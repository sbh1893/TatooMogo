import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, type QuestionListItem, type QuestionStatus, type Subject } from "@/lib/api";
import { StatusBadge, selectClass } from "./common";

type ListResponse = { items: QuestionListItem[]; total: number; page: number; pageSize: number };

export function QuestionListPage() {
  const [params, setParams] = useSearchParams();
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState(params.get("q") ?? "");
  const page = Number(params.get("page") ?? "1");

  useEffect(() => {
    api<{ items: Subject[] }>("/api/admin/subjects").then((r) => setSubjects(r.items), (e) => setError(errorMessage(e)));
  }, []);

  const load = useCallback(() => {
    api<ListResponse>(`/api/admin/questions?${params.toString()}`).then(setData, (e) => setError(errorMessage(e)));
  }, [params]);
  useEffect(load, [load]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  };

  const toggle = async (item: QuestionListItem) => {
    const action = item.status === "disabled" ? "enable" : "disable";
    if (action === "disable" && !confirm(`#${item.code} 문항을 사용 중지할까요? 새 시험에서 고를 수 없게 됩니다.`)) return;
    try {
      await api(`/api/admin/questions/${item.id}/${action}`, { method: "POST" });
      load();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">문제은행</h1>
        <Button asChild>
          <Link to="/admin/questions/new">문항 등록</Link>
        </Button>
      </div>

      <form
        className="flex flex-wrap gap-2 rounded-lg border bg-white p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter("q", term.trim());
        }}
      >
        <select
          aria-label="과목"
          className={selectClass}
          value={params.get("subject") ?? ""}
          onChange={(e) => setFilter("subject", e.target.value)}
        >
          <option value="">전체 과목</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="상태"
          className={selectClass}
          value={params.get("status") ?? ""}
          onChange={(e) => setFilter("status", e.target.value as QuestionStatus | "")}
        >
          <option value="">전체 상태</option>
          <option value="active">사용</option>
          <option value="disabled">사용 중지</option>
          <option value="review">검수 대기</option>
        </select>
        <Input
          className="min-w-0 flex-1 basis-48"
          placeholder="지문 검색 또는 공통 문항 번호"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <Button type="submit" variant="outline">
          검색
        </Button>
      </form>

      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      {/* Under 640px: one card per question instead of a table. */}
      <ul className="space-y-2 sm:hidden">
        {data?.items.map((item) => (
          <li key={item.id} className="rounded-lg border bg-white p-3">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <span className="font-mono">
                #{item.code}
                {item.version > 1 && ` v${item.version}`}
              </span>
              <span>{item.subjectName}</span>
              <span className="ml-auto">
                <StatusBadge status={item.status} />
              </span>
            </div>
            <Link to={`/admin/questions/${item.id}`} className="mt-1 line-clamp-3 text-sm hover:underline">
              {item.stemPreview}
            </Link>
            {item.used && (
              <Badge variant="outline" className="mt-1">
                응시 기록 있음
              </Badge>
            )}
            <div className="mt-2 flex justify-end gap-1">
              <Button asChild size="sm" variant="outline">
                <Link to={`/admin/questions/${item.id}`}>수정</Link>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => toggle(item)}>
                {item.status === "disabled" ? "재사용" : "중지"}
              </Button>
            </div>
          </li>
        ))}
        {data && data.items.length === 0 && (
          <li className="rounded-lg border bg-white py-10 text-center text-sm text-slate-500">조건에 맞는 문항이 없습니다.</li>
        )}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border bg-white sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">번호</TableHead>
              <TableHead className="w-32">과목</TableHead>
              <TableHead>지문</TableHead>
              <TableHead className="w-24">상태</TableHead>
              <TableHead className="w-36 text-right">동작</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs">
                  #{item.code}
                  {item.version > 1 && <span className="text-slate-500"> v{item.version}</span>}
                </TableCell>
                <TableCell className="text-sm">{item.subjectName}</TableCell>
                <TableCell className="max-w-md">
                  <Link to={`/admin/questions/${item.id}`} className="line-clamp-2 hover:underline">
                    {item.stemPreview}
                  </Link>
                  {item.used && (
                    <Badge variant="outline" className="mt-1">
                      응시 기록 있음
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status} />
                </TableCell>
                <TableCell className="space-x-1 text-right whitespace-nowrap">
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/admin/questions/${item.id}`}>수정</Link>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle(item)}>
                    {item.status === "disabled" ? "재사용" : "중지"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {data && data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-slate-500">
                  조건에 맞는 문항이 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {data && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>전체 {data.total}문항</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setFilter("page", String(page - 1))}>
              이전
            </Button>
            <span>
              {page} / {lastPage}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= lastPage}
              onClick={() => setFilter("page", String(page + 1))}
            >
              다음
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
