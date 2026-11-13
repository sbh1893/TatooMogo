import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type Subject } from "@/lib/api";
import {
  blocking,
  ERROR_TEXT,
  EXPECTED_CHOICES,
  itemErrors,
  itemKey,
  parseDocxItems,
  readDocxXml,
  toImportItem,
  type DocxItem,
} from "../../../shared/docx-items";
import { DIFFICULTIES, KNOWLEDGE_LEVELS } from "../../../shared/question";
import { selectClass } from "../question-bank/common";
import { ImportTabs } from "./ImportTabs";

const MARKS = "①②③④⑤⑥⑦⑧";
const CHUNK = 50; // = IMPORT_CHUNK on the server
const PAGE = 20;
const NEW = "new";
type Row = DocxItem & { reviewed: boolean };
type Filter = "all" | "errors" | "todo";

/**
 * Word import. The file is read here, in the browser, and never uploaded; only the reviewed
 * questions go to the server. Nothing is kept in localStorage either (the documents are confidential).
 */
export function DocxImportPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [file, setFile] = useState<{ name: string; criteria: number } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({}); // 분야 → subject id | NEW
  const [existing, setExisting] = useState<Map<string, number>>(new Map()); // key → common number
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "version">("skip");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: Subject[] }>("/api/admin/subjects").then((r) => setSubjects(r.items), (e) => setError(errorMessage(e)));
  }, []);

  const open = async (f: File) => {
    setError(null);
    setNotice(null);
    setBusy("파일을 읽는 중…");
    try {
      const { criteria, items } = parseDocxItems(readDocxXml(new Uint8Array(await f.arrayBuffer())));
      if (items.length === 0) throw new Error("문항을 찾지 못했습니다. '문항개발기준 NNN (분야-NN)' 제목과 '예비문항 N' 줄이 있는지 확인해 주세요.");
      const [saved, ex] = await Promise.all([
        api<{ map: { field: string; subjectId: number }[] }>("/api/admin/docx/fields"),
        api<{ existing: { criterionNo: string; itemNo: number; code: number }[] }>("/api/admin/docx/existing", {
          method: "POST",
          body: { keys: items.map((i) => ({ criterionNo: i.criterionNo, itemNo: i.itemNo })) },
        }),
      ]);
      const savedMap = new Map(saved.map.map((m) => [m.field, String(m.subjectId)]));
      const byName = new Map(subjects.map((s) => [s.name, String(s.id)]));
      const fields = [...new Set(items.map((i) => i.field))];
      setMapping(Object.fromEntries(fields.map((fl) => [fl, savedMap.get(fl) ?? byName.get(fl) ?? ""])));
      setExisting(new Map(ex.existing.map((e) => [itemKey(e), e.code])));
      setRows(items.map((i) => ({ ...i, reviewed: false })));
      setFile({ name: f.name, criteria });
      setPage(0);
      setFilter("all");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const errorsOf = useMemo(() => new Map(rows.map((r) => [r.pos, itemErrors(r)])), [rows]);
  const fieldCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.field, (m.get(r.field) ?? 0) + 1);
    return [...m];
  }, [rows]);
  const shown = rows.filter((r) =>
    filter === "errors" ? (errorsOf.get(r.pos) ?? []).length > 0 : filter === "todo" ? !r.reviewed : true,
  );
  const lastPage = Math.max(0, Math.ceil(shown.length / PAGE) - 1);
  const pageRows = shown.slice(Math.min(page, lastPage) * PAGE, (Math.min(page, lastPage) + 1) * PAGE);
  const ready = rows.filter((r) => r.reviewed && blocking(errorsOf.get(r.pos) ?? []).length === 0);
  const withErrors = rows.filter((r) => blocking(errorsOf.get(r.pos) ?? []).length > 0).length;
  const dupCount = rows.filter((r) => existing.has(itemKey(r))).length;

  const update = (pos: number, patch: Partial<Row>) => setRows((list) => list.map((r) => (r.pos === pos ? { ...r, ...patch } : r)));

  const register = async () => {
    if (ready.length === 0) return setError("'검수 완료'로 표시한 문항이 없습니다.");
    const fields = [...new Set(ready.map((r) => r.field))];
    const unmapped = fields.filter((f) => !mapping[f]);
    if (unmapped.length) return setError(`과목을 고르지 않은 분야가 있습니다: ${unmapped.join(", ")}`);
    setError(null);
    setNotice(null);
    try {
      // 1. New subjects for fields marked "새 과목".
      setBusy("과목을 만드는 중…");
      const resolved: Record<string, number> = {};
      let list = subjects;
      for (const f of Object.keys(mapping)) {
        if (mapping[f] !== NEW) {
          if (mapping[f]) resolved[f] = Number(mapping[f]);
          continue;
        }
        const found = list.find((s) => s.name === f);
        if (found) resolved[f] = found.id;
        else {
          const made = await api<Subject>("/api/admin/subjects", { method: "POST", body: { name: f, sortOrder: Math.max(0, ...list.map((s) => s.sortOrder)) + 1 } });
          list = [...list, made];
          resolved[f] = made.id;
        }
      }
      setSubjects(list);
      setMapping((m) => Object.fromEntries(Object.entries(m).map(([f, v]) => [f, resolved[f] ? String(resolved[f]) : v])));
      // 2. Remember the map for the next file.
      await api("/api/admin/docx/fields", { method: "PUT", body: { map: Object.entries(resolved).map(([field, subjectId]) => ({ field, subjectId })) } });
      // 3. Register in chunks; each chunk is all-or-nothing on the server.
      const total = { created: 0, versioned: 0, skipped: 0 };
      for (let i = 0; i < ready.length; i += CHUNK) {
        setBusy(`등록하는 중… ${i}/${ready.length}`);
        const chunk = ready.slice(i, i + CHUNK);
        const r = await api<typeof total>("/api/admin/docx/import", {
          method: "POST",
          body: { onDuplicate, items: chunk.map((it) => toImportItem(it, resolved[it.field])) },
        });
        total.created += r.created;
        total.versioned += r.versioned;
        total.skipped += r.skipped;
        const done = new Set(chunk.map((c) => c.pos));
        setRows((l) => l.filter((x) => !done.has(x.pos)));
      }
      setNotice(`등록 ${total.created}문항 · 새 버전 ${total.versioned}문항 · 건너뜀 ${total.skipped}문항`);
    } catch (e) {
      setError(`${errorMessage(e)}\n(이 묶음 앞까지는 등록되었습니다. 목록에 남은 문항만 다시 등록하면 됩니다.)`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-bold">문제 가져오기</h1>
      <ImportTabs />

      <div className="space-y-2 rounded-lg border bg-white p-4 text-sm">
        <label className="grid gap-1">
          <span className="font-medium">문항개발 Word 파일 (.docx)</span>
          <input
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            aria-label="Word 파일"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) open(f);
              e.target.value = "";
            }}
          />
        </label>
        <p className="text-xs text-slate-500">파일은 이 브라우저 안에서만 읽고 서버에 올리지 않습니다. 검수한 문항만 문제은행에 저장됩니다.</p>
      </div>

      {busy && <p className="rounded border bg-slate-50 p-3 text-sm">{busy}</p>}
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm whitespace-pre-line text-red-800">{error}</p>}
      {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

      {file && rows.length > 0 && (
        <>
          <p className="text-sm text-slate-700">
            {file.name} · 기준 {file.criteria}개 · 문항 {rows.length}개 · 형식 오류 {withErrors}개 · 검수 완료 {ready.length}개
          </p>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border bg-white p-3">
              <h2 className="mb-2 font-bold">분야 → 과목</h2>
              <table className="w-full text-sm">
                <tbody>
                  {fieldCounts.map(([f, n]) => (
                    <tr key={f} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">
                        {f || "(분야 없음)"} <span className="text-xs text-slate-500">{n}문항</span>
                      </td>
                      <td className="py-1.5">
                        <select
                          aria-label={`${f} 과목`}
                          className={`${selectClass} h-8 w-full ${mapping[f] ? "" : "border-amber-500"}`}
                          value={mapping[f] ?? ""}
                          onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })}
                        >
                          <option value="">과목 선택</option>
                          {subjects.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                          {f && !subjects.some((s) => s.name === f) && <option value={NEW}>새 과목 만들기: {f}</option>}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-xs text-slate-500">고른 매핑은 저장되어 다음 파일에 자동으로 채워집니다.</p>
            </div>

            <div className="space-y-2 rounded-lg border bg-white p-3 text-sm">
              <h2 className="font-bold">이미 등록된 문항 {dupCount}개</h2>
              <p className="text-xs text-slate-500">기준 번호 + 예비문항 번호가 같은 문항이 문제은행에 있을 때</p>
              <label className="flex items-center gap-2">
                <input type="radio" name="dup" checked={onDuplicate === "skip"} onChange={() => setOnDuplicate("skip")} /> 건너뛰기
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="dup" checked={onDuplicate === "version"} onChange={() => setOnDuplicate("version")} /> 새 버전으로 등록 (공통 번호 유지, 이전 버전은 과거 성적용으로 남음)
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="보기 필터" className={`${selectClass} h-8`} value={filter} onChange={(e) => {
              setFilter(e.target.value as Filter);
              setPage(0);
            }}>
              <option value="all">전체 {rows.length}</option>
              <option value="errors">오류·경고 있는 문항</option>
              <option value="todo">검수 전</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRows((l) => l.map((r) => (blocking(errorsOf.get(r.pos) ?? []).length ? r : { ...r, reviewed: true })))}
            >
              오류 없는 문항 모두 검수 완료
            </Button>
            <Button size="sm" className="ml-auto" onClick={register} disabled={!!busy || ready.length === 0}>
              검수 완료 {ready.length}문항 등록
            </Button>
          </div>

          <div className="space-y-2">
            {pageRows.map((r) => (
              <ItemCard key={r.pos} r={r} errors={errorsOf.get(r.pos) ?? []} code={existing.get(itemKey(r))} onChange={(p) => update(r.pos, p)} />
            ))}
            {shown.length === 0 && <p className="rounded border bg-white p-6 text-center text-sm text-slate-500">해당하는 문항이 없습니다.</p>}
          </div>
          {lastPage > 0 && (
            <div className="flex items-center justify-center gap-2 text-sm">
              <Button size="sm" variant="outline" disabled={page <= 0} onClick={() => setPage(page - 1)}>
                이전
              </Button>
              <span>
                {Math.min(page, lastPage) + 1} / {lastPage + 1}
              </span>
              <Button size="sm" variant="outline" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
                다음
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ItemCard({ r, errors, code, onChange }: { r: Row; errors: ReturnType<typeof itemErrors>; code?: number; onChange: (p: Partial<Row>) => void }) {
  const blockers = blocking(errors);
  const setChoice = (k: number, text: string) => onChange({ choices: r.choices.map((c, j) => (j === k ? text : c)) });
  const listSelect = (value: string, list: readonly string[], label: string, key: "knowledgeLevel" | "difficulty") => (
    <select aria-label={label} className={`${selectClass} h-8 ${list.includes(value) ? "" : "border-red-500"}`} value={value} onChange={(e) => onChange({ [key]: e.target.value })}>
      {!list.includes(value) && <option value={value}>{value ? `${value} (목록 밖)` : `${label} 없음`}</option>}
      {list.map((v) => (
        <option key={v}>{v}</option>
      ))}
    </select>
  );

  return (
    <article className={`space-y-2 rounded-lg border bg-white p-3 text-sm ${r.reviewed ? "border-emerald-500" : ""} ${blockers.length ? "border-red-400" : ""}`} data-testid="docx-item">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">
          #{r.pos} · 기준 {r.criterionNo}-{r.itemNo}
        </span>
        <span className="text-xs text-slate-600">{r.field}</span>
        {listSelect(r.knowledgeLevel, KNOWLEDGE_LEVELS, "지식수준", "knowledgeLevel")}
        {listSelect(r.difficulty, DIFFICULTIES, "예상 난이도", "difficulty")}
        {code !== undefined && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs">이미 등록됨 #{code}</span>}
        <label className={`ml-auto flex items-center gap-1 rounded px-2 py-1 font-medium ${r.reviewed ? "bg-emerald-100 text-emerald-900" : "bg-slate-100"}`}>
          <input type="checkbox" checked={r.reviewed} disabled={blockers.length > 0} onChange={(e) => onChange({ reviewed: e.target.checked })} /> 검수 완료
        </label>
      </div>
      {errors.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {errors.map((e) => (
            <li key={e} className={`rounded px-2 py-0.5 text-xs ${blockers.includes(e) ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>
              {ERROR_TEXT[e]}
              {blockers.includes(e) ? "" : " (확인 후 등록 가능)"}
            </li>
          ))}
        </ul>
      )}
      <Textarea aria-label="문제" rows={2} value={r.stem} onChange={(e) => onChange({ stem: e.target.value })} />
      <ol className="space-y-1">
        {r.choices.map((c, k) => (
          <li key={k} className="flex items-center gap-1">
            <label className="flex items-center gap-1">
              <input type="radio" name={`ans-${r.pos}`} checked={r.answer === k + 1} onChange={() => onChange({ answer: k + 1 })} aria-label={`${k + 1}번 정답`} />
              <span>{MARKS[k]}</span>
            </label>
            <input aria-label={`보기 ${k + 1}`} className="h-8 flex-1 rounded border px-2" value={c} onChange={(e) => setChoice(k, e.target.value)} />
            <button
              type="button"
              className="px-1 text-slate-400 hover:text-red-600"
              aria-label={`보기 ${k + 1} 삭제`}
              onClick={() =>
                onChange({
                  choices: r.choices.filter((_, j) => j !== k),
                  answer: r.answer === k + 1 ? null : r.answer && r.answer > k + 1 ? r.answer - 1 : r.answer,
                })
              }
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      {r.choices.length < EXPECTED_CHOICES && (
        <Button size="sm" variant="ghost" onClick={() => onChange({ choices: [...r.choices, ""] })}>
          보기 추가
        </Button>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs text-slate-500">정답해설</span>
          <Textarea rows={2} value={r.correctExplanation} onChange={(e) => onChange({ correctExplanation: e.target.value })} />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-slate-500">오답노트 (해설에 빈 줄 뒤로 붙습니다)</span>
          <Textarea rows={2} value={r.wrongNote} onChange={(e) => onChange({ wrongNote: e.target.value })} />
        </label>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-slate-500">관리자 전용: 출제의도 · 이의제기 예방검토 · 근거번호</summary>
        <div className="mt-1 grid gap-2 md:grid-cols-3">
          <Textarea aria-label="출제의도" rows={2} value={r.intent} onChange={(e) => onChange({ intent: e.target.value })} />
          <Textarea aria-label="이의제기 예방검토" rows={2} value={r.objectionReview} onChange={(e) => onChange({ objectionReview: e.target.value })} />
          <Textarea aria-label="근거번호" rows={2} value={r.basis} onChange={(e) => onChange({ basis: e.target.value })} />
        </div>
      </details>
    </article>
  );
}
