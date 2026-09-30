// MIN-876 QA checklist (R049), asserted on the EXACT request the relay sends.
//
// relay.test.js checks parts of each request (metric, properties, unique_id,
// profile). This file checks all of it: for every checklist item, the URL,
// method, headers and the body bytes Klaviyo would receive are compared with a
// request written out by hand here, from the contract in README.md and
// /docs/klaviyo, not built by calling into the relay. If the relay adds,
// drops, renames or reorders anything in the request, these fail.
//
// Klaviyo is mocked by replacing globalThis.fetch. No network is used.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import handler from "../api/relay.js";

const SECRET = "whsec_request_body_secret";
const API_KEY = "pk_request_body_test";
const { examples } = JSON.parse(
  readFileSync(new URL("./fixtures/email-crm-examples.json", import.meta.url), "utf8")
);

// --- harness ----------------------------------------------------------------

function sign(raw, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  return `t=${timestamp},v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
}

async function deliver(payload, { headers, rawBody } = {}) {
  const raw = rawBody ?? JSON.stringify(payload);
  const req = Readable.from([Buffer.from(raw, "utf8")]);
  req.method = "POST";
  req.headers = headers ?? { "mintgrove-signature": sign(raw) };
  const res = { statusCode: null, body: null };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  await handler(req, res);
  return res;
}

// Klaviyo stand-in. Records every request verbatim. `answer` decides the reply.
let calls;
let answer;
function mockKlaviyo(fn = () => new Response(null, { status: 202 })) {
  calls = [];
  answer = fn;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
}

let logs;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  process.env.MINTGROVE_SIGNING_SECRET = SECRET;
  process.env.KLAVIYO_PRIVATE_API_KEY = API_KEY;
  logs = [];
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  mockKlaviyo();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
});

// The request the contract says Klaviyo receives, written out in full.
function expectedBody(payload, profileAttributes) {
  return JSON.stringify({
    data: {
      type: "event",
      attributes: {
        metric: { data: { type: "metric", attributes: { name: "Mintgrove Event" } } },
        profile: { data: { type: "profile", attributes: profileAttributes } },
        properties: payload,
        unique_id: payload.event_id,
      },
    },
  });
}

function assertExactlyOneRequest(payload, profileAttributes) {
  assert.equal(calls.length, 1, "exactly one Klaviyo request");
  const { url, init } = calls[0];
  assert.equal(url, "https://a.klaviyo.com/api/events");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    Authorization: `Klaviyo-API-Key ${API_KEY}`,
    "Content-Type": "application/vnd.api+json",
    Accept: "application/vnd.api+json",
    revision: "2026-07-15",
  });
  // Byte-for-byte: key order, every property, nothing added.
  assert.equal(init.body, expectedBody(payload, profileAttributes));
}

// The relay's closed set of outcomes (README "Checking it works").
const OUTCOME = /^(forwarded|klaviyo_rejected_\d{3}|klaviyo_dropped_\d{3}|klaviyo_timeout|klaviyo_unreachable|no_profile_identifier|invalid_signature|unsupported_webhook_version|malformed_body|relay_not_configured)$/;

// Every log line is the prefix plus exactly {event, event_id, outcome}: event
// and event_id are the payload's own (or null before the signature is
// checked), and outcome is one of the fixed strings above. With the key set
// pinned, that leaves no room for any other payload value in the line.
function assertLogLine(line, payload) {
  assert.ok(line.startsWith("[mintgrove-klaviyo-relay] {"), line);
  const parsed = JSON.parse(line.replace("[mintgrove-klaviyo-relay] ", ""));
  assert.deepEqual(Object.keys(parsed), ["event", "event_id", "outcome"]);
  assert.match(parsed.outcome, OUTCOME);
  if (parsed.event !== null) assert.equal(parsed.event, payload?.event, line);
  if (parsed.event_id !== null) assert.equal(parsed.event_id, payload?.event_id, line);
  // And the raw line has nothing past the closing brace of those three keys.
  assert.equal(line, `[mintgrove-klaviyo-relay] ${JSON.stringify(parsed)}`);
  return parsed;
}

function assertLogsCarryNoPayload(payload, expectedOutcome) {
  assert.ok(logs.length >= 1, "the relay logs one line per request");
  for (const line of logs) {
    const parsed = assertLogLine(line, payload);
    if (expectedOutcome) assert.equal(parsed.outcome, expectedOutcome);
  }
}

// --- 1. each of the 8 event types -> exactly one "Mintgrove Event" ----------

const PROFILE_BY_EVENT = {
  "seat.assigned": { email: "user@acme.org" },
  "seat.revoked": { email: "user@acme.org" },
  "seat.restored": { email: "user@acme.org" },
  "seat.expiry_ignored": { external_id: "usr_8827311" },
  "seat.grant_held": { external_id: "usr_8827311" },
  "seat.grant_released": { external_id: "usr_8827311" },
  "purchase.completed": { email: "buyer@acme.org" },
  "subscription.renewal_reminder": { email: "buyer@acme.org" },
};

test("the fixture still holds exactly the eight documented events", () => {
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(PROFILE_BY_EVENT).sort());
});

for (const [name, profile] of Object.entries(PROFILE_BY_EVENT)) {
  test(`QA 1: ${name} sends exactly one Mintgrove Event, event property unchanged, exact body`, async () => {
    const payload = examples[name];
    const res = await deliver(payload);
    assert.equal(res.statusCode, 200);
    assertExactlyOneRequest(payload, profile);
    assert.equal(JSON.parse(calls[0].init.body).data.attributes.properties.event, name);
    assertLogsCarryNoPayload(payload, "forwarded");
  });
}

// --- 2. admin events land on admin_email, never a seat holder ---------------

for (const name of ["purchase.completed", "subscription.renewal_reminder"]) {
  test(`QA 2: ${name} lands on admin_email even when seat-holder identifiers are present`, async () => {
    const payload = {
      ...examples[name],
      recipient_email: "user@acme.org",
      external_id: "usr_8827311",
      seat_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38",
    };
    await deliver(payload);
    assertExactlyOneRequest(payload, { email: "buyer@acme.org" });
  });
}

// --- 3. store-path seat.revoked with an opaque recipient_email --------------

test("QA 3: store-path seat.revoked with an opaque recipient_email is keyed by external_id, not email", async () => {
  // The /docs/klaviyo store-path example, with recipient_email and external_id
  // made different so the test proves which field the profile came from.
  const payload = {
    ...examples["seat.revoked"],
    recipient_email: "cus_9KX2mQ4pL7",
    offer_code: null,
    offer_code_used: false,
    external_id: "usr_8827311",
    reason: "expired",
  };
  await deliver(payload);
  assertExactlyOneRequest(payload, { external_id: "usr_8827311" });
});

test("QA 3: ...and falls back to seat_id when that seat has no external_id", async () => {
  const payload = { ...examples["seat.revoked"], recipient_email: "000123.abc", external_id: null };
  await deliver(payload);
  assertExactlyOneRequest(payload, { external_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38" });
});

// --- 3b. seat.restored (MIN-888): recipient_email, then external_id, then seat_id

for (const [label, recipientEmail] of [["null", null], ["empty", ""], ["not an email", "usr_8827311"], ["missing", undefined]]) {
  test(`QA 3b: seat.restored with ${label} recipient_email is keyed by external_id`, async () => {
    const payload = { ...examples["seat.restored"], external_id: "usr_8827311" };
    if (recipientEmail === undefined) delete payload.recipient_email;
    else payload.recipient_email = recipientEmail;
    await deliver(payload);
    assertExactlyOneRequest(payload, { external_id: "usr_8827311" });
  });
}

test("QA 3b: seat.restored with no usable email and a null external_id falls back to seat_id", async () => {
  const payload = { ...examples["seat.restored"], recipient_email: "not-an-email", external_id: null };
  await deliver(payload);
  assertExactlyOneRequest(payload, { external_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38" });
});

test("QA 3b: seat.restored with no usable email, external_id or seat_id is not sent: 422", async () => {
  const { external_id, seat_id, ...payload } = { ...examples["seat.restored"], recipient_email: null };
  const res = await deliver(payload);
  assert.equal(res.statusCode, 422);
  assert.equal(calls.length, 0);
  assertLogsCarryNoPayload(payload, "no_profile_identifier");
});

// --- 4. identifier-only events never build a profile from an email ----------

for (const name of ["seat.expiry_ignored", "seat.grant_held", "seat.grant_released"]) {
  test(`QA 4: ${name} never uses an email, even a valid one smuggled into the payload`, async () => {
    const payload = { ...examples[name], recipient_email: "user@acme.org", admin_email: "buyer@acme.org" };
    await deliver(payload);
    assertExactlyOneRequest(payload, { external_id: "usr_8827311" });
  });

  for (const [label, externalId] of [["null", null], ["empty", ""], ["whitespace", "   "]]) {
    test(`QA 4: ${name} with ${label} external_id falls back to seat_id, never a missing email`, async () => {
      const payload = { ...examples[name], external_id: externalId };
      await deliver(payload);
      assertExactlyOneRequest(payload, { external_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38" });
    });
  }

  test(`QA 4: ${name} with no external_id and no seat_id is not sent: 422`, async () => {
    const { external_id, seat_id, ...payload } = examples[name];
    const res = await deliver(payload);
    assert.equal(res.statusCode, 422);
    assert.equal(calls.length, 0);
    assertLogsCarryNoPayload(payload, "no_profile_identifier");
  });
}

// --- README / docs: the fallback then 422 on the three email-keyed events ---
// that carry no external_id or seat_id.

for (const [name, field] of [
  ["seat.assigned", "recipient_email"],
  ["purchase.completed", "admin_email"],
  ["subscription.renewal_reminder", "admin_email"],
]) {
  for (const [label, value] of [["missing", undefined], ["null", null], ["empty", ""], ["not an email", "usr_8827311"]]) {
    test(`README: ${name} with ${field} ${label} and nothing to fall back on returns 422 and sends nothing`, async () => {
      const payload = { ...examples[name] };
      if (value === undefined) delete payload[field];
      else payload[field] = value;
      const res = await deliver(payload);
      assert.equal(res.statusCode, 422);
      assert.deepEqual(res.body, { error: "No usable profile identifier" });
      assert.equal(calls.length, 0);
      assertLogsCarryNoPayload(payload, "no_profile_identifier");
    });
  }

  test(`README: ${name} with a bad ${field} but an external_id falls back to it`, async () => {
    const payload = { ...examples[name], [field]: null, external_id: "usr_8827311" };
    await deliver(payload);
    assertExactlyOneRequest(payload, { external_id: "usr_8827311" });
  });
}

// --- 5. an unknown future event --------------------------------------------

test("QA 5: an unknown event is forwarded unchanged under Mintgrove Event, keyed by external_id", async () => {
  const payload = {
    event: "seat.grant_withheld",
    recipient_email: "user@acme.org",
    seat_id: "b41f7d2c-90ae-4a63-8f15-2c7e0d9a6b38",
    external_id: "usr_8827311",
    withheld_reason: "country",
    nested: { kept: ["as", "is"] },
    event_id: "0d7c3e1a-8b54-4a2f-9e61-5c7a2b9d0f13",
  };
  const res = await deliver(payload);
  assert.equal(res.statusCode, 200);
  assertExactlyOneRequest(payload, { external_id: "usr_8827311" });
});

test("QA 5: an unknown event with only an email and no ids is not sent: 422, never an email profile", async () => {
  const payload = { event: "buyer.something_new", admin_email: "buyer@acme.org", event_id: "e-1" };
  const res = await deliver(payload);
  assert.equal(res.statusCode, 422);
  assert.equal(calls.length, 0);
});

// --- 6. a repeated event_id -------------------------------------------------

test("QA 6: a redelivery sends a byte-identical request, so Klaviyo's unique_id rule records one event", async () => {
  // Klaviyo's documented rule, applied by the mock: a unique_id repeated for
  // the same profile and metric is recorded only the first time.
  const recorded = [];
  const seen = new Set();
  mockKlaviyo((url, init) => {
    const a = JSON.parse(init.body).data.attributes;
    const key = JSON.stringify([a.profile.data.attributes, a.metric.data.attributes.name, a.unique_id]);
    if (!seen.has(key)) {
      seen.add(key);
      recorded.push(a);
    }
    return new Response(null, { status: 202 });
  });
  const payload = examples["subscription.renewal_reminder"];
  // Different signature timestamps, as on a real redelivery.
  const raw = JSON.stringify(payload);
  await deliver(null, { rawBody: raw, headers: { "mintgrove-signature": sign(raw, { timestamp: Math.floor(Date.now() / 1000) - 60 }) } });
  await deliver(null, { rawBody: raw, headers: { "mintgrove-signature": sign(raw) } });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.equal(JSON.parse(calls[0].init.body).data.attributes.unique_id, payload.event_id);
  assert.equal(recorded.length, 1);
});

// --- 7. bad or missing signature --------------------------------------------

test("QA 7: every bad or missing signature returns 401, forwards nothing and logs no payload", async () => {
  const payload = examples["purchase.completed"];
  const raw = JSON.stringify(payload);
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    missing: {},
    empty: { "mintgrove-signature": "" },
    garbage: { "mintgrove-signature": "nonsense" },
    "no timestamp": { "mintgrove-signature": `v1=${"a".repeat(64)}` },
    "no v1": { "mintgrove-signature": `t=${now}` },
    "wrong secret": { "mintgrove-signature": sign(raw, { secret: "whsec_other" }) },
    "stale timestamp": { "mintgrove-signature": sign(raw, { timestamp: now - 301 }) },
    "future timestamp": { "mintgrove-signature": sign(raw, { timestamp: now + 301 }) },
    "signature over other bytes": { "mintgrove-signature": sign(raw.replace("buyer@acme.org", "x@y.z")) },
  };
  for (const [label, headers] of Object.entries(cases)) {
    logs = [];
    const res = await deliver(null, { rawBody: raw, headers });
    assert.equal(res.statusCode, 401, label);
    assert.deepEqual(res.body, { error: "Invalid signature" }, label);
    assertLogsCarryNoPayload(payload, "invalid_signature");
  }
  assert.equal(calls.length, 0);
});

// --- 8. Klaviyo failure -> 502, matching the docs ---------------------------
// Docs (word for word): "If Klaviyo accepts the event, the relay returns 200.
// If Klaviyo returns any non-2xx status, cannot be reached, or does not answer
// within 8 seconds, the relay returns 502".

for (const status of [200, 201, 202, 204]) {
  test(`QA 8: Klaviyo answering ${status} (2xx) returns 200`, async () => {
    mockKlaviyo(() => new Response(null, { status }));
    const res = await deliver(examples["seat.assigned"]);
    assert.equal(res.statusCode, 200);
  });
}

// Retryable: a setup error (401/403 key, 404/405/410/415 request shape), 408,
// 429, every 5xx, a non-2xx that is not a 4xx, and 413/422, which Klaviyo's
// status table does not document.
for (const status of [301, 401, 403, 404, 405, 408, 410, 413, 415, 422, 429, 500, 502, 503, 504]) {
  test(`QA 8: Klaviyo answering ${status} returns 502 and logs klaviyo_rejected_${status}`, async () => {
    mockKlaviyo(() => new Response(null, { status }));
    const payload = examples["seat.assigned"];
    const res = await deliver(payload);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: "Klaviyo did not accept the event" });
    assertExactlyOneRequest(payload, { email: "user@acme.org" });
    assertLogsCarryNoPayload(payload, `klaviyo_rejected_${status}`);
  });
}

// MIN-876 ruling (Nicole, 2026-09-30, corrected): only a Klaviyo response that
// says THIS EVENT's data is bad is final. Per Klaviyo's status table
// (https://developers.klaviyo.com/en/docs/rate_limits_and_error_handling) that
// is 400 and 409. The relay answers 200 and logs the rejection with no payload
// body; the exact request still went to Klaviyo exactly once.
for (const status of [400, 409]) {
  test(`QA 8: Klaviyo rejecting the event's data with ${status} is final: 200, one request, logs klaviyo_dropped_${status}`, async () => {
    mockKlaviyo(() => new Response(JSON.stringify({ errors: [{ status, detail: "rejected" }] }), { status }));
    const payload = examples["purchase.completed"];
    const res = await deliver(payload);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: false, error: "Klaviyo rejected the event; not retried" });
    assertExactlyOneRequest(payload, { email: "buyer@acme.org" });
    assertLogsCarryNoPayload(payload, `klaviyo_dropped_${status}`);
  });
}

test("QA 8: a final rejection is not re-sent on redelivery-style retries either: every delivery is one request, one 200", async () => {
  mockKlaviyo(() => new Response(null, { status: 400 }));
  const payload = examples["seat.revoked"];
  for (let i = 0; i < 3; i++) assert.equal((await deliver(payload)).statusCode, 200);
  assert.equal(calls.length, 3);
});

// MIN-876 ruling 5: only the body is signed, so unique_id must come from the
// body's event_id, never from the Mintgrove-Event-Id header.
test("unique_id is the signed body's event_id, even when the Mintgrove-Event-Id header says otherwise", async () => {
  const payload = examples["seat.grant_held"];
  const raw = JSON.stringify(payload);
  const res = await deliver(null, {
    rawBody: raw,
    headers: { "mintgrove-signature": sign(raw), "mintgrove-event-id": "11111111-2222-3333-4444-555555555555" },
  });
  assert.equal(res.statusCode, 200);
  assertExactlyOneRequest(payload, { external_id: "usr_8827311" });
  assert.equal(JSON.parse(calls[0].init.body).data.attributes.unique_id, payload.event_id);
});

test("QA 8: Klaviyo unreachable returns 502", async () => {
  mockKlaviyo(() => {
    throw new TypeError("fetch failed");
  });
  const payload = examples["purchase.completed"];
  const res = await deliver(payload);
  assert.equal(res.statusCode, 502);
  assertLogsCarryNoPayload(payload, "klaviyo_unreachable");
});

test("QA 8: Klaviyo not answering is cut off at 8 seconds and returns 502", async () => {
  // A Klaviyo that never answers until the relay's own signal aborts it.
  mockKlaviyo(
    (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      })
  );
  const payload = examples["seat.grant_released"];
  const started = Date.now();
  const res = await deliver(payload);
  const elapsed = Date.now() - started;
  assert.equal(res.statusCode, 502);
  assert.ok(elapsed >= 7900 && elapsed < 9500, `aborted after ${elapsed}ms, expected ~8000ms`);
  assertLogsCarryNoPayload(payload, "klaviyo_timeout");
});

// --- 9. no payload bodies logged, on every path -----------------------------

test("QA 9: across all eight events and every outcome, logs never carry payload data", async () => {
  const byEventId = new Map(Object.values(examples).map((p) => [p.event_id, p]));
  for (const payload of Object.values(examples)) await deliver(payload); // forwarded
  mockKlaviyo(() => new Response(null, { status: 500 }));
  for (const payload of Object.values(examples)) await deliver(payload); // klaviyo_rejected_500
  mockKlaviyo(() => new Response(null, { status: 400 }));
  await deliver(examples["purchase.completed"]); // klaviyo_dropped_400
  await deliver({ ...examples["subscription.renewal_reminder"], admin_email: null }); // no_profile_identifier
  await deliver(null, { rawBody: JSON.stringify(examples["seat.assigned"]), headers: {} }); // invalid_signature

  const outcomes = new Set();
  for (const line of logs) {
    const id = JSON.parse(line.replace("[mintgrove-klaviyo-relay] ", "")).event_id;
    outcomes.add(assertLogLine(line, id === null ? null : byEventId.get(id)).outcome);
    // Belt and braces: no email address, name or organization anywhere.
    for (const value of ["user@acme.org", "buyer@acme.org", "Jane Smith", "Acme Corp", "usr_8827311", "MG-4KQ2-8ZTP"]) {
      assert.ok(!line.includes(value), `log leaks "${value}": ${line}`);
    }
  }
  assert.deepEqual(
    [...outcomes].sort(),
    ["forwarded", "invalid_signature", "klaviyo_dropped_400", "klaviyo_rejected_500", "no_profile_identifier"].sort()
  );
});
