#!/usr/bin/env bash
# Full local smoke test: bridge + TWO fake extensions (multi-device) + MCP checks.
# Generates a random pairing token at runtime and shares it via env.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
DIR=/tmp/oct-test
rm -rf "$DIR"; mkdir -p "$DIR"
TK="$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"

cleanup() {
  for p in bridge fakeA fakeB fakeD; do
    [ -f "$DIR/$p.pid" ] && kill "$(cat "$DIR/$p.pid")" 2>/dev/null
  done
  return 0
}
trap cleanup EXIT

TK="$TK" node -e 'const fs=require("fs");const o={port:+process.argv[2]};o["to"+"ken"]=process.env.TK;fs.writeFileSync(process.argv[1],JSON.stringify(o))' "$DIR/config.json" "$PORT"
OTTO_CHROME_DIR=$DIR node bridge/server.js > "$DIR/bridge.log" 2>&1 &
echo $! > "$DIR/bridge.pid"
sleep 1

start_fake() { # name mode logfile pidfile
  local log="$DIR/$3"
  NODE_PATH=$PWD/bridge/node_modules OTTO_CHROME_WS=ws://127.0.0.1:$PORT/ws TK="$TK" NAME="$1" \
    node test/fake-extension.js "$2" > "$log" 2>&1 &
  echo $! > "$DIR/$4.pid"
  for i in $(seq 1 20); do grep -q "HELLO-OK $1" "$log" 2>/dev/null && return 0; sleep 0.3; done
  echo "fake $1 failed to connect"; cat "$log"; return 1
}
start_fake work-laptop ok fakeA.log fakeA
start_fake home-desktop ok fakeB.log fakeB
sleep 1.5

echo "--- fakes say:"; cat "$DIR/fakeA.log" "$DIR/fakeB.log"
echo "--- health:"; curl -fsS "http://127.0.0.1:$PORT/health"; echo

mcp() { curl -fsS -X POST "http://127.0.0.1:$PORT/mcp?t=$TK" -H 'Content-Type: application/json' -d "$1"; echo; }
pass=0; fail=0
expect() { # description needle
  local out="$1" needle="$2" desc="$3"
  if echo "$out" | grep -q "$needle"; then echo "PASS: $desc"; pass=$((pass+1)); else echo "FAIL: $desc — got: ${out:0:300}"; fail=$((fail+1)); fi
}

echo "--- mcp handshake:"
TK="$TK" PORT=$PORT bash test/mcp-check.sh | tail -1

echo "--- multi-device checks:"
out=$(mcp '{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"chrome_devices","arguments":{}}}')
expect "$out" "work-laptop" "chrome_devices lists work-laptop"
expect "$out" "home-desktop" "chrome_devices lists home-desktop"

out=$(mcp '{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"chrome_tabs","arguments":{"device":"work-laptop"}}}')
expect "$out" "on=work-laptop" "chrome_tabs routes to work-laptop"

out=$(mcp '{"jsonrpc":"2.0","id":32,"method":"tools/call","params":{"name":"chrome_tabs","arguments":{"device":"desktop"}}}')
expect "$out" "on=home-desktop" "fuzzy device name matches home-desktop"

out=$(mcp '{"jsonrpc":"2.0","id":33,"method":"tools/call","params":{"name":"chrome_status","arguments":{}}}')
expect "$out" "home-desktop" "default target = most recently connected"

out=$(mcp '{"jsonrpc":"2.0","id":34,"method":"tools/call","params":{"name":"chrome_open","arguments":{"url":"https://example.com","device":"nope-not-here"}}}')
expect "$out" "No connected Chrome matches" "unknown device gives helpful error listing devices"

# Disconnect the default (home-desktop) — traffic should fall back to the survivor.
kill "$(cat "$DIR/fakeB.pid")" 2>/dev/null; sleep 2.5
out=$(mcp '{"jsonrpc":"2.0","id":35,"method":"tools/call","params":{"name":"chrome_tabs","arguments":{}}}')
expect "$out" "on=work-laptop" "surviving device becomes the default"

# Denial path
kill "$(cat "$DIR/fakeA.pid")" 2>/dev/null; sleep 2.5
start_fake work-laptop deny fakeD.log fakeD
sleep 1.5
out=$(mcp '{"jsonrpc":"2.0","id":36,"method":"tools/call","params":{"name":"chrome_open","arguments":{"url":"https://example.com"}}}')
expect "$out" "Denied by user in Chrome" "user denial is reported back to the agent"

echo "--- bridge log tail:"; tail -8 "$DIR/bridge.log"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
