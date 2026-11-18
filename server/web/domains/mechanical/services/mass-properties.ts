// mass-properties.ts — volume, surface area, mass, centre of mass, moments of inertia and bounding box of bodies,
// exact from the B-rep.
//
//   await kernel.call("mass-properties", { body: "<body id>" })                       one body, unit density
//   await kernel.call("mass-properties", { bodies: [ids] | null, density: { [id]: g/cm³ } })
//   → { body?, volume, area, centre, …one body…, parts: MassBody[], total: MassTotal }
//
// Density is in g/cm³ (water 1, steel 7.85).  A body with no density has a volume, an area and a centre but no
// mass or inertia; the total has a mass only when every body has one.  Inertia is about the centre of mass along
// the model axes, in kg·mm² (see _mass-math.ts for the sign of the products).
import type { Json } from "../../../shared/itemdoc/itemdoc";
import type { Vec3 } from "../core/geometry";
import { defineService } from "../kernel/service";
import { KG_PER_MM3, combine, principal, scaleTensor, tensorFromAxisMoments, unionBox, type MassPart, type Tensor } from "./_mass-math";
import { Bin, boxOf } from "./_measure-kernel";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MassBody {
  id: string; name: string;
  /** mm³, mm² */
  volume: number; area: number;
  centre: Vec3;
  bbox: number[];
  /** g/cm³, or null when the body has no material */
  density: number | null;
  /** kg */
  mass: number | null;
  /** about the centre of mass, kg·mm² */
  inertia: Tensor | null;
}
export interface MassTotal {
  count: number; volume: number; area: number;
  /** mass-weighted when every body has a density, else volume-weighted */
  centre: Vec3;
  bbox: number[] | null;
  mass: number | null;
  inertia: Tensor | null;
  principal: { moments: Vec3; axes: [Vec3, Vec3, Vec3] } | null;
}

export default defineService({
  name: "mass-properties",
  run(ctx, args) {
    const a = (args || {}) as { body?: string; bodies?: string[] | null; density?: { [id: string]: number } };
    const oc = ctx.oc as any, k = ctx.k;
    const wanted = a.body ? [a.body] : a.bodies && a.bodies.length ? a.bodies : null;
    const bodies = wanted ? ctx.state.bodies.filter((b) => wanted.includes(b.id)) : ctx.state.bodies.slice();
    if (a.body && !bodies.length) throw ctx.fail("That body no longer exists.");
    const parts: MassBody[] = [];
    for (const body of bodies) {
      const bin = new Bin();
      try {
        const g = bin.add(new oc.GProp_GProps());
        oc.BRepGProp.VolumeProperties(body.shape, g, true, false, false);
        const volume = g.Mass();
        const c = bin.add(g.CentreOfMass()), centre: Vec3 = [c.X(), c.Y(), c.Z()];
        const s = bin.add(new oc.GProp_GProps());
        oc.BRepGProp.SurfaceProperties(body.shape, s, false, false);
        // moments about six axes through the centre give the whole tensor (gp_Mat is not in this kernel build)
        const r = Math.SQRT1_2;
        const about = (d: Vec3) => g.MomentOfInertia(bin.add(new oc.gp_Ax1(c, bin.add(new oc.gp_Dir(d[0], d[1], d[2])))));
        const perVolume = tensorFromAxisMoments({ x: about([1, 0, 0]), y: about([0, 1, 0]), z: about([0, 0, 1]), xy: about([r, r, 0]), xz: about([r, 0, r]), yz: about([0, r, r]) });
        const rho = a.density && typeof a.density[body.id] === "number" && a.density[body.id] > 0 ? a.density[body.id] : null;
        parts.push({
          id: body.id, name: body.name, volume, area: s.Mass(), centre, bbox: boxOf(k, body.shape), density: rho,
          mass: rho === null ? null : volume * rho * KG_PER_MM3,
          inertia: rho === null ? null : scaleTensor(perVolume, rho * KG_PER_MM3),
        });
      } finally { bin.empty(); }
    }
    const total = totalOf(parts);
    const one = parts.length === 1 ? { body: parts[0].id, volume: parts[0].volume, area: parts[0].area, centre: parts[0].centre } : {};
    return { ...one, parts, total } as unknown as Json;
  },
});

/** The bodies as one: sums, the common centre, inertia about it and its principal moments. */
export function totalOf(parts: readonly MassBody[]): MassTotal {
  const volume = parts.reduce((s, p) => s + p.volume, 0), area = parts.reduce((s, p) => s + p.area, 0);
  const bbox = unionBox(parts.map((p) => p.bbox));
  const allMass = parts.length > 0 && parts.every((p) => p.mass !== null && p.inertia !== null);
  if (allMass) {
    const c = combine(parts.map((p): MassPart => ({ mass: p.mass!, centre: p.centre, inertia: p.inertia! })));
    return { count: parts.length, volume, area, centre: c.centre, bbox, mass: c.mass, inertia: c.inertia, principal: principal(c.inertia) };
  }
  const centre: Vec3 = [0, 0, 0];
  if (volume > 0) for (const p of parts) for (let i = 0; i < 3; i++) centre[i] += (p.centre[i] * p.volume) / volume;
  return { count: parts.length, volume, area, centre, bbox, mass: null, inertia: null, principal: null };
}
