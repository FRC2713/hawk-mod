import { createPublicKey, type KeyObject, verify } from "node:crypto";

/** Verifies the gateway cookie as identity only. `administrator()` still
 * checks Slack Workspace Owner/Admin status and refuses students per request.
 * Proxy identity headers are never trusted, including on the Docker network.
 */

/** The gateway's cookie, set for the bare domain so every app sees it. */
export const SUITE_COOKIE = "AUTHP_ACCESS_TOKEN";

/** The role the gateway's portal transform grants a workspace member. */
export const SUITE_MEMBER_ROLE = "suite/member";

/** Longer than any token the gateway signs; a 15-minute session is ~1 KB. */
const MAX_TOKEN_BYTES = 8192;

/**
 * Only RSA, and only PKCS#1 v1.5. **An allowlist, load-bearing:** the
 * alternative is reading `alg` out of the token and believing it, and that is
 * exactly what makes the two classic forgeries work — `alg: none`, and an
 * `HS256` token whose HMAC key is the published (non-secret) verification key.
 * Naming the permitted algorithms is what refuses both.
 */
const ALGORITHMS = new Map([
  ["RS256", "sha256"],
  ["RS384", "sha384"],
  ["RS512", "sha512"],
]);

/**
 * `slack:<team>:<user>` — the subject the gateway builds from the identity it
 * verified against Slack's UserInfo endpoint. Both Slack ids are read back out
 * of it rather than out of sibling claims, because this is the one shape the
 * gateway's own tests pin.
 */
const SUBJECT = /^slack:(T[A-Z0-9]+):([UW][A-Z0-9]+)$/;

export type SuiteIdentity = {
  userId: string;
  teamId: string;
  /** The `sub` claim as signed, for the log. */
  subject: string;
  /**
   * The gateway's optional `name` claim — display only, and absent whenever
   * the portal has no profile name to put there. It never affects access.
   */
  name?: string;
};

export type SuiteVerifier = {
  /** `HAWK_SUITE_ISSUER`, matched exactly — `https://apps.<domain>/`. */
  issuer: string;
  /** `HAWK_SUITE_AUDIENCE`, `hawk-suite` unless the gateway is reconfigured. */
  audience: string;
  key: KeyObject;
};

const keyCache = new Map<string, KeyObject>();

/**
 * The gateway's public key, from a PEM or the base64 of one (the suite's deploy
 * workflow renders base64 on a single line). Throws on anything that is not an
 * RSA public key, which is why `config()` calls this at parse time: a mistyped
 * key should refuse to boot, not quietly deny every administrator at the door.
 *
 * Cached by source string, so the request path never re-parses.
 */
export function suitePublicKey(source: string): KeyObject {
  const cached = keyCache.get(source);
  if (cached) return cached;
  const pem = source.includes("-----BEGIN")
    ? source
    : Buffer.from(source, "base64").toString("utf8");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("HAWK_SUITE_PUBLIC_KEY must be an RSA public key");
  }
  keyCache.set(source, key);
  return key;
}

function segment(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8")
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** JWT allows a bare string or a list; the gateway writes a string. */
function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === "string") return claim === expected;
  return Array.isArray(claim) && claim.includes(expected);
}

/**
 * The verified signed-in member, or `undefined` for anything else — missing,
 * malformed, expired, forged, foreign, or non-member. One uninformative
 * `undefined` for every failure on purpose: the browser gets the same page
 * either way, and no caller can accidentally read "could not verify" as a pass.
 *
 * @param nowMs Unix milliseconds.
 */
export function verifySuiteToken(
  token: string,
  verifier: SuiteVerifier,
  nowMs: number
): SuiteIdentity | undefined {
  if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const rawHeader = parts[0] ?? "";
  const rawPayload = parts[1] ?? "";
  const rawSignature = parts[2] ?? "";

  const header = segment(rawHeader);
  const hash =
    typeof header?.alg === "string" ? ALGORITHMS.get(header.alg) : undefined;
  if (!hash) return undefined;

  let signed: boolean;
  try {
    signed = verify(
      hash,
      Buffer.from(`${rawHeader}.${rawPayload}`),
      verifier.key,
      Buffer.from(rawSignature, "base64url")
    );
  } catch {
    return undefined;
  }
  if (!signed) return undefined;

  const claims = segment(rawPayload);
  if (!claims) return undefined;

  // Required, all of them. An unsigned expiry is the whole point of the
  // signature, and a token with no `exp` at all would be a permanent one.
  if (
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= nowMs
  ) {
    return undefined;
  }
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== "number" ||
      !Number.isFinite(claims.nbf) ||
      claims.nbf * 1000 > nowMs)
  ) {
    return undefined;
  }
  if (claims.iss !== verifier.issuer) return undefined;
  if (!audienceMatches(claims.aud, verifier.audience)) return undefined;

  // A member of the workspace the gateway was configured for. The portal
  // blocks anyone else, and this role is the half of that it signed — which
  // is the half hawk-mod can check for itself.
  if (
    !Array.isArray(claims.roles) ||
    !claims.roles.includes(SUITE_MEMBER_ROLE)
  ) {
    return undefined;
  }

  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const match = SUBJECT.exec(subject);
  const teamId = match?.[1];
  const userId = match?.[2];
  if (!teamId || !userId) return undefined;
  const name = typeof claims.name === "string" ? claims.name : undefined;
  return { userId, teamId, subject, ...(name ? { name } : {}) };
}
