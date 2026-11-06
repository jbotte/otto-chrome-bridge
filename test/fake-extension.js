// Fake browser client for local MCP/pairing tests; never logs issued credentials.
// Usage: OTTO_CHROME_WS=ws://127.0.0.1:8712/ws NAME=work-laptop node test/fake-extension.js [ok|deny]
const WebSocket = require("ws");
const URL_ = process.env.OTTO_CHROME_WS || "ws://127.0.0.1:8712/ws";
const NAME = process.env.NAME || "fake-one";
const MODE = process.argv[2] || "ok";
let deviceId = "";
const ws = new WebSocket(URL_);
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name: NAME, extVersion: "test", chromeVersion: "test" })));
ws.on("message", (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.type === "pair-pending") { console.log("PAIR-PENDING", msg.requestId); return; }
  if (msg.type === "hello-ok") { deviceId = msg.deviceId; console.log("PAIRED", NAME, deviceId); return; }
  if (msg.type === "device-credential") { console.log("CREDENTIAL-RECEIVED", NAME); return; }
  if (msg.type === "pair-rejected" || msg.type === "pair-expired") { console.log(msg.type, NAME); return; }
  if (msg.type === "auth-fail") { console.log("AUTH-FAIL", NAME); process.exit(2); }
  if (msg.type === "cmd") {
    console.log("CMD", NAME, msg.action, JSON.stringify(msg.params));
    if (MODE === "deny") return ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "Denied by user in Chrome" }));
    let data;
    switch (msg.action) {
      case "chrome_status": data = { connected: true, extVersion: "test", mode: "auto", tabCount: 2, device: NAME }; break;
      case "chrome_tabs": data = [{ id: 1, url: "https://example.com/?on=" + NAME, title: "Example Domain", active: true }]; break;
      case "chrome_screenshot": data = { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", url: "https://example.com/?on=" + NAME }; break;
      case "chrome_act": data = { results: (msg.params.steps || []).map((s, i) => ({ step: i, action: s.action, ok: `fake ${s.action} on \"${s.target || ""}\" via ${NAME}` })) }; break;
      case "chrome_open": data = { tabId: 99, url: msg.params.url, title: "Fake on " + NAME }; break;
      case "chrome_read": data = { title: "Fake " + NAME, url: "https://example.com/?on=" + NAME, body: "fake page", headings: [], links: [], inputs: [], buttons: ["Sign in"] }; break;
      default: data = { echo: msg.params, device: NAME };
    }
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data }));
  }
});
ws.on("error", e => { console.error("fake websocket error", e.message); });
ws.on("close", (c, r) => { console.log("CLOSED", NAME, c, String(r)); process.exit(1); });
