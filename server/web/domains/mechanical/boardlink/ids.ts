// ids.ts — the ids of the board items a link drives.
//
// A driven item's id is a function of the link, the drive and the item's place in it, so every browser that
// reconciles a board writes the same items (two people with the board open do not make two outlines), and an
// item is recognisably driven by its id alone: all of them start with DRIVEN_PREFIX ("junc" in ASCII).
export const DRIVEN_PREFIX = "6a756e63-";

/** 32-bit string hash (cyrb-style mixing), seeded. */
function hash32(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}
const hex = (n: number, len: number): string => (n >>> 0).toString(16).padStart(8, "0").slice(0, len);

/** The id of the `n`th item of a role ("outline", "hole", "keepout", "group") of one drive of one link. */
export function drivenId(linkId: string, driveId: string, role: string, n = 0): string {
  const key = `${linkId}/${driveId}/${role}/${n}`;
  const a = hash32(key, 1), b = hash32(key, 2), c = hash32(key, 3), d = hash32(key, 4);
  return `${DRIVEN_PREFIX}${hex(a, 4)}-5${hex(b, 3)}-8${hex(c, 3)}-${hex(d, 8)}${hex(a ^ c, 4)}`;
}

export const isDrivenId = (id: string): boolean => typeof id === "string" && id.startsWith(DRIVEN_PREFIX);
