/**
 * Stable error vocabulary shared by the Host routes and the Client.
 *
 * Every thrown SkillError becomes `{error:{code,message}}`; anything else is
 * reported as `internal_error` without leaking a stack trace.
 */

export const ERROR_STATUS = Object.freeze({
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  invalid_skill: 422,
  bad_archive: 422,
  unsupported_archive: 415,
  too_large: 413,
  no_model: 503,
  model_error: 502,
  model_timeout: 504,
  internal_error: 500,
});

export class SkillError extends Error {
  /**
   * @param {keyof typeof ERROR_STATUS} code
   * @param {string} message
   * @param {{status?:number, cause?:unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SkillError';
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code] ?? 500;
  }
}

export function fail(code, message, options) {
  throw new SkillError(code, message, options);
}

export function isSkillError(error) {
  return error instanceof SkillError;
}

/** Normalize any thrown value into the public HTTP payload. */
export function errorPayload(error) {
  if (error instanceof SkillError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: 'internal_error', message: error.message, status: 500 };
  }
  return { code: 'internal_error', message: '内部错误，请稍后重试', status: 500 };
}

export function errorResponse(error) {
  const payload = errorPayload(error);
  return Response.json(
    { error: { code: payload.code, message: payload.message } },
    { status: payload.status, headers: { 'cache-control': 'no-store' } },
  );
}
