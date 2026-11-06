#!/usr/bin/env bash
# Full local smoke test: loopback MCP + two named, owner-approved browser clients.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
DIR=/tmp/oct-test
rm -rf "$DIR"; mkdir -p "$DIR"

cleanup() {
  for p in bridge fakeA fakeB fakeD; do
    [ -f "$DIR/$p.pid" ] && kill "$(cat "$DIR/$p.pid")" 2>/dev/null
  done
  return 0
}
trap cleanup EXIT

node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({port:+process.argv[2],devices:{}},null,2))' "$DIR/config.json" "$PORT"
OTTO_CHROME_DIR=$DIR node bridge/server.js > "$DIR/bridge.log" 2>&1 &
echo $! > "$DIR/bridge.pid"
sleep 1

start_fake() { # name mode logfile pidfile
  local log="$DIR/$3"
  NODE_PATH=$PWD/bridge/node_modules OTTO_CHROME_WS=ws://127.0.0.1:$PORT/ws NAME="$1" \
    node test/fake-extension.js "$2" > "$log" 2>&1 &
  echo $! > "$DIR/$4.pid"
  for i in $(seq 1 20); do grep -q "PAIR-PENDING" "$log" 2>/dev/null && return 0; sleep 0.3; done
  echo "fake $1 failed to request pairing"; cat "$log"; return 1
}

call_mcp() { curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" -H 'Content-Type: application/json' -d "$1"; }
mcp() { call_mcp "$1"; echo; }
pass=0; fail=0
expect() {
  local out="$1" needle="$2" desc="$3"
  if echo "$out" | grep -q "$needle"; then echo "PASS: $desc"; pass=$((pass+1)); else echo "FAIL: $desc — got: ${out:0:300}"; fail=$((fail+1)); fi
}
approve_name() {
  local name="$1" logfile="$2" response id
  response="$(call_mcp '{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"chrome_pair_requests","arguments":{}}}')"
  id="$(printf '%s' "$response" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);const rows=JSON.parse(r.result.content[0].text);const x=rows.find(v=>v.name===process.argv[1]);if(x)process.stdout.write(x.requestId)})' "$name")"
  [ -n "$id" ] || { echo "No pending request for $name"; return 1; }
  response="$(call_mcp "{\"jsonrpc\":\"2.0\",\"id\":41,\"method\":\"tools/call\",\"params\":{\"name\":\"chrome_pair_approve\",\"arguments\":{\"requestId\":\"$id\"}}}")"
  echo "$response" | grep -q '"name"' || return 1
  for i in $(seq 1 20); do grep -q "PAIRED $name" "$DIR/$logfile" 2>/dev/null && return 0; sleep 0.2; done
  return 1
}

start_fake work-laptop ok fakeA.log fakeA
start_fake home-desktop ok fakeB.log fakeB
approve_name work-laptop fakeA.log
approve_name home-desktop fakeB.log
if node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const ds=Object.values(c.devices||{});if(ds.length!==2||ds.some(d=>!d.credentialHash||d.credential)){process.exit(1)}' "$DIR/config.json"; then echo "PASS: bridge stores per-device hashes, not credentials"; pass=$((pass+1)); else echo "FAIL: credential storage invariant"; fail=$((fail+1)); fi
sleep 0.4

echo "--- health:"; curl -fsS "http://127.0.0.1:$PORT/health"; echo
echo "--- MCP checks:"
PORT=$PORT bash test/mcp-check.sh 2>/dev/null | tail -1

out=$(mcp '{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"chrome_devices","arguments":{}}}')
expect "$out" "work-laptop" "chrome_devices lists work-laptop"
expect "$out" "home-desktop" "chrome_devices lists home-desktop"
out=$(mcp '{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"chrome_tabs","arguments":{"device":"work-laptop"}}}')
expect "$out" "on=work-laptop" "chrome_tabs routes to work-laptop"
out=$(mcp '{"jsonrpc":"2.0","id":32,"method":"tools/call","params":{"name":"chrome_tabs","arguments":{"device":"desktop"}}}')
expect "$out" "on=home-desktop" "fuzzy device name matches home-desktop"
out=$(mcp '{"jsonrpc":"2.0","id":33,"method":"tools/call","params":{"name":"chrome_status","arguments":{}}}')
expect "$out" "home-desktop" "default target = most recently paired"
out=$(mcp '{"jsonrpc":"2.0","id":34,"method":"tools/call","params":{"name":"chrome_open","arguments":{"url":"https://example.com","device":"nope-not-here"}}}')
expect "$out" "No connected Chrome matches" "unknown device gives helpful error listing devices"

kill "$(cat "$DIR/fakeB.pid")" 2>/dev/null; sleep 1
out=$(mcp '{"jsonrpc":"2.0","id":35,"method":"tools/call","params":{"name":"chrome_tabs","arguments":{}}}')
expect "$out" "on=work-laptop" "surviving device becomes default"

kill "$(cat "$DIR/fakeA.pid")" 2>/dev/null; sleep 1
start_fake work-laptop deny fakeD.log fakeD
approve_name work-laptop fakeD.log
sleep 0.4
out=$(mcp '{"jsonrpc":"2.0","id":36,"method":"tools/call","params":{"name":"chrome_open","arguments":{"url":"https://example.com"}}}')
expect "$out" "Denied by user in Chrome" "user denial is reported to agent"

# Revoke is loopback-administered and removes the persistent browser credential.
response=$(mcp '{"jsonrpc":"2.0","id":37,"method":"tools/call","params":{"name":"chrome_devices","arguments":{}}}')
id=$(printf '%s' "$response" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);const a=JSON.parse(r.result.content[0].text);if(a[0])process.stdout.write(a[0].id)})')
out=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":38,\"method\":\"tools/call\",\"params\":{\"name\":\"chrome_device_revoke\",\"arguments\":{\"deviceId\":\"$id\"}}}")
expect "$out" 'revoked' "device credential can be revoked"

echo "--- bridge log tail:"; tail -8 "$DIR/bridge.log"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
