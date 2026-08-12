import { config } from "./config.js";
import { db } from "./db/client.js";
import { startSchedules } from "./jobs/schedule.js";
import { log } from "./logger.js";
import { createApp } from "./slack/app.js";

async function main() {
  const cfg = config();
  db(); // opens the database and applies migrations before serving anything
  const app = createApp();
  await app.start(cfg.PORT);
  startSchedules();
  log.info("hawk-mod started", {
    port: cfg.PORT,
    logMode: cfg.LOG_MODE,
    installUrl: `${cfg.PUBLIC_URL}/slack/install`,
  });
}

main().catch((err) => {
  log.error("failed to start", { error: String(err) });
  process.exit(1);
});
