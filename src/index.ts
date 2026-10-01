import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadSummary,
  memoryInstructions,
  recallMemory,
} from "./read.ts";
import { MemoryRuntime, formatMemoryError } from "./lib/runtime/controller.ts";

export default function memory(pi: ExtensionAPI): void {
  const runtime = new MemoryRuntime();
  pi.registerFlag("no-memory", {
    description: "关闭自动记忆与召回",
    type: "boolean",
    default: false,
  });
  pi.on("session_start", async (_event, ctx) => {
    runtime.stop();
    // 清除重载前旧实现留下的记忆状态行；日常进度只通过命令查询。
    if (ctx.hasUI) ctx.ui.setStatus("memory", undefined);
    if (pi.getFlag("no-memory") === true) runtime.enabled = false;
    runtime.summary = "";
    if (
      !runtime.enabled ||
      ctx.mode !== "tui" ||
      !ctx.sessionManager.getSessionFile()
    )
      return;
    try {
      runtime.summary = await loadSummary(runtime.root);
      await runtime.register(ctx);
      runtime.start(ctx);
    } catch (error) {
      runtime.status("读取失败");
      ctx.ui.notify(
        `记忆读取失败：${formatMemoryError(error)}`,
        "warning",
      );
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (runtime.enabled)
      try {
        await runtime.register(ctx);
      } catch (error) {
        runtime.status("登记历史失败");
      }
    // 只登记来源；当前会话不提取，待后续启动且已空闲时处理。
  });
  pi.on("session_shutdown", () => {
    runtime.stop();
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (
      !runtime.enabled ||
      ctx.mode !== "tui" ||
      !ctx.sessionManager.getSessionFile()
    )
      return;
    event.systemPromptOptions.sections.memory = memoryInstructions(
      runtime.root,
      runtime.summary,
    );
  });
  pi.registerTool({
    name: "memory_search",
    label: "记忆搜索",
    description:
      "按关键词检索跨会话 MEMORY.md，返回主题段落与来源路径；核对项目范围和当前事实。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    async execute(_id, params, signal) {
      if (!runtime.enabled)
        return {
          content: [{ type: "text", text: "记忆已关闭" }],
          details: undefined,
        };
      signal?.throwIfAborted();
      const content = await recallMemory(runtime.root, params.query);
      return {
        content: [
          {
            type: "text",
            text:
              content || "没有命中，可用 read 读取 MEMORY.md 或搜索来源摘要。",
          },
        ],
        details: { root: `${runtime.root}/current` },
      };
    },
  });
  pi.registerCommand("memory", {
    description: "自动记忆：status | on | off | run | reload",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "off") {
        runtime.enabled = false;
        runtime.stop();
        runtime.status("已关闭");
        return;
      }
      if (command === "on") {
        runtime.enabled = true;
        runtime.summary = await loadSummary(runtime.root);
        await runtime.register(ctx);
        runtime.start(ctx);
        return;
      }
      if (command === "run") {
        await runtime.register(ctx);
        runtime.start(ctx);
        return;
      }
      if (command === "reload") {
        runtime.summary = await loadSummary(runtime.root);
        ctx.ui.notify("已刷新本会话记忆摘要", "info");
        return;
      }
      ctx.ui.notify(
        `自动记忆：${runtime.enabled ? "开启" : "关闭"}\n状态：${runtime.state}\n记忆入口：${runtime.root}/current\n历史登记：${runtime.root}/candidates\n阶段记录：${runtime.root}/stage1\n写锁：${runtime.root}/.pipeline-lock\n额外模型费用（本扩展实例）：$${runtime.cost.toFixed(4)}\n仅处理已由此扩展登记的 TUI 持久会话；默认空闲30分钟，每次整理最多2个；历史无年龄限制，已积累经验不按未使用天数删除。\n新会话摘要固定；后台新结果可通过 /memory reload 载入。`,
        "info",
      );
    },
  });
}
