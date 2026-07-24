import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface MockCommand {
  handler: (args: string, ctx: any) => Promise<void>;
}

interface MockRuntime {
  commands: Map<string, MockCommand>;
  handlers: Map<string, Array<(event: any, ctx: any) => Promise<unknown>>>;
  notifications: Array<{ message: string; level: string }>;
  sentMessages: unknown[];
  pi: any;
}

mock.module("@mariozechner/pi-tui", () => ({
  matchesKey: (data: string, key: string) => data === key,
}));

const originalUserProfile = process.env.USERPROFILE;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempEnvironment(): { homeDir: string; agentDir: string; cwd: string } {
  const homeDir = join(tmpdir(), `pi-retry-${process.pid}-${Date.now()}-${tempDirs.length}`);
  const agentDir = join(homeDir, ".pi", "agent");
  const cwd = join(homeDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  tempDirs.push(homeDir);
  process.env.USERPROFILE = homeDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { homeDir, agentDir, cwd };
}

async function loadExtension() {
  return (await import("./index.ts")).default;
}

function createRuntime(): MockRuntime {
  const commands = new Map<string, MockCommand>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown>>>();
  const notifications: Array<{ message: string; level: string }> = [];
  const sentMessages: unknown[] = [];

  const pi = {
    getThinkingLevel: () => "off",
    on(name: string, handler: (event: any, ctx: any) => Promise<unknown>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: MockCommand) {
      commands.set(name, command);
    },
    sendMessage(message: unknown) {
      sentMessages.push(message);
    },
  };

  return { commands, handlers, notifications, sentMessages, pi };
}

function createContext(runtime: MockRuntime, cwd: string, projectTrusted = true) {
  let reloadCount = 0;
  const ctx = {
    cwd,
    getContextUsage: () => undefined,
    isIdle: () => true,
    isProjectTrusted: () => projectTrusted,
    model: undefined,
    reload: async () => {
      reloadCount++;
    },
    sessionManager: {
      getSessionId: () => "test-session",
    },
    ui: {
      getEditorText: () => "",
      notify(message: string, level: string) {
        runtime.notifications.push({ message, level });
      },
      onTerminalInput: () => undefined,
      setStatus: () => undefined,
      setWidget(_id: string, widget: unknown) {
        if (typeof widget === "function") {
          widget({ focusedComponent: null });
        }
      },
    },
  };

  return {
    ctx,
    getReloadCount: () => reloadCount,
  };
}

function writeSettings(path: string, settings: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function assistantError(errorMessage: string) {
  return {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage,
  };
}

async function emit(runtime: MockRuntime, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of runtime.handlers.get(name) ?? []) {
    await handler(event, ctx);
  }
}

describe("Pi retry settings", () => {
  test("uses Pi retry.maxRetries for fallback errors", async () => {
    const { agentDir, cwd } = createTempEnvironment();
    writeSettings(join(agentDir, "settings.json"), {
      retry: { maxRetries: 1 },
    });

    const runtime = createRuntime();
    const piRetry = await loadExtension();
    piRetry(runtime.pi);
    const { ctx } = createContext(runtime, cwd);
    await emit(runtime, "session_start", { reason: "startup" }, ctx);

    const message = assistantError("stream_read_error");
    await emit(runtime, "agent_end", { messages: [message] }, ctx);

    const retryTrigger = {
      role: "custom",
      customType: "__retry_trigger",
      content: "Retrying.",
    };
    const contextHandler = runtime.handlers.get("context")?.[0];
    expect(contextHandler).toBeDefined();
    const firstCleanup = await contextHandler!({ messages: [retryTrigger] }, ctx);
    const laterCleanup = await contextHandler!({ messages: [retryTrigger] }, ctx);
    expect(firstCleanup).toEqual({ messages: [] });
    expect(laterCleanup).toEqual({ messages: [] });

    await emit(runtime, "agent_end", { messages: [message] }, ctx);
    expect(runtime.sentMessages).toHaveLength(1);
  }, 10_000);

  test("uses a trusted project retry.maxRetries override", async () => {
    const { agentDir, cwd } = createTempEnvironment();
    writeSettings(join(agentDir, "settings.json"), {
      retry: { maxRetries: 3 },
    });
    writeSettings(join(cwd, ".pi", "settings.json"), {
      retry: { maxRetries: 0 },
    });

    const runtime = createRuntime();
    const piRetry = await loadExtension();
    piRetry(runtime.pi);
    const { ctx } = createContext(runtime, cwd, true);
    await emit(runtime, "session_start", { reason: "startup" }, ctx);
    await emit(
      runtime,
      "agent_end",
      { messages: [assistantError("upstream aborted unexpectedly")] },
      ctx,
    );

    expect(runtime.sentMessages).toHaveLength(0);
  }, 5_000);

  test("retry-count updates global settings, preserves fields, and reloads", async () => {
    const { agentDir, cwd } = createTempEnvironment();
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, {
      theme: "dark",
      retry: {
        enabled: true,
        maxRetries: 3,
        provider: { maxRetries: 0 },
      },
    });

    const runtime = createRuntime();
    const piRetry = await loadExtension();
    piRetry(runtime.pi);
    const command = runtime.commands.get("retry-count");
    expect(command).toBeDefined();

    const context = createContext(runtime, cwd);
    await command!.handler("7", context.ctx);

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "dark",
      retry: {
        enabled: true,
        maxRetries: 7,
        provider: { maxRetries: 0 },
      },
    });
    expect(context.getReloadCount()).toBe(1);
  });

  test("retry-count reports the effective value without reloading", async () => {
    const { agentDir, cwd } = createTempEnvironment();
    writeSettings(join(agentDir, "settings.json"), {
      retry: { maxRetries: 3 },
    });
    writeSettings(join(cwd, ".pi", "settings.json"), {
      retry: { maxRetries: 6 },
    });

    const runtime = createRuntime();
    const piRetry = await loadExtension();
    piRetry(runtime.pi);
    const command = runtime.commands.get("retry-count");
    expect(command).toBeDefined();

    const context = createContext(runtime, cwd, true);
    await command!.handler("", context.ctx);

    const notification = runtime.notifications.at(-1);
    expect(notification?.level).toBe("warning");
    expect(notification?.message).toContain("Current retry.maxRetries: 6");
    expect(notification?.message).toContain("Source: project");
    expect(notification?.message).toContain(join(cwd, ".pi", "settings.json"));
    expect(notification?.message).toContain(
      "/retry-count <count> [global|project]",
    );
    expect(notification?.message).toContain("/retry-count 5 project");
    expect(notification?.message).toContain("extra retries");
    expect(context.getReloadCount()).toBe(0);
  });

  test("retry-count can write a trusted project override", async () => {
    const { agentDir, cwd } = createTempEnvironment();
    writeSettings(join(agentDir, "settings.json"), {
      retry: { maxRetries: 3 },
    });

    const runtime = createRuntime();
    const piRetry = await loadExtension();
    piRetry(runtime.pi);
    const command = runtime.commands.get("retry-count");
    expect(command).toBeDefined();

    const context = createContext(runtime, cwd, true);
    await command!.handler("5 project", context.ctx);

    const projectSettingsPath = join(cwd, ".pi", "settings.json");
    expect(existsSync(projectSettingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(projectSettingsPath, "utf8"))).toEqual({
      retry: { maxRetries: 5 },
    });
    expect(context.getReloadCount()).toBe(1);
  });

  test("leaves built-in retry errors and context overflow to Pi", async () => {
    const { agentDir, cwd } = createTempEnvironment();
    writeSettings(join(agentDir, "settings.json"), {
      retry: { maxRetries: 1 },
    });

    const runtime = createRuntime();
    const piRetry = await loadExtension();
    piRetry(runtime.pi);
    const { ctx } = createContext(runtime, cwd);
    await emit(runtime, "session_start", { reason: "startup" }, ctx);

    await emit(
      runtime,
      "agent_end",
      { messages: [assistantError("Connection error.")] },
      ctx,
    );
    await emit(
      runtime,
      "agent_end",
      { messages: [assistantError("maximum context length is 128000 tokens")] },
      ctx,
    );

    expect(runtime.sentMessages).toHaveLength(0);
  });

  test("retry-count rejects invalid values without writing or reloading", async () => {
    const { agentDir, cwd } = createTempEnvironment();
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, {
      retry: { maxRetries: 3 },
    });
    const original = readFileSync(settingsPath, "utf8");

    const runtime = createRuntime();
    const piRetry = await loadExtension();
    piRetry(runtime.pi);
    const command = runtime.commands.get("retry-count");
    expect(command).toBeDefined();

    const context = createContext(runtime, cwd);
    await command!.handler("-1", context.ctx);

    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(context.getReloadCount()).toBe(0);
    expect(runtime.notifications.at(-1)?.level).toBe("error");
  });
});
