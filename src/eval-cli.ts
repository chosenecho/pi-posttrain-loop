import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPiRunner, readPiConfig } from "./pi-runner.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "./retry.js";
import { errorMessage, nonEmpty, validateConcurrency, validateMaxAttempts } from "./schema.js";
import {
  EvalStore,
  PROBE_TYPES,
  type EvalHistoryMode,
  type ProbeRecord,
  type ProbeStatus,
  type ProbeType,
} from "./eval/eval-db.js";
import { loadCalibrationPromptBundle, loadEvalPromptBundle } from "./eval/eval-prompts.js";
import {
  renderCalibrationReportMarkdown,
  runProbeCalibration,
  summarizeCalibrationFromStore,
} from "./eval/calibrate.js";
import { createOpenAiCandidateRunner, readCandidateConfig } from "./eval/candidate-client.js";
import { gradeEvalRun } from "./eval/eval-grader.js";
import { runSuiteEvaluation } from "./eval/eval-runner.js";
import {
  DEFAULT_MAX_ANSWER_ATTEMPTS,
  DEFAULT_MAX_CRITIC_REVISIONS,
  DEFAULT_PROBES_PER_VIDEO,
  runProbeBuild,
} from "./eval/probe-loop.js";
import { parseProbeMix } from "./eval/probe-planner.js";
import { buildEvalReport, renderEvalReportMarkdown } from "./eval/report.js";
import { importTestSources, mirrorMainVersion } from "./eval/source-import.js";
import { DEFAULT_MAX_EASY_RATIO, freezeAdversarialSuite } from "./eval/suite-freeze.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_MAIN_DB = join(ROOT, "data/data-maker.sqlite");
const DEFAULT_EVAL_DB = join(ROOT, "data/eval.sqlite");
const DEFAULT_CORPUS_DIR = join(ROOT, "data/weimingzi-semantic");

const HELP = `独立评测库与对抗测试集生产 CLI（Probe Pipeline）

子命令：
  init       初始化独立评测库 data/eval.sqlite
  status     查看评测库当前状态（材料快照、考题统计、难度分层、套卷版本、评测记录）
  mirror     从主库只读镜像冻结 test 版本到评测库（如 test-v1 -> indist-v1）
  import     从主库 test 分区只读导入视频文稿快照到评测库
  build      运行对抗 Probe Agent Loop（含单轮 5 类与 M2 多轮施压 pressure）
  calibrate  用通用模型无原稿裸答 + 评分卡 v2 打分，为已通过考题标定 easy/medium/hard 难度
  freeze     [M3] 冻结不可变对抗测试套卷（如 adv-v1），执行难度占比控制、防泄漏核验与训练集相似度审计
  run        [M3] 对冻结套卷运行候选模型脱稿盲测（原生多轮 Chat API，支持 gold/self 历史与断点续跑）
  grade      [M3] 对候选模型预测结果执行脱稿批卷（兼容 indist-v1 与 adv-v1 评分卡）
  report     [M3] 按套卷 × 候选模型 × 题型 × 预期行为 × 难度汇总评测对比报告
  compare    [M3] 针对两个候选模型（--baseline vs --target）生成增量 Δ 与逐题胜负对比报告
  inspect    导出或查看考题抽检报告（支持 --run all、--type pressure、分层抽样 --sample 20）

常用示例：
  npm run eval -- init
  npm run eval -- mirror --from-version test-v1 --as indist-v1
  npm run eval -- import --limit 10 --shuffle --seed 42 --exclude-used
  npm run eval -- build --videos imported --probes-per-video 8 --concurrency 8 --call-attempts 3
  npm run eval -- build --videos imported --probes-per-video 2 --mix pressure=100 --concurrency 8
  npm run eval -- calibrate --run all --concurrency 8 --out output/eval/calibration-report.md
  npm run eval -- calibrate --run all --report-only --out output/eval/calibration-report.md
  npm run eval -- freeze --name adv-v1 --max-easy-ratio 0.2 --export output/eval/adv-v1.jsonl --manifest-out output/eval/adv-v1.manifest.json
  npm run eval -- run --suite adv-v1 --candidate sft-v1 --model my-sft --base-url http://127.0.0.1:8000/v1 --history-mode gold
  npm run eval -- grade --run latest --grader-model <独立裁判模型> --concurrency 8
  npm run eval -- report --suites indist-v1,adv-v1 --candidates base,sft-v1 --out output/eval/report.md
  npm run eval -- compare --baseline base --target sft-v1 --suites indist-v1,adv-v1 --out output/eval/compare-base-vs-sft.md
  npm run eval -- inspect --run all --type pressure --status accepted --out output/eval/pressure-spotcheck.md
  npm run eval -- status

通用参数：
  --eval-db PATH         独立评测库路径（默认：data/eval.sqlite）
  --main-db PATH         主库路径（始终以只读打开；默认：data/data-maker.sqlite）
  -h, --help             显示帮助
`;

function parseIntOpt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const val = Number(raw);
  if (!Number.isSafeInteger(val)) throw new Error(`${label} 必须是整数`);
  return val;
}

function parseFloatOpt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const val = Number(raw);
  if (!Number.isFinite(val)) throw new Error(`${label} 必须是数字`);
  return val;
}

function parseHistoryMode(raw: string | undefined): EvalHistoryMode {
  const mode = (raw ?? "gold").trim();
  if (mode !== "gold" && mode !== "self") {
    throw new Error(`--history-mode 必须是 gold 或 self（实际 ${mode}）`);
  }
  return mode;
}

function splitCsvOpt(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stratifiedSampleProbes(probes: ProbeRecord[], sampleSize: number, seed: number): ProbeRecord[] {
  if (probes.length <= sampleSize) return [...probes];
  const rng = createSeededRng(seed);
  const byType = new Map<string, ProbeRecord[]>();
  for (const p of probes) {
    const list = byType.get(p.probeType);
    if (list) list.push(p);
    else byType.set(p.probeType, [p]);
  }
  const buckets = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, list] of buckets) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  const picked: ProbeRecord[] = [];
  let cursor = 0;
  while (picked.length < sampleSize) {
    let added = false;
    for (const [, list] of buckets) {
      if (cursor < list.length && picked.length < sampleSize) {
        picked.push(list[cursor]);
        added = true;
      }
    }
    if (!added) break;
    cursor++;
  }
  return picked;
}

function renderInspectMarkdown(
  store: EvalStore,
  runId: number | undefined,
  probes: ProbeRecord[],
  totalMatched: number,
): string {
  const lines: string[] = [];
  lines.push(`# 对抗考题（Probe）抽检报告`);
  lines.push("");
  if (runId !== undefined) {
    const run = store.getRun(runId);
    lines.push(`- **Run ID**: \`${runId}\`（状态：\`${run?.status ?? "unknown"}\`，模型：\`${String(run?.config?.modelId ?? "unknown")}\`）`);
  }
  lines.push(`- **匹配考题数**: ${totalMatched}　｜　**本报告展示**: ${probes.length}`);

  const typeDist: Record<string, number> = {};
  const statusDist: Record<string, number> = {};
  for (const p of probes) {
    typeDist[p.probeType] = (typeDist[p.probeType] ?? 0) + 1;
    statusDist[p.status] = (statusDist[p.status] ?? 0) + 1;
  }
  lines.push(`- **题型分布**: ${Object.entries(typeDist).map(([k, v]) => `\`${k}\`=${v}`).join("、")}`);
  lines.push(`- **状态分布**: ${Object.entries(statusDist).map(([k, v]) => `\`${k}\`=${v}`).join("、")}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const source = store.getSourceMaterial(p.sourceMaterialId);
    const reviews = store.listReviews(p.id);
    const dialogue = store.getProbeDialogue(p.id);
    const attempts = store.listAttemptsForProbe(p.id);
    const calibrations = store.listCalibrationsForProbe(p.id);

    const diffLabel = p.difficulty ?? "未标定";
    lines.push(`## #${i + 1} · Probe ${p.id}（\`${p.probeType}\` / \`${p.expectedBehavior}\` / ${p.persona} / ${p.targetTurns} 轮 / 难度：\`${diffLabel}\`）`);
    lines.push("");
    lines.push(`- **视频**: \`${source?.videoId ?? p.sourceMaterialId}\`（slot ${p.slotIndex}，run ${p.runId}）`);
    lines.push(`- **状态**: \`${p.status}\`　｜　**锚点校验**: ${p.anchorVerified ? "通过" : "未命中"}　｜　**审题改写次数**: ${p.revisions}`);
    if (p.rejectReason) {
      lines.push(`- **拒绝/放弃原因**: ${p.rejectReason}`);
    }
    lines.push("");
    lines.push(`**首轮考题**：${p.question}`);
    lines.push("");
    lines.push(`> **原稿锚点**：${p.anchor}`);
    lines.push("");
    lines.push(`**首轮陷阱预期（trap）**：${p.trap}`);
    lines.push("");

    if (reviews.length > 0) {
      lines.push(`**首轮审题记录（probe-critic）**：`);
      for (const r of reviews) {
        const detail = r.decision === "accept"
          ? "accept"
          : `${r.decision} — ${r.feedback || r.issues.join("; ")}`;
        lines.push(`- Round ${r.roundNo}: \`${detail}\``);
      }
      lines.push("");
    }

    if (dialogue.length > 0) {
      for (const turn of dialogue) {
        const tacticTag = turn.tactic ? ` · 手法 \`${turn.tactic}\`` : "";
        const turnAttemptCount = attempts.filter((a) => a.turnNo === turn.turnNo).length;
        if (turn.turnNo > 1) {
          lines.push(`### Turn ${turn.turnNo}（\`${turn.expectedBehavior}\`${tacticTag}）`);
          lines.push("");
          lines.push(`**施压追问**：${turn.user}`);
          lines.push("");
        }
        lines.push(`**参考答案（Turn ${turn.turnNo}，共 ${turnAttemptCount} 次核验）**：`);
        lines.push("");
        lines.push(turn.answer);
        lines.push("");
        if (turn.rubric) {
          lines.push(`**评分卡 v2（Turn ${turn.turnNo} rubric）**：`);
          lines.push("```json");
          lines.push(JSON.stringify(turn.rubric, null, 2));
          lines.push("```");
          lines.push("");
        }
        const cal = calibrations.find((c) => c.turnNo === turn.turnNo);
        if (cal) {
          const rationale = typeof cal.detail?.judgement === "object" && cal.detail?.judgement !== null
            ? String((cal.detail.judgement as { rationale?: unknown }).rationale ?? "")
            : "";
          lines.push(`**难度标定（Turn ${turn.turnNo} 裸答得分 ${cal.score} / 100，behaviorOk=\`${cal.behaviorOk}\`）**：${rationale}`);
          lines.push("");
        }
      }
    } else if (attempts.length > 0) {
      lines.push(`**核验返工记录（未通过）**：`);
      for (const a of attempts) {
        lines.push(`- Turn ${a.turnNo} Attempt ${a.attemptNo}: \`${a.decision ?? "pending"}\` ${a.feedback ?? ""}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const restArgs = args.slice(1);

  if (subcommand === "init") {
    const { values } = parseArgs({
      args: restArgs,
      options: {
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(HELP); return; }
    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    const mainDbPath = resolve(values["main-db"] ?? DEFAULT_MAIN_DB);
    const store = new EvalStore(evalDbPath);
    try {
      store.setMeta("main_db_path", mainDbPath);
      console.log(JSON.stringify({
        action: "init",
        evalDb: evalDbPath,
        mainDb: mainDbPath,
        ...store.getSummary(),
      }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "status") {
    const { values } = parseArgs({
      args: restArgs,
      options: {
        "eval-db": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(HELP); return; }
    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    if (!existsSync(evalDbPath)) {
      throw new Error(`评测库不存在：${evalDbPath}（请先运行 npm run eval -- init）`);
    }
    const store = new EvalStore(evalDbPath, { readOnly: true });
    try {
      console.log(JSON.stringify({ evalDb: evalDbPath, ...store.getSummary() }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "mirror") {
    const { values } = parseArgs({
      args: restArgs,
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
    if (values.help) { console.log(HELP); return; }
    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    const mainDbPath = resolve(values["main-db"] ?? DEFAULT_MAIN_DB);
    const fromVersion = nonEmpty(values["from-version"], "--from-version");
    const asSuiteName = nonEmpty(values.as, "--as");
    const store = new EvalStore(evalDbPath);
    try {
      store.setMeta("main_db_path", mainDbPath);
      const report = mirrorMainVersion({
        evalStore: store,
        mainDbPath,
        fromVersion,
        asSuiteName,
      });
      console.log(JSON.stringify({ evalDb: evalDbPath, mainDb: mainDbPath, ...report }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "import") {
    const { values } = parseArgs({
      args: restArgs,
      options: {
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
    if (values.help) { console.log(HELP); return; }
    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    const mainDbPath = resolve(values["main-db"] ?? DEFAULT_MAIN_DB);
    const inputDir = values["from-main-materials"]
      ? undefined
      : resolve(values["input-dir"] ?? DEFAULT_CORPUS_DIR);
    const videoKeys = values.videos
      ? values.videos.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const limit = parseIntOpt(values.limit, "--limit");
    const seed = parseIntOpt(values.seed, "--seed");
    const maxChunkChars = parseIntOpt(values["max-chunk-chars"], "--max-chunk-chars");

    const store = new EvalStore(evalDbPath);
    try {
      store.setMeta("main_db_path", mainDbPath);
      const report = await importTestSources({
        evalStore: store,
        mainDbPath,
        inputDir,
        videoKeys,
        limit,
        shuffle: Boolean(values.shuffle),
        seed,
        excludeUsed: Boolean(values["exclude-used"]),
        maxChunkChars,
      });
      console.log(JSON.stringify({ evalDb: evalDbPath, mainDb: mainDbPath, ...report }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "build") {
    const { values } = parseArgs({
      args: restArgs,
      options: {
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        "skip-main-verify": { type: "boolean", default: false },
        videos: { type: "string" },
        limit: { type: "string" },
        "probes-per-video": { type: "string" },
        mix: { type: "string" },
        seed: { type: "string" },
        "max-critic-revisions": { type: "string" },
        "max-attempts": { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(HELP); return; }

    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    const mainDbPath = values["skip-main-verify"]
      ? undefined
      : resolve(values["main-db"] ?? DEFAULT_MAIN_DB);
    const videosSpec = (values.videos ?? "imported").trim();
    const limit = parseIntOpt(values.limit, "--limit");
    const probesPerVideo = parseIntOpt(values["probes-per-video"], "--probes-per-video") ?? DEFAULT_PROBES_PER_VIDEO;
    const mix = values.mix !== undefined ? parseProbeMix(values.mix) : undefined;
    const seed = parseIntOpt(values.seed, "--seed");
    const maxCriticRevisions = parseIntOpt(values["max-critic-revisions"], "--max-critic-revisions") ?? DEFAULT_MAX_CRITIC_REVISIONS;
    const maxAnswerAttempts = validateMaxAttempts(parseIntOpt(values["max-attempts"], "--max-attempts") ?? DEFAULT_MAX_ANSWER_ATTEMPTS);
    const concurrency = validateConcurrency(parseIntOpt(values.concurrency, "--concurrency") ?? 1);
    const callMaxAttempts = validateCallMaxAttempts(parseIntOpt(values["call-attempts"], "--call-attempts") ?? DEFAULT_CALL_MAX_ATTEMPTS);
    const callRetryDelayMs = validateCallRetryDelayMs(parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms") ?? DEFAULT_CALL_RETRY_DELAY_MS);

    const bundle = await loadEvalPromptBundle();
    if (!bundle.allReady) {
      throw new Error("存在未就绪的 eval Skill，无法启动正式评测考题构建");
    }
    const config = readPiConfig();
    const runRole = createPiRunner(config);

    const store = new EvalStore(evalDbPath);
    try {
      let sources = videosSpec === "imported"
        ? store.listUnbuiltSourceMaterials()
        : videosSpec === "all"
          ? store.listSourceMaterials()
          : store.listSourceMaterialsByVideoKeys(videosSpec.split(",").map((s) => s.trim()).filter(Boolean));
      if (limit !== undefined) {
        if (limit < 1) throw new Error("--limit 必须是正整数");
        sources = sources.slice(0, limit);
      }
      if (sources.length === 0) {
        throw new Error(`未找到符合条件（--videos ${videosSpec}）的材料快照，请先运行 npm run eval -- import`);
      }

      console.log(`=== 对抗考题构建（${sources.length} 份材料，每篇 ${probesPerVideo} 题，并发 ${concurrency}，模型 ${config.modelId}）===`);
      const summary = await runProbeBuild({
        evalStore: store,
        sources,
        mainDbPath,
        prompts: bundle.prompts,
        skills: bundle.skills,
        runRole,
        modelId: config.modelId,
        probesPerVideo,
        mix,
        seed,
        maxCriticRevisions,
        maxAnswerAttempts,
        concurrency,
        callMaxAttempts,
        callRetryDelayMs,
        onProgress: (msg) => console.log(msg),
      });
      console.log(JSON.stringify({ evalDb: evalDbPath, ...summary }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "calibrate") {
    const { values } = parseArgs({
      args: restArgs,
      options: {
        "eval-db": { type: "string" },
        run: { type: "string" },
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
    if (values.help) { console.log(HELP); return; }

    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    if (!existsSync(evalDbPath)) {
      throw new Error(`评测库不存在：${evalDbPath}（请先运行 npm run eval -- init）`);
    }
    const probeTypeFilter = values.type !== undefined ? (values.type.trim() as ProbeType) : undefined;
    if (probeTypeFilter !== undefined && !PROBE_TYPES.includes(probeTypeFilter)) {
      throw new Error(`未知题型 --type ${probeTypeFilter}（可选：${PROBE_TYPES.join(", ")}）`);
    }
    const limit = parseIntOpt(values.limit, "--limit");

    if (values["report-only"]) {
      const store = new EvalStore(evalDbPath, { readOnly: true });
      try {
        let runFilter: number | undefined;
        if (values.run === undefined || values.run === "latest") {
          runFilter = store.latestRunId("probe_build");
        } else if (values.run !== "all") {
          runFilter = parseIntOpt(values.run, "--run");
        }
        let probes = store.listProbes({
          runId: runFilter,
          status: "accepted",
          probeType: probeTypeFilter,
        });
        if (limit !== undefined) {
          if (limit < 1) throw new Error("--limit 必须是正整数");
          probes = probes.slice(0, limit);
        }
        if (probes.length === 0) {
          throw new Error("未找到符合条件的已通过考题（accepted probes）可供汇总");
        }
        const summary = summarizeCalibrationFromStore({ evalStore: store, probes });
        let reportPath: string | undefined;
        if (values.out) {
          reportPath = resolve(nonEmpty(values.out, "--out"));
          await mkdir(dirname(reportPath), { recursive: true });
          await writeFile(reportPath, renderCalibrationReportMarkdown(summary), "utf8");
        }
        const { items: _items, ...compactSummary } = summary;
        console.log(JSON.stringify({
          evalDb: evalDbPath,
          reportOnly: true,
          ...compactSummary,
          ...(reportPath ? { reportPath } : {}),
        }, null, 2));
      } finally {
        store.close();
      }
      return;
    }

    const concurrency = validateConcurrency(parseIntOpt(values.concurrency, "--concurrency") ?? 1);
    const callMaxAttempts = validateCallMaxAttempts(parseIntOpt(values["call-attempts"], "--call-attempts") ?? DEFAULT_CALL_MAX_ATTEMPTS);
    const callRetryDelayMs = validateCallRetryDelayMs(parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms") ?? DEFAULT_CALL_RETRY_DELAY_MS);

    const bundle = await loadCalibrationPromptBundle();
    if (!bundle.allReady) {
      throw new Error("eval-grader Skill 未就绪，无法执行难度标定");
    }

    const baseConfig = readPiConfig();
    const bareModelId = values.model?.trim() || baseConfig.modelId;
    const graderModelId = values["grader-model"]?.trim() || process.env.EVAL_LLM_MODEL?.trim() || baseConfig.modelId;
    const runBareModel = createPiRunner({ ...baseConfig, modelId: bareModelId });
    const runGrader = createPiRunner({ ...baseConfig, modelId: graderModelId });

    const store = new EvalStore(evalDbPath);
    try {
      let runFilter: number | undefined;
      if (values.run === undefined || values.run === "latest") {
        runFilter = store.latestRunId("probe_build");
      } else if (values.run !== "all") {
        runFilter = parseIntOpt(values.run, "--run");
      }

      let probes = store.listProbes({
        runId: runFilter,
        status: "accepted",
        probeType: probeTypeFilter,
        onlyUncalibrated: Boolean(values["only-uncalibrated"]),
      });
      if (limit !== undefined) {
        if (limit < 1) throw new Error("--limit 必须是正整数");
        probes = probes.slice(0, limit);
      }
      if (probes.length === 0) {
        throw new Error("未找到符合条件的已通过考题（accepted probes）可供标定");
      }

      console.log(`=== M2 难度标定（${probes.length} 道考题，裸答模型 ${bareModelId}，批卷模型 ${graderModelId}，并发 ${concurrency}）===`);
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
        onProgress: (msg) => console.log(msg),
      });

      let reportPath: string | undefined;
      if (values.out) {
        reportPath = resolve(nonEmpty(values.out, "--out"));
        await mkdir(dirname(reportPath), { recursive: true });
        await writeFile(reportPath, renderCalibrationReportMarkdown(summary), "utf8");
      }

      const { items: _items, ...compactSummary } = summary;
      console.log(JSON.stringify({
        evalDb: evalDbPath,
        ...compactSummary,
        ...(reportPath ? { reportPath } : {}),
      }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "freeze") {
    const { values } = parseArgs({
      args: restArgs,
      options: {
        "eval-db": { type: "string" },
        "main-db": { type: "string" },
        name: { type: "string" },
        run: { type: "string" },
        "max-easy-ratio": { type: "string" },
        "allow-uncalibrated": { type: "boolean", default: false },
        "skip-main-verify": { type: "boolean", default: false },
        "fail-on-train-sim": { type: "string" },
        export: { type: "string" },
        "manifest-out": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(HELP); return; }

    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    if (!existsSync(evalDbPath)) {
      throw new Error(`评测库不存在：${evalDbPath}`);
    }
    const name = nonEmpty(values.name, "--name");
    const maxEasyRatio = parseFloatOpt(values["max-easy-ratio"], "--max-easy-ratio") ?? DEFAULT_MAX_EASY_RATIO;
    const failOnTrainSim = parseFloatOpt(values["fail-on-train-sim"], "--fail-on-train-sim");
    const mainDbPath = values["skip-main-verify"]
      ? undefined
      : resolve(values["main-db"] ?? DEFAULT_MAIN_DB);
    const exportPath = values.export ? resolve(nonEmpty(values.export, "--export")) : undefined;
    const manifestOutPath = values["manifest-out"]
      ? resolve(nonEmpty(values["manifest-out"], "--manifest-out"))
      : undefined;

    const store = new EvalStore(evalDbPath);
    try {
      let runId: number | undefined;
      if (values.run === "latest") {
        runId = store.latestRunId("probe_build");
      } else if (values.run !== undefined && values.run !== "all") {
        runId = parseIntOpt(values.run, "--run");
      }

      const report = await freezeAdversarialSuite({
        evalStore: store,
        name,
        runId,
        maxEasyRatio,
        allowUncalibrated: Boolean(values["allow-uncalibrated"]),
        mainDbPath: mainDbPath && existsSync(mainDbPath) ? mainDbPath : undefined,
        failOnTrainSim,
        exportPath,
        manifestOutPath,
      });
      console.log(JSON.stringify({ evalDb: evalDbPath, ...report }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "run") {
    const { values } = parseArgs({
      args: restArgs,
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
        temperature: { type: "string" },
        "max-tokens": { type: "string" },
        "timeout-ms": { type: "string" },
        "resume-run": { type: "string" },
        limit: { type: "string" },
        concurrency: { type: "string" },
        "call-attempts": { type: "string" },
        "retry-delay-ms": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) { console.log(HELP); return; }

    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    if (!existsSync(evalDbPath)) {
      throw new Error(`评测库不存在：${evalDbPath}`);
    }
    const suiteName = nonEmpty(values.suite, "--suite");
    const candidate = nonEmpty(values.candidate, "--candidate");
    const historyMode = parseHistoryMode(values["history-mode"]);
    const resumeRunId = parseIntOpt(values["resume-run"], "--resume-run");
    const limit = parseIntOpt(values.limit, "--limit");
    const concurrency = validateConcurrency(parseIntOpt(values.concurrency, "--concurrency") ?? 4);
    const callMaxAttempts = validateCallMaxAttempts(parseIntOpt(values["call-attempts"], "--call-attempts") ?? DEFAULT_CALL_MAX_ATTEMPTS);
    const callRetryDelayMs = validateCallRetryDelayMs(parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms") ?? DEFAULT_CALL_RETRY_DELAY_MS);

    let systemPrompt = values["system-prompt"];
    if (values["system-prompt-file"]) {
      if (systemPrompt !== undefined) {
        throw new Error("--system-prompt 与 --system-prompt-file 不能同时指定");
      }
      systemPrompt = (await readFile(resolve(values["system-prompt-file"]), "utf8")).trim();
    }

    const candidateConfig = readCandidateConfig({
      baseUrl: values["base-url"],
      modelId: values.model,
      apiKey: values["api-key"],
      temperature: parseFloatOpt(values.temperature, "--temperature"),
      maxTokens: parseIntOpt(values["max-tokens"], "--max-tokens"),
      timeoutMs: parseIntOpt(values["timeout-ms"], "--timeout-ms"),
    });
    const runCandidate = createOpenAiCandidateRunner(candidateConfig);

    const store = new EvalStore(evalDbPath);
    try {
      console.log(
        `=== M3 候选模型脱稿评测（suite=${suiteName}, candidate=${candidate}, model=${candidateConfig.modelId}, history=${historyMode}, 并发 ${concurrency}）===`,
      );
      const summary = await runSuiteEvaluation({
        evalStore: store,
        suiteName,
        candidate,
        modelId: candidateConfig.modelId,
        historyMode,
        systemPrompt,
        temperature: candidateConfig.temperature,
        maxTokens: candidateConfig.maxTokens,
        runCandidate,
        resumeRunId,
        limit,
        concurrency,
        callMaxAttempts,
        callRetryDelayMs,
        onProgress: (msg) => console.log(msg),
      });
      console.log(JSON.stringify({ evalDb: evalDbPath, ...summary }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "grade") {
    const { values } = parseArgs({
      args: restArgs,
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
    if (values.help) { console.log(HELP); return; }

    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    if (!existsSync(evalDbPath)) {
      throw new Error(`评测库不存在：${evalDbPath}`);
    }
    const concurrency = validateConcurrency(parseIntOpt(values.concurrency, "--concurrency") ?? 4);
    const callMaxAttempts = validateCallMaxAttempts(parseIntOpt(values["call-attempts"], "--call-attempts") ?? DEFAULT_CALL_MAX_ATTEMPTS);
    const callRetryDelayMs = validateCallRetryDelayMs(parseIntOpt(values["retry-delay-ms"], "--retry-delay-ms") ?? DEFAULT_CALL_RETRY_DELAY_MS);

    const bundle = await loadCalibrationPromptBundle();
    const baseConfig = readPiConfig({
      ...process.env,
      ...(process.env.EVAL_LLM_BASE_URL ? { LLM_BASE_URL: process.env.EVAL_LLM_BASE_URL } : {}),
      ...(process.env.EVAL_LLM_API_KEY ? { LLM_API_KEY: process.env.EVAL_LLM_API_KEY } : {}),
      ...(process.env.EVAL_LLM_MODEL ? { LLM_MODEL: process.env.EVAL_LLM_MODEL } : {}),
    });
    const graderModelId = values["grader-model"]?.trim() || baseConfig.modelId;
    const runGrader = createPiRunner({ ...baseConfig, modelId: graderModelId });

    const store = new EvalStore(evalDbPath);
    try {
      let evalRunId: number | undefined;
      if (values.run === undefined || values.run === "latest") {
        evalRunId = store.latestEvalRunId();
      } else {
        evalRunId = parseIntOpt(values.run, "--run");
      }
      if (evalRunId === undefined) {
        throw new Error("评测库中尚未有任何 eval_run，请先运行 npm run eval -- run");
      }

      console.log(`=== M3 脱稿批卷（eval_run #${evalRunId}，裁判模型 ${graderModelId}，并发 ${concurrency}）===`);
      const summary = await gradeEvalRun({
        evalStore: store,
        evalRunId,
        graderPrompt: bundle.prompts.evalGrader,
        runGrader,
        graderModelId,
        allowSameModel: Boolean(values["allow-same-model"]),
        regrade: Boolean(values.regrade),
        concurrency,
        callMaxAttempts,
        callRetryDelayMs,
        onProgress: (msg) => console.log(msg),
      });
      console.log(JSON.stringify({ evalDb: evalDbPath, ...summary }, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "report" || subcommand === "compare") {
    const isCompare = subcommand === "compare";
    const { values } = parseArgs({
      args: restArgs,
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
    if (values.help) { console.log(HELP); return; }

    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    if (!existsSync(evalDbPath)) {
      throw new Error(`评测库不存在：${evalDbPath}`);
    }
    const suites = splitCsvOpt(values.suites);
    let candidates = splitCsvOpt(values.candidates);
    let baselineCandidate = values.baseline?.trim();
    if (isCompare) {
      baselineCandidate = nonEmpty(values.baseline, "--baseline");
      const target = nonEmpty(values.target, "--target");
      candidates = [baselineCandidate, target];
    }
    const runIds = splitCsvOpt(values.runs)?.map((raw) => {
      const id = Number(raw);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error(`--runs 包含非法 ID：${raw}`);
      return id;
    });
    const historyMode = parseHistoryMode(values["history-mode"]);
    const topFailures = parseIntOpt(values["top-failures"], "--top-failures") ?? 6;

    const store = new EvalStore(evalDbPath, { readOnly: true });
    try {
      const report = buildEvalReport({
        evalStore: store,
        suites,
        candidates,
        runIds,
        historyMode,
        baselineCandidate,
      });
      const md = renderEvalReportMarkdown(report, topFailures);

      let outPath: string | undefined;
      if (values.out) {
        outPath = resolve(nonEmpty(values.out, "--out"));
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, md, "utf8");
      }
      let jsonOutPath: string | undefined;
      if (values["json-out"]) {
        jsonOutPath = resolve(nonEmpty(values["json-out"], "--json-out"));
        await mkdir(dirname(jsonOutPath), { recursive: true });
        await writeFile(jsonOutPath, JSON.stringify(report, null, 2) + "\n", "utf8");
      }

      if (outPath || jsonOutPath) {
        const compactEntries = report.entries.map(({ items: _items, ...rest }) => rest);
        console.log(JSON.stringify({
          evalDb: evalDbPath,
          suites: report.suites,
          candidates: report.candidates,
          ...(report.baselineCandidate ? { baselineCandidate: report.baselineCandidate } : {}),
          entries: compactEntries,
          comparisons: report.comparisons.map(({ topImproved: _ti, topRegressed: _tr, ...c }) => c),
          ...(outPath ? { outPath } : {}),
          ...(jsonOutPath ? { jsonOutPath } : {}),
        }, null, 2));
      } else {
        console.log(md);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "inspect") {
    const { values } = parseArgs({
      args: restArgs,
      options: {
        "eval-db": { type: "string" },
        run: { type: "string" },
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
    if (values.help) { console.log(HELP); return; }

    const evalDbPath = resolve(values["eval-db"] ?? DEFAULT_EVAL_DB);
    if (!existsSync(evalDbPath)) {
      throw new Error(`评测库不存在：${evalDbPath}`);
    }
    const probeTypeFilter = values.type !== undefined ? (values.type.trim() as ProbeType) : undefined;
    if (probeTypeFilter !== undefined && !PROBE_TYPES.includes(probeTypeFilter)) {
      throw new Error(`未知题型 --type ${probeTypeFilter}（可选：${PROBE_TYPES.join(", ")}）`);
    }
    const store = new EvalStore(evalDbPath, { readOnly: true });
    try {
      let runId: number | undefined;
      if (values.run === undefined || values.run === "latest") {
        runId = store.latestRunId("probe_build");
      } else if (values.run !== "all") {
        runId = parseIntOpt(values.run, "--run");
      }
      const statusFilter = values.status && values.status !== "all"
        ? (values.status as ProbeStatus)
        : undefined;
      const matched = store.listProbes({ runId, status: statusFilter, probeType: probeTypeFilter });
      const sampleSize = parseIntOpt(values.sample, "--sample");
      const seed = parseIntOpt(values.seed, "--seed") ?? 42;
      const selected = sampleSize !== undefined ? stratifiedSampleProbes(matched, sampleSize, seed) : matched;
      const md = renderInspectMarkdown(store, runId, selected, matched.length);
      if (values.out) {
        const outPath = resolve(nonEmpty(values.out, "--out"));
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, md, "utf8");
        console.log(JSON.stringify({ out: outPath, runId: runId ?? "all", totalMatched: matched.length, shown: selected.length }, null, 2));
      } else {
        console.log(md);
      }
    } finally {
      store.close();
    }
    return;
  }

  throw new Error(`未知子命令：${subcommand}（使用 --help 查看可用命令）`);
}

main().catch((error: unknown) => {
  console.error(`错误：${errorMessage(error)}`);
  process.exitCode = 1;
});
