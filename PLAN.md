# Pi NTFY Extension Plan

Sends push notifications via ntfy.sh when the pi agent completes work and the user is idle.

## Goal

Enable a seamless workflow: start work on your desk, walk away, get notified on your phone when pi is ready, continue on mobile.

## Key Design Decisions

### 1. Idle Detection (macOS only for now)

- **Method**: `ioreg -c IOHIDSystem` returns `HIDIdleTime` in nanoseconds
- **Conversion**: Divide by 1,000,000,000 to get seconds
- **Configurable threshold**: Default 60 seconds, customizable via config
- **Check timing**: Only check at `agent_end` event (not polling)
- **On failure**: Send notification anyway (fail open)

### 2. NTFY.sh Integration

- **Method**: Use `ntfy publish` CLI (already fully configured including auth)
- **Topic**: Configurable, defaults to `"pi"`
- **Options**:
  - `--title`: Format "pi 🤖 <CWD>" (with /Users/max replaced by ~/)
  - `-S <session-id>`: Full SHA256 hash of session file path

### 3. Notification Content

- **Title**: "pi 🤖 ~/Projects/foo" (CWD with ~ replacement)
- **Message**: Last assistant message (truncated if too long)
- **Session ID**: Full SHA256 of session file path for `-S` flag

The `agent_end` event includes `event.messages` - an array of `AgentMessage` from this prompt. We can extract the last assistant message to include in the notification body.

### 4. Error Handling

Pipe `ntfy publish` stderr to `ctx.ui.notify()` so the user sees any errors (network, auth, etc.) but workflow isn't interrupted.

### 5. Configuration

Environment variables:
- `PI_NTFY_TOPIC` - Topic name (default: "pi")
- `PI_NTFY_IDLE_SECONDS` - Idle threshold in seconds (default: 60)
- `PI_NTFY_DISABLED` - Set to "1" to disable

### 6. /ntfy-test Command

Register `/ntfy-test` command that:
- Skips idle check
- Sends notification immediately
- Shows result via `ctx.ui.notify()`

## Event Flow

```
agent_start
   │
   ▼
[agent processes...]
   │
   ▼
agent_end ──► Check idle time via ioreg
   │              │
   │              ▼
   │         Idle < threshold? ──► Skip notification
   │              │
   │              Yes (or ioreg failed)
   │              ▼
   │         Send NTFY notification
   │         (with -S session-id for updates)
   │              │
   ▼              ▼
[wait for user input]
```

## Code Structure

```typescript
import type { ExtensionAPI, AgentMessage } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

// Config from environment
const config = {
  topic: process.env.PI_NTFY_TOPIC || "pi",
  idleSeconds: parseInt(process.env.PI_NTFY_IDLE_SECONDS || "60", 10),
  disabled: process.env.PI_NTFY_DISABLED === "1",
};

// Get idle time on macOS
async function getIdleTimeSeconds(): Promise<number> {
  // ioreg -c IOHIDSystem -d 4 | awk '/HIDIdleTime/ {print $NF/1000000000}'
  // On error, return Infinity to trigger notification
}

// Extract text from the last assistant message
function getLastAssistantText(messages: AgentMessage[]): string | undefined {
  // Iterate backwards to find last assistant message
  // Extract text content blocks, join them, truncate to ~400 chars
}

// Get session ID (full SHA256)
function getSessionId(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile() || "unknown";
  return createHash("sha256").update(sessionFile).digest("hex");
}

// Send notification via ntfy CLI
async function sendNotification(
  topic: string,
  title: string,
  message: string,
  sequenceId: string,
  ctx: ExtensionContext,
): Promise<void> {
  // ntfy publish --title="..." -S <sequence-id> <topic> "message"
  // On error, pipe stderr to ctx.ui.notify()
}

export default function (pi: ExtensionAPI) {
  // Main logic: check idle and notify
  pi.on("agent_end", async (event, ctx) => {
    if (config.disabled) return;
    if (process.platform !== "darwin") return;

    const idleSeconds = await getIdleTimeSeconds();
    if (idleSeconds < config.idleSeconds) return;

    const lastMessage = getLastAssistantText(event.messages);
    const sessionId = getSessionId(ctx);
    const cwd = ctx.cwd.replace(/^\/Users\/[^/]+/, "~");
    const title = `pi 🤖 ${cwd}`;

    await sendNotification(
      config.topic,
      title,
      lastMessage || "Ready for input",
      sessionId,
      ctx,
    );
  });

  // Test command
  pi.registerCommand("ntfy-test", {
    description: "Send test notification immediately",
    handler: async (_args, ctx) => {
      const sessionId = getSessionId(ctx);
      const cwd = ctx.cwd.replace(/^\/Users\/[^/]+/, "~");
      const title = `pi 🤖 ${cwd}`;
      await sendNotification(
        config.topic,
        title,
        "Test notification from pi",
        sessionId,
        ctx,
      );
    },
  });
}
```

## NTFY CLI Command

```bash
ntfy publish \
  --title="pi 🤖 ~/Projects/my-project" \
  -S "<64-char-sha256-hash>" \
  pi \
  "I've completed the refactoring. All tests pass."
```

## Message Type Reference

From `agent_end` event, `event.messages` contains `AgentMessage[]`:

```typescript
// AssistantMessage (what we care about)
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
}

interface TextContent {
  type: "text";
  text: string;
}
```

To get the last assistant response:
1. Iterate `event.messages` backwards
2. Find message with `role === "assistant"`
3. Extract `text` from `content` blocks where `type === "text"`
4. Join and truncate to ~400 characters

## Files to Create

1. **`ntfy.ts`** - Main extension file
2. **`README.md`** - Installation and usage instructions

## References

- [ntfy.sh docs](https://docs.ntfy.sh/publish/)
- ntfy CLI: `ntfy publish --help`
- macOS idle detection: `ioreg -c IOHIDSystem`
- pi extensions docs
