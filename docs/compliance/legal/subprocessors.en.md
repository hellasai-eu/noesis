> **DRAFT — requires counsel review.** The Greek version at
> `subprocessors.el.md` is the binding one.

# Subprocessors

**Last updated:** 2026-09-08
**Version:** 1.1 (draft)

Noesis processes personal data on behalf of schools. To do that we use the
service providers below. Each is a subprocessor under Art. 28 GDPR, and each is
listed with **what it actually receives** — not with a purpose so general that
it says nothing.

Schools are notified before a subprocessor is added or replaced, as set out in
the data-processing agreement.

## The list

### Supabase
**What it does:** the database, user authentication, file storage, and the
server functions that run the platform's logic.
**What it receives:** everything. Accounts, pupils' work, tutor conversations,
uploaded material, logs.
**Where:** the database, authentication data and stored files are hosted in
Ireland (EU). Edge functions — the server code — run on Supabase's global edge
runtime and are not pinned to a region: a request is executed near whoever
made it, which for a school in Greece is normally the EU, but this is routing
behaviour, not a residency guarantee. Data at rest stays in Ireland.
**Website:** supabase.com

### OpenAI
**What it does:** every AI feature — generating questions and study material,
grading open answers, tutoring, evaluating pupils, and safety screening.
**What it receives:**
- Pupils' free-text answers, for grading.
- Tutor conversations in full, turn by turn.
- Text extracted from scanned handwritten work.
- Teachers' guidance notes about a pupil, with all pupil names removed, when a
  teacher generates questions aimed at that one pupil. The request never
  carries the pupil's name.
- **Course material files** the school uploads. These are stored at OpenAI, in
  a file store belonging to that school, so the AI answers from your own
  material. They stay there until deleted.
- Content submitted for safety screening: what the pupil wrote, and the tutor's
  own finished reply. The reply is submitted once the turn is complete, which on
  the tutoring surface pupils use is after they have read it.

**Where:** United States — the default endpoint; no data-residency setting is
configured.
**Transfer basis:** OpenAI's data-processing agreement, incorporating the
European Commission's Standard Contractual Clauses — **executed 2026-09-15**.
**Training:** content submitted through the business API is not used to train
OpenAI's models.
**Retention at OpenAI:** zero-data-retention is **not** enabled — OpenAI's
limited abuse-monitoring retention applies to API traffic. The platform
additionally sends calls with `store: false` by default, so nothing persists
in the OpenAI dashboard unless a super-administrator enables the
per-institution opt-in; background-mode responses, which OpenAI requires to
be stored, are deleted once the result is retrieved.
**Website:** openai.com

### ConvertAPI
**What it does:** splits PDFs into chapters, extracts images, makes thumbnails,
converts HTML to PDF.
**What it receives:** the PDF file itself. ConvertAPI fetches it directly from
our storage using a short-lived signed link, so course material — and any pupil
work a school has uploaded as a PDF — passes through it.
**Where:** `[OPERATOR: confirm from the vendor's terms]`
**Website:** convertapi.com

### Supadata
**What it does:** turns a link a teacher pastes into text a course material can
be built from — a web page as Markdown, or a YouTube video's transcript and
title.
**What it receives:** the address the teacher typed, plus the language the
course is taught in — so a page available in several comes back in the right one
— and, for a video, a flag asking for the transcript as plain text. Nothing
else. Every outbound request the link importer makes goes to Supadata; the
platform does not fetch the page or the video itself. No pupil data is sent, and
nothing is sent back to it afterwards.
**Where:** `[OPERATOR: confirm from the vendor's terms]`
**Website:** supadata.ai

### Vercel
**What it does:** serves the web application, and provides page analytics and
performance measurement.
**What it receives:** the requests your browser makes. Analytics and Speed
Insights are **cookieless** and produce page-level counts, not identified
users.
**Website:** vercel.com

### Resend
**What it does:** sends transactional email.
**What it receives:** the recipient's email address and name for invitations;
whatever a sender typed into the contact form, including their own address.
**Website:** resend.com

## Not subprocessors

Stated because their absence is a decision, not an oversight:

- **Google Analytics** was used and has been removed. No advertising or
  cross-site tracking service is present.
- **Fly.io** appears in some of our internal notes as a possible deployment
  target. Nothing is deployed there and it receives no data. It will be added
  here if that changes.

## Changes to this list

Adding or replacing a subprocessor is notified to schools in advance, with
enough time to object. The mechanism is in §6 of the data-processing agreement.
