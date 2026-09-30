import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface FileContext {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64' | 'symlink';
}

export interface ProjectContext {
  targetPath: string;
  files: FileContext[];
}

function gitRoot(activePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(activePath) }, (error, stdout) => {
      if (error) reject(new Error('Open a project folder before editing.'));
      else resolve(stdout.trimEnd());
    });
  });
}

function ignoredPaths(root: string, candidates: readonly string[]): Promise<Set<string>> {
  if (candidates.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: root });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 && code !== 1) {
        reject(new Error(`Could not read project ignore rules: ${Buffer.concat(errors).toString('utf8').trim()}`));
      } else {
        resolve(new Set(Buffer.concat(output).toString('utf8').split('\0').filter(Boolean)));
      }
    });
    child.stdin.end(Buffer.from(`${candidates.join('\0')}\0`, 'utf8'));
  });
}

async function projectPaths(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    const eligible = entries.filter(entry => entry.name !== '.git');
    const candidates = eligible.map(entry => path.posix.join(directory, entry.name));
    const ignored = await ignoredPaths(root, candidates);
    for (const entry of eligible) {
      const relativePath = path.posix.join(directory, entry.name);
      if (ignored.has(relativePath)) continue;
      if (entry.isDirectory()) await walk(relativePath);
      else if (entry.isFile() || entry.isSymbolicLink()) found.push(relativePath);
    }
  }
  await walk('');
  return found;
}

async function currentFile(root: string, relativePath: string, openText: ReadonlyMap<string, string>): Promise<FileContext> {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  const stat = await fs.lstat(absolutePath);
  if (stat.isSymbolicLink()) {
    return { path: relativePath, content: await fs.readlink(absolutePath), encoding: 'symlink' };
  }
  const unsaved = openText.get(absolutePath);
  if (unsaved !== undefined) {
    return { path: relativePath, content: unsaved, encoding: 'utf8' };
  }
  const bytes = await fs.readFile(absolutePath);
  const decoded = bytes.toString('utf8');
  if (!decoded.includes('\0') && Buffer.from(decoded, 'utf8').equals(bytes)) {
    return { path: relativePath, content: decoded, encoding: 'utf8' };
  }
  return { path: relativePath, content: bytes.toString('base64'), encoding: 'base64' };
}

export async function readProjectContext(activePath: string, projectRoot: string | undefined, openText: ReadonlyMap<string, string>): Promise<ProjectContext> {
  const root = path.resolve(projectRoot ?? await gitRoot(activePath));
  const targetPath = path.relative(root, activePath).split(path.sep).join('/');
  if (targetPath.startsWith('../') || targetPath === '..' || path.isAbsolute(targetPath)) {
    throw new Error('The active file is outside the project folder.');
  }
  const paths = await projectPaths(root);
  if (!paths.includes(targetPath)) {
    throw new Error('The active file is ignored by project ignore rules.');
  }
  paths.sort((a, b) => a === targetPath ? -1 : b === targetPath ? 1 : a.localeCompare(b));
  const files: FileContext[] = [];
  for (let index = 0; index < paths.length; index += 32) {
    files.push(...await Promise.all(paths.slice(index, index + 32).map(relativePath => currentFile(root, relativePath, openText))));
  }
  return { targetPath, files };
}
