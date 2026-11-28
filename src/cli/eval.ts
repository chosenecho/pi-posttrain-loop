import { resolve } from "node:path";
import { DEFAULT_EVAL_DB } from "../shared/paths.js";
import { migrateEvalDatabase } from "../eval/store/migration.js";
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
import {
  buildEvalReportWorkflow,
  evaluateEvalCandidateWorkflow,
  inspectEvalProbesWorkflow,
  listEvalSuitesWorkflow,
  makeEvalSuiteWorkflow,
  parseEvalHistoryMode,
  parseProbeTypeFilter,
  parseProbeTypeList,
} from "../eval/workflows.js";

const EVAL_HELP = `独立评测库与盲测流水线（npm run dm -- eval <子命令>）

子命令：
  make       一键造卷（导入 test 分区 → 出题核验 → 难度标定 → 冻结套卷；可断点续跑，--no-freeze 可只造题不冻结）
  evaluate   一键盲测（候选模型脱稿作答 + 批卷，可选 --out 直接输出报告）
  report     汇总已批卷评测报告（支持 --suites / --candidates / --out / --json-out）
  compare    对比两个候选模型（--baseline vs --target）分数 Δ 与逐题胜负
  inspect    抽检考题详情与评分卡（--run 按创建者；--execution-run <id|latest> 按执行关联）
  suites     只读查看评测库状态、所有已冻结套卷及最近评测记录
  migrate    显式升级评测库 v3→v4（--eval-db PATH --dry-run 或 --backup PATH）

常用示例：
  npm run dm -- eval make --suite eval-v1
  npm run dm -- eval make --suite eval-v1 --limit 10 --max-probes 4 --concurrency 6
  npm run dm -- eval make --no-freeze --limit 5
  npm run dm -- eval make --suite eval-v1 --resume-build 12
  npm run dm -- eval make --suite eval-v2 --rebuild
  npm run dm -- eval inspect --execution-run latest
  npm run dm -- eval migrate --eval-db data/eval.sqlite --dry-run
  npm run dm -- eval evaluate --suite eval-v1 --candidate sft-v2 --out output/eval/sft-v2.md
  npm run dm -- eval compare --suites eval-v1 --baseline base --target sft-v2 --out output/eval/compare.md
  npm run dm -- eval inspect --sample 10 --out output/eval/inspect.md
  npm run dm -- eval suites

运行规则：
  --resume-build <originRunId> 使用持久化模型与提示词；--rebuild 创建新 generation。
  未完成计划默认停止标定/冻结并返回非零；--allow-partial-build 显式冻结完整 accepted 子集并记录遗漏。
  --allow-active-runs 不绕过数据库写会话。数据库 busy 时请等待当前任务退出。
  evaluate 续跑省略选项沿用原规格；legacy 缺失规格只读，使用 --parent-run 新建关联评测。
  report / compare / inspect / suites 均为只读查询；迁移请先 --dry-run，再 --backup PATH。
`;

export async function runEvalCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(EVAL_HELP);
    return;
  }

  const sub = args[0]!;
  const rest = args.slice(1);

  if (sub === "migrate") {
    const { values } = parseArgs({ args: rest, options: {
      "eval-db": { type: "string" }, "dry-run": { type: "boolean", default: false },
      backup: { type: "string" }, "backup-path": { type: "string" }, help: { type: "boolean", short: "h", default: false },
    }, strict: true, allowPositionals: false });
    if (values.help) { console.log(EVAL_HELP); return; }
    if (values.backup && values["backup-path"]) throw new Error("--backup 与 --backup-path 只需指定一个");
    const report = await migrateEvalDatabase(resolve(values["eval-db"] ?? DEFAULT_EVAL_DB), {
      dryRun: values["dry-run"], backupPath: values.backup ?? values["backup-path"],
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (sub === "make") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        suite: { type: "string" },
        "no-freeze": { type: "boolean", default: false },
        "input-dir": { type: "string" },
        video: { type: "string" },
        limit: { type: "string" },
        shuffle: { type: "boolean", default: false },
        seed: { type: "string" },
        "max-chunk-chars": { type: "string" },
        types: { type: "string" },
        "max-probes": { type: "string" },
        "max-revisions": { type: "string" },
        "max-answer-attempts": { type: "string" },
        rebuild: { type: "boolean", default: false },
        "resume-build": { type: "string" },
        "allow-partial-build": { type: "boolean", default: false },
        recalibrate: { type: "boolean", default: false },
        "bare-model": { type: "string" },
        "grader-model": { type: "string" },
        "max-easy-ratio": { type: "string" },
        "allow-uncalibrated": { type: "boolean", default: false },
        "allow-active-runs": { type: "boolean", default: false },
        "fail-on-train-sim": { type: "string" },
        export: { type: "string" },
        "manifest-out": { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(EVAL_HELP);
      return;
    }

    const result = await makeEvalSuiteWorkflow({
      evalDbPath: values["eval-db"],
      mainDbPath: values["main-db"],
      suiteName: values.suite,
      noFreeze: values["no-freeze"],
      inputDir: values["input-dir"],
      videoKeys: splitCsvOpt(values.video),
      limit: parsePositiveInt(values.limit, "--limit"),
      shuffle: values.shuffle,
      seed: parseIntOpt(values.seed, "--seed"),
      maxChunkChars: parsePositiveInt(values["max-chunk-chars"], "--max-chunk-chars"),
      probeTypes: parseProbeTypeList(splitCsvOpt(values.types)),
      maxProbesPerVideo: parsePositiveInt(values["max-probes"], "--max-probes"),
      maxRevisions: parseNonNegativeInt(values["max-revisions"], "--max-revisions"),
      maxAnswerAttempts: parsePositiveInt(values["max-answer-attempts"], "--max-answer-attempts"),
      rebuild: values.rebuild,
      resumeBuildRunId: parsePositiveInt(values["resume-build"], "--resume-build"),
      allowPartialBuild: values["allow-partial-build"],
      recalibrate: values.recalibrate,
      bareModel: values["bare-model"],
      graderModel: values["grader-model"],
      maxEasyRatio: parseFloatOpt(values["max-easy-ratio"], "--max-easy-ratio"),
      allowUncalibrated: values["allow-uncalibrated"],
      allowActiveRuns: values["allow-active-runs"],
      failOnTrainSim: parseFloatOpt(values["fail-on-train-sim"], "--fail-on-train-sim"),
      exportPath: values.export,
      manifestOutPath: values["manifest-out"],
      concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.exitCode) process.exitCode = result.exitCode;
    return;
  }

  if (sub === "evaluate") {
    const { values } = parseArgs({
      args: rest,
      options: {
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
        "parent-run": { type: "string" },
        limit: { type: "string" },
        "grader-model": { type: "string" },
        "allow-same-model": { type: "boolean", default: false },
        regrade: { type: "boolean", default: false },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        out: { type: "string" },
        "json-out": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(EVAL_HELP);
      return;
    }

    const result = await evaluateEvalCandidateWorkflow({
      evalDbPath: values["eval-db"],
      suiteName: nonEmpty(values.suite, "--suite"),
      candidate: nonEmpty(values.candidate, "--candidate"),
      modelId: values.model,
      baseUrl: values["base-url"],
      apiKey: values["api-key"],
      historyMode: values["history-mode"] === undefined ? undefined : parseEvalHistoryMode(values["history-mode"]),
      systemPrompt: values["system-prompt"],
      systemPromptFile: values["system-prompt-file"],
      noSystemPrompt: values["no-system-prompt"],
      temperature: parseFloatOpt(values.temperature, "--temperature"),
      maxTokens: parsePositiveInt(values["max-tokens"], "--max-tokens"),
      timeoutMs: parsePositiveInt(values["timeout-ms"], "--timeout-ms"),
      resumeRunId: parsePositiveInt(values["resume-run"], "--resume-run"),
      parentRunId: parsePositiveInt(values["parent-run"], "--parent-run"),
      limit: parsePositiveInt(values.limit, "--limit"),
      graderModel: values["grader-model"],
      allowSameModel: values["allow-same-model"],
      regrade: values.regrade,
      concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
      callMaxAttempts: parsePositiveInt(values["call-attempts"], "--call-attempts"),
      callRetryDelayMs: parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms"),
      outPath: values.out,
      jsonOutPath: values["json-out"],
      onProgress: (msg) => console.error(msg),
    });
    console.log(JSON.stringify(result, null, 2));
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
    if (values.help) {
      console.log(EVAL_HELP);
      return;
    }

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
        "execution-run": { type: "string" },
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
    if (values.help) {
      console.log(EVAL_HELP);
      return;
    }

    const inspected = await inspectEvalProbesWorkflow({
      evalDbPath: values["eval-db"],
      runSpec: values.run,
      executionRunSpec: values["execution-run"],
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

  if (sub === "suites") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "eval-db": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(EVAL_HELP);
      return;
    }
    console.log(JSON.stringify(listEvalSuitesWorkflow({ evalDbPath: values["eval-db"] }), null, 2));
    return;
  }

  throw new Error(`未知 eval 子命令：${sub}（可选：make、evaluate、report、compare、inspect、suites、migrate）`);
}
