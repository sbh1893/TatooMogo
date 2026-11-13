import { NavLink } from "react-router";

const tab = ({ isActive }: { isActive: boolean }) => `rounded-t-md border-b-2 px-3 py-1.5 text-sm ${isActive ? "border-[#1f3a5f] font-bold" : "border-transparent text-slate-600 hover:text-slate-900"}`;

export function ImportTabs() {
  return (
    <nav className="flex gap-1 border-b" aria-label="가져오기 종류">
      <NavLink to="/admin/import" end className={tab}>
        PDF 문제지
      </NavLink>
      <NavLink to="/admin/import/word" className={tab}>
        Word 파일
      </NavLink>
    </nav>
  );
}
