import { describe, expect, it } from "vitest";
import { blocking, composeExplanation, itemErrors, parseDocxItems, readDocxXml, type DocxItem } from "../src/shared/docx-items";
import { FIXTURE, fakeDocumentXml, fakeDocx, type FakeItem } from "./docx-fixture";

const parseOne = (it: Partial<FakeItem>) =>
  parseDocxItems(
    fakeDocumentXml([{ no: "010", field: "가짜분야", items: [{ itemNo: 1, stem: "가짜 문제", choices: ["가", "나", "다", "라", "마"], answer: "②", ...it }] }]),
  ).items[0];

describe("docx: reading the fixture", () => {
  const { criteria, items } = parseDocxItems(readDocxXml(fakeDocx(FIXTURE)));
  const byNo = (c: string, n: number) => items.find((i) => i.criterionNo === c && i.itemNo === n)!;

  it("finds every criterion and question, skipping the overview", () => {
    expect(criteria).toBe(2);
    expect(items.map((i) => `${i.criterionNo}-${i.itemNo}`)).toEqual(["001-1", "001-2", "002-1", "002-2"]);
    expect(items.map((i) => i.pos)).toEqual([1, 2, 3, 4]);
  });

  it("reads the labels into fields (label and text on one line or on separate lines)", () => {
    const a = byNo("001", 1);
    expect(a).toMatchObject({
      field: "가짜분야가",
      knowledgeLevel: "암기형",
      difficulty: "하",
      stem: "가짜 문제 1",
      choices: ["가짜 보기 1-1", "가짜 보기 1-2", "가짜 보기 1-3", "가짜 보기 1-4", "가짜 보기 1-5"],
      correctExplanation: "가짜 정답해설",
      wrongNote: "① 가짜 오답 하나 / ② 가짜 오답 둘",
      intent: "가짜 출제의도",
      objectionReview: "가짜 예방검토",
      basis: "가짜-근거-1",
    });
    expect(byNo("001", 2)).toMatchObject({ stem: "가짜 문제 2", knowledgeLevel: "해석형", difficulty: "중상", answer: 5 });
    // Field from the header-row table layout too.
    expect(byNo("002", 1)).toMatchObject({ field: "가짜분야나", knowledgeLevel: "문제해결형" });
  });

  it("turns the answer mark (or digit) into the choice number", () => {
    expect([byNo("001", 1).answer, byNo("001", 2).answer, byNo("002", 1).answer]).toEqual([3, 5, 1]);
    expect(parseOne({ answer: "④번" }).answer).toBe(4);
  });

  it("flags only the broken question: 4 choices and an unknown difficulty", () => {
    expect(items.map((i) => itemErrors(i))).toEqual([[], [], [], ["choices", "difficulty"]]);
  });
});

describe("docx: format errors", () => {
  it("missing answer", () => {
    expect(itemErrors(parseOne({ answer: undefined }))).toEqual(["answer_missing"]);
  });
  it("answer outside the choices", () => {
    expect(itemErrors(parseOne({ answer: "⑦" }))).toEqual(["answer_range"]);
  });
  it("values outside the lists", () => {
    expect(itemErrors(parseOne({ knowledge: "응용형", difficulty: "최상" }))).toEqual(["knowledge", "difficulty"]);
    expect(itemErrors(parseOne({ header: "" }))).toEqual(["knowledge", "difficulty"]);
  });
  it("labels out of order (정답 before the choices) is a warning, plus what it breaks", () => {
    const it = parseOne({ swapAnswerAndChoices: true });
    const errors = itemErrors(it);
    expect(errors).toContain("label_order");
    expect(blocking(["label_order"])).toEqual([]);
  });
  it("the same criterion and question number twice in one file", () => {
    const { items } = parseDocxItems(
      fakeDocumentXml([
        { no: "005", field: "가", items: [{ itemNo: 1, stem: "가짜", choices: ["1", "2", "3", "4", "5"], answer: "①" }] },
        { no: "005", field: "가", items: [{ itemNo: 1, stem: "가짜", choices: ["1", "2", "3", "4", "5"], answer: "①" }] },
      ]),
    );
    expect(items.map((i) => itemErrors(i))).toEqual([["duplicate"], ["duplicate"]]);
  });
  it("two choices on one line, and a choice that mentions other marks", () => {
    const xml = fakeDocumentXml([{ no: "1", field: "가", items: [{ itemNo: 1, stem: "가짜", choices: ["가 ② 나", "다", "라", "①과 ③"], answer: "①" }] }]);
    const it: DocxItem = parseDocxItems(xml).items[0];
    expect(it.choices).toEqual(["가", "나", "다", "라", "①과 ③"]);
  });
  it("stem text that starts like a label is still stem text", () => {
    const it = parseOne({ labelOnOwnLine: true, stem: "문제가 되는 가짜 상황" });
    expect(it.stem).toBe("문제가 되는 가짜 상황");
    expect(itemErrors(it)).toEqual([]);
  });
});

describe("docx: explanation shown to examinees", () => {
  it("is 정답해설, a blank line, then 오답노트 one choice per line", () => {
    expect(composeExplanation("가짜 해설", "① 가짜 오답 하나 / ② 가짜 오답 둘 / ④ 셋")).toBe("가짜 해설\n\n① 가짜 오답 하나\n② 가짜 오답 둘\n④ 셋");
    expect(composeExplanation("가짜 해설", "")).toBe("가짜 해설");
  });
});
