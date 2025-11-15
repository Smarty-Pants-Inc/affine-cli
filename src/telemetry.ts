/*
 * Opt-in telemetry (CLI-020)
 * Disabled by default; enable via AFFINE_CLI_TELEMETRY=1 and optional AFFINE_CLI_TELEMETRY_URL.
 * No secrets collected; fire-and-forget best-effort POST when configured.
 */

import request from './http';

export type TelemetryEvent = {
  name: string;
  props?: Record<string, any>;
};

export function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.AFFINE_CLI_TELEMETRY || '') === '1';
}

export async function captureEvent(evt: TelemetryEvent): Promise<void> {
  if (!isEnabled()) return;
  const url = process.env.AFFINE_CLI_TELEMETRY_URL;
  if (!url) return; // no endpoint configured
  try {
    const payload = {
      v: 1,
      t: Date.now(),
      n: evt.name,
      p: sanitize(evt.props ?? {}),
      sys: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pkg: 'affine-cli',
      },
    };
    await request({ url, method: 'POST', headers: { 'content-type': 'application/json' }, json: payload, timeoutMs: 2000, responseType: 'json' });
  } catch {
    // swallow errors; telemetry must not affect CLI behavior
  }
}

/**
 * Helper to instrument a command handler without affecting control flow.
 * - Measures duration
 * - Reports { ok, durationMs, ...props }
 * - Fire-and-forget (no await) and fully isolated from command errors
 */
export function withTelemetry<T extends any[], R = any>(
  name: string,
  fn: (this: any, ...args: T) => Promise<R> | R,
  props?: Record<string, any> | (() => Record<string, any>),
) {
  return async function (this: any, ...args: T): Promise<R> {
    const start = Date.now();
    let ok = false;
    try {
      const res = await fn.apply(this, args);
      ok = true;
      return res as R;
    } finally {
      const durationMs = Date.now() - start;
      try {
        const extra = typeof props === 'function' ? (props as () => Record<string, any>)() : props;
        // fire-and-forget; never await
        void captureEvent({ name, props: { ...(extra ?? {}), ok, durationMs } });
      } catch {
        // never throw from telemetry wrapper
      }
    }
  };
}

function sanitize(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k).toLowerCase();
    if (
      key.includes('token') ||
      key.includes('cookie') ||
      key.includes('auth') ||
      key.includes('secret') ||
      key.includes('password') ||
      key.includes('pass') ||
      key.includes('apikey') ||
      key.includes('api_key') ||
      key.includes('session')
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

export default { isEnabled, captureEvent, withTelemetry };
