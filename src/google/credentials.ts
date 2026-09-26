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
  /** Path to the service account's JSON key file. */
  keyFile: string;
  /** Spreadsheet ID of the RHR User Lifecycle Management DB. */
  sheetId: string | undefined;
};

export function googleEnv(): GoogleEnv | null {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim();
  if (!keyFile) return null;
  return {
    keyFile,
    sheetId: process.env.LIFECYCLE_SHEET_ID?.trim() || undefined,
  };
}

type KeyFile = { client_email?: string; private_key?: string };

/**
 * A client authenticated as the service account itself. The lifecycle sheet is
 * shared with the service account directly, so reading it needs no
 * impersonation; the Directory calls in later steps will add a `subject`.
 */
export function serviceAccountClient(env: GoogleEnv, scopes: string[]): JWT {
  let parsed: KeyFile;
  try {
    parsed = JSON.parse(readFileSync(env.keyFile, "utf8")) as KeyFile;
  } catch (err) {
    throw new Error(
      `Could not read the Google key file at GOOGLE_SERVICE_ACCOUNT_KEY_FILE ` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not a service account key " +
        "(no client_email or private_key)"
    );
  }
  return new JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes,
  });
}
