/**
 * 2FA「待兑换」令牌的类型常量与判定（H-2）。
 *
 * 单独成一个模块，是因为三处都要用，而它们之间存在循环依赖风险：
 *   - server/auth.ts      签发 + 兑换端点
 *   - server/sso.ts       SSO 回调签发
 *   - server/webauthn.ts  WebAuthn finish_login 签发
 *   - server/middlewares.ts / auth.ts:authUserFromReq  必须拒绝把它当会话令牌用
 * 任何一处漏判，未完成 2FA 的令牌就能当完整会话使用，等于 2FA 没生效。
 */

export const OTP_PENDING_TYPE = "otp_pending"

/** 待兑换令牌的有效期：只够用户读完验证码输进去，不足以当会话用。 */
export const OTP_PENDING_TTL_SEC = 5 * 60

export function isOtpPendingPayload(payload: any): boolean {
  return !!payload && payload.type === OTP_PENDING_TYPE
}
