import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSynthBatchWorkflow, runSynthExportWorkflow, runSynthJudgeWorkflow, runSynthQuestionsWorkflow, runSynthSuiteWorkflow } from "../src/synth/workflows.js";
import type { PiConfig } from "../src/shared/pi-runner.js";

const config: PiConfig = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", modelId: "fixture", maxTokens: 1024, contextWindow: 8192, timeoutMs: 1000 };

test("pre-cancelled public synth workflows stop before input loading, database ownership or output writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synth-workflow-abort-"));
  try {
    const dbPath = join(dir, "main.sqlite");
    const outPath = join(dir, "out.jsonl");
    const signal = AbortSignal.abort();
    const options = { dbPath, config, signal };
    for (const run of [
      () => runSynthBatchWorkflow({ ...options, inputDir: dir }),
      () => runSynthSuiteWorkflow({ ...options, inputDir: dir }),
      () => runSynthJudgeWorkflow(options),
      () => runSynthQuestionsWorkflow({ ...options, input: join(dir, "missing.md") }),
      () => runSynthExportWorkflow({ dbPath, outPath, signal }),
    ]) {
      await assert.rejects(run(), (error: unknown) => (error as { code?: string }).code === "operation_aborted");
      assert.equal(existsSync(dbPath), false);
      assert.equal(existsSync(outPath), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
