# Pi ntfy.sh Extension

Sends push notifications via [ntfy.sh](https://ntfy.sh) when the pi agent completes work and you're idle. Perfect for starting work on your desk and seamlessly continuing on your mobile device.

## Requirements

- macOS (for idle detection)
- [ntfy CLI](https://ntfy.sh/docs/install/) installed and configured. The `ntfy.ts` calls `ntfy send` when it sends a notification so make sure that works.

## Installation

1. Install:

   ```bash
   pi install ./ntfy.ts
   ```

2. Or run directly for testing:
   ```bash
   pi -e ./ntfy.ts
   ```

## Configuration

Environment variables:

| Variable               | Default | Description                         |
| ---------------------- | ------- | ----------------------------------- |
| `PI_NTFY_TOPIC`        | `pi`    | ntfy topic to publish to            |
| `PI_NTFY_IDLE_SECONDS` | `20`    | Idle time threshold (seconds)       |
| `PI_NTFY_DISABLED`     | -       | Set to `1` to disable notifications |

## Usage

The extension automatically sends notifications when:

1. The pi agent finishes processing (`agent_end` event)
2. You've been idle for at least `PI_NTFY_IDLE_SECONDS` (default 60s)

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
