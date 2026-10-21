# Spotify Lyrics Widget (GNOME Shell extension)

Widget panel buat GNOME Shell (Ubuntu 26.04 / GNOME 50) yang nampilin **lirik
lagu Spotify** lengkap dengan:

- 🎤 **Lirik original** (dengan timestamp LRC, sinkron sama lagunya)
- 🔤 **Romaji** — Korea (Revised Romanization) & Jepang (Hepburn), dihitung
  offline tanpa panggil API
- 🇬🇧 **Terjemahan English**
- 🇮🇩 **Terjemahan Indonesia**
- 🎵 Kontrol playback (prev / play-pause / next) + progress bar yang bisa
  diklik buat seek
- 🎨 Cover art album

Data lirik dari **LRCLIB**, terjemahan dari **Google Translate** (gratis),
**MyMemory**, atau **LLM OpenAI-compatible** (paling akurat buat K-pop).

---

## Install

```bash
cd spotify-lyrics-widget
./install.sh
```

Lalu:

- **Wayland** (default di Ubuntu 26.04): logout → login
- **X11**: `Alt+F2` → ketik `r` → Enter

Cek status:

```bash
gnome-extensions info spotify-lyrics-widget@jbech
```

Kalau mau uninstall:

```bash
rm -rf ~/.local/share/gnome-shell/extensions/spotify-lyrics-widget@jbech
gsettings set org.gnome.shell enabled-extensions "[]"
```

---

## Cara pakainya

1. Nyalain Spotify, putar lagu.
2. Klik ikon headphone di panel atas → popup lirik kebuka.
3. Tab di bawah header buat ganti bahasa:
   **Original → Romaji → English → Indonesia**.
4. Baris yang lagi dimainkan otomatis di-highlight + auto-scroll.
5. Klik progress bar buat loncat ke bagian tertentu.

> Widget otomatis ambil lirik tiap ganti lagu, dan hasilanya di-cache di
> `~/.cache/spotify-lyrics-widget/` jadi lagu yang sama gak di-download ulang.

---

## Provider terjemahan

Buka **Preferences** extension-nya (GNOME Extensions app, atau
`gnome-extensions prefs spotify-lyrics-widget@jbech`).

| Provider | Keterangan | Gratis? |
|---|---|---|
| `Google Translate` | Default. Bagus & cepat, batching per lagu | ✅ |
| `MyMemory` | Fallback, ada quota ±5.000 kata/hari | ✅ |
| `LLM OpenAI-compatible` | Paling akurat + romaji dari LLM |取决于 model |
| `Nggak ada terjemahan` | Cuma original + romaji | — |

### Pakai LLM lokal (paling recommended buat K-pop)

Butuh model lokal / server yang jalan, misalnya **opencode**:

```bash
opencode serve --port 4096
```

Lalu di Preferences:

- Provider: `LLM OpenAI-compatible`
- Base URL: `http://127.0.0.1:4096/v1`
- Model: misalnya `anthropic/claude-sonnet-4-5`
- API key: kosongkan (kalau lokal)

Ollama juga bisa: `http://127.0.0.1:11434/v1` + model `llama3.1` / `gemma2`.

---

## Sumber lirik

Widget nyoba sumber ini berurutan:

| # | Sumber | Timestamp? | Keterangan |
|---|---|---|---|
| 1 | **Folder lokal** | ✅ (kalau .lrc) | `~/.local/share/spotify-lyrics-widget/lyrics/` — nama file `Artis - Judul.lrc` |
| 2 | **LRCLIB** | ✅ | CC0, gratis, API publik. Coverage paling luas |
| 3 | **Genius** | ❌ | Untuk artis indie / lagu yang belum ada di LRCLIB. **Default mati** |
| 4 | **lyrics.ovh** | ❌ | Fallback terakhir, database lebih lama |

### Kenapa Genius default mati?

- API lirik resmi Genius **butuh login** (balikin `403 This action requires a
  logged in user`), jadi lirik diambil dari HTML halaman lagu publik.
- Genius **discourage automated access** di Terms of Service-nya.
- Genius nggak punya timestamp → highlight baris cuma **perkiraan** (dibagi rata
  dengan durasi lagu), bukan sinkron beneran.

Kalau lo mau pake (mis. buat artis indie kayak Aryiion):
Preferences → centeng **"Genius (untuk artis indie)"**.

> Cara paling legal & akurat: taruh file `.lrc` sendiri di folder lokal.
> Sumbernya bisa dari lyric video YouTube (subtitle), situs resmi artis, atau
>LyricsGenius yang lo copy manual.

### Contoh file lokal

```
~/.local/share/spotify-lyrics-widget/lyrics/Aryiion - BEHIND.lrc
```

Isi `.lrc` (format standar LRC, timestamp per baris):
```
[00:12.30]She wanna vibe late night
[00:15.10]Aku dan joki all night
[00:18.00]We gonna puff this week ku dengannya
```

Format `.txt` juga bisa (tanpa timestamp → dibagi rata).

---

## Pengaturan

| Setting | Default | Keterangan |
|---|---|---|
| Provider | `google` | Sumber terjemahan |
| Bahasa tujuan | `en`, `id` | Tambah/hapus bahasa bebas |
| Tampilkan Romaji | on | Tab romaji |
| Ukuran font | `1.0` | Skala teks lirik |
| Lebar popup | `460` | Piksel |
| Tinggi daftar lirik | `520` | Piksel |
| Timestamp | off | Tampilin `[1:23]` di tiap baris |
| Auto scroll | on | Ikutin baris yang dimainkan |
| Posisi panel | `right` | left / center / right |
| Buka popup otomatis | off | Popup kebuka tiap ganti lagu |

---

## Cara kerja (arsitektur)

```
Spotify (MPRIS)
   │  org.mpris.MediaPlayer2.spotify  (metadata + posisi playback)
   ▼
lib/mpris.js ──► lib/lyrics.js ──► LRCLIB (lirik + timestamp LRC)
                              └──► lyrics.ovh (fallback)
   │
   ▼
lib/translate.js ──► Google / MyMemory / LLM   (terjemahan per baris)
                └──► lib/romaji.js               (romaji offline)
   │
   ▼
lib/cache.js  (JSON di ~/.cache/spotify-lyrics-widget/)
   │
   ▼
lib/widget.js  (popup: header, kontrol, tab bahasa, daftar lirik)
```

Semua request HTTP pakai **libsoup 3** (`gi://Soup`), jadi nggak butuh service
tambahan atau Python — extension ini pure GJS.

### Romaji offline

`lib/romaji.js` mengimplementasikan Revised Romanization (Korea) dan Hepburn
(Jepang) dari nol, termasuk:

- harfak gim (받침) + liaison ke syllable berikutnya (`강아지` → `gangaji`)
- 쌍받침 (`값이` → `gapsi`, `읽어요` → `ilgeoyo`)
- sokuon (`っ`), chōonpu (`ー`), dan `ん` (Hepburn)

Kanji Jepang nggak bisa diromaji offline — kalau pake LLM, romaji-nya
dibuat model (lebih akurat buat kanji).

---

## Struktur folder

```
spotify-lyrics-widget/
├── install.sh
├── README.md
└── src/
    ├── metadata.json
    ├── extension.js          # entry point, wiring MPRIS → service → widget
    ├── prefs.js              # preferences (Adw)
    ├── stylesheet.css
    ├── lib/
    │   ├── http.js           # libsoup 3 wrapper
    │   ├── lyrics.js         # LRCLIB + lyrics.ovh + folder lokal + parsing LRC
    │   ├── genius.js         # sumber cadangan (Genius) buat artis indie
    │   ├── translate.js      # provider terjemahan
    │   ├── romaji.js         # RR (Korea) + Hepburn (Jepang)
    │   ├── cache.js          # cache JSON di ~/.cache
    │   ├── service.js        # pipeline: fetch → translate → cache
    │   ├── mpris.js          # klien MPRIS Spotify
    │   └── widget.js         # UI popup
    └── schemas/
        └── org.gnome.shell.extensions.spotify-lyrics-widget.gschema.xml
```

---

## Troubleshooting

**Lirik ga ketemu?**
Coba klik `Refresh` di footer popup. Lagu yang liriknya ada di LRCLIB
biasanya lagu pop/K-pop yang populer. Lagu Indonesia yang viral sering ada.

**Widget gak muncul di panel?**
`gnome-extensions info spotify-lyrics-widget@jbech` → kalau `State: ERROR`,
lihat `journalctl -f -o cat /usr/bin/gnome-shell` buat cari pesan errornya.

**Terjemahan kosong?**
Cek quota MyMemory, atau ganti provider ke `google`. Kalau pake LLM, pastikan
`opencode serve` jalan dan nama modelnya bener.

**Mau paksa ambil ulang lirik?**
Klik `Refresh`, atau hapus cache:
`rm -rf ~/.cache/spotify-lyrics-widget/*`

---

## Credit

- Lirik: [LRCLIB](https://lrclib.net) (dibuat oleh trxn3)
- Terjemahan: Google Translate, MyMemory, atau LLM pilihan lo
- API: [MPRIS spec](https://www.freedesktop.org/wiki/Specifications/mpris-spec/metadata)
