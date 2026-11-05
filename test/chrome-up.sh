#!/usr/bin/env bash
# Bring up bridge + headless Chrome + extension and LEAVE THEM RUNNING.
# Drive with: bash test/drive.sh tools/call '<json-params>'
set -u
cd /var/lib/otto/owner/agent/workspace/otto-chrome
ABS=$PWD

# --- teardown anything from a previous run -----------------------------------
[ -f /tmp/oct-up/br/bridge.pid ] && kill "$(cat /tmp/oct-up/br/bridge.pid)" 2>/dev/null
pkill -f "otto-chrome/bridge/serve[r].js" 2>/dev/null
pkill -f "user-data-dir=/tmp/oct-up/pro[f]" 2>/dev/null
sleep 2
rm -rf /tmp/oct-up
mkdir -p /tmp/oct-up/br
cp -r extension /tmp/oct-up/ext

export TK="$(node -e 'console.log(require("crypto").randomBytes(6).toString("hex"))')"
node -e '
const fs=require("fs");const f="/tmp/oct-up/ext/background.js";let s=fs.readFileSync(f,"utf8");
s=s.replace("bridgeUrl: \"\",","bridgeUrl: \"ws://127.0.0.1:8796/ws\",").replace("token: \"\",","token: \""+process.env.TK+"\",").replace("mode: \"ask\",","mode: \"auto\",");
fs.writeFileSync(f,s);
if(!s.includes("8796")){console.error("SEED-FAILED");process.exit(1)}'
node -e 'const fs=require("fs");fs.writeFileSync("/tmp/oct-up/br/config.json",JSON.stringify({port:8796,token:process.env.TK}))'

# --- bridge -------------------------------------------------------------------
setsid nohup bash -c "OTTO_CHROME_DIR=/tmp/oct-up/br exec node $ABS/bridge/server.js" > /tmp/oct-up/br/bridge.log 2>&1 < /dev/null &
echo $! > /tmp/oct-up/br/bridge.pid
sleep 1.5
if ! curl -fsS http://127.0.0.1:8796/health > /dev/null 2>&1; then
  echo "BRIDGE FAILED TO START:"; cat /tmp/oct-up/br/bridge.log; exit 1
fi

# --- chrome + extension --------------------------------------------------------
setsid nohup google-chrome --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --enable-extensions=load \
  --user-data-dir=/tmp/oct-up/prof \
  --remote-debugging-port=9236 --window-size=1280,800 about:blank > /tmp/oct-up/chrome.log 2>&1 < /dev/null &
sleep 4
NODE_PATH=$ABS/bridge/node_modules node test/cdp-load.js 9236 /tmp/oct-up/ext

for i in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8796/health 2>/dev/null | grep -q '"extensionConnected":true' && break
  sleep 1
done
echo "MCP-URL: http://127.0.0.1:8796/mcp?t=$TK"
curl -s http://127.0.0.1:8796/health; echo
