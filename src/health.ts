import type { ServerResponse } from "node:http";
import { db } from "./db/client.js";
import { anyBotInstallation, listUserInstallations } from "./db/repo.js";

type Health = {
  status: "ok" | "error";
  installed: boolean;
  enrolledAdults: number;
  error?: string;
};

/**
 * Liveness/readiness probe for the container. Touches SQLite so an unwritable
 * or unmigrated volume shows up as unhealthy here rather than as failures
 * later, when the failing thing would be a DM nobody recorded.
 *
 * `installed: false` is not unhealthy — a freshly deployed container is
 * expected to be running and waiting for an admin to install the app.
 */
export function healthHandler(_req: unknown, res: ServerResponse): void {
  let body: Health;
  let code: number;
  try {
    db().prepare("SELECT 1").get();
    body = {
      status: "ok",
      installed: anyBotInstallation() !== undefined,
      enrolledAdults: listUserInstallations().length,
    };
    code = 200;
  } catch (error) {
    body = {
      status: "error",
      installed: false,
      enrolledAdults: 0,
      error: error instanceof Error ? error.message : "unknown error",
    };
    code = 503;
  }
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
