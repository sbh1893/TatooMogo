import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { questionRoutes } from "./admin/questions";
import { examRoutes } from "./admin/exams";
import { mediaRoutes, sourceRoutes } from "./admin/sources";
import { subjectRoutes } from "./admin/subjects";
import { requireAdmin } from "./auth/middleware";
import { fail, getDb, type AppEnv, type Bindings } from "./env";
import { finalizeExpired } from "./exam/attempt";
import { examApi } from "./exam/routes";

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
  .route("/source-files", sourceRoutes)
  .route("/media", mediaRoutes)
  .route("/exams", examRoutes);

const app = new Hono<AppEnv>()
  .route("/api/admin", admin)
  .route("/api/exam", examApi)
  .notFound((c) => fail(c, 404, "not_found", "요청한 주소가 없습니다."));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse(); // e.g. CSRF 403
  console.error(err);
  return fail(c, 500, "internal", "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
});

export { app };

export default {
  fetch: app.fetch,
  /** Cron (wrangler.jsonc triggers): closes attempts whose time ran out with nobody online. */
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(finalizeExpired(getDb(env)).then((n) => n && console.log(`finalized ${n} expired attempts`)));
  },
} satisfies ExportedHandler<Bindings>;
