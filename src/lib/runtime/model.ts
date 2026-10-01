import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelCall } from "../../write.ts";

export type MemoryModelPhase = "提取" | "归并";

export interface MemoryModelFailure {
  phase: MemoryModelPhase;
  model: string;
  stopReason: string;
  inputChars: number;
  outputChars: number;
  maxTokens: number;
  timeoutMs: number;
}

export function formatMemoryModelFailure(failure: MemoryModelFailure): string {
  return `记忆模型请求未成功完成（阶段=${failure.phase}，模型=${failure.model}，stopReason=${failure.stopReason}，输入=${failure.inputChars}字符，输出=${failure.outputChars}字符，上限=${failure.maxTokens} tokens，超时=${failure.timeoutMs}ms）`;
}

/** 捕获本次任务的模型与注册表；不读取主对话的可变消息。 */
export function createModelCall(
  model: NonNullable<ExtensionContext["model"]>,
  registry: ExtensionContext["modelRegistry"],
  maxTokens: number,
  timeoutMs: number,
  onCost: (amount: number) => void,
): ModelCall {
  return async (system, input, taskSignal, phase) => {
    const stream = registry.streamSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", timestamp: Date.now(), content: input }],
      },
      {
        signal: AbortSignal.any([taskSignal, AbortSignal.timeout(timeoutMs)]),
        maxTokens,
      },
    );
    const response = await stream.result();
    onCost(response.usage.cost.total);
    taskSignal.throwIfAborted();
    const output = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (response.stopReason !== "stop") {
      const modelName = [model.provider, model.id].filter(Boolean).join("/");
      throw new Error(
        formatMemoryModelFailure({
          phase: phase ?? "归并",
          model: modelName || "未知模型",
          stopReason: response.stopReason,
          inputChars: input.length,
          outputChars: output.length,
          maxTokens,
          timeoutMs,
        }),
      );
    }
    return output;
  };
}
