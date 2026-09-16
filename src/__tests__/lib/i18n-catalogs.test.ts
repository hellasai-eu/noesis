/**
 * Catalog parity.
 *
 * A missing key does not throw at runtime — i18next silently falls back to
 * English — so a half-translated release looks fine in review and reads as a
 * language salad in production. That is exactly the failure this codebase
 * already has (English admin chrome next to Greek student chrome), so the
 * guard against reintroducing it belongs in CI, not in a reviewer's eyes.
 */
import { describe, it, expect } from "vitest";

import { NAMESPACES, SUPPORTED_LOCALES } from "@/i18n/config";
import enCommon from "@/i18n/locales/en/common.json";
import enEvaluator from "@/i18n/locales/en/evaluator.json";
import elCommon from "@/i18n/locales/el/common.json";
import elEvaluator from "@/i18n/locales/el/evaluator.json";
import enStudent from "@/i18n/locales/en/student.json";
import elStudent from "@/i18n/locales/el/student.json";
import enQuiz from "@/i18n/locales/en/quiz.json";
import elQuiz from "@/i18n/locales/el/quiz.json";
import enStudyGuide from "@/i18n/locales/en/study-guide.json";
import elStudyGuide from "@/i18n/locales/el/study-guide.json";
import enPractice from "@/i18n/locales/en/practice.json";
import elPractice from "@/i18n/locales/el/practice.json";
import enStudy from "@/i18n/locales/en/study.json";
import elStudy from "@/i18n/locales/el/study.json";

type Catalog = Record<string, unknown>;

const catalogs: Record<string, Record<string, Catalog>> = {
  en: {
    common: enCommon,
    evaluator: enEvaluator,
    student: enStudent,
    quiz: enQuiz,
    studyGuide: enStudyGuide,
    practice: enPractice,
    study: enStudy,
  },
  el: {
    common: elCommon,
    evaluator: elEvaluator,
    student: elStudent,
    quiz: elQuiz,
    studyGuide: elStudyGuide,
    practice: elPractice,
    study: elStudy,
  },
};

/** Flatten to dotted leaf paths, so nesting differences surface as key diffs. */
function leafKeys(value: Catalog, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child !== null && typeof child === "object" && !Array.isArray(child)
      ? leafKeys(child as Catalog, path)
      : [path];
  });
}

/** `{{name}}` placeholders a message expects. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
}

/**
 * `<1>…</1>` component slots a `<Trans>` message expects.
 *
 * A translation that drops one renders the tag as literal text on the page; one
 * that keeps an opening tag without its closing partner throws. Neither shows up
 * as a missing key, so parity has to be checked here.
 */
function transTags(message: string): string[] {
  return [...message.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort();
}

describe("translation catalogs", () => {
  it("declares a catalog for every supported locale and namespace", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const namespace of NAMESPACES) {
        expect(catalogs[locale]?.[namespace], `${locale}/${namespace}`).toBeDefined();
      }
    }
  });

  for (const namespace of NAMESPACES) {
    describe(`${namespace}`, () => {
      // `catalogs` above is hand-maintained while this loop is driven by
      // NAMESPACES, so a namespace added to config.ts and not here would other-
      // wise crash collection with "Cannot convert undefined or null to object"
      // instead of naming the missing catalog.
      const reference = catalogs.en[namespace];
      const referenceKeys = reference ? leafKeys(reference).sort() : [];

      it("has an en catalog", () => {
        expect(reference, `missing src/i18n/locales/en/${namespace}.json`).toBeDefined();
      });

      it("has no empty English message", () => {
        for (const key of referenceKeys) {
          expect(resolve(catalogs.en[namespace], key), key).not.toBe("");
        }
      });

      for (const locale of SUPPORTED_LOCALES.filter((l) => l !== "en")) {
        it(`${locale} has exactly the same keys as en`, () => {
          expect(leafKeys(catalogs[locale][namespace]).sort()).toEqual(referenceKeys);
        });

        it(`${locale} uses the same interpolation placeholders as en`, () => {
          // A translator dropping `{{total}}` produces "Question 3 of " with no
          // error anywhere — only a visibly truncated string in production.
          for (const key of referenceKeys) {
            const source = resolve(catalogs.en[namespace], key);
            const target = resolve(catalogs[locale][namespace], key);
            expect(placeholders(target), `${locale}/${namespace}:${key}`).toEqual(
              placeholders(source)
            );
          }
        });

        it(`${locale} uses the same <Trans> component slots as en`, () => {
          for (const key of referenceKeys) {
            const source = resolve(catalogs.en[namespace], key);
            const target = resolve(catalogs[locale][namespace], key);
            expect(transTags(target), `${locale}/${namespace}:${key}`).toEqual(
              transTags(source)
            );
          }
        });
      }
    });
  }
});

function resolve(catalog: Catalog, dottedKey: string): string {
  const value = dottedKey
    .split(".")
    .reduce<unknown>((acc, part) => (acc as Catalog)?.[part], catalog);
  return typeof value === "string" ? value : "";
}
