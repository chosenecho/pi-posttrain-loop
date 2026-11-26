export interface Material {
  id: string;
  text: string;
}

export type DatasetSplit = "train" | "test" | "dpo";
export type SplitAssignMethod = "backfill" | "hash" | "manual";
export type DedupPolicy = "latest" | "earliest" | "error";

export type SynthProfile = "standard" | "short" | "trap";

export type Role = "question" | "answer" | "judge";
export type DialogueRole = Role | "followup" | "rubric";

/** Roles used only by the isolated test-set probe pipeline (src/eval/*). */
export type EvalRole =
  | "probe_writer"
  | "probe_critic"
  | "reference"
  | "verifier"
  | "adversary"
  | "rubric_v2"
  | "bare_answer"
  | "eval_grader"
  | "candidate";

export type SystemPrompts = Record<Role, string>;

export interface RoleRequest {
  role: DialogueRole | EvalRole;
  systemPrompt: string;
  input: Record<string, unknown>;
}

export type RoleRunner = (request: RoleRequest) => Promise<string>;

export type FollowupDecision =
  | { action: "followup"; user: string }
  | { action: "stop" };

export interface Skill {
  status: "placeholder" | "ready";
  body: string;
  sha256: string;
}

export type Rubric = Skill;

export interface SkillSnapshot {
  name: string;
  path?: string;
  status: Skill["status"];
  body: string;
  sha256: string;
}

export interface Review {
  decision: "pass" | "revise" | "drop";
  issues: string[];
  feedback: string;
}

export interface EvalRubric {
  stance: string;
  keyPoints: string[];
  forbidden: string[];
  mustNotHallucinate: string[];
}

export interface TrainingMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TrainingSampleLine {
  messages: TrainingMessage[];
}

export interface ResultSample {
  questionId: number;
  materialId: number;
  attempts: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OutcomeSummary {
  questionId: number;
  question: string;
  status: "pending" | "running" | "pass" | "drop" | "exhausted" | "error" | "interrupted";
  attempts: number;
  review?: Review;
  error?: string;
}

export interface VideoUnit {
  videoId: string;
  sourceGroup: string;
  partPaths: string[];
  sourcePath: string;
}
