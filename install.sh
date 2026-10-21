#!/usr/bin/env bash
# Install extension ke ~/.local/share/gnome-shell/extensions/
set -euo pipefail

UUID="spotify-lyrics-widget@jbech"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "==> Install $UUID"
mkdir -p "$DEST"
rsync -a --delete --exclude '*.mjs' "$SRC/" "$DEST/"

echo "==> Compile schemas"
glib-compile-schemas "$DEST/schemas"

echo "==> Enable extension"
gnome-extensions enable "$UUID" 2>/dev/null || true

cat <<EOF

Selesai. Biar aktif:
  * GNOME di Wayland  → logout lalu login lagi
  * GNOME di X11     → tekan Alt+F2, ketik "r", Enter

Cek status:
  gnome-extensions info $UUID

Kalau mau ganti provider ke LLM lokal (paling akurat buat K-pop):
  opencode serve --port 4096
  lalu di Preferences: provider = "LLM", base URL = http://127.0.0.1:4096/v1
EOF
