import { resolve } from "node:path";
import { combineSignals, isOperationAborted, rethrowIfAborted, throwIfAborted } from "../shared/cancellation.js";
import { writeOutputFile } from "../shared/cli-helpers.js";
import { publicErrorMessage } from "../shared/public-error.js";
import { DEFAULT_DEMO_DB, EXAMPLE_MATERIALS_PATH } from "../shared/paths.js";
import { nonEmpty, parseQuestions, validateMaxAttempts } from "../shared/schema.js";
import type { RoleRunner } from "../shared/types.js";
import { runDialogueBatch } from "./dialogue-loop.js";
import {
  answerPrompt,
  DEFAULT_PROMPTS_DIR,
  judgePrompt,
  questionPrompt,
  readSystemPrompts,
} from "./prompts.js";
import {
  DEFAULT_ANSWER_STYLE,
  DEFAULT_QUALITY_JUDGE,
  DEFAULT_QUESTION_SKILL,
  readAnswerStyle,
  readMaterials,
  readQuestionSkill,
  readRubric,
} from "./skills.js";
import { DataMakerStore } from "./store/index.js";

export const DEMO_DIRECTION = "根据传感器说明生成使用与告警规则的问答";

/** Deterministic plumbing fixture, not a language model or a quality evaluator. */
export function createDemoRunner(): RoleRunner {
  return async ({ role, input, signal }) => {
    throwIfAborted(signal);
    if (role === "question") {
      return JSON.stringify({ questions: [
        "雨量传感器在什么情况下触发和解除告警？",
        "雨量传感器的供电和工作温度要求是什么？",
        "雨量传感器使用了哪个厂商的芯片？",
      ] });
    }
    const question = String(input.question);
    if (role === "answer") {
      if (question.includes("触发")) {
        return input.previousAnswer === undefined
          ? "采样值达到20毫米时触发告警。"
          : "传感器每10分钟采样一次；采样值大于或等于20毫米时触发告警。告警后，连续3次采样值均低于15毫米才解除。缺失值不计入连续次数，也不触发告警。";
      }
      if (question.includes("供电")) return "供电电压为12V，工作温度为-10℃至50℃。";
      return "材料未提供芯片厂商信息。";
    }
    if (question.includes("厂商")) {
      return JSON.stringify({ decision: "drop", issues: ["演示：材料缺少芯片厂商信息"], feedback: "跳过此题。" });
    }
    if (question.includes("触发") && !String(input.answer).includes("连续3次")) {
      return JSON.stringify({ decision: "revise", issues: ["演示：遗漏解除条件"], feedback: "补充采样周期、解除告警条件，以及缺失采样值的处理方式。" });
    }
    return JSON.stringify({ decision: "pass", issues: [], feedback: "演示流程通过；此结论是固定脚本结果。" });
  };
}

export interface RunDemoOptions {
  signal?: AbortSignal;
  dbPath?: string;
  maxAttempts?: number;
  exportPath?: string;
  exportSystemPrompt?: string;
  onProgress?: (message: string) => void;
}

export interface RunDemoReport {
  db: string;
  mode: "demo";
  questionRunId: number;
  judgeRunId: number;
  materials: number;
  questions: number;
  passed: number;
  dropped: number;
  exhausted: number;
  errors: number;
  results: number;
  trainingEnabled: false;
  integrityOk: boolean;
  exportedPath?: string;
}

/**
 * Self-contained 30-second offline demo powered directly by DataMakerStore + runDialogueBatch.
 * Demonstrates revise -> pass, direct pass, and drop branches with zero API keys.
 */
export async function runDemo(options: RunDemoOptions = {}): Promise<RunDemoReport> {
  throwIfAborted(options.signal);
  const dbPath = resolve(options.dbPath ?? DEFAULT_DEMO_DB);
  const maxAttempts = validateMaxAttempts(options.maxAttempts ?? 3);

  const materials = await readMaterials(EXAMPLE_MATERIALS_PATH);
  const [questionSkill, answerStyle, rubric, prompts] = await Promise.all([
    readQuestionSkill(DEFAULT_QUESTION_SKILL),
    readAnswerStyle(DEFAULT_ANSWER_STYLE),
    readRubric(DEFAULT_QUALITY_JUDGE),
    readSystemPrompts(DEFAULT_PROMPTS_DIR),
  ]);

  const qSystemPrompt = questionPrompt(prompts.question, questionSkill.body);
  const aSystemPrompt = answerPrompt(prompts.answer, answerStyle.body);
  const jSystemPrompt = judgePrompt(prompts.judge, rubric.body);
  const runRole = createDemoRunner();

  throwIfAborted(options.signal);
  const store = new DataMakerStore(dbPath);
  const signal = combineSignals(options.signal, store.signal);
  let activeQuestionRunId: number | undefined;
  try {
    throwIfAborted(signal);
    store.markInterruptedRuns();

    const questionRunId = store.createRun({
      kind: "question_generation",
      maxAttempts: 1,
      maxTurns: 1,
      config: {
        mode: "demo",
        direction: DEMO_DIRECTION,
        model: "deterministic-demo-fixture",
      },
      prompts: { question: qSystemPrompt },
      skills: [{
        name: "question-design",
        path: DEFAULT_QUESTION_SKILL,
        status: questionSkill.status,
        body: questionSkill.body,
        sha256: questionSkill.sha256,
      }],
      exportPolicy: { format: "messages_jsonl", training_enabled: false },
    });

    activeQuestionRunId = questionRunId;
    const generatedQuestionIds: number[] = [];
    for (const raw of materials) {
      throwIfAborted(signal);
      const materialRecord = store.upsertMaterial({ videoId: raw.id, content: raw.text });
      const callId = store.startModelCall({
        runId: questionRunId,
        role: "question",
        materialId: materialRecord.id,
        inputRefs: { material: { material_id: materialRecord.id, field: "content" }, video_id: raw.id },
      });
      const output = await runRole({
        role: "question",
        systemPrompt: qSystemPrompt,
        input: { material: raw, direction: DEMO_DIRECTION },
        signal,
      });
      throwIfAborted(signal);
      const questions = parseQuestions(output);
      store.transaction(() => {
        store.finishModelCall(callId, output);
        for (const q of questions) {
          const { record } = store.insertQuestion({
            materialId: materialRecord.id,
            question: q,
            generationRunId: questionRunId,
          });
          generatedQuestionIds.push(record.id);
        }
      });
    }
    throwIfAborted(signal);
    store.finishRun(questionRunId, "completed");
    activeQuestionRunId = undefined;

    const dialogue = await runDialogueBatch({
      store,
      signal,
      runRole,
      prompts: { answer: aSystemPrompt, judge: jSystemPrompt },
      maxAttempts,
      maxTurns: 1,
      concurrency: 1,
      questionIds: generatedQuestionIds,
      config: {
        mode: "demo",
        model: "deterministic-demo-fixture",
        questionRunId,
      },
      skills: [
        { name: "answer-style", path: DEFAULT_ANSWER_STYLE, status: answerStyle.status, body: answerStyle.body, sha256: answerStyle.sha256 },
        { name: "quality-judge", path: DEFAULT_QUALITY_JUDGE, status: rubric.status, body: rubric.body, sha256: rubric.sha256 },
      ],
      exportPolicy: { format: "messages_jsonl", training_enabled: false },
      onProgress: options.onProgress,
    });

    throwIfAborted(signal);
    let exportedPath: string | undefined;
    if (options.exportPath !== undefined) {
      const jsonl = store.exportRunJsonl(dialogue.runId, { systemPrompt: options.exportSystemPrompt });
      exportedPath = await writeOutputFile(nonEmpty(options.exportPath, "--export"), jsonl);
      throwIfAborted(signal);
    }

    const passed = dialogue.outcomes.pass ?? 0;
    const dropped = dialogue.outcomes.drop ?? 0;
    const exhausted = dialogue.outcomes.exhausted ?? 0;

    return {
      db: dbPath,
      mode: "demo",
      questionRunId,
      judgeRunId: dialogue.runId,
      materials: materials.length,
      questions: generatedQuestionIds.length,
      passed,
      dropped,
      exhausted,
      errors: dialogue.errors,
      results: dialogue.results,
      trainingEnabled: false,
      integrityOk: dialogue.integrityOk,
      ...(exportedPath ? { exportedPath } : {}),
    };
  } catch (error) {
    if (activeQuestionRunId !== undefined) {
      const message = publicErrorMessage(error);
      store.interruptOwnedRun(activeQuestionRunId, message);
      store.finishRun(activeQuestionRunId, isOperationAborted(error) || signal?.aborted ? "interrupted" : "error", { error: message });
    }
    rethrowIfAborted(error, signal);
    throw error;
  } finally {
    store.close();
  }
}
