import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
export interface OAuthConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  allowedSubjects: string[];
}
export function oauthVerifier(
  config: OAuthConfig,
  key?: JWTVerifyGetKey,
): OAuthTokenVerifier {
  const jwks =
    key ??
    createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
    });
  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["sub", "exp", "iat"],
          maxTokenAge: "1h",
        });
        if (
          !payload.sub ||
          !config.allowedSubjects.includes(payload.sub) ||
          typeof payload.scope !== "string"
        )
          throw new Error();
        const scopes = payload.scope
          .split(" ")
          .filter((s) => ["roster:read", "roster:write"].includes(s));
        if (!scopes.includes("roster:read")) throw new Error();
        return {
          token,
          clientId: payload.sub,
          scopes,
          expiresAt: payload.exp!,
          resource: new URL(config.audience),
          extra: { subject: JSON.stringify([config.issuer, payload.sub]) },
        };
      } catch {
        throw new InvalidTokenError("Access token is invalid or expired");
      }
    },
  };
}
export function localVerifier(expected: string): OAuthTokenVerifier {
  if (expected.length < 32)
    throw new Error("OGH_DEV_TOKEN must be at least 32 characters");
  const hash = (v: string) => createHash("sha256").update(v).digest(),
    target = hash(expected),
    expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    async verifyAccessToken(token) {
      if (!timingSafeEqual(hash(token), target))
        throw new InvalidTokenError("Invalid local token");
      return {
        token,
        expiresAt,
        clientId: "local-owner",
        scopes: ["roster:read", "roster:write"],
        extra: { subject: "local-owner" },
      };
    },
  };
}
