// store.ts — a React binding for the small stores of the collaboration layer (anything with getState and
// subscribe).  On its own, with nothing of the part studio behind it, so another editor's bundle can use the
// presence parts (attach.tsx) without carrying the part studio.
import { useSyncExternalStore } from "react";

interface Store<S> { getState(): S; subscribe(fn: () => void): () => void }
const NOTHING = () => () => {};

/** Select a slice of a store (the selector must return the same reference while nothing it reads changed). */
export function useStore<S, T>(store: Store<S> | null | undefined, selector: (s: S) => T, empty: T): T {
  return useSyncExternalStore(store ? store.subscribe : NOTHING, () => (store ? selector(store.getState()) : empty));
}
