import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AdminLayout } from "./admin/AdminLayout";
import { AdminsPage } from "./admin/admins/AdminsPage";
import { AuditLogsPage } from "./admin/admins/AuditLogsPage";
import { ExamEditRoute } from "./admin/exams/ExamEditPage";
import { ExamListPage } from "./admin/exams/ExamListPage";
import { ExamMonitorPage } from "./admin/exams/ExamMonitorPage";
import { ExamResultsPage } from "./admin/exams/ExamResultsPage";
import { ImportListPage } from "./admin/import/ImportListPage";
import { QuestionEditRoute } from "./admin/question-bank/QuestionEditPage";
import { QuestionListPage } from "./admin/question-bank/QuestionListPage";
import { ExamPage } from "./exam/ExamPage";
import { HomePage } from "./exam/HomePage";
import { LegalPage } from "./exam/LegalPage";
import { ResultPage } from "./exam/ResultPage";
import "./index.css";

// Error reporting only when a DSN was given at build time (VITE_SENTRY_DSN); loaded lazily so the
// examinee bundle stays small. No user data is attached.
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (dsn) import("@sentry/browser").then((S) => S.init({ dsn, environment: import.meta.env.MODE }));

// pdf.js is large; only the PDF review screen needs it.
const ReviewPage = lazy(() => import("./admin/import/ReviewPage").then((m) => ({ default: m.ReviewPage })));
// The Word reader (fflate) likewise loads only on its own screen.
const DocxImportPage = lazy(() => import("./admin/import/DocxImportPage").then((m) => ({ default: m.DocxImportPage })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/exam" element={<ExamPage />} />
        <Route path="/result" element={<ResultPage />} />
        <Route path="/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="/terms" element={<LegalPage kind="terms" />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="questions" replace />} />
          <Route path="questions" element={<QuestionListPage />} />
          <Route path="questions/new" element={<QuestionEditRoute />} />
          <Route path="questions/:id" element={<QuestionEditRoute />} />
          <Route path="exams" element={<ExamListPage />} />
          <Route path="exams/new" element={<ExamEditRoute />} />
          <Route path="exams/:id" element={<ExamEditRoute />} />
          <Route path="exams/:id/monitor" element={<ExamMonitorPage />} />
          <Route path="exams/:id/results" element={<ExamResultsPage />} />
          <Route path="admins" element={<AdminsPage />} />
          <Route path="audit-logs" element={<AuditLogsPage />} />
          <Route path="import" element={<ImportListPage />} />
          <Route
            path="import/word"
            element={
              <Suspense fallback={<p className="p-6 text-slate-500">불러오는 중…</p>}>
                <DocxImportPage />
              </Suspense>
            }
          />
          <Route
            path="import/:id"
            element={
              <Suspense fallback={<p className="p-6 text-slate-500">불러오는 중…</p>}>
                <ReviewPage />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
