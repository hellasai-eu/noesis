> **DRAFT — requires counsel review.** Do not publish or rely on it until that
> review has happened. The Greek version at `ai-usage-notice.el.md` is the
> binding one.

# How Noesis uses AI

**Last updated:** 2026-09-14
**Version:** 1.2 (draft)

This page explains what the AI in Noesis does, what it is not good at, and what
happens to what you write. It is written for pupils, parents and teachers — not
for lawyers.

## The short version

- **AI writes a lot of what you see**: practice questions, summaries, flashcards,
  cheat sheets and study guides, all generated from your school's own material.
- **AI does not grade you.** When you write an answer in your own words it
  waits for your teacher, who grades it; the AI writes a private draft note to
  help that review, and produces evaluations of how you are doing.
- **AI is the tutor** in the Socratic and study-tutor chats.
- **Your teacher decides.** Your marks are your teacher's, full stop. Any AI
  evaluation can be replaced by your teacher's own, and when that happens the
  record says so.
- **AI gets things wrong.** Every AI-produced thing you see is labelled, and the
  label says exactly that.
- **What you write goes to OpenAI** in the United States so the features can
  work. It is not used to train any model.

## What AI feedback is for — and what it is not for

**AI-generated assessments and feedback are provided for formative learning
purposes only.** They are there to help you see where you are and what to work
on next.

**They are not intended to determine official grades, admission, promotion,
educational placement, or any other consequential decision about you.**
Educators remain responsible for formal assessment.

That is not a preference — it is a term your school agrees to in writing
before it can use the platform. And since 14 September 2026 the platform goes
further: the AI does not grade your written answers at all. If you are ever told an AI
output decided something formal about you, that is not how it is supposed to
work, and it is worth raising with your school.

## What each feature does

### Tutoring — you are talking to a machine
The Socratic tutor and the study tutor are conversations with a language model.
They are deliberately Socratic: they ask you questions and withhold the answer,
because working it out yourself is the point. There is a notice above the input
box for the whole conversation saying so.

Your messages are kept, so you can come back to the conversation and so your
teacher can see how you worked.

The reply is written to your screen as the model produces it, a few words at a
time, rather than appearing finished. That matters for one thing beyond how it
feels, and the safety section below says what.

**A conversation pauses for your teacher after a while.** Every session stops
after a set number of messages and waits for a teacher to read it and release
it. The screen counts down to it, so a pause is never a surprise and never
means you did something wrong.

### Your open answers — graded by your teacher
When you write an answer in your own words, it is recorded and waits for your
teacher, who grades it. A model used to mark these answers out of 100 directly;
since 14 September 2026 it does not. The model still reads your answer and
writes a draft note — feedback, strengths, things to work on, never a mark —
that only your teacher can see. Your teacher can use it, change it or ignore
it; what you see is what your teacher decided.

**What the draft is not good at:** an answer that is right but phrased
unusually, or written in a way the model did not expect — which is exactly why
a person, not the model, does the grading. If you think your mark is wrong,
tell your teacher — it is theirs to change.

### Evaluating how you are doing
Periodically, a model reads your performance across a course and writes an
assessment: strengths, weaknesses, recommendations, and scores against the
competencies your teacher defined.

**It describes two different things, and the second one is effort.** Alongside
performance, an evaluation reports engagement — how many practice questions you
answered, how many flashcards you reviewed, how many messages you sent to a
tutor, how many study guides you started and finished. Those are plain counts,
not a judgement, but a model reads them and states a level of engagement in
words. **Talking to a tutor is counted**, which is worth knowing before you
decide how much to use one.

Teachers can also group a class by what the AI thinks its pupils are struggling
with, and turn such a group into a real one whose name carries the difficulty —
"Confuses mitosis and meiosis", say. When the AI does that grouping it is not
told who anyone is: pupils reach it as anonymous labels and the names are put
back afterwards.

**This is the part to be most careful about**, and the reason is worth stating
plainly: an evaluation is a description of *you*, not of one answer, and it
influences what you are asked to study next. Your teacher can rewrite any of
it, and an evaluation your teacher wrote or corrected no longer carries the AI
label — because it is no longer the machine's.

### Generating what you study
Questions, chapter summaries, flashcards, cheat sheets and study guides are
generated from the material your school uploads. They are grounded in your own
textbook rather than in the open internet, which makes them much more likely to
be right about your syllabus — and does not make them certain.

Teachers can edit generated material. Where a teacher may have edited it, the
label says "created with AI and may have been edited by your teacher", because
we do not record which of the two wrote the final text.

### Marking questions with a single right answer
Multiple choice, ordering, classification and most fill-in-the-gaps questions
are marked by ordinary code comparing your answer to the stored one — no model
is involved in deciding whether you were right. One exception is disclosed
here rather than hidden: if the exact comparison rejects a fill-in-the-gaps
answer, a model gives a second opinion on whether what you wrote means the
same as the stored answer. It can only accept — it never marks you down, and
if it fails, the exact comparison's result stands. Where those questions show
you an explanation afterwards, the explanation is generated (or
teacher-edited) text, and it is labelled.

### Safety screening
**What you send to a tutor is screened, and so is what the tutor sends back.**
Either way, a flag pauses the session and tells your school, and the flagged
text is kept for the school to look at.

Generated flashcards and cheat sheets are screened after they are written, and
generated images are checked before a pupil sees them.

**What screening cannot do is take the tutor's reply back.** Because the reply
is written to your screen as the model produces it, the finished answer can only
be checked once it is finished — by which time you have read it. So a flagged
reply is recorded, the session pauses and your school is told, but the text
stays where it is rather than disappearing. It used to be withheld outright,
before the tutor wrote live; that changed, and this page says so rather than
leaving "the reply is screened" to sound like more than it is. If a reply is
flagged, nothing you wrote caused it.

**Your own message is checked while the tutor is being asked, not before.** The
reply is held off your screen for a moment while that check runs, which is
normally enough that a flagged message stops it before a single word shows. If
the check runs slow, the reply starts arriving first and a late flag stops it
then.

Two honest limits on top of that. The check is automated and can miss things.
And if the screening service is unavailable, the reply is delivered unchecked
rather than the tutor stopping — a tutor that breaks whenever a third party is
down would be its own kind of harm. So if a tutor ever says something that seems
wrong or upsetting, tell your teacher.

## What we do not do

- **We do not train models on your data.** Neither do we let our provider.
- **We do not use AI to monitor pupils' behaviour**, detect cheating, infer
  emotions, or categorise anyone by biometric data. None of that exists in the
  platform.
- **We do not make final decisions about a pupil automatically.** Every AI
  output is subject to a teacher's override.

## What we have not yet measured

We have not run a formal study of how closely the AI's draft notes and
evaluations agree with teachers' own judgement, or of whether it treats some
pupils more harshly than others — for example pupils writing in a second
language.

We are saying so because a page like this usually does not. Now that teachers
grade every open answer themselves, their marks accumulate right next to the
AI's drafts — which is exactly the comparison data this study needs, and
running it is our next piece of work.

## Which models

The platform uses OpenAI models. Which model answers which task is decided in
one place in the code and recorded with every call, so we can always say what
produced a particular output. The full table, with the model and the reasoning
for each feature, is in the Privacy & AI Security Pack we give to schools.

## Questions

Ask your teacher first — they can see your work, and your marks are theirs to
set. For anything about the data itself, see the Privacy Policy.
