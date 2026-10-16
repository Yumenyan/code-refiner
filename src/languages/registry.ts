import { extname } from '../core/text.js';
import type { LanguagePack } from './types.js';

export class LanguageRegistry {
  private byId = new Map<string, LanguagePack>();
  private byExt = new Map<string, LanguagePack>();

  register(pack: LanguagePack): void {
    this.byId.set(pack.id, pack);
    for (const ext of pack.extensions) this.byExt.set(ext.toLowerCase(), pack);
  }

  get(id: string): LanguagePack | undefined {
    return this.byId.get(id);
  }

  forFile(path: string): LanguagePack | undefined {
    return this.byExt.get(extname(path));
  }

  list(): LanguagePack[] {
    return [...this.byId.values()];
  }

  supportedLanguageIds(): Set<string> {
    return new Set(this.byId.keys());
  }
}
