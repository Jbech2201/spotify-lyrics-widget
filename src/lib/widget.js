/* Panel indicator + popup lirik.
 *
 * Isinya:
 *   - header: cover art, judul, artis, album
 *   - kontrol: prev / play-pause / next + posisi lagu + progress bar
 *   - tab bahasa: Original / Romaji / English / Indonesia / ...
 *   - daftar lirik (baris aktif ikut highlighted + auto-scroll)
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        seconds = 0;
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const LyricsIndicator = GObject.registerClass(
class LyricsIndicator extends PanelMenu.Button {
    /**
     * @param {Gio.Settings} settings
     * @param {any} player SpotifyPlayer
     * @param {any} service LyricsService
     */
    _init(settings, player, service) {
        super._init(0.5, 'Spotify Lyrics');

        this._settings = settings;
        this._player = player;
        this._service = service;

        this._views = [];
        this._timings = [];
        this._activeViewId = 'original';
        this._currentIndex = -1;
        this._loading = false;
        this._coverToken = 0;

        this._icon = new St.Icon({
            icon_name: 'audio-headphones-symbolic',
            icon_size: 16,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._buildMenu();

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._onMenuOpened();
        });
    }

    // ── bangun UI ──────────────────────────────────────────────────────────

    _buildMenu() {
        const menu = this.menu;
        menu.actor.add_style_class_name('lyrics-widget-menu');

        // header
        this._headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._headerItem.style_class = 'lyrics-header-item';
        this._headerBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._headerItem.add_child(this._headerBox);

        this._topRow = new St.BoxLayout({x_expand: true});
        this._coverIcon = new St.Icon({
            icon_size: 72,
            style_class: 'lyrics-cover',
        });
        this._coverIcon.set_size(72, 72);
        this._topRow.add_child(this._coverIcon);

        const infoBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel = new St.Label({
            style_class: 'lyrics-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this._titleLabel.clutter_text.line_wrap = false;
        this._titleLabel.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END

        this._artistLabel = new St.Label({
            style_class: 'lyrics-artist',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this._artistLabel.clutter_text.ellipsize = 3;

        this._albumLabel = new St.Label({
            style_class: 'lyrics-album',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this._albumLabel.clutter_text.ellipsize = 3;

        infoBox.add_child(this._titleLabel);
        infoBox.add_child(this._artistLabel);
        infoBox.add_child(this._albumLabel);
        this._topRow.add_child(infoBox);
        this._headerBox.add_child(this._topRow);

        // kontrol
        this._controlRow = new St.BoxLayout({
            style_class: 'lyrics-controls',
            x_expand: true,
        });
        this._prevButton = this._makeIconButton('media-skip-backward-symbolic',
            'Previous track', () => this._player.previous());
        this._playButton = this._makeIconButton('media-playback-start-symbolic',
            'Play / pause', () => this._player.playPause());
        this._nextButton = this._makeIconButton('media-skip-forward-symbolic',
            'Next track', () => this._player.next());

        this._controlRow.add_child(this._prevButton);
        this._controlRow.add_child(this._playButton);
        this._controlRow.add_child(this._nextButton);

        this._timeLabel = new St.Label({
            style_class: 'lyrics-time',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timeLabel.clutter_text.ellipsize = 3;
        this._controlRow.add_child(this._timeLabel);

        this._headerBox.add_child(this._controlRow);

        // progress bar
        this._progress = new St.Widget({
            style_class: 'lyrics-progress',
            x_expand: true,
            height: 4,
        });
        this._progressFill = new St.Widget({style_class: 'lyrics-progress-fill'});
        this._progress.add_child(this._progressFill);
        this._progress.connect('notify::width', () => this._updateProgress());
        this._progress.connect('button-press-event', (actor, event) =>
            this._onProgressPress(event));
        this._headerBox.add_child(this._progress);

        menu.addMenuItem(this._headerItem);

        // tab bahasa
        this._tabItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._tabItem.style_class = 'lyrics-tab-item';
        this._tabBox = new St.BoxLayout({
            style_class: 'lyrics-tabs',
            x_expand: true,
        });
        this._tabItem.add_child(this._tabBox);
        menu.addMenuItem(this._tabItem);

        // daftar lirik
        this._lyricsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._lyricsItem.style_class = 'lyrics-lyrics-item';
        this._scrollView = new St.ScrollView({
            style_class: 'lyrics-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
        });
        this._linesBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'lyrics-lines',
        });
        this._scrollView.set_child(this._linesBox);
        this._lyricsItem.add_child(this._scrollView);
        menu.addMenuItem(this._lyricsItem);

        // footer
        this._footerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._footerItem.style_class = 'lyrics-footer-item';
        this._footerBox = new St.BoxLayout({
            style_class: 'lyrics-footer',
            x_expand: true,
        });
        this._statusLabel = new St.Label({
            style_class: 'lyrics-status',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._statusLabel.clutter_text.ellipsize = 3;
        this._footerBox.add_child(this._statusLabel);

        this._refreshButton = new St.Button({
            label: 'Refresh',
            style_class: 'lyrics-refresh-button button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._refreshButton.connect('clicked', () => this.refresh(true));
        this._footerBox.add_child(this._refreshButton);
        this._footerItem.add_child(this._footerBox);
        menu.addMenuItem(this._footerItem);

        this._applyAppearance();
    }

    /**
     * @param {string} iconName
     * @param {string} label
     * @param {Function} callback
     * @returns {St.Button}
     */
    _makeIconButton(iconName, label, callback) {
        const button = new St.Button({
            style_class: 'lyrics-control-button button',
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 16,
                style_class: 'system-status-icon',
            }),
            accessible_name: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', callback);
        return button;
    }

    // ── update dari player ─────────────────────────────────────────────────

    /** Dipanggil waktu metadata lagu berubah. */
    onTrackChanged() {
        this._renderTrackInfo();
        this._views = [];
        this._timings = [];
        this._activeViewId = 'original';
        this._currentIndex = -1;
        this._renderLines();
        this._rebuildTabs();
        if (this._settings.get_boolean('auto-fetch'))
            this.refresh(false);
    }

    onPlayerVanished() {
        this._titleLabel.set_text('Spotify');
        this._artistLabel.set_text('Spotify is not running');
        this._albumLabel.set_text('');
        this._coverIcon.gicon = null;
        this._setStatus('Nyalain Spotify dulu, bro.');
        this._views = [];
        this._timings = [];
        this._currentIndex = -1;
        this._renderLines();
        this._rebuildTabs();
    }

    _renderTrackInfo() {
        const title = this._player.title;
        this._titleLabel.set_text(title || '—');
        this._artistLabel.set_text(this._player.artist || '—');
        this._albumLabel.set_text(this._player.album || '');
        this._loadCover();
    }

    async _loadCover() {
        const url = this._player.artUrl;
        const token = ++this._coverToken;

        if (!url) {
            this._coverIcon.gicon = null;
            return;
        }

        try {
            let bytes;
            if (url.startsWith('file://')) {
                const file = Gio.File.new_for_uri(url);
                const [ok, data] = file.load_contents(null);
                if (!ok)
                    throw new Error('gagal baca cover');
                bytes = data;
            } else {
                bytes = await this._service.http.getBytes(url);
            }
            if (token !== this._coverToken)
                return;
            this._coverIcon.gicon = new Gio.BytesIcon({
                bytes: new GLib.Bytes(bytes),
            });
        } catch (e) {
            if (token === this._coverToken)
                this._coverIcon.gicon = null;
        }
    }

    // ── ambil lirik ────────────────────────────────────────────────────────

    async refresh(force) {
        if (this._loading)
            return;
        const title = this._player.title;
        if (!title) {
            this._setStatus('Nyalain Spotify dulu, bro.');
            return;
        }

        this._loading = true;
        this._setStatus('Ngambil lirik…');
        this._icon.icon_name = 'content-loading-symbolic';

        try {
            const result = await this._service.getLyrics({
                title,
                artist: this._player.artist,
                album: this._player.album,
                durationSec: this._player.durationSec,
            }, force);

            this._views = result.views ?? [];
            this._timings = result.lines ?? [];
            this._rebuildTabs();
            this._renderLines();
            this._currentIndex = -1;
            this._updatePosition();

            const langInfo = result.language === 'ko' ? '한국어'
                : result.language === 'ja' ? '日本語' : 'English';
            const syncInfo = result.synced === false ? ' · tanpa sync' : '';
            this._setStatus(`${result.source} · ${langInfo}${syncInfo}` +
                `${result.cached ? ' · cached' : ''}`);
        } catch (e) {
            this._views = [];
            this._renderLines();
            this._rebuildTabs();
            this._setStatus(`Gagal: ${e.message ?? e}`);
        } finally {
            this._loading = false;
            this._updatePlayIcon();
        }
    }

    _onMenuOpened() {
        this._renderTrackInfo();
        this._updatePosition();
        if (!this._views.length && !this._loading)
            this.refresh(false);
    }

    // ── tab bahasa ─────────────────────────────────────────────────────────

    _rebuildTabs() {
        this._tabBox.destroy_all_children();
        this._tabButtons = [];

        for (const view of this._views) {
            const button = new St.Button({
                label: view.label,
                style_class: 'lyrics-tab',
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', () => this._selectView(view.id));
            this._tabBox.add_child(button);
            this._tabButtons.push({id: view.id, button});
        }

        if (!this._views.length) {
            const label = new St.Label({
                style_class: 'lyrics-tabs-empty',
                text: 'Belum ada data',
            });
            this._tabBox.add_child(label);
        }

        this._highlightTab();
    }

    _selectView(id) {
        this._activeViewId = id;
        this._renderLines();
        this._highlightTab();
    }

    _highlightTab() {
        if (!this._tabButtons)
            return;
        for (const {id, button} of this._tabButtons) {
            if (id === this._activeViewId)
                button.add_style_class_name('active');
            else
                button.remove_style_class_name('active');
        }
    }

    // ── daftar lirik ───────────────────────────────────────────────────────

    _activeView() {
        return this._views.find(view => view.id === this._activeViewId) ??
            this._views[0] ?? null;
    }

    _renderLines() {
        this._linesBox.destroy_all_children();
        this._lineLabels = [];
        this._currentIndex = -1;

        const view = this._activeView();
        if (!view) {
            const empty = new St.Label({
                style_class: 'lyrics-empty',
                text: 'Belum ada lirik untuk lagu ini.',
                x_expand: true,
            });
            empty.clutter_text.line_wrap = true;
            this._linesBox.add_child(empty);
            return;
        }

        const showTimestamps = this._settings.get_boolean('show-timestamps');

        view.lines.forEach((text, index) => {
            const timing = this._timings?.[index];
            const label = new St.Label({
                style_class: 'lyrics-line',
                text: showTimestamps && timing?.time
                    ? `[${formatTime(timing.time / 1000)}] ${text}`
                    : text,
                x_expand: true,
            });
            label.clutter_text.line_wrap = true;
            this._linesBox.add_child(label);
            this._lineLabels.push({label, time: timing?.time ?? 0});
        });
    }

    // ── posisi & highlight ─────────────────────────────────────────────────

    updatePosition() {
        this._updatePosition();
    }

    _updatePosition() {
        const positionMs = this._player.position / 1000;
        const duration = this._player.durationSec;

        this._timeLabel.set_text(
            `${formatTime(positionMs / 1000)} / ${formatTime(duration)}`);
        this._updateProgress();
        this._updateCurrentLine(positionMs);
    }

    _updateProgress() {
        const duration = this._player.durationSec;
        const width = this._progress.width;
        if (!(width > 0) || !(duration > 0)) {
            this._progressFill.set_width(0);
            return;
        }
        const ratio = Math.max(0, Math.min(1, (this._player.position / 1000000) / duration));
        this._progressFill.set_width(Math.round(width * ratio));
    }

    _updateCurrentLine(positionMs) {
        if (!this._lineLabels || !this._lineLabels.length)
            return;

        let index = -1;
        for (let i = 0; i < this._lineLabels.length; i++) {
            if (this._lineLabels[i].time <= positionMs)
                index = i;
            else
                break;
        }

        if (index === this._currentIndex)
            return;

        if (this._currentIndex >= 0 && this._lineLabels[this._currentIndex]) {
            this._lineLabels[this._currentIndex].label
                .remove_style_class_name('lyrics-line-active');
        }
        this._currentIndex = index;

        if (index >= 0 && this._lineLabels[index]) {
            const label = this._lineLabels[index].label;
            label.add_style_class_name('lyrics-line-active');
            if (this.menu.isOpen && this._settings.get_boolean('auto-scroll'))
                ensureActorVisibleInScrollView(this._scrollView, label);
        }
    }

    _onProgressPress(event) {
        const duration = this._player.durationSec;
        const width = this._progress.width;
        if (!(width > 0) || !(duration > 0))
            return;

        const [stageX] = event.get_coords();
        const [ok, x] = this._progress.transform_stage_point(stageX, 0);
        if (!ok)
            return;

        const ratio = Math.max(0, Math.min(1, x / width));
        this._player.seek(ratio * duration * 1000000);
    }

    _updatePlayIcon() {
        const child = this._playButton.get_child();
        if (child instanceof St.Icon) {
            child.icon_name = this._player.playing
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
        }
        this._icon.icon_name = this._player.playing
            ? 'audio-headphones-symbolic'
            : 'audio-headphones-symbolic';
    }

    _setStatus(text) {
        this._statusLabel.set_text(text);
    }

    // ── pengaturan tampilan ────────────────────────────────────────────────

    _applyAppearance() {
        const width = this._settings.get_int('popup-width');
        this.menu.actor.set_style(`width: ${width}px;`);
        this.menu.box.set_style(`width: ${width - 16}px;`);

        const height = this._settings.get_int('popup-height');
        this._scrollView.set_style(`max-height: ${height}px;`);

        const scale = this._settings.get_double('font-scale');
        this._linesBox.set_style(`font-size: ${Math.round(13 * scale)}pt;`);
    }

    applySettings() {
        this._applyAppearance();
        this._rebuildTabs();
        this._renderLines();
        // kalau provider / bahasa berubah, cache key-nya beda → refetch
        this.refresh(false);
    }
});
