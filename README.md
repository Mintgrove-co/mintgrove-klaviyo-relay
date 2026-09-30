# Mintgrove → Klaviyo relay

A small, deployable example that connects Mintgrove to Klaviyo.

When something happens to a seat or a purchase in your app, Mintgrove sends a
webhook: a single HTTP request describing what happened. Klaviyo wants events in its
own format. This relay sits between the two. It receives every Mintgrove webhook,
checks that the request genuinely came from Mintgrove, turns it into a
[Klaviyo Create Event](https://developers.klaviyo.com/en/reference/create_event)
call, and forwards it. Once events are landing in Klaviyo, you build one Flow off
them that sends the right email for each event. It's one file, has no dependencies,
and is meant to be forked and deployed as-is.

## Before you start

You'll need:

- **A Klaviyo account**, and a **Private API Key** with write access to Events.
  In Klaviyo: **Settings → API Keys → Create Private API Key**.
- **Your Mintgrove webhook signing secret.**
  In Mintgrove: **Settings → Integrations → Email Delivery → Email webhook endpoint**,
  in the **Signing secret** field. (If your app uses bind identity, the section is
  called **Event delivery** and the card **Webhook endpoint**.)
- **A Vercel account** (the free plan is fine) and [Node.js](https://nodejs.org) installed.

You do not need to know how to write JavaScript to deploy this, but you will need to
be comfortable running a few commands in a terminal.

## Deploy it

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Mintgrove-co/mintgrove-klaviyo-relay)

The button above is the quickest route: it copies this repo into your own GitHub
account and deploys it, prompting you for the two environment variables along the way.
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

The relay reads two environment variables. Add both:

```bash
vercel env add KLAVIYO_PRIVATE_API_KEY production
vercel env add MINTGROVE_SIGNING_SECRET production
```

Each command prompts you to paste the value. You can also add them in the Vercel
dashboard under **Settings → Environment Variables**. See `.env.example` for a
description of each.

Now deploy to production:

```bash
vercel --prod
```

This prints your public URL, something like
`https://your-project-name.vercel.app`.

> **Environment variables only apply to deployments made after you add them.** If you
> ran `vercel --prod` before adding the variables, run it again.

### 4. Tell Mintgrove where to send events

In Mintgrove, go to **Settings → Integrations**, find the **Email Delivery** section
(**Event delivery** for a bind-identity app), and in its **Email webhook endpoint** card
(**Webhook endpoint** for a bind-identity app) enter your relay's URL (your deployment
URL with `/api/relay` on the end) into the **Webhook endpoint URL** field, then click
**Save**:

```
https://your-project-name.vercel.app/api/relay
```

That's it. Assign a seat to a test user, then check **Analytics → Metrics** in Klaviyo
for a `Mintgrove Event` event whose `event` property is `seat.assigned`.

## What it sends to Klaviyo

Every Mintgrove event is sent to Klaviyo's Create Event API under **one metric**,
`Mintgrove Event`. The relay does not choose a metric per event. Which event it was
is in the `event` property.

| Klaviyo field | Value |
| ------------- | ----- |
| Metric name   | `Mintgrove Event`, for every event |
| Properties    | The full webhook payload: every field, under the same name, unchanged, including `event` |
| `unique_id`   | The payload's `event_id` |
| Profile       | See the next table |

The profile the event is recorded against. The relay tries the first column, then the
second, and forwards nothing if neither gives it an identifier:

| `event` | First choice | Otherwise |
| ------- | ------------ | --------- |
| `seat.assigned` | `email` = `recipient_email`, if it is an email address | `external_id` = the payload's `external_id`, or `seat_id` if that is empty. This event carries neither, so in practice: nothing sent, `422` |
| `seat.revoked` | `email` = `recipient_email`, if it is an email address | `external_id` = the payload's `external_id`, or `seat_id` if that is empty. Every `seat.revoked` carries `seat_id`, so this always resolves |
| `seat.restored` | `email` = `recipient_email`, if it is an email address | `external_id` = the payload's `external_id`, or `seat_id` if that is empty. Every `seat.restored` carries `seat_id`, so this always resolves |
| `purchase.completed` | `email` = `admin_email`, if it is an email address | `external_id` = the payload's `external_id`, or `seat_id` if that is empty. This event carries neither, so in practice: nothing sent, `422` |
| `subscription.renewal_reminder` | `email` = `admin_email`, if it is an email address | `external_id` = the payload's `external_id`, or `seat_id` if that is empty. This event carries neither, so in practice: nothing sent, `422` |
| `seat.expiry_ignored`, `seat.grant_held`, `seat.grant_released`, and any `event` value not listed here | `external_id` = the payload's `external_id`, or `seat_id` if `external_id` is empty | nothing sent, `422` |

"Is an email address" is a syntax check (something `@` something `.` something, no
spaces, at most 254 characters), not a deliverability check. A missing, `null`, empty or
non-email value never becomes a profile email.

Details that matter when you build on this:

- **`seat.revoked` does not always carry an email.** When the store or billing side
  ends a subscription, `recipient_email` holds whatever identifier the provider sent,
  which for most apps is an opaque customer id. The relay only uses it as a profile
  email if it is a syntactically valid email address. If it is not, the event is
  identified by `external_id` (or `seat_id`) instead.
- **Identifier-only events only reach a person if your profiles carry the same
  `external_id`.** For `seat.expiry_ignored`, `seat.grant_held`,
  `seat.grant_released`, and a `seat.revoked` or `seat.restored` whose
  `recipient_email` is not an email address, the relay sets the Klaviyo
  profile's `external_id`. That only resolves to an existing person if the profiles
  in your Klaviyo account already carry the same `external_id` your app gives
  Mintgrove. If they don't, Klaviyo creates a new profile with that `external_id`
  and no email, and a Flow cannot email it.
- **No profile email is ever set from a missing or non-email value.** The relay never
  sets a profile's name or any other profile field either. Use
  `{{ event.recipient_name }}` and the other event properties in your templates.
- **Unknown events are forwarded, not dropped.** If Mintgrove adds an event this
  relay doesn't know about, it goes to Klaviyo unchanged, under `Mintgrove Event`,
  identified by `external_id` (or `seat_id`). It matches no branch in your Flow, so no
  email is sent until you add one.
- **An event with no usable identifier is not sent.** If a payload has no usable
  email for its event and no `external_id` or `seat_id` either, Klaviyo has no
  profile to record it against. The relay forwards nothing and returns `422` to
  Mintgrove, so the miss appears as a failed delivery rather than a silent success.
  For `seat.assigned`, `purchase.completed` and `subscription.renewal_reminder`, which
  carry no `external_id` or `seat_id`, that means any delivery whose `recipient_email`
  or `admin_email` is missing or not an email address. In particular, a
  `subscription.renewal_reminder` whose `admin_email` is `null` returns `422`. Mintgrove
  does not expect to send one; the `422` is a guard, so a malformed reminder shows up as
  a failed delivery instead of an event on a junk profile.
- **Redeliveries are deduplicated by Klaviyo.** Mintgrove sends the same `event_id`
  on every retry of one event. Klaviyo records only the first event with a given
  `unique_id` for the same profile and metric, so a redelivery does not produce a
  second event or a second email.

### Building the Flow

Create one Flow triggered on the `Mintgrove Event` metric. Add a multi-branch split
on the `event` property, with one branch per email you send, for
example `seat.assigned` and `subscription.renewal_reminder`. Anything that matches no
branch ends with no email. Do not chain yes/no splits. In templates, payload fields
are available as event properties, for example `{{ event.org_name }}` or
`{{ event.period_end_date }}`.

The full per-event contract, including which email to send each event and who
receives it, is in the [setup guide](https://app.mintgrove.co/docs/klaviyo). The
payloads themselves are documented at
[app.mintgrove.co/docs/email-crm](https://app.mintgrove.co/docs/email-crm).

## If Klaviyo fails

The relay calls Klaviyo **before** it answers Mintgrove, and the answer reflects what
Klaviyo did:

- Klaviyo accepts the event: the relay returns `200`.
- Klaviyo returns any non-2xx status, can't be reached, or takes longer than 8
  seconds: the relay returns `502`, and Mintgrove's retry schedule sends the event
  again.

Mintgrove gives each delivery attempt 10 seconds, so the relay stops waiting on
Klaviyo after 8. A `502` is retried in the same request, roughly 1, 3 and 8 seconds
apart. If those fail too, the event goes to Mintgrove's durable queue and is retried
roughly 5, 10, 20 and 40 minutes later, then hourly, then every two hours, for up to
6 hours from the first failure. A Klaviyo outage, or a wrong API key fixed within
that window, loses nothing. One that lasts longer than 6 hours still loses the event.
Every retry carries the same `event_id`, so an attempt that Klaviyo accepted but
answered too slowly is not recorded twice.

## Checking it works

Vercel keeps a log of every request. Run `vercel logs <your-deployment-url>`, or open
your project in the Vercel dashboard and click **Logs**. Each request prints one line
with the event name, its `event_id` and what happened. It never logs payload bodies,
email addresses, names or other personal data:

```
[mintgrove-klaviyo-relay] {"event":"seat.assigned","event_id":"8f2a1b6e-4d90-4c3a-9e71-5b6a2f0d8c44","outcome":"forwarded"}
```

The possible outcomes are:

| Outcome | Relay returns | Meaning |
| ------- | ------------- | ------- |
| `forwarded` | `200` | Klaviyo accepted the event. |
| `klaviyo_rejected_<status>` | `502` | Klaviyo returned that status. Mintgrove will retry. |
| `klaviyo_timeout` / `klaviyo_unreachable` | `502` | Klaviyo didn't answer in 8 seconds, or couldn't be reached. Mintgrove will retry. |
| `no_profile_identifier` | `422` | The payload had no usable email, `external_id` or `seat_id`. Nothing was sent. |
| `invalid_signature` | `401` | Missing, wrong or expired signature. Nothing was sent. |
| `unsupported_webhook_version` | `400` | See below. |
| `malformed_body` | `400` | The signed body wasn't a JSON object. |
| `relay_not_configured` | `500` | `MINTGROVE_SIGNING_SECRET` or `KLAVIYO_PRIVATE_API_KEY` isn't set. |

`klaviyo_rejected_401` almost always means `KLAVIYO_PRIVATE_API_KEY` is wrong or lacks
Events write access.

## Running the tests

```bash
npm test
```

The tests use Node's built-in test runner, with no dependencies. They send each of
Mintgrove's eight documented example payloads through the relay against a stand-in
for Klaviyo, and cover opaque `seat.revoked` identifiers, unknown events, redelivery,
bad signatures, Klaviyo failures and logging.
`test/request-body.test.js` goes further: for every case it compares the exact request
the relay sends to Klaviyo (URL, method, headers and body bytes) with one written out by
hand from the contract above, so any change to what reaches Klaviyo fails a test.

## This is a starting point, not a finished product

It verifies that requests really come from Mintgrove (HMAC-SHA256 over the raw
body, constant-time comparison, and a five-minute replay window, the scheme described
under "Verifying webhook signatures" in the
[setup guide](https://app.mintgrove.co/docs/klaviyo)). It refuses to process anything
if `MINTGROVE_SIGNING_SECRET` or `KLAVIYO_PRIVATE_API_KEY` is unset, rather than
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

For the complete walkthrough, including the Klaviyo Flow that actually sends the
emails, no-code alternatives to this relay, and troubleshooting:

**[app.mintgrove.co/docs/klaviyo](https://app.mintgrove.co/docs/klaviyo)**

## License

MIT — see [LICENSE](LICENSE). Use it, change it, ship it.
