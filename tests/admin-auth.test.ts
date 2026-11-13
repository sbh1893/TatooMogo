import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/server/auth/access";
import { AUD, call, DEV_EMAIL, devEnv, installTestAccessKeys, makeTestAccessKeys, prodEnv, resetDb, TEAM } from "./helpers";

let sign: Awaited<ReturnType<typeof installTestAccessKeys>>["sign"];
let keys: Awaited<ReturnType<typeof installTestAccessKeys>>["keys"];

beforeAll(async () => {
  ({ sign, keys } = await installTestAccessKeys());
});
beforeEach(resetDb);

const me = (headers: Record<string, string> = {}, bindings = prodEnv()) => call("/api/admin/me", { headers }, bindings);

describe("verifyAccessJwt", () => {
  const opts = () => ({ teamDomain: TEAM, aud: AUD, keys });

  it("returns the lower-cased email of a valid token", async () => {
    expect(await verifyAccessJwt(await sign({ email: "Boss@Test.KR" }), opts())).toBe("boss@test.kr");
  });

  it("rejects wrong audience, wrong issuer, expired, forged and email-less tokens", async () => {
    await expect(verifyAccessJwt(await sign({ email: "a@b.kr" }, { aud: "other" }), opts())).rejects.toThrow();
    await expect(verifyAccessJwt(await sign({ email: "a@b.kr" }, { iss: "https://evil.cloudflareaccess.com" }), opts())).rejects.toThrow();
    await expect(verifyAccessJwt(await sign({ email: "a@b.kr" }, { exp: Math.floor(Date.now() / 1000) - 60 }), opts())).rejects.toThrow();
    const forged = await (await makeTestAccessKeys()).sign({ email: "a@b.kr" }); // signed by another key
    await expect(verifyAccessJwt(forged, opts())).rejects.toThrow();
    await expect(verifyAccessJwt(await sign({}), opts())).rejects.toThrow();
  });
});

describe("requireAdmin", () => {
  it("rejects requests without an Access token in production", async () => {
    expect((await me()).status).toBe(401);
  });

  it("never honours ADMIN_DEV_EMAIL outside ENVIRONMENT=development", async () => {
    for (const ENVIRONMENT of ["production", "Development", "dev", "staging", ""]) {
      const res = await me({}, prodEnv({ ENVIRONMENT, ADMIN_DEV_EMAIL: DEV_EMAIL }));
      expect(res.status, `ENVIRONMENT=${ENVIRONMENT}`).toBe(401);
    }
  });

  it("uses the dev bypass in development", async () => {
    const res = await me({}, devEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: DEV_EMAIL, role: "super_admin" });
  });

  it("rejects garbage and forged tokens", async () => {
    expect((await me({ "Cf-Access-Jwt-Assertion": "not-a-jwt" })).status).toBe(401);
    const wrongAud = await sign({ email: DEV_EMAIL }, { aud: "other" });
    expect((await me({ "Cf-Access-Jwt-Assertion": wrongAud })).status).toBe(401);
  });

  it("fails closed when Access settings are missing", async () => {
    const token = await sign({ email: DEV_EMAIL });
    const res = await me({ "Cf-Access-Jwt-Assertion": token }, prodEnv({ ACCESS_AUD: undefined }));
    expect(res.status).toBe(401);
  });

  it("accepts a valid token for an active admin and records one login per day", async () => {
    const token = await sign({ email: DEV_EMAIL });
    expect((await me({ "Cf-Access-Jwt-Assertion": token })).status).toBe(200);
    expect((await me({ "Cf-Access-Jwt-Assertion": token })).status).toBe(200);
    const logins = await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'login'").first<{ n: number }>();
    expect(logins?.n).toBe(1);
  });

  it("rejects valid tokens for unknown or suspended accounts", async () => {
    expect((await me({ "Cf-Access-Jwt-Assertion": await sign({ email: "stranger@test.kr" }) })).status).toBe(403);
    await env.DB.prepare("UPDATE admins SET status = 'suspended'").run();
    expect((await me({ "Cf-Access-Jwt-Assertion": await sign({ email: DEV_EMAIL }) })).status).toBe(403);
  });

  it("guards every admin route, not just /me", async () => {
    for (const [method, path] of [
      ["GET", "/api/admin/questions"],
      ["POST", "/api/admin/questions"],
      ["PUT", "/api/admin/questions/1"],
      ["POST", "/api/admin/questions/1/disable"],
      ["GET", "/api/admin/subjects"],
      ["POST", "/api/admin/questions/bulk"],
      ["GET", "/api/admin/source-files"],
      ["POST", "/api/admin/source-files"],
      ["GET", "/api/admin/source-files/1/file"],
      ["POST", "/api/admin/media"],
      ["GET", "/api/admin/media/0a.png"],
    ]) {
      const res = await call(path, { method, json: method === "GET" ? undefined : {} }, prodEnv());
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
