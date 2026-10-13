import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createExtensionRuntime,
  discoverAndLoadExtensions,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import memory from "../src/index.ts";
import { ensureMemoryDirectory, memoryInstructions, readMemoryIndex } from "../src/memory.ts";

async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-session-memory-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function environment(t: TestContext, values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

async function host(t: TestContext, options: { envOff?: boolean; flagOff?: boolean } = {}) {
  const root = join(await temp(t), "memory");
  environment(t, { PI_MEMORY_DIR: root, PI_MEMORY: options.envOff ? "0" : undefined });
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(memory, root, createEventBus(), runtime);
  if (options.flagOff) runtime.flagValues.set("no-memory", true);
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionFile: () => "session.jsonl" },
    ui: { notify: (message: string) => notifications.push(message) },
    // 任何后台模型调用都是回归；也不需要当前模型才能加载本地记忆。
    modelRegistry: { streamSimple: () => assert.fail("不应产生后台模型请求") },
  } as unknown as ExtensionContext;
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  const emit = async (name: string) => {
    for (const handler of extension.handlers.get(name) || []) await handler(event, ctx);
  };
  const command = async (args: string) => extension.commands.get("memory")!.handler(args, ctx as never);
  await emit("session_start");
  return { root, extension, ctx, event, emit, command, notifications };
}

test("文件记忆：初始化仅创建目录，载入索引而不读取主题正文", async (t) => {
  const root = join(await temp(t), "memory");
  assert.deepEqual(await readMemoryIndex(root), { content: "", truncated: false });
  await ensureMemoryDirectory(root);
  assert.deepEqual(await readdir(root), ["topics"]);
  await writeFile(join(root, "topics", "约定.md"), "这段详细证据不能常驻注入");
  const text = "- [项目约定](topics/约定.md) — 项目 A 的决策背景";
  await writeFile(join(root, "MEMORY.md"), text);
  const index = await readMemoryIndex(root);
  assert.deepEqual(index, { content: text, truncated: false });
  const prompt = memoryInstructions(root, index);
  assert.ok(prompt.includes(text));
  assert.ok(!prompt.includes("这段详细证据不能常驻注入"));
  assert.equal(await readFile(join(root, "MEMORY.md"), "utf8"), text);
});

test("文件记忆：索引按行裁剪，尾部仍可从完整文件读取", async (t) => {
  const root = await temp(t);
  const text = Array.from({ length: 201 }, (_, n) => `- 第 ${n + 1} 个主题`).join("\n");
  await writeFile(join(root, "MEMORY.md"), text);
  const index = await readMemoryIndex(root);
  assert.equal(index.content.split("\n").length, 200);
  assert.ok(index.content.endsWith("第 200 个主题"));
  assert.equal(index.truncated, true);
  assert.match(memoryInstructions(root, index), /只显示开头部分/);
  assert.equal(await readFile(join(root, "MEMORY.md"), "utf8"), text);
});

test("文件记忆：字节边界不切坏中文与 emoji，优先保留完整行", async (t) => {
  const root = await temp(t);
  const path = join(root, "MEMORY.md");
  const atLimit = "a".repeat(25_000);
  await writeFile(path, atLimit);
  assert.deepEqual(await readMemoryIndex(root), { content: atLimit, truncated: false });
  const unicode = "中🙂".repeat(4000);
  await writeFile(path, unicode);
  const clipped = await readMemoryIndex(root);
  assert.equal(clipped.truncated, true);
  assert.ok(Buffer.byteLength(clipped.content) <= 25_000);
  assert.ok(Buffer.byteLength(clipped.content) >= 24_997);
  assert.ok(!clipped.content.includes("\uFFFD"));
  assert.ok(unicode.startsWith(clipped.content));
  assert.equal(await readFile(path, "utf8"), unicode);
  await writeFile(path, "- 完整入口\n" + unicode);
  assert.deepEqual(await readMemoryIndex(root), { content: "- 完整入口", truncated: true });
});

test("文件记忆：模板保留路径和正文中的替换字符，空索引不编造内容", () => {
  const prompt = memoryInstructions("/example/$&", { content: "$& {{ root }}", truncated: false });
  assert.ok(prompt.includes("/example/$&"));
  assert.ok(prompt.includes("$& {{ root }}"));
  assert.match(memoryInstructions("/example", { content: "", truncated: false }), /尚无记忆索引/);
});

test("文件记忆：宿主每轮刷新索引，开关生效，不注册后台流程或专用工具", async (t) => {
  const h = await host(t);
  assert.deepEqual([...h.extension.handlers.keys()].sort(), ["before_agent_start", "session_start"]);
  assert.equal(h.extension.tools.size, 0);
  await h.emit("before_agent_start");
  assert.match(h.event.systemPromptOptions.sections.memory, /尚无记忆索引/);
  await writeFile(join(h.root, "MEMORY.md"), "- [测试约定](topics/测试约定.md)");
  await h.emit("before_agent_start");
  assert.match(h.event.systemPromptOptions.sections.memory, /测试约定/);
  await h.command("off");
  await h.emit("before_agent_start");
  assert.equal(h.event.systemPromptOptions.sections.memory, undefined);
  await writeFile(join(h.root, "MEMORY.md"), "- 修改后的索引");
  await h.command("on");
  await h.emit("before_agent_start");
  assert.match(h.event.systemPromptOptions.sections.memory, /修改后的索引/);
  await h.command("status");
  assert.ok(h.notifications.at(-1)!.includes(h.root));
  await h.command("unknown");
  assert.match(h.notifications.at(-1)!, /可用命令/);
  assert.deepEqual(await h.extension.commands.get("memory")!.getArgumentCompletions!("o"), [
    { value: "on", label: "on" }, { value: "off", label: "off" },
  ]);
});

test("文件记忆：环境变量和启动标记关闭时不创建目录，可显式开启", async (t) => {
  for (const options of [{ envOff: true }, { flagOff: true }]) {
    await t.test(JSON.stringify(options), async (sub) => {
      const h = await host(sub, options);
      await h.emit("before_agent_start");
      assert.equal(h.event.systemPromptOptions.sections.memory, undefined);
      await assert.rejects(readdir(h.root), { code: "ENOENT" });
      await h.command("on");
      await h.emit("before_agent_start");
      assert.match(h.event.systemPromptOptions.sections.memory, /尚无记忆索引/);
    });
  }
});

test("文件记忆：非交互与临时会话不创建目录或注入提示", async (t) => {
  const h = await host(t);
  for (const mode of ["rpc", "print", "json"] as const) {
    h.ctx.mode = mode;
    await h.emit("before_agent_start");
    assert.equal(h.event.systemPromptOptions.sections.memory, undefined);
    await h.command("on");
    assert.match(h.notifications.at(-1)!, /仅在 TUI 持久会话/);
  }
  h.ctx.mode = "tui";
  h.ctx.sessionManager.getSessionFile = () => undefined;
  await h.emit("before_agent_start");
  assert.equal(h.event.systemPromptOptions.sections.memory, undefined);
  await assert.rejects(readdir(h.root), { code: "ENOENT" });
});

test("文件记忆：读取错误明确提示，并清除上轮索引", async (t) => {
  const h = await host(t);
  await h.emit("before_agent_start");
  await mkdir(join(h.root, "MEMORY.md"));
  await assert.rejects(readMemoryIndex(h.root));
  await h.emit("before_agent_start");
  assert.equal(h.event.systemPromptOptions.sections.memory, undefined);
  assert.match(h.notifications.at(-1)!, /记忆索引载入失败/);
});

test("文件记忆：Pi loader 加载独立包与提示词资源", async (t) => {
  const root = await temp(t);
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const loaded = await discoverAndLoadExtensions(
    manifest.pi.extensions.map((path: string) => resolve(path)), root, join(root, "agent"),
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].path.endsWith("/src/index.ts"));
});
