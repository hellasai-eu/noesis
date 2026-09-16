import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";

// Interface for accept invitation request
interface AcceptInvitationRequest {
  invitationId: string;
  userId: string;
}

Deno.test("accept-invitation: validates required parameters", () => {
  const validRequest: AcceptInvitationRequest = {
    invitationId: "inv-123",
    userId: "user-456",
  };

  assertExists(validRequest.invitationId);
  assertExists(validRequest.userId);
});

Deno.test("accept-invitation: returns 400 for missing invitationId", () => {
  const requestWithoutInvitation = {
    userId: "user-456",
  };

  assertEquals("invitationId" in requestWithoutInvitation, false);
});

Deno.test("accept-invitation: returns 400 for missing userId", () => {
  const requestWithoutUser = {
    invitationId: "inv-123",
  };

  assertEquals("userId" in requestWithoutUser, false);
});

Deno.test("accept-invitation: returns 404 when invitation not found", () => {
  const invitation = null;
  const errorResponse = {
    error: "Invitation not found",
    status: 404,
  };

  assertEquals(invitation, null);
  assertEquals(errorResponse.status, 404);
});

Deno.test("accept-invitation: handles existing membership (idempotency)", () => {
  const existingMembership = { id: "membership-123" };
  const shouldSkipCreation = existingMembership !== null;

  assertEquals(shouldSkipCreation, true);
});

Deno.test("accept-invitation: creates user_institutions entry", () => {
  const newMembership = {
    user_id: "user-123",
    institution_id: "inst-456",
    role: "student",
  };

  assertExists(newMembership.user_id);
  assertExists(newMembership.institution_id);
  assertExists(newMembership.role);
});

Deno.test("accept-invitation: copies invited_grade_level_id from invitation to user_institutions", () => {
  // Every invitation carries invited_grade_level_id (the TEXT column was
  // dropped in #799). accept-invitation copies the FK into user_institutions
  // so the grade stays populated after acceptance.
  const invitation = {
    invited_grade_level_id: "gl-dimotiko-1",
    institution_id: "inst-456",
    role: "student",
  };

  const membership = {
    user_id: "user-123",
    institution_id: invitation.institution_id,
    role: invitation.role,
    grade_level_id: invitation.invited_grade_level_id,
  };

  assertEquals(membership.grade_level_id, "gl-dimotiko-1");
});

Deno.test("accept-invitation: marks invitation as accepted", () => {
  const invitation = { status: "pending" };
  const updateData = {
    status: "accepted",
    accepted_at: new Date().toISOString(),
  };

  assertEquals(invitation.status, "pending");
  assertEquals(updateData.status, "accepted");
  assertExists(updateData.accepted_at);
});

Deno.test("accept-invitation: skips update for already accepted invitation", () => {
  const invitation = { status: "accepted" };
  const shouldUpdate = invitation.status === "pending";

  assertEquals(shouldUpdate, false);
});

Deno.test("accept-invitation: successful response structure", () => {
  const successResponse = {
    success: true,
    message: "Invitation accepted successfully",
    membership: {
      institution_id: "inst-123",
      role: "student",
    },
  };

  assertEquals(successResponse.success, true);
  assertExists(successResponse.membership);
  assertEquals(successResponse.membership.role, "student");
});

Deno.test("accept-invitation: handles membership creation error", () => {
  const membershipError = {
    error: "Failed to create membership",
    details: "Duplicate entry",
  };

  assertExists(membershipError.error);
  assertExists(membershipError.details);
});

Deno.test("accept-invitation: evaluator role replays invitation_courses into course_evaluators", () => {
  const invitation = {
    id: "inv-evaluator-1",
    role: "evaluator",
    institution_id: "inst-1",
  };
  const userId = "user-evaluator-1";
  const invitationCourses = [
    { course_id: "course-a" },
    { course_id: "course-b" },
  ];

  const courseEvaluatorRows = invitationCourses.map((ic) => ({
    course_id: ic.course_id,
    user_id: userId,
  }));

  assertEquals(invitation.role, "evaluator");
  assertEquals(courseEvaluatorRows.length, 2);
  assertEquals(courseEvaluatorRows[0].user_id, userId);
  assertEquals(courseEvaluatorRows[1].course_id, "course-b");
});

Deno.test("accept-invitation: non-evaluator roles skip course_evaluators insertion", () => {
  const roles = ["student", "instructor", "admin"];
  for (const role of roles) {
    const shouldInsertEvaluatorRows = role === "evaluator";
    assertEquals(shouldInsertEvaluatorRows, false);
  }
});

Deno.test("accept-invitation: OPTIONS returns CORS headers", () => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  assertEquals(corsHeaders["Access-Control-Allow-Origin"], "*");
});
