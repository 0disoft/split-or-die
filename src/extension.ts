import * as vscode from 'vscode';
import * as path from 'node:path';

type SplitOrDieConfig = {
  enabled: boolean;
  sizeThresholdKb: number;
  excludeGlobs: string[];
  excludeExtensions: string[];
  runOnStartup: boolean;
  runOnSave: boolean;
};

type ScanEntry = {
  uri: vscode.Uri;
  size: number;
  lineCount: number;
};

type ViewEntry = {
  uri: string;
  label: string;
  sizeLabel?: string;
};

type ViewState = {
  sizeThresholdKb: number;
  excludedExtensions: string[];
  excludedFolders: ViewEntry[];
  excludedFiles: ViewEntry[];
  oversizedFiles: ViewEntry[];
};

type ExclusionState = {
  excludeExtensions: Set<string>;
  excludedFolderSet: Set<string>;
  excludedFileSet: Set<string>;
  excludedFolders: string[];
  excludedFiles: string[];
  excludeGlob: string | undefined;
};

type WebviewMessage =
  | { type: 'addExtension'; value: string }
  | { type: 'removeExtension'; value: string }
  | { type: 'removeFolder'; value: string }
  | { type: 'removeFile'; value: string }
  | { type: 'openFile'; value: string }
  | { type: 'updateThreshold'; value: number }
  | { type: 'ready' };

const VIEW_ID = 'splitOrDie.panel';
const DIAGNOSTIC_SOURCE = 'Split or Die';

const STATE_EXCLUDED_EXTENSIONS = 'splitOrDie.excludedExtensions';
const STATE_EXCLUDED_FOLDERS = 'splitOrDie.excludedFolders';
const STATE_EXCLUDED_FILES = 'splitOrDie.excludedFiles';
const CONTEXT_FILE_EXCLUDED = 'splitOrDie.fileExcluded';

const DEFAULT_EXCLUDE_FOLDERS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.svelte-kit',
  '.vite',
  'coverage',
  '__snapshots__',
  'paraglide',
];

const DEFAULT_EXCLUDE_GLOBS = DEFAULT_EXCLUDE_FOLDERS.map((name) => `**/${name}/**`);
const DEFAULT_EXCLUDE_EXTENSIONS = ['md', 'txt', 'yaml', 'yml', 'toml', 'json'];
const DEFAULT_SIZE_THRESHOLD_KB = 20;

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

class SplitOrDieViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private getState: () => ViewState,
    private onMessage: (message: WebviewMessage) => Promise<void>
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.onMessage(message);
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postState();
      }
    });
    this.postState();
  }

  postState() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'state', value: this.getState() });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Split or Die</title>
  <style>
    body {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      padding: 12px;
    }
    h3 {
      font-size: 12px;
      margin: 0 0 8px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .section {
      margin-bottom: 16px;
    }
    .inline {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }
    input[type="text"] {
      flex: 1;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
    }
    button {
      padding: 6px 10px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 4px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .list {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 6px;
      max-height: 160px;
      overflow: auto;
    }
    .item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 2px;
    }
    .item.clickable {
      cursor: pointer;
    }
    .item-label {
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-left: 6px;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      padding: 4px 2px;
    }
  </style>
</head>
<body>
  <div class="section">
    <h3>Size Threshold (KB)</h3>
    <div class="inline">
      <input id="threshold-input" type="number" min="1" step="1" />
      <button id="threshold-apply">Apply</button>
    </div>
  </div>

  <div class="section">
    <h3>Excluded Extensions</h3>
    <div class="inline">
      <input id="ext-input" type="text" placeholder="e.g. log" />
      <button id="ext-add">Add</button>
    </div>
    <div class="list" id="ext-list"></div>
  </div>

  <div class="section">
    <h3>Excluded Folders</h3>
    <div class="list" id="folder-list"></div>
  </div>

  <div class="section">
    <h3>Excluded Files</h3>
    <div class="list" id="file-list"></div>
  </div>

  <div class="section">
    <h3 id="scan-title">Oversized Files</h3>
    <div class="list" id="scan-list"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const thresholdInput = document.getElementById('threshold-input');
    const thresholdApply = document.getElementById('threshold-apply');
    const extInput = document.getElementById('ext-input');
    const extAdd = document.getElementById('ext-add');
    const extList = document.getElementById('ext-list');
    const folderList = document.getElementById('folder-list');
    const fileList = document.getElementById('file-list');
    const scanList = document.getElementById('scan-list');
    const scanTitle = document.getElementById('scan-title');

    thresholdApply.addEventListener('click', () => {
      const value = Number(thresholdInput.value);
      if (!Number.isFinite(value) || value <= 0) return;
      vscode.postMessage({ type: 'updateThreshold', value });
    });

    thresholdInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        thresholdApply.click();
      }
    });

    extAdd.addEventListener('click', () => {
      const value = extInput.value.trim();
      if (!value) return;
      vscode.postMessage({ type: 'addExtension', value });
      extInput.value = '';
    });

    extInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        extAdd.click();
      }
    });

    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'state') return;
      render(message.value);
    });

    function render(state) {
      thresholdInput.value = state.sizeThresholdKb;
      scanTitle.textContent = 'Oversized Files (> ' + state.sizeThresholdKb + ' KB)';
      renderExtensions(state.excludedExtensions || []);
      renderFolderList(state.excludedFolders || []);
      renderFileList(state.excludedFiles || []);
      renderScanList(state.oversizedFiles || []);
    }

    function renderExtensions(items) {
      extList.innerHTML = '';
      if (!items.length) {
        extList.appendChild(createEmpty('No custom extensions.'));
        return;
      }
      items.forEach((ext) => {
        const row = createRow('.' + ext);
        const button = createAction('-', 'secondary');
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'removeExtension', value: ext });
        });
        row.actions.appendChild(button);
        extList.appendChild(row.container);
      });
    }

    function renderFolderList(items) {
      folderList.innerHTML = '';
      if (!items.length) {
        folderList.appendChild(createEmpty('No excluded folders.'));
        return;
      }
      items.forEach((item) => {
        const row = createRow(item.label || item.uri);
        const button = createAction('Include', 'secondary');
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'removeFolder', value: item.uri });
        });
        row.actions.appendChild(button);
        folderList.appendChild(row.container);
      });
    }

    function renderFileList(items) {
      fileList.innerHTML = '';
      if (!items.length) {
        fileList.appendChild(createEmpty('No excluded files.'));
        return;
      }
      items.forEach((item) => {
        const row = createRow(item.label || item.uri);
        const button = createAction('Include', 'secondary');
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'removeFile', value: item.uri });
        });
        row.actions.appendChild(button);
        fileList.appendChild(row.container);
      });
    }

    function renderScanList(items) {
      scanList.innerHTML = '';
      if (!items.length) {
        scanList.appendChild(createEmpty('No oversized files.'));
        return;
      }
      items.forEach((item) => {
        const row = createRow(item.label || item.uri, item.sizeLabel);
        const button = createAction('Open', 'secondary');
        row.container.classList.add('clickable');
        row.container.addEventListener('click', () => {
          vscode.postMessage({ type: 'openFile', value: item.uri });
        });
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: 'openFile', value: item.uri });
        });
        row.actions.appendChild(button);
        scanList.appendChild(row.container);
      });
    }

    function createRow(label, meta) {
      const container = document.createElement('div');
      container.className = 'item';

      const text = document.createElement('div');
      text.className = 'item-label';
      text.textContent = label;

      if (meta) {
        const metaSpan = document.createElement('span');
        metaSpan.className = 'item-meta';
        metaSpan.textContent = meta;
        text.appendChild(metaSpan);
      }

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      container.appendChild(text);
      container.appendChild(actions);

      return { container, actions };
    }

    function createAction(label, variant) {
      const button = document.createElement('button');
      if (variant) button.className = variant;
      button.textContent = label;
      return button;
    }

    function createEmpty(message) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = message;
      return empty;
    }
  </script>
</body>
</html>`;
  }
}

function readConfig(): SplitOrDieConfig {
  const config = vscode.workspace.getConfiguration('splitOrDie');
  return {
    enabled: config.get('enable', true),
    sizeThresholdKb: config.get('sizeThresholdKb', DEFAULT_SIZE_THRESHOLD_KB),
    excludeGlobs: config.get('excludeGlobs', DEFAULT_EXCLUDE_GLOBS),
    excludeExtensions: config.get('excludeExtensions', DEFAULT_EXCLUDE_EXTENSIONS),
    runOnStartup: config.get('runOnStartup', true),
    runOnSave: config.get('runOnSave', true),
  };
}

function buildExclusionState(
  context: vscode.ExtensionContext,
  config: SplitOrDieConfig
): ExclusionState {
  const excludedFolders = getStateList<string[]>(context, STATE_EXCLUDED_FOLDERS, []);
  const excludedFiles = getStateList<string[]>(context, STATE_EXCLUDED_FILES, []);
  const excludeExtensions = normalizeExtensions(config.excludeExtensions);
  const excludedFolderSet = new Set(excludedFolders.map(normalizeFsPath));
  const excludedFileSet = new Set(excludedFiles.map(normalizeFsPath));
  const excludeGlob = buildExcludeGlob([...DEFAULT_EXCLUDE_GLOBS, ...config.excludeGlobs]);

  return {
    excludeExtensions,
    excludedFolderSet,
    excludedFileSet,
    excludedFolders,
    excludedFiles,
    excludeGlob,
  };
}

async function scanWorkspace(
  config: SplitOrDieConfig,
  exclusion: ExclusionState,
  thresholdBytes: number
): Promise<Map<string, ScanEntry>> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return new Map();
  }

  const entries = new Map<string, ScanEntry>();

  for (const folder of folders) {
    const include = new vscode.RelativePattern(folder, '**/*');
    const files = await vscode.workspace.findFiles(include, exclusion.excludeGlob);
    const candidates = files.filter((uri) => {
      if (shouldSkipExtension(uri.fsPath, exclusion.excludeExtensions)) return false;
      if (isExplicitlyExcluded(uri.fsPath, exclusion)) return false;
      return true;
    });

    const chunkSize = 50;
    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);
      const stats = await Promise.all(chunk.map((uri) => safeStat(uri)));

      for (let index = 0; index < chunk.length; index += 1) {
        const stat = stats[index];
        if (!stat) continue;
        if (stat.size <= thresholdBytes) continue;

        const uri = chunk[index];
        const lineCount = (await readLineCount(uri)) ?? estimateLines(stat.size);
        entries.set(uri.toString(), { uri, size: stat.size, lineCount });
      }
    }
  }

  return entries;
}

async function checkDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  config: SplitOrDieConfig,
  exclusion: ExclusionState,
  scanEntries: Map<string, ScanEntry>
): Promise<void> {
  if (document.uri.scheme !== 'file') return;

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return;

  const uriKey = document.uri.toString();

  if (shouldSkipExtension(document.uri.fsPath, exclusion.excludeExtensions)) {
    diagnostics.delete(document.uri);
    scanEntries.delete(uriKey);
    return;
  }

  if (isExplicitlyExcluded(document.uri.fsPath, exclusion)) {
    diagnostics.delete(document.uri);
    scanEntries.delete(uriKey);
    return;
  }

  const stat = await safeStat(document.uri);
  if (!stat) return;

  const thresholdBytes = Math.max(1, config.sizeThresholdKb) * 1024;
  if (stat.size <= thresholdBytes) {
    diagnostics.delete(document.uri);
    scanEntries.delete(uriKey);
    return;
  }

  const diagnostic = createDiagnostic(stat.size, document.lineCount);
  diagnostics.set(document.uri, [diagnostic]);
  scanEntries.set(uriKey, { uri: document.uri, size: stat.size, lineCount: document.lineCount });
}

function createDiagnostic(sizeBytes: number, lineCount: number): vscode.Diagnostic {
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));
  const sizeLabel = formatBytes(sizeBytes);
  const message = `File size ${sizeLabel} (=${lineCount} lines). Consider splitting into smaller modules.`;
  const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  return diagnostic;
}

function buildExcludeGlob(patterns: string[]): string | undefined {
  const unique = Array.from(new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean)));
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  return `{${unique.join(',')}}`;
}

function normalizeExtensions(extensions: string[]): Set<string> {
  return new Set(
    extensions
      .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
  );
}

function normalizeExtensionInput(value: string): string | null {
  const trimmed = value.trim().replace(/^\./, '').toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

function shouldSkipExtension(filePath: string, excluded: Set<string>): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  if (!ext) return false;
  return excluded.has(ext);
}

function isExplicitlyExcluded(filePath: string, exclusion: ExclusionState): boolean {
  const normalized = normalizeFsPath(filePath);
  if (exclusion.excludedFileSet.has(normalized)) {
    return true;
  }
  for (const folder of exclusion.excludedFolderSet) {
    if (normalized === folder) return true;
    if (normalized.startsWith(folder + path.sep)) return true;
  }
  return false;
}

function normalizeFsPath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function buildViewState(
  config: SplitOrDieConfig,
  exclusion: ExclusionState,
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

async function addExcludedExtension(value: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('splitOrDie');
  const normalized = normalizeExtensionInput(value);
  if (!normalized) return;
  const current = normalizeExtensionList(
    config.get('excludeExtensions', DEFAULT_EXCLUDE_EXTENSIONS)
  );
  if (current.includes(normalized)) return;
  const next = [...current, normalized].sort();
  await updateExcludedExtensionsConfig(config, next);
}

async function removeExcludedExtension(value: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('splitOrDie');
  const normalized = normalizeExtensionInput(value);
  if (!normalized) return;
  const current = normalizeExtensionList(
    config.get('excludeExtensions', DEFAULT_EXCLUDE_EXTENSIONS)
  );
  const next = current.filter((ext) => ext !== normalized);
  await updateExcludedExtensionsConfig(config, next);
}

async function updateExcludedExtensionsConfig(
  config: vscode.WorkspaceConfiguration,
  next: string[]
): Promise<void> {
  await config.update('excludeExtensions', next, getConfigTarget());
}

function normalizeExtensionList(values: string[]): string[] {
  return Array.from(normalizeExtensions(values)).sort();
}

async function migrateExcludedExtensions(context: vscode.ExtensionContext): Promise<void> {
  const legacy = getStateList<string[]>(context, STATE_EXCLUDED_EXTENSIONS, []);
  if (!legacy.length) return;
  const config = vscode.workspace.getConfiguration('splitOrDie');
  const current = normalizeExtensionList(
    config.get('excludeExtensions', DEFAULT_EXCLUDE_EXTENSIONS)
  );
  const merged = Array.from(new Set([...current, ...normalizeExtensionList(legacy)])).sort();
  await updateExcludedExtensionsConfig(config, merged);
  await context.workspaceState.update(STATE_EXCLUDED_EXTENSIONS, []);
}

async function updateSizeThreshold(next: number): Promise<void> {
  const config = vscode.workspace.getConfiguration('splitOrDie');
  await config.update('sizeThresholdKb', next, getConfigTarget());
}

function getConfigTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

async function addExcludedFolder(
  context: vscode.ExtensionContext,
  fsPath: string
): Promise<void> {
  const folders = getStateList<string[]>(context, STATE_EXCLUDED_FOLDERS, []);
  const next = addUniquePath(folders, fsPath);
  await context.workspaceState.update(STATE_EXCLUDED_FOLDERS, next);
}

async function removeExcludedFolder(
  context: vscode.ExtensionContext,
  uriValue: string
): Promise<void> {
  const folders = getStateList<string[]>(context, STATE_EXCLUDED_FOLDERS, []);
  const targetPath = resolveFsPath(uriValue);
  const next = folders.filter(
    (entry) => normalizeFsPath(entry) !== normalizeFsPath(targetPath)
  );
  await context.workspaceState.update(STATE_EXCLUDED_FOLDERS, next);
}

async function addExcludedFile(
  context: vscode.ExtensionContext,
  fsPath: string
): Promise<void> {
  const files = getStateList<string[]>(context, STATE_EXCLUDED_FILES, []);
  const next = addUniquePath(files, fsPath);
  await context.workspaceState.update(STATE_EXCLUDED_FILES, next);
}

async function removeExcludedFile(
  context: vscode.ExtensionContext,
  uriValue: string
): Promise<void> {
  const files = getStateList<string[]>(context, STATE_EXCLUDED_FILES, []);
  const targetPath = resolveFsPath(uriValue);
  const next = files.filter((entry) => normalizeFsPath(entry) !== normalizeFsPath(targetPath));
  await context.workspaceState.update(STATE_EXCLUDED_FILES, next);
}

function addUniquePath(entries: string[], fsPath: string): string[] {
  const normalized = normalizeFsPath(fsPath);
  if (entries.some((entry) => normalizeFsPath(entry) === normalized)) {
    return entries;
  }
  return [...entries, fsPath];
}

function resolveFsPath(value: string): string {
  if (/^file:/i.test(value)) {
    try {
      return vscode.Uri.parse(value).fsPath;
    } catch {
      return value;
    }
  }
  return value;
}

function getStateList<T>(
  context: vscode.ExtensionContext,
  key: string,
  fallback: T
): T {
  return context.workspaceState.get(key, fallback);
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

function pruneExcludedEntries(
  diagnostics: vscode.DiagnosticCollection,
  scanEntries: Map<string, ScanEntry>,
  excludedExtensions: Set<string>
): void {
  diagnostics.forEach((uri) => {
    if (shouldSkipExtension(uri.fsPath, excludedExtensions)) {
      diagnostics.delete(uri);
    }
  });

  for (const [key, entry] of scanEntries) {
    if (shouldSkipExtension(entry.uri.fsPath, excludedExtensions)) {
      scanEntries.delete(key);
    }
  }
}

async function updateContextForUri(
  context: vscode.ExtensionContext,
  config: SplitOrDieConfig,
  uri?: vscode.Uri
): Promise<void> {
  if (!uri || uri.scheme !== 'file') {
    await vscode.commands.executeCommand('setContext', CONTEXT_FILE_EXCLUDED, false);
    return;
  }

  const exclusion = buildExclusionState(context, config);
  const isExcluded = isExplicitlyExcluded(uri.fsPath, exclusion);
  await vscode.commands.executeCommand('setContext', CONTEXT_FILE_EXCLUDED, isExcluded);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function estimateLines(bytes: number): number {
  const estimated = (bytes / 1024) * 25;
  const rounded = Math.round(estimated / 50) * 50;
  return Math.max(1, rounded);
}

async function readLineCount(uri: vscode.Uri): Promise<number | null> {
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    return countLines(data);
  } catch {
    return null;
  }
}

function countLines(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let lines = 1;
  for (const byte of data) {
    if (byte === 10) {
      lines += 1;
    }
  }
  return lines;
}

async function safeStat(uri: vscode.Uri): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
