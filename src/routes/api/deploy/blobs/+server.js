import { json, error as server_error } from '@sveltejs/kit'
import supabase_admin from '$lib/supabase/admin'
import axios from 'axios'
import { download_image_base64 } from '$lib/server/storage_images'

export async function POST({ request, locals }) {
  const session = await locals.getSession()
  if (!session) {
    // the user is not signed in
    throw server_error(401, { message: 'Unauthorized' })
  }

  const { repo_name, files, provider } = await request.json()

  const { data: token } = await supabase_admin
    .from('config')
    .select('value')
    .eq('id', `${provider}_token`)
    .single()

  const res = await Promise.all(
    files.map(async (file) => {
      // images are sent as a storage key and downloaded here, to keep request bodies small
      const blob_sha = await create_blob({
        content: file.storage_key
          ? await download_image_base64(file.storage_key)
          : file.data,
        encoding: file.storage_key ? 'base64' : file.encoding,
        token: token?.value,
        repo_name,
      })
      return {
        path: file.file,
        sha: blob_sha,
      }
    })
  )

  return json(res)
}

async function create_blob({ content, encoding = 'utf-8', repo_name, token }) {
  const { data } = await axios.post(
    `https://api.github.com/repos/${repo_name}/git/blobs`,
    {
      content,
      encoding,
    },
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  )

  return data.sha
}
