import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_PROMPTS_DIR,
  DEFAULT_SKILLS_DIR,
  NO_SKILL_PROMPTS_DIR,
} from "../shared/paths.js";
import { errorMessage, nonEmpty, parseMaterial } from "../shared/schema.js";
import { isEvalSkillPath, readSkillFile } from "../shared/skill-loader.js";
import type { Material, Rubric, Skill, SkillSnapshot, SynthProfile } from "../shared/types.js";
import {
  answerPrompt,
  followupPrompt as composeFollowupPrompt,
  judgePrompt,
  questionPrompt,
  readQuestionGeneratorPrompt,
} from "./prompts.js";

export { isEvalSkillPath, readSkillFile };

export const DEFAULT_QUESTION_SKILL = join(DEFAULT_SKILLS_DIR, "question-design/SKILL.md");
export const DEFAULT_FOLLOWUP_SKILL = join(DEFAULT_SKILLS_DIR, "followup-strategy/SKILL.md");
export const DEFAULT_ANSWER_STYLE = join(DEFAULT_SKILLS_DIR, "answer-style/SKILL.md");
export const DEFAULT_QUALITY_JUDGE = join(DEFAULT_SKILLS_DIR, "quality-judge/SKILL.md");

export const SHORT_QUESTION_SKILL = join(DEFAULT_SKILLS_DIR, "short/question-design/SKILL.md");
export const SHORT_FOLLOWUP_SKILL = join(DEFAULT_SKILLS_DIR, "short/followup-strategy/SKILL.md");
export const SHORT_ANSWER_STYLE = join(DEFAULT_SKILLS_DIR, "short/answer-style/SKILL.md");
export const SHORT_QUALITY_JUDGE = join(DEFAULT_SKILLS_DIR, "short/quality-judge/SKILL.md");

export const TRAP_QUESTION_SKILL = join(DEFAULT_SKILLS_DIR, "trap/question-design/SKILL.md");
export const TRAP_FOLLOWUP_SKILL = join(DEFAULT_SKILLS_DIR, "trap/followup-strategy/SKILL.md");
export const TRAP_ANSWER_STYLE = join(DEFAULT_SKILLS_DIR, "trap/answer-style/SKILL.md");
export const TRAP_QUALITY_JUDGE = join(DEFAULT_SKILLS_DIR, "trap/quality-judge/SKILL.md");

interface ProfileSkillPaths {
  questionSkill: string;
  followupSkill: string;
  answerStyle: string;
  qualityJudge: string;
}

const PROFILE_SKILL_PATHS: Record<SynthProfile, ProfileSkillPaths> = {
  standard: {
    questionSkill: DEFAULT_QUESTION_SKILL,
    followupSkill: DEFAULT_FOLLOWUP_SKILL,
    answerStyle: DEFAULT_ANSWER_STYLE,
    qualityJudge: DEFAULT_QUALITY_JUDGE,
  },
  short: {
    questionSkill: SHORT_QUESTION_SKILL,
    followupSkill: SHORT_FOLLOWUP_SKILL,
    answerStyle: SHORT_ANSWER_STYLE,
    qualityJudge: SHORT_QUALITY_JUDGE,
  },
  trap: {
    questionSkill: TRAP_QUESTION_SKILL,
    followupSkill: TRAP_FOLLOWUP_SKILL,
    answerStyle: TRAP_ANSWER_STYLE,
    qualityJudge: TRAP_QUALITY_JUDGE,
  },
};

export function getProfileSkillPaths(profile: SynthProfile): ProfileSkillPaths {
  return PROFILE_SKILL_PATHS[profile];
}

export async function readMaterials(path: string): Promise<Material[]> {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  const seen = new Set<string>();
  const materials: Material[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let material: Material;
    try {
      material = parseMaterial(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`输入第 ${index + 1} 行：${errorMessage(error)}`);
    }
    if (seen.has(material.id)) throw new Error(`材料 id 重复：${material.id}`);
    seen.add(material.id);
    materials.push(material);
  }
  if (!materials.length) throw new Error("输入文件中没有材料");
  return materials;
}

async function readTrainingSkill(path: string, label: string): Promise<Skill> {
  if (isEvalSkillPath(path)) {
    throw new Error(`${label}：训练 Loop 禁止加载测试集专用 Skill（skills/eval/*）：${path}`);
  }
  return readSkillFile(path, label);
}

export function readQuestionSkill(path = DEFAULT_QUESTION_SKILL): Promise<Skill> {
  return readTrainingSkill(path, "出题 Skill");
}

export function readFollowupSkill(path = DEFAULT_FOLLOWUP_SKILL): Promise<Skill> {
  return readTrainingSkill(path, "追问 Skill");
}

export function readAnswerStyle(path = DEFAULT_ANSWER_STYLE): Promise<Skill> {
  return readTrainingSkill(path, "回答风格 Skill");
}

export function readRubric(path = DEFAULT_QUALITY_JUDGE): Promise<Rubric> {
  return readTrainingSkill(path, "判断 Skill");
}

export interface SynthSkillOverrides {
  questionSkill?: string;
  followupSkill?: string;
  answerStyle?: string;
  qualityJudge?: string;
}

export interface ResolveSynthBundleOptions {
  profile: SynthProfile;
  noSkill?: boolean;
  maxTurns: number;
  includeQuestionGenerator?: boolean;
  promptsDir?: string;
  overrides?: SynthSkillOverrides;
}

export interface ResolvedSynthBundle {
  promptDir: string;
  questionPrompt?: string;
  dialoguePrompts: {
    answer: string;
    judge: string;
    followup?: string;
  };
  questionSkills: SkillSnapshot[];
  dialogueSkills: SkillSnapshot[];
  rubricReady: boolean;
}

/**
 * Single source of truth for assembling training prompts & profile Skills (`standard | short | trap | no-skill`).
 * Replaces duplicated skill/prompt wiring across batch, question, and judge flows.
 */
export async function resolveSynthBundle(options: ResolveSynthBundleOptions): Promise<ResolvedSynthBundle> {
  const { profile, maxTurns } = options;
  const noSkill = Boolean(options.noSkill);
  const ov = options.overrides ?? {};

  if (noSkill && profile !== "standard") {
    throw new Error(`--no-skill 不能与 --profile ${profile} 同时指定`);
  }
  if (noSkill && (ov.questionSkill || ov.followupSkill || ov.answerStyle || ov.qualityJudge)) {
    throw new Error("--no-skill 不能与任何 Skill 参数同时指定");
  }

  const promptDir = resolve(options.promptsDir ?? (noSkill ? NO_SKILL_PROMPTS_DIR : DEFAULT_PROMPTS_DIR));
  const defaults = getProfileSkillPaths(profile);

  let questionSystemPrompt = options.includeQuestionGenerator
    ? await readQuestionGeneratorPrompt(DEFAULT_PROMPTS_DIR)
    : undefined;
  let answerSystemPrompt = nonEmpty(await readFile(join(promptDir, "answer.md"), "utf8"), "回答系统提示词");
  let judgeSystemPrompt = nonEmpty(await readFile(join(promptDir, "judge.md"), "utf8"), "质检系统提示词");
  let followupSystemPrompt = maxTurns > 1
    ? nonEmpty(await readFile(join(promptDir, "followup.md"), "utf8"), "多轮追问系统提示词")
    : undefined;

  const questionSkills: SkillSnapshot[] = [];
  const dialogueSkills: SkillSnapshot[] = [];
  let rubricReady = false;

  if (!noSkill) {
    if (questionSystemPrompt !== undefined) {
      const qSkillPath = resolve(ov.questionSkill ?? defaults.questionSkill);
      const qSkill = await readQuestionSkill(qSkillPath);
      questionSystemPrompt = questionPrompt(questionSystemPrompt, qSkill.body);
      questionSkills.push({ name: "question-design", path: qSkillPath, status: qSkill.status, body: qSkill.body, sha256: qSkill.sha256 });
    }

    const stylePath = resolve(ov.answerStyle ?? defaults.answerStyle);
    const style = await readAnswerStyle(stylePath);
    answerSystemPrompt = answerPrompt(answerSystemPrompt, style.body);
    dialogueSkills.push({ name: "answer-style", path: stylePath, status: style.status, body: style.body, sha256: style.sha256 });

    const rubricPath = resolve(ov.qualityJudge ?? defaults.qualityJudge);
    const rubric = await readRubric(rubricPath);
    judgeSystemPrompt = judgePrompt(judgeSystemPrompt, rubric.body);
    rubricReady = rubric.status === "ready";
    dialogueSkills.push({ name: "quality-judge", path: rubricPath, status: rubric.status, body: rubric.body, sha256: rubric.sha256 });

    if (maxTurns > 1 && followupSystemPrompt !== undefined) {
      const fSkillPath = resolve(ov.followupSkill ?? defaults.followupSkill);
      const fSkill = await readFollowupSkill(fSkillPath);
      followupSystemPrompt = composeFollowupPrompt(followupSystemPrompt, fSkill.body);
      dialogueSkills.push({ name: "followup-strategy", path: fSkillPath, status: fSkill.status, body: fSkill.body, sha256: fSkill.sha256 });
    }
  }

  return {
    promptDir,
    questionPrompt: questionSystemPrompt,
    dialoguePrompts: {
      answer: answerSystemPrompt,
      judge: judgeSystemPrompt,
      followup: followupSystemPrompt,
    },
    questionSkills,
    dialogueSkills,
    rubricReady,
  };
}
