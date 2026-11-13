import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { examDeleteDeps } from "../src/server/admin/exams";
import { call, devEnv, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  examDeleteDeps.chunk = 2000;
});

type Paper = { questions: { no: number; choices: { no: number; text: string }[] }[] };
const n = async (sql: string, ...bind: unknown[]) => (await env.DB.prepare(sql).bind(...bind).first<{ n: number }>())!.n;

async function upload() {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], "a.png", { type: "image/png" }));
  return (await (await call("/api/admin/media", { method: "POST", body: form })).json<{ key: string }>()).key;
}

async function question(stem: string, opts: { stemImageKey?: string; choiceImageKey?: string } = {}) {
  const res = await call("/api/admin/questions", {
    method: "POST",
    json: {
      subjectId: 1,
      stem,
      stemImageKey: opts.stemImageKey ?? null,
      explanation: `해설 ${stem}`,
      fixedChoices: false,
      choices: [0, 1, 2, 3].map((k) => ({ body: k === 0 ? `정답 ${stem}` : `오답 ${stem} ${k}`, isCorrect: k === 0, imageKey: k === 1 ? (opts.choiceImageKey ?? null) : null })),
    },
  });
  return (await res.json<{ id: number; code: number }>());
}

async function exam(ids: number[], open = true) {
  const e = await (
    await call("/api/admin/exams", { method: "POST", json: { title: `시험 ${ids.join(",")}`, timeLimitMin: 30, passSubjectPct: 40, passAvgPct: 60 } })
  ).json<{ id: number; code: string }>();
  await call(`/api/admin/exams/${e.id}/questions`, { method: "PUT", json: { items: ids.map((questionId) => ({ questionId })) } });
  if (open) await call(`/api/admin/exams/${e.id}/open`, { method: "POST" });
  return e;
}

/** Enters, answers everything right, submits (unless told not to). Returns the session cookie. */
async function sit(code: string, no: string, submit = true) {
  const res = await call("/api/exam/enter", { method: "POST", json: { code, examineeNo: no, name: "응시자" } });
  const Cookie = res.headers.get("Set-Cookie")!.split(";")[0];
  const paper = await (await call("/api/exam/paper", { headers: { Cookie } })).json<Paper>();
  for (const q of paper.questions) {
    const choice = q.choices.find((c) => c.text.startsWith("정답"))!.no;
    await call("/api/exam/answers", { method: "PUT", headers: { Cookie }, json: { no: q.no, choice } });
  }
  if (submit) await call("/api/exam/submit", { method: "POST", headers: { Cookie } });
  return Cookie;
}
const close = (id: number) => call(`/api/admin/exams/${id}/close`, { method: "POST" });
const del = (id: number) => call(`/api/admin/questions/${id}`, { method: "DELETE" });
const delExam = (id: number, bindings = devEnv()) => call(`/api/admin/exams/${id}/delete`, { method: "POST" }, bindings);
const list = async (q = "") => (await (await call(`/api/admin/questions${q}`)).json<{ items: { id: number; status: string }[] }>()).items;

describe("question delete", () => {
  it("deletes an unused question with its versions, choices, draft-exam slots and only its own pictures", async () => {
    const own = await upload();
    const shared = await upload();
    const q = await question("혼자", { stemImageKey: own, choiceImageKey: shared });
    await question("이웃", { stemImageKey: shared });
    const draft = await exam([q.id], false);

    const res = await del(q.id);
    expect(await res.json()).toMatchObject({ result: "deleted" });
    expect(await n("select count(*) as n from questions where code = ?", q.code)).toBe(0);
    expect(await n("select count(*) as n from choices where question_id = ?", q.id)).toBe(0);
    expect(await n("select count(*) as n from exam_questions where exam_id = ?", draft.id)).toBe(0);
    expect(await env.FILES.head(own)).toBeNull(); // only this question used it
    expect(await env.FILES.head(shared)).not.toBeNull(); // the other question still shows it
    expect(await n("select count(*) as n from audit_logs where action = 'question.delete'")).toBe(1);
  });

  it("archives (never deletes) a question that attempts used; it leaves the default list and the picker, and can come back", async () => {
    const q = await question("쓴 문항");
    const e = await exam([q.id]);
    await sit(e.code, "A1");
    await close(e.id);

    expect(await (await del(q.id)).json()).toMatchObject({ result: "archived" });
    expect(await n("select count(*) as n from questions where id = ?", q.id)).toBe(1);
    expect(await n("select count(*) as n from choices where question_id = ?", q.id)).toBe(4);
    expect((await list()).map((i) => i.id)).not.toContain(q.id);
    expect((await list("?status=archived")).map((i) => i.id)).toEqual([q.id]);

    const other = await exam([], false);
    const pick = await call(`/api/admin/exams/${other.id}/questions`, { method: "PUT", json: { items: [{ questionId: q.id }] } });
    expect(pick.status).toBe(400); // only active latest questions can go into an exam
    expect((await call(`/api/admin/questions/${q.id}`, { method: "PUT", json: { subjectId: 1, stem: "x", explanation: "", fixedChoices: false, choices: [{ body: "a", isCorrect: true }, { body: "b", isCorrect: false }] } })).status).toBe(409);

    expect((await call(`/api/admin/questions/${q.id}/restore`, { method: "POST" })).status).toBe(200);
    expect((await list()).map((i) => [i.id, i.status])).toEqual([[q.id, "active"]]);
  });

  it("past results, reviews and per-question rates are the same before and after archiving", async () => {
    const q1 = await question("하나");
    const q2 = await question("둘");
    const e = await exam([q1.id, q2.id]);
    const cookie = await sit(e.code, "A1");
    await close(e.id);
    const snapshot = async () => ({
      admin: await (await call(`/api/admin/exams/${e.id}/results`)).json(),
      examinee: await (await call("/api/exam/result", { headers: { Cookie: cookie } })).json(),
    });
    const before = await snapshot();
    expect((before.examinee as { review: unknown[] }).review).toHaveLength(2);

    await del(q1.id);
    await del(q2.id);
    expect(await n("select count(*) as n from questions where status = 'archived'")).toBe(2);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses to delete or archive a question in an open exam, and says which exam", async () => {
    const unused = await question("안 쓴");
    const used = await question("쓴");
    await exam([unused.id]); // open, nobody yet
    const e2 = await exam([used.id]);
    await sit(e2.code, "A1");

    for (const q of [unused, used]) {
      const res = await del(q.id);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("시험");
    }
    expect(await n("select count(*) as n from questions where status = 'active'")).toBe(2);
  });
});

describe("opening checks the composition", () => {
  const open = (id: number) => call(`/api/admin/exams/${id}/open`, { method: "POST" });
  type Detail = { questions: { questionId: number; status: string; isLatest: boolean; latestId: number | null }[] };

  it("refuses a draft exam holding a question archived after it was picked, naming the common number", async () => {
    const q = await question("보관될");
    const keep = await question("멀쩡");
    const draft = await exam([q.id, keep.id], false); // picked while still active
    const used = await exam([q.id]);
    await sit(used.code, "A1");
    await close(used.id);
    expect(await (await del(q.id)).json()).toMatchObject({ result: "archived" });

    const res = await open(draft.id);
    expect(res.status).toBe(400);
    const msg = await res.text();
    expect(msg).toContain(`#${q.code}(보관됨)`);
    expect(msg).not.toContain(`#${keep.code}`);
    const detail = await (await call(`/api/admin/exams/${draft.id}`)).json<Detail>();
    expect(detail.questions.find((x) => x.questionId === q.id)).toMatchObject({ status: "archived", latestId: null });
    expect(await n("select count(*) as n from exams where id = ? and status = 'draft'", draft.id)).toBe(1);
  });

  it("refuses a draft exam holding a disabled question", async () => {
    const q = await question("중지될");
    const draft = await exam([q.id], false);
    await call(`/api/admin/questions/${q.id}/disable`, { method: "POST" });
    const res = await open(draft.id);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`#${q.code}(사용 중지)`);
  });

  it("refuses an older version and points at the latest, which can replace it", async () => {
    const q = await question("고칠");
    const draft = await exam([q.id], false);
    const used = await exam([q.id]);
    await sit(used.code, "A1");
    const v2 = await (
      await call(`/api/admin/questions/${q.id}`, {
        method: "PUT",
        json: { subjectId: 1, stem: "고친", explanation: "", fixedChoices: false, choices: [{ body: "정답", isCorrect: true }, { body: "오답", isCorrect: false }] },
      })
    ).json<{ id: number; newVersion: boolean }>();
    expect(v2.newVersion).toBe(true);

    const res = await open(draft.id);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`#${q.code}(새 버전 있음)`);
    const detail = await (await call(`/api/admin/exams/${draft.id}`)).json<Detail>();
    expect(detail.questions[0]).toMatchObject({ isLatest: false, latestId: v2.id });

    await call(`/api/admin/exams/${draft.id}/questions`, { method: "PUT", json: { items: [{ questionId: v2.id }] } });
    // ids and common numbers differ now (v2.id = 2+, code = 1): every field must line up.
    const after = await (await call(`/api/admin/exams/${draft.id}`)).json<{ questions: { questionId: number; code: number; version: number; points: number; status: string; isLatest: boolean }[] }>();
    expect(after.questions).toEqual([expect.objectContaining({ questionId: v2.id, code: q.code, version: 2, points: 1, status: "active", isLatest: true })]);
    expect((await open(draft.id)).status).toBe(200);
  });

  it("a closed exam that was already sat can reopen with the versions it was sat with", async () => {
    const q = await question("쓴");
    const e = await exam([q.id]);
    await sit(e.code, "A1");
    await close(e.id);
    await del(q.id); // archived
    expect((await open(e.id)).status).toBe(200);
  });

  it("an exam whose delete has started can be neither opened nor closed (409)", async () => {
    const q = await question("q");
    const e = await exam([q.id]);
    await sit(e.code, "A1");
    await close(e.id);
    examDeleteDeps.chunk = 1; // 1 answer: the first step stops before finishing
    expect(await (await delExam(e.id)).json()).toMatchObject({ done: false });
    expect(await n("select count(*) as n from exams where id = ? and status = 'deleting'", e.id)).toBe(1);

    expect((await open(e.id)).status).toBe(409);
    expect((await close(e.id)).status).toBe(409);
    expect(await n("select count(*) as n from exams where id = ? and status = 'deleting'", e.id)).toBe(1);
  });
});

describe("exam delete", () => {
  it("is for super admins only (checked on the server)", async () => {
    const e = await exam([(await question("q")).id]);
    await close(e.id);
    await call("/api/admin/admins", { method: "POST", json: { email: "staff@test.kr", role: "admin" } });
    const res = await delExam(e.id, { ...devEnv(), ADMIN_DEV_EMAIL: "staff@test.kr" });
    expect(res.status).toBe(403);
    expect(await n("select count(*) as n from exams where id = ?", e.id)).toBe(1);
  });

  it("refuses open and draft exams, and closed exams with someone still sitting", async () => {
    const q = await question("q");
    const open = await exam([q.id]);
    expect((await delExam(open.id)).status).toBe(409);
    const draft = await exam([q.id], false);
    expect((await delExam(draft.id)).status).toBe(409);

    await sit(open.code, "A1", false); // still sitting
    await close(open.id);
    const res = await delExam(open.id);
    expect(res.status).toBe(409);
    expect(await n("select count(*) as n from exams where id = ? and status = 'closed'", open.id)).toBe(1);
  });

  it("deletes in steps only that exam's composition, attempts and answers; questions and other exams stay", async () => {
    const qs = [await question("가"), await question("나"), await question("다")];
    const a = await exam(qs.map((q) => q.id));
    const b = await exam(qs.map((q) => q.id));
    for (const no of ["A1", "A2", "A3"]) await sit(a.code, no);
    await sit(b.code, "B1");
    await close(a.id);
    const otherBefore = await (await call(`/api/admin/exams/${b.id}/results`)).json();

    examDeleteDeps.chunk = 4; // 9 answers → several requests
    const steps: { done: boolean; deletedAnswers: number }[] = [];
    for (;;) {
      const res = await delExam(a.id);
      expect(res.status).toBe(200);
      steps.push(await res.json());
      if (steps.at(-1)!.done) break;
      // While in the middle: examinees can't find it, admins can't reopen it.
      expect((await call(`/api/exam/info?code=${a.code}`)).status).toBe(404);
      expect((await call(`/api/admin/exams/${a.id}/open`, { method: "POST" })).status).toBe(409);
    }
    expect(steps.length).toBeGreaterThan(2);
    expect(steps.reduce((s, x) => s + x.deletedAnswers, 0)).toBe(9);

    expect(await n("select count(*) as n from exams where id = ?", a.id)).toBe(0);
    expect(await n("select count(*) as n from exam_questions where exam_id = ?", a.id)).toBe(0);
    expect(await n("select count(*) as n from attempts where exam_id = ?", a.id)).toBe(0);
    expect(await n("select count(*) as n from questions")).toBe(3);
    expect(await (await call(`/api/admin/exams/${b.id}/results`)).json()).toEqual(otherBefore);
    expect(await n("select count(*) as n from answers")).toBe(3);

    const log = await env.DB.prepare("select admin_email as who, created_at as at, detail from audit_logs where action = 'exam.delete'").first<{
      who: string;
      at: number;
      detail: string;
    }>();
    expect(log?.who).toBe("dev@test.kr");
    expect(log?.at).toBeGreaterThan(0);
    expect(JSON.parse(log!.detail)).toMatchObject({ attempts: 3, code: a.code });

    // The deleted id is never handed out again (isolates cache layouts by exam id).
    await call(`/api/admin/exams/${b.id}/close`, { method: "POST" });
    const c = await exam([qs[0].id], false);
    expect(c.id).toBeGreaterThan(Math.max(a.id, b.id));
  });

  it("a deleted max id is not reused by the next exam", async () => {
    const q = await question("q");
    const e = await exam([q.id]);
    await sit(e.code, "A1");
    await close(e.id);
    while (!(await (await delExam(e.id)).json<{ done: boolean }>()).done);
    const next = await exam([q.id], false);
    expect(next.id).toBeGreaterThan(e.id);
  });
});
