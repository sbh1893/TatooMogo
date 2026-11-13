import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { sourceFiles } from "../../db/schema";
import { fail, getDb, type AppEnv } from "../env";
import { auditInsert } from "./audit";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Checks the first bytes, not just the declared type. */
async function startsWith(file: File, sig: number[]) {
  const head = new Uint8Array(await file.slice(0, sig.length).arrayBuffer());
  return sig.every((b, i) => head[i] === b);
}
const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIG = [0xff, 0xd8, 0xff];

async function formFile(c: { req: { parseBody: () => Promise<Record<string, unknown>> } }) {
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  return { body, file: body.file instanceof File ? body.file : null };
}

/** Original exam papers: private in R2, read back only through this admin API. */
export const sourceRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await getDb(c.env).select().from(sourceFiles).orderBy(desc(sourceFiles.id)).limit(100);
    return c.json({ items: rows });
  })

  .post("/", async (c) => {
    const { body, file } = await formFile(c);
    if (!file) return fail(c, 400, "invalid", "PDF 파일을 선택해 주세요.");
    if (file.size > MAX_PDF_BYTES) return fail(c, 400, "too_large", "PDF는 20MB 이하만 올릴 수 있습니다.");
    if (file.type !== "application/pdf" || !(await startsWith(file, PDF_SIG))) {
      return fail(c, 400, "not_pdf", "PDF 파일만 올릴 수 있습니다.");
    }
    const roundLabel = typeof body.roundLabel === "string" ? body.roundLabel.trim().slice(0, 50) || null : null;
    const kind = body.kind === "scan" ? "scan" : body.kind === "text" ? "text" : null;
    const key = `sources/${crypto.randomUUID()}.pdf`;
    await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: "application/pdf" } });

    const db = getDb(c.env);
    try {
      const [[row]] = await db.batch([
        db
          .insert(sourceFiles)
          .values({ r2Key: key, filename: file.name.slice(0, 200), roundLabel, sizeBytes: file.size, kind, uploadedBy: c.get("admin").id })
          .returning(),
        auditInsert(db, c, "source.upload", { type: "source_file", id: key }, { filename: file.name, size: file.size }),
      ]);
      return c.json(row, 201);
    } catch (e) {
      await c.env.FILES.delete(key); // don't leave an orphan object behind
      throw e;
    }
  })

  .get("/:id{[0-9]+}", async (c) => {
    const row = await getDb(c.env).select().from(sourceFiles).where(eq(sourceFiles.id, Number(c.req.param("id")))).get();
    return row ? c.json(row) : fail(c, 404, "not_found", "파일을 찾을 수 없습니다.");
  })

  .get("/:id{[0-9]+}/file", async (c) => {
    const row = await getDb(c.env).select().from(sourceFiles).where(eq(sourceFiles.id, Number(c.req.param("id")))).get();
    const obj = row && (await c.env.FILES.get(row.r2Key));
    if (!obj) return fail(c, 404, "not_found", "파일을 찾을 수 없습니다.");
    return new Response(obj.body, {
      headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  })

  .post("/:id{[0-9]+}/reviewing", async (c) => {
    const id = Number(c.req.param("id"));
    await getDb(c.env).update(sourceFiles).set({ status: "reviewing" }).where(eq(sourceFiles.id, id));
    return c.json({ id, status: "reviewing" });
  });

/** Pictures cut out of papers (or uploaded) for stems and choices. */
export const mediaRoutes = new Hono<AppEnv>()
  .post("/", async (c) => {
    const { file } = await formFile(c);
    if (!file) return fail(c, 400, "invalid", "이미지 파일을 선택해 주세요.");
    if (file.size > MAX_IMAGE_BYTES) return fail(c, 400, "too_large", "이미지는 2MB 이하만 올릴 수 있습니다.");
    const ext = (await startsWith(file, PNG_SIG)) ? "png" : (await startsWith(file, JPEG_SIG)) ? "jpg" : null;
    if (!ext) return fail(c, 400, "not_image", "PNG 또는 JPEG 이미지만 올릴 수 있습니다.");
    const key = `media/${crypto.randomUUID()}.${ext}`;
    await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: ext === "png" ? "image/png" : "image/jpeg" } });
    return c.json({ key }, 201);
  })

  .get("/:name{[0-9a-f-]+\\.(png|jpg)}", async (c) => {
    const obj = await c.env.FILES.get(`media/${c.req.param("name")}`);
    if (!obj) return fail(c, 404, "not_found", "이미지를 찾을 수 없습니다.");
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
