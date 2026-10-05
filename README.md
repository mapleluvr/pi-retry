![pi-retry](assets/pi-retry-title.png)

<div align="center">

*One extensions that help retries requests in more conditions.*

<img src="https://img.shields.io/badge/version-0.1.1-EB0404?labelColor=181818" alt="Version: 0.1.1">
<img src="https://img.shields.io/badge/type-Pi%20extension-181818" alt="type: Pi extension">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-FDFDFD?labelColor=181818" alt="License: MIT"></a>

<br>
<br>

<a href="#quick-start">Quick Start</a> ｜
<a href="#core-idea">Core Idea</a> ｜
<a href="#features">Features</a> ｜
<a href="#logging">Logging</a> ｜
<a href="#project-structure">Structure</a> ｜
<a href="#support-and-boundaries">Boundaries</a>

</div>

---

A [pi](https://github.com/badlogic/pi) extension that retries failed LLM responses automatically, manually via `/retry`, or by pressing Enter — with an optional fixed-interval mode.

## Core Idea

Keep the extension's fallback path distinct from Pi's built-in retry and compaction paths.

| Failure or action | Owner / behavior |
| --- | --- |
| Built-in retryable error | Pi handles it; the fallback does not consume a second budget |
| Unclassified assistant error | The extension retries within the configured fallback budget |
| Context overflow | Pi's compaction recovery |
| User abort | No automatic retry; use `/retry` or Enter |
| Quota or billing error | Not retried by either side |

> [!IMPORTANT]
> Retry settings affect real provider requests. Fast-Retry also affects Pi's summarization retries. Check the effective scope and budget before enabling it.

## Quick Start

<a id="installation"></a>

### 1. Load this checkout

The package metadata still names `@georgebashi/pi-retry` and the upstream
`georgebashi/pi-retry` repository. To use the implementation documented in this
checkout, install its local path:

```bash
pi install /path/to/pi-retry
```

Review the extension before loading it and reopen Pi after installation.

### Upstream npm package

The original upstream installation command is:

```bash
pi install npm:@georgebashi/pi-retry
```

That command selects the upstream npm release, not this checkout. Do not assume
it contains this fork's retry-count and Fast-Retry changes.

### For development/testing

```bash
pi -e /path/to/pi-retry/index.ts
```

### 2. Inspect settings before changing them

In Pi, these commands show the current configuration without changing the retry mode:

```text
/retry-count
/fast-retry
```

After an error or abort, use `/retry` for an explicit retry. To enable a fixed interval,
see [Fast-Retry](#fast-retry-fixed-interval-retries) and its two preconditions below.

## Features

### Auto-retry fallback errors

When an assistant response ends with an error that pi's built-in retry does not recognize, the extension retries it regardless of the error message. This covers bare or provider-specific errors such as `stream_read_error` without maintaining an allowlist.

- **Delays:** Exponential backoff starting at 2s (2s, 4s, 8s, ...)
- **Max attempts:** The effective pi `retry.maxRetries` value (default: 3)
- **No history pollution:** The failed response is invisible to the model (pi's `transform-messages` strips aborted/errored assistant messages). The retry trigger uses `display: false` so it is hidden in the TUI.

Errors already covered by pi's built-in retry (overload, rate limits, connection errors, 5xx responses, and similar failures) stay with pi so the two retry budgets do not stack. Context overflow stays with pi's compaction recovery. User-initiated aborts (ESC) are never auto-retried; use `/retry` or Enter for those.

To decide what "covered by pi" means, the extension mirrors pi's own error classifier **token for token** rather than keeping a looser allowlist. This matters: if the skip set were narrower than pi's, a single error (for example `getaddrinfo ENOTFOUND`) would be retried by *both* pi and this extension, consuming both budgets for one failure. Quota and billing errors are never retried by either side.

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

### Fast-Retry: fixed-interval retries

By default retries use exponential backoff (2s, 4s, 8s, …). Fast-Retry replaces that with a **fixed interval**: retry every T seconds, up to N times.

```text
/fast-retry                  # Show status, effective values, and the full guide
/fast-retry on 5 10          # Retry every 5s, up to 10 times
/fast-retry off              # Restore the normal exponential backoff
```

`T` is a whole number of seconds (1–600). `N` is an **independent** retry budget (a non-negative integer) — it does not reuse `retry.maxRetries`. The first retry also waits the full T seconds. The setting persists in `~/.pi/agent/settings.json`.

Fast-Retry covers the same errors as pi's built-in retry — 429, 503, timeouts, overload, and network failures — because it **reconfigures** that retry instead of replacing it.

#### Two conditions

**1. `retry.enabled` must be truthy.** Fast-Retry works by reconfiguring pi's built-in retry, not by disabling it. `/fast-retry on 5 10` writes:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 10,
    "baseDelayMs": 5000,
    "maxAgentDelayMs": 5000
  }
}
```

pi computes `min(baseDelayMs * 2^(attempt-1), maxAgentDelayMs)`. With the base equal to the cap, every attempt waits exactly T seconds — that is how the binary growth is removed. Because Fast-Retry *depends* on pi's retry loop, `/fast-retry on` is **refused** while `retry.enabled` is falsy (`false`, `0`, or `""`); enable retries first (e.g. `/retry-count 3`).

**2. Nothing may override those keys in the effective scope.** pi deep-merges the global settings file with a trusted project's `.pi/settings.json`, and the project wins on conflicting keys. If the project file also sets `retry.baseDelayMs`, `retry.maxAgentDelayMs`, or `retry.maxRetries`, your Fast-Retry values are overridden. Running `/fast-retry` with no arguments prints the **effective** values and, for each one, which scope supplied it:

```text
Effective: maxRetries=5 (global), baseDelayMs=5000 (global), maxAgentDelayMs=5000 (global), enabled=true (global)
```

`/fast-retry on` re-reads the merged result afterwards and warns if a scope defeated the new configuration; a running session also warns once if the effective config stops matching.

#### Notes

- `retry.provider.maxRetries` is a **separate**, provider-level retry loop that runs below pi's agent retry. Fast-Retry does not touch it; leaving it at `0` is recommended.
- The `retry.maxRetries` / `baseDelayMs` / `maxAgentDelayMs` keys are shared with pi's **summarization** retries (compaction, branch summaries, bug reports). Fast-Retry therefore applies to those too: in Fast-Retry mode a summary retry waits T seconds and gets N attempts. Keep `N × T` reasonable — `N=10, T=60` lets a summary retry occupy up to 10 minutes.
- `/fast-retry off` restores those keys from a snapshot taken when Fast-Retry was enabled, and removes its marker. It only touches files carrying that marker, so your own `retry.*` values are never disturbed. If you edited those four keys by hand *while* Fast-Retry was on, `off` restores the pre-`on` values and discards your edit.
- `/fast-retry on` and `/fast-retry off` reload pi resources, so both are refused while the agent is running.

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

## Logging

Every retry attempt is logged to `~/.pi/logs/pi-retry.jsonl` with:

- Provider, model, model ID, API type, thinking level
- Stop reason and error message
- Attempt number and delay
- Working directory and session ID

Event types: `retry`, `retry_succeeded`, `retry_exhausted`, `manual_retry`. Retry entries also carry `fastRetry` and, in Fast-Retry mode, `intervalSec`.

## How it works

1. **`agent_end` event** — Checks whether the last assistant error is outside pi's built-in retry and compaction paths. If so, it waits (exponential backoff, or a fixed T seconds in Fast-Retry mode) and sends a hidden `sendMessage` with `triggerTurn: true`.

2. **`context` event** — Always strips historical hidden retry trigger messages before the LLM sees them. The aborted assistant message is already stripped by pi's `transform-messages`.

3. **`onTerminalInput` hook** — Intercepts Enter on empty editor to trigger manual retry. Consumes the keypress so it doesn't reach the editor.

4. **`/retry` command** — Explicit retry for when you want to be deliberate about it.

5. **`turn_end` event** — Resets the retry counter when a successful response comes through.

6. **`/retry-count` command** — Reads or updates pi's `retry.maxRetries`; updates call `ctx.reload()` before returning.

7. **`/fast-retry` command** — Enables fixed-interval retries by reconfiguring pi's `retry.baseDelayMs`, `retry.maxAgentDelayMs`, and `retry.maxRetries`; `off` restores the pre-`on` snapshot. See the two conditions above.

## Project Structure

```text
pi-retry/
├── index.ts                 # Retry policy, commands, settings and logging
├── index.test.ts            # Bun regression tests
├── docs/fast-retry-plan.md   # Fixed-interval design and compatibility notes
├── LICENSE
└── assets/                  # README title artwork
```

## Support and Boundaries

- This extension depends on Pi's retry classifier, settings semantics and extension hooks; review those contracts when updating Pi.
- Empty-editor Enter retry requires terminal focus, an idle agent and a last response that failed or was aborted.
- Trusted project settings can override global retry keys; the status commands report the effective values and source.
- Fast-Retry does not reconfigure `retry.provider.maxRetries`, the separate provider-level loop.
- The npm package metadata retains the upstream identity; use this checkout to evaluate its documented changes.

## Design and Development

The [Fast-Retry design](docs/fast-retry-plan.md) records the mechanism and compatibility assumptions.

With Bun available, run the repository test command:

```bash
npm test
```

`npm test` invokes `bun test`; this package defines no build or typecheck script.
Tests are not proof of live provider availability or successful application-level work.

## License

[MIT](LICENSE). Upstream package attribution remains George Bashi; this README does not change package ownership.

---

<div align="center">

**Retry deliberately. Inspect the effective budget.**

</div>
