import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import * as context from '../src/context';

test('edit command retry behavior', async t => {
  const commands = new Map<string, () => Promise<void>>();
  const disposable = { dispose() {} };
  const document = {
    uri: { scheme: 'file', fsPath: '/project/main.ts' },
    version: 1,
    isClosed: false,
    getText: () => 'before',
    offsetAt: () => 0,
    positionAt: (offset: number) => offset,
    save: async () => true
  };
  const editor = {
    document,
    selection: { active: { line: 0, character: 0 } },
    edit: async (apply: (builder: { replace: (range: unknown, text: string) => void }) => void) => {
      apply({ replace: (_range, text) => assert.equal(text, 'after') });
      return true;
    }
  };
  const vscode = {
    commands: {
      registerCommand: (name: string, handler: () => Promise<void>) => {
        commands.set(name, handler);
        return disposable;
      }
    },
    window: {
      activeTextEditor: editor as typeof editor | undefined,
      showInputBox: async () => 'change it',
      showErrorMessage: async (_message: string, ..._actions: string[]): Promise<string | undefined> => undefined,
      showInformationMessage: async (_message: string) => undefined,
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      withProgress: async (_options: unknown, run: Function) => run({}, {
        isCancellationRequested: false,
        onCancellationRequested: () => disposable
      })
    },
    workspace: {
      textDocuments: [document],
      getConfiguration: () => ({ get: () => 'test/model' }),
      getWorkspaceFolder: () => ({ uri: { fsPath: '/project' } }),
      onDidChangeConfiguration: () => disposable
    },
    StatusBarAlignment: { Right: 2 },
    ProgressLocation: { Notification: 15 },
    Range: class { constructor(readonly start: number, readonly end: number) {} }
  };
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  const loadMock = t.mock.method(loader, '_load', function (id: string, ...args: unknown[]) {
    return id === 'vscode' ? vscode : originalLoad.call(loader, id, ...args);
  });
  const { activate } = require('../src/extension') as typeof import('../src/extension');
  loadMock.mock.restore();
  activate({ subscriptions: [], secrets: { get: async () => 'test-key' } } as unknown as import('vscode').ExtensionContext);
  const run = commands.get('waitorwaitorslopplease.edit')!;
  const success = () => new Response(JSON.stringify({ choices: [{ message: {
    content: JSON.stringify({ oldText: 'before', replacement: 'after' })
  } }] }));

  t.beforeEach(st => {
    document.version = 1;
    document.isClosed = false;
    vscode.window.activeTextEditor = editor;
    st.mock.method(context, 'readProjectContext', async () => ({
      targetPath: 'main.ts', files: [{ path: 'main.ts', content: 'before', encoding: 'utf8' as const }]
    }));
  });

  await t.test('Retry resends the same request when the notification takes editor focus', async st => {
    const input = st.mock.method(vscode.window, 'showInputBox');
    const edit = st.mock.method(editor, 'edit');
    const requests: RequestInit[] = [];
    st.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requests.push(init);
      return requests.length === 1 ? new Response('', { status: 503 }) : success();
    });
    const error = st.mock.method(vscode.window, 'showErrorMessage', async (_message: string, ...actions: string[]) => {
      assert.deepEqual(actions, ['Retry']);
      vscode.window.activeTextEditor = undefined;
      return error.mock.callCount() === 0 ? 'Retry' : undefined;
    });
    await run();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.notEqual(requests[0].signal, requests[1].signal);
    assert.equal(input.mock.callCount(), 1);
    assert.equal(error.mock.callCount(), 1);
    assert.equal(edit.mock.callCount(), 1);
  });

  await t.test('dismissing Retry does not send another request', async st => {
    const fetch = st.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
    const edit = st.mock.method(editor, 'edit');
    await run();
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(edit.mock.callCount(), 0);
  });

  await t.test('Retry refuses a changed document without prompting for a new instruction', async st => {
    const input = st.mock.method(vscode.window, 'showInputBox');
    const fetch = st.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
    const edit = st.mock.method(editor, 'edit');
    const error = st.mock.method(vscode.window, 'showErrorMessage', async (_message: string, ...actions: string[]) => {
      if (error.mock.callCount() === 0) {
        document.version++;
        return 'Retry';
      }
      assert.deepEqual(actions, []);
      return undefined;
    });
    await run();
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(edit.mock.callCount(), 0);
    assert.equal(input.mock.callCount(), 1);
    assert.equal(error.mock.callCount(), 2);
  });

  await t.test('Retry Save retries saving without resending or reapplying the edit', async st => {
    const fetch = st.mock.method(globalThis, 'fetch', async () => success());
    const edit = st.mock.method(editor, 'edit');
    const save = st.mock.method(document, 'save', async () => save.mock.callCount() > 0);
    st.mock.method(vscode.window, 'showErrorMessage', async (_message: string, ...actions: string[]) => {
      assert.deepEqual(actions, ['Retry Save']);
      return 'Retry Save';
    });
    await run();
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(edit.mock.callCount(), 1);
    assert.equal(save.mock.callCount(), 2);
  });
});
