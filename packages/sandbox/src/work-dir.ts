import { tmpdir } from "node:os";

/**
 * An isolated per-run working directory for a clone. Flue's `local()` sandbox
 * runs on the host, so each run gets its own scratch dir keyed by the run id
 * (an alphanumeric ULID) under the OS temp dir, never the project dir.
 */
export function workDir(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "");
  return `${tmpdir()}/d0lt-bot/${safe || "run"}`;
}
