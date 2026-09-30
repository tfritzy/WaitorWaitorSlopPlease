import * as vscode from 'vscode';
import { performance } from 'node:perf_hooks';
import * as path from 'node:path';
import { FileContext, readProjectContext } from './context';
import { Edit, parseEdit, requestBody } from './edit';

const API_KEY_SECRET = 'waitorwaitorslopplease.openrouterApiKey';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const DEFAULT_MODEL = '~google/gemini-flash-latest';

interface ModelPick extends vscode.QuickPickItem {
  id: string;
}

class RequestError extends Error {}

class SaveError extends Error {
  constructor(readonly document: vscode.TextDocument, readonly winnerMessage: string) {
    super('The edit was applied, but VS Code could not save the file.');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('waitorwaitorslopplease.setApiKey', async () => {
      const key = await promptForKey();
      if (key !== undefined) {
        await context.secrets.store(API_KEY_SECRET, key);
        void vscode.window.showInformationMessage('WaitorWaitorSlopPlease API key saved.');
      }
    }),
    vscode.commands.registerCommand('waitorwaitorslopplease.edit', async () => {
      for (;;) {
        try {
          await editAtCursor(context);
          return;
        } catch (error) {
          if (error instanceof SaveError) {
            await retrySave(error.document, error.winnerMessage);
            return;
          }
          const message = error instanceof Error ? error.message : 'Unknown error';
          const action = await vscode.window.showErrorMessage(`WaitorWaitorSlopPlease: ${message}`, 'Retry');
          if (action !== 'Retry') return;
        }
      }
    })
  );

  const status = vscode.window.createStatusBarItem('waitorwaitorslopplease.model', vscode.StatusBarAlignment.Right, 100);
  status.command = 'waitorwaitorslopplease.selectModel';
  const updateStatus = () => {
    const model = selectedModel();
    status.text = `$(sparkle) ${model}`;
    status.tooltip = `WaitorWaitorSlopPlease model: ${model} — click to change`;
  };
  updateStatus();
  status.show();
  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('waitorwaitorslopplease.model')) updateStatus();
    }),
    vscode.commands.registerCommand('waitorwaitorslopplease.selectModel', async () => {
      try {
        await selectModel();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(`WaitorWaitorSlopPlease: ${message}`);
      }
    })
  );
}

async function retrySave(document: vscode.TextDocument, winnerMessage: string): Promise<void> {
  for (;;) {
    const action = await vscode.window.showErrorMessage(
      'WaitorWaitorSlopPlease: The edit was applied, but VS Code could not save the file.',
      'Retry Save'
    );
    if (action !== 'Retry Save') return;
    try {
      if (await document.save()) {
        void vscode.window.showInformationMessage(winnerMessage);
        return;
      }
    } catch {
      // Keep the edited document open and offer another save attempt.
    }
  }
}

function selectedModel(): string {
  return vscode.workspace.getConfiguration('waitorwaitorslopplease').get<string>('model', DEFAULT_MODEL).trim();
}

async function selectModel(): Promise<void> {
  const current = selectedModel();
  const picks: ModelPick[] = [
    { id: current, label: `Current: ${current}`, description: current }
  ];

  try {
    const response = await fetch(MODELS_ENDPOINT);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result: unknown = await response.json();
    const data = (result as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error('Invalid model list');
    const models = data
      .filter((item): item is { id: string; name?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] } } =>
        typeof item?.id === 'string' &&
        (item.architecture?.input_modalities === undefined ||
          item.architecture.input_modalities.includes('text')) &&
        (item.architecture?.output_modalities === undefined ||
          item.architecture.output_modalities.includes('text')))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    for (const model of models) {
      if (model.id !== current) {
        picks.push({ id: model.id, label: model.name || model.id, description: model.id });
      }
    }
  } catch {
    void vscode.window.showWarningMessage('WaitorWaitorSlopPlease could not load the model catalog. You can enter a model ID manually.');
  }

  picks.push({ id: '', label: 'Enter model ID…', description: 'Use any OpenRouter model slug' });
  const choice = await vscode.window.showQuickPick(picks, {
    title: 'Select WaitorWaitorSlopPlease model',
    placeHolder: 'Search by model name or ID',
    matchOnDescription: true,
    ignoreFocusOut: true
  });
  if (!choice) return;

  let model = choice.id;
  if (!model) {
    const entered = await vscode.window.showInputBox({
      prompt: 'Enter an OpenRouter model ID',
      value: current,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Enter a model ID.'
    });
    if (entered === undefined) return;
    model = entered.trim();
  }
  await vscode.workspace.getConfiguration('waitorwaitorslopplease').update('model', model, vscode.ConfigurationTarget.Global);
}

async function promptForKey(): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your OpenRouter API key',
    password: true,
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'Enter an API key.'
  });
  return key?.trim();
}

async function editAtCursor(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('Open a text file first.');
  }
  if (editor.document.uri.scheme !== 'file') {
    throw new Error('Open a local project file first.');
  }

  // Only the active end of the primary selection is used. Its range is never sent.
  const cursor = editor.selection.active;
  const document = editor.document;
  const version = document.version;
  const content = document.getText();
  const instruction = await vscode.window.showInputBox({
    prompt: 'What should change near the cursor?',
    placeHolder: 'e.g. simplify this function',
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'Enter an instruction.'
  });
  if (instruction === undefined) return;

  let key = await context.secrets.get(API_KEY_SECRET);
  if (!key) {
    key = await promptForKey();
    if (key === undefined) return;
    await context.secrets.store(API_KEY_SECRET, key);
  }

  if (document.isClosed || document.version !== version || vscode.window.activeTextEditor !== editor) {
    throw new Error('The active file changed. Run the command again.');
  }

  const model = selectedModel();
  if (!model) throw new Error('Select a model before editing.');
  const openText = new Map(vscode.workspace.textDocuments
    .filter(openDocument => openDocument.uri.scheme === 'file')
    .map(openDocument => [path.resolve(openDocument.uri.fsPath), openDocument.getText()]));
  openText.set(path.resolve(document.uri.fsPath), content);
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const projectContext = await readProjectContext(path.resolve(document.uri.fsPath), workspaceRoot, openText);
  const cursorPosition = {
    line: cursor.line + 1,
    column: cursor.character + 1
  };
  const cursorOffset = document.offsetAt(cursor);
  for (;;) {
    if (document.isClosed || document.version !== version || vscode.window.activeTextEditor !== editor) {
      throw new Error('The active file changed. Run the command again.');
    }
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `WaitorWaitorSlopPlease: editing with ${model}`,
        cancellable: true
      }, async (_progress, token) => {
        const cancellationController = new AbortController();
        const cancellation = token.onCancellationRequested(() => cancellationController.abort());
        try {
          let edit: Edit;
          const startedAt = performance.now();
          try {
            edit = await requestModelEdit(model, key, instruction.trim(), cursorPosition, projectContext.targetPath, projectContext.files, content, cursorOffset, cancellationController.signal);
          } catch (error) {
            if (token.isCancellationRequested) return;
            throw new RequestError(error instanceof Error ? error.message : 'The request failed.');
          }
          if (token.isCancellationRequested) return;
          if (document.isClosed || document.version !== version || vscode.window.activeTextEditor !== editor) {
            throw new Error('The active file changed while waiting. Run the command again.');
          }
          const range = new vscode.Range(
            document.positionAt(edit.startOffset),
            document.positionAt(edit.endOffset)
          );
          if (document.getText(range) !== content.slice(edit.startOffset, edit.endOffset)) {
            throw new RequestError('The edit range did not match the file.');
          }
          if (!await editor.edit(builder => builder.replace(range, edit.replacement), {
            undoStopBefore: true,
            undoStopAfter: true
          })) {
            throw new Error('VS Code could not apply the edit.');
          }
          const winnerMessage = `WaitorWaitorSlopPlease: ${model} edited the file in ${((performance.now() - startedAt) / 1000).toFixed(2)} s.`;
          let saved = false;
          try {
            saved = await document.save();
          } catch {
            // The edit remains in the document so the user can retry saving it.
          }
          if (!saved) throw new SaveError(document, winnerMessage);
          void vscode.window.showInformationMessage(winnerMessage);
        } finally {
          cancellation.dispose();
        }
      });
      return;
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      const action = await vscode.window.showErrorMessage(`WaitorWaitorSlopPlease: ${error.message}`, 'Retry');
      if (action !== 'Retry') return;
    }
  }
}

async function requestModelEdit(
  model: string,
  key: string,
  instruction: string,
  cursor: { line: number; column: number },
  targetPath: string,
  files: readonly FileContext[],
  content: string,
  cursorOffset: number,
  signal: AbortSignal
): Promise<Edit> {
  let correction: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody(model, instruction, cursor, targetPath, files, correction)),
      signal
    });
    if (!response.ok) throw new Error(`${model} returned HTTP ${response.status}.`);
    const result: unknown = await response.json();
    const choice = (result as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> })?.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new Error(`${model} returned a cut-off edit.`);
    }
    if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) {
      correction = 'No edit text was returned.';
    } else {
      try {
        return parseEdit(choice.message.content, content, cursorOffset);
      } catch (error) {
        correction = error instanceof Error ? error.message : 'The edit was invalid.';
      }
    }
  }
  throw new Error(`${model} returned an invalid edit twice: ${correction}`);
}

export function deactivate(): void {}
