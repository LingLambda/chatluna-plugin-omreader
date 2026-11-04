import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon/node'
import type { InlineImage } from './types'

/** Inline limits: sources above 20 MiB are not decoded; the payload sent to the model stays under 300 KB. */
export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_OUTPUT_BYTES = 300 * 1024
/** Long-side caps tried in order once the original is too large; JPEG quality drops on the last steps. */
const STEPS = [
  { side: 2048, quality: 85 },
  { side: 1568, quality: 85 },
  { side: 1024, quality: 80 },
  { side: 768, quality: 75 },
  { side: 512, quality: 70 }
]

export type ImageResult =
  | { ok: true; image: InlineImage; width: number; height: number; originalWidth: number; originalHeight: number }
  | { ok: false; reason: 'invalid' | 'too-large' }

/**
 * Decodes the bytes (rejecting payloads that only claim to be images), passes a small portable original
 * through untouched, and otherwise re-encodes downscaled JPEGs until one fits the output limit.
 * GIFs keep only their first frame when re-encoded.
 */
export function prepareImage(bytes: Uint8Array, mediaType: string): ImageResult {
  let image: PhotonImage
  try {
    image = PhotonImage.new_from_byteslice(bytes)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  try {
    const originalWidth = image.get_width()
    const originalHeight = image.get_height()
    if (originalWidth === 0 || originalHeight === 0) return { ok: false, reason: 'invalid' }
    const base64 = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
    if (bytes.length <= MAX_IMAGE_OUTPUT_BYTES) {
      return {
        ok: true,
        image: { data: base64(bytes), mediaType },
        width: originalWidth,
        height: originalHeight,
        originalWidth,
        originalHeight
      }
    }
    for (const step of STEPS) {
      const scale = Math.min(1, step.side / Math.max(originalWidth, originalHeight))
      const width = Math.max(1, Math.round(originalWidth * scale))
      const height = Math.max(1, Math.round(originalHeight * scale))
      const scaled = scale === 1 ? image : resize(image, width, height, SamplingFilter.Lanczos3)
      try {
        const encoded = scaled.get_bytes_jpeg(step.quality)
        if (encoded.length <= MAX_IMAGE_OUTPUT_BYTES) {
          return {
            ok: true,
            image: { data: base64(encoded), mediaType: 'image/jpeg' },
            width,
            height,
            originalWidth,
            originalHeight
          }
        }
      } finally {
        if (scaled !== image) scaled.free()
      }
    }
    return { ok: false, reason: 'too-large' }
  } finally {
    image.free()
  }
}
