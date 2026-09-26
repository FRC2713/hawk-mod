import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { googleEnv, serviceAccountClient } from "../src/google/credentials.js";

const VARS = [
  "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64",
  "GOOGLE_SERVICE_ACCOUNT_KEY_FILE",
  "LIFECYCLE_SHEET_ID",
] as const;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("Google credentials", () => {
  afterEach(() => {
    for (const v of VARS) delete process.env[v];
  });

  it("is off when no key is configured", () => {
    assert.equal(googleEnv(), null);
  });

  it("prefers the base64 key, the way production passes it", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 = "abc";
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = "/tmp/key.json";
    assert.deepEqual(googleEnv()?.key, { base64: "abc" });
  });

  it("accepts a base64 service account key", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 = b64(
      JSON.stringify({
        client_email: "sa@project.iam.gserviceaccount.com",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      })
    );
    const client = serviceAccountClient(googleEnv()!, ["scope"]);
    assert.equal(client.email, "sa@project.iam.gserviceaccount.com");
  });

  it("never quotes the key when it fails to parse", () => {
    // This message can be posted to Slack by /hawkmod lifecycle. JSON.parse's
    // own message would include the text it choked on — the private key.
    const secret = "PRIVATEKEYMATERIAL";
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 = b64(
      `{"private_key": ${secret}`
    );
    assert.throws(
      () => serviceAccountClient(googleEnv()!, ["scope"]),
      (err: Error) => {
        assert.ok(!err.message.includes(secret), err.message);
        assert.match(err.message, /not a JSON service account key/);
        return true;
      }
    );
  });

  it("refuses JSON that is not a service account key", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 = b64(`{"type":"other"}`);
    assert.throws(
      () => serviceAccountClient(googleEnv()!, ["scope"]),
      /not a service account key/
    );
  });
});
