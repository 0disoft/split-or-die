import * as path from 'node:path';

export function normalizeExtensions(extensions: string[]): Set<string> {
  return new Set(
    extensions
      .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
  );
}

export function normalizeExtensionInput(value: string): string | null {
  const trimmed = value.trim().replace(/^\./, '').toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeExtensionList(values: string[]): string[] {
  return Array.from(normalizeExtensions(values)).sort();
}

export function shouldSkipExtension(filePath: string, excluded: Set<string>): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  if (!ext) {
    const base = path.basename(filePath).toLowerCase();
    if (base.startsWith('.') && base.length > 1) {
      const dotName = base.slice(1);
      return excluded.has(dotName);
    }
    return false;
  }
  return excluded.has(ext);
}
