# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- `npm run dev:local` — Full local stack (Supabase + Edge Functions + Vite on :8080)
- `npm run dev` — Frontend only (Vite dev server)
- `./scripts/sync_localdb.sh --run` — Apply pending migrations + regenerate types
- `npm run gen:types` — Regenerate TypeScript types from Supabase schema

### Testing
- `npm run test:frontend` — Vitest (frontend unit tests)
- `npx vitest src/__tests__/components/SomeTest.test.tsx` — Single frontend test
- `npm test` — Deno edge function tests
- `deno test --allow-net --allow-env supabase/functions/_shared/__tests__/some.test.ts` — Single edge function test
- `npm run test:rls` — RLS policy tests. Two prerequisites the CLI does not set up for you, both of which the `RLS Policies` CI job performs verbatim:
  1. `./scripts/local-db-grants.sh` after **every** `supabase start` / `db reset` — recent CLI images create the local DB without DML grants for `anon`/`authenticated`/`service_role`, so without it every suite dies in `beforeAll` with `permission denied for table institutions`. Hosted Supabase is unaffected.
  2. `psql` on PATH (Homebrew `libpq` is keg-only: `export PATH="$(brew --prefix libpq)/bin:$PATH"`) — three suites shell out to it.
- `npm run test:all` — All tests (frontend + edge functions + RLS)

Every suite here is hermetic — Docker and Node, no account and no deployed
environment. Browser E2E and the agent-driven sim suite live in the separate
private deployment repository; nothing in this repository deploys anywhere.

### Build
- `npm run build` — Production build
- `npm run lint` — ESLint
- Nothing here deploys. The deployment repository owns the Vercel build, the edge
  function workflow and the Supabase migration integration.

### Git workflow
- Never push directly to main. Always create a branch and PR.

### After opening a PR (shepherd it to green)
When you open a PR in an interactive session, don't stop at "PR created" — drive it to a mergeable, green state. Follow this loop until the PR is clean, then hand back to the user for merge:

1. **Trigger review.** Greptile (`greptile-apps[bot]`) auto-reviews on every push, so opening the PR — and every subsequent `git push` of fixes — re-triggers it. No manual command needed; a push *is* the trigger. Greptile is a GitHub app rather than a workflow, so it is unaffected by anything in `.github/workflows/`. Nothing merges a PR on your behalf: you do the fixing in-session, and the merge is always the user's call (step 6).
2. **Monitor for review comments.** Poll the PR for new review feedback, e.g. `gh pr view <n> --json reviews,comments` and `gh api repos/<owner>/<repo>/pulls/<n>/comments`. Prefer a background Monitor over tight polling. Wait for greptile to actually post before assuming there's nothing to fix.
3. **Fix the feedback.** Address each actionable comment with a commit. Skip only false positives, and say why in a PR reply. Push — which re-triggers review (step 1). Repeat until a review round returns no new actionable comments. Respect the existing convention of **max 5 fix iterations**; if still not clean, stop and flag the user for manual review.
4. **Keep the branch current.** Watch mergeability via `gh pr view <n> --json mergeStateStatus,mergeable`. If it goes `BEHIND` / `DIRTY`, update the branch from `main` and **resolve any conflicts yourself**, then push. **Prefer merging `main` into the branch** (`git merge origin/main`) — an ordinary `git push` then works. Rebasing a published PR branch rewrites history and needs a force-push; only do that on a branch nobody else is pushing to, and use `git push --force-with-lease` (never a bare `--force`, which silently discards concurrent remote commits).
5. **Fix failing CI.** Watch checks with `gh pr checks <n>` / `gh run view --log-failed`. If a test or lint/build check fails, reproduce locally (see Testing/Build commands above), fix the cause, and push. Distinguish a real failure from a known-flaky one — re-run flaky checks (`gh run rerun`) rather than "fixing" them; note the flake in the PR.
6. **Report.** When the PR is green and has no outstanding review comments, tell the user it's ready to merge. Do not merge unless asked.

## Architecture

### Stack
React 18 + TypeScript + Vite (frontend SPA) → Supabase (PostgreSQL + Auth + Edge Functions in Deno) → OpenAI API. Deployed on Vercel (frontend) + Supabase hosted (backend).

### Frontend structure
- **Pages** (`src/pages/`): Route-based components. Two conventions coexist: older pages issue direct Supabase queries via `supabase.from().select()`, while the newer instructor and student surfaces keep pure loaders in `src/lib/*-surface/` behind thin query hooks. Follow the latter in new code — it leaves the data logic testable without mounting a component
- **Components** (`src/components/`): Feature-grouped (e.g., `class-management/`, `quiz/`). UI primitives in `src/components/ui/` (shadcn/ui)
- **Auth**: React Context (`useAuth` hook) wrapping Supabase Auth. Provides `user`, `profile`, `signIn`, `signOut`
- **Routing**: React Router v6 in `src/App.tsx`. Roles: student, instructor, admin, super-admin
- **Data fetching**: TanStack React Query for caching, direct Supabase client calls for mutations
- **UI**: shadcn/ui + Tailwind CSS + lucide-react icons. Forms use react-hook-form + Zod

### Backend structure
- **Edge Functions** (`supabase/functions/`): Each in its own directory with `index.ts`. Deno runtime. Shared utilities in `_shared/` (OpenAI client, logging, prompts, moderation)
- **Edge function auth**: Every function but one has `verify_jwt = false` in config.toml,
  so the gateway authenticates nothing — a request with no `Authorization` header reaches
  the handler. (`academic-year-rollover` has no entry and inherits the default
  `verify_jwt = true`; that is an omission, not a design.) Every function that touches the database uses the service-role key, which
  bypasses RLS. **The only access boundary is the check inside each handler**, and
  `supabase/functions/AUTHORIZATION.md` records which handlers actually have one
  (28 of 54 privileged functions, at the time of that audit). Read it before adding or
  editing a function, and follow the pattern it names: resolve the caller from the
  bearer token, then authorize that token-derived id against the resource — never an id
  from the request body. Do not reach for `verify_jwt = true` instead: the anon key
  ships in the frontend bundle and satisfies the gateway check, so it gates nothing.
- **Migrations** (`supabase/migrations/`): Timestamped SQL files. All tables use RLS. Apply with `supabase db push` (remote) or `./scripts/sync_localdb.sh --run` (local)
- **Types**: Auto-generated at `src/integrations/supabase/types.ts` — never edit manually, regenerate with `npm run gen:types`

### Key data model
- `institutions` → `classes` (grade_level + section_name) → `class_enrollments` (user ↔ class)
- `courses` → `offerings` (course ↔ class) → `course_instructors` + `course_instructor_sections`
- `course_materials` (PDFs) → AI-generated content (questions, flashcards, summaries)
- RLS enforces institutional isolation on all tables

### Local test users
`e2e-{student,instructor,admin,superadmin}@test.local` / `testpass123`

## Development Workflow

Work is done in an interactive session and shepherded by a human. There is no
label-driven or mention-driven automation: adding a label to an issue, or
mentioning `@claude` on one, does nothing.

There are no repo-specific skills here either — the E2E and sim skills moved to
the deployment repository with the suites they drive.

Greptile still reviews every push (it is a GitHub app, not a workflow), but
acting on its feedback is this session's job, and nothing merges a PR
automatically.
