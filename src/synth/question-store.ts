import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DatabaseSync } from "node:sqlite";
import type { DataMakerStore } from "./store/index.js";

export interface SaveReceipt {
  video_id: string;
  saved_count: number;
  skipped_count: number;
}

function validateSaveInput(input: unknown, expectedVideoId: string): string[] {
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

function saveQuestionsParameters(expectedVideoId: string, maxQuestions?: number) {
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
      const questions = validateSaveInput(input, expectedVideoId);
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

/** Unified SQLite store helper: binds material_id and generation_run_id in one atomic transaction. */
export function createUnifiedSaveQuestionsTool(
  store: DataMakerStore,
  materialId: number,
  expectedVideoId: string,
  generationRunId: number,
  onSaved: (receipt: SaveReceipt) => void,
  options: { maxQuestions?: number } = {},
): AgentTool {
  const maxQuestions = options.maxQuestions;
  return {
    name: "save_questions",
    label: "保存问题",
    description: maxQuestions !== undefined
      ? `将本篇文稿的问题字符串数组保存到统一 SQLite（本篇最多保存 ${maxQuestions} 题），返回实际新增和跳过的数量。`
      : "将本篇文稿的问题字符串数组保存到统一 SQLite，返回实际新增和跳过重复的数量。",
    parameters: saveQuestionsParameters(expectedVideoId, maxQuestions),
    async execute(_toolCallId, input) {
      const questions = validateSaveInput(input, expectedVideoId);
      const savedCount = store.transaction(() => {
        let inserted = 0;
        for (const question of questions) {
          if (maxQuestions !== undefined && inserted >= maxQuestions) {
            break;
          }
          const res = store.insertQuestion({ materialId, question, generationRunId });
          if (res.inserted) inserted++;
        }
        return inserted;
      });
      const receipt = { video_id: expectedVideoId, saved_count: savedCount, skipped_count: questions.length - savedCount };
      onSaved(receipt);
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
    },
  };
}
