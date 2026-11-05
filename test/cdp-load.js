// Loads an unpacked extension into a running Chrome via CDP (headless-friendly).
// Usage: node cdp-load.js <port> <path-to-extension>
const WebSocket = require("ws");

const PORT = process.argv[2] || "9235";
const PATH_ = process.argv[3];
if (!PATH_) { console.error("usage: cdp-load.js <port> <extpath>"); process.exit(1); }

(async () => {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise(r => ws.on("open", r));
  const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));
  const reply = new Promise((resolve) => {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id === 1) resolve(m);
    });
  });
  send(1, "Extensions.loadUnpacked", { path: PATH_ });
  const r = await Promise.race([reply, new Promise(res => setTimeout(() => res({ timeout: true }), 15000))]);
  console.log(JSON.stringify(r));
  ws.close();
  process.exit(r && r.error ? 1 : 0);
})();
