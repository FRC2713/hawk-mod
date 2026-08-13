import type { WebClient } from "@slack/web-api";
import { APP_NAME } from "../brand.js";
import { personBySlackId } from "../db/repo.js";
import type { Person } from "../domain/people.js";
import { log } from "../logger.js";

/**
 * Who may administer hawk-mod: Slack's own Workspace Owners and Admins, read
 * live from `users.info`.
 *
 * This used to be a roster role. That was a second, hand-maintained copy of a
 * fact Slack already knows, and it had a worse failure mode than being merely
 * redundant: a fresh install had an empty roster, so *nobody* could run
 * `/hawkmod`, and the only way out was a shell on the host running the CLI.
 * An app whose first-run instruction is "SSH into the server" is broken.
 * Whoever can install the app can now use it.
 *
 * The roster still says who is a student, who is an adult, and who has been
 * screened. It no longer says who is in charge.
 */
export const NOT_PERMITTED = `${APP_NAME} is limited to Slack workspace Owners and Admins.`;

export type Actor = {
  slackUserId: string;
  /** Roster name where there is one, Slack's profile name otherwise. */
  name: string;
  /** The roster row, when this person has one. Admins need not be on it. */
  person: Person | undefined;
};

/**
 * Long enough that a burst of button clicks is one API call, short enough that
 * revoking someone's Slack admin revokes their access to findings within a
 * minute. Promotions are picked up just as fast, which matters on first run.
 */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; actor: Actor | null }>();

/** Only for tests, and for the rare caller that must not see a stale verdict. */
export function forgetAuthorization(slackUserId?: string): void {
  if (slackUserId) cache.delete(slackUserId);
  else cache.clear();
}

type Deps = {
  now?: number;
  /** Injected by the tests so this module can be exercised without a database. */
  lookup?: (slackUserId: string) => Person | undefined;
};

/**
 * Resolves the caller if they may administer hawk-mod, `null` if they may not.
 *
 * Fails closed: a Slack API error denies the action rather than allowing it.
 * Findings name students and describe conduct concerns, so the cost of a
 * wrongly-allowed read is much higher than the cost of a retry.
 */
export async function administrator(
  client: WebClient,
  slackUserId: string,
  deps: Deps = {}
): Promise<Actor | null> {
  const now = deps.now ?? Date.now();
  const hit = cache.get(slackUserId);
  if (hit && now - hit.at < TTL_MS) return hit.actor;

  const actor = await resolve(
    client,
    slackUserId,
    deps.lookup ?? personBySlackId
  );
  cache.set(slackUserId, { at: now, actor });
  return actor;
}

async function resolve(
  client: WebClient,
  slackUserId: string,
  lookup: (slackUserId: string) => Person | undefined
): Promise<Actor | null> {
  let user;
  try {
    user = (await client.users.info({ user: slackUserId })).user;
  } catch (err) {
    log.error("could not read caller from Slack; denying", {
      slackUserId,
      error: String(err),
    });
    return null;
  }
  if (!user || user.deleted || user.is_bot) return null;

  const person = lookup(slackUserId);

  // §6: a student must never hold Owner or Admin. The sweep raises that as a
  // violation, but the finding is written to a channel this student could then
  // read. Refusing here means the workspace being misconfigured for an hour
  // does not also hand a minor the youth-protection case file.
  if (person?.role === "student") {
    log.warn("student holds workspace admin; refused", {
      slackUserId,
      person: person.email,
    });
    return null;
  }

  if (!(user.is_admin || user.is_owner || user.is_primary_owner)) return null;

  return {
    slackUserId,
    name:
      person?.full_name ??
      user.profile?.real_name ??
      user.real_name ??
      user.name ??
      slackUserId,
    person,
  };
}
