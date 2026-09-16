import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, Clock } from "lucide-react";

interface HandwrittenTestGradingProps {
  courseId: string;
}

export function HandwrittenTestGrading({ courseId }: HandwrittenTestGradingProps) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <FileText className="w-8 h-8 text-primary" />
        </div>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-lg font-semibold">Handwritten Test Grading</h3>
          <Badge variant="secondary" className="gap-1">
            <Clock className="w-3 h-3" />
            Coming Soon
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground max-w-md">
          AI-powered grading for handwritten tests and exams. Upload scanned tests, 
          and let AI extract answers, grade responses, and provide detailed feedback.
        </p>
      </CardContent>
    </Card>
  );
}
