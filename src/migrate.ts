import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DataMakerStore, normalizeText, sha256Hex } from "./db.js";
import { asObject, errorMessage, nonEmpty, parseReview } from "./schema.js";
import { normalizeApiBaseUrl } from "./shared/api-config.js";
import { backfillProcessedTrainSplits } from "./splits.js";
import type { Review } from "./types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface TrialRunManifest {
  mode: string;
  startedAt: string;
  databasePath: string;
  databaseSha256: string;
  materialRoot: string;
  skills: unknown[];
  maxAttempts: number;
  trainingEnabled: boolean;
  questionCount: number;
  promptDirectory: string;
  systemPrompts: { answer: string; judge: string };
  model: unknown;
  reviewScope?: string;
}

interface TrialSummary {
  startedAt: string;
  finishedAt?: string;
  state: string;
  questions: number;
  completed: number;
  modelCalls: number;
  rounds: number;
  passed: number;
  dropped: number;
  exhausted: number;
  errors: number;
  results: number;
}

interface TrialMaterialLine {
  videoId: string;
  path?: string;
  sha256: string;
  text: string;
}

interface TrialQuestionLine {
  id: number;
  video_id: string;
  question: string;
}

interface TrialRoundLine {
  questionId: number;
  videoId: string;
  question: string;
  attempt: number;
  answer?: string;
  review?: Review;
  error?: string;
}

interface TrialOutcomeLine {
  questionId: number;
  videoId: string;
  question: string;
  status: "pass" | "drop" | "exhausted" | "error";
  attempts: number;
  answer?: string;
  review?: Review;
  error?: string;
}

interface TrialTraceLine {
  timestamp: string;
  type: "role_start" | "role_result" | "error";
  questionId: number;
  videoId: string;
  attempt: number;
  role: "answer" | "judge";
  systemPrompt?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

interface PairedTrace {
  questionId: number;
  attempt: number;
  role: "answer" | "judge";
  startedAt: string;
  finishedAt: string;
  input: Record<string, unknown>;
  outputText?: string;
  error?: string;
  status: "completed" | "error";
}

export interface MigrateOptions {
  targetDbPath: string;
  sourceQuestionsDbPath: string;
  trialDir: string;
}

export interface MigrationReport {
  alreadyImported: boolean;
  runId: number;
  importKey: string;
  sourceDbUnchanged: boolean;
  counts: {
    materials: number;
    questions: number;
    runs: number;
    runItems: number;
    turns: number;
    attempts: number;
    modelCalls: number;
    results: number;
  };
  integrityOk: boolean;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  const rows: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line) as T);
  }
  return rows;
}

const LEGACY_THINKING_LEVELS = ["off", "low", "medium", "high", "max"];
const LEGACY_THINKING_ROLES = ["question", "answer", "judge", "followup", "rubric"];

function legacyThinkingLevel(value: unknown, label: string): string {
  if (typeof value !== "string" || !LEGACY_THINKING_LEVELS.includes(value)) {
    throw new Error(`${label} 必须为 off、low、medium、high 或 max`);
  }
  return value;
}

function sanitizeLegacyModel(raw: unknown): Record<string, unknown> {
  const model = asObject(raw, "旧运行 model");
  const sanitized: Record<string, unknown> = {};

  // Legacy snapshots may use either spelling and omit newer configuration fields.
  for (const field of ["id", "modelId"] as const) {
    if (model[field] !== undefined) sanitized[field] = nonEmpty(model[field], `旧运行 model.${field}`);
  }
  if (model.baseUrl !== undefined) {
    if (typeof model.baseUrl !== "string") {
      throw new Error("旧运行 model.baseUrl 必须是非空字符串");
    }
    sanitized.baseUrl = normalizeApiBaseUrl(model.baseUrl, "旧运行 model.baseUrl");
  }
  for (const field of ["maxTokens", "contextWindow", "timeoutMs"] as const) {
    const value = model[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`旧运行 model.${field} 必须是正安全整数`);
    }
    sanitized[field] = value;
  }
  if (model.thinkingLevel !== undefined) {
    sanitized.thinkingLevel = legacyThinkingLevel(model.thinkingLevel, "旧运行 model.thinkingLevel");
  }
  if (model.roleThinkingLevels !== undefined) {
    const roles = asObject(model.roleThinkingLevels, "旧运行 model.roleThinkingLevels");
    const sanitizedRoles: Record<string, string> = {};
    for (const role of LEGACY_THINKING_ROLES) {
      if (roles[role] !== undefined) {
        sanitizedRoles[role] = legacyThinkingLevel(roles[role], `旧运行 model.roleThinkingLevels.${role}`);
      }
    }
    sanitized.roleThinkingLevels = sanitizedRoles;
  }
  return sanitized;
}

function pairTraces(traces: TrialTraceLine[]): Map<string, PairedTrace> {
  const starts = new Map<string, TrialTraceLine>();
  const paired = new Map<string, PairedTrace>();
  for (const event of traces) {
    const key = `${event.questionId}:${event.attempt}:${event.role}`;
    if (event.type === "role_start") {
      if (starts.has(key) || paired.has(key)) throw new Error(`重复的 role_start 事件：${key}`);
      starts.set(key, event);
      continue;
    }
    const start = starts.get(key);
    if (!start) throw new Error(`缺少对应的 role_start 事件：${key}`);
    starts.delete(key);
    if (event.type === "role_result") {
      paired.set(key, {
        questionId: event.questionId,
        attempt: event.attempt,
        role: event.role,
        startedAt: start.timestamp,
        finishedAt: event.timestamp,
        input: start.input ?? {},
        outputText: event.output,
        status: "completed",
      });
    } else {
      paired.set(key, {
        questionId: event.questionId,
        attempt: event.attempt,
        role: event.role,
        startedAt: start.timestamp,
        finishedAt: event.timestamp,
        input: start.input ?? {},
        error: event.error ?? "unknown error",
        status: "error",
      });
    }
  }
  if (starts.size > 0) {
    throw new Error(`存在未配对的 role_start 事件：${[...starts.keys()].join(", ")}`);
  }
  return paired;
}

export async function migrateTrialToSqlite(options: MigrateOptions): Promise<MigrationReport> {
  const sourceDbPath = resolve(options.sourceQuestionsDbPath);
  const trialDir = resolve(options.trialDir);
  const targetDbPath = resolve(options.targetDbPath);

  const sourceDbHashBefore = createHash("sha256").update(await readFile(sourceDbPath)).digest("hex");

  // Read legacy questions.sqlite read-only to confirm exact source records.
  const legacyDb = new DatabaseSync(sourceDbPath, { readOnly: true });
  let legacyQuestions: TrialQuestionLine[];
  try {
    legacyQuestions = legacyDb.prepare("SELECT id, video_id, question FROM questions ORDER BY id").all() as unknown as TrialQuestionLine[];
  } finally {
    legacyDb.close();
  }

  const runManifest = JSON.parse(await readFile(join(trialDir, "run.json"), "utf8")) as TrialRunManifest;
  const summary = JSON.parse(await readFile(join(trialDir, "summary.json"), "utf8")) as TrialSummary;
  const materials = await readJsonl<TrialMaterialLine>(join(trialDir, "materials.jsonl"));
  const trialQuestions = await readJsonl<TrialQuestionLine>(join(trialDir, "questions.jsonl"));
  const rounds = await readJsonl<TrialRoundLine>(join(trialDir, "rounds.jsonl"));
  const outcomes = await readJsonl<TrialOutcomeLine>(join(trialDir, "outcomes.jsonl"));
  const expectedResults = await readJsonl<TrialOutcomeLine>(join(trialDir, "results.jsonl"));
  const traces = await readJsonl<TrialTraceLine>(join(trialDir, "traces.jsonl"));

  // Validate source DB matches trial snapshot
  if (legacyQuestions.length !== trialQuestions.length) {
    throw new Error(`问题库数量(${legacyQuestions.length})与试跑快照(${trialQuestions.length})不一致`);
  }
  for (let i = 0; i < legacyQuestions.length; i++) {
    const a = legacyQuestions[i];
    const b = trialQuestions[i];
    if (a.id !== b.id || a.video_id !== b.video_id || a.question.trim() !== b.question.trim()) {
      throw new Error(`问题库与试跑快照在第 ${i + 1} 条不一致`);
    }
  }

  const pairedTraces = pairTraces(traces);
  if (pairedTraces.size !== summary.modelCalls) {
    throw new Error(`配对后的模型调用数(${pairedTraces.size})与 summary.modelCalls(${summary.modelCalls})不一致`);
  }

  const importKey = `${runManifest.mode}:${basename(trialDir)}:${runManifest.startedAt}`;
  const store = new DataMakerStore(targetDbPath);

  try {
    const existingRun = store.findRunByImportKey(importKey);
    let runId: number;
    let alreadyImported = false;

    if (existingRun) {
      alreadyImported = true;
      runId = existingRun.id;
    } else {
      runId = store.transaction(() => {
        // Validate the allowlisted snapshot before importing any legacy records.
        const sanitizedModel = sanitizeLegacyModel(runManifest.model);

        // 1. Upsert materials and verify normalized SHA-256
        const materialIdByVideo = new Map<string, number>();
        for (const mat of materials) {
          const normalized = normalizeText(mat.text);
          const computedHash = sha256Hex(normalized);
          if (computedHash !== mat.sha256) {
            throw new Error(`材料 ${mat.videoId} 指纹不一致：计算值 ${computedHash} != 记录值 ${mat.sha256}`);
          }
          const rec = store.upsertMaterial({
            videoId: mat.videoId,
            content: normalized,
            sourcePath: mat.path ?? null,
            createdAt: runManifest.startedAt,
          });
          materialIdByVideo.set(mat.videoId, rec.id);
        }

        // 2. Insert legacy questions preserving original IDs and NULL generation_run_id
        const questionById = new Map<number, { materialId: number; question: string }>();
        for (const q of trialQuestions) {
          const materialId = materialIdByVideo.get(q.video_id);
          if (materialId === undefined) throw new Error(`问题 ${q.id} 缺少对应材料：${q.video_id}`);
          const { record } = store.insertQuestion({
            id: q.id,
            materialId,
            question: q.question,
            generationRunId: null,
            createdAt: runManifest.startedAt,
          });
          questionById.set(record.id, { materialId, question: record.question });
        }

        // 3. Create immutable run snapshot using only validated model metadata.
        const createdRunId = store.createRun({
          kind: "answer_judge",
          status: summary.state === "completed" ? "completed" : "error",
          startedAt: runManifest.startedAt,
          finishedAt: summary.finishedAt ?? null,
          maxAttempts: runManifest.maxAttempts,
          maxTurns: 1,
          config: {
            mode: runManifest.mode,
            model: sanitizedModel,
            reviewScope: runManifest.reviewScope ?? null,
            inputSchemaVersion: "v1-minimal-json",
          },
          prompts: {
            answer: runManifest.systemPrompts.answer,
            judge: runManifest.systemPrompts.judge,
          },
          skills: runManifest.skills,
          exportPolicy: {
            format: "messages_jsonl",
            training_enabled: Boolean(runManifest.trainingEnabled),
          },
          importKey,
        });

        // 4. Create all run_items
        const runItemIdByQuestionId = store.createRunItems(createdRunId, trialQuestions.map((q) => q.id));
        const roundsByQuestion = new Map<number, TrialRoundLine[]>();
        for (const round of rounds) {
          const list = roundsByQuestion.get(round.questionId) ?? [];
          list.push(round);
          roundsByQuestion.set(round.questionId, list);
        }
        const outcomeByQuestion = new Map<number, TrialOutcomeLine>();
        for (const outcome of outcomes) {
          outcomeByQuestion.set(outcome.questionId, outcome);
        }

        // 5. Replay each question's single turn, attempts, paired calls, and results
        for (const q of trialQuestions) {
          const runItemId = runItemIdByQuestionId.get(q.id)!;
          const qMeta = questionById.get(q.id)!;
          const qRounds = (roundsByQuestion.get(q.id) ?? []).sort((a, b) => a.attempt - b.attempt);
          const outcome = outcomeByQuestion.get(q.id);
          if (!outcome) throw new Error(`缺少问题 ${q.id} 的 outcome 记录`);
          if (qRounds.length !== outcome.attempts) {
            throw new Error(`问题 ${q.id} 的轮次数(${qRounds.length})与 outcome.attempts(${outcome.attempts})不一致`);
          }

          const firstTrace = pairedTraces.get(`${q.id}:1:answer`);
          if (!firstTrace) throw new Error(`缺少问题 ${q.id} 第 1 轮 answer trace`);
          store.startRunItem(runItemId, firstTrace.startedAt);
          const turnId = store.createTurn({ runItemId, turnNo: 1, startedAt: firstTrace.startedAt });

          let prevAttemptId: number | undefined;
          for (const round of qRounds) {
            const answerTrace = pairedTraces.get(`${q.id}:${round.attempt}:answer`);
            if (!answerTrace) throw new Error(`缺少问题 ${q.id} 第 ${round.attempt} 轮 answer trace`);
            const judgeTrace = pairedTraces.get(`${q.id}:${round.attempt}:judge`);

            const attemptId = store.startAttempt({ turnId, attemptNo: round.attempt, startedAt: answerTrace.startedAt });
            const answerInputRefs: Record<string, unknown> = {
              material: { material_id: qMeta.materialId, field: "content" },
              question: { question_id: q.id, field: "question" },
            };
            if (round.attempt > 1) {
              if (prevAttemptId === undefined) throw new Error(`问题 ${q.id} 第 ${round.attempt} 轮缺少上一轮 attemptId`);
              answerInputRefs.previousAnswer = { attempt_id: prevAttemptId, field: "answer" };
              answerInputRefs.feedback = { attempt_id: prevAttemptId, field: "feedback" };
            }

            const answerCallId = store.startModelCall({
              runId: createdRunId,
              role: "answer",
              turnId,
              attemptId,
              inputRefs: answerInputRefs,
              startedAt: answerTrace.startedAt,
            });

            if (answerTrace.status === "error") {
              store.failModelCall(answerCallId, answerTrace.error ?? "answer call failed", { finishedAt: answerTrace.finishedAt });
              store.finishAttemptError(attemptId, round.error ?? answerTrace.error ?? "answer call failed", answerTrace.finishedAt);
              store.finishTurnNonPass(turnId, "error", { finishedAt: answerTrace.finishedAt, error: round.error ?? answerTrace.error });
              store.finishRunItemNonPass(runItemId, "error", { finishedAt: answerTrace.finishedAt, error: round.error ?? answerTrace.error });
              break;
            }

            const answerOutput = nonEmpty(answerTrace.outputText, `问题 ${q.id} 第 ${round.attempt} 轮 answer output`);
            if (round.answer !== undefined && round.answer.trim() !== answerOutput) {
              throw new Error(`问题 ${q.id} 第 ${round.attempt} 轮 rounds.answer 与 traces.output 不一致`);
            }
            store.finishModelCall(answerCallId, answerTrace.outputText!, answerTrace.finishedAt);
            store.recordAttemptAnswer(attemptId, answerOutput);

            if (!judgeTrace) {
              const errMsg = round.error ?? "missing judge trace";
              store.finishAttemptError(attemptId, errMsg, answerTrace.finishedAt);
              store.finishTurnNonPass(turnId, "error", { finishedAt: answerTrace.finishedAt, error: errMsg });
              store.finishRunItemNonPass(runItemId, "error", { finishedAt: answerTrace.finishedAt, error: errMsg });
              break;
            }

            const judgeCallId = store.startModelCall({
              runId: createdRunId,
              role: "judge",
              turnId,
              attemptId,
              inputRefs: {
                question: { question_id: q.id, field: "question" },
                answer: { attempt_id: attemptId, field: "answer" },
              },
              startedAt: judgeTrace.startedAt,
            });

            if (judgeTrace.status === "error" || !round.review) {
              const errMsg = round.error ?? judgeTrace.error ?? "judge failed";
              store.failModelCall(judgeCallId, errMsg, { outputText: judgeTrace.outputText ?? null, finishedAt: judgeTrace.finishedAt });
              store.finishAttemptError(attemptId, errMsg, judgeTrace.finishedAt);
              store.finishTurnNonPass(turnId, "error", { finishedAt: judgeTrace.finishedAt, error: errMsg });
              store.finishRunItemNonPass(runItemId, "error", { finishedAt: judgeTrace.finishedAt, error: errMsg });
              break;
            }

            // Cross-check raw judge output parses to exact same review
            const parsedFromTrace = parseReview(judgeTrace.outputText ?? "");
            if (
              parsedFromTrace.decision !== round.review.decision
              || parsedFromTrace.feedback !== round.review.feedback
              || JSON.stringify(parsedFromTrace.issues) !== JSON.stringify(round.review.issues)
            ) {
              throw new Error(`问题 ${q.id} 第 ${round.attempt} 轮 judge trace 与 rounds.review 不一致`);
            }

            store.finishModelCall(judgeCallId, judgeTrace.outputText!, judgeTrace.finishedAt);
            store.finishAttemptReview(attemptId, round.review, judgeTrace.finishedAt);

            if (round.review.decision === "pass") {
              store.db.prepare("UPDATE turns SET status = 'pass', passed_attempt_id = ?, finished_at = ? WHERE id = ?")
                .run(attemptId, judgeTrace.finishedAt, turnId);
              store.db.prepare("UPDATE run_items SET status = 'pass', finished_at = ? WHERE id = ?")
                .run(judgeTrace.finishedAt, runItemId);
              store.db.prepare("INSERT INTO results (run_item_id, turn_count, created_at) VALUES (?, 1, ?)")
                .run(runItemId, judgeTrace.finishedAt);
            } else if (round.review.decision === "drop") {
              store.finishTurnNonPass(turnId, "drop", { finishedAt: judgeTrace.finishedAt });
              store.finishRunItemNonPass(runItemId, "drop", { finishedAt: judgeTrace.finishedAt });
            } else if (round.attempt === runManifest.maxAttempts) {
              store.finishTurnNonPass(turnId, "exhausted", { finishedAt: judgeTrace.finishedAt });
              store.finishRunItemNonPass(runItemId, "exhausted", { finishedAt: judgeTrace.finishedAt });
            }

            prevAttemptId = attemptId;
          }
        }

        return createdRunId;
      });
    }

    // Ensure all processed videos in SQLite are locked as train in video_splits
    backfillProcessedTrainSplits(store);

    // Verify migrated results match results.jsonl line-by-line
    const importedResults = store.queryResultTurns(runId);
    if (importedResults.length !== expectedResults.length) {
      throw new Error(`迁移结果数(${importedResults.length})与 results.jsonl(${expectedResults.length})不一致`);
    }
    for (let i = 0; i < expectedResults.length; i++) {
      const exp = expectedResults[i];
      const act = importedResults[i];
      if (
        act.question_id !== exp.questionId
        || act.user_content !== exp.question.trim()
        || act.assistant_content !== (exp.answer ?? "").trim()
        || act.attempt_no !== exp.attempts
      ) {
        throw new Error(`第 ${i + 1} 条迁移结果与 results.jsonl 不一致（questionId=${exp.questionId}）`);
      }
    }

    const integrity = store.checkIntegrity();
    if (!integrity.ok) {
      throw new Error(`数据库完整性校验失败：${JSON.stringify(integrity)}`);
    }

    const countTable = (table: string) =>
      Number((store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);

    const sourceDbHashAfter = createHash("sha256").update(await readFile(sourceDbPath)).digest("hex");

    return {
      alreadyImported,
      runId,
      importKey,
      sourceDbUnchanged: sourceDbHashBefore === sourceDbHashAfter,
      counts: {
        materials: countTable("materials"),
        questions: countTable("questions"),
        runs: countTable("runs"),
        runItems: countTable("run_items"),
        turns: countTable("turns"),
        attempts: countTable("attempts"),
        modelCalls: countTable("model_calls"),
        results: countTable("results"),
      },
      integrityOk: integrity.ok,
    };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      "questions-db": { type: "string" },
      trial: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      "将既有问题库和试跑目录幂等迁移到统一 SQLite 数据库\n" +
      "npm run migrate -- [--target data/data-maker.sqlite] [--questions-db data/questions.sqlite] [--trial output/database-trial-CkXhqo]",
    );
    return;
  }

  const report = await migrateTrialToSqlite({
    targetDbPath: resolve(values.target ?? join(ROOT, "data/data-maker.sqlite")),
    sourceQuestionsDbPath: resolve(values["questions-db"] ?? join(ROOT, "data/questions.sqlite")),
    trialDir: resolve(values.trial ?? join(ROOT, "output/database-trial-CkXhqo")),
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`错误：${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
