import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { registerHooks } from 'node:module'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-image-pack-'))
const probe = net.createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '1'
process.env.DSH_OPENAI_GATEWAY_PORT = String(port)
process.env.DSH_OPENAI_GATEWAY_API_KEY = 'test-pack-key'
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
  return nextResolve(specifier, context)
} })
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('external network disabled') }
const cleanups = []
let calls = 0
const services = {
  profileContext: { home: scratch },
  credentials: { resolve: async () => undefined, describe: async () => undefined, set: async () => {}, unset: async () => {} },
  llm: { registerAdapter() {}, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), stream: async function* () {} },
  connection: { fetch: { register() {} } },
  openaiCodexTransport: { apiVersion: 1, async generateImages(input) { calls++; assert.equal(input.prompt, 'pack test'); return { traceId: 'pack', elapsedMs: 1, images: [{ b64Json: 'iVBORw0KGgo=' }] } } },
}
const ctx = {
  ...services,
  logger: { info() {}, warn() {}, error() {} },
  get: name => services[name],
  provide(name, value) { services[name] = value; this[name] = value },
  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
  emit() {},
}
try {
  const pack = await import('../vendor/channel-pack/pack.js')
  pack.apply(ctx, { disableOpencode: true })
  let response
  for (let i = 0; i < 40; i++) {
    try {
      response = await originalFetch(`http://127.0.0.1:${port}/v1/codex/images/generations`, { method: 'POST', headers: { authorization: 'Bearer test-pack-key', 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'pack test' }) })
      break
    } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
  }
  assert.ok(response, 'bundled gateway did not start')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data[0].b64_json, 'iVBORw0KGgo=')
  assert.equal(calls, 1)
  console.log('ok: bundled channel pack mounts gateway and resolves the injected Codex transport')
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup()
  globalThis.fetch = originalFetch
  hooks.deregister()
  if (path.dirname(path.resolve(scratch)) === path.resolve(os.tmpdir())) fs.rmSync(scratch, { recursive: true, force: true })
}
