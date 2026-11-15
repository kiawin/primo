// Copies files stored in Supabase Storage into the deployed site bundle so the
// published (static) site no longer hot-links to Supabase.
//
// Every page/symbol file in the bundle is scanned for public Supabase Storage URLs:
//  - images uploaded to this server's `images` bucket, e.g.
//    https://<project>.supabase.co/storage/v1/object/public/images/<site>/<file>,
//    are added as `_images/<site>/<file>` and the URL becomes `/_images/<site>/<file>`
//  - public files from any other Supabase project or bucket (e.g. a favicon from a
//    starter template), https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<path>,
//    are added as `_assets/<ref>/<bucket>/<path>` and the URL becomes `/_assets/...`
// URLs are root-relative, like Primo's own `/_symbols/`.
//
// File entries carry only where to get the file (`storage_key` for the images bucket,
// `remote_url` otherwise), not the data: the deploy endpoints download it server-side,
// so large files don't have to fit in the request body sent from the browser.
//
// `primo.json` is intentionally left untouched so a re-imported site keeps working
// in the editor with the original Supabase URLs.

const IMAGES_DIR = '_images'
const ASSETS_DIR = '_assets'
const UNTOUCHED_FILES = ['primo.json']

const SUPABASE_PUBLIC_URL =
  /https:\/\/([a-z0-9]+)\.supabase\.co\/storage\/v1\/object\/public\/[^\s"'`<>\\?#]+/g

/**
 * @typedef {{
 *   file: string,
 *   data?: string,
 *   size: number,
 *   encoding?: 'utf-8' | 'base64',
 *   storage_key?: string,
 *   remote_url?: string
 * }} BundleFile
 */

/** Files whose data the deploy endpoints download themselves */
export function is_remote_file(file) {
  return !!(file.storage_key || file.remote_url)
}

/**
 * @param {Array<BundleFile>} files
 * @param {{ storage_url: string }} options - public base URL of the images bucket, ending with '/'
 * @returns {Promise<Array<BundleFile>>}
 */
export async function localize_images(files, { storage_url }) {
  const urls = collect_urls(files)
  if (urls.size === 0) return files

  /** @type {Map<string, { src: string, file: BundleFile }>} original url -> local copy */
  const localized = new Map()
  await Promise.all(
    [...urls].map(async (url) => {
      const size = await check_file(url)
      if (size === null) return
      localized.set(url, to_bundle_file(url, size, storage_url))
    })
  )
  if (localized.size === 0) return files

  // longest first, so a URL that is a prefix of another one doesn't clobber it
  const replacements = [...localized.entries()].sort(
    ([a], [b]) => b.length - a.length
  )

  const rewritten = files.map((file) => {
    if (is_remote_file(file) || UNTOUCHED_FILES.includes(file.file)) return file
    let data = file.data
    for (const [url, { src }] of replacements) {
      // in HTML attributes `&` is written as `&amp;`, so replace that spelling too
      for (const [from, to] of [
        [url, src],
        [escape_html(url), escape_html(src)],
      ]) {
        if (data.includes(from)) data = data.split(from).join(to)
      }
    }
    if (data === file.data) return file
    return {
      ...file,
      data,
      size: new Blob([data], { type: 'text/plain' }).size / 1024,
    }
  })

  // the same file may be referenced by several URL spellings (e.g. encoded/decoded)
  const bundle_files = new Map()
  for (const { file } of localized.values()) bundle_files.set(file.file, file)

  return [...rewritten, ...bundle_files.values()]
}

/** @returns {{ src: string, file: BundleFile }} */
function to_bundle_file(url, size, storage_url) {
  // used to split the deploy into requests; the data itself is fetched server-side
  const common = {
    size: size / 1024,
    encoding: /** @type {const} */ ('base64'),
  }

  if (url.startsWith(storage_url)) {
    const key = url.slice(storage_url.length)
    const storage_key = safe_decode(key)
    return {
      src: `/${IMAGES_DIR}/${key}`,
      file: { file: `${IMAGES_DIR}/${storage_key}`, storage_key, ...common },
    }
  }

  const { ref, path } = parse_supabase_url(url)
  return {
    src: `/${ASSETS_DIR}/${ref}/${path}`,
    file: {
      file: `${ASSETS_DIR}/${ref}/${safe_decode(path)}`,
      remote_url: url,
      ...common,
    },
  }
}

function parse_supabase_url(url) {
  const [, ref, path] =
    /^https:\/\/([a-z0-9]+)\.supabase\.co\/storage\/v1\/object\/public\/(.+)$/.exec(
      url
    )
  return { ref, path }
}

/**
 * Finds public Supabase Storage URLs in the bundle, from two places:
 *  - string values in primo.json (exact values, so any file name works)
 *  - a regex scan of every text file (catches URLs in page/site code and component code)
 */
function collect_urls(files) {
  const urls = new Set()

  const primo_json = files.find((f) => f.file === 'primo.json')
  if (primo_json) {
    try {
      walk_strings(JSON.parse(primo_json.data), (value) => {
        const url = value.split(/[?#]/)[0]
        if (is_supabase_public_url(url)) urls.add(url)
      })
    } catch (e) {
      console.warn('Could not parse primo.json while collecting images', e)
    }
  }

  for (const file of files) {
    if (is_remote_file(file) || file.file === 'primo.json') continue
    for (const match of file.data.matchAll(SUPABASE_PUBLIC_URL))
      urls.add(trim_unbalanced_parens(unescape_html(match[0])))
  }

  // the regex stops at whitespace etc., so drop partial matches of longer URLs
  const all = [...urls]
  for (const url of all) {
    if (all.some((other) => other !== url && other.startsWith(url)))
      urls.delete(url)
  }

  return urls
}

function is_supabase_public_url(value) {
  return /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/[^/]+\/.+/.test(
    value
  )
}

// `url(https://…/a.jpg)` in CSS: drop the closing paren but keep ones in file names like `a (1).jpg`
function trim_unbalanced_parens(url) {
  while (url.endsWith(')') && count(url, ')') > count(url, '(')) {
    url = url.slice(0, -1)
  }
  return url
}

function escape_html(str) {
  return str.replaceAll('&', '&amp;')
}

function unescape_html(str) {
  return str.replaceAll('&amp;', '&')
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
 * Checks the file exists and returns its size in bytes (0 if unknown), or null if it doesn't.
 * @returns {Promise<number | null>}
 */
async function check_file(url) {
  try {
    let res = await fetch(url, { method: 'HEAD' })
    if (res.status === 405) res = await fetch(url)
    if (!res.ok) {
      console.warn(`Could not find ${url} (${res.status}), keeping remote URL`)
      return null
    }
    return Number(res.headers.get('content-length')) || 0
  } catch (e) {
    console.warn(`Could not check ${url}, keeping remote URL`, e)
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
