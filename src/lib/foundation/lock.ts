import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, readJson } from "./storage.ts";

/** 文件锁替代宿主不存在的 job lease；死进程锁可以回收，活进程锁绝不强制抢占。 */
export async function acquireLock(
  root: string,
): Promise<(() => Promise<void>) | undefined> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, ".pipeline-lock");
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // 回收动作也互斥，避免两个进程同时判断旧 owner 已死，误删其中一个刚取得的新锁。
    const reaper = join(root, ".lock-recovery");
    try {
      await mkdir(reaper);
    } catch {
      return undefined;
    }
    try {
      const owner = await readJson<{ pid: number }>(join(path, "owner.json"));
      // owner 未写完/锁损坏时不猜测是否死亡；通过 /memory status 暴露路径供人工处理。
      if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0)
        return undefined;
      try {
        process.kill(owner.pid, 0);
        return undefined;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH")
          return undefined;
      }
      await rm(path, { recursive: true, force: true });
      try {
        await mkdir(path);
      } catch {
        return undefined;
      }
    } finally {
      await rm(reaper, { recursive: true, force: true });
    }
  }
  await atomicWrite(
    join(path, "owner.json"),
    JSON.stringify({ pid: process.pid }),
  );
  return () => rm(path, { recursive: true, force: true });
}
