// dialogs/maintenance.ts — Preferences > Common > Maintenance (common/dialogs/panel_maintenance.cpp) for the browser:
// what KiCad keeps in its settings files is this browser's localStorage, so "Reset All Dialogs to Defaults" forgets
// every dialog's remembered size and control state (DIALOG_SHIM's saved state), and "Reset All Program Settings to
// Defaults" (SETTINGS_MANAGER::ResetToDefaults) forgets every user setting the web editor keeps.  Nothing on the
// server — no design, project or account data — is touched.

/** DIALOG_SHIM's remembered geometry and control values: kicad-dialogs' kd.geom / kd.state, the props dialogs' pd.state. */
const DIALOG_PREFIXES = ["kd.geom.", "kd.state.", "pd.state."];
/** Every per-user program setting: the editor's (kui.*), the tools' (kc.*), the fabrication outputs' and the library choosers'. */
const SETTING_PREFIXES = ["kui.", "kc.", "kd.", "pd.", "kicad.", "kicad-collab:"];
/**
 * Kept by a program reset: browser state that is not a setting: which documents are boards (kui.boardDocs), the
 * onboarding guide's progress (kc.guide, onboarding/state.ts) and the home page editor's board (kc.onboard.*), and the
 * editor clipboard (kui.clipboard, editor/tools.ts), as KiCad's reset leaves the system clipboard alone.
 */
const KEEP = ["kui.boardDocs", "kc.guide", "kc.onboard.", "kui.clipboard"];
/**
 * KIDIALOG's "Do not show again" answers (COMMON_SETTINGS m_DoNotShowAgain): here the project plugin recommendations
 * a person waved away (plugins/host.ts LS_DISMISS).
 */
const DONT_SHOW_PREFIXES = ["kc.plugins.recommended.seen."];
/**
 * The file histories (SETTINGS_MANAGER::ClearFileHistory).  The web editor has no Open Recent menu (projects are listed
 * by the server); the histories this browser keeps are the board Find dialog's and the library choosers' recently used.
 */
const HISTORY_PREFIXES = ["kui.pcbFindHistory", "kicad-collab:lib-recent:"];

const hasPrefix = (prefixes: string[]) => (k: string): boolean => prefixes.some((p) => k.startsWith(p));
/** The stored "Don't show again" answers. */
export function dontShowAgainKeys(keys: string[]): string[] { return keys.filter(hasPrefix(DONT_SHOW_PREFIXES)); }
/** The stored histories. */
export function historyKeys(keys: string[]): string[] { return keys.filter(hasPrefix(HISTORY_PREFIXES)); }
/** The stored keys that are dialog state (doClearDialogState clears the "Don't show again" answers too). */
export function dialogStateKeys(keys: string[]): string[] { return keys.filter((k) => hasPrefix(DIALOG_PREFIXES)(k) || hasPrefix(DONT_SHOW_PREFIXES)(k)); }
/** The stored keys that are program settings, dialog state included. */
export function programSettingKeys(keys: string[]): string[] {
  return keys.filter((k) => SETTING_PREFIXES.some((p) => k.startsWith(p)) && !KEEP.some((p) => k === p || (p.endsWith(".") && k.startsWith(p))));
}

function storedKeys(): string[] {
  const out: string[] = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null) out.push(k); } } catch (e) { /* no storage */ }
  return out;
}
function removeKeys(keys: string[]): number { let n = 0; for (const k of keys) { try { localStorage.removeItem(k); n++; } catch (e) { /* no storage */ } } return n; }

/** PANEL_MAINTENANCE::onClearFileHistory: the number of entries removed. */
export function clearFileHistory(): number { return removeKeys(historyKeys(storedKeys())); }
/** PANEL_MAINTENANCE::doClearDontShowAgain: the number of entries removed. */
export function clearDontShowAgain(): number { return removeKeys(dontShowAgainKeys(storedKeys())); }
/** PANEL_MAINTENANCE::doClearDialogState: the number of entries removed. */
export function clearDialogState(): number { return removeKeys(dialogStateKeys(storedKeys())); }
/** PANEL_MAINTENANCE::onResetAll's settings half: the number of entries removed. */
export function resetProgramSettings(): number { return removeKeys(programSettingKeys(storedKeys())); }
