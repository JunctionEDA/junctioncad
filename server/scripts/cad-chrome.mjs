// What the cad-*-ui.mjs scripts share about the part studio's chrome.  The toolbar shows the tools of the mode
// the studio is in (modelling, a sketch, a dialog); a family of tools is a split button whose face runs the
// variant used last and whose caret opens the list (Fillet ▾ holds Fillet, Chamfer and Draft); in a narrow
// window a whole section may fold into one drop-down (the sketch constraints); a docked panel may be folded.
//
//   await tool(page, 'Chamfer')          click the button, opening its drop-down first when it is in one
//   await toolTitles(page)               every feature and tool the toolbar offers, drop-downs included
//   await openPanel(page, 'comments')    unfold a docked panel (and its dock) if it is folded
//   await viewFrom(page, 'top')          a face of the view cube; 'iso' and 'fit' are the buttons under it

/** Click a toolbar button by its title: a sketch tool while a sketch is open, a feature or a tool otherwise. */
export async function tool(page, title) {
  // a plain button, or the face of a split button that shows this variant just now
  const sel = `.cad-toolbar [data-group] [data-tool="${title}"]`;
  if (await page.locator(sel).count()) { await page.click(sel); return; }
  const menu = await page.evaluate((title) => {
    const m = Array.from(document.querySelectorAll('.cad-toolbar [data-menu]')).find((e) => (e.getAttribute('data-items') || '').split('|').includes(title));
    return m ? m.getAttribute('data-menu') : null;
  }, title);
  if (!menu) throw new Error(`The toolbar has no "${title}".`);
  await page.click(`.cad-toolbar [data-menu="${menu}"]`);
  await page.click(`.cad-tb-menu [data-tool="${title}"]`);
}

/** The titles of everything in the toolbar (in one group when given), with what the drop-downs hold. */
export async function toolTitles(page, group = '') {
  return page.evaluate((group) => {
    const out = [];
    for (const g of Array.from(document.querySelectorAll('.cad-toolbar [data-group]'))) {
      if (group && g.getAttribute('data-group') !== group) continue;
      // the face of a split button repeats one of its drop-down's items: the drop-down lists them all
      for (const b of Array.from(g.querySelectorAll('[data-tool]:not([data-variant]), [data-menu]'))) {
        if (b.hasAttribute('data-menu')) out.push(...(b.getAttribute('data-items') || '').split('|'));
        else out.push(b.getAttribute('data-tool'));
      }
    }
    return out;
  }, group);
}

/** The mode the toolbar is in: "model", "sketch", "dialog" or "view" (no edit rights). */
export const toolbarMode = (page) => page.getAttribute('.cad-toolbar', 'data-mode');

/** Unfold a docked panel, and the dock it is in. */
export async function openPanel(page, id) {
  const side = await page.evaluate((id) => { const p = document.querySelector(`.cad-dock [data-panel="${id}"]`); return p ? p.closest('.cad-dock').getAttribute('data-side') : null; }, id);
  if (!side) throw new Error(`There is no "${id}" panel.`);
  if (await page.locator(`.cad-dock[data-side=${side}][data-folded]`).count()) await page.click(`[data-dock-unfold=${side}]`);
  if (!(await page.locator(`.cad-dock [data-panel="${id}"][data-open]`).count())) await page.click(`[data-panel-toggle="${id}"]`);
  await page.waitForSelector(`.cad-dock [data-panel="${id}"][data-open]`);
}

/** Turn the view with the view cube: 'top', 'front', 'right', 'back', 'left', 'bottom', or 'iso' / 'fit'. */
export async function viewFrom(page, view) {
  // a face that is turned away cannot be clicked: the studio's own view call is what its click does
  if (view === 'iso' || view === 'fit') { await page.click(`.cad-viewcube [data-view=${view}]`); return; }
  await page.evaluate((view) => window.JunctionPartStudio.viewport.setView(view), view);
}

/** Start a sketch on a default plane ('top', 'front', 'right'): the Sketch button, then the plane's row in the feature list. */
export async function sketchOn(page, plane = 'top') {
  await tool(page, 'Sketch');
  await page.waitForSelector('.cad-dialog[data-feature=sketch]');
  await page.click(`.cad-features [data-default-geometry=${plane}]`);
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready, null, { timeout: 30000 });
}
