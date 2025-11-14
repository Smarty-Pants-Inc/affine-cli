import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { deepMerge, loadConfig } from '../src/config';

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
});
