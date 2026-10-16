import ts from 'typescript';
import { extname } from '../core/text.js';

const VROOT = '/__coderefiner__/';

export interface TypeCheckResult {
  ran: boolean;
  reason?: string;
  /** file -> diagnostic code -> count */
  counts: Map<string, Map<number, number>>;
  total: number;
}

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** Type-checks an in-memory project. Never touches the disk and never executes project code. */
export function typecheckProject(files: Map<string, string>): TypeCheckResult {
  const hasTs = [...files.keys()].some((p) => TS_EXT.has(extname(p)) && !p.endsWith('.d.ts') || p.endsWith('.d.ts'));
  if (!hasTs) return { ran: false, reason: 'no TypeScript files', counts: new Map(), total: 0 };

  const abs = (p: string) => VROOT + p;
  const virtual = new Map<string, string>();
  for (const [p, c] of files) virtual.set(abs(p), c);
  const dirs = new Set<string>([VROOT.slice(0, -1)]);
  for (const p of virtual.keys()) {
    let d = p.slice(0, p.lastIndexOf('/'));
    while (d.length >= VROOT.length - 1 && !dirs.has(d)) {
      dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
  }

  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowJs: false,
    types: [],
  };
  let rootNames = [...virtual.keys()].filter((p) => TS_EXT.has(extname(p)));

  const tsconfigText = files.get('tsconfig.json');
  if (tsconfigText) {
    const parsed = ts.parseConfigFileTextToJson(abs('tsconfig.json'), tsconfigText);
    if (!parsed.error) {
      const host: ts.ParseConfigHost = {
        useCaseSensitiveFileNames: true,
        readFile: (f) => virtual.get(f),
        fileExists: (f) => virtual.has(f),
        readDirectory: (root, exts) => [...virtual.keys()].filter((f) => f.startsWith(root) && (!exts || exts.some((e) => f.endsWith(e)))),
      };
      const cfg = ts.parseJsonConfigFileContent(parsed.config, host, VROOT.slice(0, -1));
      options = { ...cfg.options, noEmit: true, skipLibCheck: true, types: cfg.options.types ?? [] };
      delete options.incremental;
      delete options.composite;
      delete options.tsBuildInfoFile;
      if (cfg.fileNames.length) rootNames = cfg.fileNames;
    }
  }

  const base = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (f) => (f.startsWith(VROOT) ? virtual.has(f) : base.fileExists(f)),
    readFile: (f) => (f.startsWith(VROOT) ? virtual.get(f) : base.readFile(f)),
    directoryExists: (d) => (d.startsWith(VROOT.slice(0, -1)) ? dirs.has(d.replace(/\/$/, '')) : base.directoryExists?.(d) ?? false),
    getDirectories: (d) => (d.startsWith(VROOT.slice(0, -1)) ? [...dirs].filter((x) => x.startsWith(d.replace(/\/$/, '') + '/') && !x.slice(d.length + 1).includes('/')).map((x) => x.slice(x.lastIndexOf('/') + 1)) : base.getDirectories?.(d) ?? []),
    getSourceFile: (f, lang, onErr, shouldCreate) => {
      if (f.startsWith(VROOT)) {
        const text = virtual.get(f);
        return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true);
      }
      return base.getSourceFile(f, lang, onErr, shouldCreate);
    },
    writeFile: () => undefined,
    getCurrentDirectory: () => VROOT.slice(0, -1),
  };

  let program: ts.Program;
  try {
    program = ts.createProgram({ rootNames, options, host });
  } catch (e) {
    return { ran: false, reason: (e as Error).message, counts: new Map(), total: 0 };
  }
  const diags = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  const counts = new Map<string, Map<number, number>>();
  let total = 0;
  for (const d of diags) {
    const file = d.file ? d.file.fileName.replace(VROOT, '') : '<global>';
    if (!counts.has(file)) counts.set(file, new Map());
    const m = counts.get(file)!;
    m.set(d.code, (m.get(d.code) ?? 0) + 1);
    total++;
  }
  return { ran: true, counts, total };
}

/** Files whose diagnostics increased compared to the baseline. */
export function regressions(before: TypeCheckResult, after: TypeCheckResult): string[] {
  const out: string[] = [];
  for (const [file, codes] of after.counts) {
    const prev = before.counts.get(file);
    for (const [code, n] of codes) {
      if (n > (prev?.get(code) ?? 0)) {
        out.push(file);
        break;
      }
    }
  }
  return out;
}
