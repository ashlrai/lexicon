/**
 * Path gate for the Windows and macOS legs and for the install smokes.
 * A pull request runs those jobs when the diff touches path handling, shell
 * scripts, installers, manifests, lockfiles, the native apps, or the workflows
 * that build them. Anything else, including docs, skips the leg.
 */
const rules = [
  { name: 'path', re: /^(src\/util\/(?:xdg|which)\.ts|src\/cli\/serve-paths\.ts|src\/cli\/[^/]*paths[^/]*|apps\/(?:windows|macos)\/.*[Pp]ath.*)$/ },
  { name: 'shell', re: /^(?:src\/(?:util|core)\/shell\.ts|.*\.(?:sh|ps1|cmd|bat))$/ },
  { name: 'install', re: /^(?:scripts\/install\.sh|scripts\/build-macos-app\.sh|src\/cli\/cmd-(?:install|uninstall|setup)\.ts|src\/cli\/setup\/.*|packaging\/.*)$/ },
  { name: 'manifest', re: /(^|\/)(?:package\.json|Package\.swift|[^/]+\.(?:csproj|sln))$/ },
  { name: 'lockfile', re: /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|Package\.resolved)$/ },
  { name: 'workflow', re: /^\.github\/workflows\/(?:ci|windows-app|macos-app)\.yml$/ },
  { name: 'app', re: /^apps\/(?:windows|macos)\// },
  { name: 'test', re: /^tests\/.*(?:install|xdg|which|shell|path|windows|macos|win32)/i },
];

export function isOsPath(file) {
  const name = String(file).replaceAll('\\', '/').replace(/^\.\//, '');
  return rules.some((rule) => rule.re.test(name));
}

export function classifyPaths(files) {
  return files.some((file) => file.trim() && isOsPath(file.trim()));
}

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const files = Buffer.concat(chunks).toString('utf8').split('\n');
  process.stdout.write(`os=${classifyPaths(files) ? 'true' : 'false'}\n`);
}
