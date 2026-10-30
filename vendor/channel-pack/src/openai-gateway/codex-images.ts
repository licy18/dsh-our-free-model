import { OpenAiGatewayError } from './messages.js'
import { parseImageDataUrl } from './images.js'

type ImageType = 'image/png' | 'image/jpeg' | 'image/webp'
type ImageBytes = { data: Uint8Array; mediaType: ImageType }
type ImageResult = { apiVersion: number; traceId: string; elapsedMs: number; images: readonly { b64Json: string }[]; text?: string }
export interface CodexImageTransport {
  apiVersion: number
  generateImages(input: { prompt: string }, context: { signal: AbortSignal }): Promise<ImageResult>
  editImages?(input: { prompt: string; images: readonly ImageBytes[] }, context: { signal: AbortSignal }): Promise<ImageResult>
}

const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_OUTPUT_BYTES = 48 * 1024 * 1024
const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

function imageTypeMatches(type: string, data: Uint8Array): boolean {
  const bytes = Buffer.from(data)
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return type === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
}

function safeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess|token)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(?:[A-Za-z]:\\|\/home\/|\/Users\/)[^\s"']+/g, '[local-path]').slice(0, 4000)
}

function failure(error: unknown): OpenAiGatewayError {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const code = typeof source.code === 'string' ? source.code : ''
  const mapping: Record<string, [number, string]> = {
    OPENAI_CODEX_SIGNED_OUT: [503, 'codex_image_signed_out'],
    OPENAI_CODEX_REAUTH_REQUIRED: [503, 'codex_image_reauth_required'],
    OPENAI_CODEX_RATE_LIMITED: [429, 'codex_image_rate_limited'],
    OPENAI_CODEX_INVALID_REQUEST: [400, 'codex_image_invalid_request'],
    OPENAI_CODEX_TIMEOUT: [504, 'codex_image_result_unknown'],
    OPENAI_CODEX_CANCELED: [499, 'codex_image_result_unknown'],
    OPENAI_CODEX_NETWORK_ERROR: [502, 'codex_image_result_unknown'],
    OPENAI_CODEX_UPSTREAM_REJECTED: [502, 'codex_image_upstream_rejected'],
    OPENAI_CODEX_UPSTREAM_UNAVAILABLE: [502, 'codex_image_upstream_unavailable'],
    OPENAI_CODEX_REDIRECT_REJECTED: [502, 'codex_image_redirect_rejected'],
    OPENAI_CODEX_RESPONSE_TOO_LARGE: [502, 'codex_image_response_too_large'],
    OPENAI_CODEX_MALFORMED_RESPONSE: [502, 'codex_image_malformed_response'],
  }
  const [status, result] = mapping[code] ?? [502, 'codex_image_result_unknown']
  const failure = new OpenAiGatewayError(safeText(source.upstreamMessage) || result, status, 'server_error', result)
  Object.assign(failure, { upstreamStatus: Number.isInteger(source.status) ? source.status : undefined,
    upstreamCode: safeText(source.upstreamCode).slice(0, 100), retryAfterSeconds: Number.isInteger(source.retryAfterSeconds) ? source.retryAfterSeconds : undefined })
  return failure
}

export async function runCodexImageRequest(raw: unknown, edit: boolean, transport: CodexImageTransport | undefined, signal: AbortSignal): Promise<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OpenAiGatewayError('body must be an object')
  const body = raw as Record<string, unknown>
  const allowed = new Set(edit ? ['prompt', 'images'] : ['prompt'])
  if (Object.keys(body).some(key => !allowed.has(key))) throw new OpenAiGatewayError('unsupported image request field')
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32000) throw new OpenAiGatewayError('prompt must be a non-empty string of at most 32000 characters')
  let images: ImageBytes[] = []
  if (edit) {
    if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > MAX_IMAGES) throw new OpenAiGatewayError('images must contain 1 to 5 data URLs')
    images = body.images.map(value => {
      const image = parseImageDataUrl(value)
      const payload = typeof value === 'string' ? value.slice(value.indexOf(',') + 1).replace(/\s+/g, '') : ''
      if (!image || !allowedTypes.has(image.mediaType) || image.data.byteLength > MAX_IMAGE_BYTES || Buffer.from(image.data).toString('base64') !== payload || !imageTypeMatches(image.mediaType, image.data)) throw new OpenAiGatewayError('invalid image data URL or unsupported image type')
      return { data: image.data, mediaType: image.mediaType as ImageType }
    })
  }
  if (!transport || transport.apiVersion !== 1 || typeof transport.generateImages !== 'function' || (edit && typeof transport.editImages !== 'function')) {
    throw new OpenAiGatewayError('Codex image service is unavailable', 503, 'server_error', 'codex_image_service_unavailable')
  }
  try {
    const result = edit ? await transport.editImages!({ prompt: body.prompt, images }, { signal }) : await transport.generateImages({ prompt: body.prompt }, { signal })
    const text = safeText(result.text)
    if (!Array.isArray(result.images) || (!result.images.length && !text) || result.images.length > 4 || result.images.some(image => typeof image.b64Json !== 'string' || !image.b64Json) || result.images.reduce((sum, image) => sum + image.b64Json.length, 0) > MAX_OUTPUT_BYTES * 4 / 3 + 8 || result.images.some(image => {
      const bytes = Buffer.from(image.b64Json, 'base64')
      return bytes.toString('base64') !== image.b64Json || !['image/png', 'image/jpeg', 'image/webp'].some(type => imageTypeMatches(type, bytes))
    })) {
      throw new OpenAiGatewayError('image result unavailable after submission', 502, 'server_error', 'codex_image_result_unknown')
    }
    return { created: Math.floor(Date.now() / 1000), data: result.images.map(image => ({ b64_json: image.b64Json })), ...(text ? { output_text: text } : {}), codex: { trace_id: result.traceId, elapsed_ms: result.elapsedMs } }
  } catch (error) {
    if (error instanceof OpenAiGatewayError) throw error
    throw failure(error)
  }
}
