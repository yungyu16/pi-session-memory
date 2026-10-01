import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LIMITS, runPipeline } from "../../write.ts";
import { registerCandidate } from "../foundation/storage.ts";
import { redact } from "../foundation/model.ts";
import { readSession } from "./session.ts";
import { createModelCall } from "./model.ts";

/** 当前扩展实例的后台任务、取消和费用；不持有宿主会话的可变消息状态。 */
export class MemoryRuntime {
  enabled = process.env.PI_MEMORY !== "0";
  controller = new AbortController();
  state = "等待启动整理";
  cost = 0;
  running: Promise<void> | undefined;
  queued: ExtensionContext | undefined;
  summary = "";
  readonly root = resolve(
    process.env.PI_MEMORY_DIR || join(homedir(), ".agents", "memory"),
  );

  status = (text: string): void => {
    this.state = text;
  };
  stop = (): void => {
    this.controller.abort();
    this.controller = new AbortController();
    this.queued = undefined;
  };
  register = async (ctx: ExtensionContext): Promise<void> => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path || ctx.mode !== "tui") return; // 临时会话、RPC/print/json/subagent 不参与自动积累。
    await registerCandidate(this.root, {
      id: ctx.sessionManager.getSessionId(),
      path,
      cwd: ctx.cwd,
    });
  };
  start = (ctx: ExtensionContext): void => {
    if (
      !this.enabled ||
      ctx.mode !== "tui" ||
      !ctx.model ||
      !ctx.sessionManager.getSessionFile()
    )
      return;
    if (this.running) {
      this.queued = ctx;
      return;
    }
    const signal = this.controller.signal;
    const model = ctx.model;
    const registry = ctx.modelRegistry;
    const activeId = ctx.sessionManager.getSessionId();
    const idle = Number(process.env.PI_MEMORY_IDLE_HOURS ?? LIMITS.idleHours);
    const inputBudget = Math.min(
      64_000,
      Math.max(1000, Math.floor(model.contextWindow * 0.6)),
    );
    const outputBudget = Math.max(
      256,
      Math.min(
        8192,
        model.maxTokens || 8192,
        Math.floor(model.contextWindow * 0.2),
      ),
    );
    this.running = runPipeline({
      root: this.root,
      activeId,
      signal,
      inputBudget,
      idleHours: Number.isFinite(idle) && idle >= 0 ? idle : LIMITS.idleHours,
      status: (text) => {
        if (!signal.aborted) this.status(text);
      },
      readSession: (path) => readSession(path, Math.min(48_000, inputBudget)),
      call: createModelCall(model, registry, outputBudget, (amount) => {
        this.cost += amount;
      }),
    })
      .catch((error) => {
        if (signal.aborted) return;
        this.status("整理失败，稍后重试");
        ctx.ui.notify(
          `自动记忆未完成：${formatMemoryError(error)}`,
          "warning",
        );
      })
      .finally(() => {
        this.running = undefined;
        const next = this.queued;
        this.queued = undefined;
        if (next && this.enabled) this.start(next);
      });
    // 不等待模型：主会话正常开始；退出/重载取消，下次启动从持久阶段结果继续。
  };
}

/** 宿主通知只显示脱敏且有界的错误信息。 */
export function formatMemoryError(error: unknown): string {
  return redact(String(error)).slice(0, 200);
}
