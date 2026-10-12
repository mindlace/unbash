import type { HereDocBody, WordPart } from "./internal-types.ts";
import type { SubstitutionContext } from "./substitution-context.ts";

export class HereDocBodyImpl implements HereDocBody {
  static _resolveParts: (
    source: string,
    body: HereDocBody,
    depth: number,
    context?: SubstitutionContext,
  ) => WordPart[] | undefined;

  type = "HereDocBody" as const;
  pos: number;
  end: number;
  text = "";
  #source: string;
  #depth: number;
  #context: SubstitutionContext | undefined;
  #parts: WordPart[] | undefined | null;

  constructor(source: string, pos: number, quoted: boolean, depth: number, context?: SubstitutionContext) {
    this.pos = pos;
    this.end = pos;
    this.#source = source;
    this.#depth = depth;
    this.#context = context;
    this.#parts = quoted ? undefined : null;
  }

  get parts(): WordPart[] | undefined {
    if (this.#parts === null)
      this.#parts = HereDocBodyImpl._resolveParts(this.#source, this, this.#depth, this.#context);
    return this.#parts;
  }

  toJSON() {
    return { type: this.type, pos: this.pos, end: this.end, text: this.text, parts: this.parts };
  }
}
