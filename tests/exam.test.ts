import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/server/env";
import { finalizeExpired } from "../src/server/exam/attempt";
import { call, devEnv, resetDb } from "./helpers";

beforeEach(resetDb);

type Paper = {
  paperCode: string;
  deadlineAt: number;
  questions: { no: number; subjectName: string; stem: string; stemImage: string | null; choices: { no: number; text: string; image: string | null }[] }[];
  answers: { no: number; choice: number }[];
};

/** 4 questions in subject 1, 2 in subject 2. The right choice's text is "정답-<n>". */
async function setupExam(opts: Record<string, unknown> = {}) {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  const form = new FormData();
  form.set("file", new File([png], "a.png", { type: "image/png" }));
  const { key } = await (await call("/api/admin/media", { method: "POST", body: form })).json<{ key: string }>();
  const ids: number[] = [];
  for (let n = 1; n <= 6; n++) {
    const res = await call("/api/admin/questions", {
      method: "POST",
      json: {
        subjectId: n <= 4 ? 1 : 2,
        stem: `문항-${n}`,
        stemImageKey: n === 1 ? key : null,
        explanation: `비밀해설-${n}`,
        fixedChoices: false,
        choices: [0, 1, 2, 3, 4].map((k) => ({ body: k === n % 5 ? `정답-${n}` : `오답-${n}-${k}`, isCorrect: k === n % 5 })),
      },
    });
    ids.push((await res.json<{ id: number }>()).id);
  }
  const exam = await (
    await call("/api/admin/exams", {
      method: "POST",
      json: { title: "1회 모의고사", timeLimitMin: 30, passSubjectPct: 40, passAvgPct: 60, notice: "조용히", ...opts },
    })
  ).json<{ id: number; code: string }>();
  expect((await call(`/api/admin/exams/${exam.id}/questions`, { method: "PUT", json: { items: ids.map((questionId) => ({ questionId })) } })).status).toBe(200);
  expect((await call(`/api/admin/exams/${exam.id}/open`, { method: "POST" })).status).toBe(200);
  return { ...exam, ids, key };
}

/** Examinee requests carry the session cookie, like a browser would. */
async function enter(code: string, examineeNo: string, name: string) {
  const res = await call("/api/exam/enter", { method: "POST", json: { code, examineeNo, name } });
  const cookie = res.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  return { res, cookie, body: (await res.clone().json()) as { status?: string; error?: { code: string } } };
}
const as = (cookie: string, path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } });
const paperOf = async (cookie: string) => (await as(cookie, "/api/exam/paper")).json<Paper>();
const save = (cookie: string, no: number, choice: number | null) => as(cookie, "/api/exam/answers", { method: "PUT", json: { no, choice } });
const rightNo = (q: Paper["questions"][number]) => q.choices.find((c) => c.text.startsWith("정답"))!.no;

describe("admin: exams", () => {
  it("creates an exam with a 6-character code without look-alike characters", async () => {
    const { code } = await setupExam();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  });

  it("locks the composition and most settings once someone has started", async () => {
    const exam = await setupExam();
    await enter(exam.code, "001", "홍길동");
    expect((await call(`/api/admin/exams/${exam.id}/questions`, { method: "PUT", json: { items: [] } })).status).toBe(409);
    expect((await call(`/api/admin/exams/${exam.id}`, { method: "PATCH", json: { timeLimitMin: 99 } })).status).toBe(409);
    expect((await call(`/api/admin/exams/${exam.id}`, { method: "PATCH", json: { notice: "바뀐 안내" } })).status).toBe(200);
    const detail = await (await call(`/api/admin/exams/${exam.id}`)).json<{ locked: boolean; attemptCount: number }>();
    expect(detail).toMatchObject({ locked: true, attemptCount: 1 });
  });
});

describe("examinee: enter, paper, answers, submit, result", () => {
  it("shows exam info without any question content", async () => {
    const exam = await setupExam();
    const info = await (await call(`/api/exam/info?code=${exam.code.toLowerCase()}`)).json<Record<string, unknown>>();
    expect(info).toMatchObject({ title: "1회 모의고사", total: 6, open: true, subjects: [{ name: "위생", count: 4 }, { name: "법규", count: 2 }] });
    expect(JSON.stringify(info)).not.toMatch(/문항-|정답|비밀해설/);
  });

  it("never sends answers, explanations, choice ids, original order or the seed while sitting", async () => {
    const exam = await setupExam();
    const { cookie } = await enter(exam.code, "001", "홍길동");
    const res = await as(cookie, "/api/exam/paper");
    const text = await res.text();
    const paper = JSON.parse(text) as Paper;
    const { seed } = (await env.DB.prepare("SELECT seed FROM attempts").first<{ seed: string }>())!;
    expect(text).not.toContain(seed);
    expect(text).not.toMatch(/isCorrect|is_correct|correct|explanation|비밀해설|"ord"|"id"|seed|order/i);
    for (const q of paper.questions) {
      expect(Object.keys(q).sort()).toEqual(["choices", "no", "stem", "stemImage", "subjectName"]);
      for (const ch of q.choices) expect(Object.keys(ch).sort()).toEqual(["image", "no", "text"]);
    }
    // Subject order is kept (위생 first), each question once.
    expect(paper.questions.map((q) => q.subjectName)).toEqual(["위생", "위생", "위생", "위생", "법규", "법규"]);
    expect(paper.questions.map((q) => q.stem).sort()).toEqual(["문항-1", "문항-2", "문항-3", "문항-4", "문항-5", "문항-6"]);
    const saved = await save(cookie, 1, 2);
    expect(Object.keys(await saved.json<object>()).sort()).toEqual(["deadlineAt", "savedAt", "serverNow"]);
  });

  it("stores screen answers as original choices: all right → 100 and pass; review shows them in screen order", async () => {
    const exam = await setupExam();
    const { cookie } = await enter(exam.code, "001", "홍길동");
    const paper = await paperOf(cookie);
    for (const q of paper.questions) expect((await save(cookie, q.no, rightNo(q))).status).toBe(200);
    // Change of mind on 1, then back: the last answer counts.
    await save(cookie, 1, (rightNo(paper.questions[0]) % 5) + 1);
    await save(cookie, 1, rightNo(paper.questions[0]));
    expect((await paperOf(cookie)).answers).toEqual(paper.questions.map((q) => ({ no: q.no, choice: rightNo(q) })));

    expect((await as(cookie, "/api/exam/result")).status).toBe(409); // not before submitting
    expect((await as(cookie, "/api/exam/submit", { method: "POST" })).status).toBe(200);
    expect((await as(cookie, "/api/exam/submit", { method: "POST" })).status).toBe(200); // idempotent
    const r = await (await as(cookie, "/api/exam/result")).json<{
      avgPct: number;
      passed: boolean;
      totalCorrect: number;
      subjects: { name: string; correct: number; total: number }[];
      review: { no: number; correctNo: number; pickedNo: number; explanation: string }[];
    }>();
    expect(r).toMatchObject({ avgPct: 100, passed: true, totalCorrect: 6 });
    expect(r.subjects).toMatchObject([
      { name: "위생", correct: 4, total: 4 },
      { name: "법규", correct: 2, total: 2 },
    ]);
    expect(r.review.map((x) => x.correctNo)).toEqual(paper.questions.map(rightNo));
    expect(r.review.every((x) => x.pickedNo === x.correctNo && x.explanation.startsWith("비밀해설"))).toBe(true);
    expect((await save(cookie, 1, 1)).status).toBe(409); // no changes after submitting
  });

  it("grades a fail on a subject below the cut (과락), and hides the review when explanations are off", async () => {
    const exam = await setupExam({ revealExplanations: false });
    const { cookie } = await enter(exam.code, "002", "김철수");
    const paper = await paperOf(cookie);
    for (const q of paper.questions) if (q.subjectName === "위생") await save(cookie, q.no, rightNo(q)); // 위생 100%, 법규 0%
    await as(cookie, "/api/exam/submit", { method: "POST" });
    const r = await (await as(cookie, "/api/exam/result")).json<{ avgPct: number; passed: boolean; review: unknown; subjects: { failed: boolean }[] }>();
    expect(r).toMatchObject({ avgPct: 50, passed: false, review: null });
    expect(r.subjects.map((s) => s.failed)).toEqual([false, true]);
  });

  it("rejects out-of-range answers", async () => {
    const exam = await setupExam();
    const { cookie } = await enter(exam.code, "001", "홍길동");
    expect((await save(cookie, 1, 6)).status).toBe(400);
    expect((await save(cookie, 7, 1)).status).toBe(400);
    expect((await save(cookie, 0, 1)).status).toBe(400);
    expect((await save(cookie, 1, null)).status).toBe(200); // clearing is fine
  });

  it("gives two examinees different papers from the same exam, each seeing only their own answers", async () => {
    const exam = await setupExam();
    const a = await enter(exam.code, "001", "홍길동");
    const b = await enter(exam.code, "002", "김철수");
    const pa = await paperOf(a.cookie);
    const pb = await paperOf(b.cookie);
    const sig = (p: Paper) => p.questions.map((q) => q.stem + q.choices.map((c) => c.text).join()).join("|");
    expect(sig(pa)).not.toBe(sig(pb));
    await save(a.cookie, 1, 1);
    expect((await paperOf(b.cookie)).answers).toEqual([]);
    expect((await paperOf(a.cookie)).answers).toEqual([{ no: 1, choice: 1 }]);
  });
});

describe("examinee: sessions and time", () => {
  it("re-entering with the same number continues the same paper; the earlier device stops (last device wins)", async () => {
    const exam = await setupExam();
    const first = await enter(exam.code, "001", "홍길동");
    const before = await paperOf(first.cookie);
    await save(first.cookie, 2, 3);

    expect((await enter(exam.code, "001", "다른사람")).res.status).toBe(403);
    const second = await enter(exam.code, " 001 ", "홍길동");
    expect(second.body.status).toBe("in_progress");
    expect((await as(first.cookie, "/api/exam/paper")).status).toBe(401);
    const after = await paperOf(second.cookie);
    expect(after.questions).toEqual(before.questions);
    expect(after.answers).toEqual([{ no: 2, choice: 3 }]);
    const row = await env.DB.prepare("SELECT count(*) AS n, max(device_switches) AS s FROM attempts").first<{ n: number; s: number }>();
    expect(row).toEqual({ n: 1, s: 1 });
  });

  it("after the deadline (+5s grace) refuses saves and closes the attempt as timed out", async () => {
    const exam = await setupExam();
    const { cookie } = await enter(exam.code, "001", "홍길동");
    await save(cookie, 1, 1);
    await env.DB.prepare("UPDATE attempts SET deadline_at = ?").bind(Date.now() - 6000).run();
    const res = await save(cookie, 2, 1);
    expect(res.status).toBe(409);
    const att = await env.DB.prepare("SELECT submitted_at, submit_reason FROM attempts").first<{ submitted_at: number; submit_reason: string }>();
    expect(att?.submit_reason).toBe("timeout");
    expect((await as(cookie, "/api/exam/paper")).status).toBe(409);
    expect((await as(cookie, "/api/exam/result")).status).toBe(200);
  });

  it("the cron job closes attempts nobody came back to", async () => {
    const exam = await setupExam();
    await enter(exam.code, "001", "홍길동");
    await env.DB.prepare("UPDATE attempts SET deadline_at = ?").bind(Date.now() - 60_000).run();
    expect(await finalizeExpired(getDb(devEnv()))).toBe(1);
    expect((await env.DB.prepare("SELECT submit_reason FROM attempts").first<{ submit_reason: string }>())?.submit_reason).toBe("timeout");
    expect(await finalizeExpired(getDb(devEnv()))).toBe(0);
  });

  it("no new entries to a closed exam, but those already in can come back", async () => {
    const exam = await setupExam();
    await enter(exam.code, "001", "홍길동");
    await call(`/api/admin/exams/${exam.id}/close`, { method: "POST" });
    expect((await enter(exam.code, "002", "김철수")).res.status).toBe(403);
    expect((await enter(exam.code, "001", "홍길동")).res.status).toBe(200);
  });

  it("requires a session, and serves a picture only to examinees of an exam that uses it", async () => {
    const exam = await setupExam();
    expect((await call("/api/exam/paper")).status).toBe(401);
    const { cookie } = await enter(exam.code, "001", "홍길동");
    const paper = await paperOf(cookie);
    const img = paper.questions.find((q) => q.stemImage)!.stemImage!;
    expect(img).toBe(`/api/exam/${exam.key}`);
    expect((await as(cookie, img)).status).toBe(200);
    expect((await call(img)).status).toBe(401);
    expect((await as(cookie, "/api/exam/media/00000000-0000-0000-0000-000000000000.png")).status).toBe(404);
  });
});
