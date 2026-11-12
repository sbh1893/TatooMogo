import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AdminLayout } from "./admin/AdminLayout";
import { QuestionEditRoute } from "./admin/question-bank/QuestionEditPage";
import { QuestionListPage } from "./admin/question-bank/QuestionListPage";
import { HomePage } from "./exam/HomePage";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="questions" replace />} />
          <Route path="questions" element={<QuestionListPage />} />
          <Route path="questions/new" element={<QuestionEditRoute />} />
          <Route path="questions/:id" element={<QuestionEditRoute />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
