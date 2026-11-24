import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  extractVideoKey,
  queryProcessedVideoIndex,
  resolveSingleVideoInput,
  scanCorpusVideos,
  selectVideos,
  summarizeCorpusStatus,
  type VideoUnit,
} from "./corpus.js";
import { runCorpusQuestionGeneration } from "./corpus-questions.js";
import { DataMakerStore } from "./db.js";
import { DEFAULT_QUESTION_SKILL, readQuestionSkill } from "./io.js";
import { readPiConfig } from "./pi-runner.js";
import { questionPrompt } from "./prompts.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "./retry.js";
import { errorMessage, nonEmpty, validateConcurrency, validateSplit } from "./schema.js";
import { summarizeSplitCounts, syncCorpusSplits } from "./splits.js";

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

const HELP = `视频文稿出题并写入统一 SQLite 数据库（同视频多 P 自动合并为 1 个视频，默认防重复）

批量从语料目录选未处理视频出题：
  npm run questions -- --input-dir data/weimingzi-semantic --limit 10 [--concurrency 10] [--shuffle]

查看语料库处理进度（不调用模型）：
  npm run questions -- --input-dir data/weimingzi-semantic --status

单视频/单文稿出题（同目录多 P 默认自动合并，已处理自动跳过，除非加 --force）：
  npm run questions -- --input "data/weimingzi-semantic/by_bv/BV1Dt4y1Y7S2/P001.md"

参数：
  --input PATH          单个文稿文件或单个视频目录（与 --input-dir 互斥）
  --input-dir PATH      语料根目录（如 data/weimingzi-semantic），按视频归组并自动跳过已处理视频
  --split SPLIT         数据集分区：train（默认）| test | dpo（持久哈希注册）
  --status              仅统计 --input-dir 的总视频数/已处理/未处理进度（含分区统计），不调用模型
  --limit N             本次从 --input-dir 抽取的未处理视频数量（按视频计，多 P 算 1 个）
  --shuffle             随机抽选未处理视频（默认按视频 ID 顺序）
  --max-questions N     可选：手动覆盖单视频/分块出题上限（默认按字数与分P数动态封顶 3–10 题）
  --concurrency N       批量出题并发数，默认 10，范围 1–500
  --call-attempts N     单次出题模型调用异常/未保存最多尝试次数（含重试），默认 3，范围 1–10
  --retry-delay-ms MS   单次调用重试间隔毫秒数，默认 3000（3 秒），范围 0–60000
  --force               强制对已处理视频重新出题（单视频或批量均适用）
  --db PATH             统一 SQLite 路径，默认 data/data-maker.sqlite
  --video-id ID         单视频模式下显式指定 video_id
  --question-skill PATH 出题 Skill，默认 skills/question-design/SKILL.md
  --no-skill            不加载出题 Skill
  --help                查看说明
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      "input-dir": { type: "string" },
      split: { type: "string" },
      status: { type: "boolean", default: false },
      limit: { type: "string" },
      shuffle: { type: "boolean", default: false },
      "max-questions": { type: "string" },
      concurrency: { type: "string" },
      "call-attempts": { type: "string" },
      "retry-delay-ms": { type: "string" },
      force: { type: "boolean", default: false },
      db: { type: "string" },
      "video-id": { type: "string" },
      "question-skill": { type: "string" },
      "no-skill": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.input !== undefined && values["input-dir"] !== undefined) {
    throw new Error("--input 与 --input-dir 不能同时指定");
  }
  if (values.input === undefined && values["input-dir"] === undefined) {
    throw new Error("请指定 --input 或 --input-dir");
  }
  if (values["input-dir"] !== undefined && values["video-id"] !== undefined) {
    throw new Error("--video-id 仅用于单视频 --input 模式");
  }
  if (values.status && values["input-dir"] === undefined) {
    throw new Error("--status 需要搭配 --input-dir 使用");
  }

  const targetSplit = validateSplit(values.split ?? "train", "--split");
  const limit = parsePositiveInt(values.limit, "--limit");
  const maxQuestionsPerVideo = parsePositiveInt(values["max-questions"], "--max-questions");
  const concurrency = validateConcurrency(Number(values.concurrency ?? 10));
  const callMaxAttempts = validateCallMaxAttempts(Number(values["call-attempts"] ?? DEFAULT_CALL_MAX_ATTEMPTS));
  const callRetryDelayMs = validateCallRetryDelayMs(Number(values["retry-delay-ms"] ?? DEFAULT_CALL_RETRY_DELAY_MS));
  const dbPath = values.db
    ? resolve(values.db)
    : fileURLToPath(new URL("../data/data-maker.sqlite", import.meta.url));

  const store = new DataMakerStore(dbPath);
  try {
    if (values.status) {
      const units = await scanCorpusVideos(values["input-dir"]!);
      syncCorpusSplits(store, units);
      const status = summarizeCorpusStatus(units, store);
      const splits = summarizeSplitCounts(store, units);
      console.log(JSON.stringify({
        db: dbPath,
        inputDir: resolve(values["input-dir"]!),
        split: targetSplit,
        totalVideos: status.totalVideos,
        totalPartFiles: status.totalPartFiles,
        multiPartVideos: status.multiPartVideos,
        processedVideos: status.processedVideos,
        unprocessedVideos: status.unprocessedVideos,
        splits,
      }, null, 2));
      return;
    }

    const basePrompt = nonEmpty(
      await readFile(new URL("../prompts/question-generator.md", import.meta.url), "utf8"),
      "问题生成系统提示词",
    );

    let systemPrompt = basePrompt;
    const skills: Array<Record<string, unknown>> = [];
    if (!values["no-skill"]) {
      const skillPath = resolve(values["question-skill"] ?? DEFAULT_QUESTION_SKILL);
      const qSkill = await readQuestionSkill(skillPath);
      systemPrompt = questionPrompt(basePrompt, qSkill.body);
      skills.push({ name: "question-design", path: skillPath, status: qSkill.status, body: qSkill.body, sha256: qSkill.sha256 });
    }

    const config = readPiConfig();
    store.markInterruptedRuns();
    const { processedVideoKeys } = queryProcessedVideoIndex(store);

    let candidates: VideoUnit[];
    if (values["input-dir"] !== undefined) {
      const allUnits = await scanCorpusVideos(values["input-dir"]);
      const splitMap = syncCorpusSplits(store, allUnits);
      const pool = values.force
        ? allUnits
        : allUnits.filter((u) => !processedVideoKeys.has(extractVideoKey(u.videoId)));
      candidates = selectVideos(pool, {
        limit,
        shuffle: Boolean(values.shuffle),
        split: targetSplit,
        splitMap,
      });
      if (candidates.length === 0) {
        console.log(JSON.stringify({
          db: dbPath,
          split: targetSplit,
          totalVideos: allUnits.length,
          selectedVideos: 0,
          message: "没有需要处理的未出题视频",
        }, null, 2));
        return;
      }
    } else {
      const unit = await resolveSingleVideoInput(values.input!, {
        videoIdOverride: values["video-id"],
        mergeSiblingParts: true,
      });
      if (!values.force && processedVideoKeys.has(extractVideoKey(unit.videoId))) {
        console.log(JSON.stringify({
          db: dbPath,
          videoId: unit.videoId,
          partCount: unit.partPaths.length,
          skipped: true,
          reason: "该视频已在库中完成出题；如需重出请加 --force",
        }, null, 2));
        return;
      }
      candidates = [unit];
    }

    console.log(`数据库：${dbPath}\n分区：${targetSplit}；选中视频：${candidates.length}；并发：${concurrency}；模型：${config.modelId}`);

    const summary = await runCorpusQuestionGeneration({
      store,
      config,
      systemPrompt,
      skills,
      candidates,
      concurrency,
      split: targetSplit,
      callMaxAttempts,
      callRetryDelayMs,
      force: Boolean(values.force),
      maxQuestionsPerVideo,
      onProgress: (message) => console.log(message),
    });

    console.log(JSON.stringify({
      db: dbPath,
      split: targetSplit,
      runId: summary.runId,
      selectedVideos: summary.selectedVideos,
      processedVideos: summary.processedVideos,
      skippedBySha256: summary.skippedBySha256,
      savedQuestions: summary.savedQuestions,
      skippedDuplicateQuestions: summary.skippedDuplicateQuestions,
      errors: summary.errors,
      integrityOk: summary.integrityOk,
    }, null, 2));

    if (!summary.integrityOk || summary.errors > 0) {
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(`错误：${errorMessage(error)}`);
  process.exitCode = 1;
});
