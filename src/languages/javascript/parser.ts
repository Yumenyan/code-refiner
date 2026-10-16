import { parse as babelParse, type ParserOptions, type ParserPlugin } from '@babel/parser';
import type { File } from '@babel/types';
import * as recast from 'recast';
import { extname } from '../../core/text.js';
import type { CodePrinter } from '../types.js';

export type EcmaLanguage = 'javascript' | 'typescript';

export function parserOptions(file: string, language: EcmaLanguage): ParserOptions {
  const ext = extname(file);
  const plugins: ParserPlugin[] = [];
  if (language === 'typescript') {
    plugins.push('typescript');
    if (ext === '.tsx') plugins.push('jsx');
    plugins.push('decorators-legacy');
  } else {
    plugins.push('jsx');
  }
  const sourceType: ParserOptions['sourceType'] = ext === '.cjs' || ext === '.cts' ? 'script' : ext === '.mjs' || ext === '.mts' ? 'module' : 'unambiguous';
  return {
    sourceType,
    plugins,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowUndeclaredExports: true,
    errorRecovery: false,
    tokens: true,
  };
}

export function parseEcma(source: string, file: string, language: EcmaLanguage): File {
  return babelParse(source, parserOptions(file, language)) as unknown as File;
}

/** Parses with recast so unmodified code keeps its original formatting when printed. */
export function parseRecast(source: string, file: string, language: EcmaLanguage): File {
  const opts = parserOptions(file, language);
  return recast.parse(source, {
    parser: { parse: (src: string) => babelParse(src, opts) },
  }) as unknown as File;
}

export function printRecast(ast: File): string {
  return recast.print(ast, { quote: 'auto', reuseWhitespace: true }).code;
}

/** Code Printer for the ECMAScript packs: recast keeps untouched code byte-identical. */
export const recastPrinter: CodePrinter<File> = { id: 'recast', print: (ast) => printRecast(ast) };

export function errorMessage(e: unknown): string {
  const err = e as { message?: string; loc?: { line: number; column: number } };
  return err?.message ?? String(e);
}
