/* Cache disk sederhana: JSON file per kunci di
 * ~/.cache/spotify-lyrics-widget/
 *
 * Dipakai buat nyimpen lirik + terjemahan biar lagu yang sama gak
 * di-fetch & di-translate ulang tiap kali widget dibuka.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class DiskCache {
    constructor(dirName = 'spotify-lyrics-widget') {
        this._dir = Gio.File.new_for_path(
            `${GLib.get_user_cache_dir()}/${dirName}`);
        this.dir = this._dir;
        try {
            this._dir.make_directory_with_parents(null);
        } catch (e) {
            // sudah ada / tidak bisa bikin → cache jadi no-op
        }
    }

    /**
     * @param {string} key
     * @returns {?object}
     */
    get(key) {
        try {
            const file = Gio.File.new_for_path(`${this._dir.get_path()}/${key}.json`);
            const [ok, bytes] = file.load_contents(null);
            if (!ok)
                return null;
            return JSON.parse(new TextDecoder('utf-8').decode(bytes));
        } catch (e) {
            return null;
        }
    }

    /**
     * @param {string} key
     * @param {object} value
     */
    set(key, value) {
        try {
            const file = Gio.File.new_for_path(`${this._dir.get_path()}/${key}.json`);
            file.replace_contents(
                new TextEncoder().encode(JSON.stringify(value)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            // cache gagal = bukan masalah fatal
        }
    }

    remove(key) {
        try {
            const file = Gio.File.new_for_path(`${this._dir.get_path()}/${key}.json`);
            file.delete(null);
        } catch (e) {
            // abaikan
        }
    }
}

/**
 * Hash string jadi nama file yang aman.
 * @param {string} input
 * @returns {string}
 */
export function hashKey(input) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, input, -1).substring(0, 32);
}
