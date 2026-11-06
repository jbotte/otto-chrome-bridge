# Otto Chrome Bridge

Let your **Otto** read and control the Chrome browser on your computer — with your approval on every action.

Your Otto agent gets tools like `chrome_read`, `chrome_screenshot`, `chrome_open`, and `chrome_act` (trusted clicks and typing) that run in **your real Chrome**, with your logins. A small bridge service on your Otto relays commands to a Chrome extension over WebSocket (across your LAN or Tailscale), and exposes them to Otto as an MCP server.

```
Your Otto agent ──MCP/HTTP──▶ bridge (node, on your Otto :8712) ──WebSocket──▶ Chrome extension ──CDP──▶ your tabs
```

## Safety model (built in, not bolted on)

- **Ask mode (default):** every action that changes something — a click, keystroke, navigation, close — pops a Chrome notification with **Allow / Deny** buttons. Reads and screenshots are silent. 90 s timeout = blocked.
- **Read-only mode:** Otto can look, never touch.
- **Blocklist:** domains you list (banking, mail…) are refused even in auto mode.
- **`chrome_eval` is off by default** and always asks, even when enabled.
- Password fields are never included in page reads (`[hidden]`).
- New browsers begin quarantined; the owner approves each pairing through Otto before the browser can read or control tabs.
- Each approved browser receives its own random credential directly over WebSocket. The bridge stores only a hash; the credential is never displayed or copied through chat.
- MCP administration is loopback-only (`127.0.0.1`) and has no secret in its URL. Unpaired network clients can only request access.

## Setup (one-time, ~5 minutes)

### 1 · Install the bridge on your Otto

No SSH is needed: ask your Otto to run the installer on its own device:

> Install the Otto Chrome Bridge on yourself: run
> `curl -fsSL https://raw.githubusercontent.com/jbotte/otto-chrome-bridge/main/install.sh | bash`
> and tell me when it finishes.

The installer prints the bridge URL(s) Chrome can reach and the local MCP address. It does not print a reusable browser secret.

### 2 · Load the extension in Chrome

On the computer where your Chrome lives:

1. Download and unzip <https://github.com/jbotte/otto-chrome-bridge/archive/refs/heads/main.zip>
2. Open `chrome://extensions`, enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension` folder inside

### 3 · Pair them

Click the Otto Chrome Bridge icon in the toolbar:

- **Bridge URL** — one of the URLs the installer printed, e.g. `ws://my-otto.tailnet.ts.net:8712/ws` (Tailscale from elsewhere, LAN address at home)
- **This Chrome is called…** — give this browser a distinct name
- Press **Connect & request pairing**. It will wait for Otto's approval; there is no code to copy.

### 4 · Connect Otto

In the Otto app: **Settings → Integrations → + → MCP server**, add the local address printed by the installer, e.g. `http://127.0.0.1:8712/mcp`.

Then ask Otto to approve the pending Chrome pairing. Otto lists the waiting browser so you can confirm it is the one you just named. The extension turns green after approval. Repeat for each additional browser; no SSH is needed.

Done. Try: *“open hacker news in my Chrome and read me the top stories.”*

## Several Chrome browsers or computers

One bridge can accept multiple extension connections on the network — for example, `work-laptop`, `home-desktop`, and `family-PC`. Give every extension a distinct name in its popup under **This Chrome is called…**. The bridge keeps each connected browser separate.

- `chrome_devices` lists connected browser names and IDs.
- Every other `chrome_*` tool accepts an optional `device` value (name or ID), e.g. `chrome_read({"device":"work-laptop"})`.
- If you omit `device`, Otto uses the most recently connected browser; if that one disconnects, the most recent survivor becomes the default.
- Use unique names, especially for separate Chrome profiles on the same computer.

Each browser requests pairing separately and receives its own revocable credential. To connect from outside the home network, use a Tailscale address reachable from that computer. Don't expose the bridge to the public internet.

## Tools Otto gets

| Tool | What it does | Needs approval |
|---|---|---|
| `chrome_pair_requests` | list browsers waiting to pair | no |
| `chrome_pair_approve` | approve a browser after the owner requests pairing | owner-directed |
| `chrome_pair_reject` | reject a pending pairing | owner-directed |
| `chrome_device_revoke` | revoke a browser's credential | owner-directed |
| `chrome_devices` | list connected browsers and IDs | no |
| `chrome_status` | extension connected? mode? version | no |
| `chrome_tabs` | list open tabs | no |
| `chrome_read` | title, body text, headings, links, inputs, buttons of a tab | no |
| `chrome_screenshot` | PNG of the visible tab | no |
| `chrome_open` | open a URL in a new tab | **yes** |
| `chrome_navigate` | navigate a tab | **yes** |
| `chrome_close_tab` | close a tab | **yes** |
| `chrome_act` | click / type / key / scroll / select / wait, by element text or CSS selector, via trusted DevTools input | **yes** |
| `chrome_eval` | run JS in the page (opt-in, off by default) | **yes, always** |

`chrome_act` targets work with the **visible text** from `chrome_read` (`{"action":"click","target":"Sign in"}`) or a CSS selector. Ambiguous matches are refused with a candidate list instead of clicking something random; choose one by passing `pick: 0` (or another listed candidate index).

## Notes & limits

- Requires Chrome 116+ (WebSocket in the extension service worker).
- While Otto is typing/clicking, Chrome shows the yellow *“Otto Chrome Bridge started debugging this browser”* banner. That's Chrome's standard honesty banner — it disappears when the debugger detaches (auto after ~2 min idle).
- `chrome://`, the Web Store, and other extension pages are off-limits (Chrome policy, by design).
- Prefer the Tailscale address: Tailscale encrypts the connection. The LAN `ws://` option is unencrypted and should be used only on a trusted private network. Do not expose the port to the public internet. Only owner-approved, individually credentialed browsers can issue commands.
- The bridge listens on `0.0.0.0:8712` for browser connections, while MCP administration accepts requests only from loopback. Paired-device hashes are stored in `~/.otto-chrome/config.json` with owner-only permissions.
- Uninstall: `bash ~/.otto-chrome/uninstall.sh`.

## Development

```
otto-chrome/
  extension/     MV3 Chrome extension (background service worker + popup)
  bridge/        single-file node bridge (MCP + WebSocket), dep: ws
  install.sh     installer: config, systemd-free autostart, prints pairing info
  tools/         icon generator
```

Tests: `bash test/run.sh` exercises two named fake browsers, device selection, disconnect fallback, MCP calls and denial handling. `bash test/chrome-e2e.sh` runs the real extension in headless Chrome and verifies reading, screenshot, typing, clicking and form submission.

MIT licensed. Not affiliated with Google; "Otto" is your friendly agent.
