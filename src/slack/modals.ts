import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import {
  findingByKey,
  insertConsent,
  listConsents,
  personById,
  personBySlackId,
  resolveFinding,
  setScreeningDates,
  type ScreeningField,
} from "../db/repo.js";
import { today } from "../domain/dates.js";
import { dedupeKey } from "../domain/findings.js";
import { mayAdministerWorkspace, type Person } from "../domain/people.js";
import {
  consentStatus,
  defaultExpiry,
  mayHoldAccount,
} from "../domain/rules/consent.js";
import { screeningStatus } from "../domain/rules/screening.js";
import { log } from "../logger.js";

export const SCREENING_MODAL = "hawkmod_screening";
export const CONSENT_MODAL = "hawkmod_consent";

type Meta = { personId: number };

function dateInput(
  blockId: string,
  label: string,
  initial: string | null,
  hint?: string
) {
  return {
    type: "input" as const,
    block_id: blockId,
    optional: true,
    label: { type: "plain_text" as const, text: label },
    ...(hint ? { hint: { type: "plain_text" as const, text: hint } } : {}),
    element: {
      type: "datepicker" as const,
      action_id: "date",
      ...(initial ? { initial_date: initial } : {}),
      placeholder: { type: "plain_text" as const, text: "Date completed" },
    },
  };
}

function textInput(
  blockId: string,
  label: string,
  opts: { optional?: boolean; placeholder?: string; initial?: string } = {}
) {
  return {
    type: "input" as const,
    block_id: blockId,
    optional: opts.optional ?? false,
    label: { type: "plain_text" as const, text: label },
    element: {
      type: "plain_text_input" as const,
      action_id: "value",
      ...(opts.initial ? { initial_value: opts.initial } : {}),
      ...(opts.placeholder
        ? {
            placeholder: {
              type: "plain_text" as const,
              text: opts.placeholder,
            },
          }
        : {}),
    },
  };
}

export function screeningView(person: Person) {
  return {
    type: "modal" as const,
    callback_id: SCREENING_MODAL,
    private_metadata: JSON.stringify({ personId: person.id } satisfies Meta),
    title: { type: "plain_text" as const, text: "Screening" },
    submit: { type: "plain_text" as const, text: "Save" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: `Screening record for *${person.full_name}* (${person.role}).`,
        },
      },
      {
        type: "context" as const,
        elements: [
          {
            type: "mrkdwn" as const,
            text:
              "Enter the date each was *completed*. Expiry is worked out from " +
              "it — YPP and Mentor Ready annually, CORI and fingerprints every " +
              "three years.",
          },
        ],
      },
      dateInput("ypp", "FIRST YPP screening", person.ypp_completed_on),
      dateInput("mentor_ready", "Mentor Ready", person.mentor_ready_on),
      dateInput(
        "cori",
        "CORI + national fingerprints",
        person.cori_completed_on,
        "M.G.L. c. 71 §38R; run through district HR"
      ),
    ],
  };
}

export function consentView(person: Person) {
  return {
    type: "modal" as const,
    callback_id: CONSENT_MODAL,
    private_metadata: JSON.stringify({ personId: person.id } satisfies Meta),
    title: { type: "plain_text" as const, text: "Parental consent" },
    submit: { type: "plain_text" as const, text: "Record" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: `Recording consent for *${person.full_name}*.`,
        },
      },
      {
        type: "context" as const,
        elements: [
          {
            type: "mrkdwn" as const,
            text:
              "This records that a signed form exists — it is not the form. " +
              "Keep the signed copy filed and link it below; Slack can ask you " +
              "to produce it.",
          },
        ],
      },
      dateInput("signed_on", "Date signed", today()),
      textInput("guardian_name", "Parent/guardian name"),
      textInput("guardian_email", "Parent/guardian email", { optional: true }),
      textInput("form_version", "Consent form version", {
        placeholder: "e.g. 2026.1",
      }),
      textInput("document_ref", "Where the signed copy is filed", {
        optional: true,
        placeholder: "Drive link, folder, file name…",
      }),
    ],
  };
}

/* ------------------------------------------------------------------ opening */

export async function openScreening(
  client: WebClient,
  triggerId: string,
  person: Person
): Promise<void> {
  await client.views.open({
    trigger_id: triggerId,
    view: screeningView(person),
  });
}

export async function openConsent(
  client: WebClient,
  triggerId: string,
  person: Person
): Promise<void> {
  await client.views.open({ trigger_id: triggerId, view: consentView(person) });
}

/* --------------------------------------------------------------- submission */

type ViewState = {
  values: Record<
    string,
    Record<string, { selected_date?: string; value?: string }>
  >;
};

const dateOf = (s: ViewState, block: string) =>
  s.values[block]?.["date"]?.selected_date ?? null;
const textOf = (s: ViewState, block: string) =>
  (s.values[block]?.["value"]?.value ?? "").trim();

/** Re-checks the person and closes the finding this entry was fixing. */
function settleScreening(personId: number): void {
  const person = personById(personId);
  if (!person) return;
  if (!screeningStatus(person, today()).current) return;
  const existing = findingByKey(
    dedupeKey("screening_lapsed", String(personId))
  );
  if (existing && existing.status !== "resolved") {
    resolveFinding(existing.id, "hawk-mod", "Screening dates recorded.");
  }
}

function settleConsent(personId: number): void {
  const person = personById(personId);
  if (!person) return;
  if (!mayHoldAccount(consentStatus(person, listConsents(), today()))) return;
  const existing = findingByKey(
    dedupeKey("unconsented_account", String(personId))
  );
  if (existing && existing.status !== "resolved") {
    resolveFinding(existing.id, "hawk-mod", "Consent recorded.");
  }
}

export function registerViews(app: App): void {
  app.view(SCREENING_MODAL, async ({ ack, body, view }) => {
    const caller = personBySlackId(body.user.id);
    if (!caller || !mayAdministerWorkspace(caller)) {
      await ack({
        response_action: "errors",
        errors: { ypp: "Only Lead Coaches and admins can record screening." },
      });
      return;
    }

    const { personId } = JSON.parse(view.private_metadata) as Meta;
    const state = view.state as ViewState;
    const values: Partial<Record<ScreeningField, string | null>> = {};
    const pairs: [string, ScreeningField][] = [
      ["ypp", "ypp_completed_on"],
      ["mentor_ready", "mentor_ready_on"],
      ["cori", "cori_completed_on"],
    ];

    const now = today();
    for (const [block, field] of pairs) {
      const value = dateOf(state, block);
      if (value && value > now) {
        // A completion date in the future is a typo, and it would silently
        // extend someone's screening past when it really expires.
        await ack({
          response_action: "errors",
          errors: { [block]: "That date is in the future." },
        });
        return;
      }
      values[field] = value;
    }

    const changed = setScreeningDates({
      personId,
      values,
      recordedBy: caller.full_name,
      source: "slack_modal",
    });
    await ack();
    settleScreening(personId);
    log.info("screening recorded", {
      personId,
      by: caller.full_name,
      changed,
    });
  });

  app.view(CONSENT_MODAL, async ({ ack, body, view }) => {
    const caller = personBySlackId(body.user.id);
    if (!caller || !mayAdministerWorkspace(caller)) {
      await ack({
        response_action: "errors",
        errors: {
          signed_on: "Only Lead Coaches and admins can record consent.",
        },
      });
      return;
    }

    const { personId } = JSON.parse(view.private_metadata) as Meta;
    const state = view.state as ViewState;
    const signedOn = dateOf(state, "signed_on");

    if (!signedOn) {
      await ack({
        response_action: "errors",
        errors: { signed_on: "A signature date is required." },
      });
      return;
    }
    if (signedOn > today()) {
      await ack({
        response_action: "errors",
        errors: { signed_on: "That date is in the future." },
      });
      return;
    }

    insertConsent({
      personId,
      signedOn,
      // Annual re-collection; overridable later via the CSV import if a form
      // genuinely carries a different term.
      expiresOn: defaultExpiry(signedOn),
      formVersion: textOf(state, "form_version") || "unversioned",
      guardianName: textOf(state, "guardian_name"),
      guardianEmail: textOf(state, "guardian_email") || null,
      documentRef: textOf(state, "document_ref") || null,
      recordedBy: caller.full_name,
    });
    await ack();
    settleConsent(personId);
    log.info("consent recorded", { personId, by: caller.full_name });
  });
}
