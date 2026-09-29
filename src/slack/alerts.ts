import { getFinding, setFindingAlertTs } from "../db/repo.js";
import type { Finding } from "../domain/findings.js";
import { severityEmoji } from "../domain/findings.js";
import { log } from "../logger.js";
import { onboardingChannel, settingValue } from "../settings.js";
import {
  inviteAddressLine,
  isOnboardingKind,
  ONBOARDING_CLOSES_WHEN,
} from "../domain/lifecycle/onboardingFindings.js";
import { botClient } from "./tokens.js";

/**
 * Where findings go, or `null` if nobody has said.
 *
 * Unset is not a quiet state. A finding with nowhere to be announced is
 * recorded and invisible, which is the exact failure this project defines
 * itself against — so every attempt to use it logs at error level, naming the
 * finding that is going unreported and the command that fixes it. `/hawkmod
 * config` shows it too, and so does startup.
 */
function alertChannel(context: string): string | null {
  const channel = settingValue("alert-channel");
  if (!channel) {
    log.error("no alert channel configured; nobody is being told", {
      context,
      fix: "/hawkmod config set alert-channel #channel",
    });
    return null;
  }
  return channel;
}

/**
 * Where a finding is posted: onboarding requests to `onboarding-channel` (the
 * alert channel while that is unset), everything else to the alert channel.
 */
function postingChannel(f: Pick<Finding, "id" | "kind">): string | null {
  if (!isOnboardingKind(f.kind)) return alertChannel(`finding ${f.id}`);
  const { channel } = onboardingChannel();
  if (!channel) {
    log.error(
      "no onboarding or alert channel configured; nobody is being asked",
      {
        context: `finding ${f.id}`,
        fix: "/hawkmod config set onboarding-channel #channel",
      }
    );
    return null;
  }
  return channel;
}

/** Where a posted finding's message is: where it was posted. */
function postedChannel(f: Finding): string | null {
  return f.alert_channel ?? alertChannel(`finding ${f.id}`);
}

/** Whether a held-member finding's detail lists any group, Google or Slack. */
function inAnyGroup(detail: string | null | undefined): boolean {
  // No detail is an older row, from before step 6: those were always groups.
  if (!detail) return true;
  const d = JSON.parse(detail) as { entries?: unknown[]; slack?: unknown[] };
  return Boolean(d.entries?.length || d.slack?.length);
}

export const ACK_ACTION = "hawkmod_finding_ack";
export const ONBOARDING_ON_IT_ACTION = "hawkmod_onboarding_on_it";
export const RESOLVE_ACTION = "hawkmod_finding_resolve";
export const END_MONITORING_ACTION = "hawkmod_end_monitoring";
export const MAKE_ADULT_ACTION = "hawkmod_make_adult";
export const APPLY_ANYWAY_ACTION = "hawkmod_groups_apply_anyway";
export const REMOVE_FROM_GROUPS_ACTION = "hawkmod_remove_from_groups";
export const SLACK_APPLY_ACTION = "hawkmod_slack_groups_apply";
export const SLACK_APPLY_ANYWAY_ACTION = "hawkmod_slack_groups_apply_anyway";

/**
 * The one change a lifecycle finding asks a person to make, if it asks one.
 * End monitoring and Make adult are the only clicks that lower monitoring;
 * Remove from groups the only one that takes someone out of a Google Group
 * they are leaving; Apply anyway the only override of a groups refusal. The user-group
 * sync's old `roster_drift` records a move already made, and offers nothing.
 */
export function lifecycleAction(
  f: Pick<Finding, "kind" | "dedupe_key"> & { detail?: string | null }
): {
  actionId: string;
  label: string;
  /**
   * An everyday change rather than one that takes something away: shown
   * green, with no Acknowledge beside it — acknowledging would hide Apply
   * while what it applies is still true — and its note is optional.
   */
  routine?: true;
  /** What the alert's footer says about the button, when not the default. */
  context?: string;
} | null {
  // An onboarding request is done by doing it, outside hawk-mod; the run
  // closes it when the sheet or Slack shows it. The button only says who
  // has it, so two people do not both create one account.
  if (isOnboardingKind(f.kind)) {
    return {
      actionId: ONBOARDING_ON_IT_ACTION,
      label: "I'm on it",
      routine: true,
      context: ONBOARDING_CLOSES_WHEN[f.kind],
    };
  }
  // Every Slack group change is a click (step 5). Apply is the routine one;
  // Apply anyway, for a refused copy, is the override.
  if (f.kind === "slack_groups_differ") {
    if (f.dedupe_key === "slack_groups_differ") {
      return { actionId: SLACK_APPLY_ACTION, label: "Apply", routine: true };
    }
    if (f.dedupe_key.startsWith("slack_groups_differ:refused:")) {
      return { actionId: SLACK_APPLY_ANYWAY_ACTION, label: "Apply anyway" };
    }
    return null;
  }
  if (f.kind === "sheet_undeclared") {
    return { actionId: END_MONITORING_ACTION, label: "End monitoring" };
  }
  if (
    f.kind === "roster_drift" &&
    f.dedupe_key.startsWith("roster_drift:sheet:")
  ) {
    return { actionId: MAKE_ADULT_ACTION, label: "Make adult" };
  }
  if (f.kind === "group_member_held") {
    return { actionId: REMOVE_FROM_GROUPS_ACTION, label: "Remove from groups" };
  }
  if (f.kind === "cori_lapsed") {
    // A mentor held nowhere but in Slack itself has no group to be removed
    // from, and hawk-mod cannot deactivate a Slack account: that alert asks
    // a person to, and offers Acknowledge and Resolve like any other.
    return inAnyGroup(f.detail)
      ? {
          actionId: REMOVE_FROM_GROUPS_ACTION,
          label: "Remove from mentor groups",
        }
      : null;
  }
  // Only a refused plan: a wrong group or a missing one is fixed in the code
  // or in Google, and nothing should offer to apply past it.
  if (
    f.kind === "google_group_held" &&
    f.dedupe_key.startsWith("google_group_held:refused:")
  ) {
    return { actionId: APPLY_ANYWAY_ACTION, label: "Apply anyway" };
  }
  return null;
}

/**
 * One renderer for both the first post and every later update, so a finding
 * that has been closed never keeps offering buttons that no longer apply.
 *
 * Alerts name participants and conversations. They never carry message text —
 * the alert channel is a place to be told something needs a look, not a feed
 * of students' messages. Content stays in the database, behind the CLI.
 */
export function findingBlocks(f: Finding): {
  text: string;
  blocks: unknown[];
} {
  const headline = `${severityEmoji(f.severity)} *${f.kind}* — ${f.summary}`;
  const blocks: unknown[] = [
    // verbatim: Slack otherwise turns a plain "@students" in a summary into
    // a live mention of the whole group. Findings name groups; they must
    // never ping one.
    {
      type: "section",
      text: { type: "mrkdwn", text: headline, verbatim: true },
    },
  ];
  // Only on the posted request, in the onboarding channel: never in the
  // summary, which `/hawkmod findings` prints wherever it is run.
  const address = f.status === "open" ? inviteAddressLine(f) : null;
  if (address) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: address, verbatim: true },
    });
  }

  const lifecycle = lifecycleAction(f);
  if (f.status === "open") {
    blocks.push({
      type: "actions",
      elements: [
        // A roster finding is closed by doing what it asks, or by the sheet
        // changing. "Resolve" without either would only reopen on the next run.
        lifecycle
          ? {
              type: "button",
              action_id: lifecycle.actionId,
              style: lifecycle.routine ? "primary" : "danger",
              text: { type: "plain_text", text: lifecycle.label },
              value: String(f.id),
            }
          : {
              type: "button",
              action_id: RESOLVE_ACTION,
              style: "primary",
              text: { type: "plain_text", text: "Resolve" },
              value: String(f.id),
            },
        ...(lifecycle?.routine
          ? []
          : [
              {
                type: "button",
                action_id: ACK_ACTION,
                text: { type: "plain_text", text: "Acknowledge" },
                value: String(f.id),
              },
            ]),
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `finding #${f.id}` +
            (f.subject_ref ? ` · \`${f.subject_ref}\`` : "") +
            (lifecycle?.context
              ? ` · ${lifecycle.context}`
              : lifecycle?.routine
                ? ` · ${lifecycle.label} re-reads the lifecycle sheet first and changes Slack as you`
                : lifecycle
                  ? ` · ${lifecycle.label} asks for a reason and re-reads the lifecycle sheet first`
                  : " · both ask for a reason, which the quarterly audit reads"),
        },
      ],
    });
  } else {
    const verb = f.status === "resolved" ? "Resolved" : "Acknowledged";
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `finding #${f.id} · *${verb}* by ${f.resolved_by ?? "unknown"}` +
            (f.resolved_at ? ` on ${f.resolved_at.slice(0, 10)}` : "") +
            (f.resolution_note ? ` — _${f.resolution_note}_` : ""),
        },
      ],
    });
  }

  return { text: headline, blocks };
}

/**
 * Redraws the message a recurrence has replaced. A finding that has happened
 * again gets a *new* alert rather than an edit — an edit to an old message is
 * not seen, and the point of a recurrence is to be seen — but leaving the old
 * one saying "Resolved by …" above a live recurrence is how a channel stops
 * being believed.
 */
async function supersede(
  previousTs: string,
  previousChannel: string | null,
  finding: Finding
): Promise<void> {
  try {
    const channel = previousChannel ?? alertChannel("supersede");
    if (!channel) return;
    await botClient().chat.update({
      channel,
      ts: previousTs,
      text: `${severityEmoji(finding.severity)} ${finding.kind} — happened again`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${severityEmoji(finding.severity)} *${finding.kind}* — ${finding.summary}`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text:
                `finding #${finding.id} · this was closed and *has happened ` +
                `again* — see the newer alert in this channel`,
            },
          ],
        },
      ] as never,
    });
  } catch (err) {
    log.warn("could not supersede the previous alert", {
      findingId: finding.id,
      error: String(err),
    });
  }
}

export async function postFinding(findingId: number): Promise<void> {
  const finding = getFinding(findingId);
  if (!finding) return;
  const previousTs = finding.alert_ts;
  const previousChannel = finding.alert_channel;
  const { text, blocks } = findingBlocks(finding);
  try {
    const channel = postingChannel(finding);
    if (!channel) return;
    const res = await botClient().chat.postMessage({
      channel,
      text,
      blocks: blocks as never,
    });
    if (!res.ts) return;
    setFindingAlertTs(findingId, res.ts, channel);
    // Only once the replacement is actually in the channel: if the post failed,
    // the old message is the only one there and must keep its buttons.
    if (previousTs && previousTs !== res.ts)
      await supersede(previousTs, previousChannel, finding);
  } catch (err) {
    // A failed alert must not abort the sweep; the finding is already durable.
    log.error("could not post finding", { findingId, error: String(err) });
  }
}

/** Redraws a finding's message in place — used after it is closed. */
export async function refreshFinding(findingId: number): Promise<void> {
  const finding = getFinding(findingId);
  if (!finding?.alert_ts) return;
  const { text, blocks } = findingBlocks(finding);
  try {
    const channel = postedChannel(finding);
    if (!channel) return;
    await botClient().chat.update({
      channel,
      ts: finding.alert_ts,
      text,
      blocks: blocks as never,
    });
  } catch (err) {
    log.warn("could not update finding message", {
      findingId,
      error: String(err),
    });
  }
}

/** `text` is the notification fallback when `blocks` carry the real layout. */
export async function postToAlertChannel(
  text: string,
  blocks?: unknown[]
): Promise<void> {
  try {
    const channel = alertChannel("digest");
    if (!channel) return;
    await botClient().chat.postMessage({
      channel,
      text,
      ...(blocks ? { blocks: blocks as never } : {}),
    });
  } catch (err) {
    log.error("could not post to alert channel", { error: String(err) });
  }
}
