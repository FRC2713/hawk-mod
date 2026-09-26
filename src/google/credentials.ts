import { readFileSync } from "node:fs";
import { JWT } from "google-auth-library";

/**
 * Google access is optional. A host with none of these set keeps doing
 * everything it did before the lifecycle sync existed; only the lifecycle
 * commands notice.
 *
 * Read from `process.env` directly, never through `config()`: `config()` is an
 * all-or-nothing parse of the Slack environment, and the CLI reaches this with
 * no Slack credentials present.
 *
 * These are credentials, so they are environment and never a setting — like
 * `TOKEN_ENCRYPTION_KEY`, nothing reachable from Slack or `/config` can change
 * them.
 */
export type GoogleEnv = {
  key: { base64: string } | { file: string };
  /** Spreadsheet ID of the RHR User Lifecycle Management DB. */
  sheetId: string | undefined;
};

/**
 * The key comes one of two ways. Production gets it as one base64 line, the
 * way hawk_suite's deploy workflow passes every secret (and the way hawk-bot
 * takes its own Google key): nothing on that host is a file anyone put there.
 * A file path is for running the CLI from a laptop. Base64 wins if both are
 * set.
 */
export function googleEnv(): GoogleEnv | null {
  const base64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64?.trim();
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim();
  const key = base64 ? { base64 } : file ? { file } : null;
  if (!key) return null;
  return {
    key,
    sheetId: process.env.LIFECYCLE_SHEET_ID?.trim() || undefined,
  };
}

type KeyFile = { client_email?: string; private_key?: string };

function keyJson(env: GoogleEnv): string {
  if ("base64" in env.key) {
    return Buffer.from(env.key.base64, "base64").toString("utf8");
  }
  try {
    return readFileSync(env.key.file, "utf8");
  } catch (err) {
    // The path and the OS error only; neither contains the key.
    const code = (err as { code?: string }).code ?? "unreadable";
    throw new Error(
      `Could not read GOOGLE_SERVICE_ACCOUNT_KEY_FILE (${code}): ${env.key.file}`
    );
  }
}

/**
 * A client authenticated as the service account itself. The lifecycle sheet is
 * shared with the service account directly, so reading it needs no
 * impersonation; the Directory calls in later steps will add a `subject`.
 */
export function serviceAccountClient(env: GoogleEnv, scopes: string[]): JWT {
  const source =
    "base64" in env.key
      ? "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64"
      : "GOOGLE_SERVICE_ACCOUNT_KEY_FILE";
  let parsed: KeyFile;
  try {
    parsed = JSON.parse(keyJson(env)) as KeyFile;
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Deliberately not err.message: JSON.parse quotes the text it choked
      // on, and that text is the private key. This message can reach Slack.
      throw new Error(`${source} is not a JSON service account key`);
    }
    throw err;
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      `${source} is not a service account key (no client_email or private_key)`
    );
  }
  return new JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes,
  });
}
