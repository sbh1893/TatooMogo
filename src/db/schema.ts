import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// All timestamps are epoch milliseconds (UTC). See docs/ANALYSIS.md section 4.
const bool = (name?: string) => (name ? integer(name, { mode: "boolean" }) : integer({ mode: "boolean" }));

export const admins = sqliteTable("admins", {
  id: integer().primaryKey(),
  email: text().notNull().unique(),
  role: text({ enum: ["admin", "super_admin"] }).notNull(),
  status: text({ enum: ["active", "suspended"] }).notNull().default("active"),
  invitedBy: integer("invited_by"),
  createdAt: integer("created_at").notNull().$default(() => Date.now()),
  lastLoginAt: integer("last_login_at"),
});

export const subjects = sqliteTable(
  "subjects",
  {
    id: integer().primaryKey(),
    name: text().notNull().unique(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: integer("created_at").notNull().$default(() => Date.now()),
  },
  (t) => [index("subjects_sort_idx").on(t.sortOrder)],
);

export const sourceFiles = sqliteTable(
  "source_files",
  {
    id: integer().primaryKey(),
    r2Key: text("r2_key").notNull().unique(),
    filename: text().notNull(),
    roundLabel: text("round_label"),
    subjectId: integer("subject_id").references(() => subjects.id),
    sizeBytes: integer("size_bytes").notNull(),
    kind: text({ enum: ["text", "scan"] }),
    status: text({ enum: ["uploaded", "reviewing", "done", "failed"] })
      .notNull()
      .default("uploaded"),
    uploadedBy: integer("uploaded_by").references(() => admins.id),
    createdAt: integer("created_at").notNull().$default(() => Date.now()),
  },
  (t) => [index("source_files_status_idx").on(t.status, t.createdAt)],
);

// One row per version. `code` is the common question number shown to staff and
// stays the same across versions (docs/ANALYSIS.md section 6 #9).
export const questions = sqliteTable(
  "questions",
  {
    id: integer().primaryKey(),
    code: integer().notNull(),
    version: integer().notNull(),
    isLatest: bool("is_latest").notNull(),
    subjectId: integer("subject_id")
      .notNull()
      .references(() => subjects.id),
    sourceFileId: integer("source_file_id").references(() => sourceFiles.id),
    sourceNo: integer("source_no"),
    stem: text().notNull(),
    stemImageKey: text("stem_image_key"),
    explanation: text().notNull().default(""),
    fixedChoices: bool("fixed_choices").notNull().default(false),
    groupKey: text("group_key"),
    status: text({ enum: ["review", "active", "disabled"] }).notNull(),
    createdBy: integer("created_by").references(() => admins.id),
    createdAt: integer("created_at").notNull().$default(() => Date.now()),
    updatedAt: integer("updated_at").notNull().$default(() => Date.now()),
  },
  (t) => [
    uniqueIndex("questions_code_version_uq").on(t.code, t.version),
    index("questions_latest_subject_status_idx").on(t.isLatest, t.subjectId, t.status),
    index("questions_source_idx").on(t.sourceFileId),
    index("questions_group_idx").on(t.groupKey),
  ],
);

export const choices = sqliteTable(
  "choices",
  {
    id: integer().primaryKey(),
    questionId: integer("question_id")
      .notNull()
      .references(() => questions.id),
    ord: integer().notNull(), // original order, 0-based
    body: text().notNull().default(""),
    imageKey: text("image_key"),
    isCorrect: bool("is_correct").notNull(),
  },
  (t) => [uniqueIndex("choices_question_ord_uq").on(t.questionId, t.ord)],
);

export const exams = sqliteTable("exams", {
  id: integer().primaryKey(),
  title: text().notNull(),
  code: text().notNull().unique(),
  status: text({ enum: ["draft", "open", "closed"] }).notNull().default("draft"),
  timeLimitMin: integer("time_limit_min").notNull(),
  opensAt: integer("opens_at"),
  closesAt: integer("closes_at"),
  passSubjectPct: integer("pass_subject_pct").notNull().default(40),
  passAvgPct: integer("pass_avg_pct").notNull().default(60),
  shuffleQuestions: bool("shuffle_questions").notNull().default(true),
  shuffleWithinSubject: bool("shuffle_within_subject").notNull().default(true),
  shuffleChoices: bool("shuffle_choices").notNull().default(true),
  revealExplanations: bool("reveal_explanations").notNull().default(true),
  notice: text().notNull().default(""),
  // Shuffle input frozen at the first attempt (docs/ANALYSIS.md 5-3). Non-null = composition locked.
  layout: text({ mode: "json" }),
  createdBy: integer("created_by").references(() => admins.id),
  createdAt: integer("created_at").notNull().$default(() => Date.now()),
});

export const examQuestions = sqliteTable(
  "exam_questions",
  {
    id: integer().primaryKey(),
    examId: integer("exam_id")
      .notNull()
      .references(() => exams.id),
    questionId: integer("question_id")
      .notNull()
      .references(() => questions.id),
    position: integer().notNull(),
    points: integer().notNull().default(1),
  },
  (t) => [
    uniqueIndex("exam_questions_exam_question_uq").on(t.examId, t.questionId),
    index("exam_questions_exam_pos_idx").on(t.examId, t.position),
    index("exam_questions_question_idx").on(t.questionId),
  ],
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: integer().primaryKey(),
    examId: integer("exam_id")
      .notNull()
      .references(() => exams.id),
    examineeNo: text("examinee_no").notNull(),
    examineeName: text("examinee_name").notNull(),
    seed: text().notNull(),
    sessionHash: text("session_hash").notNull(),
    startedAt: integer("started_at").notNull(),
    deadlineAt: integer("deadline_at").notNull(),
    submittedAt: integer("submitted_at"),
    submitReason: text("submit_reason", { enum: ["manual", "timeout", "admin"] }),
    totalCorrect: integer("total_correct"),
    avgPct: integer("avg_pct"), // subject average x 100 (e.g. 6125 = 61.25%)
    passed: bool(),
    subjectScores: text("subject_scores", { mode: "json" }),
    lastSeenAt: integer("last_seen_at"),
    deviceSwitches: integer("device_switches").notNull().default(0),
  },
  (t) => [
    uniqueIndex("attempts_exam_examinee_uq").on(t.examId, t.examineeNo),
    index("attempts_exam_submitted_idx").on(t.examId, t.submittedAt),
    index("attempts_session_idx").on(t.sessionHash),
  ],
);

export const answers = sqliteTable(
  "answers",
  {
    attemptId: integer("attempt_id")
      .notNull()
      .references(() => attempts.id),
    examQuestionId: integer("exam_question_id")
      .notNull()
      .references(() => examQuestions.id),
    choiceId: integer("choice_id").references(() => choices.id), // null = cleared
    savedAt: integer("saved_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.examQuestionId] }),
    index("answers_eq_choice_idx").on(t.examQuestionId, t.choiceId),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer().primaryKey(),
    adminId: integer("admin_id").references(() => admins.id),
    adminEmail: text("admin_email").notNull(),
    action: text().notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: text({ mode: "json" }),
    ip: text(),
    createdAt: integer("created_at").notNull().$default(() => Date.now()),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt),
    index("audit_logs_admin_created_idx").on(t.adminId, t.createdAt),
  ],
);

export type Admin = typeof admins.$inferSelect;
