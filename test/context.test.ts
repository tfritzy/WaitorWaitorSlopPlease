import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { readProjectContext } from '../src/context';

const run = promisify(execFile);

test('includes new and modified project files but excludes ignored paths even when tracked', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waitor-context-'));
  try {
    await run('git', ['init', '-q', root]);
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/main.ts'), 'staged text');
    await fs.writeFile(path.join(root, 'src/hidden.ts'), 'tracked but ignored');
    await fs.writeFile(path.join(root, 'src/deleted.ts'), 'to delete');
    await run('git', ['add', 'src'], { cwd: root });

    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\nsrc/hidden.ts\n');
    await fs.writeFile(path.join(root, 'src/main.ts'), 'working tree text');
    await fs.writeFile(path.join(root, 'src/new.ts'), 'new file');
    await fs.writeFile(path.join(root, 'src/helper.ts'), 'saved helper');
    await fs.writeFile(path.join(root, 'src/blob.bin'), Buffer.from([0xff, 0x00]));
    await fs.unlink(path.join(root, 'src/deleted.ts'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules/ignored.js'), 'never send');

    const context = await readProjectContext(path.join(root, 'src/new.ts'), root, new Map([
      [path.join(root, 'src/helper.ts'), 'unsaved helper']
    ]));
    assert.equal(context.targetPath, 'src/new.ts');
    assert.deepEqual(context.files.map(file => file.path),
      ['src/new.ts', '.gitignore', 'src/blob.bin', 'src/helper.ts', 'src/main.ts']);
    assert.deepEqual(context.files.find(file => file.path === 'src/new.ts'),
      { path: 'src/new.ts', content: 'new file', encoding: 'utf8' });
    assert.deepEqual(context.files.find(file => file.path === 'src/main.ts'),
      { path: 'src/main.ts', content: 'working tree text', encoding: 'utf8' });
    assert.deepEqual(context.files.find(file => file.path === 'src/helper.ts'),
      { path: 'src/helper.ts', content: 'unsaved helper', encoding: 'utf8' });
    assert.deepEqual(context.files.find(file => file.path === 'src/blob.bin'),
      { path: 'src/blob.bin', content: '/wA=', encoding: 'base64' });
    await assert.rejects(
      readProjectContext(path.join(root, 'node_modules/ignored.js'), root, new Map()),
      /ignored by project ignore rules/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
