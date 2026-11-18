// _dialog.tsx — a modal dialog for the part studio's file tools (Export), in the same frame as the electronics
// editor's export dialogs: the KiCad dialog shell (static/kicad-dialogs.js, `window.KDialogs`), with a title bar
// that drags, Escape to cancel, and the footer's buttons.  The body is React.  Without the shell (a test page)
// a plain overlay with the same class names stands in.
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

interface KApi { body: HTMLElement; close(): void; dlg: HTMLElement; foot: HTMLElement }
interface KDialogsShell { open(spec: { title: string; width?: number; okLabel?: string; cancelLabel?: string; persist?: boolean; build(body: HTMLElement, api: KApi): void; ok?(): boolean | void; cancel?(): boolean | void }): KApi }

export interface DialogHandle {
  close(): void;
  /** the OK button, to disable while something runs */
  okButton: HTMLButtonElement | null;
  /** the body's React root re-rendered */
  render(node: ReactNode): void;
}

export function openDialog(o: { title: string; width?: number; okLabel?: string; render(h: DialogHandle): ReactNode; ok(h: DialogHandle): void; onClose?(): void }): DialogHandle {
  let root: Root | null = null, closed = false;
  const handle: DialogHandle = {
    close() { if (closed) return; closed = true; const r = root; root = null; setTimeout(() => r?.unmount(), 0); api?.close(); o.onClose?.(); },
    okButton: null,
    render(node) { if (root) root.render(node); },
  };
  const shell = (window as unknown as { KDialogs?: KDialogsShell }).KDialogs;
  let api: KApi | null = null;
  const build = (body: HTMLElement) => { root = createRoot(body); flushSync(() => root!.render(o.render(handle))); };
  if (shell) {
    api = shell.open({
      title: o.title, width: o.width, okLabel: o.okLabel,
      build(body) { build(body); },
      ok() { o.ok(handle); return false; },   // the tool closes the dialog itself, when it has finished
      cancel() { if (!closed) { closed = true; const r = root; root = null; setTimeout(() => r?.unmount(), 0); o.onClose?.(); } },
    });
    const buttons = Array.from(api.foot.querySelectorAll<HTMLButtonElement>("button"));
    handle.okButton = buttons.length ? buttons[buttons.length - 1] : null;
    return handle;
  }
  // no shell on this page: the same structure, drawn here
  const ov = document.createElement("div");
  ov.className = "kd-overlay fixed inset-0 z-[60] grid place-items-center bg-black/30";
  ov.innerHTML = `<div class="kd-dialog rounded-md border border-line bg-bench shadow-panel text-sm" style="width:${o.width || 480}px;max-width:96vw"><div class="kd-title px-3 h-8 flex items-center font-semibold border-b border-line"><span></span></div><div class="kd-body p-3"></div><div class="kd-foot flex justify-end gap-1.5 p-2 border-t border-line"><button type="button" class="btn">Cancel</button><button type="button" class="btn primary"></button></div></div>`;
  ov.querySelector(".kd-title span")!.textContent = o.title;
  const [cancel, ok] = Array.from(ov.querySelectorAll<HTMLButtonElement>(".kd-foot button"));
  ok.textContent = o.okLabel || "OK";
  handle.okButton = ok;
  api = { body: ov.querySelector(".kd-body") as HTMLElement, dlg: ov.firstElementChild as HTMLElement, foot: ov.querySelector(".kd-foot") as HTMLElement, close: () => ov.remove() };
  cancel.onclick = () => handle.close();
  ok.onclick = () => o.ok(handle);
  ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Escape") handle.close(); });
  document.body.append(ov);
  build(api.body);
  return handle;
}

/** Hand a file to the browser's downloads. */
export function download(data: Uint8Array | string, name: string, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
