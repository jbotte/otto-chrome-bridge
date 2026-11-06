#!/usr/bin/env bash
# Exercises the loopback-only MCP endpoint. Pair a fake extension first for command calls.
set -u
URL="http://127.0.0.1:${PORT:-8712}/mcp"
post() {
  curl -fsS -X POST "$URL" -H 'Content-Type: application/json' -d "$1" | cut -c1-"${2:-4000}"
  echo
}
echo "== initialize"
post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' 300
echo "== notifications/initialized"
curl -fsS -X POST "$URL" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' -o /dev/null -w '%{http_code}\n'
echo "== tools/list"
post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' 500
echo "== pairing requests tool"
post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"chrome_pair_requests","arguments":{}}}'
LANIP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ -n "$LANIP" ]; then
  REMOTE_STATUS="$(curl -sS --connect-timeout 2 -o /dev/null -w '%{http_code}' -X POST "http://$LANIP:${PORT:-8712}/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":99,"method":"initialize"}' 2>/dev/null || true)"
  if [ "$REMOTE_STATUS" = "403" ]; then echo "PASS: MCP rejects non-loopback access"; else echo "FAIL: expected 403 from LAN MCP URL, got $REMOTE_STATUS"; exit 1; fi
fi
echo "== tools/call chrome_status"
post '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"chrome_status","arguments":{}}}'
echo "== tools/call chrome_act"
post '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"chrome_act","arguments":{"steps":[{"action":"click","target":"Sign in"},{"action":"type","target":"Email","value":"a@b.co"}]}}}'
echo "== tools/call chrome_screenshot"
post '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"chrome_screenshot","arguments":{}}}' 240
echo "ALL-CHECKS-DONE"
