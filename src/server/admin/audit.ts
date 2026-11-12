import type { SQL } from "drizzle-orm";
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
  | "question.enable";

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
