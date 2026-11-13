/** Attempt plumbing shared by the examinee API and the cron job: layout cache, sessions, finalize. */
import { eq, sql } from "drizzle-orm";
import { attempts, exams } from "../../db/schema";
import { grade } from "../../shared/grade";
import type { LayoutItem } from "../../shared/paper";
import type { Db } from "../env";

/** Saves arriving up to this long after the deadline still count (network delay). */
export const GRACE_MS = 5000;
export const SESSION_COOKIE = "tatq_exam";

export type Attempt = typeof attempts.$inferSelect;

// ------------------------------------------------------------------ layout

/**
 * exams.layout never changes once written (the composition locks with it), so it is cached
 * per isolate with no invalidation (docs/ANALYSIS.md 5-3).
 */
const layoutCache = new Map<number, LayoutItem[]>();

export async function getLayout(db: Db, examId: number): Promise<LayoutItem[] | null> {
  const hit = layoutCache.get(examId);
  if (hit) return hit;
  const row = await db.select({ layout: exams.layout }).from(exams).where(eq(exams.id, examId)).get();
  const layout = (row?.layout as LayoutItem[] | null) ?? null;
  if (layout) layoutCache.set(examId, layout);
  return layout;
}

/** Builds and freezes the layout at the first attempt; concurrent first attempts write the same value once. */
export async function ensureLayout(db: Db, examId: number): Promise<LayoutItem[]> {
  const existing = await getLayout(db, examId);
  if (existing) return existing;
  const rows = await db.all<{
    eqId: number;
    questionId: number;
    subjectId: number;
    sortOrder: number;
    groupKey: string | null;
    fixedChoices: number;
    choiceCount: number;
    points: number;
  }>(sql`select eq.id as eqId, q.id as questionId, q.subject_id as subjectId, s.sort_order as sortOrder, q.group_key as groupKey,
      q.fixed_choices as fixedChoices, (select count(*) from choices c where c.question_id = q.id) as choiceCount, eq.points as points
    from exam_questions eq join questions q on q.id = eq.question_id join subjects s on s.id = q.subject_id
    where eq.exam_id = ${examId} order by eq.position`);
  // Subject order = rank by (sort_order, id), so two subjects never share a slot.
  const subjectRank = [...new Map(rows.map((r) => [r.subjectId, r.sortOrder]))]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([id]) => id);
  const layout: LayoutItem[] = rows.map((r) => ({
    eqId: r.eqId,
    questionId: r.questionId,
    subjectId: r.subjectId,
    subjectOrder: subjectRank.indexOf(r.subjectId),
    groupKey: r.groupKey,
    fixedChoices: !!r.fixedChoices,
    choiceCount: r.choiceCount,
    points: r.points,
  }));
  await db.run(sql`update exams set layout = ${JSON.stringify(layout)} where id = ${examId} and layout is null`);
  layoutCache.delete(examId);
  return (await getLayout(db, examId)) ?? layout;
}

/** Subjects in paper order. */
export const subjectOrderOf = (layout: LayoutItem[]) =>
  [...new Map(layout.map((l) => [l.subjectId, l.subjectOrder]))].sort((a, b) => a[1] - b[1]).map(([id]) => id);

/** Drops this isolate's copy after an exam is deleted (other isolates keep theirs; exam ids are never reused). */
/** No id: forget all (tests reset the database, so ids start over). */
export const forgetLayout = (examId?: number) => (examId === undefined ? layoutCache.clear() : layoutCache.delete(examId));

// ------------------------------------------------------------------ sessions

const hex = (buf: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
export const newSecret = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export const hashToken = async (token: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));

// ------------------------------------------------------------------ finalize

/**
 * Grades and closes an attempt (lazy finalize on any request after the deadline, the cron job,
 * or a manual submit). Idempotent: only the first call writes.
 */
export async function finalizeAttempt(db: Db, att: Attempt, reason: "manual" | "timeout", now = Date.now()) {
  if (att.submittedAt !== null) return att;
  const [layout, exam] = await Promise.all([
    getLayout(db, att.examId),
    db.select({ passSubjectPct: exams.passSubjectPct, passAvgPct: exams.passAvgPct }).from(exams).where(eq(exams.id, att.examId)).get(),
  ]);
  if (!layout || !exam) throw new Error(`attempt ${att.id}: exam layout missing`);
  const right = await db.all<{ eqId: number }>(
    sql`select a.exam_question_id as eqId from answers a join choices c on c.id = a.choice_id where a.attempt_id = ${att.id} and c.is_correct = 1`,
  );
  const ok = new Set(right.map((r) => r.eqId));
  const g = grade(
    layout.map((l) => ({ subjectId: l.subjectId, points: l.points, correct: ok.has(l.eqId) })),
    exam,
    subjectOrderOf(layout),
  );
  const submittedAt = reason === "timeout" ? Math.min(now, att.deadlineAt) : now;
  await db.run(sql`update attempts set submitted_at = ${submittedAt}, submit_reason = ${reason}, total_correct = ${g.totalCorrect},
      avg_pct = ${g.avgPct}, passed = ${g.passed ? 1 : 0}, subject_scores = ${JSON.stringify(g.subjects)}
    where id = ${att.id} and submitted_at is null`);
  return (await db.select().from(attempts).where(eq(attempts.id, att.id)).get())!;
}

/** Cron: closes attempts whose time ran out while nobody was looking. */
export async function finalizeExpired(db: Db, now = Date.now()) {
  const due = await db
    .select()
    .from(attempts)
    .where(sql`${attempts.submittedAt} is null and ${attempts.deadlineAt} < ${now - GRACE_MS}`)
    .limit(100);
  for (const att of due) await finalizeAttempt(db, att, "timeout", now);
  return due.length;
}
