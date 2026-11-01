/**
 * 网关侧的上游会话标识。
 *
 * DSH 应用内对话由 pi-ai 的 `withOpenCodeSessionHeader()` 把会话 ID 写成
 * `x-opencode-session`；网关路径没有对话身份，缺这个头时 OpenCode Go 直接回
 * 400 `MissingSessionID`（"cannot be routed efficiently"）。网关本身就是共享
 * 入口，没有「哪一个对话」可言，所以统一带一个固定值：它只给上游的路由亲和
 * 一个落点，不承担身份语义。
 *
 * pi-ai 的包装器见到调用方已显式给出该头就会让路，因此这里下发 `sessionId`
 * 等价于钉住网关侧的亲和，且不会覆盖宿主在应用内为每个对话注入的值。
 *
 * ## 为什么单列一个模块
 *
 * Chat（`messages.ts`）与 Responses（`responses.ts`）各有自己的选项构造函数。
 * 这条要求属于**网关这一侧**，不属于某个协议：写在其中一个里，另一个端点就会
 * 漏掉（`/v1/responses` 曾因此继续 400）。两边引用同一份常量即可保证口径一致。
 */

/** 全体网关流量共用的上游会话标识。 */
export const GATEWAY_UPSTREAM_SESSION = 'ses_ofm0gateway0shared0000000'

/** 上游要求 per-request 会话标识的 provider。 */
const SESSION_REQUIRED_PROVIDERS = new Set(['opencode-go'])

/**
 * 该 provider 是否需要网关补一个会话标识；需要时返回要下发的 `sessionId`。
 *
 * 只覆盖明确要求的 provider：免费车道沿用自己按 seed 取的 `global`，
 * 其它 provider 不因网关的这层需要而被塞入会话标识。
 */
export function gatewaySessionFor(provider: string): string | undefined {
  return SESSION_REQUIRED_PROVIDERS.has(provider) ? GATEWAY_UPSTREAM_SESSION : undefined
}
