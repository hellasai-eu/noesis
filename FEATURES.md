# dianoisis — Canonical Feature Tracker

> Single source of truth for every feature, its user story, expected behavior (derived from code),
> and its lifecycle status across the test → fix → re-test loop.

## How to use this file

- **One row per feature.** IDs are stable; never renumber.
- **Status** tracks the lifecycle of each feature through the QA loop.
- **Test Result** / **Notes** are filled during Phase 2 (testing) and Phase 4 (re-test).

### Status legend

| Symbol | Meaning |
| --- | --- |
| 📝 Documented | User story + expected behavior written from code; not yet tested |
| 🧪 Testing | Currently under test |
| ✅ Pass | Behaves as expected |
| ❌ Fail | Bug found (see Notes) |
| ⚠️ Partial | Works with caveats / minor UX issue |
| 🔧 Fixed | Bug fixed in Phase 3 (awaiting re-test) |
| ✔️ Verified | Re-tested after fix, passes |
| 🚧 Not implemented | Feature is a "Coming Soon" / scaffold only |

### Phase progress

- [x] **Phase 1** — Catalog every feature, write user stories, build this tracker
- [x] **Phase 2** — Test every user story, document all errors (see [Phase 2 Findings Log](#phase-2--test-results--findings-log))
- [x] **Phase 3** — Fix every logistical / UX error in scope (F1–F4 fixed; F5–F12 documented for maintainer decision)
- [x] **Phase 4** — Re-test post-fix: production build ✓, 270/270 unit tests ✓, deno check ✓, app lint 0 errors ✓, F1 typecheck error cleared ✓

### Phase 2 test method (transparency)

Docker/Supabase **edge runtime was not available** for the full local stack during testing, so AI/edge-function flows could not be exercised end-to-end in a browser. Phase 2 used: TypeScript typecheck, ESLint, the **270 frontend unit tests (all pass)**, and a rigorous **static audit of every feature area's code against its documented expected behavior** (each finding verified against the real code path). Runtime/browser verification of AI flows is deferred to when the edge runtime is up.

---

## 1. Auth & Onboarding

| ID | Role | User Story | Expected Behavior (key checks) | Source | Status | Test Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUTH-SIGNIN | Anonymous | Sign in with email + password to reach my institution | Validates email format + 6-char password; invalid creds → "Invalid email or password"; success → records login history (IP/UA), "Welcome back!", redirect `/select-institution`; pending invite auto-processed | `src/pages/Auth.tsx`, `src/hooks/useAuth.tsx` | 📝 | | |
| AUTH-SIGNUP-INVITATION | Anonymous | Create an account from an invitation link | Reads `?invitation&email`; verifies pending invite matches email; prefills read-only email/name; password strength enforced; on success creates membership, marks invite accepted, redirect `/select-institution`; existing email → error | `src/pages/Auth.tsx`, `supabase/functions/accept-invitation` | 📝 | | |
| AUTH-SIGNUP-BLOCKED | Anonymous | Understand why open signup is disabled | Signup tab shows "Invitation Only" warning; all fields + submit disabled; "Contact Us to Express Interest" opens email client | `src/pages/Auth.tsx` | 📝 | | |
| AUTH-FORGOT-PASSWORD | Anonymous | Request a password reset email | "Forgot password?" reveals form; validates email; calls `resetPasswordForEmail` w/ redirect `/reset-password`; success/error messages; back returns to sign-in | `src/pages/Auth.tsx` | 📝 | | |
| AUTH-RESET-PASSWORD | Anonymous (recovery) | Set a new password from reset link | Requires valid recovery session else redirect `/auth`; 8-char min + strength indicator; confirm match; success updates pw, signs out, redirect `/auth`; handles weak/same/reauth errors | `src/pages/ResetPassword.tsx` | 📝 | | |
| AUTH-CHANGE-PASSWORD | All auth | Change password while logged in | Dialog; new pw (6-char min) + confirm; submit disabled if mismatch/short; success closes + clears; error toast | `src/components/ChangePasswordDialog.tsx` | 📝 | | |
| AUTH-LOGOUT | All auth | Sign out | Clears user/session/profile + sessionStorage; `signOut({scope:'global'})`; redirect `/` | `src/hooks/useAuth.tsx` | 📝 | | |
| AUTH-SESSION-PERSIST | All auth | Stay logged in across refresh | `getSession()` on load; `onAuthStateChange` listener; profile fetched; state cleared on logout | `src/hooks/useAuth.tsx` | 📝 | | |
| AUTH-PASSWORD-RULES | All auth | Be guided to a strong password | Strength indicator mirrors the server-enforced policy first (8 chars, a letter, a number — src/lib/password-policy.ts is the single client mirror), then advisory upper/special; 5 strength levels w/ color coding | `src/components/PasswordStrengthIndicator.tsx` | 📝 | | |
| AUTH-EMAIL-VERIFY | All auth | See email verification status | create-user auto-confirms; signup requires verify; dashboard shows green check / amber alert w/ tooltip | `src/pages/Dashboard.tsx`, `supabase/functions/create-user` | 📝 | | |
| ONBOARD-SELECT-INST | All auth | Select/switch institution | Redirect `/auth` if unauth; super-admin sees all + "Manage All"; regular sees member + public; auto-redirect if exactly 1 member & no public; none → empty state + sign out; click → store id, resolve role, route to `/dashboard` or `/student` | `src/pages/SelectInstitution.tsx` | 📝 | | |
| ONBOARD-JOIN-PUBLIC | Student | Join a discovered public institution | Public section lists `is_public` non-member institutions; Join → insert membership role=student; success toast + redirect `/student`; error toast | `src/pages/SelectInstitution.tsx` | 📝 | | |
| ONBOARD-CREATE-INST | SuperAdmin | Create a new institution | Dialog: name (auto-slug), slug, language, country, description; creates row + vector store (errors non-blocking); creator auto-admin; success redirect `/dashboard`; non-super sees "Coming Soon" | `src/pages/SelectInstitution.tsx` | 📝 | | |
| ONBOARD-INST-PAGE | Anon + Auth | View a public institution portal `/i/:slug` | Public fetch by slug; 404 if missing; anon sees auth form + public courses; member (not suspended) sees courses; suspended → Access Denied; non-member public → Join; `?invite` auto-joins | `src/pages/InstitutionPage.tsx` | 📝 | | |
| PROFILE-VIEW | Student | See my personal info | Dashboard shows full name, father's name, DOB (read-only) | `src/pages/StudentDashboard.tsx` | ✔️ | Verified | F2 fixed: shows `father_name` |
| CONTACT-SEND | Anon/All | Contact the team | `/contact` form name/email/subject/message; Zod validation (lengths); rate limit 5/hr per IP+email → 429; success emails admin + confirmation to sender, toast + clear | `src/pages/Contact.tsx`, `supabase/functions/send-contact-form` | ✔️ | Verified | F4 fixed: `escapeHtml()` on user fields |
| USR-INVITE | Admin | Invite users (student/instructor/admin) | Dialog email/name/role/grade; validates email format, not-already-user, not-pending; insert invite + send email; existing user → added directly; success adds to pending list | `src/pages/UserManagement.tsx`, `supabase/functions/send-invitation` | ✔️ | Verified | F1 fixed: `fetchData(instId)` |
| USR-INVITE-RESEND | Admin | Resend a pending invitation | Resend button re-sends email; spinner; success/error toast | `src/pages/UserManagement.tsx` | 📝 | | |
| USR-INVITE-CANCEL | Admin | Cancel a pending invitation | Cancel deletes invite row; spinner; removed from list | `src/pages/UserManagement.tsx` | 📝 | | |
| USR-CREATE-DIRECT | Admin | Create accounts without invitations | Dialog email/name/pw/role/grade/father/DOB; validates email, 8-char pw; create-user: checks duplicate, creates auto-confirmed user + membership + profile, optional class enroll; success/error toast | `src/pages/UserManagement.tsx`, `supabase/functions/create-user` | 📝 | | |
| USR-REMOVE | Admin | Remove a user from institution | Confirm dialog; cannot remove self; deletes membership + pending invites for email; spinner; success toast | `src/pages/UserManagement.tsx` | 📝 | | |
| USR-SUSPEND | Admin | Suspend/reactivate a user | Toggle `is_suspended`; cannot suspend self; suspended row muted + "(suspended)"; toast | `src/pages/UserManagement.tsx` | 📝 | | |
| USR-ROLE-CHANGE | Admin | Change a user's role | Cascading cleanup (instructor↔student removes course/class assignments); updates role; loading state; error → no local update | `src/pages/UserManagement.tsx` | 📝 | | |
| USR-EDIT-PROFILE | Admin | Edit a user's profile | Dialog full name/father/DOB; updates profiles; spinner; success toast + local update | `src/pages/UserManagement.tsx` | 📝 | | |
| USR-LOGIN-HISTORY | Admin/SuperAdmin | View login history | Records IP (ipify, "unknown" on fail), UA, timestamp on each login → `login_history` | `src/hooks/useAuth.tsx` | 📝 | | |
| USR-DELETE-FULL | SuperAdmin | Delete a user entirely | Bearer auth + is_super_admin; deletes memberships → profile → auth user; 400/401/403 guards; `{success:true}` | `supabase/functions/delete-user` | 📝 | | |

---

## 2. Student Learning

| ID | Role | User Story | Expected Behavior (key checks) | Source | Status | Test Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| STU-DASHBOARD | Student | See my courses + upcoming assessments | Lists enrolled-institution courses; available-quiz badges; next due date; "New" badge (<24h); switch institution / filter by class; sort pending-first then alpha | `src/pages/StudentDashboard.tsx` | 📝 | | |
| STU-COURSE-HOME | Student | One hub for a course's activities | Urgent quiz alert; What's New (7d); Learn (tutor, cheat sheets, AI interactive); Practice (unified list + Create Your Own); Review (flashcards, history); Assessments list | `src/pages/StudentCourse.tsx` | ✔️ | Verified | F3 fixed: due count populated |
| STU-QUIZ-TAKE | Student | Take quizzes/practice with feedback | Loads snapshot or live questions; per-Q MCQ + counter + difficulty + timer; immediate correct/incorrect + explanation; skip/review; auto-submit on expiry; stores quiz_answers; upvote/downvote; exit guard on timed | `src/components/StudentQuiz.tsx` | 📝 | | |
| STU-QUIZ-HISTORY | Student | Review completed quizzes | Lists completed/expired; title/date/score/time; "Results pending" lock when answers hidden; sorted newest-first | `src/pages/StudentQuizHistory.tsx` | 📝 | | |
| STU-PRACTICE-UNIFIED | Student | Pick any assigned practice question from one list | Single PRACTICE entry → unified flat list across MCQ / open / fill-gaps / ordering / classification; type+status filters; type/difficulty/status badges per row; embeds dispatcher → matching single-question answering panel; status updates on completion | `src/components/student/UnifiedPracticeQuestionsList.tsx`, `src/components/student/PracticeAnsweringDispatcher.tsx` | 📝 | | |
| STU-OPEN-QUESTIONS | Student | Answer open-ended Qs w/ AI guidance | Lists non-hidden open Qs w/ difficulty + status; select → Socratic chat; evaluator judges CORRECT/PARTIAL/INCORRECT/IRRELEVANT/OFF_TASK; tutor can pause (flagged); progress tracked; multilingual | `src/components/StudentOpenQuestions.tsx` | 📝 | | |
| STU-QUESTION-GEN | Student | Generate AI practice questions | Lists chapters; pick difficulty; 10/day limit (unlimited admin); shows remaining quota; generates 10 via edge fn; marked is_user_generated | `src/components/StudentQuestionGenerator.tsx` | 📝 | | |
| STU-STUDY-SESSION | Student | Interactive AI study session | Lists published sessions; chat w/ the AI tutor; tracks subject/topic/goal/progress/gaps/misconceptions; images if enabled; status in_progress/completed/flagged; realtime updates; tutor pause on off-task | `src/components/StudentStudySession.tsx`, `supabase/functions/chat`, `supabase/functions/_shared/chat-subjects/study-session.ts` | 📝 | | |
| STU-AI-TUTOR | Student | Learn via AI tutor conversation | Streaming chat; persistent session state; never regresses progress; merges state intelligently; optional image gen; message count + completion tracked | `supabase/functions/chat`, `supabase/functions/_shared/chat-subjects/study-session.ts`, `src/components/chat/ChatWidget.tsx` | 📝 | | |
| STU-SOCRATIC-CHAT | Student | Socratic coaching on open Qs | Streaming; evaluator judgement + confidence + missing concepts + misconceptions + answer_allowed; tutor STOP/ASK; multilingual; offensive flagging | `supabase/functions/chat`, `supabase/functions/_shared/chat-subjects/open-question.ts` | 📝 | | |
| STU-FLASHCARD-VIEW | Student | View course flashcards | Chapters grouped by material; flip front/back; only visible flashcards; offering filter (published only); realtime refresh | `src/components/FlashcardViewer.tsx` | 📝 | | |
| STU-FLASHCARD-SESSION | Student | Spaced-repetition review session | Daily limits 10 new / 15 due; shows reviewed counts; per-chapter start; complete message at limit | `src/components/FlashcardSessionManager.tsx` | 📝 | | |
| STU-SPACED-REP | Student | SM-2 spaced repetition | Flip + rate Again/Hard/Good/Easy; updates reps/interval/ease/due; persists to flashcard_reviews; session stats; overdue highlighted; "already reviewed today" at limit | `src/components/SpacedRepetitionReview.tsx` | 📝 | | |
| STU-FLASHCARD-CAL | Student | Calendar of due flashcards | Calendar shows due+new per day; counts; distributes new across days w/ limits; click date shows cards; overdue grouped | `src/components/FlashcardCalendarView.tsx` | 📝 | | |
| STU-CHEAT-SHEET | Student | Quick-reference summaries | Chapters w/ cheat sheets grouped by material (textbooks); offering filter (published); HTML + LaTeX render; read-only | `src/components/CheatSheetViewer.tsx` | 📝 | | |
| STU-QUESTION-HISTORY | Student | Review past attempts + feedback | Lists quiz_answers; question/options/my answer/correct/explanation; grouped w/ attempt+correct counts; filter correctness/difficulty/quiz; search; up/down vote | `src/components/QuestionHistory.tsx` | 📝 | | |
| STU-QUESTION-FEEDBACK | Student | Up/downvote question quality | Toggle vote → question_votes; persists; toast; aggregated for instructors | `src/components/StudentQuiz.tsx` | 📝 | | |
| STU-INTERACTION-GRADE | Student | Open responses held for review | AI grading removed — submit-open-answer records the answer ungraded; AI drafts qualitative notes (no number) into manager-only open_answer_ai_drafts; instructor grades manually | `supabase/functions/submit-open-answer` | 📝 | | |
| STU-OPEN-Q-CHAT-HIST | Student | Review my open-question chat | Shows all messages w/ timestamps; flagged messages; status; grade if completed | `src/components/OpenQuestionChatHistory.tsx` | 📝 | | |
| STU-ASSESS-TAB | Student | See assigned quizzes by status | Grouped Not Started / In Progress / Completed / Overdue; question count/time/due/score; Take vs View Results; color-coded; overdue disabled | `src/components/student/AssessTab.tsx` | 📝 | | |
| STU-COURSE-PROGRESS | Student | Track chapter progress | Materials→chapters tree; completion status; class filter; read-only for students | `src/components/CourseProgress.tsx` | 📝 | | |
| STU-BROWSE-CLASSES | Student | Self-enroll in classes | Active classes w/ allow_self_enrollment; respects institution flag; shows grade/section/period/count; enroll → class_enrollments; toast | `src/components/student/BrowseClasses.tsx` | 📝 | | |
| STU-BROWSE-INST | Student | Discover/join public institutions | Collapsible public list (non-member); name+logo; Join → membership; toast; removed after join | `src/components/student/BrowsePublicInstitutions.tsx` | 📝 | | |
| STU-URGENT-ALERT | Student | Prominent upcoming-quiz alert | Banner for most urgent uncompleted quiz; title/count/time/due; orange/red by urgency; Take Quiz; hidden if none | `src/components/student/UrgentQuizAlert.tsx` | 📝 | | |
| STU-WHATS-NEW | Student | See recent course additions | Collapsible new-since-last-login (7d fallback); study sessions/materials/flashcards/questions/quizzes/open Qs; dismiss; collapsed by default | `src/components/student/WhatsNewSection.tsx` | 📝 | | |

---

## 3. Instructor Authoring

| ID | Role | User Story | Expected Behavior (key checks) | Source | Status | Test Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| INS-MATERIAL-UPLOAD | Instructor | Upload study materials | PDF/image/reference w/ metadata + page count; type textbook/teacher_companion/reference_exercises/images; edit metadata; thumbnails; sync to OpenAI vector store w/ status; delete w/ cascade | `src/pages/CoursePage.tsx` | 📝 | | |
| INS-CHAPTER-DETECT | Instructor | Auto-detect chapters from PDF | Splits first 50 pages; AI extracts titles + page ranges; validates ranges; returns ordered list for review | `supabase/functions/detect-chapters`, `src/components/MaterialChaptersWizard.tsx` | 📝 | | |
| INS-CHAPTER-MANAGE | Instructor | Create/edit/delete chapters | Add w/ auto page range; edit in-place; delete w/ confirm; persist to material_chapters w/ ordering; chapter count badges | `src/components/MaterialChaptersWizard.tsx`, `src/pages/CoursePage.tsx` | 📝 | | |
| INS-EXTRACT-IMAGE | Instructor | Extract images from PDF pages | PDF viewer w/ nav+zoom; extract current page → images bucket; pending moderation; reports count; toast | `src/components/PdfViewerWithExtract.tsx`, `supabase/functions/extract-images-from-pdf` | 📝 | | |
| INS-MODERATE-IMAGE | Instructor | AI-moderate extracted images | moderate-study-image → ALLOW/REJECT + reason; approved stored w/ description; rejected flagged; status indicators | `src/pages/CoursePage.tsx`, `supabase/functions/moderate-study-image` | 📝 | | |
| INS-COMPETENCY-EXTRACT | Instructor | Auto-extract competencies | Batch across chapters (200pg/32MB limits); AI title+desc+chapter indices; dedup; link via competency_chapters; progress tracking | `src/components/CourseCompetencies.tsx`, `supabase/functions/extract-competencies` | 📝 | | |
| INS-COMPETENCY-MANAGE | Instructor | Create/edit/link competencies | Create title+desc; debounced auto-save; link to chapters; filter by chapter/material; delete w/ confirm; order_num | `src/components/CourseCompetencies.tsx` | 📝 | | |
| INS-GEN-MCQ | Instructor | AI-generate MCQs | 1-5/batch; filter chapters/competencies; difficulty; auto-link chapters+competencies; validates ≤400pg/32MB; special instructions; explanation field; optional hidden | `src/components/CourseQuestions.tsx`, `supabase/functions/generate-questions` | 📝 | | |
| INS-GEN-OPEN-Q | Instructor | AI-generate open questions | 1-5/batch w/ model answer + explanation (method/steps/concepts/mistakes/4 hint levels); filter; difficulty; auto-link; size limits; optional hidden | `src/components/AIInteractiveQuestions.tsx`, `supabase/functions/generate-open-questions` | 📝 | | |
| INS-VALIDATE-Q | Instructor | Validate question correctness | AI verdict CORRECT/PARTIALLY/INCORRECT/INSUFFICIENT + confidence + message; stored w/ timestamp; filter by status; bulk | `supabase/functions/validate-questions`, `src/components/QuestionsTable.tsx` | 📝 | | |
| INS-CHECK-SIMILARITY | Instructor | Find duplicate questions | AI similarity groups w/ score + reason; quick delete/hide; threshold coloring; recheck | `src/components/SimilarityCheckDialog.tsx`, `supabase/functions/check-question-similarity` | 📝 | | |
| INS-GEN-FLASHCARD | Instructor | Auto-generate flashcards | Textbook chapters only; AI Q/A pairs; OpenAI file ref w/ text fallback; stored as JSON; visibility toggle; delete w/ confirm; count badge | `src/components/FlashcardManager.tsx`, `supabase/functions/generate-flashcards` | 📝 | | |
| INS-GEN-CHEATSHEET | Instructor | Auto-generate cheat sheets | HTML for textbook chapters; AI key concepts/formulas; rich editor visual/HTML; markdown→HTML + LaTeX; publish/hide; stored in cheat_sheet | `src/components/CheatSheetEditor.tsx`, `supabase/functions/generate-cheatsheet` | 📝 | | |
| INS-RICH-EDITOR | Instructor | Rich-text editing | Visual + HTML tabs; toolbar headings/bold/italic/code/links/lists/quotes; shortcuts; live preview; LaTeX render | `src/components/RichTextEditor.tsx` | 📝 | | |
| INS-ASSIGN-CONTENT | Instructor | Assign Qs/flashcards to classes | Dialog active classes; multi-select; save to offering assignments; bulk; badges; section restrictions respected (admins see all) | `src/components/ContentAssignDialog.tsx`, `src/components/AssignedClassesBadges.tsx` | 📝 | | |
| INS-QUIZ-BUILDER | Instructor | Build quizzes from MCQ bank | List + builder; bank filter difficulty/competency/validation/author/date; add questions; title/desc/time limit; preview; publish toggle; save to quizzes+quiz_questions | `src/components/QuizManager.tsx`, `src/components/assessment/*` | 📝 | | |
| INS-TEST-BUILDER | Instructor | Build offline tests (MCQ+open) | Mixed questions; title/desc/header; bank w/ validation filter; publish toggle; preview; export PDF; answer-key for instructor copy | `src/components/TestBuilder.tsx` | 📝 | | |
| INS-ASSIGN-QUIZ-TEST | Instructor | Assign quizzes/tests to classes | Dialog class checkboxes; due date; time-limit override; publish; stored in offering_quizzes/offering_tests; assignment counts; unassign | `src/components/QuizManager.tsx`, `src/components/TestsAssignmentView.tsx` | 📝 | | |
| INS-STUDY-SESSION-MGR | Instructor | Create study sessions | Title/topic/material/chapter; AI summary; reference images; image-gen toggle; instructor notes; stored w/ llm_status; assign to classes | `src/components/StudySessionManager.tsx` | 📝 | | |
| INS-MATERIAL-SYNC | Instructor | Manage materials in vector store | One-click sync w/ progress; status completed/in_progress/failed icons; resync metadata; handles OpenAI errors; tracks file/store IDs; delete w/ cleanup | `src/pages/CoursePage.tsx` | 📝 | | |
| INS-COURSE-SETTINGS | Instructor/Admin | Configure course settings | Edit title/desc/theme; leaderboard toggle; student-question toggle; difficulty-visibility toggle; language; reset leaderboard (deletes answers) w/ confirm | `src/pages/CoursePage.tsx` | 📝 | | |
| INS-BULK-OPS | Instructor | Bulk question actions | Multi-select; bulk assign/hide/delete/validate; confirm on delete; success count toast | `src/components/QuestionsTable.tsx`, `src/components/CourseQuestions.tsx` | 📝 | | |
| INS-Q-SORT-FILTER | Instructor | Sort/filter question bank | Sort text/difficulty/success/date/hidden; filter difficulty/validation/author/competency/date; pagination; assignment counts; search | `src/components/QuestionsTable.tsx` | 📝 | | |
| INS-ATTACH-COURSE | Admin | Attach courses to classes | Dialog active classes not yet attached; create offering; show attached w/ grade/section/period; bulk | `src/pages/CoursePage.tsx` | 📝 | | |
| INS-SECTION-ACCESS | Admin | Restrict instructor sections | course_instructor_sections gating; instructors see only allowed sections; RLS enforced; admins unrestricted | `src/pages/CoursePage.tsx` | 📝 | | |

---

## 4. Grading & Evaluation

| ID | Role | User Story | Expected Behavior (key checks) | Source | Status | Test Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GRD-EVAL-AI-GEN | Instructor | AI-generate student evaluations | Per-student via Claude w/ course language + stats (quiz acc/open avg/study msgs); ≥3 interactions threshold; stored is_manual=false; "AI Eval All" bulk; 5 fields | `src/components/StudentEvaluations.tsx`, `supabase/functions/generate-student-evaluation` | 📝 | | |
| GRD-EVAL-MANUAL | Instructor | Create manual evaluations | Form overall/strengths/weaknesses/recommendations; multiline→arrays; is_manual=true; added to timeline top; auto-expands | `src/components/StudentEvaluations.tsx` | 📝 | | |
| GRD-EVAL-EDIT | Instructor | Edit any evaluation | Pencil opens dialog prefilled; update all fields incl instructor_feedback; toast; immediate UI update | `src/components/StudentEvaluations.tsx` | 📝 | | |
| GRD-EVAL-DELETE | Instructor | Delete evaluations | Trash + confirm; deletes from student_evaluations; removed from timeline | `src/components/StudentEvaluations.tsx` | 📝 | | |
| GRD-EVAL-FEEDBACK | Instructor | Add feedback to AI evaluation | "Does this align?" prompt for latest AI eval only; textarea; Save/Skip; persists; shown in purple box | `src/components/StudentEvaluations.tsx` | 📝 | | |
| GRD-EVAL-TIMELINE | Instructor | Compare evaluation progress | "Compare Progress" at 2+ evals; modal via generate-evaluation-timeline; trend improving/stable/declining; competency insights; cached, regenerate refreshes | `src/components/EvaluationTimeline.tsx`, `supabase/functions/generate-evaluation-timeline` | 📝 | | |
| GRD-STUDENT-360 | Instructor | 360° view per student | Tabs Evaluations / MCQ Answers / Chats / Question Feedback; class filter; delegates to sub-components; offering-scoped | `src/components/Student360.tsx` | 📝 | | |
| GRD-OPEN-Q-AUTO | Instructor | (Removed) Auto-grade open questions | AI grading removed — grade-interaction and grade-open-answer deleted; open answers pend instructor review; AI supplies a qualitative draft only | — | 📝 | | |
| GRD-OPEN-Q-OVERRIDE | Instructor | Grade open-Q submissions | Edit opens slider 0-100 + feedback; the ONLY way an open-question grade is set (AI never grades); AI draft shown alongside as an aid | `src/components/OpenQuestionChatHistory.tsx` | 📝 | | |
| GRD-OFFENSIVE-FLAG | Instructor | Monitor offensive language | Moderation flags offensive student msgs; alert icon; "Show Flagged Only" filter; per-session count (grade-interaction's LLM flagging removed with AI grading) | `src/components/OpenQuestionChatHistory.tsx` | 📝 | | |
| GRD-OPEN-Q-HISTORY | Instructor | Review all open-Q interactions | Accordion by question+student; status badge; expand transcript; AI grade+feedback; override/clear; delete message; filters student/question/flagged/graded; search | `src/components/OpenQuestionChatHistory.tsx` | 📝 | | |
| GRD-QUIZ-REPORT | Instructor | Per-quiz performance report | Report modal; aggregates per-student answered/correct/%/date; sorted by %; search; question count + metadata | `src/components/QuizReport.tsx` | 📝 | | |
| GRD-QUIZ-HISTORY | Instructor | Detailed quiz answer history | All answers w/ question details; filter student/quiz/date/correctness; sort; pagination; Raw Answers + Statistics tabs (bar/pie) | `src/components/QuizHistory.tsx` | 📝 | | |
| GRD-STUDENT-STATS | Instructor | Aggregate engagement stats | Expanded row: quiz accuracy %, avg open-Q score, study msg count, AI chat count; 4-col grid | `src/components/StudentEvaluations.tsx` | 📝 | | |
| GRD-COURSE-PROGRESS | Instructor | Class-level chapter progress | Grouped by material; per-chapter completed/enrolled bar; checkbox + difficulty + competency; class filter; active classes first | `src/components/CourseProgress.tsx` | 📝 | | |
| GRD-COMPETENCY-MASTERY | Instructor | Track competency mastery | Competency editor + chapter mapping; filter; multi-chapter; reorder; auto-save; batch extraction; pagination | `src/components/CourseCompetencies.tsx` | 📝 | | |
| GRD-TEST-EXPORT | Instructor | Export tests as PDF | Test list w/ count/status/author/date; export workflow; "Offline Only" badge; published status; convert-md-to-pdf | `src/components/TestsAssignmentView.tsx`, `supabase/functions/convert-md-to-pdf` | 📝 | | |
| GRD-EVAL-PDF-EXPORT | Instructor | Export evaluations to PDF | "Export PDF" (currently disabled in UI); pdf-lib multi-page; per-student sections; dated filename | `src/components/StudentEvaluations.tsx` | ⚠️ | | Button disabled in current build — verify intent |
| GRD-INLINE-GRADE | Instructor/Admin | Select taught grade levels | Multi-checkbox (instructor) / dropdown (student); saves user_institution_grades; syncs course_instructors; toast; dup handling | `src/components/InlineGradeSelector.tsx` | 📝 | | |
| GRD-HANDWRITTEN | Instructor | AI-grade handwritten tests | "Coming Soon" placeholder only — not implemented | `src/components/HandwrittenTestGrading.tsx` | 🚧 | | Scaffold only |

---

## 5. Class & Institution Admin

| ID | Role | User Story | Expected Behavior (key checks) | Source | Status | Test Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ADM-GRADE-CREATE | Admin | Create grade level w/ sections | Pick grade; 1-8 sections (A-H); auto-names "Ε΄ Δημοτικού - Τμήμα A"; batch create active w/ academic_period; preview | `src/components/class-management/CreateGradeLevelDialog.tsx` | 📝 | | |
| ADM-GRADE-DELETE | Admin | Delete grade level + sections | Trash on hover (admin); confirm lists section count + warns; batch delete classes; clears selection | `src/pages/ClassManagement.tsx`, `src/components/class-management/GradeLevelSidebar.tsx` | 📝 | | |
| ADM-CLASS-CREATE | Admin | Create generic class | Form name+period; creates active class, self_enroll=false; appears in sidebar | `src/pages/ClassManagement.tsx` | 📝 | | |
| ADM-CLASS-ACTIVE | Admin | Deactivate class | Toggle is_active w/ confirm warning; "Inactive" badge; students/instructors lose access | `src/pages/ClassManagement.tsx`, `src/components/class-management/ClassDetailPanel.tsx` | 📝 | | |
| ADM-CLASS-SELF-ENROLL | Admin | Toggle class self-enrollment | Toggle allow_self_enrollment; requires institution flag too; toast | `src/pages/ClassManagement.tsx`, `src/components/class-management/ClassDetailPanel.tsx` | 📝 | | |
| ADM-CLASS-DELETE | Admin | Delete a class | Red delete + confirm; cascades enrollments + offerings; removed from sidebar | `src/pages/ClassManagement.tsx`, `src/components/class-management/ClassDetailPanel.tsx` | 📝 | | |
| ADM-STUDENT-ENROLL | Admin | Manually enroll students | Dialog filter Unassigned/Same grade/All; search; multi-select; reassign confirm + delete-insert; insert class_enrollments; toast | `src/pages/ClassManagement.tsx`, `src/components/class-management/EnrollStudentDialog.tsx` | 📝 | | |
| ADM-STUDENT-UNENROLL | Admin | Remove student from class | Enrollments tab delete + confirm; deletes class_enrollments; refreshes | `src/pages/ClassManagement.tsx`, `src/components/class-management/ClassDetailPanel.tsx` | 📝 | | |
| ADM-COURSE-CREATE | Admin | Create institution course | Add Course dialog title/desc/theme/language/grade; grade auto-attaches to matching classes; unique title; appears in grid | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-COURSE-CREATE-GRADE | Admin | Create course for whole grade | GradeLevel panel Create Course; prefills grade+language; batch upserts offerings for all sections; toast | `src/pages/ClassManagement.tsx`, `src/components/class-management/CreateCourseDialog.tsx` | 📝 | | |
| ADM-COURSE-DELETE | Admin | Delete a course | Card delete + confirm; cascades offerings + course_instructors; removed from grid | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-COURSE-ATTACH | Admin | Attach course to class | AttachCourseDialog dropdown unattached courses; insert offering; toast; refresh | `src/pages/ClassManagement.tsx`, `src/components/class-management/AttachCourseDialog.tsx` | 📝 | | |
| ADM-COURSE-ATTACH-GRADE | Admin | Attach course to whole grade | Course dropdown + section checkboxes preselected; batch insert offerings; partial/full toast | `src/pages/ClassManagement.tsx`, `src/components/class-management/AttachCourseDialog.tsx` | 📝 | | |
| ADM-COURSE-DETACH | Admin | Detach course from class | Courses tab X + confirm; delete offering; toast; refresh | `src/pages/ClassManagement.tsx`, `src/components/class-management/ClassDetailPanel.tsx` | 📝 | | |
| ADM-INSTR-ASSIGN | Admin | Assign instructors to course | CourseInstructorPicker available instructors (exclude assigned); multi-select+search; insert course_instructors; toast; refresh | `src/components/class-management/CourseInstructorPicker.tsx` | 📝 | | |
| ADM-INSTR-REMOVE | Admin | Remove instructor from course | X + confirm; if section-restricted deletes restriction (then course_instructors if none left) else deletes course_instructors; toast | `src/pages/ClassManagement.tsx` | 📝 | | |
| ADM-GRADE-DETAIL | Admin | Audit grade's courses+instructors | GradeLevelDetailPanel: sections w/ status, aggregated courses w/ section count + instructors + active toggle; Attach/Create buttons | `src/components/class-management/GradeLevelDetailPanel.tsx` | 📝 | | |
| ADM-CLASS-DETAIL | Admin | Manage single class | ClassDetailPanel tabs Summary/Courses/Enrollments; active+self-enroll toggles; delete; assign instructor; add student | `src/components/class-management/ClassDetailPanel.tsx` | 📝 | | |
| ADM-SIDEBAR-GRADE | Admin | Navigate grades/sections (Greek) | GradeLevelSidebar collapsible grades; click grade→panel, section→class; search; delete on hover; Add Grade buttons; counts | `src/components/class-management/GradeLevelSidebar.tsx` | 📝 | | |
| ADM-SIDEBAR-CLASS | Admin | Browse classes (generic) | ClassListSidebar paginated (10); search name/period; status badge; click→panel; Create First Class empty state | `src/components/class-management/ClassListSidebar.tsx` | 📝 | | |
| ADM-INST-PUBLIC | Admin | Toggle institution public | Settings toggle is_public w/ confirm warning; public banner; affects discovery | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-INST-LANGUAGE | Admin | Set default content language | Selector EN/EL/FR/ES/DE; updates default_language; affects course defaults + AI | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-INST-SELF-ENROLL | Admin | Toggle institution self-enroll | Toggle allow_self_enrollment; gates class self-enroll; toast | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-INST-PERIOD | Admin | Set academic period | Inline edit Save/Cancel; updates academic_period; new classes inherit | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-INST-LOGO | Admin | Upload institution logo | Dialog file picker (JPG/GIF/PNG/WebP ≤5MB); preview; upload to storage; deletes old; updates logo_url; toast | `src/components/InstitutionLogoUpload.tsx` | 📝 | | |
| ADM-YEAR-ROLLOVER | Admin | Academic-year rollover | Button (disabled if 0 active); dialog lists actions + new period input; archives classes, recreates sections, copies offerings + course-level instructors, NOT enrollments; toast counts | `src/components/class-management/AcademicYearRolloverDialog.tsx`, `supabase/functions/academic-year-rollover` | 📝 | | |
| ADM-VECTOR-ENABLE | Admin | Enable AI Cloud (vector store) | AI Cloud section; Active badge if set; Enable → manage-vector-store sync; updates vector_store_id; toast | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-USER-COUNTS | Admin | See user count summary | User Management card: Total/Pending/Students/Instructors; click → users page | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-DASH-INVITE | Admin | Invite from dashboard | Invite dialog email → send-invitation; pending list w/ Resend/Cancel; toast | `src/pages/Dashboard.tsx` | 📝 | | |
| ADM-SETTINGS-CARD | Admin | Central institution settings | Single card: public/language/self-enroll/period/rollover/AI cloud; loading states; toasts | `src/pages/Dashboard.tsx` | 📝 | | |

---

## 6. Super Admin

| ID | Role | User Story | Expected Behavior (key checks) | Source | Status | Test Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SA-INST-MGMT | SuperAdmin | Create/view/delete institutions | Create name/slug/language/type/desc; Greek auto-creates year levels + vector store; list w/ logo+date; delete w/ deep cascade; search | `src/pages/SuperAdminDashboard.tsx` | 📝 | | |
| SA-PLATFORM-STATS | SuperAdmin | Platform-wide statistics | Totals institutions/users/courses/questions/materials; per-institution role + content breakdown; sortable table | `src/pages/SuperAdminStats.tsx` | 📝 | | |
| SA-LOGIN-AUDIT | SuperAdmin | Audit login activity | Last 100 logins; email/name/institution/IP/UA/date; UA parsed to browser; hides institution for super logins; newest first | `src/pages/SuperAdminStats.tsx` | 📝 | | |
| SA-USER-MGMT | SuperAdmin | Manage all platform users | Create w/ multi-institution+role; list w/ memberships + last login; search/filter/sort; add/remove institutions; edit roles; delete (cascade); paginate 20 | `src/pages/SuperAdminUsers.tsx` | 📝 | | |
| SA-AI-HUB | SuperAdmin | AI management hub | Tabs/cards Usage / AI Cloud / Prompts / Agent Logs w/ navigation | `src/pages/SuperAdminAI.tsx` | 📝 | | |
| SA-AI-USAGE | SuperAdmin | Monitor AI usage + cost | Cards requests/in/out tokens/avg time; response-time by status; daily charts; breakdown by model/function/institution; date+institution filters; M/K formatting | `src/pages/SuperAdminUsage.tsx` | 📝 | | |
| SA-VECTOR-ADMIN | SuperAdmin | Manage vector stores | List institutions + store IDs; create missing; verify; material upload+sync status; check individual / bulk w/ rate limit; sync; expand chapters; search; paginate; stats | `src/pages/VectorStoreAdmin.tsx` | 📝 | | |
| SA-AGENT-LOGS | SuperAdmin | Audit AI agent interactions | Toggle verbose logging; logs grouped by conversation; filter function+date; expand messages w/ timing; detail modal (state/evaluator/planner/presenter/trace); delete all; paginate 500 | `src/pages/SuperAdminAgentLogs.tsx` | 📝 | | |
| SA-DATA-EXPORT | SuperAdmin | Export database tables | List tables + row counts + access errors; JSON/CSV; select/all; preview 3 rows; ZIP w/ timestamp + _metadata.json; is_super_admin gated | `src/pages/SuperAdminExport.tsx`, `supabase/functions/export-data` | 📝 | | |
| SA-VERSION | SuperAdmin | View version/build info | Commit hash + build time from Vite env vars | `src/pages/SuperAdminVersion.tsx` | 📝 | | |
| SA-ACCESS-GATING | SuperAdmin | Gate super-admin routes | All routes call is_super_admin; access-denied screen + redirect `/dashboard`; edge fns server-check | `src/pages/SuperAdminDashboard.tsx`, `src/App.tsx` | 📝 | | |
| SA-VECTOR-OPS | SuperAdmin | Vector store operations | manage-vector-store create/sync (super check); check-vector-store-file status; upload-to-openai + add to store; delete-from-openai; auto-create on institution create | `supabase/functions/manage-vector-store`, `check-vector-store-file`, `upload-to-openai`, `delete-from-openai` | 📝 | | |

---

## 7. Cross-Cutting / Platform

| ID | Role | User Story | Expected Behavior (key checks) | Source | Status | Test Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SYS-ROUTE-GUARD | All | Role-based route protection + redirects | Auth redirects authed→`/select-institution`; student dash redirects unauth→`/auth`, admin→`/dashboard`; pages enforce role via useUserInstitution | `src/App.tsx`, page guards | 📝 | | |
| SYS-RBAC-MEMBERSHIP | All | Role-based access at institution level | user_institutions role; useUserInstitution gives isAdmin/isInstructor/isStudent; reads selectedInstitutionId from sessionStorage | `src/hooks/useUserInstitution.tsx` | 📝 | | |
| SYS-NAV-SIDEBAR | All auth | Responsive collapsible sidebar | Expanded 16rem / collapsed 3rem / mobile 18rem drawer; cookie persist; Ctrl+B toggle; mobile detection | `src/components/ui/sidebar.tsx`, `src/hooks/use-mobile.ts` | 📝 | | |
| SYS-NAVLINK-ACTIVE | All auth | Active nav highlighting | NavLink applies active/pending classes via isActive/isPending | `src/components/NavLink.tsx` | 📝 | | |
| SYS-TOASTS | All | Toast notifications | Sonner success/error/loading; auto-dismiss; used across forms/async ops | `src/App.tsx`, `src/components/ui/use-toast.ts` | 📝 | | |
| SYS-404 | All | Friendly 404 page | Catch-all `*`; "404 / Page not found"; Return Home link; logs to console | `src/pages/NotFound.tsx` | 📝 | | |
| SYS-LANDING | Anonymous | Marketing landing page | Hero + nav Sign In/Get Started; sections + 4-tier pricing; CTAs to `/auth` and `/contact`; scroll animations; responsive | `src/pages/Index.tsx` | 📝 | | |
| SYS-LANGUAGE | All | Multi-language support | LANGUAGE_OPTIONS (many codes); institutions/courses store language; getLanguageName; used in creation flows | `src/lib/language-options.ts` | 📝 | | |
| SYS-GREEK-SCHOOL | Institutions | Greek school grade/section model | GREEK_SCHOOL_LEVELS + GRADE_OPTIONS + SECTION_LETTERS; buildClassDisplayName; getGradeLevelGroupsById | `src/lib/greek-school.ts`, `src/lib/grade-levels.ts` | 📝 | | |
| SYS-CHAT-WIDGET | Student/Instructor | Rich AI chat widget | Markdown + LaTeX (KaTeX) + code highlight (Prism); typing effect; SSE parse from the streaming tutor functions; TutorStatePanel; DOMPurify sanitize | `src/components/chat/ChatWidget.tsx` | 📝 | | |
| SYS-REALTIME | Student | Live progress updates | Supabase channels for study/open-question/flashcard updates; cleanup on unmount; mounted guards | `src/components/StudentStudySession.tsx`, `StudentOpenQuestions.tsx`, `FlashcardViewer.tsx` | 📝 | | |
| SYS-SAFE-IMAGE | All | Graceful image fallbacks | SafeImage tracks failed URLs; renders fallback; dev diagnostic tooltip; crossOrigin anonymous | `src/components/SafeImage.tsx` | 📝 | | |
| SYS-FORMULA-RENDER | All | Render math/chemistry notation | $$/$ LaTeX → KaTeX; nuclear notation + chemical arrows; fallback to raw on failure | `src/components/chat/ChatWidget.tsx`, `src/lib/utils.ts` | 📝 | | |
| SYS-PDF-EXPORT | Instructor/Admin | Export to PDF | convert-md-to-pdf invoked from TestBuilder/QuizReport; full vs student version; spinner; download; toast | `src/components/TestBuilder.tsx`, `supabase/functions/convert-md-to-pdf` | 📝 | | |
| SYS-EDGE-ORCH | All | Server-side edge orchestration | supabase.functions.invoke for AI/processing; SSE or JSON; timeouts; token usage tracked in ai_rate_limit_events | multiple | 📝 | | |

---

## Summary

| Area | # Features |
| --- | --- |
| Auth & Onboarding | 26 |
| Student Learning | 25 |
| Instructor Authoring | 26 |
| Grading & Evaluation | 20 |
| Class & Institution Admin | 30 |
| Super Admin | 13 |
| Cross-Cutting / Platform | 15 |
| **Total** | **155** |

> Notes: `GRD-HANDWRITTEN` is a "Coming Soon" scaffold (🚧). `GRD-EVAL-PDF-EXPORT` is implemented but its UI button is disabled (⚠️) — verified **intentional** (button has `title="Export PDF temporarily disabled"`).

---

## Phase 2 — Test Results & Findings Log

Automated baseline: **Typecheck** = 2 real app-code errors (rest in test files); **ESLint** = 0 app-code errors (168 reported errors are all under `.claude/worktrees/*`, not app code); **Frontend unit tests** = 270/270 pass.

Severity: **L** = Logistical (wrong/broken behavior) · **U** = UX · **S** = Security · **D** = Design ambiguity (needs maintainer decision).
Disposition in Phase 3: **FIX** = fixed this pass · **DOC** = documented, deferred (risky/architectural/needs maintainer alignment).

| # | Sev | Feature | Location | Finding | Disposition |
| --- | --- | --- | --- | --- | --- |
| F1 | L | USR-INVITE | `src/pages/UserManagement.tsx:618` | `fetchData()` called with no arg; `fetchData(institutionId)` early-returns on falsy arg → after auto-adding an existing invited user the member list silently fails to refresh. | ✔️ **FIXED** — now `fetchData(instId)`; typecheck error cleared |
| F2 | U | PROFILE-VIEW / STU-DASHBOARD | `src/pages/StudentDashboard.tsx:511` | "Father's Name" field renders `date_of_birth` (copy-paste bug) instead of `profile.father_name`. | ✔️ **FIXED** — renders `profile.father_name` |
| F3 | U | STU-COURSE-HOME | `src/pages/StudentCourse.tsx:125,1023-1034` | `flashcardsDueCount` state is never populated (no setter call) → "N due" badge always hidden and button always reads "Browse" instead of "Review". | ✔️ **FIXED** — counts due `flashcard_reviews` in `fetchCourseData` |
| F4 | S | CONTACT-SEND | `supabase/functions/send-contact-form/handler.ts:108,117` | User `name`/`subject`/`message` interpolated raw into HTML emails → HTML/markup injection into admin + confirmation emails. | ✔️ **FIXED** — added `escapeHtml()` on all user fields |
| F5 | S | SYS-EDGE-ORCH / GRD-OPEN-Q-AUTO / STU-* AI | `supabase/config.toml` (all fns `verify_jwt=false`), historically e.g. grade-interaction (since deleted) | Edge functions run with service-role key and trust `userId`/`courseId` from the request body without verifying the caller → IDOR (any caller can grade/generate/read for arbitrary users). Systemic. | **DOC** (architectural; needs maintainer-approved auth strategy + full edge-runtime test) |
| F6 | L/S | ADM-YEAR-ROLLOVER | `supabase/functions/academic-year-rollover/index.ts:131-176` | Copies `offerings` but not `course_instructor_sections`; section-restricted instructors lose restrictions on new sections (possible scope creep if "no restriction = all sections"). | **DOC** (edge-fn change, untestable w/o runtime; confirm restriction semantics first) |
| F7 | U | AUTH-RESET / AUTH-CHANGE / AUTH-SIGNUP | Auth.tsx / ChangePasswordDialog / ResetPassword / PasswordStrengthIndicator | Inconsistent password min-length (6 vs 8). | ✔️ **FIXED** — all surfaces mirror the server-enforced Supabase Auth policy (min 8, letters+digits; sign-in stays presence-only for legacy passwords) |
| F8 | U | SYS-ROUTE-GUARD / SYS-ERROR-BOUNDARY | `src/App.tsx:42-66` | No `ProtectedRoute` wrapper (pages self-guard via redirects, so functional but flicker/race-prone) and no top-level `ErrorBoundary` (a thrown render error white-screens the app). | **DOC** (architectural add; pages currently self-guard) |
| F9 | D | INS-ASSIGN-CONTENT / INS-BULK-OPS | `src/hooks/useContentAssignments.ts:108` | `!isBulk` guard means a bulk assignment can never *unassign* a deselected class (additive-only). Differentiated toast suggests this is intentional, but it's undocumented and surprising. | **DOC** (confirm intent) |
| F10 | D | STU-SPACED-REP | `src/components/SpacedRepetitionReview.tsx:289` | Session "correct" counter treats `Hard` rating as correct; debatable vs. SM-2 (Hard is a successful-but-difficult recall, so counting it is defensible). | **DOC** (judgment call) |
| F11 | U | ADM-INST-LOGO | `src/components/InstitutionLogoUpload.tsx:60-66,114-118` | Old-logo storage delete errors are swallowed → orphaned files accumulate; DB/storage can drift. | **DOC** (low impact cleanup) |
| F12 | L | STU-PRACTICE-SETUP | `src/components/StudentQuiz.tsx:93` | `showSetup` hardcoded `false` ("Never show setup screen") → setup screen (include previously-answered questions) is dead/unreachable. | **DOC** (appears intentional product decision) |

### Phase 3 fix scope (this pass)

Fixing the unambiguous, self-contained, low-regression defects with the local toolchain to verify: **F1, F2, F3, F4**. The rest (F5–F12) are documented above for maintainer decision because they are architectural, require the edge runtime to test, or are product/policy judgment calls — per repo policy I do not implement non-trivial behavior/security changes without maintainer direction.
