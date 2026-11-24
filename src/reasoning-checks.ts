export type ThinkTier = "short" | "medium" | "long";

export interface TierLengthSpec {
  /** Soft target range passed to the writer prompt (e.g. 80-160). */
  targetMin: number;
  targetMax: number;
  /** Hard acceptance bounds enforced by deterministic rule checks. */
  hardMin: number;
  hardMax: number;
}

export interface ReasoningCheckConfig {
  tiers: Record<ThinkTier, TierLengthSpec>;
  /** Maximum allowed ratio of reasoning chars / answer chars. */
  maxAnswerRatio: number;
  /** Maximum allowed fraction of 8-grams in reasoning that appear verbatim in answer. */
  maxNgram8Overlap: number;
  /** Maximum allowed consecutive normalized characters copied verbatim from answer. */
  maxVerbatimRun: number;
}

export const DEFAULT_REASONING_CHECK_CONFIG: ReasoningCheckConfig = {
  tiers: {
    short: { targetMin: 80, targetMax: 160, hardMin: 55, hardMax: 190 },
    medium: { targetMin: 120, targetMax: 230, hardMin: 95, hardMax: 270 },
    long: { targetMin: 180, targetMax: 340, hardMin: 145, hardMax: 400 },
  },
  maxAnswerRatio: 0.8,
  maxNgram8Overlap: 0.25,
  maxVerbatimRun: 18,
};

export interface RuleCheckMetrics {
  charCount: number;
  answerCharCount: number;
  lengthRatio: number;
  ngram8Overlap: number;
  matchedNgrams: number;
  totalNgrams: number;
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
  avgNgram8Overlap: number;
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
  if (answerCharCount <= 380) return "short";
  if (answerCharCount <= 820) return "medium";
  return "long";
}

export function formatTierTargetRange(spec: TierLengthSpec): string {
  return `${spec.targetMin}-${spec.targetMax}`;
}

export function parseTierRangeFlag(raw: string, label: string): TierLengthSpec {
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(raw);
  if (!match) {
    throw new Error(`${label} 必须使用 MIN-MAX 格式（例如 80-160）`);
  }
  const targetMin = Number(match[1]);
  const targetMax = Number(match[2]);
  if (!Number.isSafeInteger(targetMin) || !Number.isSafeInteger(targetMax) || targetMin < 10 || targetMax <= targetMin) {
    throw new Error(`${label} 的范围无效：需满足 10 <= MIN < MAX`);
  }
  const hardMin = Math.max(10, Math.round(targetMin * 0.75));
  const hardMax = Math.round(targetMax * 1.2);
  return { targetMin, targetMax, hardMin, hardMax };
}

/** Strips whitespace, punctuation, and symbols so near-verbatim copies cannot bypass overlap checks. */
export function normalizeForOverlap(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

export function computeNgramOverlap(
  reasoning: string,
  answer: string,
  n = 8,
): { overlap: number; matchedNgrams: number; totalNgrams: number } {
  const normR = normalizeForOverlap(reasoning);
  const normA = normalizeForOverlap(answer);
  if (normR.length < n || normA.length < n) {
    return { overlap: 0, matchedNgrams: 0, totalNgrams: 0 };
  }
  const answerGrams = new Set<string>();
  for (let i = 0; i <= normA.length - n; i++) {
    answerGrams.add(normA.slice(i, i + n));
  }
  const totalNgrams = normR.length - n + 1;
  let matchedNgrams = 0;
  for (let i = 0; i <= normR.length - n; i++) {
    if (answerGrams.has(normR.slice(i, i + n))) {
      matchedNgrams++;
    }
  }
  return {
    overlap: Number((matchedNgrams / totalNgrams).toFixed(4)),
    matchedNgrams,
    totalNgrams,
  };
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
  { label: "规则执行词", pattern: /(?:按|遵循|符合)(?:规则|规范|档位|提示词)/ },
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
  const thirdPersonMatch = /(?:用户的核心问题是|用户的问题是|提问者问的是|作者的观点是|作者认为|本回答应该|回答应当从以下)/.exec(reasoning);
  if (thirdPersonMatch) {
    hits.push(`第三方分析腔(${thirdPersonMatch[0]})`);
  }
  const metaOpeningMatch = /^(?:他这(?:里|一问|问法|个问法|个追问|句|回|是把)|他把|他的问题|他追问(?:的)?|对方(?:这|把)|提问(?:者)?把)/.exec(reasoning.trim());
  if (metaOpeningMatch) {
    hits.push(`旁观套话起手(${metaOpeningMatch[0]})`);
  }
  const outlinePreviewMatch = /(?:(?:我的)?推进顺序是|回答(?:的)?顺序是|我先说明[\s\S]{1,80}(?:接下来|再说明)[\s\S]{1,80}最后)/.exec(reasoning);
  if (outlinePreviewMatch) {
    hits.push(`显性结构预告(${outlinePreviewMatch[0].slice(0, 12)})`);
  }
  const metaClosingMatch = /(?:(?:留到|留给|交给)开口(?:之)?后|那是开口(?:之)?后再(?:说|讲|展开)|剩下的交给开口(?:之)?再?(?:说|讲|展开))/.exec(reasoning);
  if (metaClosingMatch) {
    hits.push(`元自指收尾(${metaClosingMatch[0]})`);
  }
  if (/首先[\s\S]{1,120}其次[\s\S]{1,120}(?:最后|再次)/.test(reasoning)) {
    hits.push("首先/其次/最后八股结构");
  }
  return hits;
}

export function runRuleChecks(
  reasoning: string,
  answer: string,
  tier: ThinkTier,
  config: ReasoningCheckConfig = DEFAULT_REASONING_CHECK_CONFIG,
): RuleCheckResult {
  const trimmed = reasoning.trim();
  const charCount = countContentChars(trimmed);
  const answerCharCount = Math.max(1, countContentChars(answer));
  const lengthRatio = Number((charCount / answerCharCount).toFixed(4));
  const { overlap: ngram8Overlap, matchedNgrams, totalNgrams } = computeNgramOverlap(trimmed, answer, 8);
  const { length: maxVerbatimRun, snippet: maxVerbatimSnippet } = findLongestCommonNormalizedRun(trimmed, answer);
  const leakHits = detectLeakHits(trimmed);
  const formatHits = detectFormatHits(trimmed);

  const spec = config.tiers[tier];
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (charCount === 0) {
    issues.push("思考正文为空");
    suggestions.push("请补写一段完整的脱稿内心思考正文。");
  } else {
    if (charCount < spec.hardMin) {
      issues.push(`思考过短（${charCount} 字，${tier} 档下限 ${spec.hardMin} 字）`);
      suggestions.push(`适当展开思考骨架至约 ${spec.targetMin}-${spec.targetMax} 字，把核心矛盾、关键区分与边界想透。`);
    }
    if (charCount > spec.hardMax) {
      issues.push(`思考过长（${charCount} 字，${tier} 档上限 ${spec.hardMax} 字）`);
      suggestions.push(`压缩至约 ${spec.targetMin}-${spec.targetMax} 字，只保留开口前的核心锚点，去掉细枝末节。`);
    }
    if (lengthRatio > config.maxAnswerRatio) {
      issues.push(`思考与正文长度比过高（${(lengthRatio * 100).toFixed(0)}% > ${(config.maxAnswerRatio * 100).toFixed(0)}%）`);
      suggestions.push("思考明显短于最终回答，只定判断和思路骨架，不要把正文提前写一遍。");
    }
  }

  if (leakHits.length > 0) {
    issues.push(`命中泄漏词：${leakHits.join("、")}`);
    suggestions.push(`彻底删去命中违规词（${leakHits.join("、")}），不要涉及参考来源、录播场景或外部写作规则，完全以脱稿开口前的自然思考来写。`);
  }

  if (formatHits.length > 0) {
    issues.push(`格式或腔调违规：${formatHits.join("、")}`);
    suggestions.push(`修正格式或腔调问题（${formatHits.join("、")}），改为自然连贯的第一人称纯文本内心独白，不要使用列表、Markdown符号、标签、结构预告、第三方分析口吻或元自指收尾。`);
  }

  if (ngram8Overlap > config.maxNgram8Overlap) {
    issues.push(`8-gram重合率过高（${(ngram8Overlap * 100).toFixed(1)}% > ${(config.maxNgram8Overlap * 100).toFixed(1)}%）`);
    const snippetHint = maxVerbatimSnippet.length >= 8 ? `（例如“${maxVerbatimSnippet.slice(0, 24)}”一带重合明显）` : "";
    suggestions.push(`避免照搬或复述最终回答里的原句与修辞${snippetHint}，站在开口前的角度提炼问题前提、关键区分与核心边界即可。`);
  } else if (maxVerbatimRun >= config.maxVerbatimRun) {
    const snippet = maxVerbatimSnippet.slice(0, 24);
    issues.push(`存在连续 ${maxVerbatimRun} 字照抄最终回答（片段：${snippet.slice(0, 20)}）`);
    suggestions.push(`其中“${snippet}”一带与最终回答连续重合过长，请用更简短的思考意图重述，不要照搬完整原句。`);
  }

  return {
    passed: issues.length === 0,
    issues,
    feedback: suggestions.join(" "),
    metrics: {
      charCount,
      answerCharCount,
      lengthRatio,
      ngram8Overlap,
      matchedNgrams,
      totalNgrams,
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
  const passedOverlaps: number[] = [];
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
        passedOverlaps.push(item.metrics.ngram8Overlap);
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
    avgNgram8Overlap: Number(mean(passedOverlaps).toFixed(4)),
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
