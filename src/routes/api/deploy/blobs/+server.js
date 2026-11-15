import { json, error as server_error } from '@sveltejs/kit'
import { createHash } from 'node:crypto'
import supabase_admin from '$lib/supabase/admin'
import axios from 'axios'
import { download_remote_file } from '$lib/server/storage_images'

// files uploaded in parallel within one request; kept low because GitHub
// rate-limits bursts of content-creating requests
const CONCURRENCY = 4

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

  const github = { repo_name, token: token?.value }

  try {
    // blobs already in the repo (e.g. images from the last deploy) don't need uploading again
    const existing = await fetch_existing_blob_shas(github)

    const res = await map_with_concurrency(files, CONCURRENCY, async (file) => {
      try {
        // images are sent by reference and downloaded here, to keep request bodies small
        const remote = await download_remote_file(file)
        const content = remote ?? file.data
        const encoding = remote !== null ? 'base64' : file.encoding || 'utf-8'

        const sha = git_blob_sha(content, encoding)
        if (!existing.has(sha)) {
          await create_blob({ ...github, content, encoding })
        }
        return { path: file.file, sha }
      } catch (e) {
        throw new Error(`Could not upload ${file.file}: ${describe_error(e)}`)
      }
    })

    return json(res)
  } catch (e) {
    console.error(e.message)
    return json({ error: e.message }, { status: 500 })
  }
}

/** The SHA git (and GitHub) uses for a blob with this content */
function git_blob_sha(content, encoding) {
  const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8')
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex')
}

/** @returns {Promise<Set<string>>} */
async function fetch_existing_blob_shas({ repo_name, token }) {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${repo_name}/git/trees/main?recursive=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      }
    )
    return new Set(
      data.tree.filter((item) => item.type === 'blob').map((item) => item.sha)
    )
  } catch (e) {
    // e.g. an empty repo: upload everything
    return new Set()
  }
}

async function create_blob(
  { content, encoding, repo_name, token },
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
        setTimeout(r, Math.min(retry_after || 2 ** attempt, 10) * 1000)
      )
      return create_blob({ content, encoding, repo_name, token }, attempt + 1)
    }
    throw e
  }
}

async function map_with_concurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return results
}

function describe_error(e) {
  const status = e.response?.status
  const detail = e.response?.data?.message
  return [status, detail || e.message].filter(Boolean).join(' ')
}
