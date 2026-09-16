# i18n

react-i18next. Two locales ship today — `en` (fallback) and `el`.

## Why this exists

The app was already bilingual by accident: at the time this landed, ~470 lines
of hardcoded Greek lived in 61 source files (student, evaluator and
class-management surfaces) while admin and super-admin surfaces were English.
`EvaluatorCourse` rendered "Back to my courses" directly beside
"Έναρξη αξιολόγησης". Neither language had a complete string set, and nothing
consumed `institutions.default_language` for the UI.

## Layout

```
src/i18n/
  config.ts          locale resolution — pure, no i18next, no React
  index.ts           i18next init; bundles the catalogs
  locale-context.ts  LocaleContext + useLocale()
  LocaleProvider.tsx applies the institution default; syncs <html lang>
  formatters.ts      locale-aware date-fns / Intl helpers
  locales/<locale>/<namespace>.json
```

Plus `src/lib/selected-institution.ts` — a subscribable wrapper over the
`selectedInstitutionId` session key, added here because the locale has to react
to an institution switch. It is not i18n-specific; anything else that needs to
react to a switch should use it rather than reading sessionStorage directly.

## Which locale wins

`resolveLocale` in `config.ts`, in order:

1. **Explicit user choice** — `localStorage['dianoisis.locale']`, written by
   `LanguageSwitcher`.
2. **`institutions.default_language`** for the user's current institution.
3. **`navigator.languages`**, in the browser's own preference order.
4. `en`.

A candidate is skipped when we ship no catalog for it. `LANGUAGE_OPTIONS` in
`src/lib/language-options.ts` lists 39 languages, but that governs what the AI
generates *content* in — it is not the set of translated UIs. An institution
whose `default_language` is `fr` gets an English UI, not a French one.

The user choice is checked first so it survives the institution row arriving
asynchronously: `LocaleProvider` applies the institution default one render
late, and must not undo a switch the user just made. Users who have chosen a
language skip the institution lookup entirely — they never consult the default.

`LocaleProvider` tracks the current institution through
`src/lib/selected-institution.ts` rather than `useUserInstitution`. That hook
re-resolves only when the *user id* changes, and an in-app institution switch
does not change it — so a multi-institution user would have kept the previous
institution's language until a full reload. Same-tab `sessionStorage` writes
fire no event, so that module keeps the storage key as the source of truth and
layers a subscription on top; every writer goes through it, and
`LocaleProvider` subscribes with `useSyncExternalStore`.

If `sessionStorage` rejects the write, the switch has not happened and the
locale does not move. That is deliberate: about eight readers take the key
straight from `sessionStorage`, so any in-memory copy that let the locale move
anyway would put the UI language and the working institution in different
institutions. A `sessionStorage` that rejects writes has broken institution
selection and auth long before it breaks i18n.

## Adding strings

```tsx
const { t } = useTranslation("evaluator");                 // one namespace
const { t } = useTranslation(["evaluator", "common"]);      // reach across with common:
…
{t("nav.next")}
{t("common:actions.save")}
{t("nav.position", { current: index + 1, total })}
```

Rules that CI enforces (`src/__tests__/lib/i18n-catalogs.test.ts`):

- Every key in `en` exists in **every** other locale, with identical nesting.
- Every `{{placeholder}}` in an `en` message appears in its translations.
  A missing key does not throw — i18next silently falls back to English — so
  without this guard a half-translated release passes review and reads as a
  language salad in production.
- Every `<1>…</1>` component slot in a `<Trans>` message appears in its
  translations. Drop one and the tag renders as literal text on the page.

Two things to watch when migrating a file:

- **Don't hold translated strings in module-level constants.** They evaluate
  once at import time and freeze to whatever locale loaded first. Keep the
  values in the catalog and the ordering in the constant — see
  `DIFFICULTY_OPTIONS` in `EvaluatorListFilters.tsx`.
- **Watch for `t` shadowing.** `items.map((t) => …)` silently captures the
  translation function; name the parameter something else.
- **Dates, numbers and sorting need the locale too.** Extracting strings does
  not touch them, and all three follow the *runtime's* locale unless told
  otherwise — so they look right on the machine that wrote them and wrong on a
  Greek browser. `formatters.ts` has the replacements, and ESLint rejects the
  built-ins in `src/`:

  | Instead of | Use |
  |---|---|
  | `new Date(x).toLocaleDateString()` | `formatDate(x)` |
  | `.toLocaleString()` on a date | `formatDateTime(x)` |
  | `.toLocaleTimeString()` | `formatTime(x)` |
  | `.toLocaleString()` on a number | `formatNumber(n)` |
  | `a.name.localeCompare(b.name)` | `compareText(a.name, b.name)` |
  | `localeCompare` on an id or ISO date | `compareCode(a, b)` |
  | `format(date, "MMM d")` | pass `{ locale: useDateFnsLocale() }` |

  **In a component, take them from `useFormatters()`**:

  ```tsx
  const { formatDate, compareText } = useFormatters();
  ```

  The plain functions read the active locale correctly whenever they run, but
  nothing tells React to run a component again when the language changes — so a
  screen showing dates or sorted names and no translated text would keep the
  previous locale's formatting until an unrelated re-render. The hook subscribes.
  If one of them is used inside a `useMemo`, it belongs in the dependency array
  for the same reason.

  `compareText` is locale-aware, numeric (so "Τμήμα 2" precedes "Τμήμα 10") and
  accent-insensitive; the empty string is a value, not a missing one, and sorts
  first exactly where `localeCompare` put it. `compareCode` is a plain
  comparison, because a timestamp's order must not depend on who is reading it.
  Both go through one cached collator per locale rather than building one per
  comparison, which is what `localeCompare` does.

  A module under `lib/` should take the locale as a parameter rather than read
  the active one: a pure function that consults ambient state gives its caller a
  result whose inputs the caller cannot see, and no reason to know its memo
  depends on the language.
- **Counts need plurals, not string concatenation.** `{n} quiz{n > 1 ? "zes" : ""}`
  encodes an English rule. Use `t("key", { count })` with `_one` / `_other`
  catalog entries.
- **A thrown `Error` can be copy.** Anything surfaced as
  `toast.error((err as Error).message)` is read by the user, so a client-side
  `throw new Error("…")` needs translating like any other string. Messages that
  come back from an edge function stay English — server-side output is not
  localised.
- **Logic modules must return decisions, not sentences.** `course-next-up.ts`
  used to hand back finished English prose, which put both the wording and a
  plural rule somewhere no catalog could reach. It now returns a variant plus
  counts, and the shelves render them. Anything that builds a user-visible
  string outside a component has the same problem.

## Adding a locale

1. Copy `locales/en/` to `locales/<code>/` and translate.
2. Add the code to `SUPPORTED_LOCALES` and a native-language `LOCALE_LABELS`
   entry in `config.ts`.
3. Import the namespaces into `resources` in `index.ts`.

Catalogs are bundled statically — a few kB for two locales, and no suspense
boundary or flash of untranslated text. Past a handful of locales, swap the
`resources` object for `i18next-resources-to-backend` with dynamic `import()`;
nothing outside `index.ts` needs to change.

## Tests

`vitest.setup.ts` imports `src/i18n`, so `useTranslation` works in any test
without a provider wrapper. jsdom reports `en-US` and nothing writes the
storage key, so the test locale is deterministically `en` — assert English.

Browser E2E lives in the deployment repository, and pins the locale explicitly
there so its visible-text assertions read English regardless of what
`institutions.default_language` says.

## Coverage

Migrated:

- **Evaluator** — `EvaluatorDashboard`, `EvaluatorCourse`, `EvaluatorNavBar`,
  `EvaluatorListFilters`, `EvaluatorMobileActionBar`.
- **Student dashboard** — `StudentDashboard`, `BrowseClasses`,
  `BrowsePublicInstitutions`.
- **Student course home** — `StudentCourse` and `WhatsNewSection`. Since #1287
  the course route renders the same `student/surface` shelves as the dashboard,
  so its copy comes from the shared `surface.*` and `course.*` keys rather than
  from a second set.
- **Quiz taking** — `StudentQuiz` and the shared answer fields in
  `question-fields/`. Those fields are rendered only by `StudentQuiz` and
  `StudyGuidePlayer`, both student surfaces, so translating them puts no Greek
  into an admin screen.
- **Study guides** — `StudyGuidePlayer`, including its four nested components.
- **Practice answering** — the five `student-answering/Single*Panel` components
  and their shared `AnsweringChrome`.

`StudentProfile` is **not** a student surface despite its name and its
`/student/:userId/profile` route: it redirects students away and is reached only
from `StudentEvaluations` and `UserManagement`. Check who a page actually serves
before migrating it — the filename lies here.

Instructor, admin and super-admin surfaces stay in English by decision, so
components those surfaces *share* with the student dashboard are deliberately
NOT migrated: `NotificationBell`, `ChangePasswordDialog` and `SiteFooter` render
on admin screens too, and translating them would put Greek into an interface
that is meant to stay English. The cost is a few English islands in an otherwise
Greek student dashboard.

Not yet migrated — the rest of the student surface (`CommunityQuestions`,
`StudentQuizHistory`, the practice flows and the `student-answering` panels), the rest
of the evaluator surface
(`EvaluatorReviewSession`, `QuestionEvaluationForm`,
`EvaluationSessionSummaryDialog`, `rubric.ts`), the class-management surfaces,
and shared constants such as `QUESTION_TYPE_LABELS` in
`src/lib/unified-question.ts`.
