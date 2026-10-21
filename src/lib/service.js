/* Service layer: nyambungin fetch lirik + terjemahan + cache.
 */

import Gio from 'gi://Gio';

import {DiskCache, hashKey} from './cache.js';
import {HttpClient} from './http.js';
import {LyricsFetcher} from './lyrics.js';
import {detectLanguage} from './romaji.js';
import {languageName, Translator} from './translate.js';

export class LyricsService {
    /**
     * @param {Gio.Settings} settings
     */
    constructor(settings) {
        this._settings = settings;
        this.http = new HttpClient();
        this._fetcher = new LyricsFetcher(this.http);
        this._translator = new Translator(this.http, settings);
        this._cache = new DiskCache();
        this._inflight = new Map();
    }

    destroy() {
        this.http.destroy();
        this._inflight.clear();
    }

    get targetLanguages() {
        return this._settings.get_strv('target-languages')
            .map(code => code.trim())
            .filter(code => code.length > 0);
    }

    get wantRomaji() {
        return this._settings.get_boolean('show-romaji');
    }

    /**
     * Ambil lirik + terjemahan untuk sebuah lagu (pakai cache kalau ada).
     * @param {{title: string, artist: string, album?: string, durationSec?: number}} track
     * @param {boolean} force abaikan cache
     * @returns {Promise<any>}
     */
    async getLyrics(track, force = false) {
        const key = this._cacheKey(track);

        if (!force) {
            const cached = this._cache.get(key);
            if (cached)
                return {...cached, cached: true};
            if (this._inflight.has(key))
                return this._inflight.get(key);
        }

        const promise = this._build(track, key)
            .finally(() => this._inflight.delete(key));
        this._inflight.set(key, promise);
        return promise;
    }

    async _build(track, key) {
        const {lines, source} = await this._fetcher.fetch(track, {
            useLocal: this._settings.get_boolean('use-local-lyrics'),
            useGenius: this._settings.get_boolean('use-genius'),
        });
        const texts = lines.map(line => line.text);

        const targets = this.targetLanguages;
        const wantRomaji = this.wantRomaji;

        let romaji = null;
        let translations = {};

        try {
            const processed = await this._translator.process(texts, targets, wantRomaji);
            romaji = processed.romaji;
            translations = processed.translations;
        } catch (e) {
            // translate gagal → tetap tampilkan lirik original
            translations = {};
        }

        const views = [{
            id: 'original',
            label: 'Original',
            lines: texts,
        }];

        if (romaji) {
            views.push({
                id: 'romaji',
                label: 'Romaji',
                lines: romaji,
            });
        }

        for (const target of targets) {
            views.push({
                id: `lang:${target}`,
                label: languageName(target),
                lines: translations[target] ?? texts,
            });
        }

        const result = {
            lines,
            views,
            source,
            // sumber tanpa timestamp (Genius / lyrics.ovh) → highlight cuma perkiraan
            synced: source === 'LRCLIB' || source === 'Lokal',
            language: detectLanguage(texts.join(' ')),
        };

        this._cache.set(key, result);
        return result;
    }

    _cacheKey(track) {
        const raw = [
            track.title ?? '',
            track.artist ?? '',
            track.album ?? '',
            Math.round(track.durationSec ?? 0),
            this._settings.get_string('provider'),
            this.targetLanguages.join(','),
            this.wantRomaji ? 'romaji' : 'no-romaji',
            this._settings.get_boolean('use-genius') ? 'genius' : 'no-genius',
            this._settings.get_boolean('use-local-lyrics') ? 'local' : 'no-local',
        ].join('|');
        return hashKey(raw);
    }

    clearCache() {
        const dir = this._cache.dir;
        if (!dir)
            return;
        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name', Gio.QueryInfoFlags.NONE, null);
        } catch (e) {
            return;
        }

        let info;
        while ((info = enumerator.next_file(null)) !== null)
            dir.get_child(info.get_name()).delete(null);
        enumerator.close(null);
    }
}
