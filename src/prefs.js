import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DiskCache} from './lib/cache.js';

const PROVIDERS = [
    ['google', 'Google Translate (gratis)'],
    ['mymemory', 'MyMemory (gratis, ada quota)'],
    ['llm', 'LLM OpenAI-compatible (paling akurat)'],
    ['none', 'Nggak ada terjemahan'],
];

const LANGUAGES = [
    ['en', 'English'],
    ['id', 'Indonesia'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['zh-CN', 'Chinese (Simplified)'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['ar', 'Arabic'],
    ['th', 'Thai'],
    ['vi', 'Vietnamese'],
    ['nl', 'Dutch'],
    ['tr', 'Turkish'],
    ['it', 'Italian'],
    ['ms', 'Malay'],
    ['pl', 'Polish'],
];

export default class SpotifyLyricsWidgetPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Lirik Widget',
            icon_name: 'audio-headphones-symbolic',
        });
        window.add(page);

        // ── Terjemahan ──────────────────────────────────────────────────────
        const translateGroup = new Adw.PreferencesGroup({
            title: 'Terjemahan',
            description: 'Lirik asli diambil dari LRCLIB, terjemahan dari provider di bawah.',
        });
        page.add(translateGroup);

        const providerRow = new Adw.ComboRow({
            title: 'Provider',
            subtitle: 'Pilih sumber terjemahan',
            model: Gtk.StringList.new(PROVIDERS.map(([, label]) => label)),
        });
        providerRow.selected = Math.max(0,
            PROVIDERS.findIndex(([id]) => id === settings.get_string('provider')));
        providerRow.connect('notify::selected', () => {
            settings.set_string('provider', PROVIDERS[providerRow.selected][0]);
        });
        translateGroup.add(providerRow);

        const romajiRow = new Adw.SwitchRow({
            title: 'Tampilkan tab Romaji',
            subtitle: 'Romanisasi Korea (Revised Romanization) & Jepang (Hepburn)',
        });
        romajiRow.active = settings.get_boolean('show-romaji');
        romajiRow.connect('notify::active', () => {
            settings.set_boolean('show-romaji', romajiRow.active);
        });
        translateGroup.add(romajiRow);

        const localRow = new Adw.SwitchRow({
            title: 'Folder lirik lokal',
            subtitle: '~/.local/share/spotify-lyrics-widget/lyrics — nama file "Artis - Judul.lrc"',
        });
        localRow.active = settings.get_boolean('use-local-lyrics');
        localRow.connect('notify::active', () => {
            settings.set_boolean('use-local-lyrics', localRow.active);
        });
        translateGroup.add(localRow);

        const geniusRow = new Adw.SwitchRow({
            title: 'Genius (untuk artis indie)',
            subtitle: 'Default mati. Lirik diambil dari halaman Genius (API resminya butuh login)',
        });
        geniusRow.active = settings.get_boolean('use-genius');
        geniusRow.connect('notify::active', () => {
            settings.set_boolean('use-genius', geniusRow.active);
        });
        translateGroup.add(geniusRow);

        const langGroup = new Adw.PreferencesGroup({
            title: 'Bahasa tujuan',
            description: 'Muncul sebagai tab di dalam widget.',
        });
        page.add(langGroup);
        const selected = new Set(settings.get_strv('target-languages'));
        for (const [code, label] of LANGUAGES) {
            const row = new Adw.SwitchRow({
                title: label,
                subtitle: code,
            });
            row.active = selected.has(code);
            row.connect('notify::active', () => {
                if (row.active)
                    selected.add(code);
                else
                    selected.delete(code);
                settings.set_strv('target-languages', Array.from(selected));
            });
            langGroup.add(row);
        }

        // ── LLM ────────────────────────────────────────────────────────────
        const llmGroup = new Adw.PreferencesGroup({
            title: 'LLM (OpenAI-compatible)',
            description: 'Dipakai kalau provider = LLM. Bisa juga pakai opencode serve di localhost.',
        });
        page.add(llmGroup);

        const baseRow = new Adw.EntryRow({
            title: 'Base URL',
            text: settings.get_string('llm-base-url'),
        });
        baseRow.connect('apply', () => {
            settings.set_string('llm-base-url', baseRow.text.trim());
        });
        llmGroup.add(baseRow);

        const modelRow = new Adw.EntryRow({
            title: 'Model',
            text: settings.get_string('llm-model'),
        });
        modelRow.connect('apply', () => {
            settings.set_string('llm-model', modelRow.text.trim());
        });
        llmGroup.add(modelRow);

        const keyRow = new Adw.PasswordEntryRow({
            title: 'API key',
            text: settings.get_string('llm-api-key'),
        });
        keyRow.connect('apply', () => {
            settings.set_string('llm-api-key', keyRow.text.trim());
        });
        llmGroup.add(keyRow);

        // ── Tampilan ───────────────────────────────────────────────────────
        const lookGroup = new Adw.PreferencesGroup({
            title: 'Tampilan',
        });
        page.add(lookGroup);

        const scaleRow = new Adw.SpinRow({
            title: 'Ukuran font',
            subtitle: 'Skala teks lirik',
            adjustment: new Gtk.Adjustment({
                lower: 0.7, upper: 2.0, step_increment: 0.05, page_increment: 0.1,
            }),
        });
        scaleRow.value = settings.get_double('font-scale');
        scaleRow.connect('notify::value', () => {
            settings.set_double('font-scale', scaleRow.value);
        });
        lookGroup.add(scaleRow);

        const widthRow = new Adw.SpinRow({
            title: 'Lebar popup',
            adjustment: new Gtk.Adjustment({
                lower: 320, upper: 900, step_increment: 10, page_increment: 50,
            }),
        });
        widthRow.value = settings.get_int('popup-width');
        widthRow.connect('notify::value', () => {
            settings.set_int('popup-width', widthRow.value);
        });
        lookGroup.add(widthRow);

        const heightRow = new Adw.SpinRow({
            title: 'Tinggi daftar lirik',
            adjustment: new Gtk.Adjustment({
                lower: 200, upper: 1200, step_increment: 10, page_increment: 50,
            }),
        });
        heightRow.value = settings.get_int('popup-height');
        heightRow.connect('notify::value', () => {
            settings.set_int('popup-height', heightRow.value);
        });
        lookGroup.add(heightRow);

        const timestampsRow = new Adw.SwitchRow({
            title: 'Tampilkan timestamp',
            subtitle: 'Timestamp LRC di depan tiap baris',
        });
        timestampsRow.active = settings.get_boolean('show-timestamps');
        timestampsRow.connect('notify::active', () => {
            settings.set_boolean('show-timestamps', timestampsRow.active);
        });
        lookGroup.add(timestampsRow);

        const scrollRow = new Adw.SwitchRow({
            title: 'Auto scroll',
            subtitle: 'Ikutin baris yang sedang dimainkan',
        });
        scrollRow.active = settings.get_boolean('auto-scroll');
        scrollRow.connect('notify::active', () => {
            settings.set_boolean('auto-scroll', scrollRow.active);
        });
        lookGroup.add(scrollRow);

        // ── Perilaku ───────────────────────────────────────────────────────
        const behaviourGroup = new Adw.PreferencesGroup({
            title: 'Perilaku',
        });
        page.add(behaviourGroup);

        const positionRow = new Adw.ComboRow({
            title: 'Posisi di panel',
            model: Gtk.StringList.new(['Kiri', 'Tengah', 'Kanan']),
        });
        const positions = ['left', 'center', 'right'];
        positionRow.selected = Math.max(0,
            positions.indexOf(settings.get_string('panel-position')));
        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positions[positionRow.selected]);
        });
        behaviourGroup.add(positionRow);

        const openRow = new Adw.SwitchRow({
            title: 'Buka popup otomatis saat ganti lagu',
        });
        openRow.active = settings.get_boolean('open-on-change');
        openRow.connect('notify::active', () => {
            settings.set_boolean('open-on-change', openRow.active);
        });
        behaviourGroup.add(openRow);

        const cacheRow = new Adw.ActionRow({
            title: 'Cache lirik',
            subtitle: 'Lirik + terjemahan disimpan di ~/.cache/spotify-lyrics-widget',
        });
        const clearButton = new Gtk.Button({
            label: 'Bersihkan',
            valign: Gtk.Align.CENTER,
        });
        clearButton.connect('clicked', () => {
            clearLyricsCache();
            clearButton.set_label('Dibersihkan ✓');
        });
        cacheRow.add_suffix(clearButton);
        behaviourGroup.add(cacheRow);
    }
}

/**
 * Hapus semua cache lirik yang tersimpan.
 */
function clearLyricsCache() {
    const cache = new DiskCache();
    const dir = cache.dir;
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
