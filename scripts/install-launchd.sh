#!/usr/bin/env bash
#
# Instala renamer como LaunchAgent para que arranque al iniciar sesion y se
# reinicie si se cae. Hay que correrlo EN LA MAC, no en otra maquina.
#
#   ./scripts/install-launchd.sh
#
# Para quitarlo:
#   launchctl bootout gui/$(id -u)/com.alfredo.renamer
#   rm ~/Library/LaunchAgents/com.alfredo.renamer.plist

set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.alfredo.renamer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

if [ -z "$NODE" ]; then
  echo "No encontre node en el PATH." >&2
  exit 1
fi

if [ ! -f "$PROJECT/dist/server.js" ]; then
  echo "Falta el build. Corre:  npm install && npm run build" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/data"

sed -e "s|__NODE__|$NODE|g" -e "s|__PROJECT__|$PROJECT|g" \
  "$PROJECT/scripts/$LABEL.plist" > "$PLIST"

# bootout primero para que un reinstall tome el plist nuevo.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Instalado. node: $NODE"
echo "Logs: $PROJECT/data/renamer.log"
echo
sleep 1
if curl -fsS "http://127.0.0.1:${PORT:-7845}/health" >/dev/null 2>&1; then
  echo "Responde en http://$(hostname -s).local:${PORT:-7845}"
else
  echo "Todavia no responde. Revisa $PROJECT/data/renamer.error.log"
fi
