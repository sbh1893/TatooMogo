import { env } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { app } from "../src/server";
import { authDeps } from "../src/server/auth/middleware";
import { forgetLayout } from "../src/server/exam/attempt";
import type { Bindings } from "../src/server/env";

export const DEV_EMAIL = "dev@test.kr";
export const TEAM = "https://team.cloudflareaccess.com";
export const AUD = "test-aud";

export const devEnv = (): Bindings => ({ ...env, ENVIRONMENT: "development", ADMIN_DEV_EMAIL: DEV_EMAIL });
export const prodEnv = (extra: Partial<Bindings> = {}): Bindings => ({
  ...env,
  ENVIRONMENT: "production",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ...extra,
});

/** Calls the Worker app in-process with the given bindings. */
export function call(path: string, init: RequestInit & { json?: unknown } = {}, bindings: Bindings = devEnv()) {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  // Browsers send Origin on same-origin POST/PUT; the CSRF check relies on it.
  if (rest.method && rest.method !== "GET" && !headers.has("Origin")) headers.set("Origin", "http://localhost");
  return app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }, bindings);
}

export async function resetDb() {
  forgetLayout(); // ids restart after the reset; a cached layout from an earlier test must not leak in
  await env.DB.batch(
    ["answers", "attempts", "exam_questions", "exams", "choices", "questions", "source_files", "subjects", "audit_logs", "admins"].map(
      (t) => env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.batch([
    env.DB.prepare("INSERT INTO admins (id, email, role, status, created_at) VALUES (1, ?, 'super_admin', 'active', 0)").bind(DEV_EMAIL),
    env.DB.prepare("INSERT INTO subjects (id, name, sort_order, created_at) VALUES (1, '위생', 1, 0), (2, '법규', 2, 0)"),
  ]);
}

/** Local RS256 key pair + signer, playing the role of Cloudflare Access. */
export async function makeTestAccessKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string | number } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(opts.iss ?? TEAM)
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "1h")
      .sign(privateKey);
  return { keys, sign };
}

/** Same, and makes the middleware trust this key pair instead of fetching real certs. */
export async function installTestAccessKeys() {
  const pair = await makeTestAccessKeys();
  authDeps.keys = () => pair.keys;
  return pair;
}
