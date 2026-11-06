const $ = (id) => document.getElementById(id);

function setStatus(ok, text) {
  const el = $("status");
  el.textContent = text;
  el.className = ok ? "on" : "off";
}

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ kind: "status" });
  if (!resp || !resp.ok) { setStatus(false, "Extension error: " + (resp && resp.error || "unknown")); return; }
  const s = resp.settings;
  if (!$("bridgeUrl").matches(":focus")) $("bridgeUrl").value = s.bridgeUrl;
  if (!$("token").matches(":focus")) $("token").value = s.token;
  if (!$("blocklist").matches(":focus")) $("blocklist").value = s.blocklist;
  if (!$("deviceName").matches(":focus")) $("deviceName").value = s.deviceName;
  $("mode").value = s.mode;
  $("allowEval").checked = !!s.allowEval;
  if (!s.bridgeUrl) setStatus(false, "Not configured — set the Bridge URL and token, then Save.");
  else setStatus(resp.connected, resp.connected ? "Connected to Otto ✓" : "Disconnected — retrying…");
  $("version").textContent = "v" + chrome.runtime.getManifest().version + (resp.lastHelloOk ? " · last connected " + new Date(resp.lastHelloOk).toLocaleTimeString() : "");

  const box = $("pending");
  box.innerHTML = "";
  for (const p of resp.pending) {
    const div = document.createElement("div");
    div.className = "pending";
    const d = document.createElement("div");
    d.className = "desc";
    d.textContent = p.desc;
    const row = document.createElement("div");
    row.className = "inline";
    const allow = document.createElement("button");
    allow.className = "allow"; allow.textContent = "Allow";
    const deny = document.createElement("button");
    deny.className = "deny"; deny.textContent = "Deny";
    allow.onclick = async () => { await chrome.runtime.sendMessage({ kind: "approval", id: p.id, allow: true }); refresh(); };
    deny.onclick = async () => { await chrome.runtime.sendMessage({ kind: "approval", id: p.id, allow: false }); refresh(); };
    row.append(allow, deny);
    div.append(d, row);
    box.append(div);
  }
}

$("save").onclick = async () => {
  await chrome.runtime.sendMessage({
    kind: "save",
    settings: {
      bridgeUrl: $("bridgeUrl").value.trim(),
      token: $("token").value.trim(),
      deviceName: $("deviceName").value.trim(),
      mode: $("mode").value,
      blocklist: $("blocklist").value,
      allowEval: $("allowEval").checked
    }
  });
  setStatus(false, "Saved — connecting…");
  setTimeout(refresh, 1200);
};

$("test").onclick = async () => {
  await chrome.runtime.sendMessage({ kind: "connect-now" });
  setStatus(false, "Reconnecting…");
  setTimeout(refresh, 1500);
};

function copyBtn(id, field) {
  $(id).onclick = () => {
    $(field).select();
    document.execCommand("copy");
    $(id).textContent = "✓";
    setTimeout(() => { $(id).textContent = "⧉"; }, 900);
  };
}
copyBtn("copyUrl", "bridgeUrl");
copyBtn("copyToken", "token");

refresh();
setInterval(refresh, 1500);
