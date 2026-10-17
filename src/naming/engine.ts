import type { Config, NamingWeights, Thresholds } from '../core/config.js';
import type { NameCandidate } from '../core/types.js';
import { generateSpecs, renderSpec, valueTypeFromRole, type Evidence, type NameSpec } from './candidates.js';
import type { NamingConvention } from './convention.js';
import type { NamingSubject } from './facts.js';
import type { Vocabulary } from './vocabulary.js';
import { COMMON_ABBREVIATIONS, isAmbiguousName, isPoorName, isValidIdentifier, splitWords } from './words.js';
import type { NamingAdvice } from '../ai/advisor.js';

export interface NamingContext {
  vocabulary: Vocabulary;
  convention: NamingConvention;
  weights: NamingWeights;
  thresholds: Thresholds;
}

export type ConfidenceClass = 'auto' | 'recommended' | 'candidate' | 'none';

export function classifyConfidence(confidence: number, t: Thresholds): ConfidenceClass {
  if (confidence >= t.autoApply) return 'auto';
  if (confidence >= t.recommend) return 'recommended';
  if (confidence >= t.suggest) return 'candidate';
  return 'none';
}

export function namingContextFrom(config: Config, vocabulary: Vocabulary, convention: NamingConvention): NamingContext {
  return { vocabulary, convention, weights: config.namingWeights, thresholds: config.thresholds };
}

function initialsMatch(current: string, head: string[]): boolean {
  const c = current.toLowerCase();
  if (c.length > 3 || head.length === 0) return false;
  const w = head.join('');
  return /^[a-z]+$/.test(c) && (w.startsWith(c) || head.map((x) => x[0]).join('') === c || head[head.length - 1].startsWith(c));
}

interface Scored {
  name: string;
  score: number;
  evidence: string[];
  reasons: Evidence[];
  spec: NameSpec;
}

/**
 * Candidate generation + scoring for one subject. Pure and deterministic:
 * the same facts always produce the same ranked list.
 */
export function proposeNames(subject: NamingSubject, ctx: NamingContext): NameCandidate[] {
  const specs = generateSpecs(subject);
  const byName = new Map<string, Scored>();
  const w = ctx.weights;

  for (const spec of specs) {
    const styles: ('convention' | 'plural')[] = ctx.convention.collection.startsWith('suffix-') && spec.plural ? ['convention', 'plural'] : ['convention'];
    for (const style of styles) {
      const { name, followsConvention } = renderSpec(spec, ctx.convention, style);
      if (!name || name === subject.name) continue;
      const ev: Evidence[] = [...spec.evidence];
      if (followsConvention && ctx.convention.collectionStrength >= 0.55) {
        ev.push({ key: 'conventionMatch', note: `project convention (${ctx.convention.collection})` });
      }
      const words = splitWords(name);
      if (words.some((x) => ctx.vocabulary.has(x))) {
        ev.push({ key: 'vocabularyMatch', note: 'uses project vocabulary' });
      }
      if (isPoorName(subject.name) && !ev.some((x) => x.key === 'nameHint')) {
        ev.push({ key: 'poorName', note: `"${subject.name}" says nothing about the value` });
      }
      if (initialsMatch(subject.name, spec.head)) {
        ev.push({ key: 'nameHint', note: `"${subject.name}" abbreviates "${spec.head.join(' ')}"` });
      }
      const prior = byName.get(name);
      const scored = scoreEvidence(ev, w);
      if (!prior || scored.score > prior.score) {
        byName.set(name, { name, score: scored.score, evidence: scored.notes, reasons: ev, spec });
      }
    }
  }

  // Abbreviation expansion: stnList -> stationList
  for (const cand of expandAbbreviations(subject, ctx)) {
    const prior = byName.get(cand.name);
    if (!prior || cand.score > prior.score) byName.set(cand.name, cand);
  }

  const out: NameCandidate[] = [];
  for (const s of byName.values()) {
    let score = s.score;
    const notes = [...s.evidence];
    let usable = true;
    let rejectedReason: string | undefined;

    if (!isValidIdentifier(s.name)) {
      usable = false;
      rejectedReason = 'not a valid identifier';
    }
    if (isAmbiguousName(s.name)) {
      score += w.ambiguousName;
      notes.push(`ambiguous name (${w.ambiguousName})`);
    }
    if (subject.takenNames.has(s.name)) {
      score += w.collision;
      notes.push(`collides with an existing identifier (${w.collision})`);
      usable = false;
      rejectedReason = 'collides with an existing identifier';
    }
    const roleType = valueTypeFromRole(s.spec.role);
    if (subject.kind !== 'function' && roleType && subject.valueType !== 'unknown' && roleType !== subject.valueType && !(roleType === 'element' && subject.valueType === 'object')) {
      score += w.contextMismatch;
      notes.push(`name implies ${roleType} but value is ${subject.valueType} (${w.contextMismatch})`);
    }
    if (s.name.length > 40) {
      usable = false;
      rejectedReason = 'too long';
    }
    score = Math.max(0, Math.min(100, score));
    out.push({ name: s.name, score, confidence: score / 100, evidence: notes, usable, rejectedReason });
  }
  return out.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1)).slice(0, 8);
}

function scoreEvidence(ev: Evidence[], w: NamingWeights): { score: number; notes: string[] } {
  const seen = new Set<string>();
  let score = 0;
  const notes: string[] = [];
  for (const e of ev) {
    if (seen.has(e.key)) continue; // each kind of evidence counts once
    seen.add(e.key);
    score += w[e.key];
    notes.push(`${e.key} +${w[e.key]}: ${e.note}`);
  }
  return { score, notes };
}

function expandAbbreviations(subject: NamingSubject, ctx: NamingContext): Scored[] {
  const words = splitWords(subject.name);
  const out: Scored[] = [];
  if (!words.length) return out;
  const hints = new Map<string, { abbreviation: string; expansion: string }>();
  for (const [abbr, expansion] of Object.entries(COMMON_ABBREVIATIONS)) if (words.includes(abbr)) hints.set(abbr, { abbreviation: abbr, expansion });
  // the project's own spelling wins over the generic dictionary
  for (const a of ctx.vocabulary.abbreviations) hints.set(a.abbreviation, a);
  let changed = false;
  const expanded = words.map((wd) => {
    const h = hints.get(wd);
    if (h) {
      changed = true;
      return h.expansion;
    }
    return wd;
  });
  if (!changed) return out;
  const casing = /_/.test(subject.name) ? 'snake' : 'camel';
  const name = casing === 'snake' ? expanded.join('_') : expanded[0] + expanded.slice(1).map((x) => x[0].toUpperCase() + x.slice(1)).join('');
  const ev: Evidence[] = [
    { key: 'abbreviation', note: 'expands an abbreviation used in this project' },
    { key: 'vocabularyMatch', note: 'expansion is project vocabulary' },
    { key: 'nameHint', note: 'keeps the original wording' },
  ];
  if (subject.valueType !== 'unknown') ev.push({ key: 'typeMatch', note: 'name keeps its role' });
  const sc = scoreEvidence(ev, ctx.weights);
  out.push({ name, score: sc.score, evidence: sc.notes, reasons: ev, spec: { pre: [], head: expanded, post: [], plural: false, role: 'scalar', evidence: ev } });
  return out;
}

/** Optional AI nudge. The AI can only choose among usable local candidates; it never invents a name. */
export function applyAdvice(
  candidates: NameCandidate[],
  advice: { choice: string | null; rationale?: string } | null,
  t: Thresholds,
): NameCandidate[] {
  if (!advice) return candidates;
  const out = candidates.map((c) => ({ ...c, evidence: [...c.evidence] }));
  if (advice.choice === null) {
    // Veto: nothing may be auto-applied on the strength of local analysis alone.
    for (const c of out) {
      if (c.score / 100 >= t.recommend) {
        c.score = Math.max(0, Math.round((t.recommend - 0.01) * 100));
        c.confidence = c.score / 100;
        c.evidence.push('AI advisor: no candidate is clearly right (capped below recommend)');
      }
    }
  } else {
    const chosen = out.find((c) => c.name === advice.choice);
    if (chosen && chosen.usable && chosen.confidence >= t.suggest) {
      chosen.score = Math.min(100, chosen.score + 5);
      chosen.confidence = chosen.score / 100;
      chosen.evidence.push(`AI advisor agrees (+5)${advice.rationale ? ': ' + advice.rationale : ''}`);
      chosen.ai = true;
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
}

/**
 * Turns a model-proposed name into a candidate, after the same local checks every candidate gets.
 * Its confidence is capped just above "recommended", so SAFE mode never applies it and
 * CAUTIOUS / AGGRESSIVE modes only apply it when no better, locally justified candidate exists.
 */
export function withProposal(candidates: NameCandidate[], advice: NamingAdvice | null, subject: NamingSubject, t: Thresholds, w: NamingWeights): NameCandidate[] {
  const name = advice?.proposal;
  if (!name || name === subject.name || candidates.some((c) => c.name === name)) return candidates;
  const evidence = [`AI proposal${advice?.rationale ? ': ' + advice.rationale : ''}`, 'passed local checks (valid identifier, no collision)'];
  let usable = isValidIdentifier(name);
  let rejectedReason: string | undefined = usable ? undefined : 'not a valid identifier';
  if (subject.takenNames.has(name)) {
    usable = false;
    rejectedReason = 'collides with an existing identifier';
  }
  if (isAmbiguousName(name)) {
    usable = false;
    rejectedReason = 'ambiguous name';
  }
  const score = Math.min(Math.round(t.recommend * 100) + 2, Math.round(t.autoApply * 100) - 1);
  void w;
  const cand: NameCandidate = { name, score, confidence: score / 100, evidence, usable, rejectedReason, ai: true };
  return [...candidates, cand].sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
}
