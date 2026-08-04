# Mintgrove → Klaviyo relay

A small, deployable example that connects Mintgrove to Klaviyo.

When someone is given or loses a seat in your app, Mintgrove sends a webhook — a
single HTTP request describing what happened. Klaviyo, meanwhile, wants events in
its own particular format. This relay sits between the two: it receives Mintgrove's
seat-event webhook, checks that the request genuinely came from Mintgrove, reshapes
it into a [Klaviyo Events API](https://developers.klaviyo.com/en/reference/create_event)
call, and forwards it. Once events are landing in Klaviyo, you can trigger Flows off
them — a welcome email when a seat is assigned, an access-removed notice when one is
revoked. It's one file, has no dependencies, and is meant to be forked and deployed
as-is.

## Before you start

You'll need:

- **A Klaviyo account**, and a **Private API Key** with write access to Events.
  In Klaviyo: **Settings → API Keys → Create Private API Key**.
- **Your Mintgrove webhook signing secret.**
  In Mintgrove: **Settings → Integrations → Outbound webhook**.
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

In Mintgrove, go to **Settings → Integrations**, find the **Email** section, and enter
your relay's URL — your deployment URL with `/api/relay` on the end — into the
**Webhook endpoint URL** field, then click **Save**:

```
https://your-project-name.vercel.app/api/relay
```

That's it. Assign a seat to a test user, then check **Analytics → Metrics** in Klaviyo
for an `Enterprise Seat Assigned` event.

## What it sends to Klaviyo

| Mintgrove event | Klaviyo metric            |
| --------------- | ------------------------- |
| `seat.assigned` | `Enterprise Seat Assigned` |
| `seat.revoked`  | `Enterprise Seat Revoked`  |

The seat holder's email and name become the Klaviyo profile. These fields ride along as
event properties, so you can use them in your email templates (for example
`{{ event.org_name }}`):

`org_name` · `app_name` · `seat_expiry` · `offer_code` · `offer_code_used`

## Checking it works

Vercel keeps a log of every request. Run `vercel logs <your-deployment-url>`, or open
your project in the Vercel dashboard and click **Logs**. Each relayed event prints one
line, with the recipient's email partly masked:

```
[mintgrove-klaviyo-relay] seat.assigned for da***@acme-corp.com
```

If Klaviyo rejects an event, the status code is logged too:

```
[mintgrove-klaviyo-relay] Klaviyo API returned 401
```

A `401` here almost always means `KLAVIYO_PRIVATE_API_KEY` is missing, wrong, or lacks
Events write access.

Note that the relay always replies `200 OK` to Mintgrove once a request passes the
signature check, even if the call to Klaviyo then fails. This is deliberate — it stops
Mintgrove from retrying and eventually disabling your webhook because of a problem on
Klaviyo's end. The trade-off is that a failed forward is only visible in these logs,
which is why the section below matters.

## This is a starting point, not a finished product

It handles the happy path and verifies that requests really come from Mintgrove
(HMAC-SHA256 over the raw body, constant-time comparison, and a five-minute replay
window — the scheme described under "Verifying webhook signatures" in the
[setup guide](https://mintgrove.co/docs/klaviyo)).
The relay refuses to start processing at all if `MINTGROVE_SIGNING_SECRET` is unset,
rather than quietly accepting unsigned traffic.

Several things you'd want in production are deliberately left out, because the right
answer depends on your setup:

- **No retries.** If Klaviyo is down or rate-limits you, that event is lost. Consider a
  queue, or retrying on `429` and `5xx`.
- **No deduplication.** Mintgrove retries deliveries that don't get a `2xx`, so the same
  event can arrive more than once. If duplicate emails would be a problem, track which
  events you've already forwarded.
- **No alerting.** Failures are written to the logs and nowhere else. Nobody is watching
  those logs at 3am — wire failures into whatever you already use for monitoring.
- **Signing-scheme changes are rejected, not tolerated.** If Mintgrove bumps
  `Mintgrove-Webhook-Version`, this relay returns `400` until you update
  `SUPPORTED_WEBHOOK_VERSION` in `api/relay.js`. That's the safe default, but it means
  you should keep an eye on Mintgrove's changelog.

Read `api/relay.js` before you rely on it — it's about 150 lines, and it's the whole
thing.

## Full setup guide

For the complete walkthrough, including creating the Klaviyo Flows that actually send
the emails, no-code alternatives to this relay, and troubleshooting:

**[mintgrove.co/docs/klaviyo](https://mintgrove.co/docs/klaviyo)**

## License

MIT — see [LICENSE](LICENSE). Use it, change it, ship it.
