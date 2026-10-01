export interface Candidate {
  id: string;
  path: string;
  cwd: string;
}
export interface RawMemory extends Candidate {
  fingerprint: string;
  updated: number;
  generated: number;
  raw_memory: string;
  rollout_summary: string;
  retryAt?: number;
  error?: string;
}
export interface Snapshot {
  memory: string;
  summary: string;
  sources: Record<string, string>;
}
export const emptySnapshot = (): Snapshot => ({
  memory: "",
  summary: "",
  sources: {},
});
