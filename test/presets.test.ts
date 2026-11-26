import assert from "node:assert/strict";
import test from "node:test";
import { renderInspectMarkdown, stratifiedSampleProbes } from "../src/eval/inspect.js";
import {
  resolveEvalBuildPreset,
  resolveEvalImportPreset,
  resolveEvalRunPreset,
} from "../src/eval/presets.js";
import { EvalStore } from "../src/eval/store/index.js";
import { resolveCotBackfillPreset, resolveCotExportPreset } from "../src/reasoning/presets.js";
import { resolveSynthExportPreset, resolveSynthRunPreset } from "../src/synth/presets.js";

test("all built-in synth, cot, and eval presets resolve cleanly and reject unknown names", () => {
  assert.equal(resolveSynthRunPreset("train-standard")?.profile, "standard");
  assert.equal(resolveSynthRunPreset("train-short")?.maxTurns, 2);
  assert.equal(resolveSynthRunPreset("train-trap")?.maxQuestionsPerVideo, 3);
  assert.equal(resolveSynthRunPreset("test-freeze")?.extractRubric, true);
  assert.equal(resolveSynthRunPreset("dpo-pool")?.split, "dpo");
  assert.throws(() => resolveSynthRunPreset("bad-preset"), /未知 synth 预设/);

  assert.equal(resolveSynthExportPreset("train-all")?.timestamp, true);
  assert.equal(resolveSynthExportPreset("train-val")?.valRatio, 0.1);
  assert.throws(() => resolveSynthExportPreset("bad-export"), /未知 export 预设/);

  assert.equal(resolveCotBackfillPreset("pilot")?.limit, 30);
  assert.equal(resolveCotBackfillPreset("pilot")?.stratified, true);
  assert.equal(resolveCotBackfillPreset("full")?.onlyMissing, true);
  assert.throws(() => resolveCotBackfillPreset("bad-cot"), /未知 cot backfill 预设/);

  assert.equal(resolveCotExportPreset("train-cot")?.format, "inline");
  assert.equal(resolveCotExportPreset("train-cot-val")?.valRatio, 0.1);
  assert.throws(() => resolveCotExportPreset("bad-cot-export"), /未知 cot export 预设/);

  assert.equal(resolveEvalImportPreset("test-fresh")?.excludeUsed, true);
  assert.throws(() => resolveEvalImportPreset("bad-import"), /未知 eval import 预设/);

  assert.equal(resolveEvalBuildPreset("adv-full")?.bareCheck, true);
  assert.equal(resolveEvalBuildPreset("adv-fast")?.bareCheck, false);
  assert.equal(resolveEvalBuildPreset("trap")?.profile, "trap");
  assert.throws(() => resolveEvalBuildPreset("bad-build"), /未知 eval build 预设/);

  assert.equal(resolveEvalRunPreset("blind-gold")?.historyMode, "gold");
  assert.equal(resolveEvalRunPreset("blind-self")?.historyMode, "self");
  assert.throws(() => resolveEvalRunPreset("bad-run"), /未知 eval run 预设/);
});

test("eval inspect stratifies across probe types deterministically and renders markdown report", () => {
  const store = new EvalStore(":memory:");
  try {
    const { record: src } = store.insertSourceMaterial({
      videoId: "BV_INSPECT_1",
      videoKey: "BV_INSPECT_1",
      partCount: 1,
      content: "示例原文段落：结构决定位置，位置决定立场。",
      splitSnapshot: "test",
    });
    const runId = store.createRun({
      kind: "probe_build",
      config: { modelId: "fixture-model" },
      prompts: {},
      skills: [],
    });
    const types = ["wild_short", "premise_trap", "contrast", "wild_short"] as const;
    for (let i = 0; i < types.length; i++) {
      const specId = store.createSpec({
        runId,
        sourceMaterialId: src.id,
        slotIndex: i + 1,
        probeType: types[i]!,
        persona: "学生",
        targetTurns: 1,
      });
      const probeId = store.createProbe({
        specId,
        question: `问题 ${i + 1}`,
        anchor: "结构决定位置",
        trap: "测试陷阱",
        expectedBehavior: "answer",
        anchorVerified: true,
      });
      store.setProbeStatus(probeId, "accepted");
    }

    const all = store.listProbes({ runId });
    const sampleA = stratifiedSampleProbes(all, 3, 42);
    const sampleB = stratifiedSampleProbes(all, 3, 42);
    assert.equal(sampleA.length, 3);
    assert.deepEqual(sampleA.map((p) => p.id), sampleB.map((p) => p.id));
    assert.equal(new Set(sampleA.map((p) => p.probeType)).size, 3);

    const md = renderInspectMarkdown(store, runId, sampleA, all.length);
    assert.match(md, /对抗考题（Probe）抽检报告/);
    assert.match(md, /fixture-model/);
    assert.match(md, /结构决定位置/);
  } finally {
    store.close();
  }
});
