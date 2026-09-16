import { useState, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Image, Upload, Loader2, CheckCircle } from "lucide-react";
import { toast } from "sonner";

interface ImageUploadDialogProps {
  courseId: string;
  courseLanguage: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function ImageUploadDialog({ 
  courseId, 
  courseLanguage,
  open, 
  onOpenChange, 
  onSuccess 
}: ImageUploadDialogProps) {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [moderationStatus, setModerationStatus] = useState<"pending" | "allowed" | "rejected" | null>(null);
  const [tempFilePath, setTempFilePath] = useState<string | null>(null);
  const [tempFileUrl, setTempFileUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isSelectingFileRef = useRef(false);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setFile(null);
      setPreview(null);
      setTitle("");
      setDescription("");
      setModerationStatus(null);
      setTempFilePath(null);
      setTempFileUrl(null);
      isSelectingFileRef.current = false;
    }
  }, [open]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isSelectingFileRef.current) {
      return;
    }
    if (!newOpen) {
      handleClose();
    } else {
      onOpenChange(newOpen);
    }
  };

  const openFilePicker = () => {
    isSelectingFileRef.current = true;
    fileInputRef.current?.click();
    setTimeout(() => {
      isSelectingFileRef.current = false;
    }, 500);
  };

  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0 || !user) return;

    const selectedFile = files[0];

    if (!selectedFile.type.startsWith("image/")) {
      toast.error("Only image files are allowed");
      return;
    }

    if (selectedFile.size > 10 * 1024 * 1024) {
      toast.error("File size must be less than 10MB");
      return;
    }

    setFile(selectedFile);
    
    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(selectedFile);

    // Upload to temp location in Supabase storage
    setModerating(true);
    setModerationStatus("pending");
    
    try {
      const timestamp = Date.now();
      const sanitizedName = selectedFile.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9._-]/g, "_");
      
      const tempPath = `temp/${courseId}/${timestamp}-${sanitizedName}`;

      const { error: uploadError } = await supabase.storage
        .from("course-materials")
        .upload(tempPath, selectedFile, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) throw uploadError;

      setTempFilePath(tempPath);

      // Get public URL
      const { data: urlData } = supabase.storage
        .from("course-materials")
        .getPublicUrl(tempPath);

      setTempFileUrl(urlData.publicUrl);

      // Image uploaded successfully - mark as allowed (no moderation)
      setModerationStatus("allowed");
      
      // Use filename as default title
      setTitle(selectedFile.name.replace(/\.[^/.]+$/, ""));
      
    } catch (error: unknown) {
      console.error("Error uploading image:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to upload image";
      toast.error(errorMessage);
      setModerationStatus(null);
      setFile(null);
      setPreview(null);
    } finally {
      setModerating(false);
    }
  };

  const handleUpload = async () => {
    if (!file || !user || !tempFilePath || moderationStatus !== "allowed") return;

    setUploading(true);

    try {
      const timestamp = Date.now();
      const sanitizedFileName = file.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9._-]/g, "_");

      const finalPath = `${courseId}/${timestamp}-${sanitizedFileName}`;

      // Download from temp
      const { data: downloadData, error: downloadError } = await supabase.storage
        .from("course-materials")
        .download(tempFilePath);

      if (downloadError) throw downloadError;

      // Upload to final location
      const { error: uploadError } = await supabase.storage
        .from("course-materials")
        .upload(finalPath, downloadData, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) throw uploadError;

      // Delete temp file
      await supabase.storage.from("course-materials").remove([tempFilePath]);

      // Save metadata to database
      const { error: dbError } = await supabase.from("course_materials").insert({
        course_id: courseId,
        file_name: file.name,
        file_url: finalPath,
        file_size: file.size,
        uploaded_by: user.id,
        title: title || null,
        material_type: "images",
        is_moderated: false,
      });

      if (dbError) throw dbError;

      toast.success("Image uploaded successfully");
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Upload error:", error);
      toast.error(error.message || "Failed to upload image");
    } finally {
      setUploading(false);
    }
  };

  const handleClose = async () => {
    // Clean up temp file if exists
    if (tempFilePath) {
      try {
        await supabase.storage.from("course-materials").remove([tempFilePath]);
      } catch (e) {
        console.error("Failed to clean up temp file:", e);
      }
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* See MaterialUploadDialog: `overflow-hidden` would beat the base scroll and
          clip this form once a preview + metadata fields push it past the viewport. */}
      <DialogContent className="max-w-lg w-[95vw] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Image</DialogTitle>
          <DialogDescription>
            Upload an image for course materials.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File Selection */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                isSelectingFileRef.current = false;
                handleFileSelect(e.target.files);
              }}
            />
            {!file ? (
              <div
                onClick={openFilePicker}
                className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all hover:border-primary/50 hover:bg-secondary/50"
              >
                <div className="flex flex-col items-center gap-3">
                  <div className="w-14 h-14 rounded-xl bg-secondary flex items-center justify-center">
                    <Upload className="w-7 h-7 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Click to select image</p>
                    <p className="text-xs text-muted-foreground mt-1">JPG, PNG, GIF, WebP • Max 10MB</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Preview */}
                {preview && (
                  <div className="relative aspect-video rounded-lg overflow-hidden bg-secondary">
                    <img 
                      src={preview} 
                      alt="Preview" 
                      className="w-full h-full object-contain"
                    />
                    {moderating && (
                      <div className="absolute inset-0 bg-background/80 flex items-center justify-center">
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-5 h-5 animate-spin text-primary" />
                          <span className="text-sm">Uploading...</span>
                        </div>
                      </div>
                    )}
                    {moderationStatus === "allowed" && !moderating && (
                      <div className="absolute top-2 right-2 bg-green-500/90 text-white px-2 py-1 rounded-md flex items-center gap-1 text-xs">
                        <CheckCircle className="w-3 h-3" />
                        Ready
                      </div>
                    )}
                  </div>
                )}
                
                {/* File info */}
                <div className="flex items-center gap-3 p-3 bg-secondary/50 rounded-lg">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Image className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(file.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Title - only show when moderation passed */}
          {moderationStatus === "allowed" && (
            <div className="space-y-2">
              <Label htmlFor="image-title">Title</Label>
              <Input 
                id="image-title" 
                value={title} 
                onChange={(e) => setTitle(e.target.value)} 
                placeholder="Image title" 
              />
            </div>
          )}

          {/* Description - editable AI-generated description */}
          {moderationStatus === "allowed" && (
            <div className="space-y-2">
              <Label htmlFor="image-description">Description</Label>
              <Textarea 
                id="image-description" 
                value={description} 
                onChange={(e) => setDescription(e.target.value)} 
                placeholder="Image description"
                rows={3}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleUpload} 
            disabled={!file || uploading || moderating || moderationStatus !== "allowed"}
          >
            {uploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              "Upload"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
