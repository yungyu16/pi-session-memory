import { acquireLock } from "./lib/foundation/lock.ts";
import {
  clearRetry,
  hash,
  listCandidates,
  prepareStorage,
  publish,
  readRaw,
  readRetry,
  readSnapshot,
  readSourceInfo,
  writeRaw,
  writeRetry,
} from "./lib/foundation/storage.ts";
import {
  parseConsolidation,
  parseExtraction,
  redact,
} from "./lib/foundation/model.ts";
import {
  CONSOLIDATION_PROMPT,
  EXTRACTION_PROMPT,
} from "./lib/foundation/prompts.ts";
import type { Candidate, RawMemory } from "./lib/foundation/types.ts";

export const LIMITS = {
  perRun: 2,
  idleHours: 0.5,
  retryMs: 3_600_000,
};

export type ModelCall = (
  system: string,
  input: string,
  signal: AbortSignal,
) => Promise<string>;

export interface PipelineOptions {
  root: string;
  activeId: string;
  signal: AbortSignal;
  call: ModelCall;
  readSession: (path: string) => Promise<string>;
  status: (text: string) => void;
  now?: number;
  idleHours?: number;
  inputBudget?: number;
}

/** 入口只协调全局写锁和两个阶段；阶段一结果在阶段二之前独立持久化。 */
export async function runPipeline(options: PipelineOptions): Promise<void> {
  const release = await acquireLock(options.root);
  if (!release) {
    options.status("其他会话正在整理");
    return;
  }
  try {
    options.signal.throwIfAborted();
    await prepareStorage(options.root);
    await extractHistory(options);
    await consolidateHistory(options);
  } finally {
    await release();
  }
}

async function extractHistory(options: PipelineOptions): Promise<void> {
  const { root, activeId, signal, call, readSession, status } = options;
  const now = options.now ?? Date.now();
  const candidates = await listCandidates(root);
  const rows = await readRaw(root);
  const eligible: {
    candidate: Candidate;
    updated: number;
    fingerprint: string;
  }[] = [];
  for (const candidate of candidates) {
    signal.throwIfAborted();
    if (candidate.id === activeId) continue;
    let info;
    try {
      info = await readSourceInfo(candidate.path);
    } catch {
      continue;
    }
    if (
      !info.isFile ||
      info.size > 20 * 1024 * 1024 ||
      now - info.updated <
        (options.idleHours ?? LIMITS.idleHours) * 3_600_000
    )
      continue;
    const fingerprint = hash(`${candidate.path}:${info.updated}:${info.size}`);
    const old = rows.find((row) => row.id === candidate.id);
    if (
      old &&
      ((old.fingerprint === fingerprint && !old.error) ||
        (old.retryAt || 0) > now)
    )
      continue;
    eligible.push({ candidate, updated: info.updated, fingerprint });
  }
  for (const { candidate, updated, fingerprint } of eligible
    .sort((a, b) => a.updated - b.updated)
    .slice(0, LIMITS.perRun)) {
    signal.throwIfAborted();
    status("提取历史会话");
    const old = rows.find((row) => row.id === candidate.id);
    const row: RawMemory = {
      ...candidate,
      fingerprint,
      updated,
      generated: now,
      raw_memory: "",
      rollout_summary: "",
    };
    try {
      const conversation = redact(await readSession(candidate.path));
      if (conversation)
        Object.assign(
          row,
          parseExtraction(
            await call(
              EXTRACTION_PROMPT,
              JSON.stringify({
                project: candidate.cwd,
                source: candidate.path,
                conversation,
              }),
              signal,
            ),
          ),
        );
      const latest = await readSourceInfo(candidate.path);
      if (latest.updated !== updated) continue; // 历史会话被恢复使用，放弃这次旧快照。
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) throw error;
      // 保留上次成功的提取，失败状态带一小时退避，避免每次启动反复收费。
      Object.assign(row, old || {}, {
        error: redact(String(error)).slice(0, 200),
        retryAt: now + LIMITS.retryMs,
      });
    }
    await writeRaw(root, row);
  }
}

async function consolidateHistory(options: PipelineOptions): Promise<void> {
  const { root, signal, call, status } = options;
  const now = options.now ?? Date.now();
  signal.throwIfAborted();
  const previous = await readSnapshot(root);
  const pending = selectPending(await readRaw(root), previous.sources);
  if (!pending.length) {
    status(previous.memory ? "记忆已是最新" : "暂无可积累经验");
    return;
  }
  const budget = options.inputBudget ?? 64_000;
  const existingSources = Object.keys(previous.sources);
  const input = (rows: RawMemory[]): string =>
    JSON.stringify({
      previous: previous.memory,
      currentSummary: previous.summary,
      existingSources,
      records: rows.map(({ id, cwd, path, raw_memory, rollout_summary }) => ({
        id,
        cwd,
        path,
        raw_memory,
        rollout_summary,
      })),
    });
  // 完整手册也要占用预算；放不下的记录不推进检查点，下一次触发继续。
  const selected: RawMemory[] = [];
  for (const row of pending)
    if (input([...selected, row]).length <= budget) selected.push(row);
  if (!selected.length) {
    // 不靠淘汰旧知识腾空间；手册过大时暂停归并，需人工精简或换更大模型。
    status("模型预算不足，保留已有记忆与待处理记录");
    return;
  }
  const fingerprint = hash(
    JSON.stringify({
      sources: selected.map((row) => [row.id, row.fingerprint]),
      memory: previous.memory,
      summary: previous.summary,
    }),
  );
  const retry = await readRetry(root);
  if (retry?.fingerprint === fingerprint && retry.retryAt > now) {
    status("归并失败退避中");
    return;
  }
  status("归并与整理");
  try {
    const result = parseConsolidation(
      await call(CONSOLIDATION_PROMPT, input(selected), signal),
    );
    signal.throwIfAborted();
    const sources = {
      ...previous.sources,
      ...Object.fromEntries(selected.map((row) => [row.id, row.fingerprint])),
    };
    for (const match of result.memory.matchAll(
      /rollout_summaries\/([a-zA-Z0-9-]+)\.md/g,
    ))
      if (!Object.hasOwn(sources, match[1]))
        throw new Error("归并结果引用了不存在的来源摘要，拒绝发布");
    const latest = await readSnapshot(root);
    if (
      latest.memory !== previous.memory ||
      latest.summary !== previous.summary
    )
      throw new Error("归并期间记忆被人工编辑，本次保留人工版本，稍后重新归并");
    await publish(root, { ...result, sources }, selected);
    await clearRetry(root);
    status(
      `已归并 ${selected.length} 个会话，待归并 ${pending.length - selected.length} 个`,
    );
  } catch (error) {
    if (!signal.aborted)
      await writeRetry(root, fingerprint, now + LIMITS.retryMs);
    throw error;
  }
}

/** 只选择未归并的有效更新；等待最久的先处理，不凭访问次数或年龄淘汰。 */
export function selectPending(
  rows: RawMemory[],
  sources: Record<string, string>,
): RawMemory[] {
  return rows
    .filter(
      (row) => row.raw_memory.trim() && sources[row.id] !== row.fingerprint,
    )
    .sort((a, b) => a.generated - b.generated || a.id.localeCompare(b.id));
}
