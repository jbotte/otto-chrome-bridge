#!/usr/bin/env node
// Otto Chrome Bridge — bridge server.
// Sits between your Otto agent (MCP over HTTP) and the Chrome extension
// (WebSocket). One file, one dependency (ws), no root needed.
//
// Config: ~/.otto-chrome/config.json { port, devices }
// MCP is loopback-only; Chrome clients use pending owner-approved pairing.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const DIR = process.env.OTTO_CHROME_DIR || path.join(os.homedir(), ".otto-chrome");
const CONFIG_PATH = path.join(DIR, "config.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch (e) {}
const PORT = parseInt(process.env.OTTO_CHROME_PORT || cfg.port || "8712", 10);
cfg.devices = cfg.devices && typeof cfg.devices === "object" ? cfg.devices : {};

function saveConfig() {
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, CONFIG_PATH);
}
if (Object.prototype.hasOwnProperty.call(cfg, "token")) {
  delete cfg.token;
  saveConfig();
}

const MCP_PATH = "/mcp";
const WS_PATH = "/ws";
const HEALTH_PATH = "/health";
const CMD_TIMEOUT_MS = 120000;

const clients = new Map(); // clientId -> { sock, info, connectedSince }
let lastClientId = null;   // most recently connected — the default target
let clientSeq = 0;
let lastError = null;
let cmdSeq = 0;
const pending = new Map(); // id -> {resolve, reject, timer, clientId}
const pendingPairings = new Map(); // requestId -> {sock, info, requestedAt, expiresAt}
const PAIR_REQUEST_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 25;

function log(...a) { console.log(new Date().toISOString(), ...a); }

function listDevices() {
  return Array.from(clients.entries()).map(([id, c]) => ({
    id,
    name: c.info.name || "Chrome",
    chromeVersion: c.info.chromeVersion,
    extVersion: c.info.extVersion,
    connectedSince: c.connectedSince,
    isDefault: id === lastClientId
  }));
}

function resolveDevice(device) {
  if (!clients.size) throw new Error("No Chrome is connected. Check the extension's Bridge URL and pairing status; if it is waiting, approve it with chrome_pair_requests and chrome_pair_approve.");
  if (device == null || device === "") {
    if (clients.size === 1) return clients.keys().next().value;
    if (lastClientId && clients.has(lastClientId)) return lastClientId; // most recently used wins
  }
  if (device == null || device === "") throw new Error("Several Chromes are connected and no default exists yet — pass device:<name> from chrome_devices.");
  const q = String(device).toLowerCase();
  let hits = Array.from(clients.entries()).filter(([id, c]) => id === device || (c.info.name || "").toLowerCase() === q);
  if (!hits.length) hits = Array.from(clients.entries()).filter(([id, c]) => (c.info.name || "").toLowerCase().includes(q) || id.toLowerCase().includes(q));
  if (!hits.length) throw new Error(`No connected Chrome matches "${device}". Connected devices: ${listDevices().map(d => `${d.name} (${d.id})`).join(", ") || "none"}`);
  if (hits.length > 1) throw new Error(`"${device}" matches several Chromes: ${hits.map(([, c]) => c.info.name).join(", ")} — pass the exact device id from chrome_devices.`);
  return hits[0][0];
}

// ---------------------------------------------------------------- extension side

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (sock, req) => {
  let hello = false;
  const guard = setTimeout(() => { if (!hello) sock.close(4001, "hello timeout"); }, 10000);
  sock.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    if (msg.type === "hello") {
      hello = true;
      clearTimeout(guard);
      const info = { name: String(msg.name || "Chrome").slice(0, 80), extVersion: msg.extVersion || "", chromeVersion: msg.chromeVersion || "" };
      if (msg.deviceId && msg.credential && authenticateDevice(msg.deviceId, msg.credential)) {
        registerClient(sock, String(msg.deviceId), info);
        return;
      }
      // New browsers are quarantined until the owner approves through the local MCP tools.
      expirePairings();
      if (pendingPairings.size >= MAX_PENDING_PAIRINGS) {
        sock.send(JSON.stringify({ type: "auth-fail", reason: "pairing queue full" }));
        return sock.close(4005, "pairing queue full");
      }
      const requestId = crypto.randomBytes(8).toString("hex");
      const requestedAt = Date.now();
      pendingPairings.set(requestId, { sock, info, requestedAt, expiresAt: requestedAt + PAIR_REQUEST_TTL_MS, remoteAddress: req.socket.remoteAddress });
      sock.pendingPairId = requestId;
      sock.send(JSON.stringify({ type: "pair-pending", requestId, expiresAt: requestedAt + PAIR_REQUEST_TTL_MS }));
      log("pairing request:", info.name, "expires in five minutes");
      return;
    }
    if (sock !== (clients.get(sock.deviceId) || {}).sock) return;
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
    if (sock.pendingPairId) pendingPairings.delete(sock.pendingPairId);
    const id = sock.deviceId;
    if (id && clients.has(id)) {
      const info = (clients.get(id) || {}).info || {};
      clients.delete(id);
      if (lastClientId === id) {
        let newest = null;
        for (const [oid, c] of clients) if (!newest || c.connectedSince > newest.connectedSince) newest = { id: oid, ...c };
        lastClientId = newest ? newest.id : null;
      }
      log("extension disconnected:", info.name || id, "— remaining:", listDevices().map(d => d.name).join(", ") || "none");
      for (const [pid, p] of pending) {
        if (p.clientId === id) { clearTimeout(p.timer); pending.delete(pid); p.reject(new Error("Chrome extension disconnected mid-command")); }
      }
    }
  });
  sock.on("error", (e) => { lastError = String(e); });
});

function hashCredential(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function timingSafeHexEqual(a, b) {
  if (!/^[0-9a-f]{64}$/i.test(String(a || "")) || !/^[0-9a-f]{64}$/i.test(String(b || ""))) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function authenticateDevice(deviceId, credential) {
  const stored = cfg.devices[deviceId];
  if (!stored || !stored.credentialHash) return false;
  return timingSafeHexEqual(stored.credentialHash, hashCredential(credential));
}

function registerClient(sock, id, incomingInfo) {
  const stored = cfg.devices[id];
  if (!stored) return sock.close(4001, "device revoked");
  const info = {
    name: String(incomingInfo.name || stored.name || "Chrome").slice(0, 80),
    extVersion: incomingInfo.extVersion || "",
    chromeVersion: incomingInfo.chromeVersion || ""
  };
  const previous = clients.get(id);
  if (previous && previous.sock !== sock) {
    try { previous.sock.close(4002, "replaced"); } catch (e) {}
    for (const [pid, p] of pending) if (p.clientId === id) { clearTimeout(p.timer); pending.delete(pid); p.reject(new Error("Chrome extension reconnected — retry")); }
  }
  stored.name = info.name;
  saveConfig();
  clients.set(id, { sock, info, connectedSince: Date.now() });
  lastClientId = id;
  sock.deviceId = id;
  sock.send(JSON.stringify({ type: "hello-ok", deviceId: id }));
  log("extension connected:", info.name, "— devices:", listDevices().map(d => d.name).join(", "));
}

function expirePairings() {
  const now = Date.now();
  for (const [id, p] of pendingPairings) {
    if (p.expiresAt <= now) {
      pendingPairings.delete(id);
      try { p.sock.send(JSON.stringify({ type: "pair-expired" })); p.sock.close(4003, "pair request expired"); } catch (e) {}
    }
  }
}
setInterval(expirePairings, 15000);

function approvePairing(requestId) {
  expirePairings();
  const p = pendingPairings.get(String(requestId));
  if (!p) throw new Error("No pending pairing with that requestId (it may have expired or disconnected).");
  const id = "d" + (++clientSeq) + "-" + crypto.randomBytes(3).toString("hex");
  const credential = crypto.randomBytes(32).toString("base64url");
  cfg.devices[id] = { name: p.info.name, credentialHash: hashCredential(credential), createdAt: Date.now() };
  saveConfig();
  pendingPairings.delete(String(requestId));
  registerClient(p.sock, id, p.info);
  // Deliver the new browser-only credential once over its established WebSocket.
  p.sock.send(JSON.stringify({ type: "device-credential", deviceId: id, credential }));
  return { deviceId: id, name: p.info.name };
}

function rejectPairing(requestId) {
  const p = pendingPairings.get(String(requestId));
  if (!p) throw new Error("No pending pairing with that requestId.");
  pendingPairings.delete(String(requestId));
  try { p.sock.send(JSON.stringify({ type: "pair-rejected" })); p.sock.close(4004, "pairing rejected"); } catch (e) {}
  return { rejected: true, name: p.info.name };
}

function revokeDevice(deviceId) {
  const stored = cfg.devices[String(deviceId)];
  if (!stored) throw new Error("Unknown device id.");
  delete cfg.devices[String(deviceId)];
  saveConfig();
  const c = clients.get(String(deviceId));
  if (c) { clients.delete(String(deviceId)); try { c.sock.send(JSON.stringify({ type: "auth-fail", reason: "revoked" })); c.sock.close(4001, "device revoked"); } catch (e) {} }
  if (lastClientId === String(deviceId)) lastClientId = clients.size ? Array.from(clients.keys()).at(-1) : null;
  for (const [pid, p] of pending) if (p.clientId === String(deviceId)) { clearTimeout(p.timer); pending.delete(pid); p.reject(new Error("Device revoked")); }
  return { revoked: true, name: stored.name || deviceId };
}

function sendCmd(action, params, device) {
  return new Promise((resolve, reject) => {
    let clientId;
    try { clientId = resolveDevice(device != null ? device : (params && params.device)); }
    catch (e) { return reject(e); }
    const c = clients.get(clientId);
    if (!c || c.sock.readyState !== WebSocket.OPEN) {
      return reject(new Error("Chrome extension is not connected. Open the Otto Chrome Bridge extension popup on your computer and check the status."));
    }
    const id = "c" + (++cmdSeq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command ${action} timed out after ${CMD_TIMEOUT_MS / 1000}s (a pending approval may have expired)`));
    }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, clientId });
    c.sock.send(JSON.stringify({ type: "cmd", id, action, params }));
  });
}

// keepalive pings both ways are handled by the extension; server pings:
setInterval(() => {
  for (const c of clients.values()) {
    if (c.sock.readyState === WebSocket.OPEN) { try { c.sock.ping(); } catch (e) {} }
  }
}, 15000);

// ---------------------------------------------------------------- MCP tools

const TOOLS = [
  {
    name: "chrome_pair_requests",
    description: "List new Chrome browsers waiting to pair. Only show/approve requests when the owner asked to connect that browser.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chrome_pair_approve",
    description: "Approve a pending Chrome pairing after the owner explicitly requests it. The bridge creates a private per-browser credential; no credential is returned to the caller.",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] }
  },
  {
    name: "chrome_pair_reject",
    description: "Reject a pending Chrome pairing request.",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] }
  },
  {
    name: "chrome_device_revoke",
    description: "Revoke a previously paired Chrome browser so its stored credential can no longer reconnect.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"] }
  },
  {
    name: "chrome_devices",
    description: "List the Chromes currently connected to the bridge (name, id, versions). Other chrome_* tools accept an optional device parameter — pass the name or id here to choose which Chrome to drive. When several are connected, the most recently connected one is the default.",
    inputSchema: { type: "object", properties: {} }
  },
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

// Every tool except chrome_devices accepts an optional device selector.
for (const t of TOOLS) {
  if (t.name.startsWith("chrome_pair_") || t.name === "chrome_device_revoke" || t.name === "chrome_devices") continue;
  t.inputSchema.properties.device = { type: "string", description: "Which Chrome to drive: device name or id from chrome_devices. Omit to use the default (most recently connected)." };
}

async function callTool(name, args) {
  const dev = args && args.device != null ? args.device : undefined;
  if (name === "chrome_pair_requests") {
    expirePairings();
    const rows = Array.from(pendingPairings.entries()).map(([id, p]) => ({ requestId: id, name: p.info.name, chromeVersion: p.info.chromeVersion, requestedAt: p.requestedAt, expiresAt: p.expiresAt }));
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
  if (name === "chrome_pair_approve") return { content: [{ type: "text", text: JSON.stringify(approvePairing(args.requestId), null, 2) }] };
  if (name === "chrome_pair_reject") return { content: [{ type: "text", text: JSON.stringify(rejectPairing(args.requestId), null, 2) }] };
  if (name === "chrome_device_revoke") return { content: [{ type: "text", text: JSON.stringify(revokeDevice(args.deviceId), null, 2) }] };
  if (name === "chrome_devices") return { content: [{ type: "text", text: JSON.stringify(listDevices(), null, 2) }] };
  switch (name) {
    case "chrome_status": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_status", args, dev), null, 2) }] };
    case "chrome_tabs": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_tabs", args, dev), null, 2) }] };
    case "chrome_open": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_open", args, dev), null, 2) }] };
    case "chrome_navigate": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_navigate", args, dev), null, 2) }] };
    case "chrome_close_tab": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_close_tab", args, dev), null, 2) }] };
    case "chrome_read": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_read", args, dev), null, 2) }] };
    case "chrome_screenshot": {
      const r = await sendCmd("chrome_screenshot", args, dev);
      const base64 = String(r.dataUrl || "").replace(/^data:image\/png;base64,/, "");
      return { content: [
        { type: "text", text: `Screenshot of ${r.url}` },
        { type: "image", data: base64, mimeType: "image/png" }
      ] };
    }
    case "chrome_act": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_act", args, dev), null, 2) }] };
    case "chrome_eval": return { content: [{ type: "text", text: JSON.stringify(await sendCmd("chrome_eval", args, dev), null, 2) }] };
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
              serverInfo: { name: "otto-chrome-bridge", version: "0.3.0" }
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (u.pathname === HEALTH_PATH) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, service: "otto-chrome-bridge", port: PORT,
      extensionConnected: clients.size > 0,
      devices: listDevices(),
      pendingPairings: pendingPairings.size,
      lastError, pendingCommands: pending.size
    }));
  }

  if (u.pathname === MCP_PATH && req.method === "POST") {
    const remote = req.socket.remoteAddress || "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLoopback) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "MCP is loopback-only; connect from the Otto itself." }, id: null }));
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
