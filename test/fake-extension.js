// Test helper: a fake Chrome extension that connects to the bridge and
// answers commands with canned data.
// Usage: OTTO_CHROME_WS=ws://127.0.0.1:8712/ws TK=<token> node test/fake-extension.js [ok|deny]
const WebSocket = require("ws");

const URL_ = process.env.OTTO_CHROME_WS || "ws://127.0.0.1:8712/ws";
const PAIR = process.env.TK;
const MODE = process.argv[2] || "ok";

const ws = new WebSocket(URL_);
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", token: PAIR, extVersion: "test", chromeVersion: "test" }));
});
ws.on("message", (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.type === "hello-ok") { console.log("HELLO-OK"); return; }
  if (msg.type === "auth-fail") { console.log("AUTH-FAIL"); process.exit(2); }
  if (msg.type === "cmd") {
    console.log("CMD", msg.action, JSON.stringify(msg.params));
    if (MODE === "deny") return ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "Denied by user in Chrome" }));
    let data;
    switch (msg.action) {
      case "chrome_status": data = { connected: true, extVersion: "test", mode: "auto", tabCount: 2 }; break;
      case "chrome_tabs": data = [{ id: 1, url: "https://example.com", title: "Example Domain", active: true }]; break;
      case "chrome_screenshot": data = { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", url: "https://example.com" }; break;
      case "chrome_act": data = { results: (msg.params.steps || []).map((s, i) => ({ step: i, action: s.action, ok: `fake ${s.action} on "${s.target || ""}"` })) }; break;
      case "chrome_open": data = { tabId: 99, url: msg.params.url, title: "Fake" }; break;
      case "chrome_read": data = { title: "Fake", url: "https://example.com", body: "fake page", headings: [], links: [], inputs: [], buttons: ["Sign in"] }; break;
      default: data = { echo: msg.params };
    }
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data }));
  }
});
ws.on("close", (c, r) => { console.log("CLOSED", c, String(r)); process.exit(1); });
