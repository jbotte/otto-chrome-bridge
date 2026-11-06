const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class Element {
  constructor() { this.value = ""; this.checked = false; this.hidden = false; this.dataset = {}; this.listeners = {}; this.children = []; this.textContent = ""; }
  matches(selector) { return selector === ":focus" && this.focused; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  set innerHTML(value) { this.children = []; }
  select() {}
}

const ids = ["status", "pending", "bridgeUrl", "blocklist", "deviceName", "mode", "allowEval", "version", "pairAgain", "save", "copyUrl"];
const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
let polls = 0;
let savedSettings = { bridgeUrl: "ws://saved.example/ws", blocklist: "saved.example", deviceName: "Saved Chrome", mode: "ask", allowEval: false };
const chrome = {
  runtime: {
    getManifest: () => ({ version: "0.3.2" }),
    sendMessage: async message => {
      if (message.kind === "save") { savedSettings = { ...savedSettings, ...message.settings }; return { ok: true }; }
      if (message.kind !== "status") return { ok: true };
      polls++;
      return { ok: true, settings: savedSettings, connected: polls > 1, pairingState: "pending", pending: [], lastHelloOk: null };
    }
  }
};
const context = { document: { getElementById: id => elements[id], createElement: () => new Element() }, chrome, setInterval: () => {}, setTimeout: () => {}, console };
vm.runInNewContext(fs.readFileSync("extension/popup.js", "utf8") + "\nglobalThis.refreshForTest = refresh;", context);
(async () => {
  await context.refreshForTest();
  assert.equal(elements.bridgeUrl.value, "ws://saved.example/ws");
  elements.bridgeUrl.value = "ws://unsaved.example/ws";
  elements.bridgeUrl.listeners.input();
  elements.bridgeUrl.focused = false; // reproduce blur before periodic refresh
  await context.refreshForTest();
  assert.equal(elements.bridgeUrl.value, "ws://unsaved.example/ws", "refresh preserves a blurred unsaved Bridge URL");
  assert.equal(elements.status.textContent, "Connected to Otto ✓", "status still refreshes");
  elements.mode.value = "auto";
  elements.mode.listeners.change();
  await context.refreshForTest();
  assert.equal(elements.mode.value, "auto", "refresh preserves an unsaved Auto selection after blur");
  await elements.save.onclick();
  await context.refreshForTest();
  assert.equal(savedSettings.mode, "auto", "Save persists Auto mode");
  assert.equal(elements.mode.value, "auto", "refresh displays the saved Auto mode");
  console.log("PASS: popup refresh preserves unsaved form values, persists Auto, and refreshes status");
})().catch(error => { console.error(error); process.exitCode = 1; });
