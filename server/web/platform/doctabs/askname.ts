// askname.ts — a one-field dialog that asks for a name (a new folder, a new name for a PCB), drawn like the
// app's other small dialogs (shared/components/msgbox.ts).  Resolves the trimmed name, or null on Cancel.
export function askName(title: string, o: { label?: string; value?: string; ok?: string; check?: (name: string) => string | null } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") { resolve(null); return; }
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); e.className = cls; return e; };
    const ov = el("div", "kd-overlay"); ov.style.zIndex = "10050"; ov.dataset.k = "ask-name";
    const dlg = el("div", "kd-dialog"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-label", title); dlg.style.cssText = "width:min(420px, calc(100vw - 32px))";
    const head = el("div", "kd-title"); const t = document.createElement("span"); t.textContent = title; head.append(t);
    const body = el("div", "kd-body");
    const label = document.createElement("label"); label.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:4px 0 2px";
    const cap = document.createElement("span"); cap.textContent = o.label || "Name";
    const input = el("input", "input"); input.type = "text"; input.value = o.value || ""; input.maxLength = 80; input.setAttribute("aria-label", o.label || "Name"); input.dataset.k = "ask-name-input";
    const err = el("div", "note"); err.style.cssText = "color:var(--err);min-height:16px"; err.setAttribute("role", "alert");
    label.append(cap, input); body.append(label, err);
    const foot = el("div", "kd-foot"); const spacer = el("span", "spacer");
    const cancel = el("button", "btn"); cancel.type = "button"; cancel.textContent = "Cancel";
    const ok = el("button", "btn primary"); ok.type = "button"; ok.textContent = o.ok || "OK"; ok.dataset.k = "ask-name-ok";
    foot.append(spacer, cancel, ok); dlg.append(head, body, foot); ov.append(dlg);
    const done = (v: string | null): void => { ov.remove(); resolve(v); };
    const submit = (): void => {
      const name = input.value.trim().replace(/\s+/g, " ");
      const bad = !name ? "It needs a name." : o.check ? o.check(name) : null;
      if (bad) { err.textContent = bad; input.classList.add("bad"); input.focus(); return; }
      done(name);
    };
    cancel.addEventListener("click", () => done(null)); ok.addEventListener("click", submit);
    input.addEventListener("input", () => { err.textContent = ""; input.classList.remove("bad"); });
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Escape") { ev.preventDefault(); done(null); } else if (ev.key === "Enter") { ev.preventDefault(); submit(); } });
    ov.addEventListener("mousedown", (ev) => { if (ev.target === ov) done(null); });
    document.body.append(ov); input.focus(); input.select();
  });
}
