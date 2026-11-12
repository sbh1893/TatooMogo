// Helpers for scripts that run SQL against D1 through wrangler (works on Windows and macOS/Linux).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const q = (v: string | number | boolean | null) =>
  v === null ? "NULL" : typeof v === "string" ? `'${v.replaceAll("'", "''")}'` : String(Number(v));

export function runSqlFile(name: string, sqlText: string, target: "--local" | "--remote") {
  const dir = join(".wrangler", "tmp-sql");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.sql`);
  writeFileSync(file, sqlText, "utf8");
  const r = spawnSync("npx", ["wrangler", "d1", "execute", "DB", target, `--file=${file}`, "--yes"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
