#!/usr/bin/env bash
# Produit, dans dist/ : un tarball, un .deb et une AppImage AUTONOME
# (webkit/gtk embarqués -> fonctionne sur n'importe quelle distro récente).
# Usage : packaging/linux-package.sh <version>   (ex. 0.1.5)
#
# Prérequis système (installés par la CI) :
#   build : libgtk-3-dev libwebkit2gtk-4.1-dev  (+ binaire compilé avec -tags webkit2_41)
#   outils: wget file imagemagick patchelf python3 fuse3 desktop-file-utils
set -euxo pipefail

VERSION="${1:?usage: linux-package.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BIN=build/bin/drossh
[ -f "$BIN" ] || { echo "Binaire introuvable : $BIN (compile d'abord avec wails build -tags webkit2_41)"; exit 1; }
mkdir -p dist

ARCHLIB=/usr/lib/x86_64-linux-gnu

# ------------------------------------------------------------------ Tarball
STAGE="drossh-$VERSION-linux-amd64"
rm -rf "dist/$STAGE"; mkdir -p "dist/$STAGE"
cp "$BIN" "dist/$STAGE/drossh"
cp packaging/drossh.desktop "dist/$STAGE/"
cp build/appicon.png "dist/$STAGE/drossh.png"
[ -f build/appicon.svg ] && cp build/appicon.svg "dist/$STAGE/drossh.svg" || true
cat > "dist/$STAGE/install.sh" <<'EOS'
#!/usr/bin/env bash
set -e
PREFIX="${PREFIX:-/usr/local}"
install -Dm755 drossh "$PREFIX/bin/drossh"
install -Dm644 drossh.desktop "$PREFIX/share/applications/drossh.desktop"
install -Dm644 drossh.png "$PREFIX/share/icons/hicolor/512x512/apps/drossh.png"
[ -f drossh.svg ] && install -Dm644 drossh.svg "$PREFIX/share/icons/hicolor/scalable/apps/drossh.svg" || true
echo "Drossh installé dans $PREFIX (lance : drossh)"
EOS
chmod +x "dist/$STAGE/install.sh"
( cd dist && tar czf "$STAGE.tar.gz" "$STAGE" && rm -rf "$STAGE" )
echo "→ dist/$STAGE.tar.gz"

# ------------------------------------------------------------------ .deb (nfpm)
export VERSION
go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest
"$(go env GOPATH)/bin/nfpm" package -f packaging/nfpm.yaml -p deb -t "dist/drossh_${VERSION}_amd64.deb"
echo "→ dist/drossh_${VERSION}_amd64.deb"

# ================= AppImage autonome =================
APPDIR="$(mktemp -d)/AppDir"
mkdir -p "$APPDIR"

# Icône 512x512 (linuxdeploy refuse le 1024 d'origine)
convert build/appicon.png -resize 512x512 /tmp/drossh-512.png

# Outils AppImage
TOOLS="$(mktemp -d)"
wget -qO "$TOOLS/linuxdeploy" https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage
wget -qO "$TOOLS/linuxdeploy-plugin-gtk.sh" https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh
wget -qO "$TOOLS/appimagetool" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
wget -qO "$TOOLS/runtime-x86_64" https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64
chmod +x "$TOOLS/linuxdeploy" "$TOOLS/linuxdeploy-plugin-gtk.sh" "$TOOLS/appimagetool"
export PATH="$TOOLS:$PATH"
export APPIMAGE_EXTRACT_AND_RUN=1   # pas de FUSE nécessaire pour faire tourner les outils

# Bundling binaire + gtk/webkit + dépendances
"$TOOLS/linuxdeploy" \
  --appdir "$APPDIR" \
  -e "$BIN" \
  -d packaging/drossh.desktop \
  -i /tmp/drossh-512.png \
  --icon-filename drossh \
  --plugin gtk

# Process auxiliaires WebKit, placés À CÔTÉ de la lib (usr/lib/webkit2gtk-4.1)
cp -a "$ARCHLIB/webkit2gtk-4.1" "$APPDIR/usr/lib/webkit2gtk-4.1"

# ICU (webkit en dépend ; linuxdeploy ne le copie pas tout seul)
cp -aL "$ARCHLIB"/libicudata.so.* "$APPDIR/usr/lib/" 2>/dev/null || true
cp -aL "$ARCHLIB"/libicui18n.so.* "$APPDIR/usr/lib/" 2>/dev/null || true
cp -aL "$ARCHLIB"/libicuuc.so.*   "$APPDIR/usr/lib/" 2>/dev/null || true

# Fermeture des dépendances : embarque toute lib encore manquante
# (hors glibc / pilotes GL, listés dans l'excludelist officielle)
wget -qO "$TOOLS/excludelist" https://raw.githubusercontent.com/AppImage/pkg2appimage/master/excludelist || true
EXCL=$(grep -vE '^\s*#|^\s*$' "$TOOLS/excludelist" 2>/dev/null | awk '{print $1}')
is_excluded() { echo "$EXCL" | grep -qx "$1"; }
search_paths() { echo "$APPDIR/usr/lib:$APPDIR/usr/lib/webkit2gtk-4.1:$ARCHLIB:/usr/lib:/lib"; }
for pass in 1 2 3 4; do
  while IFS= read -r elf; do
    file "$elf" 2>/dev/null | grep -q ELF || continue
    LD_LIBRARY_PATH="$(search_paths)" ldd "$elf" 2>/dev/null | awk '/=> \// {print $3}' | while IFS= read -r dep; do
      base="$(basename "$dep")"
      [ -e "$APPDIR/usr/lib/$base" ] && continue
      is_excluded "$base" && continue
      cp -aL "$dep" "$APPDIR/usr/lib/$base" 2>/dev/null && echo "  + $base"
    done
  done < <(find "$APPDIR/usr/bin" "$APPDIR/usr/lib" -type f 2>/dev/null)
done

# Patch des chemins libexec/injected-bundle codés en dur dans libwebkit
python3 -I packaging/patch-webkit.py "$APPDIR/usr/lib/libwebkit2gtk-4.1.so.0"

# AppRun maison : relie le chemin webkit patché à l'AppDir, charge l'env GTK, lance le binaire
mv "$APPDIR/AppRun" "$APPDIR/AppRun.linuxdeploy" 2>/dev/null || true
cat > "$APPDIR/AppRun" <<'EOS'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="$HERE"
# WebKit cherche ses process à /tmp/.drssh-wk/webkit2gtk-4.1 (patché dans la lib) :
# on relie ce chemin au contenu embarqué.
mkdir -p /tmp/.drssh-wk 2>/dev/null && ln -sfn "$HERE/usr/lib/webkit2gtk-4.1" /tmp/.drssh-wk/webkit2gtk-4.1 2>/dev/null
if [ -f "$HERE/apprun-hooks/linuxdeploy-plugin-gtk.sh" ]; then
  . "$HERE/apprun-hooks/linuxdeploy-plugin-gtk.sh"
fi
export LD_LIBRARY_PATH="$HERE/usr/lib:$HERE/usr/lib/webkit2gtk-4.1${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
exec "$HERE/AppRun.wrapped" "$@"
EOS
chmod +x "$APPDIR/AppRun"

# Assemble l'AppImage avec le runtime moderne (fuse3, plus de dépendance à libfuse2)
ARCH=x86_64 "$TOOLS/appimagetool" \
  --runtime-file "$TOOLS/runtime-x86_64" \
  "$APPDIR" "dist/Drossh-${VERSION}-x86_64.AppImage"
echo "→ dist/Drossh-${VERSION}-x86_64.AppImage"

echo "=== Contenu de dist/ ==="
ls -la dist/
