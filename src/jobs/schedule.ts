import { Cron } from "croner";
import { config } from "../config.js";
import { log } from "../logger.js";
import { backfillAll } from "../monitor/backfill.js";
import { postDigest, postQuarterlyReminder } from "./digest.js";
import { runSweep } from "./sweep.js";

function schedule(
  name: string,
  expression: string,
  fn: () => Promise<unknown>
) {
  return new Cron(
    expression,
    // `protect` skips a run whose predecessor is still going, so a slow
    // backfill cannot stack up behind itself.
    { timezone: config().TZ, protect: true, name },
    async () => {
      try {
        await fn();
      } catch (err) {
        log.error("scheduled job failed", { job: name, error: String(err) });
      }
    }
  );
}

export function startSchedules(): Cron[] {
  const cfg = config();
  const jobs = [
    schedule("sweep", cfg.SWEEP_CRON, runSweep),
    schedule("backfill", cfg.BACKFILL_CRON, backfillAll),
    schedule("digest", cfg.DIGEST_CRON, postDigest),
    schedule("quarterly", cfg.QUARTERLY_CRON, postQuarterlyReminder),
  ];
  for (const job of jobs) {
    log.info("scheduled", {
      job: job.name,
      next: job.nextRun()?.toISOString() ?? null,
    });
  }
  return jobs;
}
