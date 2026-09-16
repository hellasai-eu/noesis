import { useState, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  ImagePlus,
  Loader2,
  Download,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PdfViewerWithExtractProps {
  fileUrl: string; // Blob URL for displaying PDF
  storagePath: string; // Actual storage path for extraction API
  fileName: string;
  courseId: string;
  onImagesExtracted?: () => void;
}

export function PdfViewerWithExtract({
  fileUrl,
  storagePath,
  fileName,
  courseId,
  onImagesExtracted,
}: PdfViewerWithExtractProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [loading, setLoading] = useState<boolean>(true);
  const [extracting, setExtracting] = useState<boolean>(false);

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setLoading(false);
  }, []);

  const onDocumentLoadError = useCallback((error: Error) => {
    console.error("PDF load error:", error);
    toast.error("Failed to load PDF");
    setLoading(false);
  }, []);

  const goToPrevPage = () => {
    setPageNumber((prev) => Math.max(1, prev - 1));
  };

  const goToNextPage = () => {
    setPageNumber((prev) => Math.min(numPages, prev + 1));
  };

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    if (!isNaN(value) && value >= 1 && value <= numPages) {
      setPageNumber(value);
    }
  };

  const zoomIn = () => {
    setScale((prev) => Math.min(2.5, prev + 0.25));
  };

  const zoomOut = () => {
    setScale((prev) => Math.max(0.5, prev - 0.25));
  };

  const handleExtractImages = async () => {
    setExtracting(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/extract-images-from-pdf`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filePath: storagePath, // Use storage path, not blob URL
            bucketName: "course-materials",
            page: pageNumber,
            courseId,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to extract images");
      }

      const data = await response.json();

      if (data.success && data.extractedCount > 0) {
        toast.success(`Extracted ${data.extractedCount} image(s) from page ${pageNumber}`, {
          description: "Images are pending moderation",
        });
        onImagesExtracted?.();
      } else if (data.extractedCount === 0) {
        toast.info("No images found on this page");
      } else {
        throw new Error(data.error || "Extraction failed");
      }
    } catch (error: any) {
      console.error("Error extracting images:", error);
      toast.error(error.message || "Failed to extract images");
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 p-3 border-b bg-muted/30">
        {/* Navigation */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={goToPrevPage}
            disabled={pageNumber <= 1 || loading}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>

          <div className="flex items-center gap-1.5 text-sm">
            <span>Page</span>
            <input
              type="number"
              min={1}
              max={numPages}
              value={pageNumber}
              onChange={handlePageInputChange}
              className="w-14 px-2 py-1 text-center border rounded-md bg-background"
              disabled={loading}
            />
            <span>of {numPages || "..."}</span>
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={goToNextPage}
            disabled={pageNumber >= numPages || loading}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={zoomOut} disabled={scale <= 0.5}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <span className="text-sm min-w-[4rem] text-center">{Math.round(scale * 100)}%</span>
          <Button variant="outline" size="icon" onClick={zoomIn} disabled={scale >= 2.5}>
            <ZoomIn className="w-4 h-4" />
          </Button>
        </div>

        {/* Extract Button */}
        <Button
          variant="default"
          onClick={handleExtractImages}
          disabled={extracting || loading}
          className="gap-2"
        >
          {extracting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Extracting...
            </>
          ) : (
            <>
              <ImagePlus className="w-4 h-4" />
              Extract Images
            </>
          )}
        </Button>
      </div>

      {/* PDF Viewer */}
      <div className="flex-1 overflow-auto flex justify-center bg-muted/20 p-4">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}
        <Document
          file={fileUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          loading={null}
          className="flex justify-center"
        >
          <Page
            pageNumber={pageNumber}
            scale={scale}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            className="shadow-lg"
          />
        </Document>
      </div>
    </div>
  );
}
