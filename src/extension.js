import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SpotifyPlayer} from './lib/mpris.js';
import {LyricsService} from './lib/service.js';
import {LyricsIndicator} from './lib/widget.js';

export default class SpotifyLyricsWidgetExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._player = new SpotifyPlayer();
        this._service = new LyricsService(this._settings);
        this._indicator = new LyricsIndicator(this._settings, this._player, this._service);

        const position = this._settings.get_string('panel-position');
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, position);

        this._playerSignals = [
            this._player.connect('track-changed', () => {
                this._indicator.onTrackChanged();
                if (this._settings.get_boolean('open-on-change'))
                    this._indicator.menu.open();
            }),
            this._player.connect('player-appeared', () => this._indicator.onTrackChanged()),
            this._player.connect('player-vanished', () => this._indicator.onPlayerVanished()),
            this._player.connect('position-changed', () => this._indicator.updatePosition()),
            this._player.connect('playback-changed', () => this._indicator.updatePosition()),
        ];

        // timer buat update posisi + baris aktif (selalu jalan, biar state
        // pas popup kebuka udah langsung bener)
        this._positionTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._indicator.updatePosition();
            return GLib.SOURCE_CONTINUE;
        });

        this._settingsSignals = [
            this._settings.connect('changed::font-scale',
                () => this._indicator.applySettings()),
            this._settings.connect('changed::popup-width',
                () => this._indicator.applySettings()),
            this._settings.connect('changed::popup-height',
                () => this._indicator.applySettings()),
            this._settings.connect('changed::show-timestamps',
                () => this._indicator.applySettings()),
            this._settings.connect('changed::target-languages',
                () => this._indicator.applySettings()),
            this._settings.connect('changed::show-romaji',
                () => this._indicator.applySettings()),
            this._settings.connect('changed::provider',
                () => this._indicator.applySettings()),
        ];

        this._indicator.onPlayerVanished();
    }

    disable() {
        if (this._positionTimer) {
            GLib.Source.remove(this._positionTimer);
            this._positionTimer = 0;
        }

        for (const id of this._settingsSignals ?? [])
            this._settings.disconnect(id);
        this._settingsSignals = [];

        // disconnect signal player DULUAN, baru destroy — soalnya destroy()
        // bisa nge-emit 'player-vanished' yang n touching widget
        for (const id of this._playerSignals ?? [])
            this._player.disconnect(id);
        this._playerSignals = [];

        this._player?.destroy();
        this._player = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._service?.destroy();
        this._service = null;

        this._settings = null;
    }
}
