import { assertDistinctDatabaseFiles } from "../shared/database-path.js";
import { combineSignals, throwIfAborted } from "../shared/cancellation.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { writeOutputFile } from "../shared/cli-helpers.js";
import { DEFAULT_CORPUS_DIR, DEFAULT_EVAL_DB, DEFAULT_MAIN_DB } from "../shared/paths.js";
import { createPiRunner, readEvalPiConfig, readPiConfig } from "../shared/pi-runner.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../shared/retry.js";
import { nonEmpty, validateConcurrency } from "../shared/schema.js";
import type { RoleRunner } from "../shared/types.js";
import { runProbeCalibration, type RunProbeCalibrationSummary } from "./calibrate.js";
import type { CandidateFactory, CandidateRunner } from "./candidate-client.js";
import { gradeEvalRun, type GradeEvalRunSummary } from "./eval-grader.js";
import {
  loadCalibrationPromptBundle,
  loadEvalBuildPromptBundle,
  resolveCandidateSystemPrompt,
  type EvalSkillSnapshot,
} from "./eval-prompts.js";
import { runSuiteEvaluation, type RunSuiteEvaluationSummary } from "./eval-runner.js";
import { renderInspectMarkdown, stratifiedSampleProbes } from "./inspect.js";
import {
  DEFAULT_MAX_ANSWER_ATTEMPTS,
  DEFAULT_MAX_CRITIC_REVISIONS,
  DEFAULT_MAX_PROBES_PER_VIDEO,
  runProbeBuildLoop,
  type RunProbeBuildLoopSummary,
} from "./probe-loop.js";
import { buildEvalReport, renderEvalReportMarkdown, type EvalComparisonReport } from "./report.js";
import { importTestSources, verifySourceSplits, type ImportTestSourcesReport } from "./source-import.js";
import {
  EvalStore,
  PROBE_TYPES,
  type EvalHistoryMode,
  type EvalStoreSummary,
  type ProbeStatus,
  type ProbeType,
} from "./store/index.js";
import { DEFAULT_MAX_EASY_RATIO, freezeEvalSuite, type FreezeSuiteReport } from "./suite-freeze.js";

function requireEvalDbExists(evalDbPath: string): void {
  if (!existsSync(evalDbPath)) {
    throw new Error(`评测库不存在：${evalDbPath}（请先运行 npm run dm -- eval make）`);
  }
}

export function parseEvalHistoryMode(raw: string | undefined): EvalHistoryMode {
  const mode = (raw ?? "gold").trim();
  if (mode !== "gold" && mode !== "self") {
    throw new Error(`--history-mode 必须是 gold 或 self（实际 ${mode}）`);
  }
  return mode;
}

export function parseProbeTypeFilter(raw: string | undefined): ProbeType | undefined {
  if (raw === undefined) return undefined;
  const probeType = raw.trim() as ProbeType;
  if (!PROBE_TYPES.includes(probeType)) {
    throw new Error(`未知题型 --type ${probeType}（可选：${PROBE_TYPES.join(", ")}）`);
  }
  return probeType;
}

export function parseProbeTypeList(raw: readonly string[] | undefined): ProbeType[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: ProbeType[] = [];
  for (const item of raw) {
    const t = item.trim() as ProbeType;
    if (!PROBE_TYPES.includes(t)) {
      throw new Error(`未知题型 "${item}"（可选：${PROBE_TYPES.join(", ")}）`);
    }
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function resolveProbeRunFilter(store: EvalStore, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "all") return undefined;
  if (raw === "latest") return store.getLatestRun("probe_build")?.id;
  const id = Number(raw.trim());
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`--run 必须是正整数、latest 或 all（实际 ${raw}）`);
  }
  return id;
}

export interface MakeEvalSuiteOptions {
  evalDbPath?: string;
  mainDbPath?: string;
  suiteName?: string;
  noFreeze?: boolean;
  inputDir?: string;
  videoKeys?: string[];
  limit?: number;
  shuffle?: boolean;
  seed?: number;
  maxChunkChars?: number;
  probeTypes?: readonly ProbeType[];
  maxProbesPerVideo?: number;
  maxRevisions?: number;
  maxAnswerAttempts?: number;
  rebuild?: boolean;
  resumeBuildRunId?: number;
  allowPartialBuild?: boolean;
  recalibrate?: boolean;
  bareModel?: string;
  graderModel?: string;
  maxEasyRatio?: number;
  allowUncalibrated?: boolean;
  allowActiveRuns?: boolean;
  failOnTrainSim?: number;
  exportPath?: string;
  manifestOutPath?: string;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  promptsDir?: string;
  skillsDir?: string;
  answerStylePath?: string;
  /** Optional injectable runners & model IDs for tests. */
  runRole?: RoleRunner;
  runBareModel?: RoleRunner;
  runGrader?: RoleRunner;
  modelId?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface MakeEvalSuiteResult {
  action: "make";
  evalDb: string;
  mainDb: string;
  import: ImportTestSourcesReport;
  partial: boolean;
  exitCode: 0 | 1;
  build: RunProbeBuildLoopSummary | { skipped: true; reason: string };
  calibrate: RunProbeCalibrationSummary | { skipped: true; reason: string };
  freeze: FreezeSuiteReport | { skipped: true; reason: string };
}

/**
 * Unified one-command suite maker (`eval make`):
 * import(test split) -> build(unbuilt sources) -> calibrate(uncalibrated accepted probes) -> freeze(suite).
 * Fully resumable and idempotent across partial runs.
 */
export async function makeEvalSuiteWorkflow(options: MakeEvalSuiteOptions): Promise<MakeEvalSuiteResult> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  const mainDbPath = resolve(options.mainDbPath ?? DEFAULT_MAIN_DB);
  assertDistinctDatabaseFiles(mainDbPath, evalDbPath);
  if (!options.noFreeze && !options.suiteName?.trim()) {
    throw new Error("请指定 --suite <套卷名>（或传入 --no-freeze 只造题标定不冻结）");
  }
  if (!existsSync(mainDbPath)) {
    throw new Error(`主库不存在：${mainDbPath}`);
  }

  const concurrency = validateConcurrency(options.concurrency ?? 4);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const effectiveInputDir =
    options.inputDir !== undefined
      ? resolve(options.inputDir)
      : mainDbPath === resolve(DEFAULT_MAIN_DB) && existsSync(DEFAULT_CORPUS_DIR)
        ? DEFAULT_CORPUS_DIR
        : undefined;

  const evalStore = new EvalStore(evalDbPath);
  try {
    const signal = combineSignals(evalStore.signal, options.signal);
    throwIfAborted(signal);
    if (options.rebuild && options.resumeBuildRunId !== undefined) throw new Error("build_config_conflict: --rebuild 与 --resume-build 互斥");
    evalStore.setMeta("main_db_path", mainDbPath);

    // 1. Import test split (read-only from main DB, idempotent)
    options.onProgress?.("[eval make 1/4] 导入主库 test 分区材料快照...");
    const importReport = await importTestSources({
      evalStore,
      mainDbPath,
      inputDir: effectiveInputDir,
      videoKeys: options.videoKeys,
      limit: options.limit,
      shuffle: options.shuffle,
      seed: options.seed,
      maxChunkChars: options.maxChunkChars,
    });
    options.onProgress?.(
      `[eval make 1/4] 导入完成：新增视频 ${importReport.importedVideos}，新增分块 ${importReport.importedChunks}，跳过已有 ${importReport.skippedExistingChunks}`,
    );

    // Link every plan in the requested source scope, including zero-HTTP terminal reuse.
    const selectedSourceIds = new Set(importReport.selectedSourceMaterialIds);
    let targetSources = evalStore.listSourceMaterials().filter((source) => selectedSourceIds.has(source.id));
    const resumePlans = options.resumeBuildRunId === undefined ? [] : evalStore.listBuildPlans({ originRunId: options.resumeBuildRunId });
    if (options.resumeBuildRunId !== undefined) {
      if (!resumePlans.length) throw new Error(`build_snapshot_missing: origin run #${options.resumeBuildRunId}`);
      const sourceIds = new Set(resumePlans.map((plan) => plan.sourceMaterialId));
      targetSources = targetSources.filter((source) => sourceIds.has(source.id));
    }
    verifySourceSplits(mainDbPath, targetSources);
    const storedSpecs = resumePlans.filter((plan) => targetSources.some((source) => source.id === plan.sourceMaterialId)).map((plan) => {
      if (!plan.spec) throw new Error("build_snapshot_missing: 旧计划缺少生成规格，请使用 --rebuild 创建新 generation");
      return plan.spec;
    });
    const storedModels = new Set(storedSpecs.map((spec) => spec.modelId));
    if (storedModels.size > 1) throw new Error("build_config_conflict: 旧计划包含多个模型，请分别续跑");
    const storedSpec = storedSpecs[0];
    const bundle = storedSpec ? { prompts: storedSpec.prompts, skills: (evalStore.getRun(options.resumeBuildRunId!)?.skills ?? []) as EvalSkillSnapshot[] } : await loadEvalBuildPromptBundle({
      promptsDir: options.promptsDir, skillsDir: options.skillsDir, answerStylePath: options.answerStylePath,
    });
    const needsBuildCalls = options.rebuild || targetSources.some((source) => {
      const plan = options.resumeBuildRunId === undefined
        ? evalStore.listBuildPlans({ sourceMaterialId: source.id, latestOnly: true }).at(-1)
        : resumePlans.filter((candidate) => candidate.sourceMaterialId === source.id).at(-1);
      return !plan || (!["done", "skipped"].includes(plan.status) && !(plan.spec === null && plan.errorCode === "legacy_plan_incomplete"));
    });
    const requestedBuildModel = storedSpec?.modelId ?? options.modelId;
    const evalPi = options.runRole || !needsBuildCalls ? undefined : readEvalPiConfig({ ...process.env, ...(requestedBuildModel ? { EVAL_LLM_MODEL: requestedBuildModel } : {}) });
    const modelId = storedSpec?.modelId ?? options.modelId ?? evalPi?.modelId ?? (needsBuildCalls ? "injected-build-model" : "no-model-calls");
    const runRole = options.runRole ?? (evalPi ? createPiRunner(evalPi) : async () => { throw new Error("build_snapshot_missing: 没有可执行的生成规格"); });
    options.onProgress?.(`[eval make 2/4] 处理造题计划（${targetSources.length} 份材料，模型=${modelId}）...`);
    const buildResult = await runProbeBuildLoop({
      evalStore, sources: targetSources, prompts: bundle.prompts, skills: bundle.skills,
      modelId, runRole, allowedTypes: options.probeTypes,
      maxProbesPerVideo: options.maxProbesPerVideo ?? DEFAULT_MAX_PROBES_PER_VIDEO,
      maxRevisions: options.maxRevisions ?? DEFAULT_MAX_CRITIC_REVISIONS,
      maxAnswerAttempts: options.maxAnswerAttempts ?? DEFAULT_MAX_ANSWER_ATTEMPTS,
      rebuild: options.rebuild, resumeBuildRunId: options.resumeBuildRunId,
      concurrency, callMaxAttempts, callRetryDelayMs, signal, onProgress: options.onProgress,
    });
    const partial = buildResult.partial || !buildResult.plansComplete;
    if (partial && !options.allowPartialBuild) {
      const reason = `build_partial: 出题计划未完成（pending=${buildResult.pendingSlots}, errors=${buildResult.errorSlots}, legacy=${buildResult.incompleteLegacyPlans.join(",")}）；请续跑或显式使用 --allow-partial-build`;
      options.onProgress?.(reason);
      return { action: "make", evalDb: evalDbPath, mainDb: mainDbPath, import: importReport, build: buildResult, partial: true, exitCode: 1,
        calibrate: { skipped: true, reason }, freeze: { skipped: true, reason } };
    }
    throwIfAborted(signal);

    // 3. Calibrate uncalibrated accepted probes (or all accepted if --recalibrate)
    const probesToCalibrate = evalStore.listProbes({
      status: "accepted",
      executionRunId: buildResult.runId,
      probeTypes: options.probeTypes,
      ...(options.recalibrate ? {} : { difficulty: "uncalibrated" }),
    });

    let calibrateResult: RunProbeCalibrationSummary | { skipped: true; reason: string };
    if (probesToCalibrate.length === 0) {
      calibrateResult = { skipped: true, reason: "全部已通过考题均已标定难度" };
      options.onProgress?.("[eval make 3/4] 跳过标定：无待标定考题");
    } else {
      const calBundle = await loadCalibrationPromptBundle({
        promptsDir: options.promptsDir,
        skillsDir: options.skillsDir,
      });
      const barePi = options.runBareModel
        ? undefined
        : readPiConfig({ ...process.env, ...(options.bareModel ? { LLM_MODEL: options.bareModel } : {}) });
      const graderPi = options.runGrader
        ? undefined
        : readEvalPiConfig({ ...process.env, ...(options.graderModel ? { EVAL_LLM_MODEL: options.graderModel } : {}) });

      const bareModelId = options.bareModel ?? barePi?.modelId ?? options.modelId ?? "bare-model";
      const graderModelId = options.graderModel ?? graderPi?.modelId ?? options.modelId ?? "grader-model";
      const runBareModel = options.runBareModel ?? createPiRunner(barePi!);
      const runGrader = options.runGrader ?? createPiRunner(graderPi!);

      options.onProgress?.(
        `[eval make 3/4] 开始难度标定（${probesToCalibrate.length} 题，bare=${bareModelId}，grader=${graderModelId}）...`,
      );
      calibrateResult = await runProbeCalibration({
        evalStore,
        probes: probesToCalibrate,
        prompts: calBundle.prompts,
        skills: calBundle.skills,
        bareModelId,
        graderModelId,
        runBareModel,
        runGrader,
        recalibrate: options.recalibrate,
        concurrency,
        callMaxAttempts,
        callRetryDelayMs,
        signal,
        onProgress: options.onProgress,
      });
    }

    throwIfAborted(signal);
    // 4. Freeze suite (unless --no-freeze)
    let freezeResult: FreezeSuiteReport | { skipped: true; reason: string };
    if (options.noFreeze) {
      freezeResult = { skipped: true, reason: "指定了 --no-freeze" };
      options.onProgress?.("[eval make 4/4] 跳过冻结（--no-freeze）");
    } else {
      options.onProgress?.(`[eval make 4/4] 冻结套卷 "${options.suiteName}"...`);
      freezeResult = await freezeEvalSuite({
        evalStore,
        name: options.suiteName!,
        executionRunId: buildResult.runId,
        allowPartialBuild: options.allowPartialBuild,
        signal,
        probeTypes: options.probeTypes,
        maxEasyRatio: options.maxEasyRatio ?? DEFAULT_MAX_EASY_RATIO,
        allowUncalibrated: options.allowUncalibrated,
        allowActiveRuns: options.allowActiveRuns,
        mainDbPath,
        failOnTrainSim: options.failOnTrainSim,
        exportPath: options.exportPath ? resolve(options.exportPath) : undefined,
        manifestOutPath: options.manifestOutPath ? resolve(options.manifestOutPath) : undefined,
      });
    }

    return {
      action: "make",
      evalDb: evalDbPath,
      mainDb: mainDbPath,
      import: importReport,
      partial,
      exitCode: 0,
      build: buildResult,
      calibrate: calibrateResult,
      freeze: freezeResult,
    };
  } finally {
    evalStore.close();
  }
}

export interface EvaluateCandidateWorkflowOptions {
  evalDbPath?: string;
  suiteName: string;
  candidate: string;
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
  historyMode?: EvalHistoryMode;
  systemPrompt?: string;
  systemPromptFile?: string;
  noSystemPrompt?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  resumeRunId?: number;
  limit?: number;
  graderModel?: string;
  allowSameModel?: boolean;
  regrade?: boolean;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  outPath?: string;
  jsonOutPath?: string;
  promptsDir?: string;
  skillsDir?: string;
  candidateFactory?: CandidateFactory;
  runCandidate?: CandidateRunner;
  candidateSpecHash?: string;
  stripThinkTags?: boolean;
  parentRunId?: number;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runGrader?: RoleRunner;
  onProgress?: (message: string) => void;
}

export interface EvaluateCandidateWorkflowResult {
  action: "evaluate";
  evalDb: string;
  run: RunSuiteEvaluationSummary;
  grade: GradeEvalRunSummary;
  reportOutPath?: string;
  jsonOutPath?: string;
}

export async function evaluateEvalCandidateWorkflow(
  options: EvaluateCandidateWorkflowOptions,
): Promise<EvaluateCandidateWorkflowResult> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const suiteName = nonEmpty(options.suiteName, "--suite");
  const candidate = nonEmpty(options.candidate, "--candidate");

  const resolvedSys = await resolveCandidateSystemPrompt({
    systemPrompt: options.systemPrompt,
    systemPromptFile: options.systemPromptFile,
    noSystemPrompt: options.noSystemPrompt,
    isResuming: options.resumeRunId !== undefined,
  });

  const calBundle = await loadCalibrationPromptBundle({
    promptsDir: options.promptsDir,
    skillsDir: options.skillsDir,
  });
  const graderPi = options.runGrader
    ? undefined
    : readEvalPiConfig({ ...process.env, ...(options.graderModel ? { EVAL_LLM_MODEL: options.graderModel } : {}) });
  const graderModelId = options.graderModel ?? graderPi?.modelId ?? "injected-grader-model";
  const runGrader = options.runGrader ?? createPiRunner(graderPi!);

  const evalStore = new EvalStore(evalDbPath);
  try {
    const signal = combineSignals(evalStore.signal, options.signal);
    throwIfAborted(signal);
    options.onProgress?.(`[eval evaluate 1/2] 候选模型 "${candidate}" 盲测套卷 "${suiteName}"...`);
    const runSummary = await runSuiteEvaluation({
      evalStore,
      suiteName,
      candidate,
      modelId: options.modelId,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      historyMode: options.historyMode,
      systemPrompt: resolvedSys.systemPrompt,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      candidateFactory: options.candidateFactory,
      runCandidate: options.runCandidate,
      candidateSpecHash: options.candidateSpecHash,
      stripThinkTags: options.stripThinkTags,
      parentRunId: options.parentRunId,
      environment: options.environment,
      signal,
      resumeRunId: options.resumeRunId,
      limit: options.limit,
      concurrency: options.concurrency,
      callMaxAttempts: options.callMaxAttempts,
      callRetryDelayMs: options.callRetryDelayMs,
      onProgress: options.onProgress,
    });

    options.onProgress?.(`[eval evaluate 2/2] 批卷 eval_run #${runSummary.evalRunId}（裁判=${graderModelId}）...`);
    const gradeSummary = await gradeEvalRun({
      evalStore,
      evalRunId: runSummary.evalRunId,
      signal,
      graderPrompt: calBundle.prompts.evalGrader,
      runGrader,
      graderModelId,
      allowSameModel: options.allowSameModel,
      regrade: options.regrade,
      concurrency: options.concurrency,
      callMaxAttempts: options.callMaxAttempts,
      callRetryDelayMs: options.callRetryDelayMs,
      onProgress: options.onProgress,
    });

    let reportOutPath: string | undefined;
    let jsonOutPath: string | undefined;
    if (options.outPath || options.jsonOutPath) {
      const report = buildEvalReport({ evalStore, runIds: [runSummary.evalRunId] });
      if (options.outPath) {
        reportOutPath = await writeOutputFile(options.outPath, renderEvalReportMarkdown(report) + "\n");
      }
      if (options.jsonOutPath) {
        jsonOutPath = await writeOutputFile(options.jsonOutPath, JSON.stringify(report, null, 2) + "\n");
      }
    }

    return {
      action: "evaluate",
      evalDb: evalDbPath,
      run: runSummary,
      grade: gradeSummary,
      ...(reportOutPath ? { reportOutPath } : {}),
      ...(jsonOutPath ? { jsonOutPath } : {}),
    };
  } finally {
    evalStore.close();
  }
}

export async function buildEvalReportWorkflow(options: {
  evalDbPath?: string;
  suites?: string[];
  candidates?: string[];
  runIds?: number[];
  baselineCandidate?: string;
  historyMode?: EvalHistoryMode;
  topFailures?: number;
  outPath?: string;
  jsonOutPath?: string;
}): Promise<{ report: EvalComparisonReport; markdown: string; summary: Record<string, unknown> }> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const evalStore = new EvalStore(evalDbPath, { readOnly: true });
  try {
    const report = buildEvalReport({
      evalStore,
      suites: options.suites,
      candidates: options.candidates,
      runIds: options.runIds,
      baselineCandidate: options.baselineCandidate,
      historyMode: options.historyMode,
    });
    const markdown = renderEvalReportMarkdown(report, options.topFailures ?? 6);
    const outPath = options.outPath ? await writeOutputFile(options.outPath, markdown + "\n") : undefined;
    const jsonOutPath = options.jsonOutPath
      ? await writeOutputFile(options.jsonOutPath, JSON.stringify(report, null, 2) + "\n")
      : undefined;

    return {
      report,
      markdown,
      summary: {
        evalDb: evalDbPath,
        suites: report.suites,
        candidates: report.candidates,
        entryCount: report.entries.length,
        comparisonCount: report.comparisons.length,
        ...(outPath ? { outPath } : {}),
        ...(jsonOutPath ? { jsonOutPath } : {}),
      },
    };
  } finally {
    evalStore.close();
  }
}

export async function inspectEvalProbesWorkflow(options: {
  evalDbPath?: string;
  runSpec?: string;
  executionRunSpec?: string;
  status?: string;
  probeType?: ProbeType;
  sampleSize?: number;
  seed?: number;
  outPath?: string;
}): Promise<{ markdown: string; summary: Record<string, unknown> }> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const evalStore = new EvalStore(evalDbPath, { readOnly: true });
  try {
    if (options.runSpec !== undefined && options.executionRunSpec !== undefined) throw new Error("--run 与 --execution-run 只能指定一个");
    const runId = resolveProbeRunFilter(evalStore, options.runSpec);
    if (options.executionRunSpec === "all") throw new Error("--execution-run 必须是正整数或 latest");
    const executionRunId = resolveProbeRunFilter(evalStore, options.executionRunSpec);
    if (options.executionRunSpec === "latest" && executionRunId === undefined) throw new Error("尚无造题执行记录");
    const validStatuses: ProbeStatus[] = ["draft", "accepted", "rejected", "dropped"];
    const status =
      options.status && options.status !== "all"
        ? (validStatuses.includes(options.status as ProbeStatus)
            ? (options.status as ProbeStatus)
            : (() => {
                throw new Error(`未知 --status "${options.status}"（可选：draft/accepted/rejected/dropped/all）`);
              })())
        : undefined;

    const matched = evalStore.listProbes({
      runId,
      executionRunId,
      status,
      probeType: options.probeType,
    });
    const picked =
      options.sampleSize !== undefined
        ? stratifiedSampleProbes(matched, options.sampleSize, options.seed ?? 42)
        : matched;
    const markdown = renderInspectMarkdown(evalStore, runId, picked, matched.length, executionRunId);
    const outPath = options.outPath ? await writeOutputFile(options.outPath, markdown + "\n") : undefined;

    return {
      markdown,
      summary: {
        evalDb: evalDbPath,
        runId: runId ?? "all",
        executionRunId: executionRunId ?? null,
        matched: matched.length,
        displayed: picked.length,
        ...(outPath ? { outPath } : {}),
      },
    };
  } finally {
    evalStore.close();
  }
}

export function listEvalSuitesWorkflow(options: { evalDbPath?: string } = {}): EvalStoreSummary & {
  evalDb: string;
  recentEvalRuns: Array<{
    id: number;
    suiteName: string;
    candidate: string;
    model: string;
    historyMode: EvalHistoryMode;
    status: string;
    startedAt: string;
  }>;
} {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const evalStore = new EvalStore(evalDbPath, { readOnly: true });
  try {
    const summary = evalStore.getSummary();
    const recentEvalRuns = evalStore
      .listEvalRuns()
      .slice(-20)
      .reverse()
      .map((r) => ({
        id: r.id,
        suiteName: r.suiteName,
        candidate: r.candidate,
        model: r.model,
        historyMode: r.historyMode,
        status: r.status,
        startedAt: r.startedAt,
      }));
    return {
      evalDb: evalDbPath,
      ...summary,
      recentEvalRuns,
    };
  } finally {
    evalStore.close();
  }
}
