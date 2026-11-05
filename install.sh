#!/usr/bin/env bash
# Otto Chrome Bridge installer — run on your Otto (or any Linux/macOS box with Node 18+).
#
#   curl -fsSL https://raw.githubusercontent.com/jbotte/otto-chrome-bridge/main/install.sh | bash
#
# Options: --port N --token XXX --repo URL --no-start
set -euo pipefail

REPO="${REPO:-https://github.com/jbotte/otto-chrome-bridge.git}"
DIR="${OTTO_CHROME_DIR:-$HOME/.otto-chrome}"
PORT="${OTTO_CHROME_PORT:-8712}"
TOKEN="${OTTO_CHROME_TOKEN:-}"
START=1
SRC=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --no-start) START=0; shift;;
    *) echo "unknown option: $1" >&2; exit 1;;
  esac
done

command -v node >/dev/null || { echo "ERROR: node is required (https://nodejs.org)"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "ERROR: node >= 18 required, found $(node --version)"; exit 1; }

# Locate source: use the repo this script sits in, else clone.
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bridge/server.js" ]; then
  SRC="$SCRIPT_DIR"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Fetching otto-chrome-bridge..."
  git clone --depth 1 "$REPO" "$TMP/repo" >/dev/null 2>&1 || {
    curl -fsSL "${REPO%.git}/archive/refs/heads/main.tar.gz" | tar xz -C "$TMP"
    mv "$TMP"/*/ "$TMP/repo"
  }
  SRC="$TMP/repo"
fi

echo "Installing to $DIR (port $PORT)..."
mkdir -p "$DIR"
rm -rf "$DIR/bridge" "$DIR/extension"
cp -r "$SRC/bridge" "$DIR/bridge"
cp -r "$SRC/extension" "$DIR/extension"

# Pairing token: keep an existing one unless overridden.
if [ -z "$TOKEN" ] && [ -f "$DIR/config.json" ]; then
  TOKEN="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token||"")}catch(e){}' "$DIR/config.json")"
fi
if [ -z "$TOKEN" ]; then
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"
fi
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({port:+process.argv[2],token:process.argv[3]},null,2));fs.chmodSync(process.argv[1],0o600)' "$DIR/config.json" "$PORT" "$TOKEN"

# Dependencies (only needed when running the bridge; harmless offline if cached)
( cd "$DIR/bridge" && { npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund; } )

cat > "$DIR/run.sh" <<EOF
#!/usr/bin/env bash
cd "$DIR/bridge" && exec node server.js
EOF

cat > "$DIR/start.sh" <<EOF
#!/usr/bin/env bash
# Start the bridge in the background if it is not already running.
PIDFILE="$DIR/bridge.pid"
if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then
  echo "otto-chrome-bridge already running (pid \$(cat "\$PIDFILE"))"
  exit 0
fi
mkdir -p "$DIR"
nohup "$DIR/run.sh" >> "$DIR/bridge.log" 2>&1 &
echo \$! > "\$PIDFILE"
echo "otto-chrome-bridge started (pid \$(cat "\$PIDFILE"))"
EOF
chmod +x "$DIR/run.sh" "$DIR/start.sh"

cat > "$DIR/uninstall.sh" <<EOF
#!/usr/bin/env bash
[ -f "$DIR/bridge.pid" ] && kill "\$(cat "$DIR/bridge.pid")" 2>/dev/null
rm -rf "$DIR/bridge" "$DIR/extension" "$DIR/run.sh" "$DIR/start.sh" "$DIR/bridge.log" "$DIR/bridge.pid"
if command -v crontab >/dev/null; then
  ( crontab -l 2>/dev/null | grep -v "otto-chrome/start.sh" ) | crontab - || true
fi
echo "Removed. Config kept at $DIR/config.json (delete it to forget the pairing token)."
EOF
chmod +x "$DIR/uninstall.sh"

# Autostart via cron @reboot when available (no root needed).
if command -v crontab >/dev/null; then
  ( crontab -l 2>/dev/null | grep -v "otto-chrome/start.sh"; echo "@reboot $DIR/start.sh" ) | crontab - || true
fi

if [ "$START" = "1" ]; then
  "$DIR/start.sh"
  sleep 1
  HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || echo '{"ok":false}')"
else
  HEALTH='{"ok":"not started (use start.sh)"}'
fi

# Figure out the addresses your Chrome can reach this box on.
BRIDGE_URLS=""
MAGIC="$(tailscale status --json 2>/dev/null | sed -n 's/.*"MagicDNSName": "\([^"]*\)".*/\1/p' || true)"
TSIP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
LANIP="$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0 2>/dev/null || true)"
[ -n "$MAGIC" ] && BRIDGE_URLS="ws://$MAGIC:$PORT/ws"
[ -n "$TSIP" ] && [ "$TSIP" != "$MAGIC" ] && BRIDGE_URLS="$BRIDGE_URLS ws://$TSIP:$PORT/ws"
[ -n "$LANIP" ] && BRIDGE_URLS="$BRIDGE_URLS ws://$LANIP:$PORT/ws"

cat <<EOF

============================================================
 Otto Chrome Bridge installed.
============================================================
 Bridge files:   $DIR
 Status:         $HEALTH
 Logs:           $DIR/bridge.log   (uninstall: $DIR/uninstall.sh)

 ── Step 1 · Put the extension in Chrome (on the computer your browser lives on) ──
   Download:  https://github.com/jbotte/otto-chrome-bridge/archive/refs/heads/main.zip
   Unzip it, then open chrome://extensions → enable "Developer mode"
   → "Load unpacked" → pick the folder named  extension  (inside otto-chrome-bridge-main).

 ── Step 2 · Point the extension at this Otto ──
   Click the Otto Chrome Bridge puzzle-piece icon and fill in:
     Bridge URL:   $BRIDGE_URLS   ← pick one reachable from this computer
     Token:        $TOKEN
   Mode "Ask me before Otto acts" is recommended. Press Save & connect.

 ── Step 3 · Connect your Otto ──
   In the Otto app: Settings → Integrations → + → MCP server, URL:
     http://127.0.0.1:$PORT/mcp?t=$TOKEN
   (From another machine use this box's address instead of 127.0.0.1.)

 Then tell your Otto: "open example.com in my Chrome and read it back to me".
============================================================
EOF
