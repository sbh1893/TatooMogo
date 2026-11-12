import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Cloudflare Access puts a signed JWT in `Cf-Access-Jwt-Assertion` on every request it lets through.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

export function normalizeTeamDomain(raw: string) {
  const s = raw.trim().replace(/\/+$/, "");
  return s.startsWith("https://") ? s : `https://${s}`;
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();

/** JWKS for a team domain, cached per isolate (jose also caches the fetched keys). */
export function accessKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    remoteKeys.set(teamDomain, keys);
  }
  return keys;
}

/** Verifies signature, issuer, audience and expiry. Returns the lower-cased email or throws. */
export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string; keys: JWTVerifyGetKey },
): Promise<string> {
  const { payload } = await jwtVerify(token, opts.keys, {
    issuer: opts.teamDomain,
    audience: opts.aud,
    algorithms: ["RS256"],
  });
  if (typeof payload.email !== "string" || !payload.email) throw new Error("no email claim");
  return payload.email.toLowerCase();
}
