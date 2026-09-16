import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  diagramInstructions,
  parseDiagramMode,
  validateDiagram,
} from "../diagram-mode.ts";

Deno.test("parseDiagramMode defaults unknown/missing input to 'off'", () => {
  assertEquals(parseDiagramMode(undefined), "off");
  assertEquals(parseDiagramMode(null), "off");
  assertEquals(parseDiagramMode("nope"), "off");
  assertEquals(parseDiagramMode(""), "off");
});

Deno.test("parseDiagramMode accepts 'auto' and 'force' verbatim", () => {
  assertEquals(parseDiagramMode("auto"), "auto");
  assertEquals(parseDiagramMode("force"), "force");
});

Deno.test("diagramInstructions: off mode instructs model to set source to empty string", () => {
  const out = diagramInstructions("off");
  assertEquals(out.includes("diagram.source"), true);
  assertEquals(out.includes("empty string"), true);
});

Deno.test("diagramInstructions: auto mode permits but doesn't require diagrams", () => {
  const out = diagramInstructions("auto");
  assertEquals(out.includes("OPTIONAL"), true);
  assertEquals(out.includes("ONLY when"), true);
});

Deno.test("diagramInstructions: force mode requires diagrams on every question", () => {
  const out = diagramInstructions("force");
  assertEquals(out.includes("REQUIRED"), true);
  assertEquals(out.includes("EVERY question"), true);
});

Deno.test("diagramInstructions: auto/force forbid LaTeX inside SVG <text> (#636)", () => {
  for (const mode of ["auto", "force"] as const) {
    const out = diagramInstructions(mode);
    assertEquals(out.includes("PLAIN TEXT"), true, `${mode} mode should require plain text labels`);
    // The directive must explicitly mention that KaTeX doesn't render inside SVG.
    assertEquals(out.includes("KaTeX does not run inside SVG"), true, `${mode} mode missing KaTeX-in-SVG warning`);
  }
});

Deno.test("diagramInstructions: auto/force include label-spacing / anti-overlap guidance (#646)", () => {
  for (const mode of ["auto", "force"] as const) {
    const out = diagramInstructions(mode);
    // A dedicated LABEL SPACING section must exist.
    assertEquals(
      out.includes("LABEL SPACING"),
      true,
      `${mode} mode missing LABEL SPACING section`,
    );
    // Short labels / abbreviation guidance.
    assertEquals(
      out.toLowerCase().includes("abbreviate"),
      true,
      `${mode} mode missing abbreviation guidance`,
    );
    // text-anchor guidance — without it, long labels run rightward off their x.
    assertEquals(
      out.includes("text-anchor"),
      true,
      `${mode} mode missing text-anchor guidance`,
    );
    // Lane / stacking guidance so labels close in x land on different y rows.
    assertEquals(
      out.toLowerCase().includes("lane"),
      true,
      `${mode} mode missing lane / y-row guidance`,
    );
    // Explicit minimum-gap rule so the model has a concrete number to follow.
    assertEquals(
      /minimum.*gap/i.test(out),
      true,
      `${mode} mode missing explicit minimum-gap rule`,
    );
  }
});

Deno.test("validateDiagram accepts a well-formed minimal SVG", () => {
  const result = validateDiagram({
    format: "svg",
    source: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
    alt: "small dot",
  });
  assertEquals(result?.alt, "small dot");
  assertEquals(result?.source.startsWith("<svg"), true);
});

Deno.test("validateDiagram drops the alt when empty", () => {
  const result = validateDiagram({
    format: "svg",
    source: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
    alt: "",
  });
  assertEquals(result?.alt, undefined);
});

Deno.test("validateDiagram rejects malformed / dangerous inputs", () => {
  // missing object
  assertEquals(validateDiagram(null), null);
  assertEquals(validateDiagram(undefined), null);
  // wrong format
  assertEquals(
    validateDiagram({ format: "png", source: '<svg xmlns="http://www.w3.org/2000/svg"/>' }),
    null,
  );
  // non-string source
  assertEquals(validateDiagram({ format: "svg", source: 42 as unknown as string }), null);
  // empty source
  assertEquals(validateDiagram({ format: "svg", source: "" }), null);
  // no svg root
  assertEquals(validateDiagram({ format: "svg", source: "<div/>" }), null);
  // <script>
  assertEquals(
    validateDiagram({ format: "svg", source: "<svg><script>alert(1)</script></svg>" }),
    null,
  );
  // <foreignObject>
  assertEquals(
    validateDiagram({ format: "svg", source: "<svg><foreignObject></foreignObject></svg>" }),
    null,
  );
  // event handler
  assertEquals(
    validateDiagram({ format: "svg", source: '<svg onload="alert(1)"></svg>' }),
    null,
  );
  // javascript: URL
  assertEquals(
    validateDiagram({ format: "svg", source: '<svg><a href="javascript:1"/></svg>' }),
    null,
  );
});

Deno.test("validateDiagram rejects oversize input", () => {
  const huge = '<svg xmlns="http://www.w3.org/2000/svg">' + "a".repeat(50_001) + "</svg>";
  assertEquals(validateDiagram({ format: "svg", source: huge }), null);
});
