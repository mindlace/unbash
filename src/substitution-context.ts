import type { PartsResolver } from "./word.ts";

export interface SubstitutionContext {
  boundaries: Map<number, number> | undefined;
  wordParts: PartsResolver | undefined;
  embeddedParts: PartsResolver | undefined;
  arrayParts: PartsResolver | undefined;
}

// A nested script shares its parent's boundary cache, allocated on first use.
export function createSubstitutionContext(parent?: SubstitutionContext): SubstitutionContext {
  const boundaries = parent === undefined ? undefined : substitutionBoundaries(parent);
  return { boundaries, wordParts: undefined, embeddedParts: undefined, arrayParts: undefined };
}

export function substitutionBoundaries(context: SubstitutionContext): Map<number, number> {
  return context.boundaries ?? (context.boundaries = new Map());
}
