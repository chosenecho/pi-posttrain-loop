import type { AgentTool } from "@earendil-works/pi-agent-core";
import { nonEmpty, parseJson } from "./schema.js";
import {
  PI_QUESTION_TOOL_DEFINITION,
  PI_QUESTIONNAIRE_TOOL_DEFINITION,
  PI_TODO_TOOL_DEFINITION,
} from "./tool-schema.js";
import type { RoleRunner, ToolStep } from "./types.js";

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

export interface CreateTodoToolOptions {
  /** Max todo tool calls allowed within a single turn (default 12). */
  maxCalls?: number;
  onStep?: (step: ToolStep) => void;
}

function formatTodoItem(item: TodoItem): string {
  return `#${item.id} [${item.done ? "x" : " "}] ${item.text}`;
}

function formatTodoList(items: readonly TodoItem[]): string {
  if (items.length === 0) return "No todos";
  return items.map(formatTodoItem).join("\n");
}

/**
 * In-memory sandbox implementation of Pi's official `todo` extension tool
 * (`packages/coding-agent/examples/extensions/todo.ts`).
 */
export function createTodoAgentTool(options: CreateTodoToolOptions = {}): AgentTool {
  const maxCalls = Math.max(1, Math.floor(options.maxCalls ?? 12));
  const items: TodoItem[] = [];
  let nextId = 1;
  let callCount = 0;

  return {
    name: "todo",
    label: "Todo",
    description: PI_TODO_TOOL_DEFINITION.function.description,
    parameters: PI_TODO_TOOL_DEFINITION.function.parameters as AgentTool["parameters"],
    async execute(_toolCallId, rawInput) {
      if (!rawInput || typeof rawInput !== "object" || !("action" in rawInput)) {
        throw new Error("todo 必须提供 action 参数（list | add | toggle | clear）");
      }
      const input = rawInput as { action: unknown; text?: unknown; id?: unknown };
      const action = input.action;
      if (action !== "list" && action !== "add" && action !== "toggle" && action !== "clear") {
        throw new Error(`todo action 必须是 list、add、toggle 或 clear，当前值：${String(action)}`);
      }

      if (callCount >= maxCalls) {
        const text = `Todo calls limit (${maxCalls}) reached. Current list:\n${formatTodoList(items)}`;
        return {
          content: [{ type: "text", text }],
          details: { action, items: items.map((i) => ({ ...i })), error: "limit_reached" },
        };
      }

      let outputText: string;
      const recordedArgs: Record<string, unknown> = { action };

      if (action === "list") {
        outputText = formatTodoList(items);
      } else if (action === "add") {
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (!text) {
          outputText = "Error: text required for add";
        } else {
          recordedArgs.text = text;
          const newItem: TodoItem = { id: nextId++, text, done: false };
          items.push(newItem);
          outputText = `Added ${formatTodoItem(newItem)}`;
        }
      } else if (action === "toggle") {
        const id = typeof input.id === "number" ? input.id : Number(input.id);
        if (!Number.isInteger(id) || id < 1) {
          outputText = "Error: id required for toggle";
        } else {
          recordedArgs.id = id;
          const target = items.find((item) => item.id === id);
          if (!target) {
            outputText = `Todo #${id} not found`;
          } else {
            target.done = !target.done;
            outputText = `${target.done ? "Completed" : "Uncompleted"} ${formatTodoItem(target)}`;
          }
        }
      } else {
        const count = items.length;
        items.length = 0;
        nextId = 1;
        outputText = `Cleared ${count} todos`;
      }

      callCount++;
      options.onStep?.({
        stepNo: callCount,
        toolName: "todo",
        arguments: recordedArgs,
        toolOutput: outputText,
      });

      return {
        content: [{ type: "text", text: outputText }],
        details: { action, items: items.map((i) => ({ ...i })) },
      };
    },
  };
}

export interface QuestionOptionItem {
  label: string;
  description?: string;
}

export interface QuestionnaireOptionItem {
  value: string;
  label: string;
  description?: string;
}

export interface QuestionnaireQuestionItem {
  id: string;
  label?: string;
  prompt: string;
  options: QuestionnaireOptionItem[];
  allowOther?: boolean;
}

export interface QuestionnaireAnswerItem {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

export interface UserSimulatorContext {
  question?: string;
  material?: string;
  hiddenUserPersona?: string;
  missingSlots?: string[];
  /** Optional LLM runner (`followup` role) for semantic option matching when persona is nuanced. */
  runRole?: RoleRunner;
}

export interface CreateClarifyToolOptions {
  context?: UserSimulatorContext;
  /** Max clarification calls allowed per turn (default 1). */
  maxCalls?: number;
  onStep?: (step: ToolStep) => void;
}

/**
 * Deterministic token/substring overlap matcher between hiddenUserPersona and option labels/descriptions.
 * Falls back to the first option when no persona is provided or overlap is tied at zero.
 */
export function selectBestOptionDeterministically<T extends { label: string; description?: string; value?: string }>(
  options: readonly T[],
  personaText: string,
  promptText = "",
): { option: T; index: number } {
  if (options.length === 0) {
    throw new Error("options 不能为空数组");
  }
  const cleanPersona = personaText.trim().toLowerCase();
  if (!cleanPersona) {
    return { option: options[0]!, index: 1 };
  }

  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const candidate = `${opt.label} ${opt.description ?? ""} ${opt.value ?? ""}`.toLowerCase();
    let score = 0;
    // Exact phrase match bonus
    const cleanLabel = opt.label.trim().toLowerCase();
    if (cleanLabel.length >= 2 && cleanPersona.includes(cleanLabel)) {
      score += 50;
    }
    // 2-gram character overlap for Chinese / English phrases
    const compact = candidate.replace(/[\s，。！？、；：“”‘’（）()[\]【】《》—\-/,.!?;:'"]+/g, "");
    for (let j = 0; j < compact.length - 1; j++) {
      const bigram = compact.slice(j, j + 2);
      if (cleanPersona.includes(bigram)) {
        score += 3;
      }
    }
    for (let j = 0; j < compact.length; j++) {
      const ch = compact[j]!;
      if (cleanPersona.includes(ch)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // If zero overlap, pick deterministically using hash of persona + prompt
  if (bestScore <= 0) {
    let hash = 0;
    const seedStr = `${cleanPersona}:${promptText}`;
    for (let i = 0; i < seedStr.length; i++) {
      hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
    }
    bestIdx = hash % options.length;
  }

  return { option: options[bestIdx]!, index: bestIdx + 1 };
}

const USER_SIMULATOR_SYSTEM_PROMPT = `你扮演提出问题的真实用户，正在回答助手通过追问工具（question / questionnaire）发出的澄清选项。
请严格依据给定的 <hidden_user_persona>（你的真实处境与隐藏背景）从候选 options 中选出最符合你真实处境的一项。
如果所有预设选项都与你的真实处境严重不符且允许补充，可以用一句话大白话简短说明真实情况（不超过25字）；只要有基本契合的预设选项，优先直接选该选项。
仅输出合法的 JSON 对象，不带任何解释或代码围栏。`;

async function simulateSingleQuestionSelection(
  questionText: string,
  options: readonly QuestionOptionItem[],
  ctx?: UserSimulatorContext,
): Promise<{ selectedLabel: string }> {
  const persona = ctx?.hiddenUserPersona?.trim() ?? "";
  if (ctx?.runRole && persona) {
    try {
      const raw = await ctx.runRole({
        role: "followup",
        systemPrompt: USER_SIMULATOR_SYSTEM_PROMPT,
        input: {
          original_question: ctx.question ?? "",
          hidden_user_persona: persona,
          missing_slots: ctx.missingSlots ?? [],
          clarifying_question: questionText,
          options: options.map((o, idx) => ({ index: idx + 1, label: o.label, ...(o.description ? { description: o.description } : {}) })),
          output_contract: '输出 {"selected_index": 1..N} 或 {"custom_reply": "简短大白话"}',
        },
      });
      const parsed = parseJson(raw) as { selected_index?: unknown; custom_reply?: unknown };
      if (typeof parsed.selected_index === "number" && Number.isInteger(parsed.selected_index)) {
        const picked = options[parsed.selected_index - 1];
        if (picked) return { selectedLabel: picked.label };
      }
      if (typeof parsed.custom_reply === "string" && parsed.custom_reply.trim()) {
        return { selectedLabel: parsed.custom_reply.trim() };
      }
    } catch {
      // Fallback to deterministic overlap matching if simulator call fails
    }
  }
  const { option } = selectBestOptionDeterministically(options, persona, questionText);
  return { selectedLabel: option.label };
}

async function simulateQuestionnaireSelection(
  questions: readonly QuestionnaireQuestionItem[],
  ctx?: UserSimulatorContext,
): Promise<QuestionnaireAnswerItem[]> {
  const persona = ctx?.hiddenUserPersona?.trim() ?? "";
  if (ctx?.runRole && persona) {
    try {
      const raw = await ctx.runRole({
        role: "followup",
        systemPrompt: USER_SIMULATOR_SYSTEM_PROMPT,
        input: {
          original_question: ctx.question ?? "",
          hidden_user_persona: persona,
          missing_slots: ctx.missingSlots ?? [],
          questions: questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            options: q.options.map((o, idx) => ({
              index: idx + 1,
              value: o.value,
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
          })),
          output_contract: '输出 {"selections": [{"id": "问题id", "selected_index": 1..N}]}',
        },
      });
      const parsed = parseJson(raw) as { selections?: Array<{ id?: unknown; selected_index?: unknown; custom_reply?: unknown }> };
      if (Array.isArray(parsed.selections)) {
        const byId = new Map(parsed.selections.map((s) => [String(s.id ?? ""), s]));
        return questions.map((q) => {
          const hit = byId.get(q.id);
          if (hit && typeof hit.selected_index === "number" && Number.isInteger(hit.selected_index)) {
            const opt = q.options[hit.selected_index - 1];
            if (opt) {
              return {
                id: q.id,
                value: opt.value,
                label: opt.label,
                wasCustom: false,
                index: hit.selected_index,
              };
            }
          }
          if (hit && typeof hit.custom_reply === "string" && hit.custom_reply.trim() && q.allowOther !== false) {
            const custom = hit.custom_reply.trim();
            return {
              id: q.id,
              value: custom,
              label: custom,
              wasCustom: true,
            };
          }
          const { option, index } = selectBestOptionDeterministically(q.options, persona, q.prompt);
          return {
            id: q.id,
            value: option.value,
            label: option.label,
            wasCustom: false,
            index,
          };
        });
      }
    } catch {
      // Fallback to deterministic selection
    }
  }

  return questions.map((q) => {
    const { option, index } = selectBestOptionDeterministically(q.options, persona, q.prompt);
    return {
      id: q.id,
      value: option.value,
      label: option.label,
      wasCustom: false,
      index,
    };
  });
}

/**
 * Pi `question` extension tool (`packages/coding-agent/examples/extensions/question.ts`)
 * backed by an automatic User Simulator using the question's hidden_user_persona.
 */
export function createQuestionAgentTool(options: CreateClarifyToolOptions = {}): AgentTool {
  const maxCalls = Math.max(1, Math.floor(options.maxCalls ?? 1));
  let callCount = 0;

  return {
    name: "question",
    label: "Question",
    description: PI_QUESTION_TOOL_DEFINITION.function.description,
    parameters: PI_QUESTION_TOOL_DEFINITION.function.parameters as AgentTool["parameters"],
    async execute(_toolCallId, rawInput) {
      if (!rawInput || typeof rawInput !== "object") {
        throw new Error("question 参数必须是对象");
      }
      const input = rawInput as { question?: unknown; options?: unknown };
      const questionText = nonEmpty(input.question, "question");
      if (!Array.isArray(input.options) || input.options.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No options provided" }],
          details: { question: questionText, options: [], answer: null },
        };
      }
      const normalizedOptions: QuestionOptionItem[] = input.options.map((raw, idx) => {
        if (!raw || typeof raw !== "object") {
          throw new Error(`question.options[${idx}] 必须是对象`);
        }
        const o = raw as { label?: unknown; description?: unknown };
        const label = nonEmpty(o.label, `question.options[${idx}].label`);
        const description = typeof o.description === "string" && o.description.trim()
          ? o.description.trim()
          : undefined;
        return { label, ...(description ? { description } : {}) };
      });

      if (callCount >= maxCalls) {
        const limitText = "User already answered your clarification question. Please provide your final answer directly based on the selected option.";
        return {
          content: [{ type: "text", text: limitText }],
          details: { question: questionText, options: normalizedOptions, answer: null },
        };
      }

      const { selectedLabel } = await simulateSingleQuestionSelection(questionText, normalizedOptions, options.context);
      const outputText = `User selected: ${selectedLabel}`;
      const recordedArgs: Record<string, unknown> = {
        question: questionText,
        options: normalizedOptions,
      };

      callCount++;
      options.onStep?.({
        stepNo: callCount,
        toolName: "question",
        arguments: recordedArgs,
        toolOutput: outputText,
      });

      return {
        content: [{ type: "text", text: outputText }],
        details: {
          question: questionText,
          options: normalizedOptions,
          answer: selectedLabel,
        },
      };
    },
  };
}

/**
 * Pi `questionnaire` extension tool (`packages/coding-agent/examples/extensions/questionnaire.ts`)
 * backed by an automatic User Simulator using the question's hidden_user_persona.
 */
export function createQuestionnaireAgentTool(options: CreateClarifyToolOptions = {}): AgentTool {
  const maxCalls = Math.max(1, Math.floor(options.maxCalls ?? 1));
  let callCount = 0;

  return {
    name: "questionnaire",
    label: "Questionnaire",
    description: PI_QUESTIONNAIRE_TOOL_DEFINITION.function.description,
    parameters: PI_QUESTIONNAIRE_TOOL_DEFINITION.function.parameters as AgentTool["parameters"],
    async execute(_toolCallId, rawInput) {
      if (!rawInput || typeof rawInput !== "object") {
        throw new Error("questionnaire 参数必须是对象");
      }
      const input = rawInput as { questions?: unknown };
      if (!Array.isArray(input.questions) || input.questions.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No questions provided" }],
          details: { questions: [], answers: [], cancelled: true },
        };
      }

      const normalizedQuestions: QuestionnaireQuestionItem[] = input.questions.map((raw, qIdx) => {
        if (!raw || typeof raw !== "object") {
          throw new Error(`questionnaire.questions[${qIdx}] 必须是对象`);
        }
        const q = raw as {
          id?: unknown;
          label?: unknown;
          prompt?: unknown;
          options?: unknown;
          allowOther?: unknown;
        };
        const id = nonEmpty(q.id, `questions[${qIdx}].id`);
        const prompt = nonEmpty(q.prompt, `questions[${qIdx}].prompt`);
        const label = typeof q.label === "string" && q.label.trim() ? q.label.trim() : undefined;
        if (!Array.isArray(q.options) || q.options.length === 0) {
          throw new Error(`questions[${qIdx}].options 必须是非空数组`);
        }
        const opts: QuestionnaireOptionItem[] = q.options.map((rawOpt, oIdx) => {
          if (!rawOpt || typeof rawOpt !== "object") {
            throw new Error(`questions[${qIdx}].options[${oIdx}] 必须是对象`);
          }
          const o = rawOpt as { value?: unknown; label?: unknown; description?: unknown };
          const optLabel = nonEmpty(o.label, `questions[${qIdx}].options[${oIdx}].label`);
          const optValue = typeof o.value === "string" && o.value.trim() ? o.value.trim() : optLabel;
          const description = typeof o.description === "string" && o.description.trim()
            ? o.description.trim()
            : undefined;
          return {
            value: optValue,
            label: optLabel,
            ...(description ? { description } : {}),
          };
        });
        return {
          id,
          ...(label ? { label } : {}),
          prompt,
          options: opts,
          ...(typeof q.allowOther === "boolean" ? { allowOther: q.allowOther } : {}),
        };
      });

      if (callCount >= maxCalls) {
        const limitText = "User already completed the questionnaire. Please provide your final answer directly based on the user's answers.";
        return {
          content: [{ type: "text", text: limitText }],
          details: { questions: normalizedQuestions, answers: [], cancelled: false },
        };
      }

      const answers = await simulateQuestionnaireSelection(normalizedQuestions, options.context);
      const formattedLines = answers.map((a) => {
        if (a.wasCustom) {
          return `${a.id}: (wrote) ${a.label}`;
        }
        return `${a.id}: ${a.index ?? 1}. ${a.label}`;
      });
      const outputText = formattedLines.join("\n");
      const recordedArgs: Record<string, unknown> = {
        questions: normalizedQuestions,
      };

      callCount++;
      options.onStep?.({
        stepNo: callCount,
        toolName: "questionnaire",
        arguments: recordedArgs,
        toolOutput: outputText,
      });

      return {
        content: [{ type: "text", text: outputText }],
        details: {
          questions: normalizedQuestions,
          answers,
          cancelled: false,
        },
      };
    },
  };
}
