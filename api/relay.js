import crypto from "crypto";

// Mintgrove signs the exact bytes it sent, so we verify against the raw body
// and parse it ourselves. Reading the stream below is safe on Vercel: the Node
// runtime buffers the body and replays it, and req.body is only parsed if you
// touch it. Do not swap this for req.body - re-serializing parsed JSON can
// reorder keys or change escaping, which breaks the signature.
//
// (Note for anyone porting this: `config.api.bodyParser = false` is a Next.js
// API-route setting. It does nothing in a standalone Vercel function, and you
// do not need it here.)

// Reject signatures older than this. Closes the window for someone replaying a
// captured, validly-signed request later.
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

// Signing scheme this relay understands. Mintgrove bumps this only if the
// header format or the hashed string changes. See mintgrove.co/docs/klaviyo.
const SUPPORTED_WEBHOOK_VERSION = "2026-07-18";

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signatureHeader, signingSecret) {
  if (!signatureHeader || !signingSecret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((pair) => pair.split("=").map((s) => s.trim()))
  );
  const { t: timestamp, v1: signature } = parts;
  if (!timestamp || !signature) return false;

  // Reject stale or far-future timestamps before doing any crypto work.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signature, "hex");
  // timingSafeEqual throws on length mismatch, so check that first.
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Every Mintgrove event lands in Klaviyo under this one metric. Build one Flow
// triggered on it and split on the `event` property, one branch per email.
export const METRIC_NAME = "Mintgrove Event";

// Klaviyo API revision this relay was written against.
const KLAVIYO_REVISION = "2026-07-15";

// Mintgrove gives each delivery attempt 10 seconds. Klaviyo gets 8 of them, so
// a slow Klaviyo call still ends in a 502 that Mintgrove sees and retries,
// rather than in Mintgrove timing out while we are mid-request.
const KLAVIYO_TIMEOUT_MS = 8000;

// Events whose profile is the address in the named field, when that field holds
// a real email address. Every other event, including one this relay has never
// heard of, is identified by external_id instead.
const EMAIL_FIELD_BY_EVENT = {
  "seat.assigned": "recipient_email",
  "seat.revoked": "recipient_email",
  "purchase.completed": "admin_email",
  "subscription.renewal_reminder": "admin_email",
};

// A syntax check, not a deliverability check. It exists because seat.revoked
// from the store path carries the provider's own identifier in
// recipient_email, which for most apps is an opaque customer id, not an email.
function isEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// Which Klaviyo profile this event belongs to. Returns null when the payload
// carries nothing usable, in which case nothing is sent.
export function profileIdentifier(payload) {
  const emailField = EMAIL_FIELD_BY_EVENT[payload.event];
  if (emailField && isEmail(payload[emailField])) {
    return { email: payload[emailField] };
  }
  const externalId = nonEmptyString(payload.external_id) ?? nonEmptyString(payload.seat_id);
  return externalId ? { external_id: externalId } : null;
}

// The Klaviyo Create Event body for one Mintgrove payload, or null if the
// payload has no usable profile identifier. Properties are the payload itself,
// every field under its own name, unchanged.
export function toKlaviyoEvent(payload) {
  const identifier = profileIdentifier(payload);
  if (!identifier) return null;

  const attributes = {
    metric: { data: { type: "metric", attributes: { name: METRIC_NAME } } },
    profile: { data: { type: "profile", attributes: identifier } },
    properties: payload,
  };
  // Klaviyo records only the first event per unique_id for a given profile and
  // metric, so a Mintgrove redelivery of the same event_id is not counted twice.
  if (nonEmptyString(payload.event_id)) attributes.unique_id = payload.event_id;

  return { data: { type: "event", attributes } };
}

// Klaviyo statuses that mean THIS EVENT's data was rejected, so sending the
// same bytes again can never succeed. Taken from Klaviyo's status code table
// (https://developers.klaviyo.com/en/docs/rate_limits_and_error_handling):
//   400 Bad Request  "missing a required parameter or has an invalid parameter"
//   409 Conflict     "conflicts with the current state of the server"
// Everything else answers 502 so Mintgrove retries: 401/403 are a wrong or
// under-scoped key and clear once the key is fixed; 404/405/410/415 are this
// relay's own request shape; 408, 429, 5xx, timeouts and network errors are
// transient. 422 is not in Klaviyo's table, so it is not treated as final.
// Ruled by Nicole 2026-09-30 (MIN-876), corrected the same day.
const FINAL_KLAVIYO_STATUSES = new Set([400, 409]);

export function isFinalRejection(status) {
  return FINAL_KLAVIYO_STATUSES.has(status);
}

// The only thing this relay ever logs. No payload bodies, no emails, no names.
function log(outcome, payload) {
  const line = JSON.stringify({
    event: typeof payload?.event === "string" ? payload.event : null,
    event_id: typeof payload?.event_id === "string" ? payload.event_id : null,
    outcome,
  });
  if (outcome === "forwarded") console.log(`[mintgrove-klaviyo-relay] ${line}`);
  else console.error(`[mintgrove-klaviyo-relay] ${line}`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const signingSecret = process.env.MINTGROVE_SIGNING_SECRET;
  const klaviyoKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  if (!signingSecret || !klaviyoKey) {
    // Fail closed. An unauthenticated relay lets anyone who discovers this URL
    // POST fabricated events into your Klaviyo account. A 5xx here also means
    // Mintgrove keeps retrying, so events sent before you set the variables
    // still arrive once you do.
    log("relay_not_configured", null);
    res.status(500).json({ error: "Relay is not configured" });
    return;
  }

  const rawBody = await readRawBody(req);

  const version = req.headers["mintgrove-webhook-version"];
  if (version && version !== SUPPORTED_WEBHOOK_VERSION) {
    log("unsupported_webhook_version", null);
    res.status(400).json({ error: "Unsupported webhook version" });
    return;
  }

  if (!verifySignature(rawBody, req.headers["mintgrove-signature"], signingSecret)) {
    log("invalid_signature", null);
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    log("malformed_body", null);
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }

  const klaviyoEvent = toKlaviyoEvent(payload);
  if (!klaviyoEvent) {
    // Klaviyo cannot record an event without a profile, and inventing one would
    // create a junk profile. Answer non-2xx so the miss shows up on Mintgrove's
    // side as a failed delivery instead of disappearing behind a 200.
    log("no_profile_identifier", payload);
    res.status(422).json({ error: "No usable profile identifier" });
    return;
  }

  // Klaviyo is called before we answer Mintgrove. If it fails in a way a retry
  // can fix, we answer 502 and Mintgrove's retry schedule sends the event
  // again; unique_id stops a retry after a slow-but-successful call from being
  // recorded twice. If Klaviyo rejects the event's data (400 or 409), we answer
  // 200: see isFinalRejection.
  let klaviyoStatus;
  try {
    const klaviyoRes = await fetch("https://a.klaviyo.com/api/events", {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${klaviyoKey}`,
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
        revision: KLAVIYO_REVISION,
      },
      body: JSON.stringify(klaviyoEvent),
      signal: AbortSignal.timeout(KLAVIYO_TIMEOUT_MS),
    });
    klaviyoStatus = klaviyoRes.status;
  } catch (err) {
    log(err?.name === "TimeoutError" ? "klaviyo_timeout" : "klaviyo_unreachable", payload);
    res.status(502).json({ error: "Klaviyo did not accept the event" });
    return;
  }

  if (klaviyoStatus < 200 || klaviyoStatus >= 300) {
    if (isFinalRejection(klaviyoStatus)) {
      // Klaviyo rejected this event's data. Sending the same event again cannot
      // change that, so a 502 would only buy six hours of identical retries.
      // The event is not in Klaviyo; the log line (never the payload) is the
      // record of it.
      log(`klaviyo_dropped_${klaviyoStatus}`, payload);
      res.status(200).json({ ok: false, error: "Klaviyo rejected the event; not retried" });
      return;
    }
    log(`klaviyo_rejected_${klaviyoStatus}`, payload);
    res.status(502).json({ error: "Klaviyo did not accept the event" });
    return;
  }

  log("forwarded", payload);
  res.status(200).json({ ok: true });
}
