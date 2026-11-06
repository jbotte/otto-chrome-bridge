// Otto Chrome Bridge — background service worker
// Connects to the bridge server on your Otto over WebSocket and executes
// read/control commands from your Otto agent. Read/control actions that
// CHANGE the page require your approval (unless you switch mode to "auto").

const DEFAULTS = {
  bridgeUrl: "",        // e.g. ws://my-otto.tailnet.ts.net:8712/ws
  deviceName: "",       // label shown to Otto when several Chromes are connected
  deviceId: "",
  deviceCredential: "", // per-browser credential; never displayed in the popup
  pairingState: "not_paired",
  mode: "ask",          // ask | auto | readonly
  blocklist: "",        // newline/comma-separated domains where automation is refused
  allowEval: false      // allow the chrome_eval tool (always approval-gated)
};

const ACTION_TOOLS = new Set(["chrome_open", "chrome_close_tab", "chrome_act", "chrome_navigate"]);

let ws = null;
let wsReady = false;
let authBlocked = false;
let reconnectDelay = 1000;
let lastHelloOk = null;
const pendingApprovals = new Map(); // id -> {desc, createdAt, allow, deny}
const debuggerTabs = new Map();     // tabId -> lastUsedMs

// ---------------------------------------------------------------- settings

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// ---------------------------------------------------------------- websocket

function connect() {
  if (authBlocked) return;
  getSettings().then((s) => {
    if (!s.bridgeUrl) return;
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
    let sock;
    try { sock = new WebSocket(s.bridgeUrl); } catch (e) { scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      const osName = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "Chrome";
      sock.send(JSON.stringify({
        type: "hello",
        name: s.deviceName || osName,
        deviceId: s.deviceId || undefined,
        credential: s.deviceCredential || undefined,
        extVersion: chrome.runtime.getManifest().version,
        chromeVersion: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || ""
      }));
    };
    sock.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMsg(msg, sock);
    };
    sock.onclose = () => { wsReady = false; ws = null; scheduleReconnect(); };
    sock.onerror = () => { /* onclose follows */ };
  });
}

function scheduleReconnect() {
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  setTimeout(connect, reconnectDelay);
}

async function handleMsg(msg, sock) {
  const active = sock || ws;
  if (msg.type === "hello-ok") {
    wsReady = true; reconnectDelay = 1000; lastHelloOk = Date.now();
    await chrome.storage.local.set({ pairingState: "connected" });
    return;
  }
  if (msg.type === "pair-pending") {
    wsReady = false;
    await chrome.storage.local.set({ pairingState: "pending" });
    return;
  }
  if (msg.type === "device-credential") {
    await chrome.storage.local.set({ deviceId: msg.deviceId, deviceCredential: msg.credential, pairingState: "connected" });
    wsReady = true;
    return;
  }
  if (msg.type === "pair-expired" || msg.type === "pair-rejected") {
    wsReady = false; authBlocked = true;
    await chrome.storage.local.set({ pairingState: msg.type === "pair-expired" ? "expired" : "rejected" });
    return;
  }
  if (msg.type === "auth-fail") {
    wsReady = false; authBlocked = true;
    await chrome.storage.local.set({ pairingState: "revoked" });
    return;
  }
  if (msg.type === "ping") { try { active.send(JSON.stringify({ type: "pong" })); } catch (e) {} return; }
  if (msg.type === "cmd") {
    let out;
    try {
      const data = await runCommand(msg.action, msg.params || {});
      out = { type: "result", id: msg.id, ok: true, data };
    } catch (e) {
      out = { type: "result", id: msg.id, ok: false, error: String(e && e.message ? e.message : e) };
    }
    try { active.send(JSON.stringify(out)); } catch (e) {}
  }
}

chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") {
    if (!wsReady) connect();
    cleanupDebugger();
  }
});

// ---------------------------------------------------------------- commands

async function runCommand(action, params) {
  const s = await getSettings();
  const isAction = ACTION_TOOLS.has(action) || action === "chrome_eval";
  if (isAction) {
    if (s.mode === "readonly") throw new Error("Extension is in read-only mode — open the Otto Chrome Bridge popup to allow control.");
    if (action === "chrome_eval" && !s.allowEval) throw new Error("chrome_eval is disabled — enable 'Allow JS evaluation' in the extension popup first.");
    await checkBlocklist(s, action, params);
    if (s.mode === "ask") await requireApproval(action, params);
  }

  switch (action) {
    case "chrome_status":
      return {
        connected: true,
        extVersion: chrome.runtime.getManifest().version,
        chromeVersion: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "",
        mode: s.mode,
        tabCount: (await chrome.tabs.query({})).length
      };

    case "chrome_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({ id: t.id, url: t.url || "", title: t.title || "", active: !!t.active, windowId: t.windowId }));
    }

    case "chrome_open": {
      if (!params.url) throw new Error("url is required");
      const tab = await chrome.tabs.create({ url: params.url, active: !params.background });
      const t = await waitForComplete(tab.id, params.timeoutMs || 20000);
      return { tabId: t.id, url: t.url, title: t.title };
    }

    case "chrome_navigate": {
      const tab = await resolveTab(params.tabId);
      if (!params.url) throw new Error("url is required");
      await chrome.tabs.update(tab.id, { url: params.url });
      const t = await waitForComplete(tab.id, params.timeoutMs || 20000);
      return { tabId: t.id, url: t.url, title: t.title };
    }

    case "chrome_close_tab": {
      const tab = await resolveTab(params.tabId);
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }

    case "chrome_read": {
      const tab = await resolveTab(params.tabId);
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPage,
        args: [params.maxChars || 15000]
      });
      if (!inj || !inj.result) throw new Error("Could not read the page (chrome:// and Web Store pages are off-limits)" + (inj && inj.error ? ": " + inj.error.message : ""));
      return inj.result;
    }

    case "chrome_screenshot": {
      const tab = await resolveTab(params.tabId);
      if (!tab.active) {
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tab.id, { active: true });
        await sleep(300);
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl, tabId: tab.id, url: tab.url };
    }

    case "chrome_act":
      return await runAct(params);

    case "chrome_eval": {
      const tab = await resolveTab(params.tabId);
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (code) => { try { return { ok: true, value: eval(code) }; } catch (e) { return { ok: false, error: String(e) }; } },
        args: [params.expression]
      });
      if (!inj || !inj.result) throw new Error("eval failed to inject");
      if (!inj.result.ok) throw new Error("eval error: " + inj.result.error);
      let value = inj.result.value;
      try { JSON.stringify(value); } catch (e) { value = String(value); }
      return { value };
    }

    default:
      throw new Error("Unknown action: " + action);
  }
}

// ---------------------------------------------------------------- act (control)

async function runAct(params) {
  const tab = await resolveTab(params.tabId);
  const steps = Array.isArray(params.steps) ? params.steps : [params];
  if (!steps.length) throw new Error("No steps given");
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      const out = await doStep(tab.id, step);
      results.push({ step: i, action: step.action, result: out });
    } catch (e) {
      results.push({ step: i, action: step.action, error: String(e && e.message ? e.message : e) });
      throw new Error(`Step ${i} (${step.action}) failed: ${e && e.message ? e.message : e} | results so far: ${JSON.stringify(results)}`);
    }
  }
  return { results };
}

async function doStep(tabId, step) {
  const a = (step.action || "click").toLowerCase();
  if (a === "wait") { await sleep(Math.min(step.ms || 500, 15000)); return "waited"; }

  if (a === "scroll") {
    const dir = step.direction === "up" ? -1 : 1;
    const amount = Math.abs(step.amount || 800);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 360, deltaX: 0, deltaY: dir * amount });
    return "scrolled";
  }

  if (a === "key") {
    const k = normalizeKey(step.key);
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...k });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...k });
    return "key " + step.key;
  }

  if (a === "select") {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId }, func: setSelect, args: [{ target: step.target, value: String(step.value ?? "") }]
    });
    const r = inj && inj.result;
    if (!r || !r.found) throw new Error((r && r.error) || "select not found");
    return "selected " + r.selected;
  }

  if (a === "press") { // press at raw coordinates without resolving
    const { x, y } = step;
    if (typeof x !== "number" || typeof y !== "number") throw new Error("press needs numeric x and y");
    await mouseClick(tabId, x, y, step.clickCount || 1);
    return `pressed at ${x},${y}`;
  }

  // click / type resolve a target first
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId }, func: resolveTarget, args: [{ target: step.target || null, x: step.x ?? null, y: step.y ?? null, pick: Number.isInteger(step.pick) ? step.pick : null }]
  });
  const hit = inj && inj.result;
  if (!hit || !hit.found) throw new Error((hit && hit.error) || "resolve failed: " + JSON.stringify(inj).slice(0, 500));
  const { x, y } = hit;

  if (a === "click") {
    await mouseClick(tabId, x, y, step.clickCount || 1);
    return `clicked ${hit.tag} "${hit.text || hit.cssPath || ""}"`;
  }
  if (a === "type") {
    await mouseClick(tabId, x, y, 1); // focus
    await sleep(80);
    if (step.replace !== false) {
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    }
    await cdp(tabId, "Input.insertText", { text: String(step.value ?? "") });
    if (step.then === "Enter") {
      const k = normalizeKey("Enter");
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...k });
    }
    return `typed into ${hit.tag}`;
  }
  throw new Error("Unknown step action: " + a);
}

async function mouseClick(tabId, x, y, clickCount) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount, buttons: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount, buttons: 0 });
}

const KEYMAP = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " }
};

function normalizeKey(name) {
  const k = KEYMAP[String(name).toLowerCase()];
  if (k) return k;
  const s = String(name);
  if (s.length === 1) return { key: s, code: "Key" + s.toUpperCase(), windowsVirtualKeyCode: s.toUpperCase().charCodeAt(0), text: s };
  throw new Error("Unknown key: " + name);
}

// ---------------------------------------------------------------- debugger

async function cdp(tabId, method, params) {
  if (!debuggerTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
  }
  debuggerTabs.set(tabId, Date.now());
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

function cleanupDebugger() {
  const now = Date.now();
  for (const [tabId, last] of debuggerTabs) {
    if (now - last > 120000) {
      chrome.debugger.detach({ tabId }).catch(() => {});
      debuggerTabs.delete(tabId);
    }
  }
}

chrome.debugger.onDetach.addListener((source) => { if (source.tabId) debuggerTabs.delete(source.tabId); });
chrome.tabs.onRemoved.addListener((tabId) => debuggerTabs.delete(tabId));

// ---------------------------------------------------------------- helpers

async function resolveTab(tabId) {
  if (tabId != null) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) return tab;
  const tabs = await chrome.tabs.query({ active: true });
  if (tabs.length) return tabs[0];
  throw new Error("No active tab found");
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUp);
      chrome.tabs.get(tabId).then(resolve).catch(() => reject(new Error("tab closed while loading")));
    }, timeoutMs);
    function onUp(id, change) {
      if (id === tabId && change.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUp);
        setTimeout(() => chrome.tabs.get(tabId).then(resolve).catch(reject), 150);
      }
    }
    chrome.tabs.onUpdated.addListener(onUp);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkBlocklist(s, action, params) {
  const blocked = String(s.blocklist || "").split(/[\n,]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!blocked.length) return;
  const hosts = [];
  if (params.url) { try { hosts.push(new URL(params.url).hostname); } catch (e) {} }
  if (params.tabId != null) { try { hosts.push(new URL((await chrome.tabs.get(params.tabId)).url).hostname); } catch (e) {} }
  if (params.tabId == null && !params.url) {
    try { const t = await resolveTab(null); hosts.push(new URL(t.url).hostname); } catch (e) {}
  }
  for (const h of hosts) {
    if (blocked.some(b => h === b || h.endsWith("." + b))) {
      throw new Error(`Blocked by the extension blocklist: ${h}`);
    }
  }
}

function describeCmd(action, params) {
  const t = (s) => String(s || "").slice(0, 140);
  let what = action;
  if (action === "chrome_act") {
    const steps = Array.isArray(params.steps) ? params.steps : [params];
    what = steps.map(s => `${s.action || "click"}${s.target ? ` "${t(s.target)}"` : ""}${s.value != null ? ` = "${t(s.value)}"` : ""}`).join("; ");
  } else if (action === "chrome_open") what = `open ${t(params.url)}`;
  else if (action === "chrome_navigate") what = `navigate to ${t(params.url)}`;
  else if (action === "chrome_close_tab") what = `close tab ${params.tabId ?? "active"}`;
  else if (action === "chrome_eval") what = `run JS: ${t(params.expression)}`;
  return `Otto wants to: ${what}`;
}

function requireApproval(action, params) {
  return new Promise((resolve, reject) => {
    const id = "appr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const desc = describeCmd(action, params);
    let settled = false;
    const finish = (ok, err) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      pendingApprovals.delete(id);
      chrome.notifications.clear(id);
      if (!pendingApprovals.size) chrome.action.setBadgeText({ text: "" });
      ok ? resolve() : reject(new Error(err));
    };
    const timer = setTimeout(() => finish(false, "Approval timed out after 90s — action blocked"), 90000);
    pendingApprovals.set(id, {
      desc, createdAt: Date.now(),
      allow: () => finish(true),
      deny: () => finish(false, "Denied by user in Chrome")
    });
    chrome.action.setBadgeText({ text: "?" });
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Otto Chrome Bridge",
      message: desc + " — Allow?",
      buttons: [{ title: "Allow" }, { title: "Deny" }],
      requireInteraction: true,
      priority: 2
    }, (created) => {
      if (chrome.runtime.lastError || !created) {
        // No notification UI (rare): fall back to popup-only approval, also timed out above.
      }
    });
  });
}

chrome.notifications.onButtonClicked.addListener((id, btn) => {
  const p = pendingApprovals.get(id);
  if (!p) return;
  btn === 0 ? p.allow() : p.deny();
});
chrome.notifications.onClosed.addListener((id) => {
  const p = pendingApprovals.get(id);
  if (p) p.deny();
});

// ---------------------------------------------------------------- popup messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.kind === "status") {
        const s = await getSettings();
        const publicSettings = { ...s };
        delete publicSettings.deviceCredential;
        sendResponse({
          ok: true, connected: wsReady, lastHelloOk,
          settings: publicSettings,
          pairingState: s.pairingState || "not_paired",
          pending: Array.from(pendingApprovals.entries()).map(([id, p]) => ({ id, desc: p.desc, createdAt: p.createdAt }))
        });
      } else if (msg.kind === "save") {
        const clean = {};
        for (const k of Object.keys(DEFAULTS)) if (msg.settings && k in msg.settings) clean[k] = msg.settings[k];
        const current = await getSettings();
        if (clean.bridgeUrl && clean.bridgeUrl !== current.bridgeUrl) {
          clean.deviceId = ""; clean.deviceCredential = ""; clean.pairingState = "not_paired";
        }
        await chrome.storage.local.set(clean);
        authBlocked = false; reconnectDelay = 200; connect();
        sendResponse({ ok: true });
      } else if (msg.kind === "connect-now") {
        authBlocked = false; reconnectDelay = 200; connect();
        sendResponse({ ok: true });
      } else if (msg.kind === "reset-pairing") {
        authBlocked = false; wsReady = false;
        await chrome.storage.local.set({ deviceId: "", deviceCredential: "", pairingState: "not_paired" });
        reconnectDelay = 200; connect();
        sendResponse({ ok: true });
      } else if (msg.kind === "approval") {
        const p = pendingApprovals.get(msg.id);
        if (!p) return sendResponse({ ok: false, error: "not found" });
        msg.allow ? p.allow() : p.deny();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async response
});

connect();
// Remove the old shared browser token from pre-pairing releases.
chrome.storage.local.remove(["token"]);

// ---------------------------------------------------------------- injected functions (self-contained)

function extractPage(maxChars) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  const q = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; } };
  const headings = q("h1,h2,h3").filter(vis).slice(0, 40).map(h => `${"#".repeat(Math.min(+h.tagName[1] || 1, 3))} ${(h.innerText || "").trim().slice(0, 200)}`).filter(Boolean);
  const links = q("a[href]").filter(vis).slice(0, 80)
    .map(a => ({ text: ((a.innerText || "").trim() || a.getAttribute("aria-label") || "").slice(0, 120), href: a.href }))
    .filter(l => l.text);
  const inputs = q("input,textarea").filter(vis).slice(0, 60).map(i => ({
    tag: i.tagName.toLowerCase(), type: i.type || "", name: i.name || "", id: i.id || "",
    placeholder: i.placeholder || "", aria: i.getAttribute("aria-label") || "",
    value: (i.type === "password" ? "[hidden]" : String(i.value || "").slice(0, 80))
  }));
  const buttons = q('button,[role="button"],input[type=submit],[type="button"],summary').filter(vis).slice(0, 80)
    .map(b => ((b.innerText || b.value || b.getAttribute("aria-label") || "").trim().slice(0, 120)))
    .filter(Boolean);
  let body = "";
  try { body = (document.body ? document.body.innerText : ""); } catch (e) {}
  body = body.replace(/\n{3,}/g, "\n\n").slice(0, maxChars);
  return {
    title: document.title, url: location.href,
    meta: (document.querySelector("meta[name=description]") || {}).content || "",
    headings, links, inputs, buttons, body
  };
}

function resolveTarget({ target, x, y }) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.visibility !== "hidden" && st.display !== "none";
  };
  const cssPath = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let n = el;
    for (let i = 0; n && n.tagName && i < 4; i++) {
      let seg = n.tagName.toLowerCase();
      if (n.className && typeof n.className === "string") seg += "." + n.className.trim().split(/\s+/).slice(0, 2).join(".");
      parts.unshift(seg);
      n = n.parentElement;
    }
    return parts.join(" > ");
  };
  const label = (el) => ((el.innerText || el.value || el.getAttribute("aria-label") || el.placeholder || "").trim().slice(0, 100));

  let el = null;
  let candidates = [];

  if (target) {
    // Try as a CSS selector first (only if it looks like one).
    if (/^[.#a-zA-Z*\[]/.test(target) && !/ /.test(target)) {
      try {
        const m = Array.from(document.querySelectorAll(target)).filter(vis);
        if (m.length === 1) el = m[0];
        else if (m.length > 1) { el = null; candidates = m.slice(0, 6).map(c => ({ css: cssPath(c), text: label(c) })); if (m.length) el = m[0]; }
      } catch (e) { /* not a valid selector; fall through to text search */ }
    }
    if (!el || candidates.length) {
      const t = String(target).toLowerCase();
      const pool = Array.from(document.querySelectorAll(
        'a,button,[role="button"],[role="checkbox"],[role="radio"],[role="tab"],input,textarea,select,label,summary,[onclick],[contenteditable="true"]'
      )).filter(vis);
      let matches = pool.filter(c => {
        const txt = (c.innerText || c.value || "").trim().toLowerCase();
        const aria = (c.getAttribute("aria-label") || "").toLowerCase();
        const ph = (c.placeholder || "").toLowerCase();
        const nm = (c.name || "").toLowerCase();
        const id = (c.id || "").toLowerCase();
        return txt === t || aria === t || (txt && txt.includes(t) && txt.length <= t.length + 40) || (aria && aria.includes(t)) || (ph && ph.includes(t)) || nm === t || id === t;
      });
      // Dedupe: a <label> whose for-target is also matched is redundant — keep the label (bigger target).
      matches = matches.filter(c => {
        if (c.tagName === "LABEL" && c.htmlFor) return !matches.some(m => m !== c && m.id === c.htmlFor);
        if ("INPUT TEXTAREA SELECT".includes(c.tagName) && matches.some(m => m !== c && m.tagName === "LABEL" && m.contains(c))) return false; // radio/checkbox wrapped in its label — click the label
        return true;
      });
      const exact = matches.filter(c => {
        const txt = (c.innerText || c.value || "").trim().toLowerCase();
        const aria = (c.getAttribute("aria-label") || "").toLowerCase();
        return txt === t || aria === t;
      });
      const best = exact.length ? exact : matches;
      if (best.length === 1) { el = best[0]; candidates = []; }
      else if (best.length > 1) {
        candidates = best.slice(0, 8).map(c => ({ css: cssPath(c), text: label(c), tag: c.tagName.toLowerCase() }));
        if (Number.isInteger(pick) && pick >= 0 && pick < best.length) el = best[pick];
      }
    }
  }

  if (!el) {
    if (typeof x === "number" && typeof y === "number") return { found: true, x, y };
    const msg = target
      ? (candidates.length
        ? `Several elements matched "${target}" — pass pick:0..${candidates.length - 1} to choose one: ${JSON.stringify(candidates)}`
        : `No visible element matched "${target}"`)
      : "No target given";
    return { found: false, error: msg, candidates };
  }

  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { found: false, error: "Element is invisible", candidates };
  return {
    found: true, x: r.left + r.width / 2, y: r.top + r.height / 2,
    tag: el.tagName.toLowerCase(), text: label(el), cssPath: cssPath(el),
    candidates
  };
}

function setSelect({ target, value }) {
  const selects = Array.from(document.querySelectorAll("select")).filter(s => {
    const r = s.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const t = String(target || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  let el = null;
  for (const s of selects) {
    const name = (s.name || "").toLowerCase();
    const id = (s.id || "").toLowerCase();
    const aria = (s.getAttribute("aria-label") || "").toLowerCase();
    const text = (s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : "").toLowerCase();
    if (t && (name === t || id === t || aria.includes(t) || text.includes(t))) { el = s; break; }
    if (!t) {
      for (const o of s.options) if (o.text.toLowerCase() === v || o.value.toLowerCase() === v) { el = s; break; }
      if (el) break;
    }
  }
  if (!el) return { found: false, error: `No <select> matched "${target}"` };
  let picked = null;
  for (const o of el.options) {
    if (o.text.toLowerCase().includes(v) || o.value.toLowerCase() === v) { picked = o; break; }
  }
  if (!picked) return { found: false, error: `No option matching "${value}" in select "${target}"` };
  el.focus();
  el.value = picked.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { found: true, selected: picked.text };
}
