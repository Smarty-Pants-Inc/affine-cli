import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { runCli } from './utils/runCli';

describe('auth login CLI', () => {
  it('writes token and baseUrl to the requested profile and prints JSON summary', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-login-'));
    const cfgPath = path.join(tmpDir, 'config.json');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AFFINE_CONFIG_PATH: cfgPath,
    } as any;

    const token = 'cli-token-123';
    const baseUrl = 'https://cli-login.example';

    const logs = await runCli(['auth', 'login', '--json', '--profile', 'test'], {
      baseUrl,
      token,
      timeoutMs: 5000,
      env,
    });

    expect(logs.length).toBeGreaterThan(0);
    const payload = JSON.parse(logs[0]);
    expect(payload && typeof payload === 'object').toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.profile).toBe('test');
    expect(payload.apiBaseUrl).toBe(baseUrl);
    expect(payload.tokenSet).toBe(true);
    expect(payload.cookieSet).toBe(false);
    expect(typeof payload.configPath).toBe('string');
    expect(payload.configPath).toBe(cfgPath);

    const raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as any;
    expect(raw.profile).toBe('test');
    expect(raw.profiles.test.token).toBe(token);
    expect(raw.profiles.test.apiBaseUrl).toBe(baseUrl);
  });

  it('supports cookie-based login without token', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-login-cookie-'));
    const cfgPath = path.join(tmpDir, 'config.json');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AFFINE_CONFIG_PATH: cfgPath,
    } as any;

    const cookie = 'cookie=value; path=/';

    const logs = await runCli(['auth', 'login', '--json', '--profile', 'cookie-only'], {
      cookie,
      timeoutMs: 5000,
      env,
    });

    const payload = JSON.parse(logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.profile).toBe('cookie-only');
    expect(payload.tokenSet).toBe(false);
    expect(payload.cookieSet).toBe(true);

    const raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as any;
    expect(raw.profiles['cookie-only'].cookie).toBe(cookie);
  });

  it('emits a clear error when AFFINE_CONFIG_PATH points to a directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-login-error-'));
    const cfgDirAsPath = tmpDir; // Intentionally use a directory as the config "file" path

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AFFINE_CONFIG_PATH: cfgDirAsPath,
    } as any;

    let err: any | undefined;
    try {
      await runCli(['auth', 'login', '--json', '--profile', 'bad'], {
        token: 'unused-token',
        timeoutMs: 2000,
        env,
      });
    } catch (e: any) {
      err = e;
    }

    expect(err).toBeDefined();
    const msg = String(err?.message || '');
    // The exact filesystem error may vary, but our CLI wrapper message should be present.
    expect(msg.toLowerCase()).toContain('failed to update config');
  });

  it('logout clears stored credentials for the selected profile and login can restore them', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-logout-'));
    const cfgPath = path.join(tmpDir, 'config.json');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AFFINE_CONFIG_PATH: cfgPath,
    } as any;

    const token1 = 'first-token-123';
    const token2 = 'second-token-456';
    const baseUrl = 'https://logout.example';

    // Initial login writes token1
    await runCli(['auth', 'login', '--json', '--profile', 'logout-test'], {
      baseUrl,
      token: token1,
      timeoutMs: 5000,
      env,
    });

    let raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as any;
    expect(raw.profile).toBe('logout-test');
    expect(raw.profiles['logout-test'].token).toBe(token1);

    // Logout clears token/cookie for that profile
    const logoutLogs = await runCli(['auth', 'logout', '--json', '--profile', 'logout-test'], {
      timeoutMs: 5000,
      env,
    });
    const logoutPayload = JSON.parse(logoutLogs[0]);
    expect(logoutPayload.ok).toBe(true);
    expect(logoutPayload.profile).toBe('logout-test');

    raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as any;
    expect(raw.profiles['logout-test'].token).toBeUndefined();
    expect(raw.profiles['logout-test'].cookie).toBeUndefined();

    // Logging in again with a new token overwrites the cleared profile
    await runCli(['auth', 'login', '--json', '--profile', 'logout-test'], {
      baseUrl,
      token: token2,
      timeoutMs: 5000,
      env,
    });

    raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as any;
    expect(raw.profiles['logout-test'].token).toBe(token2);
  });
});
