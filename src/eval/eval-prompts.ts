import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_EVAL_PROMPTS_DIR,
  DEFAULT_EVAL_SKILLS_DIR,
  DEFAULT_SKILLS_DIR,
} from "../shared/paths.js";
import { nonEmpty } from "../shared/schema.js";
import { isEvalSkillPath, readSkillFile } from "../shared/skill-loader.js";
import type { Skill } from "../shared/types.js";

const DEFAULT_ANSWER_STYLE = join(DEFAULT_SKILLS_DIR, "answer-style/SKILL.md");

export { DEFAULT_EVAL_PROMPTS_DIR, DEFAULT_EVAL_SKILLS_DIR };
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
  systemPrompt: string | null | undefined;
  source: CandidateSystemPromptSource;
}

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
  "reasoning-writer",
  "reasoning-judge",
]);

function skillDirName(filePath: string): string {
  const normalized = resolve(filePath);
  return basename(dirname(normalized)).toLowerCase();
}

export function assertAllowedEvalSkillPath(filePath: string): void {
  const name = skillDirName(filePath);
  if (FORBIDDEN_TRAINING_SKILL_NAMES.has(name)) {
    throw new Error(`评测 Skill 隔离拦截：禁止评测流水线加载训练专属 Skill "${name}"（${filePath}）`);
  }
  if (name === "answer-style") return;
  if (!isEvalSkillPath(filePath)) {
    throw new Error(`评测 Skill 隔离拦截：评测专属 Skill 必须位于 skills/eval/ 目录下（收到：${filePath}）`);
  }
}

export async function readEvalSkill(path: string, label: string): Promise<Skill> {
  assertAllowedEvalSkillPath(path);
  return readSkillFile(path, label);
}

export interface EvalSkillSnapshot {
  name: string;
  path: string;
  status: Skill["status"];
  sha256: string;
}

export interface EvalBuildPrompts {
  probeWriter: string;
  probeCritic: string;
  reference: string;
  verifier: string;
  adversary: string;
}

export interface EvalBuildPromptBundle {
  prompts: EvalBuildPrompts;
  skills: EvalSkillSnapshot[];
  allReady: boolean;
}

export interface CalibrationPrompts {
  bareAnswer: string;
  evalGrader: string;
}

export interface CalibrationPromptBundle {
  prompts: CalibrationPrompts;
  skills: EvalSkillSnapshot[];
  allReady: boolean;
}

function wrapSkill(base: string, tag: string, body: string): string {
  return `${base.trim()}\n\n以下为本次执行标准（<${tag}>）：\n<${tag}>\n${body.trim()}\n</${tag}>`;
}

export async function loadEvalBuildPromptBundle(options: {
  promptsDir?: string;
  skillsDir?: string;
  answerStylePath?: string;
} = {}): Promise<EvalBuildPromptBundle> {
  const promptsDir = options.promptsDir ?? DEFAULT_EVAL_PROMPTS_DIR;
  const skillsDir = options.skillsDir ?? DEFAULT_EVAL_SKILLS_DIR;
  const answerStylePath = options.answerStylePath ?? DEFAULT_ANSWER_STYLE;

  const probeDesignPath = join(skillsDir, "probe-design", "SKILL.md");
  const probeCriticPath = join(skillsDir, "probe-critic", "SKILL.md");
  const probeAnswerPath = join(skillsDir, "probe-answer", "SKILL.md");
  const verifierSkillPath = join(skillsDir, "reference-verifier", "SKILL.md");
  const adversarySkillPath = join(skillsDir, "adversary-tactics", "SKILL.md");

  const [
    writerBase,
    criticBase,
    refBase,
    verifierBase,
    adversaryBase,
    probeDesignSkill,
    probeCriticSkill,
    probeAnswerSkill,
    verifierSkill,
    adversarySkill,
    answerStyleSkill,
  ] = await Promise.all([
    readFile(join(promptsDir, "probe-writer.md"), "utf8").then((t) => nonEmpty(t, "probe-writer 系统提示词")),
    readFile(join(promptsDir, "probe-critic.md"), "utf8").then((t) => nonEmpty(t, "probe-critic 系统提示词")),
    readFile(join(promptsDir, "reference.md"), "utf8").then((t) => nonEmpty(t, "reference 系统提示词")),
    readFile(join(promptsDir, "verifier.md"), "utf8").then((t) => nonEmpty(t, "verifier 系统提示词")),
    readFile(join(promptsDir, "adversary.md"), "utf8").then((t) => nonEmpty(t, "adversary 系统提示词")),
    readEvalSkill(probeDesignPath, "probe-design Skill"),
    readEvalSkill(probeCriticPath, "probe-critic Skill"),
    readEvalSkill(probeAnswerPath, "probe-answer Skill"),
    readEvalSkill(verifierSkillPath, "reference-verifier Skill"),
    readEvalSkill(adversarySkillPath, "adversary-tactics Skill"),
    readEvalSkill(answerStylePath, "answer-style Skill"),
  ]);

  const skills: EvalSkillSnapshot[] = [
    { name: "probe-design", path: probeDesignPath, status: probeDesignSkill.status, sha256: probeDesignSkill.sha256 },
    { name: "probe-critic", path: probeCriticPath, status: probeCriticSkill.status, sha256: probeCriticSkill.sha256 },
    { name: "answer-style", path: answerStylePath, status: answerStyleSkill.status, sha256: answerStyleSkill.sha256 },
    { name: "probe-answer", path: probeAnswerPath, status: probeAnswerSkill.status, sha256: probeAnswerSkill.sha256 },
    { name: "reference-verifier", path: verifierSkillPath, status: verifierSkill.status, sha256: verifierSkill.sha256 },
    { name: "adversary-tactics", path: adversarySkillPath, status: adversarySkill.status, sha256: adversarySkill.sha256 },
  ];

  const reference = [
    refBase.trim(),
    "以下为作者风格参考（<answer-style>）：",
    `<answer-style>\n${answerStyleSkill.body.trim()}\n</answer-style>`,
    "以下为测试集参考答案规范（<probe-answer>）：",
    `<probe-answer>\n${probeAnswerSkill.body.trim()}\n</probe-answer>`,
  ].join("\n\n");

  return {
    prompts: {
      probeWriter: wrapSkill(writerBase, "probe-design", probeDesignSkill.body),
      probeCritic: wrapSkill(criticBase, "probe-critic", probeCriticSkill.body),
      reference,
      verifier: wrapSkill(verifierBase, "reference-verifier", verifierSkill.body),
      adversary: wrapSkill(adversaryBase, "adversary-tactics", adversarySkill.body),
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
      bareAnswer: bareBase.trim(),
      evalGrader: wrapSkill(graderBase, "eval-grader", graderSkill.body),
    },
    skills,
    allReady: skills.every((s) => s.status === "ready"),
  };
}
