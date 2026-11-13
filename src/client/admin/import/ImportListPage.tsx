import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage, type SourceFile } from "@/lib/api";

const STATUS: Record<SourceFile["status"], string> = { uploaded: "업로드됨", reviewing: "검수 중", done: "등록 완료", failed: "실패" };
const MAX_MB = 20;

export function ImportListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<SourceFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ items: SourceFile[] }>("/api/admin/source-files").then((r) => setItems(r.items), (e) => setError(errorMessage(e)));
  }, []);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || !file.name) return setError("PDF 파일을 선택해 주세요.");
    if (file.size > MAX_MB * 1024 * 1024) return setError(`PDF는 ${MAX_MB}MB 이하만 올릴 수 있습니다.`);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/source-files", { method: "POST", body: form, credentials: "same-origin" });
      const data = (await res.json()) as SourceFile & { error?: { message: string } };
      if (!res.ok) throw new Error(data.error?.message ?? "업로드에 실패했습니다.");
      navigate(`/admin/import/${data.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-bold">PDF 문제지 가져오기</h1>
      <form onSubmit={submit} className="grid gap-3 rounded-lg border bg-white p-4 sm:grid-cols-[1fr_12rem_8rem_auto] sm:items-end">
        <div className="grid gap-1">
          <Label htmlFor="file">PDF 파일 (20MB 이하)</Label>
          <Input id="file" name="file" type="file" accept="application/pdf,.pdf" required />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="roundLabel">회차 이름</Label>
          <Input id="roundLabel" name="roundLabel" placeholder="예: 2027년 1회" maxLength={50} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="kind">종류</Label>
          <select id="kind" name="kind" className="h-9 rounded-md border bg-white px-2 text-sm" defaultValue="text">
            <option value="text">텍스트형</option>
            <option value="scan">스캔본</option>
          </select>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "올리는 중…" : "올리고 검수하기"}
        </Button>
      </form>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      <ul className="divide-y rounded-lg border bg-white">
        {items?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
            <Link to={`/admin/import/${s.id}`} className="font-medium hover:underline">
              {s.roundLabel ? `${s.roundLabel} · ` : ""}
              {s.filename}
            </Link>
            <span className="text-xs text-slate-500">
              {s.kind === "scan" ? "스캔본" : "텍스트형"} · {(s.sizeBytes / 1024 / 1024).toFixed(1)}MB ·{" "}
              {new Date(s.createdAt).toLocaleString("ko-KR")}
            </span>
            <span className="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs">{STATUS[s.status]}</span>
          </li>
        ))}
        {items?.length === 0 && <li className="p-6 text-center text-sm text-slate-500">아직 올린 문제지가 없습니다.</li>}
      </ul>
    </section>
  );
}
