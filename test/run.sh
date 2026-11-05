#!/usr/bin/env bash
# Full local smoke test: bridge + fake extension + MCP checks.
# Generates a random pairing token at runtime and shares it via env.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
DIR=/tmp/oct-test
rm -rf "$DIR"; mkdir -p "$DIR"
TK="$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"

cleanup() {
  [ -f "$DIR/bridge.pid" ] && kill "$(cat "$DIR/bridge.pid")" 2>/dev/null
  [ -f "$DIR/fake.pid" ] && kill "$(cat "$DIR/fake.pid")" 2>/dev/null
  return 0
}
trap cleanup EXIT

TK="$TK" node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({port:+process.argv[2],token:process.env.TK}))' "$DIR/config.json" "$PORT"
OTTO_CHROME_DIR=$DIR node bridge/server.js > "$DIR/bridge.log" 2>&1 &
echo $! > "$DIR/bridge.pid"
sleep 1
NODE_PATH=$PWD/bridge/node_modules OTTO_CHROME_WS=ws://127.0.0.1:$PORT/ws TK="$TK" \
  node test/fake-extension.js ok > "$DIR/fake.log" 2>&1 &
echo $! > "$DIR/fake.pid"
sleep 1

echo "--- fake says:"; cat "$DIR/fake.log"
echo "--- health:"; curl -fsS "http://127.0.0.1:$PORT/health"; echo
echo "--- mcp checks:"
TK="$TK" PORT=$PORT bash test/mcp-check.sh
RC=$?
echo "--- deny path check (extension replies 'Denied by user in Chrome'):"
kill "$(cat "$DIR/fake.pid")" 2>/dev/null; sleep 1
NODE_PATH=$PWD/bridge/node_modules OTTO_CHROME_WS=ws://127.0.0.1:$PORT/ws TK="$TK" node test/fake-extension.js deny > /dev/null 2>&1 &
echo $! > "$DIR/fake.pid"
sleep 1
curl -fsS -X POST "http://127.0.0.1:$PORT/mcp?t=$TK" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"chrome_open","arguments":{"url":"https://example.com"}}}' | grep -o "Denied by user in Chrome" || RC=1
echo "(denied open reported back to agent as expected)"
echo "--- bridge log:"; tail -6 "$DIR/bridge.log"
exit $RC
