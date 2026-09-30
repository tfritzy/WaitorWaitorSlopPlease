import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { readGitContext } from '../src/context';

const run = promisify(execFile);

test('reads current tracked files, unsaved text, and binary content without untracked files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waitor-context-'));
  try {
    await run('git', ['init', '-q', root]);
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/main.ts'), 'staged text');
    await fs.writeFile(path.join(root, 'src/helper.ts'), 'staged helper');
    await fs.writeFile(path.join(root, 'src/deleted.ts'), 'to delete');
    await fs.writeFile(path.join(root, 'src/blob.bin'), Buffer.from([0xff, 0x00]));
    await run('git', ['add', 'src'], { cwd: root });

    await fs.writeFile(path.join(root, 'src/main.ts'), 'working tree text');
    await fs.writeFile(path.join(root, 'src/helper.ts'), 'saved helper');
    await fs.unlink(path.join(root, 'src/deleted.ts'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules/ignored.js'), 'never send');

    const context = await readGitContext(path.join(root, 'src/main.ts'), new Map([
      [path.join(root, 'src/helper.ts'), 'unsaved helper']
    ]));
    assert.equal(context.targetPath, 'src/main.ts');
    assert.deepEqual(context.files.map(file => file.path),
      ['src/main.ts', 'src/blob.bin', 'src/deleted.ts', 'src/helper.ts']);
    assert.deepEqual(context.files.find(file => file.path === 'src/main.ts'),
      { path: 'src/main.ts', content: 'working tree text', encoding: 'utf8' });
    assert.deepEqual(context.files.find(file => file.path === 'src/helper.ts'),
      { path: 'src/helper.ts', content: 'unsaved helper', encoding: 'utf8' });
    assert.deepEqual(context.files.find(file => file.path === 'src/blob.bin'),
      { path: 'src/blob.bin', content: '/wA=', encoding: 'base64' });
    assert.deepEqual(context.files.find(file => file.path === 'src/deleted.ts'),
      { path: 'src/deleted.ts', content: null, encoding: 'utf8' });
    await assert.rejects(
      readGitContext(path.join(root, 'node_modules/ignored.js'), new Map()),
      /not tracked by Git/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
