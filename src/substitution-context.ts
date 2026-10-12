import type { PartsResolver } from "./word.ts";

export interface SubstitutionContext {
  boundaries: Map<number, number>;
  wordParts: PartsResolver | undefined;
  embeddedParts: PartsResolver | undefined;
  arrayParts: PartsResolver | undefined;
}
