import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AdminLayout } from "./admin/AdminLayout";
import { ExamEditRoute } from "./admin/exams/ExamEditPage";
import { ExamListPage } from "./admin/exams/ExamListPage";
import { ImportListPage } from "./admin/import/ImportListPage";
import { QuestionEditRoute } from "./admin/question-bank/QuestionEditPage";
import { QuestionListPage } from "./admin/question-bank/QuestionListPage";
import { ExamPage } from "./exam/ExamPage";
import { HomePage } from "./exam/HomePage";
import { ResultPage } from "./exam/ResultPage";
import "./index.css";

// pdf.js is large; only the PDF review screen needs it.
const ReviewPage = lazy(() => import("./admin/import/ReviewPage").then((m) => ({ default: m.ReviewPage })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/exam" element={<ExamPage />} />
        <Route path="/result" element={<ResultPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="questions" replace />} />
          <Route path="questions" element={<QuestionListPage />} />
          <Route path="questions/new" element={<QuestionEditRoute />} />
          <Route path="questions/:id" element={<QuestionEditRoute />} />
          <Route path="exams" element={<ExamListPage />} />
          <Route path="exams/new" element={<ExamEditRoute />} />
          <Route path="exams/:id" element={<ExamEditRoute />} />
          <Route path="import" element={<ImportListPage />} />
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
