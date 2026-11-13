import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { MAX_CHOICES, MIN_CHOICES, validateQuestionInput, type QuestionInput } from "../../../shared/question";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, mediaUrl, uploadMedia, type QuestionDetail, type SaveResult, type Subject } from "@/lib/api";
import { StatusBadge, selectClass } from "./common";

/** Shows a stem/choice picture with remove, or a button to upload one (PNG/JPEG, 2MB). */
function ImageField({ value, onChange, label }: { value?: string | null; onChange: (key: string | null) => void; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (value)
    return (
      <div className="flex items-start gap-2">
        <img src={mediaUrl(value)} alt={label} className="max-h-48 max-w-full rounded border bg-white" />
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
          그림 빼기
        </Button>
      </div>
    );
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
      <span className="rounded border px-2 py-1 hover:bg-slate-50">{busy ? "올리는 중…" : `${label} 올리기`}</span>
      <input
        type="file"
        accept="image/png,image/jpeg"
        className="sr-only"
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            onChange(await uploadMedia(file, file.name));
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && <span className="text-red-700">{error}</span>}
    </label>
  );
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
const emptyChoice = () => ({ body: "", imageKey: null, isCorrect: false });
const emptyForm = (): QuestionInput => ({
  subjectId: 0,
  stem: "",
  explanation: "",
  fixedChoices: false,
  groupKey: "",
  choices: Array.from({ length: 5 }, emptyChoice),
});

/** Remounts the editor when the id changes so stale form state never leaks between questions. */
export function QuestionEditRoute() {
  const { id } = useParams();
  return <QuestionEditPage key={id ?? "new"} />;
}

function QuestionEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [form, setForm] = useState<QuestionInput>(emptyForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ items: Subject[] }>("/api/admin/subjects").then((r) => setSubjects(r.items), (e) => setErrors([errorMessage(e)]));
  }, []);

  // The route remounts this page per id (see QuestionEditRoute), so no reset is needed here.
  useEffect(() => {
    if (!id) return;
    api<QuestionDetail>(`/api/admin/questions/${id}`).then(
      (d) => {
        setDetail(d);
        setForm({
          subjectId: d.subjectId,
          stem: d.stem,
          stemImageKey: d.stemImageKey,
          explanation: d.explanation,
          fixedChoices: d.fixedChoices,
          groupKey: d.groupKey ?? "",
          choices: d.choices.map((c) => ({ body: c.body, imageKey: c.imageKey, isCorrect: c.isCorrect })),
        });
      },
      (e) => setErrors([errorMessage(e)]),
    );
  }, [id]);

  const set = <K extends keyof QuestionInput>(key: K, value: QuestionInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setChoice = (i: number, patch: Partial<QuestionInput["choices"][number]>) =>
    setForm((f) => ({
      ...f,
      choices: f.choices.map((c, k) =>
        patch.isCorrect ? { ...c, ...(k === i ? patch : {}), isCorrect: k === i } : k === i ? { ...c, ...patch } : c,
      ),
    }));

  const readOnly = detail !== null && !detail.isLatest;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateQuestionInput(form);
    if (!v.ok) return setErrors(v.errors);
    setErrors([]);
    setSaving(true);
    try {
      const r = await api<SaveResult>(id ? `/api/admin/questions/${id}` : "/api/admin/questions", {
        method: id ? "PUT" : "POST",
        body: v.value,
      });
      setNotice(
        r.newVersion
          ? `응시 기록이 있는 문항이라 새 버전(v${r.version})으로 저장했습니다. 지난 성적은 바뀌지 않습니다.`
          : `#${r.code} 문항을 저장했습니다.`,
      );
      navigate(`/admin/questions/${r.id}`, { replace: true });
    } catch (err) {
      setErrors([errorMessage(err)]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/admin/questions" className="text-sm text-slate-600 hover:underline">
          ← 문제은행
        </Link>
        <h1 className="mr-auto w-full text-xl font-bold sm:w-auto">
          {detail ? `#${detail.code} 문항 (v${detail.version})` : "문항 등록"}
        </h1>
        {detail && <StatusBadge status={detail.status} />}
      </div>

      {notice && <p className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
      {readOnly && (
        <p className="rounded border border-slate-300 bg-slate-50 p-3 text-sm">
          지난 버전입니다. 수정하려면 최신 버전을 여세요.
        </p>
      )}
      {detail?.used && detail.isLatest && (
        <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          이 문항은 응시 기록이 있어 저장하면 새 버전으로 만들어집니다. 이미 본 시험의 성적과 문제지는 바뀌지 않습니다.
        </p>
      )}
      {errors.length > 0 && (
        <ul className="list-inside list-disc rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {errors.flatMap((e) => e.split("\n")).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <fieldset disabled={readOnly || saving} className="space-y-4 rounded-lg border bg-white p-4 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="subject">과목</Label>
            <select
              id="subject"
              className={`${selectClass} w-full`}
              value={form.subjectId || ""}
              onChange={(e) => set("subjectId", Number(e.target.value))}
            >
              <option value="">과목 선택</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group">묶음 키 (선택)</Label>
            <Input
              id="group"
              placeholder="같은 지문에 딸린 문항끼리 같은 값"
              value={form.groupKey ?? ""}
              onChange={(e) => set("groupKey", e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="stem">지문</Label>
          <Textarea id="stem" rows={4} value={form.stem} onChange={(e) => set("stem", e.target.value)} />
          <ImageField label="지문 그림" value={form.stemImageKey} onChange={(k) => set("stemImageKey", k)} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>보기 (정답 하나 선택)</Label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.fixedChoices}
                onChange={(e) => set("fixedChoices", e.target.checked)}
              />
              보기 고정 (섞지 않음)
            </label>
          </div>
          {form.choices.map((c, i) => (
            <div key={i} className="flex items-start gap-2">
              <label className="flex shrink-0 items-center gap-1 pt-2 text-sm" title="정답">
                <input type="radio" name="correct" checked={c.isCorrect} onChange={() => setChoice(i, { isCorrect: true })} />
                <span className="w-5 text-center">{CIRCLED[i]}</span>
              </label>
              <div className="flex-1 space-y-1">
                <Textarea
                  rows={1}
                  aria-label={`${i + 1}번 보기`}
                  className="min-h-9"
                  value={c.body}
                  onChange={(e) => setChoice(i, { body: e.target.value })}
                />
                <ImageField label="보기 그림" value={c.imageKey} onChange={(k) => setChoice(i, { imageKey: k })} />
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`${i + 1}번 보기 삭제`}
                disabled={form.choices.length <= MIN_CHOICES}
                onClick={() => set("choices", form.choices.filter((_, k) => k !== i))}
              >
                삭제
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={form.choices.length >= MAX_CHOICES}
            onClick={() => set("choices", [...form.choices, emptyChoice()])}
          >
            보기 추가
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="explanation">해설</Label>
          <Textarea
            id="explanation"
            rows={3}
            value={form.explanation}
            onChange={(e) => set("explanation", e.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit">{saving ? "저장 중…" : "저장"}</Button>
        </div>
      </fieldset>

      {detail && detail.versions.length > 1 && (
        <div className="rounded-lg border bg-white p-4 text-sm">
          <h2 className="mb-2 font-bold">버전 이력</h2>
          <ul className="space-y-1">
            {detail.versions.map((v) => (
              <li key={v.id}>
                <Link to={`/admin/questions/${v.id}`} className={v.id === detail.id ? "font-bold" : "hover:underline"}>
                  v{v.version}
                </Link>{" "}
                · {new Date(v.createdAt).toLocaleString("ko-KR")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
