import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import * as v from "valibot";
import { MAIL_SCOPES, type MailPrincipal } from "./principal.ts";

export interface AuthEnvironment {
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE: string;
  MAIL_GRANTS: string;
  API_ORIGIN: string;
}
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const address = v.pipe(
  v.string(),
  v.maxLength(254),
  v.regex(/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/),
);
const grantsSchema = v.record(
  // oxlint-disable-next-line no-control-regex -- Reject control characters in configured identity keys.
  v.pipe(v.string(), v.regex(/^(user|service):[^\s\x00-\x1f]{1,256}$/)),
  v.strictObject({
    scopes: v.pipe(v.array(v.picklist(MAIL_SCOPES)), v.maxLength(4)),
    fromAddresses: v.pipe(v.array(address), v.maxLength(20)),
    fromDomains: v.optional(
      v.pipe(
        v.array(
          v.pipe(
            v.string(),
            v.maxLength(253),
            v.regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
          ),
        ),
        v.maxLength(10),
      ),
    ),
  }),
);
export function resolveGrant(serialized: string, id: string): MailPrincipal | null {
  if (typeof serialized !== "string" || serialized.length > 32_768) return null;
  try {
    const parsed = v.safeParse(grantsSchema, JSON.parse(serialized));
    if (
      !parsed.success ||
      Object.keys(parsed.output).length > 64 ||
      !Object.hasOwn(parsed.output, id)
    )
      return null;
    const grant = parsed.output[id];
    return grant
      ? {
          id,
          scopes: grant.scopes,
          fromAddresses: grant.fromAddresses,
          ...(grant.fromDomains ? { fromDomains: grant.fromDomains } : {}),
        }
      : null;
  } catch {
    return null;
  }
}
export function apiOrigin(env: Pick<AuthEnvironment, "API_ORIGIN">): string {
  try {
    const url = new URL(env.API_ORIGIN);
    if (url.protocol !== "https:" || url.origin !== env.API_ORIGIN || url.username || url.password)
      throw new Error();
    return url.origin;
  } catch {
    throw new HttpError(503, "api_not_configured");
  }
}
// Cache public verification keys only, never tokens or resolved grants.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(
  request: Request,
  env: AuthEnvironment,
  testKeys?: JWTVerifyGetKey,
): Promise<MailPrincipal> {
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER) ||
    !env.ACCESS_AUDIENCE ||
    env.ACCESS_AUDIENCE.length > 256
  )
    throw new HttpError(503, "auth_not_configured");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16_384) throw new HttpError(401, "authentication_required");
  let keys = testKeys ?? keySets.get(env.ACCESS_ISSUER);
  if (!keys) {
    const remote = createRemoteJWKSet(new URL(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
    });
    if (keySets.size >= 4) keySets.clear();
    keySets.set(env.ACCESS_ISSUER, remote);
    keys = remote;
  }
  let id: string;
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"],
    });
    if (payload["type"] !== "app") throw new Error();
    if (typeof payload.sub === "string" && payload.sub.trim()) id = `user:${payload.sub}`;
    else if (typeof payload["common_name"] === "string" && payload["common_name"].trim())
      id = `service:${payload["common_name"]}`;
    else throw new Error();
  } catch {
    throw new HttpError(401, "authentication_required");
  }
  const principal = resolveGrant(env.MAIL_GRANTS, id);
  if (!principal) throw new HttpError(403, "grant_required");
  return principal;
}
