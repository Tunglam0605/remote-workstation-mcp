const DEFAULT_TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function origin() {
  return typeof location === 'undefined' ? 'http://localhost' : location.origin;
}

function apiPath(path) {
  if (typeof path !== 'string' || !/^\/api(?:\/|$)/.test(path)) {
    throw new TypeError('request requires a same-origin API path');
  }
  return new URL(path, origin()).toString();
}

function combinedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, dispose: () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); } };
}

export function createApi(token, { fetchImpl = globalThis.fetch, defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('A setup token is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');

  async function request(path, { method = 'GET', body, signal, timeoutMs = defaultTimeoutMs } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    const bounded = combinedSignal(signal, timeoutMs);
    try {
      const headers = new Headers({ 'x-rwmcp-setup-token': token, 'cache-control': 'no-store', accept: 'application/json' });
      const init = { method, headers, signal: bounded.signal, cache: 'no-store', credentials: 'same-origin' };
      if (body !== undefined) {
        headers.set('content-type', 'application/json');
        init.body = JSON.stringify(body);
      }
      const response = await fetchImpl(apiPath(path), init);
      const contentType = response.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json') ? await response.json() : null;
      if (!response.ok) throw new ApiError(typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`, response.status, data);
      return data;
    } finally {
      bounded.dispose();
    }
  }

  return { request };
}
