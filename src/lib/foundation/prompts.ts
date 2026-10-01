import { readFileSync } from "node:fs";

/** 提示词随扩展加载，路径相对模块定位，不依赖启动时的工作目录。 */
function loadPrompt(name: string): string {
  return readFileSync(
    new URL(`../templates/${name}.md`, import.meta.url),
    "utf8",
  ).trimEnd();
}

export const READ_PROMPT = loadPrompt("召回");
export const EXTRACTION_PROMPT = loadPrompt("提取");
export const CONSOLIDATION_PROMPT = loadPrompt("归并");
