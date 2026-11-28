import { join } from "node:path";
import { DEFAULT_SKILLS_DIR } from "../shared/paths.js";
import { ALL_SYNTH_PROFILES, TRAIN_SUITE_PROFILES, type QuestionMode, type SynthProfile } from "../shared/types.js";

// The shared profile list remains the one enumeration used by CLI/schema consumers.
export { ALL_SYNTH_PROFILES, TRAIN_SUITE_PROFILES };

export interface ProfileSkillPaths {
  readonly questionSkill: string;
  readonly followupSkill: string;
  readonly answerStyle: string;
  readonly qualityJudge: string;
}

interface SynthProfileDescriptor {
  readonly skills: ProfileSkillPaths;
  readonly maxTurns: number;
  readonly maxQuestionsPerVideo?: number;
  readonly questionMode: QuestionMode;
  readonly tools: Readonly<{ required: boolean; defaultSearch: boolean; alwaysSearch: boolean }>;
  readonly dedicatedAnswerPrompt?: string;
  readonly exportTag: SynthProfile;
}

function descriptor(profile: SynthProfile): SynthProfileDescriptor {
  const root = profile === "standard" ? DEFAULT_SKILLS_DIR : join(DEFAULT_SKILLS_DIR, profile);
  const toolProfile = profile === "search" || profile === "todo" || profile === "clarify";
  return Object.freeze({
    skills: Object.freeze({
      questionSkill: join(root, "question-design/SKILL.md"),
      followupSkill: join(root, "followup-strategy/SKILL.md"),
      answerStyle: join(root, "answer-style/SKILL.md"),
      qualityJudge: join(root, "quality-judge/SKILL.md"),
    }),
    maxTurns: profile === "standard" || profile === "long" || profile === "xlong" ? 3 : 2,
    ...(toolProfile || profile === "trap" ? { maxQuestionsPerVideo: 2 } : {}),
    questionMode: profile === "todo" ? "todo_plan" : profile === "clarify" ? "clarify_question" : "direct",
    tools: Object.freeze({ required: toolProfile, defaultSearch: profile !== "standard", alwaysSearch: profile === "search" }),
    ...(toolProfile ? { dedicatedAnswerPrompt: `answer-${profile}.md` } : {}),
    exportTag: profile,
  });
}

const descriptors = Object.freeze(Object.fromEntries(ALL_SYNTH_PROFILES.map((profile) => [profile, descriptor(profile)]))) as Readonly<Record<SynthProfile, SynthProfileDescriptor>>;

export function getSynthProfile(profile: SynthProfile): SynthProfileDescriptor {
  return descriptors[profile];
}

export function defaultMaxTurnsForProfile(profile: SynthProfile): number {
  return getSynthProfile(profile).maxTurns;
}
