/* HTTP client kecil di atas libsoup 3.
 *
 * Dipakai buat nembak LRCLIB (lirik), Google Translate / MyMemory /
 * OpenAI-compatible endpoint (terjemahan), sama buat ambil cover art.
 */

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

const USER_AGENT = 'SpotifyLyricsWidget/1.0 (GNOME Shell extension)';

export class HttpClient {
    /**
     * @param {number} timeout timeout per request (detik)
     */
    constructor(timeout = 15) {
        this._session = new Soup.Session();
        this._session.timeout = timeout;
        this._session.user_agent = USER_AGENT;
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    /**
     * @param {Soup.Message} msg
     * @returns {Promise<Uint8Array>}
     */
    async _send(msg) {
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                    try {
                        resolve(this._session.send_and_read_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });

        const status = msg.status_code;
        if (status < 200 || status >= 300) {
            const reason = msg.get_reason_phrase() ?? '';
            throw new Error(`HTTP ${status} ${reason}`.trim());
        }
        const data = bytes.get_data();
        return data ?? new Uint8Array();
    }

    /**
     * @param {string} url
     * @param {object} headers
     * @returns {Promise<Uint8Array>}
     */
    async getBytes(url, headers = {}) {
        const msg = Soup.Message.new('GET', url);
        for (const [key, value] of Object.entries(headers))
            msg.request_headers.append(key, value);
        return this._send(msg);
    }

    /**
     * @param {string} url
     * @param {object} headers
     * @returns {Promise<string>}
     */
    async getText(url, headers = {}) {
        const data = await this.getBytes(url, headers);
        return new TextDecoder('utf-8').decode(data);
    }

    /**
     * @param {string} url
     * @param {object} headers
     * @returns {Promise<any>}
     */
    async getJSON(url, headers = {}) {
        const text = await this.getText(url, {
            'Accept': 'application/json',
            ...headers,
        });
        return JSON.parse(text);
    }

    /**
     * @param {string} url
     * @param {any} payload
     * @param {object} headers
     * @returns {Promise<any>}
     */
    async postJSON(url, payload, headers = {}) {
        const msg = Soup.Message.new('POST', url);
        for (const [key, value] of Object.entries(headers))
            msg.request_headers.append(key, value);
        msg.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload))));
        const data = await this._send(msg);
        return JSON.parse(new TextDecoder('utf-8').decode(data));
    }
}
