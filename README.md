# Dianoisis

The codebase for **Noesis**, an AI study platform for schools. (`dianoisis` is the
repository and package name; *Noesis* is the name the product carries in its UI and
in its legal texts.)

Noesis turns a course's own material — the PDFs a teacher actually assigns — into
practice questions, flashcards, chapter summaries, cheat sheets and guided study
sessions, and keeps the teacher in charge of what reaches the class. It is built
for institutions: a school gets its own portal, its own users, and data that is
isolated from every other school's at the database level.

Licensed **AGPL-3.0-only** — see [License](#license), and note the network clause
if you intend to run a modified copy as a service.

## What it does

Three commitments shape most of the design, and they are worth stating before the
feature list:

- **Generation is grounded in the school's own material.** Questions, summaries
  and study guides come from uploaded course material, not from the model's
  general knowledge.
- **The instructor approves what students see.** AI output is a draft until a
  teacher releases it.
- **AI does not grade written answers.** A student's own-words answer waits for a
  human. The AI writes a private draft note to support that review; the mark is
  the teacher's. Every AI-produced artefact is labelled as such.

### By role

| Role | What the platform gives them |
| --- | --- |
| **Student** | Assigned quizzes (multiple-choice, fill-gaps, ordering, classification), open-ended questions, flashcards, cheat sheets, guided study guides, a Socratic tutor chat, quiz history and progress |
| **Instructor** | Upload and chapter-split material, generate and review content, assign it to a class / group / individual, track performance, cluster students by weakness, author announcements |
| **Evaluator** | Subject-matter review of AI-generated questions on assigned courses — a verdict (good / needs fixing / reject) plus scientific accuracy, difficulty, clarity, distractor quality and curriculum alignment. Read-only over the questions themselves |
| **Admin** (school) | User lifecycle and roles, classes and enrolment, student profiles and admin notes, AI-activity visibility, data-subject rights requests, academic-year rollover |
| **Super-admin** (platform staff) | Institutions, cross-institution users, token usage and cost, global and per-institution AI prompts, OpenAI vector stores, agent logs, data export |

## Architecture

```
React 18 + TypeScript + Vite (SPA)
        │  supabase-js
        ▼
Supabase — PostgreSQL (RLS on every table) · Auth · Storage
        │
        ├─ 60 Deno edge functions (supabase/functions/)
        ▼
    OpenAI API — generation + vector stores for material grounding
```

- **Frontend** — route-based pages in `src/pages/`, feature-grouped components in
  `src/components/`, shadcn/ui + Tailwind primitives in `src/components/ui/`.
  React Router v6, TanStack Query for caching. Two conventions coexist: older
  pages query Supabase directly, while the newer instructor and student
  surfaces put pure loaders in `src/lib/*-surface/` behind thin query hooks —
  which is the pattern to follow in new code, since it leaves the data logic
  testable without a component.
- **Backend** — each edge function is a directory with an `index.ts`; shared
  helpers (OpenAI client, logging, prompts, moderation) live in `_shared/`.
  Functions hold the service-role key, so **the access boundary is the
  authorization check inside each handler** — the model and the per-function
  status are documented in
  [`supabase/functions/AUTHORIZATION.md`](supabase/functions/AUTHORIZATION.md).
  Read it before adding a function.
- **Database** — 354 timestamped migrations under `supabase/migrations/`. RLS
  enforces institutional isolation on every table; `src/integrations/supabase/types.ts`
  is generated from the schema and must never be hand-edited.
- **Deployment** — the frontend builds on Vercel from `main`; edge functions ship
  via the `Deploy Edge Functions` workflow; migrations are applied by the Supabase
  GitHub integration. No workflow runs `supabase db push`.

### Key data model

`institutions` → `classes` (grade level + section) → `class_enrollments`, and
`courses` → `offerings` (a course taught to a class) → `course_instructors`.
Course material (`course_materials`) hangs off a course and is what the AI
content is generated from.

## Getting started

**Prerequisites:** Node 24, Deno 2.6, Docker (for the local Supabase stack), and
the [Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
npm install
supabase start           # boots the local stack and prints its API URL + anon key
cp .env.example .env     # then paste that anon key into VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev:local        # edge functions + Vite on :8080 (Supabase is already up)
```

**Do not skip the paste.** `.env.example` ships a placeholder, so leaving it in place
means every Supabase request fails. `supabase status` reprints the key at any time; it
is a fixed local development credential, not a secret.

`npm run dev` starts the frontend alone against whatever `.env` points at.
`./scripts/sync_localdb.sh --run` applies pending migrations and regenerates types.

Seeded local accounts: `e2e-{student,instructor,admin,superadmin,evaluator}@test.local`
/ `testpass123`.

### Environment

**Frontend** (`.env`, read at build time):

| Variable | Description |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase API URL (`http://127.0.0.1:54321` locally) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase anon/public key |
| `VITE_SENTRY_DSN` | *(Optional)* enables error reporting; a no-op when unset |

**Edge functions** (`supabase/.env.local`):

| Variable | Description | Where to get it |
| --- | --- | --- |
| `OPENAI_API_KEY` | Used by most edge functions | platform.openai.com |
| `CONVERT_API_KEY` | PDF processing | convertapi.com |
| `RESEND_API_KEY` | Invitations, contact form | resend.com |
| `ELASTICSEARCH_URL` | *(Optional)* logging endpoint | your Elastic deployment |
| `ELASTICSEARCH_API_KEY` | *(Optional)* logging key | your Elastic deployment |

> `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` are injected
> by Supabase locally and in hosted mode — do not set them yourself.

## Testing

Layers, fastest first. `npm run test:all` runs the frontend + edge + RLS suites.

| Layer | Command | Covers | In CI |
| --- | --- | --- | --- |
| Lint / typecheck | `npm run lint` · `npm run typecheck` | ESLint + TypeScript (`tsc -b`) | every PR |
| Frontend unit | `npm run test:frontend` | Vitest (jsdom) components + logic | every PR |
| Edge functions | `npm test` | Deno tests for `supabase/functions/_shared` | every PR |
| RLS policies | `npm run test:rls` | Row-Level-Security policy tests (needs the local stack and `psql` on `PATH`) | PRs touching `supabase/**`, plus nightly |

Every suite above is hermetic: it needs Docker and Node and nothing else — no account,
no API key, no deployed environment. That is the line this repository draws.

### Browser E2E lives elsewhere

Playwright specs and the agent-driven sim-scenario suite need a deployed application
and a seeded hosted database, so they live in a separate private deployment
repository rather than here. Nothing in this repository deploys anywhere, and no
workflow here holds a credential for a live environment.

## Security & compliance

- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability, what is in scope,
  and what not to test against.
- [`supabase/functions/AUTHORIZATION.md`](supabase/functions/AUTHORIZATION.md) —
  the edge-function authorization model and the status of every function.
- [`docs/compliance/README.md`](docs/compliance/README.md) — the legal texts the
  app serves at `/legal/*`. They are compiled into the bundle, so editing one
  ships new legal text.

Secret scanning and a dependency-vulnerability gate run against this repository.
The dynamic scans — a weekly passive ZAP baseline and an adversarial (jailbreak)
suite against the AI tutor — need a running deployment, so they run from the
deployment repository. The operator maintains the security-testing record
and the archived run verdicts privately, and makes them available on request.

## Repository layout

```
src/                      React SPA — pages/, components/, hooks/, lib/, i18n/
supabase/functions/       60 Deno edge functions + _shared/
supabase/migrations/      354 SQL migrations (RLS on every table)
supabase/tests/rls/       RLS policy tests
docs/compliance/legal/    the legal texts served at /legal/*
```

## Continuous integration

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` | every PR, push to `main`, nightly | Lint + typecheck, Deno edge-function tests, frontend unit tests, production build, RLS policy tests |
| `security.yml` | every PR, push to `main`, weekly | gitleaks secret scan over full history, `npm audit` gate |

Both workflows run on the automatic `GITHUB_TOKEN`; this repository holds no
secrets. Branch protection requires **Lint & Type Check**, **Unit Tests**,
**Frontend Unit** and **Build** to pass, and every review conversation to be
resolved.

Code review comes from the Greptile GitHub app, which reviews on every push.
Acting on that feedback is a person's job — nothing merges a PR automatically.

Contribution guidelines are not published yet.

## License

Copyright (C) 2024-2026 Hellenic Institute for AI & Education.

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU Affero General Public License, version 3**, as published
by the Free Software Foundation.

Version 3 only — not "version 3 or any later version". That is what the SPDX
identifier `AGPL-3.0-only` in `package.json` declares, and the two must keep
saying the same thing.

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the [GNU Affero General Public License](LICENSE) for
details.

The AGPL's network clause (section 13) is the operative one for a hosted
platform like this: **if you run a modified version as a network service, you
must offer its users the source of your modified version.** Running it
unmodified, or modifying it privately without offering it as a service, carries
no such obligation.

`"private": true` in `package.json` is unrelated to this — it only prevents an
accidental `npm publish`, and is not a statement about the code licence.
