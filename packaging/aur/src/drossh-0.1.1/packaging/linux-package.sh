#!/usr/bin/env bash
# Produit, dans dist/ : un tarball, un .deb et un AppImage à partir du binaire compilé.
# Usage : packaging/linux-package.sh <version>   (ex. 0.1.0)
set -euo pipefail

VERSION="${1:?usage: linux-package.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BIN=build/bin/drossh
[ -f "$BIN" ] || { echo "Binaire introuvable : $BIN (compile d'abord avec wails build)"; exit 1; }
mkdir -p dist

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

# ------------------------------------------------------------------ AppImage
APPDIR="$(mktemp -d)/AppDir"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps"
cp "$BIN" "$APPDIR/usr/bin/drossh"
cp packaging/drossh.desktop "$APPDIR/drossh.desktop"
cp packaging/drossh.desktop "$APPDIR/usr/share/applications/drossh.desktop"
cp build/appicon.png "$APPDIR/drossh.png"
cp build/appicon.png "$APPDIR/usr/share/icons/hicolor/512x512/apps/drossh.png"
cat > "$APPDIR/AppRun" <<'EOS'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
exec "$HERE/usr/bin/drossh" "$@"
EOS
chmod +x "$APPDIR/AppRun"

wget -qO /tmp/appimagetool \
  https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x /tmp/appimagetool
ARCH=x86_64 /tmp/appimagetool --appimage-extract-and-run "$APPDIR" "dist/Drossh-${VERSION}-x86_64.AppImage"
echo "→ dist/Drossh-${VERSION}-x86_64.AppImage"

echo "=== Contenu de dist/ ==="
ls -la dist/
