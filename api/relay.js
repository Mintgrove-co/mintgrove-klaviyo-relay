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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const signingSecret = process.env.MINTGROVE_SIGNING_SECRET;
  if (!signingSecret) {
    // Fail closed. An unauthenticated relay lets anyone who discovers this URL
    // POST fabricated seat events into your Klaviyo account.
    console.error(
      "[mintgrove-klaviyo-relay] MINTGROVE_SIGNING_SECRET is not set - refusing to process webhooks"
    );
    res.status(500).json({ error: "Relay is not configured" });
    return;
  }

  const rawBody = await readRawBody(req);

  const version = req.headers["mintgrove-webhook-version"];
  if (version && version !== SUPPORTED_WEBHOOK_VERSION) {
    console.error(
      `[mintgrove-klaviyo-relay] unsupported webhook version ${version} (expected ${SUPPORTED_WEBHOOK_VERSION})`
    );
    res.status(400).json({ error: "Unsupported webhook version" });
    return;
  }

  if (!verifySignature(rawBody, req.headers["mintgrove-signature"], signingSecret)) {
    console.error("[mintgrove-klaviyo-relay] rejected request with invalid signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.error("[mintgrove-klaviyo-relay] rejected request with malformed JSON body");
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }

  const metricName =
    body.event === "seat.assigned"
      ? "Enterprise Seat Assigned"
      : "Enterprise Seat Revoked";

  const [firstName, ...rest] = (body.recipient_name ?? "").split(" ");

  const klaviyoPayload = {
    data: {
      type: "event",
      attributes: {
        metric: { data: { type: "metric", attributes: { name: metricName } } },
        profile: {
          data: {
            type: "profile",
            attributes: {
              email: body.recipient_email,
              first_name: firstName ?? "",
              last_name: rest.join(" "),
            },
          },
        },
        properties: {
          org_name: body.org_name,
          app_name: body.app_name,
          seat_expiry: body.seat_expiry,
          offer_code: body.offer_code,
          offer_code_used: body.offer_code_used,
        },
        time: new Date().toISOString(),
      },
    },
  };

  const maskedEmail = body.recipient_email
    ? body.recipient_email.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => `${a}${b[0] ?? ""}***${c}`)
    : "unknown";
  console.log(`[mintgrove-klaviyo-relay] ${body.event} for ${maskedEmail}`);

  try {
    const klaviyoRes = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_API_KEY}`,
        "Content-Type": "application/json",
        revision: "2024-02-15",
      },
      body: JSON.stringify(klaviyoPayload),
    });
    if (!klaviyoRes.ok) {
      console.error(`[mintgrove-klaviyo-relay] Klaviyo API returned ${klaviyoRes.status}`);
    }
  } catch (err) {
    console.error("[mintgrove-klaviyo-relay] forward failed", err);
  }

  // Always ack 2xx so Mintgrove does not treat this as a failed delivery.
  res.status(200).json({ ok: true });
}
