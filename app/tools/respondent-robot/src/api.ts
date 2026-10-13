/**
 * A small client for the platform's public HTTP API, using Node's built-in
 * fetch. Retries 429 (honouring Retry-After) and 5xx / network failures with
 * exponential backoff and jitter; any other 4xx is returned to the caller as
 * an ApiError carrying the server's own error name and message.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorName: string,
    message: string,
    public readonly path: string,
  ) {
    super(`${status} ${errorName}: ${message} (${path})`);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  baseUrl: string;
  maxRetries: number;
  /** First backoff delay; doubles per attempt, capped at `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
  onRetry?: (info: { path: string; attempt: number; waitMs: number; reason: string }) => void;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? at - Date.now() : null;
}

export class Api {
  readonly baseUrl: string;
  requests = 0;
  retries = 0;

  constructor(private readonly opts: ApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      let reason: string;
      let waitMs: number | null = null;
      try {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (token) headers['authorization'] = `Bearer ${token}`;
        this.requests++;
        const res = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const text = await res.text();
        let data: unknown = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { message: text.slice(0, 200) };
        }
        if (res.ok) return data as T;
        const err = (data ?? {}) as { error?: unknown; message?: unknown };
        const apiErr = new ApiError(
          res.status,
          typeof err.error === 'string' ? err.error : 'Error',
          typeof err.message === 'string' ? err.message : `HTTP ${res.status}`,
          path,
        );
        if (res.status !== 429 && res.status < 500) throw apiErr;
        reason = apiErr.message;
        if (res.status === 429) waitMs = retryAfterMs(res.headers.get('retry-after'));
        if (attempt >= this.opts.maxRetries) throw apiErr;
      } catch (e) {
        // A 4xx, or a 429/5xx that used up its retries, goes to the caller.
        if (e instanceof ApiError) throw e;
        reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        if (attempt >= this.opts.maxRetries) {
          throw new ApiError(0, 'NetworkError', reason, path);
        }
      }
      const backoff = Math.min(this.opts.maxBackoffMs, this.opts.backoffMs * 2 ** attempt);
      const wait = (waitMs ?? backoff) * (0.75 + Math.random() * 0.5);
      this.retries++;
      this.opts.onRetry?.({ path, attempt: attempt + 1, waitMs: Math.round(wait), reason });
      await sleep(wait);
    }
  }

  get<T>(path: string, token?: string): Promise<T> {
    return this.request<T>('GET', path, undefined, token);
  }
  post<T>(path: string, body?: unknown, token?: string): Promise<T> {
    return this.request<T>('POST', path, body ?? {}, token);
  }
  put<T>(path: string, body: unknown, token?: string): Promise<T> {
    return this.request<T>('PUT', path, body, token);
  }
}
