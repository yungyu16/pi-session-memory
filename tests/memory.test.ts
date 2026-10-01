import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createExtensionRuntime,
  discoverAndLoadExtensions,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import memory from "../src/index.ts";
import { transcript } from "../src/lib/runtime/session.ts";
import {
  atomicWrite,
  readSnapshot,
  readRaw,
  readRetry,
  registerCandidate,
} from "../src/lib/foundation/storage.ts";
import {
  parseExtraction,
  parseConsolidation,
  redact,
} from "../src/lib/foundation/model.ts";
import { acquireLock } from "../src/lib/foundation/lock.ts";
import { formatMemoryModelFailure } from "../src/lib/runtime/model.ts";
import { searchMemory } from "../src/read.ts";
import {
  LIMITS,
  runPipeline,
  selectPending,
  type ModelCall,
} from "../src/write.ts";

const now = Date.now();
const raw = {
  raw_memory: "已核对：修改 ConfigProject 配置源文件，生成文件会被覆盖。",
  rollout_summary: "配置不生效的根因是改了生成文件，证据为 setup_config。",
};
const consolidated = {
  memory:
    "## 配置源文件\n范围：ConfigProject。修改源文件，生成文件会被覆盖。\n来源 session-a：rollout_summaries/session-a.md",
  summary: "ConfigProject：配置源文件，详情搜索 MEMORY.md。",
};
async function temp(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-session-memory-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function candidate(root: string, id = "session-a", hours = 7) {
  const path = join(root, `${id}.jsonl`);
  await writeFile(path, "不可改写的原始证据");
  await utimes(
    path,
    new Date(now - hours * 3_600_000),
    new Date(now - hours * 3_600_000),
  );
  await registerCandidate(root, { id, path, cwd: "/ConfigProject" });
  return path;
}
function pipeline(root: string, call: ModelCall, overrides = {}) {
  return runPipeline({
    root,
    activeId: "active",
    now,
    signal: new AbortController().signal,
    readSession: async () => "user: 配置不生效\nassistant: 已核对源文件",
    status() {},
    call,
    ...overrides,
  });
}
const standard: ModelCall = async (system) =>
  JSON.stringify(system.includes("记忆提取器") ? raw : consolidated);

test("记忆：两阶段启动整理，发布完整 Markdown 和来源，原始会话不变", async (t) => {
  const root = await temp(t);
  const path = await candidate(root);
  const calls: string[] = [];
  await pipeline(root, async (system, input) => {
    calls.push(system);
    assert.ok(input.includes("/ConfigProject"));
    return standard(system, input, new AbortController().signal);
  });
  assert.equal(calls.length, 2);
  assert.equal((await readRaw(root))[0].raw_memory, raw.raw_memory);
  assert.deepEqual((await readSnapshot(root)).sources, {
    "session-a": (await readRaw(root))[0].fingerprint,
  });
  assert.equal(
    await readFile(join(root, "current", "MEMORY.md"), "utf8"),
    consolidated.memory,
  );
  assert.ok(
    (
      await readFile(
        join(root, "current", "rollout_summaries", "session-a.md"),
        "utf8",
      )
    ).includes(path),
  );
  assert.equal(await readFile(path, "utf8"), "不可改写的原始证据");
  await pipeline(root, async () => {
    throw new Error("重复启动不应重新调用模型");
  });
});

test("记忆：当前与刚修改的会话跳过；长期积压按等待顺序处理，每次最多两个", async (t) => {
  const root = await temp(t);
  await candidate(root, "active", 7);
  await candidate(root, "fresh", 0.1);
  await pipeline(root, async () => assert.fail("不应提取当前或刚修改的来源"));
  assert.equal((await readRaw(root)).length, 0);
  await candidate(root, "session-a", 7);
  await candidate(root, "session-b", 8);
  await candidate(root, "session-c", 9);
  await candidate(root, "old", 24 * 31);
  await pipeline(root, async (system, input) => {
    if (system.includes("记忆提取器")) return JSON.stringify(raw);
    const records = JSON.parse(input).records as { id: string }[];
    return JSON.stringify({
      memory: records
        .map(({ id }) => `## ${id}\n来源 rollout_summaries/${id}.md`)
        .join("\n"),
      summary: "已处理最早的积压会话",
    });
  });
  assert.deepEqual((await readRaw(root)).map((row) => row.id).sort(), [
    "old",
    "session-c",
  ]);
  assert.equal((await readRaw(root)).length, LIMITS.perRun);
});

test("记忆：低收益空输出有检查点，不归并、不重复收费", async (t) => {
  const root = await temp(t);
  await candidate(root);
  let calls = 0;
  await pipeline(root, async () => {
    calls++;
    return JSON.stringify({ raw_memory: "", rollout_summary: "" });
  });
  await pipeline(root, async () => {
    calls++;
    throw new Error("不应重跑");
  });
  assert.equal(calls, 1);
  assert.equal((await readSnapshot(root)).memory, "");
});

test("记忆：提取失败一小时退避，成功后可继续", async (t) => {
  const root = await temp(t);
  await candidate(root);
  let calls = 0;
  await pipeline(root, async () => {
    calls++;
    throw new Error("模型不可用");
  });
  await pipeline(root, async () => {
    calls++;
    throw new Error("不能在退避期间重跑");
  });
  assert.equal(calls, 1);
  assert.ok((await readRaw(root))[0].retryAt! > now);
  await pipeline(root, standard, { now: now + LIMITS.retryMs + 1 });
  assert.equal((await readSnapshot(root)).memory, consolidated.memory);
});

test("记忆：归并失败保留阶段一成果和旧快照，下次只重跑归并", async (t) => {
  const root = await temp(t);
  await candidate(root);
  await assert.rejects(
    pipeline(root, async (system) => {
      if (system.includes("记忆提取器")) return JSON.stringify(raw);
      throw new Error("归并失败");
    }),
    /归并失败/,
  );
  assert.equal((await readRaw(root)).length, 1);
  assert.equal((await readSnapshot(root)).memory, "");
  assert.equal((await readRetry(root))?.error, "Error: 归并失败");
  let calls = 0;
  await pipeline(root, async () => {
    calls++;
    return JSON.stringify(consolidated);
  });
  assert.equal(calls, 0);
  await pipeline(
    root,
    async (system) => {
      calls++;
      assert.ok(system.includes("归并器"));
      return JSON.stringify(consolidated);
    },
    { now: now + LIMITS.retryMs + 1 },
  );
  assert.equal(calls, 1);
});

test("记忆：更新历史会话后重新提取，同主题完整替换，不追加重复副本", async (t) => {
  const root = await temp(t);
  const path = await candidate(root);
  await pipeline(root, standard);
  await writeFile(path, "追加了已核验的新结论");
  await utimes(
    path,
    new Date(now - 6.5 * 3_600_000),
    new Date(now - 6.5 * 3_600_000),
  );
  const updated = {
    ...consolidated,
    memory: consolidated.memory.replace("修改源文件", "修改新的源文件"),
  };
  await pipeline(root, async (system, input) => {
    if (system.includes("归并器")) {
      assert.ok(input.includes(consolidated.memory.split("\n")[0]));
      return JSON.stringify(updated);
    }
    return JSON.stringify(raw);
  });
  assert.equal((await readRaw(root)).length, 1);
  assert.equal((await readSnapshot(root)).memory, updated.memory);
  assert.equal((await readdir(join(root, "generations"))).length, 2);
});

test("记忆：取证期间被恢复的历史不落旧快照，取消不发布且释放锁", async (t) => {
  const root = await temp(t);
  const path = await candidate(root);
  await pipeline(root, async () => {
    await writeFile(path, "正在继续的会话");
    return JSON.stringify(raw);
  });
  assert.equal((await readRaw(root)).length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pipeline(root, standard, { signal: controller.signal }));
  const release = await acquireLock(root);
  assert.ok(release);
  await release();
});

test("记忆：单进程锁不抢占，失效进程锁恢复", async (t) => {
  const root = await temp(t);
  const release = await acquireLock(root);
  assert.ok(release);
  assert.equal(await acquireLock(root), undefined);
  await release();
  await mkdir(join(root, ".pipeline-lock"));
  await atomicWrite(
    join(root, ".pipeline-lock", "owner.json"),
    JSON.stringify({ pid: 2_000_000_000 }),
  );
  const recovered = await acquireLock(root);
  assert.ok(recovered);
  await recovered();

  await mkdir(join(root, ".pipeline-lock"));
  assert.equal(await acquireLock(root), undefined);
  await rm(join(root, ".pipeline-lock"), { recursive: true });

  await mkdir(join(root, ".pipeline-lock"));
  await writeFile(join(root, ".pipeline-lock", "owner.json"), "损坏 JSON");
  assert.equal(await acquireLock(root), undefined);
  const staleOwner = new Date(Date.now() - 121_000);
  await utimes(join(root, ".pipeline-lock"), staleOwner, staleOwner);
  const recoveredCorruptOwner = await acquireLock(root);
  assert.ok(recoveredCorruptOwner);
  await recoveredCorruptOwner();

  await mkdir(join(root, ".pipeline-lock"));
  await mkdir(join(root, ".lock-recovery"));
  const stale = new Date(Date.now() - 121_000);
  await utimes(join(root, ".pipeline-lock"), stale, stale);
  await utimes(join(root, ".lock-recovery"), stale, stale);
  const recoveredIncomplete = await acquireLock(root);
  assert.ok(recoveredIncomplete);
  await recoveredIncomplete();
});

test("记忆：单个损坏状态文件不阻塞其他会话", async (t) => {
  const root = await temp(t);
  await mkdir(join(root, "candidates"), { recursive: true });
  await mkdir(join(root, "stage1"), { recursive: true });
  await writeFile(join(root, "candidates", "broken.json"), "损坏 JSON");
  await writeFile(join(root, "stage1", "broken.json"), "损坏 JSON");
  await writeFile(join(root, "phase2-retry.json"), "损坏 JSON");
  await candidate(root);
  await pipeline(root, standard);
  assert.equal((await readSnapshot(root)).memory, consolidated.memory);
  assert.equal(await readFile(join(root, "candidates", "broken.json"), "utf8"), "损坏 JSON");
  assert.equal(await readFile(join(root, "stage1", "broken.json"), "utf8"), "损坏 JSON");
  await assert.rejects(readFile(join(root, "phase2-retry.json"), "utf8"), {
    code: "ENOENT",
  });
});

test("记忆：关键词检索不写状态；归并只处理变化，按等待顺序选取", async (t) => {
  const root = await temp(t);
  await candidate(root);
  await pipeline(root, standard);
  const rows = await readRaw(root);
  assert.ok(searchMemory(consolidated.memory, "配置被覆盖").includes("session-a"));
  assert.deepEqual(await readRaw(root), rows);
  const pending = { ...rows[0], id: "pending", generated: now - 90 * 86_400_000 };
  const changed = { ...rows[0], fingerprint: "changed" };
  const sources = (await readSnapshot(root)).sources;
  assert.deepEqual(
    selectPending([rows[0], changed, pending], sources).map((row) => row.id),
    ["pending", "session-a"],
  );
  const backlog = Array.from({ length: 300 }, (_, i) => ({
    ...pending,
    id: `source-${i}`,
  }));
  assert.equal(selectPending(backlog, {}).length, 300);
});

test("记忆：格式、预算和常见凭据边界", () => {
  assert.deepEqual(
    parseExtraction(JSON.stringify({ raw_memory: "", rollout_summary: "" })),
    { raw_memory: "", rollout_summary: "" },
  );
  assert.throws(() =>
    parseExtraction(
      JSON.stringify({ raw_memory: "非空", rollout_summary: "" }),
    ),
  );
  assert.deepEqual(
    parseConsolidation(JSON.stringify(consolidated)),
    consolidated,
  );
  assert.equal(
    formatMemoryModelFailure({
      phase: "归并",
      model: "ep/gpt-5.6-sol",
      stopReason: "length",
      inputChars: 64000,
      outputChars: 16384,
      maxTokens: 16384,
      timeoutMs: 600_000,
    }),
    "记忆模型请求未成功完成（阶段=归并，模型=ep/gpt-5.6-sol，stopReason=length，输入=64000字符，输出=16384字符，上限=16384 tokens，超时=600000ms）",
  );
  assert.throws(() =>
    parseConsolidation(JSON.stringify({ memory: "", summary: " \n " })),
  );
  assert.equal(
    redact("token=secret123 password=hunter2"),
    "token=[已脱敏] password=[已脱敏]",
  );
  const messages: AgentMessage[] = [
    { role: "user", content: "问题 token=secret123", timestamp: 0 },
    {
      ...response("已核验"),
      content: [
        { type: "thinking", thinking: "隐藏推理" },
        { type: "text", text: "已核验" },
      ],
    },
  ];
  const text = transcript(messages);
  assert.ok(
    text.includes("已核验") &&
      !text.includes("secret123") &&
      !text.includes("隐藏推理"),
  );
  assert.ok(
    transcript(
      [{ role: "user", content: "字".repeat(9000), timestamp: 0 }],
      1000,
    ).includes("预算截断"),
  );
});

test("记忆：长期不检索或原始文件消失，不自动删除已确认的知识和证据", async (t) => {
  const root = await temp(t);
  const path = await candidate(root);
  await pipeline(root, standard);
  const checkpoint = await readSnapshot(root);
  await pipeline(root, async () => assert.fail("来源未变化，不应重复付费"), {
    now: now + 90 * 86_400_000,
  });
  assert.equal((await readRaw(root)).length, 1);
  assert.deepEqual(await readSnapshot(root), checkpoint);
  await rm(path);
  await pipeline(root, async () => assert.fail("缺少原始文件不代表旧知识失效"));
  assert.deepEqual(await readSnapshot(root), checkpoint);
  assert.ok(
    (await readFile(
      join(root, "current", "rollout_summaries", "session-a.md"),
      "utf8",
    )).includes(raw.rollout_summary),
  );
});

test("记忆：预算只约束增量，旧知识与来源保留，下一轮继续积压", async (t) => {
  const root = await temp(t);
  await candidate(root);
  await pipeline(root, standard);
  const before = await readSnapshot(root);
  const oldSummary = await readFile(
    join(root, "current", "rollout_summaries", "session-a.md"),
    "utf8",
  );
  const b = await candidate(root, "session-b", 8);
  await candidate(root, "session-c", 9);
  const budget = JSON.stringify({
    previous: before.memory,
    currentSummary: before.summary,
    existingSources: ["session-a"],
    records: [{ id: "session-b", cwd: "/ConfigProject", path: b, ...raw }],
  }).length;
  const merge = (input: string) => {
    const data = JSON.parse(input) as {
      previous: string;
      existingSources: string[];
      records: { id: string }[];
    };
    assert.ok(data.existingSources.includes("session-a"));
    assert.equal(data.records.length, 1);
    assert.ok(!("removedSources" in data));
    return JSON.stringify({
      memory: data.previous + data.records
        .map(({ id }) => `\n## ${id}\n来源 rollout_summaries/${id}.md`)
        .join(""),
      summary: consolidated.summary,
    });
  };
  await pipeline(
    root,
    async (system, input) => system.includes("记忆提取器")
      ? JSON.stringify(raw)
      : merge(input),
    { inputBudget: budget },
  );
  const partial = await readSnapshot(root);
  assert.deepEqual(Object.keys(partial.sources).sort(), [
    "session-a",
    "session-b",
  ]);
  assert.ok(partial.memory.includes(before.memory));
  assert.equal(
    await readFile(
      join(root, "current", "rollout_summaries", "session-a.md"),
      "utf8",
    ),
    oldSummary,
  );
  assert.equal((await readRaw(root)).length, 3);
  await pipeline(root, async (system, input) => {
    assert.ok(system.includes("归并器"));
    assert.deepEqual(
      JSON.parse(input).records.map((row: { id: string }) => row.id),
      ["session-c"],
    );
    return merge(input);
  });
  assert.deepEqual(Object.keys((await readSnapshot(root)).sources).sort(), [
    "session-a",
    "session-b",
    "session-c",
  ]);
  assert.equal((await readdir(join(root, "current", "rollout_summaries"))).length, 3);
  await pipeline(root, async () => assert.fail("全部增量已消费，不应重新归并"));
  await assert.rejects(readFile(join(root, "current", "raw_memories.md")), {
    code: "ENOENT",
  });
  const state = JSON.parse(
    await readFile(join(root, "current", "state.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(state), ["sources"]);
});

test("记忆：整个增量放不下时暂停；低收益更新不抹掉旧结论", async (t) => {
  const root = await temp(t);
  const path = await candidate(root);
  await pipeline(root, standard);
  const before = await readSnapshot(root);
  await candidate(root, "session-b");
  await pipeline(
    root,
    async (system) => {
      assert.ok(system.includes("记忆提取器"));
      return JSON.stringify(raw);
    },
    { inputBudget: 1 },
  );
  assert.deepEqual(await readSnapshot(root), before);
  await writeFile(path, "新回合没有额外可复用经验");
  await utimes(path, new Date(now - 3_600_000), new Date(now - 3_600_000));
  await pipeline(
    root,
    async (system) => {
      assert.ok(system.includes("记忆提取器"));
      return JSON.stringify({ raw_memory: "", rollout_summary: "" });
    },
    { inputBudget: 1 },
  );
  assert.deepEqual(await readSnapshot(root), before);
  assert.ok(
    (await readFile(
      join(root, "current", "rollout_summaries", "session-a.md"),
      "utf8",
    )).includes(raw.rollout_summary),
  );
});

test("记忆：归并期间人工修改保留，未知来源不能发布", async (t) => {
  const root = await temp(t);
  const path = await candidate(root);
  await pipeline(root, standard);
  await writeFile(path, "新证据");
  await utimes(
    path,
    new Date(now - 6.5 * 3_600_000),
    new Date(now - 6.5 * 3_600_000),
  );
  await assert.rejects(
    pipeline(root, async (system) => {
      if (system.includes("记忆提取器")) return JSON.stringify(raw);
      await writeFile(join(root, "current", "MEMORY.md"), "人工纠正的版本");
      return JSON.stringify(consolidated);
    }),
    /人工编辑/,
  );
  assert.equal((await readSnapshot(root)).memory, "人工纠正的版本");
  const other = await temp(t);
  await candidate(other);
  await assert.rejects(
    pipeline(other, async (system) =>
      JSON.stringify(
        system.includes("记忆提取器")
          ? raw
          : {
              ...consolidated,
              memory: "## 主题\n来源：rollout_summaries/nonexistent.md",
            },
      ),
    ),
    /不存在的来源/,
  );
  assert.equal((await readSnapshot(other)).memory, "");
});

function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("记忆：真实宿主 session 文件、启动事件后台两阶段、摘要按会话冻结", async (t) => {
  const root = await temp(t);
  const previous = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_MEMORY_DIR;
    else process.env.PI_MEMORY_DIR = previous;
  });
  const historical = SessionManager.create(root, join(root, "sessions"));
  historical.appendMessage({ role: "user", content: "配置入口", timestamp: 0 });
  historical.appendMessage(response("已核对生成文件"));
  const path = historical.getSessionFile()!;
  await registerCandidate(root, {
    id: historical.getSessionId(),
    path,
    cwd: root,
  });
  await utimes(
    path,
    new Date(now - 7 * 3_600_000),
    new Date(now - 7 * 3_600_000),
  );
  const active = SessionManager.create(root, join(root, "sessions"));
  active.appendMessage({ role: "user", content: "当前问题", timestamp: 0 });
  active.appendMessage(response("完成"));
  const extension = await loadExtensionFromFactory(
    memory,
    root,
    createEventBus(),
    createExtensionRuntime(),
  );
  const historicalMemory = {
    ...consolidated,
    memory: consolidated.memory.replaceAll(
      "session-a",
      historical.getSessionId(),
    ),
  };
  let calls = 0;
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: false,
    model: { id: "test", contextWindow: 8000, maxTokens: 4096 },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setStatus() {},
    },
    sessionManager: active,
    modelRegistry: {
      streamSimple(
        _model: unknown,
        context: { systemPrompt: string; messages: { content: string }[] },
        options: { maxTokens: number },
      ) {
        assert.equal(options.maxTokens, 1600);
        calls++;
        const stream = createAssistantMessageEventStream();
        const text = context.systemPrompt.includes("记忆提取器")
          ? raw
          : historicalMemory;
        if (context.systemPrompt.includes("记忆提取器"))
          assert.ok(context.messages[0].content.includes("已核对生成文件"));
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: response(JSON.stringify(text)),
          }),
        );
        return stream;
      },
    },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown) => {
    for (const handler of extension.handlers.get(name) || [])
      await handler(event, ctx);
  };
  await emit("session_start", {});
  for (let i = 0; i < 100 && !(await readSnapshot(root)).summary; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2);
  const memoryCommand = extension.commands.get("memory")!;
  assert.deepEqual(await memoryCommand.getArgumentCompletions!("r"), [
    { value: "run", label: "run" },
    { value: "retry", label: "retry" },
    { value: "reload", label: "reload" },
  ]);
  assert.equal(await memoryCommand.getArgumentCompletions!("x"), null);
  const event = {
    type: "before_agent_start",
    systemPromptOptions: { sections: {} as Record<string, string> },
  };
  await emit("before_agent_start", event);
  assert.ok(event.systemPromptOptions.sections.memory.includes("尚无记忆摘要"));
  await memoryCommand.handler("reload", ctx as never);
  await emit("before_agent_start", event);
  assert.ok(
    event.systemPromptOptions.sections.memory.includes(consolidated.summary),
  );
  await writeFile(
    join(root, "phase2-retry.json"),
    JSON.stringify({
      fingerprint: "retry",
      retryAt: Date.now() + 60_000,
      error: "Error: stopReason=aborted",
    }),
  );
  await memoryCommand.handler("run", ctx as never);
  assert.match(notifications.at(-1)!.message, /\/memory retry/);
  await memoryCommand.handler("status", ctx as never);
  assert.match(notifications.at(-1)!.message, /模型请求超时或被取消/);
  assert.doesNotMatch(notifications.at(-1)!.message, /记忆入口|fingerprint/);
  await memoryCommand.handler("debug", ctx as never);
  assert.match(notifications.at(-1)!.message, /记忆入口|Retry/);
  await memoryCommand.handler("retry", ctx as never);
  assert.match(notifications.at(-1)!.message, /已开始|已排队/);
  assert.equal(await readRetry(root), undefined);
  await memoryCommand.handler("unknown", ctx as never);
  assert.match(notifications.at(-1)!.message, /未知子命令/);
  await writeFile(join(root, "phase2-retry.json"), "损坏 JSON");
  await memoryCommand.handler("status", ctx as never);
  assert.match(notifications.at(-1)!.message, /自动记忆：/);
  await rm(join(root, "phase2-retry.json"));
  await emit("agent_settled", {});
  assert.equal(calls, 2);
  await memoryCommand.handler("off", ctx as never);
  await memoryCommand.handler("run", ctx as never);
  assert.match(notifications.at(-1)!.message, /已关闭/);
  event.systemPromptOptions.sections = {};
  await emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.sections, {});
  await emit("session_shutdown", {});
});

test("记忆：Pi loader 加载独立包入口", async (t) => {
  const root = await temp(t);
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { pi: { extensions: string[] } };
  const loaded = await discoverAndLoadExtensions(
    manifest.pi.extensions.map((path) => resolve(path)),
    root,
    join(root, "agent"),
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0]!.path.endsWith("/src/index.ts"));
});
