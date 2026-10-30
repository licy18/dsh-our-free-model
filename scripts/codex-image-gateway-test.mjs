import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }) }
    return nextLoad(url, context)
  },
})
const probe = net.createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const { createOpenAiGateway } = await import('../vendor/channel-pack/src/openai-gateway/server.ts')
let service
let calls = 0
const events = []
const png = 'data:image/png;base64,iVBORw0KGgo='
const jpeg = 'data:image/jpeg;base64,/9j/'
const llm = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), stream: async function* () {} }
const gateway = createOpenAiGateway({ llm, env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'test-key' }, imageTransport: () => service, logger: { info() {}, warn() {}, error() {} } })
const base = `http://127.0.0.1:${port}`
const post = (route, body, auth = true) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer test-key' } : {}) }, body: JSON.stringify(body) })
try {
  await gateway.start()
  let response = await post('/v1/codex/images/generations', { prompt: 'test' }, false)
  assert.equal(response.status, 401)
  response = await post('/v1/codex/images/generations', { prompt: 'test' })
  assert.equal(response.status, 503)
  service = {
    apiVersion: 1,
    async generateImages(input, ctx) { calls++; events.push({ input, signal: ctx.signal }); return { traceId: 'test-id', elapsedMs: 2, images: [{ b64Json: 'iVBORw0KGgo=' }] } },
    async editImages(input, ctx) { calls++; events.push({ input, signal: ctx.signal }); return { traceId: 'test-edit', elapsedMs: 3, images: [{ b64Json: 'iVBORw0KGgo=' }] } },
  }
  response = await post('/v1/codex/images/generations', { prompt: 'synthetic' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data[0].b64_json, 'iVBORw0KGgo=')
  response = await post('/v1/codex/images/edits', { prompt: 'edit', images: [png, jpeg] })
  assert.equal(response.status, 200)
  assert.deepEqual(events[1].input.images.map(x => x.mediaType), ['image/png', 'image/jpeg'])
  assert.ok(events[1].signal instanceof AbortSignal)
  response = await post('/v1/codex/images/edits', { prompt: 'five', images: Array(5).fill(png) })
  assert.equal(response.status, 200)
  assert.equal(events[2].input.images.length, 5)
  for (const invalid of [{ prompt: 'test', images: ['https://example.com/x.png'] }, { prompt: 'test', images: [jpeg.replace('image/jpeg', 'image/png')] }, { prompt: 'test', images: Array(6).fill(png) }, { prompt: 'test', images: [png], size: '1K' }]) {
    response = await post('/v1/codex/images/edits', invalid)
    assert.equal(response.status, 400)
  }
  assert.equal(calls, 3)
  service.generateImages = async () => { calls++; throw Object.assign(new Error('private upstream details'), { code: 'OPENAI_CODEX_TIMEOUT' }) }
  response = await post('/v1/codex/images/generations', { prompt: 'timeout' })
  assert.equal(response.status, 504)
  const error = await response.json()
  assert.equal(error.error.code, 'codex_image_result_unknown')
  assert.equal(JSON.stringify(error).includes('private upstream details'), false)
  assert.equal(calls, 4)
  service.generateImages = async () => ({ traceId: 'text', elapsedMs: 1, images: [], text: 'Cannot create this image.' })
  response = await post('/v1/codex/images/generations', { prompt: 'text-only' })
  const textResult = await response.json()
  assert.equal(response.status, 200)
  assert.equal(textResult.output_text, 'Cannot create this image.')
  assert.deepEqual(textResult.data, [])
  service.generateImages = async () => { throw Object.assign(new Error('discarded'), { code: 'OPENAI_CODEX_UPSTREAM_REJECTED', status: 400, upstreamCode: 'policy_error', upstreamMessage: 'Request refused' }) }
  response = await post('/v1/codex/images/generations', { prompt: 'rejection' })
  const rejection = await response.json()
  assert.equal(rejection.error.code, 'codex_image_upstream_rejected')
  assert.equal(rejection.error.message, 'Request refused')
  assert.equal(rejection.error.upstream_status, 400)
  assert.equal(rejection.error.upstream_code, 'policy_error')
  let aborted
  const observedAbort = new Promise(resolve => { aborted = resolve })
  let started
  const observedStart = new Promise(resolve => { started = resolve })
  service.generateImages = async (_input, ctx) => {
    calls++
    started()
    await new Promise(resolve => ctx.signal.addEventListener('abort', () => { aborted(); resolve() }, { once: true }))
    throw Object.assign(new Error('cancelled'), { code: 'OPENAI_CODEX_CANCELED' })
  }
  const controller = new AbortController()
  const request = fetch(base + '/v1/codex/images/generations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' }, body: JSON.stringify({ prompt: 'cancel' }), signal: controller.signal }).catch(() => undefined)
  await observedStart
  controller.abort()
  await Promise.race([observedAbort, new Promise((_, reject) => setTimeout(() => reject(new Error('transport did not receive cancellation')), 1500))])
  await request
  assert.equal(calls, 5)
  console.log('ok: auth, missing service, generation, ordered edits, validation, timeout without retry, cancellation')
} finally {
  await gateway.close()
  hooks.deregister()
}
