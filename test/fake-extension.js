// Test helper: a fake Chrome extension that connects to the bridge and
// answers commands with canned data (tagged with its NAME so routing is provable).
// Usage: OTTO_CHROME_WS=ws://127.0.0.1:8712/ws TK=<token> NAME=work-laptop node test/fake-extension.js [ok|deny]
const WebSocket = require("ws");

const URL_ = process.env.OTTO_CHROME_WS || "ws://127.0.0.1:8712/ws";
const PAIR = process.env.TK;
const NAME = process.env.NAME || "fake-one";
const MODE = process.argv[2] || "ok";

const ws = new WebSocket(URL_);
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", token: PAIR, name: NAME, extVersion: "test", chromeVersion: "test" }));
});
ws.on("message", (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.type === "hello-ok") { console.log("HELLO-OK", NAME, msg.deviceId); return; }
  if (msg.type === "auth-fail") { console.log("AUTH-FAIL", NAME); process.exit(2); }
  if (msg.type === "cmd") {
    console.log("CMD", NAME, msg.action, JSON.stringify(msg.params));
    if (MODE === "deny") return ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "Denied by user in Chrome" }));
    let data;
    switch (msg.action) {
      case "chrome_status": data = { connected: true, extVersion: "test", mode: "auto", tabCount: 2, device: NAME }; break;
      case "chrome_tabs": data = [{ id: 1, url: "https://example.com/?on=" + NAME, title: "Example Domain", active: true }]; break;
      case "chrome_screenshot": data = { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", url: "https://example.com/?on=" + NAME }; break;
      case "chrome_act": data = { results: (msg.params.steps || []).map((s, i) => ({ step: i, action: s.action, ok: `fake ${s.action} on "${s.target || ""}" via ${NAME}` })) }; break;
      case "chrome_open": data = { tabId: 99, url: msg.params.url, title: "Fake on " + NAME }; break;
      case "chrome_read": data = { title: "Fake " + NAME, url: "https://example.com/?on=" + NAME, body: "fake page", headings: [], links: [], inputs: [], buttons: ["Sign in"] }; break;
      default: data = { echo: msg.params, device: NAME };
    }
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data }));
  }
});
ws.on("close", (c, r) => { console.log("CLOSED", NAME, c, String(r)); process.exit(1); });
