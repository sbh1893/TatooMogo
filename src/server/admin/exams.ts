import { and, asc, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { attempts, examQuestions, exams, questions, subjects } from "../../db/schema";
import type { SubjectScore } from "../../shared/grade";
import { superAdminOnly } from "../auth/middleware";
import { fail, getDb, isUniqueViolation, rawBatch, type AppEnv, type Db } from "../env";
import { forgetLayout } from "../exam/attempt";
import { auditInsert, auditInsertIf } from "./audit";

/**
 * Answers removed per delete request. A 100-person, 100-question exam has 10,000 answers,
 * so about 5 requests. Each deleted row also writes its index entries (D1 free: 100k rows written/day).
 */
// Swappable in tests so the multi-step path runs with a handful of answers.
export const examDeleteDeps = { chunk: 2000 };

/**
 * SQLite would hand a deleted exam's id (if it was the largest) to the next exam, and isolates cache
 * layouts by exam id with no invalidation. So new ids also skip every id in the deletion log.
 */
const nextExamId = sql`(select max(coalesce((select max(id) from exams), 0),
  coalesce((select max(cast(target_id as integer)) from audit_logs where action = 'exam.delete'), 0)) + 1)`;

/** 6 characters without look-alikes (0/O, 1/I/L), case-insensitive (ANALYSIS #23). */
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newExamCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

type Settings = {
  title: string;
  timeLimitMin: number;
  opensAt: number | null;
  closesAt: number | null;
  passSubjectPct: number;
  passAvgPct: number;
  shuffleQuestions: boolean;
  shuffleWithinSubject: boolean;
  shuffleChoices: boolean;
  revealExplanations: boolean;
  notice: string;
};
/** Fields that may still change once the composition is locked (first attempt). */
const AFTER_LOCK: (keyof Settings)[] = ["title", "opensAt", "closesAt", "revealExplanations", "notice"];

/** Validates a full (create) or partial (update) settings body. */
function parseSettings(raw: unknown, partial: boolean): { ok: true; value: Partial<Settings> } | { ok: false; error: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<Settings> = {};
  const has = (k: string) => o[k] !== undefined || !partial;
  const int = (k: keyof Settings, min: number, max: number, label: string) => {
    if (!has(k)) return null;
    const n = Number(o[k]);
    if (!Number.isInteger(n) || n < min || n > max) return `${label}은(는) ${min}~${max} 사이 정수여야 합니다.`;
    (out as Record<string, unknown>)[k] = n;
    return null;
  };
  const time = (k: "opensAt" | "closesAt") => {
    if (!has(k)) return;
    const v = o[k];
    out[k] = v === null || v === "" || v === undefined ? null : Number(v);
  };
  const bool = (k: keyof Settings, def: boolean) => {
    if (!has(k)) return;
    (out as Record<string, unknown>)[k] = o[k] === undefined ? def : o[k] === true;
  };
  if (has("title")) {
    const t = typeof o.title === "string" ? o.title.trim() : "";
    if (!t || t.length > 100) return { ok: false, error: "시험 이름(100자 이하)을 입력해 주세요." };
    out.title = t;
  }
  for (const err of [
    int("timeLimitMin", 1, 600, "제한 시간(분)"),
    int("passSubjectPct", 0, 100, "과목별 최소 점수(%)"),
    int("passAvgPct", 0, 100, "평균 합격 점수(%)"),
  ])
    if (err) return { ok: false, error: err };
  time("opensAt");
  time("closesAt");
  if ([out.opensAt, out.closesAt].some((v) => v != null && !Number.isFinite(v))) return { ok: false, error: "기간 형식이 올바르지 않습니다." };
  if (out.opensAt != null && out.closesAt != null && out.opensAt >= out.closesAt) {
    return { ok: false, error: "닫히는 시각은 열리는 시각보다 뒤여야 합니다." };
  }
  bool("shuffleQuestions", true);
  bool("shuffleWithinSubject", true);
  bool("shuffleChoices", true);
  bool("revealExplanations", true);
  if (has("notice")) {
    const n = typeof o.notice === "string" ? o.notice.trim() : "";
    if (n.length > 2000) return { ok: false, error: "유의사항은 2000자 이하로 입력해 주세요." };
    out.notice = n;
  }
  return { ok: true, value: out };
}

const attemptCount = sql<number>`(select count(*) from attempts a where a.exam_id = ${exams.id})`;

/** Scores per examinee and the correct rate per common question number (submitted attempts only). */
async function loadResults(db: Db, id: number) {
  const [[exam], people, perQuestion, subj] = await Promise.all([
    db
      .select({ id: exams.id, title: exams.title, code: exams.code, passSubjectPct: exams.passSubjectPct, passAvgPct: exams.passAvgPct })
      .from(exams)
      .where(eq(exams.id, id)),
    db
      .select({
        no: attempts.examineeNo,
        name: attempts.examineeName,
        startedAt: attempts.startedAt,
        submittedAt: attempts.submittedAt,
        submitReason: attempts.submitReason,
        totalCorrect: attempts.totalCorrect,
        avgPct: attempts.avgPct,
        passed: attempts.passed,
        subjectScores: attempts.subjectScores,
      })
      .from(attempts)
      .where(and(eq(attempts.examId, id), isNotNull(attempts.submittedAt)))
      .orderBy(asc(attempts.examineeNo)),
    db.all<{ code: number; version: number; subject: string; correct: number; answered: number }>(sql`
      select q.code as code, q.version as version, s.name as subject,
        count(case when c.is_correct = 1 then 1 end) as correct, count(c.id) as answered
      from exam_questions eq join questions q on q.id = eq.question_id join subjects s on s.id = q.subject_id
      left join answers an on an.exam_question_id = eq.id
        and an.attempt_id in (select id from attempts where exam_id = ${id} and submitted_at is not null)
      left join choices c on c.id = an.choice_id
      where eq.exam_id = ${id} group by eq.id order by eq.position`),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects),
  ]);
  if (!exam) return null;
  const subjectName = new Map(subj.map((s) => [s.id, s.name]));
  const n = people.length;
  return {
    exam,
    submitted: n,
    examinees: people.map(({ subjectScores, avgPct, passed, ...p }) => ({
      ...p,
      avgPct: (avgPct ?? 0) / 100,
      passed: !!passed,
      subjects: ((subjectScores ?? []) as SubjectScore[]).map((s) => ({
        name: subjectName.get(s.subjectId) ?? "",
        correct: s.correct,
        total: s.total,
        pct: s.possible ? Math.round((1000 * s.earned) / s.possible) / 10 : 0,
      })),
    })),
    // Unanswered counts as wrong: the rate is over everyone who submitted.
    questions: perQuestion.map((q) => ({ ...q, rate: n ? Math.round((1000 * q.correct) / n) / 10 : null })),
  };
}

export const examRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await getDb(c.env)
      .select({
        id: exams.id,
        title: exams.title,
        code: exams.code,
        status: exams.status,
        opensAt: exams.opensAt,
        closesAt: exams.closesAt,
        timeLimitMin: exams.timeLimitMin,
        createdAt: exams.createdAt,
        questionCount: sql<number>`(select count(*) from exam_questions q where q.exam_id = ${exams.id})`,
        attemptCount,
      })
      .from(exams)
      .orderBy(desc(exams.id))
      .limit(200);
    return c.json({ items: rows });
  })

  .post("/", async (c) => {
    const v = parseSettings(await c.req.json().catch(() => null), false);
    if (!v.ok) return fail(c, 400, "invalid", v.error);
    const db = getDb(c.env);
    for (let tries = 0; ; tries++) {
      const code = newExamCode();
      try {
        const [[row]] = await db.batch([
          db
            .insert(exams)
            .values({ ...(v.value as Settings), id: nextExamId, code, createdBy: c.get("admin").id })
            .returning(),
          auditInsert(db, c, "exam.create", { type: "exam", id: sql`(select cast(max(id) as text) from exams)` }, { title: v.value.title, code }),
        ]);
        return c.json(row, 201);
      } catch (e) {
        if (!isUniqueViolation(e) || tries >= 4) throw e; // code collision: draw again
      }
    }
  })

  .get("/:id{[0-9]+}", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const [[exam], items, [{ n }]] = await db.batch([
      db.select().from(exams).where(eq(exams.id, id)),
      db
        .select({
          eqId: examQuestions.id,
          questionId: questions.id,
          code: questions.code,
          version: questions.version,
          subjectId: questions.subjectId,
          subjectName: subjects.name,
          stemPreview: sql<string>`substr(${questions.stem}, 1, 80)`,
          groupKey: questions.groupKey,
          points: examQuestions.points,
        })
        .from(examQuestions)
        .innerJoin(questions, eq(questions.id, examQuestions.questionId))
        .innerJoin(subjects, eq(subjects.id, questions.subjectId))
        .where(eq(examQuestions.examId, id))
        .orderBy(asc(examQuestions.position)),
      db.select({ n: count() }).from(attempts).where(eq(attempts.examId, id)),
    ]);
    if (!exam) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    const { layout, ...rest } = exam;
    return c.json({ ...rest, locked: layout !== null, attemptCount: n, questions: items });
  })

  .patch("/:id{[0-9]+}", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const exam = await db.select({ layout: exams.layout, opensAt: exams.opensAt, closesAt: exams.closesAt }).from(exams).where(eq(exams.id, id)).get();
    if (!exam) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    const v = parseSettings(await c.req.json().catch(() => null), true);
    if (!v.ok) return fail(c, 400, "invalid", v.error);
    if (exam.layout !== null) {
      const blocked = Object.keys(v.value).filter((k) => !AFTER_LOCK.includes(k as keyof Settings));
      if (blocked.length) return fail(c, 409, "locked", "응시가 시작된 시험은 이름·기간·해설 공개·유의사항만 바꿀 수 있습니다.");
    }
    const opensAt = v.value.opensAt !== undefined ? v.value.opensAt : exam.opensAt;
    const closesAt = v.value.closesAt !== undefined ? v.value.closesAt : exam.closesAt;
    if (opensAt != null && closesAt != null && opensAt >= closesAt) return fail(c, 400, "invalid", "닫히는 시각은 열리는 시각보다 뒤여야 합니다.");
    if (Object.keys(v.value).length === 0) return fail(c, 400, "invalid", "바꿀 값을 입력해 주세요.");
    const [[row]] = await db.batch([
      db.update(exams).set(v.value).where(eq(exams.id, id)).returning(),
      auditInsert(db, c, "exam.update", { type: "exam", id: String(id) }, v.value),
    ]);
    const { layout, ...rest } = row;
    return c.json({ ...rest, locked: layout !== null });
  })

  /** Replaces the question list: [{ questionId, points }] in order. Refused once anyone has started. */
  .put("/:id{[0-9]+}/questions", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const raw = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
    const list = Array.isArray(raw?.items) ? raw.items : null;
    if (!list || list.length > 300) return fail(c, 400, "invalid", "문항 목록(300개 이하)을 보내 주세요.");
    const items = list.map((it) => {
      const o = (it ?? {}) as { questionId?: unknown; points?: unknown };
      return { questionId: Number(o.questionId), points: o.points === undefined ? 1 : Number(o.points) };
    });
    if (items.some((i) => !Number.isInteger(i.questionId) || !Number.isInteger(i.points) || i.points < 1 || i.points > 100)) {
      return fail(c, 400, "invalid", "문항 번호와 배점(1~100)을 확인해 주세요.");
    }
    if (new Set(items.map((i) => i.questionId)).size !== items.length) return fail(c, 400, "invalid", "같은 문항이 두 번 들어 있습니다.");

    const exam = await db.select({ layout: exams.layout }).from(exams).where(eq(exams.id, id)).get();
    if (!exam) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    if (exam.layout !== null) return fail(c, 409, "locked", "응시가 시작된 시험은 문항 구성을 바꿀 수 없습니다.");
    // D1 allows at most 100 bound variables per statement, so the list goes in as one JSON value.
    const json = JSON.stringify(items.map((it) => ({ q: it.questionId, p: it.points })));
    if (items.length) {
      const ok = await db.get<{ n: number }>(sql`select count(*) as n from questions
        where id in (select json_extract(value, '$.q') from json_each(${json})) and is_latest = 1 and status = 'active'`);
      if (ok?.n !== items.length) return fail(c, 400, "invalid", "사용 중인 최신 문항만 넣을 수 있습니다.");
    }
    // The layout check is repeated inside the batch so a first attempt racing this request wins.
    const unlocked = sql`(select layout from exams where id = ${id}) is null`;
    await rawBatch(c.env, [
      db.delete(examQuestions).where(and(eq(examQuestions.examId, id), unlocked)),
      sql`insert into exam_questions (exam_id, question_id, position, points)
        select ${id}, json_extract(value, '$.q'), key, json_extract(value, '$.p') from json_each(${json}) where ${unlocked}`,
      auditInsert(db, c, "exam.questions", { type: "exam", id: String(id) }, { count: items.length }),
    ]);
    return c.json({ id, count: items.length });
  })

  /** Live status: who is sitting, how far along, last activity, device switches. */
  .get("/:id{[0-9]+}/attempts", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const [[exam], items] = await Promise.all([
      db
        .select({ id: exams.id, title: exams.title, code: exams.code, status: exams.status, total: sql<number>`(select count(*) from exam_questions where exam_id = ${id})` })
        .from(exams)
        .where(eq(exams.id, id)),
      db.all<{
        no: string;
        name: string;
        startedAt: number;
        deadlineAt: number;
        submittedAt: number | null;
        submitReason: string | null;
        deviceSwitches: number;
        lastActiveAt: number;
        answered: number;
      }>(sql`select a.examinee_no as no, a.examinee_name as name, a.started_at as startedAt, a.deadline_at as deadlineAt,
          a.submitted_at as submittedAt, a.submit_reason as submitReason, a.device_switches as deviceSwitches,
          max(coalesce(a.last_seen_at, 0), coalesce((select max(saved_at) from answers x where x.attempt_id = a.id), 0)) as lastActiveAt,
          (select count(*) from answers x where x.attempt_id = a.id and x.choice_id is not null) as answered
        from attempts a where a.exam_id = ${id} order by a.examinee_no`),
    ]);
    if (!exam) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    const submitted = items.filter((i) => i.submittedAt !== null).length;
    return c.json({ exam, serverNow: Date.now(), inProgress: items.length - submitted, submitted, items });
  })

  .get("/:id{[0-9]+}/results", async (c) => {
    const r = await loadResults(getDb(c.env), Number(c.req.param("id")));
    return r ? c.json(r) : fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
  })

  /** Same data for the xlsx file (built in the browser: CPU limit), but the download is logged. */
  .post("/:id{[0-9]+}/export", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const r = await loadResults(db, id);
    if (!r) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    await auditInsert(db, c, "exam.export", { type: "exam", id: String(id) }, { examinees: r.submitted });
    return c.json(r);
  })

  /**
   * Deletes a closed exam with its composition, attempts and answers (questions stay). Super admin only.
   * Runs in steps so no single request does a long D1 write: the first call marks the exam "deleting"
   * (from then on it can't be reopened or entered) and logs it; each call removes up to examDeleteDeps.chunk
   * answers; the last removes the rest. The browser calls again while `done` is false.
   */
  .post("/:id{[0-9]+}/delete", superAdminOnly, async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const exam = await db.select({ status: exams.status, title: exams.title, code: exams.code }).from(exams).where(eq(exams.id, id)).get();
    if (!exam) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    if (exam.status === "open" || exam.status === "draft") return fail(c, 409, "not_closed", "닫힌 시험만 삭제할 수 있습니다.");

    if (exam.status === "closed") {
      const pending = sql`exists(select 1 from attempts where exam_id = ${id} and submitted_at is null)`;
      const [{ n }] = await db.select({ n: count() }).from(attempts).where(eq(attempts.examId, id));
      const [mark] = await rawBatch(c.env, [
        sql`update exams set status = 'deleting' where id = ${id} and status = 'closed' and not ${pending}`,
        auditInsertIf(c, sql`(select status from exams where id = ${id}) = 'deleting'`, "exam.delete", { type: "exam", id: String(id) }, {
          title: exam.title,
          code: exam.code,
          attempts: n,
        }),
      ]);
      if (!mark.meta.changes) {
        return fail(c, 409, "in_progress", "아직 제출되지 않은 응시가 있습니다. 시간이 끝난 응시는 10분 안에 자동 제출되니 잠시 뒤 다시 시도해 주세요.");
      }
    }

    const del = await db.run(sql`delete from answers where rowid in (
      select an.rowid from answers an join attempts a on a.id = an.attempt_id where a.exam_id = ${id} limit ${examDeleteDeps.chunk})`);
    if (del.meta.changes >= examDeleteDeps.chunk) return c.json({ done: false, deletedAnswers: del.meta.changes });
    await rawBatch(c.env, [
      sql`delete from answers where attempt_id in (select id from attempts where exam_id = ${id})`, // stragglers, normally none
      db.delete(attempts).where(eq(attempts.examId, id)),
      db.delete(examQuestions).where(eq(examQuestions.examId, id)),
      db.delete(exams).where(and(eq(exams.id, id), eq(exams.status, "deleting"))),
    ]);
    forgetLayout(id);
    return c.json({ done: true, deletedAnswers: del.meta.changes });
  })

  .post("/:id{[0-9]+}/:action{open|close}", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const action = c.req.param("action") as "open" | "close";
    const exam = await db.select({ id: exams.id, status: exams.status }).from(exams).where(eq(exams.id, id)).get();
    if (!exam) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    if (exam.status === "deleting") return fail(c, 409, "deleting", "삭제 중인 시험입니다.");
    if (action === "open") {
      const [{ n }] = await db.select({ n: count() }).from(examQuestions).where(eq(examQuestions.examId, id));
      if (n === 0) return fail(c, 400, "empty", "문항을 하나 이상 넣은 뒤 열 수 있습니다.");
    }
    const status = action === "open" ? "open" : "closed";
    await db.batch([
      db.update(exams).set({ status }).where(eq(exams.id, id)),
      auditInsert(db, c, `exam.${action}`, { type: "exam", id: String(id) }),
    ]);
    return c.json({ id, status });
  });
