import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

function fileIdentity(path: string): { path: string; dev?: bigint; ino?: bigint } | undefined {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    canonicalPath = resolve(path);
    return { path: process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath };
  }
  const stat = statSync(canonicalPath, { bigint: true });
  // Preserve SQLite's own open error for directories and other non-file targets.
  if (!stat.isFile()) return undefined;
  return {
    path: process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath,
    dev: stat.dev,
    ino: stat.ino,
  };
}

/** Call before opening a writable store: path aliases must never mix the two schemas. */
export function assertDistinctDatabaseFiles(mainPath: string, evalPath: string): void {
  // SQLite gives each of these connections its own private temporary database.
  if ([mainPath, evalPath].some((path) => path === ":memory:" || path === "")) return;
  const main = fileIdentity(mainPath);
  const evaluation = fileIdentity(evalPath);
  if (!main || !evaluation) return;
  if (main.path === evaluation.path ||
    (main.ino !== undefined && evaluation.ino !== undefined && main.dev === evaluation.dev && main.ino === evaluation.ino)) {
    throw new Error("database_path_conflict: 主库与评测库必须使用不同物理文件");
  }
}
