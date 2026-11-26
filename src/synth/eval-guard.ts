import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Training-side leak guard. Deliberately does NOT import `src/eval/*`:
 * it opens the independent eval DB read-only and only reads video keys.
 */
export function readEvalVideoKeys(evalDbPath: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(evalDbPath)) return keys;
  const db = new DatabaseSync(evalDbPath, { readOnly: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const table of ["source_materials", "suite_items"]) {
      if (!tables.has(table)) continue;
      for (const row of db.prepare(`SELECT DISTINCT video_key FROM ${table}`).all() as Array<{ video_key: string }>) {
        keys.add(row.video_key);
      }
    }
  } finally {
    db.close();
  }
  return keys;
}

/** Throws when any exported training video also appears in the eval DB. */
export function assertNoEvalLeak(exportedVideoKeys: Iterable<string>, evalVideoKeys: Set<string>, label = "训练导出"): void {
  if (evalVideoKeys.size === 0) return;
  const leaked = [...new Set(exportedVideoKeys)].filter((key) => evalVideoKeys.has(key)).sort();
  if (leaked.length > 0) {
    throw new Error(
      `${label}包含评测库（eval.sqlite）中的视频，存在测试集泄漏风险：${leaked.slice(0, 10).join(", ")}${leaked.length > 10 ? ` 等 ${leaked.length} 个` : ""}`,
    );
  }
}
