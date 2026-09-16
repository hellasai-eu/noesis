import { describe, expect, it } from "vitest";
import { isImageFile, isTextMaterial, opensInPdfViewer } from "@/lib/material-files";

describe("isTextMaterial", () => {
  it("matches what UrlImportDialog writes", () => {
    expect(isTextMaterial("openai-huggingface.md")).toBe(true);
    expect(isTextMaterial("notes.markdown")).toBe(true);
    expect(isTextMaterial("notes.TXT")).toBe(true);
  });

  it("does not match a PDF", () => {
    expect(isTextMaterial("textbook.pdf")).toBe(false);
  });
});

describe("isImageFile", () => {
  // ImageUploadDialog accepts `image/*`, so the list has to cover what a file
  // picker hands over — a phone screenshot is .heic, a modern export is .avif.
  it.each([
    "diagram.jpg",
    "diagram.JPEG",
    "diagram.png",
    "diagram.gif",
    "diagram.webp",
    "diagram.svg",
    "diagram.avif",
    "diagram.bmp",
    "diagram.tif",
    "diagram.tiff",
    "photo.heic",
    "photo.heif",
    "photo.jfif",
    "loop.apng",
    "favicon.ico",
  ])("treats %s as an image", (name) => {
    expect(isImageFile(name)).toBe(true);
  });

  it("does not match a PDF or a Markdown import", () => {
    expect(isImageFile("textbook.pdf")).toBe(false);
    expect(isImageFile("article.md")).toBe(false);
  });
});

describe("opensInPdfViewer", () => {
  it("accepts a PDF", () => {
    expect(opensInPdfViewer("textbook.pdf")).toBe(true);
  });

  it("accepts a PDF whose name lost its extension", () => {
    // MaterialUploadDialog validates on File.type, not on the extension.
    expect(opensInPdfViewer("textbook")).toBe(true);
  });

  it("rejects images the viewer cannot load, whatever the material type says", () => {
    expect(opensInPdfViewer("diagram.png")).toBe(false);
    expect(opensInPdfViewer("photo.heic")).toBe(false);
    expect(opensInPdfViewer("diagram.avif")).toBe(false);
  });

  it("rejects Markdown imports", () => {
    expect(opensInPdfViewer("openai-huggingface.md")).toBe(false);
  });
});
