import type { App } from "@slack/bolt";
import { getFinding, personBySlackId, resolveFinding } from "../db/repo.js";
import { mayAdministerWorkspace } from "../domain/people.js";
import { log } from "../logger.js";
import { ACK_ACTION, RESOLVE_ACTION, refreshFinding } from "./alerts.js";

const NOTE_MODAL = "hawkmod_finding_note";
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

      const caller = personBySlackId(payload.user.id);
      const finding = getFinding(findingId);
      if (!finding) return;

      // Anyone who can see the channel can click; only the people responsible
      // for youth protection may close.
      if (!caller || !mayAdministerWorkspace(caller)) {
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
                  text: "Only Lead Coaches and workspace admins can close findings.",
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

  app.view(NOTE_MODAL, async ({ ack, body, view }) => {
    const caller = personBySlackId(body.user.id);
    if (!caller || !mayAdministerWorkspace(caller)) {
      await ack({
        response_action: "errors",
        errors: {
          [NOTE_BLOCK]: "Only Lead Coaches and admins can close findings.",
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
      resolveFinding(findingId, caller.full_name, note, status);
      await ack();
      await refreshFinding(findingId);
      log.info("finding closed from Slack", {
        findingId,
        status,
        by: caller.full_name,
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
