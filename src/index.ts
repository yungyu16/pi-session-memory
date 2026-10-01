import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadSummary,
  memoryInstructions,
  recallMemory,
} from "./read.ts";
import { MemoryRuntime, formatMemoryError } from "./lib/runtime/controller.ts";
import { clearRetry, readRetry } from "./lib/foundation/storage.ts";

function retryReason(error?: string): string {
  if (!error) return "上次整理失败，未记录具体原因";
  if (error.includes("stopReason=aborted"))
    return "上次归并时模型请求超时或被取消";
  if (error.includes("stopReason=length"))
    return "上次归并时模型输出达到长度上限";
  if (error.includes("stopReason=error")) return "上次归并时模型服务返回错误";
  return "上次归并失败";
}

function remainingTime(timestamp: number): string {
  const minutes = Math.max(1, Math.ceil((timestamp - Date.now()) / 60_000));
  return minutes < 60
    ? `${minutes} 分钟后`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后`;
}

function displayState(state: string): string {
  const labels: Record<string, string> = {
    "等待启动整理": "待命",
    "提取历史会话": "正在提取历史会话",
    "归并与整理": "正在归并记忆",
    "归并失败退避中": "等待重试",
    "整理失败，稍后重试": "整理失败",
    "记忆已是最新": "已是最新",
    "暂无可积累经验": "暂无新内容",
  };
  return labels[state] || state;
}

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
    description: "自动记忆：status | run | retry | on | off | reload | debug",
    getArgumentCompletions: (prefix) => {
      const commands = [
        "status",
        "run",
        "retry",
        "on",
        "off",
        "reload",
        "debug",
      ];
      const matches = commands.filter((command) => command.startsWith(prefix));
      return matches.length
        ? matches.map((command) => ({ value: command, label: command }))
        : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      try {
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
        if (command === "run" || command === "retry") {
          if (!runtime.enabled) {
            ctx.ui.notify("自动记忆已关闭，请先执行 /memory on", "warning");
            return;
          }
          const retry = await readRetry(runtime.root);
          if (command === "run" && retry && retry.retryAt > Date.now()) {
            ctx.ui.notify(
              `整理正在等待重试。${retryReason(retry.error)}，${remainingTime(retry.retryAt)}可再次执行 /memory run。\n如需现在重试，请执行 /memory retry。`,
              "info",
            );
            return;
          }
          if (command === "retry" && retry) await clearRetry(runtime.root);
          await runtime.register(ctx);
          const result = runtime.start(ctx);
          const messages = {
            started: "已开始整理记忆，完成后可执行 /memory status 查看结果",
            queued: "已有整理任务正在运行，本次请求已排队",
            disabled: "自动记忆已关闭，请先执行 /memory on",
            unavailable: "当前会话无法启动记忆整理",
          } as const;
          ctx.ui.notify(
            messages[result],
            result === "disabled" || result === "unavailable"
              ? "warning"
              : "info",
          );
          return;
        }
        if (command === "reload") {
          runtime.summary = await loadSummary(runtime.root);
          ctx.ui.notify("已刷新本会话记忆摘要", "info");
          return;
        }
        if (command !== "status" && command !== "debug") {
          ctx.ui.notify(
            `未知子命令：${command}。可用：status | run | retry | on | off | reload | debug`,
            "warning",
          );
          return;
        }
        const retry = await readRetry(runtime.root);
        if (command === "debug") {
          ctx.ui.notify(
            `状态：${runtime.state}\n记忆入口：${runtime.root}/current\n历史登记：${runtime.root}/candidates\n阶段记录：${runtime.root}/stage1\n写锁：${runtime.root}/.pipeline-lock\n额外模型费用：$${runtime.cost.toFixed(4)}\nRetry：${retry ? JSON.stringify(retry) : "无"}`,
            "info",
          );
          return;
        }
        const retryStatus = retry
          ? retry.retryAt > Date.now()
            ? `\n${retryReason(retry.error)}，${remainingTime(retry.retryAt)}允许重试`
            : `\n${retryReason(retry.error)}，现在可以重试`
          : "";
        ctx.ui.notify(
          `自动记忆：${runtime.enabled ? "开启" : "关闭"}\n状态：${displayState(runtime.state)}${retryStatus}\n操作：/memory run 查看或启动整理，/memory retry 立即重试`,
          "info",
        );
      } catch (error) {
        runtime.status(`${command} 失败`);
        ctx.ui.notify(
          `记忆命令失败：${formatMemoryError(error)}`,
          "warning",
        );
      }
    },
  });
}
