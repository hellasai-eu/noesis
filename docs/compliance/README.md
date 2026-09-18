# Compliance notes

**This repository publishes no legal documents.** The four texts the
application serves at `/legal/*` — privacy policy, terms of service, AI usage
notice, subprocessors — come from the deployment overlay, and the operator
running a deployment owns them outright. See
[`deployment/README.md`](../../deployment/README.md) for the mechanism and
[`deployment/legal/`](../../deployment/legal/) for the skeletons a clone falls back
on.

Until 2026-09-17 this directory held a set of Greek and English drafts.
They were one operator's documents sitting in a repository anyone may run under
the AGPL, which is the wrong place for them: a school reading `/legal/privacy`
must read *its* operator's policy, not whoever wrote the code. They remain in
git history if you need them, and the skeletons that replaced them keep the
structure without the operative text.

What is left here is the part that is about this codebase rather than about any
one operator, and that a deployment's own documents still have to respect.

## The rule these documents live by

**Nothing in a published legal document may claim a control that does not exist
in the codebase.** A document describing an aspirational system is not a
compliance document, it is a misrepresentation to a school buying protection
for minors.

So, to be stated in an operator's documents rather than quietly omitted:

- **MFA enforcement is per-deployment, and the document must state what this
  deployment does.** TOTP with audited admin lockout recovery shipped
  2026-09-14. Since 2026-09-18 the set of roles required to enrol is operator
  policy (`security_policies.mfa_policy`, declared in the deployment overlay's
  `settings.json`), so "MFA is optional" is no longer a fact about the
  codebase — it is a fact about a configuration. The shipped default requires
  it of platform staff immediately and institution admins from 2026-11-01, and
  leaves instructors, evaluators and pupils opt-in. Read the live policy before
  writing the sentence; the super-admin version page shows it. The challenge
  runs at login only in every case.
- **Password rules are server-enforced since 2026-09-14** — eight characters,
  letters and digits, leaked-password screening.
- **Rate limits are per-isolate**, so they bound abuse rather than prevent it.
- **Free-text student names typed by instructors survive an erasure** and need
  a human review; the search for them is automated and its result returned to
  the deleting admin, but clearing them is a judgement call.
- **Backups are Supabase's**, and rows persist in them after a live-database
  deletion until they roll off.
- **Edge functions authenticate in the handler, not at the gateway.** Almost
  every function sets `verify_jwt = false` and uses the service-role key, so
  the check inside each handler is the only access boundary — see
  [`supabase/functions/AUTHORIZATION.md`](../../supabase/functions/AUTHORIZATION.md)
  for which handlers actually have one.

## Security policy is a database row, not a file

The same trap as retention, for the same reason. A privacy policy or DPA that
states "administrators must use two-factor authentication" is quoting
`security_policies.mfa_policy`, which the operator sets — not something a
reader can verify from this repository.

Change it with `npm run settings:sql` from the deployment overlay's
`settings.json` and apply the statement to the project; do not hand-edit the
row, or the declared policy and the live one drift and the super-admin version
page will say so. See `deployment/README.md`.

## Retention windows are a database row, not a file

A privacy policy that quotes retention periods is quoting
`system_config.data_retention` — a `default_months` plus per-table overrides
that the purge job reads at run time.

So to change a window, **add a new migration** that updates that row
(`ON CONFLICT (key) DO UPDATE`, as `20260913120000` and `20260913140000` do for
the 3-month and 24-month overrides), and update the operator's policy text in
the same change.

Do **not** edit the migration that first seeded the row. It inserts
`ON CONFLICT (key) DO NOTHING`, so on any database where the row already exists
the edit is inert: the published policy would announce a new window while the
purge kept applying the old one.

## `[OPERATOR: …]` markers

Several statements a school will ask for cannot be read out of a repository:
the legal entity, the privacy contact address, whether a DPO has been
appointed, the Supabase project's region, and the status of each vendor DPA.

The skeletons leave each as an explicit `[OPERATOR: …]` marker rather than
guessing, and `src/pages/Legal.tsx` renders every marker as a visible
**⚠ TO BE COMPLETED** badge — so an unfilled one is impossible to miss on the
page.

**A `[OPERATOR: …]` marker left in a published document is a bug.**

## Governance records are the operator's

The internal compliance records — ROPA, DPIA, EU AI Act risk assessment, the
access-control, AI-usage, backup and incident-response policies, the open-items
register, retention and erasure procedures, the rights-request register, the
DPA template — are not part of this repository and should not be. They are
working papers containing internal procedure, supplier detail and unresolved
risk items, and they are specific to whoever is operating a deployment.

Their absence here is not a gap in the platform's compliance posture; it is a
statement about what belongs in a public source repository.

> For anyone working in this repo: an earlier operator's copies lived under
> `governance/`, `pack/`, `legal/dpa-template.*`, and three root procedures
> until commit `d40c99f6`, and the legal drafts under `docs/compliance/legal/`
> until the deployment overlay replaced them. Both remain in git history.
