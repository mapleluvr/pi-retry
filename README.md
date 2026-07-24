# pi-retry

A [pi](https://github.com/badlogic/pi) extension that retries failed LLM responses automatically, manually via `/retry`, or by pressing Enter.

## Features

### Auto-retry fallback errors

When an assistant response ends with an error that pi's built-in retry does not recognize, the extension retries it regardless of the error message. This covers bare or provider-specific errors such as `stream_read_error` without maintaining an allowlist.

- **Delays:** Exponential backoff starting at 2s (2s, 4s, 8s, ...)
- **Max attempts:** The effective pi `retry.maxRetries` value (default: 3)
- **No history pollution:** The failed response is invisible to the model (pi's `transform-messages` strips aborted/errored assistant messages). The retry trigger uses `display: false` so it is hidden in the TUI.

Errors already covered by pi's built-in retry (overload, rate limits, connection errors, 5xx responses, and similar failures) stay with pi so the two retry budgets do not stack. Context overflow stays with pi's compaction recovery. User-initiated aborts (ESC) are never auto-retried; use `/retry` or Enter for those.

### Retry count: `/retry-count`

The extension reads pi's effective `retry.maxRetries` setting. Global settings come from `~/.pi/agent/settings.json`; a trusted project's `.pi/settings.json` overrides the global value. If neither file configures it, the pi default of 3 is used.

```text
/retry-count                 # Show the current value, source, and full usage guide
/retry-count 5               # Set the global value to 5
/retry-count 5 global        # Same as above, with an explicit scope
/retry-count 2 project       # Set this trusted project's override to 2
/retry-count 0               # Disable automatic retries globally
```

Running `/retry-count` without arguments is read-only and does not reload. It prints a visible guide in the chat, including the active settings path when the value comes from a settings file:

```text
Pi retry configuration
Current retry.maxRetries: 2
Source: project: /path/to/project/.pi/settings.json

Usage:
  /retry-count                         Show this guide
  /retry-count <count> [global|project]
```

The count is the number of extra retries after the initial request. Changing the value updates pi's own setting, preserves the other settings fields, and reloads pi resources automatically. Because this is the shared pi setting, it controls both pi's built-in retries and this extension's fallback retries.

### Manual retry: `/retry`

Type `/retry` after any error or abort to re-invoke the LLM. The model starts fresh from the last user message — it never sees the failed partial response.

### Manual retry: press Enter

After an error or user-initiated abort (ESC), just press Enter on an empty editor to retry. This is the fastest path for the common "oops, I shouldn't have cancelled" scenario.

This works by intercepting raw terminal input via pi's `onTerminalInput` hook. The Enter keypress is consumed only when all of these are true:

- The editor is empty
- The editor has focus (no modal/selector/overlay is open)
- The agent is idle
- The last response was an error or abort

Otherwise Enter behaves normally — including when a model selector, confirm dialog, session picker, or any other modal UI is displayed.

## Installation

### As a pi package (recommended)

```bash
pi install npm:@georgebashi/pi-retry
```

Or from a local checkout:

```bash
pi install /path/to/pi-retry
```

### For development/testing

```bash
pi -e /path/to/pi-retry/index.ts
```

## Logging

Every retry attempt is logged to `~/.pi/logs/pi-retry.jsonl` with:

- Provider, model, model ID, API type, thinking level
- Stop reason and error message
- Attempt number and delay
- Working directory and session ID

Event types: `retry`, `retry_succeeded`, `retry_exhausted`, `manual_retry`.

## How it works

1. **`agent_end` event** — Checks whether the last assistant error is outside pi's built-in retry and compaction paths. If so, it waits with backoff and sends a hidden `sendMessage` with `triggerTurn: true`.

2. **`context` event** — Always strips historical hidden retry trigger messages before the LLM sees them. The aborted assistant message is already stripped by pi's `transform-messages`.

3. **`onTerminalInput` hook** — Intercepts Enter on empty editor to trigger manual retry. Consumes the keypress so it doesn't reach the editor.

4. **`/retry` command** — Explicit retry for when you want to be deliberate about it.

5. **`turn_end` event** — Resets the retry counter when a successful response comes through.

6. **`/retry-count` command** — Reads or updates pi's `retry.maxRetries`; updates call `ctx.reload()` before returning.
