import { z } from "zod";

const schema = z.object({
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  SLACK_STATE_SECRET: z.string().min(16),
  PUBLIC_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  // Seeds only, all four of them. A value set from Slack wins — see
  // src/settings.ts. Kept optional so a fresh install can be configured
  // entirely from Slack, and so an existing host keeps working unchanged.
  ALERT_CHANNEL_ID: z.string().optional(),
  DATA_DIR: z.string().default("./data"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  LOG_MODE: z.enum(["full", "metadata"]).default("full"),
  // Slack user groups that declare roles. Seeds for the settings of the same
  // name; leave both unset and unconfigured and the roster is maintained purely
  // by CSV import.
  STUDENT_USERGROUP: z.string().optional(),
  ADULT_USERGROUP: z.string().optional(),
  // Seed for the `managed-groups` setting; see src/settings.ts for what the
  // allowlist is actually for.
  MANAGED_USERGROUPS: z.string().optional(),
  TZ: z.string().default("America/New_York"),
  SWEEP_CRON: z.string().default("0 3 * * *"),
  BACKFILL_CRON: z.string().default("15 * * * *"),
  DIGEST_CRON: z.string().default("0 8 * * *"),
  QUARTERLY_CRON: z.string().default("0 9 1 1,4,7,10 *"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

/**
 * Parsed once, on first use, so the CLI can load a partial environment for
 * commands that never touch Slack (see `requireConfig` vs `dataDir`).
 */
export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** DATA_DIR without requiring the full Slack environment. */
export function dataDir(): string {
  return process.env.DATA_DIR ?? "./data";
}

/** LOG_MODE without requiring the full Slack environment. */
export function logMode(): "full" | "metadata" {
  return process.env.LOG_MODE === "metadata" ? "metadata" : "full";
}
