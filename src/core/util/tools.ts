import os from 'node:os';
import type { CommandRunner } from './exec.js';
import type { Prompter } from './prompt.js';
import type { Logger } from './logger.js';

export interface ToolDef {
  command: string;
  name: string;
  installCommands: {
    win32: string;
    darwin: string;
    linux: string;
  };
  checkArgs?: string[];
  url?: string;
}

export const TOOLS: Record<string, ToolDef> = {
  doppler: {
    command: 'doppler',
    name: 'Doppler CLI',
    installCommands: {
      win32: 'winget install DopplerHQ.doppler',
      darwin: 'brew install dopplerhq/cli/doppler',
      linux: 'curl -sLf https://cli.doppler.com/install.sh | sh',
    },
    checkArgs: ['--version'],
    url: 'https://docs.doppler.com/docs/install-cli',
  },
  age: {
    command: 'age',
    name: 'age encryption',
    installCommands: {
      win32: 'winget install FiloSottile.age',
      darwin: 'brew install age',
      linux: 'apt install age  # or: dnf install age',
    },
    checkArgs: ['--version'],
    url: 'https://github.com/FiloSottile/age#installation',
  },
  'age-keygen': {
    command: 'age-keygen',
    name: 'age-keygen',
    installCommands: {
      win32: 'winget install FiloSottile.age',
      darwin: 'brew install age',
      linux: 'apt install age  # or: dnf install age',
    },
    checkArgs: ['--version'],
    url: 'https://github.com/FiloSottile/age#installation',
  },
  aws: {
    command: 'aws',
    name: 'AWS CLI',
    installCommands: {
      win32: 'winget install Amazon.AWSCLI',
      darwin: 'brew install awscli',
      linux: 'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && unzip awscliv2.zip && sudo ./aws/install',
    },
    checkArgs: ['--version'],
    url: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
  },
  git: {
    command: 'git',
    name: 'Git',
    installCommands: {
      win32: 'winget install Git.Git',
      darwin: 'brew install git',
      linux: 'apt install git  # or: dnf install git',
    },
    checkArgs: ['--version'],
    url: 'https://git-scm.com/downloads',
  },
  docker: {
    command: 'docker',
    name: 'Docker',
    installCommands: {
      win32: 'winget install Docker.DockerDesktop',
      darwin: 'brew install --cask docker',
      linux: 'curl -fsSL https://get.docker.com | sh',
    },
    checkArgs: ['--version'],
    url: 'https://docs.docker.com/get-docker/',
  },
  tar: {
    command: 'tar',
    name: 'tar',
    installCommands: {
      win32: 'Built into Windows 10+',
      darwin: 'Built into macOS',
      linux: 'apt install tar  # usually pre-installed',
    },
    checkArgs: ['--version'],
  },
};

function getPlatform(): 'win32' | 'darwin' | 'linux' {
  const p = os.platform();
  if (p === 'win32') return 'win32';
  if (p === 'darwin') return 'darwin';
  return 'linux';
}

export interface EnsureToolResult {
  installed: boolean;
  wasInstalled: boolean;
}

/**
 * Check if a tool is installed. If not, prompt user to install it.
 */
export async function ensureTool(
  toolName: string,
  runner: CommandRunner,
  logger: Logger,
  prompter: Prompter,
): Promise<EnsureToolResult> {
  const tool = TOOLS[toolName];
  if (!tool) {
    // Unknown tool, just check if it exists
    const found = await runner.which(toolName);
    return { installed: !!found, wasInstalled: false };
  }

  // Check if already installed
  const found = await runner.which(tool.command);
  if (found) {
    return { installed: true, wasInstalled: false };
  }

  // Not installed - prompt user
  const platform = getPlatform();
  const installCmd = tool.installCommands[platform];

  logger.warn(`${tool.name} is not installed.`);
  logger.raw('');
  logger.raw(`  Install with: ${installCmd}`);
  if (tool.url) {
    logger.raw(`  More info: ${tool.url}`);
  }
  logger.raw('');

  const shouldInstall = await prompter.confirm(`Install ${tool.name} now?`, true);

  if (!shouldInstall) {
    return { installed: false, wasInstalled: false };
  }

  // Try to install
  logger.info(`Installing ${tool.name}...`);

  let installResult;
  if (platform === 'win32') {
    // Use cmd for Windows
    installResult = await runner.run('cmd', ['/c', installCmd], { allowFailure: true });
  } else {
    // Use sh for Unix
    installResult = await runner.run('sh', ['-c', installCmd], { allowFailure: true });
  }

  if (installResult.code !== 0) {
    logger.error(`Installation failed. Please install manually:`);
    logger.raw(`  ${installCmd}`);
    return { installed: false, wasInstalled: false };
  }

  // Verify installation
  const nowFound = await runner.which(tool.command);
  if (nowFound) {
    logger.success(`${tool.name} installed successfully.`);
    return { installed: true, wasInstalled: true };
  } else {
    logger.warn(`${tool.name} installed but not found in PATH. You may need to restart your terminal.`);
    return { installed: false, wasInstalled: true };
  }
}

/**
 * Ensure multiple tools are installed.
 */
export async function ensureTools(
  toolNames: string[],
  runner: CommandRunner,
  logger: Logger,
  prompter: Prompter,
): Promise<{ allInstalled: boolean; missing: string[] }> {
  const missing: string[] = [];

  for (const name of toolNames) {
    const result = await ensureTool(name, runner, logger, prompter);
    if (!result.installed) {
      missing.push(name);
    }
  }

  return { allInstalled: missing.length === 0, missing };
}
