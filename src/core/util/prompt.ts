import {
  confirm as inquirerConfirm,
  input as inquirerInput,
  select as inquirerSelect,
  password as inquirerPassword,
} from '@inquirer/prompts';

export interface SelectChoice<T extends string = string> {
  name: string;
  value: T;
  description?: string;
}

/**
 * Abstraction over interactive prompts so commands stay testable. Tests inject
 * an {@link AutoPrompter} with scripted answers; nothing blocks on a TTY.
 */
export interface Prompter {
  readonly interactive: boolean;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  input(message: string, defaultValue?: string): Promise<string>;
  password(message: string): Promise<string>;
  select<T extends string>(message: string, choices: SelectChoice<T>[], defaultValue?: T): Promise<T>;
}

/** Real terminal prompter backed by @inquirer/prompts. */
export class TerminalPrompter implements Prompter {
  readonly interactive = true;

  confirm(message: string, defaultValue = false): Promise<boolean> {
    return inquirerConfirm({ message, default: defaultValue });
  }

  input(message: string, defaultValue?: string): Promise<string> {
    return inquirerInput({ message, default: defaultValue });
  }

  password(message: string): Promise<string> {
    return inquirerPassword({ message, mask: true });
  }

  select<T extends string>(message: string, choices: SelectChoice<T>[], defaultValue?: T): Promise<T> {
    return inquirerSelect<T>({
      message,
      choices: choices.map((c) => ({ name: c.name, value: c.value, description: c.description })),
      default: defaultValue,
    });
  }
}

/**
 * Non-interactive prompter. Used with `--yes`/`--no-input` and in tests.
 * `defaults: true` returns the supplied/declared default for every prompt;
 * scripted answers (by message substring) take precedence.
 */
export interface AutoPrompterOptions {
  defaults?: boolean;
  answers?: Array<{ match: string | RegExp; value: string | boolean }>;
  /**
   * Claim to be a TTY. Guards that refuse to resolve a divergence without a
   * human branch on `interactive`, and tests need to exercise both sides.
   */
  interactive?: boolean;
}

export class AutoPrompter implements Prompter {
  readonly interactive: boolean;
  private readonly opts: AutoPrompterOptions;
  constructor(opts: AutoPrompterOptions = {}) {
    this.opts = opts;
    this.interactive = opts.interactive ?? false;
  }

  private scripted(message: string): string | boolean | undefined {
    for (const a of this.opts.answers ?? []) {
      if (typeof a.match === 'string' ? message.includes(a.match) : a.match.test(message)) {
        return a.value;
      }
    }
    return undefined;
  }

  async confirm(message: string, defaultValue = false): Promise<boolean> {
    const s = this.scripted(message);
    if (typeof s === 'boolean') return s;
    return this.opts.defaults ? true : defaultValue;
  }

  async input(message: string, defaultValue = ''): Promise<string> {
    const s = this.scripted(message);
    if (typeof s === 'string') return s;
    return defaultValue;
  }

  async password(message: string): Promise<string> {
    const s = this.scripted(message);
    if (typeof s === 'string') return s;
    return '';
  }

  async select<T extends string>(message: string, choices: SelectChoice<T>[], defaultValue?: T): Promise<T> {
    const s = this.scripted(message);
    if (typeof s === 'string') return s as T;
    if (defaultValue !== undefined) return defaultValue;
    const first = choices[0];
    if (!first) throw new Error(`AutoPrompter.select called with no choices: ${message}`);
    return first.value;
  }
}
