import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler as deleteFromOpenai } from "../../../delete-from-openai/handler.ts";
import { handler as uploadToOpenai } from "../../../upload-to-openai/handler.ts";
import { handler as manageVectorStore } from "../../../manage-vector-store/handler.ts";

// ── Vector-store handlers (#1135) ──────────────────────────────────────
// The last of Gap A. All three acted on an institution's OpenAI vector store
// using ids from the request body. `delete-from-openai` and `upload-to-openai`
// established no caller identity at all; `manage-vector-store` checked
// `is_super_admin` against a body-supplied `userId`, which authorizes nothing
// because the caller picks the id being checked.

const CALLER_ID = "99999999-9999-9999-9999-999999999999";
const SUPER_ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const INSTITUTION_ID = "22222222-2222-2222-2222-222222222222";
const MATERIAL_ID = "66666666-6666-6666-6666-666666666666";
const OPENAI_FILE_ID = "file-abc123";
const OWN_FILE_PATH = `${COURSE_ID}/1700000000-textbook.pdf`;
const AUTH = { Authorization: "Bearer test-token" };

function authUserRoute(user: unknown, status = 200): MockRoute {
  return {
    match: (url) => url.includes("/auth/v1/user"),
    respond: () =>
      new Response(JSON.stringify(user), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function materialRoute(courseId: string | null): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/course_materials") && (init?.method ?? "GET") === "GET",
    respond: () =>
      new Response(
        JSON.stringify(
          courseId
            ? {
              course_id: courseId,
              title: "Textbook",
              file_url: OWN_FILE_PATH,
              openai_file_id: OPENAI_FILE_ID,
            }
            : null,
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

const COURSE_ROUTE: MockRoute = {
  match: (url, init) => url.includes("/rest/v1/courses") && (init?.method ?? "GET") === "GET",
  respond: () =>
    new Response(JSON.stringify({ id: COURSE_ID, title: "Biology", institution_id: INSTITUTION_ID }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

function institutionAdminRoute(allow: boolean): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/rpc/is_institution_admin"),
    respond: () =>
      new Response(JSON.stringify(allow), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function superAdminRoute(allow: boolean): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/rpc/is_super_admin"),
    respond: () =>
      new Response(JSON.stringify(allow), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const MEMBERSHIP_NONE: MockRoute = {
  match: (url, init) =>
    url.includes("/rest/v1/user_institutions") && (init?.method ?? "GET") === "GET",
  respond: () =>
    new Response(JSON.stringify(null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

const INSTRUCTOR_NONE: MockRoute = {
  match: (url, init) =>
    url.includes("/rest/v1/course_instructors") && (init?.method ?? "GET") === "GET",
  respond: () =>
    new Response(JSON.stringify(null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

/** Did anything reach OpenAI? */
function touchedOpenAI(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) => c.url.includes("api.openai.com"));
}

function managerRoutes(courseId: string = COURSE_ID): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
    materialRoute(courseId),
    COURSE_ROUTE,
    institutionAdminRoute(true),
  ];
}

function outsiderRoutes(courseId: string = COURSE_ID): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "outsider@elsewhere.test" }),
    materialRoute(courseId),
    COURSE_ROUTE,
    institutionAdminRoute(false),
    MEMBERSHIP_NONE,
    INSTRUCTOR_NONE,
  ];
}

// ── delete-from-openai ─────────────────────────────────────────────────

Deno.test("delete-from-openai: 401 without an Authorization header, and deletes nothing", async () => {
  const h = createTestHarness({ routes: managerRoutes() });
  try {
    const res = await h.invoke(deleteFromOpenai, {
      openaiFileId: OPENAI_FILE_ID,
      courseId: COURSE_ID,
    });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("delete-from-openai: 403 for a caller who does not manage the owning course", async () => {
  const h = createTestHarness({ routes: outsiderRoutes() });
  try {
    const res = await h.invoke(deleteFromOpenai, {
      openaiFileId: OPENAI_FILE_ID,
      courseId: COURSE_ID,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("delete-from-openai: 404 when no material owns the file, and deletes nothing", async () => {
  // A file we cannot attribute to a course is one we decline to delete.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(null),
      COURSE_ROUTE,
      institutionAdminRoute(true),
    ],
  });
  try {
    const res = await h.invoke(deleteFromOpenai, {
      openaiFileId: "file-someone-elses",
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 404);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

// ── upload-to-openai ───────────────────────────────────────────────────

Deno.test("upload-to-openai: 401 without an Authorization header", async () => {
  const h = createTestHarness({ routes: managerRoutes() });
  try {
    const res = await h.invoke(uploadToOpenai, {
      materialId: MATERIAL_ID,
      filePath: `${COURSE_ID}/textbook.pdf`,
      fileName: "textbook.pdf",
    });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("upload-to-openai: 403 for a caller who does not manage the material's course", async () => {
  const h = createTestHarness({ routes: outsiderRoutes() });
  try {
    const res = await h.invoke(uploadToOpenai, {
      materialId: MATERIAL_ID,
      filePath: `${COURSE_ID}/textbook.pdf`,
      fileName: "textbook.pdf",
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("upload-to-openai: the material's course wins over a body courseId", async () => {
  // The original code did the opposite — `if (!effectiveCourseId)` meant a body
  // `courseId` overrode the row's. Naming a course you manage while pointing at
  // someone else's material was enough.
  const OTHER_COURSE = "44444444-4444-4444-4444-444444444444";
  const h = createTestHarness({ routes: outsiderRoutes(OTHER_COURSE) });
  try {
    const res = await h.invoke(uploadToOpenai, {
      materialId: MATERIAL_ID,
      filePath: `${OTHER_COURSE}/textbook.pdf`,
      fileName: "textbook.pdf",
      courseId: COURSE_ID, // a course the caller may well manage
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("upload-to-openai: a filePath outside the named course's prefix is refused", async () => {
  // The fresh-upload path has no material row yet, so the course comes from the
  // body — which is only safe while the file is bound to that same course.
  const h = createTestHarness({ routes: managerRoutes() });
  try {
    const res = await h.invoke(uploadToOpenai, {
      filePath: "44444444-4444-4444-4444-444444444444/someone-elses.pdf",
      fileName: "someone-elses.pdf",
      courseId: COURSE_ID,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("upload-to-openai: add-to-vector-store is gated too", async () => {
  // This action returns early, so it needed the gate placed above the branch.
  const h = createTestHarness({ routes: outsiderRoutes() });
  try {
    const res = await h.invoke(uploadToOpenai, {
      action: "add-to-vector-store",
      openaiFileId: OPENAI_FILE_ID,
      vectorStoreId: "vs_abc",
      materialId: MATERIAL_ID,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

// ── manage-vector-store ────────────────────────────────────────────────

Deno.test("manage-vector-store: 401 without an Authorization header", async () => {
  const h = createTestHarness({
    routes: [authUserRoute({ id: CALLER_ID }), COURSE_ROUTE, institutionAdminRoute(true)],
  });
  try {
    const res = await h.invoke(manageVectorStore, {
      action: "create",
      institutionId: INSTITUTION_ID,
      institutionName: "Test School",
    });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("manage-vector-store: a forged body userId no longer authorizes resync-metadata", async () => {
  // The whole finding: `is_super_admin` was checked against the body's `userId`.
  // Sending a known super-admin's id passed the gate. The RPC now receives the
  // token's user, who here is not a super-admin.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "nobody@elsewhere.test" }),
      superAdminRoute(false),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      MEMBERSHIP_NONE,
    ],
  });
  try {
    const res = await h.invoke(manageVectorStore, {
      action: "resync-metadata",
      courseId: COURSE_ID,
      userId: SUPER_ADMIN_ID, // the forgery the old code accepted
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Only super admins can resync metadata");
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("manage-vector-store: the super-admin check is made against the token's user", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: SUPER_ADMIN_ID, email: "root@platform.test" }),
      superAdminRoute(true),
      COURSE_ROUTE,
      institutionAdminRoute(true),
    ],
  });
  try {
    await h.invoke(manageVectorStore, {
      action: "resync-metadata",
      courseId: COURSE_ID,
      userId: "someone-else-entirely",
    }, { headers: AUTH });

    const rpc = h.fetchLog.find((c) => c.url.includes("/rest/v1/rpc/is_super_admin"));
    assertEquals(rpc?.body?.includes(SUPER_ADMIN_ID), true);
    assertEquals(rpc?.body?.includes("someone-else-entirely"), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("manage-vector-store: 403 for a non-admin of the named institution", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "outsider@elsewhere.test" }),
      superAdminRoute(false),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      MEMBERSHIP_NONE,
    ],
  });
  try {
    const res = await h.invoke(manageVectorStore, {
      action: "delete",
      institutionId: INSTITUTION_ID,
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Not authorized for this institution");
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("manage-vector-store: bulk-sync-files is gated on the institution too", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "outsider@elsewhere.test" }),
      superAdminRoute(false),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      MEMBERSHIP_NONE,
    ],
  });
  try {
    const res = await h.invoke(manageVectorStore, {
      action: "bulk-sync-files",
      institutionId: INSTITUTION_ID,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});


// ── The destination store is not caller-chosen (greptile, #1151) ───────

Deno.test("upload-to-openai: add-to-vector-store writes to the material's own store, not the body's", async () => {
  // Gating the caller on the material's course leaves the *target* open: an
  // authorized manager could push their own material into another
  // institution's index. The store is now derived from the owning course's
  // institution, and the body value is ignored.
  const OWN_STORE = "vs_owned_by_this_institution";
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(true),
      {
        match: (url) => url.includes("/rest/v1/institutions"),
        respond: () =>
          new Response(JSON.stringify({ vector_store_id: OWN_STORE }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("api.openai.com") && url.includes("/vector_stores/"),
        respond: () =>
          new Response(JSON.stringify({ status: "completed" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    await h.invoke(uploadToOpenai, {
      action: "add-to-vector-store",
      openaiFileId: OPENAI_FILE_ID,
      vectorStoreId: "vs_another_institution", // the redirection attempt
      materialId: MATERIAL_ID,
    }, { headers: AUTH });

    const call = h.fetchLog.find(
      (c) => c.url.includes("api.openai.com") && c.url.includes("/vector_stores/"),
    );
    assertEquals(call?.url.includes(OWN_STORE), true);
    assertEquals(call?.url.includes("vs_another_institution"), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("upload-to-openai: 400 when the owning institution has no vector store", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(true),
      {
        match: (url) => url.includes("/rest/v1/institutions"),
        respond: () =>
          new Response(JSON.stringify({ vector_store_id: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    const res = await h.invoke(uploadToOpenai, {
      action: "add-to-vector-store",
      openaiFileId: OPENAI_FILE_ID,
      vectorStoreId: "vs_another_institution",
      materialId: MATERIAL_ID,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});


Deno.test("upload-to-openai: the upload reads the material's own path, not the body's", async () => {
  // Third instance of the same shape in this handler: authorize on the
  // material's course, then act on an id the caller supplied. Here it is the
  // source — a manager could attach any course's PDF to a material they own.
  const OWN_STORE = "vs_owned_by_this_institution";
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(true),
      {
        match: (url) => url.includes("/rest/v1/institutions"),
        respond: () =>
          new Response(JSON.stringify({ vector_store_id: OWN_STORE }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("/storage/v1/"),
        respond: () =>
          new Response("%PDF-1.4 fake", {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          }),
      },
      {
        match: (url) => url.includes("api.openai.com"),
        respond: () =>
          new Response(JSON.stringify({ id: "file-new", filename: "textbook.pdf", bytes: 12 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    await h.invoke(uploadToOpenai, {
      materialId: MATERIAL_ID,
      filePath: "44444444-4444-4444-4444-444444444444/someone-elses.pdf",
      fileName: "someone-elses.pdf",
    }, { headers: AUTH });

    const download = h.fetchLog.find((c) => c.url.includes("/storage/v1/"));
    assertEquals(download?.url.includes("1700000000-textbook.pdf"), true);
    assertEquals(download?.url.includes("someone-elses.pdf"), false);
  } finally {
    h.cleanup();
  }
});


Deno.test("delete-from-openai: detaches from the material's own store, not the body's", async () => {
  // The resolution chain was `vectorStoreId` -> `institutionId` -> `courseId`,
  // every link caller-supplied. Authorizing on the material that owns the file
  // and then detaching from a store the caller names would let an authorized
  // manager evict a file from any institution's index.
  const OWN_STORE = "vs_owned_by_this_institution";
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(true),
      {
        match: (url) => url.includes("/rest/v1/institutions"),
        respond: () =>
          new Response(JSON.stringify({ vector_store_id: OWN_STORE }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("api.openai.com"),
        respond: () =>
          new Response(JSON.stringify({ deleted: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    await h.invoke(deleteFromOpenai, {
      openaiFileId: OPENAI_FILE_ID,
      vectorStoreId: "vs_another_institution", // the redirection attempt
      institutionId: "another-institution",
      courseId: "another-course",
    }, { headers: AUTH });

    const detach = h.fetchLog.find(
      (c) => c.url.includes("api.openai.com") && c.url.includes("/vector_stores/"),
    );
    assertEquals(detach?.url.includes(OWN_STORE), true);
    assertEquals(detach?.url.includes("vs_another_institution"), false);
  } finally {
    h.cleanup();
  }
});


Deno.test("delete-from-openai: a store lookup failure aborts before deleting anything", async () => {
  // The store is now the only source for the detach target, so swallowing a
  // lookup error would skip the detach and still delete the file from OpenAI
  // globally — leaving the store pointing at a file that no longer exists.
  // A resolution failure is retryable; a half-done delete is not.
  let courseLookups = 0;
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(COURSE_ID),
      institutionAdminRoute(true),
      {
        // Both course lookups select `institution_id`, so they cannot be told
        // apart by URL. The authorization one comes first and succeeds; the
        // store lookup right after it does not.
        match: (url, init) =>
          url.includes("/rest/v1/courses") && (init?.method ?? "GET") === "GET",
        respond: () => {
          courseLookups++;
          return courseLookups === 1
            ? new Response(JSON.stringify({ institution_id: INSTITUTION_ID }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
            : new Response(JSON.stringify({ message: "connection reset" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
        },
      },
    ],
  });
  try {
    const res = await h.invoke(deleteFromOpenai, {
      openaiFileId: OPENAI_FILE_ID,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(touchedOpenAI(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});


Deno.test("delete-from-openai: a failed detach stops the global delete", async () => {
  // Deleting the file from OpenAI after a detach that may not have taken would
  // strand the attachment. Only a 404 is safe to continue past, because it
  // means the attachment is already gone.
  const OWN_STORE = "vs_owned_by_this_institution";
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(true),
      {
        match: (url) => url.includes("/rest/v1/institutions"),
        respond: () =>
          new Response(JSON.stringify({ vector_store_id: OWN_STORE }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("api.openai.com") && url.includes("/vector_stores/"),
        respond: () =>
          new Response(JSON.stringify({ error: "upstream unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("api.openai.com") && url.includes("/files/"),
        respond: () =>
          new Response(JSON.stringify({ deleted: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    const res = await h.invoke(deleteFromOpenai, {
      openaiFileId: OPENAI_FILE_ID,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 502);

    // The file itself must not have been deleted.
    const fileDelete = h.fetchLog.find(
      (c) =>
        c.url.includes("api.openai.com/v1/files/") && c.method === "DELETE",
    );
    assertEquals(fileDelete, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("delete-from-openai: a 404 from the detach is safe to continue past", async () => {
  // Already gone is not a failure — the attachment cannot be stranded.
  const OWN_STORE = "vs_owned_by_this_institution";
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(true),
      {
        match: (url) => url.includes("/rest/v1/institutions"),
        respond: () =>
          new Response(JSON.stringify({ vector_store_id: OWN_STORE }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("api.openai.com") && url.includes("/vector_stores/"),
        respond: () =>
          new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("api.openai.com") && url.includes("/files/"),
        respond: () =>
          new Response(JSON.stringify({ deleted: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    const res = await h.invoke(deleteFromOpenai, {
      openaiFileId: OPENAI_FILE_ID,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 200);

    const fileDelete = h.fetchLog.find(
      (c) => c.url.includes("api.openai.com/v1/files/") && c.method === "DELETE",
    );
    assertEquals(fileDelete !== undefined, true);
  } finally {
    h.cleanup();
  }
});
