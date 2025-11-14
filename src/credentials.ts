export type RedactOptions = {
  // Keep first n characters visible
  prefix?: number;
  // Keep last n characters visible
  suffix?: number;
  // Replacement character/string
  mask?: string;
};

export const DEFAULT_REDACT_OPTIONS: Required<RedactOptions> = {
  prefix: 4,
  suffix: 2,
  mask: '*',
};

export function redactValue(value: unknown, opts: RedactOptions = DEFAULT_REDACT_OPTIONS): string {
  const { prefix = 4, suffix = 2, mask = '*' } = opts;
  const str = value == null ? '' : String(value);
  if (str.length === 0) return '';
  if (str.length <= prefix + suffix) return mask.repeat(Math.max(0, str.length));
  const head = str.slice(0, prefix);
  const tail = str.slice(-suffix);
  const middle = mask.repeat(Math.max(0, str.length - prefix - suffix));
  return `${head}${middle}${tail}`;
}

export const SENSITIVE_KEYS = new Set(['token', 'cookie', 'authorization', 'auth', 'password', 'secret']);

export function redactConfigDeep<T = any>(obj: T, keys: Set<string> = SENSITIVE_KEYS): T {
  if (Array.isArray(obj)) {
    return obj.map(v => redactConfigDeep(v, keys)) as unknown as T;
  }
  if (obj && typeof obj === 'object') {
    const out: any = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj as any)) {
      if (keys.has(k)) {
        out[k] = typeof v === 'string' ? redactValue(v) : redactValue(String(v ?? ''));
      } else {
        out[k] = redactConfigDeep(v, keys);
      }
    }
    return out as T;
  }
  return obj;
}

export function readCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): { token?: string; cookie?: string } {
  const token = env.AFFINE_TOKEN?.trim();
  const cookie = env.AFFINE_COOKIE?.trim();
  const out: { token?: string; cookie?: string } = {};
  if (token) out.token = token;
  if (cookie) out.cookie = cookie;
  return out;
}
