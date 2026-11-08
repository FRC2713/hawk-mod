import { z } from "zod";
import { suitePublicKey } from "./web/suiteSession.js";

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
  // Seed for the `managed-groups` setting; see src/settings.ts for what the
  // allowlist is actually for.
  MANAGED_USERGROUPS: z.string().optional(),
  TZ: z.string().default("America/New_York"),
  SWEEP_CRON: z.string().default("0 3 * * *"),
  BACKFILL_CRON: z.string().default("15 * * * *"),
  // Seed for the `report-time` setting: HH:MM for both morning reports (the
  // daily digest and the quarterly reminder). Replaces DIGEST_CRON and
  // QUARTERLY_CRON, which let the two drift apart.
  REPORT_TIME: z.string().optional(),
  // Optional gateway identity verification; never editable as workspace settings.
  HAWK_SUITE_ISSUER: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.string().url().optional()),
  HAWK_SUITE_PUBLIC_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),
  HAWK_SUITE_AUDIENCE: z.string().min(1).default("hawk-suite"),
});

const envSchema = schema.superRefine((value, ctx) => {
  if (!value.HAWK_SUITE_ISSUER !== !value.HAWK_SUITE_PUBLIC_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["HAWK_SUITE_PUBLIC_KEY"],
      message:
        "Set both HAWK_SUITE_ISSUER and HAWK_SUITE_PUBLIC_KEY, or neither",
    });
    return;
  }
  if (!value.HAWK_SUITE_PUBLIC_KEY) return;
  try {
    suitePublicKey(value.HAWK_SUITE_PUBLIC_KEY);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["HAWK_SUITE_PUBLIC_KEY"],
      message: "not an RSA public key (PEM, or base64 of one)",
    });
  }
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

/**
 * Parsed once, on first use, so the CLI can load a partial environment for
 * commands that never touch Slack (see `requireConfig` vs `dataDir`).
 */
export function config(): Config {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
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
