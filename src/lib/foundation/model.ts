/** 两阶段模型输出契约和共同脱敏规则。 */
export function parseExtraction(output: string): {
  raw_memory: string;
  rollout_summary: string;
} {
  const data: unknown = JSON.parse(
    output
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, ""),
  );
  if (!data || typeof data !== "object")
    throw new Error("提取输出必须是 JSON 对象");
  const row = data as Record<string, unknown>;
  if (
    typeof row.raw_memory !== "string" ||
    typeof row.rollout_summary !== "string" ||
    row.raw_memory.length > 10_000 ||
    row.rollout_summary.length > 9000
  )
    throw new Error("提取输出字段或长度不正确");
  if (!!row.raw_memory.trim() !== !!row.rollout_summary.trim())
    throw new Error("无收益时两个字段必须同时为空");
  return {
    raw_memory: redact(row.raw_memory.trim()),
    rollout_summary: redact(row.rollout_summary.trim()),
  };
}

export function parseConsolidation(output: string): {
  memory: string;
  summary: string;
} {
  const data: unknown = JSON.parse(
    output
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, ""),
  );
  if (!data || typeof data !== "object")
    throw new Error("归并输出必须是 JSON 对象");
  const row = data as Record<string, unknown>;
  if (
    typeof row.memory !== "string" ||
    typeof row.summary !== "string" ||
    row.memory.length > 48_000 ||
    row.summary.length > 6000 ||
    !row.summary.trim()
  )
    throw new Error("归并输出字段、长度不正确或摘要为空");
  return {
    memory: redact(row.memory.trim()),
    summary: redact(row.summary.trim()),
  };
}

/** 只做常见凭据脱敏，不承诺识别所有敏感信息；提取提示也要求不保存敏感值。 */
export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[已脱敏私钥]",
    )
    .replace(
      /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[已脱敏]",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?key|token|secret|password|密码)["']?\s*[=:]\s*["']?)[^\s,"'`]+/gi,
      "$1[已脱敏]",
    )
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, "$1[已脱敏]");
}
