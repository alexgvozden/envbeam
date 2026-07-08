import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { redactUrlCreds } from './redact.js';

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Extra environment variables merged over process.env. */
  env?: Record<string, string | undefined>;
  /** String piped to the child's stdin. */
  input?: string;
  /** Milliseconds before the child is killed. */
  timeout?: number;
  /** When true, a non-zero exit does not throw; the caller inspects `code`. */
  allowFailure?: boolean;
  /** Stream stdout/stderr to the parent's stdio instead of capturing. */
  inherit?: boolean;
  /** Run command through shell (needed for .cmd/.bat on Windows). */
  shell?: boolean;
}

export interface RunResult {
  command: string;
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  readonly result: RunResult;
  constructor(result: RunResult) {
    const cmd = [result.command, ...result.args].join(' ');
    super(
      `Command failed (exit ${result.code}): ${cmd}\n${result.stderr || result.stdout}`.trim(),
    );
    this.name = 'CommandError';
    this.result = result;
  }
}

/**
 * Abstraction over shelling out to an external CLI. Every provider depends on
 * this rather than on `child_process` directly, so tests can inject a fake.
 */
export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** Resolve whether an executable is reachable on PATH. */
  which(command: string): Promise<string | null>;
}

/**
 * When on, RealCommandRunner traces every external command + exit code to
 * stderr. Toggled by `--verbose`, or by `ENVBEAM_TRACE=1` from process start
 * (handy for verifying a deployed build and for non-interactive debugging).
 */
let COMMAND_TRACE = ['1', 'true'].includes(process.env.ENVBEAM_TRACE ?? '');
export function setCommandTrace(on: boolean): void {
  COMMAND_TRACE = on;
}

function traceStart(command: string, args: string[]): void {
  // Redact credentials embedded in URL args (e.g. postgres://u:pw@h, token git
  // remotes) so a --verbose / ENVBEAM_TRACE run never prints secrets.
  if (COMMAND_TRACE) {
    process.stderr.write(pc.dim(`  $ ${[command, ...args].map(redactUrlCreds).join(' ')}`) + '\n');
  }
}
function traceEnd(command: string, code: number, stderr: string): void {
  if (!COMMAND_TRACE) return;
  let summary = '';
  if (code !== 0) {
    // Prefer the line that names the error over progress noise (e.g. compose's
    // "db Pulling" lines precede the actual "Error response from daemon: …").
    const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
    summary = lines.find((l) => /error|failed|denied|cannot|fatal|refused/i.test(l)) ?? lines[0] ?? '';
  }
  process.stderr.write(pc.dim(`    → exit ${code}${summary ? `: ${redactUrlCreds(summary)}` : ''}`) + '\n');
}

export class RealCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    traceStart(command, args);
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...stripUndefined(options.env) } : process.env,
        stdio: options.inherit
          ? ['inherit', 'inherit', 'inherit']
          : [options.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: options.shell,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;

      if (options.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeout);
      }

      if (!options.inherit) {
        child.stdout?.on('data', (d) => {
          stdout += d.toString();
        });
        child.stderr?.on('data', (d) => {
          stderr += d.toString();
        });
      }

      if (options.input != null && child.stdin) {
        child.stdin.write(options.input);
        child.stdin.end();
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        // A spawn failure (e.g. binary not on PATH → ENOENT) is, under
        // allowFailure, just a non-zero result the caller can inspect — not a
        // crash. This keeps best-effort steps tolerant of missing tools.
        if (options.allowFailure) {
          traceEnd(command, 127, (err as Error).message);
          resolve({ command, args, code: 127, stdout, stderr: `${stderr}${(err as Error).message}` });
          return;
        }
        traceEnd(command, 127, (err as Error).message);
        reject(err);
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const result: RunResult = {
          command,
          args,
          code: timedOut ? 124 : (code ?? 0),
          stdout,
          stderr: timedOut ? `${stderr}\n[envbeam] command timed out` : stderr,
        };
        traceEnd(command, result.code, result.stderr);
        if (result.code !== 0 && !options.allowFailure) {
          reject(new CommandError(result));
          return;
        }
        resolve(result);
      });
    });
  }

  async which(command: string): Promise<string | null> {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    try {
      const res = await this.run(probe, [command], { allowFailure: true });
      if (res.code !== 0) return null;
      const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return first ?? null;
    } catch {
      return null;
    }
  }
}

function stripUndefined(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
