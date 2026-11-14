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
