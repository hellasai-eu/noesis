import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { AuthProvider } from "@/hooks/useAuth";
import { hasLegalDocuments } from "@/deployment";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { NewVersionBanner } from "@/components/NewVersionBanner";
import { MfaEnrollmentGate } from "@/components/MfaEnrollmentGate";
import { GlobalFooter } from "@/components/GlobalFooter";
// `/` belongs to the deployment overlay, not to this repository — there is no
// `pages/Index` to import. The default overlay redirects to the sign-in screen;
// a deployment replaces it with whatever it wants a visitor to land on. See
// `deployment/README.md`.
import Landing from "@deployment/Landing";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import InstructorHome from "./pages/InstructorHome";
import InstitutionPage from "./pages/InstitutionPage";
import UserManagement from "./pages/UserManagement";
import RightsRequests from "./pages/RightsRequests";
import AiActivity from "./pages/AiActivity";
import ClassManagement from "./pages/ClassManagement";
import CoursePage from "./pages/CoursePage";
import StudentDashboard from "./pages/StudentDashboard";
import StudentCourse from "./pages/StudentCourse";
import StudentQuizHistory from "./pages/StudentQuizHistory";
import StudentCommunityQuestions from "./pages/StudentCommunityQuestions";
import EvaluatorDashboard from "./pages/EvaluatorDashboard";
import EvaluatorCourse from "./pages/EvaluatorCourse";
import EvaluatorReviewSession from "./pages/EvaluatorReviewSession";
import SuperAdminDashboard from "./pages/SuperAdminDashboard";
import SuperAdminStats from "./pages/SuperAdminStats";
import SuperAdminUsers from "./pages/SuperAdminUsers";
import SuperAdminUsage from "./pages/SuperAdminUsage";
import SuperAdminAI from "./pages/SuperAdminAI";
import VectorStoreAdmin from "./pages/VectorStoreAdmin";
import SuperAdminAgentLogs from "./pages/SuperAdminAgentLogs";
import SuperAdminExport from "./pages/SuperAdminExport";
import SuperAdminVersion from "./pages/SuperAdminVersion";
import SuperAdminBugReports from "./pages/SuperAdminBugReports";
import SelectInstitution from "./pages/SelectInstitution";
import StudentProfile from "./pages/StudentProfile";
import Contact from "./pages/Contact";
import ResetPassword from "./pages/ResetPassword";
import JobsPage from "./pages/JobsPage";
import Legal from "./pages/Legal";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <LocaleProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <NewVersionBanner />
          <MfaEnrollmentGate />
          <BrowserRouter>
            <Analytics />
            <SpeedInsights />
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/select-institution" element={<SelectInstitution />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/instructor" element={<InstructorHome />} />
              <Route path="/student" element={<StudentDashboard />} />
              <Route path="/student/course/:courseId" element={<StudentCourse />} />
              <Route path="/student/course/:courseId/quiz-history" element={<StudentQuizHistory />} />
              <Route path="/student/course/:courseId/community-questions" element={<StudentCommunityQuestions />} />
              <Route path="/evaluator" element={<EvaluatorDashboard />} />
              <Route path="/evaluator/course/:courseId" element={<EvaluatorCourse />} />
              <Route
                path="/evaluator/course/:courseId/review"
                element={<EvaluatorReviewSession />}
              />
              <Route path="/i/:slug" element={<InstitutionPage />} />
              <Route path="/users" element={<UserManagement />} />
              <Route path="/rights-requests" element={<RightsRequests />} />
              <Route path="/ai-activity" element={<AiActivity />} />
              <Route path="/classes" element={<ClassManagement />} />
              <Route path="/course/:courseId" element={<CoursePage />} />
              <Route path="/student/:userId/profile" element={<StudentProfile />} />
              <Route path="/super-admin" element={<SuperAdminDashboard />} />
              <Route path="/super-admin/stats" element={<SuperAdminStats />} />
              <Route path="/super-admin/users" element={<SuperAdminUsers />} />
              <Route path="/super-admin/ai" element={<SuperAdminAI />} />
              <Route path="/super-admin/usage" element={<SuperAdminUsage />} />
              <Route path="/super-admin/vector-stores" element={<VectorStoreAdmin />} />
              <Route path="/super-admin/agent-logs" element={<SuperAdminAgentLogs />} />
              <Route path="/super-admin/export" element={<SuperAdminExport />} />
              <Route path="/super-admin/version" element={<SuperAdminVersion />} />
              <Route path="/super-admin/bug-reports" element={<SuperAdminBugReports />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/jobs" element={<JobsPage />} />
              {/* Public, no session required — a school must be able to read
                  these before anyone has an account (#937).

                  Registered only when the deployment overlay actually publishes
                  documents. An overlay that serves its policies elsewhere sets
                  `languages: []`, and then `/legal` must fall through to the
                  404 rather than render an empty shell that looks like the
                  real thing. */}
              {hasLegalDocuments && (
                <>
                  <Route path="/legal" element={<Legal />} />
                  <Route path="/legal/:slug" element={<Legal />} />
                </>
              )}
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
            {/* The legal links have to be reachable from inside the app too, and
                there is no shared authenticated shell to hang them on — every
                page renders its own nav. So the footer is global, and skips the
                two routes that already end in one (#937). */}
            <GlobalFooter />
          </BrowserRouter>
        </TooltipProvider>
      </LocaleProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
