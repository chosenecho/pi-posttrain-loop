import type {
  QuestionMode,
  SynthProfile,
  ToolDefinition,
  ToolStep,
  TrainingMessage,
  TrainingSampleLine,
} from "./types.js";

export interface WebSearchToolVariant {
  name: string;
  queryParam: string;
  description: string;
  queryDescription: string;
}

export const CANONICAL_WEB_SEARCH_VARIANT: WebSearchToolVariant = {
  name: "web_search",
  queryParam: "query",
  description: "搜索公开网络资料、统计数据、政策法规、文献出处或现实事件细节。",
  queryDescription: "搜索关键词",
};

/**
 * Generic web search tool schema variants for export-time randomization so fine-tuned
 * models do not overfit to a single hardcoded function or parameter name.
 */
export const GENERALIZED_WEB_SEARCH_VARIANTS: readonly WebSearchToolVariant[] = [
  CANONICAL_WEB_SEARCH_VARIANT,
  {
    name: "search_web",
    queryParam: "query",
    description: "Search the web for public facts, statistics, documents, citations, or current events.",
    queryDescription: "Search query string",
  },
  {
    name: "internet_search",
    queryParam: "q",
    description: "联网检索公开信息、数据、条文或文献来源。",
    queryDescription: "检索关键词",
  },
  {
    name: "online_search",
    queryParam: "keywords",
    description: "Query public web pages to verify facts, numbers, dates, or references.",
    queryDescription: "Keywords to look up",
  },
  {
    name: "web_lookup",
    queryParam: "query",
    description: "查询公开网络来源以核实具体事实、出处、年份或统计口径。",
    queryDescription: "需要检索的查询词",
  },
];

/**
 * Exact 1:1 Pi v1.7.0 `todo` extension tool schema (`packages/coding-agent/examples/extensions/todo.ts`).
 */
export const PI_TODO_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: "todo",
    description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "toggle", "clear"],
        },
        text: {
          type: "string",
          description: "Todo text (for add)",
        },
        id: {
          type: "number",
          description: "Todo ID (for toggle)",
        },
      },
      required: ["action"],
    },
  },
};

/**
 * Exact 1:1 Pi v1.7.0 `question` extension tool schema (`packages/coding-agent/examples/extensions/question.ts`).
 */
export const PI_QUESTION_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: "question",
    description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
        options: {
          type: "array",
          description: "Options for the user to choose from",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Display label for the option" },
              description: { type: "string", description: "Optional description shown below label" },
            },
            required: ["label"],
          },
        },
      },
      required: ["question", "options"],
    },
  },
};

/**
 * Exact 1:1 Pi v1.7.0 `questionnaire` extension tool schema (`packages/coding-agent/examples/extensions/questionnaire.ts`).
 */
export const PI_QUESTIONNAIRE_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: "questionnaire",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask the user",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique identifier for this question" },
              label: {
                type: "string",
                description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
              },
              prompt: { type: "string", description: "The full question text to display" },
              options: {
                type: "array",
                description: "Available options to choose from",
                items: {
                  type: "object",
                  properties: {
                    value: { type: "string", description: "The value returned when selected" },
                    label: { type: "string", description: "Display label for the option" },
                    description: { type: "string", description: "Optional description shown below label" },
                  },
                  required: ["value", "label"],
                },
              },
              allowOther: { type: "boolean", description: "Allow 'Type something' option (default: true)" },
            },
            required: ["id", "prompt", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
};

export function buildToolDefinition(variant: WebSearchToolVariant): ToolDefinition {
  return {
    type: "function",
    function: {
      name: variant.name,
      description: variant.description,
      parameters: {
        type: "object",
        properties: {
          [variant.queryParam]: {
            type: "string",
            description: variant.queryDescription,
          },
        },
        required: [variant.queryParam],
      },
    },
  };
}

export function pickWebSearchToolVariant(
  rng: () => number,
  generalize = true,
): WebSearchToolVariant {
  if (!generalize) return CANONICAL_WEB_SEARCH_VARIANT;
  const idx = Math.floor(rng() * GENERALIZED_WEB_SEARCH_VARIANTS.length);
  return GENERALIZED_WEB_SEARCH_VARIANTS[Math.min(GENERALIZED_WEB_SEARCH_VARIANTS.length - 1, Math.max(0, idx))]!;
}

export function extractSearchQuery(args: Record<string, unknown>): string {
  for (const key of ["query", "q", "keywords", "text"]) {
    const val = args[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return JSON.stringify(args);
}

const SEARCH_TOOL_NAMES = new Set<string>([
  "web_search",
  ...GENERALIZED_WEB_SEARCH_VARIANTS.map((v) => v.name),
]);

export function isWebSearchToolName(toolName: string): boolean {
  return SEARCH_TOOL_NAMES.has(toolName);
}

export function remapToolArguments(
  step: ToolStep,
  variant: WebSearchToolVariant,
): Record<string, unknown> {
  if (!isWebSearchToolName(step.toolName)) {
    return step.arguments;
  }
  const query = extractSearchQuery(step.arguments);
  return { [variant.queryParam]: query };
}

export function resolveExportToolName(
  step: ToolStep,
  variant: WebSearchToolVariant,
): string {
  return isWebSearchToolName(step.toolName) ? variant.name : step.toolName;
}

/**
 * Resolves the top-level `tools` declaration array for an exported sample based on
 * the steps actually invoked and/or the sample's profile/questionMode.
 */
export function buildSampleToolDefinitions(options: {
  steps: readonly ToolStep[];
  searchVariant?: WebSearchToolVariant;
  profile?: SynthProfile | string | null;
  questionMode?: QuestionMode | string | null;
  alwaysIncludeSearch?: boolean;
}): ToolDefinition[] {
  const usedToolNames = new Set(options.steps.map((s) => s.toolName));
  const usedSearch = options.steps.some((s) => isWebSearchToolName(s.toolName));
  const includeSearch = Boolean(
    usedSearch
    || options.alwaysIncludeSearch
    || options.profile === "search"
    || options.profile === "todo"
    || options.profile === "clarify"
    || options.questionMode === "todo_plan"
    || options.questionMode === "clarify_question",
  );
  const includeTodo = Boolean(
    usedToolNames.has("todo")
    || options.profile === "todo"
    || options.questionMode === "todo_plan",
  );
  const includeQuestion = Boolean(
    usedToolNames.has("question")
    || options.profile === "clarify"
    || options.questionMode === "clarify_question",
  );
  const includeQuestionnaire = Boolean(
    usedToolNames.has("questionnaire")
    || options.profile === "clarify"
    || options.questionMode === "clarify_question",
  );

  const defs: ToolDefinition[] = [];
  if (includeSearch && options.searchVariant) {
    defs.push(buildToolDefinition(options.searchVariant));
  }
  if (includeTodo) {
    defs.push(PI_TODO_TOOL_DEFINITION);
  }
  if (includeQuestion) {
    defs.push(PI_QUESTION_TOOL_DEFINITION);
  }
  if (includeQuestionnaire) {
    defs.push(PI_QUESTIONNAIRE_TOOL_DEFINITION);
  }
  return defs;
}

export function formatToolCallThinking(
  thought: string | null | undefined,
  format: "inline" | "reasoning_content" | "plain",
): { content: string; reasoning_content?: string } {
  const clean = thought?.trim();
  if (!clean || format === "plain") {
    return { content: "" };
  }
  if (format === "inline") {
    return { content: `<think>\n${clean}\n</think>\n` };
  }
  return { content: "", reasoning_content: clean };
}

export function buildToolStepMessages(
  steps: ToolStep[],
  variant: WebSearchToolVariant,
  options: {
    format?: "inline" | "reasoning_content" | "plain";
    preCallThoughts?: ReadonlyMap<number, string> | readonly (string | null | undefined)[];
    callIdPrefix?: string;
  } = {},
): TrainingMessage[] {
  const format = options.format ?? "plain";
  const prefix = options.callIdPrefix ?? "call";
  const messages: TrainingMessage[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const toolName = resolveExportToolName(step, variant);
    const mappedArgs = remapToolArguments(step, variant);
    const callId = `${prefix}_${step.stepNo}`;
    const overrideThought = Array.isArray(options.preCallThoughts)
      ? options.preCallThoughts[i]
      : options.preCallThoughts instanceof Map
        ? options.preCallThoughts.get(step.stepNo)
        : undefined;
    const thought = overrideThought ?? step.preCallThought ?? undefined;
    const thoughtFields = formatToolCallThinking(thought, format);

    messages.push({
      role: "assistant",
      content: thoughtFields.content,
      ...(thoughtFields.reasoning_content !== undefined
        ? { reasoning_content: thoughtFields.reasoning_content }
        : {}),
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: toolName,
            arguments: JSON.stringify(mappedArgs),
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      name: toolName,
      tool_call_id: callId,
      content: step.toolOutput,
    });
  }

  return messages;
}

/**
 * Attaches a generic search tool declaration to a non-search sample without adding
 * any tool_calls, teaching the model when NOT to call search even when tools are available.
 */
export function attachNegativeToolDeclaration<T extends TrainingSampleLine>(
  sample: T,
  rng: () => number,
  generalize = true,
): T {
  if (sample.tools && sample.tools.length > 0) return sample;
  const variant = pickWebSearchToolVariant(rng, generalize);
  return {
    ...sample,
    tools: [buildToolDefinition(variant)],
  };
}
