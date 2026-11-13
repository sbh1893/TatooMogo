import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage, type AdminRole, type AdminRow } from "@/lib/api";
import type { Me } from "../AdminLayout";
import { fmtTime } from "../exams/common";

const ROLE: Record<AdminRole, string> = { admin: "관리자", super_admin: "최고관리자" };

/** Allow list (super admin). Server permission follows this table; Access must list the same emails. */
export function AdminsPage() {
  const { email: myEmail } = useOutletContext<Me>();
  const [items, setItems] = useState<AdminRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("admin");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ items: AdminRow[] }>("/api/admin/admins").then((r) => setItems(r.items), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(ok);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const target = email.trim().toLowerCase();
    run(async () => {
      await api("/api/admin/admins", { method: "POST", body: { email: target, role } });
      setEmail("");
    }, `${target}을(를) 허용 목록에 넣었습니다. Cloudflare Access 정책에도 같은 이메일을 추가해야 로그인할 수 있습니다.`);
  };
  const patch = (a: AdminRow, body: Partial<Pick<AdminRow, "status" | "role">>, ok: string) =>
    run(() => api(`/api/admin/admins/${a.id}`, { method: "PATCH", body }), ok);

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-bold">관리자 허용 목록</h1>
      <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        관리자를 추가하거나 빼면 <b>Cloudflare Access 정책(Zero Trust → Access → Applications → 타투모고 관리자 → Policy)</b>의 이메일 목록도 같이 바꿔
        주세요. 정지는 이 화면에서 바로 반영됩니다(다음 요청부터 차단).
      </p>
      {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-3">
        <Input type="email" required placeholder="staff@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="max-w-xs" aria-label="이메일" />
        <select value={role} onChange={(e) => setRole(e.target.value as AdminRole)} className="h-9 rounded-md border px-2 text-sm" aria-label="역할">
          <option value="admin">관리자</option>
          <option value="super_admin">최고관리자</option>
        </select>
        <Button type="submit">추가</Button>
      </form>
      <ul className="divide-y rounded-lg border bg-white">
        {items?.map((a) => {
          const me = a.email === myEmail;
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
              <span className={`font-medium ${a.status === "suspended" ? "text-slate-400 line-through" : ""}`}>{a.email}</span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{ROLE[a.role]}</span>
              {a.status === "suspended" && <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">정지</span>}
              {me && <span className="text-xs text-slate-500">(나)</span>}
              <span className="text-xs text-slate-500">최근 로그인 {a.lastLoginAt ? fmtTime(a.lastLoginAt) : "없음"}</span>
              {!me && (
                <span className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const next = a.role === "admin" ? "super_admin" : "admin";
                      patch(a, { role: next }, `${a.email}의 역할을 ${ROLE[next]}(으)로 바꿨습니다.`);
                    }}
                  >
                    {a.role === "admin" ? "최고관리자로" : "관리자로"}
                  </Button>
                  {a.status === "active" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-700"
                      onClick={() => confirm(`${a.email} 계정을 정지할까요?`) && patch(a, { status: "suspended" }, `${a.email} 계정을 정지했습니다.`)}
                    >
                      정지
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => patch(a, { status: "active" }, `${a.email} 계정을 다시 허용했습니다.`)}>
                      정지 해제
                    </Button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
