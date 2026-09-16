/**
 * Class selector shared by the Class Performance rosters, mirroring the
 * "All Classes" filter Student 360 renders: pick a class to scope the
 * roster to assignments targeting that class's offering.
 */
import { GraduationCap } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildClassDisplayName } from "@/lib/greek-school";

export interface PerformanceClass {
  id: string;
  name: string;
  grade_level_id: string | null;
  section_name: string;
  category: string | null;
  academic_period: string | null;
  offering_id: string;
}

interface ClassFilterSelectProps {
  classes: PerformanceClass[];
  /** Selected class id, or "all". */
  value: string;
  onChange: (classId: string) => void;
}

export const ClassFilterSelect = ({ classes, value, onChange }: ClassFilterSelectProps) => {
  if (classes.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <GraduationCap className="w-4 h-4 text-muted-foreground" />
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-[220px]">
          <SelectValue placeholder="Filter by class" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Classes</SelectItem>
          {classes.map((cls) => (
            <SelectItem key={cls.id} value={cls.id}>
              {buildClassDisplayName(cls)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
