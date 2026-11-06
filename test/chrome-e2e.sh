#!/usr/bin/env bash
# End-to-end: real headless Chrome + the real extension + bridge + MCP.
# Requires Google Chrome or Chromium (Chrome 116+).
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8798}
DIR=/tmp/oct-e2e
PROFILE=/tmp/oct-e2e-profile
rm -rf "$DIR" "$PROFILE"; mkdir -p "$DIR"

cleanup() {
  [ -n "${CH:-}" ] && kill "$CH" 2>/dev/null
  [ -n "${BRIDGE:-}" ] && kill "$BRIDGE" 2>/dev/null
  pkill -f "oct-e2e-profil[e]" 2>/dev/null
  return 0
}
trap cleanup EXIT

# Test copy of the extension with settings seeded into DEFAULTS (never ship this).
cp -r extension "$DIR/extension"
sed -i "s#bridgeUrl: \"\",#bridgeUrl: \"ws://127.0.0.1:$PORT/ws\",#" "$DIR/extension/background.js"
sed -i "s#mode: \"ask\",#mode: \"auto\",#" "$DIR/extension/background.js"
grep -q "ws://127.0.0.1:$PORT/ws" "$DIR/extension/background.js" || { echo "SEED-FAILED"; exit 1; }

node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({port:+process.argv[2],devices:{}},null,2))' "$DIR/config.json" "$PORT"
OTTO_CHROME_DIR=$DIR node bridge/server.js > "$DIR/bridge.log" 2>&1 &
BRIDGE=$!
sleep 1

CHROME=${CHROME:-$(command -v google-chrome || command -v chromium)}
echo "using: $CHROME"
"$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --enable-extensions=load \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9235 --window-size=1280,800 "about:blank" > "$DIR/chrome.log" 2>&1 &
CH=$!
sleep 4
NODE_PATH=$PWD/bridge/node_modules node test/cdp-load.js 9235 "$DIR/extension"

echo -n "waiting for pairing request..."
PENDING=no
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -Eq '"pendingPairings":[1-9]' && { PENDING=yes; break; }
  sleep 1
done
echo " pending=$PENDING"
curl -fsS "http://127.0.0.1:$PORT/health"; echo
[ "$PENDING" = yes ] || { echo "--- chrome.log tail:"; tail -5 "$DIR/chrome.log"; echo "--- bridge.log:"; cat "$DIR/bridge.log"; exit 1; }

call_mcp() { curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" -H 'Content-Type: application/json' -d "$1"; }
mcp() { call_mcp "$1"; echo; }
call_mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' > /dev/null
REQS="$(call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"chrome_pair_requests","arguments":{}}}')"
REQ_ID="$(printf '%s' "$REQS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);const a=JSON.parse(r.result.content[0].text);if(a[0])process.stdout.write(a[0].requestId)})')"
[ -n "$REQ_ID" ] || { echo "No pairing request found"; exit 1; }
mcp "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"chrome_pair_approve\",\"arguments\":{\"requestId\":\"$REQ_ID\"}}}" > /dev/null
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"extensionConnected":true' && break; sleep 0.3; done

echo "== chrome_status"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"chrome_status","arguments":{}}}' | cut -c1-400
echo "== chrome_open example.com"
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"chrome_open","arguments":{"url":"https://example.com"}}}' | cut -c1-300
echo "== chrome_read"
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"chrome_read","arguments":{}}}' | cut -c1-700
echo "== chrome_screenshot -> shot.png"
mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"chrome_screenshot","arguments":{}}}' > "$DIR/shot.json"
node -e "const r=JSON.parse(require('fs').readFileSync('$DIR/shot.json','utf8'));const img=(r.result.content||[]).find(c=>c.type==='image');if(!img){console.log('NO IMAGE',JSON.stringify(r).slice(0,300));process.exit(1)}require('fs').writeFileSync('$DIR/shot.png',Buffer.from(img.data,'base64'));console.log('shot bytes:',require('fs').statSync('$DIR/shot.png').size)"
echo "== chrome_act submit httpbin form (type + click)"
mcp '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"chrome_open","arguments":{"url":"https://httpbin.org/forms/post"}}}' > /dev/null
sleep 2
mcp '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"chrome_act","arguments":{"steps":[{"action":"type","target":"Customer name:","value":"otto-test-value","replace":false}]}}}' | cut -c1-300
mcp '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"chrome_act","arguments":{"steps":[{"action":"click","target":"Medium"},{"action":"click","target":"Cheese"},{"action":"click","target":"Submit order"},{"action":"wait","ms":2500}]}}}' | cut -c1-300
mcp '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"chrome_read","arguments":{}}}' > "$DIR/post-read.json"
grep -c "otto-test-value" "$DIR/post-read.json" && echo TYPED-VALUE-SUBMITTED
node -e "const r=JSON.parse(require('fs').readFileSync('$DIR/shot.json','utf8'));const img=(r.result.content||[]).find(c=>c.type==='image');if(img){require('fs').writeFileSync('$DIR/shot.png',Buffer.from(img.data,'base64'));console.log('re-saved shot.png',require('fs').statSync('$DIR/shot.png').size)}"
echo "E2E-DONE"
