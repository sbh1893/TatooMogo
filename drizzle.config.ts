import { defineConfig } from "drizzle-kit";

// Only generates SQL migration files; applying them is done with wrangler (db:migrate:*).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
