import type {
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

export function remapToolArguments(
  step: ToolStep,
  variant: WebSearchToolVariant,
): Record<string, unknown> {
  const query = extractSearchQuery(step.arguments);
  return { [variant.queryParam]: query };
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
            name: variant.name,
            arguments: JSON.stringify(mappedArgs),
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      name: variant.name,
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
