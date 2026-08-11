import { dirname, isAbsolute, resolve, win32 } from "node:path";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isAbsoluteOnAnyPlatform(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function replaceListBlock(
  template: string,
  key: "watch" | "exec",
  transform: (line: string) => string,
): string {
  const block = new RegExp(
    `(^[ \\t]*${key}:[ \\t]*\\r?\\n)((?:^[ \\t]+-[^\\r\\n]*(?:\\r?\\n|$))*)`,
    "gm",
  );
  return template.replace(block, (_match, heading: string, entries: string) => {
    const trailingNewline = entries.endsWith("\n");
    const lines = entries.split(/\r?\n/);
    if (trailingNewline) lines.pop();
    const rendered = lines.map(transform).join("\n");
    return heading + rendered + (trailingNewline ? "\n" : "");
  });
}

function rootRelativeWatchPaths(template: string, packageRoot: string): string {
  return replaceListBlock(template, "watch", (line) => {
    const match = line.match(/^(\s*-\s*)(.+?)\s*$/);
    if (!match) return line;
    const value = stripQuotes(match[2]);
    if (!value || isAbsoluteOnAnyPlatform(value)) return line;
    const absolute = normalizePath(resolve(packageRoot, value));
    return `${match[1]}${absolute.includes(" ") ? yamlSingleQuoted(absolute) : absolute}`;
  });
}

function rootRelativeWorkerExec(template: string, packageRoot: string): string {
  return replaceListBlock(template, "exec", (line) => {
    const match = line.match(/^(\s*-\s*node\s+)(.+?)\s*$/);
    if (!match) return line;
    const value = stripQuotes(match[2]);
    if (!value || isAbsoluteOnAnyPlatform(value)) return line;
    const absolute = normalizePath(resolve(packageRoot, value));
    const argument = absolute.includes(" ") ? `"${absolute}"` : absolute;
    return `${match[1]}${argument}`;
  });
}

export function renderIiiConfig(
  template: string,
  dataDir: string,
  configPath: string,
): string {
  const packageRoot = dirname(configPath);
  const withDataPaths = template
    .replace(
      /file_path:\s*\.\/data\/state_store\.db/,
      `file_path: ${yamlSingleQuoted(normalizePath(resolve(dataDir, "state_store.db")))}`,
    )
    .replace(
      /file_path:\s*\.\/data\/stream_store/,
      `file_path: ${yamlSingleQuoted(normalizePath(resolve(dataDir, "stream_store")))}`,
    );
  return rootRelativeWorkerExec(
    rootRelativeWatchPaths(withDataPaths, packageRoot),
    packageRoot,
  );
}

export function extractWorkerExecPath(config: string): string | null {
  const block = config.match(
    /^[ \t]*exec:[ \t]*\r?\n((?:^[ \t]+-[^\r\n]*(?:\r?\n|$))*)/m,
  );
  if (!block) return null;
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*node\s+(.+?)\s*$/);
    if (!match) continue;
    return normalizePath(stripQuotes(match[1]));
  }
  return null;
}

export function workerPackageRoot(workerExecPath: string): string {
  const normalized = normalizePath(workerExecPath).replace(/\/+$/, "");
  const marker = normalized.match(/^(.*)\/(?:dist|src)\/[^/]+$/);
  return marker ? marker[1] : normalizePath(dirname(normalized));
}
