/**
 * Tiny Node request/response helpers shared by the Host routes.
 *
 * The Harness `webServer` hands a route handler the raw Node pair, so the
 * plugin answers with `send()` instead of the `Response` used by the Web
 * standard. Every failure is reported through the stable error payload
 * (`{ok:false, error:{code,message}}`) so the Client can translate codes into
 * localized messages without parsing prose.
 */

import { errorPayload } from './errors.js';

export const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

/** Read the human-readable message of any thrown value. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Write one JSON answer unless the response already left. */
export function send(response, status, payload) {
  if (response.headersSent || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

/** Report a thrown value with its stable code and HTTP status. */
export function sendError(response, error) {
  const payload = errorPayload(error);
  send(response, payload.status, { ok: false, error: { code: payload.code, message: payload.message } });
}

/**
 * Guard a route against anything but one method.
 * @returns true when the request may continue.
 */
export function requireMethod(request, response, method) {
  if (request.method === method) return true;
  send(response, 405, { ok: false, error: { code: 'bad_request', message: 'Method Not Allowed' } });
  return false;
}

/** A Host whose authority is loopback only (the desktop renderer). */
function loopbackAuthority(host) {
  const lower = String(host ?? '').toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * Reject requests that did not come from this Harness page.
 *
 * The route is same-origin only: the Host must be loopback, a cross-site fetch
 * metadata hint is refused, and a present Origin must match the Host header.
 */
export function sameOrigin(request) {
  const host = request.headers.host;
  if (host !== undefined && !loopbackAuthority(host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Buffer an entire raw request body, refusing anything above `maxBytes`. */
export async function readRawBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const error = new Error('请求体超过大小限制');
      error.status = 413;
      error.code = 'too_large';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Buffer and parse a JSON request body with the same size bound. */
export async function readJsonBody(request, maxBytes) {
  const buffer = await readRawBody(request, maxBytes);
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.status = 400;
    error.code = 'bad_request';
    throw error;
  }
}

/** Detach a header value that may be a string or a one-element array. */
export function headerValue(request, name) {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}
