import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { 
  BookOpen, 
  Users, 
  FileText, 
  Shield, 
  ArrowRight, 
  GraduationCap, 
  BarChart3, 
  Brain,
  Clock,
  CheckCircle2,
  Sparkles,
  LayoutDashboard
} from "lucide-react";
import { SiteFooter } from "@/components/SiteFooter";


const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <Link to="/" className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gold flex items-center justify-center">
                <BookOpen className="w-6 h-6 text-foreground" />
              </div>
              <span className="text-2xl font-display font-bold text-foreground">Noesis</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link to="/auth">
                <Button variant="outline" size="lg">
                  Sign In
                </Button>
              </Link>
              <Link to="/auth">
                <Button variant="default" size="lg">
                  Get Started
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <header className="pt-32 pb-20 gradient-hero relative overflow-hidden">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PHBhdGggZD0iTTM2IDM0djItSDI0di0yaDEyek0zNiAyNHYySDI0di0yaDEyeiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />
        
        <div className="container mx-auto px-6 relative z-10">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="animate-fade-up">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gold/20 text-gold mb-6">
                <Sparkles className="w-4 h-4" />
                <span className="text-sm font-medium">AI-Powered Learning Platform</span>
              </div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-display font-bold text-primary-foreground leading-tight mb-6">
                Where Knowledge Meets{" "}
                <span className="text-gold">Innovation</span>
              </h1>
              <p className="text-xl text-primary-foreground/80 mb-8 leading-relaxed">
                An educational platform grounded in real classroom content. Noesis transforms your 
                existing course materials into interactive quizzes and study tools—ensuring students 
                learn from trusted, instructor-approved content.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <Link to="/auth">
                  <Button variant="gold" size="xl" className="group w-full sm:w-auto">
                    Start Learning
                    <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-1" />
                  </Button>
                </Link>
                <Link to="/auth">
                  <Button variant="heroOutline" size="xl" className="w-full sm:w-auto">
                    For Institutions
                  </Button>
                </Link>
              </div>
            </div>
            
            {/* Platform Preview Mockup */}
            <div className="animate-fade-up" style={{ animationDelay: "0.2s" }}>
              <div className="relative">
                <div className="absolute -inset-4 bg-gradient-to-r from-gold/20 to-primary/20 rounded-2xl blur-2xl" />
                <div className="relative rounded-xl overflow-hidden shadow-2xl border border-primary-foreground/10 bg-card">
                  {/* Mockup Header */}
                  <div className="bg-primary px-4 py-3 flex items-center gap-3">
                    <div className="flex gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-destructive/80" />
                      <div className="w-3 h-3 rounded-full bg-gold/80" />
                      <div className="w-3 h-3 rounded-full bg-green-500/80" />
                    </div>
                    <div className="flex-1 flex justify-center">
                      <div className="bg-primary-foreground/10 rounded-md px-4 py-1 text-xs text-primary-foreground/60">
                        dianoisis.net/dashboard
                      </div>
                    </div>
                  </div>
                  {/* Mockup Content */}
                  <div className="p-4 flex gap-4">
                    {/* Sidebar */}
                    <div className="w-48 bg-secondary rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2 p-2 bg-primary/10 rounded-md">
                        <LayoutDashboard className="w-4 h-4 text-primary" />
                        <span className="text-xs font-medium text-foreground">Dashboard</span>
                      </div>
                      <div className="flex items-center gap-2 p-2 text-muted-foreground">
                        <BookOpen className="w-4 h-4" />
                        <span className="text-xs">Courses</span>
                      </div>
                      <div className="flex items-center gap-2 p-2 text-muted-foreground">
                        <Users className="w-4 h-4" />
                        <span className="text-xs">Students</span>
                      </div>
                      <div className="flex items-center gap-2 p-2 text-muted-foreground">
                        <BarChart3 className="w-4 h-4" />
                        <span className="text-xs">Analytics</span>
                      </div>
                    </div>
                    {/* Main Content */}
                    <div className="flex-1 space-y-4">
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-secondary rounded-lg p-3">
                          <div className="text-xs text-muted-foreground mb-1">Active Courses</div>
                          <div className="text-2xl font-display font-bold text-foreground">12</div>
                        </div>
                        <div className="bg-secondary rounded-lg p-3">
                          <div className="text-xs text-muted-foreground mb-1">Students</div>
                          <div className="text-2xl font-display font-bold text-foreground">248</div>
                        </div>
                        <div className="bg-secondary rounded-lg p-3">
                          <div className="text-xs text-muted-foreground mb-1">Quizzes</div>
                          <div className="text-2xl font-display font-bold text-foreground">56</div>
                        </div>
                      </div>
                      <div className="bg-secondary rounded-lg p-3">
                        <div className="text-xs font-medium text-foreground mb-2">Recent Activity</div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-gold" />
                            <span className="text-xs text-muted-foreground">Quiz completed by Maria K.</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-primary" />
                            <span className="text-xs text-muted-foreground">New chapter added to Physics 101</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-gold" />
                            <span className="text-xs text-muted-foreground">15 questions generated</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background to-transparent" />
      </header>

      {/* Grounded Education Section */}
      <section className="py-24 bg-background">
        <div className="container mx-auto px-6">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div className="animate-fade-up">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary mb-6">
                <BookOpen className="w-4 h-4" />
                <span className="text-sm font-medium">Classroom-First Approach</span>
              </div>
              <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground mb-6">
                Education Grounded in Your Classroom Content
              </h2>
              <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
                Unlike generic learning platforms, Noesis builds everything from your actual course 
                materials. Every quiz question, flashcard, and cheat sheet is derived directly from 
                instructor-provided content—ensuring relevance and accuracy.
              </p>
              <div className="space-y-4">
                {[
                  { title: "Material-Based Questions", desc: "AI generates questions exclusively from your uploaded course materials" },
                  { title: "Instructor Control", desc: "Teachers review and approve all AI-generated content before students see it" },
                  { title: "Curriculum Aligned", desc: "Study tools match exactly what students need to learn in class" },
                ].map((item, index) => (
                  <div key={item.title} className="flex gap-4">
                    <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-gold/20 flex items-center justify-center">
                      <CheckCircle2 className="w-5 h-5 text-gold" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-foreground">{item.title}</h4>
                      <p className="text-sm text-muted-foreground">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="animate-fade-up" style={{ animationDelay: "0.2s" }}>
              <div className="relative p-8 rounded-2xl bg-card border border-border">
                <div className="absolute -top-3 -right-3 px-3 py-1 rounded-full bg-gold text-foreground text-xs font-semibold">
                  Grounded Learning
                </div>
                <div className="space-y-6">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <FileText className="w-6 h-6 text-primary" />
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-foreground mb-1">Course Materials</div>
                      <div className="h-2 bg-primary/20 rounded-full">
                        <div className="h-full w-full bg-primary rounded-full" />
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Your PDFs, notes & chapters</div>
                    </div>
                  </div>
                  <div className="flex justify-center">
                    <ArrowRight className="w-5 h-5 text-muted-foreground rotate-90" />
                  </div>
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-lg bg-gold/20 flex items-center justify-center flex-shrink-0">
                      <Brain className="w-6 h-6 text-gold" />
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-foreground mb-1">AI Processing</div>
                      <div className="h-2 bg-gold/20 rounded-full">
                        <div className="h-full w-3/4 bg-gold rounded-full animate-pulse" />
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Extracts key concepts & generates questions</div>
                    </div>
                  </div>
                  <div className="flex justify-center">
                    <ArrowRight className="w-5 h-5 text-muted-foreground rotate-90" />
                  </div>
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                      <GraduationCap className="w-6 h-6 text-green-600" />
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-foreground mb-1">Student Learning</div>
                      <div className="h-2 bg-green-500/20 rounded-full">
                        <div className="h-full w-full bg-green-500 rounded-full" />
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Quizzes, flashcards & cheat sheets</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* User Types Section */}
      <section className="py-24 bg-secondary">
        <div className="container mx-auto px-6">
          <div className="text-center mb-16 animate-fade-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground mb-4">
              Built for Everyone in Education
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Whether you're running an institution, teaching courses, or learning new skills, 
              Noesis has the tools you need.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {/* Institutions */}
            <div 
              className="group p-8 rounded-2xl bg-card border border-border hover:shadow-elegant transition-all duration-300 animate-fade-up"
              style={{ animationDelay: "0.1s" }}
            >
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6 group-hover:bg-gold/20 transition-colors">
                <Shield className="w-8 h-8 text-primary group-hover:text-gold transition-colors" />
              </div>
              <h3 className="text-2xl font-display font-semibold text-foreground mb-3">
                For Institutions
              </h3>
              <p className="text-muted-foreground mb-6 leading-relaxed">
                Manage your entire educational ecosystem. Create departments, invite staff, 
                and maintain complete control over your courses and content.
              </p>
              <ul className="space-y-3">
                {["Private institutional portals", "Role-based access control", "Centralized user management", "Branded experience"].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 text-gold flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Instructors */}
            <div 
              className="group p-8 rounded-2xl bg-card border border-border hover:shadow-elegant transition-all duration-300 animate-fade-up"
              style={{ animationDelay: "0.2s" }}
            >
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6 group-hover:bg-gold/20 transition-colors">
                <GraduationCap className="w-8 h-8 text-primary group-hover:text-gold transition-colors" />
              </div>
              <h3 className="text-2xl font-display font-semibold text-foreground mb-3">
                For Instructors
              </h3>
              <p className="text-muted-foreground mb-6 leading-relaxed">
                Focus on teaching, not admin work. Upload materials, generate AI-powered quizzes, 
                and track student performance with ease.
              </p>
              <ul className="space-y-3">
                {["AI question generation", "Material chapter organization", "Student progress tracking", "Custom quiz creation"].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 text-gold flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Students */}
            <div 
              className="group p-8 rounded-2xl bg-card border border-border hover:shadow-elegant transition-all duration-300 animate-fade-up"
              style={{ animationDelay: "0.3s" }}
            >
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6 group-hover:bg-gold/20 transition-colors">
                <Brain className="w-8 h-8 text-primary group-hover:text-gold transition-colors" />
              </div>
              <h3 className="text-2xl font-display font-semibold text-foreground mb-3">
                For Students
              </h3>
              <p className="text-muted-foreground mb-6 leading-relaxed">
                Learn at your own pace with structured materials and intelligent quizzes 
                that adapt to your progress and help you master every topic.
              </p>
              <ul className="space-y-3">
                {["Interactive quiz practice", "Progress tracking", "Material access anywhere"].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 text-gold flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-24 bg-background">
        <div className="container mx-auto px-6">
          <div className="text-center mb-16 animate-fade-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground mb-4">
              Powerful Features, Simple Experience
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Everything you need to create, deliver, and assess educational content effectively.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: FileText,
                title: "Smart Materials",
                description: "Organize content into chapters with PDF parsing and text extraction.",
              },
              {
                icon: Brain,
                title: "AI Quiz Generation",
                description: "Generate questions automatically from your course materials using AI.",
              },
              {
                icon: Clock,
                title: "Timed Assessments",
                description: "Create timed quizzes with automatic submission when time runs out.",
              },
              {
                icon: BarChart3,
                title: "Analytics & Insights",
                description: "Track student performance with detailed statistics and reports.",
              },
              {
                icon: Users,
                title: "Team Management",
                description: "Invite instructors and students with role-based permissions.",
              },
              {
                icon: BookOpen,
                title: "Course Organization",
                description: "Structure courses with tags, themes, and cover images.",
              },
            ].map((feature, index) => (
              <div
                key={feature.title}
                className="p-6 rounded-xl bg-card border border-border hover:shadow-elegant transition-all duration-300 animate-fade-up"
                style={{ animationDelay: `${0.1 + index * 0.05}s` }}
              >
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <feature.icon className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-lg font-display font-semibold text-foreground mb-2">
                  {feature.title}
                </h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section className="py-24 bg-secondary">
        <div className="container mx-auto px-6">
          <div className="text-center mb-16 animate-fade-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground mb-4">
              Simple, Transparent Pricing
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              From free student access to full enterprise solutions. Choose the plan that fits your needs.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Free Tier */}
            <div className="p-6 rounded-2xl bg-card border-2 border-green-500/50 relative animate-fade-up">
              <div className="absolute -top-3 left-6 px-3 py-1 rounded-full bg-green-500 text-white text-xs font-semibold">
                Free
              </div>
              <div className="pt-4">
                <h3 className="text-xl font-display font-bold text-foreground mb-1">Student</h3>
                <div className="flex items-baseline gap-1 mb-4">
                  <span className="text-3xl font-display font-bold text-foreground">FREE</span>
                  <span className="text-muted-foreground">/forever</span>
                </div>
                <p className="text-sm text-muted-foreground mb-6">
                  Access to pre-generated, evergreen content.
                </p>
                <div className="space-y-3 mb-6">
                  <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Includes</p>
                  {[
                    "Library of pre-made quizzes",
                    "Basic practice mode",
                    "20 questions/day limit",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
                <Link to="/auth">
                  <Button variant="outline" className="w-full">Get Started</Button>
                </Link>
              </div>
            </div>

            {/* Teacher Tier */}
            <div className="p-6 rounded-2xl bg-card border-2 border-amber-500/50 relative animate-fade-up" style={{ animationDelay: "0.1s" }}>
              <div className="absolute -top-3 left-6 px-3 py-1 rounded-full bg-amber-500 text-white text-xs font-semibold">
                Popular
              </div>
              <div className="pt-4">
                <h3 className="text-xl font-display font-bold text-foreground mb-1">Teacher</h3>
                <div className="flex items-baseline gap-1 mb-4">
                  <span className="text-3xl font-display font-bold text-foreground">€10</span>
                  <span className="text-muted-foreground">/month</span>
                </div>
                <p className="text-sm text-muted-foreground mb-6">
                  Perfect for individual teachers wanting more control.
                  <span className="block text-xs text-muted-foreground/70 mt-1 italic">*For one course</span>
                </p>
                <div className="space-y-3 mb-6">
                  <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Includes</p>
                  {[
                    "Create custom quizzes",
                    "AI question generation",
                    "Classroom game modes",
                    "Export results",
                    "3 PDF uploads/month",
                    "Limited AI explanations",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
                <Link to="/auth">
                  <Button variant="default" className="w-full">Start Free Trial</Button>
                </Link>
              </div>
            </div>

            {/* School Pro Tier */}
            <div className="p-6 rounded-2xl bg-card border-2 border-orange-500/50 relative animate-fade-up" style={{ animationDelay: "0.2s" }}>
              <div className="absolute -top-3 left-6 px-3 py-1 rounded-full bg-orange-500 text-white text-xs font-semibold">
                Best Value
              </div>
              <div className="pt-4">
                <h3 className="text-xl font-display font-bold text-foreground mb-1">School</h3>
                <div className="flex items-baseline gap-1 mb-4">
                  <span className="text-3xl font-display font-bold text-foreground">€100</span>
                  <span className="text-muted-foreground">/student/year</span>
                </div>
                <p className="text-sm text-muted-foreground mb-6">
                  Everything schools need to transform learning.
                  <span className="block text-xs text-muted-foreground/70 mt-1 italic">*Volume discounts available</span>
                </p>
                <div className="space-y-3 mb-6">
                  <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Everything in Teacher, plus</p>
                  {[
                    "Unlimited AI questions",
                    "Unlimited PDF ingestion",
                    "AI tutor mode",
                    "Mastery & adaptive tracking",
                    "Full gamification",
                    "LMS integration",
                    "Parent progress reports",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
                <Link to="/auth">
                  <Button variant="gold" className="w-full">Contact Sales</Button>
                </Link>
              </div>
            </div>

            {/* Enterprise Tier */}
            <div className="p-6 rounded-2xl bg-card border-2 border-red-500/50 relative animate-fade-up" style={{ animationDelay: "0.3s" }}>
              <div className="absolute -top-3 left-6 px-3 py-1 rounded-full bg-red-500 text-white text-xs font-semibold">
                Enterprise
              </div>
              <div className="pt-4">
                <h3 className="text-xl font-display font-bold text-foreground mb-1">School Pro</h3>
                <div className="flex items-baseline gap-1 mb-4">
                  <span className="text-3xl font-display font-bold text-foreground">Contact Us</span>
                </div>
                <p className="text-sm text-muted-foreground mb-6">
                  For international & private schools with custom needs.
                </p>
                <div className="space-y-3 mb-6">
                  <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Everything in Pro, plus</p>
                  {[
                    "Custom curriculum alignment",
                    "Dedicated onboarding",
                    "Per-school AI fine-tuning",
                    "Priority support",
                    "Analytics API",
                    "School-wide tournaments",
                    "SSO + admin console",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
                <Link to="/auth">
                  <Button variant="outline" className="w-full">Contact Sales</Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 gradient-hero relative overflow-hidden">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PHBhdGggZD0iTTM2IDM0djItSDI0di0yaDEyek0zNiAyNHYySDI0di0yaDEyeiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />
        
        <div className="container mx-auto px-6 relative z-10">
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="text-3xl md:text-4xl font-display font-bold text-primary-foreground mb-6">
              Ready to Transform Your Learning Experience?
            </h2>
            <p className="text-xl text-primary-foreground/80 mb-10">
              Join institutions and educators already using Noesis to deliver 
              exceptional educational experiences.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link to="/auth">
                <Button variant="gold" size="xl" className="group w-full sm:w-auto">
                  Get Started Free
                  <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-1" />
                </Button>
              </Link>
              <Link to="/contact">
                <Button variant="heroOutline" size="xl" className="w-full sm:w-auto">
                  Contact Us
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* The same footer the rest of the app gets, in the landing page's tone.
          The legal links come from the compliance set, so adding a document
          there puts it here without editing this file (#937). */}
      <SiteFooter tone="brand" />
    </div>
  );
};

export default Index;
