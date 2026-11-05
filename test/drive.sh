#!/usr/bin/env bash
# Drive the running debug bridge: ./drive.sh <method> [json-params]
set -u
TK="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/oct-up/br/config.json","utf8")).token)')"
METHOD="$1"; PARAMS="${2:-}"
[ -z "$PARAMS" ] && PARAMS='{}'
if [ "$METHOD" = "call" ]; then
  curl -fsS -X POST "http://127.0.0.1:8796/mcp?t=$TK" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":$PARAMS}"
else
  curl -fsS -X POST "http://127.0.0.1:8796/mcp?t=$TK" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"$METHOD\",\"params\":$PARAMS}"
fi
echo
