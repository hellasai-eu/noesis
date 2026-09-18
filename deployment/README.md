# The deployment overlay

This directory is everything about a deployment that is not the software: the
name, the logo, the landing page at `/`, the legal documents at `/legal/*`, and
the security policy. Nothing under `src/` hardcodes any of it.

The default here is deliberately generic — a clone of this repository calls
itself "Study Platform", draws a fallback glyph, redirects `/` to the sign-in
screen, serves four legal skeletons with no operative text, and requires
two-factor authentication of platform staff and institution admins. A
deployment supplies its own.

Most of the overlay takes effect purely by being built. **The security policy
is the exception** — it is enforced by Postgres, so changing it takes a second
step. [The security policy](#the-security-policy) below is the part to read
carefully.

## How a deployment overrides it

Point `DEPLOYMENT_DIR` at a directory of your own. Vite resolves the `@deployment`
alias there instead of at `deployment/`:

```sh
DEPLOYMENT_DIR=./my-deployment npm run build
DEPLOYMENT_DIR=./my-deployment npm run dev
DEPLOYMENT_DIR=./my-deployment npm run test:frontend
```

The path is resolved relative to the repository root, and `dev`, `build` and
`vitest` all honour it — so a deployment's test run exercises its own landing
page and legal set rather than this repository's defaults.

It can also go in `.env` (`DEPLOYMENT_DIR="./my-deployment"`), which is the
convenient form for local work. A real shell variable wins over `.env`, so a CI
step that exports it is not silently overridden by a checked-in file.

### Keep the overlay inside the checkout

`DEPLOYMENT_DIR` must point somewhere inside the repository checkout. The
overlay's files import `react`, `react-router-dom` and `@/deployment/contract`,
and bare specifiers resolve from the importing file's own location — so a
directory outside the project (or a symlink to one, which Vite resolves to its
real path) cannot find `node_modules`.

The supported pattern for a separate deployment repository is therefore to copy
its overlay directory into the checkout as a build step:

```sh
cp -R ../deploy-repo/brand ./my-deployment
DEPLOYMENT_DIR=./my-deployment npm run build
```

`my-deployment/` and `brand/` are already in `.gitignore` for exactly this.

## What an overlay must contain

Six files, all required:

| File | What it is |
|---|---|
| `brand.meta.json` | The plain-data brand: name, description, contact, social tags |
| `brand.config.ts` | Default-exports `defineBrand({ … })` — the JSON plus the artwork |
| `settings.json` | The plain-data policy: which roles must use two-factor auth |
| `settings.config.ts` | Default-exports `defineSettings({ … })` — normally just the JSON |
| `legal.config.ts` | Default-exports `defineLegal({ … })` — the published documents |
| `Landing.tsx` | Default-exports the route element for `/` |

Every field is optional; the `define*` helpers fill in the rest. That is the
point of calling them: a field this app adds tomorrow gets a sane default in
your overlay today, rather than arriving in the UI as `undefined`.
The full list of fields, each with what it does and what `null` means, is in
[`src/deployment/contract.ts`](../src/deployment/contract.ts) — it is the contract,
and `tsc` checks your config against it.

### Why the brand is split across two files

`vite.config.ts` writes the `<title>`, the description and every social tag
into `index.html` at build time, before any module has run — a title applied
after hydration is a title a link-preview bot never sees. So it reads
`brand.meta.json` with `readFileSync`, and `brand.config.ts` imports the same
file and spreads it. One source of truth, two readers: the `<title>` a crawler
sees and the name the app renders cannot drift apart. Both normalise the file
through the same `resolveBrandMeta`.

Anything that needs *code* — the logo asset, an icon component — goes in
`brand.config.ts`, which JSON could not express.

A minimal overlay is small:

```json
// my-deployment/brand.meta.json
{
  "name": "Acme Learn",
  "description": "Acme's study platform for our schools.",
  "canonicalUrl": "https://learn.acme.example",
  "contactEmail": "hello@acme.example",
  "poweredBy": "Powered by Acme Learn",
  "htmlLang": "el"
}
```

```ts
// my-deployment/brand.config.ts
import { defineBrand } from "@/deployment/contract";

import meta from "./brand.meta.json";
import logo from "./logo.svg";

export default defineBrand({ ...meta, logo: { src: logo } });
```

```tsx
// my-deployment/Landing.tsx
export default function Landing() {
  return <main>…your marketing page…</main>;
}
```

Omit `title` and it follows `name` — so a deployment that sets only a name gets
that name in the tab, not this repository's default.

Prefer a Vite asset import for the logo (`import logo from "./logo.svg"`) over
a path into `public/`: the asset is then hashed and fingerprinted with the rest
of the bundle, so a logo change cannot be served stale.

## The security policy

`settings.json` says which roles must enrol in two-factor authentication:

```json
{
  "mfa": {
    "enforceForRoles": ["super_admin", "admin", "instructor"],
    "deadlines": {
      "instructor": "2026-12-01T00:00:00Z"
    }
  }
}
```

A role in `enforceForRoles` is required **immediately** unless `deadlines`
names a later instant. Before that instant the role is *recommended*: a
dismissible nudge naming the date, with no loss of access. From it, required.

The roles are `super_admin` (platform staff), and `admin`, `instructor`,
`evaluator` and `student` (institution memberships). Omit a role and nobody in
it is required to enrol — `"enforceForRoles": []` opts out of the mandate
entirely.

### What "required" costs a person

MFA is enforced in the database: a restrictive RLS policy on every table calls
`public.mfa_satisfied()`. An unenrolled user in a required role therefore reads
**nothing at all** until they enrol, and sees the full-screen enrolment gate,
which is their route back.

That is a real decision about real people. For platform staff it is right. For
a thousand pupils, give the role a deadline and let them see it coming.

### Applying it takes a second step

Editing `settings.json` changes what the *app* believes. It does not change
what the *database* enforces, and the database is the only thing that does
enforce — a user who bypasses the SPA keeps their JWT and their access.

So a policy change is two steps:

```sh
npm run settings:sql                 # print the UPDATE to apply
npm run settings:sql -- --check      # validate; exit 1 on a bad policy
npm run settings:sql -- --json       # just the policy, as jsonb
```

Apply the statement from the deployment repository, against its Supabase
project — this repository deploys nowhere and holds no credentials:

```sh
npm run --silent settings:sql | psql "$DATABASE_URL"
```

`--silent` is not optional in a pipe: without it npm prints its own banner to
stdout and `psql` receives it as SQL.

Re-running it is idempotent, and removing a role takes effect at once: anyone
who enrolled stays enrolled, they are simply no longer required to be.

### Three things stop a policy from drifting silently

The cost of one source of truth is that it has to reach two places. All three
of these exist because forgetting the apply step is quiet:

1. **The build refuses a malformed policy.** A misspelled role fails
   `npm run build`, rather than shipping as a policy that enforces nothing.
2. **`npm run settings:sql -- --check`** in the deploy pipeline fails on a bad
   declaration before anything is applied.
3. **The super-admin version page** shows the declared policy against the live
   one, and says which roles disagree. The database is what counts, whatever
   the build says.

### If the policy row is broken

A missing or unparseable `mfa_policy` row falls back to
`{"super_admin": null, "admin": null}` — privileged roles enforced
immediately. It deliberately does **not** fall back to enforcing every role:
locking out every pupil is not the safe reading of somebody's mistyped
`UPDATE`.

## The logo

`brand.logo` is optional. With no logo the app draws `brand.icon` inside a
filled rounded tile — that tile is the mark everywhere in the app chrome, so a
bare glyph needs it. A logo that carries its own background, or a wordmark,
should set `bare: true` to skip the tile.

`brand.icon` accepts any component taking a `className`, which includes every
`lucide-react` icon and any inline SVG of your own. Nothing in
`src/deployment/` imports `lucide-react`, so an overlay is free not to.

## The legal documents

`legal.config.ts` is the single source of truth for what is published: the
router and the footer both read it, so there is no second list to keep in step.

- Removing a document from `documents` unpublishes it — `/legal/<slug>` stops
  resolving and the footer drops the link.
- Setting `languages: []` turns the legal pages off entirely, for a deployment
  that serves its policies from somewhere else.
- Editing a markdown file ships new legal text on the next build. Treat that as
  a publication, not a docs tidy-up.

`[OPERATOR: …]` markers in the markdown are rendered as visible
**⚠ TO BE COMPLETED** badges rather than passed through as prose, so an
unfilled one is impossible to miss on the page. That is what the skeletons here
are made of. **A marker left in a published document is a bug.**

One rule worth carrying over into whatever you write: **a legal document must
not claim a control that does not exist in the codebase.** A document
describing an aspirational system is not a compliance document, it is a
misrepresentation to a school buying protection for minors.
