// The output contract for the unified conversation state (schema v2).
//
// Both tutoring surfaces keep their own teaching prompts — how to question a
// student is genuinely different between them — but they now describe the same
// output shape, so that description lives once, here.
//
// Appended to the end of a surface's system prompt, which keeps it above the
// prefix-cache boundary described in this directory's README: the text depends
// only on the schema version and which surface is asking, both of which are
// fixed for a session, so it is byte-identical across every turn of one.

/**
 * Describe the unified fields, and retire the v1 key list that the surface's
 * own prompt states earlier.
 *
 * `extraKeys` are the surface's own additions (see `extraOutputProperties`);
 * they are named so the closing key list stays complete, because a model told
 * "no extra keys" against an incomplete list will drop real ones.
 *
 * `endsOnStop` must match the subject's `completeOnStop`, and the surfaces
 * genuinely differ. An open question ends when the tutor says the answer is
 * right, and the composer closes behind that message — so a question asked
 * there is one the student cannot answer. A study session does not end that
 * way: nothing server-side acts on STOP, and the student closes it (or just
 * leaves) from the UI. STOP there is only the model's way of writing a
 * farewell — when the student says they are done, the reply carries no
 * question, matching the closing-message exception in `study-tutor.ts`. The
 * two exceptions must move together: a question-every-turn rule with no
 * exception plus a no-questions farewell is two instructions the model cannot
 * both obey.
 */
export function unifiedOutputContract(
  extraKeys: string[] = [],
  { endsOnStop = false }: { endsOnStop?: boolean } = {},
): string {
  const keys = ["assistant_text", "decision", "confidence", "state_update", ...extraKeys];

  return `## Output contract (supersedes any earlier key list above)

Return JSON with exactly these keys: ${keys.join(", ")}.
Where an instruction above names an older key, use the new one: write your reply
into assistant_text (not assistant_text_draft), and the learner state into
state_update (not state_patch). Inside the state, the learning goal is goal
(not learning_goal). Where it says stop = true, that is decision: STOP.

This section overrides every earlier statement about output keys, not only the
key list: any instruction above to omit answer_allowed, decision or goal, to
avoid renaming learning_goal, or to check that those names are absent, was
written for the older schema and no longer applies. Emit exactly the keys named
here, with assistant_text first, and disregard an earlier rule that names a
different first property. A key an earlier instruction requires that is absent
from the list above — response_class, for one — is not part of this schema:
do the thinking it describes, and let it shape your reply and your state
update, but do not emit it. Everything above about how to teach, how to ground
a claim, what to classify, and how conservatively to update each state field
stands unchanged.

- assistant_text — your reply to the student, in Markdown. Write it FIRST; it is
  streamed to the student as you produce it, so anything you emit before it is
  time the student spends watching nothing.
- decision — what this turn does:
  STOP (the exchange is finished), ASK (put a question to the student),
  HINT (nudge without giving it away), WORKED_STEP (work one step through).

  decision and assistant_text must agree. The student never sees decision —
  they see the reply — so a decision that describes something the reply does
  not do is simply wrong.
${decisionRule(endsOnStop)}
- confidence — 0..1, how sure you are of your judgement of the student.
- state_update — a FULL state object, not a patch: repeat what still holds and
  change only what this turn actually showed you. Be conservative; unsupported
  changes here mislead the next turn as much as a wrong answer would.

state_update fields:
- subject, current_topic, goal — what is being learnt, and toward what.
- progress_level — intro | developing | solid | mastered. Do not mark mastered
  unless the student has demonstrated it. It is never lowered, so raise it only
  on evidence.
- known — what the student has actually shown they understand. It accumulates
  across the session; list what this turn demonstrated.
- gaps — what is still missing right now. Replaced each turn, so a gap the
  student has just closed should be left out.
- misconceptions — what the student believes that is wrong. Also replaced each
  turn; drop one once it has been corrected.
- difficulty — easier | same | harder, for the next turn.
- frustration — 0..1. Do not raise it for an off-topic or irrelevant message;
  those are not signs of a struggling student.
- hint_level — 0..4, how much has been given away so far.
- judgement — CORRECT | PARTIAL | INCORRECT, on the student's last message.
- answer_allowed — true once the student has earned the full answer.`;
}

/**
 * What `decision` obliges the reply to do, per surface.
 *
 * Split because STOP is the only decision whose meaning is not shared: on one
 * surface it ends the session, on the other nothing acts on it at all.
 */
function decisionRule(endsOnStop: boolean): string {
  if (!endsOnStop) {
    return `
  - STOP does not close anything here — the session stays open and the student
    may return to review — but it is how you honour a goodbye. Say STOP only
    on a closing turn as ENDING THE SESSION defines it: the student has said
    they are finished, or assented, even with a bare "ok", to a wrap-up you
    offered. The reply is then the closing message those rules describe — a
    short farewell naming what they accomplished, with NO question mark and no
    offer of a recap or confirmation. Their first "let's finish" is final — a
    question after it reopens a conversation the student already ended.
  - Until then, ASK, HINT and WORKED_STEP continue the exchange: the reply must
    leave the student something to do next. When the material is covered, say
    so — you may offer once to wrap up, and that offer is your question.`;
  }

  return `
  - STOP has ONE trigger: the student's latest answer is correct. It is a
    verdict on their work, not a read of the mood in the room, so it must agree
    with the judgement you are writing into state_update — that field must say
    CORRECT on any turn you choose STOP.
  - Everything short of that is ASK, HINT or WORKED_STEP, however finished the
    exchange may feel. A student who is stuck, who has lost patience, who says
    they give up, or who asks you to stop has still not answered the question,
    and closing it on their behalf takes away the attempt they never got to
    make. Ending the session that way is the student's decision and they have
    their own way to make it; it is not yours.
  - STOP means you are done asking, and it is final: the exchange closes behind
    this message and the student cannot write back. So ask them NOTHING
    further — no follow-up question, no "can you also explain…", no "what do
    you think would happen if…", no rhetorical question, nothing ending in a
    question mark that invites a reply. A reply that asks for anything more is
    not a STOP: if you want another turn from the student, choose ASK or HINT
    and do not say STOP.

    On a STOP turn this overrides the rule above requiring exactly one question
    and exactly one "?" character: a STOP reply must contain none. That rule
    governs every other turn, where it stands unchanged. The two never both
    apply, because a turn that has something left to ask is not a STOP.
  - ASK, HINT and WORKED_STEP mean the exchange continues, so the reply must
    leave the student something to do next.`;
}
