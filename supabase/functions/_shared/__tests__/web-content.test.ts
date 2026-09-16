import { assertEquals, assertThrows } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { assertPublicHttpUrl } from "../web-content.ts";
import { ContentImportError } from "../import-provider.ts";

Deno.test("assertPublicHttpUrl: accepts an ordinary public page", () => {
  assertEquals(
    assertPublicHttpUrl("https://en.wikipedia.org/wiki/French_Revolution").hostname,
    "en.wikipedia.org",
  );
  assertEquals(assertPublicHttpUrl("http://example.com/a?b=c").protocol, "http:");
});

Deno.test("assertPublicHttpUrl: refuses anything that points inside a network", () => {
  // The provider does the fetching now, so these are no longer reachable from
  // our runtime — but each is still a link somebody could paste, and naming the
  // mistake here beats spending a provider credit to have it fail.
  const refused = [
    "http://localhost/",
    "http://LOCALHOST:8000/",
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://metadata.google.internal/",
    "http://0.0.0.0/",
    "http://100.64.0.1/", // carrier-grade NAT
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:169.254.169.254]/", // IPv4-mapped metadata address
    "http://something.local/",
    "http://build.internal/",
    "http://user:pass@example.com/",
    "file:///etc/passwd",
    "ftp://example.com/",
    "not a url",
  ];

  for (const url of refused) {
    assertThrows(
      () => assertPublicHttpUrl(url),
      ContentImportError,
      undefined,
      `should have refused ${url}`,
    );
  }
});
