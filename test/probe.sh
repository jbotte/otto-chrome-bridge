#!/usr/bin/env bash
set -u
cd /var/lib/otto/owner/agent/workspace/otto-chrome
pkill -f "probe-por[f]" 2>/dev/null; sleep 1
rm -rf /tmp/octprobe; mkdir -p /tmp/octprobe/br
mkdir -p /tmp/octprobe
cp -r extension /tmp/octprobe/ext
export TK="$(node -e 'console.log(require("crypto").randomBytes(6).toString("hex"))')"
node -e '
const fs=require("fs");const f="/tmp/octprobe/ext/background.js";let s=fs.readFileSync(f,"utf8");
s=s.replace("bridgeUrl: \"\",","bridgeUrl: \"ws://127.0.0.1:8797/ws\",").replace("token: \"\",","token: \""+process.env.TK+"\",").replace("mode: \"ask\",","mode: \"auto\",");
fs.writeFileSync(f,s);console.log("seeded url:",s.includes("8797"),"seeded tok:",s.includes(process.env.TK))'
node -e 'const fs=require("fs");fs.writeFileSync("/tmp/octprobe/br/config.json",JSON.stringify({port:8797,token:process.env.TK}))'
OTTO_CHROME_DIR=/tmp/octprobe/br node bridge/server.js > /tmp/octprobe/br/bridge.log 2>&1 &
BR=$!
sleep 1
google-chrome --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --enable-extensions=load \
  --user-data-dir=/tmp/octprobe/prof \
  --remote-debugging-port=9235 --window-size=1280,800 about:blank > /tmp/octprobe/chrome.log 2>&1 &
CH=$!
sleep 4
node test/cdp-load.js 9235 /tmp/octprobe/ext
sleep 4
echo "== CDP targets:"
curl -s http://127.0.0.1:9235/json/list | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const t=JSON.parse(d);console.log(t.map(x=>x.type+" | "+(x.title||"").slice(0,70)+" | "+(x.url||"").slice(0,70)).join("\n"))}catch(e){console.log("no cdp:",d.slice(0,200))}})'
echo "== health:"; curl -s http://127.0.0.1:8797/health; echo
echo "== bridge:"; cat /tmp/octprobe/br/bridge.log
kill $CH $BR 2>/dev/null
pkill -f "probe-por[f]" 2>/dev/null
echo PROBE-DONE
