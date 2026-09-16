import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Upload, Loader2, Image, X } from "lucide-react";
import { toast } from "sonner";

interface InstitutionLogoUploadProps {
  institutionId: string;
  currentLogoUrl: string | null;
  onLogoUpdate: (newUrl: string | null) => void;
}

export function InstitutionLogoUpload({
  institutionId,
  currentLogoUrl,
  onLogoUpdate,
}: InstitutionLogoUploadProps) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.match(/^image\/(jpeg|jpg|gif|png|webp)$/)) {
      toast.error("Please select a JPG, GIF, PNG, or WebP image");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be less than 5MB");
      return;
    }

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleUpload = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      // Delete old logo if exists
      if (currentLogoUrl) {
        const oldPath = currentLogoUrl.split("/").pop();
        if (oldPath) {
          await supabase.storage
            .from("institution-logos")
            .remove([`${institutionId}/${oldPath}`]);
        }
      }

      // Upload new logo
      const fileExt = file.name.split(".").pop();
      const fileName = `${institutionId}/${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("institution-logos")
        .upload(fileName, file, {
          cacheControl: "3600",
          upsert: true,
        });

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: urlData } = supabase.storage
        .from("institution-logos")
        .getPublicUrl(fileName);

      // Update institution record
      const { error: updateError } = await supabase
        .from("institutions")
        .update({ logo_url: urlData.publicUrl })
        .eq("id", institutionId);

      if (updateError) throw updateError;

      onLogoUpdate(urlData.publicUrl);
      toast.success("Logo updated successfully");
      setOpen(false);
      setPreview(null);
    } catch (error: any) {
      console.error("Upload error:", error);
      toast.error(error.message || "Failed to upload logo");
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!currentLogoUrl) return;
    if (!confirm("Remove the institution logo?")) return;

    setUploading(true);
    try {
      // Extract path from URL
      const urlParts = currentLogoUrl.split("institution-logos/");
      if (urlParts[1]) {
        await supabase.storage
          .from("institution-logos")
          .remove([urlParts[1]]);
      }

      // Update institution record
      const { error } = await supabase
        .from("institutions")
        .update({ logo_url: null })
        .eq("id", institutionId);

      if (error) throw error;

      onLogoUpdate(null);
      toast.success("Logo removed");
      setOpen(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to remove logo");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
          <Image className="w-3 h-3 mr-1" />
          {currentLogoUrl ? "Change Logo" : "Add Logo"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Institution Logo</DialogTitle>
          <DialogDescription>
            Upload a logo for your institution (JPG, GIF, PNG, or WebP)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Current/Preview Image */}
          <div className="flex justify-center">
            {preview ? (
              <div className="relative">
                <img
                  src={preview}
                  alt="Preview"
                  className="w-32 h-32 object-contain rounded-lg border border-border"
                />
                <Button
                  variant="destructive"
                  size="icon"
                  className="absolute -top-2 -right-2 h-6 w-6"
                  onClick={() => {
                    setPreview(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            ) : currentLogoUrl ? (
              <img
                src={currentLogoUrl}
                alt="Current logo"
                className="w-32 h-32 object-contain rounded-lg border border-border"
                crossOrigin="anonymous"
                data-cmp-noconsent="true"
                onError={(e) => {
                  console.error("Failed to load logo:", currentLogoUrl);
                }}
              />
            ) : (
              <div className="w-32 h-32 rounded-lg border-2 border-dashed border-border flex items-center justify-center">
                <Image className="w-8 h-8 text-muted-foreground" />
              </div>
            )}
          </div>

          {/* Upload Input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/gif,image/png,image/webp"
            className="hidden"
            onChange={handleFileSelect}
          />

          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <Upload className="w-4 h-4 mr-2" />
              Select Image
            </Button>

            {preview && (
              <Button onClick={handleUpload} disabled={uploading}>
                {uploading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Uploading...
                  </>
                ) : (
                  "Save Logo"
                )}
              </Button>
            )}

            {currentLogoUrl && !preview && (
              <Button
                variant="destructive"
                onClick={handleRemoveLogo}
                disabled={uploading}
              >
                Remove Logo
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Max file size: 5MB
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}