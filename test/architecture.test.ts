import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_ROOT = join(ROOT, "src");

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function parseRelativeImports(filePath: string, code: string): string[] {
  const imports: string[] = [];
  const regex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    const spec = match[1]!;
    const resolved = resolve(dirname(filePath), spec.replace(/\.js$/, ".ts"));
    imports.push(resolved);
  }
  return imports;
}

test("src/ import graph has zero circular dependencies", async () => {
  const files = await listTsFiles(SRC_ROOT);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const code = await readFile(file, "utf8");
    graph.set(file, parseRelativeImports(file, code));
  }

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles: string[] = [];

  function dfs(node: string): void {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const nextState = state.get(next);
      if (nextState === "visiting") {
        const start = stack.indexOf(next);
        cycles.push([...stack.slice(start), next].map((f) => relative(SRC_ROOT, f).replace(/\\/g, "/")).join(" -> "));
      } else if (!nextState && graph.has(next)) {
        dfs(next);
      }
    }
    stack.pop();
    state.set(node, "visited");
  }

  for (const file of files) {
    if (!state.has(file)) dfs(file);
  }

  assert.deepEqual(cycles, [], `发现循环依赖：\n${cycles.join("\n")}`);
});

test("no production module outside dedicated store files executes raw SQL via .db.prepare / .db.exec", async () => {
  const files = await listTsFiles(SRC_ROOT);
  const allowedStoreFile = (rel: string): boolean =>
    rel.startsWith("synth/store/")
    || rel.startsWith("eval/store/")
    || rel === "reasoning/store.ts"
    || rel === "synth/eval-guard.ts" // intentional read-only cross-DB guard (must not import src/eval/* per ADR 0004)
    || rel === "synth/question-store.ts"; // legacy standalone createSaveQuestionsTool helper accepts raw DatabaseSync

  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
    if (allowedStoreFile(rel)) continue;
    const code = await readFile(file, "utf8");
    if (/\bdb\.(?:prepare|exec)\s*\(/.test(code)) {
      violations.push(rel);
    }
  }
  assert.deepEqual(violations, [], `禁止在 store 之外直接写裸 SQL：${violations.join(", ")}`);
});

test("domain boundaries hold: shared/ is leaf-only and non-cli modules never import cli/", async () => {
  const files = await listTsFiles(SRC_ROOT);
  for (const file of files) {
    const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
    const code = await readFile(file, "utf8");
    const deps = parseRelativeImports(file, code).map((d) => relative(SRC_ROOT, d).replace(/\\/g, "/"));

    if (rel.startsWith("shared/")) {
      const bad = deps.filter((d) => !d.startsWith("shared/"));
      assert.deepEqual(bad, [], `src/${rel} 不得依赖非 shared 模块：${bad.join(", ")}`);
    }
    if (!rel.startsWith("cli/")) {
      const bad = deps.filter((d) => d.startsWith("cli/"));
      assert.deepEqual(bad, [], `src/${rel} 不得反向依赖 cli/：${bad.join(", ")}`);
    }
    if (rel.startsWith("synth/") || rel.startsWith("reasoning/")) {
      const bad = deps.filter((d) => d.startsWith("eval/"));
      assert.deepEqual(bad, [], `src/${rel} 不得依赖 eval/：${bad.join(", ")}`);
    }
  }
});
