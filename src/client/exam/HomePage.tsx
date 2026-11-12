// Examinee entry screen. The real flow (exam code → examinee no. + name) arrives in week 3.
export function HomePage() {
  return (
    <main className="min-h-screen bg-slate-100">
      <header className="bg-[#1f3a5f] px-4 py-3 text-lg font-black text-white">문신사 CBT 모의고사</header>
      <div className="mx-auto max-w-xl p-4">
        <div className="rounded-lg border bg-white p-6">
          <h1 className="text-xl font-bold">시험 입장</h1>
          <p className="mt-2 text-sm text-slate-600">응시 화면은 준비 중입니다.</p>
        </div>
      </div>
    </main>
  );
}
