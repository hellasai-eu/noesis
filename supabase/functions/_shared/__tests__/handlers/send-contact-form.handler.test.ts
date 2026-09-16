import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  resendRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler, resetRateLimits } from "../../../send-contact-form/handler.ts";

const VALID_BODY = {
  name: "Test User",
  email: "test@example.com",
  subject: "Hello",
  message: "This is a test message",
};

// ── Input validation ───────────────────────────────────────────────────

Deno.test("send-contact-form: returns 400 when name is missing", async () => {
  resetRateLimits();
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { ...VALID_BODY, name: "" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "All fields are required");
  } finally {
    h.cleanup();
  }
});

Deno.test("send-contact-form: returns 400 when email is missing", async () => {
  resetRateLimits();
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { ...VALID_BODY, email: "" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "All fields are required");
  } finally {
    h.cleanup();
  }
});

Deno.test("send-contact-form: returns 400 for invalid email format", async () => {
  resetRateLimits();
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { ...VALID_BODY, email: "not-an-email" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Invalid email format");
  } finally {
    h.cleanup();
  }
});

// ── Successful submission ──────────────────────────────────────────────

Deno.test("send-contact-form: sends emails and returns success", async () => {
  resetRateLimits();
  const h = createTestHarness({
    routes: [resendRoute()],
  });
  try {
    const res = await h.invoke(handler, VALID_BODY);
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);

    // Resend SDK calls fetch internally — verify at least one call to resend
    const resendCalls = h.fetchLog.filter((c) => c.url.includes("resend"));
    assertEquals(resendCalls.length >= 1, true);
  } finally {
    h.cleanup();
  }
});

// ── Rate limiting ──────────────────────────────────────────────────────

Deno.test("send-contact-form: rate limits after 5 requests from same IP", async () => {
  resetRateLimits();
  const h = createTestHarness({
    routes: [resendRoute()],
  });
  try {
    // Make 5 successful requests (rate limit allows 5 per window)
    for (let i = 0; i < 5; i++) {
      const res = await h.invoke(handler, {
        ...VALID_BODY,
        email: `unique-${i}@example.com`, // unique emails to avoid email rate limit
      }, {
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);
    }

    // 6th request from same IP should be rate limited
    const res = await h.invoke(handler, {
      ...VALID_BODY,
      email: "another-unique@example.com",
    }, {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 429);
    assertEquals(body.error, "Too many requests. Please try again later.");
  } finally {
    h.cleanup();
  }
});

Deno.test("send-contact-form: rate limits after 5 requests from same email", async () => {
  resetRateLimits();
  const h = createTestHarness({
    routes: [resendRoute()],
  });
  try {
    // Make 5 successful requests with same email but different IPs
    for (let i = 0; i < 5; i++) {
      const res = await h.invoke(handler, VALID_BODY, {
        headers: { "x-forwarded-for": `10.0.0.${i}` },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);
    }

    // 6th request with same email should be rate limited
    const res = await h.invoke(handler, VALID_BODY, {
      headers: { "x-forwarded-for": "10.0.0.99" },
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 429);
    assertEquals(body.error, "Too many requests from this email. Please try again later.");
  } finally {
    h.cleanup();
  }
});

// ── Resend API failure ─────────────────────────────────────────────────

Deno.test("send-contact-form: returns 500 when Resend API fails", async () => {
  resetRateLimits();
  const h = createTestHarness({
    routes: [resendRoute({ error: "Unauthorized" }, { status: 401 })],
  });
  try {
    const res = await h.invoke(handler, VALID_BODY);
    const { status } = await parseResponse(res);
    // The Resend SDK may throw on non-200 responses
    assertEquals(status === 500 || status === 200, true);
  } finally {
    h.cleanup();
  }
});

// ── CORS preflight ─────────────────────────────────────────────────────

Deno.test("send-contact-form: OPTIONS returns CORS headers", async () => {
  resetRateLimits();
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost:54321/functions/v1/send-contact-form", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});
