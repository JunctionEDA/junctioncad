// dialogs/cvpcb/style.ts — the stylesheet of the Assign Footprints frame and its footprint viewer (theme tokens only).
// The menu bar, toolbar buttons, icons and drop-down menus are the Symbol Editor frame's (symedit/ui.ts, se-*).
import { h } from "../dom";
import { ensureStyle } from "../../symedit/ui";

const CSS = `
.se-menu{z-index:58}
.cv-frame{position:fixed;z-index:55;display:flex;flex-direction:column;min-width:520px;min-height:300px;background:var(--bench);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-3);box-shadow:var(--shadow-dialog);font:var(--fs-sm) var(--font);overflow:hidden}
.cv-frame.cv-top,.v3d-win.cv-top{z-index:56}
.cv-frame *{box-sizing:border-box}
.cv-title{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--paper);border-bottom:1px solid var(--line);font-weight:600;cursor:move;user-select:none}
.cv-title .cv-x{margin-left:auto;padding:0 4px;color:var(--ink-2);font-size:15px;line-height:1;cursor:pointer}
.cv-title .cv-x:hover{color:var(--ink)}
.cv-frame .se-menubar{flex:none;height:24px}
.cv-frame .se-tb{min-height:32px}
.cv-flabel{font-weight:600;margin:0 4px 0 0;white-space:nowrap}
.cv-ftext{width:150px;min-width:150px;height:24px;padding:2px 6px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-2);font:var(--fs-sm) var(--mono)}
.cv-ftext:focus{outline:0;border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}
.cv-main{flex:1;display:flex;min-height:0;min-width:0}
.cv-pane{display:flex;flex-direction:column;min-width:20px;min-height:0}
.cv-pane.cv-center{flex:1;min-width:60px}
.cv-cap{flex:none;padding:3px 6px;background:linear-gradient(var(--paper),var(--bench));border-bottom:1px solid var(--line);color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none}
.cv-pane.cv-focus .cv-cap{color:var(--ink);font-weight:600}
.cv-split{flex:none;width:5px;cursor:col-resize;background:var(--bench);border-left:1px solid var(--line);border-right:1px solid var(--line);touch-action:none}
.cv-split:hover,.cv-split.drag{background:var(--sel-soft)}
.cv-list{position:relative;flex:1;min-height:0;overflow:auto;background:var(--panel);outline:none;font:var(--fs-sm)/18px var(--mono);white-space:pre;cursor:default;user-select:none}
.cv-pane.cv-focus .cv-list{box-shadow:inset 0 0 0 1px var(--blue)}
.cv-sizer{position:absolute;left:0;top:0;width:1px}
.cv-row{position:absolute;left:0;right:0;height:18px;padding:0 6px;overflow:hidden;min-width:max-content}
.cv-row:hover{background:var(--sel-soft)}
.cv-row.warn{background:var(--warn-row)}
.cv-row.sel{background:var(--sel)}
.cv-row.cur{outline:1px dotted var(--ink-2);outline-offset:-1px}
.cv-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:12px;color:var(--ink-3);font-family:var(--font);white-space:normal;text-align:center;pointer-events:none}
.cv-bottom{flex:none;display:flex;align-items:flex-end;gap:12px;padding:4px 6px 6px 8px;border-top:1px solid var(--line);background:var(--bench)}
.cv-status{flex:1;min-width:0;display:flex;flex-direction:column;font-size:var(--fs-xs);color:var(--ink-2)}
.cv-status div{min-height:15px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-buttons{flex:none;display:flex;gap:8px;align-items:center}
.cv-buttons .cv-apply{margin-right:12px}
.cv-grip{position:absolute;right:1px;bottom:1px;width:12px;height:12px;cursor:nwse-resize;touch-action:none;background:radial-gradient(circle,var(--ink-2) 1px,transparent 1.3px) 0 0/4px 4px;clip-path:polygon(100% 0,100% 100%,0 100%);opacity:.7}
.cv-viewer .cv-vmain{flex:1;display:flex;min-height:0}
.cv-viewer .cv-canvas{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;outline:none}
.cv-viewer .cv-canvas canvas{position:absolute;inset:0;width:100%;height:100%}
.cv-viewer .se-info{flex:none}
.cv-viewer .se-msg{flex:none}
.cv-vstatus{flex:none;display:flex;gap:14px;align-items:center;padding:2px 8px;height:22px;background:var(--panel);border-top:1px solid var(--line);color:var(--ink-2);font-size:var(--fs-xs);white-space:nowrap;overflow:hidden}
.cv-vstatus span{font-family:var(--mono)}
.cv-equ .cv-elist{height:150px;overflow:auto;border:1px solid var(--line);background:var(--panel);font:var(--fs-sm)/20px var(--mono);user-select:none}
.cv-equ .cv-erow{padding:0 6px;white-space:nowrap;cursor:default}
.cv-equ .cv-erow.sel{background:var(--sel)}
.cv-equ .cv-ebtns{display:flex;gap:4px;margin:6px 0 10px}
.cv-equ .cv-ebtns button{width:28px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.cv-equ .cv-ebtns .sp{width:12px}
.cv-equ .se-ic{width:16px;height:16px}
`;

let styled = false;
export function ensureCvStyle(): void {
  ensureStyle();
  if (styled) return; styled = true;
  document.head.append(h("style", { id: "cvpcb-style" }, CSS));
}
