import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { deepMerge, loadConfig, writeConfigProfile } from '../src/config';

describe('config loadConfig', () => {
  it('merges defaults, file, env, and overrides with correct precedence', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-config-'));
    const cfgPath = path.join(tmpDir, 'config.json');

    const fileCfg = {
      apiBaseUrl: 'https://file-base',
      profile: 'default',
      profiles: {
        default: { apiBaseUrl: 'https://file-default', token: 'file-token' },
        alt: { apiBaseUrl: 'https://file-alt', cookie: 'file-cookie' },
      },
      extra: { nested: true },
    };
    await fs.writeFile(cfgPath, JSON.stringify(fileCfg), 'utf8');

    const env: NodeJS.ProcessEnv = {
      AFFINE_PROFILE: 'alt',
      AFFINE_API_BASE_URL: 'https://env-base',
      AFFINE_TOKEN: 'env-token',
    } as any;

    const cfg = await loadConfig({ env, configPath: cfgPath, overrides: { apiBaseUrl: 'https://override', extra: { flag: 1 } } });

    // Overrides win over env and file
    expect(cfg.apiBaseUrl).toBe('https://override');
    // Profile resolved from env/profile map
    expect(cfg.profile).toBe('alt');
    // Credentials pulled from env via readCredentialsFromEnv
    expect(cfg.token).toBe('env-token');
    // Deep merge preserves nested file values and overlay overrides
    expect(cfg.extra).toEqual({ nested: true, flag: 1 });
  });

  it('deepMerge combines nested objects without overwriting existing branches', () => {
    const a = { a: 1, nested: { x: 1, y: 2 }, keep: { v: 1 } };
    const b = { b: 2, nested: { y: 3, z: 4 }, keep: undefined };
    const merged = deepMerge(a, b);

    expect(merged).toEqual({
      a: 1,
      b: 2,
      nested: { x: 1, y: 3, z: 4 },
      keep: { v: 1 },
    });
  });

  it('writeConfigProfile creates and updates profiles while preserving existing fields', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-config-write-'));
    const cfgPath = path.join(tmpDir, 'config.json');

    const initial = {
      apiBaseUrl: 'https://file-base',
      profile: 'default',
      profiles: {
        default: { apiBaseUrl: 'https://file-default', token: 'old-token', keep: 'value' },
        other: { token: 'other-token' },
      },
      extra: { nested: true },
    };
    await fs.writeFile(cfgPath, JSON.stringify(initial), 'utf8');

    const res = await writeConfigProfile({
      profile: 'default',
      apiBaseUrl: 'https://new-default',
      token: 'new-token',
      configPath: cfgPath,
    });

    expect(res.path).toBe(cfgPath);
    expect(res.profile).toBe('default');
    expect(res.profileConfig).toMatchObject({
      apiBaseUrl: 'https://new-default',
      token: 'new-token',
      keep: 'value',
    });

    const raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as any;
    // Top-level fields preserved
    expect(raw.apiBaseUrl).toBe('https://file-base');
    expect(raw.extra).toEqual({ nested: true });
    // Other profiles preserved
    expect(raw.profiles.other).toEqual({ token: 'other-token' });
  });

  it('writeConfigProfile respects AFFINE_CONFIG_PATH env override', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-config-env-'));
    const cfgPath = path.join(tmpDir, 'affine-config.json');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AFFINE_CONFIG_PATH: cfgPath,
    } as any;

    const res = await writeConfigProfile({
      profile: 'default',
      token: 'env-token',
      env,
    });

    expect(res.path).toBe(cfgPath);
    const raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as any;
    expect(raw.profile).toBe('default');
    expect(raw.profiles.default.token).toBe('env-token');
  });
});
