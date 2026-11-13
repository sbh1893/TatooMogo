/** Scoring (docs/ANALYSIS.md 5-4): subject average, every subject above its cut-off. */

export type GradeItem = { subjectId: number; points: number; correct: boolean };
export type SubjectScore = { subjectId: number; earned: number; possible: number; correct: number; total: number };
export type GradeResult = {
  totalCorrect: number;
  /** Average of subject percentages × 100, rounded (6125 = 61.25%). */
  avgPct: number;
  passed: boolean;
  subjects: SubjectScore[];
};

export function grade(items: GradeItem[], cut: { passSubjectPct: number; passAvgPct: number }, subjectOrder: number[]): GradeResult {
  const subjects = subjectOrder
    .map((subjectId) => {
      const mine = items.filter((i) => i.subjectId === subjectId);
      return {
        subjectId,
        earned: mine.reduce((s, i) => s + (i.correct ? i.points : 0), 0),
        possible: mine.reduce((s, i) => s + i.points, 0),
        correct: mine.filter((i) => i.correct).length,
        total: mine.length,
      };
    })
    .filter((s) => s.total > 0);
  const pcts = subjects.map((s) => (s.possible ? (100 * s.earned) / s.possible : 0));
  const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
  return {
    totalCorrect: items.filter((i) => i.correct).length,
    avgPct: Math.round(avg * 100),
    passed: pcts.length > 0 && pcts.every((p) => p >= cut.passSubjectPct) && avg >= cut.passAvgPct,
    subjects,
  };
}
