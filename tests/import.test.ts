import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { call, resetDb } from "./helpers";

beforeEach(resetDb);

const pdfBytes = new TextEncoder().encode("%PDF-1.7\n% test\n");
const upload = (bytes: string | Uint8Array, name = "1회.pdf", type = "application/pdf") => {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));
  form.set("roundLabel", "2027년 1회");
  return call("/api/admin/source-files", { method: "POST", body: form });
};
const auditActions = async () =>
  (await env.DB.prepare("SELECT action FROM audit_logs WHERE action <> 'login' ORDER BY id").all<{ action: string }>()).results.map((r) => r.action);

describe("PDF upload", () => {
  it("stores the PDF privately in R2, records source_files and an audit row, and streams it back to admins", async () => {
    const res = await upload(pdfBytes);
    expect(res.status).toBe(201);
    const row = await res.json<{ id: number; r2Key: string; status: string; roundLabel: string; sizeBytes: number }>();
    expect(row).toMatchObject({ status: "uploaded", roundLabel: "2027년 1회", sizeBytes: pdfBytes.length });
    expect(row.r2Key).toMatch(/^sources\/[0-9a-f-]{36}\.pdf$/);
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await auditActions()).toEqual(["source.upload"]);

    const file = await call(`/api/admin/source-files/${row.id}/file`);
    expect(file.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdfBytes);
  });

  it("rejects files that are not PDFs (by content, not just by name) and files over 20MB", async () => {
    expect((await upload("hello", "fake.pdf")).status).toBe(400);
    expect((await upload(pdfBytes, "x.png", "image/png")).status).toBe(400);
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    big.set(pdfBytes);
    expect((await upload(big)).status).toBe(400);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM source_files").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("media upload", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const send = (bytes: string | Uint8Array, type = "image/png") => {
    const form = new FormData();
    form.set("file", new File([bytes], "crop.png", { type }));
    return call("/api/admin/media", { method: "POST", body: form });
  };

  it("accepts PNG/JPEG by signature and serves it back", async () => {
    const res = await send(png);
    expect(res.status).toBe(201);
    const { key } = await res.json<{ key: string }>();
    expect(key).toMatch(/^media\/[0-9a-f-]{36}\.png$/);
    const back = await call(`/api/admin/${key}`);
    expect(back.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(png);
  });

  it("rejects other content", async () => {
    expect((await send("GIF89a", "image/gif")).status).toBe(400);
    expect((await send(new Uint8Array(2 * 1024 * 1024 + 1).fill(0x89))).status).toBe(400);
  });
});

describe("bulk register from a reviewed PDF", () => {
  async function source() {
    return (await (await upload(pdfBytes)).json<{ id: number }>()).id;
  }
  const item = (sourceNo: number, extra: Record<string, unknown> = {}) => ({
    sourceNo,
    subjectId: 1,
    stem: `${sourceNo}번 지문`,
    explanation: "",
    fixedChoices: false,
    choices: ["가", "나", "다"].map((body, i) => ({ body, isCorrect: i === 1 })),
    ...extra,
  });
  const bulk = (body: unknown) => call("/api/admin/questions/bulk", { method: "POST", json: body });

  it("creates every question as active with its source number, in one go, and marks the PDF done", async () => {
    const id = await source();
    const res = await bulk({ sourceFileId: id, items: [item(1), item(2, { groupKey: "2-3" }), item(3, { groupKey: "2-3" })] });
    expect(res.status).toBe(201);
    const { created } = await res.json<{ created: { code: number; sourceNo: number }[] }>();
    expect(created.map((c) => [c.code, c.sourceNo])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    const rows = await env.DB.prepare("SELECT status, source_file_id, group_key FROM questions ORDER BY id").all();
    expect(rows.results).toEqual([
      { status: "active", source_file_id: id, group_key: null },
      { status: "active", source_file_id: id, group_key: `s${id}:2-3` },
      { status: "active", source_file_id: id, group_key: `s${id}:2-3` },
    ]);
    const choices = await env.DB.prepare("SELECT question_id, ord, is_correct FROM choices WHERE question_id = 3 ORDER BY ord").all();
    expect(choices.results.map((c) => c.is_correct)).toEqual([0, 1, 0]);
    expect((await env.DB.prepare("SELECT status FROM source_files WHERE id = ?").bind(id).first())?.status).toBe("done");
    expect(await auditActions()).toEqual(["source.upload", "question.import"]);
  });

  it("refuses the whole batch when any question has no answer, or a group spans subjects", async () => {
    const id = await source();
    const noAnswer = item(2, { choices: [{ body: "가", isCorrect: false }, { body: "나", isCorrect: false }] });
    const res = await bulk({ sourceFileId: id, items: [item(1), noAnswer] });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { message: string } }>()).error.message).toContain("2번");
    const mixed = await bulk({ sourceFileId: id, items: [item(1, { groupKey: "1-2" }), item(2, { groupKey: "1-2", subjectId: 2 })] });
    expect(mixed.status).toBe(400);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM questions").first<{ n: number }>())?.n).toBe(0);
  });
});
