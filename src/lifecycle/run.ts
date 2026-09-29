import type { WebClient } from "@slack/web-api";
import { today } from "../domain/dates.js";
import { planLifecycle, type LifecyclePlan } from "../domain/lifecycle/plan.js";
import { planRoster } from "../domain/lifecycle/roster.js";
import { formatRosterPlan } from "../domain/lifecycle/rosterReport.js";
import { parseSheet } from "../domain/lifecycle/sheet.js";
import {
  planSlackIds,
  type SlackIdDecision,
} from "../domain/lifecycle/slackIds.js";
import {
  googleActor,
  googleEnv,
  serviceAccountClient,
} from "../google/credentials.js";
import {
  addMember,
  DIRECTORY_GROUP_MEMBER,
  DIRECTORY_GROUP_READONLY,
  readGroup,
  removeMember,
} from "../google/directory.js";
import {
  CORI_EXPIRING_PREFIX,
  coriExpiringFinding,
  coriExpiringSoon,
  coriReminderText,
} from "../domain/lifecycle/cori.js";
import {
  HELD_MEMBER_PREFIXES,
  heldMemberFinding,
  heldSubjects,
} from "../domain/lifecycle/heldMembers.js";
import type { GroupPlanResult } from "../domain/lifecycle/groupPlan.js";
import {
  decideGroups,
  failedFinding,
  runFailedFinding,
  GROUP_HELD_PREFIX,
  heldFinding,
  raAnnouncement,
  type GroupDecision,
} from "../domain/lifecycle/groupApply.js";
import { applyGroupDecisions, type GroupApplyResult } from "./applyGroups.js";
import { postToAlertChannel } from "../slack/alerts.js";
import { planGoogleGroups } from "../domain/lifecycle/groupPlan.js";
import {
  formatGroupPlans,
  type FoundGroup,
  type MissingGroup,
} from "../domain/lifecycle/groupReport.js";
import {
  GOOGLE_GROUP_IDS,
  GROUPS,
  type GroupName,
} from "../domain/lifecycle/groups.js";
import {
  fillBlankCells,
  readLifecycleSheet,
  SHEETS_READONLY,
  SHEETS_READWRITE,
} from "../google/sheets.js";
import { APP_ACTOR } from "../brand.js";
import { closeFinding } from "../close.js";
import {
  findingByKey,
  finishAuditRun,
  GROUPS_RUN,
  insertGroupChange,
  listPeople,
  resolveMissingWithPrefix,
  rosterCutoverDone,
  runEverFinished,
  startAuditRun,
} from "../db/repo.js";
import {
  ROSTER_FINDING_PREFIXES,
  rosterFinding,
  rosterFindingKey,
  UNREADABLE_KEY,
  unreadableFinding,
} from "../domain/lifecycle/rosterFindings.js";
import { raise } from "../raise.js";
import { refreshFinding } from "../slack/alerts.js";
import { applyRosterChanges } from "./applyRoster.js";
import { log } from "../logger.js";
import { fetchWorkspaceUsers } from "../slack/roster.js";
import { botClient } from "../slack/tokens.js";
import {
  decideSlackCopies,
  membershipAfter,
  planSlackCopies,
  SLACK_COPIES,
  SLACK_DIFFER_PREFIX,
  SLACK_GROUP_IDS,
  slackCheckFailedFinding,
  slackDifferFinding,
  slackHeldFinding,
  type FoundSlackGroup,
  type SlackCopy,
  type SlackMember,
} from "../domain/lifecycle/slackGroups.js";
import type { NewFinding } from "../domain/findings.js";
import { withGroupEditor } from "../slack/groupAdmin.js";
import {
  formatSlackCopies,
  type ReadCopy,
} from "../domain/lifecycle/slackGroupReport.js";
import {
  channelLabel,
  groupMembers,
  listUserGroups,
  setGroupMembership,
} from "../slack/userGroups.js";

/**
 * The lifecycle commands, once, for both doors: the CLI prints what these
 * return, and `/hawkmod lifecycle` posts it. Production has no shell anyone
 * logs into, so Slack is the door that matters there; keeping one
 * implementation means the dry run seen in Slack is the dry run that was
 * tested from a laptop.
 *
 * Output names Person IDs, rows and counts, never a name or an address — it is
 * posted into Slack, and most of the people in it are minors. The CLI's
 * `--members` is the one exception, and Slack never offers it.
 */

function requireGoogle() {
  const env = googleEnv();
  if (!env) {
    throw new Error(
      "Google is not configured: set GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 (or " +
        "GOOGLE_SERVICE_ACCOUNT_KEY_FILE). See docs/google-setup.md."
    );
  }
  if (!env.sheetId) throw new Error("LIFECYCLE_SHEET_ID is not set");
  return { ...env, sheetId: env.sheetId };
}

function formatPlan(plan: LifecyclePlan, members: boolean): string {
  const { people } = plan;
  const count = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
  const lines = [
    `Lifecycle plan as of ${plan.asOf} (dry run: nothing changed)`,
    "",
    `People: ${people.total} (${count(people.byStatus)})`,
    `Roles:  ${count(people.byRole)}`,
    "",
    "Groups, as the sheet computes them:",
  ];
  for (const g of plan.groups) {
    lines.push(`  ${g.name.padEnd(18)} ${g.members.length}`);
    if (members) for (const m of g.members) lines.push(`      ${m}`);
  }
  if (plan.noAccess.length) {
    lines.push(
      "",
      "Active mentors without CORI current (join no group; not invited to Slack):"
    );
    for (const m of plan.noAccess) lines.push(`  ${m.personId}: ${m.why}`);
  }
  if (plan.notCleared.length) {
    lines.push(
      "",
      "Active mentors not screened (do not count toward the two-adult rule):"
    );
    for (const m of plan.notCleared) {
      lines.push(`  ${m.personId}: ${m.missing.join(", ")}`);
    }
  }
  if (plan.noAddress.length) {
    lines.push("", `No email to add to groups: ${plan.noAddress.join(", ")}`);
  }
  if (plan.noParentEmail.length) {
    lines.push(
      "",
      `Active students with no parent email for grp-parents: ${plan.noParentEmail.join(", ")}`
    );
  }
  lines.push("", `Sheet problems: ${plan.problems.length}`);
  for (const p of plan.problems) {
    const where = p.row ? `${p.tab} row ${p.row}` : p.tab;
    lines.push(
      `  ${where}${p.personId ? `, ${p.personId}` : ""}: ${p.message}`
    );
  }
  return lines.join("\n");
}

/** Reads the sheet and describes it. Changes nothing, anywhere. */
export async function lifecyclePlanReport(
  opts: { members?: boolean } = {}
): Promise<string> {
  const env = requireGoogle();
  const client = serviceAccountClient(env, [SHEETS_READONLY]);
  const data = await readLifecycleSheet(client, env.sheetId);
  return formatPlan(
    planLifecycle(parseSheet(data), today()),
    opts.members ?? false
  );
}

/** Everything a roster plan is made from, read fresh. */
async function readRosterInputs(slack: WebClient) {
  const env = requireGoogle();
  const client = serviceAccountClient(env, [SHEETS_READONLY]);
  const parsed = parseSheet(await readLifecycleSheet(client, env.sheetId));
  const accounts = (await fetchWorkspaceUsers(slack)).map((u) => ({
    id: u.id,
    email: u.email,
    live: !u.isBot && !u.isDeleted,
  }));
  const roster = listPeople(false);
  const plan = planRoster({
    roster,
    sheet: parsed.people,
    accounts,
    firstApply: !rosterCutoverDone(),
  });
  return { parsed, roster, plan };
}

/**
 * Step 3: the roster from the sheet. A dry run unless `apply`; both plan the
 * same way and print the same text, so what an administrator read is what
 * gets applied.
 *
 * Applying writes every change or none, then raises what the plan asks a
 * person about and closes whatever it no longer sees. A refused plan changes
 * nothing. So does a sheet that cannot be read — and once the roster comes
 * from the sheet, that is itself a finding, because a roster that silently
 * stops updating is one that silently stops adding new students.
 */
export async function rosterReport(opts: {
  slack: WebClient;
  apply: boolean;
  /** How to ask for the apply, in the words of the door being used. */
  applyHint: string;
  /** Who asked, for the log. */
  by: string;
}): Promise<string> {
  let inputs;
  try {
    inputs = await readRosterInputs(opts.slack);
  } catch (err) {
    if (opts.apply && rosterCutoverDone()) {
      await raise(unreadableFinding(errorText(err)));
    }
    throw err;
  }
  const { parsed, roster, plan } = inputs;
  const text = formatRosterPlan({
    plan,
    roster,
    sheetProblems: parsed.problems.length,
    dryRun: !opts.apply,
  });

  if (!opts.apply) {
    const anything = plan.changes.length || plan.findings.length;
    return plan.refused || !anything
      ? text
      : `${text}\n\nTo apply it: ${opts.applyHint}`;
  }
  if (plan.refused) return `${text}\n\nNothing was changed.`;

  const stats = applyRosterChanges(plan);
  log.info("lifecycle roster applied", { by: opts.by, ...stats });

  // The sheet was readable, so a finding saying otherwise is over.
  const unreadable = findingByKey(UNREADABLE_KEY);
  if (unreadable && unreadable.status !== "resolved") {
    await closeFinding(
      unreadable.id,
      APP_ACTOR,
      "The lifecycle sheet was read."
    );
  }

  const names = {
    roster: new Map(roster.map((r) => [r.id, r])),
    sheet: new Map(parsed.people.map((p) => [p.personId, p.name])),
  };
  const seen = new Set<string>();
  for (const f of plan.findings) {
    const finding = rosterFinding(f, names);
    seen.add(finding.dedupeKey);
    await raise(finding);
  }
  const closed = resolveMissingWithPrefix(
    ROSTER_FINDING_PREFIXES,
    seen,
    "No longer true on the lifecycle sheet."
  );
  for (const id of closed) await refreshFinding(id);

  return (
    `${text}\n\nApplied: ${stats.created} created, ${stats.updated} updated. ` +
    `${plan.findings.length} question(s) are in the alert channel; ` +
    `${closed.length} closed as no longer true.`
  );
}

/**
 * Whether a roster finding is still what the sheet says, read now — for a
 * button that would lower monitoring. An hour-old finding is not enough to
 * end someone's monitoring on: the sheet may have declared them Active again
 * since, and the button must not act on a request nobody is making any more.
 */
export async function rosterFindingStillTrue(
  slack: WebClient,
  key: string
): Promise<boolean> {
  const { plan } = await readRosterInputs(slack);
  return plan.findings.some((f) => rosterFindingKey(f) === key);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Everything a groups plan is made from, read fresh. */
async function readGroupInputs() {
  const env = requireGoogle();
  const sheets = serviceAccountClient(env, [SHEETS_READONLY]);
  const parsed = parseSheet(await readLifecycleSheet(sheets, env.sheetId));

  const directory = serviceAccountClient(
    env,
    [DIRECTORY_GROUP_READONLY, DIRECTORY_GROUP_MEMBER],
    googleActor()
  );
  const actual: Partial<Record<GroupName, string[]>> = {};
  const found: Partial<Record<GroupName, FoundGroup & { id: string }>> = {};
  const missing: Partial<Record<GroupName, MissingGroup>> = {};
  for (const group of GROUPS) {
    const id = GOOGLE_GROUP_IDS[group];
    const info = id ? await readGroup(directory, id) : null;
    if (!info) {
      missing[group] = { id };
      continue;
    }
    actual[group] = info.members;
    found[group] = {
      id,
      name: info.name,
      email: info.email,
      count: info.members.length,
    };
  }

  const plans = planGoogleGroups({
    people: parsed.people,
    actual,
    asOf: today(),
  });
  return { parsed, directory, plans, found, missing };
}

/**
 * Everything a Slack copies plan is made from, read fresh with the bot token
 * (`usergroups:read`): the sheet, the roster's Slack accounts, and each copy's
 * group. A copy with no ID yet is looked up by its handle so a dry run shows
 * real numbers, but it is never in `found`, so nothing can be applied to it.
 */
async function readSlackCopyInputs(slack: WebClient) {
  const env = requireGoogle();
  const sheets = serviceAccountClient(env, [SHEETS_READONLY]);
  const parsed = parseSheet(await readLifecycleSheet(sheets, env.sheetId));

  const users = await fetchWorkspaceUsers(slack);
  const live = new Set(
    users.filter((u) => !u.isDeleted && !u.isBot).map((u) => u.id)
  );
  const slackIds = new Map(
    listPeople(false).flatMap((p) =>
      p.person_id && p.slack_user_id && live.has(p.slack_user_id)
        ? [[p.person_id, p.slack_user_id] as const]
        : []
    )
  );

  const workspace = await listUserGroups(slack);
  const actual: Partial<Record<SlackCopy, string[]>> = {};
  const found: Partial<Record<SlackCopy, FoundSlackGroup>> = {};
  const read: Partial<Record<SlackCopy, ReadCopy>> = {};
  const disabled = new Set<SlackCopy>();
  for (const copy of SLACK_COPIES) {
    const { id, handle } = SLACK_GROUP_IDS[copy];
    const group = id
      ? workspace.find((g) => g.id === id)
      : workspace.find((g) => g.handle.toLowerCase() === handle);
    if (!group) continue;
    if (group.disabled) {
      disabled.add(copy);
      continue;
    }
    const members = await groupMembers(slack, group.id);
    actual[copy] = members;
    if (id) found[copy] = { id: group.id, handle: group.handle };
    read[copy] = {
      id: group.id,
      handle: group.handle,
      count: members.length,
      channels: await Promise.all(
        group.channels.map((c) => channelLabel(slack, c))
      ),
      byHandle: !id,
    };
  }

  const plans = planSlackCopies({
    people: parsed.people,
    slackIds,
    actual,
    asOf: today(),
  });
  return { parsed, users, workspace, plans, actual, found, read, disabled };
}

/**
 * Step 5: the Slack user groups against the sheet. Read-only for now — Apply
 * arrives with the `slack_groups_differ` finding (part 3). Uses only the bot
 * token; nothing here needs an administrator's grant.
 */
export async function slackGroupsReport(opts: {
  slack: WebClient;
}): Promise<string> {
  const { parsed, users, workspace, plans, found, read, disabled } =
    await readSlackCopyInputs(opts.slack);
  return formatSlackCopies({
    plans,
    decisions: decideSlackCopies({ plans, found }),
    read,
    disabled,
    workspace,
    names: new Map(parsed.people.map((p) => [p.personId, p.name])),
    accounts: new Map(
      users.map((u) => [
        u.id,
        u.isDeleted ? `${u.realName}, deactivated` : u.realName,
      ])
    ),
    dryRun: true,
  });
}

/**
 * Raises a finding whose text may change while it stays open — who differs
 * in the Slack groups, say — and redraws its alert in place when it does,
 * rather than posting again (decided 2026-09-28): only a finding that closed
 * and came back alerts anew.
 */
async function raiseRedrawn(f: NewFinding): Promise<void> {
  const before = findingByKey(f.dedupeKey);
  const { id, alerted } = await raise(f);
  if (!alerted && before?.summary !== f.summary) await refreshFinding(id);
}

/**
 * The hourly Slack groups check: keeps the one `slack_groups_differ` finding
 * (with **Apply**) up to date, raises one per copy nothing can be applied to
 * (a refusal carries **Apply anyway**), and closes what it no longer sees.
 * Changes no group: every Slack group change is an administrator's click.
 */
export async function slackGroupsCheck(slack: WebClient): Promise<string> {
  let inputs;
  try {
    inputs = await readSlackCopyInputs(slack);
  } catch (err) {
    await raise(slackCheckFailedFinding(errorText(err)));
    throw err;
  }
  const { parsed, plans, found } = inputs;
  const decisions = decideSlackCopies({ plans, found });
  const names = new Map(parsed.people.map((p) => [p.personId, p.name]));
  const seen = new Set<string>();
  const differ = slackDifferFinding(decisions, names);
  if (differ) {
    seen.add(differ.dedupeKey);
    await raiseRedrawn(differ);
  }
  for (const d of decisions) {
    if (d.kind !== "held") continue;
    const f = slackHeldFinding(d);
    seen.add(f.dedupeKey);
    await raiseRedrawn(f);
  }
  const closed = resolveMissingWithPrefix(
    [SLACK_DIFFER_PREFIX],
    seen,
    "The Slack groups match the lifecycle sheet."
  );
  for (const id of closed) await refreshFinding(id);
  const held = decisions.filter((d) => d.kind === "held").length;
  return [
    differ
      ? "Slack groups differ from the sheet: Apply is on the alert in the alert channel."
      : "Slack groups match the sheet.",
    held ? `${held} Slack group(s) held; see the alert channel.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * **Apply** (every copy) or **Apply anyway** (one refused copy), as the
 * administrator who clicked, with their own group-editing grant. Reads the
 * sheet and the groups again inside the group-write lock and applies what
 * differs *then*, not what the finding said. Adds and flag-off removals only:
 * nobody held is removed, because the whole membership sent keeps them.
 * Records the clicker in `group_changes`, then re-checks so the findings
 * show what is left.
 */
export async function slackGroupsApply(opts: {
  slack: WebClient;
  teamId: string;
  actor: GroupsActor;
  reason: string | null;
  /** Apply anyway: this one copy, despite its refusal. */
  force?: SlackCopy;
}): Promise<string> {
  const outcome = await withGroupEditor(
    opts.teamId,
    opts.actor.slackUserId,
    async (editor) => {
      const { parsed, plans, actual, found } = await readSlackCopyInputs(
        opts.slack
      );
      const decisions = decideSlackCopies({
        plans,
        found,
        force: opts.force ? new Set([opts.force]) : undefined,
      }).filter((d) => !opts.force || d.copy === opts.force);
      const names = new Map(parsed.people.map((p) => [p.personId, p.name]));
      const who = (m: SlackMember) =>
        m.personId
          ? `${m.personId} ${names.get(m.personId) ?? ""}`.trim()
          : m.slackUserId;
      const rosterIds = new Map(
        listPeople(false).flatMap((p) =>
          p.person_id ? [[p.person_id, p.id] as const] : []
        )
      );
      const lines: string[] = [];
      for (const d of decisions) {
        if (d.kind === "held") {
          lines.push(
            `@${SLACK_GROUP_IDS[d.copy].handle}: not applied, ${d.message}.`
          );
          continue;
        }
        if (d.kind === "nothing") continue;
        try {
          await setGroupMembership(
            editor,
            d.groupId,
            membershipAfter(actual[d.copy] ?? [], d)
          );
        } catch (err) {
          lines.push(
            `@${d.handle}: Slack refused the change (${errorText(err)}).`
          );
          continue;
        }
        const changes = [
          ...d.add.map((m) => ({ action: "add" as const, m })),
          ...d.remove.map((m) => ({ action: "remove" as const, m })),
        ];
        for (const { action, m } of changes) {
          insertGroupChange({
            usergroupId: d.groupId,
            handle: d.handle,
            action,
            subject: m.slackUserId,
            personId: m.personId ? (rosterIds.get(m.personId) ?? null) : null,
            actor: opts.actor.slackUserId,
            actorName: opts.actor.name,
            reason: opts.reason,
            source: opts.force ? "slack_apply_anyway" : "slack_apply",
          });
        }
        lines.push(
          `@${d.handle}: ` +
            [
              d.add.length ? `added ${d.add.map(who).join(", ")}` : "",
              d.remove.length
                ? `removed ${d.remove.map(who).join(", ")} (lead/RA flag off)`
                : "",
            ]
              .filter(Boolean)
              .join("; ")
        );
      }
      log.info("slack groups applied", {
        by: opts.actor.name,
        force: opts.force ?? null,
        groups: decisions.filter((d) => d.kind === "apply").length,
      });
      return lines.length
        ? lines.join("\n")
        : "The Slack groups already match the lifecycle sheet; nothing to apply.";
    }
  );
  if (!outcome.ok) return outcome.reason;
  try {
    await slackGroupsCheck(opts.slack);
  } catch (err) {
    log.error("slack groups check after apply failed", {
      error: errorText(err),
    });
  }
  return outcome.value;
}

/** Who is applying: a person in Slack, or hawk-mod itself on the hour. */
export type GroupsActor = { slackUserId: string; name: string };

const HAWK_MOD: GroupsActor = { slackUserId: APP_ACTOR, name: APP_ACTOR };

/**
 * Step 4: the Google Groups from the sheet. A dry run unless `apply`; both
 * plan the same way and print the same text.
 *
 * Applying adds everyone the sheet puts in a group and removes only those
 * whose lead or RA flag was turned off — never anyone leaving, who waits for
 * a person (part 4). A group whose plan is refused, whose ID leads to the
 * wrong group, or that cannot be found is left alone and raised as a
 * `google_group_held` finding; a refusal carries **Apply anyway**. Every
 * change is recorded in `group_changes`, and every grp-ra change is announced
 * in the alert channel, since grp-ra can edit the lifecycle sheet.
 */
export async function groupsReport(
  opts: {
    members?: boolean;
    apply?: boolean;
    /** How to ask for the apply, in the words of the door being used. */
    applyHint?: string;
    actor?: GroupsActor;
  } = {}
): Promise<string> {
  const { parsed, directory, plans, found, missing } = await readGroupInputs();
  const text = formatGroupPlans({
    plans,
    found,
    missing,
    members: opts.members ?? false,
    dryRun: !opts.apply,
  });
  if (!opts.apply) {
    return opts.applyHint ? `${text}\n\nTo apply it: ${opts.applyHint}` : text;
  }
  const decisions = decideGroups({ plans, found, missing });
  const outcome = await applyAndRecord({
    decisions,
    directory,
    parsed,
    actor: opts.actor ?? HAWK_MOD,
    reason: null,
    source: "lifecycle_groups",
  });
  await settleHeldFindings(decisions, outcome.failed);
  await settleHeldMembers(plans, parsed);
  return `${text}\n\n${outcome.summary}`;
}

/**
 * One alert per person (or unplaceable address) the run left in a group they
 * no longer belong in, each with Remove from groups; closed once they are out
 * or belong again. Raised only by an applying run — the dry run asks nothing.
 */
async function settleHeldMembers(
  plans: GroupPlanResult[],
  parsed: ReturnType<typeof parseSheet>
): Promise<void> {
  const names = new Map(parsed.people.map((p) => [p.personId, p.name]));
  const slackByPerson = new Map(
    listPeople(false).flatMap((p) =>
      p.person_id && p.slack_user_id ? [[p.person_id, p.slack_user_id]] : []
    )
  );
  // The Slack copies hold people too, and gather into the same alerts. If
  // Slack cannot be read, raise what Google shows and close nothing: a
  // Slack-only alert must not close because Slack was unreachable.
  let slack: Awaited<ReturnType<typeof readSlackCopyInputs>> | null = null;
  try {
    slack = await readSlackCopyInputs(botClient());
  } catch (err) {
    log.error("could not read the Slack groups for held members", {
      error: errorText(err),
    });
  }
  const seen = new Set<string>();
  for (const subject of heldSubjects(plans, slack?.plans ?? [])) {
    const f = heldMemberFinding(subject, {
      names,
      inSlack: (id) => slackByPerson.has(id),
      slackNames: new Map((slack?.users ?? []).map((u) => [u.id, u.realName])),
    });
    seen.add(f.dedupeKey);
    await raiseRedrawn(f);
  }
  if (!slack) return;
  const closed = resolveMissingWithPrefix(
    HELD_MEMBER_PREFIXES,
    seen,
    "No longer held: out of the group, or belongs in it again."
  );
  for (const id of closed) await refreshFinding(id);
}

/**
 * **Remove from groups** (or **Remove from mentor groups**), from a
 * `group_member_held` or `cori_lapsed` finding's button. Re-reads the sheet
 * and the groups now and removes only what is *still* held for that person
 * or address — someone who belongs again by the time of the click is left
 * alone. Never touches a wrong or missing group. Every removal is recorded
 * against the clicker, with their reason; a grp-ra removal is announced.
 */
export async function groupsRemoveHeld(opts: {
  key: string;
  actor: GroupsActor;
  reason: string;
  /** The workspace, for the clicker's own grant to edit the Slack copies. */
  teamId: string | null;
}): Promise<{ text: string; done: boolean }> {
  const { parsed, directory, plans, found, missing } = await readGroupInputs();
  const slackBefore = await readSlackCopyInputs(botClient());
  const subject = heldSubjects(plans, slackBefore.plans).find(
    (s) => s.key === opts.key
  );
  if (!subject) {
    return {
      text: "Nothing is held for them any more; nothing was removed.",
      done: true,
    };
  }
  const usable = decideGroups({
    plans,
    found,
    missing,
    force: new Set(GROUPS),
  });
  const decisions: GroupDecision[] = [];
  const skipped: string[] = [];
  for (const group of GROUPS) {
    const entries = subject.entries.filter((e) => e.group === group);
    if (!entries.length) continue;
    const d = usable.find((x) => x.group === group);
    const f = found[group];
    if (!f || !d || (d.kind === "held" && d.why !== "refused")) {
      skipped.push(group);
      continue;
    }
    decisions.push({
      group,
      kind: "apply",
      groupId: f.id,
      name: f.name,
      add: [],
      remove: entries.map((e) => ({
        address: e.address,
        personIds: subject.personId ? [subject.personId] : [],
      })),
    });
  }
  const lines: string[] = [];
  let failed = 0;
  if (decisions.length) {
    const outcome = await applyAndRecord({
      decisions,
      directory,
      parsed,
      actor: opts.actor,
      reason: opts.reason,
      source: "remove_from_groups",
    });
    lines.push(`Google Groups: ${outcome.summary}`);
    failed += outcome.failed.length;
  }
  if (skipped.length) {
    lines.push(
      `Not touched, because the group is wrong or missing: ${skipped.join(", ")}.`
    );
  }
  let slackDone = true;
  if (subject.slack.length) {
    const slack = await removeHeldFromSlack({
      key: opts.key,
      googlePlans: plans,
      actor: opts.actor,
      reason: opts.reason,
      teamId: opts.teamId,
    });
    lines.push(`Slack: ${slack.text}`);
    slackDone = slack.done;
  }
  return {
    text: lines.join("\n"),
    done: !failed && !skipped.length && slackDone,
  };
}

/**
 * The Slack half of Remove from groups: takes the person (or account) out of
 * the Slack copies they are still held in, as the clicker, with their own
 * grant, inside the group-write lock. Re-reads the groups inside the lock, so
 * only what is held at that moment is removed. Never empties a group — Slack
 * refuses that, and it is a person's job in Slack — and never touches a copy
 * whose ID leads to the wrong group.
 */
async function removeHeldFromSlack(opts: {
  key: string;
  googlePlans: GroupPlanResult[];
  actor: GroupsActor;
  reason: string;
  teamId: string | null;
}): Promise<{ text: string; done: boolean }> {
  if (!opts.teamId) {
    return {
      text: "not changed: Slack did not say which workspace.",
      done: false,
    };
  }
  const outcome = await withGroupEditor(
    opts.teamId,
    opts.actor.slackUserId,
    async (editor) => {
      const now = await readSlackCopyInputs(botClient());
      const subject = heldSubjects(opts.googlePlans, now.plans).find(
        (s) => s.key === opts.key
      );
      if (!subject?.slack.length) {
        return { text: "nothing is held there any more.", done: true };
      }
      const rosterIds = new Map(
        listPeople(false).flatMap((p) =>
          p.person_id ? [[p.person_id, p.id] as const] : []
        )
      );
      const removed: string[] = [];
      const notDone: string[] = [];
      for (const copy of SLACK_COPIES) {
        const ids = subject.slack
          .filter((e) => e.copy === copy)
          .map((e) => e.slackUserId);
        if (!ids.length) continue;
        const { handle } = SLACK_GROUP_IDS[copy];
        const group = now.found[copy];
        if (!group || group.handle.toLowerCase() !== handle) {
          notDone.push(`@${handle} (wrong or missing group)`);
          continue;
        }
        const members = (now.actual[copy] ?? []).filter(
          (m) => !ids.includes(m)
        );
        if (!members.length) {
          notDone.push(`@${handle} (it would be empty; Slack refuses that)`);
          continue;
        }
        try {
          await setGroupMembership(editor, group.id, members);
        } catch (err) {
          notDone.push(`@${handle} (Slack said: ${errorText(err)})`);
          continue;
        }
        for (const id of ids) {
          insertGroupChange({
            usergroupId: group.id,
            handle: group.handle,
            action: "remove",
            subject: id,
            personId: subject.personId
              ? (rosterIds.get(subject.personId) ?? null)
              : null,
            actor: opts.actor.slackUserId,
            actorName: opts.actor.name,
            reason: opts.reason,
            source: "remove_from_groups",
          });
        }
        removed.push(`@${handle}`);
      }
      log.info("removed held member from slack groups", {
        by: opts.actor.name,
        removed: removed.length,
        notDone: notDone.length,
      });
      return {
        text: [
          removed.length ? `removed from ${removed.join(", ")}.` : "",
          notDone.length ? `not removed from ${notDone.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        done: !notDone.length,
      };
    }
  );
  return outcome.ok
    ? outcome.value
    : { text: `not changed. ${outcome.reason}`, done: false };
}

/**
 * The 60-day CORI warning, hourly: a `cori_expiring` finding per mentor, and
 * — once per expiry date, when the finding is first raised — a Slack message
 * to the mentor if they are in Slack. Closed when the renewed date is entered.
 */
export async function coriWarnings(slack: WebClient): Promise<void> {
  const env = requireGoogle();
  const sheets = serviceAccountClient(env, [SHEETS_READONLY]);
  const parsed = parseSheet(await readLifecycleSheet(sheets, env.sheetId));
  const slackByPerson = new Map(
    listPeople(false).flatMap((p) =>
      p.person_id && p.slack_user_id ? [[p.person_id, p.slack_user_id]] : []
    )
  );
  const seen = new Set<string>();
  for (const c of coriExpiringSoon(parsed.people, today())) {
    const f = coriExpiringFinding(c);
    seen.add(f.dedupeKey);
    const { alerted } = await raise(f);
    const slackId = slackByPerson.get(c.personId);
    if (!alerted || !slackId) continue;
    try {
      const im = await slack.conversations.open({ users: slackId });
      const channel = im.channel?.id;
      if (channel) {
        await slack.chat.postMessage({ channel, text: coriReminderText(c) });
      }
    } catch (err) {
      log.warn("could not send a CORI reminder", {
        personId: c.personId,
        error: errorText(err),
      });
    }
  }
  const closed = resolveMissingWithPrefix(
    [CORI_EXPIRING_PREFIX],
    seen,
    "The CORI Expiry on the sheet is renewed, or has passed."
  );
  for (const id of closed) await refreshFinding(id);
}

/**
 * **Apply anyway**, from a `google_group_held` finding's button: the one
 * override of a refusal, for one group. Re-reads the sheet and the group now,
 * so what is applied is what differs at the click, not what the finding said
 * an hour ago. Never overrides a wrong group or a missing one.
 */
export async function groupsApplyAnyway(opts: {
  group: GroupName;
  actor: GroupsActor;
  reason: string;
}): Promise<string> {
  const { parsed, directory, plans, found, missing } = await readGroupInputs();
  const decisions = decideGroups({
    plans: plans.filter((p) => p.group === opts.group),
    found,
    missing,
    force: new Set([opts.group]),
  });
  const [d] = decisions;
  if (!d || d.kind === "held") {
    return `Nothing was applied to ${opts.group}: ${d?.kind === "held" ? d.message : "no plan"}.`;
  }
  if (d.kind === "nothing") return `${opts.group} already matches the sheet.`;
  const outcome = await applyAndRecord({
    decisions,
    directory,
    parsed,
    actor: opts.actor,
    reason: opts.reason,
    source: "apply_anyway",
  });
  return outcome.summary;
}

async function applyAndRecord(args: {
  decisions: GroupDecision[];
  directory: ReturnType<typeof serviceAccountClient>;
  parsed: ReturnType<typeof parseSheet>;
  actor: GroupsActor;
  reason: string | null;
  source: string;
}): Promise<{ summary: string; failed: GroupApplyResult["failed"] }> {
  const rosterIds = new Map(
    listPeople(false).flatMap((p) => (p.person_id ? [[p.person_id, p.id]] : []))
  );
  const runId = startAuditRun(GROUPS_RUN);
  const result = await applyGroupDecisions(
    args.decisions,
    {
      add: (id, email) => addMember(args.directory, id, email),
      remove: (id, email) => removeMember(args.directory, id, email),
    },
    (c) =>
      insertGroupChange({
        usergroupId: c.groupId,
        handle: c.name,
        action: c.action,
        subject: c.member.address,
        // A parent's row names their students; the subject is the parent.
        personId:
          c.group === "grp-parents"
            ? null
            : (rosterIds.get(c.member.personIds[0] ?? "") ?? null),
        actor: args.actor.slackUserId,
        actorName: args.actor.name,
        reason: args.reason,
        source: args.source,
      })
  );
  const added = result.applied.filter((c) => c.action === "add").length;
  const removed = result.applied.length - added;
  finishAuditRun(runId, { added, removed, failed: result.failed.length });
  log.info("google groups applied", {
    by: args.actor.name,
    added,
    removed,
    failed: result.failed.length,
  });

  const names = new Map(args.parsed.people.map((p) => [p.personId, p.name]));
  const ra = result.applied.filter((c) => c.group === "grp-ra");
  if (ra.length) await postToAlertChannel(raAnnouncement(ra, names));

  const lines = [`Applied: ${added} added, ${removed} removed.`];
  if (result.failed.length) {
    lines.push(
      `Failed: ${result.failed.length}; the next run tries again.`,
      ...result.failed.map(
        (f) =>
          `  ${f.group} ${f.action} ${f.member.personIds.join(", ") || "(no Person ID)"}: ${f.reason}`
      )
    );
  }
  return { summary: lines.join("\n"), failed: result.failed };
}

/** Raises a finding per held group, and closes those no longer held. */
async function settleHeldFindings(
  decisions: GroupDecision[],
  failed: GroupApplyResult["failed"]
): Promise<void> {
  const seen = new Set<string>();
  for (const d of decisions) {
    if (d.kind !== "held") continue;
    const f = heldFinding(d);
    seen.add(f.dedupeKey);
    await raise(f);
  }
  const failedGroups = [...new Set(failed.map((f) => f.group))];
  for (const group of failedGroups) {
    const these = failed.filter((f) => f.group === group);
    const f = failedFinding(group, these.length, these[0]!.reason);
    seen.add(f.dedupeKey);
    await raise(f);
  }
  const closed = resolveMissingWithPrefix(
    [GROUP_HELD_PREFIX],
    seen,
    "No longer held: the groups run applied cleanly."
  );
  for (const id of closed) await refreshFinding(id);
}

/**
 * The hourly groups run. Does nothing until the first
 * `/hawkmod lifecycle groups apply` — the first apply adds everyone at once,
 * and that is a person's decision, taken after reading the dry run.
 */
export async function groupsSync(): Promise<string> {
  if (!runEverFinished(GROUPS_RUN)) {
    log.info("google groups sync skipped: never applied yet");
    return "The Google Groups have not been applied yet; nothing to keep in step.";
  }
  try {
    return await groupsReport({ apply: true, actor: HAWK_MOD });
  } catch (err) {
    await raise(runFailedFinding(errorText(err)));
    throw err;
  }
}

/**
 * The hourly job: the roster, then the groups. Each is its own try, so a
 * Google Groups problem never stops the roster being kept, which is the part
 * that decides who is monitored.
 */
export async function lifecycleHourly(slack: WebClient): Promise<void> {
  try {
    await rosterSync({ slack, by: "hourly" });
  } catch (err) {
    log.error("hourly roster sync failed", { error: errorText(err) });
  }
  try {
    await groupsSync();
  } catch (err) {
    log.error("hourly groups sync failed", { error: errorText(err) });
  }
  // Only once the roster comes from the sheet: before that, the sheet is
  // not what hawk-mod goes by.
  if (rosterCutoverDone()) {
    try {
      await coriWarnings(slack);
    } catch (err) {
      log.error("hourly CORI warnings failed", { error: errorText(err) });
    }
    try {
      await slackGroupsCheck(slack);
    } catch (err) {
      log.error("hourly slack groups check failed", { error: errorText(err) });
    }
  }
}

const SLACK_ID_LABEL: Record<SlackIdDecision["kind"], string> = {
  write: "To fill in",
  unchanged: "Already correct",
  typed: "Typed by hand, trusted (Slack email differs)",
  not_in_slack: "Not in Slack yet",
  conflict: "Needs a person to look at",
};

/**
 * Step 1 of the lifecycle sync. A dry run unless `apply`; both print the same
 * plan, so what an administrator read is what gets written.
 */
export async function slackIdsReport(opts: {
  slack: WebClient;
  apply: boolean;
  /** How to ask for the write, in the words of the door being used. */
  applyHint: string;
  /** Who asked, for the log. */
  by: string;
}): Promise<string> {
  const env = requireGoogle();
  const sheets = serviceAccountClient(env, [
    opts.apply ? SHEETS_READWRITE : SHEETS_READONLY,
  ]);
  const parsed = parseSheet(await readLifecycleSheet(sheets, env.sheetId));
  const accounts = (await fetchWorkspaceUsers(opts.slack)).map((u) => ({
    id: u.id,
    email: u.email,
    live: !u.isBot && !u.isDeleted,
  }));
  const decisions = planSlackIds(parsed.people, accounts);

  const lines = [
    `Slack User IDs${opts.apply ? "" : " (dry run: nothing changed)"}`,
    "",
  ];
  for (const kind of Object.keys(SLACK_ID_LABEL) as SlackIdDecision["kind"][]) {
    const these = decisions.filter((d) => d.kind === kind);
    lines.push(`${SLACK_ID_LABEL[kind]}: ${these.length}`);
    for (const d of these) {
      const where = `${d.personId} (${d.tab} row ${d.row})`;
      if (d.kind === "write") lines.push(`  ${where} -> ${d.slackUserId}`);
      else if (d.kind === "conflict") lines.push(`  ${where}: ${d.reason}`);
      else if (d.kind === "not_in_slack") lines.push(`  ${where}`);
    }
  }
  if (parsed.problems.length) {
    lines.push(
      "",
      `${parsed.problems.length} sheet problem(s); the lifecycle plan lists them.`
    );
  }

  const writes = decisions.flatMap((d) =>
    d.kind === "write"
      ? [
          {
            tab: d.tab,
            row: d.row,
            header: "Slack User ID" as const,
            personId: d.personId,
            value: d.slackUserId,
          },
        ]
      : []
  );
  if (!opts.apply) {
    if (writes.length) lines.push("", `To fill them in: ${opts.applyHint}`);
    return lines.join("\n");
  }
  const result = await fillBlankCells(sheets, env.sheetId, writes);
  log.info("lifecycle slack ids applied", {
    by: opts.by,
    written: result.written.length,
    skipped: result.skipped.length,
  });
  lines.push("", `Filled ${result.written.length} cell(s).`);
  for (const s of result.skipped) {
    lines.push(`  skipped ${s.write.personId}: ${s.reason}; run it again`);
  }
  return lines.join("\n");
}

export const NOT_YET_BUILT =
  "The roster has not been built from the lifecycle sheet yet, so there is " +
  "nothing to keep in step. Check it with `/hawkmod lifecycle roster`, then " +
  "build it with `/hawkmod lifecycle roster apply`.";

/**
 * "Sync now" (`/hawkmod lifecycle sync`, and the CLI): the roster, then the
 * Slack groups check, so whoever just edited the sheet sees the new Slack
 * difference — and its Apply — without waiting for the hour. Changes no
 * Slack group itself. The hourly job runs the same two, separately.
 */
export async function syncNow(opts: {
  slack: WebClient;
  by: string;
}): Promise<string> {
  const roster = await rosterSync(opts);
  if (!rosterCutoverDone()) return roster;
  let slack: string;
  try {
    slack = await slackGroupsCheck(opts.slack);
  } catch (err) {
    slack = `The Slack groups were not checked (${errorText(err)}).`;
  }
  return `${roster}\n\n${slack}`;
}

/**
 * One run of the roster from the sheet, as the hourly job and "sync now" both
 * do it: apply the plan, then write newly linked Slack User IDs back to the
 * sheet. Does nothing before the cutover — the first apply is a person's
 * decision, taken after reading the dry run.
 *
 * A sheet that cannot be read raises `lifecycle_unreadable` and leaves the
 * roster as it was (rosterReport). A write-back that fails does not undo a
 * roster already applied: the IDs are filled in on the next run.
 */
export async function rosterSync(opts: {
  slack: WebClient;
  /** Who asked, for the log: "hourly", "cli", or an administrator's name. */
  by: string;
}): Promise<string> {
  if (!rosterCutoverDone()) {
    log.info("lifecycle roster sync skipped: not built from the sheet yet");
    return NOT_YET_BUILT;
  }
  const roster = await rosterReport({
    slack: opts.slack,
    apply: true,
    applyHint: "",
    by: opts.by,
  });
  let ids: string;
  try {
    ids = await slackIdsReport({
      slack: opts.slack,
      apply: true,
      applyHint: "",
      by: opts.by,
    });
  } catch (err) {
    log.warn("slack id write-back failed", { error: errorText(err) });
    ids = `Slack User IDs were not written back (${errorText(err)}); the next run tries again.`;
  }
  return `${roster}\n\n${ids}`;
}
