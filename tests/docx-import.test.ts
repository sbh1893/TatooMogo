import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blocking, itemErrors, parseDocxItems, readDocxXml, toImportItem } from "../src/shared/docx-items";
import { FIXTURE, fakeDocx } from "./docx-fixture";
import { call, resetDb } from "./helpers";

beforeEach(resetDb);

const SUBJECT: Record<string, number> = { 가짜분야가: 1, 가짜분야나: 2 };
const parsed = parseDocxItems(readDocxXml(fakeDocx(FIXTURE))).items;
const good = parsed.filter((i) => blocking(itemErrors(i)).length === 0); // 3 of 4
const body = (onDuplicate: "skip" | "version", list = good) => ({ onDuplicate, items: list.map((i) => toImportItem(i, SUBJECT[i.field])) });
const importDocx = async (onDuplicate: "skip" | "version", list = good) => {
  const res = await call("/api/admin/docx/import", { method: "POST", json: body(onDuplicate, list) });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json<{ created: number; versioned: number; skipped: number; items: { criterionNo: string; itemNo: number; code: number; version: number }[] }>();
};
const META_KEYS = /dev_|criterion|itemNo|knowledge|difficulty|intent|objection|basis|"field"|가짜 출제의도|가짜 예방검토|가짜-근거|암기형|해석형|문제해결형/i;

describe("docx import: registering", () => {
  it("stores questions with metadata and the explanation built from 정답해설 + 오답노트", async () => {
    const r = await importDocx("skip");
    expect(r).toMatchObject({ created: 3, versioned: 0, skipped: 0 });
    expect(r.items.map((i) => [i.criterionNo, i.itemNo, i.version])).toEqual([
      ["001", 1, 1],
      ["001", 2, 1],
      ["002", 1, 1],
    ]);
    expect(new Set(r.items.map((i) => i.code)).size).toBe(3);
    const q = await (await call(`/api/admin/questions/${(await env.DB.prepare("SELECT id FROM questions WHERE dev_criterion_no='001' AND dev_item_no=1").first<{ id: number }>())!.id}`)).json<Record<string, unknown> & { choices: { body: string; isCorrect: boolean }[] }>();
    expect(q).toMatchObject({
      subjectId: 1,
      stem: "가짜 문제 1",
      explanation: "가짜 정답해설\n\n① 가짜 오답 하나\n② 가짜 오답 둘",
      devField: "가짜분야가",
      knowledgeLevel: "암기형",
      expectedDifficulty: "하",
      devIntent: "가짜 출제의도",
      devObjectionReview: "가짜 예방검토",
      devBasis: "가짜-근거-1",
      status: "active",
    });
    expect(q.choices.map((c) => c.isCorrect)).toEqual([false, false, true, false, false]);
  });

  it("refuses bad items, image keys and a chunk over the limit", async () => {
    const bad = toImportItem(parsed[3], 2); // 4 choices is allowed by the bank, but the difficulty is not in the list
    expect((await call("/api/admin/docx/import", { method: "POST", json: { onDuplicate: "skip", items: [bad] } })).status).toBe(400);
    const img = { ...toImportItem(good[0], 1), stemImageKey: "x" };
    expect((await call("/api/admin/docx/import", { method: "POST", json: { onDuplicate: "skip", items: [img] } })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, k) => ({ ...toImportItem(good[0], 1), meta: { ...toImportItem(good[0], 1).meta, itemNo: k + 1 } }));
    expect((await call("/api/admin/docx/import", { method: "POST", json: { onDuplicate: "skip", items: many } })).status).toBe(400);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM questions").first<{ n: number }>())!.n).toBe(0);
  });

  it("uploading the same file again: skip, or a new version of the same common number", async () => {
    const first = await importDocx("skip");
    const dup = await call("/api/admin/docx/existing", { method: "POST", json: { keys: good.map((i) => ({ criterionNo: i.criterionNo, itemNo: i.itemNo })) } });
    expect((await dup.json<{ existing: unknown[] }>()).existing).toHaveLength(3);

    expect(await importDocx("skip")).toMatchObject({ created: 0, versioned: 0, skipped: 3 });
    const again = await importDocx("version");
    expect(again).toMatchObject({ created: 0, versioned: 3, skipped: 0 });
    expect(again.items.map((i) => i.code)).toEqual(first.items.map((i) => i.code));
    expect(again.items.every((i) => i.version === 2)).toBe(true);
    const rows = await env.DB.prepare("SELECT version, is_latest AS l, dev_field AS f FROM questions WHERE code = ? ORDER BY version").bind(first.items[0].code).all();
    expect(rows.results).toEqual([
      { version: 1, l: 0, f: "가짜분야가" },
      { version: 2, l: 1, f: "가짜분야가" },
    ]);
    const choices = await env.DB.prepare("SELECT count(*) AS n FROM choices").first<{ n: number }>();
    expect(choices!.n).toBe(30); // 3 questions × 5 choices × 2 versions
    // A new question in the same upload still gets a fresh number.
    const mixed = await importDocx("version", parsed.slice(0, 1).concat([{ ...parsed[0], itemNo: 9 }]));
    expect(mixed).toMatchObject({ created: 1, versioned: 1 });
  });

  it("an edit of a used imported question keeps its metadata in the new version (rule 8)", async () => {
    const { items } = await importDocx("skip");
    const id = (await env.DB.prepare("SELECT id FROM questions WHERE code = ?").bind(items[0].code).first<{ id: number }>())!.id;
    const exam = await (await call("/api/admin/exams", { method: "POST", json: { title: "가짜", timeLimitMin: 10, passSubjectPct: 40, passAvgPct: 60 } })).json<{ id: number; code: string }>();
    await call(`/api/admin/exams/${exam.id}/questions`, { method: "PUT", json: { items: [{ questionId: id }] } });
    await call(`/api/admin/exams/${exam.id}/open`, { method: "POST" });
    await call("/api/exam/enter", { method: "POST", json: { code: exam.code, examineeNo: "1", name: "가" } });
    const cur = await (await call(`/api/admin/questions/${id}`)).json<{ choices: { body: string; isCorrect: boolean }[] }>();
    const put = await call(`/api/admin/questions/${id}`, {
      method: "PUT",
      json: { subjectId: 1, stem: "가짜 문제 1 수정", explanation: "x", fixedChoices: false, choices: cur.choices },
    });
    expect(await put.json()).toMatchObject({ newVersion: true, version: 2 });
    const v2 = await env.DB.prepare("SELECT dev_criterion_no AS c, knowledge_level AS k, dev_intent AS i FROM questions WHERE code = ? AND version = 2").bind(items[0].code).first();
    expect(v2).toEqual({ c: "001", k: "암기형", i: "가짜 출제의도" });
  });

  it("remembers the 분야 → subject map, and filters the bank by 분야, 지식수준 and 예상 난이도", async () => {
    expect((await call("/api/admin/docx/fields", { method: "PUT", json: { map: [{ field: "가짜분야가", subjectId: 1 }] } })).status).toBe(200);
    expect((await call("/api/admin/docx/fields", { method: "PUT", json: { map: [{ field: "가짜분야가", subjectId: 2 }, { field: "가짜분야나", subjectId: 2 }] } })).status).toBe(200);
    expect((await call("/api/admin/docx/fields", { method: "PUT", json: { map: [{ field: "x", subjectId: 99 }] } })).status).toBe(400);
    await importDocx("skip");
    const f = await (await call("/api/admin/docx/fields")).json<{ map: unknown[]; fields: string[] }>();
    expect(f.map).toEqual([
      { field: "가짜분야가", subjectId: 2 },
      { field: "가짜분야나", subjectId: 2 },
    ]);
    expect(f.fields).toEqual(["가짜분야가", "가짜분야나"]);
    const list = async (qs: string) => (await (await call(`/api/admin/questions?${qs}`)).json<{ items: { stemPreview: string }[] }>()).items.map((i) => i.stemPreview).sort();
    expect(await list(`field=${encodeURIComponent("가짜분야가")}`)).toEqual(["가짜 문제 1", "가짜 문제 2"]);
    expect(await list(`knowledge=${encodeURIComponent("문제해결형")}`)).toEqual(["가짜 문제 3"]);
    expect(await list(`difficulty=${encodeURIComponent("중상")}`)).toEqual(["가짜 문제 2"]);
  });
});

describe("docx import: sitting the exam", () => {
  type Paper = { questions: { no: number; stem: string; choices: { no: number; text: string }[] }[] };
  const right: Record<string, string> = Object.fromEntries(good.map((i) => [i.stem, i.choices[i.answer! - 1]]));

  it("grades correctly with shuffled choices, and never sends the metadata (paper or result)", async () => {
    const { items } = await importDocx("skip");
    const ids = (await env.DB.prepare("SELECT id FROM questions ORDER BY code").all<{ id: number }>()).results.map((r) => r.id);
    expect(ids).toHaveLength(items.length);
    const exam = await (await call("/api/admin/exams", { method: "POST", json: { title: "가짜 시험", timeLimitMin: 10, passSubjectPct: 40, passAvgPct: 60 } })).json<{ id: number; code: string }>();
    await call(`/api/admin/exams/${exam.id}/questions`, { method: "PUT", json: { items: ids.map((questionId) => ({ questionId })) } });
    expect((await call(`/api/admin/exams/${exam.id}/open`, { method: "POST" })).status).toBe(200);

    let shuffled = false;
    for (const no of ["1", "2", "3", "4"]) {
      const enter = await call("/api/exam/enter", { method: "POST", json: { code: exam.code, examineeNo: no, name: "가짜" } });
      const cookie = enter.headers.get("Set-Cookie")!.split(";")[0];
      const as = (path: string, init: RequestInit & { json?: unknown } = {}) => call(path, { ...init, headers: { Cookie: cookie } });
      const paperText = await (await as("/api/exam/paper")).text();
      expect(paperText).not.toMatch(META_KEYS);
      const paper = JSON.parse(paperText) as Paper;
      shuffled ||= paper.questions.some((q) => q.choices.some((c, k) => !c.text.endsWith(`-${k + 1}`)));
      // Right on every question except the first one shown.
      for (const [k, q] of paper.questions.entries()) {
        const pick = k === 0 ? q.choices.find((c) => c.text !== right[q.stem])! : q.choices.find((c) => c.text === right[q.stem])!;
        expect((await as("/api/exam/answers", { method: "PUT", json: { no: q.no, choice: pick.no } })).status).toBe(200);
      }
      await as("/api/exam/submit", { method: "POST" });
      const resultText = await (await as("/api/exam/result")).text();
      expect(resultText).not.toMatch(META_KEYS);
      const r = JSON.parse(resultText) as { totalCorrect: number; review: { stem: string; correctNo: number; choices: { no: number; text: string }[]; explanation: string }[] };
      expect(r.totalCorrect).toBe(2);
      for (const q of r.review) {
        expect(q.choices.find((c) => c.no === q.correctNo)!.text).toBe(right[q.stem]);
        expect(q.explanation.startsWith("가짜 정답해설\n\n")).toBe(true);
        // 오답노트 "① 가짜 오답 하나" names original choice 1: it must carry that choice's number on this screen.
        const orig = good.find((g) => g.stem === q.stem)!.choices;
        const screenOf = (k: number) => "①②③④⑤"[q.choices.findIndex((c) => c.text === orig[k])];
        expect(q.explanation).toContain(`${screenOf(0)} 가짜 오답 하나`);
        expect(q.explanation).toContain(`${screenOf(1)} 가짜 오답 둘`);
      }
    }
    expect(shuffled).toBe(true);
  });
});
