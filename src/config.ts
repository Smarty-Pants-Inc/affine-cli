import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { readCredentialsFromEnv } from './credentials';

export type Primitive = string | number | boolean | null | undefined;

export type AffineConfig = {
  // Active profile name
  profile?: string;
  // Profiles map
  profiles?: Record<string, Record<string, any>>;
  // Common fields used by the CLI (extensible)
  apiBaseUrl?: string;
  token?: string;
  cookie?: string;
  [key: string]: any;
};

export type LoadConfigOptions = {
  // Force a specific profile (overrides file/env)
  profile?: string;
  // Arbitrary flag-based overrides (highest precedence)
  overrides?: Record<string, any>;
  // Environment variables (defaults to process.env)
  env?: NodeJS.ProcessEnv;
  // Optional override path for config.json (useful for tests)
  configPath?: string;
};

const DEFAULTS: AffineConfig = {
  apiBaseUrl: 'https://api.affine.pro',
};

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge<T extends Record<string, any>, U extends Record<string, any>>(a: T, b: U): T & U {
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (isObject(v) && isObject((out as any)[k])) {
      (out as any)[k] = deepMerge((out as any)[k], v);
    } else if (v !== undefined) {
      (out as any)[k] = v;
    }
  }
  return out as T & U;
}

async function readJsonIfExists(filePath: string): Promise<any | undefined> {
  try {
    const buf = await fs.readFile(filePath, 'utf8');
    return JSON.parse(buf);
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return undefined;
    throw err;
  }
}

function resolveConfigPath(customPath?: string): string {
  if (customPath) return customPath;
  const home = os.homedir();
  return path.join(home, '.affine', 'cli', 'config.json');
}

function normalizeEnv(env: NodeJS.ProcessEnv): Partial<AffineConfig> {
  const out: Partial<AffineConfig> = {};
  if (env.AFFINE_PROFILE) out.profile = env.AFFINE_PROFILE;
  if (env.AFFINE_API_BASE_URL) out.apiBaseUrl = env.AFFINE_API_BASE_URL;
  // Credentials (token/cookie) live in credentials reader, but include here to participate in precedence
  const creds = readCredentialsFromEnv(env);
  Object.assign(out, creds);
  return out;
}

function pickBaseFromFile(fileCfg: any): Record<string, any> {
  if (!isObject(fileCfg)) return {};
  const { profiles: _profiles, profile: _profile, ...rest } = fileCfg as Record<string, any>;
  return rest || {};
}

function applyProfile(fileCfg: any, desiredProfile?: string): Record<string, any> {
  if (!isObject(fileCfg)) return {};
  const profiles = isObject(fileCfg.profiles) ? (fileCfg.profiles as Record<string, any>) : undefined;
  if (!profiles) return {};

  // Determine profile name: explicit > file.profile
  const name = desiredProfile ?? (typeof fileCfg.profile === 'string' ? fileCfg.profile : undefined);
  if (!name) return {};
  const selected = profiles[name];
  if (!isObject(selected)) return {};
  return selected;
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<AffineConfig> {
  const env = opts.env ?? process.env;

  // 1) defaults
  let merged: AffineConfig = { ...DEFAULTS };

  // 2) file (base + profile)
  const cfgPath = resolveConfigPath(opts.configPath);
  const fileCfg = await readJsonIfExists(cfgPath);
  if (fileCfg) {
    const base = pickBaseFromFile(fileCfg);
    merged = deepMerge(merged, base);

    const profFromEnv = normalizeEnv(env).profile;
    const profileName = opts.profile ?? profFromEnv ?? (typeof fileCfg.profile === 'string' ? fileCfg.profile : undefined);
    const prof = applyProfile(fileCfg, profileName);
    if (Object.keys(prof).length) {
      merged = deepMerge(merged, prof);
      merged.profile = profileName;
    } else if (profileName) {
      // Keep the requested profile name even if empty to reflect intent
      merged.profile = profileName;
    }
  }

  // 3) env
  const envCfg = normalizeEnv(env);
  merged = deepMerge(merged, envCfg);

  // 4) flags/overrides
  if (opts.overrides && Object.keys(opts.overrides).length) {
    merged = deepMerge(merged, opts.overrides as Record<string, any>);
  }

  return merged;
}

// Convenience: synchronous variant that avoids async FS when caller already has file config
export async function loadConfigForProfile(profile: string, opts: Omit<LoadConfigOptions, 'profile'> = {}): Promise<AffineConfig> {
  return loadConfig({ ...opts, profile });
}
