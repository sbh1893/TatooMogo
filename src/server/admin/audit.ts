import { sql, type SQL } from "drizzle-orm";
import { auditLogs, type Admin } from "../../db/schema";
import type { Ctx, Db } from "../env";

export type AuditAction =
  | "login"
  | "subject.create"
  | "subject.update"
  | "question.create"
  | "question.update"
  | "question.version"
  | "question.disable"
  | "question.enable"
  | "question.import"
  | "question.delete"
  | "question.archive"
  | "question.restore"
  | "source.upload"
  | "exam.create"
  | "exam.update"
  | "exam.questions"
  | "exam.open"
  | "exam.close"
  | "exam.export"
  | "exam.delete"
  | "admin.create"
  | "admin.update";

/**
 * Builds (does not run) an audit insert so callers can put it in the same D1 batch
 * as the change it records — both land or neither does.
 */
export function auditInsert(
  db: Db,
  c: Ctx,
  action: AuditAction,
  target: { type: string; id: string | SQL } | null,
  detail?: Record<string, unknown>,
  admin: Admin = c.get("admin"),
) {
  return db.insert(auditLogs).values({
    adminId: admin.id,
    adminEmail: admin.email,
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    detail: detail ?? null,
    ip: c.req.header("CF-Connecting-IP") ?? null,
  });
}

/** Same, but the row is written only if `when` holds at batch time (use with rawBatch). */
export function auditInsertIf(
  c: Ctx,
  when: SQL,
  action: AuditAction,
  target: { type: string; id: string | SQL },
  detail?: Record<string, unknown>,
) {
  const admin = c.get("admin");
  return sql`insert into audit_logs (admin_id, admin_email, action, target_type, target_id, detail, ip, created_at)
    select ${admin.id}, ${admin.email}, ${action}, ${target.type}, ${target.id}, ${detail ? JSON.stringify(detail) : null},
      ${c.req.header("CF-Connecting-IP") ?? null}, ${Date.now()}
    where ${when}`;
}
