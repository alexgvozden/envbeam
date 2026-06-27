import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readFileIfExists, expandHome } from '../util/fs.js';
import type { DetectedField } from './types.js';

interface GitRemote {
  name: string;
  url: string;
}

/** Minimal INI parse of `.git/config` to extract remotes and current branch. */
export async function parseGitConfig(gitDir: string): Promise<{ remotes: GitRemote[] }> {
  const text = await readFileIfExists(path.join(gitDir, 'config'));
  if (!text) return { remotes: [] };
  const remotes: GitRemote[] = [];
  let currentRemote: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[remote "([^"]+)"\]$/);
    if (sectionMatch && sectionMatch[1]) {
      currentRemote = sectionMatch[1];
      remotes.push({ name: currentRemote, url: '' });
      continue;
    }
    if (line.startsWith('[')) {
      currentRemote = null;
      continue;
    }
    const urlMatch = line.match(/^url\s*=\s*(.+)$/);
    if (urlMatch && currentRemote) {
      const target = remotes.find((r) => r.name === currentRemote);
      if (target) target.url = urlMatch[1]!.trim();
    }
  }
  return { remotes };
}

async function currentBranch(gitDir: string): Promise<string | null> {
  const head = await readFileIfExists(path.join(gitDir, 'HEAD'));
  if (!head) return null;
  const m = head.match(/^ref:\s*refs\/heads\/(.+)$/m);
  return m ? m[1]!.trim() : null;
}

/** Extract the SSH host alias from a remote URL (e.g. git@github-work:org/repo). */
export function sshHostFromUrl(url: string): string | null {
  // scp-like syntax: git@host:path
  const scp = url.match(/^[^@]+@([^:]+):/);
  if (scp) return scp[1]!;
  // ssh:// URL
  const ssh = url.match(/^ssh:\/\/[^@]+@([^/:]+)/);
  if (ssh) return ssh[1]!;
  return null;
}

/** Parse `~/.ssh/config` host alias list (for identity matching). */
async function sshConfigHosts(): Promise<string[]> {
  const text = await readFileIfExists(expandHome('~/.ssh/config'));
  if (!text) return [];
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^Host\s+(.+)$/i);
    if (m) {
      for (const h of m[1]!.split(/\s+/)) {
        if (h && !h.includes('*')) hosts.push(h);
      }
    }
  }
  return hosts;
}

export async function detectGit(workspaceRoot: string): Promise<DetectedField[]> {
  const fields: DetectedField[] = [];
  const gitDir = path.join(workspaceRoot, '.git');
  let isRepo = false;
  try {
    const st = await fs.stat(gitDir);
    isRepo = st.isDirectory();
  } catch {
    isRepo = false;
  }

  if (!isRepo) {
    fields.push({
      field: 'git.remote',
      source: '.git/config',
      status: 'missing',
      note: 'not a git repository',
    });
    return fields;
  }

  const { remotes } = await parseGitConfig(gitDir);
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  if (origin && origin.url) {
    fields.push({ field: 'git.remote', value: origin.name, source: '.git/config', status: 'detected' });
    fields.push({ field: 'git.url', value: origin.url, source: '.git/config', status: 'detected' });

    const sshHost = sshHostFromUrl(origin.url);
    if (sshHost) {
      const knownHosts = await sshConfigHosts();
      const matched = knownHosts.includes(sshHost);
      fields.push({
        field: 'git.identity',
        value: sshHost,
        source: '~/.ssh/config host alias',
        status: matched ? 'detected' : 'ambiguous',
        note: matched
          ? `ssh host alias "${sshHost}" → name an identity for it`
          : `remote uses host "${sshHost}" not found in ~/.ssh/config`,
      });
    } else {
      fields.push({
        field: 'git.identity',
        source: 'remote URL',
        status: 'ambiguous',
        note: 'HTTPS or default-host remote — declare which identity to use',
      });
    }
  } else {
    fields.push({
      field: 'git.remote',
      source: '.git/config',
      status: 'missing',
      note: 'no remote configured',
    });
  }

  const branch = await currentBranch(gitDir);
  if (branch) {
    fields.push({ field: 'git.branch', value: branch, source: '.git/HEAD', status: 'detected' });
  }

  return fields;
}
