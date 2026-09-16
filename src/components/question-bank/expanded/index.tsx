import type { UnifiedQuestion } from "@/lib/unified-question";
import { McqExpandedPanel } from "./McqExpandedPanel";
import { OpenExpandedPanel } from "./OpenExpandedPanel";
import { FillGapsExpandedPanel } from "./FillGapsExpandedPanel";
import { OrderingExpandedPanel } from "./OrderingExpandedPanel";
import { ClassificationExpandedPanel } from "./ClassificationExpandedPanel";

interface QuestionExpandedPanelProps {
  question: UnifiedQuestion;
  onClose: () => void;
  isAdmin: boolean;
}

/**
 * Dispatches on `question.type` to render the right expanded panel.
 * Centralizing the switch means the unified table never has to know about
 * type-specific payload shapes.
 */
export function QuestionExpandedPanel(props: QuestionExpandedPanelProps) {
  switch (props.question.type) {
    case "mcq":
      return <McqExpandedPanel {...props} />;
    case "open":
      return <OpenExpandedPanel {...props} />;
    case "fill_gaps":
      return <FillGapsExpandedPanel {...props} />;
    case "ordering":
      return <OrderingExpandedPanel {...props} />;
    case "classification":
      return <ClassificationExpandedPanel {...props} />;
  }
}

export {
  McqExpandedPanel,
  OpenExpandedPanel,
  FillGapsExpandedPanel,
  OrderingExpandedPanel,
  ClassificationExpandedPanel,
};
