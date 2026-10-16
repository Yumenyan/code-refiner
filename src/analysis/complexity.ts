import type { ComplexityLimits } from '../core/config.js';
import type { Suggestion } from '../core/types.js';
import type { ProjectModel } from '../semantic/project.js';

export function analyzeComplexity(model: ProjectModel, limits: ComplexityLimits): Suggestion[] {
  const out: Suggestion[] = [];
  for (const f of model.functions) {
    const problems: string[] = [];
    if (f.lines > limits.maxFunctionLines) problems.push(`${f.lines} lines (max ${limits.maxFunctionLines})`);
    if (f.maxNesting > limits.maxNesting) problems.push(`nesting depth ${f.maxNesting} (max ${limits.maxNesting})`);
    if (f.params.length > limits.maxParams) problems.push(`${f.params.length} parameters (max ${limits.maxParams})`);
    if (f.cyclomatic > limits.maxCyclomatic) problems.push(`cyclomatic complexity ${f.cyclomatic} (max ${limits.maxCyclomatic})`);
    if (problems.length) {
      out.push({
        file: f.file,
        kind: 'complexity',
        loc: f.loc,
        confidence: 1,
        message: `Function "${f.name}" is hard to read: ${problems.join(', ')}.`,
        details: { name: f.name, lines: f.lines, nesting: f.maxNesting, params: f.params.length, cyclomatic: f.cyclomatic },
      });
    }
  }
  for (const cycle of model.cycles) {
    out.push({
      file: cycle[0],
      kind: 'complexity',
      confidence: 1,
      message: `Circular dependency between ${cycle.length === 1 ? 'a file and itself' : cycle.join(' ↔ ')}.`,
      details: { category: 'circular-dependency', files: cycle },
    });
  }
  return out;
}
