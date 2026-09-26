import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { APP_ACTOR } from "../brand.js";
import {
  findingByKey,
  insertConsent,
  listConsents,
  personById,
  setScreeningDates,
  SCREENING_FIELDS,
  type ScreeningField,
} from "../db/repo.js";
import { closeFinding } from "../close.js";
import { today } from "../domain/dates.js";
import { dedupeKey } from "../domain/findings.js";
import { type Person } from "../domain/people.js";
import { administrator } from "./authz.js";
import {
  consentStatus,
  defaultExpiry,
  mayHoldAccount,
} from "../domain/rules/consent.js";
import {
  screeningEntryErrors,
  screeningStatus,
} from "../domain/rules/screening.js";
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
              "Enter the date each one *expires*, exactly as FIRST's " +
              "dashboard (or district HR, for CORI) shows it — hawk-mod never " +
              "works one out, because FIRST's annual items expire on 1 August " +
              "rather than a year after completion. The first three decide " +
              "whether this person counts as screened; the rest are reported " +
              "only. Once the lifecycle sheet is the roster, record them there.",
          },
        ],
      },
      dateInput(
        "training_expires_on",
        "Youth Protection Training expires (required)",
        person.training_expires_on,
        "Annual; FIRST expires it on 1 August"
      ),
      dateInput(
        "screening_expires_on",
        "Background Screening expires (required)",
        person.screening_expires_on,
        "FIRST renews it every 3 years"
      ),
      dateInput(
        "cori_expires_on",
        "CORI + national fingerprints expire (required)",
        person.cori_expires_on,
        "M.G.L. c. 71 §38R; every 3 years, through district HR"
      ),
      dateInput(
        "consent_release_expires_on",
        "Consent & Release expires (reported only)",
        person.consent_release_expires_on,
        "Annual FIRST registration"
      ),
      dateInput(
        "data_privacy_expires_on",
        "Data Privacy for Mentors expires (reported only)",
        person.data_privacy_expires_on,
        "Annual"
      ),
      dateInput(
        "mentor_ready_completed_on",
        "Mentor Ready completed (reported only)",
        person.mentor_ready_completed_on,
        "One-time badge: the date it was earned"
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
async function settleScreening(personId: number): Promise<void> {
  const person = personById(personId);
  if (!person) return;
  if (!screeningStatus(person, today()).current) return;
  const existing = findingByKey(
    dedupeKey("screening_lapsed", String(personId))
  );
  if (existing && existing.status !== "resolved") {
    await closeFinding(existing.id, APP_ACTOR, "Screening dates recorded.");
  }
}

async function settleConsent(personId: number): Promise<void> {
  const person = personById(personId);
  if (!person) return;
  if (!mayHoldAccount(consentStatus(person, listConsents(), today()))) return;
  const existing = findingByKey(
    dedupeKey("unconsented_account", String(personId))
  );
  if (existing && existing.status !== "resolved") {
    await closeFinding(existing.id, APP_ACTOR, "Consent recorded.");
  }
}

export function registerViews(app: App): void {
  app.view(SCREENING_MODAL, async ({ ack, body, view, client }) => {
    const caller = await administrator(client, body.user.id);
    if (!caller) {
      await ack({
        response_action: "errors",
        errors: {
          training_expires_on:
            "Only Slack workspace Owners and Admins can record screening.",
        },
      });
      return;
    }

    const { personId } = JSON.parse(view.private_metadata) as Meta;
    const state = view.state as ViewState;
    const values: Partial<Record<ScreeningField, string | null>> = {};
    for (const field of SCREENING_FIELDS) values[field] = dateOf(state, field);

    const errors = screeningEntryErrors(values, today());
    if (Object.keys(errors).length) {
      await ack({ response_action: "errors", errors });
      return;
    }

    try {
      const changed = setScreeningDates({
        personId,
        values,
        recordedBy: caller.name,
        source: "slack_modal",
      });
      await ack();
      await settleScreening(personId);
      log.info("screening recorded", {
        personId,
        by: caller.name,
        changed,
      });
    } catch (err) {
      // Without this the modal just says "trouble connecting", which sends
      // whoever hit it looking at their network rather than at the cause.
      log.error("screening submission failed", {
        personId,
        error: String(err),
      });
      await ack({
        response_action: "errors",
        errors: { training_expires_on: `Could not save: ${String(err)}` },
      });
    }
  });

  app.view(CONSENT_MODAL, async ({ ack, body, view, client }) => {
    const caller = await administrator(client, body.user.id);
    if (!caller) {
      await ack({
        response_action: "errors",
        errors: {
          signed_on:
            "Only Slack workspace Owners and Admins can record consent.",
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

    try {
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
        recordedBy: caller.name,
      });
      await ack();
      await settleConsent(personId);
      log.info("consent recorded", { personId, by: caller.name });
    } catch (err) {
      log.error("consent submission failed", { personId, error: String(err) });
      await ack({
        response_action: "errors",
        errors: { signed_on: `Could not save: ${String(err)}` },
      });
    }
  });
}
