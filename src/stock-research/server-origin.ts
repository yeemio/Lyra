import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/** Local mode has no login boundary: validate the HTTP authority before resolving owner. */
export function assertLocalBind(config: { mode: 'local' | 'saas'; bind: string; allowNonLoopbackBind?: boolean }): void {
  const bind = config.bind.toLowerCase();
  const loopback = bind === 'localhost' || bind === '::1' || (isIP(bind) === 4 && bind.startsWith('127.'));
  if (config.mode === 'local' && !loopback && config.allowNonLoopbackBind !== true) {
    throw new Error('LOCAL_NON_LOOPBACK_BIND_REQUIRES_EXPLICIT_OPT_IN');
  }
}

export type LocalRequestError = 'LOCAL_HOST_REJECTED' | 'LOCAL_ORIGIN_REJECTED' | 'LOCAL_FETCH_SITE_REJECTED';

export function localRequestError(req: IncomingMessage): LocalRequestError | null {
  // Do not trust proxy headers, URL userinfo, alternate numeric IP spellings or duplicate Host fields.
  const hostCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'host').length;
  const host = req.headers.host;
  const match = typeof host === 'string' ? /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/i.exec(host) : null;
  const port = match?.[2] === undefined ? 80 : Number(match[2]);
  if (hostCount !== 1 || !match || port > 65535 || port !== req.socket.localPort
    || !req.url?.startsWith('/') || req.url.startsWith('//')) return 'LOCAL_HOST_REJECTED';

  const method = (req.method ?? 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  const expectedOrigin = `http://${match[1]!.toLowerCase()}${port === 80 ? '' : `:${port}`}`;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin);
      if (origin !== parsed.origin || parsed.origin !== expectedOrigin) return 'LOCAL_ORIGIN_REJECTED';
    } catch { return 'LOCAL_ORIGIN_REJECTED'; }
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'LOCAL_FETCH_SITE_REJECTED';
  // Non-browser callers can omit both headers; each write handler still requires the instance CSRF token.
  return null;
}
