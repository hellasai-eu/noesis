import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { LANGUAGE_OPTIONS } from "@/lib/language-options";
import type { GradeLevelOption } from "@/lib/grade-levels";

interface CreateCourseData {
  title: string;
  description: string;
  theme: string;
  language: string;
  grade_level: string;
  category: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gradeLevel: string;
  gradeLevels: GradeLevelOption[];
  defaultLanguage: string;
  categories: string[];
  onCreate: (data: CreateCourseData) => Promise<void>;
}

export default function CreateCourseDialog({
  open,
  onOpenChange,
  gradeLevel,
  gradeLevels,
  defaultLanguage,
  categories,
  onCreate,
}: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [theme, setTheme] = useState("");
  const [language, setLanguage] = useState(defaultLanguage);
  const [selectedGrade, setSelectedGrade] = useState(gradeLevel);
  const [selectedCategory, setSelectedCategory] = useState("Default");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setTheme("");
      setLanguage(defaultLanguage);
      setSelectedGrade(gradeLevel);
      setSelectedCategory("Default");
    }
  }, [open, gradeLevel, defaultLanguage]);

  useEffect(() => {
    setSelectedCategory("Default");
  }, [selectedGrade]);

  const handleOpenChange = (v: boolean) => {
    onOpenChange(v);
  };

  const canSubmit = title.trim().length > 0 && selectedGrade.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim(),
        theme: theme.trim(),
        language,
        grade_level: selectedGrade,
        category: selectedCategory,
      });
      handleOpenChange(false);
    } catch {
      // Error handled by parent
    } finally {
      setCreating(false);
    }
  };

  const categoryOptions = ["Default", ...categories.filter((c) => c !== "Default")];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Course</DialogTitle>
          <DialogDescription>
            Create a course and auto-attach it to matching sections in the selected grade and category.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="course-grade">Grade Level *</Label>
            <Select value={selectedGrade} onValueChange={setSelectedGrade}>
              <SelectTrigger id="course-grade">
                <SelectValue placeholder="Select grade level" />
              </SelectTrigger>
              <SelectContent>
                {gradeLevels.map((gl) => (
                  <SelectItem key={gl.value} value={gl.value}>
                    {defaultLanguage === "el" ? gl.labelEl : gl.labelEn}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!selectedGrade && (
              <p className="text-xs text-destructive">Please select a grade level</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="course-category">Category *</Label>
            <Select
              value={selectedCategory}
              onValueChange={setSelectedCategory}
            >
              <SelectTrigger id="course-category">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Offerings will be auto-created for sections matching this category
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="course-title">Title *</Label>
            <Input
              id="course-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Mathematics, History"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="course-description">Description</Label>
            <Textarea
              id="course-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional course description"
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="course-theme">Theme</Label>
            <Input
              id="course-theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="e.g., STEM, Humanities"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="course-language">Language</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger>
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => handleOpenChange(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={creating || !canSubmit}
            >
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Creating...
                </>
              ) : (
                "Create Course"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
