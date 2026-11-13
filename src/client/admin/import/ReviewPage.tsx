import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type SourceFile, type Subject } from "@/lib/api";
import { blankDraft, mergeWithNext, refKey, splitAt, stemPicture, toBulkItem, toReview, type ReviewDraft } from "../../../shared/draft-ops";
import { applyAnswerKey, parseAnswerKey, splitPages, type Box, type ImageRef } from "../../../shared/split-rules";
import { selectClass } from "../question-bank/common";
import { cropToPng, CROP_SCALE, extractPages, loadPdf, renderPage, uploadMedia } from "./pdf";

const MARKS = "①②③④⑤⑥⑦⑧";
type Saved = { drafts: ReviewDraft[]; keys: Record<string, string> };
const storageKey = (id: number) => `tatq-import-${id}`;

export function ReviewPage() {
  const id = Number(useParams().id);
  const [source, setSource] = useState<SourceFile | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({}); // picture → uploaded R2 key
  const [sel, setSel] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [crop, setCrop] = useState<Box | null>(null); // dragged area waiting for a target
  const [keyText, setKeyText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cursor = useRef<{ field: "stem" | number; pos: number }>({ field: "stem", pos: 0 });
  const cropCanvases = useRef(new Map<number, Promise<HTMLCanvasElement>>());

  const pageCanvas = useCallback(
    (page: number) => {
      if (!doc) return Promise.reject(new Error("PDF를 아직 불러오지 못했습니다."));
      let c = cropCanvases.current.get(page);
      if (!c) cropCanvases.current.set(page, (c = renderPage(doc, page, CROP_SCALE)));
      return c;
    },
    [doc],
  );

  const autoSplit = async (d: PDFDocumentProxy, subs: Subject[]) => toReview(splitPages(await extractPages(d)), subs);

  useEffect(() => {
    let alive = true;
    Promise.all([api<SourceFile>(`/api/admin/source-files/${id}`), api<{ items: Subject[] }>("/api/admin/subjects"), loadPdf(id)]).then(
      async ([s, subs, d]) => {
        if (!alive) return;
        setSource(s);
        setSubjects(subs.items);
        setDoc(d);
        const saved = localStorage.getItem(storageKey(id));
        if (saved) {
          const v = JSON.parse(saved) as Saved;
          setDrafts(v.drafts);
          setKeys(v.keys);
        } else {
          const list = await autoSplit(d, subs.items);
          if (!alive) return;
          setDrafts(list);
          if (list.length === 0) setNotice("글자를 읽을 수 없는 PDF입니다(스캔본). '문항 추가' 후 원본에서 영역을 드래그해 그림으로 잘라 주세요.");
        }
        if (s.status === "uploaded") api(`/api/admin/source-files/${id}/reviewing`, { method: "POST" }).catch(() => {});
      },
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  // Review work lives in this browser until it is registered.
  useEffect(() => {
    if (doc) localStorage.setItem(storageKey(id), JSON.stringify({ drafts, keys } satisfies Saved));
  }, [id, doc, drafts, keys]);

  const cur = drafts[sel] as ReviewDraft | undefined;
  const update = (i: number, patch: Partial<ReviewDraft>) => setDrafts((list) => list.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  const select = (i: number) => {
    setSel(i);
    if (drafts[i]?.box.w) setPageNo(drafts[i].page);
  };

  const resplit = async () => {
    if (!doc || !confirm("자동 분리를 다시 하면 지금까지 고친 내용이 사라집니다. 계속할까요?")) return;
    setDrafts(await autoSplit(doc, subjects));
    setSel(0);
  };

  const applyKey = () => {
    const key = parseAnswerKey(keyText);
    if (key.size === 0) return setError("정답표를 읽지 못했습니다. 예: 1-③, 2-①");
    setDrafts((list) => applyAnswerKey(list, key) as ReviewDraft[]);
    setError(null);
    setNotice(`정답 ${key.size}개를 넣었습니다.`);
  };

  const assignCrop = (target: "stem" | "group" | number) => {
    if (!crop || !cur) return;
    const ref: ImageRef = { page: pageNo, box: crop };
    if (target === "stem") update(sel, { stemImages: [...cur.stemImages, ref] });
    else if (target === "group") update(sel, { groupImages: [...cur.groupImages, ref] });
    else update(sel, { choices: cur.choices.map((c, k) => (k === target ? { ...c, image: ref } : c)) });
    setCrop(null);
  };

  const register = async () => {
    const chosen = drafts.filter((d) => d.reviewed);
    if (chosen.length === 0) return setError("'검수 완료'로 표시한 문항이 없습니다.");
    setBusy(true);
    setError(null);
    try {
      // Upload every picture not uploaded yet (cut from the original at high resolution).
      const known = { ...keys };
      for (const d of chosen) {
        const pic = stemPicture(d);
        const refs = [...(pic && pic !== "pages" ? [pic] : []), ...d.choices.flatMap((c) => (c.image ? [c.image] : []))];
        for (const ref of refs) {
          if (known[refKey(ref)]) continue;
          known[refKey(ref)] = await uploadMedia(await cropToPng(await pageCanvas(ref.page), ref));
          setKeys({ ...known });
        }
      }
      const problems: string[] = [];
      const items = chosen.flatMap((d) => {
        const r = toBulkItem(d, (ref) => known[refKey(ref)]);
        if (!r.ok) problems.push(...r.errors.map((e) => `${d.no}번: ${e}`));
        return r.ok ? [r.item] : [];
      });
      if (problems.length) throw new Error(problems.join("\n"));
      const res = await api<{ created: { code: number }[] }>("/api/admin/questions/bulk", { method: "POST", body: { sourceFileId: id, items } });
      setDrafts((list) => list.filter((d) => !d.reviewed));
      setSel(0);
      setNotice(`${res.created.length}문항을 문제은행에 등록했습니다 (공통 번호 ${res.created[0]?.code}~${res.created.at(-1)?.code}).`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !doc) return <p className="rounded border border-red-200 bg-red-50 p-4 text-red-800">{error}</p>;
  if (!doc || !source) return <p className="p-6 text-slate-500">원본을 불러와 문항을 나누는 중…</p>;

  const reviewedCount = drafts.filter((d) => d.reviewed).length;
  const answered = drafts.filter((d) => d.answer).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/admin/import" className="text-sm text-slate-600 hover:underline">
          ← 문제지 목록
        </Link>
        <h1 className="text-lg font-bold">
          검수 · {source.roundLabel ? `${source.roundLabel} · ` : ""}
          {source.filename}
        </h1>
        <span className="text-sm text-slate-600">
          문항 {drafts.length} · 정답 {answered} · 검수 완료 {reviewedCount}
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={resplit}>
            자동 분리 다시
          </Button>
          <Button size="sm" onClick={register} disabled={busy || reviewedCount === 0}>
            {busy ? "등록 중…" : `검수 완료 ${reviewedCount}문항 등록`}
          </Button>
        </div>
      </div>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm whitespace-pre-line text-red-800">{error}</p>}
      {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Left: the original page */}
        <div className="space-y-2 lg:sticky lg:top-2 lg:max-h-[calc(100vh-1rem)] lg:self-start lg:overflow-y-auto">
          <div className="flex items-center gap-2 text-sm">
            <Button size="sm" variant="outline" disabled={pageNo <= 1} onClick={() => setPageNo(pageNo - 1)}>
              이전 쪽
            </Button>
            <span>
              {pageNo} / {doc.numPages}
            </span>
            <Button size="sm" variant="outline" disabled={pageNo >= doc.numPages} onClick={() => setPageNo(pageNo + 1)}>
              다음 쪽
            </Button>
            <span className="text-xs text-slate-500">영역을 드래그하면 그림으로 자를 수 있습니다</span>
          </div>
          <PageView doc={doc} pageNo={pageNo} draft={cur} drafts={drafts} onSelect={select} onCrop={setCrop} crop={crop} />
          {crop && (
            <div className="flex flex-wrap items-center gap-1 rounded border bg-amber-50 p-2 text-sm">
              <span className="mr-1">{cur ? `${cur.no}번의` : "문항을 먼저 고르세요"}</span>
              {cur && (
                <>
                  <Button size="sm" variant="outline" onClick={() => assignCrop("stem")}>
                    지문 그림
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => assignCrop("group")}>
                    묶음 공통 그림
                  </Button>
                  {cur.choices.map((_, k) => (
                    <Button key={k} size="sm" variant="outline" onClick={() => assignCrop(k)}>
                      보기 {MARKS[k]}
                    </Button>
                  ))}
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => setCrop(null)}>
                취소
              </Button>
            </div>
          )}
          <div className="rounded border bg-white p-2">
            <label className="text-sm font-medium" htmlFor="answer-key">
              정답표 붙여넣기
            </label>
            <Textarea
              id="answer-key"
              rows={2}
              placeholder="1-③, 2-① … (1③, 1 3 형식도 됩니다)"
              value={keyText}
              onChange={(e) => setKeyText(e.target.value)}
            />
            <Button size="sm" variant="outline" className="mt-1" onClick={applyKey}>
              정답 적용
            </Button>
          </div>
        </div>

        {/* Right: split result */}
        <div className="space-y-2">
          {drafts.map((d, i) => (
            <DraftCard
              key={d.id}
              d={d}
              selected={i === sel}
              subjects={subjects}
              doc={doc}
              pageCanvas={pageCanvas}
              onSelect={() => select(i)}
              onChange={(patch) => update(i, patch)}
              onCursor={(field, pos) => (cursor.current = { field, pos })}
              onMerge={i < drafts.length - 1 ? () => setDrafts((l) => mergeWithNext(l, i)) : undefined}
              onSplit={() => {
                const c = cursor.current;
                setDrafts((l) => splitAt(l, i, c.field, c.pos));
              }}
              onDelete={() => confirm(`${d.no}번을 지울까요?`) && setDrafts((l) => l.filter((_, k) => k !== i))}
            />
          ))}
          <Button
            variant="outline"
            onClick={() => {
              setDrafts((l) => [...l, blankDraft((l.at(-1)?.no ?? 0) + 1, pageNo)]);
              setSel(drafts.length);
            }}
          >
            문항 추가
          </Button>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ page view

function PageView(props: {
  doc: PDFDocumentProxy;
  pageNo: number;
  draft?: ReviewDraft;
  drafts: ReviewDraft[];
  crop: Box | null;
  onSelect: (i: number) => void;
  onCrop: (b: Box | null) => void;
}) {
  const { doc, pageNo, draft, drafts, crop, onSelect, onCrop } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; box: Box } | null>(null);

  useEffect(() => {
    let alive = true;
    renderPage(doc, pageNo, 2).then((c) => {
      const el = canvasRef.current;
      if (!alive || !el) return;
      el.width = c.width;
      el.height = c.height;
      el.getContext("2d")!.drawImage(c, 0, 0);
      setSize({ w: c.width / 2, h: c.height / 2 });
    });
    return () => {
      alive = false;
    };
  }, [doc, pageNo]);

  // Pointer position in PDF points.
  const at = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * (size?.w ?? 1), y: ((e.clientY - r.top) / r.height) * (size?.h ?? 1) };
  };
  const pct = (b: Box) =>
    size ? { left: `${(b.x / size.w) * 100}%`, top: `${(b.y / size.h) * 100}%`, width: `${(b.w / size.w) * 100}%`, height: `${(b.h / size.h) * 100}%` } : {};

  const pictures = draft
    ? [...draft.stemImages, ...draft.groupImages, ...draft.choices.flatMap((c) => (c.image ? [c.image] : []))].filter((r) => r.page === pageNo)
    : [];

  return (
    <div className="relative overflow-hidden rounded border bg-white shadow-sm">
      <canvas ref={canvasRef} className="block h-auto w-full" />
      <div
        className="absolute inset-0 cursor-crosshair touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = at(e);
          setDrag({ x0: p.x, y0: p.y, box: { x: p.x, y: p.y, w: 0, h: 0 } });
          onCrop(null);
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const p = at(e);
          setDrag({ ...drag, box: { x: Math.min(p.x, drag.x0), y: Math.min(p.y, drag.y0), w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) } });
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          setDrag(null);
          if (drag.box.w > 6 && drag.box.h > 6) return onCrop(drag.box);
          // A click selects the question under the pointer.
          const p = at(e);
          const i = drafts.findIndex((d) => d.page === pageNo && p.x >= d.box.x && p.x <= d.box.x + d.box.w && p.y >= d.box.y && p.y <= d.box.y + d.box.h);
          if (i >= 0) onSelect(i);
        }}
      >
        {drafts
          .filter((d) => d.page === pageNo && d.box.w)
          .map((d) => (
            <div
              key={d.id}
              className={`absolute rounded-sm border ${d === draft ? "border-2 border-blue-600 bg-blue-500/10" : d.reviewed ? "border-emerald-500/60" : "border-slate-400/40"}`}
              style={pct(d.box)}
            />
          ))}
        {pictures.map((r) => (
          <div key={refKey(r)} className="absolute border-2 border-emerald-600 bg-emerald-500/10" style={pct(r.box)} />
        ))}
        {(drag?.box ?? crop) && <div className="absolute border-2 border-dashed border-amber-500 bg-amber-400/20" style={pct((drag?.box ?? crop)!)} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ one question

function Thumb({ refImg, pageCanvas, onRemove }: { refImg: ImageRef; pageCanvas: (p: number) => Promise<HTMLCanvasElement>; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    pageCanvas(refImg.page)
      .then((c) => cropToPng(c, refImg))
      .then((b) => {
        made = URL.createObjectURL(b);
        if (alive) setUrl(made);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [refImg, pageCanvas]);
  return (
    <span className="relative inline-block rounded border bg-white p-0.5 align-top">
      {url ? <img src={url} alt="잘라 낸 그림" className="max-h-24 max-w-40" /> : <span className="block h-12 w-16 bg-slate-100" />}
      <button type="button" onClick={onRemove} className="absolute -top-2 -right-2 rounded-full bg-red-600 px-1.5 text-xs text-white" aria-label="그림 빼기">
        ×
      </button>
    </span>
  );
}

function DraftCard(props: {
  d: ReviewDraft;
  selected: boolean;
  subjects: Subject[];
  doc: PDFDocumentProxy;
  pageCanvas: (p: number) => Promise<HTMLCanvasElement>;
  onSelect: () => void;
  onChange: (patch: Partial<ReviewDraft>) => void;
  onCursor: (field: "stem" | number, pos: number) => void;
  onMerge?: () => void;
  onSplit: () => void;
  onDelete: () => void;
}) {
  const { d, selected, subjects, pageCanvas, onSelect, onChange, onCursor, onMerge, onSplit, onDelete } = props;
  const track = (field: "stem" | number) => (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onCursor(field, e.currentTarget.selectionStart ?? 0);
  const setChoice = (k: number, patch: Partial<ReviewDraft["choices"][number]>) =>
    onChange({ choices: d.choices.map((c, j) => (j === k ? { ...c, ...patch } : c)) });

  return (
    <article
      onFocus={onSelect}
      onClick={onSelect}
      className={`space-y-2 rounded-lg border bg-white p-3 text-sm ${selected ? "ring-2 ring-blue-600" : ""} ${d.reviewed ? "border-emerald-500" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="문항 번호"
          type="number"
          className="h-8 w-16 rounded border px-1 font-bold"
          value={d.no}
          onChange={(e) => onChange({ no: Number(e.target.value) || d.no })}
        />
        <select aria-label="과목" className={`${selectClass} h-8 w-40`} value={d.subjectId ?? ""} onChange={(e) => onChange({ subjectId: Number(e.target.value) || null })}>
          <option value="">과목 선택{d.subject ? ` (${d.subject})` : ""}</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={d.fixedChoices} onChange={(e) => onChange({ fixedChoices: e.target.checked })} /> 보기 고정
        </label>
        <input
          aria-label="묶음 키"
          placeholder="묶음 키"
          className="h-8 w-20 rounded border px-1"
          value={d.groupKey ?? ""}
          onChange={(e) => onChange({ groupKey: e.target.value || null })}
        />
        <label className={`ml-auto flex items-center gap-1 rounded px-2 py-1 font-medium ${d.reviewed ? "bg-emerald-100 text-emerald-900" : "bg-slate-100"}`}>
          <input type="checkbox" checked={d.reviewed} onChange={(e) => onChange({ reviewed: e.target.checked })} /> 검수 완료
        </label>
      </div>

      {d.groupIntro !== null && (
        <div>
          <span className="text-xs text-slate-500">묶음 공통 지문 (이 문항 지문 앞에 붙습니다)</span>
          <Textarea rows={2} value={d.groupIntro} onChange={(e) => onChange({ groupIntro: e.target.value })} />
        </div>
      )}
      <Textarea
        aria-label="지문"
        rows={3}
        value={d.stem}
        onChange={(e) => onChange({ stem: e.target.value })}
        onSelect={track("stem")}
        onKeyUp={track("stem")}
        onClick={track("stem")}
      />
      {(d.groupImages.length > 0 || d.stemImages.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {d.groupImages.map((r, k) => (
            <Thumb key={`g${refKey(r)}`} refImg={r} pageCanvas={pageCanvas} onRemove={() => onChange({ groupImages: d.groupImages.filter((_, j) => j !== k) })} />
          ))}
          {d.stemImages.map((r, k) => (
            <Thumb key={`s${refKey(r)}`} refImg={r} pageCanvas={pageCanvas} onRemove={() => onChange({ stemImages: d.stemImages.filter((_, j) => j !== k) })} />
          ))}
        </div>
      )}

      <ol className="space-y-1">
        {d.choices.map((c, k) => (
          <li key={k} className="flex items-start gap-1">
            <label className="mt-1.5 flex items-center gap-1">
              <input type="radio" name={`answer-${d.id}`} checked={d.answer === k + 1} onChange={() => onChange({ answer: k + 1 })} aria-label={`${k + 1}번 정답`} />
              <span>{MARKS[k]}</span>
            </label>
            <div className="flex-1 space-y-1">
              <input
                aria-label={`보기 ${k + 1}`}
                className="h-8 w-full rounded border px-2"
                value={c.text}
                onChange={(e) => setChoice(k, { text: e.target.value })}
                onSelect={track(k)}
                onKeyUp={track(k)}
                onClick={track(k)}
              />
              {c.image && <Thumb refImg={c.image} pageCanvas={pageCanvas} onRemove={() => setChoice(k, { image: undefined })} />}
            </div>
            <button
              type="button"
              className="mt-1 px-1 text-slate-400 hover:text-red-600"
              aria-label={`보기 ${k + 1} 삭제`}
              onClick={() => onChange({ choices: d.choices.filter((_, j) => j !== k), answer: d.answer === k + 1 ? null : d.answer && d.answer > k + 1 ? d.answer - 1 : d.answer })}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-1">
        {d.choices.length < 8 && (
          <Button size="sm" variant="ghost" onClick={() => onChange({ choices: [...d.choices, { text: "" }] })}>
            보기 추가
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onSplit} title="커서가 있는 곳에서 뒤쪽을 새 문항으로 나눕니다">
          커서에서 나누기
        </Button>
        {onMerge && (
          <Button size="sm" variant="ghost" onClick={onMerge} title="다음 문항을 이 문항에 붙입니다">
            다음 문항과 합치기
          </Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto text-red-700" onClick={onDelete}>
          삭제
        </Button>
      </div>
    </article>
  );
}
