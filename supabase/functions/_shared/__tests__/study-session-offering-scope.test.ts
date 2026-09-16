import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, MockRoute } from "./handler-harness.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveStudySessionOffering } from "../resolve-study-session-offering.ts";
import { studySessionSubject } from "../chat-subjects/study-session.ts";

// ── Study-tutor sessions carry their section ───────────────────────────
//
// The study-tutor surface used to create every `chat_sessions` row with
// `offering_id = NULL`, because its `authorize` returned a course and nothing
// else. That is not a cosmetic gap: the write policies on `chat_sessions` and
// `chat_messages` go through `instructor_can_access_student_work`, and its
// unattributed arm admits only an instructor with no section restrictions at
// all. So a teacher who takes 1Α but not 1Β could read a tutoring transcript
// (staff SELECT is course-wide) and could not unpause it, delete it, or reply
// in it — while an institution admin, who bypasses both arms, could do all
// three. The open-question surface never had the bug, because it resolves the
// offering the question was published through.

const USER_ID = "99999999-9999-9999-9999-999999999999";
const STUDY_SESSION_ID = "44444444-4444-4444-4444-444444444444";
const COURSE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_COURSE_ID = "22222222-2222-2222-2222-222222222222";

function client() {
  return createClient("http://localhost:54321", "test-service-role-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The classes this study session is assigned to, as offering rows. */
function assignmentRoute(
  rows: Array<{ offeringId: string; classId: string; courseId?: string }>,
): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/offering_study_sessions"),
    respond: () =>
      json(
        rows.map((r) => ({
          offering_id: r.offeringId,
          offerings: {
            id: r.offeringId,
            class_id: r.classId,
            course_id: r.courseId ?? COURSE_ID,
          },
        })),
      ),
  };
}

/** The classes the student is enrolled in, among those queried. */
function enrollmentRoute(classIds: string[]): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/class_enrollments"),
    respond: () => json(classIds.map((class_id) => ({ class_id }))),
  };
}

const STUDY_SESSION_ROUTE: MockRoute = {
  match: (url) => url.includes("/rest/v1/study_sessions"),
  respond: () => json({ id: STUDY_SESSION_ID, course_id: COURSE_ID }),
};

Deno.test("resolveStudySessionOffering: takes the offering of the class the student sits in", async () => {
  const h = createTestHarness({
    routes: [
      assignmentRoute([
        { offeringId: "off-A", classId: "class-A" },
        { offeringId: "off-B", classId: "class-B" },
      ]),
      enrollmentRoute(["class-B"]),
    ],
  });
  try {
    const offeringId = await resolveStudySessionOffering(client(), {
      studySessionId: STUDY_SESSION_ID,
      courseId: COURSE_ID,
      userId: USER_ID,
    });
    assertEquals(offeringId, "off-B");
  } finally {
    h.cleanup();
  }
});

Deno.test("resolveStudySessionOffering: an unassigned session stays unscoped", async () => {
  // Nothing places this work in a section, which is the case the policies'
  // unattributed arm exists for. The enrolment table must not even be asked —
  // asserted by leaving it unmocked.
  const h = createTestHarness({ routes: [assignmentRoute([])] });
  try {
    const offeringId = await resolveStudySessionOffering(client(), {
      studySessionId: STUDY_SESSION_ID,
      courseId: COURSE_ID,
      userId: USER_ID,
    });
    assertEquals(offeringId, null);
    assertEquals(h.fetchLog.some((c) => c.url.includes("class_enrollments")), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("resolveStudySessionOffering: an offering in another course is not the answer", async () => {
  // `instructor_can_access_student_work` requires the offering to belong to the
  // row's own course before it will read it, so an incoherent pair is worse
  // than none: it names a section that decides nothing.
  const h = createTestHarness({
    routes: [
      assignmentRoute([
        { offeringId: "off-elsewhere", classId: "class-A", courseId: OTHER_COURSE_ID },
      ]),
    ],
  });
  try {
    const offeringId = await resolveStudySessionOffering(client(), {
      studySessionId: STUDY_SESSION_ID,
      courseId: COURSE_ID,
      userId: USER_ID,
    });
    assertEquals(offeringId, null);
  } finally {
    h.cleanup();
  }
});

Deno.test("resolveStudySessionOffering: two enrolled classes leave it unscoped", async () => {
  // A student in two classes of one course, both assigned this session. Picking
  // either would hand one section's instructor writes over work that may be the
  // other's, so nothing is picked.
  const h = createTestHarness({
    routes: [
      assignmentRoute([
        { offeringId: "off-A", classId: "class-A" },
        { offeringId: "off-B", classId: "class-B" },
      ]),
      enrollmentRoute(["class-A", "class-B"]),
    ],
  });
  try {
    const offeringId = await resolveStudySessionOffering(client(), {
      studySessionId: STUDY_SESSION_ID,
      courseId: COURSE_ID,
      userId: USER_ID,
    });
    assertEquals(offeringId, null);
  } finally {
    h.cleanup();
  }
});

Deno.test("studySessionSubject.authorize: the session is scoped to the student's offering", async () => {
  // The regression guard. `runChatTurn` stamps `authorization.offeringId` onto
  // the session and repairs a row that has none, so an authorisation that
  // carries no offering is what left every study-tutor transcript unwritable by
  // a section-restricted instructor.
  const h = createTestHarness({
    routes: [
      STUDY_SESSION_ROUTE,
      assignmentRoute([{ offeringId: "off-A", classId: "class-A" }]),
      enrollmentRoute(["class-A"]),
    ],
  });
  try {
    const result = await studySessionSubject.authorize(client(), {
      subjectId: STUDY_SESSION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, true);
    assertEquals(result.ok && result.courseId, COURSE_ID);
    assertEquals(result.ok && result.offeringId, "off-A");
  } finally {
    h.cleanup();
  }
});

Deno.test("studySessionSubject.authorize: an unresolvable offering is not a refusal", async () => {
  // Practice-mode tutoring on a session assigned to nobody still runs; it is
  // just course-scoped, exactly as before.
  const h = createTestHarness({
    routes: [STUDY_SESSION_ROUTE, assignmentRoute([])],
  });
  try {
    const result = await studySessionSubject.authorize(client(), {
      subjectId: STUDY_SESSION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, true);
    assertEquals(result.ok && result.offeringId, null);
  } finally {
    h.cleanup();
  }
});
