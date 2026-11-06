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
  if (!$("blocklist").matches(":focus")) $("blocklist").value = s.blocklist;
  if (!$("deviceName").matches(":focus")) $("deviceName").value = s.deviceName;
  $("mode").value = s.mode;
  $("allowEval").checked = !!s.allowEval;
  if (!s.bridgeUrl) setStatus(false, "Not configured — set the Bridge URL, then Save.");
  else if (resp.connected) setStatus(true, "Connected to Otto ✓");
  else if (resp.pairingState === "pending") setStatus(false, "Pairing requested — ask Otto to approve this Chrome.");
  else if (resp.pairingState === "revoked") setStatus(false, "This Chrome was revoked — reset pairing to request access again.");
  else if (resp.pairingState === "expired" || resp.pairingState === "rejected") setStatus(false, "Pairing did not complete — reset pairing to try again.");
  else setStatus(false, "Not paired — save settings to request pairing.");
  $("version").textContent = "v" + chrome.runtime.getManifest().version + (resp.lastHelloOk ? " · last connected " + new Date(resp.lastHelloOk).toLocaleTimeString() : "");

  $("pairAgain").hidden = !!resp.connected;

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
      deviceName: $("deviceName").value.trim(),
      mode: $("mode").value,
      blocklist: $("blocklist").value,
      allowEval: $("allowEval").checked
    }
  });
  setStatus(false, "Saved — connecting…");
  setTimeout(refresh, 1200);
};

$("pairAgain").onclick = async () => {
  await chrome.runtime.sendMessage({ kind: "reset-pairing" });
  setStatus(false, "Pairing request sent — ask Otto to approve this Chrome.");
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

refresh();
setInterval(refresh, 1500);
