// Tests for the record-login-attempt handler.
//
// The two properties that matter here are (1) a failed sign-in actually
// produces a `failed_login_attempts` row with a SERVER-observed IP, and (2) the
// endpoint is not a user-enumeration oracle — it must answer identically for an
// address that exists, one that does not, and one where the write failed.

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, type MockRoute } from "./handler-harness.ts";
import { handler, resetRateLimits } from "../../record-login-attempt/handler.ts";

// ── Route helpers ──────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** profiles lookup — `data` null models an address with no account. */
function profilesRoute(data: unknown, status = 200): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/profiles"),
    respond: () => json(data, status),
  };
}

function institutionsRoute(data: unknown): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/user_institutions"),
    respond: () => json(data),
  };
}

function insertRoute(status = 201): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/failed_login_attempts") && init?.method === "POST",
    respond: () => (status >= 400 ? json({ message: "insert boom" }, status) : json([], status)),
  };
}

function insertBodies(harness: { fetchLog: Array<{ url: string; method: string; body?: string }> }) {
  return harness.fetchLog
    .filter((e) => e.url.includes("failed_login_attempts") && e.method === "POST")
    .map((e) => JSON.parse(e.body ?? "{}"));
}

const CLIENT_IP_HEADERS = { "x-forwarded-for": "203.0.113.9, 70.41.3.18", "user-agent": "TestAgent/1.0" };

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test("record-login-attempt: writes a row attributed to the matching account", async () => {
  resetRateLimits();
  const harness = createTestHarness({
    routes: [
      profilesRoute({ user_id: "user-1" }),
      institutionsRoute({ institution_id: "inst-1" }),
      insertRoute(),
    ],
  });
  try {
    const res = await harness.invoke(
      handler,
      { email: "Student@School.GR", reason: "invalid_credentials" },
      { headers: CLIENT_IP_HEADERS },
    );
    assertEquals(res.status, 200);

    const [row] = insertBodies(harness);
    assertEquals(row.user_id, "user-1");
    assertEquals(row.institution_id, "inst-1");
    assertEquals(row.reason, "invalid_credentials");
    // Normalised so "how many failures for this address" groups correctly.
    assertEquals(row.email_attempted, "student@school.gr");
    // The RIGHTMOST x-forwarded-for hop — the one our own infrastructure
    // appended. The leftmost is whatever the caller chose to prepend.
    assertEquals(row.ip_address, "70.41.3.18");
    assertEquals(row.user_agent, "TestAgent/1.0");
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: records an unknown address unattributed", async () => {
  resetRateLimits();
  const harness = createTestHarness({
    routes: [profilesRoute(null), insertRoute()],
  });
  try {
    const res = await harness.invoke(
      handler,
      { email: "nobody@example.com", reason: "invalid_credentials" },
      { headers: CLIENT_IP_HEADERS },
    );
    assertEquals(res.status, 200);

    // The row must still be written — an address matching no account is the
    // signal that separates credential stuffing from one user mistyping.
    const [row] = insertBodies(harness);
    assertEquals(row.email_attempted, "nobody@example.com");
    assertEquals(row.user_id, null);
    assertEquals(row.institution_id, null);
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: is not a user-enumeration oracle", async () => {
  const read = async (routes: MockRoute[], email: string) => {
    resetRateLimits();
    const harness = createTestHarness({ routes });
    try {
      const res = await harness.invoke(handler, { email, reason: "invalid_credentials" }, {
        headers: CLIENT_IP_HEADERS,
      });
      return { status: res.status, body: await res.text() };
    } finally {
      harness.cleanup();
    }
  };

  const existing = await read(
    [profilesRoute({ user_id: "user-1" }), institutionsRoute({ institution_id: "inst-1" }), insertRoute()],
    "student@school.gr",
  );
  const unknown = await read([profilesRoute(null), insertRoute()], "nobody@example.com");
  const lookupBroken = await read([profilesRoute({ message: "nope" }, 500), insertRoute()], "x@y.gr");
  const writeBroken = await read([profilesRoute(null), insertRoute(500)], "x@y.gr");

  for (const other of [unknown, lookupBroken, writeBroken]) {
    assertEquals(other.status, existing.status);
    assertEquals(other.body, existing.body);
  }
  assertEquals(existing.body, JSON.stringify({ ok: true }));
});

// Identical status and body are not enough on their own: if only the
// matching-profile branch made the membership round trip, an unauthenticated
// caller could tell a real address from an unknown one by response latency.
// Asserted as query counts rather than wall-clock, which would be flaky.
Deno.test("record-login-attempt: issues the same queries whether or not the account exists", async () => {
  const shape = async (routes: MockRoute[]) => {
    resetRateLimits();
    const harness = createTestHarness({ routes });
    try {
      await harness.invoke(handler, { email: "probe@school.gr", reason: "invalid_credentials" }, {
        headers: CLIENT_IP_HEADERS,
      });
      return harness.fetchLog.map((e) => {
        const path = new URL(e.url).pathname.replace("/rest/v1/", "");
        return `${e.method} ${path}`;
      });
    } finally {
      harness.cleanup();
    }
  };

  const existing = await shape([
    profilesRoute({ user_id: "user-1" }),
    institutionsRoute({ institution_id: "inst-1" }),
    insertRoute(),
  ]);
  const unknown = await shape([profilesRoute(null), institutionsRoute(null), insertRoute()]);

  assertEquals(unknown, existing);
  // Sanity: the membership lookup really did happen in both, so this is not
  // passing because neither branch queries at all.
  assert(existing.some((c) => c.includes("user_institutions")), "no membership lookup was made");
});

Deno.test("record-login-attempt: an unrecognised reason is folded into 'other'", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), insertRoute()] });
  try {
    await harness.invoke(
      handler,
      { email: "a@b.gr", reason: "some_future_gotrue_code" },
      { headers: CLIENT_IP_HEADERS },
    );
    assertEquals(insertBodies(harness)[0].reason, "other");
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: a banned account is recorded as such", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), insertRoute()] });
  try {
    await harness.invoke(handler, { email: "a@b.gr", reason: "user_banned" }, {
      headers: CLIENT_IP_HEADERS,
    });
    assertEquals(insertBodies(harness)[0].reason, "user_banned");
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: writes nothing when no email is supplied", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), insertRoute()] });
  try {
    const res = await harness.invoke(handler, { reason: "invalid_credentials" }, {
      headers: CLIENT_IP_HEADERS,
    });
    assertEquals(res.status, 200);
    assertEquals(insertBodies(harness).length, 0);
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: oversized email is truncated, not stored whole", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), insertRoute()] });
  try {
    await harness.invoke(
      handler,
      { email: "a".repeat(5000) + "@b.gr", reason: "invalid_credentials" },
      { headers: CLIENT_IP_HEADERS },
    );
    assertEquals(insertBodies(harness)[0].email_attempted.length, 320);
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: per-IP cap stops writing but still answers ok", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), insertRoute()] });
  try {
    for (let i = 0; i < 60; i++) {
      const res = await harness.invoke(
        handler,
        { email: `a${i}@b.gr`, reason: "invalid_credentials" },
        { headers: CLIENT_IP_HEADERS },
      );
      assertEquals(res.status, 200);
    }
    // Bounded well below the 60 attempts made, and the cap is per-IP only —
    // it must never be keyed on the email, or a distributed attack on one
    // account would be the case it silences.
    const written = insertBodies(harness).length;
    assertEquals(written, 50);
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: different IPs are capped independently", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), insertRoute()] });
  try {
    for (let i = 0; i < 55; i++) {
      await harness.invoke(handler, { email: "target@school.gr", reason: "invalid_credentials" }, {
        headers: { "x-forwarded-for": "203.0.113.1" },
      });
    }
    // A second IP hitting the SAME address must still get through — this is
    // the distributed-attack case the cap must not hide.
    await harness.invoke(handler, { email: "target@school.gr", reason: "invalid_credentials" }, {
      headers: { "x-forwarded-for": "198.51.100.7" },
    });

    const rows = insertBodies(harness);
    assert(rows.some((r) => r.ip_address === "198.51.100.7"), "second IP was silenced by the cap");
  } finally {
    harness.cleanup();
  }
});

// The per-IP cap is keyed on a request header, and a header is whatever the
// caller says it is. Rotating it must not buy an unlimited number of fresh
// buckets — the isolate-wide cap is the bound that has to hold.
Deno.test("record-login-attempt: rotating x-forwarded-for cannot exceed the global cap", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), institutionsRoute(null), insertRoute()] });
  try {
    // 2000 requests, each claiming a brand-new source address.
    for (let i = 0; i < 2000; i++) {
      const res = await harness.invoke(
        handler,
        { email: `victim@school.gr`, reason: "invalid_credentials" },
        { headers: { "x-forwarded-for": `10.0.${Math.floor(i / 256)}.${i % 256}` } },
      );
      assertEquals(res.status, 200);
    }
    // Bounded by MAX_TOTAL_PER_WINDOW (500), not by 2000 × the per-IP cap.
    const written = insertBodies(harness).length;
    assertEquals(written, 500);
  } finally {
    harness.cleanup();
  }
});

// A caller can prepend anything to x-forwarded-for; only the entries our own
// infrastructure appended are meaningful. Taking the leftmost would let the
// caller choose their own rate-limit bucket and their own recorded address.
Deno.test("record-login-attempt: uses the rightmost x-forwarded-for hop, not the spoofable leftmost", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), institutionsRoute(null), insertRoute()] });
  try {
    await harness.invoke(handler, { email: "a@b.gr", reason: "invalid_credentials" }, {
      headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.9" },
    });
    assertEquals(insertBodies(harness)[0].ip_address, "203.0.113.9");
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: tracked-IP map stays bounded under key rotation", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [profilesRoute(null), institutionsRoute(null), insertRoute()] });
  try {
    for (let i = 0; i < 1500; i++) {
      await harness.invoke(handler, { email: "a@b.gr", reason: "invalid_credentials" }, {
        headers: { "x-forwarded-for": `10.1.${Math.floor(i / 256)}.${i % 256}` },
      });
    }
    // No assertion on the map directly (it is module-private) — the point is
    // that 1500 distinct keys neither throw nor grow without limit, and the
    // global cap still held.
    assert(insertBodies(harness).length <= 500, "global cap did not hold under rotation");
  } finally {
    harness.cleanup();
  }
});

Deno.test("record-login-attempt: OPTIONS returns CORS headers", async () => {
  resetRateLimits();
  const harness = createTestHarness({ routes: [] });
  try {
    const res = await handler(new Request("http://localhost/record-login-attempt", { method: "OPTIONS" }));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    harness.cleanup();
  }
});
