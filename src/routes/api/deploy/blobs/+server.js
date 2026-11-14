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

  // one file at a time: GitHub rate-limits concurrent requests, and large images
  // shouldn't all sit in memory at once
  const res = []
  for (const file of files) {
    try {
      // images are sent as a storage key and downloaded here, to keep request bodies small
      const blob_sha = await create_blob({
        content: file.storage_key
          ? await download_image_base64(file.storage_key)
          : file.data,
        encoding: file.storage_key ? 'base64' : file.encoding,
        token: token?.value,
        repo_name,
      })
      res.push({ path: file.file, sha: blob_sha })
    } catch (e) {
      const message = `Could not upload ${file.file}: ${describe_error(e)}`
      console.error(message)
      return json({ error: message }, { status: 500 })
    }
  }

  return json(res)
}

async function create_blob(
  { content, encoding = 'utf-8', repo_name, token },
  attempt = 1
) {
  try {
    const { data } = await axios.post(
      `https://api.github.com/repos/${repo_name}/git/blobs`,
      { content, encoding },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        // axios caps request bodies at 10MB in Node; base64 images can be bigger
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    )
    return data.sha
  } catch (e) {
    const status = e.response?.status
    // secondary rate limit: wait and retry a few times
    if ((status === 403 || status === 429) && attempt < 4) {
      const retry_after = Number(e.response.headers?.['retry-after'])
      await new Promise((r) =>
        setTimeout(r, Math.min(retry_after || 2 ** attempt, 20) * 1000)
      )
      return create_blob({ content, encoding, repo_name, token }, attempt + 1)
    }
    throw e
  }
}

function describe_error(e) {
  const status = e.response?.status
  const detail = e.response?.data?.message
  return [status, detail || e.message].filter(Boolean).join(' ')
}
