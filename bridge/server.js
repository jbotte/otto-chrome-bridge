#!/usr/bin/env node
// Otto Chrome Bridge — bridge server.
// Sits between your Otto agent (MCP over HTTP) and the Chrome extension
// (WebSocket). One file, one dependency (ws), no root needed.
//
// Config: ~/.otto-chrome/config.json  { "port": 8712, "token": "***" }
// Env overrides: OTTO_CHROME_PORT, OTTO_CHROME_TOKEN, OTTO_CHROME_DIR

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const DIR = process.env.OTTO_CHROME_DIR || path.join(os.homedir(), ".otto-chrome");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8")); } catch (e) {}
const PORT = parseInt(process.env.OTTO_CHROME_PORT || cfg.port || "8712", 10);
const TOKEN = process.env.OTTO_CHROME_TOKEN || cfg.token || "";
if (!TOKEN) {
  console.error("No pairing token. Run install.sh or set config.json / OTTO_CHROME_TOKEN.");
  process.exit(1);
}

const MCP_PATH = "/mcp";
const WS_PATH = "/ws";
const HEALTH_PATH = "/health";
const CMD_TIMEOUT_MS = 120000;

let client = null; // the one connected extension
let clientInfo = null;
let connectedSince = null;
let lastError = null;
let cmdSeq = 0;
const pending = new Map(); // id -> {resolve, reject, timer}

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------------------------------------------------------------- extension side

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (sock) => {
  let hello = false;
  const guard = setTimeout(() => { if (!hello) sock.close(4001, "hello timeout"); }, 10000);
  sock.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    if (msg.type === "hello") {
      if (!tokenOk(msg.token)) {
        lastError = "extension presented a bad token — check the pairing token in the extension popup";
        log("auth-fail from", req.socket.remoteAddress);
        sock.send(JSON.stringify({ type: "auth-fail" }));
        sock.close(4001, "bad token");
        return;
      }
      hello = true;
      clearTimeout(guard);
      if (client) { try { client.close(4002, "replaced"); } catch (e) {} }
      client = sock;
      clientInfo = { extVersion: msg.extVersion, chromeVersion: msg.chromeVersion };
      connectedSince = Date.now();
      sock.send(JSON.stringify({ type: "hello-ok" }));
      log("extension connected", JSON.stringify(clientInfo));
      return;
    }
    if (sock !== client) return;
    if (msg.type === "pong") return;
    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || "extension error"));
    }
  });
  sock.on("close", () => {
    clearTimeout(guard);
    if (client === sock) {
      client = null;
      log("extension disconnected");
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("Chrome extension disconnected mid-command")); }
      pending.clear();
    }
  });
  sock.on("error", (e) => { lastError = String(e); });
});

function tokenOk(candidate) {
  const a = Buffer.from(String(candidate || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendCmd(action, params) {
  return new Promise((resolve, reject) => {
    if (!client || client.readyState !== WebSocket.OPEN) {
      return reject(new Error("Chrome extension is not connected. Open the Otto Chrome Bridge extension popup on your computer and check the status (and that the Bridge URL/token match the installer output)."));
    }
    const id = "c" + (++cmdSeq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command ${action} timed out after ${CMD_TIMEOUT_MS / 1000}s (a pending approval may have expired)`));
    }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    client.send(JSON.stringify({ type: "cmd", id, action, params }));
  });
}

// keepalive pings both ways are handled by the extension; server pings:
setInterval(() => {
  if (client && client.readyState === WebSocket.OPEN) {
    try { client.ping(); } catch (e) {}
  }
}, 15000);

// ---------------------------------------------------------------- MCP tools

const TOOLS = [
  {
    name: "chrome_status",
    description: "Check whether the user's Chrome (with the Otto Chrome Bridge extension) is connected, and its mode.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chrome_tabs",
    description: "List the user's open Chrome tabs: id, url, title, active.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chrome_open",
    description: "Open a URL in a new tab in the user's Chrome and wait for it to load. Returns tabId, url, title.",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "Full https:// URL" },
      background: { type: "boolean", description: "Open without stealing focus" },
      timeoutMs: { type: "number" }
    }, required: ["url"] }
  },
  {
    name: "chrome_navigate",
    description: "Navigate an existing tab to a new URL.",
    inputSchema: { type: "object", properties: {
      tabId: { type: "number" },
      url: { type: "string" }
    }, required: ["url"] }
  },
  {
    name: "chrome_close_tab",
    description: "Close a tab.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] }
  },
  {
    name: "chrome_read",
    description: "Read a tab: title, url, headings, visible body text, links, inputs and buttons. Use the texts in `buttons`/links as click/type targets.",
    inputSchema: { type: "object", properties: {
      tabId: { type: "number", description: "Defaults to the active tab" },
      maxChars: { type: "number", description: "Max body text chars (default 15000)" }
    } }
  },
  {
    name: "chrome_screenshot",
    description: "Screenshot the visible area of a tab (activates it first). Returns a PNG image.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } }
  },
  {
    name: "chrome_act",
    description: "Control a page with trusted input. steps is an array, each: {action, target, value, ...}. action=click|type|key|scroll|select|press|wait. target is a CSS selector OR the visible text of a link/button/label/placeholder (prefer text from chrome_read). If several elements match, the error lists candidates — rerun with pick:N. type: value = text to enter (replaces existing; then:\"Enter\" to submit). key: Enter/Tab/Escape/Backspace/ArrowDown/... scroll: direction up|down, amount px. select: target=select name, value=option text. press: raw x,y click. wait: ms. Example: [{action:\"type\",target:\"Email\",value:\"a@b.co\"},{action:\"click\",target:\"Sign in\"}]",
    inputSchema: { type: "object", properties: {
      tabId: { type: "number" },
      steps: { type: "array", items: { type: "object", properties: {
        action: { type: "string", enum: ["click", "type", "key", "scroll", "select", "press", "wait"] },
        target: { type: "string" },
        pick: { type: "number", description: "When several elements match the target text, choose candidate N from the returned candidate list" },
        value: { type: "string" },
        key: { type: "string" },
        direction: { type: "string" },
        amount: { type: "number" },
        ms: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
        clickCount: { type: "number" },
        then: { type: "string" },
        replace: { type: "boolean" }
      } } }
    }, required: ["steps"] }
  },
  {
    name: "chrome_eval",
    description: "Run a JavaScript expression in the page and return its value. Requires the user to have enabled 'Allow JS evaluation' in the extension popup, and always asks their permission.",
    inputSchema: { type: "object", properties: {
      tabId: { type: "number" },
      expression: { type: "string" }
    }, required: ["expression"] }
  }
];

async function callTool(name, args) {
  switch (name) {
    case "chrome_status": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_status", {}), null, 2) }] };
    case "chrome_tabs": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_tabs", {}), null, 2) }] };
    case "chrome_open": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_open", args), null, 2) }] };
    case "chrome_navigate": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_navigate", args), null, 2) }] };
    case "chrome_close_tab": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_close_tab", args), null, 2) }] };
    case "chrome_read": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_read", args), null, 2) }] };
    case "chrome_screenshot": {
      const r = await sendCmd("chrome_screenshot", args);
      const base64 = String(r.dataUrl || "").replace(/^data:image\/png;base64,/, "");
      return { content: [
        { type: "text", text: `Screenshot of ${r.url}` },
        { type: "image", data: base64, mimeType: "image/png" }
      ] };
    }
    case "chrome_act": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_act", args), null, 2) }] };
    case "chrome_eval": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_eval", args), null, 2) }] };
    default: throw new Error("Unknown tool: " + name);
  }
}

// ---------------------------------------------------------------- MCP over HTTP

function handleMcp(body, res) {
  let req;
  try { req = JSON.parse(body); } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }));
  }
  const batch = Array.isArray(req) ? req : [req];
  const responses = [];
  let chain = Promise.resolve();
  for (const r of batch) {
    chain = chain.then(async () => {
      const isNotification = r.id === undefined || r.id === null;
      try {
        let result;
        switch (r.method) {
          case "initialize":
            result = {
              protocolVersion: (r.params && r.params.protocolVersion) || "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "otto-chrome-bridge", version: "0.1.0" }
            };
            break;
          case "ping":
            result = {};
            break;
          case "tools/list":
            result = { tools: TOOLS };
            break;
          case "tools/call": {
            const t0 = Date.now();
            try {
              result = await callTool(r.params.name, r.params.arguments || {});
              log("tool", r.params.name, `${Date.now() - t0}ms`);
            } catch (e) {
              result = { content: [{ type: "text", text: "Error: " + (e && e.message ? e.message : String(e)) }], isError: true };
              log("tool-error", r.params.name, String(e && e.message || e));
            }
            break;
          }
          default:
            if (isNotification) return;
            throw Object.assign(new Error("Method not found: " + r.method), { code: -32601 });
        }
        if (!isNotification) responses.push({ jsonrpc: "2.0", id: r.id, result });
      } catch (e) {
        if (!isNotification) responses.push({ jsonrpc: "2.0", id: r.id, error: { code: e.code || -32603, message: String(e && e.message || e) } });
      }
    });
  }
  chain.then(() => {
    if (!responses.length) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses));
  });
}

// ---------------------------------------------------------------- http server

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (u.pathname === HEALTH_PATH) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, service: "otto-chrome-bridge", port: PORT,
      extensionConnected: !!(client && client.readyState === WebSocket.OPEN),
      clientInfo, connectedSince, lastError,
      pendingCommands: pending.size
    }));
  }

  if (u.pathname === MCP_PATH && req.method === "POST") {
    if (!tokenOk(u.searchParams.get("t") || req.headers["x-bridge-token"] || "")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "bad token" }, id: null }));
    }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on("end", () => handleMcp(body, res));
    return;
  }

  if (u.pathname === MCP_PATH && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("otto-chrome-bridge: POST JSON-RPC here (MCP). See the README.");
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found — try /health or /mcp" }));
});

server.on("upgrade", (req, sock, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname !== WS_PATH) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => {
  log(`otto-chrome-bridge listening on :${PORT} — MCP at /mcp, extension at /ws`);
});
