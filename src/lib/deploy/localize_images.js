// Copies images stored in Supabase Storage into the deployed site bundle so the
// published (static) site no longer hot-links to the Supabase bucket.
//
// Every page/symbol file in the bundle is scanned for public Supabase image URLs,
// e.g. https://<project>.supabase.co/storage/v1/object/public/images/<site>/<file>.
// Each URL is rewritten to `/_images/<site>/<file>` (root-relative, like `/_symbols/`)
// and an image entry is added to the bundle as `_images/<site>/<file>`.
//
// Image entries carry only the storage key (`storage_key`), not the image data: the
// deploy endpoints download the image from Supabase server-side, so large images
// don't have to fit in the request body sent from the browser.
//
// `primo.json` is intentionally left untouched so a re-imported site keeps working
// in the editor with the original Supabase URLs.

const BUNDLE_DIR = '_images'
const UNTOUCHED_FILES = ['primo.json']

/**
 * @typedef {{
 *   file: string,
 *   data?: string,
 *   size: number,
 *   encoding?: 'utf-8' | 'base64',
 *   storage_key?: string
 * }} BundleFile
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
      const size = await check_image(url)
      if (size === null) return
      const key = url.slice(storage_url.length)
      const storage_key = safe_decode(key)
      images.set(url, {
        src: `/${BUNDLE_DIR}/${key}`,
        file: {
          file: `${BUNDLE_DIR}/${storage_key}`,
          storage_key,
          // used to split the deploy into requests; the data itself is fetched server-side
          size: size / 1024,
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
    if (file.storage_key || UNTOUCHED_FILES.includes(file.file)) return file
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
 *  - string values in primo.json (exact values, so any file name works)
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
    escape_regex(storage_url) + '[^\\s"\'`<>\\\\?#&]+',
    'g'
  )
  for (const file of files) {
    if (file.storage_key || file.file === 'primo.json') continue
    for (const match of file.data.matchAll(pattern))
      urls.add(trim_unbalanced_parens(match[0]))
  }

  // the regex stops at whitespace etc., so drop partial matches of longer URLs
  const all = [...urls]
  for (const url of all) {
    if (all.some((other) => other !== url && other.startsWith(url)))
      urls.delete(url)
  }

  return urls
}

// `url(https://…/a.jpg)` in CSS: drop the closing paren but keep ones in file names like `a (1).jpg`
function trim_unbalanced_parens(url) {
  while (url.endsWith(')') && count(url, ')') > count(url, '('))
    url = url.slice(0, -1)
  return url
}

function count(str, char) {
  return str.split(char).length - 1
}

function walk_strings(value, fn) {
  if (typeof value === 'string') fn(value)
  else if (Array.isArray(value)) value.forEach((v) => walk_strings(v, fn))
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => walk_strings(v, fn))
}

/**
 * Checks the image exists and returns its size in bytes (0 if unknown), or null if it doesn't.
 * @returns {Promise<number | null>}
 */
async function check_image(url) {
  try {
    let res = await fetch(url, { method: 'HEAD' })
    if (res.status === 405) res = await fetch(url)
    if (!res.ok) {
      console.warn(
        `Could not find image ${url} (${res.status}), keeping remote URL`
      )
      return null
    }
    return Number(res.headers.get('content-length')) || 0
  } catch (e) {
    console.warn(`Could not check image ${url}, keeping remote URL`, e)
    return null
  }
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
