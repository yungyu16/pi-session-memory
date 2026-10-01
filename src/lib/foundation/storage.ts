import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  emptySnapshot,
  type Candidate,
  type RawMemory,
  type Snapshot,
} from "./types.ts";

export const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRecord<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** 文件布局和 I/O 由基础层负责，流程只处理来源状态与结果。 */
export async function prepareStorage(root: string): Promise<void> {
  await mkdir(join(root, "stage1"), { recursive: true, mode: 0o700 });
}

export async function readSourceInfo(path: string): Promise<{
  size: number;
  updated: number;
  isFile: boolean;
}> {
  const info = await stat(path);
  return { size: info.size, updated: info.mtimeMs, isFile: info.isFile() };
}

export async function writeRaw(root: string, row: RawMemory): Promise<void> {
  await atomicWrite(join(root, "stage1", `${row.id}.json`), JSON.stringify(row));
}

export async function readRetry(root: string): Promise<{
  fingerprint: string;
  retryAt: number;
  error?: string;
} | undefined> {
  return readRecord(join(root, "phase2-retry.json"));
}

export async function writeRetry(
  root: string,
  fingerprint: string,
  retryAt: number,
  error?: string,
): Promise<void> {
  await atomicWrite(
    join(root, "phase2-retry.json"),
    JSON.stringify({ fingerprint, retryAt, ...(error ? { error } : {}) }),
  );
}

export async function clearRetry(root: string): Promise<void> {
  await rm(join(root, "phase2-retry.json"), { force: true });
}

export async function readSnapshot(root: string): Promise<Snapshot> {
  let current: string;
  try {
    current = await realpath(join(root, "current"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return emptySnapshot();
    throw error;
  }
  // 固定这一代路径，避免读取期间 current 切换而混用两代文件。
  const snapshot = await readJson<Pick<Snapshot, "sources">>(
    join(current, "state.json"),
  );
  if (!snapshot) return emptySnapshot();
  // 允许人工修正 Markdown，下次归并以实际正文为准，不覆盖用户编辑。
  return {
    ...snapshot,
    memory: await readFile(join(current, "MEMORY.md"), "utf8"),
    summary: await readFile(join(current, "memory_summary.md"), "utf8"),
  };
}

export async function publish(
  root: string,
  snapshot: Snapshot,
  rows: RawMemory[],
): Promise<void> {
  const dir = join(root, "generations", randomUUID());
  await mkdir(join(dir, "rollout_summaries"), { recursive: true, mode: 0o700 });
  try {
    await atomicWrite(join(dir, "MEMORY.md"), snapshot.memory);
    await atomicWrite(join(dir, "memory_summary.md"), snapshot.summary);
    await atomicWrite(
      join(dir, "state.json"),
      JSON.stringify({ sources: snapshot.sources }),
    );
    // 本轮只更新部分来源，复制已发布摘要，避免预算不足让旧证据消失。
    let current: string | undefined;
    try {
      current = await realpath(join(root, "current"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current)
      await cp(join(current, "rollout_summaries"), join(dir, "rollout_summaries"), {
        recursive: true,
      });
    for (const row of rows)
      await atomicWrite(
        join(dir, "rollout_summaries", `${row.id}.md`),
        `# ${row.id}\n\n项目：${row.cwd}\n来源：${row.path}\n更新时间：${new Date(row.updated).toISOString()}\n\n${row.rollout_summary}`,
      );
    const pointer = join(root, `.current-${randomUUID()}`);
    try {
      await symlink(dir, pointer);
      await rename(pointer, join(root, "current"));
    } finally {
      await rm(pointer, { force: true });
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  // 当前入口稳定，保留最近两代恢复；原始 Pi 会话始终不删除。
  const generations = await readdir(join(root, "generations"));
  const dated = await Promise.all(
    generations.map(async (name) => ({
      name,
      time: (await stat(join(root, "generations", name))).mtimeMs,
    })),
  );
  for (const old of dated.sort((a, b) => b.time - a.time).slice(2))
    await rm(join(root, "generations", old.name), {
      recursive: true,
      force: true,
    });
}

export async function registerCandidate(
  root: string,
  candidate: Candidate,
): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(candidate.id))
    throw new Error("无效会话标识");
  await mkdir(join(root, "candidates"), { recursive: true, mode: 0o700 });
  await atomicWrite(
    join(root, "candidates", `${candidate.id}.json`),
    JSON.stringify(candidate),
  );
}

export async function listCandidates(root: string): Promise<Candidate[]> {
  let files: string[];
  try {
    files = await readdir(join(root, "candidates"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: Candidate[] = [];
  for (const file of files.filter((file) =>
    /^[a-zA-Z0-9-]+\.json$/.test(file),
  )) {
    const row = await readRecord<Candidate>(join(root, "candidates", file));
    if (
      row &&
      typeof row.path === "string" &&
      typeof row.cwd === "string" &&
      row.id === file.slice(0, -5)
    )
      rows.push(row);
  }
  return rows;
}

export async function readRaw(root: string): Promise<RawMemory[]> {
  let files: string[];
  try {
    files = await readdir(join(root, "stage1"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: RawMemory[] = [];
  for (const file of files.filter((file) =>
    /^[a-zA-Z0-9-]+\.json$/.test(file),
  )) {
    const row = await readRecord<RawMemory>(join(root, "stage1", file));
    if (
      row &&
      row.id === file.slice(0, -5) &&
      typeof row.raw_memory === "string" &&
      typeof row.rollout_summary === "string"
    )
      rows.push(row);
  }
  return rows;
}
