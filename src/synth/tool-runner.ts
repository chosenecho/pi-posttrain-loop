import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createCallBudget } from "../shared/call-budget.js";
import { createPiSearchRunner, type PiConfig, type PiSearchRunnerOptions } from "../shared/pi-runner.js";
import { createQuestionAgentTool, createQuestionnaireAgentTool, createTodoAgentTool } from "../shared/pi-tools.js";
import type { QuestionTaskSpec, RoleRequest, RoleRunner, SearchAnswerRunner, SynthProfile } from "../shared/types.js";
import type { WebSearchRunner } from "../shared/web-search.js";
import { getSynthProfile } from "./profiles.js";

export interface SynthToolRunnerOptions extends Omit<PiSearchRunnerOptions, "transformInput" | "maxToolRounds"> {
  profile?: SynthProfile;
  maxTodoCalls?: number;
  maxClarifyCalls?: number;
  simulatorRunner?: RoleRunner;
}

/** Synth owns task metadata, simulator isolation and profile-specific tool assembly. */
export function createSynthToolRunner(config: PiConfig, webSearchRunner?: WebSearchRunner, options: SynthToolRunnerOptions = {}): SearchAnswerRunner {
  const profile = getSynthProfile(options.profile ?? "standard");
  const maxSearchCalls = Math.max(1, Math.floor(options.maxSearchCalls ?? 3));
  const maxTodoCalls = Math.max(1, Math.floor(options.maxTodoCalls ?? 12));
  const maxClarifyCalls = Math.max(1, Math.floor(options.maxClarifyCalls ?? 1));
  function task(request: RoleRequest) {
    const { _questionMode, _taskSpec, ...wireInput } = request.input;
    const questionMode = typeof _questionMode === "string" ? _questionMode : undefined;
    const taskSpec = _taskSpec && typeof _taskSpec === "object" ? _taskSpec as QuestionTaskSpec : undefined;
    return {
      wireInput, taskSpec,
      mountTodo: profile.questionMode === "todo_plan" || questionMode === "todo_plan",
      mountClarify: profile.questionMode === "clarify_question" || questionMode === "clarify_question",
    };
  }
  return createPiSearchRunner(config, webSearchRunner, {
    ...options,
    transformInput: (request) => task(request).wireInput,
    maxToolRounds: (request) => {
      const { mountTodo, mountClarify } = task(request);
      return (mountTodo ? maxTodoCalls : 0) + (mountClarify ? maxClarifyCalls : 0) + maxSearchCalls + 2;
    },
    extraToolsFactory: (context) => {
      const { request, recordCallStep, signal } = context;
      const { wireInput, taskSpec, mountTodo, mountClarify } = task(request);
      const tools: AgentTool[] = [];
      if (mountTodo) tools.push(createTodoAgentTool({ maxCalls: maxTodoCalls, onCallStep: recordCallStep, signal }));
      if (mountClarify) {
        // question and questionnaire consume the same non-refundable allowance.
        const budget = createCallBudget(maxClarifyCalls);
        const simulatorContext = {
          question: typeof wireInput.question === "string" ? wireInput.question : undefined,
          material: typeof wireInput.material === "string" ? wireInput.material : undefined,
          hiddenUserPersona: taskSpec?.hidden_user_persona,
          missingSlots: taskSpec?.missing_slots,
          runRole: options.simulatorRunner, signal,
        };
        const toolOptions = { maxCalls: maxClarifyCalls, budget, context: simulatorContext, onCallStep: recordCallStep, signal };
        tools.push(createQuestionAgentTool(toolOptions), createQuestionnaireAgentTool(toolOptions));
      }
      if (options.extraToolsFactory) tools.push(...options.extraToolsFactory(context));
      return tools;
    },
  });
}
