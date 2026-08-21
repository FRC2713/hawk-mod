import { APP_NAME } from "../brand.js";
import type {
  Installation,
  InstallationQuery,
  InstallationStore,
} from "@slack/bolt";
import { log } from "../logger.js";
import {
  BOT_USER_KEY,
  deleteInstallation,
  getInstallation,
  personBySlackId,
  saveInstallation,
} from "../db/repo.js";

function teamKey(
  q: InstallationQuery<boolean> | Installation<"v1" | "v2", boolean>
): string {
  const anyQ = q as {
    teamId?: string;
    enterpriseId?: string;
    team?: { id: string };
    enterprise?: { id: string };
  };
  const id =
    anyQ.teamId ?? anyQ.team?.id ?? anyQ.enterpriseId ?? anyQ.enterprise?.id;
  if (!id) throw new Error("Installation has neither team nor enterprise id");
  return id;
}

/** Marks an authorization that came from the group-editing flow. */
export const GROUP_ADMIN_METADATA = "group-admin";

/**
 * Three kinds of row live here:
 *
 *   'bot'   — one per workspace, installed once by a workspace admin. Posts alerts.
 *   'user'  — one per enrolled adult, holding that adult's user token. This is
 *             what lets hawk-mod see DMs at all; Slack exposes no other way to
 *             read them below Enterprise Grid.
 *   'admin' — one per administrator who authorized group editing, holding a
 *             token scoped to `usergroups:write` and nothing else.
 *
 * A fetch merges bot and user so a single event can carry both a bot token (to
 * reply) and the observing adult's user token (to read the conversation).
 * 'admin' rows are deliberately *not* part of that merge: they are fetched by
 * name, by the one code path that edits groups, and never ride along on
 * anything else.
 *
 * The reason 'admin' is a separate row rather than extra scopes on 'user' is
 * that Slack issues one token per authorization carrying only the scopes
 * granted at that moment. An administrator who is also an enrolled mentor would
 * otherwise have their DM token overwritten the first time they authorized
 * group editing, ending their monitoring while coverage still read 100%.
 */
export const installationStore: InstallationStore = {
  async storeInstallation(installation) {
    const teamId = teamKey(installation);
    const enterpriseId = installation.enterprise?.id ?? null;

    if (installation.bot) {
      saveInstallation({
        teamId,
        enterpriseId,
        slackUserId: BOT_USER_KEY,
        kind: "bot",
        payload: installation,
        scopes: (installation.bot.scopes ?? []).join(","),
      });
    }

    if (installation.user?.token) {
      // The group-editing grant is a different consent for a different purpose
      // and gets its own row. Critically it must not fall through to the
      // enrolment branch below, which would overwrite a mentor's DM token.
      if (installation.metadata === GROUP_ADMIN_METADATA) {
        saveInstallation({
          teamId,
          enterpriseId,
          slackUserId: installation.user.id,
          kind: "admin",
          payload: installation,
          scopes: (installation.user.scopes ?? []).join(","),
        });
        log.info("administrator authorized group editing", {
          user: installation.user.id,
          teamId,
        });
        return;
      }

      // Enrolling grants hawk-mod that account's DM history. For a student
      // that would expose student-to-student conversations, which are
      // deliberately never recorded — so the enrolment is refused outright
      // rather than stored and filtered later.
      const person = personBySlackId(installation.user.id);
      if (person?.role === "student") {
        log.warn("refused enrolment by a student", {
          user: installation.user.id,
          person: person.full_name,
        });
        throw new Error(
          `Students cannot authorize ${APP_NAME}; it would expose their DMs with other students.`
        );
      }
      saveInstallation({
        teamId,
        enterpriseId,
        slackUserId: installation.user.id,
        kind: "user",
        payload: installation,
        scopes: (installation.user.scopes ?? []).join(","),
      });
      log.info("adult enrolled", { user: installation.user.id, teamId });
    }
  },

  async fetchInstallation(query) {
    const teamId = teamKey(query);
    const bot = getInstallation(teamId, "bot", BOT_USER_KEY);
    const user = query.userId
      ? getInstallation(teamId, "user", query.userId)
      : undefined;

    if (!bot && !user) {
      throw new Error(`No installation for team ${teamId}`);
    }

    const base = (bot?.payload ?? user!.payload) as unknown as Installation;
    if (!user) {
      // Bot-only context: strip any user token that rode along on the bot row,
      // so a adult's token is never handed to a request that did not ask for
      // that adult.
      return {
        ...base,
        user: {
          id: query.userId ?? base.user.id,
          token: undefined,
          scopes: undefined,
        },
      } as Installation;
    }

    const userPayload = user.payload as unknown as Installation;
    return { ...base, user: userPayload.user } as Installation;
  },

  async deleteInstallation(query) {
    const teamId = teamKey(query);
    if (query.userId) {
      deleteInstallation(teamId, "user", query.userId);
      return;
    }
    deleteInstallation(teamId, "bot", BOT_USER_KEY);
  },
};
