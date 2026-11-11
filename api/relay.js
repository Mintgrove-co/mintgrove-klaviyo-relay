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

// The only thing this relay ever logs. No payload bodies, no emails, no names.
function log(outcome, payload) {
  const line = JSON.stringify({
    event: typeof payload?.event === "string" ? payload.event : null,
    event_id: typeof payload?.event_id === "string" ? payload.event_id : null,
    outcome,
  });
  if (outcome === "verified") console.log(`[mintgrove-klaviyo-relay] ${line}`);
  else console.error(`[mintgrove-klaviyo-relay] ${line}`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const signingSecret = process.env.MINTGROVE_SIGNING_SECRET;
  if (!signingSecret) {
    // Fail closed. An unauthenticated relay lets anyone who discovers this URL
    // POST fabricated events to your endpoint. A 5xx here also means Mintgrove
    // keeps retrying, so events sent before you set the variable still arrive
    // once you do.
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

  // MIN-1270: the payload is verified and nothing more. It is not sent to
  // Klaviyo or any other CRM, and no profile is built from recipient_email or
  // admin_email. Send the one email this event calls for here, through your own
  // transactional email provider (see /docs/klaviyo), and deduplicate on
  // payload.event_id. Do not store the payload or the address.
  log("verified", payload);
  res.status(200).json({ ok: true });
}
