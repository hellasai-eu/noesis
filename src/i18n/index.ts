import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import {
  DEFAULT_NAMESPACE,
  FALLBACK_LOCALE,
  NAMESPACES,
  SUPPORTED_LOCALES,
  readStoredLocale,
  resolveLocale,
  type SupportedLocale,
} from "./config";

import enCommon from "./locales/en/common.json";
import enEvaluator from "./locales/en/evaluator.json";
import elCommon from "./locales/el/common.json";
import elEvaluator from "./locales/el/evaluator.json";
import enStudent from "./locales/en/student.json";
import elStudent from "./locales/el/student.json";
import enQuiz from "./locales/en/quiz.json";
import elQuiz from "./locales/el/quiz.json";
import enStudyGuide from "./locales/en/study-guide.json";
import elStudyGuide from "./locales/el/study-guide.json";
import enPractice from "./locales/en/practice.json";
import elPractice from "./locales/el/practice.json";
import enStudy from "./locales/en/study.json";
import elStudy from "./locales/el/study.json";

/**
 * Catalogs are bundled statically rather than lazy-loaded over HTTP.
 *
 * With two small locales that is a few kB in the main chunk and buys us no
 * suspense boundary and no flash of untranslated text. If this grows past a
 * handful of locales, swap this object for `i18next-resources-to-backend` and
 * dynamic `import()` — nothing outside this file needs to change.
 */
const resources = {
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
} as const;

/**
 * The initial locale, chosen before React mounts.
 *
 * The institution default is *not* available yet — it needs an authenticated
 * Supabase round-trip — so it is applied later by `LocaleProvider`, which only
 * overrides this when the user has made no explicit choice.
 */
const initialLocale: SupportedLocale = resolveLocale({
  stored: readStoredLocale(),
  browser: typeof navigator === "undefined" ? [] : navigator.languages,
});

i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: SUPPORTED_LOCALES,
  ns: NAMESPACES,
  defaultNS: DEFAULT_NAMESPACE,
  interpolation: {
    // React already escapes everything it renders; i18next doing it again turns
    // an apostrophe in a course name into `&#39;`.
    escapeValue: false,
  },
  returnNull: false,
});

export default i18n;
