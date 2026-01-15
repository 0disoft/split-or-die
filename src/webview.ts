import * as vscode from 'vscode';
import type { ViewState, WebviewMessage } from './types';

export class SplitOrDieViewProvider implements vscode.WebviewViewProvider {
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

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
