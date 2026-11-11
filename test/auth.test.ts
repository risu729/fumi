import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authenticate, resolveGrant, type AuthEnvironment } from "../src/auth.ts";
import { handleHttp } from "../src/http.ts";
import { env } from "cloudflare:workers";

const settings: AuthEnvironment = {
  ACCESS_ISSUER: "https://synthetic.cloudflareaccess.com",
  ACCESS_AUDIENCE: "synthetic-app",
  API_ORIGIN: "https://mail.example.invalid",
  MAIL_GRANTS: JSON.stringify({
    "user:synthetic": { scopes: ["mail:read"], fromAddresses: [] },
    "service:synthetic-service": {
      scopes: ["mail:draft"],
      fromAddresses: ["sender@example.invalid"],
    },
  }),
};
describe("Access authorization boundary", () => {
  it("verifies signature, audience, issuer, expiry and the explicit server grant", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "synthetic-key";
    const resolver = createLocalJWKSet({ keys: [jwk] });
    async function request(claims: Record<string, unknown> = {}, key = keys.privateKey) {
      const token = await new SignJWT({ type: "app", sub: "synthetic", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
        .setIssuer(settings.ACCESS_ISSUER)
        .setAudience(settings.ACCESS_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key);
      return new Request(`${settings.API_ORIGIN}/mcp`, {
        headers: { "cf-access-jwt-assertion": token },
      });
    }
    const valid = await request();
    expect((await authenticate(valid, settings, resolver)).id).toBe("user:synthetic");
    await expect(
      authenticate(valid, { ...settings, ACCESS_AUDIENCE: "other" }, resolver),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticate(
        valid,
        { ...settings, ACCESS_ISSUER: "https://other.cloudflareaccess.com" },
        resolver,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticate(valid, { ...settings, MAIL_GRANTS: "{}" }, resolver),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authenticate(await request({ type: "other" }), settings, resolver),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await authenticate(
          await request({ sub: "", common_name: "synthetic-service" }),
          settings,
          resolver,
        )
      ).id,
    ).toBe("service:synthetic-service");
    const wrong = await generateKeyPair("RS256");
    await expect(
      authenticate(await request({}, wrong.privateKey), settings, resolver),
    ).rejects.toMatchObject({ status: 401 });
    const expired = await new SignJWT({ type: "app", sub: "synthetic" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(settings.ACCESS_ISSUER)
      .setAudience(settings.ACCESS_AUDIENCE)
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(keys.privateKey);
    await expect(
      authenticate(
        new Request(valid.url, { headers: { "cf-access-jwt-assertion": expired } }),
        settings,
        resolver,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("rejects malformed grants and identity claims supplied outside a signed assertion", async () => {
    expect(
      resolveGrant(
        '{"user:synthetic":{"scopes":["mail:admin"],"fromAddresses":[]}}',
        "user:synthetic",
      ),
    ).toBeNull();
    expect(
      resolveGrant(
        '{"user:synthetic":{"scopes":["mail:send"],"fromAddresses":[],"id":"other"}}',
        "user:synthetic",
      ),
    ).toBeNull();
    const response = await handleHttp(
      new Request(`${settings.API_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "x-principal": "user:synthetic" },
        body: "{}",
      }),
      { ...env, ...settings },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cross = await handleHttp(
      new Request(`${settings.API_ORIGIN}/mcp`, {
        headers: { origin: "https://other.example.invalid" },
      }),
      { ...env, ...settings },
    );
    expect(cross.status).toBe(403);
  });
});
