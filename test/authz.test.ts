import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { WebClient } from "@slack/web-api";
import type { Person, Role } from "../src/domain/people.js";
import { administrator, forgetAuthorization } from "../src/slack/authz.js";

type SlackFlags = {
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_bot?: boolean;
  deleted?: boolean;
  real_name?: string;
};

/** A WebClient with just enough of `users.info` to exercise the gate. */
function slack(flags: SlackFlags | Error): {
  client: WebClient;
  calls: () => number;
} {
  let calls = 0;
  const client = {
    users: {
      info: async () => {
        calls += 1;
        if (flags instanceof Error) throw flags;
        return { user: { id: "U1", name: "someone", ...flags } };
      },
    },
  } as unknown as WebClient;
  return { client, calls: () => calls };
}

function person(role: Role): Person {
  return {
    id: 1,
    slack_user_id: "U1",
    email: "p1@example.org",
    full_name: "Roster Name",
    role,
    active: 1,
    ypp_completed_on: null,
    ypt_completed_on: null,
    mentor_ready_on: null,
    cori_completed_on: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const nobody = () => undefined;

describe("who may administer hawk-mod", () => {
  beforeEach(() => forgetAuthorization());

  it("admits a workspace admin who is not on the roster at all", async () => {
    // The whole point: a fresh install has an empty roster, and whoever
    // installed the app must still be able to use it.
    const { client } = slack({ is_admin: true, real_name: "Ty" });
    const actor = await administrator(client, "U1", { lookup: nobody });
    assert.equal(actor?.name, "Ty");
    assert.equal(actor?.person, undefined);
  });

  it("admits owners and primary owners", async () => {
    for (const flags of [{ is_owner: true }, { is_primary_owner: true }]) {
      forgetAuthorization();
      const { client } = slack(flags);
      assert.ok(await administrator(client, "U1", { lookup: nobody }));
    }
  });

  it("refuses an ordinary member, roster row or not", async () => {
    const { client } = slack({ real_name: "Someone" });
    assert.equal(
      await administrator(client, "U1", { lookup: () => person("adult") }),
      null
    );
  });

  it("refuses a student who holds workspace admin (§6)", async () => {
    // The sweep raises this as a violation; the finding names other students,
    // so this one must not be readable by the student it is about.
    const { client } = slack({ is_owner: true });
    assert.equal(
      await administrator(client, "U1", { lookup: () => person("student") }),
      null
    );
  });

  it("fails closed when Slack cannot be reached", async () => {
    const { client } = slack(new Error("ratelimited"));
    assert.equal(await administrator(client, "U1", { lookup: nobody }), null);
  });

  it("prefers the roster name, for a stable audit trail", async () => {
    const { client } = slack({ is_admin: true, real_name: "tyt" });
    const actor = await administrator(client, "U1", {
      lookup: () => person("adult"),
    });
    assert.equal(actor?.name, "Roster Name");
  });

  it("caches a verdict briefly, then re-reads it", async () => {
    const { client, calls } = slack({ is_admin: true });
    await administrator(client, "U1", { lookup: nobody, now: 0 });
    await administrator(client, "U1", { lookup: nobody, now: 59_000 });
    assert.equal(calls(), 1);
    await administrator(client, "U1", { lookup: nobody, now: 61_000 });
    assert.equal(
      calls(),
      2,
      "a revoked admin must lose access within a minute"
    );
  });
});
