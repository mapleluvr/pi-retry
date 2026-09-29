# Fast-Retry 实现方案（v6）

> 迭代历史：v1 → reviewer BLOCK（3 HIGH + 3 低）；v2 修正 v1 事实性错误；
> v3 换用"重配置内置重试"机制；v4 修正 v3 的 CRITICAL + 3 HIGH；
> v5 修正 v4 的 3 个 P1 + 1 个 P2；
> **v6 修正 v5 的 3 个 P1（`off` 误删无标记文件、不可信 project 的休眠标记、合并函数 root guard）
> + 2 个 P2（逐键来源、`off` 丢弃期间手工修改）。**

## 1. 目标

Fast-Retry：**固定间隔 T 秒**、**固定 N 次**重试，取代指数退避（2s/4s/8s…）。
覆盖 429 / 503 / timeout / overload / 网络类等**原本由 pi 内置重试负责**的错误。

## 2. 机制：重配置 pi 内置重试（而非关闭它）

### 2.1 pi 的延迟公式可压成常数

`pi-ai/dist/utils/retry.js:81-85`：
```js
export function retryDelayMs(policy, attempt) {
    const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
    const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
    return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}
```

令 `baseDelayMs = maxAgentDelayMs = T*1000`，则 `min(T*1000 * 2^(n-1), T*1000) = T*1000` 对**所有** n ≥ 1 成立。

**已实测**（T=5/30，n=1..5 全部等于 T）。溢出分支安全：`2^(n-1)` 超安全整数时 `safeDelay = MAX_SAFE_INTEGER`，
再 `min(..., T*1000)` 仍为 `T*1000`（`T*1000 ≤ 600000`）。
（边界：等值**负数**不成立，`min(-2000,-1000) = -2000`；T 校验为 1..600，不在该域内。）

→ **pi 内置重试本身变成固定间隔 T。** 再令 `retry.maxRetries = N`，即得"固定 T、N 次"。

### 2.2 为什么优于"关闭内置重试"（v1/v2 方案）

| 维度 | v1/v2：`retry.enabled=false` + 扩展全接管 | **v5：重配置** |
|---|---|---|
| 生效 `enabled` 的作用域问题 | 需保证合并后确实为 false（v1 的 HIGH-1） | **不存在**。`enabled` 保持 true |
| overflow 谓词 | 扩展需复刻 `isContextOverflow`（含 Case 2/3） | 只需 Case 1；Case 2/3 由 pi 用 `model.contextWindow` 自行处理 |
| `stopReason === "length"` | 需显式处理 | 不需要，pi 自行交给 compaction |
| 重试期间 reload | reload 会 `invalidate()` 旧 runner，在飞的 `sendMessage` 抛错 | pi 的 sleep 走 `_retryAbortController`，原生可中止 |
| 摘要重试 | **失效**（副作用） | 不失效，只是同样变成固定 T/N |

### 2.3 【CRITICAL】扩展必须精确复刻 pi 的分类，否则双重试

扩展的 guard 原本是"**兜底减去跳过集**"（`index.ts:300`）：
```ts
if (BUILTIN_RETRY_PATTERNS.test(errorMessage)) return;   // 跳过 pi 负责的
// 否则扩展自己重试（兜底）
```
而 `BUILTIN_RETRY_PATTERNS` 是 pi `RETRYABLE_PROVIDER_ERROR_PATTERN` 的**严格子集**
（**已实测**：扩展 36 token，pi 43 token）。pi 多出的 7 个：

```
currently experiencing high demand
520
exceeded request buffer limit while retrying upstream
getaddrinfo
ENOTFOUND
EAI_AGAIN
stream ended before a terminal response event
```

对落在这 7 个上的错误（如 `getaddrinfo ENOTFOUND api.example.com`）：扩展**不**跳过 → 扩展重试；
pi 的 `_isRetryableError` 为真 → **pi 也重试** → **同一错误消耗两个预算**。
在 v1/v2（内置已关）下不显现；重配置方案下**致命**。

**修正**：跳过判断必须与 pi 的判定**逐字等价**。**入参是 assistant 消息本身**（需读 `provider` 与 `errorMessage`）：

```ts
// pi: _isRetryableError(m) = !isContextOverflow(m, model.contextWindow ?? 0) && isRetryableAssistantError(m)
//     isRetryableAssistantError(m) = m.stopReason==="error" && !!m.errorMessage
//                                    && !LIMIT.test(m.errorMessage) && RETRYABLE.test(m.errorMessage)
function piWillRetry(message: any): boolean {
  if (message.stopReason !== "error") return false;        // pi 只重试 error
  const msg: string = message.errorMessage;
  if (!msg) return false;                                  // pi 要求 errorMessage 为真
  if (NON_RETRYABLE_LIMIT_PATTERNS.test(msg)) return false; // limit 先判
  if (isContextOverflowError(message)) return false;       // pi 在 retry 之前先排除 overflow（Case 1）
  return RETRYABLE_PATTERNS_PI.test(msg);                  // pi 的完整 pattern（含 7 token）
}
```

`RETRYABLE_PATTERNS_PI` 与 `NON_RETRYABLE_LIMIT_PATTERNS` **逐字取自** `pi-ai/dist/utils/retry.js:4-74`。

**顺带修复的既有缺陷**：`index.ts:300` 的跳过**未按 `stopReason` 门控**。
非用户 abort（如 `socket hang up`）目前被扩展跳过，而 pi 因 `stopReason !== "error"` 也不重试
→ **今天就没有任何重试**。`piWillRetry` 的 `stopReason === "error"` 门控一并修掉。

## 3. 权威依据（已逐条对照源码）

### 3.1 内置重试控制流（`dist/core/agent-session.js`）

```
_runAgentPrompt()                                    // :1079
  └─ await this.agent.prompt(messages)               // :1084  agent_end 监听器全部完成后才返回
     while (!this._agentRunAbortRequested) {
       _handlePostAgentRun()                         // :1106
         └─ _isRetryableError(msg) && _prepareRetry(msg)      // :1117
              ├─ if (!settings.enabled) return false          // :2686-2688   ← 真值判定
              ├─ _retryAttempt++                              // :2689
              ├─ if (_retryAttempt > settings.maxRetries) { _retryAttempt--; return false }  // :2690-2694
              ├─ delayMs = retryDelayMs(settings, _retryAttempt)   // :2695
              ├─ _omitRecoveryAttempt(message)                // :2704
              ├─ _retryAbortController = new AbortController()     // :2706
              └─ await sleep(delayMs, _retryAbortController.signal) // :2709  原生可中止
       → agent.continue()
     }
```
`agent_end` 在 `agent.prompt()` 内触发（`pi-agent-core/dist/agent-loop.js:143-149`），
`_prepareRetry` 在 `prompt()` 返回**之后** → 二者严格顺序，**扩展在 `agent_end` 里的 `await` 会阻塞并延后内置重试**。

### 3.2 `getRetrySettings()` 的全部消费者（影响面）

| 消费者 | 位置 |
|---|---|
| agent 回合重试 | `agent-session.js:2695` |
| compaction 摘要 | `:1844` → `compaction.js:509` |
| branch-summary 摘要 | `:2939` → `branch-summarization.js:226` |
| **bug-report 摘要** | `:3182` → `bug-report.js:278` |
| `_willRetryAfterAgentEnd` | `:631-632`（只用 `enabled`/`maxRetries`） |

→ 重配置 `baseDelayMs`/`maxAgentDelayMs`/`maxRetries` 使上述**全部**变为固定 T/N。**不涉及** provider 层
（`provider-retry.js` 用 `retry.provider.*`，`settings-manager.js:646-650`）。

**无写入校验**：`settings-manager.js` 仅有 `setRetryEnabled`（`:609-614`），其余三键无 setter、无范围检查；
`docs/settings.md:108-111` 只列类型与默认值。

### 3.3 错误分类（`pi-ai/dist/utils/retry.js:4-74`）

```js
NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i
RETRYABLE_PROVIDER_ERROR_PATTERN =
  /overloaded|currently experiencing high demand|rate.?limit|too many requests|429|500|502|503|504|520|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|exceeded request buffer limit while retrying upstream|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i

function isRetryableAssistantError(message) {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message.errorMessage) ? false
       : RETRYABLE_PROVIDER_ERROR_PATTERN.test(message.errorMessage);
}
```

`agent-session.js:2634-2638`：
```js
_isRetryableError(message) {
    if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
    return isRetryableAssistantError(message);
}
```

### 3.4 overflow 谓词（`pi-ai/dist/utils/overflow.js:131-171`）

```js
OVERFLOW_PATTERNS = [/prompt (?:is )?too long/i, /request_too_large/i, /input is too long for requested model/i,
  /exceeds the context window/i, /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i, /maximum prompt length is \d+/i, /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i, /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, /exceeds the limit of \d+/i,
  /exceeds the available context size/i, /greater than the context length/i, /context window exceeds limit/i,
  /exceeded model token limit/i, /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i, /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i, /too many tokens/i, /token limit exceeded/i]
CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i
NON_OVERFLOW_PATTERNS = [/^(Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i]
```
实现必须**逐字复制**这些正则（24 + 1 + 3 条），不可用散文描述替代（否则漏掉 z.ai `prompt too long`、
Copilot `exceeds the limit of \d+`、Mistral、Ollama、Qwen 的措辞）。
Cerebras 分支仅在 `message.provider === "cerebras"` 时适用。
`isContextOverflow` 的 Case 2/3 均以 `if (contextWindow && ...)` 开头，故 pi 传 `contextWindow ?? 0`（`0` 为假）
时**只可能命中 Case 1**——这正是扩展侧需要的范围。

### 3.5 扩展上下文能力（`dist/core/extensions/types.d.ts`）

```ts
isIdle(): boolean;                 // :233
isProjectTrusted(): boolean;       // :235
signal: AbortSignal | undefined;   // :237  "The current abort signal, or undefined when the agent is not streaming."
reload(): Promise<void>;           // :291
```
`ctx.signal` 活路径：`agent.signal = activeRun.abortController.signal`（`agent.js:212-217`），
`agent_end` 监听器在 `finishRun` 之前运行（`agent.js:388-416`），ctx getter 即该 signal（`agent-session.js:2449`）。
ESC → `session.abort()` → `agent.abort()`（`interactive-mode.js:2332-2334`、`agent-session.js:1608-1617`）。

### 3.6 reload 语义（`dist/core/agent-session.js:2603-2626`）

```js
async reload(options) {
    const oldRunner = this._extensionRunner;
    await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
    oldRunner.invalidate();                      // ← 先失效旧 runner
    await this.settingsManager.reload();
    await this._resourceLoader.reload();
    this._buildRuntime({...});
    const hasBindings = this._extensionUIContext || this._extensionCommandContextActions ||
                        this._extensionShutdownHandler || this._extensionErrorListener;
    if (hasBindings) {
        await options?.beforeSessionStart?.();
        await this._extensionRunner.emit({ type: "session_start", reason: "reload" });   // ← 重跑 session_start
        await this.extendResourcesFromExtensions("reload");
    }
}
```
TUI 侧 `interactive-mode.js:5151-5158`：`handleReloadCommand` 在 `session.isStreaming` 时**直接 return**（仅警告）。
`isStreaming = _isAgentRunActive`，在整个 post-run 循环（含重试 sleep）期间为 true。
→ 无论 `ctx.reload()` 走哪条路，**都必须在命令层拒绝非 idle 调用**。

### 3.7 `toJsonEvent` 原样透传 `agent_end`（含 `willRetry`）

`dist/modes/json-event.js:16-18`：`if (event.type !== "message_update") return event;`
→ 引用成立，但树内无分支依赖它，**不是控制信号**。

## 4. 设计

### 4.1 配置模型

```jsonc
{
  "retry": {
    "enabled": true,          // 必须为真值，否则见 §4.4
    "maxRetries": 10,         // = N
    "baseDelayMs": 5000,      // = T*1000  ┐ 二者相等 ⇒ 延迟恒为 T
    "maxAgentDelayMs": 5000,  // = T*1000  ┘
    "provider": { },          // 必须原样保留
    "fastRetry": {
      "enabled": true,
      "intervalSec": 5,
      "maxRetries": 10,
      "restore": {            // 按文件记录；null = 该文件原本无这些键
        "global":  { "enabled": true, "maxRetries": 3, "baseDelayMs": 2000, "maxAgentDelayMs": 60000 },
        "project": null
      }
    }
  }
}
```

### 4.2 【修正 P1】`/fast-retry on T N`

```
1. 校验 T ∈ 整数[1,600]、N ∈ 非负整数。失败 → notify(error)，不写盘
2. 若 !ctx.isIdle() → notify(warning) 拒绝（reload 会 invalidate 在飞的 runner）
3. 确定作用域 scope（默认 global；project 需 trusted）
4. 计算 eff = resolveEffectiveRetry(cwd, trusted)（§4.3）
5. 若 !eff.retryEnabled → notify(error) 拒绝：
     "内置重试已被禁用（来源: <source>）；fast 模式依赖内置重试，请先启用"
   （不可走"扩展兜底安装"——那会重新引入 v1/v2 的作用域正确性问题）
6. 【按文件快照】读取 **目标文件** 自身的 retry.fastRetry：
     若该文件尚无 fastRetry 或 fastRetry.enabled !== true
       → restore[scope] = 该文件当前 4 键原值（缺失记 null）
     否则（该文件已处于 fast）
       → 保留其既有 restore[scope]，不覆盖
   ★ 判定用"该文件自身"而非合并值：否则 `on global` 后再 `on project` 会跳过 project 快照，
     导致 `off` 无法还原 project 的覆盖（v4 的 P1）
7. 合并写入目标文件（保留 retry 下其它键，尤其 provider）：
     retry.enabled = true            ← 重复 on 也必须重写（v3 遗漏）
     retry.maxRetries = N
     retry.baseDelayMs = T*1000
     retry.maxAgentDelayMs = T*1000
     retry.fastRetry = { ...该文件既有 fastRetry, enabled:true, intervalSec:T, maxRetries:N, restore }
8. 读回并自校验（**不可链式 ===**）：
     eff2 = resolveEffectiveRetry(cwd, trusted)
     eff2.retryEnabled && eff2.maxRetries === N
       && eff2.baseDelayMs === T*1000 && eff2.maxAgentDelayMs === T*1000
   不符 → 对每个不符的键用 eff2.sourceOf(key) 报出覆盖作用域，notify(warning)
9. notify(生效 T/N 与来源) + await ctx.reload()
```

### 4.2b 【修正 P1】`/fast-retry off` —— 只清理"带标记"的文件

```text
1. 若 !ctx.isIdle() → 拒绝
2. 候选文件 = {global, project} 中 **retry.fastRetry 存在** 的文件
   ★ 关键：无 fastRetry 标记的文件必须**整体跳过**，绝不删除其四键。
     否则 restore[scope] 为 undefined，而 JS 中 `undefined == null` 为真，
     会误删用户自己写在 project 里的 retry.maxRetries / baseDelayMs 等（破坏性）
3. 若候选为空 → 幂等，notify("未启用")，不 reload，返回
4. 对每个候选文件：
     读该文件 retry.fastRetry.restore[scope]
       === null（严格相等）→ 从该文件删除 enabled / maxRetries / baseDelayMs / maxAgentDelayMs 四键
       为对象            → 写回该四键原值
     然后从该文件删除 retry.fastRetry（整体移除标记）
5. notify(已还原) + await ctx.reload()
```
> `off` 只还原**我们自己写过的**四键，不触碰用户其它 `retry.*`（含 `provider`）。
> **不可信 project**：若 project 文件带 `fastRetry` 标记但当前不可信，其 `retry.*` 覆盖在 pi 侧处于休眠状态
> （`settings-manager.js:195-197` 不加载不可信 project）。`off` 仍会清除该标记与四键（清理自身足迹）
> 并在 notify 中提示该处覆盖曾处于休眠状态。

### 4.3 【修正 P1】生效值解析：**递归**复刻 `deepMergeObjects`

`settings-manager.js:16-31`：
```js
function isMergeableObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepMergeObjects(base, overrides) {
    const result = { ...base };
    for (const key of Object.keys(overrides)) {
        const overrideValue = overrides[key];
        if (overrideValue === undefined) continue;          // ← undefined 跳过
        const baseValue = base[key];
        result[key] =
            isMergeableObject(baseValue) && isMergeableObject(overrideValue)
                ? deepMergeObjects(baseValue, overrideValue)   // ← 双侧皆对象才【递归】
                : overrideValue;                              // ← 否则整体替换
    }
    return result;
}
```

**v4 的两处错误**：
1. v4 §4.3 只合并了一层。但 `deepMergeObjects` **递归**——`retry` → `retry.fastRetry` → `retry.fastRetry.restore`
   都会被逐层合并。project 只写 `retry.fastRetry.enabled` 时，global 的 `intervalSec`/`maxRetries`/`restore` 应被保留。
2. v4 用 `typeof o?.enabled === "boolean" ? o.enabled : true`。pi 是 `getRetryEnabled() = retry?.enabled ?? true`，
   随后 `_prepareRetry` 用**真值**判定（`if (!settings.enabled) return false`）。
   **已实测**：`enabled: 0` 或 `enabled: ""` 时 pi **不重试**，而 `typeof` 写法会得出 `true`
   → 扩展误以为 pi 会重试而跳过 → **静默丢弃重试**。

```ts
// 逐字同构于 settings-manager.js:19-31（★ 不添加 root guard，保持与 pi 完全一致）
function deepMergeObjects(base: any, overrides: any): any {
  const result: any = { ...base };                    // 非对象 base 展开为 {}
  for (const key of Object.keys(overrides)) {
    const ov = overrides[key];
    if (ov === undefined) continue;                   // undefined 跳过
    const bv = base?.[key];
    result[key] = isMergeableObject(bv) && isMergeableObject(ov)
      ? deepMergeObjects(bv, ov)                      // 双侧皆对象 → 递归
      : ov;                                           // 否则整体替换
  }
  return result;
}

/** 逐键来源，用于 on 的自校验告警与只读查询展示 */
function keySource(g: any, p: any, key: string): "project" | "global" | "default" {
  // project 的 retry 非对象 → 整体替换，四键均由 project 提供
  if (p !== undefined && !isMergeableObject(p)) return "project";
  if (isMergeableObject(p) && p[key] !== undefined) return "project";
  if (isMergeableObject(g) && g[key] !== undefined) return "global";
  return "default";
}

function resolveEffectiveRetry(cwd: string, projectTrusted: boolean) {
  const gRoot = tryReadSettingsFile(getSettingsPath(cwd, "global"));
  // 缺文件 / 不可信 / 解析失败 → {}（与 pi 一致；pi 对不可信 project 不加载）
  const pRoot = projectTrusted ? tryReadSettingsFile(getSettingsPath(cwd, "project")) : {};
  const settings = deepMergeObjects(gRoot, pRoot);   // 与 pi 同构
  const r = settings?.retry;
  const o = isMergeableObject(r) ? r : undefined;
  const g = gRoot?.retry;
  const p = pRoot?.retry;

  const enabled = o?.enabled ?? true;                // pi: getRetryEnabled() = retry?.enabled ?? true
  return {
    enabled,                                         // 可能是非布尔真值/假值
    retryEnabled: !!enabled,                         // ← 唯一可用于判断的字段（pi 用真值判定）
    maxRetries:      typeof o?.maxRetries      === "number" ? o.maxRetries      : 3,
    baseDelayMs:     typeof o?.baseDelayMs     === "number" ? o.baseDelayMs     : 2000,
    maxAgentDelayMs: typeof o?.maxAgentDelayMs === "number" ? o.maxAgentDelayMs : 60000,
    fastRetry: isMergeableObject(o?.fastRetry) ? o.fastRetry : undefined,
    sourceOf: (key: string) => keySource(g, p, key), // 逐键来源（替代 v5 的粗糙 source）
  };
}
```
> `maxRetries`/`baseDelayMs`/`maxAgentDelayMs` 用 `typeof === "number"`：pi 用 `?? 默认`，
> 对 JSON 中不存在的键与 `null` 均取默认，`typeof` 写法在此**语义一致**（JSON 无 `undefined`）。
> 仅 `enabled` 需特殊处理，因为 pi 后续用真值判定而非 `??`。

`projectTrusted` 在 `session_start` 用 `ctx.isProjectTrusted()` 取一次并缓存（现有代码已在做）。

### 4.4 【修正 P1】`enabled` 不为真时的行为

- **`on` 时**：`!eff.retryEnabled` → **拒绝**（§4.2 步骤 5）。安装期只允许"单一 owner"。
- **运行时**（fast 已开，会话中途被改）：用 `retryEnabled`（真值）判定，**不跳过** pi 集合，
  改为**扩展自己接管**（固定 T + N），并 `notify(warning)`：
  ```ts
  const piOwnsIt = piWillRetry(lastAssistant) && eff.retryEnabled;   // ← 真值，非 typeof
  if (piOwnsIt) return;      // 交给 pi
  ```
  这样 `enabled=false`/`0`/`""` 时错误仍由扩展重试，不会静默丢弃。
  > 两条策略不矛盾：安装期拒绝是"选一个 owner"；运行期接管是"owner 消失后的兜底"。

### 4.5 【修正 P2】overflow 只实现 Case 1

扩展的 `agent_end` 在 `if (stopReason !== "error" && stopReason !== "aborted") return;` 之后才检查 overflow，
**Case 2（`stop`）与 Case 3（`length`）永远不可能触发**——v3 复刻它们是死代码。

v5：`isContextOverflowError(message)` 只实现 Case 1，正则**逐字复制** §3.4 的 `OVERFLOW_PATTERNS`
+ `NON_OVERFLOW_PATTERNS` 排除 + Cerebras 分支（读 `message.provider`）。
**入参是 message 而非 errorMessage**（需要 provider）。
Case 2/3 由 pi 在 `_isRetryableError`/`_checkCompaction` 中用 `model.contextWindow` 处理，扩展不重复实现。

### 4.6 扩展侧的固定间隔与独立预算

```ts
const delayMs = useFast ? fastRetry.intervalSec * 1000
                        : BASE_DELAY_MS * 2 ** (retryAttempt - 1);
const budget  = useFast ? fastRetry.maxRetries : maxRetries;
```
首次重试也等 T 秒（uniform，用户要求）。

### 4.7 可中止的等待

```ts
await new Promise<void>((resolve) => {
  const signal = ctx.signal;
  if (!signal) { setTimeout(resolve, delayMs); return; }   // 降级：类型允许 undefined
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, delayMs);
  signal.addEventListener("abort", done, { once: true });
});
if (ctx.signal?.aborted) { resetRetryState(); ctx.ui.setStatus("pi-retry", undefined); return; }  // 不 triggerRetry
```
`ctx.signal` 已核实存在且为当前 run 的 abort signal（ESC 会 abort 它）。
T 上限 600 秒。若 `signal` 为 `undefined`（类型允许），降级为非可中止等待并记日志。

### 4.8 Guard 顺序（最终）

| # | 条件 | normal | fast |
|---|---|---|---|
| 1 | 用户 ESC abort（`operation aborted`/`request was aborted`） | 早退 | 早退 |
| 2 | `stopReason` 非 error/aborted（含 `stop`/`length`） | 早退 | 早退 |
| 3 | `piWillRetry(message) && eff.retryEnabled` | 早退（交给 pi） | 早退（交给 pi，已重配置为固定 T/N） |
| 4 | `NON_RETRYABLE_LIMIT_PATTERNS` | 早退 | 早退 |
| 5 | `isContextOverflowError(message)`（Case 1） | 早退 | 早退 |
| 6 | 其余 → 扩展重试 | 指数退避，预算 `maxRetries` | 固定 T，预算 `N` |

> `enabled` 为假时行 3 不命中 → 落到行 4/5/6：limit 与 overflow 仍不重试，429/503 由扩展重试。无静默丢弃。

### 4.9 统一状态重置

单一 `resetRetryState()`：`retryAttempt = 0; attemptMode = null;`

| 触发点 | 说明 |
|---|---|
| `session_start` | 现有代码已重置计数器，补 `attemptMode` |
| `turn_end` 成功 | 现有逻辑保留 |
| 预算耗尽 | 现有逻辑保留 |
| 等待期间 abort | v2/v3 遗漏 |
| `/retry`、空 Enter 手动重试 | v2/v3 遗漏（上一轮 sleep 被中止时计数器仍"热"） |
| 模式切换 fast ↔ normal | v3 引入 |

### 4.10 命令规格

```
/fast-retry                 显示生效配置（T/N + 来源）+ 完整用法指南（只读，不 reload）
/fast-retry on <T> <N>      启用；T=整数秒(1..600)，N=非负整数
/fast-retry off             关闭并还原（遍历所有作用域）
```
作用域参数沿用 `/retry-count` 的 `[global|project]` 约定，可后续追加。

### 4.11 状态栏与日志

```
normal: Error "X", retrying (1/3) in 2s…
fast:   Error "X", retrying (1/10) in 5s… [fast]
```
`RetryLogEntry` 新增 `fastRetry?: boolean`、`intervalSec?: number`。

### 4.12 README 必须写明的两个条件

1. **Fast-Retry 通过重配置 pi 的内置重试实现固定间隔**：`/fast-retry on T N` 把
   `retry.baseDelayMs` 与 `retry.maxAgentDelayMs` 同时设为 `T*1000`、`retry.maxRetries` 设为 `N`。
   因 pi 的公式是 `min(baseDelayMs * 2^(n-1), maxAgentDelayMs)`，二者相等时**每次都是 T**
   —— 这就是"不再以 binary 方式增加 wait seconds"的实现。
   `retry.enabled` 必须为**真值**（fast 模式**依赖**内置重试，不是关闭它）；`on` 会拒绝在 `enabled` 为假时启用。
2. **配置必须在生效作用域不被覆盖**：pi 的 settings 是 global 与 trusted project 的**递归深合并**，
   project 同名键优先（project 的 `retry` 若为非对象会**整体替换** global）。
   若 project 另有 `retry.baseDelayMs`/`maxRetries`，会覆盖 fast 配置。
   `/fast-retry` 只读查询显示**生效值及来源**，`on` 之后会自校验并警告未生效的情况。

附带说明（写入 README 的"注意"）：
- `retry.provider.maxRetries` 是**独立**的 provider 层循环（`provider-retry.js`），默认 0，fast 模式不接管，建议保持 0。
- **影响面**：`retry.maxRetries`/`baseDelayMs`/`maxAgentDelayMs` 同时作用于 compaction、branch-summary、
  bug-report 的摘要重试（§3.2）。fast 模式下它们的重试也会变成 `N` 次 × `T` 秒。
  大 `N*T`（如 N=10、T=60 → 600s）会让摘要重试长时间占用，建议保持 `N*T` 在可接受范围。

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `index.ts` | ① `BUILTIN_RETRY_PATTERNS` → 替换为 `RETRYABLE_PATTERNS_PI`（逐字复制 pi）+ `NON_RETRYABLE_LIMIT_PATTERNS`；新增 `piWillRetry(message)`（含 `stopReason==="error"`、`!!errorMessage` 门控，并在 `agent_end` 使用）；② `CONTEXT_OVERFLOW_PATTERNS` → 逐字替换为 pi 的 `OVERFLOW_PATTERNS`，新增 `NON_OVERFLOW_PATTERNS` + Cerebras 分支，`isContextOverflowError(message)` 改收 message；③ 新增 `deepMergeObjects` + `resolveEffectiveRetry`（递归、`retryEnabled` 真值字段）；④ 新增 `resolveFastRetry`（从 `resolveEffectiveRetry().fastRetry` 取，不再单独读文件）；⑤ `session_start` 加载 fast 配置 + 缓存 `projectTrusted`；⑥ `agent_end`：`piWillRetry && retryEnabled` 跳过；fast 分支固定 T + 预算 N + 可中止 sleep + 未生效警告；⑦ `resetRetryState()` 接入 6 个触发点；⑧ `/fast-retry` 命令（只读 / on / off），含 `ctx.isIdle()` 与 `!retryEnabled` 拒绝；⑨ `writeFastRetrySettings`（**合并写入**，保留 `retry.provider` 等其它键；**按文件**快照 restore；`off` 遍历所有作用域还原四键并移除 `fastRetry`）；⑩ 状态栏 `[fast]`；⑪ 日志字段 |
| `index.test.ts` | T 恒定（多 attempt 断言 delay 相同）；独立预算 N；`on` 写入 4 键且 `baseDelayMs === maxAgentDelayMs`；重复 `on` 仍写 `enabled:true`；**`on global` 后 `on project` 再 `off` → 两处均还原**；`off` 对 `restore:null` 执行删除；`retry.provider` 在 `on`/`off` 后保留；`deepMergeObjects` 递归语义（project 只写 `fastRetry.enabled` 时保留 global 的 T/N）；`resolveEffectiveRetry` 对 project `retry:null`/非对象/叶子 `null` 的语义；**`enabled:0` / `enabled:""` 时 `retryEnabled===false` 且扩展接管（不静默丢弃）**；`!retryEnabled` 时 `on` 被拒；7 个 pi-only token 命中 `piWillRetry`（不再双重试）；非用户 abort 且匹配 `socket hang up` 时**仍被重试**（门控修复）；Case 2/3 不进入 overflow 早退；Cerebras 分支仅在 `provider==="cerebras"` 命中；abort 中止 sleep 且不 triggerRetry；非 idle 拒绝 on/off；6 个重置点；只读查询不 reload |
| `README.md` | Fast-Retry 章节；两个条件 + 两条附带说明；命令列表；日志字段；工作原理（含"为何 `baseDelayMs = maxAgentDelayMs` 得常数延迟"与"为何必须精确复刻 pi 分类"） |
| `docs/fast-retry-plan.md` | 本文件 |

## 6. 已核实的既有事实

1. 扩展 `agent_end` 早于 `_omitRecoveryAttempt`（后者在 `_prepareRetry` 内，`:2704`）。
2. `triggerRetry()` **不重发失败消息**：`transformMessages` 跳过 `error`/`aborted`（`transform-messages.js:159-166`），`convertToLlm` 透传 assistant。
3. `triggerRetry()` 在 run 期间只做 `steer()`（`agent-session.js:1494-1497`），不另起 prompt。
4. `session.reload()` 会重跑 `session_start(reason:"reload")`（`:2619-2621`，前提 `hasBindings`）。
5. 扩展 ctx 具备 `isIdle` / `isProjectTrusted` / `signal` / `reload`（`types.d.ts:233-291`）。
6. `toJsonEvent` 原样透传非 `message_update` 事件（`json-event.js:16-18`）。
7. pi 对 `retry.baseDelayMs`/`maxAgentDelayMs`/`maxRetries` **无写入校验、无范围限制**（`settings-manager.js` 仅有 `setRetryEnabled`）。
8. `_isRetryableError` 用 `contextWindow ?? 0`；`isContextOverflow` 的 Case 2/3 均以 `if (contextWindow && ...)` 开头 → 传 `0` 时只可能命中 Case 1。

## 7. 残留风险（已知、可接受）

| 风险 | 说明 |
|---|---|
| 作用域覆盖 | project 同名键优先（递归合并；`retry` 非对象时整体替换）。已用自校验 + 警告缓解；`on` 时 `!retryEnabled` 直接拒绝 |
| `retry.provider.maxRetries > 0` | provider 层会先自行重试 429/5xx。fast 模式不接管。文档建议保持 0 |
| 摘要重试连带变化 | compaction/branch-summary/bug-report 也变为固定 T/N。大 `N*T` 会拉长摘要重试，已在 README 提示 |
| `ctx.signal` 为 undefined | 类型允许。降级为非可中止等待 + 记日志（活路径在 `agent_end` 期间必然有值） |
| 扩展侧集合比 pi 宽 | 非用户 abort（pi 不重试）由扩展重试。符合既有设计意图，且修掉了 `index.ts:300` 未门控的既有缺陷 |
| `enabled` 为非布尔假值（`0`/`""`） | 已按 pi 真值语义对齐；`on` 拒绝、运行期由扩展接管 |
| `off` 覆盖期间的手工修改 | 若用户在 fast 开启期间手改 `maxRetries`/`baseDelayMs`/`maxAgentDelayMs`/`enabled`，`off` 会按快照还原到 `on` 之前的值，丢弃该修改。属快照契约的必然结果 |
| 不可信 project 的休眠覆盖 | 若 project 带 `fastRetry` 标记但当前不可信，其 `retry.*` 在 pi 侧休眠；`off` 仍会清除该标记与四键（清理自身足迹）并提示 |
