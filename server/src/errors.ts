export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal'

export class AppError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details)
export const unauthorized = (message = '未登录或会话已过期') => new AppError(401, 'unauthorized', message)
export const forbidden = (message = '没有权限执行该操作') => new AppError(403, 'forbidden', message)
export const notFound = (message = '资源不存在') => new AppError(404, 'not_found', message)
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details)
export const rateLimited = (message = '请求过于频繁') => new AppError(429, 'rate_limited', message)

export function errorBody(error: AppError): { error: { code: ErrorCode; message: string; details?: unknown } } {
  return { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }
}
