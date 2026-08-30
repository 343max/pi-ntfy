# Pi ntfy.sh Extension

Sends push notifications via [ntfy.sh](https://ntfy.sh) when the pi agent completes work and you're idle. Perfect for starting work on your desk and seamlessly continuing on your mobile device.

## Requirements

- macOS (for idle detection)
- [ntfy CLI](https://ntfy.sh/docs/install/) installed and configured. The `ntfy.ts` calls `ntfy send` when it sends a notification so make sure that works.

## Installation

1. Install:

   ```bash
   pi install https://github.com/343max/pi-ntfy
   ```

2. Or run directly for testing:
   ```bash
   pi -e https://github.com/343max/pi-ntfy
   ```

## Configuration

Environment variables:

| Variable               | Default                                                      | Description                         |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------- |
| `PI_NTFY_TOPIC`        | `pi`                                                         | ntfy topic to publish to            |
| `PI_NTFY_IDLE_SECONDS` | `20`                                                         | Idle time threshold (seconds)       |
| `PI_NTFY_DISABLED`     | -                                                            | Set to `1` to disable notifications |
| `PI_NTFY_CLICK_URL`    | `https://pi-macbook.tun.43v.de/?session=<sessionid>` | URL opened when the notification is tapped; set to empty to disable |

## Click URL

Set `PI_NTFY_CLICK_URL` to a URL template that is opened when a notification is
**tapped** on your phone (ntfy's `--click` action). Leave it empty to disable
click actions.

The extension ships with a default that deep-links to a pi session web view
on a Tailscale hostname. Override it in your shell config to change the target
or to disable click actions entirely:

```fish
# ~/.config/fish/config.fish (or your shell's rc file)
set -gx PI_NTFY_CLICK_URL "https://pi-macbook.tun.43v.de/?session=<sessionid>"
# set -gx PI_NTFY_CLICK_URL ""   # disables click actions
```

The variable is read when pi starts, so open a new shell (or restart pi)
after changing it.

Placeholders are substituted at send time. Both `{name}` and `<name>` syntax
are supported (case-insensitive), so both of these work:

```
https://pi-macbook.tun.43v.de/?session=<sessionid>
https://pi-macbook.tun.43v.de/?session={sessionId}
```

Available placeholders:

| Placeholder        | Value                                                          |
| ------------------ | ------------------------------------------------------------- |
| `{sessionid}`      | Pi session UUID (`sessionManager.getSessionId()`)             |
| `{sequenceid}`     | SHA256 of CWD — same id used for ntfy dedup (`-S`)            |
| `{sessionfile}`    | Basename of the session file (empty for in-memory sessions)   |
| `{cwd}`            | Current working directory                                     |
| `{cwdencoded}`     | CWD URL-encoded (for query parameters)                        |
| `{title}`          | Notification title                                            |
| `{titleencoded}`   | Title URL-encoded (for query parameters)                      |
| `{topic}`          | The ntfy topic                                                |
| `{timestamp}`      | Unix epoch seconds (UTC)                                      |

Unknown placeholders are left as-is so a misconfigured template is easy to spot.

> **Note**: `{sessionid}` is the pi session UUID from
> `sessionManager.getSessionId()`. If your target expects the session file name
> instead (e.g. a viewer that reads `~/.pi/agent/sessions/...`), use
> `{sessionfile}`.

## Usage

The extension automatically sends notifications when:

1. The pi agent finishes processing (`agent_end` event)
2. The pi agent pauses to ask you a question (`ask_user_question` tool)

Both only fire when you've been idle for at least `PI_NTFY_IDLE_SECONDS` (default 20s).

Notifications are only sent from an **interactive (TUI) session**. One-shot/headless
invocations — `pi -p`, `pi --mode json`, and `pi --mode rpc` — never notify, since
there's no human at the terminal to walk away from.

### Manual Test

To send a test notification immediately (skips idle check):

```
/ntfy-test
```

## How It Works

- **Idle Detection**: Uses `ioreg -c IOHIDSystem` to get HID idle time on macOS
- **Notification Content**:
  - Title: `pi 🤖 ~/Projects/my-project` (CWD with `~` shorthand)
  - Message: Last assistant response (truncated to ~400 chars)
- **Session Tracking**: Uses SHA256 hash of session file as sequence ID (`-S` flag), so notifications update instead of stacking

## Troubleshooting

- Check ntfy CLI is working: `ntfy publish mytopic "test"`
- Use `/ntfy-test` command to verify the extension is loaded
- Errors from `ntfy publish` are shown via pi's notification UI
