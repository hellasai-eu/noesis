/**
 * Images an author attaches inside the rich-text editor (#1217).
 *
 * The rule the UI needs is "an image never blows up the layout", and there are
 * two places to enforce it. CSS bounds what is *displayed* — see `.prose img`
 * in index.css — but CSS cannot stop a 12-megapixel phone photo from being
 * stored, re-fetched by every student, and pushed down the mobile connection
 * of each of them. So the bytes are bounded too: everything is decoded, scaled
 * to fit MAX_IMAGE_WIDTH x MAX_IMAGE_HEIGHT, and re-encoded before upload.
 *
 * Scaled, not cropped. Cropping to a fixed box would silently throw away the
 * edges of a diagram, and a diagram with its axis labels cut off is worse than
 * one that is merely small.
 */
import { supabase } from "@/integrations/supabase/client";

/** Matches the bucket created in 20260831090000_content_images_bucket.sql. */
export const CONTENT_IMAGE_BUCKET = "content-images";

/**
 * The stored image is bounded to this box. Wide enough that a full-width
 * diagram is still crisp on a 2x display at the ~600px the prose column gives
 * it; small enough that a piece with several images is not megabytes.
 */
export const MAX_IMAGE_WIDTH = 1200;
export const MAX_IMAGE_HEIGHT = 900;

/** Rejected before decoding — a file this big is a mistake, not a diagram. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * Under this, and already inside the box, the original bytes are uploaded
 * untouched. Re-encoding a small PNG buys nothing, and it would flatten an
 * animated GIF to its first frame for no reason at all.
 */
const PASSTHROUGH_BYTES = 512 * 1024;

const WEBP_QUALITY = 0.85;

/** What the bucket's `allowed_mime_types` accepts. Keep the two in step. */
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** For the file input's `accept`, so the picker filters rather than the toast. */
export const IMAGE_ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(",");

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * The largest box with the same aspect ratio as `width`x`height` that fits
 * inside `maxWidth`x`maxHeight`. Never enlarges: an image already smaller than
 * the box comes back unchanged, because upscaling only adds bytes and blur.
 */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    // A sub-pixel result would round to a zero-sized canvas, which throws.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * `createImageBitmap` decodes off the main thread and is what every browser we
 * support has; the <img> path is the fallback for anything that does not.
 */
async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(file);
  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("The image could not be decoded"));
      img.src = url;
    });
    return {
      source: element,
      width: element.naturalWidth,
      height: element.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export interface PreparedImage {
  blob: Blob;
  contentType: string;
  extension: string;
  width: number;
  height: number;
}

/**
 * Validates, downscales and re-encodes a picked file into something safe to
 * store. Throws with a message meant for a toast.
 */
export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new Error("Only PNG, JPEG, WebP and GIF images can be attached");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("That image is over 10MB — try a smaller one");
  }

  const decoded = await decodeImage(file);
  try {
    const { width: sourceWidth, height: sourceHeight } = decoded;
    if (!sourceWidth || !sourceHeight) {
      throw new Error("The image could not be decoded");
    }

    const target = fitWithin(sourceWidth, sourceHeight, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT);
    const alreadyFits = target.width === sourceWidth && target.height === sourceHeight;
    if (alreadyFits && file.size <= PASSTHROUGH_BYTES) {
      return {
        blob: file,
        contentType: file.type,
        extension: EXTENSION_BY_TYPE[file.type] ?? "png",
        width: sourceWidth,
        height: sourceHeight,
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The image could not be resized");
    context.drawImage(decoded.source, 0, 0, target.width, target.height);

    // WebP is both smaller than JPEG and keeps transparency, which a diagram
    // drawn for a light background needs. PNG is the fallback for the same
    // reason: a JPEG fallback would fill every transparent pixel with black.
    let blob = await canvasToBlob(canvas, "image/webp", WEBP_QUALITY);
    if (!blob || blob.type !== "image/webp") {
      blob = await canvasToBlob(canvas, "image/png", 1);
    }
    if (!blob) throw new Error("The image could not be resized");

    return {
      blob,
      contentType: blob.type,
      extension: EXTENSION_BY_TYPE[blob.type] ?? "png",
      width: target.width,
      height: target.height,
    };
  } finally {
    decoded.release();
  }
}

/**
 * Uploads a prepared image and returns the public URL to embed.
 *
 * The path is `<uid>/<uuid>.<ext>`: the uid prefix is what the bucket's INSERT
 * policy checks, and the uuid means two authors uploading `diagram.png` never
 * collide — and no filename an author chose ends up in a URL students can read.
 *
 * The uid comes from the session rather than a prop, because the policy
 * compares the prefix against `auth.uid()` — the token is the only source that
 * cannot disagree with the check, and it keeps the editor component free of an
 * AuthProvider it otherwise has no use for.
 */
export async function uploadContentImage(file: File): Promise<string> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth?.user) {
    throw new Error("Sign in again to attach images");
  }

  const prepared = await prepareImageForUpload(file);
  const path = `${auth.user.id}/${crypto.randomUUID()}.${prepared.extension}`;

  const { error } = await supabase.storage.from(CONTENT_IMAGE_BUCKET).upload(path, prepared.blob, {
    // Immutable content at an unguessable path, so cache it for a year.
    cacheControl: "31536000",
    contentType: prepared.contentType,
    upsert: false,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(CONTENT_IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
