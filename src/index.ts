import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureMemoryDirectory, memoryInstructions, readMemoryIndex } from "./memory.ts";

/** 临时会话与 RPC/print 不启用自动记忆，避免无意改变批处理任务的行为。 */
function isInteractiveSession(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && !!ctx.sessionManager.getSessionFile();
}

/** 扩展只提供目录和提示；记忆读写由当前 Agent 使用宿主工具完成。 */
export default function memory(pi: ExtensionAPI): void {
  const root = resolve(process.env.PI_MEMORY_DIR || join(homedir(), ".agents", "memory"));
  let enabled = process.env.PI_MEMORY !== "0";
  pi.registerFlag("no-memory", {
    description: "关闭自动记忆提示",
    type: "boolean",
    default: false,
  });
  pi.on("session_start", () => {
    if (pi.getFlag("no-memory") === true) enabled = false;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    // 清除上轮注入，保证关闭或读取失败后不会继续携带旧索引。
    delete event.systemPromptOptions.sections.memory;
    if (!enabled || !isInteractiveSession(ctx)) return;
    try {
      await ensureMemoryDirectory(root);
      // 每轮读取最新索引，无需后台任务、缓存或单独的 reload 命令。
      event.systemPromptOptions.sections.memory = memoryInstructions(
        root,
        await readMemoryIndex(root),
      );
    } catch (error) {
      ctx.ui.notify(`记忆索引载入失败：${String(error).slice(0, 200)}`, "warning");
    }
  });
  pi.registerCommand("memory", {
    description: "文件记忆：status | on | off",
    getArgumentCompletions(prefix) {
      const matches = ["status", "on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      const command = args.trim() || "status";
      if (!["status", "on", "off"].includes(command)) {
        ctx.ui.notify("可用命令：/memory status、/memory on、/memory off", "warning");
        return;
      }
      if (command === "on" && !isInteractiveSession(ctx)) {
        ctx.ui.notify("文件记忆仅在 TUI 持久会话中启用", "warning");
        return;
      }
      if (command === "on") enabled = true;
      if (command === "off") enabled = false;
      ctx.ui.notify(
        `文件记忆：${enabled && isInteractiveSession(ctx) ? "开启" : "关闭"}\n目录：${root}\n由当前 Agent 维护主题文件，索引在下一轮自动载入。`,
        "info",
      );
    },
  });
}
