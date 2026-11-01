/**
 * 网关侧必须给「要求 per-request 会话标识」的 provider 一个固定的上游会话值。
 *
 * DSH 应用内对话由 pi-ai 的 `withOpenCodeSessionHeader()` 把会话 ID 写成
 * `x-opencode-session`；网关路径没有对话身份，缺这个头时 OpenCode Go 回
 * 400 `MissingSessionID`。这条回归锁住三件事：
 *   1. `opencode-go` 拿到一个非空、稳定的 sessionId；
 *   2. 免费车道不被改变（仍走自己的 seed）；
 *   3. 其它 provider 不被无端塞入会话标识。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const hostEntry = import.meta.resolve('@deepseek-ai/dsh-llm')
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const packUrl = new URL('../vendor/channel-pack/pack.js', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm'
      && (context.parentURL?.startsWith(sourceRoot) || context.parentURL === packUrl)) {
      return { url: hostEntry, shortCircuit: true }
    }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === packUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: fs.readFileSync(fileURLToPath(url), 'utf8')
          + '\nexport { toGenerateOptions };\n',
      }
    }
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
      }
    }
    return nextLoad(url, context)
  },
})

const build = async label => {
  const module = await import(label === 'source'
    ? new URL('../vendor/channel-pack/src/openai-gateway/messages.ts', import.meta.url).href
    : packUrl)
  return module.toGenerateOptions
}

const body = model => ({ model, messages: [{ role: 'user', content: 'ping' }] })

for (const label of ['source', 'bundle']) {
  const toGenerateOptions = await build(label)
  const signal = AbortSignal.timeout(5000)

  const paid = await toGenerateOptions(body('opencode-go/deepseek-v4.1-flash'), signal)
  assert.equal(typeof paid.sessionId, 'string', `${label}: opencode-go must carry a session id`)
  assert.ok(paid.sessionId.length >= 8, `${label}: session id must be a real token, got ${JSON.stringify(paid.sessionId)}`)

  const paidAgain = await toGenerateOptions(body('opencode-go/deepseek-v4.1-flash'), signal)
  assert.equal(paidAgain.sessionId, paid.sessionId, `${label}: the gateway id must be stable across requests`)

  const freeLane = await toGenerateOptions(body('our-free-model/deepseek-v4.1-flash-free'), signal)
  assert.equal(freeLane.sessionId, undefined, `${label}: the free lane must keep its own seed, not inherit the gateway id`)

  const other = await toGenerateOptions(body('deepseek-official/deepseek-flash'), signal)
  assert.equal(other.sessionId, undefined, `${label}: unrelated providers must not be given a session id`)

  console.log(`PASS ${label}: opencode-go pinned to one gateway session id; free lane and other providers untouched`)
}

// The value must be a plausible OpenCode session token, not an empty placeholder.
const toGenerateOptions = await build('bundle')
const { sessionId } = await toGenerateOptions(body('opencode-go/deepseek-v4.1-flash'), AbortSignal.timeout(5000))
assert.match(sessionId, /^ses_[A-Za-z0-9]{8,}$/, `session id must look like an OpenCode session token, got ${sessionId}`)
console.log('PASS session id shape:', sessionId)
