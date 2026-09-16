import { useState, useEffect } from "react";
import { format } from "date-fns";
import { TrendingUp, TrendingDown, Minus, Bot, User, Sparkles, MessageSquare, Loader2, RefreshCw, Target, CheckCircle2, AlertTriangle, Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";

interface Evaluation {
  id: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  overallAssessment: string;
  hasEnoughData: boolean;
  generatedAt: string;
  instructorFeedback: string | null;
  isManual: boolean;
}

interface CompetencyInsight {
  competencyTitle: string;
  trend: "improving" | "stable" | "declining";
  insight: string;
}

interface TimelineAnalysis {
  summary: string;
  overallTrend: "improving" | "stable" | "declining";
  competencyInsights: CompetencyInsight[];
  strengths: string[];
  areasForImprovement: string[];
  recommendations: string[];
}

interface EvaluationTimelineProps {
  evaluations: Evaluation[];
  studentName: string;
  courseId?: string;
  userId: string;
}

const EvaluationTimeline = ({ evaluations, studentName, courseId, userId }: EvaluationTimelineProps) => {
  const [analysis, setAnalysis] = useState<TimelineAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingCache, setLoadingCache] = useState(true);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [cachedEvaluationCount, setCachedEvaluationCount] = useState<number | null>(null);

  // Sort evaluations from oldest to newest for timeline
  const sortedEvaluations = [...evaluations].sort((a, b) => 
    new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime()
  );

  const fetchCachedAnalysis = async () => {
    if (!courseId || !userId) {
      setLoadingCache(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("evaluation_timeline_cache")
        .select("*")
        .eq("course_id", courseId)
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setAnalysis({
          summary: data.summary,
          overallTrend: data.overall_trend as "improving" | "stable" | "declining",
          competencyInsights: (data.competency_insights as unknown as CompetencyInsight[]) || [],
          strengths: data.strengths || [],
          areasForImprovement: data.areas_for_improvement || [],
          recommendations: data.recommendations || [],
        });
        setGeneratedAt(data.generated_at);
        setCachedEvaluationCount(data.evaluation_count);
      }
    } catch (err) {
      console.error("Error fetching cached analysis:", err);
    } finally {
      setLoadingCache(false);
    }
  };

  const saveAnalysisToCache = async (analysisData: TimelineAnalysis) => {
    if (!courseId || !userId) return;

    try {
      const now = new Date().toISOString();
      // First try to update existing record
      const { data: existing } = await supabase
        .from("evaluation_timeline_cache")
        .select("id")
        .eq("course_id", courseId)
        .eq("user_id", userId)
        .maybeSingle();

      if (existing) {
        // Update existing
        const { error } = await supabase
          .from("evaluation_timeline_cache")
          .update({
            summary: analysisData.summary,
            overall_trend: analysisData.overallTrend,
            competency_insights: JSON.parse(JSON.stringify(analysisData.competencyInsights)) as Json,
            strengths: analysisData.strengths,
            areas_for_improvement: analysisData.areasForImprovement,
            recommendations: analysisData.recommendations,
            evaluation_count: evaluations.length,
            generated_at: now,
            updated_at: now,
          })
          .eq("id", existing.id);

        if (error) throw error;
      } else {
        // Insert new - use raw SQL approach via RPC or direct insert
        const insertData = {
          course_id: courseId,
          user_id: userId,
          summary: analysisData.summary,
          overall_trend: analysisData.overallTrend,
          competency_insights: JSON.parse(JSON.stringify(analysisData.competencyInsights)) as Json,
          strengths: analysisData.strengths,
          areas_for_improvement: analysisData.areasForImprovement,
          recommendations: analysisData.recommendations,
          evaluation_count: evaluations.length,
          generated_at: now,
        };

        const { error } = await supabase
          .from("evaluation_timeline_cache")
          .insert(insertData as any);

        if (error) throw error;
      }

      setGeneratedAt(now);
      setCachedEvaluationCount(evaluations.length);
    } catch (err) {
      console.error("Error saving analysis to cache:", err);
    }
  };

  useEffect(() => {
    fetchCachedAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/userId change
  }, [courseId, userId]);

  const generateAnalysis = async () => {
    if (evaluations.length < 2) return;
    
    setLoading(true);
    setError(null);

    try {
      // Get course language if available
      let language = 'en';
      if (courseId) {
        const { data: courseData } = await supabase
          .from("courses")
          .select("language, institution_id")
          .eq("id", courseId)
          .single();
        
        if (courseData?.language) {
          language = courseData.language;
        } else if (courseData?.institution_id) {
          const { data: institutionData } = await supabase
            .from("institutions")
            .select("default_language")
            .eq("id", courseData.institution_id)
            .single();
          if (institutionData?.default_language) {
            language = institutionData.default_language;
          }
        }
      }

      const { data, error: functionError } = await supabase.functions.invoke("generate-evaluation-timeline", {
        body: {
          evaluations: evaluations.map(e => ({
            id: e.id,
            strengths: e.strengths,
            weaknesses: e.weaknesses,
            recommendations: e.recommendations,
            overallAssessment: e.overallAssessment,
            generatedAt: e.generatedAt,
            instructorFeedback: e.instructorFeedback,
            isManual: e.isManual,
          })),
          language,
        },
      });

      if (functionError) throw functionError;
      
      if (data?.error) {
        throw new Error(data.error);
      }

      setAnalysis(data.analysis);
      
      // Save to cache
      await saveAnalysisToCache(data.analysis);
    } catch (err: any) {
      console.error("Error generating timeline analysis:", err);
      setError(err.message || "Failed to generate analysis");
      toast.error("Failed to generate timeline analysis");
    } finally {
      setLoading(false);
    }
  };

  // Only auto-generate if no cached analysis exists
  useEffect(() => {
    if (!loadingCache && evaluations.length >= 2 && !analysis) {
      generateAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- auto-generate when cache check completes
  }, [loadingCache, evaluations.length, analysis]);

  if (evaluations.length < 2) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>Need at least 2 evaluations to show timeline comparison</p>
      </div>
    );
  }

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case "improving":
        return <TrendingUp className="w-5 h-5 text-green-500" />;
      case "declining":
        return <TrendingDown className="w-5 h-5 text-red-500" />;
      default:
        return <Minus className="w-5 h-5 text-amber-500" />;
    }
  };

  const getTrendColor = (trend: string) => {
    switch (trend) {
      case "improving":
        return "border-green-500 bg-green-500/10 text-green-700 dark:text-green-400";
      case "declining":
        return "border-red-500 bg-red-500/10 text-red-700 dark:text-red-400";
      default:
        return "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    }
  };

  const getSmallTrendIcon = (trend: string) => {
    switch (trend) {
      case "improving":
        return <TrendingUp className="w-4 h-4 text-green-500" />;
      case "declining":
        return <TrendingDown className="w-4 h-4 text-red-500" />;
      default:
        return <Minus className="w-4 h-4 text-amber-500" />;
    }
  };

  const hasNewEvaluations = cachedEvaluationCount !== null && evaluations.length > cachedEvaluationCount;

  return (
    <ScrollArea className="h-[70vh] pr-4">
      <div className="space-y-6">
        {/* AI Analysis Section */}
        {loadingCache ? (
          <Card className="border-primary/20">
            <CardContent className="py-12 flex flex-col items-center justify-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Loading analysis...</p>
            </CardContent>
          </Card>
        ) : loading ? (
          <Card className="border-primary/20">
            <CardContent className="py-12 flex flex-col items-center justify-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Analyzing student progress...</p>
            </CardContent>
          </Card>
        ) : error ? (
          <Card className="border-destructive/20">
            <CardContent className="py-8 flex flex-col items-center justify-center gap-3">
              <AlertTriangle className="w-8 h-8 text-destructive" />
              <p className="text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" onClick={generateAnalysis}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : analysis ? (
          <>
            {/* Progress Summary Card */}
            <Card className={`border-2 ${getTrendColor(analysis.overallTrend)}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4" />
                    AI Progress Analysis: {studentName}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={getTrendColor(analysis.overallTrend)}>
                      {getTrendIcon(analysis.overallTrend)}
                      <span className="ml-1 capitalize">{analysis.overallTrend}</span>
                    </Badge>
                  </div>
                </CardTitle>
                {/* Generated date and regenerate button */}
                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Calendar className="w-3 h-3" />
                    <span>
                      Generated {generatedAt ? format(new Date(generatedAt), "MMM d, yyyy 'at' h:mm a") : "just now"}
                    </span>
                    {hasNewEvaluations && (
                      <Badge variant="secondary" className="text-xs ml-2">
                        {evaluations.length - (cachedEvaluationCount || 0)} new evaluation{evaluations.length - (cachedEvaluationCount || 0) > 1 ? 's' : ''} since
                      </Badge>
                    )}
                  </div>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={generateAnalysis}
                    disabled={loading}
                  >
                    <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                    Regenerate Analysis
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Summary */}
                <p className="text-sm">{analysis.summary}</p>

                {/* Competency Insights */}
                {analysis.competencyInsights.length > 0 && (
                  <div className="p-3 bg-background border rounded-lg">
                    <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                      <Target className="w-4 h-4" />
                      Competency Insights
                    </h4>
                    <div className="space-y-2">
                      {analysis.competencyInsights.map((insight, i) => (
                        <div key={i} className="flex items-start gap-3 p-2 bg-muted/50 rounded-md">
                          <div className="flex-shrink-0 mt-0.5">
                            {getSmallTrendIcon(insight.trend)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-medium">{insight.competencyTitle}</span>
                              <Badge variant="outline" className={`text-xs ${getTrendColor(insight.trend)}`}>
                                {insight.trend}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">{insight.insight}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Strengths */}
                {analysis.strengths.length > 0 && (
                  <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                    <h4 className="text-sm font-medium text-green-700 dark:text-green-400 mb-2 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" />
                      Strengths
                    </h4>
                    <ul className="space-y-1">
                      {analysis.strengths.map((strength, i) => (
                        <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                          <span className="text-green-500 mt-1">✓</span>
                          {strength}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Areas for Improvement */}
                {analysis.areasForImprovement.length > 0 && (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                    <h4 className="text-sm font-medium text-amber-700 dark:text-amber-400 mb-2 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4" />
                      Areas for Improvement
                    </h4>
                    <ul className="space-y-1">
                      {analysis.areasForImprovement.map((area, i) => (
                        <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                          <span className="text-amber-500 mt-1">!</span>
                          {area}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Recommendations */}
                {analysis.recommendations.length > 0 && (
                  <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                    <h4 className="text-sm font-medium text-blue-700 dark:text-blue-400 mb-2 flex items-center gap-2">
                      <Target className="w-4 h-4" />
                      Recommended Next Steps
                    </h4>
                    <ul className="space-y-1">
                      {analysis.recommendations.map((rec, i) => (
                        <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                          <span className="text-blue-500 mt-1">{i + 1}.</span>
                          {rec}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}

        {/* Timeline of Evaluations */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Evaluation History</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[400px] pr-4">
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-[19px] top-0 bottom-0 w-0.5 bg-border" />

                <div className="space-y-4">
                  {sortedEvaluations.map((evaluation, index) => {
                    const isFirst = index === 0;
                    const isLast = index === sortedEvaluations.length - 1;

                    return (
                      <div key={evaluation.id} className="relative pl-12">
                        {/* Timeline dot */}
                        <div className={`absolute left-0 w-10 h-10 rounded-full flex items-center justify-center border-2 bg-background ${
                          isLast ? "border-primary text-primary" : "border-muted-foreground text-muted-foreground"
                        }`}>
                          {evaluation.isManual ? (
                            <User className="w-4 h-4" />
                          ) : (
                            <Bot className="w-4 h-4" />
                          )}
                        </div>

                        {/* Evaluation Card */}
                        <Card className={isLast ? "border-primary" : ""}>
                          <CardContent className="py-3 px-4">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">
                                  {format(new Date(evaluation.generatedAt), "MMMM d, yyyy")}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {format(new Date(evaluation.generatedAt), "h:mm a")}
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                {evaluation.isManual ? (
                                  <Badge variant="outline" className="gap-1 text-xs">
                                    <User className="w-3 h-3" />
                                    Manual
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary" className="gap-1 text-xs">
                                    <Bot className="w-3 h-3" />
                                    AI
                                  </Badge>
                                )}
                                {isLast && <Badge className="text-xs">Latest</Badge>}
                                {isFirst && !isLast && <Badge variant="outline" className="text-xs">First</Badge>}
                              </div>
                            </div>

                            <p className="text-sm text-muted-foreground line-clamp-2">
                              {evaluation.overallAssessment}
                            </p>

                            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <TrendingUp className="w-3 h-3 text-green-500" />
                                {evaluation.strengths.length} strengths
                              </span>
                              <span className="flex items-center gap-1">
                                <TrendingDown className="w-3 h-3 text-amber-500" />
                                {evaluation.weaknesses.length} areas
                              </span>
                              {evaluation.instructorFeedback && (
                                <span className="flex items-center gap-1">
                                  <MessageSquare className="w-3 h-3 text-violet-500" />
                                  Has feedback
                                </span>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      </div>
                    );
                  })}
                </div>
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
};

export default EvaluationTimeline;
