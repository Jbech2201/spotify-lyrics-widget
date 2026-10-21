/* Ambil lirik dari LRCLIB (primary) sama lyrics.ovh (fallback).
 *
 * LRCLIB nyediain:
 *   - syncedLyrics : format LRC (ada timestamp per baris)
 *   - plainLyrics  : teks polos
 *   - duration     : durasi lagu (dipakai buat nyocokin lagu yg beda versi)
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {GeniusFetcher, normalize} from './genius.js';

const LRCLIB = 'https://lrclib.net/api';
const OVH = 'https://api.lyrics.ovh/v1';

/**
 * Folder lirik lokal (manual).
 * Taruh file .lrc atau .txt di sini, namanya "Artis - Judul.lrc".
 */
export const LOCAL_LYRICS_DIR = `${GLib.get_user_data_dir()}/spotify-lyrics-widget/lyrics`;

/**
 * Bikin query string dari object (GJS gak punya URLSearchParams).
 * @param {Object<string, string>} params
 * @returns {string}
 */
function buildQuery(params) {
    return Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
}

/**
 * Bersihin judul: buang "(Official Audio)", "- Remastered 2020", dll.
 * @param {string} text
 * @returns {string}
 */
export function stripNoise(text) {
    if (!text)
        return '';
    let out = text;
    // bagian dalam kurung / kurung siku
    out = out.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ');
    // feat / ft / featuring / with / vs
    out = out.replace(/\s*\b(feat\.?|ft\.?|featuring|with|vs\.?|and)\b\s*[^,]*$/i, ' ');
    //suffix setelah " - " atau " – "
    out = out.split(/\s+[-–—]\s+/)[0];
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Kandidat judul & artis untuk pencarian (urutan prioritas).
 * @param {string} title
 * @param {string} artist
 * @returns {{titles: string[], artists: string[]}}
 */
export function buildCandidates(title, artist) {
    const rawTitle = (title ?? '').trim();
    const rawArtist = (artist ?? '').trim();

    const titles = [];
    const pushTitle = value => {
        const v = (value ?? '').trim();
        if (v && !titles.includes(v))
            titles.push(v);
    };

    pushTitle(rawTitle);
    pushTitle(stripNoise(rawTitle));

    const artists = [];
    const pushArtist = value => {
        const v = (value ?? '').trim();
        if (v && !artists.includes(v))
            artists.push(v);
    };

    pushArtist(rawArtist);
    pushArtist(stripNoise(rawArtist));
    // multi artist: "A, B" / "A & B" / "A x B"
    for (const part of rawArtist.split(/\s*(?:,|&|\bx\b|\+)\s*/)) {
        if (part.length > 1)
            pushArtist(stripNoise(part));
    }

    return {titles, artists};
}

/**
 * Parse LRC → array {time (ms), text}
 * @param {string} lrc
 * @returns {Array<{time: number, text: string}>}
 */
export function parseLRC(lrc) {
    const lines = [];
    if (!lrc)
        return lines;

    let offset = 0;
    for (const raw of lrc.split('\n')) {
        const offsetMatch = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
        if (offsetMatch) {
            offset = parseInt(offsetMatch[1], 10);
            continue;
        }

        const stamps = [];
        const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
        let match;
        let consumed = 0;
        while ((match = re.exec(raw)) !== null) {
            if (match.index !== consumed)
                break; // ada teks sebelum timestamp → bukan baris LRC
            consumed = match.index + match[0].length;
            const ms = parseInt(match[3] ?? '0', 10);
            const frac = match[3] && match[3].length === 2 ? ms * 10 : ms;
            stamps.push(parseInt(match[1], 10) * 60000 +
                parseInt(match[2], 10) * 1000 + frac);
        }
        if (!stamps.length)
            continue;

        const text = raw.slice(consumed).trim();
        for (const time of stamps)
            lines.push({time: Math.max(0, time + offset), text});
    }

    lines.sort((a, b) => a.time - b.time);
    return lines;
}

/**
 * Pecah plain lyrics jadi baris + evenly-spaced timestamp.
 * @param {string} plain
 * @param {number} durationSec
 * @returns {Array<{time: number, text: string}>}
 */
export function plainToLines(plain, durationSec) {
    const texts = plain
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !/^\[.*\]$/.test(l));
    if (!texts.length)
        return [];

    const totalMs = durationSec > 10 ? durationSec * 1000 : 240000;
    const step = totalMs / (texts.length + 1);
    return texts.map((text, i) => ({time: Math.round(step * (i + 1)), text}));
}

export class LyricsFetcher {
    /**
     * @param {import('./http.js').HttpClient} http
     */
    constructor(http) {
        this._http = http;
        this._genius = new GeniusFetcher(http);
    }

    /**
     * Ambil lirik untuk sebuah lagu.
     *
     * Urutan sumber:
     *   1. folder lokal  (~/.local/share/spotify-lyrics-widget/lyrics)
     *   2. LRCLIB        (punya timestamp, CC0)
     *   3. Genius        (kalau diidu di prefs — buat artis indie)
     *   4. lyrics.ovh    (fallback, tanpa timestamp)
     *
     * @param {{title: string, artist: string, album?: string, durationSec?: number}} track
     * @param {{useLocal?: boolean, useGenius?: boolean}} [options]
     * @returns {Promise<{lines: Array<{time: number, text: string}>, source: string}>}
     */
    async fetch(track, options = {}) {
        const {titles, artists} = buildCandidates(track.title, track.artist);
        const duration = track.durationSec ?? 0;

        // 0) lirik manual di folder lokal
        if (options.useLocal !== false) {
            const local = this._local(track);
            if (local)
                return local;
        }

        // 1) exact match (paling akurat)
        for (const title of titles) {
            for (const artist of artists) {
                const result = await this._lrclibGet(title, artist, track.album, duration);
                if (result)
                    return result;
            }
        }

        // 2) search + pilih yang durasinya paling deket
        for (const title of titles) {
            for (const artist of artists) {
                const result = await this._lrclibSearch(title, artist, duration);
                if (result)
                    return result;
            }
        }

        // 3) search full text
        const free = `${track.title ?? ''} ${track.artist ?? ''}`.trim();
        if (free) {
            const result = await this._lrclibSearchFree(free, duration);
            if (result)
                return result;
        }

        // 4) Genius (buat artis yg belum ada di LRCLIB)
        if (options.useGenius) {
            const genius = await this._genius.fetch(track).catch(() => null);
            if (genius)
                return genius;
        }

        // 5) lyrics.ovh
        const ovh = await this._ovh(track.title, track.artist, duration);
        if (ovh)
            return ovh;

        throw new Error('Lirik ga ketemu');
    }

    /**
     * Cari file lirik manual di folder lokal.
     * @param {{title: string, artist: string, durationSec?: number}} track
     * @returns {?{lines: Array<{time: number, text: string}>, source: string}}
     */
    _local(track) {
        const dir = Gio.File.new_for_path(LOCAL_LYRICS_DIR);
        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return null;
        }

        const wantTitle = normalize(track.title);
        const wantArtist = normalize(track.artist);
        const wantCombo = normalize(`${track.artist ?? ''} ${track.title ?? ''}`);

        let found = null;
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!/\.(lrc|txt|json)$/i.test(name))
                continue;

            const base = normalize(name.replace(/\.[^.]+$/, ''));
            if (base !== wantTitle && base !== wantCombo && base !== `${wantArtist} ${wantTitle}`)
                continue;

            found = dir.get_child(name);
            break;
        }
        enumerator.close(null);

        if (!found)
            return null;

        let content;
        try {
            const [ok, bytes] = found.load_contents(null);
            if (!ok)
                return null;
            content = new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
            return null;
        }

        const lrc = parseLRC(content);
        if (lrc.length)
            return {lines: lrc, source: 'Lokal'};

        const plain = plainToLines(content, track.durationSec ?? 0);
        if (plain.length)
            return {lines: plain, source: 'Lokal'};

        return null;
    }

    async _lrclibGet(title, artist, album, duration) {
        const params = {
            'track_name': title,
            'artist_name': artist,
        };
        if (album)
            params.album_name = album;
        if (duration > 0)
            params.duration = String(Math.round(duration));

        const data = await this._http.getJSON(`${LRCLIB}/get?${buildQuery(params)}`)
            .catch(() => null);
        if (!data)
            return null;

        const lines = parseLRC(data.syncedLyrics);
        if (lines.length)
            return {lines, source: 'LRCLIB'};

        if (data.plainLyrics) {
            const plain = plainToLines(data.plainLyrics, duration);
            if (plain.length)
                return {lines: plain, source: 'LRCLIB (plain)'};
        }
        return null;
    }

    async _lrclibSearch(title, artist, duration) {
        const params = {
            'track_name': title,
            'artist_name': artist,
        };
        const data = await this._http.getJSON(`${LRCLIB}/search?${buildQuery(params)}`)
            .catch(() => null);
        return this._pickSearchResult(data, duration);
    }

    async _lrclibSearchFree(query, duration) {
        const params = {'q': query};
        const data = await this._http.getJSON(`${LRCLIB}/search?${buildQuery(params)}`)
            .catch(() => null);
        return this._pickSearchResult(data, duration);
    }

    _pickSearchResult(data, duration) {
        if (!Array.isArray(data) || !data.length)
            return null;

        const withSynced = data.filter(r => r.syncedLyrics);
        const pool = withSynced.length ? withSynced : [];

        let best = null;
        let bestDiff = Infinity;
        for (const item of pool) {
            const diff = duration > 0 ? Math.abs((item.duration ?? 0) - duration) : 0;
            if (diff < bestDiff) {
                bestDiff = diff;
                best = item;
            }
        }

        // durasi jauh beda → bukan versi lagu yang sama
        if (best && duration > 0 && bestDiff > 12)
            return null;
        if (!best)
            return null;

        const lines = parseLRC(best.syncedLyrics);
        if (lines.length)
            return {lines, source: 'LRCLIB'};

        if (best.plainLyrics) {
            const plain = plainToLines(best.plainLyrics, duration);
            if (plain.length)
                return {lines: plain, source: 'LRCLIB (plain)'};
        }
        return null;
    }

    async _ovh(title, artist, duration) {
        if (!title || !artist)
            return null;
        const enc = s => encodeURIComponent(s.trim());
        const data = await this._http.getJSON(
            `${OVH}/${enc(artist)}/${enc(title)}`).catch(() => null);
        if (!data?.lyrics)
            return null;

        const lines = plainToLines(data.lyrics, duration);
        if (!lines.length)
            return null;
        return {lines, source: 'lyrics.ovh'};
    }
}
