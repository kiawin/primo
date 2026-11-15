import supabase_admin from '$lib/supabase/admin'

/**
 * Downloads an image from the Supabase `images` bucket and returns it base64-encoded.
 * Takes a storage key (not a URL), so callers can only read from this bucket.
 * @param {string} key - path inside the `images` bucket, e.g. `<site id>/<file name>`
 * @returns {Promise<string>}
 */
export async function download_image_base64(key) {
  if (typeof key !== 'string' || !key || key.split('/').includes('..')) {
    throw new Error(`Invalid image key: ${key}`)
  }
  const { data, error } = await supabase_admin.storage
    .from('images')
    .download(key)
  if (error)
    throw new Error(`Could not download image ${key}: ${error.message}`)
  return Buffer.from(await data.arrayBuffer()).toString('base64')
}

const MAX_REMOTE_BYTES = 50 * 1024 * 1024

/**
 * Downloads a public file from any Supabase project's Storage and returns it base64-encoded.
 * Only `https://<ref>.supabase.co/storage/v1/object/public/...` URLs are accepted, so this
 * can't be used to fetch arbitrary URLs from the server.
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function download_public_base64(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (
    parsed.protocol !== 'https:' ||
    !/^[a-z0-9]+\.supabase\.co$/.test(parsed.hostname) ||
    parsed.port ||
    parsed.username ||
    !parsed.pathname.startsWith('/storage/v1/object/public/')
  ) {
    throw new Error(`Not a public Supabase Storage URL: ${url}`)
  }
  const res = await fetch(parsed, { redirect: 'error' })
  if (!res.ok) throw new Error(`Could not download ${url}: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_REMOTE_BYTES) {
    throw new Error(`${url} is larger than ${MAX_REMOTE_BYTES} bytes`)
  }
  return bytes.toString('base64')
}

/**
 * Base64 content for a bundle file the browser sent by reference (see localize_images.js),
 * or null for an ordinary file that carries its own data.
 * @param {{ storage_key?: string, remote_url?: string }} file
 * @returns {Promise<string | null>}
 */
export async function download_remote_file(file) {
  if (file.storage_key) return download_image_base64(file.storage_key)
  if (file.remote_url) return download_public_base64(file.remote_url)
  return null
}
