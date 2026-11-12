import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { call, resetDb } from "./helpers";

beforeEach(resetDb);

const input = (stem = "멸균 조건은?", correct = 1) => ({
  subjectId: 1,
  stem,
  explanation: "해설",
  fixedChoices: false,
  choices: ["가", "나", "다", "라", "마"].map((body, i) => ({ body, isCorrect: i === correct })),
});

type Saved = { id: number; code: number; version: number; newVersion: boolean };

async function create(stem?: string) {
  const res = await call("/api/admin/questions", { method: "POST", json: input(stem) });
  expect(res.status).toBe(201);
  return (await res.json()) as Saved;
}

const update = (id: number, body: unknown) => call(`/api/admin/questions/${id}`, { method: "PUT", json: body });

/** Simulates "someone already sat an exam containing this question". */
async function addAttemptFor(questionId: number) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO exams (id, title, code, time_limit_min, created_at) VALUES (1, '1회', 'ABC234', 60, 0)"),
    env.DB.prepare("INSERT INTO exam_questions (id, exam_id, question_id, position) VALUES (1, 1, ?, 1)").bind(questionId),
    env.DB.prepare(
      "INSERT INTO attempts (exam_id, examinee_no, examinee_name, seed, session_hash, started_at, deadline_at) VALUES (1, '001', '홍길동', 'ab', 'h', 0, 1)",
    ),
  ]);
}

const auditActions = async () =>
  (await env.DB.prepare("SELECT action FROM audit_logs WHERE action <> 'login' ORDER BY id").all<{ action: string }>()).results.map((r) => r.action);

describe("question bank API", () => {
  it("creates questions with sequential common numbers and records an audit log", async () => {
    const a = await create("첫 문항");
    const b = await create("둘째 문항");
    expect([a.code, b.code]).toEqual([1, 2]);
    expect(a.version).toBe(1);
    const detail = await (await call(`/api/admin/questions/${a.id}`)).json<{ choices: { ord: number; isCorrect: boolean }[] }>();
    expect(detail.choices.map((c) => c.ord)).toEqual([0, 1, 2, 3, 4]);
    expect(detail.choices.findIndex((c) => c.isCorrect)).toBe(1);
    const log = await env.DB.prepare("SELECT target_id FROM audit_logs WHERE action = 'question.create' ORDER BY id").all<{ target_id: string }>();
    expect(log.results.map((r) => r.target_id)).toEqual([String(a.id), String(b.id)]);
  });

  it("rejects invalid input and unknown subjects with 400", async () => {
    expect((await call("/api/admin/questions", { method: "POST", json: { ...input(), choices: [] } })).status).toBe(400);
    expect((await call("/api/admin/questions", { method: "POST", json: { ...input(), subjectId: 99 } })).status).toBe(400);
    expect(await auditActions()).toEqual([]);
  });

  it("edits in place while no one has sat an exam with the question", async () => {
    const q = await create();
    const res = await update(q.id, input("고친 지문", 3));
    const body = (await res.json()) as Saved;
    expect(body).toMatchObject({ id: q.id, version: 1, newVersion: false });
    const row = await env.DB.prepare("SELECT stem FROM questions WHERE id = ?").bind(q.id).first<{ stem: string }>();
    expect(row?.stem).toBe("고친 지문");
    const correct = await env.DB.prepare("SELECT ord FROM choices WHERE question_id = ? AND is_correct = 1").bind(q.id).first<{ ord: number }>();
    expect(correct?.ord).toBe(3);
    expect(await auditActions()).toEqual(["question.create", "question.update"]);
  });

  it("creates a new version instead of editing once the question has an attempt (rule 8)", async () => {
    const q = await create("원래 지문");
    await addAttemptFor(q.id);
    const before = await env.DB.prepare("SELECT id, ord, body, is_correct FROM choices WHERE question_id = ? ORDER BY ord").bind(q.id).all();

    const res = await update(q.id, input("고친 지문", 4));
    const v2 = (await res.json()) as Saved;
    expect(v2).toMatchObject({ code: q.code, version: 2, newVersion: true });
    expect(v2.id).not.toBe(q.id);

    // The old version and everything pointing at it is untouched.
    const old = await env.DB.prepare("SELECT stem, is_latest FROM questions WHERE id = ?").bind(q.id).first<{ stem: string; is_latest: number }>();
    expect(old).toEqual({ stem: "원래 지문", is_latest: 0 });
    const after = await env.DB.prepare("SELECT id, ord, body, is_correct FROM choices WHERE question_id = ? ORDER BY ord").bind(q.id).all();
    expect(after.results).toEqual(before.results);
    const eq = await env.DB.prepare("SELECT question_id FROM exam_questions WHERE id = 1").first<{ question_id: number }>();
    expect(eq?.question_id).toBe(q.id);

    // The new version carries the new content.
    const latest = await env.DB.prepare("SELECT id, stem FROM questions WHERE code = ? AND is_latest = 1").bind(q.code).first();
    expect(latest).toEqual({ id: v2.id, stem: "고친 지문" });
    const newCorrect = await env.DB.prepare("SELECT ord FROM choices WHERE question_id = ? AND is_correct = 1").bind(v2.id).first<{ ord: number }>();
    expect(newCorrect?.ord).toBe(4);

    // Old versions are read-only; the list shows only the latest.
    expect((await update(q.id, input())).status).toBe(409);
    const list = await (await call("/api/admin/questions")).json<{ items: { id: number; used: boolean }[]; total: number }>();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: v2.id, used: false });
    expect(await auditActions()).toEqual(["question.create", "question.version"]);
  });

  it("disables and re-enables a question", async () => {
    const q = await create();
    expect((await call(`/api/admin/questions/${q.id}/disable`, { method: "POST" })).status).toBe(200);
    const disabled = await (await call("/api/admin/questions?status=disabled")).json<{ total: number }>();
    expect(disabled.total).toBe(1);
    expect((await call(`/api/admin/questions/${q.id}/enable`, { method: "POST" })).status).toBe(200);
    expect(await auditActions()).toEqual(["question.create", "question.disable", "question.enable"]);
  });

  it("searches by stem text and by common number", async () => {
    await create("오토클레이브 조건");
    await create("켈로이드 설명");
    const byText = await (await call(`/api/admin/questions?q=${encodeURIComponent("켈로이드")}`)).json<{ items: { code: number }[] }>();
    expect(byText.items.map((i) => i.code)).toEqual([2]);
    const byCode = await (await call("/api/admin/questions?q=1")).json<{ items: { code: number }[] }>();
    expect(byCode.items.map((i) => i.code)).toEqual([1]);
  });

  it("blocks cross-site form posts (CSRF)", async () => {
    const res = await call("/api/admin/questions/1/disable", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" },
      body: "x=1",
    });
    expect(res.status).toBe(403);
  });
});
