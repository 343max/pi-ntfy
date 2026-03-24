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

### 2. NTFY.sh Integration

- **Method**: Use `ntfy` CLI (already fully configured including auth)
- **Topic**: Configurable, defaults to `"pi"`
- **Headers**:
  - `Title`: "Pi Ready" or similar ^[WITH THE CWD!]
  - `Priority`: 4 (high) for urgent attention
  - `Tags`: `robot` emoji 🤖
  - ^[-S session-id so old notifications will be overwritten]
  - ^[run ntfy send --help to read the documentation how to use it!]

### 3. Notification Content

Include useful context so the user knows what happened:

- **Message**: Last assistant message (truncated if too long) + CWD ^[CWD should be part of the title]
- **Session name** (if set)
- **Working directory** (important for context)

The `agent_end` event includes `event.messages` - an array of `AgentMessage` from this prompt. We can extract the last assistant message to include in the notification.

### 4. Configuration

Environment variables (simple, no config file needed):

- `PI_NTFY_TOPIC` - Topic name (default: "pi")
- `PI_NTFY_IDLE_SECONDS` - Idle threshold in seconds (default: 60)
- `PI_NTFY_DISABLED` - Set to "1" to disable

### 5. Rate Limiting / Deduplication

**None** - Just send the notification. The user can't start new processes fast enough to spam.

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
   │              Yes
   │              ▼
   │         Send NTFY notification
   │              │
   ▼              ▼
[wait for user input]
```

## Code Structure

```typescript
import type { ExtensionAPI, AgentMessage } from "@mariozechner/pi-coding-agent";

// Config from environment
const config = {
  topic: process.env.PI_NTFY_TOPIC || "pi",
  idleSeconds: parseInt(process.env.PI_NTFY_IDLE_SECONDS || "60", 10),
  disabled: process.env.PI_NTFY_DISABLED === "1",
};

// Get idle time on macOS
async function getIdleTimeSeconds(): Promise<number> {
  // ioreg -c IOHIDSystem -d 4 | awk '/HIDIdleTime/ {print $NF/1000000000}'
}

// Extract text from the last assistant message
function getLastAssistantText(messages: AgentMessage[]): string | undefined {
  // Iterate backwards to find last assistant message
  // Extract text content blocks, join them, truncate to ~200 chars
}

// Send notification via ntfy CLI
async function sendNotification(title: string, message: string): Promise<void> {
  // ntfy publish --title="..." --priority=4 --tags=robot <topic> "message"
}

export default function (pi: ExtensionAPI) {
  // Main logic: check idle and notify
  pi.on("agent_end", async (event, ctx) => {
    if (config.disabled) return;
    if (process.platform !== "darwin") return; // macOS only for now

    const idleSeconds = await getIdleTimeSeconds();
    if (idleSeconds < config.idleSeconds) return;

    const sessionName = pi.getSessionName();
    const lastMessage = getLastAssistantText(event.messages);

    // Build message: last assistant text + CWD
    let message = lastMessage || "Ready for input";
    message += `\nCWD: ${ctx.cwd}`;

    await sendNotification(sessionName ? `Pi: ${sessionName}` : "Pi Ready", message);
  });
}
```

## Message Type Reference

From `agent_end` event, `event.messages` contains `AgentMessage[]`:

```typescript
// AssistantMessage (what we care about)
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  // ... other fields
}

interface TextContent {
  type: "text";
  text: string;
}
```

To get the last assistant response:

1. Filter messages by `role === "assistant"`
2. Take the last one
3. Extract `text` from `content` blocks where `type === "text"`
4. Join and truncate

## Files to Create

1. **`ntfy.ts`** - Main extension file
2. **`README.md`** - Installation and usage instructions

## Testing Plan

1. Load extension with `pi -e ./ntfy.ts`
2. Run a simple prompt: "say hello"
3. While active: should NOT notify (not idle)
4. Wait 60+ seconds without touching computer
5. Run another prompt: should notify
6. Verify notification appears on phone

## Future Enhancements

1. **Cross-platform idle detection**: Linux (`xprintidle`), Windows (GetLastInputInfo)
2. **Richer context**: Include summary of changes made
3. **Action buttons**: "Continue on mobile" with session URL
4. **Configurable priorities**: Different priority for errors vs success

## References

- [ntfy.sh docs](https://docs.ntfy.sh/publish/)
- ntfy CLI: `ntfy publish --help`
- macOS idle detection: `ioreg -c IOHIDSystem`
- pi extensions docs: `/Users/max/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- Message types: `/Users/max/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
