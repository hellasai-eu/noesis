import { useState, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { School, Search, X, Plus, ChevronDown, ChevronRight, Users, Trash2, Loader2 } from "lucide-react";
import { buildClassDisplayName, getSectionDisplayName } from "@/lib/greek-school";
import { getGradeLevelGroupsById } from "@/lib/grade-levels";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import type { ClassItem } from "./hooks/useClassManagement";

interface Props {
  classes: ClassItem[];
  institutionId: string | null;
  selectedGradeLevel: string | null;
  selectedClassId: string | null;
  onSelectGradeLevel: (gradeLevel: string) => void;
  onSelectClass: (cls: ClassItem) => void;
  onCreateGradeLevel: () => void;
  onDeleteGradeLevel?: (gradeLevel: string) => Promise<void>;
  isAdmin?: boolean;
}

export default function GradeLevelSidebar({
  classes,
  institutionId,
  selectedGradeLevel,
  selectedClassId,
  onSelectGradeLevel,
  onSelectClass,
  onCreateGradeLevel,
  onDeleteGradeLevel,
  isAdmin = false,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedGrades, setExpandedGrades] = useState<Set<string>>(new Set());
  const [deletingGradeLevel, setDeletingGradeLevel] = useState<string | null>(null);
  const gradeLevels = useInstitutionGradeLevels(institutionId);

  const groups = useMemo(
    () => getGradeLevelGroupsById(classes, gradeLevels.rows),
    [classes, gradeLevels.rows],
  );

  // Classes without grade_level_id (haven't been resolved to an FK yet, or
  // truly gradeless generic classes) fall into the "Other classes" bucket.
  const ungroupedClasses = useMemo(
    () => classes.filter((c) => !c.grade_level_id),
    [classes],
  );

  const filteredGroups = useMemo(() => {
    if (!searchQuery) return groups;
    const q = searchQuery.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        classes: g.classes.filter(
          (c) =>
            g.label.toLowerCase().includes(q) ||
            (c.section_name && getSectionDisplayName(g.gradeLevel, c.section_name).toLowerCase().includes(q)) ||
            c.name.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.classes.length > 0);
  }, [groups, searchQuery]);

  const filteredUngrouped = useMemo(() => {
    if (!searchQuery) return ungroupedClasses;
    const q = searchQuery.toLowerCase();
    return ungroupedClasses.filter((c) => c.name.toLowerCase().includes(q));
  }, [ungroupedClasses, searchQuery]);

  const toggleExpand = (gradeLevel: string) => {
    setExpandedGrades((prev) => {
      const next = new Set(prev);
      if (next.has(gradeLevel)) next.delete(gradeLevel);
      else next.add(gradeLevel);
      return next;
    });
  };

  const handleDeleteGradeLevel = async (gradeLevel: string) => {
    if (!onDeleteGradeLevel) return;
    setDeletingGradeLevel(gradeLevel);
    try {
      await onDeleteGradeLevel(gradeLevel);
    } finally {
      setDeletingGradeLevel(null);
    }
  };

  const totalStudents = useMemo(() => {
    // We don't have enrollment counts in the sidebar data, just show section count
    return null;
  }, []);

  const gradeClasses = classes.filter((c) => c.grade_level_id);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <School className="w-5 h-5" />
          Grade Levels
        </CardTitle>
        <CardDescription>
          {filteredGroups.length} grade level{filteredGroups.length !== 1 ? "s" : ""},{" "}
          {gradeClasses.length} section{gradeClasses.length !== 1 ? "s" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search grades or sections..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
              onClick={() => setSearchQuery("")}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>

        {filteredGroups.length === 0 && filteredUngrouped.length === 0 ? (
          <div className="text-center py-8">
            <School className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              {searchQuery ? "No matches found" : "No grade levels yet"}
            </p>
            {!searchQuery && (
              <Button variant="outline" onClick={onCreateGradeLevel}>
                <Plus className="w-4 h-4 mr-2" />
                Create Grade Level
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredGroups.map((group) => {
              const isExpanded = expandedGrades.has(group.gradeLevel);
              const isGradeSelected =
                selectedGradeLevel === group.gradeLevel && !selectedClassId;

              return (
                <div key={group.gradeLevel}>
                  {/* Grade header */}
                  <div
                    className={`group/grade flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                      isGradeSelected
                        ? "bg-primary/10 border border-primary/30"
                        : "hover:bg-secondary/50"
                    }`}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(group.gradeLevel);
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                    <div
                      className="flex-1 min-w-0 flex items-center gap-2"
                      onClick={() => onSelectGradeLevel(group.gradeLevel)}
                    >
                      <span className="font-medium text-sm truncate">{group.label}</span>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {group.classes.length} τμ.
                      </Badge>
                    </div>
                    {isAdmin && onDeleteGradeLevel && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 text-destructive hover:text-destructive opacity-0 group-hover/grade:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteGradeLevel(group.gradeLevel);
                        }}
                        disabled={deletingGradeLevel === group.gradeLevel}
                      >
                        {deletingGradeLevel === group.gradeLevel ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                  </div>

                  {/* Section rows */}
                  {isExpanded && (
                    <div className="ml-6 space-y-1 mt-1">
                      {(() => {
                        // Group sections by category for sub-headers
                        const categories = new Map<string, typeof group.classes>();
                        for (const cls of group.classes) {
                          const cat = cls.category ?? "";
                          if (!categories.has(cat)) categories.set(cat, []);
                          categories.get(cat)!.push(cls);
                        }
                        const hasMultipleCategories = categories.size > 1;

                        return Array.from(categories.entries()).map(([cat, classes]) => (
                          <div key={cat}>
                            {hasMultipleCategories && (
                              <p className="text-xs text-muted-foreground px-2 pt-1 pb-0.5 font-medium">
                                {cat || "Default"}
                              </p>
                            )}
                            {classes.map((cls) => {
                              const displayName = cls.section_name
                                ? getSectionDisplayName(group.gradeLevel, cls.section_name)
                                : cls.name;
                              return (
                                <div
                                  key={cls.id}
                                  className={`flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors text-sm ${
                                    selectedClassId === cls.id
                                      ? "bg-primary/10 border border-primary/30"
                                      : "hover:bg-secondary/50"
                                  }`}
                                  onClick={() => onSelectClass(cls)}
                                >
                                  <Users className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                  <span className="truncate">
                                    Τμήμα {displayName}
                                    {cls.category && (
                                      <span className="text-muted-foreground ml-1">({cls.category})</span>
                                    )}
                                  </span>
                                  {!cls.is_active && (
                                    <Badge variant="secondary" className="text-xs shrink-0">
                                      Inactive
                                    </Badge>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ));
                      })()}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Ungrouped classes */}
            {filteredUngrouped.length > 0 && (
              <>
                {filteredGroups.length > 0 && (
                  <div className="border-t my-2" />
                )}
                <p className="text-xs text-muted-foreground px-2 py-1">Other classes</p>
                {filteredUngrouped.map((cls) => (
                  <div
                    key={cls.id}
                    className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                      selectedClassId === cls.id
                        ? "bg-primary/10 border border-primary/30"
                        : "hover:bg-secondary/50"
                    }`}
                    onClick={() => onSelectClass(cls)}
                  >
                    <School className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm truncate">{buildClassDisplayName(cls)}</span>
                    <Badge
                      variant={cls.is_active ? "default" : "secondary"}
                      className="text-xs shrink-0 ml-auto"
                    >
                      {cls.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* Create button at bottom */}
        {(filteredGroups.length > 0 || filteredUngrouped.length > 0) && (
          <Button variant="outline" className="w-full" onClick={onCreateGradeLevel}>
            <Plus className="w-4 h-4 mr-2" />
            Add Grade Level
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
