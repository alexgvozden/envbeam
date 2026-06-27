import pc from 'picocolors';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** When true, mutating actions are previews; the logger tags them. */
  dryRun?: boolean;
  /** Sink for output; defaults to process streams. Injectable for tests. */
  write?: (stream: 'out' | 'err', text: string) => void;
}

/** Human-readable, ordered CLI output. Step/sub structure mirrors PRD pipelines. */
export class Logger {
  level: LogLevel;
  dryRun: boolean;
  private readonly sink: (stream: 'out' | 'err', text: string) => void;
  private stepIndex = 0;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.dryRun = opts.dryRun ?? false;
    this.sink =
      opts.write ??
      ((stream, text) => {
        if (stream === 'out') process.stdout.write(text);
        else process.stderr.write(text);
      });
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[this.level] >= LEVEL_ORDER[level];
  }

  private line(stream: 'out' | 'err', text: string): void {
    this.sink(stream, text + '\n');
  }

  step(title: string): void {
    if (!this.enabled('info')) return;
    this.stepIndex += 1;
    const tag = this.dryRun ? pc.dim(' (dry-run)') : '';
    this.line('out', `${pc.cyan(pc.bold(`▸ ${this.stepIndex}. ${title}`))}${tag}`);
  }

  /** Reset step numbering at the start of a pipeline run. */
  resetSteps(): void {
    this.stepIndex = 0;
  }

  sub(text: string): void {
    if (!this.enabled('info')) return;
    this.line('out', `    ${text}`);
  }

  info(text: string): void {
    if (!this.enabled('info')) return;
    this.line('out', text);
  }

  success(text: string): void {
    if (!this.enabled('info')) return;
    this.line('out', `${pc.green('✓')} ${text}`);
  }

  warn(text: string): void {
    if (!this.enabled('warn')) return;
    this.line('err', `${pc.yellow('!')} ${pc.yellow(text)}`);
  }

  error(text: string): void {
    if (!this.enabled('error')) return;
    this.line('err', `${pc.red('✗')} ${pc.red(text)}`);
  }

  debug(text: string): void {
    if (!this.enabled('debug')) return;
    this.line('err', pc.dim(`  · ${text}`));
  }

  /** Plain output with no decoration (machine-ish summaries, reports). */
  raw(text: string): void {
    this.line('out', text);
  }

  /** A dim hint about a suggested next action. */
  hint(text: string): void {
    if (!this.enabled('info')) return;
    this.line('out', pc.dim(`→ ${text}`));
  }
}
