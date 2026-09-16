# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: *Security* → *Report a vulnerability* on
this repository, which opens a draft security advisory visible only to you and
the maintainers.

Please include what you need to reproduce it — the affected route or edge
function, the role you were authenticated as, and the request or steps. If you
found it against a deployment rather than a local stack, say which.

We aim to acknowledge a report within five working days.

## Scope

This platform is used by schools, and most of its users are minors. Reports
that touch personal data are treated with priority. Of particular interest:

- **Cross-institution data access.** Every table carries row-level security and
  institutional isolation is the property it exists to enforce. Any read or
  write that crosses an institution boundary is a serious finding.
- **Edge-function authorization.** Functions hold the service-role key and so
  bypass RLS; the boundary is the check inside each handler. The model and the
  per-function status are documented in
  [`supabase/functions/AUTHORIZATION.md`](supabase/functions/AUTHORIZATION.md).
- **Privilege escalation between roles** — student, instructor, evaluator,
  admin, super-admin.
- **Prompt injection or jailbreaks against the pupil-facing AI** that produce
  harmful output, leak another user's data, or extract assigned answers.

## Please do not

- Test against production. Use a local stack (`npm run dev:local`) or an
  ephemeral preview environment. Automated scanning of the production
  deployment is not authorised.
- Access, modify or retain any real user's data. If a proof of concept would
  require it, describe the mechanism instead and we will reproduce it.
- Run denial-of-service or load tests.

## What is not a vulnerability

The Supabase **anon / publishable key** is public by design — it ships in every
frontend bundle, and it is the row-level security policies, not the key, that
protect the data.

## Disclosure

We will work with you on a fix and a disclosure timeline. Please give us a
chance to ship the fix before publishing.
