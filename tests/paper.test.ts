import { describe, expect, it } from "vitest";
import { grade } from "../src/shared/grade";
import { buildPaper, type LayoutItem, type PaperOptions } from "../src/shared/paper";
import { paperCode } from "../src/shared/prng";

/** 20 questions over 4 subjects (5 each), 5 choices; 3–4 are a group; 7 has fixed choices. */
const layout: LayoutItem[] = Array.from({ length: 20 }, (_, i) => ({
  eqId: 100 + i,
  questionId: 500 + i,
  subjectId: Math.floor(i / 5) + 1,
  subjectOrder: Math.floor(i / 5) + 1,
  groupKey: i === 3 || i === 4 ? "g1" : null,
  fixedChoices: i === 7,
  choiceCount: 5,
  points: 1,
}));
const all: PaperOptions = { shuffleQuestions: true, shuffleWithinSubject: true, shuffleChoices: true };
const seed = (n: number) => n.toString(16).padStart(32, "0");
const sig = (p: ReturnType<typeof buildPaper>) => p.map((i) => `${i.eqId}:${i.order.join("")}`).join(",");

describe("buildPaper", () => {
  it("same seed → same paper", () => {
    expect(buildPaper(seed(1), all, layout)).toEqual(buildPaper(seed(1), all, layout));
  });

  it("different seeds → different papers (1000 seeds, no two alike)", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 1000; n++) seen.add(sig(buildPaper(seed(n + 1) + "a", all, layout)));
    expect(seen.size).toBe(1000);
  });

  it("screen → original → screen round trip is the identity, and every question appears once", () => {
    const p = buildPaper(seed(7), all, layout);
    expect(p.map((i) => i.eqId).sort()).toEqual(layout.map((l) => l.eqId).sort());
    for (const item of p) {
      for (let screen = 0; screen < item.order.length; screen++) {
        const orig = item.order[screen];
        expect(item.order.indexOf(orig)).toBe(screen);
      }
      expect([...item.order].sort()).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("keeps subject order when shuffling within subjects; keeps groups together; never shuffles fixed choices", () => {
    for (let n = 1; n <= 50; n++) {
      const p = buildPaper(seed(n), all, layout);
      const subj = p.map((i) => layout.find((l) => l.eqId === i.eqId)!.subjectOrder);
      expect(subj).toEqual([...subj].sort((a, b) => a - b));
      const g = p.findIndex((i) => i.eqId === 103);
      expect(p[g + 1].eqId).toBe(104);
      expect(p.find((i) => i.eqId === 107)!.order).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("no shuffling at all → subject then position order, choices as written", () => {
    const p = buildPaper(seed(3), { shuffleQuestions: false, shuffleWithinSubject: true, shuffleChoices: false }, layout);
    expect(p.map((i) => i.eqId)).toEqual(layout.map((l) => l.eqId));
    expect(p.every((i) => i.order.join("") === "01234")).toBe(true);
  });

  it("shuffling across subjects mixes subjects (but still keeps the group together)", () => {
    const p = buildPaper(seed(9), { ...all, shuffleWithinSubject: false }, layout);
    const subj = p.map((i) => layout.find((l) => l.eqId === i.eqId)!.subjectOrder);
    expect(subj).not.toEqual([...subj].sort((a, b) => a - b));
    expect(p[p.findIndex((i) => i.eqId === 103) + 1].eqId).toBe(104);
  });

  it("paper code is 3 characters and stable", () => {
    expect(paperCode(seed(1))).toMatch(/^[0-9A-Z]{3}$/);
    expect(paperCode(seed(1))).toBe(paperCode(seed(1)));
  });
});

describe("grade", () => {
  const cut = { passSubjectPct: 40, passAvgPct: 60 };
  const items = (correctPerSubject: number[], per = 5) =>
    correctPerSubject.flatMap((c, s) => Array.from({ length: per }, (_, k) => ({ subjectId: s + 1, points: 1, correct: k < c })));

  it("averages subject percentages and passes when all subjects ≥ 40% and average ≥ 60%", () => {
    const r = grade(items([5, 4, 3, 2]), cut, [1, 2, 3, 4]); // 100, 80, 60, 40 → avg 70
    expect(r).toMatchObject({ totalCorrect: 14, avgPct: 7000, passed: true });
    expect(r.subjects.map((s) => [s.earned, s.possible])).toEqual([
      [5, 5],
      [4, 5],
      [3, 5],
      [2, 5],
    ]);
  });

  it("fails on a subject below the cut even with a high average (과락)", () => {
    expect(grade(items([5, 5, 5, 1]), cut, [1, 2, 3, 4])).toMatchObject({ avgPct: 8000, passed: false });
  });

  it("fails below the average cut", () => {
    expect(grade(items([3, 3, 2, 2]), cut, [1, 2, 3, 4])).toMatchObject({ avgPct: 5000, passed: false });
  });

  it("uses points within a subject", () => {
    const r = grade(
      [
        { subjectId: 1, points: 3, correct: true },
        { subjectId: 1, points: 1, correct: false },
      ],
      cut,
      [1],
    );
    expect(r.avgPct).toBe(7500);
  });
});
