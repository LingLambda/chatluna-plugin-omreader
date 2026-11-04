/** Lowercased MIME type without parameters. */
export function normalizeMime(contentType: string) {
  return contentType.split(';', 1)[0]!.trim().toLowerCase()
}

function filenameExtension(filename: string) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.tar.gz')) return '.tar.gz'
  const match = /\.[^./\\]+$/.exec(lower)
  return match === null ? '' : match[0]
}

/** Lowercased extension (`.pdf`, `.tar.gz`) from a Content-Disposition filename, else the URL path; empty when none. */
export function extensionHint(url: string, contentDisposition?: string) {
  const filename = contentDisposition?.match(/filename\*?=["']?(?:UTF-8'')?([^"';\n]+)/i)?.[1]
  if (filename !== undefined) {
    let decoded = filename
    try {
      decoded = decodeURIComponent(filename)
    } catch {
      // Keep a filename with stray `%` as written.
    }
    const extension = filenameExtension(decoded)
    if (extension) return extension
  }
  try {
    return filenameExtension(new URL(url).pathname)
  } catch {
    return ''
  }
}

/** MIME types servers use for downloads whose real type is only known from the extension. */
export const GENERIC_BINARY_MIMES: Record<string, true> = {
  '': true,
  unknown: true,
  'application/octet-stream': true,
  'binary/octet-stream': true,
  'application/x-download': true
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** Images the model can receive inline. */
export const INLINE_IMAGE_MIMES: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
  'image/webp': true
}

/** Image MIME type from the header, or from the extension when the header is generic; null for non-images. */
export function imageMimeOf(mime: string, extension: string) {
  if (mime.startsWith('image/')) return mime
  if (GENERIC_BINARY_MIMES[mime] !== true) return null
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null
}
