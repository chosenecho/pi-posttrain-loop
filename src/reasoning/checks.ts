import { ALL_SYNTH_PROFILES, type SynthProfile } from "../shared/types.js";

export type ThinkTier = "short" | "medium" | "long";
export type SourceProfile = SynthProfile;
export type ProfileFilter = "all" | SourceProfile;

export function normalizeSourceProfile(raw: string | null | undefined): SourceProfile {
  const normalized = (raw ?? "standard").trim().toLowerCase();
  if ((ALL_SYNTH_PROFILES as readonly string[]).includes(normalized)) {
    return normalized as SourceProfile;
  }
  return "standard";
}

export function parseProfileFilter(raw: string | undefined, label = "--profile"): ProfileFilter {
  const normalized = (raw ?? "all").trim().toLowerCase();
  if (normalized === "all" || (ALL_SYNTH_PROFILES as readonly string[]).includes(normalized)) {
    return normalized as ProfileFilter;
  }
  throw new Error(`${label} 仅支持 all、${ALL_SYNTH_PROFILES.join("、")}，当前值：${raw}`);
}

export function parseTierFilter(raw: string | undefined, label = "--tier"): ThinkTier[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`${label} 不能为空，可选值为 short、medium、long（支持逗号分隔）`);
  }
  const valid = new Set<ThinkTier>(["short", "medium", "long"]);
  const result: ThinkTier[] = [];
  for (const part of parts) {
    if (!valid.has(part as ThinkTier)) {
      throw new Error(`${label} 仅支持 short、medium、long，无效值：${part}`);
    }
    if (!result.includes(part as ThinkTier)) {
      result.push(part as ThinkTier);
    }
  }
  return result;
}

export interface ReasoningCheckConfig {
  /** Hard safety fuse for runaway thinking output (chars). */
  maxChars: number;
  /** Hard safety fuse for blatant consecutive verbatim copy-paste (normalized chars). */
  maxVerbatimRun: number;
}

export const DEFAULT_REASONING_CHECK_CONFIG: ReasoningCheckConfig = {
  maxChars: 1500,
  maxVerbatimRun: 36,
};

export interface RuleCheckMetrics {
  charCount: number;
  answerCharCount: number;
  lengthRatio: number;
  maxVerbatimRun: number;
  maxVerbatimSnippet: string;
  leakHits: string[];
  formatHits: string[];
}

export interface RuleCheckResult {
  passed: boolean;
  issues: string[];
  feedback: string;
  metrics: RuleCheckMetrics;
}

export interface RepeatedOpeningStat {
  prefix: string;
  count: number;
}

export interface TierSummaryStat {
  total: number;
  passed: number;
  avgChars: number;
  p50Chars: number;
  p90Chars: number;
}

export interface ReasoningBatchStats {
  total: number;
  passed: number;
  dropped: number;
  errored: number;
  passRate: number;
  totalLeakHitTraces: number;
  avgChars: number;
  p50Chars: number;
  p90Chars: number;
  avgLengthRatio: number;
  avgRewrites: number;
  byTier: Record<ThinkTier, TierSummaryStat>;
  openingDiversity: {
    evaluatedCount: number;
    uniquePrefixCount: number;
    uniqueRatio: number;
    topRepeated: RepeatedOpeningStat[];
    topRepeated2Char: RepeatedOpeningStat[];
    max2CharShare: number;
  };
}

export function countContentChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export function inferThinkTier(answerCharCount: number): ThinkTier {
  if (answerCharCount <= 430) return "short";
  if (answerCharCount <= 850) return "medium";
  return "long";
}

/** Strips whitespace, punctuation, and symbols for normalized comparison. */
export function normalizeForOverlap(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

export function findLongestCommonNormalizedRun(
  reasoning: string,
  answer: string,
): { length: number; snippet: string } {
  const normR = normalizeForOverlap(reasoning);
  const normA = normalizeForOverlap(answer);
  if (!normR.length || !normA.length) {
    return { length: 0, snippet: "" };
  }
  let prev = new Uint16Array(normA.length + 1);
  let curr = new Uint16Array(normA.length + 1);
  let bestLen = 0;
  let bestEndInR = 0;

  for (let i = 1; i <= normR.length; i++) {
    const ch = normR.charCodeAt(i - 1);
    curr.fill(0);
    for (let j = 1; j <= normA.length; j++) {
      if (ch === normA.charCodeAt(j - 1)) {
        const len = prev[j - 1] + 1;
        curr[j] = len;
        if (len > bestLen) {
          bestLen = len;
          bestEndInR = i;
        }
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return {
    length: bestLen,
    snippet: bestLen > 0 ? normR.slice(bestEndInR - bestLen, bestEndInR) : "",
  };
}

const LEAK_RULES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "原稿/文稿转写词", pattern: /原稿|文稿|转写稿|转录稿|逐字稿/ },
  { label: "录播场景词", pattern: /本期视频|上期视频|前面几期|这期视频|弹幕|评论区/ },
  { label: "材料引用词", pattern: /材料(?:中|里|提到|指出|说明|未提及|之外|以外|没有)/ },
  {
    label: "字数/档位规则词",
    pattern: /(?:字数|篇幅)(?:要求|限制|控制|不能|不得|超过|以内|档位|区间)|(?:不超过|至少|控制在)\s*\d+\s*字|targetLength|targetThinkTier/i,
  },
  {
    label: "提示词/质检规则词",
    pattern: /answer-style|quality-judge|judging-skill|reasoning-writer|reasoning-judge|系统提示词|质检标准|审核标准|参考答案|金标答案|金标回答|Markdown/i,
  },
  {
    label: "格式禁令泄漏",
    pattern: /(?:严禁|禁止|不能|不要)(?:使用|出现|输出)?(?:加粗|斜体|标题|列表|套话|AI腔|夸奖|点评|复读|泄题)/i,
  },
  { label: "规则执行词", pattern: /(?:按|遵循|符合)(?:字数要求|档位要求|写作规范|提示词|输出规则)/ },
  { label: "AI自称泄漏", pattern: /作为\s*AI|作为一个?\s*(?:AI|人工智能|语言模型)/i },
];

export function detectLeakHits(reasoning: string): string[] {
  const hits: string[] = [];
  for (const rule of LEAK_RULES) {
    const match = rule.pattern.exec(reasoning);
    if (match) {
      hits.push(`${rule.label}(${match[0]})`);
    }
  }
  return hits;
}

export function detectFormatHits(reasoning: string): string[] {
  const hits: string[] = [];
  if (/<\/?think>/i.test(reasoning)) {
    hits.push("包含<think>标签");
  }
  if (/(?:^|\n)\s*#{1,6}\s+\S/.test(reasoning)) {
    hits.push("包含Markdown标题");
  }
  if (/\*\*[^*\n]{1,60}\*\*/.test(reasoning)) {
    hits.push("包含Markdown加粗");
  }
  const numberedItems = reasoning.match(/(?:^|\n)\s*(?:\d+[.、)）]|[（(]\d+[)）]|[一二三四五六七八九十]+[、.])\s*\S/g) ?? [];
  if (numberedItems.length >= 2) {
    hits.push("包含编号列表结构");
  }
  const bulletItems = reasoning.match(/(?:^|\n)\s*[-*•]\s+\S/g) ?? [];
  if (bulletItems.length >= 2) {
    hits.push("包含项目符号列表");
  }
  return hits;
}

export function runRuleChecks(
  reasoning: string,
  answer: string,
  _tier: ThinkTier,
  config: ReasoningCheckConfig = DEFAULT_REASONING_CHECK_CONFIG,
): RuleCheckResult {
  const trimmed = reasoning.trim();
  const charCount = countContentChars(trimmed);
  const answerCharCount = Math.max(1, countContentChars(answer));
  const lengthRatio = Number((charCount / answerCharCount).toFixed(4));
  const { length: maxVerbatimRun, snippet: maxVerbatimSnippet } = findLongestCommonNormalizedRun(trimmed, answer);
  const leakHits = detectLeakHits(trimmed);
  const formatHits = detectFormatHits(trimmed);

  const issues: string[] = [];
  const suggestions: string[] = [];

  if (charCount === 0) {
    issues.push("思考正文为空");
    suggestions.push("请补写一段完整的脱稿内心思考正文。");
  } else if (charCount > config.maxChars) {
    issues.push(`思考异常过长（${charCount} 字 > 安全上限 ${config.maxChars} 字）`);
    suggestions.push("大幅收紧思考篇幅，只保留开口前的核心破题与判断支点。");
  }

  if (leakHits.length > 0) {
    issues.push(`命中泄漏词：${leakHits.join("、")}`);
    suggestions.push(`彻底删去命中违规词（${leakHits.join("、")}），不要涉及参考来源、录播场景或外部写作规则，完全以脱稿开口前的自然思考来写。`);
  }

  if (formatHits.length > 0) {
    issues.push(`格式违规：${formatHits.join("、")}`);
    suggestions.push(`修正格式问题（${formatHits.join("、")}），改为纯文本自然段，不要使用列表、Markdown 符号或 <think> 标签。`);
  }

  if (maxVerbatimRun >= config.maxVerbatimRun) {
    const snippet = maxVerbatimSnippet.slice(0, 24);
    issues.push(`存在连续 ${maxVerbatimRun} 字照抄最终回答（片段：${snippet.slice(0, 20)}）`);
    suggestions.push(`其中“${snippet}”一带与最终回答连续照抄过长，请改为开口前的自然思考表达，不要直接照搬整句。`);
  }

  return {
    passed: issues.length === 0,
    issues,
    feedback: suggestions.join(" "),
    metrics: {
      charCount,
      answerCharCount,
      lengthRatio,
      maxVerbatimRun,
      maxVerbatimSnippet: maxVerbatimSnippet.slice(0, 32),
      leakHits,
      formatHits,
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export interface TraceStatInput {
  status: string;
  decision: string | null;
  lengthTier: ThinkTier;
  reasoning: string | null;
  metrics: RuleCheckMetrics | null;
  rewriteCount: number;
}

export function computeBatchStats(items: TraceStatInput[]): ReasoningBatchStats {
  const total = items.length;
  let passed = 0;
  let dropped = 0;
  let errored = 0;
  let totalLeakHitTraces = 0;

  const passedChars: number[] = [];
  const passedRatios: number[] = [];
  const allRewrites: number[] = [];
  const openingCounts = new Map<string, number>();
  const opening2Counts = new Map<string, number>();

  const tierBuckets: Record<ThinkTier, { total: number; passed: number; chars: number[] }> = {
    short: { total: 0, passed: 0, chars: [] },
    medium: { total: 0, passed: 0, chars: [] },
    long: { total: 0, passed: 0, chars: [] },
  };

  for (const item of items) {
    tierBuckets[item.lengthTier].total++;
    allRewrites.push(item.rewriteCount);
    if (item.metrics && item.metrics.leakHits.length > 0) {
      totalLeakHitTraces++;
    }
    if (item.status === "error" || item.status === "interrupted") {
      errored++;
      continue;
    }
    if (item.decision === "pass" && item.reasoning) {
      passed++;
      tierBuckets[item.lengthTier].passed++;
      const chars = item.metrics?.charCount ?? countContentChars(item.reasoning);
      passedChars.push(chars);
      tierBuckets[item.lengthTier].chars.push(chars);
      if (item.metrics) {
        passedRatios.push(item.metrics.lengthRatio);
      }
      const norm = normalizeForOverlap(item.reasoning);
      const prefix = norm.slice(0, 8);
      if (prefix.length >= 4) {
        openingCounts.set(prefix, (openingCounts.get(prefix) ?? 0) + 1);
      }
      const prefix2 = norm.slice(0, 2);
      if (prefix2.length === 2) {
        opening2Counts.set(prefix2, (opening2Counts.get(prefix2) ?? 0) + 1);
      }
    } else {
      dropped++;
    }
  }

  const sortedChars = [...passedChars].sort((a, b) => a - b);
  const byTier = (["short", "medium", "long"] as const).reduce(
    (acc, tier) => {
      const bucket = tierBuckets[tier];
      const sorted = [...bucket.chars].sort((a, b) => a - b);
      acc[tier] = {
        total: bucket.total,
        passed: bucket.passed,
        avgChars: Math.round(mean(sorted)),
        p50Chars: percentile(sorted, 0.5),
        p90Chars: percentile(sorted, 0.9),
      };
      return acc;
    },
    {} as Record<ThinkTier, TierSummaryStat>,
  );

  const evaluatedCount = [...openingCounts.values()].reduce((sum, count) => sum + count, 0);
  const topRepeated = [...openingCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([prefix, count]) => ({ prefix, count }));

  const evaluated2Count = [...opening2Counts.values()].reduce((sum, count) => sum + count, 0);
  const topRepeated2Char = [...opening2Counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([prefix, count]) => ({ prefix, count }));
  const max2Count = topRepeated2Char.length > 0 ? topRepeated2Char[0].count : (evaluated2Count > 0 ? 1 : 0);
  const max2CharShare = evaluated2Count > 0 ? Number((max2Count / evaluated2Count).toFixed(4)) : 0;

  return {
    total,
    passed,
    dropped,
    errored,
    passRate: total > 0 ? Number((passed / total).toFixed(4)) : 0,
    totalLeakHitTraces,
    avgChars: Math.round(mean(sortedChars)),
    p50Chars: percentile(sortedChars, 0.5),
    p90Chars: percentile(sortedChars, 0.9),
    avgLengthRatio: Number(mean(passedRatios).toFixed(4)),
    avgRewrites: Number(mean(allRewrites).toFixed(2)),
    byTier,
    openingDiversity: {
      evaluatedCount,
      uniquePrefixCount: openingCounts.size,
      uniqueRatio: evaluatedCount > 0 ? Number((openingCounts.size / evaluatedCount).toFixed(4)) : 1,
      topRepeated,
      topRepeated2Char,
      max2CharShare,
    },
  };
}
