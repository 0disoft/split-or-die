import * as vscode from 'vscode';
import {
  DEFAULT_EXCLUDE_EXTENSIONS,
  DEFAULT_EXCLUDE_GLOBS,
  DEFAULT_SIZE_THRESHOLD_KB,
  STATE_EXCLUDED_EXTENSIONS,
} from './constants';
import { normalizeExtensionInput, normalizeExtensionList } from './extensions';
import { getStateList } from './state';
import type { SplitOrDieConfig } from './types';

export function readConfig(): SplitOrDieConfig {
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

export async function addExcludedExtension(value: string): Promise<void> {
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

export async function removeExcludedExtension(value: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('splitOrDie');
  const normalized = normalizeExtensionInput(value);
  if (!normalized) return;
  const current = normalizeExtensionList(
    config.get('excludeExtensions', DEFAULT_EXCLUDE_EXTENSIONS)
  );
  const next = current.filter((ext) => ext !== normalized);
  await updateExcludedExtensionsConfig(config, next);
}

export async function migrateExcludedExtensions(
  context: vscode.ExtensionContext
): Promise<void> {
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

export async function updateSizeThreshold(next: number): Promise<void> {
  const config = vscode.workspace.getConfiguration('splitOrDie');
  await config.update('sizeThresholdKb', next, getConfigTarget());
}

async function updateExcludedExtensionsConfig(
  config: vscode.WorkspaceConfiguration,
  next: string[]
): Promise<void> {
  await config.update('excludeExtensions', next, getConfigTarget());
}

function getConfigTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
