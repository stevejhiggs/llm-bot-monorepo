import { tmpdir } from "node:os";

// Keep a path segment to characters that are always safe in a path/shell, with a
// fallback so a fully-stripped value never collapses the path.
const safeSegment = (value: string, fallback: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, "") || fallback;

/**
 * An isolated per-run working directory for a clone, namespaced by the consuming
 * bot's `appName` so multiple bots sharing a host never collide. Flue's `local()`
 * sandbox runs on the host, so each run gets its own scratch dir keyed by the run
 * id (an alphanumeric ULID) under `<tmpdir>/<appName>/`, never the project dir.
 */
export function workDir(appName: string, runId: string): string {
  return `${tmpdir()}/${safeSegment(appName, "app")}/${safeSegment(runId, "run")}`;
}
