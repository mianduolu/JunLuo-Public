import { ImageFormat, Skia } from '@shopify/react-native-skia';
import type { SkImage } from '@shopify/react-native-skia';

export const POST_IMAGE_MAX_EDGE = 2560;
export const POST_IMAGE_JPEG_QUALITY = 90;

export type CompressedPostImage = {
  base64: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
};

export function postImageSize(width: number, height: number, maxEdge = POST_IMAGE_MAX_EDGE) {
  if (![width, height, maxEdge].every((value) => Number.isFinite(value) && value >= 1)) {
    throw new Error('baiyun-post-image-invalid-size');
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The decoder has already applied the encoded image orientation. Do not rotate it twice.
// This borrowed image belongs to the caller; only the output surface/snapshot are disposed here.
export function encodePostImage(image: SkImage, maxEdge = POST_IMAGE_MAX_EDGE, quality = POST_IMAGE_JPEG_QUALITY): CompressedPostImage {
  const { width, height } = postImageSize(image.width(), image.height(), maxEdge);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('baiyun-post-image-invalid-quality');
  const surface = Skia.Surface.Make(width, height);
  if (!surface) throw new Error('baiyun-post-image-surface-failed');
  try {
    const canvas = surface.getCanvas();
    // JPEG has no alpha channel: transparent screenshots/images get an explicit white background.
    canvas.clear(Skia.Color('white'));
    canvas.drawImageRectCubic(image, Skia.XYWHRect(0, 0, image.width(), image.height()), Skia.XYWHRect(0, 0, width, height), 1 / 3, 1 / 3);
    surface.flush();
    const snapshot = surface.makeImageSnapshot();
    try {
      const base64 = snapshot.encodeToBase64(ImageFormat.JPEG, quality);
      if (!base64) throw new Error('baiyun-post-image-encode-failed');
      return { base64, width, height, mimeType: 'image/jpeg' };
    } finally {
      snapshot.dispose();
    }
  } finally {
    surface.dispose();
  }
}

// Import a group with sequential awaits, so nine full-size source images are never decoded together.
export async function compressPostImage(uri: string): Promise<CompressedPostImage> {
  const data = await Skia.Data.fromURI(uri);
  try {
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) throw new Error('baiyun-post-image-decode-failed');
    try {
      return encodePostImage(image);
    } finally {
      image.dispose();
    }
  } finally {
    data.dispose();
  }
}
