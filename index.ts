import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, type TUI } from "@mariozechner/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * pi-retry: Handles fallback retries for assistant errors + manual retry.
 *
 * Three features:
 *
 * 1. **Auto-retry** — On `agent_end`, if the last assistant message has an
 *    error that neither Pi's built-in retry nor Pi's compaction recovery
 *    handles, wait with exponential backoff and re-invoke the LLM. The failed
 *    assistant message is stripped from LLM context by Pi's `transform-messages`
 *    (it skips any assistant message with stopReason "error" or "aborted"), so
 *    we only need to send a hidden trigger to kick off a new turn.
 *
 * 2. **Manual retry** — `/retry` command or pressing Enter on an empty
 *    editor retries the last prompt. Works for any aborted/errored
 *    response, including user-initiated ESC cancellations. Uses the
 *    `onTerminalInput` hook to intercept Enter before Pi swallows it.
 *
 * 3. **Fast-Retry mode** — `/fast-retry on <T> <N>` retries every T seconds
 *    (fixed interval, no exponential growth) up to N times.
 *
 *    It is implemented by *reconfiguring* Pi's built-in retry rather than
 *    disabling it: `retry.baseDelayMs` and `retry.maxAgentDelayMs` are both set
 *    to `T * 1000`, and `retry.maxRetries` to `N`. Pi computes
 *    `min(baseDelayMs * 2^(attempt-1), maxAgentDelayMs)`, so making the base
 *    equal to the cap yields a constant T-second delay at every attempt.
 *
 *    Because Pi keeps retrying (just at a fixed interval), this extension must
 *    skip exactly the errors Pi retries — see `piWillRetry()` below, which
 *    mirrors Pi's classification token-for-token. If the skip set were narrower
 *    than Pi's, a single error would consume both budgets.
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

const DEFAULT_RETRY_ENABLED = true;
const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_MAX_AGENT_DELAY_MS = 60_000;

const FAST_RETRY_MIN_INTERVAL_SEC = 1;
const FAST_RETRY_MAX_INTERVAL_SEC = 600;

/** The `retry.*` keys Fast-Retry overwrites (and restores on `off`). */
const RETRY_DELAY_KEYS = [
  "enabled",
  "maxRetries",
  "baseDelayMs",
  "maxAgentDelayMs",
] as const;

// ---------------------------------------------------------------------------
// Error classification — kept verbatim in sync with Pi
// ---------------------------------------------------------------------------

// Verbatim from pi-ai/dist/utils/retry.js. Pi checks this FIRST: a quota or
// billing error is never retried, even when its text also contains "429".
const NON_RETRYABLE_LIMIT_PATTERNS =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

// Verbatim from pi-ai/dist/utils/retry.js (RETRYABLE_PROVIDER_ERROR_PATTERN).
// This MUST stay a superset-or-equal of Pi's pattern: any token Pi retries but
// we fail to skip causes the same error to consume both retry budgets.
const RETRYABLE_PATTERNS =
  /overloaded|currently experiencing high demand|rate.?limit|too many requests|429|500|502|503|504|520|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|exceeded request buffer limit while retrying upstream|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i;

// Verbatim from pi-ai/dist/utils/overflow.js (Case 1 only). Cases 2 (silent
// overflow on `stop`) and 3 (length-stop overflow) can never fire here: our
// `agent_end` handler returns early unless stopReason is "error"/"aborted".
// Pi itself handles those cases via `_isRetryableError` / `_checkCompaction`.
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

/**
 * Case-1 context overflow detection (error message patterns), matching Pi's
 * `isContextOverflow(message, contextWindow)` for the stopReason "error" case.
 */
function isContextOverflowError(message: any): boolean {
  const errorMessage: unknown = message?.errorMessage;
  if (message?.stopReason !== "error" || typeof errorMessage !== "string" || !errorMessage) {
    return false;
  }
  if (NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))) return false;
  if (OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))) return true;
  return message.provider === "cerebras" && CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(errorMessage);
}

/**
 * Would Pi's built-in retry handle this error?
 *
 * Mirrors Pi's `_isRetryableError(message)` exactly:
 *   !isContextOverflow(message, model.contextWindow ?? 0) && isRetryableAssistantError(message)
 * where `isRetryableAssistantError` requires stopReason "error", a truthy
 * errorMessage, no limit-pattern match, and a retryable-pattern match.
 *
 * `contextWindow` is not needed: Cases 2/3 of `isContextOverflow` are guarded by
 * `if (contextWindow && ...)`, and Pi passes `?? 0` from `_isRetryableError`.
 */
function piWillRetry(message: any): boolean {
  if (message?.stopReason !== "error") return false;
  const errorMessage: unknown = message.errorMessage;
  if (typeof errorMessage !== "string" || !errorMessage) return false;
  if (NON_RETRYABLE_LIMIT_PATTERNS.test(errorMessage)) return false;
  if (isContextOverflowError(message)) return false;
  return RETRYABLE_PATTERNS.test(errorMessage);
}

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

interface PiSettings {
  retry?: Record<string, unknown>;
  [key: string]: unknown;
}

type RetrySettingsScope = "global" | "project";

interface ResolvedRetryCount {
  maxRetries: number;
  source: RetrySettingsScope | "default";
}

interface EffectiveRetry {
  /** Raw merged `retry.enabled` (may be any truthy/falsy value, like Pi's). */
  enabled: unknown;
  /** Truthiness of `enabled` — the only field callers should branch on. */
  retryEnabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs: number;
  fastRetry?: Record<string, unknown>;
  /** Which scope supplied a given key. */
  sourceOf: (key: string) => RetrySettingsScope | "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mirrors Pi's `isMergeableObject` (settings-manager.js). */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mirrors Pi's `deepMergeObjects(base, overrides)` exactly (settings-manager.js).
 * Deliberately has no root guard: `{ ...base }` on a non-object yields `{}`,
 * which is what Pi does too.
 */
function deepMergeObjects(base: any, overrides: any): any {
  const result: any = { ...base };
  for (const key of Object.keys(overrides)) {
    const overrideValue = overrides[key];
    if (overrideValue === undefined) continue;
    const baseValue = base?.[key];
    result[key] =
      isMergeableObject(baseValue) && isMergeableObject(overrideValue)
        ? deepMergeObjects(baseValue, overrideValue)
        : overrideValue;
  }
  return result;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`);
  }
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

/** Effective `retry.maxRetries` for the extension's own (non-Pi) retry budget. */
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

/** Which scope supplied `key`, following Pi's merge precedence. */
function keySource(g: unknown, p: unknown, key: string): RetrySettingsScope | "default" {
  // A non-object project `retry` replaces the global one wholesale.
  if (p !== undefined && !isMergeableObject(p)) return "project";
  if (isMergeableObject(p) && p[key] !== undefined) return "project";
  if (isMergeableObject(g) && g[key] !== undefined) return "global";
  return "default";
}

/**
 * Resolve the merged `retry` settings the way Pi does: deep-merge global with
 * a trusted project file, then apply `?? default` per key.
 *
 * `enabled` keeps Pi's raw value (Pi's `getRetryEnabled()` is
 * `retry?.enabled ?? true` and callers test it for truthiness), so `enabled: 0`
 * or `enabled: ""` means "disabled" exactly as it does in Pi.
 */
function resolveEffectiveRetry(cwd: string, projectTrusted: boolean): EffectiveRetry {
  const globalRoot = tryReadSettingsFile(getSettingsPath(cwd, "global"));
  const projectRoot = projectTrusted
    ? tryReadSettingsFile(getSettingsPath(cwd, "project"))
    : {};

  const settings = deepMergeObjects(globalRoot, projectRoot);
  const retry = (settings as PiSettings)?.retry;
  const o = isMergeableObject(retry) ? retry : undefined;
  const g = (globalRoot as PiSettings)?.retry;
  const p = (projectRoot as PiSettings)?.retry;

  const enabled = o?.enabled ?? DEFAULT_RETRY_ENABLED;
  return {
    enabled,
    retryEnabled: !!enabled,
    maxRetries: typeof o?.maxRetries === "number" ? o.maxRetries : DEFAULT_MAX_RETRIES,
    baseDelayMs: typeof o?.baseDelayMs === "number" ? o.baseDelayMs : DEFAULT_BASE_DELAY_MS,
    maxAgentDelayMs: typeof o?.maxAgentDelayMs === "number"
      ? o.maxAgentDelayMs
      : DEFAULT_MAX_AGENT_DELAY_MS,
    fastRetry: isMergeableObject(o?.fastRetry) ? o.fastRetry : undefined,
    sourceOf: (key: string) => keySource(g, p, key),
  };
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

// ---------------------------------------------------------------------------
// Fast-Retry settings I/O
// ---------------------------------------------------------------------------

/** Snapshot the four retry keys, using `null` for keys that are absent. */
function snapshotDelayKeys(retry: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of RETRY_DELAY_KEYS) {
    snapshot[key] = key in retry ? retry[key] : null;
  }
  return snapshot;
}

/**
 * Turn Fast-Retry on in `path`: set `baseDelayMs` and `maxAgentDelayMs` to
 * `T * 1000` so Pi's delay is constant, `maxRetries` to N, and `enabled` to
 * true. Preserves every other `retry.*` key (notably `provider`).
 *
 * Records the file's own previous four values in `retry.fastRetry.restore` so
 * `/fast-retry off` can restore them. Re-running `on` keeps the original
 * snapshot rather than overwriting it with Fast-Retry's own values.
 */
function writeFastRetrySettings(
  path: string,
  intervalSec: number,
  maxRetries: number,
): void {
  const settings = readSettingsFile(path);
  const retry = isRecord(settings.retry) ? settings.retry : {};
  const existing = isRecord(retry.fastRetry) ? retry.fastRetry : undefined;

  const restore = existing && existing.enabled === true && isRecord(existing.restore)
    ? existing.restore
    : snapshotDelayKeys(retry);

  const updated: PiSettings = {
    ...settings,
    retry: {
      ...retry,
      enabled: true,
      maxRetries,
      baseDelayMs: intervalSec * 1000,
      maxAgentDelayMs: intervalSec * 1000,
      fastRetry: {
        enabled: true,
        intervalSec,
        maxRetries,
        restore,
      },
    },
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}

/**
 * Undo Fast-Retry in `path`, if and only if that file carries our
 * `retry.fastRetry` marker.
 *
 * The marker check is essential: without it, a file we never touched would have
 * `restore === undefined`, and since `undefined == null` in JS we would delete
 * the user's own `retry.maxRetries` and friends.
 *
 * @returns true when the file had a marker and was cleaned up.
 */
function clearFastRetry(path: string): boolean {
  if (!existsSync(path)) return false;

  let settings: PiSettings;
  try {
    settings = readSettingsFile(path);
  } catch {
    return false;
  }

  const retry = isRecord(settings.retry) ? settings.retry : undefined;
  if (!retry) return false;
  const marker = isRecord(retry.fastRetry) ? retry.fastRetry : undefined;
  if (!marker) return false;

  const restore = isRecord(marker.restore) ? marker.restore : {};
  const next: Record<string, unknown> = { ...retry };
  for (const key of RETRY_DELAY_KEYS) {
    const original = restore[key];
    if (original === null || original === undefined) {
      delete next[key];
    } else {
      next[key] = original;
    }
  }
  delete next.fastRetry;

  const updated: PiSettings = { ...settings };
  if (Object.keys(next).length === 0) {
    delete updated.retry;
  } else {
    updated.retry = next;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return true;
}

function isProjectTrusted(ctx: any): boolean {
  return typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
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
  fastRetry?: boolean;
  intervalSec?: number;
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

/** Abortable sleep. Falls back to a plain timer when no signal is available. */
function sleepUnlessAborted(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal) {
      setTimeout(resolve, delayMs);
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

type RetryMode = "normal" | "fast";

export default function piRetry(pi: ExtensionAPI) {
  // -- Auto-retry state --
  let retryAttempt = 0;
  let maxRetries = DEFAULT_MAX_RETRIES;
  let lastErrorMessage = "";
  let lastStopReason = "";

  // Which budget `retryAttempt` currently counts against. Switching between
  // fast and normal mode resets the counter so the two budgets never mix.
  let attemptMode: RetryMode | null = null;

  // Avoid repeating the "fast config is overridden" warning every turn.
  let fastMismatchWarned = false;

  // -- Shared state: track whether last response was an error/abort --
  // Used by the manual retry path to know if there's something to retry.
  let lastResponseWasError = false;

  // TUI reference, captured via a no-op widget during session_start.
  let tuiRef: TUI | null = null;

  /**
   * Clear the auto-retry counter. Called from every path that ends or
   * invalidates a retry sequence: session start, a successful turn, budget
   * exhaustion, an aborted wait, a manual retry, and a mode switch.
   */
  function resetRetryState(): void {
    retryAttempt = 0;
    attemptMode = null;
  }

  function fastRetryStatus(fast: Record<string, unknown> | undefined): string {
    if (!fast || fast.enabled !== true) return "off";
    return `on (every ${fast.intervalSec}s, up to ${fast.maxRetries} times)`;
  }

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
          fastRetry: attemptMode === "fast",
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          ...getContextFields(ctx),
        });

        ctx.ui.notify(`Retry succeeded on attempt ${retryAttempt}.`, "info");
        ctx.ui.setStatus("pi-retry", undefined);
        resetRetryState();
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

    // Only error/abort responses are candidates. Length stops and successful
    // responses belong to Pi's compaction path.
    if (stopReason !== "error" && stopReason !== "aborted") return;

    const projectTrusted = isProjectTrusted(ctx);
    const effective = resolveEffectiveRetry(ctx.cwd, projectTrusted);

    // Hand the error to Pi when Pi will actually retry it. In Fast-Retry mode
    // Pi's retry has been reconfigured to a fixed T-second interval with an
    // N-retry budget, so this is also how Fast-Retry covers 429/503/timeouts.
    if (piWillRetry(lastAssistant) && effective.retryEnabled) return;

    // Errors Pi refuses on purpose must not be retried here either.
    if (NON_RETRYABLE_LIMIT_PATTERNS.test(errorMessage)) return;
    if (isContextOverflowError(lastAssistant)) return;

    // -- Fast-Retry mode --
    const fast = effective.fastRetry;
    const useFast = fast?.enabled === true;
    const intervalSec = useFast ? Number(fast?.intervalSec) : 0;
    const budget = useFast ? Number(fast?.maxRetries) : maxRetries;
    const fastUsable = useFast
      && Number.isInteger(intervalSec)
      && intervalSec >= FAST_RETRY_MIN_INTERVAL_SEC
      && Number.isInteger(budget)
      && budget >= 0;

    if (useFast && !fastUsable) {
      ctx.ui.notify(
        "Fast-Retry config is malformed; falling back to normal retry. Re-run /fast-retry on <T> <N>.",
        "warning",
      );
    }

    const activeFast = useFast && fastUsable;
    const activeMode: RetryMode = activeFast ? "fast" : "normal";
    const activeBudget = activeFast ? budget : maxRetries;

    // Warn once when Fast-Retry is on but an overriding scope defeats it.
    if (activeFast && !fastMismatchWarned) {
      const tMs = intervalSec * 1000;
      const mismatch =
        effective.baseDelayMs !== tMs
        || effective.maxAgentDelayMs !== tMs
        || effective.maxRetries !== budget;
      if (mismatch) {
        fastMismatchWarned = true;
        const keys = (["baseDelayMs", "maxAgentDelayMs", "maxRetries"] as const)
          .filter((k) => effective[k] !== (k === "maxRetries" ? budget : tMs))
          .map((k) => `${k} (from ${effective.sourceOf(k)})`);
        ctx.ui.notify(
          `Fast-Retry is active but ${keys.join(", ")} is overridden; Pi may not use a fixed ${intervalSec}s interval.`,
          "warning",
        );
      }
    }

    // Reset the counter when the mode changed so the two budgets stay separate.
    if (attemptMode !== activeMode) {
      retryAttempt = 0;
      attemptMode = activeMode;
    }

    retryAttempt++;
    lastErrorMessage = errorMessage;
    lastStopReason = stopReason;

    const model = ctx.model;
    const delayMs = activeFast
      ? intervalSec * 1000
      : BASE_DELAY_MS * 2 ** (retryAttempt - 1);

    if (retryAttempt > activeBudget) {
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
        maxRetries: activeBudget,
        fastRetry: activeFast,
        ...(activeFast ? { intervalSec } : {}),
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        messageCount: messages.length,
        ...getContextFields(ctx),
      });

      ctx.ui.notify(
        `Error persisted after ${activeBudget} retries: ${errorMessage}`,
        "error",
      );
      ctx.ui.setStatus("pi-retry", undefined);
      resetRetryState();
      lastErrorMessage = "";
      lastStopReason = "";
      return;
    }

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
      maxRetries: activeBudget,
      delayMs,
      fastRetry: activeFast,
      ...(activeFast ? { intervalSec } : {}),
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      messageCount: messages.length,
      ...getContextFields(ctx),
    });

    ctx.ui.setStatus(
      "pi-retry",
      `Error "${errorMessage}", retrying (${retryAttempt}/${activeBudget}) in ${(delayMs / 1000).toFixed(0)}s…${activeFast ? " [fast]" : ""}`,
    );

    await sleepUnlessAborted(delayMs, ctx.signal);
    ctx.ui.setStatus("pi-retry", undefined);

    // An ESC during the wait aborts the run's signal. Stop here instead of
    // steering a new turn into an aborted run.
    if (ctx.signal?.aborted) {
      resetRetryState();
      return;
    }

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

      resetRetryState();
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
  // /fast-retry — fixed-interval retries
  // -----------------------------------------------------------------------
  pi.registerCommand("fast-retry", {
    description: "Toggle fixed-interval retries: /fast-retry on <seconds> <count> | off",
    handler: async (args, ctx) => {
      const commandCtx = ctx as any;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const globalPath = getSettingsPath(ctx.cwd, "global");
      const projectPath = getSettingsPath(ctx.cwd, "project");

      const guide = (): string => {
        const effective = resolveEffectiveRetry(ctx.cwd, isProjectTrusted(ctx));
        return [
          "Fast-Retry — fixed-interval retries",
          `Status: ${fastRetryStatus(effective.fastRetry)}`,
          `Effective: maxRetries=${effective.maxRetries} (${effective.sourceOf("maxRetries")}), `
            + `baseDelayMs=${effective.baseDelayMs} (${effective.sourceOf("baseDelayMs")}), `
            + `maxAgentDelayMs=${effective.maxAgentDelayMs} (${effective.sourceOf("maxAgentDelayMs")}), `
            + `enabled=${String(effective.enabled)} (${effective.sourceOf("enabled")})`,
          "",
          "Usage:",
          "  /fast-retry                  Show this guide",
          "  /fast-retry on <T> <N>       Retry every T seconds, up to N times",
          "  /fast-retry off              Restore normal exponential backoff",
          "",
          "Arguments:",
          `  T   fixed interval in whole seconds (${FAST_RETRY_MIN_INTERVAL_SEC}..${FAST_RETRY_MAX_INTERVAL_SEC})`,
          "  N   retry budget (non-negative integer), independent of retry.maxRetries",
          "",
          "How it works:",
          "  Sets retry.baseDelayMs = retry.maxAgentDelayMs = T*1000 and retry.maxRetries = N.",
          "  Pi's delay is min(baseDelayMs * 2^(attempt-1), maxAgentDelayMs), so equal base and",
          "  cap make every attempt wait exactly T seconds.",
          "",
          "Requirements:",
          "  1. retry.enabled must be true. Fast-Retry reconfigures Pi's built-in retry",
          "     instead of disabling it, so `on` is refused while retries are disabled.",
          "  2. The effective scope must not override those keys. Pi deep-merges global with",
          "     a trusted project file (project wins). Check the Effective line above.",
        ].join("\n");
      };

      // -- Read-only query --
      if (parts.length === 0) {
        ctx.ui.notify(guide(), "warning");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Agent is still running; /fast-retry cannot reload right now.",
          "warning",
        );
        return;
      }

      // -- off --
      if (parts[0] === "off") {
        if (parts.length > 1) {
          ctx.ui.notify("Usage: /fast-retry off", "error");
          return;
        }

        let restored = 0;
        try {
          // Walk every scope carrying our marker; a file without one is left
          // untouched so we never delete the user's own retry settings.
          for (const path of [globalPath, projectPath]) {
            if (clearFastRetry(path)) restored++;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to restore retry settings: ${message}`, "error");
          return;
        }

        if (restored === 0) {
          ctx.ui.notify("Fast-Retry is not enabled.", "info");
          return;
        }

        ctx.ui.notify(`Fast-Retry disabled; restored retry settings in ${restored} file(s); reloading.`, "info");
        await commandCtx.reload();
        return;
      }

      // -- on T N --
      if (parts[0] !== "on") {
        ctx.ui.notify("Usage: /fast-retry on <seconds> <count> | off", "error");
        return;
      }

      if (parts.length !== 3) {
        ctx.ui.notify("Usage: /fast-retry on <T> <N>", "error");
        return;
      }

      const intervalSec = Number(parts[1]);
      const count = Number(parts[2]);
      if (
        !Number.isInteger(intervalSec) ||
        intervalSec < FAST_RETRY_MIN_INTERVAL_SEC ||
        intervalSec > FAST_RETRY_MAX_INTERVAL_SEC ||
        !Number.isInteger(count) ||
        count < 0
      ) {
        ctx.ui.notify(
          `Usage: /fast-retry on <T> <N>  (T: integer ${FAST_RETRY_MIN_INTERVAL_SEC}..${FAST_RETRY_MAX_INTERVAL_SEC} seconds, N: non-negative integer)`,
          "error",
        );
        return;
      }

      const before = resolveEffectiveRetry(ctx.cwd, isProjectTrusted(ctx));
      if (!before.retryEnabled) {
        ctx.ui.notify(
          `Pi retries are disabled (retry.enabled from ${before.sourceOf("enabled")}); `
            + "Fast-Retry reconfigures Pi's built-in retry and cannot work without it. "
            + "Enable retries first (e.g. /retry-count 3).",
          "error",
        );
        return;
      }

      try {
        writeFastRetrySettings(globalPath, intervalSec, count);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to update retry settings: ${message}`, "error");
        return;
      }

      fastMismatchWarned = false;

      // Self-check: report if an overriding scope defeats the new config.
      const after = resolveEffectiveRetry(ctx.cwd, isProjectTrusted(ctx));
      const tMs = intervalSec * 1000;
      const mismatched = (["baseDelayMs", "maxAgentDelayMs", "maxRetries"] as const)
        .filter((key) => after[key] !== (key === "maxRetries" ? count : tMs));

      if (!after.retryEnabled) {
        ctx.ui.notify(
          `Wrote Fast-Retry (T=${intervalSec}s, N=${count}) to ${globalPath}, but retry.enabled is `
            + `overridden to a falsy value by ${after.sourceOf("enabled")}; Pi will not retry.`,
          "warning",
        );
      } else if (mismatched.length > 0) {
        ctx.ui.notify(
          `Wrote Fast-Retry (T=${intervalSec}s, N=${count}) to ${globalPath}, but `
            + `${mismatched.map((k) => `${k} is overridden by ${after.sourceOf(k)}`).join("; ")}. `
            + "The fixed interval may not take effect.",
          "warning",
        );
      } else {
        ctx.ui.notify(
          `Fast-Retry enabled: every ${intervalSec}s, up to ${count} times; reloading.`,
          "info",
        );
      }

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
    resetRetryState();
    fastMismatchWarned = false;
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

      resetRetryState();
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
