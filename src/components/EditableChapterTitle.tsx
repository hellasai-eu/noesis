import { useState, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pencil, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface EditableChapterTitleProps {
  chapterId: string;
  title: string;
  canEdit: boolean;
  onSaved: (newTitle: string) => void;
  className?: string;
}

export function EditableChapterTitle({
  chapterId,
  title,
  canEdit,
  onSaved,
  className = "",
}: EditableChapterTitleProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    setValue(title);
  }, [title]);

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error("Chapter title cannot be empty");
      return;
    }
    if (trimmed === title) {
      setValue(title);
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from("material_chapters")
        .update({ title: trimmed })
        .eq("id", chapterId);

      if (error) throw error;

      onSaved(trimmed);
      setEditing(false);
      toast.success("Chapter title updated");
    } catch (error: any) {
      toast.error(error.message || "Failed to update chapter title");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setValue(title);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") handleCancel();
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-7 text-sm py-0 px-2"
          disabled={saving}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Check className="w-3.5 h-3.5 text-green-600" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={handleCancel}
          disabled={saving}
        >
          <X className="w-3.5 h-3.5 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1.5 group ${className}`}>
      <span className="truncate">{title}</span>
      {canEdit && (
        <button
          onClick={() => setEditing(true)}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-secondary"
        >
          <Pencil className="w-3 h-3 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
