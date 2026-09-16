/**
 * How a `course_materials` row's file should be rendered.
 *
 * `course_materials` stores no MIME type — only `file_name` — so every surface
 * that has to pick a viewer reads the extension. These helpers are that reading,
 * kept in one place so the material list, the preview dialog and the extraction
 * menu cannot disagree about what a file is.
 */

/**
 * A material stored as text rather than as a PDF — what `UrlImportDialog`
 * writes. The PDF viewer and the thumbnail generator both assume a PDF, so
 * every affordance that leads to one is gated on this.
 */
export const isTextMaterial = (fileName: string) => /\.(md|markdown|txt)$/i.test(fileName);

/**
 * A material the browser can render as an image.
 *
 * `ImageUploadDialog` accepts `image/*`, so this list has to cover what a file
 * picker will actually hand over — not just the four formats a PDF-era codebase
 * expected. Anything missing here is treated as a PDF and sent to a viewer that
 * cannot open it.
 */
export const isImageFile = (fileName: string) =>
  /\.(jpe?g|png|gif|webp|svg|avif|bmp|tiff?|heic|heif|jfif|apng|ico)$/i.test(fileName);

/**
 * Whether the material preview routes this file to `PdfViewerWithExtract` —
 * everything that is neither a Markdown import nor an image.
 *
 * Deliberately a complement rather than a `.pdf` test: `MaterialUploadDialog`
 * validates on `File.type`, not on the extension, so a PDF can reach storage
 * under a name that ends in nothing at all.
 */
export const opensInPdfViewer = (fileName: string) =>
  !isTextMaterial(fileName) && !isImageFile(fileName);
