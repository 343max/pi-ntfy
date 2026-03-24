import type { ExtensionAPI, ExtensionContext, AgentEndEvent } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { complete, completeSimple } from "@mariozechner/pi-ai";

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
      const nanoseconds = parseInt(match[1] || "0", 10);
      return nanoseconds / 1_000_000_000;
    }
  } catch {
    // Ignore errors
  }
  // Return Infinity to trigger notification on failure (fail open)
  return Infinity;
}

// Extract text from the last assistant message
function getLastAssistantText(messages: AgentEndEvent["messages"]): string | undefined {
  // Iterate backwards to find last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg === undefined) continue;
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const textParts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }

    if (textParts.length > 0) {
      return textParts.join("\n").trim();
    }
  }
  return undefined;
}

// Check if text is simple enough to skip LLM processing
function shouldSkipProcessing(text: string): boolean {
  if (text.length > 400) return false;

  const markdownPatterns = [
    /```/, // Code blocks
    /`[^`]+`/, // Inline code
    /^#{1,6}\s/m, // Headers
    /\*\*|__/, // Bold
    /\*|_/, // Italic
    /\[.+\]\(.+\)/, // Links
    /^\s*[-*+]\s/m, // Lists
    /^\s*\d+\.\s/m, // Numbered lists
    />\s/, // Blockquotes
    /\|.+\|/, // Tables
  ];

  return !markdownPatterns.some((p) => p.test(text));
}

// Summarize text using LLM
async function summarizeWithLLM(text: string, ctx: ExtensionContext): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("No model configured");

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) throw new Error("No API key");

  const input = text.slice(0, 1000);

  const prompt = `Summarize this in under 400 characters using only text and emojis. Focus on the key result or action:\n\n${input}`;

  const response = await completeSimple(
    model,
    {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey },
  );

  if (response.stopReason === "error") {
    throw new Error(response.errorMessage);
  }

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .slice(0, 400);
}

// Get sequence ID (full SHA256 of CWD)
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

    const text = getLastAssistantText(event.messages);
    if (!text) return;

    const sessionId = getSequenceId(ctx);
    const cwd = ctx.cwd.replace(/^\/Users\/[^/]+/, "~");
    const title = `pi 🤖 ${cwd}`;

    // Plausibility check: simple enough to send as-is
    if (shouldSkipProcessing(text)) {
      await sendNotification(config.topic, title, text, sessionId, ctx);
      return;
    }

    // Fire and forget: summarize and send
    const processAndNotify = async () => {
      try {
        const summary = await summarizeWithLLM(text, ctx);
        await sendNotification(config.topic, title, `Summary: ${summary}`, sessionId, ctx);
      } catch (error) {
        // Fallback: send truncated original

        const fallback = text.slice(0, 397) + "...";
        await sendNotification(config.topic, title, fallback, sessionId, ctx);
      }
    };

    // Don't await - let agent continue immediately
    processAndNotify().catch(console.error);
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
      const message = `${cwd} - Your lucky emojis for the day are: ${getRandomEmojis()}`;
      await sendNotification(config.topic, title, message, sessionId, ctx);
    },
  });
}
