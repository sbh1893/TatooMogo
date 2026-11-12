import { describe, expect, it } from "vitest";
import { validateQuestionInput } from "../src/shared/question";

const base = () => ({
  subjectId: 1,
  stem: "  지문  ",
  explanation: "해설",
  fixedChoices: false,
  choices: [
    { body: "가", isCorrect: false },
    { body: "나", isCorrect: true },
    { body: "다", isCorrect: false },
  ],
});

describe("validateQuestionInput", () => {
  it("accepts a valid question and trims text", () => {
    const r = validateQuestionInput(base());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stem).toBe("지문");
  });

  it("requires exactly one correct choice", () => {
    const none = { ...base(), choices: base().choices.map((c) => ({ ...c, isCorrect: false })) };
    const two = { ...base(), choices: base().choices.map((c) => ({ ...c, isCorrect: true })) };
    expect(validateQuestionInput(none).ok).toBe(false);
    expect(validateQuestionInput(two).ok).toBe(false);
  });

  it("does not fix the number of choices to five, but keeps 2..8", () => {
    const one = { ...base(), choices: [{ body: "가", isCorrect: true }] };
    const nine = { ...base(), choices: Array.from({ length: 9 }, (_, i) => ({ body: `${i}`, isCorrect: i === 0 })) };
    expect(validateQuestionInput(one).ok).toBe(false);
    expect(validateQuestionInput(nine).ok).toBe(false);
    expect(validateQuestionInput({ ...base(), choices: base().choices.slice(0, 2).map((c, i) => ({ ...c, isCorrect: i === 0 })) }).ok).toBe(true);
  });

  it("rejects empty stem, empty choice and missing subject", () => {
    expect(validateQuestionInput({ ...base(), stem: " " }).ok).toBe(false);
    expect(validateQuestionInput({ ...base(), subjectId: 0 }).ok).toBe(false);
    const blank = base();
    blank.choices[0].body = "";
    expect(validateQuestionInput(blank).ok).toBe(false);
    expect(validateQuestionInput(null).ok).toBe(false);
  });
});
