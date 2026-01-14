# Split or Die

Enforce smaller, modular files by flagging oversized or complex code.

## Features

- Scans the workspace and reports files larger than a size threshold.
- Runs on startup, on save, and via command palette.
- Activity Bar view to manage exclusions and see oversized files.
- Exclude folders/files from the Explorer context menu.
- Skips common build/vendor folders and non-code extensions by default.

## Usage

- Activity Bar: open **Split or Die** to manage exclusions and view oversized files.
- Command Palette: `Split or Die: Scan Workspace`
- Explorer context menu:
  - `Split or Die: Toggle Folder Exclusion`
  - `Split or Die: Toggle File Exclusion`

## Extension Settings

This extension contributes the following settings:

- `splitOrDie.enable`: Enable or disable diagnostics.
- `splitOrDie.sizeThresholdKb`: Report files larger than this size (KB). Default: `16`.
- `splitOrDie.runOnStartup`: Run a scan when VS Code finishes starting.
- `splitOrDie.runOnSave`: Check the saved file and update diagnostics.
- `splitOrDie.excludeGlobs`: Glob patterns excluded from scans.
- `splitOrDie.excludeExtensions`: File extensions to ignore (without leading dot).

## Release Notes

### 0.0.1

- Initial scaffold.
