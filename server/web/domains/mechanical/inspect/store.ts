// store.ts — the small state holder the inspection controllers (measure, section, mass, appearance) share, and
// one controller of each kind per open part studio.
import { useSyncExternalStore } from "react";
import { toolsChanged } from "../core/tool";
import type { PartStudio } from "../ui/studio";

export class Store<S extends object> {
  private listeners = new Set<() => void>();
  constructor(protected state: S) {}
  getState = (): S => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  protected set(patch: Partial<S>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of Array.from(this.listeners)) fn();
    // the toolbar's pressed and greyed buttons read these stores
    toolsChanged();
  }
}

/** React: a slice of a store; re-renders when it changes (Object.is). */
export function useStore<S extends object, T>(store: Store<S>, selector: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

const made = new WeakMap<PartStudio, Map<string, unknown>>();
/** The one controller of a kind for a studio, made on first use. */
export function perStudio<T>(studio: PartStudio, kind: string, make: (s: PartStudio) => T): T {
  let m = made.get(studio);
  if (!m) { m = new Map(); made.set(studio, m); }
  if (!m.has(kind)) m.set(kind, make(studio));
  return m.get(kind) as T;
}
