import assert from "node:assert/strict";
import test from "node:test";
import { parseEvalRubric, parseQuestions, parseReview, validateMaxAttempts } from "../src/schema.js";

test("questions accepts exactly zero to three nonempty questions and trims their text", () => {
  for (const questions of [[], ["一？"], ["一？", "二？"], ["一？", "二？", "三？"]]) {
    assert.deepEqual(parseQuestions(JSON.stringify({ questions })), questions);
  }
  assert.deepEqual(parseQuestions('{"questions":["  何时交付？  "]}'), ["何时交付？"]);
});

test("questions rejects malformed JSON, invalid shapes, duplicates and more than three items", () => {
  const cases = [
    { text: '{"questions":', error: /JSON/ },
    { text: "null", error: /JSON 对象/ },
    { text: "[]", error: /JSON 对象/ },
    { text: "{}", error: /questions 数组/ },
    { text: '{"questions":"问题"}', error: /questions 数组/ },
    { text: '{"questions":["一","二","三","四"]}', error: /0–3/ },
    { text: '{"questions":[42]}', error: /非空字符串/ },
    { text: '{"questions":["  "]}', error: /非空字符串/ },
    { text: '{"questions":["重复？"," 重复？ "]}', error: /重复/ },
  ];
  for (const { text, error } of cases) {
    assert.throws(() => parseQuestions(text), error, text);
  }
});

test("model JSON permits one complete fenced block, never prose or partial JSON", () => {
  assert.deepEqual(parseQuestions('```json\n{"questions":["何时交付？"]}\n```'), ["何时交付？"]);
  assert.throws(() => parseQuestions('说明：{"questions":[]}'), /JSON/);
  assert.throws(() => parseReview('```json\n{"decision":"pass","issues":[],"feedback":""}'), /JSON/);
});

test("pass review requires an empty issues array and permits empty feedback", () => {
  assert.deepEqual(parseReview('{"decision":"pass","issues":[],"feedback":"  "}'), {
    decision: "pass", issues: [], feedback: "",
  });
});

test("revise review preserves issues and returns trimmed actionable feedback", () => {
  assert.deepEqual(parseReview('{"decision":"revise","issues":["遗漏条件"],"feedback":"  补上签字条件。  "}'), {
    decision: "revise", issues: ["遗漏条件"], feedback: "补上签字条件。",
  });
});

test("drop review accepts a reason in either issues or feedback", () => {
  assert.deepEqual(parseReview('{"decision":"drop","issues":["材料不足"],"feedback":""}'), {
    decision: "drop", issues: ["材料不足"], feedback: "",
  });
  assert.deepEqual(parseReview('{"decision":"drop","issues":[],"feedback":"  问题无效。  "}'), {
    decision: "drop", issues: [], feedback: "问题无效。",
  });
});

test("review rejects unknown decisions, wrong field types and contradictory three-state structures", () => {
  const cases = [
    { value: null, error: /JSON 对象/ },
    { value: [], error: /JSON 对象/ },
    { value: { decision: "accept", issues: [], feedback: "" }, error: /decision/ },
    { value: { issues: [], feedback: "" }, error: /decision/ },
    { value: { decision: "pass", feedback: "" }, error: /issues/ },
    { value: { decision: "pass", issues: "", feedback: "" }, error: /issues/ },
    { value: { decision: "revise", issues: [42], feedback: "修订" }, error: /issues/ },
    { value: { decision: "pass", issues: [] }, error: /feedback/ },
    { value: { decision: "pass", issues: [], feedback: 42 }, error: /feedback/ },
    { value: { decision: "pass", issues: ["尚有问题"], feedback: "" }, error: /issues/ },
    { value: { decision: "revise", issues: [], feedback: "   " }, error: /非空 feedback/ },
    { value: { decision: "drop", issues: [], feedback: "   " }, error: /原因/ },
  ];
  for (const { value, error } of cases) {
    const text = JSON.stringify(value);
    assert.throws(() => parseReview(text), error, text);
  }
});

test("maxAttempts accepts every integer from one through ten", () => {
  for (const attempts of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.equal(validateMaxAttempts(attempts), attempts);
  }
});

test("maxAttempts rejects zero, negatives, fractions, values above ten and nonfinite numbers", () => {
  for (const attempts of [0, -1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => validateMaxAttempts(attempts), /1–10 的整数/, String(attempts));
  }
});

test("parseEvalRubric validates stance, keyPoints, forbidden, and mustNotHallucinate contracts", () => {
  assert.deepEqual(
    parseEvalRubric(
      JSON.stringify({
        stance: "  核心立场  ",
        keyPoints: [" 要点一 ", "要点二"],
        forbidden: ["误区一"],
        mustNotHallucinate: [],
      }),
    ),
    {
      stance: "核心立场",
      keyPoints: ["要点一", "要点二"],
      forbidden: ["误区一"],
      mustNotHallucinate: [],
    },
  );

  for (const bad of [
    { value: {}, error: /stance/ },
    { value: { stance: "立场", keyPoints: [] }, error: /1–6/ },
    { value: { stance: "立场", keyPoints: ["1", "2", "3", "4", "5", "6", "7"] }, error: /1–6/ },
    { value: { stance: "立场", keyPoints: ["重复", " 重复 "] }, error: /重复/ },
    { value: { stance: "立场", keyPoints: ["要点"], forbidden: ["1", "2", "3", "4", "5", "6"] }, error: /0–5/ },
  ]) {
    assert.throws(() => parseEvalRubric(JSON.stringify(bad.value)), bad.error);
  }
});
