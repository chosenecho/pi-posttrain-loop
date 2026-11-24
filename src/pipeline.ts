import { DataMakerStore, validateMaxTurns } from "./db.js";
import { runDialogueBatch, type RunDialogueBatchSummary } from "./dialogue-loop.js";
import { readAnswerStyle, readFollowupSkill, readQuestionSkill } from "./io.js";
import { answerPrompt, followupPrompt as composeFollowupPrompt, judgePrompt, questionPrompt, readFollowupPrompt, readSystemPrompts } from "./prompts.js";
import { errorMessage, nonEmpty, parseMaterial, parseQuestions, validateConcurrency, validateMaxAttempts } from "./schema.js";
import type { Material, MaterialResult, OutcomeSummary, ResultSample, Review, RoleRunner, Rubric, RunMaterialOptions, Skill, SystemPrompts } from "./types.js";

export interface SkillSnapshot {
  name: "question-design" | "followup-strategy" | "answer-style" | "quality-judge";
  path?: string;
  status: Skill["status"];
  body: string;
  sha256: string;
}

export interface RunMaterialsToStoreOptions {
  store: DataMakerStore;
  materials: Material[];
  direction: string;
  rubric: Rubric;
  questionSkill?: Skill;
  followupSkill?: Skill;
  answerStyle?: Skill;
  prompts?: SystemPrompts;
  followupPrompt?: string;
  runRole: RoleRunner;
  maxAttempts?: number;
  maxTurns?: number;
  concurrency?: number;
  mode?: "live" | "demo";
  config?: Record<string, unknown>;
  skillPaths?: {
    questionSkillPath?: string;
    followupSkillPath?: string;
    rubricPath?: string;
    answerStylePath?: string;
  };
  throwOnQuestionError?: boolean;
  onProgress?: (message: string) => void;
}

export interface RunMaterialsToStoreResult {
  questionRunId: number;
  judgeRunId?: number;
  materials: number;
  generatedQuestions: number;
  questionErrors: number;
  trainingEnabled: boolean;
  dialogue?: RunDialogueBatchSummary;
  integrityOk: boolean;
}

/**
 * Unified SQLite-backed material pipeline:
 * upserts materials -> generates questions (question_generation run) -> runs bounded single/multi-turn dialogue loop (answer_judge run).
 * Each role receives strictly its own isolated Skill snapshot.
 */
export async function runMaterialsToStore(options: RunMaterialsToStoreOptions): Promise<RunMaterialsToStoreResult> {
  const { store, runRole } = options;
  if (options.materials.length === 0) throw new Error("输入文件中没有材料");
  const materials = options.materials.map((item) => parseMaterial(item));
  const direction = nonEmpty(options.direction, "direction");
  const maxAttempts = validateMaxAttempts(options.maxAttempts ?? 3);
  const maxTurns = validateMaxTurns(options.maxTurns ?? 1);
  const concurrency = validateConcurrency(options.concurrency ?? 1);
  const mode = options.mode ?? "live";
  nonEmpty(options.rubric.body, "判断 Skill 正文");
  const prompts = options.prompts ?? await readSystemPrompts();
  const questionSkill = options.questionSkill ?? await readQuestionSkill();
  nonEmpty(questionSkill.body, "出题 Skill 正文");
  const answerStyle = options.answerStyle ?? await readAnswerStyle();
  nonEmpty(answerStyle.body, "回答风格 Skill 正文");

  let followupFullPrompt: string | undefined;
  let followupSkillSnapshot: SkillSnapshot | undefined;
  if (maxTurns > 1) {
    const baseFollowup = options.followupPrompt ?? await readFollowupPrompt();
    const followupSkill = options.followupSkill ?? await readFollowupSkill();
    nonEmpty(followupSkill.body, "追问 Skill 正文");
    followupFullPrompt = composeFollowupPrompt(nonEmpty(baseFollowup, "多轮追问系统提示词"), followupSkill.body);
    followupSkillSnapshot = {
      name: "followup-strategy",
      ...(options.skillPaths?.followupSkillPath ? { path: options.skillPaths.followupSkillPath } : {}),
      status: followupSkill.status,
      body: followupSkill.body,
      sha256: followupSkill.sha256,
    };
  }

  const questioningPrompt = questionPrompt(prompts.question, questionSkill.body);
  const answeringPrompt = answerPrompt(prompts.answer, answerStyle.body);
  const judgingPrompt = judgePrompt(prompts.judge, options.rubric.body);
  const trainingEnabled = mode === "live" && options.rubric.status === "ready";

  const questionSkills: SkillSnapshot[] = [
    {
      name: "question-design",
      ...(options.skillPaths?.questionSkillPath ? { path: options.skillPaths.questionSkillPath } : {}),
      status: questionSkill.status,
      body: questionSkill.body,
      sha256: questionSkill.sha256,
    },
  ];

  const dialogueSkills: SkillSnapshot[] = [
    {
      name: "answer-style",
      ...(options.skillPaths?.answerStylePath ? { path: options.skillPaths.answerStylePath } : {}),
      status: answerStyle.status,
      body: answerStyle.body,
      sha256: answerStyle.sha256,
    },
    {
      name: "quality-judge",
      ...(options.skillPaths?.rubricPath ? { path: options.skillPaths.rubricPath } : {}),
      status: options.rubric.status,
      body: options.rubric.body,
      sha256: options.rubric.sha256,
    },
    ...(followupSkillSnapshot ? [followupSkillSnapshot] : []),
  ];

  store.markInterruptedRuns();

  const questionRunId = store.createRun({
    kind: "question_generation",
    maxAttempts: 1,
    maxTurns: 1,
    config: {
      mode,
      direction,
      concurrency,
      ...(options.config ?? {}),
      inputSchemaVersion: "v1-minimal-json",
    },
    prompts: { question: questioningPrompt },
    skills: questionSkills,
    exportPolicy: { format: "messages_jsonl", training_enabled: false },
  });

  const perMaterialQuestionIds: number[][] = Array.from({ length: materials.length }, () => []);
  let questionErrors = 0;
  let fatalQuestionError: unknown;
  let nextMaterialIndex = 0;
  const questionWorkers = Array.from({ length: Math.min(concurrency, materials.length) }, async () => {
    while (nextMaterialIndex < materials.length && fatalQuestionError === undefined) {
      const idx = nextMaterialIndex++;
      const rawMaterial = materials[idx];
      const materialRecord = store.upsertMaterial({
        videoId: rawMaterial.id,
        content: rawMaterial.text,
      });
      const callId = store.startModelCall({
        runId: questionRunId,
        role: "question",
        materialId: materialRecord.id,
        inputRefs: {
          material: { material_id: materialRecord.id, field: "content" },
          video_id: rawMaterial.id,
          direction,
        },
      });

      let rawOutput: string | undefined;
      try {
        rawOutput = await runRole({
          role: "question",
          systemPrompt: questioningPrompt,
          input: { material: { id: rawMaterial.id, text: materialRecord.content }, direction },
        });
        const parsed = parseQuestions(rawOutput);
        store.transaction(() => {
          store.finishModelCall(callId, rawOutput!);
          for (const qText of parsed) {
            const { record } = store.insertQuestion({
              materialId: materialRecord.id,
              question: qText,
              generationRunId: questionRunId,
            });
            perMaterialQuestionIds[idx].push(record.id);
          }
        });
      } catch (error) {
        const msg = errorMessage(error);
        store.failModelCall(callId, msg, { outputText: rawOutput ?? null });
        questionErrors++;
        options.onProgress?.(`[${rawMaterial.id}] 出题失败：${msg}`);
        if (options.throwOnQuestionError) {
          fatalQuestionError = error;
          return;
        }
      }
    }
  });
  await Promise.all(questionWorkers);

  if (fatalQuestionError !== undefined) {
    store.finishRun(questionRunId, "error", { error: errorMessage(fatalQuestionError) });
    throw fatalQuestionError;
  }

  const generatedQuestionIds: number[] = [];
  const seenQuestionIds = new Set<number>();
  for (const ids of perMaterialQuestionIds) {
    for (const id of ids) {
      if (!seenQuestionIds.has(id)) {
        seenQuestionIds.add(id);
        generatedQuestionIds.push(id);
      }
    }
  }

  store.finishRun(questionRunId, "completed");

  if (generatedQuestionIds.length === 0) {
    return {
      questionRunId,
      materials: materials.length,
      generatedQuestions: 0,
      questionErrors,
      trainingEnabled,
      integrityOk: store.checkIntegrity().ok,
    };
  }

  const dialogue = await runDialogueBatch({
    store,
    runRole,
    prompts: {
      answer: answeringPrompt,
      judge: judgingPrompt,
      followup: followupFullPrompt,
    },
    maxAttempts,
    maxTurns,
    concurrency,
    questionIds: generatedQuestionIds,
    config: {
      mode,
      direction,
      ...(options.config ?? {}),
      inputSchemaVersion: maxTurns > 1 ? "v2-multiturn-json" : "v1-minimal-json",
    },
    skills: dialogueSkills,
    exportPolicy: {
      format: "messages_jsonl",
      training_enabled: trainingEnabled,
    },
    onProgress: options.onProgress,
  });

  return {
    questionRunId,
    judgeRunId: dialogue.runId,
    materials: materials.length,
    generatedQuestions: generatedQuestionIds.length,
    questionErrors,
    trainingEnabled,
    dialogue,
    integrityOk: store.checkIntegrity().ok,
  };
}

/**
 * In-memory single-material helper backed by the exact same DataMakerStore + runDialogueBatch loop.
 * Returns converged results (pure user/assistant messages without material concatenation) and outcomes.
 */
export async function runMaterial(options: RunMaterialOptions): Promise<MaterialResult> {
  const store = new DataMakerStore(":memory:");
  try {
    const run = await runMaterialsToStore({
      store,
      materials: [options.material],
      direction: options.direction,
      rubric: options.rubric,
      questionSkill: options.questionSkill,
      followupSkill: options.followupSkill,
      answerStyle: options.answerStyle,
      prompts: options.prompts,
      followupPrompt: options.followupPrompt,
      runRole: options.runRole,
      maxAttempts: options.maxAttempts,
      maxTurns: options.maxTurns,
      mode: options.mode,
      throwOnQuestionError: true,
    });

    if (run.judgeRunId === undefined) {
      return { results: [], outcomes: [] };
    }

    const resultRows = store.queryResultTurns(run.judgeRunId);
    const resultsById = new Map<number, ResultSample>();
    for (const row of resultRows) {
      let sample = resultsById.get(row.result_id);
      if (!sample) {
        sample = {
          questionId: row.question_id,
          materialId: row.material_id,
          attempts: row.attempt_no,
          messages: [],
        };
        resultsById.set(row.result_id, sample);
      }
      sample.attempts = row.attempt_no;
      sample.messages.push(
        { role: "user", content: row.user_content },
        { role: "assistant", content: row.assistant_content },
      );
    }

    const outcomeRows = store.db.prepare(`
      SELECT i.id AS run_item_id, i.question_id, q.question, i.status, i.error
      FROM run_items i
      JOIN questions q ON q.id = i.question_id
      WHERE i.run_id = ?
      ORDER BY i.id
    `).all(run.judgeRunId) as Array<{
      run_item_id: number;
      question_id: number;
      question: string;
      status: OutcomeSummary["status"];
      error: string | null;
    }>;

    const outcomes: OutcomeSummary[] = outcomeRows.map((row) => {
      const lastAttempt = store.db.prepare(`
        SELECT a.attempt_no, a.decision, a.issues_json, a.feedback
        FROM attempts a
        JOIN turns t ON t.id = a.turn_id
        WHERE t.run_item_id = ?
        ORDER BY t.turn_no DESC, a.attempt_no DESC
        LIMIT 1
      `).get(row.run_item_id) as {
        attempt_no: number;
        decision: Review["decision"] | null;
        issues_json: string | null;
        feedback: string | null;
      } | undefined;

      const outcome: OutcomeSummary = {
        questionId: Number(row.question_id),
        question: row.question,
        status: row.status,
        attempts: lastAttempt ? Number(lastAttempt.attempt_no) : 0,
      };
      if (lastAttempt?.decision) {
        outcome.review = {
          decision: lastAttempt.decision,
          issues: JSON.parse(lastAttempt.issues_json ?? "[]") as string[],
          feedback: lastAttempt.feedback ?? "",
        };
      }
      if (row.error) outcome.error = row.error;
      return outcome;
    });

    return { results: [...resultsById.values()], outcomes };
  } finally {
    store.close();
  }
}
