import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { adminRoutes, auditLogRoutes } from "./admin/admins";
import { docxRoutes } from "./admin/docx-import";
import { questionRoutes } from "./admin/questions";
import { examRoutes } from "./admin/exams";
import { mediaRoutes, sourceRoutes } from "./admin/sources";
import { subjectRoutes } from "./admin/subjects";
import { requireAdmin } from "./auth/middleware";
import { meterD1, type Meter } from "./d1-meter";
import { fail, getDb, type AppEnv, type Bindings } from "./env";
import { finalizeExpired } from "./exam/attempt";
import { examApi } from "./exam/routes";

/**
 * Per-IP limit (Workers Rate Limiting binding: per Cloudflare location, approximate).
 * Off in local development so the load script can run from one machine.
 */
const rateLimit = (pick: (env: Bindings) => RateLimit | undefined) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const rl = pick(c.env);
    const ip = c.req.header("CF-Connecting-IP");
    if (rl && ip && c.env.ENVIRONMENT !== "development" && !(await rl.limit({ key: ip })).success) {
      return fail(c, 429, "rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    }
    await next();
  });

// Every /api/admin route is checked on the server on every request (rule 5).
const admin = new Hono<AppEnv>()
  .use(csrf())
  .use(requireAdmin())
  .get("/me", (c) => {
    const { email, role } = c.get("admin");
    return c.json({ email, role });
  })
  .route("/subjects", subjectRoutes)
  .route("/questions", questionRoutes)
  .route("/docx", docxRoutes)
  .route("/source-files", sourceRoutes)
  .route("/media", mediaRoutes)
  .route("/exams", examRoutes)
  .route("/admins", adminRoutes)
  .route("/audit-logs", auditLogRoutes);

const app = new Hono<AppEnv>()
  // Development only, opt-in per request: D1 queries and rows read/written (scripts/load-test.ts).
  .use("/api/*", async (c, next) => {
    if (c.env.ENVIRONMENT !== "development" || !c.req.header("X-D1-Meter")) return next();
    const m: Meter = { q: 0, read: 0, write: 0 };
    c.env = { ...c.env, DB: meterD1(c.env.DB, m) };
    await next();
    c.header("X-D1-Meter", `${m.q},${m.read},${m.write}`);
  })
  .use("/api/*", rateLimit((env) => env.RL_API))
  .use("/api/exam/info", rateLimit((env) => env.RL_ENTRY))
  .use("/api/exam/enter", rateLimit((env) => env.RL_ENTRY))
  .route("/api/admin", admin)
  .route("/api/exam", examApi)
  .notFound((c) => fail(c, 404, "not_found", "요청한 주소가 없습니다."));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse(); // e.g. CSRF 403
  console.error(err);
  Sentry.captureException(err); // no-op without SENTRY_DSN
  return fail(c, 500, "internal", "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
});

export { app };

// No SENTRY_DSN → no Sentry at all. Request bodies (examinee names) are not sent by default.
export default Sentry.withSentry((env: Bindings) => (env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, environment: env.ENVIRONMENT } : undefined), {
  fetch: app.fetch,
  /** Cron (wrangler.jsonc triggers): closes attempts whose time ran out with nobody online. */
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(finalizeExpired(getDb(env)).then((n) => n && console.log(`finalized ${n} expired attempts`)));
  },
} satisfies ExportedHandler<Bindings>);
