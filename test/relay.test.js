// Run with `npm test` (Node 18+, no dependencies).
//
// The example payloads in fixtures/email-crm-examples.json are copied verbatim
// from https://app.mintgrove.co/docs/email-crm. If Mintgrove changes a payload
// there, refresh the fixture and re-run.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import handler, { METRIC_NAME } from "../api/relay.js";

const SECRET = "whsec_test_relay_secret";
const { examples } = JSON.parse(
  readFileSync(new URL("./fixtures/email-crm-examples.json", import.meta.url), "utf8")
);
const ALL_EVENTS = [
  "seat.assigned",
  "seat.revoked",
  "seat.restored",
  "seat.expiry_ignored",
  "seat.grant_held",
  "seat.grant_released",
  "purchase.completed",
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

// A stand-in for Klaviyo's Create Event endpoint. It applies Klaviyo's
// documented rule: "If the unique_id is repeated for the same profile and
// metric, only the first processed event will be recorded."
let klaviyo;
function fakeKlaviyo({ status = 202, throwWith = null } = {}) {
  const state = { calls: [], recorded: [], seen: new Set(), respondedBeforeFetch: false };
  globalThis.fetch = async (url, init) => {
    state.calls.push({ url, init, body: JSON.parse(init.body) });
    if (throwWith) throw throwWith;
    if (status === 202) {
      const a = state.calls.at(-1).body.data.attributes;
      const key = JSON.stringify([a.profile.data.attributes, a.metric.data.attributes.name, a.unique_id]);
      if (!a.unique_id || !state.seen.has(key)) {
        state.seen.add(key);
        state.recorded.push(a);
      }
    }
    return new Response(null, { status });
  };
  return state;
}

async function deliver(payload, { headers, rawBody } = {}) {
  const raw = rawBody ?? JSON.stringify(payload);
  const res = response();
  await handler(request(raw, headers ?? { "mintgrove-signature": sign(raw) }), res);
  return res;
}

let logs;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  process.env.MINTGROVE_SIGNING_SECRET = SECRET;
  process.env.KLAVIYO_PRIVATE_API_KEY = "pk_test";
  logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  klaviyo = fakeKlaviyo();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
});

function sentAttributes() {
  assert.equal(klaviyo.calls.length, 1, "expected exactly one Klaviyo call");
  return klaviyo.calls[0].body.data.attributes;
}

// --- the fixture is the live docs, all eight events ------------------------

test("fixture holds the eight documented events", () => {
  assert.deepEqual(Object.keys(examples).sort(), [...ALL_EVENTS].sort());
});

// --- QA: each event type -> exactly one "Mintgrove Event", event unchanged --

for (const name of ALL_EVENTS) {
  test(`${name}: one Klaviyo event under "${METRIC_NAME}" carrying the full payload unchanged`, async () => {
    const payload = examples[name];
    const res = await deliver(payload);

    assert.equal(res.statusCode, 200);
    const a = sentAttributes();
    assert.equal(klaviyo.calls[0].url, "https://a.klaviyo.com/api/events");
    assert.equal(a.metric.data.attributes.name, "Mintgrove Event");
    assert.deepEqual(a.properties, payload, "properties must be the payload, every field, same names");
    assert.equal(a.properties.event, name);
    assert.equal(a.unique_id, payload.event_id);
    assert.equal(klaviyo.recorded.length, 1);
  });
}

// --- QA: profile identifier per event --------------------------------------

test("seat.assigned lands on the recipient_email profile", async () => {
  await deliver(examples["seat.assigned"]);
  assert.deepEqual(sentAttributes().profile.data.attributes, { email: "user@acme.org" });
});

test("seat.revoked with an email lands on the recipient_email profile", async () => {
  await deliver(examples["seat.revoked"]);
  assert.deepEqual(sentAttributes().profile.data.attributes, { email: "user@acme.org" });
});

for (const name of ["purchase.completed", "subscription.renewal_reminder"]) {
  test(`${name} lands on the admin_email profile, never a seat holder's`, async () => {
    // Even with a seat-holder address present, the buyer admin is the profile.
    await deliver({ ...examples[name], recipient_email: "user@acme.org" });
    assert.deepEqual(sentAttributes().profile.data.attributes, { email: "buyer@acme.org" });
  });
}

for (const name of ["seat.restored", "seat.expiry_ignored", "seat.grant_held", "seat.grant_released"]) {
  test(`${name} is identified by external_id and never creates an email profile`, async () => {
    await deliver(examples[name]);
    assert.deepEqual(sentAttributes().profile.data.attributes, { external_id: "usr_8827311" });
  });

  test(`${name} falls back to seat_id when external_id is null`, async () => {
    await deliver({ ...examples[name], external_id: null });
    assert.deepEqual(sentAttributes().profile.data.attributes, {
      external_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38",
    });
  });
}

// --- QA: store-path seat.revoked with an opaque recipient_email -------------

test("store-path seat.revoked with an opaque id does not create an email profile from it", async () => {
  const payload = {
    ...examples["seat.revoked"],
    recipient_email: "cus_9KX2mQ4pL7",
    external_id: "usr_8827311",
    reason: "subscription_expired",
  };
  await deliver(payload);
  const a = sentAttributes();
  assert.deepEqual(a.profile.data.attributes, { external_id: "usr_8827311" });
  // The opaque value still rides along untouched as an event property.
  assert.equal(a.properties.recipient_email, "cus_9KX2mQ4pL7");
});

test("store-path seat.revoked with an opaque id and no external_id falls back to seat_id", async () => {
  await deliver({ ...examples["seat.revoked"], recipient_email: "000123.abc", external_id: null });
  assert.deepEqual(sentAttributes().profile.data.attributes, {
    external_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38",
  });
});

// --- QA: identifier-only events never build a profile from a missing email ---

test("no profile email is ever set from a missing, null or non-email value", async () => {
  const variants = [
    { ...examples["seat.assigned"], recipient_email: undefined, seat_id: "s-1" },
    { ...examples["seat.assigned"], recipient_email: null, seat_id: "s-1" },
    { ...examples["seat.assigned"], recipient_email: "", seat_id: "s-1" },
    { ...examples["seat.assigned"], recipient_email: "undefined", seat_id: "s-1" },
    { ...examples["purchase.completed"], admin_email: "not an email", seat_id: "s-1" },
  ];
  for (const payload of variants) {
    klaviyo = fakeKlaviyo();
    const res = await deliver(payload);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sentAttributes().profile.data.attributes, { external_id: "s-1" });
  }
});

test("an event with no usable identifier at all is not sent, and is not acked as success", async () => {
  const { admin_email, ...noAdmin } = examples["purchase.completed"];
  const res = await deliver(noAdmin);
  assert.equal(res.statusCode, 422);
  assert.equal(klaviyo.calls.length, 0);
});

// --- QA: an unknown future event -------------------------------------------

test("an unknown event is forwarded unchanged under the same metric, not dropped or relabeled", async () => {
  const payload = {
    event: "seat.grant_withheld",
    seat_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38",
    external_id: "usr_8827311",
    withheld_reason: "country",
    recipient_email: "user@acme.org",
    event_id: "0d7c3e1a-8b54-4a2f-9e61-5c7a2b9d0f13",
  };
  const res = await deliver(payload);
  assert.equal(res.statusCode, 200);
  const a = sentAttributes();
  assert.equal(a.metric.data.attributes.name, "Mintgrove Event");
  assert.deepEqual(a.properties, payload);
  assert.equal(a.properties.event, "seat.grant_withheld");
  // Only the four listed events use an email; anything else is external_id.
  assert.deepEqual(a.profile.data.attributes, { external_id: "usr_8827311" });
});

// --- QA: redelivery of the same event_id -----------------------------------

test("a redelivery with the same event_id does not produce a second Klaviyo event", async () => {
  const payload = examples["seat.grant_held"];
  assert.equal((await deliver(payload)).statusCode, 200);
  assert.equal((await deliver(payload)).statusCode, 200);

  assert.equal(klaviyo.calls.length, 2, "the relay is stateless and forwards both");
  const [first, second] = klaviyo.calls.map((c) => c.body.data.attributes);
  assert.equal(first.unique_id, payload.event_id);
  assert.deepEqual(second, first, "same unique_id, profile and metric, so Klaviyo dedupes");
  assert.equal(klaviyo.recorded.length, 1, "Klaviyo records only the first");
});

// --- QA: bad signatures ----------------------------------------------------

test("a missing or invalid signature returns 401 and forwards nothing", async () => {
  const raw = JSON.stringify(examples["seat.assigned"]);
  const old = Math.floor(Date.now() / 1000) - 301;
  const cases = {
    missing: {},
    empty: { "mintgrove-signature": "" },
    garbage: { "mintgrove-signature": "nonsense" },
    "no v1": { "mintgrove-signature": `t=${Math.floor(Date.now() / 1000)}` },
    "wrong secret": { "mintgrove-signature": sign(raw, { secret: "whsec_someone_else" }) },
    "stale timestamp": { "mintgrove-signature": sign(raw, { timestamp: old }) },
    "short v1": { "mintgrove-signature": `t=${Math.floor(Date.now() / 1000)},v1=abcd` },
  };
  for (const [label, headers] of Object.entries(cases)) {
    const res = await deliver(null, { rawBody: raw, headers });
    assert.equal(res.statusCode, 401, label);
  }
  // A valid signature over different bytes: the body was tampered with.
  const tampered = raw.replace("user@acme.org", "attacker@evil.test");
  const res = await deliver(null, { rawBody: tampered, headers: { "mintgrove-signature": sign(raw) } });
  assert.equal(res.statusCode, 401, "tampered body");

  assert.equal(klaviyo.calls.length, 0);
});

test("an unset signing secret fails closed with 500 and forwards nothing", async () => {
  delete process.env.MINTGROVE_SIGNING_SECRET;
  const res = await deliver(examples["seat.assigned"]);
  assert.equal(res.statusCode, 500);
  assert.equal(klaviyo.calls.length, 0);
});

// --- QA: Klaviyo failure behaviour -----------------------------------------

test("the Klaviyo call carries a timeout signal, the current revision and the API key", async () => {
  await deliver(examples["seat.assigned"]);
  const { init } = klaviyo.calls[0];
  assert.ok(init.signal instanceof AbortSignal, "the Klaviyo call must carry a timeout signal");
  assert.equal(init.headers.revision, "2026-07-15");
  assert.equal(init.headers.Authorization, "Klaviyo-API-Key pk_test");
});

for (const status of [400, 401, 429, 500, 503]) {
  test(`Klaviyo answering ${status} returns 502 so Mintgrove retries`, async () => {
    klaviyo = fakeKlaviyo({ status });
    const res = await deliver(examples["seat.assigned"]);
    assert.equal(res.statusCode, 502);
  });
}

test("Klaviyo unreachable or timing out returns 502 so Mintgrove retries", async () => {
  for (const err of [new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError")]) {
    klaviyo = fakeKlaviyo({ throwWith: err });
    const res = await deliver(examples["seat.assigned"]);
    assert.equal(res.statusCode, 502);
  }
});

test("a Klaviyo retry after a failure lands exactly one event", async () => {
  const payload = examples["subscription.renewal_reminder"];
  klaviyo = fakeKlaviyo({ status: 503 });
  assert.equal((await deliver(payload)).statusCode, 502);

  const recovered = fakeKlaviyo();
  klaviyo = recovered;
  assert.equal((await deliver(payload)).statusCode, 200);
  assert.equal(recovered.recorded.length, 1);
});

// --- logging: event, event_id and outcome, nothing else ---------------------

test("logs carry only event, event_id and outcome, never payload data", async () => {
  for (const name of ALL_EVENTS) await deliver(examples[name]);
  klaviyo = fakeKlaviyo({ status: 500 });
  await deliver(examples["purchase.completed"]);
  await deliver(null, { rawBody: JSON.stringify(examples["seat.assigned"]), headers: {} });

  assert.ok(logs.length >= ALL_EVENTS.length + 2);
  const forbidden = ["user@acme.org", "buyer@acme.org", "Jane Smith", "Acme Corp", "usr_8827311", "MG-4KQ2-8ZTP"];
  for (const line of logs) {
    for (const value of forbidden) assert.ok(!line.includes(value), `log leaked ${value}: ${line}`);
    const parsed = JSON.parse(line.replace("[mintgrove-klaviyo-relay] ", ""));
    assert.deepEqual(Object.keys(parsed).sort(), ["event", "event_id", "outcome"]);
  }
});
