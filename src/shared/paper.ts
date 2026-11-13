/**
 * One examinee's paper from the exam layout and the attempt seed (docs/ANALYSIS.md 5-2, 5-3).
 * Pure and deterministic: the server recomputes it on every request instead of storing it.
 */
import { rng, shuffle } from "./prng";

/** Shuffle input of an exam, frozen at its first attempt (exams.layout). */
export type LayoutItem = {
  eqId: number; // exam_questions.id
  questionId: number; // questions.id (a specific version)
  subjectId: number;
  subjectOrder: number;
  groupKey: string | null;
  fixedChoices: boolean;
  choiceCount: number;
  points: number;
};

export type PaperOptions = { shuffleQuestions: boolean; shuffleWithinSubject: boolean; shuffleChoices: boolean };

/** Screen position n (0-based) shows `paper[n]`; its screen choice m is original choice `order[m]`. */
export type PaperItem = { eqId: number; questionId: number; order: number[] };

/** `layout` must be in exam_questions.position order. */
export function buildPaper(seed: string, opts: PaperOptions, layout: LayoutItem[]): PaperItem[] {
  // 1. Units: a group moves together, in its original order.
  const units: LayoutItem[][] = [];
  const byGroup = new Map<string, LayoutItem[]>();
  for (const item of layout) {
    if (item.groupKey) {
      const unit = byGroup.get(item.groupKey);
      if (unit) {
        unit.push(item);
        continue;
      }
      byGroup.set(item.groupKey, [item]);
      units.push(byGroup.get(item.groupKey)!);
    } else units.push([item]);
  }

  // 2. Question order. Subjects keep their order unless shuffling across the whole paper.
  const bySubject = (list: LayoutItem[][]) => {
    const subjects = [...new Set(list.map((u) => u[0].subjectOrder))].sort((a, b) => a - b);
    return subjects.map((s) => list.filter((u) => u[0].subjectOrder === s));
  };
  const q = rng(`${seed}|q`);
  let ordered: LayoutItem[][];
  if (!opts.shuffleQuestions) ordered = bySubject(units).flat();
  else if (opts.shuffleWithinSubject) ordered = bySubject(units).flatMap((s) => shuffle(s, q));
  else ordered = shuffle(units, q);

  // 3. Choice order, per question from its own stream.
  return ordered.flat().map((item) => {
    const base = Array.from({ length: item.choiceCount }, (_, i) => i);
    const order = opts.shuffleChoices && !item.fixedChoices ? shuffle(base, rng(`${seed}|c|${item.eqId}`)) : base;
    return { eqId: item.eqId, questionId: item.questionId, order };
  });
}
