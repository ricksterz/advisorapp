# Decision memo: claimed profiles / lead-gen (2d-v2)

**Status: partially decided.** Ricky, 2026-07-10: **monetization is paused, not
ruled out** — no paid tiers, no listing fees, no per-lead/referral fees for now,
revisit later. That holds decision 4 open but inactive, and keeps the
marketing-rule surface (decision 2) at its minimum in the meantime. Still open:
whether to build the free claiming flow at all (decision 1) and, if so, the
verification design (decision 3). Nothing is built until that call is made.

Written 2026-07-10, after shipping Workstreams 1 and 2 (config-driven benchmarking
engine; website ingestion + firm detail routes).

## What v2 would be

A firm proves control of its CRD (e.g. a verification code sent to the Item 1.J
filing-contact email on record), after which its detail page gains: a "verified"
badge, a scheduling link (Calendly/Cal.com URL — we link out, never build
scheduling), a monitored contact address, and a "Request an introduction" form
that relays to the firm by email. This moves the product from *audit tool*
toward *directory/lead-gen* — SmartAsset / Zoe Financial / Wealthtender
territory, but sitting on regulatory-grade data instead of self-authored
profiles.

## The four decisions

**1. Positioning — do it at all?**
The app's stated edge is independence: "informational screens, not endorsements"
(current disclaimer), methodology as readable code. A lead-gen layer is the one
feature that can put that at risk — the moment firms can pay for anything, every
ranking invites the question "is this influenced?" If v2 proceeds, an explicit,
published commitment that claimed/paid status never touches ranking inputs
should ship in the methodology copy on day one.

**2. Compliance surface.**
The Advisers Act marketing rule (206(4)-1) treats compensated referrals/
endorsements as advertising, with disclosure and oversight obligations on the
*adviser* — and potentially promoter status for the app if any per-lead or
referral fee exists. A flat listing/claiming fee (not tied to leads) or a free
tier keeps that surface minimal. State-registered advisers add state-level
variants. This memo is not legal advice; a securities lawyer should review the
chosen model before launch, not after.

**3. Verification / anti-impersonation.**
Item 1.J (filing contact email) is public Form ADV data but is **not currently
ingested** — that's a small ETL addition when needed. Failure modes to design
for: stale contact emails, outsourced-compliance addresses shared across many
firms, umbrella registrations where one filer controls several CRDs. Fallback:
manual review queue. Note this is the first feature that genuinely needs a
backend (claim state, codes, email relay) — either wake the dormant FastAPI
app or use Cloudflare Workers (already the deploy target) with KV + an email
API.

**4. Monetization.**
- **Free claiming** — maximizes verified-profile coverage, monetize later; no
  compliance surface; no revenue.
- **Paid claiming (flat fee)** — revenue without per-lead fees; perception risk
  is manageable if rankings-independence is published.
- **Per-lead / referral fees** — most revenue, largest marketing-rule surface,
  directly at odds with the independence positioning. Not recommended.

## Recommendation

Don't build until positioning (decision 1) is settled. If pursued: start with
**free claiming + verified badge + scheduling/contact links, no fees of any
kind**, which defers the compliance question entirely while proving whether
firms will actually claim profiles. Add a flat-fee tier only if claim volume
justifies it. Sequence the Item 1.J ingestion with whatever ETL pass comes next
so the verification channel is ready when needed.
