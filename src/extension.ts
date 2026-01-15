import * as path from 'node:path';
import * as vscode from 'vscode';
import { addExcludedExtension, migrateExcludedExtensions, readConfig, removeExcludedExtension, updateSizeThreshold } from './config';
import { VIEW_ID } from './constants';
import { buildExclusionState, pruneExcludedEntries, updateContextForUri } from './exclusions';
import { normalizeExtensionInput, normalizeExtensionList } from './extensions';
import { checkDocument, createDiagnostic, formatBytes, scanWorkspace } from './scan';
import { addExcludedFile, addExcludedFolder, normalizeFsPath, removeExcludedFile, removeExcludedFolder } from './state';
import type { ScanEntry, ViewEntry, ViewState, WebviewMessage } from './types';
import { SplitOrDieViewProvider } from './webview';

export async function activate(context: vscode.ExtensionContext) {
  await migrateExcludedExtensions(context);
  const diagnostics = vscode.languages.createDiagnosticCollection('split-or-die');
  context.subscriptions.push(diagnostics);

  const scanEntries = new Map<string, ScanEntry>();
  let scanToken = 0;

  const runWorkspaceScan = async () => {
    const runId = ++scanToken;
    const config = readConfig();
    if (!config.enabled) {
      diagnostics.clear();
      scanEntries.clear();
      viewProvider.postState();
      await updateContextForUri(context, config);
      return;
    }

    const exclusion = buildExclusionState(context, config);
    const thresholdBytes = Math.max(1, config.sizeThresholdKb) * 1024;
    const entries = await scanWorkspace(config, exclusion, thresholdBytes);
    if (runId !== scanToken) {
      return;
    }

    diagnostics.clear();
    scanEntries.clear();
    for (const [key, value] of entries) {
      scanEntries.set(key, value);
      const diagnostic = createDiagnostic(value.size, value.lineCount);
      diagnostics.set(value.uri, [diagnostic]);
    }

    const label = `${entries.size} file${entries.size === 1 ? '' : 's'} over ${config.sizeThresholdKb} KB`;
    vscode.window.setStatusBarMessage(`Split or Die: ${label}`, 4000);
    viewProvider.postState();
    await updateContextForUri(context, config);
  };

  const viewProvider = new SplitOrDieViewProvider(
    () => {
      const config = readConfig();
      const exclusion = buildExclusionState(context, config);
      return buildViewState(config, exclusion, scanEntries);
    },
    async (message: WebviewMessage) => {
      await handleWebviewMessage(
        message,
        context,
        runWorkspaceScan,
        diagnostics,
        scanEntries,
        () => viewProvider.postState()
      );
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider)
  );

  const command = vscode.commands.registerCommand('split-or-die.scanWorkspace', () => {
    void runWorkspaceScan();
  });

  const excludeFolder = vscode.commands.registerCommand(
    'split-or-die.excludeFolder',
    async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') return;
      await addExcludedFolder(context, target.fsPath);
      void runWorkspaceScan();
      await updateContextForUri(context, readConfig(), target);
    }
  );

  const excludeFile = vscode.commands.registerCommand(
    'split-or-die.excludeFile',
    async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') return;
      await addExcludedFile(context, target.fsPath);
      void runWorkspaceScan();
      await updateContextForUri(context, readConfig(), target);
    }
  );

  const toggleExtension = vscode.commands.registerCommand(
    'split-or-die.toggleExtension',
    async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') return;
      const extension = normalizeExtensionInput(path.extname(target.fsPath));
      if (!extension) return;
      const config = readConfig();
      const exclusion = buildExclusionState(context, config);
      if (exclusion.excludeExtensions.has(extension)) {
        await removeExcludedExtension(extension);
      } else {
        await addExcludedExtension(extension);
      }
      void runWorkspaceScan();
    }
  );

  const toggleFile = vscode.commands.registerCommand(
    'split-or-die.toggleFile',
    async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') return;
      const config = readConfig();
      const exclusion = buildExclusionState(context, config);
      const normalized = normalizeFsPath(target.fsPath);
      if (exclusion.excludedFileSet.has(normalized)) {
        await removeExcludedFile(context, target.fsPath);
      } else {
        await addExcludedFile(context, target.fsPath);
      }
      void runWorkspaceScan();
      await updateContextForUri(context, config, target);
    }
  );

  const toggleFolder = vscode.commands.registerCommand(
    'split-or-die.toggleFolder',
    async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') return;
      const config = readConfig();
      const exclusion = buildExclusionState(context, config);
      const normalized = normalizeFsPath(target.fsPath);
      if (exclusion.excludedFolderSet.has(normalized)) {
        await removeExcludedFolder(context, target.fsPath);
      } else {
        await addExcludedFolder(context, target.fsPath);
      }
      void runWorkspaceScan();
      await updateContextForUri(context, config, target);
    }
  );

  const includeFolder = vscode.commands.registerCommand(
    'split-or-die.includeFolder',
    async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') return;
      await removeExcludedFolder(context, target.fsPath);
      void runWorkspaceScan();
      await updateContextForUri(context, readConfig(), target);
    }
  );

  const includeFile = vscode.commands.registerCommand(
    'split-or-die.includeFile',
    async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') return;
      await removeExcludedFile(context, target.fsPath);
      void runWorkspaceScan();
      await updateContextForUri(context, readConfig(), target);
    }
  );

  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const config = readConfig();
    if (!config.enabled || !config.runOnSave) {
      return;
    }

    const exclusion = buildExclusionState(context, config);
    await checkDocument(doc, diagnostics, config, exclusion, scanEntries);
    viewProvider.postState();
    await updateContextForUri(context, config, doc.uri);
  });

  const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    const config = readConfig();
    void updateContextForUri(context, config, editor?.document.uri);
  });

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('splitOrDie')) {
      return;
    }

    void runWorkspaceScan();
  });

  context.subscriptions.push(
    command,
    excludeFolder,
    excludeFile,
    toggleExtension,
    toggleFolder,
    toggleFile,
    includeFolder,
    includeFile,
    saveListener,
    editorListener,
    configListener
  );

  const startupConfig = readConfig();
  if (startupConfig.enabled && startupConfig.runOnStartup) {
    void runWorkspaceScan();
  } else {
    viewProvider.postState();
    void updateContextForUri(context, startupConfig);
  }
}

export function deactivate() {}

function buildViewState(
  config: { sizeThresholdKb: number; excludeExtensions: string[]; },
  exclusion: { excludedFolders: string[]; excludedFiles: string[]; },
  scanEntries: Map<string, ScanEntry>
): ViewState {
  const excludedExtensions = normalizeExtensionList(config.excludeExtensions);

  const excludedFolders = exclusion.excludedFolders.map((entry) => toViewEntry(entry));
  const excludedFiles = exclusion.excludedFiles.map((entry) => toViewEntry(entry));
  const oversizedFiles = Array.from(scanEntries.values())
    .sort((a, b) => b.size - a.size)
    .map((entry) => ({
      uri: entry.uri.toString(),
      label: vscode.workspace.asRelativePath(entry.uri, false),
      sizeLabel: `${formatBytes(entry.size)} (${entry.lineCount} lines)`,
    }));

  return {
    sizeThresholdKb: config.sizeThresholdKb,
    excludedExtensions,
    excludedFolders,
    excludedFiles,
    oversizedFiles,
  };
}

function toViewEntry(fsPath: string): ViewEntry {
  const uri = vscode.Uri.file(fsPath);
  const label = vscode.workspace.asRelativePath(uri, false);
  return {
    uri: uri.toString(),
    label: label || fsPath,
  };
}

async function handleWebviewMessage(
  message: WebviewMessage,
  context: vscode.ExtensionContext,
  runWorkspaceScan: () => Promise<void>,
  diagnostics: vscode.DiagnosticCollection,
  scanEntries: Map<string, ScanEntry>,
  postState: () => void
): Promise<void> {
  switch (message.type) {
    case 'addExtension': {
      const extension = normalizeExtensionInput(message.value);
      if (!extension) return;
      await addExcludedExtension(extension);
      const config = readConfig();
      const exclusion = buildExclusionState(context, config);
      diagnostics.clear();
      scanEntries.clear();
      pruneExcludedEntries(diagnostics, scanEntries, exclusion.excludeExtensions);
      postState();
      void runWorkspaceScan();
      return;
    }
    case 'removeExtension': {
      const extension = normalizeExtensionInput(message.value);
      if (!extension) return;
      await removeExcludedExtension(extension);
      postState();
      diagnostics.clear();
      scanEntries.clear();
      void runWorkspaceScan();
      return;
    }
    case 'removeFolder': {
      await removeExcludedFolder(context, message.value);
      void runWorkspaceScan();
      return;
    }
    case 'removeFile': {
      await removeExcludedFile(context, message.value);
      void runWorkspaceScan();
      return;
    }
    case 'updateThreshold': {
      const next = Number(message.value);
      if (!Number.isFinite(next)) return;
      await updateSizeThreshold(Math.max(1, Math.round(next)));
      diagnostics.clear();
      scanEntries.clear();
      postState();
      void runWorkspaceScan();
      return;
    }
    case 'openFile': {
      await openFile(message.value);
      return;
    }
    case 'ready': {
      postState();
      return;
    }
    default:
      return;
  }
}

async function openFile(uriValue: string): Promise<void> {
  try {
    const uri = vscode.Uri.parse(uriValue);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch {
    // ignore
  }
}
