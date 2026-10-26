// Minimal host contracts for the generated channel pack's offline mount test.
// Provider implementation, pool persistence and RPC handlers remain real.
import { randomUUID } from 'node:crypto'
export class Service {
  constructor(ctx, name) { this.ctx = ctx; ctx.provide(name, this) }
}
export class LlmAdapter {}
export class LlmError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
export const credentialRef = value => value
export const ReasoningEffortId = value => value
export const ToolCallId = value => value
export const createUserMessage = value => value
/** Mirrors the 0.1.7+ kernel factory this pack targets; the legacy shape is covered by its own fixture. */
export const createToolResultMessage = ({ callId, content, isError }) => ({
  id: randomUUID(),
  role: 'tool',
  toolCallId: callId,
  content,
  ...isError === true ? { isError: true } : {},
  source: { kind: 'tool', callId },
})
export const attributionHeaders = () => ({})
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'
export const isContextWindowExceededError = error => error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = error => error?.code === QUOTA_EXCEEDED_CODE
const schema = new Proxy(() => schema, { get: () => schema })
export default schema
