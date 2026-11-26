import { parseArgs } from "node:util";
import {
  parseFloatOpt,
  parseIdList,
  parseIntOpt,
  parseNonNegativeInt,
  parsePositiveInt,
  splitCsvOpt,
} from "../shared/cli-helpers.js";
import { nonEmpty } from "../shared/schema.js";
import { parseProbeMix } from "../eval/probe-planner.js";
import {
  EVAL_BUILD_PRESETS,
  EVAL_IMPORT_PRESETS,
  EVAL_RUN_PRESETS,
  resolveEvalBuildPreset,
  resolveEvalImportPreset,
  resolveEvalRunPreset,
} from "../eval/presets.js";
import {
  buildEvalProbesWorkflow,
  buildEvalReportWorkflow,
  calibrateEvalProbesWorkflow,
  evaluateEvalCandidateWorkflow,
  freezeEvalSuiteWorkflow,
  getEvalStatusWorkflow,
  gradeEvalRunWorkflow,
  importEvalSourcesWorkflow,
  initEvalStoreWorkflow,
  inspectEvalProbesWorkflow,
  mirrorEvalSuiteWorkflow,
  parseEvalHistoryMode,
  parseEvalProfile,
  parseProbeTypeFilter,
  runEvalCandidateWorkflow,
} from "../eval/workflows.js";

const EVAL_HELP = `独立评测库与对抗/陷阱测试集流水线（npm run dm -- eval <子命令>）

子命令：
  init       初始化独立评测库 data/eval.sqlite
  status     查看评测库状态（材料快照、考题统计、难度分层、套卷版本、评测记录）
  mirror     从主库只读镜像冻结 test 版本到评测库（如 test-v1 -> indist-v1）
  import     从主库 test 分区只读导入视频文稿快照（支持 --preset test-fresh）
  build      运行对抗/陷阱 Probe 构建循环（支持 --preset adv-full | adv-fast | trap）
  calibrate  通用模型无原稿裸答 + 语义批卷，为已通过考题标定 easy/medium/hard 难度
  freeze     冻结不可变对抗测试套卷（并发守卫 + 难度上限 + 分区复核 + 训练集相似度审计）
  run        对冻结套卷运行候选模型脱稿盲测（支持 --preset blind-gold | blind-self）
  grade      对候选模型预测结果执行脱稿批卷
  evaluate   一键串联 run + grade（可选 --out 直接输出报告，支持 --preset blind-gold | blind-self）
  report     按套卷 × 候选模型 × 题型 × 预期行为 × 难度汇总对比报告
  compare    对比两个候选模型（--baseline vs --target）增量 Δ 与逐题胜负
  inspect    导出或查看考题抽检报告（支持 --run all、--type、--sample）

内置预设一览：
  import:   ${Object.values(EVAL_IMPORT_PRESETS).map((p) => `${p.name} (${p.description})`).join("\n            ")}
  build:    ${Object.values(EVAL_BUILD_PRESETS).map((p) => `${p.name} (${p.description})`).join("\n            ")}
  run/eval: ${Object.values(EVAL_RUN_PRESETS).map((p) => `${p.name} (${p.description})`).join("\n            ")}

常用示例：
  npm run dm -- eval init
  npm run dm -- eval mirror --from-version test-v1 --as indist-v1
  npm run dm -- eval import --preset test-fresh
  npm run dm -- eval build --preset adv-full
  npm run dm -- eval build --preset trap
  npm run dm -- eval calibrate --run all --concurrency 8 --out output/eval/calibration-report.md
  npm run dm -- eval freeze --name adv-main-v1 --export output/eval/adv-main-v1.jsonl --manifest-out output/eval/adv-main-v1.manifest.json
  npm run dm -- eval evaluate --preset blind-gold --suite adv-main-v1 --candidate sft-v2 --out output/eval/sft-v2.md
  npm run dm -- eval compare --suites indist-v1,adv-main-v1 --baseline base --target sft-v2 --out output/eval/compare.md
`;

export async function runEvalCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(EVAL_HELP);
    return;
  }

  const sub = args[0]!;
  const rest = args.slice(1);

  if (sub === "init") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    console.log(JSON.stringify(initEvalStoreWorkflow({
      evalDbPath: values["eval-db"],
      mainDbPath: values["main-db"],
    }), null, 2));
    return;
  }

  if (sub === "status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    console.log(JSON.stringify(getEvalStatusWorkflow({ evalDbPath: values["eval-db"] }), null, 2));
    return;
  }

  if (sub === "mirror") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        "from-version": { type: "string" },
        as: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    console.log(JSON.stringify(mirrorEvalSuiteWorkflow({
      evalDbPath: values["eval-db"],
      mainDbPath: values["main-db"],
      fromVersion: nonEmpty(values["from-version"], "--from-version"),
      asSuiteName: nonEmpty(values.as, "--as"),
    }), null, 2));
    return;
  }

  if (sub === "import") {
    const { values } = parseArgs({
      args: rest,
      options: {
        preset: { type: "string" },
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        "input-dir": { type: "string" },
        "from-main-materials": { type: "boolean", default: false },
        videos: { type: "string" },
        limit: { type: "string" },
        shuffle: { type: "boolean", default: false },
        seed: { type: "string" },
        "exclude-used": { type: "boolean", default: false },
        "max-chunk-chars": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    const preset = resolveEvalImportPreset(values.preset);
    const report = await importEvalSourcesWorkflow({
      evalDbPath: values["eval-db"],
      mainDbPath: values["main-db"],
      inputDir: values["input-dir"],
      fromMainMaterials: values["from-main-materials"],
      videoKeys: splitCsvOpt(values.videos),
      limit: parsePositiveInt(values.limit, "--limit") ?? preset?.limit,
      shuffle: values.shuffle || Boolean(preset?.shuffle),
      seed: parseIntOpt(values.seed, "--seed") ?? preset?.seed,
      excludeUsed: values["exclude-used"] || Boolean(preset?.excludeUsed),
      maxChunkChars: parsePositiveInt(values["max-chunk-chars"], "--max-chunk-chars"),
    });
    console.log(JSON.stringify({ ...(preset ? { preset: preset.name } : {}), ...report }, null, 2));
    return;
  }

  if (sub === "build") {
    const { values } = parseArgs({
      args: rest,
      options: {
        preset: { type: "string" },
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        "skip-main-verify": { type: "boolean", default: false },
        profile: { type: "string" },
        videos: { type: "string" },
        limit: { type: "string" },
        shuffle: { type: "boolean", default: false },
        "probes-per-video": { type: "string" },
        mix: { type: "string" },
        seed: { type: "string" },
        "max-critic-revisions": { type: "string" },
        "max-bare-refinements": { type: "string" },
        "no-bare-check": { type: "boolean", default: false },
        "bare-model": { type: "string" },
        "max-attempts": { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    const preset = resolveEvalBuildPreset(values.preset);
    const profile = parseEvalProfile(values.profile) ?? preset?.profile ?? "adversarial";
    const bareCheck = values["no-bare-check"] ? false : (preset?.bareCheck ?? true);
    const report = await buildEvalProbesWorkflow({
      evalDbPath: values["eval-db"],
      mainDbPath: values["main-db"],
      skipMainVerify: values["skip-main-verify"],
      profile,
      videosSpec: values.videos,
      limit: parsePositiveInt(values.limit, "--limit"),
      shuffle: values.shuffle,
      probesPerVideo: parsePositiveInt(values["probes-per-video"], "--probes-per-video") ?? preset?.probesPerVideo,
      mix: values.mix !== undefined ? parseProbeMix(values.mix) : undefined,
      seed: parseIntOpt(values.seed, "--seed"),
      maxCriticRevisions: parseNonNegativeInt(values["max-critic-revisions"], "--max-critic-revisions"),
      maxBareRefinements: parseNonNegativeInt(values["max-bare-refinements"], "--max-bare-refinements") ?? preset?.maxBareRefinements,
      bareCheck,
      bareModel: values["bare-model"],
      maxAnswerAttempts: parsePositiveInt(values["max-attempts"], "--max-attempts"),
      concurrency: parsePositiveInt(values.concurrency, "--concurrency") ?? preset?.concurrency,
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify({ ...(preset ? { preset: preset.name } : {}), ...report }, null, 2));
    return;
  }

  if (sub === "calibrate") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        run: { type: "string" },
        profile: { type: "string" },
        type: { type: "string" },
        "only-uncalibrated": { type: "boolean", default: false },
        "report-only": { type: "boolean", default: false },
        limit: { type: "string" },
        model: { type: "string" },
        "grader-model": { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    const report = await calibrateEvalProbesWorkflow({
      evalDbPath: values["eval-db"],
      runSpec: values.run,
      profile: parseEvalProfile(values.profile),
      probeType: parseProbeTypeFilter(values.type),
      onlyUncalibrated: values["only-uncalibrated"],
      reportOnly: values["report-only"],
      limit: parsePositiveInt(values.limit, "--limit"),
      bareModel: values.model,
      graderModel: values["grader-model"],
      concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      outPath: values.out,
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (sub === "freeze") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        name: { type: "string" },
        run: { type: "string" },
        profile: { type: "string" },
        "max-easy-ratio": { type: "string" },
        "allow-uncalibrated": { type: "boolean", default: false },
        "allow-active-runs": { type: "boolean", default: false },
        "skip-main-verify": { type: "boolean", default: false },
        "fail-on-train-sim": { type: "string" },
        export: { type: "string" },
        "manifest-out": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    const report = await freezeEvalSuiteWorkflow({
      evalDbPath: values["eval-db"],
      mainDbPath: values["main-db"],
      name: nonEmpty(values.name, "--name"),
      runSpec: values.run,
      profile: parseEvalProfile(values.profile),
      maxEasyRatio: parseFloatOpt(values["max-easy-ratio"], "--max-easy-ratio"),
      allowUncalibrated: values["allow-uncalibrated"],
      allowActiveRuns: values["allow-active-runs"],
      skipMainVerify: values["skip-main-verify"],
      failOnTrainSim: parseFloatOpt(values["fail-on-train-sim"], "--fail-on-train-sim"),
      exportPath: values.export,
      manifestOutPath: values["manifest-out"],
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (sub === "run" || sub === "evaluate") {
    const isOneShot = sub === "evaluate";
    const { values } = parseArgs({
      args: rest,
      options: {
        preset: { type: "string" },
        "eval-db": { type: "string" },
        suite: { type: "string" },
        candidate: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "api-key": { type: "string" },
        "history-mode": { type: "string" },
        "system-prompt": { type: "string" },
        "system-prompt-file": { type: "string" },
        "no-system-prompt": { type: "boolean", default: false },
        temperature: { type: "string" },
        "max-tokens": { type: "string" },
        "timeout-ms": { type: "string" },
        "resume-run": { type: "string" },
        limit: { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        ...(isOneShot
          ? {
              "grade-concurrency": { type: "string" },
              "grader-model": { type: "string" },
              "allow-same-model": { type: "boolean", default: false },
              regrade: { type: "boolean", default: false },
              out: { type: "string" },
            }
          : {}),
        help: { type: "boolean", short: "h", default: false },
      } as const,
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    const preset = resolveEvalRunPreset(values.preset as string | undefined);
    const historyMode = values["history-mode"] !== undefined
      ? parseEvalHistoryMode(values["history-mode"] as string)
      : (preset?.historyMode ?? "gold");
    const concurrency = parsePositiveInt(values.concurrency as string | undefined, "--concurrency") ?? preset?.concurrency;

    const baseOpts = {
      evalDbPath: values["eval-db"] as string | undefined,
      suiteName: nonEmpty(values.suite as string | undefined, "--suite"),
      candidate: nonEmpty(values.candidate as string | undefined, "--candidate"),
      model: values.model as string | undefined,
      baseUrl: values["base-url"] as string | undefined,
      apiKey: values["api-key"] as string | undefined,
      historyMode,
      systemPrompt: values["system-prompt"] as string | undefined,
      systemPromptFile: values["system-prompt-file"] as string | undefined,
      noSystemPrompt: Boolean(values["no-system-prompt"]),
      temperature: parseFloatOpt(values.temperature as string | undefined, "--temperature"),
      maxTokens: parsePositiveInt(values["max-tokens"] as string | undefined, "--max-tokens"),
      timeoutMs: parsePositiveInt(values["timeout-ms"] as string | undefined, "--timeout-ms"),
      resumeRunId: parsePositiveInt(values["resume-run"] as string | undefined, "--resume-run"),
      limit: parsePositiveInt(values.limit as string | undefined, "--limit"),
      concurrency,
      callMaxAttempts: parsePositiveInt(values["call-attempts"] as string | undefined, "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"] as string | undefined, "--retry-delay-ms"),
      onProgress: (msg: string) => console.error(msg),
    };

    const report = isOneShot
      ? await evaluateEvalCandidateWorkflow({
          ...baseOpts,
          gradeConcurrency: parsePositiveInt(
            (values as Record<string, unknown>)["grade-concurrency"] as string | undefined,
            "--grade-concurrency",
          ),
          graderModel: (values as Record<string, unknown>)["grader-model"] as string | undefined,
          allowSameModel: Boolean((values as Record<string, unknown>)["allow-same-model"]),
          regrade: Boolean((values as Record<string, unknown>).regrade),
          outPath: (values as Record<string, unknown>).out as string | undefined,
        })
      : await runEvalCandidateWorkflow(baseOpts);

    console.log(JSON.stringify({ ...(preset ? { preset: preset.name } : {}), ...report }, null, 2));
    return;
  }

  if (sub === "grade") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        run: { type: "string" },
        "grader-model": { type: "string" },
        "allow-same-model": { type: "boolean", default: false },
        regrade: { type: "boolean", default: false },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }
    const report = await gradeEvalRunWorkflow({
      evalDbPath: values["eval-db"],
      runSpec: values.run,
      graderModel: values["grader-model"],
      allowSameModel: values["allow-same-model"],
      regrade: values.regrade,
      concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (sub === "report" || sub === "compare") {
    const isCompare = sub === "compare";
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        suites: { type: "string" },
        candidates: { type: "string" },
        runs: { type: "string" },
        baseline: { type: "string" },
        target: { type: "string" },
        "history-mode": { type: "string" },
        "top-failures": { type: "string" },
        out: { type: "string" },
        "json-out": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }

    let candidates = splitCsvOpt(values.candidates);
    let baselineCandidate = values.baseline?.trim();
    if (isCompare) {
      baselineCandidate = nonEmpty(values.baseline, "--baseline");
      const target = nonEmpty(values.target, "--target");
      candidates = [baselineCandidate, target];
    }

    const built = await buildEvalReportWorkflow({
      evalDbPath: values["eval-db"],
      suites: splitCsvOpt(values.suites),
      candidates,
      runIds: parseIdList(values.runs, "--runs"),
      baselineCandidate,
      historyMode: values["history-mode"] !== undefined ? parseEvalHistoryMode(values["history-mode"]) : undefined,
      topFailures: parsePositiveInt(values["top-failures"], "--top-failures"),
      outPath: values.out,
      jsonOutPath: values["json-out"],
    });

    if (values.out || values["json-out"]) {
      console.log(JSON.stringify(built.summary, null, 2));
    } else {
      console.log(built.markdown);
    }
    return;
  }

  if (sub === "inspect") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        run: { type: "string" },
        profile: { type: "string" },
        status: { type: "string" },
        type: { type: "string" },
        sample: { type: "string" },
        seed: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(EVAL_HELP); return; }

    const inspected = await inspectEvalProbesWorkflow({
      evalDbPath: values["eval-db"],
      runSpec: values.run,
      profile: parseEvalProfile(values.profile),
      status: values.status,
      probeType: parseProbeTypeFilter(values.type),
      sampleSize: parsePositiveInt(values.sample, "--sample"),
      seed: parseIntOpt(values.seed, "--seed"),
      outPath: values.out,
    });

    if (values.out) {
      console.log(JSON.stringify(inspected.summary, null, 2));
    } else {
      console.log(inspected.markdown);
    }
    return;
  }

  throw new Error(`未知 eval 子命令：${sub}（运行 npm run dm -- eval --help 查看可用命令）`);
}
