/* Terjemahan lirik.
 *
 * Provider yang didukung:
 *   - 'google'   → translate.googleapis.com (client=dict-chrome-ex), gratis
 *   - 'mymemory' → api.mymemory.translated.net, gratis (limit 5k kata/hari)
 *   - 'llm'      → OpenAI-compatible endpoint (opencode serve, Ollama,
 *                  LM Studio, OpenAI, ...). Paling akurat, bisa sekalian
 *                  bikin romaji.
 */

import {detectLanguage, romanize} from './romaji.js';

export const LANGUAGE_NAMES = {
    'en': 'English',
    'id': 'Indonesia',
    'ja': 'Japan',
    'ko': 'Korea',
    'zh-CN': 'Chinese',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'ar': 'Arabic',
    'th': 'Thai',
    'vi': 'Vietnamese',
    'nl': 'Dutch',
    'tr': 'Turkish',
    'it': 'Italian',
    'ms': 'Malay',
    'pl': 'Polish',
    'uk': 'Ukrainian',
    'sv': 'Swedish',
    'cs': 'Czech',
    'ro': 'Romanian',
    'hu': 'Hungarian',
    'he': 'Hebrew',
    'hi': 'Hindi',
    'fa': 'Persian',
};

const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';

export function languageName(code) {
    return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

/**
 * Ambil kode bahasa buat MyMemory (pakai ISO-639-1, except zh-CN).
 * @param {string} code
 * @returns {string}
 */
function shortCode(code) {
    return code === 'zh-CN' ? 'zh-CN' : code.split('-')[0];
}

export class Translator {
    /**
     * @param {import('./http.js').HttpClient} http
     * @param {Gio.Settings} settings
     */
    constructor(http, settings) {
        this._http = http;
        this._settings = settings;
    }

    get provider() {
        return this._settings.get_string('provider');
    }

    /**
     * Terjemahkan + (kalau perlu) romaji sekaligus.
     *
     * @param {string[]} lines baris lirik original
     * @param {string[]} targets kode bahasa tujuan
     * @param {boolean} wantRomaji
     * @returns {Promise<{romaji: ?string[], translations: Object<string, string[]>}>}
     */
    async process(lines, targets, wantRomaji) {
        if (!lines.length)
            return {romaji: null, translations: {}};

        switch (this.provider) {
        case 'llm':
            return this._llm(lines, targets, wantRomaji);
        case 'mymemory':
            return this._mymemory(lines, targets, wantRomaji);
        case 'none':
            return {romaji: wantRomaji ? this._localRomaji(lines) : null,
                translations: {}};
        case 'google':
        default:
            return this._google(lines, targets, wantRomaji);
        }
    }

    // ── Google Translate ────────────────────────────────────────────────────

    async _google(lines, targets, wantRomaji) {
        const translations = {};

        for (const target of targets) {
            try {
                translations[target] = await this._googleBatch(lines, target);
            } catch (e) {
                // fallback ke MyMemory kalau Google gagal
                const fallback = await this._mymemoryOneByOne(lines, target)
                    .catch(() => null);
                translations[target] = fallback ?? lines.slice();
            }
        }

        return {
            romaji: wantRomaji ? this._localRomaji(lines) : null,
            translations,
        };
    }

    async _googleBatch(lines, target) {
        const joined = lines.join('\n');
        const url = `${GOOGLE_ENDPOINT}?client=dict-chrome-ex&sl=auto` +
            `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(joined)}`;

        const data = await this._http.getJSON(url);
        if (!Array.isArray(data) || !Array.isArray(data[0]))
            throw new Error('Respons translate aneh');

        const text = data[0].map(seg => (seg && seg[0]) || '').join('');
        const parts = text.split('\n');

        if (parts.length === lines.length)
            return parts.map(l => l.trim());

        // jumlah baris beda → terjemah satu-satu (lebih lambat tapi akurat)
        return this._googlePerLine(lines, target);
    }

    async _googlePerLine(lines, target) {
        const results = new Array(lines.length);
        let cursor = 0;
        const workers = [];

        const worker = async () => {
            while (cursor < lines.length) {
                const index = cursor++;
                try {
                    results[index] = await this._googleSingle(lines[index], target);
                } catch (e) {
                    results[index] = lines[index];
                }
            }
        };

        const concurrency = Math.min(4, lines.length);
        for (let i = 0; i < concurrency; i++)
            workers.push(worker());
        await Promise.all(workers);

        return results;
    }

    async _googleSingle(text, target) {
        if (!text.trim())
            return '';
        const url = `${GOOGLE_ENDPOINT}?client=dict-chrome-ex&sl=auto` +
            `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
        const data = await this._http.getJSON(url);
        if (!Array.isArray(data) || !Array.isArray(data[0]))
            throw new Error('Respons translate aneh');
        return data[0].map(seg => (seg && seg[0]) || '').join('').trim();
    }

    // ── MyMemory ────────────────────────────────────────────────────────────

    async _mymemory(lines, targets, wantRomaji) {
        const source = detectLanguage(lines.join(' '));
        const translations = {};
        for (const target of targets) {
            translations[target] = await this._mymemoryOneByOne(lines, target, source)
                .catch(() => lines.slice());
        }
        return {
            romaji: wantRomaji ? this._localRomaji(lines) : null,
            translations,
        };
    }

    async _mymemoryOneByOne(lines, target, source = null) {
        const src = source ?? detectLanguage(lines.join(' '));
        const results = new Array(lines.length);
        let cursor = 0;

        const worker = async () => {
            while (cursor < lines.length) {
                const index = cursor++;
                const line = lines[index];
                if (!line.trim()) {
                    results[index] = '';
                    continue;
                }
                try {
                    results[index] = await this._mymemorySingle(line, src, target);
                } catch (e) {
                    results[index] = line;
                }
            }
        };

        const concurrency = Math.min(3, lines.length);
        const workers = [];
        for (let i = 0; i < concurrency; i++)
            workers.push(worker());
        await Promise.all(workers);

        return results;
    }

    async _mymemorySingle(text, source, target) {
        const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(text)}` +
            `&langpair=${encodeURIComponent(shortCode(source))}|${encodeURIComponent(shortCode(target))}`;
        const data = await this._http.getJSON(url);
        const status = data?.responseStatus;
        if (status !== 200 && status !== '200')
            throw new Error('MyMemory error');
        const translated = data?.responseData?.translatedText;
        if (typeof translated !== 'string')
            throw new Error('MyMemory error');
        return translated.trim();
    }

    // ── LLM (OpenAI-compatible) ─────────────────────────────────────────────

    async _llm(lines, targets, wantRomaji) {
        const base = this._settings.get_string('llm-base-url').trim().replace(/\/+$/, '');
        const model = this._settings.get_string('llm-model').trim();
        const apiKey = this._settings.get_string('llm-api-key').trim();

        if (!base || !model)
            throw new Error('LLM belum dikonfigurasi (base URL + model)');

        const headers = apiKey ? {'Authorization': `Bearer ${apiKey}`} : {};

        const system = [
            'Kamu adalah penerjemah lirik lagu profesional.',
            'Kamu menerima array JSON berisi baris-baris lirik asli.',
            'Balas HANYA dengan JSON valid dengan bentuk:',
            '{"romaji": [...], "translations": {"<kode bahasa>": [...]}}',
            'Aturan:',
            '- jumlah baris output harus PERSIS sama dengan jumlah baris input,',
            '  jangan gabung atau pecah baris,',
            '- "romaji" isi romanisasi (Revised Romanization untuk Korea, Hepburn untuk',
            '  Jepang); pakai null kalau teksnya sudah Latin,',
            '- "translations" punya satu entri untuk tiap kode bahasa yang diminta,',
            '- terjemahan harus natural, enak dibaca, dan preserve makna artistiknya,',
            '- jangan tambahkan timestamp atau penjelasan apa pun.',
        ].join('\n');

        const payload = {
            model,
            temperature: 0.2,
            messages: [
                {role: 'system', content: system},
                {
                    role: 'user',
                    content: JSON.stringify({
                        lines,
                        languages: targets,
                        need_romaji: wantRomaji,
                    }),
                },
            ],
        };

        const data = await this._http.postJSON(
            `${base}/chat/completions`, payload, headers);

        const content = data?.choices?.[0]?.message?.content ?? '';
        const parsed = this._parseJSON(content);

        const translations = {};
        for (const target of targets) {
            const value = parsed?.translations?.[target];
            translations[target] = Array.isArray(value) && value.length === lines.length
                ? value.map(v => String(v ?? ''))
                : lines.slice();
        }

        let romaji = null;
        if (wantRomaji) {
            const value = parsed?.romaji;
            romaji = Array.isArray(value) && value.length === lines.length
                ? value.map(v => String(v ?? ''))
                : this._localRomaji(lines);
        }

        return {romaji, translations};
    }

    _parseJSON(content) {
        const text = String(content ?? '').trim();
        if (!text)
            return null;

        const candidates = [text];
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced)
            candidates.unshift(fenced[1].trim());
        const braced = text.match(/\{[\s\S]*\}/);
        if (braced)
            candidates.push(braced[0]);

        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate);
            } catch (e) {
                // coba kandidat berikutnya
            }
        }
        return null;
    }

    // ── Romaji lokal (offline) ──────────────────────────────────────────────

    /**
     * @param {string[]} lines
     * @returns {string[]}
     */
    _localRomaji(lines) {
        return lines.map(line => romanize(line));
    }
}
