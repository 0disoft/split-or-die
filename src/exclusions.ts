import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONTEXT_FILE_EXCLUDED, DEFAULT_EXCLUDE_GLOBS, STATE_EXCLUDED_FILES, STATE_EXCLUDED_FOLDERS } from './constants';
import { normalizeExtensions, shouldSkipExtension } from './extensions';
import { getStateList, normalizeFsPath } from './state';
import type { ExclusionState, ScanEntry, SplitOrDieConfig } from './types';

export function buildExclusionState(
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

export function buildExcludeGlob(patterns: string[]): string | undefined {
  const unique = Array.from(new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean)));
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  return `{${unique.join(',')}}`;
}

export function isExplicitlyExcluded(filePath: string, exclusion: ExclusionState): boolean {
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

export function pruneExcludedEntries(
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

export async function updateContextForUri(
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
