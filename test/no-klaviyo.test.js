// MIN-1270 — Reference relay: no event creates a Klaviyo profile or is sent to Klaviyo.
// Run with `npm test` (Node 18+, no dependencies).
//
// Eight payloads come from fixtures/email-crm-examples.json (copied from
// https://app.mintgrove.co/docs/email-crm). The other three are the remaining
// documented events, copied from https://app.mintgrove.co/docs/klaviyo.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import handler, * as relay from "../api/relay.js";

const SECRET = "whsec_test_relay_secret";
const { examples } = JSON.parse(
  readFileSync(new URL("./fixtures/email-crm-examples.json", import.meta.url), "utf8")
);

const PAYLOADS = {
  ...examples,
  "seat.grant_withheld": {
    event: "seat.grant_withheld",
    seat_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38",
    external_id: "usr_8827311",
    withheld_reason: "country_missing",
    buyer_org_id: "3d9c1a70-6e58-4b22-9f31-c07ad4e5b169",
    access_revoked: false,
    event_id: "2b8f04ce-71d9-4a15-8c63-e5940b1d7fa2",
  },
  "seat.grant_withheld_cleared": {
    event: "seat.grant_withheld_cleared",
    seat_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38",
    external_id: "usr_8827311",
    cleared_withheld_reason: "country_missing",
    buyer_org_id: "3d9c1a70-6e58-4b22-9f31-c07ad4e5b169",
    event_id: "9c41d7e2-5f08-4a6b-b3d1-68e2f0a47c95",
  },
  "subscription.partial_refund": {
    event: "subscription.partial_refund",
    app_subscription_id: "5acee4d8-7b31-4c92-a0e6-1d83f7b2c4a9",
    buyer_org_id: "3f9a1c7e-6b20-4f81-9e2d-77c4a0b51d38",
    app_name: "Your App",
    stripe_refund_id: "re_3Pk2xAbCdEfGhIjK0lMnOpQr",
    stripe_charge_id: "ch_3Pk2xAbCdEfGhIjK0lMnOpQr",
    event_id: "7d2e9a14-5c38-4b60-a1f7-0e83c6b9d452",
  },
};
const ELEVEN = [
  "seat.assigned",
  "seat.revoked",
  "seat.restored",
  "seat.expiry_ignored",
  "seat.grant_held",
  "seat.grant_released",
  "seat.grant_withheld",
  "seat.grant_withheld_cleared",
  "purchase.completed",
  "subscription.partial_refund",
  "subscription.renewal_reminder",
];

// --- harness ---------------------------------------------------------------

function sign(rawBody, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const v1 = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

function request(rawBody, headers = {}) {
  const req = Readable.from([Buffer.from(rawBody, "utf8")]);
  req.method = "POST";
  req.headers = headers;
  return req;
}

function response() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function deliver(payload, { headers, rawBody } = {}) {
  const raw = rawBody ?? JSON.stringify(payload);
  const res = response();
  await handler(request(raw, headers ?? { "mintgrove-signature": sign(raw) }), res);
  return res;
}

// Any outbound request at all is recorded. The relay must make none.
let outbound;
let logs;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  process.env.MINTGROVE_SIGNING_SECRET = SECRET;
  delete process.env.KLAVIYO_PRIVATE_API_KEY;
  outbound = [];
  logs = [];
  globalThis.fetch = async (url, init) => {
    outbound.push({ url: String(url), body: init?.body ?? null });
    return new Response(null, { status: 202 });
  };
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
});

// --- the run -----------------------------------------------------------------

test("the eleven payloads under test are all present", () => {
  assert.deepEqual(Object.keys(PAYLOADS).sort(), [...ELEVEN].sort());
});

for (const name of ELEVEN) {
  for (const keySet of [false, true]) {
    test(`${name}: nothing is sent anywhere, answered 200 (Klaviyo key ${keySet ? "set" : "unset"})`, async () => {
      if (keySet) process.env.KLAVIYO_PRIVATE_API_KEY = "pk_test";
      const res = await deliver(PAYLOADS[name]);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(outbound, [], "the relay made an outbound request");
    });
  }
}

// recipient_email and admin_email must never reach any outbound request, even
// a valid address in an event that used to be keyed by it.
for (const name of ["seat.assigned", "seat.revoked", "seat.restored", "purchase.completed", "subscription.renewal_reminder"]) {
  test(`${name}: no profile identifier is built from recipient_email or admin_email`, async () => {
    process.env.KLAVIYO_PRIVATE_API_KEY = "pk_test";
    const payload = { ...PAYLOADS[name], recipient_email: "holder@acme.org", admin_email: "admin@acme.org" };
    const res = await deliver(payload);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(outbound, []);
    assert.ok(!logs.join("\n").includes("@"), "an email address reached the logs");
  });
}

test("the relay exports nothing that builds a Klaviyo event or profile identifier", () => {
  for (const name of ["toKlaviyoEvent", "profileIdentifier", "METRIC_NAME", "isFinalRejection"]) {
    assert.equal(name in relay, false, `${name} is still exported`);
  }
});

test("an unknown event is acknowledged and sent nowhere", async () => {
  const res = await deliver({ event: "seat.something_new", external_id: "usr_1", event_id: "e-1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(outbound, []);
});

// --- what the relay still does -----------------------------------------------

test("a missing or invalid signature returns 401", async () => {
  const raw = JSON.stringify(PAYLOADS["seat.assigned"]);
  const stale = sign(raw, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  for (const headers of [{}, { "mintgrove-signature": sign(raw, { secret: "wrong" }) }, { "mintgrove-signature": stale }]) {
    const res = await deliver(null, { rawBody: raw, headers });
    assert.equal(res.statusCode, 401);
  }
  assert.deepEqual(outbound, []);
});

test("an unsupported webhook version returns 400", async () => {
  const raw = JSON.stringify(PAYLOADS["seat.assigned"]);
  const res = await deliver(null, {
    rawBody: raw,
    headers: { "mintgrove-signature": sign(raw), "mintgrove-webhook-version": "2099-01-01" },
  });
  assert.equal(res.statusCode, 400);
});

test("a signed body that is not a JSON object returns 400", async () => {
  for (const raw of ["not json", "[1,2]", "null"]) {
    const res = await deliver(null, { rawBody: raw });
    assert.equal(res.statusCode, 400);
  }
});

test("an unset signing secret fails closed with 500", async () => {
  delete process.env.MINTGROVE_SIGNING_SECRET;
  const res = await deliver(PAYLOADS["seat.assigned"]);
  assert.equal(res.statusCode, 500);
});

test("only POST is accepted", async () => {
  const req = request("");
  req.method = "GET";
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test("logs carry only event, event_id and outcome, never payload data", async () => {
  for (const name of ELEVEN) await deliver(PAYLOADS[name]);
  assert.equal(logs.length, ELEVEN.length);
  for (const line of logs) {
    const parsed = JSON.parse(line.replace("[mintgrove-klaviyo-relay] ", ""));
    assert.deepEqual(Object.keys(parsed).sort(), ["event", "event_id", "outcome"]);
  }
  const all = logs.join("\n");
  for (const secret of ["Jane Smith", "Acme Corp", "@", "usr_8827311"]) {
    assert.ok(!all.includes(secret), `${secret} reached the logs`);
  }
});
