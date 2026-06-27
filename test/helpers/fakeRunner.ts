import type { CommandRunner, RunOptions, RunResult } from '../../src/core/util/exec.js';
import { CommandError } from '../../src/core/util/exec.js';

export interface RecordedCall {
  command: string;
  args: string[];
  options: RunOptions;
}

export interface StubResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
}

type Matcher = (command: string, args: string[]) => boolean;
type Responder = StubResponse | ((command: string, args: string[], options: RunOptions) => StubResponse);

interface Rule {
  matcher: Matcher;
  responder: Responder;
}

/**
 * Scriptable CommandRunner for tests. Register responses by command/arg
 * predicate; every invocation is recorded for assertions. Unmatched commands
 * default to exit 0 / empty output unless `strict` is set.
 */
export class FakeRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  private readonly rules: Rule[] = [];
  private readonly onPath = new Set<string>();
  strict: boolean;

  constructor(opts: { strict?: boolean; available?: string[] } = {}) {
    this.strict = opts.strict ?? false;
    for (const c of opts.available ?? []) this.onPath.add(c);
  }

  /** Register a stubbed response. `match` can be a command name, a
   *  "command arg0 arg1" prefix string, or a predicate. */
  on(match: string | Matcher, responder: Responder): this {
    const matcher: Matcher =
      typeof match === 'function'
        ? match
        : (command, args) => {
            const parts = match.split(/\s+/).filter(Boolean);
            const full = [command, ...args];
            return parts.every((p, i) => full[i] === p);
          };
    this.rules.push({ matcher, responder });
    return this;
  }

  /** Mark commands as present on PATH for `which`. */
  available(...commands: string[]): this {
    for (const c of commands) this.onPath.add(c);
    return this;
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ command, args, options });
    const rule = [...this.rules].reverse().find((r) => r.matcher(command, args));
    if (!rule) {
      if (this.strict) {
        throw new Error(`FakeRunner: no stub for: ${[command, ...args].join(' ')}`);
      }
      return { command, args, code: 0, stdout: '', stderr: '' };
    }
    const resp =
      typeof rule.responder === 'function' ? rule.responder(command, args, options) : rule.responder;
    const result: RunResult = {
      command,
      args,
      code: resp.code ?? 0,
      stdout: resp.stdout ?? '',
      stderr: resp.stderr ?? '',
    };
    if (result.code !== 0 && !options.allowFailure) {
      throw new CommandError(result);
    }
    return result;
  }

  async which(command: string): Promise<string | null> {
    return this.onPath.has(command) ? `/usr/bin/${command}` : null;
  }

  /** Filter recorded calls by command name. */
  callsTo(command: string): RecordedCall[] {
    return this.calls.filter((c) => c.command === command);
  }

  /** True if any recorded call matches the "command arg0 arg1" prefix. */
  called(prefix: string): boolean {
    const parts = prefix.split(/\s+/).filter(Boolean);
    return this.calls.some((c) => {
      const full = [c.command, ...c.args];
      return parts.every((p, i) => full[i] === p);
    });
  }
}
