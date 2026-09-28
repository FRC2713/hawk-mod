import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { APP_ACTOR } from "../brand.js";
import { closeFinding } from "../close.js";
import {
  getFinding,
  personById,
  setPersonActive,
  setPersonRole,
} from "../db/repo.js";
import { groupsApplyAnyway, rosterFindingStillTrue } from "../lifecycle/run.js";
import { GROUPS, type GroupName } from "../domain/lifecycle/groups.js";
import { log } from "../logger.js";
import {
  ACK_ACTION,
  APPLY_ANYWAY_ACTION,
  END_MONITORING_ACTION,
  lifecycleAction,
  MAKE_ADULT_ACTION,
  RESOLVE_ACTION,
  refreshFinding,
} from "./alerts.js";
import { administrator } from "./authz.js";

const NOTE_MODAL = "hawkmod_finding_note";
const LIFECYCLE_MODAL = "hawkmod_lifecycle_change";
const NOTE_BLOCK = "note";

type Meta = {
  findingId: number;
  status: "acknowledged" | "resolved";
};

function noteView(findingId: number, status: Meta["status"], summary: string) {
  const verb = status === "resolved" ? "Resolve" : "Acknowledge";
  return {
    type: "modal" as const,
    callback_id: NOTE_MODAL,
    private_metadata: JSON.stringify({ findingId, status } satisfies Meta),
    title: { type: "plain_text" as const, text: `${verb} finding` },
    submit: { type: "plain_text" as const, text: verb },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "section" as const,
        text: { type: "mrkdwn" as const, text: `*#${findingId}* — ${summary}` },
      },
      {
        type: "context" as const,
        elements: [
          {
            type: "mrkdwn" as const,
            text:
              status === "resolved"
                ? "_Resolved means someone looked into it and it is dealt with._"
                : "_Acknowledged means seen, but not finished with._",
          },
        ],
      },
      {
        type: "input" as const,
        block_id: NOTE_BLOCK,
        label: { type: "plain_text" as const, text: "What happened?" },
        element: {
          type: "plain_text_input" as const,
          action_id: "value",
          multiline: true,
          placeholder: {
            type: "plain_text" as const,
            text: "Spoke to them; moved it to #build. Nothing concerning.",
          },
        },
      },
    ],
  };
}

/**
 * Buttons on the alert, rather than `/hawkmod resolve 14 <note>` typed from a
 * phone. The note stays mandatory: a finding closed without a reason tells the
 * quarterly review nothing, and "an audit right we never exercise is worth
 * nothing" applies just as well to one we exercise without writing anything
 * down.
 */
export function registerActions(app: App): void {
  for (const [actionId, status] of [
    [RESOLVE_ACTION, "resolved"],
    [ACK_ACTION, "acknowledged"],
  ] as const) {
    app.action(actionId, async ({ ack, body, client }) => {
      await ack();
      const payload = body as {
        user: { id: string };
        trigger_id?: string;
        actions?: { value?: string }[];
      };
      const findingId = Number(payload.actions?.[0]?.value);
      if (!Number.isInteger(findingId) || !payload.trigger_id) return;

      const caller = await administrator(client, payload.user.id);
      const finding = getFinding(findingId);
      if (!finding) return;

      // Anyone who can see the channel can click; only the people responsible
      // for youth protection may close.
      if (!caller) {
        await client.views.open({
          trigger_id: payload.trigger_id,
          view: {
            type: "modal",
            title: { type: "plain_text", text: "Not permitted" },
            close: { type: "plain_text", text: "Close" },
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "Only Slack workspace Owners and Admins can close findings.",
                },
              },
            ],
          },
        });
        return;
      }

      if (finding.status !== "open") {
        await refreshFinding(findingId);
        return;
      }

      await client.views.open({
        trigger_id: payload.trigger_id,
        view: noteView(findingId, status, finding.summary),
      });
    });
  }

  registerLifecycleActions(app);

  app.view(NOTE_MODAL, async ({ ack, body, view, client }) => {
    const caller = await administrator(client, body.user.id);
    if (!caller) {
      await ack({
        response_action: "errors",
        errors: {
          [NOTE_BLOCK]:
            "Only Slack workspace Owners and Admins can close findings.",
        },
      });
      return;
    }

    const { findingId, status } = JSON.parse(view.private_metadata) as Meta;
    const state = view.state as {
      values: Record<string, Record<string, { value?: string }>>;
    };
    const note = (state.values[NOTE_BLOCK]?.["value"]?.value ?? "").trim();
    if (!note) {
      await ack({
        response_action: "errors",
        errors: { [NOTE_BLOCK]: "A reason is required." },
      });
      return;
    }

    try {
      await ack();
      await closeFinding(findingId, caller.name, note, status);
      log.info("finding closed from Slack", {
        findingId,
        status,
        by: caller.name,
      });
    } catch (err) {
      log.error("could not close finding", { findingId, error: String(err) });
      await ack({
        response_action: "errors",
        errors: { [NOTE_BLOCK]: `Could not save: ${String(err)}` },
      });
    }
  });
}

/* ------------------------------------------------ lowering monitoring */

type LifecycleMeta = {
  findingId: number;
  action:
    | typeof END_MONITORING_ACTION
    | typeof MAKE_ADULT_ACTION
    | typeof APPLY_ANYWAY_ACTION;
  /** Where the button was, so the outcome can be told to the clicker there. */
  channel: string | null;
};

const NOT_PERMITTED = {
  type: "modal" as const,
  title: { type: "plain_text" as const, text: "Not permitted" },
  close: { type: "plain_text" as const, text: "Close" },
  blocks: [
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: "Only Slack workspace Owners and Admins can change who hawk-mod monitors.",
      },
    },
  ],
};

const VIEW_TEXT: Record<
  LifecycleMeta["action"],
  { title: string; explain: string; placeholder: string }
> = {
  [END_MONITORING_ACTION]: {
    title: "End monitoring",
    explain:
      "hawk-mod stops recording and checking this person's conversations. Recorded messages are kept. The lifecycle sheet is read again first, and nothing changes if it no longer says this.",
    placeholder: "Graduated in June; alumni are not monitored.",
  },
  [MAKE_ADULT_ACTION]: {
    title: "Make adult",
    explain:
      "Their DMs with students stop being treated as a student's. The lifecycle sheet is read again first, and nothing changes if it no longer says Mentor.",
    placeholder: "Former student, now a screened mentor.",
  },
  [APPLY_ANYWAY_ACTION]: {
    title: "Apply anyway",
    explain:
      "Applies this group's changes even though they remove more than a quarter of it, or empty it. The sheet and the group are read again first, and what differs then is applied — not what this alert said. Nobody who is leaving is removed.",
    placeholder: "The three RAs stepped down on 28 Sept; the sheet is right.",
  },
};

function lifecycleView(meta: LifecycleMeta, summary: string) {
  const text = VIEW_TEXT[meta.action];
  return {
    type: "modal" as const,
    callback_id: LIFECYCLE_MODAL,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text" as const, text: text.title },
    submit: { type: "plain_text" as const, text: text.title },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: `*#${meta.findingId}* — ${summary}`,
        },
      },
      {
        type: "context" as const,
        elements: [{ type: "mrkdwn" as const, text: `_${text.explain}_` }],
      },
      {
        type: "input" as const,
        block_id: NOTE_BLOCK,
        label: { type: "plain_text" as const, text: "Why?" },
        element: {
          type: "plain_text_input" as const,
          action_id: "value",
          multiline: true,
          placeholder: { type: "plain_text" as const, text: text.placeholder },
        },
      },
    ],
  };
}

/**
 * End monitoring and Make adult: the only buttons in hawk-mod that make it see
 * less. Each is gated on `administrator()` at the click and again at the
 * submit, demands a reason, re-reads the lifecycle sheet before acting, and
 * records the clicker in `role_changes`.
 */
function registerLifecycleActions(app: App): void {
  for (const action of [
    END_MONITORING_ACTION,
    MAKE_ADULT_ACTION,
    APPLY_ANYWAY_ACTION,
  ] as const) {
    app.action(action, async ({ ack, body, client }) => {
      await ack();
      const payload = body as {
        user: { id: string };
        trigger_id?: string;
        channel?: { id?: string };
        actions?: { value?: string }[];
      };
      const findingId = Number(payload.actions?.[0]?.value);
      if (!Number.isInteger(findingId) || !payload.trigger_id) return;

      const caller = await administrator(client, payload.user.id);
      if (!caller) {
        await client.views.open({
          trigger_id: payload.trigger_id,
          view: NOT_PERMITTED,
        });
        return;
      }
      const finding = getFinding(findingId);
      if (!finding) return;
      if (
        finding.status === "resolved" ||
        lifecycleAction(finding)?.actionId !== action
      ) {
        await refreshFinding(findingId);
        return;
      }
      await client.views.open({
        trigger_id: payload.trigger_id,
        view: lifecycleView(
          { findingId, action, channel: payload.channel?.id ?? null },
          finding.summary
        ),
      });
    });
  }

  app.view(LIFECYCLE_MODAL, async ({ ack, body, view, client }) => {
    const caller = await administrator(client, body.user.id);
    if (!caller) {
      await ack({
        response_action: "errors",
        errors: {
          [NOTE_BLOCK]:
            "Only Slack workspace Owners and Admins can change who hawk-mod monitors.",
        },
      });
      return;
    }
    const meta = JSON.parse(view.private_metadata) as LifecycleMeta;
    const state = view.state as {
      values: Record<string, Record<string, { value?: string }>>;
    };
    const note = (state.values[NOTE_BLOCK]?.["value"]?.value ?? "").trim();
    if (!note) {
      await ack({
        response_action: "errors",
        errors: { [NOTE_BLOCK]: "A reason is required." },
      });
      return;
    }
    // Re-reading the sheet takes longer than Slack waits for a modal, so the
    // modal closes now and the outcome is told to the clicker afterwards.
    await ack();
    let outcome: string;
    try {
      outcome = await applyLifecycleAction(client, meta, caller, note);
    } catch (err) {
      log.error("lifecycle action failed", {
        findingId: meta.findingId,
        error: String(err),
      });
      outcome = `Nothing was changed: ${String(err)}`;
    }
    await tell(client, meta.channel, body.user.id, outcome);
  });
}

async function applyLifecycleAction(
  client: WebClient,
  meta: LifecycleMeta,
  caller: { slackUserId: string; name: string },
  note: string
): Promise<string> {
  const by = caller.name;
  const finding = getFinding(meta.findingId);
  if (!finding || finding.status === "resolved") {
    return `Finding #${meta.findingId} is already closed; nothing was changed.`;
  }
  if (lifecycleAction(finding)?.actionId !== meta.action) {
    return `Finding #${meta.findingId} does not offer that; nothing was changed.`;
  }

  if (meta.action === APPLY_ANYWAY_ACTION) {
    const group = finding.subject_ref as GroupName;
    if (!GROUPS.includes(group)) {
      return `Finding #${finding.id} names no known group; nothing was changed.`;
    }
    const outcome = await groupsApplyAnyway({
      group,
      actor: caller,
      reason: note,
    });
    // Closed only when something was applied or nothing was left to apply;
    // a group held for another reason keeps its alert.
    if (!outcome.startsWith("Nothing was applied")) {
      await closeFinding(finding.id, by, `Applied anyway: ${note}`);
    }
    log.info("groups applied anyway", { findingId: finding.id, group, by });
    return `${group}: ${outcome}`;
  }
  const person =
    finding.subject_person_id === null
      ? undefined
      : personById(finding.subject_person_id);
  if (!person) return "That roster row no longer exists; nothing was changed.";

  const ending = meta.action === END_MONITORING_ACTION;
  // Already done some other way — by `/hawkmod deactivate`, say.
  if (ending ? person.active !== 1 : person.role !== "student") {
    await closeFinding(finding.id, by, `Already done: ${note}`);
    return `${person.full_name} was already ${ending ? "not monitored" : "an adult"}; the finding is closed.`;
  }

  if (!(await rosterFindingStillTrue(client, finding.dedupe_key))) {
    await closeFinding(
      finding.id,
      APP_ACTOR,
      "No longer true on the lifecycle sheet."
    );
    return (
      `The lifecycle sheet no longer says this about ${person.full_name}, so ` +
      `nothing was changed and the finding is closed.`
    );
  }

  if (ending) {
    setPersonActive({
      personId: person.id,
      active: false,
      source: "lifecycle_click",
      actor: by,
      reason: note,
    });
  } else {
    setPersonRole({
      personId: person.id,
      toRole: "adult",
      source: "lifecycle_click",
      detail: { actor: by, reason: note, personId: person.person_id },
    });
  }
  await closeFinding(
    finding.id,
    by,
    `${ending ? "Ended monitoring" : "Made adult"}: ${note}`
  );
  log.info("lifecycle action applied", {
    findingId: finding.id,
    action: meta.action,
    by,
  });
  return ending
    ? `${person.full_name} is no longer monitored. Recorded against your name, with your reason.`
    : `${person.full_name} is now an adult on the roster. Recorded against your name, with your reason.`;
}

async function tell(
  client: WebClient,
  channel: string | null,
  user: string,
  text: string
): Promise<void> {
  try {
    if (channel) await client.chat.postEphemeral({ channel, user, text });
    else await client.chat.postMessage({ channel: user, text });
  } catch (err) {
    log.warn("could not report a lifecycle action", { error: String(err) });
  }
}
