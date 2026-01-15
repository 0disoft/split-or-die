import type * as vscode from 'vscode';

export type SplitOrDieConfig = {
  enabled: boolean;
  sizeThresholdKb: number;
  excludeGlobs: string[];
  excludeExtensions: string[];
  runOnStartup: boolean;
  runOnSave: boolean;
};

export type ScanEntry = {
  uri: vscode.Uri;
  size: number;
  lineCount: number;
};

export type ViewEntry = {
  uri: string;
  label: string;
  sizeLabel?: string;
};

export type ViewState = {
  sizeThresholdKb: number;
  excludedExtensions: string[];
  excludedFolders: ViewEntry[];
  excludedFiles: ViewEntry[];
  oversizedFiles: ViewEntry[];
};

export type ExclusionState = {
  excludeExtensions: Set<string>;
  excludedFolderSet: Set<string>;
  excludedFileSet: Set<string>;
  excludedFolders: string[];
  excludedFiles: string[];
  excludeGlob: string | undefined;
};

export type WebviewMessage =
  | { type: 'addExtension'; value: string }
  | { type: 'removeExtension'; value: string }
  | { type: 'removeFolder'; value: string }
  | { type: 'removeFile'; value: string }
  | { type: 'openFile'; value: string }
  | { type: 'updateThreshold'; value: number }
  | { type: 'ready' };
