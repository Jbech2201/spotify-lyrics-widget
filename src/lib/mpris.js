/* Klien MPRIS untuk Spotify.
 *
 * Nangkep org.mpris.MediaPlayer2.spotify (metadata, playback status,
 * posisi playback) dan nge-sync-in otomatis waktu Spotify dibuka / ditutup.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const SPOTIFY_BUS = 'org.mpris.MediaPlayer2.spotify';
const SPOTIFY_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

export const SpotifyPlayer = GObject.registerClass({
    Signals: {
        'track-changed': {param_types: [GObject.TYPE_JSOBJECT]},
        'playback-changed': {param_types: [GObject.TYPE_STRING]},
        'position-changed': {param_types: [GObject.TYPE_INT64]},
        'player-appeared': {},
        'player-vanished': {},
    },
}, class SpotifyPlayer extends GObject.Object {
    _init() {
        super._init();

        this._proxy = null;
        this._pollId = 0;
        this._trackId = null;
        this._status = 'Stopped';
        this._position = 0; // µs
        this._positionAt = 0; // monotonic time saat posisi terakhir dibaca
        this._metadata = {};

        this._watchBus();
    }

    destroy() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
        if (this._subId) {
            Gio.DBus.session.signal_unsubscribe(this._subId);
            this._subId = 0;
        }
        this._disconnectPlayer();
        this._proxy = null;
    }

    // ── state ───────────────────────────────────────────────────────────────

    get status() {
        return this._status;
    }

    get playing() {
        return this._status === 'Playing';
    }

    /** Posisi playback dalam mikrodetik (interpolasi biar mulus). */
    get position() {
        if (this.playing)
            return this._position + (GLib.get_monotonic_time() - this._positionAt);
        return this._position;
    }

    get metadata() {
        return this._metadata;
    }

    get title() {
        return this._metadata['xesam:title'] ?? '';
    }

    get artists() {
        const value = this._metadata['xesam:artist'];
        return Array.isArray(value) ? value : [];
    }

    get artist() {
        return this.artists.join(', ');
    }

    get album() {
        return this._metadata['xesam:album'] ?? '';
    }

    get artUrl() {
        return this._metadata['mpris:artUrl'] ?? '';
    }

    /** Durasi lagu dalam detik (0 kalau gak ada). */
    get durationSec() {
        const length = this._metadata['mpris:length'];
        return typeof length === 'number' && length > 0 ? length / 1000000 : 0;
    }

    // ── bus watching ───────────────────────────────────────────────────────

    _watchBus() {
        this._subId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, parameters) => {
                const [name, oldOwner, newOwner] = parameters.deepUnpack();
                if (name !== SPOTIFY_BUS)
                    return;
                if (newOwner)
                    this._connectPlayer();
                else
                    this._disconnectPlayer();
            });

        // Spotify mungkin udah jalan sebelum extension ini ke-load
        this._checkExistingPlayer();
    }

    _checkExistingPlayer() {
        try {
            const reply = Gio.DBus.session.call_sync(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'GetNameOwner',
                new GLib.Variant('(s)', [SPOTIFY_BUS]),
                new GLib.VariantType('(s)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null);
            const [owner] = reply.deepUnpack();
            if (owner)
                this._connectPlayer();
        } catch (e) {
            // belum ada yang punya nama itu
        }
    }

    _connectPlayer() {
        if (this._proxy)
            return;

        Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null,
            SPOTIFY_BUS,
            SPOTIFY_PATH,
            PLAYER_IFACE,
            null,
            (source, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    return; // Spotify belum siap
                }

                this._proxy = proxy;
                proxy.connectObject('g-properties-changed',
                    () => this._onPropertiesChanged(), this);
                this._onPropertiesChanged();
                this._startPolling();
                this.emit('player-appeared');
            });
    }

    _disconnectPlayer() {
        if (!this._proxy)
            return;

        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }

        this._proxy.disconnect_object(this);
        this._proxy = null;
        this._trackId = null;
        this._metadata = {};
        this._status = 'Stopped';
        this._position = 0;
        this._positionAt = 0;
        this.emit('player-vanished');
    }

    _startPolling() {
        if (this._pollId)
            return;
        this._pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this._pollPosition();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _onPropertiesChanged() {
        const proxy = this._proxy;
        if (!proxy)
            return;

        // generic proxy: property remote ada di cache, bukan sebagai properti GObject
        const metadata = this._unpackMetadata(proxy.get_cached_property('Metadata'));
        const status = this._unpack(proxy.get_cached_property('PlaybackStatus')) ?? 'Stopped';
        const position = Number(this._unpack(proxy.get_cached_property('Position')) ?? 0) || 0;

        const newId = metadata['mpris:trackid'] ??
            `${metadata['xesam:title'] ?? ''}::${metadata['xesam:artist'] ?? ''}`;

        const trackChanged = newId !== this._trackId;
        const statusChanged = status !== this._status;

        this._metadata = metadata;
        this._status = status;
        this._syncPosition(position, trackChanged || !this.playing);

        if (trackChanged) {
            this._trackId = newId;
            this.emit('track-changed', metadata);
        }
        if (statusChanged)
            this.emit('playback-changed', status);
        this.emit('position-changed', this.position);
    }

    /**
     * Proxy generic balikin property-nya sebagai GVariant, jadi harus
     * di-unpack sendiri.
     * @param {any} value
     * @returns {any}
     */
    _unpack(value) {
        if (value instanceof GLib.Variant)
            return value.deepUnpack();
        return value;
    }

    /**
     * @param {any} raw
     * @returns {Object<string, any>}
     */
    _unpackMetadata(raw) {
        const metadata = {};
        if (!raw)
            return metadata;

        const source = raw instanceof GLib.Variant ? raw.deepUnpack() : raw;
        if (!source || typeof source !== 'object')
            return metadata;

        for (const key in source) {
            const value = source[key];
            metadata[key] = value instanceof GLib.Variant ? value.deepUnpack() : value;
        }
        return metadata;
    }

    _pollPosition() {
        if (!this._proxy)
            return;

        Gio.DBus.session.call(
            SPOTIFY_BUS,
            SPOTIFY_PATH,
            PROPERTIES_IFACE,
            'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            1500,
            null,
            (connection, result) => {
                try {
                    const reply = Gio.DBus.session.call_finish(result);
                    const [value] = reply.deepUnpack();
                    // balikinannya GVariant, harus di-unpack sekali lagi
                    const real = value instanceof GLib.Variant
                        ? Number(value.deepUnpack())
                        : Number(value);
                    this._syncPosition(real, !this.playing);
                    this.emit('position-changed', this.position);
                } catch (e) {
                    // Spotify ditutup / timeout
                }
            });
    }

    /**
     * Sinkronkan position internal dengan nilai asli dari player.
     *
     * Nilai Position dari Spotify cuma di-update ~1x/detik, jadi sering
     * udah basi pas kebaca. Kalau kita langsung pakai nilai itu, position
     * bakal loncat-loncat (highlight flickering). Jadi: kalau selisihnya
     * kecil, lanjutkan interpolasi sendiri; kalau jauh (seek / ganti lagu),
     * baru sinkron ulang.
     *
     * @param {number} real posisi asli (mikrodetik)
     * @param {boolean} force paksa sinkron
     */
    _syncPosition(real, force = false) {
        if (!Number.isFinite(real))
            return;

        const now = GLib.get_monotonic_time();
        const predicted = this._position + (now - this._positionAt);

        if (force || Math.abs(real - predicted) > 1500000)
            this._position = real;
        else
            this._position = predicted;

        this._positionAt = now;
    }

    // ── kontrol ────────────────────────────────────────────────────────────

    playPause() {
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    /**
     * @param {number} positionUs posisi absolut dalam mikrodetik
     */
    seek(positionUs) {
        this._call('Seek', new GLib.Variant('(x)', [Math.round(positionUs)]));
    }

    _call(method, params = null) {
        Gio.DBus.session.call(
            SPOTIFY_BUS,
            SPOTIFY_PATH,
            PLAYER_IFACE,
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                try {
                    Gio.DBus.session.call_finish(result);
                } catch (e) {
                    // abaikan error
                }
            });
    }
});
