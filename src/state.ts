import * as vscode from 'vscode';
import * as path from 'node:path';
import { STATE_EXCLUDED_FILES, STATE_EXCLUDED_FOLDERS } from './constants';

export function getStateList<T>(
  context: vscode.ExtensionContext,
  key: string,
  fallback: T
): T {
  return context.workspaceState.get(key, fallback);
}

export async function addExcludedFolder(
  context: vscode.ExtensionContext,
  fsPath: string
): Promise<void> {
  const folders = getStateList<string[]>(context, STATE_EXCLUDED_FOLDERS, []);
  const next = addUniquePath(folders, fsPath);
  await context.workspaceState.update(STATE_EXCLUDED_FOLDERS, next);
}

export async function removeExcludedFolder(
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

export async function addExcludedFile(
  context: vscode.ExtensionContext,
  fsPath: string
): Promise<void> {
  const files = getStateList<string[]>(context, STATE_EXCLUDED_FILES, []);
  const next = addUniquePath(files, fsPath);
  await context.workspaceState.update(STATE_EXCLUDED_FILES, next);
}

export async function removeExcludedFile(
  context: vscode.ExtensionContext,
  uriValue: string
): Promise<void> {
  const files = getStateList<string[]>(context, STATE_EXCLUDED_FILES, []);
  const targetPath = resolveFsPath(uriValue);
  const next = files.filter((entry) => normalizeFsPath(entry) !== normalizeFsPath(targetPath));
  await context.workspaceState.update(STATE_EXCLUDED_FILES, next);
}

export function normalizeFsPath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
