import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { redact } from "../foundation/model.ts";

export async function readSession(path: string, budget: number): Promise<string> {
  const entries = SessionManager.open(path).getBranch();
  return transcript(
    entries.flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    ),
    budget,
  );
}

/** 历史分支只收集可见文本，不包括 thinking、图片、工具参数或自定义注入消息。 */
export function transcript(messages: AgentMessage[], budget = 48_000): string {
  const lines = messages.flatMap((message) => {
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "toolResult"
    )
      return [];
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    return [`${message.role}: ${text.slice(0, 8000)}`];
  });
  if (!messages.some((message) => message.role === "user")) return "";
  const text = redact(lines.join("\n\n"));
  // 长历史保留开头目标与结尾结果，明确标出被截断部分，不让提取器猜测缺失证据。
  return text.length <= budget
    ? text
    : `${text.slice(0, Math.floor(budget / 3))}\n[中间历史因预算截断，不能推断缺失证据]\n${text.slice(-Math.floor((budget * 2) / 3))}`;
}
