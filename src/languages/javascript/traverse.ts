import traverseModule from '@babel/traverse';
import type { NodePath, Scope, Binding, TraverseOptions } from '@babel/traverse';
import type { Node } from '@babel/types';

type TraverseFn = ((parent: Node, opts: TraverseOptions) => void) & { cache: { clear(): void } };
// @babel/traverse is CommonJS; under NodeNext the callable lives on `.default`.
const mod = traverseModule as unknown as { default?: TraverseFn } & TraverseFn;
export const traverse: TraverseFn = mod.default ?? mod;

export type { NodePath, Scope, Binding };
