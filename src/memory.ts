import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// 只约束常驻索引的载入量，不限制主题文件大小，也不拒绝模型的文件写入。
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;
const PROMPT = readFileSync(new URL("./templates/记忆.md", import.meta.url), "utf8").trimEnd();

export interface MemoryIndex {
  content: string;
  truncated: boolean;
}

export async function ensureMemoryDirectory(root: string): Promise<void> {
  await mkdir(join(root, "topics"), { recursive: true, mode: 0o700 });
}

/** 仅读取入口索引；主题内容由 Agent 按需读取，缺失索引表示尚未积累记忆。 */
export async function readMemoryIndex(root: string): Promise<MemoryIndex> {
  let text: string;
  try {
    text = (await readFile(join(root, "MEMORY.md"), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { content: "", truncated: false };
    throw error;
  }
  const lines = text.split("\n");
  let content = lines.slice(0, INDEX_MAX_LINES).join("\n");
  const bytes = Buffer.from(content, "utf8");
  const truncated = lines.length > INDEX_MAX_LINES || bytes.length > INDEX_MAX_BYTES;
  if (bytes.length > INDEX_MAX_BYTES) {
    // 尽量保留完整索引行；单行过长时也必须落在 UTF-8 边界，不能切坏中文。
    let end = INDEX_MAX_BYTES;
    while ((bytes[end] & 0xc0) === 0x80) end--;
    content = bytes.subarray(0, end).toString("utf8");
    const newline = content.lastIndexOf("\n");
    if (newline >= 0) content = content.slice(0, newline);
  }
  return { content, truncated };
}

/** 使用回调替换，避免路径或索引中的 $& 等文本被当成替换指令。 */
export function memoryInstructions(root: string, index: MemoryIndex): string {
  const values: Record<string, string> = {
    root,
    index: index.content || "尚无记忆索引。遇到值得记住的内容时再创建。",
    limits: `${INDEX_MAX_LINES} 行、${INDEX_MAX_BYTES} UTF-8 字节`,
    notice: index.truncated
      ? "索引超过载入上限，本轮只显示开头部分。需要时读取完整 MEMORY.md，并将细节移到主题文件以缩短索引；磁盘内容未被裁剪。"
      : "",
  };
  return PROMPT.replace(/\{\{ (root|index|limits|notice) \}\}/g, (_match, key: string) => values[key]);
}
