import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import { edgeBrand, emailFooterText, monogram } from "../brand.ts";

/**
 * The backend half of the deployment overlay (`_shared/brand.ts`).
 *
 * Two things here are load-bearing rather than cosmetic, and both are the
 * reason this file exists:
 *
 *   1. A missing sending address must yield `null`, not a guess. Every caller
 *      treats `null` as "do not send", so a fallback invented here would mail
 *      people as somebody else's domain.
 *   2. `BRAND_APP_URL` becomes an `href` in a security email. It is
 *      operator-set, so it is trusted where `Origin` is not — but "trusted"
 *      still means scheme-checked, because `javascript:` parses as a URL.
 */

/** Set env for one case and restore whatever was there. */
function withEnv(vars: Record<string, string | null>, run: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, Deno.env.get(key));
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === null) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const UNSET: Record<string, string | null> = {
  BRAND_NAME: null,
  BRAND_TAGLINE: null,
  BRAND_FROM_EMAIL: null,
  BRAND_CONTACT_EMAIL: null,
  BRAND_APP_URL: null,
  BRAND_TUTOR_NAME: null,
};

Deno.test("edgeBrand: an unconfigured deployment gets a neutral name and no addresses", () => {
  withEnv(UNSET, () => {
    const brand = edgeBrand();
    assertEquals(brand.name, "Study Platform");
    // The important nulls: no address means no mail, not mail from a
    // hardcoded domain.
    assertEquals(brand.from, null);
    assertEquals(brand.contactRecipient, null);
    assertEquals(brand.appUrl, null);
    assertEquals(brand.signInUrl, null);
    assertEquals(brand.tagline, null);
  });
});

Deno.test("edgeBrand: reads the configured identity", () => {
  withEnv(
    {
      ...UNSET,
      BRAND_NAME: "Acme Learn",
      BRAND_TAGLINE: "Learning, for Acme schools.",
      BRAND_FROM_EMAIL: "no-reply@acme.example",
      BRAND_CONTACT_EMAIL: "hello@acme.example",
      BRAND_APP_URL: "https://learn.acme.example",
    },
    () => {
      const brand = edgeBrand();
      assertEquals(brand.name, "Acme Learn");
      assertEquals(brand.from, "Acme Learn <no-reply@acme.example>");
      assertEquals(brand.contactRecipient, "hello@acme.example");
      assertEquals(brand.appUrl, "https://learn.acme.example");
      assertEquals(brand.signInUrl, "https://learn.acme.example/auth");
      assertEquals(brand.tutorName, "Acme Learn Tutor");
    },
  );
});

Deno.test("edgeBrand: an empty or blank variable counts as unset", () => {
  // Supabase secrets and CI both make it easy to set a variable to "".
  // Treating that as a value would produce `from: " <addr>"` and a tagline
  // that renders as a blank line.
  withEnv({ ...UNSET, BRAND_NAME: "   ", BRAND_TAGLINE: "" }, () => {
    const brand = edgeBrand();
    assertEquals(brand.name, "Study Platform");
    assertEquals(brand.tagline, null);
  });
});

Deno.test("edgeBrand: the from header is stripped of characters that would break it", () => {
  // `Name <addr>` is a structured header. A comma in the display name would
  // read as a second recipient, and an angle bracket as a second address.
  withEnv(
    {
      ...UNSET,
      BRAND_NAME: 'Acme, Inc <evil@attacker.test>',
      BRAND_FROM_EMAIL: "no-reply@acme.example",
    },
    () => {
      const brand = edgeBrand();
      assertEquals(brand.from, "Acme Inc evil@attacker.test <no-reply@acme.example>");
      // Exactly one address delimiter pair survives.
      assertEquals((brand.from!.match(/</g) ?? []).length, 1);
      assertEquals((brand.from!.match(/,/g) ?? []).length, 0);
    },
  );
});

Deno.test("edgeBrand: rejects a non-http app URL rather than linking to it", () => {
  // The value becomes an href in an email people are primed to click.
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "not a url",
    "/auth",
  ]) {
    withEnv({ ...UNSET, BRAND_APP_URL: bad }, () => {
      const brand = edgeBrand();
      assertEquals(brand.appUrl, null, `expected ${bad} to be rejected`);
      assertEquals(brand.signInUrl, null, `expected ${bad} to yield no link`);
    });
  }
});

Deno.test("edgeBrand: normalises a trailing slash so links do not double up", () => {
  withEnv({ ...UNSET, BRAND_APP_URL: "https://learn.acme.example/" }, () => {
    assertEquals(edgeBrand().signInUrl, "https://learn.acme.example/auth");
  });
});

Deno.test("edgeBrand: keeps a path prefix, for an app served under a subpath", () => {
  withEnv({ ...UNSET, BRAND_APP_URL: "https://acme.example/learn" }, () => {
    assertEquals(edgeBrand().signInUrl, "https://acme.example/learn/auth");
  });
});

Deno.test("edgeBrand: the tutor name can be set independently of the brand", () => {
  withEnv({ ...UNSET, BRAND_NAME: "Acme Learn", BRAND_TUTOR_NAME: "Sokrates" }, () => {
    assertEquals(edgeBrand().tutorName, "Sokrates");
  });
});

Deno.test("emailFooterText: omits a tagline that was never configured", () => {
  withEnv({ ...UNSET, BRAND_NAME: "Acme Learn" }, () => {
    const footer = emailFooterText();
    assertStringIncludes(footer, "Acme Learn");
    assertStringIncludes(footer, String(new Date().getFullYear()));
    // No trailing orphan from a missing slogan.
    assertEquals(footer.endsWith("Acme Learn."), true);
  });
});

Deno.test("emailFooterText: includes the tagline when there is one", () => {
  withEnv({ ...UNSET, BRAND_NAME: "Acme", BRAND_TAGLINE: "For our schools." }, () => {
    assertEquals(emailFooterText(), `© ${new Date().getFullYear()} Acme. For our schools.`);
  });
});

Deno.test("monogram: the brand's own initial, not a fixed glyph", () => {
  assertEquals(monogram("Acme Learn"), "A");
  assertEquals(monogram("noesis"), "N");
  // Non-Latin scripts have to work: the platform's own users are Greek.
  assertEquals(monogram("Νόησις"), "Ν");
  // Never empty — an empty tile looks like a broken image.
  assertEquals(monogram(""), "·");
  assertEquals(monogram("   "), "·");
});
