import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  deriveGroupWeaknesses,
  type DeriveWeaknessesInput,
  suggestDifficulty,
} from "../group-weaknesses.ts";

// --- suggestDifficulty ------------------------------------------------------

Deno.test("suggestDifficulty maps correctness bands to difficulty", () => {
  assertEquals(suggestDifficulty(null), null);
  assertEquals(suggestDifficulty(0), "easy");
  assertEquals(suggestDifficulty(49), "easy");
  assertEquals(suggestDifficulty(50), "medium");
  assertEquals(suggestDifficulty(74), "medium");
  assertEquals(suggestDifficulty(75), "hard");
  assertEquals(suggestDifficulty(100), "hard");
});

// --- helpers ----------------------------------------------------------------

const baseCatalog = {
  competencies: [
    { id: "c1", title: "Fractions", chapter_ids: ["ch1"] },
    { id: "c2", title: "Decimals", chapter_ids: ["ch2"] },
    { id: "c3", title: "Geometry", chapter_ids: ["ch1", "ch3"] },
  ],
  chapters: [
    { id: "ch1", title: "Chapter 1" },
    { id: "ch2", title: "Chapter 2" },
    { id: "ch3", title: "Chapter 3" },
  ],
};

function input(overrides: Partial<DeriveWeaknessesInput>): DeriveWeaknessesInput {
  return {
    memberCount: 3,
    quizAnswers: [],
    questionCompetencies: [],
    evalScores: [],
    competencies: baseCatalog.competencies,
    chapters: baseCatalog.chapters,
    ...overrides,
  };
}

// --- insufficient data ------------------------------------------------------

Deno.test("insufficient data: no evals and too few answers", () => {
  const res = deriveGroupWeaknesses(
    input({
      quizAnswers: [
        { user_id: "u1", is_correct: true, question_id: "q1" },
        { user_id: "u1", is_correct: false, question_id: "q2" },
      ],
      questionCompetencies: [
        { question_id: "q1", competency_id: "c1" },
        { question_id: "q2", competency_id: "c1" },
      ],
    }),
  );
  assert(res.insufficient_data);
  assertEquals(res.weak_competencies.length, 0);
  assertEquals(res.suggested_difficulty, null);
  assert(res.reason);
  // Overall stats are still reported.
  assertEquals(res.overall.total_answers, 2);
  assertEquals(res.overall.members_with_data, 1);
});

Deno.test("a single eval score is enough signal even with no quiz answers", () => {
  const res = deriveGroupWeaknesses(
    input({ evalScores: [{ competency_id: "c1", score: 30, user_id: "u1" }] }),
  );
  assert(!res.insufficient_data);
  assertEquals(res.weak_competencies.length, 1);
  assertEquals(res.weak_competencies[0].competency_id, "c1");
  // No quiz answers ⇒ no correctness signal ⇒ no difficulty suggestion.
  assertEquals(res.suggested_difficulty, null);
  // The eval-only member still counts toward members_with_data.
  assertEquals(res.overall.members_with_data, 1);
});

// --- ranking + combined scoring ---------------------------------------------

Deno.test("ranks weakest-first and combines eval + mcq signals", () => {
  const answers = [];
  // c1 (Fractions): 2/10 correct across group ⇒ mcq 20%.
  for (let i = 0; i < 10; i++) {
    answers.push({ user_id: "u1", is_correct: i < 2, question_id: "q1" });
  }
  // c2 (Decimals): 9/10 correct ⇒ mcq 90%.
  for (let i = 0; i < 10; i++) {
    answers.push({ user_id: "u2", is_correct: i < 9, question_id: "q2" });
  }
  const res = deriveGroupWeaknesses(
    input({
      quizAnswers: answers,
      questionCompetencies: [
        { question_id: "q1", competency_id: "c1" },
        { question_id: "q2", competency_id: "c2" },
      ],
      evalScores: [
        { competency_id: "c1", score: 40, user_id: "u1" }, // Fractions mastery = 0.5*40 + 0.5*20 = 30
        { competency_id: "c2", score: 80, user_id: "u2" }, // Decimals mastery = 0.5*80 + 0.5*90 = 85
      ],
    }),
  );
  assert(!res.insufficient_data);
  assertEquals(res.weak_competencies.map((w) => w.competency_id), ["c1", "c2"]);
  const c1 = res.weak_competencies[0];
  assertEquals(c1.mastery, 30);
  assertEquals(c1.eval_avg, 40);
  assertEquals(c1.mcq_percent, 20);
  assertEquals(c1.mcq_correct, 2);
  assertEquals(c1.mcq_total, 10);
  // Overall correctness = 11/20 = 55% ⇒ medium.
  assertEquals(res.overall.percent_correct, 55);
  assertEquals(res.suggested_difficulty, "medium");
});

Deno.test("eval scores are averaged across the group's members", () => {
  const res = deriveGroupWeaknesses(
    input({
      evalScores: [
        { competency_id: "c1", score: 20, user_id: "u1" },
        { competency_id: "c1", score: 60, user_id: "u2" },
        { competency_id: "c1", score: 40, user_id: "u3" }, // avg = 40
      ],
    }),
  );
  assertEquals(res.weak_competencies[0].eval_avg, 40);
  assertEquals(res.weak_competencies[0].mastery, 40);
  assertEquals(res.overall.members_with_data, 3);
});

Deno.test("topN truncates to the weakest competencies", () => {
  const res = deriveGroupWeaknesses(
    input({
      topN: 2,
      evalScores: [
        { competency_id: "c1", score: 10, user_id: "u1" },
        { competency_id: "c2", score: 90, user_id: "u2" },
        { competency_id: "c3", score: 50, user_id: "u3" },
      ],
    }),
  );
  assertEquals(res.weak_competencies.map((w) => w.competency_id), ["c1", "c3"]);
});

// --- chapter rollup ---------------------------------------------------------

Deno.test("rolls competency up to its chapters (deduped, titled)", () => {
  const res = deriveGroupWeaknesses(
    input({ evalScores: [{ competency_id: "c3", score: 20, user_id: "u1" }] }),
  );
  const c3 = res.weak_competencies[0];
  assertEquals(c3.chapters, [
    { id: "ch1", title: "Chapter 1" },
    { id: "ch3", title: "Chapter 3" },
  ]);
});

Deno.test("unknown chapter ids are dropped from the rollup", () => {
  const res = deriveGroupWeaknesses(
    input({
      competencies: [{ id: "c1", title: "Fractions", chapter_ids: ["ch1", "missing"] }],
      evalScores: [{ competency_id: "c1", score: 20, user_id: "u1" }],
    }),
  );
  assertEquals(res.weak_competencies[0].chapters, [{ id: "ch1", title: "Chapter 1" }]);
});

// --- guards -----------------------------------------------------------------

Deno.test("competencies not in the catalog are ignored", () => {
  const res = deriveGroupWeaknesses(
    input({ evalScores: [{ competency_id: "not-a-comp", score: 10, user_id: "u1" }] }),
  );
  // No catalog competency and no quiz answers ⇒ still insufficient (no evals counted? no)
  // The score counts as an eval signal, but it maps to no catalog entry, so no weak areas.
  assert(!res.insufficient_data);
  assertEquals(res.weak_competencies.length, 0);
});

Deno.test("null eval scores contribute no signal", () => {
  const res = deriveGroupWeaknesses(
    input({
      quizAnswers: [{ user_id: "u1", is_correct: false, question_id: "q1" }],
      questionCompetencies: [{ question_id: "q1", competency_id: "c1" }],
      evalScores: [{ competency_id: "c2", score: null, user_id: "u2" }],
    }),
  );
  // Only 1 answer, and the single eval score is null ⇒ treated as no evals.
  assert(res.insufficient_data);
});

Deno.test("difficulty is hard when the group is strong overall", () => {
  const answers = [];
  for (let i = 0; i < 10; i++) {
    answers.push({ user_id: "u1", is_correct: i < 8, question_id: "q1" }); // 80%
  }
  const res = deriveGroupWeaknesses(
    input({
      quizAnswers: answers,
      questionCompetencies: [{ question_id: "q1", competency_id: "c1" }],
    }),
  );
  assertEquals(res.overall.percent_correct, 80);
  assertEquals(res.suggested_difficulty, "hard");
});
