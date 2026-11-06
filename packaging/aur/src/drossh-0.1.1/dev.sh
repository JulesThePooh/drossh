#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Lance une commande Wails DANS la boîte à outils Docker.
#  Les fichiers générés t'appartiennent (pas à root), grâce à --user.
#
#  Exemples :
#    ./dev.sh doctor                  # vérifie que tout est OK
#    ./dev.sh build -tags webkit2_41  # compile l'appli
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/devhome \
  -e GOPATH=/tmp/go \
  -e GOCACHE=/tmp/gocache \
  -e XDG_CONFIG_HOME=/tmp/devhome/.config \
  -v "$PWD":/app \
  -w /app \
  drossh-dev:latest \
  wails "$@"
