# Published legal documents

**Reviewed by counsel:** no. Every document here carries a DRAFT banner and
must not be published or signed before a Greek data-protection lawyer has read
it.

This directory holds the four legal texts the application serves to its users,
in Greek and English. Nothing else. They are not reference copies: `/legal/*`
renders *these files*, so a change here is a change to what a pupil, parent or
school reads.

## What is here

| File | Route | |
|---|---|---|
| `legal/privacy-policy.{el,en}.md` | `/legal/privacy` | What personal data the platform holds, why, where it goes, and what rights a data subject has. |
| `legal/terms-of-service.{el,en}.md` | `/legal/terms` | The terms on which the platform is used. |
| `legal/ai-usage-notice.{el,en}.md` | `/legal/ai` | What the AI does, what it is not good at, and what happens to what a pupil writes. |
| `legal/subprocessors.{el,en}.md` | `/legal/subprocessors` | The providers that process data on our behalf, and what each receives. |

Greek is the binding text; English is the reference translation.

## These files are compiled into the app

`src/content/legal.ts` imports all eight with Vite's `?raw`, so they are inlined
at build time and the pages render with no network request and no session.

Two consequences worth stating, because both are load-bearing:

- **Renaming or deleting one breaks the build**, not just a link. That is
  deliberate — it is what keeps the published text and the reviewed text the
  same document. There is no second copy under `src/` for exactly this reason:
  two copies of a privacy policy are two documents, and the day they disagree
  the published one is wrong while the reviewed one still looks fine.
- **Editing one ships new legal text** on the next deploy. Treat a change here
  as a publication, not a docs tidy-up.

## Governance records are maintained privately

The operator's internal compliance records — the ROPA, the DPIA, the EU AI Act
risk assessment, the access-control, AI-usage, backup and incident-response
policies, the open-items register, the retention and erasure procedures, the
rights-request register, the DPA template, and the Privacy & AI Security Pack —
are **not part of this repository**. They are the operator's working papers and
contain material that is not appropriate to publish: internal procedure,
supplier detail, and unresolved risk items.

They are available to a school's procurement office, and to the supervisory
authority under Art. 30, **on request from the operator** — not from here.

Their absence is not a gap in the platform's compliance posture; it is a
statement about what belongs in a public source repository.

> For anyone working in this repo: those files lived under `governance/`,
> `pack/`, `legal/dpa-template.*`, and the three root procedures until commit
> `d40c99f6`, and remain in this repository's git history at that commit. Source
> comments that used to cite them by path now point here instead.

## The rule these documents live by

**Nothing here may claim a control that does not exist in the codebase.** A
document describing an aspirational system is not a compliance document, it is
a misrepresentation to a school buying protection for minors.

So, stated in the documents themselves rather than quietly omitted:

- **MFA is opt-in, not required.** TOTP with audited admin lockout recovery
  shipped 2026-09-14; no role is forced to enrol, and the challenge runs at
  login only.
- **Password rules are server-enforced since 2026-09-14** — eight characters,
  letters and digits, leaked-password screening.
- **Rate limits are per-isolate**, so they bound abuse rather than prevent it.
- **Free-text student names typed by instructors survive an erasure** and need a
  human review; the search for them is automated and its result returned to the
  deleting admin, but clearing them is a judgement call.
- **Backups are Supabase's**, and rows persist in them after a live-database
  deletion until they roll off.

Where a number appears in more than one place it appears once as fact and
elsewhere as a pointer. Retention months are one such number, and the Privacy
Policy quotes them in both languages.

The live value is a **database row**, not a file: the purge job reads
`system_config.data_retention` (a `default_months` plus per-table overrides) at
run time. So to change a window, **add a new migration** that updates that row —
`ON CONFLICT (key) DO UPDATE`, as `20260913120000` and `20260913140000` do for
the 3-month and 24-month overrides — and update both Privacy Policy
translations in the same change.

Do **not** edit the migration that first seeded the row. It inserts
`ON CONFLICT (key) DO NOTHING`, so on any database where the row already exists
the edit is inert: the published policy would announce a new window while the
purge kept applying the old one.

## `[OPERATOR: …]` markers

Several statements a Greek school will ask for cannot be read out of the
repository: the legal entity, the privacy contact address, whether a DPO has
been appointed, the Supabase project's region, and the status of each vendor
DPA. They are left as explicit `[OPERATOR: …]` markers rather than guessed at,
and the operator's private open-items register tracks them.

`src/pages/Legal.tsx` renders each marker as a visible **⚠ TO BE COMPLETED**
badge, so an unfilled one is impossible to miss on the page.

**A `[OPERATOR: …]` marker left in a published document is a bug.**
