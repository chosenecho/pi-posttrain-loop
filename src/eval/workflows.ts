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
import { nonEmpty, validateConcurrency, validateMaxAttempts } from "../shared/schema.js";
import { createSeededRng, shuffleInPlace } from "../shared/utils.js";
import {
  renderCalibrationReportMarkdown,
  runProbeCalibration,
  summarizeCalibrationFromStore,
} from "./calibrate.js";
import { createOpenAiCandidateRunner, readCandidateConfig } from "./candidate-client.js";
import { gradeEvalRun } from "./eval-grader.js";
import {
  loadCalibrationPromptBundle,
  loadEvalPromptBundle,
  resolveCandidateSystemPrompt,
} from "./eval-prompts.js";
import { runSuiteEvaluation } from "./eval-runner.js";
import { renderInspectMarkdown, stratifiedSampleProbes } from "./inspect.js";
import {
  DEFAULT_MAX_ANSWER_ATTEMPTS,
  DEFAULT_MAX_BARE_REFINEMENTS,
  DEFAULT_MAX_CRITIC_REVISIONS,
  DEFAULT_PROBES_PER_VIDEO,
  runProbeBuild,
} from "./probe-loop.js";
import { DEFAULT_TRAP_PROBE_MIX } from "./probe-planner.js";
import { buildEvalReport, renderEvalReportMarkdown } from "./report.js";
import { importTestSources, mirrorMainVersion } from "./source-import.js";
import {
  EvalStore,
  PROBE_TYPES,
  probeTypesForProfile,
  type EvalHistoryMode,
  type EvalProfile,
  type ProbeStatus,
  type ProbeType,
} from "./store/index.js";
import { DEFAULT_MAX_EASY_RATIO, freezeAdversarialSuite } from "./suite-freeze.js";

function requireEvalDbExists(evalDbPath: string): void {
  if (!existsSync(evalDbPath)) {
    throw new Error(`评测库不存在：${evalDbPath}（请先运行 npm run dm -- eval init）`);
  }
}

export function parseEvalProfile(raw: string | undefined): EvalProfile | undefined {
  if (raw === undefined) return undefined;
  const profile = raw.trim();
  if (profile !== "adversarial" && profile !== "trap") {
    throw new Error(`--profile 必须是 adversarial 或 trap（实际 ${profile}）`);
  }
  return profile;
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

function resolveProbeRunFilter(store: EvalStore, raw: string | undefined, defaultToLatest: boolean): number | undefined {
  if (raw === undefined) {
    return defaultToLatest ? store.latestRunId("probe_build") : undefined;
  }
  if (raw === "latest") return store.latestRunId("probe_build");
  if (raw === "all") return undefined;
  const id = Number(raw.trim());
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`--run 必须是正整数、latest 或 all（实际 ${raw}）`);
  }
  return id;
}

export function initEvalStoreWorkflow(options: { evalDbPath?: string; mainDbPath?: string } = {}): Record<string, unknown> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  const mainDbPath = resolve(options.mainDbPath ?? DEFAULT_MAIN_DB);
  const store = new EvalStore(evalDbPath);
  try {
    store.setMeta("main_db_path", mainDbPath);
    return {
      action: "init",
      evalDb: evalDbPath,
      mainDb: mainDbPath,
      ...store.getSummary(),
    };
  } finally {
    store.close();
  }
}

export function getEvalStatusWorkflow(options: { evalDbPath?: string } = {}): Record<string, unknown> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const store = new EvalStore(evalDbPath, { readOnly: true });
  try {
    return { evalDb: evalDbPath, ...store.getSummary() };
  } finally {
    store.close();
  }
}

export function mirrorEvalSuiteWorkflow(options: {
  evalDbPath?: string;
  mainDbPath?: string;
  fromVersion: string;
  asSuiteName: string;
}): Record<string, unknown> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  const mainDbPath = resolve(options.mainDbPath ?? DEFAULT_MAIN_DB);
  const fromVersion = nonEmpty(options.fromVersion, "--from-version");
  const asSuiteName = nonEmpty(options.asSuiteName, "--as");
  const store = new EvalStore(evalDbPath);
  try {
    store.setMeta("main_db_path", mainDbPath);
    const report = mirrorMainVersion({
      evalStore: store,
      mainDbPath,
      fromVersion,
      asSuiteName,
    });
    return { evalDb: evalDbPath, mainDb: mainDbPath, ...report };
  } finally {
    store.close();
  }
}

export async function importEvalSourcesWorkflow(options: {
  evalDbPath?: string;
  mainDbPath?: string;
  inputDir?: string;
  fromMainMaterials?: boolean;
  videoKeys?: string[];
  limit?: number;
  shuffle?: boolean;
  seed?: number;
  excludeUsed?: boolean;
  maxChunkChars?: number;
}): Promise<Record<string, unknown>> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  const mainDbPath = resolve(options.mainDbPath ?? DEFAULT_MAIN_DB);
  const inputDir = options.fromMainMaterials
    ? undefined
    : resolve(options.inputDir ?? DEFAULT_CORPUS_DIR);
  const store = new EvalStore(evalDbPath);
  try {
    store.setMeta("main_db_path", mainDbPath);
    const report = await importTestSources({
      evalStore: store,
      mainDbPath,
      inputDir,
      videoKeys: options.videoKeys,
      limit: options.limit,
      shuffle: Boolean(options.shuffle),
      seed: options.seed,
      excludeUsed: Boolean(options.excludeUsed),
      maxChunkChars: options.maxChunkChars,
    });
    return { evalDb: evalDbPath, mainDb: mainDbPath, ...report };
  } finally {
    store.close();
  }
}

export async function buildEvalProbesWorkflow(options: {
  evalDbPath?: string;
  mainDbPath?: string;
  skipMainVerify?: boolean;
  profile?: EvalProfile;
  videosSpec?: string;
  limit?: number;
  shuffle?: boolean;
  probesPerVideo?: number;
  mix?: Partial<Record<ProbeType, number>>;
  seed?: number;
  maxCriticRevisions?: number;
  maxBareRefinements?: number;
  bareCheck?: boolean;
  bareModel?: string;
  maxAnswerAttempts?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  onProgress?: (message: string) => void;
}): Promise<Record<string, unknown>> {
  const profile: EvalProfile = options.profile ?? "adversarial";
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  const mainDbPath = options.skipMainVerify
    ? undefined
    : resolve(options.mainDbPath ?? DEFAULT_MAIN_DB);
  const videosSpec = (options.videosSpec ?? "imported").trim();
  const defaultProbesPerVideo = profile === "trap" ? 3 : DEFAULT_PROBES_PER_VIDEO;
  const probesPerVideo = options.probesPerVideo ?? defaultProbesPerVideo;
  const mix = options.mix ?? (profile === "trap" ? { ...DEFAULT_TRAP_PROBE_MIX } : undefined);
  const maxCriticRevisions = options.maxCriticRevisions ?? DEFAULT_MAX_CRITIC_REVISIONS;
  const maxBareRefinements = options.maxBareRefinements ?? DEFAULT_MAX_BARE_REFINEMENTS;
  const maxAnswerAttempts = validateMaxAttempts(options.maxAnswerAttempts ?? DEFAULT_MAX_ANSWER_ATTEMPTS);
  const concurrency = validateConcurrency(options.concurrency ?? 1);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const bundle = await loadEvalPromptBundle({ profile });
  if (!bundle.allReady) {
    throw new Error(`存在未就绪的 eval Skill（profile=${profile}），无法启动正式评测考题构建`);
  }
  const config = readEvalPiConfig();
  const runRole = createPiRunner(config);

  const bareCheckEnabled = options.bareCheck ?? true;
  let runBareModel: ReturnType<typeof createPiRunner> | undefined;
  let barePrompt: string | undefined;
  let bareModelId: string | undefined;
  if (bareCheckEnabled) {
    const calBundle = await loadCalibrationPromptBundle();
    barePrompt = calBundle.prompts.bareAnswer;
    bareModelId = options.bareModel?.trim() || config.modelId;
    runBareModel = createPiRunner({ ...config, modelId: bareModelId });
  }

  const store = new EvalStore(evalDbPath);
  try {
    let sources = videosSpec === "imported"
      ? store.listUnbuiltSourceMaterials(probeTypesForProfile(profile))
      : videosSpec === "all"
        ? store.listSourceMaterials()
        : store.listSourceMaterialsByVideoKeys(videosSpec.split(",").map((s) => s.trim()).filter(Boolean));

    if (options.shuffle && sources.length > 1) {
      const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
      sources = shuffleInPlace([...sources], rng);
    }
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit 必须是正整数");
      }
      sources = sources.slice(0, options.limit);
    }
    if (sources.length === 0) {
      throw new Error(`未找到符合条件（--profile ${profile}, --videos ${videosSpec}）的材料快照，请先运行 npm run dm -- eval import`);
    }

    options.onProgress?.(
      `=== 对抗考题 Agent Loop 构建（profile=${profile}，${sources.length} 份材料，单篇上限 ${probesPerVideo} 题，裸答回流=${bareCheckEnabled ? bareModelId : "off"}，并发 ${concurrency}，模型 ${config.modelId}）===`,
    );
    const summary = await runProbeBuild({
      evalStore: store,
      sources,
      mainDbPath,
      profile,
      prompts: bundle.prompts,
      skills: bundle.skills,
      runRole,
      modelId: config.modelId,
      probesPerVideo,
      mix,
      seed: options.seed,
      maxCriticRevisions,
      maxAnswerAttempts,
      ...(runBareModel && barePrompt ? { runBareModel, barePrompt, bareModelId, maxBareRefinements } : {}),
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      onProgress: options.onProgress,
    });
    return { evalDb: evalDbPath, ...summary };
  } finally {
    store.close();
  }
}

export async function calibrateEvalProbesWorkflow(options: {
  evalDbPath?: string;
  runSpec?: string;
  profile?: EvalProfile;
  probeType?: ProbeType;
  onlyUncalibrated?: boolean;
  reportOnly?: boolean;
  limit?: number;
  bareModel?: string;
  graderModel?: string;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  outPath?: string;
  onProgress?: (message: string) => void;
}): Promise<Record<string, unknown>> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const probeTypesFilter = options.profile ? probeTypesForProfile(options.profile) : undefined;

  if (options.reportOnly) {
    const store = new EvalStore(evalDbPath, { readOnly: true });
    try {
      const runFilter = resolveProbeRunFilter(store, options.runSpec, true);
      let probes = store.listProbes({
        runId: runFilter,
        status: "accepted",
        probeType: options.probeType,
        probeTypes: probeTypesFilter,
      });
      if (options.limit !== undefined) {
        if (options.limit < 1) throw new Error("--limit 必须是正整数");
        probes = probes.slice(0, options.limit);
      }
      if (probes.length === 0) {
        throw new Error("未找到符合条件的已通过考题（accepted probes）可供汇总");
      }
      const summary = summarizeCalibrationFromStore({ evalStore: store, probes });
      const reportPath = options.outPath
        ? await writeOutputFile(nonEmpty(options.outPath, "--out"), renderCalibrationReportMarkdown(summary))
        : undefined;
      const { items: _items, ...compactSummary } = summary;
      return {
        evalDb: evalDbPath,
        reportOnly: true,
        ...compactSummary,
        ...(reportPath ? { reportPath } : {}),
      };
    } finally {
      store.close();
    }
  }

  const concurrency = validateConcurrency(options.concurrency ?? 1);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const bundle = await loadCalibrationPromptBundle();
  if (!bundle.allReady) {
    throw new Error("eval-grader Skill 未就绪，无法执行难度标定");
  }

  const baseConfig = readPiConfig();
  const graderConfig = readEvalPiConfig();
  const bareModelId = options.bareModel?.trim() || baseConfig.modelId;
  const graderModelId = options.graderModel?.trim() || graderConfig.modelId;
  const runBareModel = createPiRunner({ ...baseConfig, modelId: bareModelId });
  const runGrader = createPiRunner({ ...graderConfig, modelId: graderModelId });

  const store = new EvalStore(evalDbPath);
  try {
    const runFilter = resolveProbeRunFilter(store, options.runSpec, true);
    let probes = store.listProbes({
      runId: runFilter,
      status: "accepted",
      probeType: options.probeType,
      probeTypes: probeTypesFilter,
      onlyUncalibrated: Boolean(options.onlyUncalibrated),
    });
    if (options.limit !== undefined) {
      if (options.limit < 1) throw new Error("--limit 必须是正整数");
      probes = probes.slice(0, options.limit);
    }
    if (probes.length === 0) {
      throw new Error("未找到符合条件的已通过考题（accepted probes）可供标定");
    }

    options.onProgress?.(
      `=== 难度标定（${probes.length} 道考题，裸答模型 ${bareModelId}，批卷模型 ${graderModelId}，并发 ${concurrency}）===`,
    );
    const summary = await runProbeCalibration({
      evalStore: store,
      probes,
      prompts: bundle.prompts,
      skills: bundle.skills,
      runBareModel,
      bareModelId,
      runGrader,
      graderModelId,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      onProgress: options.onProgress,
    });

    const reportPath = options.outPath
      ? await writeOutputFile(nonEmpty(options.outPath, "--out"), renderCalibrationReportMarkdown(summary))
      : undefined;
    const { items: _items, ...compactSummary } = summary;
    return {
      evalDb: evalDbPath,
      ...compactSummary,
      ...(reportPath ? { reportPath } : {}),
    };
  } finally {
    store.close();
  }
}

export async function freezeEvalSuiteWorkflow(options: {
  evalDbPath?: string;
  mainDbPath?: string;
  name: string;
  runSpec?: string;
  profile?: EvalProfile;
  maxEasyRatio?: number;
  allowUncalibrated?: boolean;
  allowActiveRuns?: boolean;
  skipMainVerify?: boolean;
  failOnTrainSim?: number;
  exportPath?: string;
  manifestOutPath?: string;
}): Promise<Record<string, unknown>> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const name = nonEmpty(options.name, "--name");
  const probeTypesFilter = options.profile ? probeTypesForProfile(options.profile) : undefined;
  const maxEasyRatio = options.maxEasyRatio ?? DEFAULT_MAX_EASY_RATIO;
  const mainDbPath = options.skipMainVerify
    ? undefined
    : resolve(options.mainDbPath ?? DEFAULT_MAIN_DB);
  const exportPath = options.exportPath ? resolve(nonEmpty(options.exportPath, "--export")) : undefined;
  const manifestOutPath = options.manifestOutPath
    ? resolve(nonEmpty(options.manifestOutPath, "--manifest-out"))
    : undefined;

  const store = new EvalStore(evalDbPath);
  try {
    const runId = resolveProbeRunFilter(store, options.runSpec, false);
    const report = await freezeAdversarialSuite({
      evalStore: store,
      name,
      runId,
      probeTypes: probeTypesFilter,
      maxEasyRatio,
      allowUncalibrated: Boolean(options.allowUncalibrated),
      allowActiveRuns: Boolean(options.allowActiveRuns),
      mainDbPath: mainDbPath && existsSync(mainDbPath) ? mainDbPath : undefined,
      failOnTrainSim: options.failOnTrainSim,
      exportPath,
      manifestOutPath,
    });
    return { evalDb: evalDbPath, ...report };
  } finally {
    store.close();
  }
}

export async function runEvalCandidateWorkflow(options: {
  evalDbPath?: string;
  suiteName: string;
  candidate: string;
  model?: string;
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
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  onProgress?: (message: string) => void;
}): Promise<Record<string, unknown> & { evalRunId: number }> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const suiteName = nonEmpty(options.suiteName, "--suite");
  const candidate = nonEmpty(options.candidate, "--candidate");
  const historyMode: EvalHistoryMode = options.historyMode ?? "gold";
  const concurrency = validateConcurrency(options.concurrency ?? 4);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const resolvedPrompt = await resolveCandidateSystemPrompt({
    systemPrompt: options.systemPrompt,
    systemPromptFile: options.systemPromptFile,
    noSystemPrompt: options.noSystemPrompt,
    isResuming: options.resumeRunId !== undefined,
  });
  const promptSourceLabel: Record<typeof resolvedPrompt.source, string> = {
    cli: "CLI(--system-prompt)",
    cli_file: "CLI(--system-prompt-file)",
    env: "ENV(CANDIDATE_LLM_SYSTEM_PROMPT)",
    env_file: "ENV(CANDIDATE_LLM_SYSTEM_PROMPT_FILE)",
    default_file: "默认(prompts/eval/candidate-system.md)",
    none: "无(--no-system-prompt)",
    resume_inherit: "继承原run",
  };

  const candidateConfig = readCandidateConfig({
    baseUrl: options.baseUrl,
    modelId: options.model,
    apiKey: options.apiKey,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
  });
  const runCandidate = createOpenAiCandidateRunner(candidateConfig);

  const store = new EvalStore(evalDbPath);
  try {
    options.onProgress?.(
      `=== 候选模型脱稿评测（suite=${suiteName}, candidate=${candidate}, model=${candidateConfig.modelId}, history=${historyMode}, systemPrompt=${promptSourceLabel[resolvedPrompt.source]}, 并发 ${concurrency}）===`,
    );
    const summary = await runSuiteEvaluation({
      evalStore: store,
      suiteName,
      candidate,
      modelId: candidateConfig.modelId,
      historyMode,
      systemPrompt: resolvedPrompt.systemPrompt,
      temperature: candidateConfig.temperature,
      maxTokens: candidateConfig.maxTokens,
      runCandidate,
      resumeRunId: options.resumeRunId,
      limit: options.limit,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      onProgress: options.onProgress,
    });
    return { evalDb: evalDbPath, ...summary };
  } finally {
    store.close();
  }
}

export async function gradeEvalRunWorkflow(options: {
  evalDbPath?: string;
  runSpec?: string;
  graderModel?: string;
  allowSameModel?: boolean;
  regrade?: boolean;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  onProgress?: (message: string) => void;
}): Promise<Record<string, unknown>> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const concurrency = validateConcurrency(options.concurrency ?? 4);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const bundle = await loadCalibrationPromptBundle();
  const baseConfig = readEvalPiConfig();
  const graderModelId = options.graderModel?.trim() || baseConfig.modelId;
  const runGrader = createPiRunner({ ...baseConfig, modelId: graderModelId });

  const store = new EvalStore(evalDbPath);
  try {
    let evalRunId: number | undefined;
    if (options.runSpec === undefined || options.runSpec === "latest") {
      evalRunId = store.latestEvalRunId();
    } else {
      const parsed = Number(options.runSpec.trim());
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`--run 必须是正整数或 latest（实际 ${options.runSpec}）`);
      }
      evalRunId = parsed;
    }
    if (evalRunId === undefined) {
      throw new Error("评测库中尚未有任何 eval_run，请先运行 npm run dm -- eval run");
    }

    options.onProgress?.(`=== 脱稿批卷（eval_run #${evalRunId}，裁判模型 ${graderModelId}，并发 ${concurrency}）===`);
    const summary = await gradeEvalRun({
      evalStore: store,
      evalRunId,
      graderPrompt: bundle.prompts.evalGrader,
      runGrader,
      graderModelId,
      allowSameModel: Boolean(options.allowSameModel),
      regrade: Boolean(options.regrade),
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      onProgress: options.onProgress,
    });
    return { evalDb: evalDbPath, ...summary };
  } finally {
    store.close();
  }
}

/**
 * One-shot candidate evaluation workflow: runs blind inference (`run`) and immediately grades (`grade`),
 * optionally writing a Markdown report (`--out`).
 */
export async function evaluateEvalCandidateWorkflow(options: {
  evalDbPath?: string;
  suiteName: string;
  candidate: string;
  model?: string;
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
  concurrency?: number;
  gradeConcurrency?: number;
  graderModel?: string;
  allowSameModel?: boolean;
  regrade?: boolean;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  outPath?: string;
  onProgress?: (message: string) => void;
}): Promise<Record<string, unknown>> {
  const runSummary = await runEvalCandidateWorkflow(options);
  const gradeSummary = await gradeEvalRunWorkflow({
    evalDbPath: options.evalDbPath,
    runSpec: String(runSummary.evalRunId),
    graderModel: options.graderModel,
    allowSameModel: options.allowSameModel,
    regrade: options.regrade,
    concurrency: options.gradeConcurrency ?? options.concurrency,
    callMaxAttempts: options.callMaxAttempts,
    callRetryDelayMs: options.callRetryDelayMs,
    onProgress: options.onProgress,
  });

  let reportInfo: Record<string, unknown> | undefined;
  if (options.outPath !== undefined) {
    const built = await buildEvalReportWorkflow({
      evalDbPath: options.evalDbPath,
      runIds: [runSummary.evalRunId],
      outPath: options.outPath,
    });
    reportInfo = built.summary;
  }

  return {
    run: runSummary,
    grade: gradeSummary,
    ...(reportInfo ? { report: reportInfo } : {}),
  };
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
}): Promise<{ markdown: string; summary: Record<string, unknown> }> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const topFailures = options.topFailures ?? 6;

  const store = new EvalStore(evalDbPath, { readOnly: true });
  try {
    const report = buildEvalReport({
      evalStore: store,
      suites: options.suites,
      candidates: options.candidates,
      runIds: options.runIds,
      historyMode: options.historyMode,
      baselineCandidate: options.baselineCandidate,
    });
    const markdown = renderEvalReportMarkdown(report, topFailures);

    const outPath = options.outPath
      ? await writeOutputFile(nonEmpty(options.outPath, "--out"), markdown)
      : undefined;
    const jsonOutPath = options.jsonOutPath
      ? await writeOutputFile(nonEmpty(options.jsonOutPath, "--json-out"), JSON.stringify(report, null, 2) + "\n")
      : undefined;

    const compactEntries = report.entries.map(({ items: _items, ...rest }) => rest);
    const summary: Record<string, unknown> = {
      evalDb: evalDbPath,
      suites: report.suites,
      candidates: report.candidates,
      ...(report.baselineCandidate ? { baselineCandidate: report.baselineCandidate } : {}),
      entries: compactEntries,
      comparisons: report.comparisons.map(({ topImproved: _ti, topRegressed: _tr, ...c }) => c),
      ...(outPath ? { outPath } : {}),
      ...(jsonOutPath ? { jsonOutPath } : {}),
    };
    return { markdown, summary };
  } finally {
    store.close();
  }
}

export async function inspectEvalProbesWorkflow(options: {
  evalDbPath?: string;
  runSpec?: string;
  profile?: EvalProfile;
  status?: string;
  probeType?: ProbeType;
  sampleSize?: number;
  seed?: number;
  outPath?: string;
}): Promise<{ markdown: string; summary: Record<string, unknown> }> {
  const evalDbPath = resolve(options.evalDbPath ?? DEFAULT_EVAL_DB);
  requireEvalDbExists(evalDbPath);
  const probeTypesFilter = options.profile ? probeTypesForProfile(options.profile) : undefined;

  const store = new EvalStore(evalDbPath, { readOnly: true });
  try {
    const runId = resolveProbeRunFilter(store, options.runSpec, true);
    const statusFilter = options.status && options.status !== "all"
      ? (options.status as ProbeStatus)
      : undefined;
    const matched = store.listProbes({
      runId,
      status: statusFilter,
      probeType: options.probeType,
      probeTypes: probeTypesFilter,
    });
    const seed = options.seed ?? 42;
    const selected = options.sampleSize !== undefined
      ? stratifiedSampleProbes(matched, options.sampleSize, seed)
      : matched;
    const markdown = renderInspectMarkdown(store, runId, selected, matched.length);
    const outPath = options.outPath
      ? await writeOutputFile(nonEmpty(options.outPath, "--out"), markdown)
      : undefined;
    return {
      markdown,
      summary: {
        ...(outPath ? { out: outPath } : {}),
        runId: runId ?? "all",
        totalMatched: matched.length,
        shown: selected.length,
      },
    };
  } finally {
    store.close();
  }
}
