import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelCall } from "../../write.ts";

/** 捕获本次任务的模型与注册表；不读取主对话的可变消息。 */
export function createModelCall(
  model: NonNullable<ExtensionContext["model"]>,
  registry: ExtensionContext["modelRegistry"],
  maxTokens: number,
  onCost: (amount: number) => void,
): ModelCall {
  return async (system, input, taskSignal) => {
    const stream = registry.streamSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", timestamp: Date.now(), content: input }],
      },
      {
        signal: AbortSignal.any([taskSignal, AbortSignal.timeout(120_000)]),
        maxTokens,
      },
    );
    const response = await stream.result();
    taskSignal.throwIfAborted();
    onCost(response.usage.cost.total);
    if (response.stopReason !== "stop")
      throw new Error("记忆模型请求未成功完成");
    return response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  };
}
