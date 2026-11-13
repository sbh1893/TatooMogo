import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import type { Me } from "../AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type ExamDetail, type ExamSettings, type QuestionListItem, type Subject } from "@/lib/api";
import { selectClass } from "../question-bank/common";
import { ExamStatusBadge, fromLocalInput, toLocalInput } from "./common";

const defaults: ExamSettings = {
  title: "",
  timeLimitMin: 60,
  opensAt: null,
  closesAt: null,
  passSubjectPct: 40,
  passAvgPct: 60,
  shuffleQuestions: true,
  shuffleWithinSubject: true,
  shuffleChoices: true,
  revealExplanations: true,
  notice: "",
};
/** Settings that stay editable after the first attempt (server enforces the same list). */
const AFTER_LOCK = new Set<keyof ExamSettings>(["title", "opensAt", "closesAt", "revealExplanations", "notice"]);

export function ExamEditRoute() {
  const { id } = useParams();
  return <ExamEditPage key={id ?? "new"} />;
}

function ExamEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useOutletContext<Me>();
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [form, setForm] = useState<ExamSettings>(defaults);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<ExamDetail>(`/api/admin/exams/${id}`).then(
      (e) => {
        setExam(e);
        setForm(Object.fromEntries(Object.keys(defaults).map((k) => [k, e[k as keyof ExamSettings]])) as ExamSettings);
      },
      (e) => setError(errorMessage(e)),
    );
  useEffect(() => {
    if (id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per id (the route remounts per id)
  }, [id]);

  const set = <K extends keyof ExamSettings>(k: K, v: ExamSettings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const locked = !!exam?.locked;
  const off = (k: keyof ExamSettings) => busy || (locked && !AFTER_LOCK.has(k));

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!id) {
        const created = await api<{ id: number }>("/api/admin/exams", { method: "POST", body: form });
        navigate(`/admin/exams/${created.id}`, { replace: true });
        return;
      }
      const body = locked ? Object.fromEntries([...AFTER_LOCK].map((k) => [k, form[k]])) : form;
      await api(`/api/admin/exams/${id}`, { method: "PATCH", body });
      await load();
      setNotice("설정을 저장했습니다.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (action: "open" | "close") => {
    if (action === "close" && !confirm("시험을 닫으면 새로 입장할 수 없습니다. 응시 중인 사람은 이어서 볼 수 있습니다. 닫을까요?")) return;
    setError(null);
    try {
      await api(`/api/admin/exams/${id}/${action}`, { method: "POST" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/admin/exams" className="text-sm text-slate-600 hover:underline">
          ← 시험 목록
        </Link>
        <h1 className="mr-auto text-xl font-bold">{exam ? exam.title : "시험 개설"}</h1>
        {exam && (
          <>
            <ExamStatusBadge status={exam.status} />
            <span className="text-sm">
              시험 코드{" "}
              <button
                type="button"
                className="rounded bg-slate-900 px-2 py-0.5 font-mono tracking-widest text-white"
                title="눌러서 복사"
                onClick={() => navigator.clipboard?.writeText(exam.code).then(() => setNotice(`시험 코드 ${exam.code}를 복사했습니다.`))}
              >
                {exam.code}
              </button>
            </span>
            {exam.status === "deleting" ? null : exam.status !== "open" ? (
              <Button size="sm" onClick={() => setStatus("open")}>
                시험 열기
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setStatus("close")}>
                시험 닫기
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <Link to={`/admin/exams/${exam.id}/monitor`}>응시 현황</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to={`/admin/exams/${exam.id}/results`}>성적</Link>
            </Button>
          </>
        )}
      </div>
      {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm whitespace-pre-line text-red-800">{error}</p>}
      {locked && (
        <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          응시자가 {exam?.attemptCount}명 있어 문항 구성과 채점 설정이 잠겼습니다. 이름·기간·해설 공개·유의사항만 바꿀 수 있습니다.
        </p>
      )}

      <form onSubmit={saveSettings} className="grid gap-4 rounded-lg border bg-white p-4 sm:grid-cols-2 sm:p-6">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="title">시험 이름</Label>
          <Input id="title" required maxLength={100} value={form.title} disabled={off("title")} onChange={(e) => set("title", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="limit">제한 시간(분)</Label>
          <Input id="limit" type="number" min={1} max={600} value={form.timeLimitMin} disabled={off("timeLimitMin")} onChange={(e) => set("timeLimitMin", Number(e.target.value))} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="subjPct">과목별 최소(%)</Label>
            <Input id="subjPct" type="number" min={0} max={100} value={form.passSubjectPct} disabled={off("passSubjectPct")} onChange={(e) => set("passSubjectPct", Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="avgPct">평균 합격(%)</Label>
            <Input id="avgPct" type="number" min={0} max={100} value={form.passAvgPct} disabled={off("passAvgPct")} onChange={(e) => set("passAvgPct", Number(e.target.value))} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="opens">열리는 시각 (비우면 바로)</Label>
          <Input id="opens" type="datetime-local" value={toLocalInput(form.opensAt)} disabled={off("opensAt")} onChange={(e) => set("opensAt", fromLocalInput(e.target.value))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="closes">닫히는 시각 (비우면 직접 닫을 때까지)</Label>
          <Input id="closes" type="datetime-local" value={toLocalInput(form.closesAt)} disabled={off("closesAt")} onChange={(e) => set("closesAt", fromLocalInput(e.target.value))} />
        </div>
        <fieldset className="space-y-1 text-sm sm:col-span-2">
          <legend className="mb-1 font-medium">문제지</legend>
          {(
            [
              ["shuffleQuestions", "문항 순서 섞기"],
              ["shuffleWithinSubject", "과목 순서는 유지 (과목 안에서만 섞기)"],
              ["shuffleChoices", "보기 순서 섞기 (보기 고정 문항은 제외)"],
              ["revealExplanations", "제출 후 정답·해설 공개"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="mr-4 inline-flex items-center gap-1.5">
              <input type="checkbox" checked={form[k]} disabled={off(k) || (k === "shuffleWithinSubject" && !form.shuffleQuestions)} onChange={(e) => set(k, e.target.checked)} />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="notice">유의사항 (입장 화면에 보입니다)</Label>
          <Textarea id="notice" rows={3} maxLength={2000} value={form.notice} disabled={off("notice")} onChange={(e) => set("notice", e.target.value)} />
        </div>
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" disabled={busy}>
            {id ? "설정 저장" : "만들고 문항 고르기"}
          </Button>
        </div>
      </form>

      {exam && exam.status !== "deleting" && <QuestionPicker exam={exam} onSaved={load} onError={setError} />}
      {exam && me.role === "super_admin" && (exam.status === "closed" || exam.status === "deleting") && <DeleteExam exam={exam} />}
    </section>
  );
}

/**
 * Super admin: deletes a closed exam and its attempts. The server works in steps (a few thousand
 * answers per request), so this keeps calling until it reports done. Re-opening the page continues
 * an interrupted delete.
 */
function DeleteExam({ exam }: { exam: ExamDetail }) {
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resuming = exam.status === "deleting";
  const ready = resuming || typed.trim().toUpperCase() === exam.code;

  const run = async () => {
    setError(null);
    let removed = 0;
    setProgress(0);
    try {
      for (;;) {
        const r = await api<{ done: boolean; deletedAnswers: number }>(`/api/admin/exams/${exam.id}/delete`, { method: "POST" });
        removed += r.deletedAnswers;
        setProgress(removed);
        if (r.done) break;
      }
      alert(`「${exam.title}」 시험을 삭제했습니다.`);
      navigate("/admin/exams", { replace: true });
    } catch (e) {
      setError(`${errorMessage(e)} 다시 누르면 이어서 지웁니다.`);
      setProgress(null);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-red-200 bg-white p-4">
      <h2 className="font-bold text-red-800">시험 삭제 (최고관리자)</h2>
      <p className="text-sm text-slate-700">
        시험, 문항 구성, 응시 기록({exam.attemptCount}명)과 답안이 모두 지워지고 되돌릴 수 없습니다. 문항은 문제은행에 남습니다.
      </p>
      <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        삭제하기 전에{" "}
        <Link to={`/admin/exams/${exam.id}/results`} className="font-bold underline">
          성적 화면에서 엑셀을 내려받아
        </Link>{" "}
        보관해 주세요. 삭제 후에는 성적을 다시 볼 수 없습니다.
      </p>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {resuming ? (
        <p className="text-sm text-red-800">삭제가 중간에 멈춘 시험입니다. 아래 버튼으로 이어서 지웁니다.</p>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="confirm-code">
            확인을 위해 시험 코드 <b className="font-mono">{exam.code}</b>를 입력하세요
          </Label>
          <Input id="confirm-code" className="max-w-40 font-mono uppercase" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}
      <Button variant="destructive" disabled={!ready || progress !== null} onClick={run}>
        {progress !== null ? `지우는 중… (답안 ${progress}개)` : resuming ? "이어서 삭제" : "시험 삭제"}
      </Button>
    </section>
  );
}

// ------------------------------------------------------------------ questions

function QuestionPicker({ exam, onSaved, onError }: { exam: ExamDetail; onSaved: () => void; onError: (m: string | null) => void }) {
  const [bank, setBank] = useState<QuestionListItem[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subject, setSubject] = useState(0);
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<{ questionId: number; points: number }[]>(() => exam.questions.map((q) => ({ questionId: q.questionId, points: q.points })));
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    api<{ items: QuestionListItem[] }>("/api/admin/questions?status=active&size=500").then((r) => setBank(r.items), (e) => onError(errorMessage(e)));
    api<{ items: Subject[] }>("/api/admin/subjects").then((r) => setSubjects(r.items));
  }, [onError]);

  // Questions already in the exam may be older versions; show them from the exam detail.
  const info = useMemo(() => {
    const m = new Map<number, { code: number; version: number; subjectId: number; subjectName: string; stemPreview: string; groupKey: string | null }>();
    for (const q of bank) m.set(q.id, q);
    for (const q of exam.questions) m.set(q.questionId, q);
    return m;
  }, [bank, exam.questions]);
  const pickedIds = new Set(picked.map((p) => p.questionId));
  const visible = bank.filter((q) => (!subject || q.subjectId === subject) && (!term || q.stemPreview.includes(term) || String(q.code) === term));

  const change = (next: typeof picked) => {
    setPicked(next);
    setSaved(false);
  };
  /** A grouped question comes with its whole group. */
  const toggle = (q: QuestionListItem) => {
    const ids = q.groupKey ? bank.filter((b) => b.groupKey === q.groupKey).map((b) => b.id) : [q.id];
    if (pickedIds.has(q.id)) change(picked.filter((p) => !ids.includes(p.questionId)));
    else change([...picked, ...ids.filter((x) => !pickedIds.has(x)).map((questionId) => ({ questionId, points: 1 }))]);
  };

  const save = async () => {
    onError(null);
    try {
      await api(`/api/admin/exams/${exam.id}/questions`, { method: "PUT", body: { items: picked } });
      setSaved(true);
      onSaved();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const bySubject = subjects
    .map((s) => ({ s, n: picked.filter((p) => info.get(p.questionId)?.subjectId === s.id).length }))
    .filter((x) => x.n > 0);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-2 rounded-lg border bg-white p-3">
        <h2 className="font-bold">문제은행</h2>
        <div className="flex gap-2">
          <select aria-label="과목" className={`${selectClass} w-40`} value={subject} onChange={(e) => setSubject(Number(e.target.value))}>
            <option value={0}>전체 과목</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Input placeholder="지문 검색 또는 공통 번호" value={term} onChange={(e) => setTerm(e.target.value.trim())} />
        </div>
        {!exam.locked && visible.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => change([...picked, ...visible.filter((q) => !pickedIds.has(q.id)).map((q) => ({ questionId: q.id, points: 1 }))])}
          >
            보이는 {visible.length}문항 모두 넣기
          </Button>
        )}
        <ul className="max-h-[28rem] divide-y overflow-y-auto text-sm">
          {visible.map((q) => (
            <li key={q.id}>
              <label className="flex cursor-pointer items-start gap-2 p-2 hover:bg-slate-50">
                <input type="checkbox" className="mt-1" checked={pickedIds.has(q.id)} disabled={exam.locked} onChange={() => toggle(q)} />
                <span className="font-mono text-xs text-slate-500">#{q.code}</span>
                <span className="flex-1">
                  <span className="mr-1 text-xs text-slate-500">{q.subjectName}</span>
                  {q.groupKey && <span className="mr-1 rounded bg-amber-100 px-1 text-xs">묶음</span>}
                  {q.stemPreview}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2 rounded-lg border bg-white p-3">
        <div className="flex items-center gap-2">
          <h2 className="mr-auto font-bold">
            시험 문항 {picked.length}개 <span className="text-sm font-normal text-slate-500">{bySubject.map((x) => `${x.s.name} ${x.n}`).join(" · ")}</span>
          </h2>
          {!exam.locked && (
            <Button size="sm" onClick={save} disabled={saved}>
              {saved ? "저장됨" : "문항 구성 저장"}
            </Button>
          )}
        </div>
        <ol className="max-h-[32rem] divide-y overflow-y-auto text-sm">
          {picked.map((p, i) => {
            const q = info.get(p.questionId);
            return (
              <li key={p.questionId} className="flex items-center gap-2 p-2">
                <span className="w-6 text-right text-slate-500">{i + 1}</span>
                <span className="font-mono text-xs text-slate-500">
                  #{q?.code}
                  {q && q.version > 1 ? ` v${q.version}` : ""}
                </span>
                <span className="flex-1 truncate">
                  <span className="mr-1 text-xs text-slate-500">{q?.subjectName}</span>
                  {q?.stemPreview}
                </span>
                <label className="flex items-center gap-1 text-xs">
                  배점
                  <input
                    type="number"
                    min={1}
                    max={100}
                    className="h-7 w-14 rounded border px-1"
                    value={p.points}
                    disabled={exam.locked}
                    onChange={(e) => change(picked.map((x) => (x.questionId === p.questionId ? { ...x, points: Math.max(1, Number(e.target.value) || 1) } : x)))}
                  />
                </label>
                {!exam.locked && (
                  <button type="button" className="px-1 text-slate-400 hover:text-red-600" aria-label="빼기" onClick={() => change(picked.filter((x) => x.questionId !== p.questionId))}>
                    ×
                  </button>
                )}
              </li>
            );
          })}
          {picked.length === 0 && <li className="p-6 text-center text-slate-500">왼쪽에서 문항을 골라 주세요.</li>}
        </ol>
      </div>
    </div>
  );
}
