import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { api, errorMessage } from "@/lib/api";

export type Me = { email: string; role: "admin" | "super_admin" };

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded px-3 py-1.5 text-sm ${isActive ? "bg-white/20 font-bold" : "hover:bg-white/10"}`;

export function AdminLayout() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/api/admin/me").then(setMe, (e) => setError(errorMessage(e)));
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="flex flex-wrap items-center gap-2 bg-[#1f3a5f] px-4 py-2 text-white">
        <span className="mr-2 font-black">타투모고 관리자</span>
        <nav className="flex flex-wrap gap-1">
          <NavLink to="/admin/questions" className={navClass}>
            문제은행
          </NavLink>
          <NavLink to="/admin/exams" className={navClass}>
            시험
          </NavLink>
          <NavLink to="/admin/import" className={navClass}>
            PDF 가져오기
          </NavLink>
          {/* Shown to super admins only; the server checks the role on every request anyway. */}
          {me?.role === "super_admin" && (
            <>
              <NavLink to="/admin/admins" className={navClass}>
                관리자
              </NavLink>
              <NavLink to="/admin/audit-logs" className={navClass}>
                접속 기록
              </NavLink>
            </>
          )}
        </nav>
        <span className="ml-auto truncate text-xs opacity-80">
          {me ? `${me.email} · ${me.role === "super_admin" ? "최고관리자" : "관리자"}` : ""}
        </span>
      </header>
      <main className="mx-auto max-w-7xl p-3 sm:p-6">
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">{error}</div>
        ) : me ? (
          <Outlet context={me} />
        ) : (
          <p className="p-6 text-slate-500">불러오는 중…</p>
        )}
      </main>
    </div>
  );
}
