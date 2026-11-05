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
- Pairing token required both ways: the extension must present it, and Otto's MCP URL carries it.

## Setup (one-time, ~5 minutes)

### 1 · Install the bridge on your Otto

Tell your Otto:

> Install the Otto Chrome Bridge on yourself: run
> `curl -fsSL https://raw.githubusercontent.com/jbotte/otto-chrome-bridge/main/install.sh | bash`
> then add the MCP URL it prints as an integration.

Or run the command yourself in a terminal on the Otto. It prints a **token**, the **bridge URL(s)** your Chrome should use, and the **MCP URL**.

### 2 · Load the extension in Chrome

On the computer where your Chrome lives:

1. Download and unzip <https://github.com/jbotte/otto-chrome-bridge/archive/refs/heads/main.zip>
2. Open `chrome://extensions`, enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension` folder inside

### 3 · Pair them

Click the Otto Chrome Bridge icon in the toolbar:

- **Bridge URL** — one of the URLs the installer printed, e.g. `ws://my-otto.tailnet.ts.net:8712/ws` (Tailscale MagicDNS works from anywhere on your tailnet; the LAN IP works at home)
- **Token** — from the installer output
- Press **Save & connect** — the status should turn green.

### 4 · Connect Otto

In the Otto app: **Settings → Integrations → + → MCP server**, and paste the MCP URL from the installer output (`http://127.0.0.1:8712/mcp?t=…`).

Done. Try: *“open hacker news in my Chrome and read me the top stories.”*

## Tools Otto gets

| Tool | What it does | Needs approval |
|---|---|---|
| `chrome_status` | extension connected? mode? version | no |
| `chrome_tabs` | list open tabs | no |
| `chrome_read` | title, body text, headings, links, inputs, buttons of a tab | no |
| `chrome_screenshot` | PNG of the visible tab | no |
| `chrome_open` | open a URL in a new tab | **yes** |
| `chrome_navigate` | navigate a tab | **yes** |
| `chrome_close_tab` | close a tab | **yes** |
| `chrome_act` | click / type / key / scroll / select / wait, by element text or CSS selector, via trusted DevTools input | **yes** |
| `chrome_eval` | run JS in the page (opt-in, off by default) | **yes, always** |

`chrome_act` targets work with the **visible text** from `chrome_read` (`{"action":"click","target":"Sign in"}`) or a CSS selector. Ambiguous matches are refused with a candidate list instead of clicking something random.

## Notes & limits

- Requires Chrome 116+ (WebSocket in the extension service worker).
- While Otto is typing/clicking, Chrome shows the yellow *“Otto Chrome Bridge started debugging this browser”* banner. That's Chrome's standard honesty banner — it disappears when the debugger detaches (auto after ~2 min idle).
- `chrome://`, the Web Store, and other extension pages are off-limits (Chrome policy, by design).
- Traffic between Chrome and the bridge is plain WebSocket on your LAN/Tailscale; the token gates commands. On a shared LAN, keep the extension in Ask mode.
- The bridge listens on `0.0.0.0:8712`; change the port with `--port` and keep the token secret (`~/.otto-chrome/config.json`).
- Uninstall: `bash ~/.otto-chrome/uninstall.sh`.

## Development

```
otto-chrome/
  extension/     MV3 Chrome extension (background service worker + popup)
  bridge/        single-file node bridge (MCP + WebSocket), dep: ws
  install.sh     installer: config, systemd-free autostart, prints pairing info
  tools/         icon generator
```

Test locally without Chrome: `node bridge/server.js` with `OTTO_CHROME_TOKEN=*** OTTO_CHROME_DIR=/tmp/x`, then `node test/fake-extension.js` drives a scripted extension while `test/mcp-check.sh` exercises the MCP endpoint.

MIT licensed. Not affiliated with Google; "Otto" is your friendly agent.
