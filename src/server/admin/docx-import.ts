/**
 * Word (.docx) import. The browser reads the file and sends only the parsed questions (the file itself
 * never reaches the server or R2). Each request registers at most IMPORT_CHUNK questions in one D1 batch
 * of a fixed number of statements (lists travel as one JSON value through json_each), so CPU time and
 * the D1 query count stay inside the free plan whatever the chunk holds.
 */
import { inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { fieldSubjects, subjects } from "../../db/schema";
import { validateQuestionInput, validateQuestionMeta, type QuestionInput, type QuestionMeta } from "../../shared/question";
import { fail, getDb, rawBatch, type AppEnv } from "../env";
import { auditInsert } from "./audit";
import { META_COLS } from "./questions";

export const IMPORT_CHUNK = 50;

const keyOf = (m: { criterionNo: string; itemNo: number }) => `${m.criterionNo}-${m.itemNo}`;
// A question with this criterion + item number, any version (j = a json_each row with c, i).
const sameKey = (q: string) => sql.raw(`${q}.dev_criterion_no = json_extract(j.value, '$.c') and ${q}.dev_item_no = json_extract(j.value, '$.i')`);
const J = (field: string) => sql.raw(`json_extract(j.value, '$.${field}')`);
const NEW_COLS = sql.raw("subject_id, stem, explanation, fixed_choices, status, created_by, created_at, updated_at");

export const docxRoutes = new Hono<AppEnv>()
  /** Saved 분야 → subject map, and every 분야 already in the bank (for the list filter). */
  .get("/fields", async (c) => {
    const db = getDb(c.env);
    const [map, fields] = await Promise.all([
      db.select({ field: fieldSubjects.field, subjectId: fieldSubjects.subjectId }).from(fieldSubjects),
      db.all<{ field: string }>(sql`select distinct dev_field as field from questions where dev_field is not null and is_latest = 1 order by 1`),
    ]);
    return c.json({ map, fields: fields.map((f) => f.field) });
  })

  .put("/fields", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { map?: unknown } | null;
    const map = (Array.isArray(raw?.map) ? raw.map : []) as { field?: unknown; subjectId?: unknown }[];
    const rows = map.map((m) => ({ field: typeof m.field === "string" ? m.field.trim() : "", subjectId: Number(m.subjectId) }));
    if (rows.length === 0 || rows.length > 200 || rows.some((r) => !r.field || r.field.length > 50 || !Number.isInteger(r.subjectId))) {
      return fail(c, 400, "invalid", "분야와 과목을 1~200개 지정해 주세요.");
    }
    const db = getDb(c.env);
    const ids = [...new Set(rows.map((r) => r.subjectId))];
    const found = await db.select({ id: subjects.id }).from(subjects).where(inArray(subjects.id, ids));
    if (found.length !== ids.length) return fail(c, 400, "invalid", "존재하지 않는 과목이 있습니다.");
    const now = Date.now();
    await rawBatch(c.env, [
      sql`insert into field_subjects (field, subject_id, updated_at)
        select json_extract(value, '$.f'), json_extract(value, '$.s'), ${now} from json_each(${JSON.stringify(rows.map((r) => ({ f: r.field, s: r.subjectId })))})
        where true on conflict(field) do update set subject_id = excluded.subject_id, updated_at = excluded.updated_at`,
    ]);
    return c.json({ ok: true });
  })

  /** Which of these criterion + item numbers are already in the bank (latest version). */
  .post("/existing", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { keys?: unknown } | null;
    const keys = (Array.isArray(raw?.keys) ? raw.keys : []) as { criterionNo?: unknown; itemNo?: unknown }[];
    if (keys.length > 2000) return fail(c, 400, "invalid", "한 번에 2,000개까지 확인할 수 있습니다.");
    const json = JSON.stringify(keys.map((k) => ({ c: String(k.criterionNo ?? ""), i: Number(k.itemNo) })));
    const rows = await getDb(c.env).all<{ criterionNo: string; itemNo: number; code: number; status: string }>(
      sql`select q.dev_criterion_no as criterionNo, q.dev_item_no as itemNo, q.code as code, q.status as status
        from json_each(${json}) j join questions q on ${sameKey("q")} and q.is_latest = 1`,
    );
    return c.json({ existing: rows });
  })

  /**
   * Body: { onDuplicate: "skip" | "version", items: [{ ...QuestionInput, meta: QuestionMeta }] }.
   * A question whose criterion + item number is already in the bank is skipped, or becomes version + 1 of
   * that common number (the old row stays for past results: rule 8). New ones get new common numbers.
   */
  .post("/import", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { onDuplicate?: unknown; items?: unknown } | null;
    const onDuplicate = raw?.onDuplicate;
    const rawItems = Array.isArray(raw?.items) ? raw.items : [];
    if ((onDuplicate !== "skip" && onDuplicate !== "version") || rawItems.length === 0 || rawItems.length > IMPORT_CHUNK) {
      return fail(c, 400, "invalid", `등록할 문항(1~${IMPORT_CHUNK}개)과 중복 처리 방법을 지정해 주세요.`);
    }
    const errors: string[] = [];
    const items: { q: QuestionInput; m: QuestionMeta }[] = [];
    for (const it of rawItems) {
      const q = validateQuestionInput(it);
      const m = validateQuestionMeta((it as { meta?: unknown })?.meta);
      const label = m.ok ? `기준 ${keyOf(m.value)}` : `${items.length + errors.length + 1}번째`;
      if (!q.ok || !m.ok) errors.push(`${label}: ${[...(q.ok ? [] : q.errors), ...(m.ok ? [] : m.errors)].join(" ")}`);
      else if (q.value.stemImageKey || q.value.choices.some((ch) => ch.imageKey)) errors.push(`${label}: Word 가져오기는 그림을 받지 않습니다.`);
      else items.push({ q: q.value, m: m.value });
    }
    if (errors.length) return fail(c, 400, "invalid", errors.join("\n"));
    const keys = items.map((i) => keyOf(i.m));
    if (new Set(keys).size !== keys.length) return fail(c, 400, "invalid", "같은 기준·문항 번호가 두 번 들어 있습니다.");

    const db = getDb(c.env);
    const subjectIds = [...new Set(items.map((i) => i.q.subjectId))];
    const found = await db.select({ id: subjects.id }).from(subjects).where(inArray(subjects.id, subjectIds));
    if (found.length !== subjectIds.length) return fail(c, 400, "invalid", "존재하지 않는 과목이 있습니다.");

    const json = JSON.stringify(
      items.map(({ q, m }) => ({
        c: m.criterionNo,
        i: m.itemNo,
        s: q.subjectId,
        stem: q.stem,
        ex: q.explanation,
        f: m.field,
        k: m.knowledgeLevel,
        d: m.difficulty,
        in: m.intent,
        ob: m.objectionReview,
        b: m.basis,
        ch: q.choices.map((ch) => ({ b: ch.body, ok: ch.isCorrect ? 1 : 0 })),
      })),
    );
    const adminId = c.get("admin").id;
    const now = Date.now();
    const values = sql`${J("s")}, ${J("stem")}, ${J("ex")}, 0, 'active', ${adminId}, ${now}, ${now},
      ${J("c")}, ${J("i")}, ${J("f")}, ${J("k")}, ${J("d")}, ${J("in")}, ${J("ob")}, ${J("b")}`;
    const nothing = sql`select 0 where 0`;

    const res = await rawBatch(c.env, [
      // 1. already in the bank, "version": version + 1 of the same common number
      onDuplicate === "version"
        ? sql`insert into questions (code, version, is_latest, ${NEW_COLS}, ${META_COLS})
            select q.code, (select max(v.version) from questions v where v.code = q.code) + 1, 1, ${values}
            from json_each(${json}) j join questions q on ${sameKey("q")} and q.is_latest = 1`
        : nothing,
      // 2. retire the version that was latest before step 1
      sql`update questions set is_latest = 0 where is_latest = 1
        and exists (select 1 from questions n where n.code = questions.code and n.id > questions.id and n.is_latest = 1)
        and code in (select q.code from json_each(${json}) j join questions q on ${sameKey("q")})`,
      // 3. not in the bank at all: new common numbers, in document order
      sql`insert into questions (code, version, is_latest, ${NEW_COLS}, ${META_COLS})
        select (select coalesce(max(code), 0) from questions) + row_number() over (order by j.key), 1, 1, ${values}
        from json_each(${json}) j where not exists (select 1 from questions q where ${sameKey("q")})`,
      // 4. choices for every row added above (the only latest rows without choices)
      sql`insert into choices (question_id, ord, body, is_correct)
        select q.id, ch.key, json_extract(ch.value, '$.b'), json_extract(ch.value, '$.ok')
        from json_each(${json}) j join questions q on ${sameKey("q")} and q.is_latest = 1, json_each(j.value, '$.ch') ch
        where not exists (select 1 from choices x where x.question_id = q.id)`,
      auditInsert(db, c, "question.import", { type: "docx", id: "" }, { count: items.length, onDuplicate }),
      sql`select q.dev_criterion_no as criterionNo, q.dev_item_no as itemNo, q.code as code, q.version as version
        from json_each(${json}) j join questions q on ${sameKey("q")} and q.is_latest = 1 order by j.key`,
    ]);
    const versioned = onDuplicate === "version" ? res[0].meta.changes : 0;
    const created = res[2].meta.changes;
    return c.json({ created, versioned, skipped: items.length - created - versioned, items: res.at(-1)!.results }, 201);
  });
