import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  School,
  UsersRound,
  Search,
  X,
  Plus,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { ClassItem } from "./hooks/useClassManagement";
import { buildClassDisplayName } from "@/lib/greek-school";

interface Props {
  classes: ClassItem[];
  selectedClassId: string | null;
  onSelectClass: (cls: ClassItem) => void;
  onCreateClass: () => void;
}

const CLASSES_PER_PAGE = 10;

export default function ClassListSidebar({
  classes,
  selectedClassId,
  onSelectClass,
  onCreateClass,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const filteredClasses = classes.filter((cls) => {
    const searchLower = searchQuery.toLowerCase();
    return (
      !searchQuery ||
      buildClassDisplayName(cls).toLowerCase().includes(searchLower) ||
      cls.academic_period?.toLowerCase().includes(searchLower)
    );
  });

  const totalPages = Math.ceil(filteredClasses.length / CLASSES_PER_PAGE);
  const paginatedClasses = filteredClasses.slice(
    (currentPage - 1) * CLASSES_PER_PAGE,
    currentPage * CLASSES_PER_PAGE,
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UsersRound className="w-5 h-5" />
          Classes
        </CardTitle>
        <CardDescription>
          {filteredClasses.length} of {classes.length} class{classes.length !== 1 ? "es" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name..."
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
        </div>

        {classes.length === 0 ? (
          <div className="text-center py-8">
            <School className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground mb-4">No classes yet</p>
            <Button variant="outline" onClick={onCreateClass}>
              <Plus className="w-4 h-4 mr-2" />
              Create First Class
            </Button>
          </div>
        ) : filteredClasses.length === 0 ? (
          <div className="text-center py-8">
            <Search className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No classes match your search</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {paginatedClasses.map((cls) => (
                <div
                  key={cls.id}
                  className={`p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedClassId === cls.id
                      ? "bg-primary/10 border border-primary/30"
                      : "bg-secondary/50 hover:bg-secondary"
                  }`}
                  onClick={() => onSelectClass(cls)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                        <School className="w-4 h-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{buildClassDisplayName(cls)}</p>
                        {cls.academic_period && (
                          <p className="text-xs text-muted-foreground truncate">
                            {cls.academic_period}
                          </p>
                        )}
                      </div>
                    </div>
                    <Badge
                      variant={cls.is_active ? "default" : "secondary"}
                      className="text-xs shrink-0"
                    >
                      {cls.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((p) => p + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
