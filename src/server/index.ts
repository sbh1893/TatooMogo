import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { questionRoutes } from "./admin/questions";
import { subjectRoutes } from "./admin/subjects";
import { requireAdmin } from "./auth/middleware";
import { fail, type AppEnv } from "./env";

// Every /api/admin route is checked on the server on every request (rule 5).
const admin = new Hono<AppEnv>()
  .use(csrf())
  .use(requireAdmin())
  .get("/me", (c) => {
    const { email, role } = c.get("admin");
    return c.json({ email, role });
  })
  .route("/subjects", subjectRoutes)
  .route("/questions", questionRoutes);

const app = new Hono<AppEnv>()
  .route("/api/admin", admin)
  .notFound((c) => fail(c, 404, "not_found", "요청한 주소가 없습니다."));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse(); // e.g. CSRF 403
  console.error(err);
  return fail(c, 500, "internal", "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
});

export default app;
