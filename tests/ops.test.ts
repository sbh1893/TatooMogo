import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { meterD1, type Meter } from "../src/server/d1-meter";
import { call, devEnv, prodEnv, resetDb } from "./helpers";

beforeEach(resetDb);

type Paper = { questions: { no: number; choices: { no: number; text: string }[] }[] };

/** 2 questions in subject 1, 1 in subject 2; the right choice's text starts with "정답". */
async function setupExam() {
  const ids: number[] = [];
  for (let n = 1; n <= 3; n++) {
    const res = await call("/api/admin/questions", {
      method: "POST",
      json: {
        subjectId: n <= 2 ? 1 : 2,
        stem: `문항-${n}`,
        fixedChoices: false,
        choices: [0, 1, 2, 3].map((k) => ({ body: k === 0 ? `정답-${n}` : `오답-${n}-${k}`, isCorrect: k === 0 })),
      },
    });
    ids.push((await res.json<{ id: number }>()).id);
  }
  const exam = await (
    await call("/api/admin/exams", { method: "POST", json: { title: "운영 점검", timeLimitMin: 30, passSubjectPct: 40, passAvgPct: 60 } })
  ).json<{ id: number; code: string }>();
  await call(`/api/admin/exams/${exam.id}/questions`, { method: "PUT", json: { items: ids.map((questionId) => ({ questionId })) } });
  await call(`/api/admin/exams/${exam.id}/open`, { method: "POST" });
  return exam;
}

async function sit(code: string, no: string, name: string, pick: (q: Paper["questions"][number]) => number | null, submit = true) {
  const res = await call("/api/exam/enter", { method: "POST", json: { code, examineeNo: no, name } });
  const Cookie = res.headers.get("Set-Cookie")!.split(";")[0];
  const paper = await (await call("/api/exam/paper", { headers: { Cookie } })).json<Paper>();
  for (const q of paper.questions) {
    const choice = pick(q);
    if (choice !== null) await call("/api/exam/answers", { method: "PUT", headers: { Cookie }, json: { no: q.no, choice } });
  }
  if (submit) await call("/api/exam/submit", { method: "POST", headers: { Cookie } });
}
const right = (q: Paper["questions"][number]) => q.choices.find((c) => c.text.startsWith("정답"))!.no;
const wrong = (q: Paper["questions"][number]) => q.choices.find((c) => c.text.startsWith("오답"))!.no;

describe("admin: monitor and results", () => {
  it("shows who is sitting and how far along", async () => {
    const exam = await setupExam();
    await sit(exam.code, "A1", "가", right);
    await sit(exam.code, "B2", "나", (q) => (q.no === 1 ? right(q) : null), false);
    const r = await (await call(`/api/admin/exams/${exam.id}/attempts`)).json<{
      inProgress: number;
      submitted: number;
      exam: { total: number };
      items: { no: string; answered: number; submittedAt: number | null; lastActiveAt: number }[];
    }>();
    expect(r).toMatchObject({ inProgress: 1, submitted: 1, exam: { total: 3 } });
    expect(r.items.map((i) => [i.no, i.answered, i.submittedAt !== null])).toEqual([
      ["A1", 3, true],
      ["B2", 1, false],
    ]);
    expect(r.items[1].lastActiveAt).toBeGreaterThan(0);
  });

  it("scores per examinee and correct rate per common question number; export is logged", async () => {
    const exam = await setupExam();
    await sit(exam.code, "A1", "가", right); // 3/3
    await sit(exam.code, "B2", "나", (q) => (q.no === 1 ? null : wrong(q))); // 0/3
    await sit(exam.code, "C3", "다", right, false); // not submitted: not counted
    const r = await (await call(`/api/admin/exams/${exam.id}/results`)).json<{
      submitted: number;
      examinees: { no: string; totalCorrect: number; avgPct: number; passed: boolean; subjects: { pct: number }[] }[];
      questions: { code: number; correct: number; rate: number }[];
    }>();
    expect(r.submitted).toBe(2);
    expect(r.examinees.map((e) => [e.no, e.totalCorrect, e.avgPct, e.passed])).toEqual([
      ["A1", 3, 100, true],
      ["B2", 0, 0, false],
    ]);
    expect(r.examinees[0].subjects.map((s) => s.pct)).toEqual([100, 100]);
    expect(r.questions.map((q) => q.rate)).toEqual([50, 50, 50]);

    const logs = () => env.DB.prepare("select count(*) as n from audit_logs where action = 'exam.export'").first<{ n: number }>();
    expect((await logs())?.n).toBe(0);
    expect((await call(`/api/admin/exams/${exam.id}/export`, { method: "POST" })).status).toBe(200);
    expect((await logs())?.n).toBe(1);
  });
});

describe("super admin: allow list and access log", () => {
  it("adds and suspends admins; a suspended admin is refused at once", async () => {
    const add = await call("/api/admin/admins", { method: "POST", json: { email: " Staff@Test.kr ", role: "admin" } });
    expect(add.status).toBe(201);
    const staff = await add.json<{ id: number; email: string }>();
    expect(staff.email).toBe("staff@test.kr");
    expect((await call("/api/admin/admins", { method: "POST", json: { email: "staff@test.kr" } })).status).toBe(409);
    expect((await call("/api/admin/admins", { method: "POST", json: { email: "nope" } })).status).toBe(400);

    const asStaff = { ...devEnv(), ADMIN_DEV_EMAIL: "staff@test.kr" };
    expect((await call("/api/admin/me", {}, asStaff)).status).toBe(200);
    expect((await call("/api/admin/admins", {}, asStaff)).status).toBe(403); // not a super admin
    expect((await call("/api/admin/audit-logs", {}, asStaff)).status).toBe(403);

    expect((await call(`/api/admin/admins/${staff.id}`, { method: "PATCH", json: { status: "suspended" } })).status).toBe(200);
    expect((await call("/api/admin/me", {}, asStaff)).status).toBe(403);
  });

  it("refuses changes to your own account", async () => {
    expect((await call("/api/admin/admins/1", { method: "PATCH", json: { role: "admin" } })).status).toBe(400);
  });

  it("lists the access log newest first with filters", async () => {
    await call("/api/admin/admins", { method: "POST", json: { email: "a@test.kr" } });
    await call("/api/admin/admins", { method: "POST", json: { email: "b@test.kr" } });
    const all = await (await call("/api/admin/audit-logs")).json<{ items: { action: string; targetId: string }[]; total: number }>();
    expect(all.items.map((i) => i.action)).toEqual(["admin.create", "admin.create", "login"]);
    const only = await (await call("/api/admin/audit-logs?action=login")).json<{ total: number }>();
    expect(only.total).toBe(1);
  });
});

describe("rate limit", () => {
  const limiter = (allow: boolean): RateLimit => ({ limit: async () => ({ success: allow }) });

  it("answers 429 when the per-IP limit is hit (production), and only then", async () => {
    const ip = { "CF-Connecting-IP": "203.0.113.9" };
    const blocked = prodEnv({ RL_API: limiter(true), RL_ENTRY: limiter(false) });
    expect((await call("/api/exam/info?code=ABCDEF", { headers: ip }, blocked)).status).toBe(429);
    expect((await call("/api/exam/paper", { headers: ip }, blocked)).status).toBe(401); // RL_API still allows
    expect((await call("/api/exam/paper", { headers: ip }, prodEnv({ RL_API: limiter(false) }))).status).toBe(429);
    // Local development skips it so the load script can run from one machine.
    expect((await call("/api/exam/info?code=ABCDEF", { headers: ip }, { ...devEnv(), RL_ENTRY: limiter(false) })).status).toBe(404);
  });
});

describe("D1 meter (load script, development only)", () => {
  it("counts queries and rows from D1 meta, including raw()/first()", async () => {
    const m: Meter = { q: 0, read: 0, write: 0 };
    const db = meterD1(env.DB, m);
    await db.prepare("insert into subjects (name, sort_order, created_at) values (?, 9, 0)").bind("측정").run();
    expect(await db.prepare("select name from subjects where sort_order = ?").bind(9).first("name")).toBe("측정");
    expect(await db.prepare("select name, sort_order from subjects where sort_order = 9").raw()).toEqual([["측정", 9]]);
    await db.batch([db.prepare("select 1"), db.prepare("select 2")]);
    expect(m.q).toBe(5);
    expect(m.write).toBeGreaterThan(0);
    expect(m.read).toBeGreaterThan(0);
  });

  it("is reported only in development and only when asked", async () => {
    expect((await call("/api/exam/info?code=ABCDEF", { headers: { "X-D1-Meter": "1" } })).headers.get("X-D1-Meter")).toMatch(/^\d+,\d+,\d+$/);
    expect((await call("/api/exam/info?code=ABCDEF")).headers.get("X-D1-Meter")).toBeNull();
    expect((await call("/api/exam/info?code=ABCDEF", { headers: { "X-D1-Meter": "1" } }, prodEnv())).headers.get("X-D1-Meter")).toBeNull();
  });
});
