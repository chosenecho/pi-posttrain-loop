import type { RoleRunner } from "./types.js";

/** Deterministic plumbing fixture, not a language model or a quality evaluator. */
export function createDemoRunner(): RoleRunner {
  return async ({ role, input }) => {
    if (role === "question") {
      return JSON.stringify({ questions: [
        "雨量传感器在什么情况下触发和解除告警？",
        "雨量传感器的供电和工作温度要求是什么？",
        "雨量传感器使用了哪个厂商的芯片？",
      ] });
    }
    const question = String(input.question);
    if (role === "answer") {
      if (question.includes("触发")) {
        return input.previousAnswer === undefined
          ? "采样值达到20毫米时触发告警。"
          : "传感器每10分钟采样一次；采样值大于或等于20毫米时触发告警。告警后，连续3次采样值均低于15毫米才解除。缺失值不计入连续次数，也不触发告警。";
      }
      if (question.includes("供电")) return "供电电压为12V，工作温度为-10℃至50℃。";
      return "材料未提供芯片厂商信息。";
    }
    if (question.includes("厂商")) {
      return JSON.stringify({ decision: "drop", issues: ["演示：材料缺少芯片厂商信息"], feedback: "跳过此题。" });
    }
    if (question.includes("触发") && !String(input.answer).includes("连续3次")) {
      return JSON.stringify({ decision: "revise", issues: ["演示：遗漏解除条件"], feedback: "补充采样周期、解除告警条件，以及缺失采样值的处理方式。" });
    }
    return JSON.stringify({ decision: "pass", issues: [], feedback: "演示流程通过；此结论是固定脚本结果。" });
  };
}
