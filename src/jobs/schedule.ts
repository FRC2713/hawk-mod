import { Cron } from "croner";
import { config } from "../config.js";
import { lifecycleHourly } from "../lifecycle/run.js";
import { botClient } from "../slack/tokens.js";
import { log } from "../logger.js";
import { backfillAll } from "../monitor/backfill.js";
import {
  parseReportTime,
  REPORT_TIME_DEFAULT,
  settingValue,
} from "../settings.js";
import { postDigest, postQuarterlyReminder } from "./digest.js";
import { runSweep } from "./sweep.js";

function schedule(
  name: string,
  expression: string,
  fn: () => Promise<unknown>
) {
  const job = new Cron(
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
  log.info("scheduled", {
    job: name,
    next: job.nextRun()?.toISOString() ?? null,
  });
  return job;
}

/**
 * Both morning reports fire at the same minute, on purpose: one configurable
 * time (`report-time`), not two cron expressions that drift apart. The
 * quarterly reminder keeps its own calendar — first of January, April, July,
 * October — and borrows only the clock time.
 */
export function reportTime(): { hour: number; minute: number } {
  const raw = settingValue("report-time");
  const parsed = parseReportTime(raw ?? REPORT_TIME_DEFAULT);
  if (parsed) return parsed;
  // Unreachable through `/hawkmod config` or the web page, which validate
  // before storing; a hand-set REPORT_TIME env var can still get here.
  log.warn("report-time is not HH:MM; using the default", {
    value: raw,
    default: REPORT_TIME_DEFAULT,
  });
  return parseReportTime(REPORT_TIME_DEFAULT)!;
}

let reportJobs: Cron[] = [];

function scheduleReports(): Cron[] {
  const { hour, minute } = reportTime();
  reportJobs = [
    schedule("digest", `${minute} ${hour} * * *`, postDigest),
    schedule(
      "quarterly",
      `${minute} ${hour} 1 1,4,7,10 *`,
      postQuarterlyReminder
    ),
  ];
  return reportJobs;
}

/**
 * Applies a changed `report-time` immediately, the same way a changed role
 * group re-syncs immediately: leaving it until tomorrow would mean the setting
 * looked applied and was not. Returns the next digest run for the caller's
 * confirmation message. Safe before `startSchedules` — there is nothing to
 * stop yet.
 */
export function rescheduleReports(): Date | null {
  for (const job of reportJobs) job.stop();
  const jobs = scheduleReports();
  return jobs[0]?.nextRun() ?? null;
}

/**
 * The roster and the Google Groups from the lifecycle sheet, hourly. Fixed rather than configurable:
 * a new environment variable means a change to hawk_suite's deploy, and an
 * hour is the promise the design makes. "Sync now" is there for anyone who
 * cannot wait for it. At :20, clear of the backfill's default :15.
 */
const LIFECYCLE_CRON = "20 * * * *";

export function startSchedules(): Cron[] {
  const cfg = config();
  return [
    schedule("sweep", cfg.SWEEP_CRON, runSweep),
    schedule("backfill", cfg.BACKFILL_CRON, backfillAll),
    schedule("lifecycle", LIFECYCLE_CRON, () => lifecycleHourly(botClient())),
    ...scheduleReports(),
  ];
}
