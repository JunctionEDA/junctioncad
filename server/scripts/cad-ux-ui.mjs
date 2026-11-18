// Browser test of how the part studio feels in a person's hands: the things an Onshape user expects to be where
// they are.  One person builds a bracket and, on the way:
//
//   planes       the default geometry is in the feature list, each plane is labelled in the model, hides and
//                shows on its own (and all at once with P), grows with the model; a reference plane carries
//                its feature's name
//   toolbar      a sketch replaces the feature tools by the sketch tools and a ✓ / ✗ pair; a dialog by what it
//                is waiting for; drop-downs remember the variant used last; tooltips; the tool search (S)
//   sketch       Esc and right-click put the tool down and never leave the sketch; ✗ takes a new sketch away
//                again; the plane can be changed; Shift+E from inside a sketch extrudes that sketch
//   units        the control in the status bar; a bare number is in the document's unit, a typed unit converts
//                ("1 in"), expressions too; the readouts follow; ↑ ↓ step a number
//   selection    a listening field keeps adding: a click adds, a click on a chosen edge removes it, a click on
//                nothing changes nothing; ×, Clear; Esc puts the field down, then cancels; a selection made
//                beforehand fills the field; what is chosen stays highlighted
//   dialog       it can be dragged and folded and the next one opens where it was left; Final
//   feature list hover both ways, rollback bar, F2, multi-select, the filter, the menu, an error's "show me"
//   viewport     the view cube, Shift+7, N, F, box selection both ways, the right-click menu, the ? sheet
//
// Setup as the other cad-*-ui.mjs scripts (see cad-ui.mjs): a server with KC_DEV_LOGIN=1, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-ux-ui.mjs
//
// With SHOTS it also saves screenshots, light and dark, 1500 and 1100 pixels wide.
import fs from 'node:fs';
import { openPanel, sketchOn, tool, toolTitles, toolbarMode } from './cad-chrome.mjs';
import { S, click, edgeOnScreen, faceOnScreen, focusViewport, launch, newPartStudio, previewed, screenOf, settled, signedIn, sketchPoint, state, user, viewDir, viewStill } from './cad-ux-lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const browser = await launch();
const uid = user('cad-ux-alice', 990901);
const page = await signedIn(browser, uid, 'cad-ux-alice');
const shot = async (name, p = page) => { if (SHOTS) { await p.waitForTimeout(350); await p.screenshot({ path: `${SHOTS}/${name}.png` }); } };
const st = () => state(page);
const labels = () => page.$$eval('.cad-plane-label', (els) => els.filter((e) => e.style.display !== 'none' && Number(e.style.opacity || 1) > 0.05).map((e) => e.textContent));
const key = async (k) => { await focusViewport(page); await page.keyboard.press(k); await page.waitForTimeout(80); };
const rows = () => page.$$eval('.cad-features [data-feature-row]', (els) => els.map((e) => e.querySelector('[data-row-name]')?.textContent || ''));

try {
  // ================================================================ first paint
  const pid = await newPartStudio(page, 'CAD UX test');
  const early = await S(page, () => ({ kernel: window.JunctionPartStudio.getState().kernel.state, rows: document.querySelectorAll('.cad-features [data-default-geometry]').length, status: document.querySelector('.cad-status')?.textContent || '' }));
  check('the feature list and the status bar are there before the modelling kernel is', early.rows === 4 && early.status.length > 0, `kernel ${early.kernel}; ${early.rows} default rows`);
  await page.waitForFunction(() => window.JunctionPartStudio.getState().kernel.state === 'ready', null, { timeout: 90000 });

  // ================================================================ 1. planes as features
  check('the feature list starts with the default geometry: Origin, Top, Front, Right', (await page.$$eval('.cad-features [data-default-geometry]', (els) => els.map((e) => e.textContent.trim()))).join() === 'Origin,Top,Front,Right');
  check('each plane carries its name in the model', (await labels()).sort().join() === 'Front,Right,Top', (await labels()).join());
  await shot('01-empty-studio-planes');
  // the pointer over a plane's row lights the plane up, and its name
  await page.hover('.cad-features [data-default-geometry=front]');
  check('the pointer over a plane\'s row marks its name in the model', await page.$eval('.cad-plane-label[data-plane-label="plane:front"]', (e) => e.hasAttribute('data-on')));
  // the eye hides one plane, for this person, and it stays hidden over a reload
  await page.click('.cad-features [data-default-geometry=front] [data-eye]');
  await page.waitForTimeout(120);   // the names are placed with the next frame
  check('the eye hides one plane: its name goes, the others stay', (await labels()).sort().join() === 'Right,Top' && (await st()).visibility.front === false, (await labels()).join());
  const frontPick = await S(page, () => { const s = window.JunctionPartStudio, c = s.viewport.canvas.getBoundingClientRect(); const q = s.viewport.project(s.viewport.target.clone().set(-25, 0, 25)); const p = s.view.pick({ clientX: c.left + q.x, clientY: c.top + q.y }); return p ? p.kind + ':' + (p.plane || '') : null; });
  check('a hidden plane is not picked', frontPick !== 'plane:front', String(frontPick));
  await page.reload();
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  check('what a person hid is still hidden after a reload', (await st()).visibility.front === false && await page.getAttribute('.cad-features [data-default-geometry=front]', 'data-visible') === 'false');
  await key('p');
  await page.waitForTimeout(120);
  check('P hides every plane: a clean view', (await labels()).length === 0 && !(await S(page, () => window.JunctionPartStudio.getState().planesVisible)));
  await key('p');
  await page.waitForTimeout(120);
  check('P shows them all again', (await labels()).sort().join() === 'Front,Right,Top');
  // a plane is selected from the list as from the model
  await page.click('.cad-features [data-default-geometry=right]');
  check('a click on a plane\'s row selects the plane', await S(page, () => { const s = window.JunctionPartStudio.getState().selection; return s.length === 1 && s[0].kind === 'plane' && s[0].plane === 'right'; }));
  await key('Escape');

  // ================================================================ 2. the toolbar follows the mode
  check('modelling: the feature tools, no sketch tools', (await toolbarMode(page)) === 'model' && (await toolTitles(page)).includes('Extrude') && !(await toolTitles(page)).includes('Line'));
  await sketchOn(page, 'top');
  await viewStill(page);
  const sketchTools = await toolTitles(page);
  check('in a sketch the toolbar is the sketch tools', (await toolbarMode(page)) === 'sketch' && ['Line', 'Rectangle', 'Centre rectangle', 'Circle', 'Arc', 'Centre arc', 'Tangent arc', 'Slot', 'Point', 'Construction', 'Sketch fillet', 'Trim', 'Extend', 'Offset', 'Mirror', 'Use edge', 'Dimension', 'Coincident', 'Horizontal', 'Vertical', 'Parallel', 'Perpendicular', 'Tangent', 'Equal', 'Midpoint', 'Concentric', 'Collinear', 'Symmetric', 'Fix'].every((t) => sketchTools.includes(t)), sketchTools.join(' '));
  check('… and none of the tools that cannot be used in one', !['Shell', 'Hole', 'Boolean', 'Linear pattern', 'Measure', 'Section', 'History', 'Export'].some((t) => sketchTools.includes(t)));
  check('… with a clear confirm and cancel pair', await page.isVisible('.cad-toolbar [data-group=confirm] [data-tool="Finish sketch"]') && await page.isVisible('.cad-toolbar [data-group=confirm] [data-tool="Cancel sketch"]'));
  check('the view turned to face the sketch plane', (await viewDir(page)).join() === '0,0,-1', (await viewDir(page)).join());
  check('the sketch has its dialog, with the plane it lies on', (await page.textContent('.cad-sketch-dialog [data-sketch-plane]')).includes('Top plane'));
  // a tooltip: the name, the key, a line on what it does
  await page.hover('.cad-toolbar [data-tool=Line]');
  await page.waitForSelector('.cad-tip', { timeout: 3000 });
  const tip = await page.textContent('.cad-tip');
  check('a tool\'s tooltip has its name, its key and what it does', tip.includes('Line') && tip.includes('L') && tip.length > 30, tip);
  await shot('02-sketch-toolbar-tooltip');
  await page.mouse.move(700, 500);
  // a drop-down remembers the variant used last
  await tool(page, 'Centre rectangle');
  check('a drop-down\'s face is the variant used last', await page.isVisible('.cad-toolbar [data-split] [data-variant][data-tool="Centre rectangle"]'));
  await click(page, await sketchPoint(page, 0, 0));
  await click(page, await sketchPoint(page, 30, 20));
  check('the centre rectangle is drawn', Object.values((await S(page, () => window.JunctionSketch.getState().data)).entities).filter((e) => e.type === 'line' && !e.construction).length === 4);
  // Esc puts the tool down and never leaves the sketch
  await key('Escape'); await key('Escape'); await key('Escape');
  check('Esc puts the tool down, clears the selection, and never leaves the sketch', (await st()).sketch !== null && await S(page, () => window.JunctionSketch.getState().tool === 'select'));
  // the tool search, at the pointer
  await page.mouse.move(700, 420);
  await key('s');
  await page.waitForSelector('.cad-palette [data-palette-input]');
  await page.keyboard.type('circ');
  await shot('03-tool-search');
  await page.keyboard.press('Enter');
  check('S opens the tool search; a few letters and Enter take the tool', await S(page, () => window.JunctionSketch.getState().tool === 'sketch-circle') && !(await page.locator('.cad-palette').count()));
  await click(page, await sketchPoint(page, -18, 0));
  await click(page, await sketchPoint(page, -12, 0));
  // a right click puts the tool down
  const rc = await sketchPoint(page, 10, 30);
  await page.mouse.click(rc.x, rc.y, { button: 'right' });
  check('a right click puts the tool down', await S(page, () => window.JunctionSketch.getState().tool === 'select') && (await st()).sketch !== null);
  check('the status bar says how the sketch stands', (await page.getAttribute('.cad-sketch-status', 'data-standing')) === 'free' && (await page.textContent('.cad-sketch-status')).includes('Under-constrained'));
  // the plane can be changed from the sketch's dialog, and back
  await page.click('.cad-sketch-dialog [data-plane=front]');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return f.params.plane.plane === 'front'; });
  await page.click('.cad-sketch-dialog [data-sketch-plane]');
  check('the plane field of the sketch listens for a click', await page.locator('.cad-sketch-dialog [data-sketch-plane][data-armed]').count() === 1 && (await page.getAttribute('[data-pick-filter]', 'data-pick-filter')).includes('plane'));
  await page.click('.cad-features [data-default-geometry=top]');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return f.params.plane.plane === 'top'; });
  check('the sketch moves to the plane picked in the feature list', !(await page.locator('.cad-sketch-dialog [data-sketch-plane][data-armed]').count()));
  await viewStill(page);
  await page.mouse.move(820, 520);
  await shot('04-sketch');

  // ✗ on a new sketch takes it away again; undo brings it back
  await page.click('.cad-toolbar [data-tool="Cancel sketch"]');
  await settled(page, 0);
  check('✗ on a new sketch takes the sketch away again', (await st()).features.length === 0 && (await toolbarMode(page)) === 'model');
  await key('Control+z');
  await settled(page, 1);
  check('… and undo brings it back, with what was drawn', Object.keys((await st()).features[0].params.sketch.entities).length > 8);

  // Shift+E from inside the sketch extrudes that sketch
  await page.dblclick('.cad-features [data-feature-type=sketch]');
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready);
  const sketchId = (await st()).sketch;
  await key('Shift+E');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  check('Shift+E inside a sketch starts an extrude of that sketch', (await st()).editing.params.profile.sketch === sketchId && (await st()).sketch === null);
  check('with a dialog open the toolbar says what it is waiting for, and offers no feature tools', (await toolbarMode(page)) === 'dialog' && !(await toolTitles(page)).includes('Extrude') && await page.isVisible('.cad-toolbar [data-group=confirm] [data-tool=Accept]'));
  await previewed(page);

  // ================================================================ 3. units
  const depth = '.cad-dialog [data-param=depth]';
  check('a length field shows the document\'s unit', (await page.getAttribute('.cad-dialog [data-field=depth] [data-unit]', 'data-unit')) === 'mm');
  await page.fill(depth, '1 in');
  check('"1 in" typed into a millimetre document is 25.4 mm', near((await st()).editing.params.depth, 25.4) && (await st()).editing.params.$expr.depth === '1 in', JSON.stringify((await st()).editing.params.depth));
  await page.fill(depth, '3/8 in + 2 mm');
  check('"3/8 in + 2 mm" adds up', near((await st()).editing.params.depth, 11.525));
  await page.fill(depth, '20');
  check('a bare number is millimetres here, and no expression is kept', (await st()).editing.params.depth === 20 && !(await st()).editing.params.$expr);
  await page.focus(depth);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown');
  check('↑ and ↓ step a number', (await st()).editing.params.depth === 21 && (await page.inputValue(depth)) === '21');
  await page.fill(depth, 'abc');
  check('what is not a number is marked, and the last good value stays', (await page.getAttribute(depth, 'aria-invalid')) === 'true' && (await st()).editing.params.depth === 21);
  await page.fill(depth, '20');
  await previewed(page);
  await shot('05-extrude-dialog');
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 2);
  await page.click('.cad-viewcube [data-view=fit]');

  check('the units are always in the status bar', (await page.getAttribute('.cad-status [data-units]', 'data-units')) === 'mm deg 3');
  await page.click('.cad-status [data-units]');
  await page.waitForSelector('.cad-units');
  await shot('06-units');
  await page.click('.cad-units [data-unit-length=in]');
  await page.waitForFunction(() => window.JunctionPartStudio.getState().units.length === 'in');
  check('a click changes the document\'s length unit, stored in the studio item', await S(page, () => window.JunctionPartStudio.doc.items.get('studio').units === 'in') && (await page.getAttribute('.cad-status [data-units]', 'data-units')) === 'in deg 3');
  await page.click('.cad-units [data-unit-places=more]');
  await page.waitForFunction(() => window.JunctionPartStudio.getState().units.places === 4);
  check('… and the decimal places', await S(page, () => window.JunctionPartStudio.doc.items.get('studio').precision === 4));
  await page.keyboard.press('Escape');
  check('changing the units moved nothing in the model', (await st()).features[1].params.depth === 20);
  // the dialog now reads and writes inches
  await page.dblclick('.cad-features [data-feature-type=extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  check('the same depth now reads in inches', (await page.inputValue(depth)) === '0.787402' && (await page.getAttribute('.cad-dialog [data-field=depth] [data-unit]', 'data-unit')) === 'in', await page.inputValue(depth));
  await page.fill(depth, '1');
  check('a bare 1 is now an inch', near((await st()).editing.params.depth, 25.4));
  await page.fill(depth, '10 mm');
  check('"10 mm" in an inch document is 10 mm', near((await st()).editing.params.depth, 10));
  await page.fill(depth, '1/2');
  check('"1/2" is half an inch, and remembers that it was typed in inches', near((await st()).editing.params.depth, 12.7) && (await st()).editing.params.$unit.depth === 'in');
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 2);
  // the readout follows
  const sideEdge = await edgeOnScreen(page, [':side:', ':end:'], 0);
  await click(page, sideEdge);
  await page.waitForFunction(() => { const e = document.querySelector('.cad-measure[data-measure=ready] [data-key]'); return !!e; }, null, { timeout: 20000 });
  const measured = await page.textContent('.cad-measure');
  check('the measure readout is in the document\'s units', / in\b/.test(measured) && !/ mm\b/.test(measured), measured.slice(0, 80));
  await shot('07-measure-in-inches');
  await key('Escape');
  await page.click('.cad-status [data-units]');
  await page.click('.cad-units [data-unit-length=mm]');
  await page.click('.cad-units [data-unit-places=less]');
  await page.waitForFunction(() => { const u = window.JunctionPartStudio.getState().units; return u.length === 'mm' && u.places === 3; });
  await page.keyboard.press('Escape');
  check('back in millimetres the expression is still half an inch', near((await st()).features[1].params.depth, 12.7));
  await page.dblclick('.cad-features [data-feature-type=extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.fill(depth, '20');
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 2);
  check('the planes reach past the model as it grows', await S(page, () => window.JunctionPartStudio.view.planeLayer.halfOf('top')[0] >= 36));

  // ================================================================ 4. a field that listens keeps adding
  await key('Shift+F');
  await page.waitForSelector('.cad-dialog[data-feature=fillet]');
  const edges = '.cad-dialog [data-param=edges]';
  check('the fillet\'s edge field is listening when the dialog opens', (await st()).editing.field === 'edges' && await page.locator(`${edges}[data-armed]`).count() === 1);
  check('the status bar says what a click picks', (await page.getAttribute('.cad-status [data-pick-filter]', 'data-pick-filter')) === 'edge face');
  const e1 = await edgeOnScreen(page, [':end:', ':side:'], 0), e2 = await edgeOnScreen(page, [':end:', ':side:'], 1), e3 = await edgeOnScreen(page, [':end:', ':side:'], 2);
  // the pre-highlight is what a click will take: at a corner an edge, never the vertex the field cannot use
  await page.mouse.move(e1.x, e1.y, { steps: 3 }); await page.waitForTimeout(120);
  check('the hover shows exactly what a click will pick', await S(page, (name) => { const h = window.JunctionPartStudio.getState().hover; return !!h && h.kind === 'edge' && h.name === name; }, e1.name));
  await click(page, e1);
  await click(page, e2);
  await click(page, e3);
  check('each click adds an edge', (await st()).editing.params.edges.length === 3 && (await page.getAttribute(edges, 'data-count')) === '3');
  await click(page, e2);
  check('a click on a chosen edge takes it out', (await st()).editing.params.edges.map((e) => e.name).join() === [e1.name, e3.name].join());
  const empty = await S(page, () => { const c = window.JunctionPartStudio.viewport.canvas.getBoundingClientRect(); return { x: c.left + c.width - 120, y: c.top + c.height - 60 }; });
  await click(page, empty);
  check('a click on nothing neither drops the selection nor closes the dialog', (await st()).editing?.params.edges.length === 2 && (await st()).editing.field === 'edges');
  await previewed(page);
  check('what is chosen stays highlighted on the model while the dialog is open', await S(page, () => window.JunctionPartStudio.view.marks.active.length === 2));
  await page.mouse.move(empty.x, empty.y);
  await shot('08-fillet-sticky-selection');
  await page.click(`${edges} [data-held]:first-child [data-held-remove]`);
  check('× takes one out of the list', (await st()).editing.params.edges.length === 1 && (await st()).editing.params.edges[0].name === e3.name);
  // the preview follows: the edge that was taken out is an edge of the model again, and can be chosen again
  await page.waitForFunction((name) => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.some((b) => b.mesh && b.mesh.edges.names.includes(name)); }, e1.name, { timeout: 30000 });
  await click(page, e1);
  check('an edge taken out can be chosen again', (await st()).editing.params.edges.length === 2);
  await page.click(`${edges} [data-held-clear]`);
  check('Clear empties the field, and it goes on listening', (await st()).editing.params.edges.length === 0 && (await st()).editing.field === 'edges');
  await key('Escape');
  check('Esc first puts the field down', (await st()).editing !== null && (await st()).editing.field === null);
  await key('Tab');
  check('Tab makes a field listen again', (await st()).editing.field === 'edges');
  await key('Escape'); await key('Escape');
  check('… and a second Esc cancels the dialog', (await st()).editing === null && (await st()).features.length === 2);
  // a selection made beforehand fills the field
  await click(page, e1);
  await click(page, e3, { shift: true });
  check('Shift-click adds to the selection', (await st()).selection === 2);
  await key('Shift+F');
  await page.waitForSelector('.cad-dialog[data-feature=fillet]');
  check('what was selected before the tool fills its field', (await st()).editing.params.edges.map((e) => e.name).join() === [e1.name, e3.name].join());
  // the dialog moves and folds, and stays where it was put
  const before = await page.locator('.cad-dialog').boundingBox();
  await page.mouse.move(before.x + 150, before.y + 14); await page.mouse.down(); await page.mouse.move(before.x + 270, before.y + 74, { steps: 6 }); await page.mouse.up();
  const moved = await page.locator('.cad-dialog').boundingBox();
  check('the dialog is dragged by its title', near(moved.x - before.x, 120, 3) && near(moved.y - before.y, 60, 3), `${moved.x - before.x}, ${moved.y - before.y}`);
  await page.click('.cad-dialog [data-dialog-fold]');
  check('… and folds to its title', (await page.locator('.cad-dialog').boundingBox()).height < 40 && await page.isHidden(edges));
  await page.click('.cad-dialog [data-dialog-fold]');
  await page.fill('.cad-dialog [data-param=radius]', '3');
  // dragging a number's label scrubs it: six pixels a step, and a fillet's radius steps by half a millimetre
  const label = await page.locator('.cad-dialog [data-field=radius] > span').first().boundingBox();
  await page.mouse.move(label.x + 10, label.y + 10); await page.mouse.down(); await page.mouse.move(label.x + 10 + 31, label.y + 10, { steps: 5 }); await page.mouse.up();
  check('dragging a number\'s label scrubs it', (await st()).editing.params.radius === 5.5 && (await page.inputValue('.cad-dialog [data-param=radius]')) === '5.5', String((await st()).editing.params.radius));
  await page.fill('.cad-dialog [data-param=radius]', '3');
  await previewed(page);
  await key('Enter');
  await settled(page, 3);
  check('Enter accepts', (await st()).features[2].type === 'fillet' && (await st()).features[2].params.radius === 3);
  await page.dblclick('.cad-features [data-feature-type=extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  const reopened = await page.locator('.cad-dialog').boundingBox();
  check('the next dialog opens where the last one was left', near(reopened.x, moved.x, 2) && near(reopened.y, moved.y, 2));
  // back into its corner, out of the model's way
  await page.mouse.move(reopened.x + 150, reopened.y + 14); await page.mouse.down(); await page.mouse.move(reopened.x + 30, reopened.y - 46, { steps: 6 }); await page.mouse.up();
  // Final: the model with every later feature built, while an earlier feature is edited
  await previewed(page);
  const faces = () => S(page, () => window.JunctionPartStudio.getState().bodies.reduce((n, b) => n + (b.mesh ? b.mesh.faces.names.length : 0), 0));
  const asFar = await faces();
  await page.click('.cad-dialog [data-final]');
  await page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.reduce((k, b) => k + (b.mesh ? b.mesh.faces.names.length : 0), 0) > n; }, asFar, { timeout: 30000 });
  check('Final shows the later features while an earlier one is edited', (await faces()) === asFar + 2, `${asFar} → ${await faces()} faces`);
  await page.click('.cad-dialog [data-cancel]');
  await settled(page, 3);

  // the edges an existing fillet has rounded are gone from the model, and are still shown as chosen and still clickable
  await page.dblclick('.cad-features [data-feature-type=fillet]');
  await page.waitForSelector('.cad-dialog[data-feature=fillet]');
  await page.waitForFunction(() => window.JunctionPartStudio.view.held.size === 2, null, { timeout: 30000 });
  check('editing a fillet shows the edges it rounded, as they were before it', await S(page, () => { const v = window.JunctionPartStudio.view; return v.marks.other.length === 2 && Array.from(v.held.values()).every((h) => h.segments && h.segments.length >= 6); }));
  await page.click(edges);
  await click(page, e1);
  check('… and a click where one was takes it out of the fillet', (await st()).editing.params.edges.length === 1 && (await st()).editing.params.edges[0].name === e3.name);
  await page.click('.cad-dialog [data-cancel]');
  await settled(page, 3);

  // ================================================================ 5. the feature list
  check('the list counts its features', (await page.getAttribute('.cad-dock [data-panel=features] [data-panel-count]', 'data-panel-count')) === '3' && (await page.getAttribute('.cad-dock [data-panel=parts] [data-panel-count]', 'data-panel-count')) === '1');
  await page.hover('.cad-features [data-feature-type=fillet]');
  check('the pointer over a feature\'s row lights up what it made', await S(page, () => { const v = window.JunctionPartStudio.view; return v.featureHover.length === 2 && v.featureHover.every((p) => p.kind === 'face'); }));
  const cap = await faceOnScreen(page, [':end:']);
  await page.mouse.move(cap.x, cap.y, { steps: 3 }); await page.waitForTimeout(150);
  const madeBy = await S(page, () => { const st = window.JunctionPartStudio, h = st.getState().hover; return h ? st.hoveredFeature() : null; });
  check('the pointer over the model marks the row of the feature that made the face', !!madeBy && await page.locator(`.cad-features [data-feature-row="${madeBy}"][data-made-hover]`).count() === 1 && await page.locator('.cad-features [data-made-hover]').count() === 1);
  // rename with F2
  await page.click('.cad-features [data-feature-type=fillet]');
  await key('F2');
  await page.waitForSelector('.cad-features [data-feature-type=fillet] input');
  await page.keyboard.type('Soft edges'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.JunctionPartStudio.getState().features[2].name === 'Soft edges');
  await page.waitForSelector('.cad-features [data-feature-type=fillet] input', { state: 'detached' });
  check('F2 renames the selected feature in place', (await rows()).join() === 'Sketch 1,Extrude 1,Soft edges');
  // Ctrl and Shift select several
  await page.click('.cad-features [data-feature-type=sketch]');
  await page.click('.cad-features [data-feature-type=fillet]', { modifiers: ['Control'] });
  check('Ctrl-click selects a second row', (await S(page, () => window.JunctionPartStudio.getState().selectedFeatures.length)) === 2);
  await page.click('.cad-features [data-feature-type=sketch]');
  await page.click('.cad-features [data-feature-type=fillet]', { modifiers: ['Shift'] });
  check('Shift-click selects the range', (await S(page, () => window.JunctionPartStudio.getState().selectedFeatures.length)) === 3);
  // the filter
  await page.fill('.cad-features [data-feature-filter]', 'soft');
  check('the filter box keeps the rows whose name matches', (await rows()).join() === 'Soft edges' && (await page.locator('.cad-features [data-default-geometry]').count()) === 0);
  await page.fill('.cad-features [data-feature-filter]', '');
  // the rollback bar
  const bar = await page.locator('.cad-features [data-rollback]').boundingBox();
  const filletRow = await page.locator('.cad-features [data-feature-type=fillet]').boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2); await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2, filletRow.y + 2, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction(() => window.JunctionPartStudio.getState().rollback === 2);
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.reports[s.features[2].id]?.status === 'rolled-back'; }, null, { timeout: 30000 });
  check('dragging the bar up rolls the model back, and the bar says how much is below it', (await page.getAttribute('.cad-features [data-rollback]', 'data-rolled')) === '1' && (await page.getAttribute('.cad-features [data-feature-type=fillet]', 'data-state')) === 'rolled-back');
  await shot('09-rolled-back');
  await page.click('.cad-features [data-feature-type=extrude]');
  await page.click('.cad-features [data-feature-type=fillet]', { button: 'right' });
  const menuItems = await page.$$eval('.cad-feature-menu [data-menu-item]', (els) => els.map((e) => e.getAttribute('data-menu-item')));
  check('the right-click menu of a feature', ['Edit…', 'Rename', 'Suppress', 'Roll back to here', 'Roll to end', 'Zoom to', 'Show what it uses and what uses it', 'Delete'].every((m) => menuItems.includes(m)), menuItems.join(' | '));
  await page.click('.cad-feature-menu [data-menu-item="Roll to end"]');
  await settled(page, 3);
  await page.click('.cad-features [data-feature-type=extrude]', { button: 'right' });
  await page.click('.cad-feature-menu [data-menu-item="Show what it uses and what uses it"]');
  check('“used by” marks the rows on either side', (await page.getAttribute('.cad-features [data-feature-type=sketch] [data-dep]', 'data-dep')) === 'uses' && (await page.getAttribute('.cad-features [data-feature-type=fillet] [data-dep]', 'data-dep')) === 'used by');
  await page.click('.cad-features [data-deps] button');
  // a sketch is shown and hidden with its eye
  check('a sketch a feature uses is hidden until asked for', (await page.getAttribute('.cad-features [data-feature-type=sketch] [data-eye]', 'data-eye')) === 'hidden');
  await page.click('.cad-features [data-feature-type=sketch] [data-eye]');
  check('the eye shows it', (await st()).visibility[(await st()).features[0].id] === true && await S(page, () => !!window.JunctionPartStudio.view.sketchFrame(window.JunctionPartStudio.getState().features[0].id)));
  await page.click('.cad-features [data-feature-type=sketch] [data-eye]');
  // an error: its message, and "show me"
  await page.click('.cad-features [data-feature-type=sketch]', { button: 'right' });
  await page.click('.cad-feature-menu [data-menu-item=Suppress]');
  await page.waitForSelector('.cad-features [data-feature-type=extrude] [data-problem=error]', { timeout: 30000 });
  await page.hover('.cad-features [data-feature-type=extrude] [data-problem=error]');
  await page.waitForSelector('.cad-tip');
  check('a failed feature says why on hover', (await page.textContent('.cad-tip')).includes('sketch'), await page.textContent('.cad-tip'));
  await page.click('.cad-features [data-feature-type=extrude] [data-problem=error]');
  check('… and a click selects it and looks at it', (await S(page, () => window.JunctionPartStudio.getState().selectedFeature)) === (await st()).features[1].id);
  await key('Control+z');
  await settled(page, 3);
  await page.waitForFunction(() => window.JunctionPartStudio.getState().bodies.length === 1, null, { timeout: 30000 });
  // the parts list
  await page.click('.cad-dock [data-panel=parts] [data-body] [data-eye]');
  check('the parts list hides a part', (await page.getAttribute('.cad-dock [data-panel=parts] [data-body]', 'data-visible')) === 'false');
  await page.click('.cad-dock [data-panel=parts] [data-show-all]');
  check('… and shows them all again', (await page.getAttribute('.cad-dock [data-panel=parts] [data-body]', 'data-visible')) === 'true');

  // ================================================================ 1 again: a reference plane has its feature's name
  await page.click('.cad-features [data-default-geometry=top]');
  await tool(page, 'Plane');
  await page.waitForSelector('.cad-dialog[data-feature=plane]');
  check('the plane selected beforehand is what the new plane is offset from', (await st()).editing.params.ref?.plane === 'top');
  await page.fill('.cad-dialog [data-param=distance]', '40');
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 4);
  await page.waitForFunction(() => window.JunctionPartStudio.getState().datums.length === 1, null, { timeout: 30000 });
  check('a reference plane is labelled with its feature\'s name', (await labels()).includes('Plane 1'), (await labels()).join());
  await page.click('.cad-features [data-feature-type=plane] [data-eye]');
  await page.waitForTimeout(120);
  check('… and hides with its eye, name and all', !(await labels()).includes('Plane 1'));
  await page.click('.cad-features [data-feature-type=plane] [data-eye]');
  await page.click('.cad-viewcube [data-view=fit]');
  await shot('10-reference-plane');

  // ================================================================ 6. the viewport
  await page.click('.cad-viewcube [data-face=top] [data-view=top]');
  await viewStill(page);
  check('a face of the view cube turns the view', (await viewDir(page)).join() === '0,0,-1', (await viewDir(page)).join());
  await key('Shift+7');
  await viewStill(page);
  const iso = await viewDir(page);
  check('Shift+7 is the isometric view', near(iso[0], -0.577, 0.01) && near(iso[1], 0.577, 0.01) && near(iso[2], -0.577, 0.01), iso.join());
  await page.click('.cad-viewcube [data-turn="Turn right"]');
  await viewStill(page);
  const turned = await viewDir(page);
  check('an arrow beside the cube turns the view 15°', near(Math.acos(Math.min(1, turned[0] * iso[0] + turned[1] * iso[1] + turned[2] * iso[2])) * 180 / Math.PI, 15, 2.5) || near(turned[2], iso[2], 0.05), turned.join());
  await key('Shift+7'); await viewStill(page);
  const extrudeId = (await st()).features[1].id;
  // a flat side of the block that faces the camera (not the wall of the hole, which is a side too)
  const flatName = await S(page, (id) => {
    const st = window.JunctionPartStudio, back = st.viewport.target.clone().set(0, 0, 1).applyQuaternion(st.viewport.camera.quaternion);
    for (const b of st.getState().bodies) for (const name of b.mesh ? b.mesh.faces.names : []) {
      if (!name.startsWith(id + ':side:')) continue;
      const n = st.view.normalOf({ kind: 'face', body: b.id, name });
      if (n && n.normal[0] * back.x + n.normal[1] * back.y + n.normal[2] * back.z > 0.3) return name;
    }
    return null;
  }, extrudeId);
  const flat = await faceOnScreen(page, [`^${flatName}`]);
  await click(page, flat);
  await key('n');
  await viewStill(page);
  const nd = await viewDir(page);
  check('N looks straight at the selected flat face', near(Math.abs(nd[2]), 0, 0.01) && near(Math.hypot(nd[0], nd[1]), 1, 0.01), nd.join());
  await key('Escape');
  await key('Shift+7'); await viewStill(page);
  await S(page, () => { const v = window.JunctionPartStudio.viewport; v.camera.zoom *= 0.2; v.camera.updateProjectionMatrix(); v.invalidate(); });
  await key('f');
  await page.waitForTimeout(200);
  check('F fits the model in the view', await S(page, () => window.JunctionPartStudio.viewport.camera.zoom > 2));
  // a box from left to right takes what is wholly inside it; from right to left, what it touches
  const box = await S(page, () => { const c = window.JunctionPartStudio.viewport.canvas.getBoundingClientRect(); return { l: c.left + 30, t: c.top + 120, r: c.left + c.width - 180, b: c.top + c.height - 30, cx: c.left + c.width / 2, cy: c.top + c.height / 2 }; });
  const drag = async (x0, y0, x1, y1) => { await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await page.mouse.move(x1, y1, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(100); };
  await drag(box.l, box.t, box.r, box.b);
  const all = (await st()).selection;
  check('a box drawn left to right selects what is wholly inside it', all > 20, `${all} selected`);
  await key('Escape');
  await drag(box.cx + 10, box.cy + 10, box.cx - 10, box.cy - 10);
  const touched = (await st()).selection;
  await key('Escape');
  await drag(box.cx - 10, box.cy - 10, box.cx + 10, box.cy + 10);
  const inside = (await st()).selection;
  check('a small box drawn right to left takes what it touches; left to right, nothing that is not inside', touched >= 1 && inside === 0, `${touched} touched, ${inside} inside`);
  // the right-click menu
  const top = await faceOnScreen(page, [`^${extrudeId}:end:`]);
  await page.mouse.click(top.x, top.y, { button: 'right' });
  await page.waitForSelector('.cad-context-menu');
  const ctx = await page.$$eval('.cad-context-menu [data-menu-item]', (els) => els.map((e) => e.getAttribute('data-menu-item')));
  check('a right click offers what can be done with what is under it', ['New sketch here', 'View normal to', 'Zoom to fit', 'Hide this part'].every((m) => ctx.includes(m)), ctx.join(' | '));
  await shot('11-context-menu');
  await page.click('.cad-context-menu [data-menu-item="New sketch here"]');
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready);
  check('“New sketch here” starts drawing on that face at once', (await st()).sketch !== null && (await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.find((f) => f.id === s.sketch.featureId).params.plane.kind; })) === 'face');
  await page.click('.cad-sketch-dialog [data-sketch-cancel]');
  await settled(page, 4);
  check('✗ in the sketch\'s dialog takes the unused sketch away', (await st()).features.length === 4 && (await toolbarMode(page)) === 'model');
  await key('?');
  await page.waitForSelector('.cad-shortcuts');
  check('? opens the sheet of keys', (await page.textContent('.cad-shortcuts')).includes('Zoom to fit') && (await page.textContent('.cad-shortcuts')).includes('Right drag'));
  await shot('12-shortcuts');
  await page.keyboard.press('Escape');
  await page.click('.cad-viewcube [data-view-menu]');
  await page.waitForSelector('.cad-view-menu');
  await page.click('.cad-view-menu [data-view-item=Perspective]');
  check('the view cube\'s menu sets the projection', (await page.getAttribute('.cad-viewcube', 'data-projection')) === 'perspective');
  await page.click('.cad-viewcube [data-view-menu]');
  await page.click('.cad-view-menu [data-view-item=Orthographic]');
  await key('Shift+7'); await viewStill(page);
  await page.click('.cad-viewcube [data-view=fit]');
  await page.mouse.move(box.cx, box.b);
  await shot('13-bracket');
  await openPanel(page, 'mass-properties');
  check('no script errors', page.errors.length === 0, page.errors.join(' | '));

  // ================================================================ the same studio, dark and narrow
  if (SHOTS) {
    const did = await S(page, () => new URL(location.href).searchParams.get('doc'));
    for (const [name, o] of [['14-dark-1500', { dark: true, width: 1500 }], ['15-dark-1100', { dark: true, width: 1100 }], ['16-light-1100', { width: 1100 }]]) {
      const p = await signedIn(browser, uid, 'cad-ux-alice', o);
      await p.goto(`${process.env.E2E_BASE || 'http://127.0.0.1:8099'}/p/${pid}/edit?doc=${did}`);
      await p.waitForFunction(() => { const s = window.JunctionPartStudio && window.JunctionPartStudio.getState(); return s && s.loaded && s.kernel.state === 'ready' && s.bodies.length === 1; }, null, { timeout: 90000 });
      await p.waitForTimeout(400);
      await p.click('.cad-viewcube [data-view=fit]');
      if (name === '15-dark-1100') {
        await p.dblclick('.cad-features [data-feature-type=sketch]');
        await p.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready);
        await p.waitForTimeout(600);
      } else if (name === '14-dark-1500') {
        await p.dblclick('.cad-features [data-feature-type=fillet]');
        await p.waitForSelector('.cad-dialog[data-feature=fillet]');
        await p.click('.cad-dialog [data-param=edges]');
        await p.waitForTimeout(600);
      }
      await shot(name, p);
      check(`${name}: no script errors`, p.errors.length === 0, p.errors.join(' | '));
      await p.context().close();
    }
  }
} catch (e) {
  check('the script ran to its end', false, String(e && e.message ? e.message : e).split('\n').slice(0, 3).join(' | '));
  await shot('zz-failed');
  if (page.errors.length) console.log('page errors:', page.errors.join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
