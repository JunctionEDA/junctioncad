// expr.ts — what may be typed into a dimension: a number, or simple arithmetic with units.
//
//   40          12.5 mm       1.5 in        3/8 in + 2 mm       (10 + 5) * 2        2^3       sqrt(2) * 10
//   45          45 deg        pi/4 rad      90 deg / 4
//
// A length comes out in millimetres and an angle in degrees, which is what the sketch stores.  A bare number
// takes the unit of the dimension it is typed into.  Units: mm, cm, m, in (or "), ft (or '), thou/mil; deg (or °),
// rad.  Functions: sqrt, abs, sin, cos, tan (of degrees).  The constant pi.  Pure; no variables yet.
export type Quantity = "length" | "angle";

export interface Parsed { value: number; /** true when the text was more than a plain number */ isExpression: boolean }

const LENGTH: { [unit: string]: number } = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8, "'": 304.8, thou: 0.0254, mil: 0.0254, um: 0.001 };
const ANGLE: { [unit: string]: number } = { deg: 1, "°": 1, rad: 180 / Math.PI };
const FUNCS: { [name: string]: (v: number) => number } = {
  sqrt: Math.sqrt, abs: Math.abs,
  sin: (v) => Math.sin((v * Math.PI) / 180), cos: (v) => Math.cos((v * Math.PI) / 180), tan: (v) => Math.tan((v * Math.PI) / 180),
};

/** A value with the power of its dimension: 0 a plain number, 1 a length or an angle (in its base unit). */
interface Val { v: number; dim: 0 | 1 }

class Parser {
  private i = 0;
  constructor(private readonly s: string, private readonly units: { [unit: string]: number }, private readonly factor = 1) {}

  parse(): Val {
    const v = this.sum();
    this.space();
    if (this.i < this.s.length) throw new Error(`Unexpected "${this.s.slice(this.i)}"`);
    return v;
  }
  private space(): void { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  private eat(ch: string): boolean { this.space(); if (this.s.startsWith(ch, this.i)) { this.i += ch.length; return true; } return false; }

  private sum(): Val {
    let a = this.product();
    for (;;) {
      const plus = this.eat("+"), minus = !plus && this.eat("-");
      if (!plus && !minus) return a;
      const b = this.product();
      // "10 + 5 mm": a bare number beside a quantity is in the unit of the place it was typed (`factor`)
      const av = a.dim || !b.dim ? a.v : a.v * this.factor, bv = b.dim || !a.dim ? b.v : b.v * this.factor;
      a = { v: plus ? av + bv : av - bv, dim: a.dim || b.dim ? 1 : 0 };
    }
  }
  private product(): Val {
    // a unit follows a whole product, so "3/8 in" is three eighths of an inch
    let a = this.withUnit(this.power());
    for (;;) {
      const times = this.eat("*"), over = !times && this.eat("/");
      if (!times && !over) return a;
      const b = this.power();
      if (!a.dim && !b.dim) { a = this.withUnit({ v: times ? a.v * b.v : a.v / b.v, dim: 0 }); continue; }
      if (times && a.dim && b.dim) throw new Error("A length times a length is not a length");
      if (over && b.dim && !a.dim) throw new Error("A number over a length is not a length");
      if (over && b.v === 0) throw new Error("Division by zero");
      a = { v: times ? a.v * b.v : a.v / b.v, dim: times ? ((a.dim || b.dim) as 0 | 1) : a.dim && b.dim ? 0 : a.dim };
    }
  }
  private power(): Val {
    const a = this.unary();
    if (!this.eat("^")) return a;
    const b = this.unary();
    if (a.dim || b.dim) throw new Error("A power takes plain numbers");
    return { v: Math.pow(a.v, b.v), dim: 0 };
  }
  private unary(): Val {
    if (this.eat("-")) { const a = this.unary(); return { v: -a.v, dim: a.dim }; }
    if (this.eat("+")) return this.unary();
    return this.atom();
  }
  private atom(): Val {
    this.space();
    if (this.eat("(")) { const v = this.sum(); if (!this.eat(")")) throw new Error("Missing )"); return v; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(this.s.slice(this.i));
    if (num) { this.i += num[0].length; return { v: parseFloat(num[0]), dim: 0 }; }
    const word = /^[a-z]+/i.exec(this.s.slice(this.i));
    if (word) {
      const name = word[0].toLowerCase();
      if (name === "pi") { this.i += 2; return { v: Math.PI, dim: 0 }; }
      if (FUNCS[name]) {
        this.i += name.length;
        if (!this.eat("(")) throw new Error(`${name} needs (…)`);
        const v = this.sum(); if (!this.eat(")")) throw new Error("Missing )");
        return { v: FUNCS[name](v.v), dim: name === "sqrt" || name === "abs" ? v.dim : 0 };
      }
      throw new Error(`"${word[0]}" is not something this understands`);
    }
    throw new Error(this.i >= this.s.length ? "Type a value" : `Unexpected "${this.s[this.i]}"`);
  }
  private withUnit(a: Val): Val {
    this.space();
    const rest = this.s.slice(this.i).toLowerCase();
    // longest unit first, and a unit must not run into a following word ("m" is not the start of "mm")
    for (const u of Object.keys(this.units).sort((p, q) => q.length - p.length)) {
      if (!rest.startsWith(u)) continue;
      if (/[a-z]/.test(u) && /[a-z]/.test(rest[u.length] || "")) continue;
      if (a.dim) return a;
      this.i += u.length;
      return { v: a.v * this.units[u], dim: 1 };
    }
    return a;
  }
}

/**
 * Evaluate what was typed, in millimetres (length) or degrees (angle).  Throws an Error a person can read.
 * `factor` is what a bare number is worth: 1 (millimetres, degrees) unless the document is worked in another
 * unit (25.4 for inches; document/units.ts).
 */
export function evaluate(text: string, quantity: Quantity, factor = 1): Parsed {
  const s = text.trim().replace(/,/g, ".").replace(/×/g, "*").replace(/÷/g, "/");
  if (!s) throw new Error("Type a value");
  const r = new Parser(s, quantity === "length" ? LENGTH : ANGLE, factor).parse();
  if (!r.dim) r.v *= factor;
  if (!Number.isFinite(r.v)) throw new Error("That does not come to a number");
  return { value: Math.round(r.v * 1e9) / 1e9, isExpression: !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) };
}

/** `evaluate`, or null instead of an error. */
export function tryEvaluate(text: string, quantity: Quantity, factor = 1): Parsed | null {
  try { return evaluate(text, quantity, factor); } catch { return null; }
}
