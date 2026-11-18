// exchange-files.ts — the bytes of a file stored with the project, for a feature that reads one (Import).
//
// An imported file is an ordinary document of the project (a `model3d` document for .step/.stp, the same kind
// the electronics editor's footprint models are), so it is shared, archived, cloned and synced with the rest of
// the project.  The worker fetches it from GET /api/docs/{id}/content with the page's own cookies.
//
// Tests (and anything else without a server) set `globalThis.__junctionProjectFile = async (file) => bytes`.
import { FeatureError } from "../types";

export interface ProjectFileRef { docId: string; path: string; name?: string; bytes?: number }

type Hook = (file: ProjectFileRef) => Promise<Uint8Array | null> | Uint8Array | null;

export async function projectFileBytes(file: ProjectFileRef): Promise<Uint8Array> {
  const hook = (globalThis as { __junctionProjectFile?: Hook }).__junctionProjectFile;
  if (hook) { const got = await hook(file); if (got) return got; }
  const name = file.name || file.path;
  if (typeof fetch !== "function") throw new FeatureError(`“${name}” cannot be read here.`);
  let r: Response;
  try { r = await fetch(`/api/docs/${encodeURIComponent(file.docId)}/content`, { credentials: "same-origin" }); }
  catch (e) { throw new FeatureError(`“${name}” could not be downloaded. Check the connection and rebuild.`); }
  if (r.status === 404) throw new FeatureError(`“${name}” is no longer in this project. Import the file again.`);
  if (r.status === 401 || r.status === 403) throw new FeatureError(`You cannot read “${name}”.`);
  if (!r.ok) throw new FeatureError(`“${name}” could not be downloaded (${r.status}).`);
  return new Uint8Array(await r.arrayBuffer());
}
