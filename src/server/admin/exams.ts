import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { attempts, examQuestions, exams, questions, subjects } from "../../db/schema";
import { fail, getDb, isUniqueViolation, type AppEnv } from "../env";
import { auditInsert } from "./audit";

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
            .values({ ...(v.value as Settings), code, createdBy: c.get("admin").id })
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
    if (items.length) {
      const ok = await db
        .select({ id: questions.id })
        .from(questions)
        .where(and(inArray(questions.id, items.map((i) => i.questionId)), eq(questions.isLatest, true), eq(questions.status, "active")));
      if (ok.length !== items.length) return fail(c, 400, "invalid", "사용 중인 최신 문항만 넣을 수 있습니다.");
    }
    // The layout check is repeated inside the batch so a first attempt racing this request wins.
    const unlocked = sql`(select layout from exams where id = ${id}) is null`;
    await db.batch([
      db.delete(examQuestions).where(and(eq(examQuestions.examId, id), unlocked)),
      ...(items.length
        ? [db.insert(examQuestions).values(items.map((it, position) => ({ examId: id, questionId: it.questionId, position, points: it.points })))]
        : []),
      auditInsert(db, c, "exam.questions", { type: "exam", id: String(id) }, { count: items.length }),
    ]);
    return c.json({ id, count: items.length });
  })

  .post("/:id{[0-9]+}/:action{open|close}", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const action = c.req.param("action") as "open" | "close";
    const exam = await db.select({ id: exams.id }).from(exams).where(eq(exams.id, id)).get();
    if (!exam) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
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
