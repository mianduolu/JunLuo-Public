import JSZip from 'jszip';

export type JunLuoToolPkgManifestPreview = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  permissions: string[];
  packages: Array<{ id?: string; name?: string; toolCount?: number }>;
  hooks: Array<{ type?: string; id?: string }>;
  resources: Array<{ name?: string; type?: string }>;
  status: 'manifest_only';
  executableLoaded: false;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeString(value: unknown) {
  const text = readString(value);
  if (/token|cookie|secret|endpoint|api[_-]?key/i.test(text)) return '[redacted]';
  return text;
}

function summarizePackage(value: unknown) {
  const record = readRecord(value) ?? {};
  const tools = Array.isArray(record.tools) ? record.tools : [];
  return {
    ...(sanitizeString(record.id) ? { id: sanitizeString(record.id) } : {}),
    ...(sanitizeString(record.name ?? record.display_name) ? { name: sanitizeString(record.name ?? record.display_name) } : {}),
    toolCount: tools.length,
  };
}

function summarizeHook(value: unknown) {
  const record = readRecord(value) ?? {};
  return {
    ...(sanitizeString(record.type) ? { type: sanitizeString(record.type) } : {}),
    ...(sanitizeString(record.id ?? record.name) ? { id: sanitizeString(record.id ?? record.name) } : {}),
  };
}

function summarizeResource(value: unknown) {
  const record = readRecord(value) ?? {};
  return {
    ...(sanitizeString(record.name ?? record.path) ? { name: sanitizeString(record.name ?? record.path) } : {}),
    ...(sanitizeString(record.type) ? { type: sanitizeString(record.type) } : {}),
  };
}

export function parseToolPkgManifestJson(input: string | Record<string, unknown>): JunLuoToolPkgManifestPreview {
  const manifest = typeof input === 'string' ? JSON.parse(input) : input;
  const record = readRecord(manifest);
  if (!record) throw new Error('ToolPkg manifest 必须是 JSON object');
  const id = sanitizeString(record.id ?? record.package_id);
  const name = sanitizeString(record.name ?? record.display_name);
  if (!id || !name) throw new Error('ToolPkg manifest 缺少 id/name');
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.map(sanitizeString).filter(Boolean)
    : [];
  return {
    id,
    name,
    ...(sanitizeString(record.version) ? { version: sanitizeString(record.version) } : {}),
    ...(sanitizeString(record.description) ? { description: sanitizeString(record.description) } : {}),
    permissions,
    packages: Array.isArray(record.packages) ? record.packages.map(summarizePackage) : [],
    hooks: Array.isArray(record.hooks) ? record.hooks.map(summarizeHook) : [],
    resources: Array.isArray(record.resources) ? record.resources.map(summarizeResource) : [],
    status: 'manifest_only',
    executableLoaded: false,
  };
}

export async function parseToolPkgManifestFromZipBase64(base64: string): Promise<JunLuoToolPkgManifestPreview> {
  const zip = await JSZip.loadAsync(base64, { base64: true });
  const manifestFile =
    zip.file('manifest.json') ??
    zip.file('toolpkg.json') ??
    zip.file('.toolpkg/manifest.json');
  if (!manifestFile) {
    throw new Error('ToolPkg 中没有 manifest.json');
  }
  const manifestText = await manifestFile.async('text');
  return parseToolPkgManifestJson(manifestText);
}
