import type { ExtensionAPI, ExtensionContext, AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { completeSimple } from "@earendil-works/pi-ai/compat";

const execFileAsync = promisify(execFile);

// Config from environment
const config = {
  topic: process.env.PI_NTFY_TOPIC || "pi",
  idleSeconds: parseInt(process.env.PI_NTFY_IDLE_SECONDS || "20", 10),
  disabled: process.env.PI_NTFY_DISABLED === "1",
  // URL template opened when the notification is tapped. Supports
  // {placeholder} and <placeholder> tokens, see buildClickVars().
  // Empty string disables the click action.
  clickUrl:
    process.env.PI_NTFY_CLICK_URL ||
    "https://pi-macbook.tun.43v.de/?session=<sessionid>",
};

// Session-scoped state captured on session_start, so event-bus handlers
// (which receive no ctx) can build the same notification payload.
let sessionCwd: string | undefined;
let sessionMode: string | undefined;
let sessionId: string | undefined;
let sessionFile: string | undefined;

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

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey) throw new Error("No API key");
  const apiKey = auth.apiKey;

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
function getSequenceId(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

// Shorten the cwd for display (~/Projects/foo)
function displayCwd(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

// Placeholder variables available in the PI_NTFY_CLICK_URL template.
// Both {name} and <name> syntax are supported, case-insensitive.
// Unknown placeholders are left untouched so a misconfigured template
// is visible instead of silently producing a broken URL.
type ClickVars = {
  sessionid: string; // pi session UUID (sessionManager.getSessionId())
  sequenceid: string; // SHA256 of cwd, same id used for ntfy dedup (-S)
  sessionfile: string; // basename of the session file (empty if in-memory)
  cwd: string; // current working directory
  cwdencoded: string; // cwd URL-encoded, for query parameters
  title: string; // notification title
  titleencoded: string; // title URL-encoded, for query parameters
  topic: string; // ntfy topic
  timestamp: number; // unix epoch seconds (UTC)
};

function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}|<(\w+)>/g, (match, brace, angle) => {
    const key = (brace ?? angle).toLowerCase();
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}

// Build the placeholder map for the click URL template.
function buildClickVars(input: {
  sessionId: string;
  sequenceId: string;
  sessionFile: string | undefined;
  cwd: string;
  title: string;
  topic: string;
}): ClickVars {
  return {
    sessionid: input.sessionId,
    sequenceid: input.sequenceId,
    sessionfile: input.sessionFile ? input.sessionFile.split("/").pop() ?? "" : "",
    cwd: input.cwd,
    cwdencoded: encodeURIComponent(input.cwd),
    title: input.title,
    titleencoded: encodeURIComponent(input.title),
    topic: input.topic,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

// Render the configured click URL, or undefined when disabled.
function resolveClickUrl(input: {
  sessionId: string;
  sequenceId: string;
  sessionFile: string | undefined;
  cwd: string;
  title: string;
  topic: string;
}): string | undefined {
  if (!config.clickUrl) return undefined;
  return renderTemplate(config.clickUrl, buildClickVars(input));
}

// Send notification via ntfy CLI
async function sendNotification(
  topic: string,
  title: string,
  message: string,
  sequenceId: string,
  options: { clickUrl?: string; ctx?: ExtensionContext } = {},
): Promise<void> {
  try {
    const args = ["publish", "--title", title, "-S", sequenceId];
    if (options.clickUrl) {
      args.push("--click", options.clickUrl);
    }
    args.push(topic, message);
    await execFileAsync("ntfy", args);
  } catch (error: any) {
    // Show error to user via notify (when a ctx is available)
    const errorMsg = error?.stderr || error?.message || String(error);
    if (options.ctx) {
      options.ctx.ui.notify(`ntfy error: ${errorMsg}`, "error");
    } else {
      console.error(`ntfy error: ${errorMsg}`);
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
    sessionMode = ctx.mode;
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile();
  });

  // Main logic: check idle and notify
  pi.on("agent_end", async (event, ctx) => {
    // Only notify in interactive TUI sessions. Suppresses -p, --mode json, and
    // --mode rpc, where there is no human at the terminal to walk away from.
    if (ctx.mode !== "tui") return;
    if (config.disabled) return;
    if (process.platform !== "darwin") return;

    const idleSeconds = await getIdleTimeSeconds();
    if (idleSeconds < config.idleSeconds) return;

    const text = getLastAssistantText(event.messages);
    if (!text) return;

    const sequenceId = getSequenceId(ctx.cwd);
    const title = `pi 🤖 ${displayCwd(ctx.cwd)}`;
    const clickUrl = resolveClickUrl({
      sessionId: ctx.sessionManager.getSessionId() ?? sequenceId,
      sequenceId,
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      title,
      topic: config.topic,
    });

    // Plausibility check: simple enough to send as-is
    if (shouldSkipProcessing(text)) {
      await sendNotification(config.topic, title, text, sequenceId, { clickUrl, ctx });
      return;
    }

    // Fire and forget: summarize and send
    const processAndNotify = async () => {
      try {
        const summary = await summarizeWithLLM(text, ctx);
        await sendNotification(config.topic, title, `Summary: ${summary}`, sequenceId, {
          clickUrl,
          ctx,
        });
      } catch (error) {
        // Fallback: send truncated original

        const fallback = text.slice(0, 397) + "...";
        await sendNotification(config.topic, title, fallback, sequenceId, { clickUrl, ctx });
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

  // Notify when the agent pauses to ask the user a question via the
  // ask_user_question extension (@juicesharp/rpiv-ask-user-question). That
  // extension emits "rpiv:ask-user:prompt" on the shared event bus when it
  // shows a questionnaire. agent_end only fires after the user answers, so
  // without this hook a question asked while you're away never notifies.
  async function notifyOnAskUser(data: unknown): Promise<void> {
    if (config.disabled) return;
    if (process.platform !== "darwin") return;
    if (sessionMode !== "tui") return;
    if (!sessionCwd) return;

    const payload = data as { questions?: Array<{ question?: string }> };
    const questions = payload.questions ?? [];
    const question = questions[0]?.question;
    if (!question) return;

    const idleSeconds = await getIdleTimeSeconds();
    if (idleSeconds < config.idleSeconds) return;

    const extra = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    const message = `Question: ${question}${extra}`.slice(0, 400);
    const sequenceId = getSequenceId(sessionCwd);
    const title = `pi 🤖 ${displayCwd(sessionCwd)}`;
    const clickUrl = resolveClickUrl({
      sessionId: sessionId ?? sequenceId,
      sequenceId,
      sessionFile,
      cwd: sessionCwd,
      title,
      topic: config.topic,
    });
    await sendNotification(config.topic, title, message, sequenceId, { clickUrl });
  }

  pi.events.on("rpiv:ask-user:prompt", (data) => {
    void notifyOnAskUser(data);
  });

  // Test command
  pi.registerCommand("ntfy-test", {
    description: "Send test notification immediately",
    handler: async (_args, ctx) => {
      const sequenceId = getSequenceId(ctx.cwd);
      const cwd = displayCwd(ctx.cwd);
      const title = `pi 🤖 ${cwd}`;
      const message = `${cwd} - Your lucky emojis for the day are: ${getRandomEmojis()}`;
      const clickUrl = resolveClickUrl({
        sessionId: ctx.sessionManager.getSessionId() ?? sequenceId,
        sequenceId,
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        title,
        topic: config.topic,
      });
      await sendNotification(config.topic, title, message, sequenceId, { clickUrl, ctx });
    },
  });
}
