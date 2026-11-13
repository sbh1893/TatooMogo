/**
 * Examinee API (/api/exam). Nothing here ever sends a correct answer, an explanation, a choice id,
 * an original choice order or the seed before the attempt is submitted (CLAUDE.md rule 1).
 */
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { attempts, exams } from "../../db/schema";
import { buildPaper, renumberMarks, type PaperItem } from "../../shared/paper";
import { paperCode } from "../../shared/prng";
import { fail, getDb, isUniqueViolation, type AppEnv, type Bindings, type Db } from "../env";
import { ensureLayout, finalizeAttempt, getLayout, GRACE_MS, hashToken, newSecret, SESSION_COOKIE, type Attempt } from "./attempt";

type ExamEnv = { Bindings: Bindings; Variables: AppEnv["Variables"] & { attempt: Attempt } };
type Exam = typeof exams.$inferSelect;

const isOpen = (e: Pick<Exam, "status" | "opensAt" | "closesAt">, now: number) =>
  e.status === "open" && (e.opensAt === null || now >= e.opensAt) && (e.closesAt === null || now < e.closesAt);
const mediaUrl = (key: string | null) => (key ? `/api/exam/${key}` : null);
const paperOf = (att: Attempt, exam: Exam, layout: NonNullable<Awaited<ReturnType<typeof getLayout>>>) =>
  buildPaper(att.seed, exam, layout);

async function examByCode(db: Db, raw: unknown) {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{6}$/.test(code)) return null;
  const exam = await db.select().from(exams).where(eq(exams.code, code)).get();
  return exam && exam.status !== "deleting" ? exam : null; // being deleted = already gone for examinees
}

/** Issues a fresh session for this device; any earlier device stops working (last device wins). */
async function startSession(c: Parameters<typeof setCookie>[0], db: Db, attemptId: number, switched: boolean, now: number) {
  const token = newSecret();
  await db
    .update(attempts)
    .set({ sessionHash: await hashToken(token), lastSeenAt: now, ...(switched ? { deviceSwitches: sql`${attempts.deviceSwitches} + 1` } : {}) })
    .where(eq(attempts.id, attemptId));
  setCookie(c, SESSION_COOKIE, token, { path: "/api/exam", httpOnly: true, secure: true, sameSite: "Strict", maxAge: 60 * 60 * 24 });
}

export const examApi = new Hono<ExamEnv>()
  .use(csrf())

  // ---------------------------------------------------------------- before entering
  .get("/info", async (c) => {
    const db = getDb(c.env);
    const exam = await examByCode(db, c.req.query("code"));
    if (!exam || exam.status === "draft") return fail(c, 404, "not_found", "시험 코드를 확인해 주세요.");
    const subjects = await db.all<{ name: string; count: number }>(
      sql`select s.name as name, count(*) as count from exam_questions eq join questions q on q.id = eq.question_id
        join subjects s on s.id = q.subject_id where eq.exam_id = ${exam.id} group by s.id order by s.sort_order, s.id`,
    );
    const now = Date.now();
    return c.json({
      title: exam.title,
      code: exam.code,
      timeLimitMin: exam.timeLimitMin,
      passSubjectPct: exam.passSubjectPct,
      passAvgPct: exam.passAvgPct,
      notice: exam.notice,
      opensAt: exam.opensAt,
      closesAt: exam.closesAt,
      open: isOpen(exam, now),
      serverNow: now,
      subjects,
      total: subjects.reduce((s, x) => s + x.count, 0),
    });
  })

  .post("/enter", async (c) => {
    const db = getDb(c.env);
    const body = (await c.req.json().catch(() => null)) as { code?: unknown; examineeNo?: unknown; name?: unknown } | null;
    const examineeNo = typeof body?.examineeNo === "string" ? body.examineeNo.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!/^[0-9A-Za-z-]{1,16}$/.test(examineeNo)) return fail(c, 400, "invalid", "수험번호는 영문·숫자 16자 이하로 입력해 주세요.");
    if (!name || name.length > 12) return fail(c, 400, "invalid", "이름(12자 이하)을 입력해 주세요.");
    const exam = await examByCode(db, body?.code);
    if (!exam || exam.status === "draft") return fail(c, 404, "not_found", "시험 코드를 확인해 주세요.");
    const now = Date.now();

    for (let tries = 0; tries < 2; tries++) {
      const existing = await db
        .select()
        .from(attempts)
        .where(and(eq(attempts.examId, exam.id), eq(attempts.examineeNo, examineeNo)))
        .get();
      if (existing) {
        // Same number, different name: someone else's attempt (ANALYSIS #5).
        if (existing.examineeName !== name) return fail(c, 403, "name_mismatch", "이미 다른 이름으로 응시한 수험번호입니다.");
        await startSession(c, db, existing.id, true, now);
        const att = existing.submittedAt === null && now > existing.deadlineAt + GRACE_MS ? await finalizeAttempt(db, existing, "timeout", now) : existing;
        return c.json({ status: att.submittedAt === null ? "in_progress" : "submitted" });
      }
      if (!isOpen(exam, now)) return fail(c, 403, "closed", "지금은 응시할 수 있는 시간이 아닙니다.");

      const layout = await ensureLayout(db, exam.id);
      if (layout.length === 0) return fail(c, 403, "closed", "아직 문항이 준비되지 않은 시험입니다.");
      const token = newSecret();
      const deadline = Math.min(now + exam.timeLimitMin * 60_000, exam.closesAt ?? Infinity);
      try {
        await db.insert(attempts).values({
          examId: exam.id,
          examineeNo,
          examineeName: name,
          seed: newSecret(), // 128-bit crypto random, never sent to the browser
          sessionHash: await hashToken(token),
          startedAt: now,
          deadlineAt: deadline,
          lastSeenAt: now,
        });
      } catch (e) {
        if (isUniqueViolation(e)) continue; // the same person entered twice at once: join that attempt
        throw e;
      }
      setCookie(c, SESSION_COOKIE, token, { path: "/api/exam", httpOnly: true, secure: true, sameSite: "Strict", maxAge: 60 * 60 * 24 });
      return c.json({ status: "in_progress" });
    }
    return fail(c, 409, "conflict", "잠시 후 다시 시도해 주세요.");
  })

  // ---------------------------------------------------------------- with a session
  .use("/*", async (c, next) => {
    if (c.req.path.endsWith("/info") || c.req.path.endsWith("/enter")) return next();
    const token = getCookie(c, SESSION_COOKIE);
    const att = token ? await getDb(c.env).select().from(attempts).where(eq(attempts.sessionHash, await hashToken(token))).get() : undefined;
    if (!att) {
      deleteCookie(c, SESSION_COOKIE, { path: "/api/exam" });
      return fail(c, 401, "session", "다른 기기에서 입장했거나 입장 정보가 없습니다. 처음 화면에서 다시 입장해 주세요.");
    }
    c.set("attempt", att);
    await next();
  })

  .get("/paper", async (c) => {
    const db = getDb(c.env);
    let att = c.get("attempt");
    const now = Date.now();
    if (att.submittedAt === null && now > att.deadlineAt + GRACE_MS) att = await finalizeAttempt(db, att, "timeout", now);
    if (att.submittedAt !== null) return fail(c, 409, "submitted", "이미 제출한 시험입니다.");
    const [exam, layout] = await Promise.all([db.select().from(exams).where(eq(exams.id, att.examId)).get(), getLayout(db, att.examId)]);
    if (!exam || !layout) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    const paper = paperOf(att, exam, layout);

    const inExam = sql`(select question_id from exam_questions where exam_id = ${att.examId})`;
    const [qs, cs, ans, subj] = await Promise.all([
      db.all<{ id: number; stem: string; img: string | null; subjectId: number }>(
        sql`select id, stem, stem_image_key as img, subject_id as subjectId from questions where id in ${inExam}`,
      ),
      // No is_correct, no id: only what the screen shows.
      db.all<{ q: number; ord: number; body: string; img: string | null }>(
        sql`select question_id as q, ord, body, image_key as img from choices where question_id in ${inExam}`,
      ),
      db.all<{ eqId: number; ord: number }>(
        sql`select a.exam_question_id as eqId, c.ord as ord from answers a join choices c on c.id = a.choice_id where a.attempt_id = ${att.id}`,
      ),
      db.all<{ id: number; name: string }>(sql`select id, name from subjects`),
    ]);
    await db.update(attempts).set({ lastSeenAt: now }).where(eq(attempts.id, att.id));

    const qById = new Map(qs.map((q) => [q.id, q]));
    const subjectName = new Map(subj.map((s) => [s.id, s.name]));
    const choiceOf = (qid: number, ord: number) => cs.find((x) => x.q === qid && x.ord === ord);
    const ansByEq = new Map(ans.map((a) => [a.eqId, a.ord]));
    const order = [...new Set(layout.map((l) => l.subjectId))];
    return c.json({
      exam: { title: exam.title, subjects: order.map((id) => subjectName.get(id) ?? "") },
      examinee: { no: att.examineeNo, name: att.examineeName },
      paperCode: paperCode(att.seed),
      serverNow: now,
      deadlineAt: att.deadlineAt,
      questions: paper.map((item, n) => {
        const q = qById.get(item.questionId)!;
        return {
          no: n + 1,
          subjectName: subjectName.get(q.subjectId) ?? "",
          stem: q.stem,
          stemImage: mediaUrl(q.img),
          choices: item.order.map((ord, m) => {
            const ch = choiceOf(item.questionId, ord);
            return { no: m + 1, text: ch?.body ?? "", image: mediaUrl(ch?.img ?? null) };
          }),
        };
      }),
      answers: paper.flatMap((item, n) => (ansByEq.has(item.eqId) ? [{ no: n + 1, choice: item.order.indexOf(ansByEq.get(item.eqId)!) + 1 }] : [])),
    });
  })

  /** Saves one answer as the original choice id: ≈3–5 rows read (docs/ANALYSIS.md 5-3). */
  .put("/answers", async (c) => {
    const db = getDb(c.env);
    const att = c.get("attempt");
    const now = Date.now();
    if (att.submittedAt !== null) return fail(c, 409, "submitted", "이미 제출한 시험입니다.");
    if (now > att.deadlineAt + GRACE_MS) {
      await finalizeAttempt(db, att, "timeout", now);
      return fail(c, 409, "timeout", "시험 시간이 끝나 답안이 제출되었습니다.");
    }
    const body = (await c.req.json().catch(() => null)) as { no?: unknown; choice?: unknown } | null;
    const [exam, layout] = await Promise.all([
      db
        .select({ shuffleQuestions: exams.shuffleQuestions, shuffleWithinSubject: exams.shuffleWithinSubject, shuffleChoices: exams.shuffleChoices })
        .from(exams)
        .where(eq(exams.id, att.examId))
        .get(),
      getLayout(db, att.examId),
    ]);
    if (!exam || !layout) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    const paper: PaperItem[] = buildPaper(att.seed, exam, layout);
    const no = Number(body?.no);
    const item = Number.isInteger(no) ? paper[no - 1] : undefined;
    const choice = body?.choice === null ? null : Number(body?.choice);
    if (!item || (choice !== null && (!Number.isInteger(choice) || choice < 1 || choice > item.order.length))) {
      return fail(c, 400, "invalid", "문항 번호나 보기 번호가 올바르지 않습니다.");
    }
    const open = sql`exists(select 1 from attempts where id = ${att.id} and submitted_at is null)`;
    const upsert = sql`on conflict (attempt_id, exam_question_id) do update set choice_id = excluded.choice_id, saved_at = excluded.saved_at`;
    const res = await db.run(
      choice === null
        ? sql`insert into answers (attempt_id, exam_question_id, choice_id, saved_at) select ${att.id}, ${item.eqId}, null, ${now} where ${open} ${upsert}`
        : sql`insert into answers (attempt_id, exam_question_id, choice_id, saved_at)
            select ${att.id}, ${item.eqId}, id, ${now} from choices where question_id = ${item.questionId} and ord = ${item.order[choice - 1]} and ${open} ${upsert}`,
    );
    if (!res.meta.changes) return fail(c, 409, "submitted", "이미 제출한 시험입니다.");
    return c.json({ savedAt: now, serverNow: now, deadlineAt: att.deadlineAt });
  })

  .post("/submit", async (c) => {
    const db = getDb(c.env);
    const att = c.get("attempt");
    const now = Date.now();
    await finalizeAttempt(db, att, now >= att.deadlineAt ? "timeout" : "manual", now);
    return c.json({ status: "submitted" });
  })

  .get("/result", async (c) => {
    const db = getDb(c.env);
    let att = c.get("attempt");
    const now = Date.now();
    if (att.submittedAt === null && now > att.deadlineAt + GRACE_MS) att = await finalizeAttempt(db, att, "timeout", now);
    if (att.submittedAt === null) return fail(c, 409, "not_submitted", "제출한 뒤에 결과를 볼 수 있습니다.");
    const [exam, layout, subj] = await Promise.all([
      db.select().from(exams).where(eq(exams.id, att.examId)).get(),
      getLayout(db, att.examId),
      db.all<{ id: number; name: string }>(sql`select id, name from subjects`),
    ]);
    if (!exam || !layout) return fail(c, 404, "not_found", "시험을 찾을 수 없습니다.");
    const subjectName = new Map(subj.map((s) => [s.id, s.name]));
    const scores = (att.subjectScores ?? []) as { subjectId: number; earned: number; possible: number; correct: number; total: number }[];

    let review = null;
    if (exam.revealExplanations) {
      const paper = buildPaper(att.seed, exam, layout);
      const inExam = sql`(select question_id from exam_questions where exam_id = ${att.examId})`;
      const [qs, cs, ans] = await Promise.all([
        db.all<{ id: number; code: number; stem: string; img: string | null; subjectId: number; explanation: string }>(
          sql`select id, code, stem, stem_image_key as img, subject_id as subjectId, explanation from questions where id in ${inExam}`,
        ),
        db.all<{ q: number; ord: number; body: string; img: string | null; correct: number }>(
          sql`select question_id as q, ord, body, image_key as img, is_correct as correct from choices where question_id in ${inExam}`,
        ),
        db.all<{ eqId: number; ord: number }>(
          sql`select a.exam_question_id as eqId, c.ord as ord from answers a join choices c on c.id = a.choice_id where a.attempt_id = ${att.id}`,
        ),
      ]);
      const ansByEq = new Map(ans.map((a) => [a.eqId, a.ord]));
      review = paper.map((item, n) => {
        const q = qs.find((x) => x.id === item.questionId)!;
        const choices = item.order.map((ord) => cs.find((x) => x.q === item.questionId && x.ord === ord)!);
        const picked = ansByEq.get(item.eqId);
        return {
          no: n + 1,
          code: q.code,
          subjectName: subjectName.get(q.subjectId) ?? "",
          stem: q.stem,
          stemImage: mediaUrl(q.img),
          choices: choices.map((ch, m) => ({ no: m + 1, text: ch.body, image: mediaUrl(ch.img) })),
          correctNo: choices.findIndex((ch) => ch.correct) + 1,
          pickedNo: picked === undefined ? null : item.order.indexOf(picked) + 1,
          explanation: renumberMarks(q.explanation, item.order), // ①~⑤ follow this screen's choice order
        };
      });
    }
    return c.json({
      exam: { title: exam.title, passSubjectPct: exam.passSubjectPct, passAvgPct: exam.passAvgPct },
      examinee: { no: att.examineeNo, name: att.examineeName },
      paperCode: paperCode(att.seed),
      submitReason: att.submitReason,
      durationSec: Math.max(0, Math.round((att.submittedAt - att.startedAt) / 1000)),
      totalCorrect: att.totalCorrect,
      total: layout.length,
      avgPct: (att.avgPct ?? 0) / 100,
      passed: !!att.passed,
      subjects: scores.map((s) => {
        const pct = s.possible ? (100 * s.earned) / s.possible : 0;
        return { name: subjectName.get(s.subjectId) ?? "", correct: s.correct, total: s.total, pct, failed: pct < exam.passSubjectPct };
      }),
      review,
    });
  })

  /** Pictures only for questions of this attempt's exam (keys are random; ANALYSIS #15). */
  .get("/media/:name{[0-9a-f-]+\\.(png|jpg)}", async (c) => {
    const db = getDb(c.env);
    const key = `media/${c.req.param("name")}`;
    const used = await db.get<{ ok: number }>(sql`select 1 as ok from exam_questions eq join questions q on q.id = eq.question_id
      where eq.exam_id = ${c.get("attempt").examId}
        and (q.stem_image_key = ${key} or exists(select 1 from choices ch where ch.question_id = q.id and ch.image_key = ${key})) limit 1`);
    const obj = used && (await c.env.FILES.get(key));
    if (!obj) return fail(c, 404, "not_found", "그림을 찾을 수 없습니다.");
    return new Response(obj.body, {
      headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  });
