import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DatabaseSync } from "node:sqlite";
import type { QuestionMode, QuestionTaskSpec, SynthProfile } from "../shared/types.js";
import type { DataMakerStore } from "./store/index.js";

export interface SaveReceipt {
  video_id: string;
  saved_count: number;
  skipped_count: number;
}

export interface NormalizedQuestionEntry {
  question: string;
  questionMode: QuestionMode;
  taskSpec: QuestionTaskSpec | null;
}

export function inferQuestionModeFromProfile(profile?: SynthProfile | string): QuestionMode {
  if (profile === "todo") return "todo_plan";
  if (profile === "clarify") return "clarify_question";
  return "direct";
}

function validateStringQuestions(input: unknown, expectedVideoId: string): string[] {
  if (!input || typeof input !== "object" || !("video_id" in input) || input.video_id !== expectedVideoId) {
    throw new Error("video_id 必须与本篇文稿一致");
  }
  if (
    !("questions" in input)
    || !Array.isArray(input.questions)
    || !input.questions.every((question): question is string => typeof question === "string" && question.trim().length > 0)
  ) {
    throw new Error("questions 必须是非空问题字符串组成的数组，也可为空数组");
  }
  return input.questions.map((question) => question.trim());
}

function normalizeStringArrayField(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return cleaned.length > 0 ? cleaned : undefined;
}

function validateUnifiedSaveInput(
  input: unknown,
  expectedVideoId: string,
  defaultMode: QuestionMode,
  profile?: SynthProfile | string,
): NormalizedQuestionEntry[] {
  if (!input || typeof input !== "object" || !("video_id" in input) || input.video_id !== expectedVideoId) {
    throw new Error("video_id 必须与本篇文稿一致");
  }
  if (!("questions" in input) || !Array.isArray(input.questions)) {
    throw new Error("questions 必须是非空问题数组，也可为空数组");
  }

  return input.questions.map((item, idx) => {
    if (typeof item === "string") {
      const q = item.trim();
      if (!q) {
        throw new Error(`questions[${idx}] 必须是非空问题字符串`);
      }
      const spec: QuestionTaskSpec | null = profile
        ? { profile: profile as SynthProfile }
        : null;
      return {
        question: q,
        questionMode: defaultMode,
        taskSpec: spec,
      };
    }

    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as {
        question?: unknown;
        expected_phases?: unknown;
        missing_slots?: unknown;
        hidden_user_persona?: unknown;
        difficulty?: unknown;
      };
      if (typeof obj.question !== "string" || !obj.question.trim()) {
        throw new Error(`questions[${idx}].question 必须是非空问题字符串`);
      }
      const question = obj.question.trim();
      const expectedPhases = normalizeStringArrayField(obj.expected_phases);
      const missingSlots = normalizeStringArrayField(obj.missing_slots);
      const hiddenUserPersona = typeof obj.hidden_user_persona === "string" && obj.hidden_user_persona.trim()
        ? obj.hidden_user_persona.trim()
        : undefined;
      const difficulty = (obj.difficulty === "easy" || obj.difficulty === "medium" || obj.difficulty === "hard")
        ? obj.difficulty
        : undefined;

      const taskSpec: QuestionTaskSpec = {
        ...(profile ? { profile: profile as SynthProfile } : {}),
        ...(difficulty ? { difficulty } : {}),
        ...(expectedPhases ? { expected_phases: expectedPhases } : {}),
        ...(missingSlots ? { missing_slots: missingSlots } : {}),
        ...(hiddenUserPersona ? { hidden_user_persona: hiddenUserPersona } : {}),
      };

      return {
        question,
        questionMode: defaultMode,
        taskSpec: Object.keys(taskSpec).length > 0 ? taskSpec : null,
      };
    }

    throw new Error(`questions[${idx}] 必须是非空问题字符串或任务契约对象`);
  });
}

function saveQuestionsParameters(
  expectedVideoId: string,
  maxQuestions?: number,
  questionMode: QuestionMode = "direct",
) {
  if (questionMode === "todo_plan") {
    return {
      type: "object",
      properties: {
        video_id: { type: "string", const: expectedVideoId },
        questions: {
          type: "array",
          items: {
            anyOf: [
              { type: "string", minLength: 1 },
              {
                type: "object",
                properties: {
                  question: { type: "string", minLength: 1, description: "多阶段长流程问题正文" },
                  expected_phases: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                    description: "预计需要拆解的 3–5 个关键分析子阶段（仅供质检参考）",
                  },
                },
                required: ["question"],
              },
            ],
          },
          ...(maxQuestions !== undefined ? { maxItems: maxQuestions } : {}),
        },
      },
      required: ["video_id", "questions"],
      additionalProperties: false,
    };
  }

  if (questionMode === "clarify_question") {
    return {
      type: "object",
      properties: {
        video_id: { type: "string", const: expectedVideoId },
        questions: {
          type: "array",
          items: {
            anyOf: [
              { type: "string", minLength: 1 },
              {
                type: "object",
                properties: {
                  question: { type: "string", minLength: 1, description: "故意剥离了关键边界条件的表面模糊提问" },
                  missing_slots: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                    description: "被剥离的 1–3 个决定判断走向的核心缺失维度",
                  },
                  hidden_user_persona: {
                    type: "string",
                    minLength: 1,
                    description: "提问者被隐藏的真实处境与背景设定（当回答者调用 question/questionnaire 追问时，用户模拟器依此应答）",
                  },
                },
                required: ["question", "hidden_user_persona"],
              },
            ],
          },
          ...(maxQuestions !== undefined ? { maxItems: maxQuestions } : {}),
        },
      },
      required: ["video_id", "questions"],
      additionalProperties: false,
    };
  }

  return {
    type: "object",
    properties: {
      video_id: { type: "string", const: expectedVideoId },
      questions: {
        type: "array",
        items: { type: "string", minLength: 1 },
        ...(maxQuestions !== undefined ? { maxItems: maxQuestions } : {}),
      },
    },
    required: ["video_id", "questions"],
    additionalProperties: false,
  };
}

/** Single-table helper for standalone question databases. */
export function createSaveQuestionsTool(
  db: DatabaseSync,
  expectedVideoId: string,
  onSaved: (receipt: SaveReceipt) => void,
): AgentTool {
  return {
    name: "save_questions",
    label: "保存问题",
    description: "将本篇文稿的问题字符串数组保存到 SQLite，返回实际新增和跳过重复的数量。",
    parameters: saveQuestionsParameters(expectedVideoId),
    async execute(_toolCallId, input) {
      const questions = validateStringQuestions(input, expectedVideoId);
      const insert = db.prepare(`INSERT INTO questions (video_id, question)
        SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM questions WHERE video_id = ? AND question = ?)`);
      let savedCount = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const question of questions) {
          savedCount += Number(insert.run(expectedVideoId, question, expectedVideoId, question).changes);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const receipt = { video_id: expectedVideoId, saved_count: savedCount, skipped_count: questions.length - savedCount };
      onSaved(receipt);
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
    },
  };
}

/** Unified SQLite store helper: binds material_id, generation_run_id, question_mode, and task_spec in one atomic transaction. */
export function createUnifiedSaveQuestionsTool(
  store: DataMakerStore,
  materialId: number,
  expectedVideoId: string,
  generationRunId: number,
  onSaved: (receipt: SaveReceipt) => void,
  options: { maxQuestions?: number; profile?: SynthProfile | string; questionMode?: QuestionMode } = {},
): AgentTool {
  const maxQuestions = options.maxQuestions;
  const questionMode = options.questionMode ?? inferQuestionModeFromProfile(options.profile);
  return {
    name: "save_questions",
    label: "保存问题",
    description: maxQuestions !== undefined
      ? `将本篇文稿的问题（或带隐藏设定/阶段契约的问题对象）数组保存到统一 SQLite（本篇最多保存 ${maxQuestions} 题），返回实际新增和跳过的数量。`
      : "将本篇文稿的问题数组保存到统一 SQLite，返回实际新增和跳过重复的数量。",
    parameters: saveQuestionsParameters(expectedVideoId, maxQuestions, questionMode),
    async execute(_toolCallId, input) {
      const entries = validateUnifiedSaveInput(input, expectedVideoId, questionMode, options.profile);
      const savedCount = store.transaction(() => {
        let inserted = 0;
        for (const entry of entries) {
          if (maxQuestions !== undefined && inserted >= maxQuestions) {
            break;
          }
          const res = store.insertQuestion({
            materialId,
            question: entry.question,
            generationRunId,
            questionMode: entry.questionMode,
            taskSpec: entry.taskSpec,
          });
          if (res.inserted) inserted++;
        }
        return inserted;
      });
      const receipt = { video_id: expectedVideoId, saved_count: savedCount, skipped_count: entries.length - savedCount };
      onSaved(receipt);
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
    },
  };
}
