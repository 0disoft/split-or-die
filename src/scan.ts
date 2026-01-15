import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from './constants';
import { shouldSkipExtension } from './extensions';
import { isExplicitlyExcluded } from './exclusions';
import type { ExclusionState, ScanEntry, SplitOrDieConfig } from './types';

export async function scanWorkspace(
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

export async function checkDocument(
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

export function createDiagnostic(sizeBytes: number, lineCount: number): vscode.Diagnostic {
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));
  const sizeLabel = formatBytes(sizeBytes);
  const message = `File size ${sizeLabel} (=${lineCount} lines). Consider splitting into smaller modules.`;
  const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  return diagnostic;
}

export function formatBytes(bytes: number): string {
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
