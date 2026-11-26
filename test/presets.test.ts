import assert from "node:assert/strict";
import test from "node:test";
import { renderInspectMarkdown, stratifiedSampleProbes } from "../src/eval/inspect.js";
import { EvalStore } from "../src/eval/store/index.js";
import { resolveCotBackfillPreset, resolveCotExportPreset } from "../src/reasoning/presets.js";
import { resolveSynthExportPreset, resolveSynthRunPreset } from "../src/synth/presets.js";

test("all built-in synth and cot presets resolve cleanly and reject unknown names", () => {
  assert.equal(resolveSynthRunPreset("train-standard")?.profile, "standard");
  assert.equal(resolveSynthRunPreset("train-short")?.maxTurns, 2);
  assert.equal(resolveSynthRunPreset("train-trap")?.maxQuestionsPerVideo, 3);
  assert.equal(resolveSynthRunPreset("dpo-pool")?.split, "dpo");
  assert.throws(() => resolveSynthRunPreset("test-freeze"), /未知 synth 预设/);
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
});

test("eval inspect stratifies across the 5 probe types deterministically and renders markdown report", () => {
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
    const types = ["answer", "correct_premise", "refuse", "answer"] as const;
    for (let i = 0; i < types.length; i++) {
      const probeId = store.createProbe({
        runId,
        sourceMaterialId: src.id,
        slotIndex: i + 1,
        probeType: types[i]!,
        persona: "学生",
        targetTurns: 1,
        question: `问题 ${i + 1}`,
        anchor: "结构决定位置",
        trap: "测试陷阱",
        anchorVerified: true,
      });
      store.appendReview(probeId, {
        roundNo: 1,
        decision: "accept",
        issues: [],
        feedback: "",
        callId: null,
      });
      store.saveProbeTurn({
        probeId,
        turnNo: 1,
        expectedBehavior: types[i]!,
        userContent: `问题 ${i + 1}`,
        referenceAnswer: "参考回答内容",
        rubric: {
          expectedBehavior: types[i]!,
          stance: "核心立场",
          keyPoints: ["论点 1"],
          forbidden: [],
          mustNotHallucinate: [],
          failureSignals: ["踩坑 1"],
        },
        attempts: 1,
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
    assert.match(md, /评测考题（Probe）抽检报告/);
    assert.match(md, /fixture-model/);
    assert.match(md, /结构决定位置/);
    assert.match(md, /核心立场/);
  } finally {
    store.close();
  }
});
