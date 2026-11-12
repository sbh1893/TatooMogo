// Creates (or re-activates) the first super_admin. There is no sign-up screen by design.
// Usage: npm run db:bootstrap-admin -- owner@example.com --remote
//        npm run db:bootstrap-admin -- owner@example.com --local
import { q, runSqlFile } from "./d1";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
const target = args.includes("--remote") ? "--remote" : args.includes("--local") ? "--local" : null;

if (!email || !/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email) || !target) {
  console.error("사용법: npm run db:bootstrap-admin -- <이메일> --remote | --local");
  process.exit(1);
}

runSqlFile(
  "bootstrap-admin",
  `INSERT INTO admins (email, role, status, created_at) VALUES (${q(email)}, 'super_admin', 'active', ${Date.now()})
   ON CONFLICT(email) DO UPDATE SET role = 'super_admin', status = 'active';`,
  target,
);
console.log(`\n최고관리자 등록 완료: ${email} (${target === "--remote" ? "운영 D1" : "로컬 D1"})`);
console.log("Cloudflare Access 정책의 허용 이메일에도 같은 주소를 넣어야 로그인할 수 있습니다 (docs/SETUP.md).");
