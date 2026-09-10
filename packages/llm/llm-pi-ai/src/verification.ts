/** Bounded, non-generative exact-model verification for OpenAI-compatible routes. */
import { LlmError, isCredentialHeaderName } from '@deepseek-ai/dsh-llm'

const METADATA_BYTES = 64 * 1024

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try { await body?.cancel() }
  catch { /* Cleanup cannot replace the already-decided HTTP or size failure. */ }
}

async function verifyMetadata(response: Response, provider: string, model: string): Promise<void> {
  const oversized = () => new LlmError('provider verification metadata exceeded its byte limit', 'VERIFICATION_FAILED')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > METADATA_BYTES) {
    await cancelBody(response.body)
    throw oversized()
  }
  if (response.body === null) throw new LlmError('provider verification returned no metadata', 'VERIFICATION_FAILED')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > METADATA_BYTES) throw oversized()
      chunks.push(next.value)
    }
  } finally {
    try { await reader.cancel() }
    catch { /* The selected metadata result owns the outcome, not stream cleanup. */ }
    reader.releaseLock()
  }
  let data: unknown
  try { data = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
  catch { throw new LlmError('provider verification metadata was not valid JSON', 'VERIFICATION_FAILED') }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LlmError('provider verification metadata was not an object', 'VERIFICATION_FAILED')
  }
  if (!('id' in data) || data.id !== model) throw new LlmError('provider verification returned a different model', 'INVALID_MODEL_INFO')
  if ('provider' in data && data.provider !== provider) throw new LlmError('provider verification returned a different provider', 'INVALID_MODEL_INFO')
}

/**
 * Check exact metadata and an unauthenticated challenge without generating model output.
 * @param request - captured endpoint, route, headers and cancellation signal.
 * @returns authentication proof, reachability only, or undefined when the owner must verify generation instead.
 */
export async function verifyExactModel(request: {
  baseURL: string
  provider: string
  model: string
  headers: Record<string, string>
  publicHeaders: Record<string, string>
  signal: AbortSignal
}): Promise<'metadata-auth' | 'endpoint-catalog' | undefined> {
  const { provider, model, signal } = request
  const url = `${request.baseURL.replace(/\/+$/u, '')}/models/${encodeURIComponent(model)}`
  const aborted = () => { if (signal.aborted) throw new LlmError('provider metadata verification aborted', 'ABORTED') }
  aborted()
  let response: Response
  try { response = await fetch(url, { method: 'GET', headers: request.headers, signal, redirect: 'manual' }) }
  catch { aborted(); throw new LlmError('provider metadata verification could not reach its configured endpoint', 'VERIFICATION_FAILED') }
  if (signal.aborted) { await cancelBody(response.body); aborted() }
  if (!response.ok) {
    await cancelBody(response.body)
    if (response.status === 401 || response.status === 403) throw new LlmError('provider metadata verification rejected the configured credential', 'AUTH')
    if (response.status === 404 || response.status === 405) return undefined
    throw new LlmError(`provider metadata verification answered HTTP ${response.status}`, 'VERIFICATION_FAILED')
  }
  try { await verifyMetadata(response, provider, model) }
  catch (error) { aborted(); throw error }
  aborted()
  const headers = Object.fromEntries(Object.entries(request.publicHeaders).filter(([name]) => !isCredentialHeaderName(name)))
  let challenge: Response
  try { challenge = await fetch(url, { method: 'GET', headers, signal, redirect: 'manual' }) }
  catch { aborted(); return 'endpoint-catalog' }
  await cancelBody(challenge.body)
  aborted()
  return challenge.status === 401 || challenge.status === 403 ? 'metadata-auth' : 'endpoint-catalog'
}
