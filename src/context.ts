import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface FileContext {
  path: string;
  content: string | null;
  encoding: 'utf8' | 'base64' | 'symlink';
}

export interface GitContext {
  targetPath: string;
  files: FileContext[];
}

function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as Buffer);
    });
  });
}

export async function readGitContext(activePath: string, openText: ReadonlyMap<string, string>): Promise<GitContext> {
  const root = (await git(path.dirname(activePath), ['rev-parse', '--show-toplevel'])).toString('utf8').trimEnd();
  const targetPath = path.relative(root, activePath).split(path.sep).join('/');
  const tracked = (await git(root, ['ls-files', '--cached', '-z'])).toString('utf8').split('\0').filter(Boolean);
  if (!tracked.includes(targetPath)) {
    throw new Error('The active file is not tracked by Git. Add it to Git before editing.');
  }

  const files = await Promise.all(tracked.map(async relativePath => {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const unsaved = openText.get(absolutePath);
      return { path: relativePath, content: unsaved ?? null, encoding: 'utf8' as const };
    }
    if (stat.isSymbolicLink()) {
      return { path: relativePath, content: await fs.readlink(absolutePath), encoding: 'symlink' as const };
    }
    if (!stat.isFile()) {
      return { path: relativePath, content: null, encoding: 'utf8' as const };
    }
    const unsaved = openText.get(absolutePath);
    if (unsaved !== undefined) {
      return { path: relativePath, content: unsaved, encoding: 'utf8' as const };
    }
    const bytes = await fs.readFile(absolutePath);
    const decoded = bytes.toString('utf8');
    if (!decoded.includes('\0') && Buffer.from(decoded, 'utf8').equals(bytes)) {
      return { path: relativePath, content: decoded, encoding: 'utf8' as const };
    }
    return { path: relativePath, content: bytes.toString('base64'), encoding: 'base64' as const };
  }));
  files.sort((a, b) => a.path === targetPath ? -1 : b.path === targetPath ? 1 : a.path.localeCompare(b.path));
  return { targetPath, files };
}
