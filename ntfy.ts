import type { ExtensionAPI, AgentMessage, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

// Get idle time on macOS (in seconds)
async function getIdleTimeSeconds(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
    const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (match) {
      // HIDIdleTime is in nanoseconds
      const nanoseconds = parseInt(match[1], 10);
      return nanoseconds / 1_000_000_000;
    }
  } catch {
    // Ignore errors
  }
  // Return Infinity to trigger notification on failure (fail open)
  return Infinity;
}

// Extract text from the last assistant message
function getLastAssistantText(messages: AgentMessage[]): string | undefined {
  // Iterate backwards to find last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const textParts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }

    if (textParts.length > 0) {
      const fullText = textParts.join("\n").trim();
      // Truncate to ~400 chars
      if (fullText.length > 400) {
        return fullText.slice(0, 397) + "...";
      }
      return fullText;
    }
  }
  return undefined;
}

// Get session ID (full SHA256)
function getSequenceId(ctx: ExtensionContext): string {
  return createHash("sha256").update(ctx.cwd).digest("hex");
}

// Send notification via ntfy CLI
async function sendNotification(
  topic: string,
  title: string,
  message: string,
  sequenceId: string,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    await execFileAsync("ntfy", ["publish", "--title", title, "-S", sequenceId, topic, message]);
  } catch (error: any) {
    // Show error to user via notify
    const errorMsg = error?.stderr || error?.message || String(error);
    ctx.ui.notify(`ntfy error: ${errorMsg}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  // Main logic: check idle and notify
  pi.on("agent_end", async (event, ctx) => {
    if (config.disabled) return;
    if (process.platform !== "darwin") return;

    const idleSeconds = await getIdleTimeSeconds();
    if (idleSeconds < config.idleSeconds) return;

    const lastMessage = getLastAssistantText(event.messages);
    const sessionId = getSequenceId(ctx);
    const cwd = ctx.cwd.replace(/^\/Users\/[^/]+/, "~");
    const title = `pi 🤖 ${cwd}`;

    await sendNotification(config.topic, title, lastMessage || "Ready for input", sessionId, ctx);
  });

  // Emoji pool for test messages
  const EMOJI_POOL = [
    "🎉",
    "🚀",
    "🌟",
    "🔥",
    "✨",
    "🎨",
    "🎯",
    "🏆",
    "💡",
    "🌈",
    "🍀",
    "🦋",
    "🌸",
    "⚡",
    "🎸",
    "🎲",
    "🎪",
    "🌺",
    "🍕",
    "🎁",
  ];

  // Pick 3 random emojis from the pool
  function getRandomEmojis(): string {
    const shuffled = [...EMOJI_POOL].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3).join(" ");
  }

  // Test command
  pi.registerCommand("ntfy-test", {
    description: "Send test notification immediately",
    handler: async (_args, ctx) => {
      const sessionId = getSequenceId(ctx);
      const cwd = ctx.cwd.replace(/^\/Users\/[^/]+/, "~");
      const title = `pi 🤖 ${cwd}`;
      const message = `Your lucky emojis for the day are: ${getRandomEmojis()} ${sessionId}`;
      await sendNotification(config.topic, title, message, sessionId, ctx);
    },
  });
}
