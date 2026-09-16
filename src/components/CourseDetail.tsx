import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  FileText,
  Upload,
  Trash2,
  Download,
  Loader2,
  X,
  File,
  Eye,
  ChevronDown,
  ChevronRight,
  BookOpen,
  Link as LinkIcon,
  Image,
  FileType,
  Plus,
  Cloud,
  CloudOff,
  Power,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  MaterialUploadDialog,
  MATERIAL_TYPE_LABELS,
  CHAPTERLESS_MATERIAL_TYPES,
  MaterialType,
} from "./MaterialUploadDialog";
import { blockedReclassificationReason } from "@/lib/material-chapters";
import { isImageFile } from "@/lib/material-files";
import { ImageUploadDialog } from "./ImageUploadDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChapterStudyMaterialsManager } from "./ChapterStudyMaterialsManager";
import { EditableChapterTitle } from "./EditableChapterTitle";
import { useFormatters } from "@/i18n/formatters";

interface Course {
  id: string;
  title: string;
  description: string | null;
  theme: string | null;
  institution_id: string;
  language?: string | null;
}

interface CourseMaterial {
  id: string;
  file_name: string;
  file_url: string;
  file_size: number | null;
  created_at: string;
  title: string | null;
  author: string | null;
  thumbnail_url: string | null;
  material_type: MaterialType;
  openai_file_id: string | null;
  ai_description: string | null;
  is_moderated: boolean;
}

interface MaterialChapter {
  id: string;
  material_id: string;
  chapter_number: number;
  title: string;
  content_type: string;
  content: string | null;
  file_url: string | null;
  file_name: string | null;
  cheat_sheet: string | null;
  flashcards: any | null;
  cheat_sheet_visible: boolean;
  flashcards_visible: boolean;
}

interface CourseDetailProps {
  course: Course | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
}

export function CourseDetail({ course, open, onOpenChange, isAdmin }: CourseDetailProps) {
  const { formatDate } = useFormatters();
  const { user } = useAuth();
  const [materials, setMaterials] = useState<CourseMaterial[]>([]);
  const [materialChapters, setMaterialChapters] = useState<Record<string, MaterialChapter[]>>({});
  const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());
  const [loadingChapters, setLoadingChapters] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [previewMaterial, setPreviewMaterial] = useState<CourseMaterial | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [imageUploadDialogOpen, setImageUploadDialogOpen] = useState(false);
  const [updatingMaterialType, setUpdatingMaterialType] = useState<string | null>(null);

  const [syncingMaterial, setSyncingMaterial] = useState<string | null>(null);

  const handleMaterialTypeChange = async (materialId: string, newType: MaterialType) => {
    setUpdatingMaterialType(materialId);
    try {
      const current = materials.find(m => m.id === materialId)?.material_type;
      if (current) {
        const blocked = await blockedReclassificationReason(materialId, current, newType);
        if (blocked) {
          toast.error(blocked);
          return;
        }
      }

      const { error } = await supabase
        .from("course_materials")
        .update({ material_type: newType })
        .eq("id", materialId);

      if (error) throw error;

      setMaterials(prev => prev.map(m => 
        m.id === materialId ? { ...m, material_type: newType } : m
      ));
      toast.success("Material type updated");
    } catch (error: any) {
      console.error("Error updating material type:", error);
      toast.error("Failed to update material type");
    } finally {
      setUpdatingMaterialType(null);
    }
  };

  const handleSyncToOpenAI = async (material: CourseMaterial) => {
    setSyncingMaterial(material.id);
    try {
      const { data, error } = await supabase.functions.invoke("upload-to-openai", {
        body: {
          materialId: material.id,
          filePath: material.file_url,
          fileName: material.file_name,
        },
      });

      if (error) throw error;
      
      if (data?.openaiFileId) {
        setMaterials(prev => prev.map(m => 
          m.id === material.id ? { ...m, openai_file_id: data.openaiFileId } : m
        ));
        toast.success("Synced to OpenAI successfully");
      }
    } catch (error: any) {
      console.error("Error syncing to OpenAI:", error);
      toast.error(error.message || "Failed to sync to OpenAI");
    } finally {
      setSyncingMaterial(null);
    }
  };

  useEffect(() => {
    if (course && open) {
      fetchMaterials();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch when course/open changes
  }, [course, open]);

  const fetchMaterials = async () => {
    if (!course) return;
    setLoading(true);

    try {
      const { data, error } = await supabase
        .from("course_materials")
        .select("*")
        .eq("course_id", course.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setMaterials((data || []).map(m => ({
        ...m,
        material_type: (m.material_type as MaterialType) || 'textbook'
      })));
    } catch (error: any) {
      console.error("Error fetching materials:", error);
      toast.error("Failed to load materials");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteMaterial = async (material: CourseMaterial) => {
    if (!confirm("Are you sure you want to delete this file?")) return;

    try {
      const { error: storageError } = await supabase.storage
        .from("course-materials")
        .remove([material.file_url]);

      if (storageError) {
        console.error("Storage delete error:", storageError);
      }

      const { error: dbError } = await supabase
        .from("course_materials")
        .delete()
        .eq("id", material.id);

      if (dbError) throw dbError;

      setMaterials(materials.filter((m) => m.id !== material.id));
      toast.success("File deleted");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete file");
    }
  };

  const handleDownload = async (material: CourseMaterial) => {
    try {
      const { data, error } = await supabase.storage
        .from("course-materials")
        .download(material.file_url);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = material.file_name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast.error("Failed to download file");
    }
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return "Unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handlePreview = async (material: CourseMaterial) => {
    setPreviewMaterial(material);
    setPreviewLoading(true);
    
    try {
      const { data, error } = await supabase.storage
        .from("course-materials")
        .download(material.file_url);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      setPreviewUrl(url);
    } catch (error: any) {
      toast.error("Failed to load preview");
      setPreviewMaterial(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewMaterial(null);
    setPreviewUrl(null);
  };

  const fetchChaptersForMaterial = async (materialId: string, force = false) => {
    if (!force && materialChapters[materialId]) return; // Already loaded
    
    setLoadingChapters(prev => new Set(prev).add(materialId));
    
    try {
      const { data, error } = await supabase
        .from("material_chapters")
        .select("*")
        .eq("material_id", materialId)
        .order("chapter_number", { ascending: true }).order("id");

      if (error) throw error;
      
      setMaterialChapters(prev => ({
        ...prev,
        [materialId]: data || []
      }));
    } catch (error: any) {
      console.error("Error fetching chapters:", error);
      toast.error("Failed to load chapters");
    } finally {
      setLoadingChapters(prev => {
        const next = new Set(prev);
        next.delete(materialId);
        return next;
      });
    }
  };

  const toggleMaterialExpanded = async (materialId: string) => {
    const isExpanded = expandedMaterials.has(materialId);
    
    if (!isExpanded) {
      await fetchChaptersForMaterial(materialId);
    }
    
    setExpandedMaterials(prev => {
      const next = new Set(prev);
      if (isExpanded) {
        next.delete(materialId);
      } else {
        next.add(materialId);
      }
      return next;
    });
  };

  const getChapterTypeIcon = (contentType: string) => {
    switch (contentType) {
      case 'html_link':
        return <LinkIcon className="w-4 h-4" />;
      case 'pdf':
        return <FileText className="w-4 h-4" />;
      case 'image':
        return <Image className="w-4 h-4" />;
      case 'text':
      default:
        return <FileType className="w-4 h-4" />;
    }
  };

  const getChapterTypeBadge = (contentType: string) => {
    switch (contentType) {
      case 'html_link':
        return 'Link';
      case 'pdf':
        return 'PDF';
      case 'image':
        return 'Image';
      case 'text':
      default:
        return 'Text';
    }
  };

  if (!course) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start justify-between">
            <div>
              {course.theme && (
                <span className="text-xs px-2 py-1 bg-gold/10 text-gold-dark rounded-full mb-2 inline-block">
                  {course.theme}
                </span>
              )}
              <DialogTitle className="text-xl font-display">{course.title}</DialogTitle>
              <DialogDescription className="mt-2">
                {course.description || "No description provided"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Course Materials</h3>
            {isAdmin && (
              <div className="flex items-center gap-2">
                <Button onClick={() => setImageUploadDialogOpen(true)} size="sm" variant="outline">
                  <Image className="w-4 h-4 mr-2" />
                  Add Image
                </Button>
                <Button onClick={() => setUploadDialogOpen(true)} size="sm">
                  <Plus className="w-4 h-4 mr-2" />
                  Add PDF
                </Button>
              </div>
            )}
          </div>

          {/* Materials List */}
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : materials.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-8 text-center">
                <FileText className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">
                  No materials uploaded yet
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {materials.map((material) => {
                const isExpanded = expandedMaterials.has(material.id);
                const chapters = materialChapters[material.id] || [];
                const isLoadingChapters = loadingChapters.has(material.id);
                const isImageType = material.material_type === 'images';
                const isImage = isImageType || isImageFile(material.file_name);
                // Images and study-guide-only "Other" PDFs are never chaptered.
                const isChapterless = CHAPTERLESS_MATERIAL_TYPES.includes(material.material_type);

                return (
                  <div key={material.id} className="rounded-xl bg-secondary/50 overflow-hidden">
                    <div className="flex items-center gap-4 p-4 hover:bg-secondary transition-colors group">
                      {/* Expand button - only for chaptered materials */}
                      {!isChapterless ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={() => toggleMaterialExpanded(material.id)}
                        >
                          {isLoadingChapters ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : isExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </Button>
                      ) : (
                        <div className="w-8 flex-shrink-0" /> 
                      )}
                      <div className={`w-12 h-16 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden ${isImage ? 'bg-primary/10' : 'bg-destructive/10'}`}>
                        {material.thumbnail_url ? (
                          <img 
                            src={material.thumbnail_url} 
                            alt="Cover" 
                            className="w-full h-full object-cover"
                          />
                        ) : isImage && material.file_url ? (
                          <img 
                            src={`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/course-materials/${material.file_url}`}
                            alt={material.title || material.file_name} 
                            className="w-full h-full object-cover"
                          />
                        ) : isImage ? (
                          <Image className="w-6 h-6 text-primary" />
                        ) : (
                          <File className="w-6 h-6 text-destructive" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-foreground truncate">
                            {material.title || material.file_name}
                          </p>
                          {isImage && material.is_moderated && (
                            <Badge variant="outline" className="text-xs bg-green-500/10 text-green-600 border-green-500/30">
                              Moderated
                            </Badge>
                          )}
                        </div>
                        {material.author && (
                          <p className="text-xs text-muted-foreground truncate">
                            by {material.author}
                          </p>
                        )}
                        {material.ai_description && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5" title={material.ai_description}>
                            {material.ai_description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          {isAdmin && !isImageType ? (
                            <Select 
                              value={material.material_type} 
                              onValueChange={(v) => handleMaterialTypeChange(material.id, v as MaterialType)}
                              disabled={updatingMaterialType === material.id}
                            >
                              <SelectTrigger className="h-6 w-auto text-xs px-2 py-0">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {Object.entries(MATERIAL_TYPE_LABELS).map(([value, label]) => (
                                  <SelectItem key={value} value={value} className="text-xs">
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant="outline" className="text-xs">
                              {MATERIAL_TYPE_LABELS[material.material_type]}
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {formatFileSize(material.file_size)} • {formatDate(material.created_at)}
                            {!isChapterless && chapters.length > 0 && ` • ${chapters.length} chapter${chapters.length !== 1 ? 's' : ''}`}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Enable button for images */}
                        {isImageType && isAdmin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              // No-op for now
                              toast.info("Enable functionality coming soon");
                            }}
                            title="Enable image"
                          >
                            <Power className="w-4 h-4" />
                          </Button>
                        )}
                        {/* Cloud sync - only for non-image materials */}
                        {isAdmin && !isImageType && (
                          material.openai_file_id ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-green-600"
                              title="Synced to OpenAI"
                              disabled
                            >
                              <Cloud className="w-4 h-4" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleSyncToOpenAI(material)}
                              title="Sync to OpenAI"
                              disabled={syncingMaterial === material.id}
                            >
                              {syncingMaterial === material.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <CloudOff className="w-4 h-4 text-muted-foreground" />
                              )}
                            </Button>
                          )
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handlePreview(material)}
                          title="Preview"
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDownload(material)}
                          title="Download"
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteMaterial(material)}
                            className="text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    
                    {/* Chapters List - only for chaptered materials */}
                    {isExpanded && !isChapterless && (
                      <div className="border-t border-border/50 bg-background/50">
                        {chapters.length === 0 ? (
                          <div className="px-4 py-6 text-center border-2 border-dashed border-amber-500/30 bg-amber-500/5 rounded-lg m-3">
                            <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-3">
                              <BookOpen className="w-6 h-6 text-amber-600" />
                            </div>
                            <p className="text-sm font-medium text-amber-700 dark:text-amber-400 mb-1">No chapters defined</p>
                            <p className="text-xs text-muted-foreground">
                              Go to the course page to define chapters and enable question generation
                            </p>
                          </div>
                        ) : (
                          <div className="divide-y divide-border/30">
                            {chapters.map((chapter) => (
                              <div 
                                key={chapter.id}
                                className="px-4 py-3 hover:bg-secondary/30 transition-colors"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 text-primary">
                                    {getChapterTypeIcon(chapter.content_type)}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-medium text-muted-foreground">
                                        Ch. {chapter.chapter_number}
                                      </span>
                                      <Badge variant="outline" className="text-xs px-1.5 py-0">
                                        {getChapterTypeBadge(chapter.content_type)}
                                      </Badge>
                                    </div>
                                    <EditableChapterTitle
                                      chapterId={chapter.id}
                                      title={chapter.title}
                                      canEdit={isAdmin}
                                      onSaved={(newTitle) => {
                                        setMaterialChapters(prev => ({
                                          ...prev,
                                          [material.id]: (prev[material.id] || []).map(ch =>
                                            ch.id === chapter.id ? { ...ch, title: newTitle } : ch
                                          ),
                                        }));
                                      }}
                                      className="font-medium text-sm text-foreground"
                                    />
                                  </div>
                                  {chapter.content_type === 'html_link' && chapter.content && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      asChild
                                    >
                                      <a href={chapter.content} target="_blank" rel="noopener noreferrer">
                                        <LinkIcon className="w-4 h-4 mr-1" />
                                        Open
                                      </a>
                                    </Button>
                                  )}
                                </div>
                                {isAdmin && material.material_type === 'textbook' && (
                                  <div className="mt-3 pl-11">
                                    <ChapterStudyMaterialsManager
                                      chapterId={chapter.id}
                                      chapterTitle={chapter.title}
                                      hasCheatSheet={!!chapter.cheat_sheet}
                                      materialType={material.material_type}
                                      onUpdate={() => fetchChaptersForMaterial(material.id, true)}
                                    />
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* PDF Preview Dialog */}
        <Dialog open={!!previewMaterial} onOpenChange={(open) => !open && closePreview()}>
          <DialogContent className="max-w-5xl h-[90vh] flex flex-col p-0">
            <DialogHeader className="px-6 py-4 border-b">
              <div className="flex items-center justify-between">
                <DialogTitle className="text-lg font-medium truncate pr-4">
                  {previewMaterial?.file_name}
                </DialogTitle>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => previewMaterial && handleDownload(previewMaterial)}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>
                </div>
              </div>
            </DialogHeader>
            <div className="flex-1 overflow-hidden bg-muted">
              {previewLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
              ) : previewUrl ? (
                isImageFile(previewMaterial?.file_name || '') ? (
                  <div className="flex items-center justify-center h-full p-4">
                    <img 
                      src={previewUrl} 
                      alt={previewMaterial?.file_name} 
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                ) : (
                  <iframe
                    src={previewUrl}
                    className="w-full h-full border-0"
                    title={previewMaterial?.file_name}
                  />
                )
              ) : null}
            </div>
          </DialogContent>
        </Dialog>

        {/* Upload Dialogs */}
        {course && (
          <>
            <MaterialUploadDialog
              courseId={course.id}
              open={uploadDialogOpen}
              onOpenChange={setUploadDialogOpen}
              onSuccess={fetchMaterials}
            />
            <ImageUploadDialog
              courseId={course.id}
              courseLanguage={course.language || "en"}
              open={imageUploadDialogOpen}
              onOpenChange={setImageUploadDialogOpen}
              onSuccess={fetchMaterials}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
