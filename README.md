# Mintgrove webhook relay (reference)

A small, deployable example of an endpoint that receives Mintgrove webhooks.

When something happens to a seat or a purchase in your app, Mintgrove sends a
webhook: a single HTTP request describing what happened. This relay receives every
Mintgrove webhook, checks that the request genuinely came from Mintgrove, and
acknowledges it. It is one file, has no dependencies, and is meant to be forked and
deployed as-is.

**These events are for sending one transactional email each. They are not for CRM
use.** Do not create, update or subscribe a profile, contact, list or audience in
Klaviyo or any other CRM from these events, and do not send these events to Klaviyo.
A buyer admin's details belong in your CRM only if that buyer has opted in to your
app, and not through these events. Mintgrove cannot see what your app does with a
payload after it is delivered.

This relay follows that rule. It sends nothing to Klaviyo or any CRM, and it builds no
profile from `recipient_email` or `admin_email`. To send the email an event calls for,
add your own transactional email provider's send call where `api/relay.js` marks it.
The full per-event contract, including who each email is for, is in the
[setup guide](https://app.mintgrove.co/docs/klaviyo).

## Before you start

You'll need:

- **Your Mintgrove webhook signing secret.**
  In Mintgrove: **Settings → Integrations → Event delivery → Webhook endpoint**,
  in the **Signing secret** field.
- **A Vercel account** (the free plan is fine) and [Node.js](https://nodejs.org) installed.

You do not need to know how to write JavaScript to deploy this, but you will need to
be comfortable running a few commands in a terminal.

## Deploy it

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Mintgrove-co/mintgrove-klaviyo-relay)

The button above is the quickest route: it copies this repo into your own GitHub
account and deploys it, prompting you for the environment variable along the way.
Once it finishes, skip to [step 4](#4-tell-mintgrove-where-to-send-events).

Prefer to do it by hand? Follow the four steps below.

### 1. Get your own copy

Click **Use this template → Create a new repository** at the top of this page (or fork
it), then clone your copy and move into the folder:

```bash
git clone https://github.com/YOUR-USERNAME/mintgrove-klaviyo-relay.git
cd mintgrove-klaviyo-relay
```

### 2. Create a Vercel project

If you don't already have the Vercel CLI:

```bash
npm i -g vercel
```

Then, from inside the folder, run:

```bash
vercel
```

Answer the prompts (accepting the defaults is fine). This creates a new Vercel project
and gives you a preview deployment.

### 3. Add your credentials

The relay reads one environment variable. Add it:

```bash
vercel env add MINTGROVE_SIGNING_SECRET production
```

The command prompts you to paste the value. You can also add it in the Vercel
dashboard under **Settings → Environment Variables**. See `.env.example` for a
description.

Now deploy to production:

```bash
vercel --prod
```

This prints your public URL, something like
`https://your-project-name.vercel.app`.

> **Environment variables only apply to deployments made after you add them.** If you
> ran `vercel --prod` before adding the variable, run it again.

### 4. Tell Mintgrove where to send events

In Mintgrove, go to **Settings → Integrations**, find the **Event delivery** section,
and in its **Webhook endpoint** card enter your relay's URL (your deployment
URL with `/api/relay` on the end) into the **Webhook endpoint URL** field, then click
**Save**:

```
https://your-project-name.vercel.app/api/relay
```

Now send one real event through the relay: assign a seat to a test user, then check
the logs (see [Checking it works](#checking-it-works)) for a `verified` line for
`seat.assigned`.

## What it does with an event

Every event is handled the same way: the relay verifies it and answers `200`. It makes
no outbound request of any kind. In particular:

- **Nothing is sent to Klaviyo or any other CRM**, for any event, including an event
  this relay has never heard of.
- **No profile is built.** `recipient_email` and `admin_email` are not read, and the
  relay never sets a profile, contact or list entry from any field.
- **The payload is not stored.** It is not written to the logs either.

Your own handler goes where `api/relay.js` marks it, and is where the email is sent.
The contract it follows, per event, is in the
[setup guide](https://app.mintgrove.co/docs/klaviyo), and the payloads are documented at
[app.mintgrove.co/docs/email-crm](https://app.mintgrove.co/docs/email-crm). Two things
from that contract matter when you add the send:

- **Deduplicate on `event_id`.** Mintgrove sends the same `event_id` on every retry of
  one event, so a redelivery must not send a second email. Only the body is signed, so
  read `event_id` from the verified body, never from the `Mintgrove-Event-Id` header.
- **An event with no usable address and no way to look the person up in your own
  records is not emailed.** Answer `200` and send nothing.

## If your send fails

Mintgrove gives each delivery attempt 10 seconds. If your handler answers with a `5xx`,
Mintgrove retries in the same request, roughly 1, 3 and 8 seconds apart. If those fail
too, the event goes to Mintgrove's durable queue and is retried roughly 5, 10, 20 and
40 minutes later, then hourly, then every two hours, for up to 6 hours from the first
failure. One that lasts longer than 6 hours loses the event. A `4xx` is not retried in
the same request, but it is put on the same durable queue. As the relay stands, it
answers `200` once the request is verified.

## Checking it works

Vercel keeps a log of every request. Run `vercel logs <your-deployment-url>`, or open
your project in the Vercel dashboard and click **Logs**. Each request prints one line
with the event name, its `event_id` and what happened. It never logs payload bodies,
email addresses, names or other personal data:

```
[mintgrove-klaviyo-relay] {"event":"seat.assigned","event_id":"8f2a1b6e-4d90-4c3a-9e71-5b6a2f0d8c44","outcome":"verified"}
```

The possible outcomes are:

| Outcome | Relay returns | Meaning |
| ------- | ------------- | ------- |
| `verified` | `200` | The request came from Mintgrove. Nothing was sent anywhere. |
| `invalid_signature` | `401` | Missing, wrong or expired signature. |
| `unsupported_webhook_version` | `400` | See below. |
| `malformed_body` | `400` | The signed body wasn't a JSON object. |
| `relay_not_configured` | `500` | `MINTGROVE_SIGNING_SECRET` isn't set. |

## Running the tests

```bash
npm test
```

The tests use Node's built-in test runner, with no dependencies. They send each of
Mintgrove's eleven documented example payloads through the relay while recording every
outbound request, and fail if the relay makes any. They also cover bad signatures,
unsupported versions, malformed bodies and logging.

## This is a starting point, not a finished product

It verifies that requests really come from Mintgrove (HMAC-SHA256 over the raw
body, constant-time comparison, and a five-minute replay window, the scheme described
under "Verifying webhook signatures" in the
[setup guide](https://app.mintgrove.co/docs/klaviyo)). It refuses to process anything
if `MINTGROVE_SIGNING_SECRET` is unset, rather than
quietly accepting unsigned traffic.

Some things are deliberately left out, because the right answer depends on your setup:

- **No alerting.** Failures are written to the logs and nowhere else. Wire them into
  whatever you already use for monitoring.
- **Signing-scheme changes are rejected, not tolerated.** If Mintgrove bumps
  `Mintgrove-Webhook-Version`, this relay returns `400` until you update
  `SUPPORTED_WEBHOOK_VERSION` in `api/relay.js`. That's the safe default, but it means
  you should keep an eye on Mintgrove's changelog.

Read `api/relay.js` before you rely on it. It's the whole thing.

## Full setup guide

For the complete walkthrough, including the per-event contract, how to build the
endpoint with or without this relay, and troubleshooting:

**[app.mintgrove.co/docs/klaviyo](https://app.mintgrove.co/docs/klaviyo)**

## License

MIT, see [LICENSE](LICENSE). Use it, change it, ship it.
