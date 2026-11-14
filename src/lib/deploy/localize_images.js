// Copies images stored in Supabase Storage into the deployed site bundle so the
// published (static) site no longer hot-links to the Supabase bucket.
//
// Every page/symbol file in the bundle is scanned for public Supabase image URLs,
// e.g. https://<project>.supabase.co/storage/v1/object/public/images/<site>/<file>.
// Each image is downloaded, added to the bundle as `_images/<site>/<file>`, and the
// URL is rewritten to `/_images/<site>/<file>` (root-relative, like `/_symbols/`).
//
// `primo.json` is intentionally left untouched so a re-imported site keeps working
// in the editor with the original Supabase URLs.

const BUNDLE_DIR = '_images'
const UNTOUCHED_FILES = ['primo.json']

// Images bigger than this are left on Supabase: the deploy API receives files in
// request bodies that are capped (~4.5MB on Vercel) and base64 adds ~33%.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

/**
 * @typedef {{file: string, data: string, size: number, encoding?: 'utf-8' | 'base64'}} BundleFile
 */

/**
 * @param {Array<BundleFile>} files
 * @param {{ storage_url: string }} options - public base URL of the images bucket, ending with '/'
 * @returns {Promise<Array<BundleFile>>}
 */
export async function localize_images(files, { storage_url }) {
  const urls = collect_image_urls(files, storage_url)
  if (urls.size === 0) return files

  /** @type {Map<string, { src: string, file: BundleFile }>} original url -> local copy */
  const images = new Map()
  await Promise.all(
    [...urls].map(async (url) => {
      const key = url.slice(storage_url.length)
      const base64 = await download_as_base64(url)
      if (base64 === null) return
      images.set(url, {
        src: `/${BUNDLE_DIR}/${key}`,
        file: {
          file: `${BUNDLE_DIR}/${safe_decode(key)}`,
          data: base64,
          size: base64.length / 1024,
          encoding: 'base64',
        },
      })
    })
  )
  if (images.size === 0) return files

  // longest first, so a URL that is a prefix of another one doesn't clobber it
  const replacements = [...images.entries()].sort(
    ([a], [b]) => b.length - a.length
  )

  const rewritten = files.map((file) => {
    if (file.encoding === 'base64' || UNTOUCHED_FILES.includes(file.file))
      return file
    let data = file.data
    for (const [url, { src }] of replacements) {
      if (data.includes(url)) data = data.split(url).join(src)
    }
    if (data === file.data) return file
    return {
      ...file,
      data,
      size: new Blob([data], { type: 'text/plain' }).size / 1024,
    }
  })

  // the same image may be referenced by several URL spellings (e.g. encoded/decoded)
  const image_files = new Map()
  for (const { file } of images.values()) image_files.set(file.file, file)

  return [...rewritten, ...image_files.values()]
}

/**
 * Finds Supabase image URLs in the bundle, from two places:
 *  - string values in primo.json (exact values, so file names with spaces work)
 *  - a regex scan of every text file (catches URLs hard-coded in component code)
 */
function collect_image_urls(files, storage_url) {
  const urls = new Set()

  const primo_json = files.find((f) => f.file === 'primo.json')
  if (primo_json) {
    try {
      walk_strings(JSON.parse(primo_json.data), (value) => {
        if (
          value.startsWith(storage_url) &&
          value.length > storage_url.length
        ) {
          urls.add(value.split(/[?#]/)[0])
        }
      })
    } catch (e) {
      console.warn('Could not parse primo.json while collecting images', e)
    }
  }

  const pattern = new RegExp(
    escape_regex(storage_url) + '[^\\s"\'`<>()\\\\?#&]+',
    'g'
  )
  for (const file of files) {
    if (file.encoding === 'base64') continue
    for (const match of file.data.matchAll(pattern)) urls.add(match[0])
  }

  // the regex stops at whitespace, so drop partial matches of file names with spaces
  for (const url of urls) {
    if ([...urls].some((other) => other.startsWith(url + ' '))) urls.delete(url)
  }

  return urls
}

function walk_strings(value, fn) {
  if (typeof value === 'string') fn(value)
  else if (Array.isArray(value)) value.forEach((v) => walk_strings(v, fn))
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => walk_strings(v, fn))
}

/** @returns {Promise<string | null>} */
async function download_as_base64(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(
        `Could not download image ${url} (${res.status}), keeping remote URL`
      )
      return null
    }
    const blob = await res.blob()
    if (blob.size > MAX_IMAGE_BYTES) {
      console.warn(
        `Image ${url} is larger than ${MAX_IMAGE_BYTES} bytes, keeping remote URL`
      )
      return null
    }
    return await blob_to_base64(blob)
  } catch (e) {
    console.warn(`Could not download image ${url}, keeping remote URL`, e)
    return null
  }
}

function blob_to_base64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function safe_decode(str) {
  try {
    return decodeURIComponent(str)
  } catch {
    return str
  }
}

function escape_regex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
