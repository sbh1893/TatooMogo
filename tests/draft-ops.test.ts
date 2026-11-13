import { describe, expect, it } from "vitest";
import { blankDraft, mergeWithNext, splitAt, stemPicture, toBulkItem, toReview, type ReviewDraft } from "../src/shared/draft-ops";

const d = (no: number, stem: string, choices: string[], extra: Partial<ReviewDraft> = {}): ReviewDraft => ({
  ...blankDraft(no, 1),
  stem,
  choices: choices.map((text) => ({ text })),
  ...extra,
});

describe("review draft operations", () => {
  it("matches the subject heading to a subject by name, ignoring spacing and dots", () => {
    const [r] = toReview([{ ...d(1, "x", ["a"]), subject: "위생·감염관리" }], [{ id: 7, name: "위생 감염관리" }]);
    expect(r.subjectId).toBe(7);
  });

  it("merge: a question wrongly cut after its stem gets the next part's choices", () => {
    const merged = mergeWithNext([d(1, "멸균 조", []), d(2, "건은?", ["가", "나"]), d(3, "다음", ["다"])], 0);
    expect(merged.map((q) => q.no)).toEqual([1, 3]);
    expect(merged[0].stem).toBe("멸균 조건은?");
    expect(merged[0].choices.map((c) => c.text)).toEqual(["가", "나"]);
  });

  it("merge: text wrongly read as a new question continues the last choice", () => {
    const [q] = mergeWithNext([d(1, "옳은 것은?", ["가", "121℃에서"]), d(2, "15분", [])], 0);
    expect(q.choices.map((c) => c.text)).toEqual(["가", "121℃에서 15분"]);
  });

  it("split: at a cursor in the last choice, the rest becomes the next question", () => {
    const list = splitAt([d(1, "첫 지문", ["가", "나 2. 둘째 지문"])], 0, 1, 2);
    expect(list.map((q) => [q.no, q.stem, q.choices.map((c) => c.text)])).toEqual([
      [1, "첫 지문", ["가", "나"]],
      [2, "둘째 지문", []],
    ]);
  });

  it("split: at a cursor in the stem, the stem tail and all choices move", () => {
    const list = splitAt([d(1, "첫 지문 둘째 지문", ["가", "나"])], 0, "stem", 4);
    expect(list.map((q) => [q.stem, q.choices.length])).toEqual([
      ["첫 지문", 0],
      ["둘째 지문", 2],
    ]);
  });

  it("stem picture: group and stem pictures on one page become one crop", () => {
    const pic = stemPicture(
      d(1, "x", [], {
        groupImages: [{ page: 2, box: { x: 10, y: 10, w: 50, h: 20 } }],
        stemImages: [{ page: 2, box: { x: 20, y: 40, w: 60, h: 20 } }],
      }),
    );
    expect(pic).toEqual({ page: 2, box: { x: 10, y: 10, w: 70, h: 50 } });
  });

  it("bulk item: needs subject and answer; puts the group's shared passage in front of the stem", () => {
    expect(toBulkItem(d(1, "x", ["가", "나"]), () => undefined)).toMatchObject({ ok: false });
    const r = toBulkItem(d(6, "원리는?", ["가", "나"], { subjectId: 1, answer: 2, groupIntro: "다음 화면을 보고 답하시오.", groupKey: "6-7" }), () => "media/k.png");
    expect(r).toMatchObject({
      ok: true,
      item: { sourceNo: 6, stem: "다음 화면을 보고 답하시오.\n\n원리는?", groupKey: "6-7", choices: [{ isCorrect: false }, { isCorrect: true }] },
    });
  });
});
