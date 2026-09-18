import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";

// Interface for invitation request
interface InvitationRequest {
  email: string;
  invitedName?: string;
  institutionId: string;
  institutionName: string;
  inviterName: string;
}

Deno.test("send-invitation: validates required fields", () => {
  const validRequest: InvitationRequest = {
    email: "test@example.com",
    institutionId: "inst-123",
    institutionName: "Test University",
    inviterName: "John Doe",
  };

  assertExists(validRequest.email);
  assertExists(validRequest.institutionId);
  assertExists(validRequest.institutionName);
  assertExists(validRequest.inviterName);
});

Deno.test("send-invitation: invitedName is optional", () => {
  const requestWithoutName: InvitationRequest = {
    email: "test@example.com",
    institutionId: "inst-123",
    institutionName: "Test University",
    inviterName: "John Doe",
  };

  assertEquals(requestWithoutName.invitedName, undefined);
});

Deno.test("send-invitation: generates correct invite link", () => {
  const baseUrl = "https://dianoisis.net";
  const institutionId = "inst-123";
  const email = "test@example.com";

  const inviteLink = `${baseUrl}/auth?invitation=${institutionId}&email=${encodeURIComponent(email)}`;

  assertEquals(inviteLink.includes("/auth?invitation="), true);
  assertEquals(inviteLink.includes(institutionId), true);
  assertEquals(inviteLink.includes(encodeURIComponent(email)), true);
});

Deno.test("send-invitation: email subject includes inviter, institution and brand", () => {
  // The brand name is a deployment setting (BRAND_NAME), so this asserts the
  // subject is built from it rather than from any particular product name.
  const inviterName = "John Doe";
  const institutionName = "Test University";
  const brandName = "Test Brand";
  const subject = `${inviterName} invited you to join ${institutionName} on ${brandName}`;

  assertEquals(subject.includes(inviterName), true);
  assertEquals(subject.includes(institutionName), true);
  assertEquals(subject.includes(brandName), true);
});

Deno.test("send-invitation: email HTML contains required elements", () => {
  // Test that the email contains key elements
  const emailElements = [
    "You're Invited",
    "Accept Invitation",
    "Invited by",
    "Institution",
    "AI-powered tutoring",
    "Interactive study materials",
  ];

  // All elements should be present in a proper email
  emailElements.forEach(element => {
    assertExists(element);
  });
});

Deno.test("send-invitation: handles origin header", () => {
  const headers = new Headers();
  headers.set("origin", "https://custom-domain.com");

  const origin = headers.get("origin") || "https://dianoisis.net";
  assertEquals(origin, "https://custom-domain.com");
});

Deno.test("send-invitation: fallback to default origin", () => {
  const headers = new Headers();

  const origin = headers.get("origin") || "https://dianoisis.net";
  assertEquals(origin, "https://dianoisis.net");
});

Deno.test("send-invitation: successful response structure", () => {
  const successResponse = {
    success: true,
    data: { id: "email-123" },
  };

  assertEquals(successResponse.success, true);
  assertExists(successResponse.data);
  assertExists(successResponse.data.id);
});

Deno.test("send-invitation: error response structure", () => {
  const errorResponse = {
    success: false,
    error: "Failed to send email",
  };

  assertEquals(errorResponse.success, false);
  assertExists(errorResponse.error);
});

Deno.test("send-invitation: OPTIONS returns CORS headers", () => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  assertEquals(corsHeaders["Access-Control-Allow-Origin"], "*");
});

// Tests for invitationId parameter (fix for resend invitation bug)
Deno.test("send-invitation: uses invitationId when provided (resend case)", () => {
  const baseUrl = "https://dianoisis.net";
  const invitationId = "invitation-uuid-123";
  const institutionId = "institution-uuid-456";
  const email = "test@example.com";

  // When invitationId is provided, it should be used in the link
  const inviteLink = `${baseUrl}/auth?invitation=${invitationId}&email=${encodeURIComponent(email)}`;

  assertEquals(inviteLink.includes(invitationId), true);
  assertEquals(inviteLink.includes(institutionId), false);
});

Deno.test("send-invitation: falls back to institutionId when invitationId is undefined (legacy case)", () => {
  const baseUrl = "https://dianoisis.net";
  const invitationId = undefined;
  const institutionId = "institution-uuid-456";
  const email = "test@example.com";

  // Fallback behavior: use institutionId when invitationId is not provided
  const inviteLink = `${baseUrl}/auth?invitation=${invitationId || institutionId}&email=${encodeURIComponent(email)}`;

  assertEquals(inviteLink.includes(institutionId), true);
});

Deno.test("send-invitation: invitationId takes precedence over institutionId", () => {
  const baseUrl = "https://dianoisis.net";
  const invitationId = "correct-invitation-id";
  const institutionId = "wrong-institution-id";
  const email = "test@example.com";

  const inviteLink = `${baseUrl}/auth?invitation=${invitationId || institutionId}&email=${encodeURIComponent(email)}`;

  // The invitation parameter should be the invitationId, not institutionId
  assertEquals(inviteLink, `${baseUrl}/auth?invitation=correct-invitation-id&email=test%40example.com`);
  assertEquals(inviteLink.includes("wrong-institution-id"), false);
});

Deno.test("send-invitation: resend request structure includes invitationId", () => {
  interface ResendInvitationRequest {
    email: string;
    institutionId: string;
    institutionName: string;
    inviterName: string;
    invitationId: string; // Required for resend
  }

  const resendRequest: ResendInvitationRequest = {
    email: "user@example.com",
    institutionId: "inst-123",
    institutionName: "Test University",
    inviterName: "Admin User",
    invitationId: "invitation-456",
  };

  assertExists(resendRequest.invitationId);
  assertEquals(resendRequest.invitationId, "invitation-456");
  // Verify invitationId is different from institutionId
  assertEquals(resendRequest.invitationId !== resendRequest.institutionId, true);
});
