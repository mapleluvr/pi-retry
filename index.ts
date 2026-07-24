import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, type TUI } from "@mariozechner/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * pi-retry: Handles fallback retries for assistant errors + manual retry.
 *
 * Two features:
 *
 * 1. **Auto-retry** — On `agent_end`, if the last assistant message has an
 *    error not covered by pi's built-in retry, wait with exponential
 *    backoff and re-invoke the LLM. The failed assistant message is already
 *    stripped from LLM context by pi's `transform-messages` (it skips any
 *    assistant message with stopReason "error" or "aborted"). We just need
 *    to send a hidden trigger to kick off a new turn.
 *
 * 2. **Manual retry** — `/retry` command or pressing Enter on an empty
 *    editor retries the last prompt. Works for any aborted/errored
 *    response, including user-initiated ESC cancellations. Uses the
 *    `onTerminalInput` hook to intercept Enter before pi swallows it.
 *
 * History:
 *   The session is append-only, so we can't delete the aborted assistant
 *   message. But from the model's perspective, it's invisible (stripped by
 *   transform-messages). Our trigger messages use `display: false` so they
 *   don't clutter the TUI.
 *
 * Logging:
 *   Each retry attempt is logged to ~/.pi/logs/pi-retry.jsonl.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const RETRY_CUSTOM_TYPE = "__retry_trigger";

// Patterns already handled by Pi's built-in retry. Keep these out of the
// extension fallback so one failure never consumes both retry budgets.
const BUILTIN_RETRY_PATTERNS =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i;

// Context overflow has its own Pi recovery path: compact first, then retry.
// The fallback must not queue a competing continuation from agent_end.
const CONTEXT_OVERFLOW_PATTERNS =
  /prompt is too long|request_too_large|input is too long for requested model|exceeds (?:the )?(?:model'?s )?(?:maximum )?context (?:window|length)|input token count.*exceeds the maximum|maximum prompt length is \d+|reduce the length of the messages|maximum context length is \d+ tokens|maximum allowed input length|longer than the model'?s context length|exceeds the available context size|greater than the context length|context window exceeds limit|exceeded model token limit|configured context size|model_context_window_exceeded|context[_ ]length[_ ]exceeded|too many tokens|token limit exceeded|^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

interface PiSettings {
  retry?: Record<string, unknown>;
  [key: string]: unknown;
}

type RetrySettingsScope = "global" | "project";

interface ResolvedRetryCount {
  maxRetries: number;
  source: RetrySettingsScope | "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured || join(homedir(), ".pi", "agent");
}

function getSettingsPath(cwd: string, scope: RetrySettingsScope): string {
  return scope === "global"
    ? join(getAgentDir(), "settings.json")
    : join(cwd, ".pi", "settings.json");
}

function readSettingsFile(path: string): PiSettings {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`Settings root must be a JSON object: ${path}`);
  }
  return parsed as PiSettings;
}

function tryReadSettingsFile(path: string): PiSettings {
  try {
    return readSettingsFile(path);
  } catch {
    return {};
  }
}

function configuredRetryCount(settings: PiSettings): number | undefined {
  const value = isRecord(settings.retry) ? settings.retry.maxRetries : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function resolveRetryCount(cwd: string, projectTrusted: boolean): ResolvedRetryCount {
  const globalCount = configuredRetryCount(
    tryReadSettingsFile(getSettingsPath(cwd, "global")),
  );
  let resolved: ResolvedRetryCount = globalCount === undefined
    ? { maxRetries: DEFAULT_MAX_RETRIES, source: "default" }
    : { maxRetries: globalCount, source: "global" };

  if (projectTrusted) {
    const projectCount = configuredRetryCount(
      tryReadSettingsFile(getSettingsPath(cwd, "project")),
    );
    if (projectCount !== undefined) {
      resolved = { maxRetries: projectCount, source: "project" };
    }
  }

  return resolved;
}

function writeRetryCount(path: string, maxRetries: number): void {
  const settings = readSettingsFile(path);
  const retry = isRecord(settings.retry) ? settings.retry : {};
  const updated: PiSettings = {
    ...settings,
    retry: {
      ...retry,
      maxRetries,
    },
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}

function isProjectTrusted(ctx: any): boolean {
  return typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
}

function isContextOverflowError(errorMessage: string): boolean {
  if (/rate limit|too many requests/i.test(errorMessage)) return false;
  return CONTEXT_OVERFLOW_PATTERNS.test(errorMessage);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), ".pi", "logs");
const LOG_FILE = join(LOG_DIR, "pi-retry.jsonl");

interface RetryLogEntry {
  timestamp: string;
  event: "retry" | "retry_exhausted" | "retry_succeeded" | "manual_retry";
  provider?: string;
  model?: string;
  modelId?: string;
  api?: string;
  thinkingLevel?: string;
  stopReason?: string;
  errorMessage?: string;
  attempt: number;
  maxRetries: number;
  delayMs?: number;
  cwd: string;
  sessionId?: string;
  // Context size at the time of the event
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
  messageCount?: number;
}

function logRetryEvent(entry: RetryLogEntry): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort — don't break the extension if logging fails.
  }
}

/** Extract context size fields from the extension context. */
function getContextFields(ctx: any): Pick<RetryLogEntry, "contextTokens" | "contextWindow" | "contextPercent"> {
  const usage = ctx.getContextUsage?.();
  if (!usage) return {};
  return {
    contextTokens: usage.tokens,
    contextWindow: usage.contextWindow,
    contextPercent: usage.percent,
  };
}

// ---------------------------------------------------------------------------
// TUI focus detection
// ---------------------------------------------------------------------------

/**
 * Check if the editor is the currently focused component. Uses duck-typing
 * against the TUI's (runtime-accessible) focusedComponent: editors have both
 * `onSubmit` and `getText`, which no selector/dialog/overlay component does.
 *
 * When a modal UI is shown (model selector, confirm dialog, session picker,
 * extension selector, overlay, etc.), focus moves away from the editor, and
 * this returns false — preventing our Enter handler from stealing the keypress.
 */
function isEditorFocused(tui: TUI | null): boolean {
  if (!tui) return false;
  const focused = (tui as any).focusedComponent;
  if (!focused) return false;
  // Duck-type: the editor component has getText + onSubmit; selectors don't.
  return typeof focused.getText === "function" && "onSubmit" in focused;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piRetry(pi: ExtensionAPI) {
  // -- Auto-retry state --
  let retryAttempt = 0;
  let maxRetries = DEFAULT_MAX_RETRIES;
  let lastErrorMessage = "";
  let lastStopReason = "";

  // -- Shared state: track whether last response was an error/abort --
  // Used by the manual retry path to know if there's something to retry.
  let lastResponseWasError = false;

  // TUI reference, captured via a no-op widget during session_start.
  let tuiRef: TUI | null = null;

  // -----------------------------------------------------------------------
  // Reset auto-retry counter on successful responses
  // -----------------------------------------------------------------------
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;
    if (
      msg.role === "assistant" &&
      msg.stopReason !== "error" &&
      msg.stopReason !== "aborted"
    ) {
      lastResponseWasError = false;

      if (retryAttempt > 0) {
        const model = ctx.model;
        logRetryEvent({
          timestamp: new Date().toISOString(),
          event: "retry_succeeded",
          provider: model?.provider,
          model: model?.name,
          modelId: model?.id,
          api: model?.api,
          thinkingLevel: pi.getThinkingLevel(),
          stopReason: lastStopReason,
          errorMessage: lastErrorMessage,
          attempt: retryAttempt,
          maxRetries,
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          ...getContextFields(ctx),
        });

        ctx.ui.notify(`Retry succeeded on attempt ${retryAttempt}.`, "info");
        ctx.ui.setStatus("pi-retry", undefined);
        retryAttempt = 0;
        lastErrorMessage = "";
        lastStopReason = "";
      }
    }
  });

  // -----------------------------------------------------------------------
  // Auto-retry: detect retryable errors on agent_end
  // -----------------------------------------------------------------------
  pi.on("agent_end", async (event, ctx) => {
    const messages = event.messages;
    let lastAssistant: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistant = messages[i];
        break;
      }
    }
    if (!lastAssistant) return;

    const stopReason: string = lastAssistant.stopReason;
    const errorMessage: string = lastAssistant.errorMessage || "";

    // Track for manual retry
    if (stopReason === "error" || stopReason === "aborted") {
      lastResponseWasError = true;
    }

    // Never retry user-initiated aborts.
    if (
      stopReason === "aborted" &&
      /operation aborted|request was aborted/i.test(errorMessage)
    )
      return;

    // Retry every assistant error plus non-user aborts. Known built-in errors
    // stay with Pi, and context overflow stays with Pi's compaction recovery.
    if (stopReason !== "error" && stopReason !== "aborted") return;
    if (BUILTIN_RETRY_PATTERNS.test(errorMessage)) return;
    if (stopReason === "error" && isContextOverflowError(errorMessage)) return;

    retryAttempt++;
    lastErrorMessage = errorMessage;
    lastStopReason = stopReason;

    const model = ctx.model;

    if (retryAttempt > maxRetries) {
      logRetryEvent({
        timestamp: new Date().toISOString(),
        event: "retry_exhausted",
        provider: model?.provider,
        model: model?.name,
        modelId: model?.id,
        api: model?.api,
        thinkingLevel: pi.getThinkingLevel(),
        stopReason,
        errorMessage,
        attempt: retryAttempt - 1,
        maxRetries,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        messageCount: messages.length,
        ...getContextFields(ctx),
      });

      ctx.ui.notify(
        `Error persisted after ${maxRetries} retries: ${errorMessage}`,
        "error",
      );
      ctx.ui.setStatus("pi-retry", undefined);
      retryAttempt = 0;
      lastErrorMessage = "";
      lastStopReason = "";
      return;
    }

    const delayMs = BASE_DELAY_MS * 2 ** (retryAttempt - 1);

    logRetryEvent({
      timestamp: new Date().toISOString(),
      event: "retry",
      provider: model?.provider,
      model: model?.name,
      modelId: model?.id,
      api: model?.api,
      thinkingLevel: pi.getThinkingLevel(),
      stopReason,
      errorMessage,
      attempt: retryAttempt,
      maxRetries,
      delayMs,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      messageCount: messages.length,
      ...getContextFields(ctx),
    });

    ctx.ui.setStatus(
      "pi-retry",
      `Error "${errorMessage}", retrying (${retryAttempt}/${maxRetries}) in ${(delayMs / 1000).toFixed(0)}s…`,
    );

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    ctx.ui.setStatus("pi-retry", undefined);

    triggerRetry(pi);
  });

  // -----------------------------------------------------------------------
  // Manual retry: /retry command
  // -----------------------------------------------------------------------
  pi.registerCommand("retry", {
    description: "Retry the last prompt (use after aborted or errored responses)",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is still running.", "warning");
        return;
      }

      if (!lastResponseWasError) {
        ctx.ui.notify("Nothing to retry — last response completed successfully.", "warning");
        return;
      }

      const model = ctx.model;
      logRetryEvent({
        timestamp: new Date().toISOString(),
        event: "manual_retry",
        provider: model?.provider,
        model: model?.name,
        modelId: model?.id,
        api: model?.api,
        thinkingLevel: pi.getThinkingLevel(),
        attempt: 1,
        maxRetries: 1,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        ...getContextFields(ctx),
      });

      triggerRetry(pi);
    },
  });

  pi.registerCommand("retry-count", {
    description: "Get or set Pi retry.maxRetries, then reload after changes",
    handler: async (args, ctx) => {
      const commandCtx = ctx as any;
      const parts = args.trim().split(/\s+/).filter(Boolean);

      if (parts.length === 0) {
        const resolved = resolveRetryCount(ctx.cwd, isProjectTrusted(ctx));
        const source = resolved.source === "default"
          ? "Pi default (no settings override)"
          : `${resolved.source}: ${getSettingsPath(ctx.cwd, resolved.source)}`;
        ctx.ui.notify(
          [
            "Pi retry configuration",
            `Current retry.maxRetries: ${resolved.maxRetries}`,
            `Source: ${source}`,
            "",
            "Usage:",
            "  /retry-count                         Show this guide",
            "  /retry-count <count> [global|project]",
            "",
            "Examples:",
            "  /retry-count 5                       Set the global value",
            "  /retry-count 5 project               Set a trusted project override",
            "  /retry-count 0                       Disable automatic retries globally",
            "",
            "The count is extra retries after the initial request; 0 disables retries in that scope.",
            "Changing a value reloads Pi automatically.",
          ].join("\n"),
          "warning",
        );
        return;
      }

      const scope = (parts[1] ?? "global") as RetrySettingsScope;
      const count = Number(parts[0]);
      if (
        parts.length > 2 ||
        !Number.isInteger(count) ||
        count < 0 ||
        (scope !== "global" && scope !== "project")
      ) {
        ctx.ui.notify("Usage: /retry-count <non-negative integer> [global|project]", "error");
        return;
      }

      if (scope === "project" && !isProjectTrusted(ctx)) {
        ctx.ui.notify("Cannot write retry settings for an untrusted project.", "error");
        return;
      }

      try {
        writeRetryCount(getSettingsPath(ctx.cwd, scope), count);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to update retry settings: ${message}`, "error");
        return;
      }

      ctx.ui.notify(
        `Set Pi retry.maxRetries to ${count} (${scope}); reloading.`,
        "info",
      );
      await commandCtx.reload();
      return;
    },
  });

  // -----------------------------------------------------------------------
  // Empty Enter = retry: intercept raw terminal input via onTerminalInput
  // hook. When the editor is empty, the agent is idle, and the last
  // response was an error/abort, pressing Enter triggers a retry instead
  // of being swallowed as a no-op.
  //
  // We also check that the editor is the focused component. When a modal
  // UI is displayed (model selector, confirm dialog, session picker, etc.)
  // focus moves to the modal and we must NOT consume the Enter keypress —
  // otherwise the modal can't be interacted with.
  // -----------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    maxRetries = resolveRetryCount(ctx.cwd, isProjectTrusted(ctx)).maxRetries;
    retryAttempt = 0;
    lastErrorMessage = "";
    lastStopReason = "";
    lastResponseWasError = false;

    // Capture TUI reference via a zero-height widget factory. The factory
    // is called once with the TUI instance; we stash it and return an
    // invisible component (empty render, no height).
    ctx.ui.setWidget("__pi-retry-tui-probe", (tui) => {
      tuiRef = tui;
      // Return a minimal no-op component that renders nothing.
      return { render: () => [], invalidate: () => {} };
    }, { placement: "aboveEditor" });
    // Remove the widget immediately — we only needed it to grab tui.
    ctx.ui.setWidget("__pi-retry-tui-probe", undefined);

    ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "enter")) return;
      if (!lastResponseWasError) return;
      if (!ctx.isIdle()) return;
      if (ctx.ui.getEditorText().trim() !== "") return;
      // Don't consume Enter when a modal/selector/overlay has focus.
      if (!isEditorFocused(tuiRef)) return;

      // Consume the Enter keypress and trigger retry
      logRetryEvent({
        timestamp: new Date().toISOString(),
        event: "manual_retry",
        provider: ctx.model?.provider,
        model: ctx.model?.name,
        modelId: ctx.model?.id,
        api: ctx.model?.api,
        thinkingLevel: pi.getThinkingLevel(),
        attempt: 1,
        maxRetries: 1,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        ...getContextFields(ctx),
      });

      triggerRetry(pi);
      return { consume: true };
    });
  });

  // -----------------------------------------------------------------------
  // Context cleanup: strip our hidden trigger messages before LLM sees them.
  // transform-messages already strips the aborted assistant message, so we
  // only need to remove our custom trigger.
  // -----------------------------------------------------------------------
  pi.on("context", async (event) => {
    const cleaned = event.messages.filter(
      (msg: any) => !(msg.role === "custom" && msg.customType === RETRY_CUSTOM_TYPE),
    );
    if (cleaned.length === event.messages.length) return;
    return { messages: cleaned };
  });

  // -----------------------------------------------------------------------
  // Helper: send the hidden retry trigger
  // -----------------------------------------------------------------------
  function triggerRetry(pi: ExtensionAPI) {
    pi.sendMessage(
      {
        customType: RETRY_CUSTOM_TYPE,
        content: "Retrying.",
        display: false,
      },
      { triggerTurn: true },
    );
  }
}
