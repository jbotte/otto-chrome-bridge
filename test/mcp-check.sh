#!/usr/bin/env bash
# Exercises the bridge's MCP endpoint against a running bridge (+ fake extension).
# Usage: TK=<pairing-token> PORT=8712 bash test/mcp-check.sh
set -u
if [ -z "${TK:-}" ]; then echo "TK (pairing token) is required" >&2; exit 1; fi
URL="http://127.0.0.1:${PORT:-8712}/mcp?t=$TK"
post() {
  curl -fsS -X POST "$URL" -H 'Content-Type: application/json' -d "$1" | cut -c1-"${2:-4000}"
  echo
}
echo "== initialize"
post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' 300
echo "== notifications/initialized"
curl -fsS -X POST "$URL" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' -o /dev/null -w '%{http_code}\n'
echo "== tools/list"
post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' 400
echo "== tools/call chrome_status"
post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"chrome_status","arguments":{}}}'
echo "== tools/call chrome_act"
post '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"chrome_act","arguments":{"steps":[{"action":"click","target":"Sign in"},{"action":"type","target":"Email","value":"a@b.co"}]}}}'
echo "== tools/call chrome_screenshot"
post '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"chrome_screenshot","arguments":{}}}' 240
echo "== bad token"
curl -s -X POST "http://127.0.0.1:${PORT:-8712}/mcp?t=WRONG-VALUE-HERE" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":6,"method":"tools/list"}' | cut -c1-200
echo
echo "ALL-CHECKS-DONE"
