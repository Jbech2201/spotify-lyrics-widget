/* Sumber lirik tambahan: Genius.
 *
 * Kenapa perlu: LRCLIB itu crowd-sourced, jadi artis indie / artis yang
 * baru rilis belum tentu ada di sana (contoh: Aryiion).
 *
 * Catatan jujur:
 *   - API lirik resmi Genius butuh login (403 "requires a logged in user"),
 *     jadi ini ambil dari halaman lagu publik yang di-render di HTML.
 *   - Genius discourage automated access di ToS-nya, jadi fitur ini
 *     DEFAULT MATI — lo yang nyalain sendiri di Preferences.
 *   - Genius nggak punya timestamp, jadi highlight "yangSedangregs" cuma
 *     perkiraan (baris dibagi rata dengan durasi lagu).
 */

const SEARCH_URL = 'https://genius.com/api/search/multi';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Normalisasi judul/artis biar perbandingan tidak sensitif format.
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
    return (text ?? '')
        .toLowerCase()
        .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ')
        .replace(/\b(feat|ft|featuring|with|prod|original|mix|remaster(ed)?|explicit|audio|video|official|lyric(s)?|hq|4k)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Ambil lirik dari HTML halaman lagu Genius.
 *
 * Halaman Genius nyediain beberapa container:
 *   - container header ("1 Contributor", "<Judul> Lyrics", bio artis) → BUANG
 *   - container iklan → BUANG
 *   - container lirik → AMBIL
 *
 * @param {string} html
 * @returns {string[]} baris lirik
 */
export function extractLyrics(html) {
    if (!html)
        return [];

    const chunks = html.split('data-lyrics-container="true"').slice(1);
    const lines = [];

    for (const raw of chunks) {
        let chunk = raw;

        // buang sisa atribut pembuka (mis. ' class="Lyrics__Container...">')
        if (!chunk.startsWith('<')) {
            const gt = chunk.indexOf('>');
            if (gt !== -1)
                chunk = chunk.slice(gt + 1);
        }

        // header & iklan: penanda exclude muncul sebelum baris lirik pertama
        const brIndex = chunk.indexOf('<br');
        const excludeIndex = chunk.indexOf('data-exclude-from-selection="true"');
        if (excludeIndex !== -1 && (brIndex === -1 || excludeIndex < brIndex))
            continue;

        // potong konten junk yang menyusul lirik
        for (const marker of ['<svg', 'You might also like', 'window.location.reload',
            '__CF$cv$params', 'Annotations']) {
            const index = chunk.indexOf(marker);
            if (index !== -1)
                chunk = chunk.slice(0, index);
        }

        let text = chunk.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<[^>]+>/g, '\n');
        text = decodeEntities(text);

        for (const rawLine of text.split('\n')) {
            const line = rawLine.replace(/\s+/g, ' ').trim();
            if (!line)
                continue;
            if (line.length > 300)
                continue;
            if (line.startsWith('<'))
                continue; // sisa tag HTML yang gagal ke-strip
            if (/^\d+\s*contributor/i.test(line))
                continue;
            if (/^read more$/i.test(line))
                continue;
            if (/^(you might also like|lyrics|song information)$/i.test(line))
                continue;
            if (/window\.|__CF\$|function\s*\(|document\.|\{|\}/.test(line))
                continue;
            lines.push(line);
        }
    }

    return lines;
}

function decodeEntities(text) {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

export class GeniusFetcher {
    /**
     * @param {import('./http.js').HttpClient} http
     */
    constructor(http) {
        this._http = http;
    }

    /**
     * @param {{title: string, artist: string, album?: string, durationSec?: number}} track
     * @returns {Promise<?{lines: Array<{time: number, text: string}>, source: string}>}
     */
    async fetch(track) {
        const song = await this._searchSong(track);
        if (!song)
            return null;

        const html = await this._http.getText(song.url, {'User-Agent': UA});
        const lines = extractLyrics(html);
        if (!lines.length)
            return null;

        // tanpa timestamp → bagi rata sesuai durasi
        const durationSec = track.durationSec ?? 0;
        const step = (durationSec > 10 ? durationSec * 1000 : 240000) / (lines.length + 1);

        return {
            lines: lines.map((text, i) => ({
                time: Math.round(step * (i + 1)),
                text,
            })),
            source: 'Genius',
        };
    }

    /**
     * @param {{title: string, artist: string}} track
     * @returns {Promise<?object>}
     */
    async _searchSong(track) {
        // Spotify biasanya nulis "Artis1, Artis2, ..." → coba satu-satu
        const artistCandidates = [track.artist ?? ''];
        for (const part of (track.artist ?? '').split(/\s*(?:,|&|\bx\b|\+|\bwith\b)\s*/)) {
            const value = part.trim();
            if (value && !artistCandidates.includes(value))
                artistCandidates.push(value);
        }

        for (const artist of artistCandidates) {
            const song = await this._searchSongWith(`${artist} ${track.title ?? ''}`.trim(),
                track.title, artist);
            if (song)
                return song;
        }
        return null;
    }

    /**
     * @param {string} query
     * @param {string} title
     * @param {string} artist
     * @returns {Promise<?object>}
     */
    async _searchSongWith(query, title, artist) {
        if (!query)
            return null;

        // NB: parameter type=/per_page= bikin API balikin 0 section, jangan dipake
        const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
        const data = await this._http.getJSON(url, {'User-Agent': UA}).catch(() => null);
        if (!data?.response?.sections)
            return null;

        const wantTitle = normalize(title);
        const wantArtist = normalize(artist);

        let best = null;
        let bestScore = 0;

        for (const section of data.response.sections) {
            for (const hit of section.hits ?? []) {
                if (hit.type !== 'song' || !hit.result)
                    continue;

                const result = hit.result;
                const hitTitle = normalize(result.title);
                const hitArtist = normalize(result.primary_artist?.name ?? '');
                const hitArtists = (result.artists ?? []).map(a => normalize(a.name));

                let score = 0;
                if (hitTitle && wantTitle) {
                    if (hitTitle === wantTitle)
                        score += 10;
                    else if (hitTitle.startsWith(wantTitle) || wantTitle.startsWith(hitTitle))
                        score += 5;
                }
                if (hitArtist && wantArtist) {
                    if (hitArtist === wantArtist)
                        score += 6;
                    else if (hitArtists.includes(wantArtist))
                        score += 4;
                    else if (hitArtist.includes(wantArtist) || wantArtist.includes(hitArtist))
                        score += 2;
                }

                if (score > bestScore) {
                    bestScore = score;
                    best = result;
                }
            }
        }

        // butuh kecocokan judul yang decent
        if (!best || bestScore < 8)
            return null;

        return {
            id: best.id,
            title: best.title,
            url: best.url ?? `https://genius.com/songs/${best.id}`,
            artist: best.primary_artist?.name ?? '',
        };
    }
}
