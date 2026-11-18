// components/kdate.ts — a themed date picker: wxDatePickerCtrl (DIALOG_PAGES_SETTINGS' m_PickDate) as an entry
// holding the date plus a drop-down button that opens a month calendar, never the browser's own <input type=date>.
//
//   entry      the date as YYYY-MM-DD (wxDateTime::FormatISODate, which is how the dialog copies it into the title
//              block); a typed date is taken when it parses, otherwise the entry goes back to the last good date
//   calendar   wxGenericCalendarCtrl: the month and year over a Monday-first (ISO) week grid, the days of the
//              neighbouring months greyed, the picked day highlighted and today outlined
//   keyboard   Alt+Down / F4 in the entry open it; in the calendar the arrows move a day / a week, Page Up /
//              Page Down a month, Home / End the month's first / last day, Enter takes the day, Escape closes
// The popup is placed with menufit.ts like every other drop-down.
import { fitMenu } from "../menufit";

export interface KDate { el: HTMLElement; input: HTMLInputElement; get value(): string; set value(v: string); open(): void; close(): void; isOpen(): boolean }

const pad = (n: number): string => String(n).padStart(2, "0");
/** wxDateTime::FormatISODate of a local date. */
export function isoOf(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** wxDateTime::ParseISODate: YYYY-MM-DD with a real day of that month, else null. */
export function parseIso(s: string): Date | null {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(s); if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3], r = new Date(y, mo, d);
  return r.getFullYear() === y && r.getMonth() === mo && r.getDate() === d ? r : null;
}
/** The 6 x 7 day cells shown for a month, Monday first: each day with whether it belongs to the month. */
export function monthGrid(year: number, month: number): { date: Date; inMonth: boolean }[] {
  const first = new Date(year, month, 1), lead = (first.getDay() + 6) % 7;   // days before the 1st back to Monday
  const out: { date: Date; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) { const d = new Date(year, month, 1 - lead + i); out.push({ date: d, inMonth: d.getMonth() === month }); }
  return out;
}
/** A date moved by whole months, the day clamped to the target month's length (wxDateTime::Add(wxDateSpan)). */
export function addMonths(d: Date, n: number): Date {
  const y = d.getFullYear(), m = d.getMonth() + n, last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(d.getDate(), last));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CARET = '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1 2.5h6L4 6z" fill="currentColor"/></svg>';
const CHEV = (left: boolean): string => `<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="${left ? "M5.5 1L2.5 4l3 3" : "M2.5 1l3 3-3 3"}" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
let seq = 0;

/** A date picker holding `value` (YYYY-MM-DD; today when empty or unreadable). `onChange` runs when the date changes. */
export function datePicker(value: string, opts: { id?: string; disabled?: boolean; onChange?: (v: string) => void } = {}): KDate {
  let cur = parseIso(value) || new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  let pop: HTMLElement | null = null, shown = cur, focus = cur, undo: (() => void)[] = [];
  const input = document.createElement("input"); input.type = "text"; input.className = "input kdate-entry"; input.value = isoOf(cur);
  input.autocomplete = "off"; input.spellcheck = false; if (opts.id) input.id = opts.id; input.disabled = !!opts.disabled;
  input.setAttribute("role", "combobox"); input.setAttribute("aria-haspopup", "dialog"); input.setAttribute("aria-expanded", "false");
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn kcombo-btn kdate-btn"; btn.tabIndex = -1; btn.innerHTML = CARET; btn.disabled = !!opts.disabled;
  btn.setAttribute("aria-label", "Show the calendar");
  const el = document.createElement("span"); el.className = "kdate"; el.append(input, btn);
  const set = (d: Date, notify = true): void => {
    const changed = isoOf(d) !== isoOf(cur); cur = d; input.value = isoOf(d);
    if (changed && notify && opts.onChange) opts.onChange(input.value);
  };
  input.addEventListener("change", () => { const d = parseIso(input.value); if (d) set(d); else input.value = isoOf(cur); });

  const render = (): void => {
    if (!pop) return;
    const head = pop.querySelector(".kdate-title") as HTMLElement; head.textContent = `${MONTHS[shown.getMonth()]} ${shown.getFullYear()}`;
    const grid = pop.querySelector(".kdate-grid") as HTMLElement, today = isoOf(new Date());
    grid.replaceChildren(...DAYS.map((d) => { const c = document.createElement("div"); c.className = "kdate-dow"; c.textContent = d; return c; }),
      ...monthGrid(shown.getFullYear(), shown.getMonth()).map(({ date, inMonth }) => {
        const c = document.createElement("div"), iso = isoOf(date);
        c.className = "kdate-day" + (inMonth ? "" : " out") + (iso === isoOf(cur) ? " on" : "") + (iso === isoOf(focus) ? " hi" : "") + (iso === today ? " today" : "");
        c.textContent = String(date.getDate()); c.dataset.date = iso; c.setAttribute("role", "gridcell");
        if (iso === isoOf(cur)) c.setAttribute("aria-selected", "true");
        return c;
      }));
  };
  const moveTo = (d: Date): void => { focus = d; if (d.getMonth() !== shown.getMonth() || d.getFullYear() !== shown.getFullYear()) shown = new Date(d.getFullYear(), d.getMonth(), 1); render(); };
  function close(): void {
    if (!pop) return; pop.remove(); pop = null; for (const u of undo) u(); undo = [];
    el.removeAttribute("data-popup-open"); input.setAttribute("aria-expanded", "false");
  }
  function open(): void {
    if (pop || input.disabled) return;
    const typed = parseIso(input.value); if (typed) set(typed);
    shown = new Date(cur.getFullYear(), cur.getMonth(), 1); focus = cur;
    const p = document.createElement("div"); p.className = "ksel-pop kdate-pop"; p.id = "kdate-pop-" + ++seq; p.setAttribute("role", "dialog"); p.setAttribute("aria-label", "Calendar");
    const nav = (left: boolean, title: string): HTMLButtonElement => { const b = document.createElement("button"); b.type = "button"; b.className = "btn sm kdate-nav"; b.innerHTML = CHEV(left); b.title = title; b.tabIndex = -1;
      b.addEventListener("click", () => moveTo(addMonths(focus, left ? -1 : 1))); return b; };
    const bar = document.createElement("div"); bar.className = "kdate-bar";
    const title = document.createElement("span"); title.className = "kdate-title";
    bar.append(nav(true, "Previous month"), title, nav(false, "Next month"));
    const grid = document.createElement("div"); grid.className = "kdate-grid"; grid.setAttribute("role", "grid");
    grid.addEventListener("click", (ev) => { const c = (ev.target as HTMLElement).closest<HTMLElement>(".kdate-day"); if (!c || !c.dataset.date) return; const d = parseIso(c.dataset.date); if (d) { set(d); close(); input.focus(); } });
    p.append(bar, grid);
    p.addEventListener("pointerdown", (ev) => ev.preventDefault());   // the entry keeps the focus and the keys
    pop = p; document.body.append(p); render();
    fitMenu(p, { below: el.getBoundingClientRect() }); p.style.overflowY = "visible";
    const away = (ev: Event): void => { const t = ev.target as Node; if (!el.contains(t) && !p.contains(t)) close(); };
    const scroll = (ev: Event): void => { if (!p.contains(ev.target as Node)) close(); };
    document.addEventListener("pointerdown", away, true); window.addEventListener("scroll", scroll, true); window.addEventListener("resize", close); window.addEventListener("blur", close);
    undo = [() => document.removeEventListener("pointerdown", away, true), () => window.removeEventListener("scroll", scroll, true), () => window.removeEventListener("resize", close), () => window.removeEventListener("blur", close)];
    el.setAttribute("data-popup-open", ""); input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-controls", p.id);
  }
  btn.addEventListener("pointerdown", (ev) => ev.preventDefault());
  btn.addEventListener("click", () => { if (pop) close(); else { input.focus(); open(); } });
  input.addEventListener("keydown", (ev) => {
    if (!pop) { if ((ev.key === "ArrowDown" && ev.altKey) || ev.key === "F4") { ev.preventDefault(); open(); } return; }
    const day = (n: number): Date => new Date(focus.getFullYear(), focus.getMonth(), focus.getDate() + n);
    let to: Date | null = null;
    if (ev.key === "ArrowLeft") to = day(-1); else if (ev.key === "ArrowRight") to = day(1);
    else if (ev.key === "ArrowUp") to = day(-7); else if (ev.key === "ArrowDown") to = day(7);
    else if (ev.key === "PageUp") to = addMonths(focus, -1); else if (ev.key === "PageDown") to = addMonths(focus, 1);
    else if (ev.key === "Home") to = new Date(focus.getFullYear(), focus.getMonth(), 1);
    else if (ev.key === "End") to = new Date(focus.getFullYear(), focus.getMonth() + 1, 0);
    else if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); set(focus); close(); return; }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    else if (ev.key === "Tab") { close(); return; }
    if (to) { ev.preventDefault(); moveTo(to); }
  });
  input.addEventListener("blur", () => { setTimeout(() => { if (document.activeElement !== input) close(); }, 0); });
  new MutationObserver(() => { btn.disabled = input.disabled; if (input.disabled) close(); }).observe(input, { attributes: true, attributeFilter: ["disabled"] });
  return {
    el, input, open, close, isOpen: () => !!pop,
    get value() { return isoOf(cur); },
    set value(v: string) { const d = parseIso(v); if (d) set(d, false); },
  };
}
