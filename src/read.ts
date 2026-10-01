import { READ_PROMPT } from "./lib/foundation/prompts.ts";
import { readSnapshot } from "./lib/foundation/storage.ts";

export async function loadSummary(root: string): Promise<string> {
  return (await readSnapshot(root)).summary.slice(0, 6000);
}

export async function recallMemory(root: string, query: string): Promise<string> {
  return searchMemory((await readSnapshot(root)).memory, query);
}

/** 读路径不依赖后台提取和归并；摘要固定在当前会话中。 */
export function memoryInstructions(root: string, summary: string): string {
  return READ_PROMPT.replace(/\{\{ (root|summary) \}\}/g, (_match, name: string) =>
    name === "root" ? root : summary || "尚无记忆摘要。",
  );
}

export function terms(query: string): string[] {
  const normalized = query.toLowerCase();
  const words: string[] = normalized.match(/[a-z0-9_.-]+/g) || [];
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) words.push(run);
    else
      for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
  }
  return [...new Set(words)].slice(0, 80);
}

export function searchMemory(memory: string, query: string): string {
  const tokens = terms(query);
  return memory
    .split(/(?=^## )/m)
    .map((body) => ({
      body,
      score: tokens.reduce(
        (n, token) => n + (body.toLowerCase().includes(token) ? 1 : 0),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ body }) => body)
    .join("\n")
    .slice(0, 10_000);
}
