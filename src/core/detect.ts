import { extname } from './text.js';

/** Extension -> language id. Ids that have a Language Pack are listed in languages/registry. */
const EXT_LANGUAGE: Record<string, string> = {
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.jsonc': 'json',
  '.py': 'python',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.md': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.lua': 'lua',
  '.scala': 'scala',
  '.kts': 'kotlin',
  '.cxx': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.markdown': 'markdown',
};

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.jar', '.wasm', '.pdf', '.exe', '.dll', '.so', '.dylib', '.class', '.pyc',
]);

export function detectLanguage(path: string): string | undefined {
  return EXT_LANGUAGE[extname(path)];
}

export function isBinary(path: string, data: Buffer): boolean {
  if (BINARY_EXT.has(extname(path))) return true;
  // UTF-16 text contains NUL bytes by design
  if (data.length >= 2 && ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))) return false;
  const len = Math.min(data.length, 8000);
  for (let i = 0; i < len; i++) if (data[i] === 0) return true;
  return false;
}

/** Languages that are not "code" for the purpose of the unsupported-language report. */
export const NON_CODE_LANGUAGES = new Set(['markdown', 'yaml', 'toml', 'xml', 'shell']);
