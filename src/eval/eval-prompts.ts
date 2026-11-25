import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ANSWER_STYLE, isEvalSkillPath, readSkillFile } from "../io.js";
import { nonEmpty } from "../schema.js";
import type { Skill } from "../types.js";
import type { EvalProfile } from "./eval-db.js";

export const DEFAULT_EVAL_PROMPTS_DIR = fileURLToPath(new URL("../../prompts/eval", import.meta.url));
export const DEFAULT_EVAL_SKILLS_DIR = fileURLToPath(new URL("../../skills/eval", import.meta.url));
export const DEFAULT_CANDIDATE_SYSTEM_PROMPT_PATH = join(DEFAULT_EVAL_PROMPTS_DIR, "candidate-system.md");

export async function loadDefaultCandidateSystemPrompt(
  promptPath: string = DEFAULT_CANDIDATE_SYSTEM_PROMPT_PATH,
): Promise<string> {
  const raw = await readFile(promptPath, "utf8");
  return nonEmpty(raw.replace(/^\uFEFF/, ""), "默认候选模型系统提示词（prompts/eval/candidate-system.md）");
}

export type CandidateSystemPromptSource =
  | "cli"
  | "cli_file"
  | "env"
  | "env_file"
  | "default_file"
  | "none"
  | "resume_inherit";

export interface ResolveCandidateSystemPromptOptions {
  systemPrompt?: string;
  systemPromptFile?: string;
  noSystemPrompt?: boolean;
  isResuming?: boolean;
  env?: NodeJS.ProcessEnv;
  defaultPromptPath?: string;
}

export interface ResolvedCandidateSystemPrompt {
  /** `undefined` means inherit on resume (or none); `null` means explicitly disabled via `--no-system-prompt`. */
  systemPrompt: string | null | undefined;
  source: CandidateSystemPromptSource;
}

/**
 * Resolves the system prompt passed to candidate models during `eval run`.
 * Priority: CLI flags (`--no-system-prompt` / `--system-prompt` / `--system-prompt-file`)
 * > resume inheritance (when `--resume-run` is set without CLI overrides)
 * > env vars (`CANDIDATE_LLM_SYSTEM_PROMPT` / `CANDIDATE_LLM_SYSTEM_PROMPT_FILE`)
 * > default prompt file (`prompts/eval/candidate-system.md`).
 */
export async function resolveCandidateSystemPrompt(
  options: ResolveCandidateSystemPromptOptions = {},
): Promise<ResolvedCandidateSystemPrompt> {
  const cliCount =
    Number(options.systemPrompt !== undefined) +
    Number(options.systemPromptFile !== undefined) +
    Number(Boolean(options.noSystemPrompt));
  if (cliCount > 1) {
    throw new Error("--system-prompt、--system-prompt-file 与 --no-system-prompt 不能同时指定");
  }

  if (options.noSystemPrompt) {
    return { systemPrompt: null, source: "none" };
  }
  if (options.systemPrompt !== undefined) {
    return { systemPrompt: nonEmpty(options.systemPrompt, "--system-prompt"), source: "cli" };
  }
  if (options.systemPromptFile !== undefined) {
    const raw = await readFile(resolve(options.systemPromptFile), "utf8");
    return {
      systemPrompt: nonEmpty(raw.replace(/^\uFEFF/, ""), "--system-prompt-file"),
      source: "cli_file",
    };
  }
  if (options.isResuming) {
    return { systemPrompt: undefined, source: "resume_inherit" };
  }

  const env = options.env ?? process.env;
  const envPrompt = env.CANDIDATE_LLM_SYSTEM_PROMPT?.trim();
  const envPromptFile = env.CANDIDATE_LLM_SYSTEM_PROMPT_FILE?.trim();
  if (envPrompt && envPromptFile) {
    throw new Error("CANDIDATE_LLM_SYSTEM_PROMPT 与 CANDIDATE_LLM_SYSTEM_PROMPT_FILE 不能同时设置");
  }
  if (envPrompt) {
    return { systemPrompt: envPrompt, source: "env" };
  }
  if (envPromptFile) {
    const raw = await readFile(resolve(envPromptFile), "utf8");
    return {
      systemPrompt: nonEmpty(raw.replace(/^\uFEFF/, ""), "CANDIDATE_LLM_SYSTEM_PROMPT_FILE"),
      source: "env_file",
    };
  }

  const defaultPrompt = await loadDefaultCandidateSystemPrompt(options.defaultPromptPath);
  return { systemPrompt: defaultPrompt, source: "default_file" };
}

/** Training-only skills that MUST NEVER be loaded by the isolated eval probe pipeline. */
const FORBIDDEN_TRAINING_SKILL_NAMES = new Set([
  "question-design",
  "followup-strategy",
  "quality-judge",
  "eval-rubric",
  "reasoning-writer",
  "reasoning-judge",
]);

/** Only skills under `skills/eval/*` and the shared voice baseline `skills/answer-style/SKILL.md` are whitelisted. */
export function assertEvalAllowedSkillPath(skillPath: string, label: string): void {
  const normalized = resolve(skillPath).replace(/\\/g, "/");
  const skillDirName = basename(dirname(normalized));
  if (FORBIDDEN_TRAINING_SKILL_NAMES.has(skillDirName)) {
    throw new Error(`${label}：评测 Loop 禁止加载训练专用 Skill（${skillDirName}）：${skillPath}`);
  }
  const isAllowedEval = isEvalSkillPath(skillPath);
  const isSharedAnswerStyle = /(^|\/)skills\/answer-style\/SKILL\.md$/i.test(normalized);
  if (!isAllowedEval && !isSharedAnswerStyle) {
    throw new Error(`${label}：不在评测 Skill 白名单内（仅允许 skills/eval/* 与 skills/answer-style/SKILL.md）：${skillPath}`);
  }
}

export async function readEvalSkill(skillPath: string, label: string): Promise<Skill> {
  assertEvalAllowedSkillPath(skillPath, label);
  return readSkillFile(skillPath, label);
}

export interface EvalSkillSnapshot {
  name: string;
  path: string;
  status: Skill["status"];
  sha256: string;
}

export interface EvalPromptBundle {
  prompts: {
    probeWriter: string;
    probeCritic: string;
    reference: string;
    verifier: string;
    adversary: string;
    rubricV2: string;
  };
  skills: EvalSkillSnapshot[];
  allReady: boolean;
}

export interface CalibrationPromptBundle {
  prompts: {
    bareAnswer: string;
    evalGrader: string;
  };
  skills: EvalSkillSnapshot[];
  allReady: boolean;
}

export function composeProbeWriterPrompt(systemPrompt: string, probeDesignSkillBody: string): string {
  return `${systemPrompt}\n\n<probe-design>\n${probeDesignSkillBody}\n</probe-design>`;
}

export function composeProbeCriticPrompt(systemPrompt: string, probeCriticSkillBody: string): string {
  return `${systemPrompt}\n\n<probe-critic>\n${probeCriticSkillBody}\n</probe-critic>`;
}

export function composeReferencePrompt(
  systemPrompt: string,
  answerStyleSkillBody: string,
  probeAnswerSkillBody: string,
): string {
  return `${systemPrompt}\n\n<answer-style>\n${answerStyleSkillBody}\n</answer-style>\n\n<probe-answer>\n${probeAnswerSkillBody}\n</probe-answer>`;
}

export function composeVerifierPrompt(systemPrompt: string, verifierSkillBody: string): string {
  return `${systemPrompt}\n\n<reference-verifier>\n${verifierSkillBody}\n</reference-verifier>`;
}

export function composeAdversaryPrompt(systemPrompt: string, adversarySkillBody: string): string {
  return `${systemPrompt}\n\n<adversary-tactics>\n${adversarySkillBody}\n</adversary-tactics>`;
}

export function composeRubricV2Prompt(systemPrompt: string, rubricV2SkillBody: string): string {
  return `${systemPrompt}\n\n<eval-rubric-v2>\n${rubricV2SkillBody}\n</eval-rubric-v2>`;
}

export function composeEvalGraderPrompt(systemPrompt: string, graderSkillBody: string): string {
  return `${systemPrompt}\n\n<eval-grader>\n${graderSkillBody}\n</eval-grader>`;
}

export function composeTrapReferencePrompt(
  systemPrompt: string,
  trapProbeAnswerSkillBody: string,
): string {
  return `${systemPrompt}\n\n<probe-answer>\n${trapProbeAnswerSkillBody}\n</probe-answer>`;
}

export async function loadEvalPromptBundle(options: {
  profile?: EvalProfile;
  promptsDir?: string;
  skillsDir?: string;
  answerStylePath?: string;
} = {}): Promise<EvalPromptBundle> {
  const profile: EvalProfile = options.profile ?? "adversarial";
  const promptsDir = options.promptsDir ?? DEFAULT_EVAL_PROMPTS_DIR;
  const baseSkillsDir = options.skillsDir ?? DEFAULT_EVAL_SKILLS_DIR;
  const skillsDir = profile === "trap" ? join(baseSkillsDir, "trap") : baseSkillsDir;
  const answerStylePath = options.answerStylePath ?? DEFAULT_ANSWER_STYLE;

  const probeDesignPath = join(skillsDir, "probe-design", "SKILL.md");
  const probeCriticPath = join(skillsDir, "probe-critic", "SKILL.md");
  const probeAnswerPath = join(skillsDir, "probe-answer", "SKILL.md");
  const verifierSkillPath = join(skillsDir, "reference-verifier", "SKILL.md");
  const adversarySkillPath = join(skillsDir, "adversary-tactics", "SKILL.md");
  const rubricV2SkillPath = join(skillsDir, "eval-rubric-v2", "SKILL.md");

  const [
    writerBase,
    criticBase,
    refBase,
    verifierBase,
    adversaryBase,
    rubricBase,
    probeDesignSkill,
    probeCriticSkill,
    probeAnswerSkill,
    verifierSkill,
    adversarySkill,
    rubricV2Skill,
    answerStyleSkill,
  ] = await Promise.all([
    readFile(join(promptsDir, "probe-writer.md"), "utf8").then((t) => nonEmpty(t, "probe-writer 系统提示词")),
    readFile(join(promptsDir, "probe-critic.md"), "utf8").then((t) => nonEmpty(t, "probe-critic 系统提示词")),
    readFile(join(promptsDir, "reference.md"), "utf8").then((t) => nonEmpty(t, "reference 系统提示词")),
    readFile(join(promptsDir, "verifier.md"), "utf8").then((t) => nonEmpty(t, "verifier 系统提示词")),
    readFile(join(promptsDir, "adversary.md"), "utf8").then((t) => nonEmpty(t, "adversary 系统提示词")),
    readFile(join(promptsDir, "rubric-v2.md"), "utf8").then((t) => nonEmpty(t, "rubric-v2 系统提示词")),
    readEvalSkill(probeDesignPath, "probe-design Skill"),
    readEvalSkill(probeCriticPath, "probe-critic Skill"),
    readEvalSkill(probeAnswerPath, "probe-answer Skill"),
    readEvalSkill(verifierSkillPath, "reference-verifier Skill"),
    readEvalSkill(adversarySkillPath, "adversary-tactics Skill"),
    readEvalSkill(rubricV2SkillPath, "eval-rubric-v2 Skill"),
    profile === "trap" ? Promise.resolve(undefined) : readEvalSkill(answerStylePath, "answer-style Skill"),
  ]);

  const prefix = profile === "trap" ? "trap/" : "";
  const skills: EvalSkillSnapshot[] = [
    { name: `${prefix}probe-design`, path: probeDesignPath, status: probeDesignSkill.status, sha256: probeDesignSkill.sha256 },
    { name: `${prefix}probe-critic`, path: probeCriticPath, status: probeCriticSkill.status, sha256: probeCriticSkill.sha256 },
    ...(answerStyleSkill
      ? [{ name: "answer-style", path: answerStylePath, status: answerStyleSkill.status, sha256: answerStyleSkill.sha256 }]
      : []),
    { name: `${prefix}probe-answer`, path: probeAnswerPath, status: probeAnswerSkill.status, sha256: probeAnswerSkill.sha256 },
    { name: `${prefix}reference-verifier`, path: verifierSkillPath, status: verifierSkill.status, sha256: verifierSkill.sha256 },
    { name: `${prefix}adversary-tactics`, path: adversarySkillPath, status: adversarySkill.status, sha256: adversarySkill.sha256 },
    { name: `${prefix}eval-rubric-v2`, path: rubricV2SkillPath, status: rubricV2Skill.status, sha256: rubricV2Skill.sha256 },
  ];

  return {
    prompts: {
      probeWriter: composeProbeWriterPrompt(writerBase, probeDesignSkill.body),
      probeCritic: composeProbeCriticPrompt(criticBase, probeCriticSkill.body),
      reference: profile === "trap"
        ? composeTrapReferencePrompt(refBase, probeAnswerSkill.body)
        : composeReferencePrompt(refBase, answerStyleSkill!.body, probeAnswerSkill.body),
      verifier: composeVerifierPrompt(verifierBase, verifierSkill.body),
      adversary: composeAdversaryPrompt(adversaryBase, adversarySkill.body),
      rubricV2: composeRubricV2Prompt(rubricBase, rubricV2Skill.body),
    },
    skills,
    allReady: skills.every((s) => s.status === "ready"),
  };
}

export async function loadCalibrationPromptBundle(options: {
  promptsDir?: string;
  skillsDir?: string;
} = {}): Promise<CalibrationPromptBundle> {
  const promptsDir = options.promptsDir ?? DEFAULT_EVAL_PROMPTS_DIR;
  const skillsDir = options.skillsDir ?? DEFAULT_EVAL_SKILLS_DIR;
  const graderSkillPath = join(skillsDir, "eval-grader", "SKILL.md");

  const [bareBase, graderBase, graderSkill] = await Promise.all([
    readFile(join(promptsDir, "bare-answer.md"), "utf8").then((t) => nonEmpty(t, "bare-answer 系统提示词")),
    readFile(join(promptsDir, "grader.md"), "utf8").then((t) => nonEmpty(t, "grader 系统提示词")),
    readEvalSkill(graderSkillPath, "eval-grader Skill"),
  ]);

  const skills: EvalSkillSnapshot[] = [
    { name: "eval-grader", path: graderSkillPath, status: graderSkill.status, sha256: graderSkill.sha256 },
  ];

  return {
    prompts: {
      bareAnswer: bareBase,
      evalGrader: composeEvalGraderPrompt(graderBase, graderSkill.body),
    },
    skills,
    allReady: skills.every((s) => s.status === "ready"),
  };
}
