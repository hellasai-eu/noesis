> **DRAFT — requires counsel review.** It must not be published or relied on
> until that review has happened. The Greek version at `privacy-policy.el.md`
> is the binding one; this is the reference translation.

# Privacy Policy

**Last updated:** 2026-09-15
**Version:** 1.3 (draft)

## 1. Who is responsible for your data

Noesis is a learning platform that schools use with their pupils. That split
matters for your rights, so it comes first:

- **Your school is the controller.** It decides that the platform is used, what
  is uploaded to it, and how long records are kept. Requests about your data
  start there.
- **Noesis is the processor.** We hold and process the data on the school's
  instructions, under a written data-processing agreement.

**Noesis:** Hellenic Institute for AI & Education `[OPERATOR: company number, registered address]`
**Contact for privacy questions:** privacy@noesis-app.com
**Data Protection Officer:** Pending — `[OPERATOR: appoint, or record reasoning under Art. 37]`

If you are a pupil or a parent, the fastest route is your school. If you write
to us directly we will help, but for most requests we have to ask the school
first, because the decision is theirs.

## 2. What we hold

### About every user
Email address, password (stored hashed by our authentication provider), name,
and your role and school. Sign-in times, IP address and browser user agent.

### About pupils, additionally
Date of birth and father's name, **where the school chooses to record them** —
both are optional. Class and year group.

### The work you do on the platform
Quiz attempts and answers. Answers to open questions, and the grades and
feedback on them. Study-guide answers, which cannot be changed once submitted.
Flashcard review history. Progress through course material.

### What you write to the AI tutors
The full conversation, message by message. What a pupil types into a tutor is
kept so the conversation can be resumed and so a teacher can see how the pupil
worked through a problem.

### What the AI concludes about a pupil
Competency scores, periodic evaluations describing strengths, weaknesses and
recommendations, and — for each open answer — a draft review note that only
staff can see. Grades on open answers are the teacher's own: since
14 September 2026 the AI assigns none (grades it assigned before then remain
on the record). A teacher can replace any AI conclusion with their own
judgement, and when they do, the record says so.

An evaluation has **two parts, and the second is about effort rather than
marks**. Alongside performance, it describes how much a pupil has engaged —
counted from how many practice questions were answered, how many flashcards
were reviewed, how many messages were sent to an AI tutor, and how many study
guides were started and answered. Those counts are shown to the teacher, and a
model turns them into a stated engagement level with a short summary.

The AI also **groups a class by what its answers suggest the pupils are
struggling with**, and a teacher can turn a group into a real one that carries
the difficulty in its name — for example "Confuses mitosis and meiosis". When
that grouping is produced, pupils are identified to the model only by a
throwaway label, not by name.

### Scanned handwritten work
Where a school uses that feature: the scan itself, the text extracted from it,
and the pupil's name as written on the paper.

### Administrative notes
Notes a teacher or administrator writes about a pupil, with a record of every
change to them.

### Operational records
How much the AI features were used, which model answered, and technical traces
of tutor sessions — including the pupil's own messages. Failed sign-in
attempts. Bug reports and any screenshot attached to them.

## 3. Why we hold it

To run the platform for your school: teaching material, assessment, tutoring,
progress tracking, accounts, and keeping the service secure and working.

We do **not** use your data for our own purposes, we do not sell it, and we do
not use it for advertising.

**We do not use your data to train AI models**, and neither does our AI
provider — the models we call are used through a business API where content
submitted is not used for training. See section 5.

The legal basis for the processing is your school's, not ours. Ask your school
what it relies on; for a state school it is normally the performance of a
public task.

## 4. Automated decisions and AI

The platform marks objective exercises automatically and produces evaluations;
open answers are graded by the teacher — since 14 September 2026 the AI
assigns no grades to them, and instead drafts a private note only the teacher
can see.
Two things follow:

- **Every AI-produced feedback and evaluation shown to a pupil is labelled as
  such**, and says that the teacher decides.
- **A teacher decides your grades, and can override the rest.** Open-answer
  grades are the teacher's own; no AI evaluation stands only because a machine
  produced it — but nothing forces a teacher to review each evaluation, so if
  you disagree with one, say so to your teacher. That is the mechanism.

**AI assessments are formative.** They exist to help a pupil learn
from their work, and they are **not intended to determine official grades,
admission, promotion, educational placement, or any other consequential
decision about a pupil.** Educators remain responsible for formal assessment.
Your school agrees to this in writing before it can use the platform.

We describe what each AI feature does, and what it is known not to do well, in
our AI notice.

## 5. Who else sees the data

We use a small number of service providers. The current list, with what each
one receives, is published at `/legal/subprocessors` and kept up to date.
The platform itself — the database, user accounts, pupils' work and uploaded
files — is hosted in Ireland, within the European Union.

The one worth reading carefully:

**OpenAI** provides the AI. Pupils' free-text answers, the whole of their tutor
conversations, the text extracted from scanned work, and the course material
files the school uploads are all sent to OpenAI so the features can work.
Processing takes place in the **United States** (the default endpoint — no
data-residency setting is configured). The transfer is covered by OpenAI's
data-processing agreement and the European Commission's Standard Contractual
Clauses, executed on 15 September 2026. No zero-data-retention arrangement is
in place: OpenAI's limited abuse-monitoring retention applies, and the
platform sends calls with `store: false` by default — the exceptions are a
per-school opt-in a platform administrator controls, and background responses
that OpenAI requires to be stored, which are deleted once retrieved.

Course material files uploaded by the school are stored at OpenAI until they
are deleted, so that the AI can answer from your school's own material rather
than from the open internet.

We also use **ConvertAPI** to split and process PDF files. It fetches the file
directly from our storage, so course material passes through it.

Where a teacher builds material from a link rather than a file, **Supadata**
fetches that web page or YouTube transcript for us and returns it as text. It
receives the address the teacher typed, and nothing about you.

## 6. Cookies and what is stored in your browser

**We do not use cookies for tracking or advertising, and there is no consent
banner because there is nothing to consent to.**

- **Your sign-in session** is kept in your browser's local storage. It is what
  keeps you signed in; the platform does not work without it.
- **Analytics** are provided by Vercel Analytics and Speed Insights, which are
  **cookieless**: they count page views and measure loading speed without
  identifying you or following you to other sites.
- Google Analytics was previously used and has been **removed**.

## 7. How long we keep things

**Security and operational logs are deleted automatically.** Sign-in history,
failed sign-in attempts, AI usage records and rate-limit events are purged on a
daily schedule, **12 months** after they are written. Tutor session traces —
our internal diagnostic copy of tutor conversations, kept separately from the
conversation you see — are purged after **3 months**.

**Your school decides how long your learning record is kept** — grades,
answers, evaluations, chats. That is agreed in our contract with the school and
is not something we shorten unilaterally, because it is the school's record.

When an account is deleted, we erase the personal data attached to it in one
action, and we can demonstrate that it is gone. Two exceptions we state rather
than hide:

- **Our audit trail survives.** It records that an administrator deleted an
  account, and when. It holds no name or email address for the deleted person,
  and it is itself deleted **24 months** after each entry is written.
- **Backups.** Our database provider keeps backups. Deleted rows remain in
  those backups until they expire on the provider's own schedule.

## 8. Your rights

Under the GDPR you can ask for access to your data, correction, erasure,
restriction, portability, and to object to processing.

**Send the request to your school.** The school is the controller and decides
it; we act on its instruction. On the school's request we can produce a
complete export of one person's data as a single file, and we can erase an
account entirely.

If a school does not respond, you may complain to the Hellenic Data Protection
Authority (Αρχή Προστασίας Δεδομένων Προσωπικού Χαρακτήρα, www.dpa.gr).

## 9. Children

Most of our users are minors. That is the reason for most of the choices
described here, and it is why we have carried out a data protection impact
assessment.

We do not rely on a child's consent for anything: the school decides that the
platform is used, and the school is accountable for telling parents.

## 10. Security

What protects the data, stated with its limits:

- **Isolation between schools** is enforced in the database itself, on every
  table, and is covered by an automated test suite that runs on every change.
- **Every server function that touches data checks who is calling** before it
  acts. Each one has been audited individually.
- **Encryption** in transit and at rest, provided by our hosting platform.
- **What you send to an AI tutor is screened** for harmful material, **and so
  is the tutor's reply.** Both checks run on every turn, both are recorded, and
  a flag pauses the session and tells your school. What screening no longer
  does is keep a flagged reply off your screen — see below.
- **Administrative actions are recorded** in a durable audit log.

And what does **not** protect it, which you are entitled to know:

- **Two-factor authentication is optional, not required.** You can enable an
  authenticator app on your account — and staff accounts should — but nothing
  forces it yet, for any role. (Passwords themselves are now held to a
  server-enforced minimum of eight characters with letters and digits, and
  known-leaked passwords are refused.)
- **A flagged tutor reply is no longer withheld.** The tutor writes to your
  screen as it goes, which is what makes it feel like a conversation — and it
  means its reply can only be checked once you have read it. A flagged reply is
  recorded, the session pauses, and your school is told, but the text stays on
  screen rather than vanishing. This is a deliberate choice about how the tutor
  works, and it is weaker than what came before it, so we state it rather than
  let "the reply is screened" imply more than it does.
- **Your own message is checked alongside the tutor, not before it.** The reply
  is held back for a moment while the check runs, which is normally enough for a
  flagged message to stop the reply before a word of it appears. If the check is
  slow, the reply starts arriving first and a late flag stops it then.
- **Screening is not a guarantee.** It is an automated check that can miss
  things, and when the screening service is unavailable a reply is delivered
  unchecked rather than the tutor stopping — because a tutor that breaks
  whenever a third party is down is its own kind of harm. If a tutor says
  something wrong or upsetting, tell your teacher.

## 11. Changes

We will update this policy as the platform changes. The date at the top says
when. Material changes are notified to schools, which pass them on.

## 12. Contact

privacy@noesis-app.com `[OPERATOR: postal address]`
