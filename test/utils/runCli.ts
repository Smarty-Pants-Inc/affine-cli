import { spawn } from 'node:child_process';
import path from 'node:path';

export type RunCliOptions = {
  baseUrl?: string;
  token?: string;
  cookie?: string;
  workspaceId?: string;
  timeoutMs?: number;
  /**
   * When true, do not reject on non-zero exit code. Useful for tests that
   * intentionally exercise error paths while still inspecting CLI output.
   */
  allowNonZeroExit?: boolean;
  /** Optional extra environment overrides for the child process. */
  env?: NodeJS.ProcessEnv;
};

const CLI_ENTRY = path.resolve(__dirname, '../../dist/index.js');

export async function runCli(args: string[], opts: RunCliOptions): Promise<string[]> {
  const flags: string[] = [];
  if (opts.baseUrl) {
    flags.push('--base-url', opts.baseUrl);
  }
  if (opts.workspaceId && !args.includes('--workspace-id') && !args.includes('--workspace-id=')) {
    flags.push('--workspace-id', opts.workspaceId);
  }
  if (opts.token) {
    flags.push('--token', opts.token);
  } else if (opts.cookie) {
    flags.push('--cookie', opts.cookie);
  }
  if (typeof opts.timeoutMs === 'number') {
    flags.push('--timeout', String(opts.timeoutMs));
  }

  const fullArgs = [CLI_ENTRY, ...args, ...flags];

  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(process.execPath, fullArgs, {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, ...(opts.env ?? {}) },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      const trimmedStdout = stdout.trimEnd();
      const trimmedStderr = stderr.trimEnd();
      const lines = trimmedStdout.length ? trimmedStdout.split(/\r?\n/) : [];

      if (code && code !== 0 && !opts.allowNonZeroExit) {
        const message = trimmedStderr || trimmedStdout || `CLI exited with code ${code}`;
        const error: any = new Error(message);
        error.exitCode = code;
        error.stdout = trimmedStdout;
        error.stderr = trimmedStderr;
        return reject(error);
      }

      resolve(lines);
    });
  });
}

export default { runCli };
