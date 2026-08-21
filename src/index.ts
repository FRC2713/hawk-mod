import { config } from "./config.js";
import { db } from "./db/client.js";
import { startSchedules } from "./jobs/schedule.js";
import { log } from "./logger.js";
import { setting } from "./settings.js";
import { createApp } from "./slack/app.js";

async function main() {
  const cfg = config();
  db(); // opens the database and applies migrations before serving anything
  const app = createApp();
  await app.start(cfg.PORT);
  startSchedules();
  const students = setting("student-group");
  const mentors = setting("mentor-group");
  const alerts = setting("alert-channel");

  log.info("hawk-mod started", {
    port: cfg.PORT,
    logMode: cfg.LOG_MODE,
    installUrl: `${cfg.PUBLIC_URL}/slack/install`,
    // Silence here used to look identical to "the groups are empty". The
    // source matters as much as the value: "which group?" and "who set it?"
    // are the two questions asked when the roster looks wrong.
    roleSource:
      students.value || mentors.value
        ? `user groups (@${students.value ?? "-"} [${students.source}] / ` +
          `@${mentors.value ?? "-"} [${mentors.source}])`
        : "CSV import only — no user groups configured",
    alertChannel: alerts.value ? `${alerts.value} [${alerts.source}]` : "unset",
  });

  // A finding nobody is told about is the failure this project is built to
  // avoid, so an unset alert channel is an error at boot rather than a surprise
  // the first time something goes wrong.
  if (!alerts.value) {
    log.error("no alert channel configured; findings will not be announced", {
      fix: "/hawkmod config set alert-channel #channel",
    });
  }
}

main().catch((err) => {
  log.error("failed to start", { error: String(err) });
  process.exit(1);
});
