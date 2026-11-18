// components/msgbox.ts — KIDIALOG / IsOK for every bundle (the React chrome, the GitHub panel, the plug-in manager):
// a themed message over the page with its buttons, never the browser's native confirm().  The overlay and dialog
// classes are theme.css's (.kd-overlay, .kd-dialog), so it needs no editor module.

function trapTab(ev: KeyboardEvent, root: HTMLElement): void {
  const f = Array.from(root.querySelectorAll<HTMLElement>("button,input,select,textarea,[tabindex]:not([tabindex='-1'])")).filter((e) => !(e as HTMLButtonElement).disabled);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement as HTMLElement);
  const next = ev.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i >= f.length - 1 ? 0 : i + 1);
  ev.preventDefault(); f[next].focus();
}

/**
 * A question with a Cancel and an OK button (KIDIALOG::DoNotShowCheckbox-less, SetOKCancelLabels): resolves true
 * for OK.  `danger` draws the OK button as a destructive action.  Escape is Cancel, Enter is OK.
 */
export function askConfirm(title: string, message: string, opts: { ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") { resolve(false); return; }
    const ov = document.createElement("div"); ov.className = "kd-overlay"; ov.style.zIndex = "10050"; ov.dataset.k = "confirm";
    const dlg = document.createElement("div"); dlg.className = "kd-dialog"; dlg.setAttribute("role", "alertdialog"); dlg.setAttribute("aria-label", title);
    dlg.style.cssText = "width:max-content;min-width:400px;max-width:min(600px, calc(100vw - 32px))";
    const head = document.createElement("div"); head.className = "kd-title"; const t = document.createElement("span"); t.textContent = title; head.append(t);
    const body = document.createElement("div"); body.className = "kd-body";
    const p = document.createElement("p"); p.style.cssText = "margin:4px 0 6px;white-space:pre-wrap"; p.textContent = message; body.append(p);
    const foot = document.createElement("div"); foot.className = "kd-foot";
    const spacer = document.createElement("span"); spacer.className = "spacer";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = opts.cancel || "Cancel"; cancel.dataset.k = "confirm-cancel";
    const ok = document.createElement("button"); ok.type = "button"; ok.className = opts.danger ? "btn danger solid" : "btn primary"; ok.textContent = opts.ok || "OK"; ok.dataset.k = "confirm-ok";
    foot.append(spacer, cancel, ok);
    dlg.append(head, body, foot); ov.append(dlg);
    const done = (v: boolean): void => { ov.remove(); resolve(v); };
    cancel.addEventListener("click", () => done(false)); ok.addEventListener("click", () => done(true));
    ov.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Tab") trapTab(ev, ov);
      else if (ev.key === "Escape") { ev.preventDefault(); done(false); }
      else if (ev.key === "Enter" && !(ev.target instanceof HTMLButtonElement)) { ev.preventDefault(); done(true); }
    });
    document.body.append(ov); ok.focus();
  });
}
