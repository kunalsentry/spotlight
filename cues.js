// Spotlight — cues.
//
// A cue turns the spotlight on automatically when a specific element is
// clicked on a page whose URL matches a pattern, placed over a recorded area.
// Cues only run while armed (a per-browser-session switch kept by the service
// worker). After a cue places it, the spotlight is an ordinary placed
// spotlight; content.js does the drawing, through globalThis.__spotlight.
//
// Elements are identified by a fingerprint: a list of strategies (a CSS
// selector, optionally plus an accessible name), each of which matched exactly
// that one element when the cue was recorded. The first strategy that still
// finds exactly one element wins.
//
// The spotlight's area is stored relative to an anchor element (or the
// viewport), one rule per axis, so it adapts to other window sizes:
//   stretch  both edges follow the anchor's edges (a = inset from the start
//            edge, b = from the end edge; negative = outside the anchor)
//   start    fixed size, `inset` from the anchor's start edge
//   end      fixed size, `inset` from the anchor's end edge
//   center   fixed size, `offset` from the anchor's centre
// A cue whose two axes both stretch simply fits its anchor, plus padding.

(() => {
  'use strict';

  const api = globalThis.__spotlight;
  if (!api) return; // content.js didn't start (shouldn't happen)

  const TEARDOWN_EVENT = 'spotlight:teardown';
  const PENDING_KEY = 'spotlight:pendingCue';  // a cue whose click loaded a new page
  const RECORDING_KEY = 'spotlight:recording'; // a recording whose trigger click loaded a new page
  const PENDING_MAX_AGE = 10000;  // ms
  const RECORDING_MAX_AGE = 30000;
  const FIT_TOLERANCE = 24;       // px: an edge this close to the anchor's edge follows it
  const POLL_MS = 50;             // how often to look for the anchor while a cue runs
  const STABLE_POLLS = 3;         // its box must stay put this many polls in a row
  const DEFAULT_TIMEOUT = 3000;
  const TEST_ATTRS = ['data-test-id', 'data-testid', 'data-test', 'data-cy', 'data-qa'];
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"], [onclick]';

  let cues = [];
  let armed = false;
  let run = null;      // the cue being carried out: { cue, timer, ... }
  let rec = null;      // recording state: { step, trigger, name, page }
  let ui = null;       // recording bar and picker highlight

  // ------------------------------------------------------------ fingerprints

  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

  // Elements whose visible text is their name (buttons, links, tabs,
  // headings...). Other elements are only named by aria-label/title, so name
  // matching never has to read the text of every <div> on the page.
  const NAMED_BY_TEXT = `${INTERACTIVE}, h1, h2, h3, h4, h5, h6, [role="heading"], li, td, th`;

  // Close enough to an accessible name for matching: the label a person sees.
  function accName(el) {
    const label = el.getAttribute('aria-label');
    if (label) return clean(label).slice(0, 80);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(' ');
      if (clean(text)) return clean(text).slice(0, 80);
    }
    const sources = [el.getAttribute('title'), el.getAttribute('alt'), el.getAttribute('placeholder')];
    if (el.matches(NAMED_BY_TEXT)) sources.unshift(el.textContent);
    for (const text of sources) {
      if (clean(text)) return clean(text).slice(0, 80);
    }
    return '';
  }

  // A short label for showing an element to a person (not used for matching).
  function describe(el) {
    const testAttr = TEST_ATTRS.find((a) => el.hasAttribute(a));
    const heading = el.querySelector('h1, h2, h3, h4, [role="heading"]');
    const text = accName(el) || (testAttr && el.getAttribute(testAttr)) || (stableId(el.id) && el.id) || clean(heading?.textContent) || clean(el.textContent);
    return (text || el.localName).slice(0, 40);
  }

  // Ids that look generated (React useId, Ember, hashes, long numbers) change
  // between page loads, so they're not used.
  const stableId = (id) => !!id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}|[0-9a-f]{8,}|^(ember|react|radix|headlessui|mui|rc-|downshift)/i.test(id);

  function roleSelector(el) {
    const role = el.getAttribute('role');
    return role ? `[role="${CSS.escape(role)}"]` : el.localName;
  }

  // nth-of-type path up from the nearest ancestor with a stable id or test id.
  function cssPath(el) {
    const parts = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const testAttr = TEST_ATTRS.find((a) => node.hasAttribute(a));
      if (node !== el && testAttr) { parts.unshift(`[${testAttr}="${CSS.escape(node.getAttribute(testAttr))}"]`); break; }
      if (node !== el && stableId(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function query(strategy) {
    let found;
    try { found = [...document.querySelectorAll(strategy.sel)]; } catch { return []; }
    return strategy.name == null ? found : found.filter((el) => accName(el) === strategy.name);
  }

  // Every strategy that finds exactly this element, best first. Empty when
  // the element can't be told apart from others.
  function fingerprint(el) {
    const name = accName(el);
    const testAttr = TEST_ATTRS.find((a) => el.hasAttribute(a));
    const testSel = testAttr && `[${testAttr}="${CSS.escape(el.getAttribute(testAttr))}"]`;
    const candidates = [];
    if (testSel) candidates.push({ kind: 'test id', sel: testSel });
    if (stableId(el.id)) candidates.push({ kind: 'id', sel: `#${CSS.escape(el.id)}` });
    if (name) {
      if (testSel) candidates.push({ kind: 'test id + name', sel: testSel, name });
      const roleSel = roleSelector(el);
      if (el.getAttribute('role') || !['div', 'span'].includes(roleSel)) candidates.push({ kind: 'role + name', sel: roleSel, name });
      if (el.getAttribute('role') && !['div', 'span'].includes(el.localName)) candidates.push({ kind: 'tag + name', sel: el.localName, name });
    }
    candidates.push({ kind: 'path', sel: cssPath(el) });
    const unique = candidates.filter((s) => {
      const found = query(s);
      return found.length === 1 && found[0] === el;
    });
    return unique.slice(0, 4);
  }

  // The element a fingerprint identifies now, or null.
  function resolve(fp) {
    for (const strategy of fp || []) {
      const found = query(strategy);
      if (found.length === 1) return found[0];
    }
    return null;
  }

  // ------------------------------------------------------------- page match

  function compilePattern(page) {
    try {
      // A trailing slash is optional, so "/issues/:id/" also matches "/issues/123".
      const pathname = (page.pathname || '/').replace(/\/+$/, '') + '{/}?';
      return new URLPattern({ hostname: page.hostname || '*', pathname });
    } catch {
      return null;
    }
  }

  const pageMatches = (cue) => !!compilePattern(cue.page)?.test(location.href);

  // Suggest a pattern from the current URL: segments that look like ids or
  // slugs (numbers, hashes, uuids, and whatever follows organizations/,
  // projects/ and the like) become named wildcards.
  function suggestPage() {
    const segs = location.pathname.split('/');
    const used = new Set();
    const name = (base) => {
      let n = base;
      for (let i = 2; used.has(n); i++) n = `${base}${i}`;
      used.add(n);
      return `:${n}`;
    };
    const OWNERS = { organizations: 'org', orgs: 'org', projects: 'project', teams: 'team', users: 'user', accounts: 'account', workspaces: 'workspace' };
    const out = segs.map((seg, i) => {
      if (!seg) return seg;
      const prev = segs[i - 1];
      if (OWNERS[prev]) return name(OWNERS[prev]);
      if (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^[0-9a-f-]{32,36}$/i.test(seg) || (/\d/.test(seg) && /[a-z]/i.test(seg) && seg.length >= 12)) return name('id');
      return seg.replace(/[:*?+(){}\\]/g, (c) => `\\${c}`);
    });
    return { hostname: location.hostname, pathname: out.join('/') || '/' };
  }

  // ------------------------------------------------------------ geometry

  function pageRect(r) {
    const { ox, oy, s } = api.view();
    return { l: (r.left - ox) / s, t: (r.top - oy) / s, r: (r.right - ox) / s, b: (r.bottom - oy) / s };
  }

  const viewportRect = () => ({ l: 0, t: 0, r: innerWidth, b: innerHeight });

  // One axis of a spotlight [s0, s1] inside a container [c0, c1].
  function axisRule(s0, s1, c0, c1, canStretch) {
    const a = s0 - c0;
    const b = c1 - s1;
    if (canStretch && Math.abs(a) <= FIT_TOLERANCE && Math.abs(b) <= FIT_TOLERANCE) return { pin: 'stretch', a: Math.round(a), b: Math.round(b) };
    const size = Math.round(s1 - s0);
    const offset = (s0 + s1) / 2 - (c0 + c1) / 2;
    if (Math.abs(offset) <= FIT_TOLERANCE) return { pin: 'center', offset: Math.round(offset), size };
    return a <= b ? { pin: 'start', inset: Math.round(a), size } : { pin: 'end', inset: Math.round(b), size };
  }

  function applyAxis(rule, c0, c1) {
    switch (rule.pin) {
      case 'stretch': return [c0 + rule.a, c1 - rule.b];
      case 'start': return [c0 + rule.inset, c0 + rule.inset + rule.size];
      case 'end': return [c1 - rule.inset - rule.size, c1 - rule.inset];
      default: { const m = (c0 + c1) / 2 + rule.offset; return [m - rule.size / 2, m + rule.size / 2]; }
    }
  }

  // The spotlight rect (screen coordinates) for a cue, from its anchor's box now.
  function cueRect(spec, anchorRect) {
    const c = anchorRect ? { l: anchorRect.left, t: anchorRect.top, r: anchorRect.right, b: anchorRect.bottom } : viewportRect();
    const [x0, x1] = applyAxis(spec.x, c.l, c.r);
    let [y0, y1] = applyAxis(spec.y, c.t, c.b);
    if (spec.shape === 'circle') { // a circle keeps its width as its height
      const m = (y0 + y1) / 2;
      [y0, y1] = [m - (x1 - x0) / 2, m + (x1 - x0) / 2];
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const isOurs = (el) => el?.localName === 'spotlight-overlay';

  // Pick what the recorded spotlight (page rect R) should be anchored to:
  //  1. an element it fits (each edge within FIT_TOLERANCE), so it follows
  //     that element's size;
  //  2. else the smallest element that contains it;
  //  3. else the viewport.
  // Only elements that can be found again (a non-empty fingerprint) count.
  function chooseAnchor(R, shapeName) {
    const { ox, oy, s } = api.view();
    const sx = ox + s * (R.l + R.r) / 2;
    const sy = oy + s * (R.t + R.b) / 2;
    const deepest = document.elementsFromPoint(sx, sy).find((el) => !isOurs(el));
    const chain = [];
    for (let el = deepest; el && el !== document.body && el !== document.documentElement; el = el.parentElement) chain.push(el);

    const box = shapeName !== 'circle';
    let best = null;
    if (box) {
      for (const el of chain) {
        const P = pageRect(el.getBoundingClientRect());
        const d = [R.l - P.l, R.t - P.t, P.r - R.r, P.b - R.b].map(Math.abs);
        if (Math.max(...d) > FIT_TOLERANCE) continue;
        const score = d.reduce((x, y) => x + y, 0);
        if (best && best.score <= score) continue;
        const fp = fingerprint(el);
        if (fp.length) best = { el, fp, P, score };
      }
      if (best) return best;
    }
    for (const el of chain) {
      const P = pageRect(el.getBoundingClientRect());
      if (P.l > R.l + 1 || P.t > R.t + 1 || P.r < R.r - 1 || P.b < R.b - 1) continue;
      const fp = fingerprint(el);
      if (fp.length) return { el, fp, P };
    }
    return null;
  }

  // ------------------------------------------------------------ running cues

  function stopRun() {
    if (!run) return;
    clearTimeout(run.timer);
    run = null;
  }

  // Wait for the anchor to exist and stop moving (a drawer sliding in, a
  // zoom-out finishing), scroll it into view if needed, then place.
  function runCue(cue) {
    stopRun();
    api.setZoom(false); // any spotlight interaction zooms out first
    const spec = cue.spotlight;
    const r = { cue, last: null, stable: 0, scrolled: false, deadline: performance.now() + (spec.timeoutMs || DEFAULT_TIMEOUT) };
    run = r;
    const poll = () => {
      if (run !== r) return;
      const anchor = spec.anchor ? resolve(spec.anchor) : null;
      const box = anchor?.getBoundingClientRect();
      if (spec.anchor && (!box || box.width < 1 || box.height < 1)) return retry('Cue: its target isn’t on the page at this window size');
      const key = box ? `${box.left},${box.top},${box.width},${box.height}` : `${innerWidth},${innerHeight}`;
      r.stable = key === r.last ? r.stable + 1 : 0;
      r.last = key;
      if (r.stable < STABLE_POLLS) return retry();
      const rect = cueRect(spec, box);
      if (anchor && spec.scroll !== false && !r.scrolled && (rect.y < 0 || rect.y + rect.h > innerHeight || rect.x < 0 || rect.x + rect.w > innerWidth)) {
        r.scrolled = true;
        r.stable = 0;
        r.deadline += 1500;
        anchor.scrollIntoView({ block: rect.h > innerHeight ? 'start' : 'nearest', inline: 'nearest', behavior: 'smooth' });
        return retry();
      }
      // Present but out of sight (a closed drawer parked off-screen, or a
      // spot scrolling couldn't reach): showing it would spotlight nothing.
      const seen = Math.max(0, Math.min(rect.x + rect.w, innerWidth) - Math.max(rect.x, 0)) * Math.max(0, Math.min(rect.y + rect.h, innerHeight) - Math.max(rect.y, 0));
      if (seen < 0.5 * rect.w * rect.h) return retry('Cue: its target is off-screen');
      run = null;
      clearPending();
      api.place(rect, { shape: spec.shape || 'rounded', zoom: !!spec.zoom });
    };
    const retry = (failure) => {
      if (performance.now() > r.deadline) {
        run = null;
        clearPending();
        api.showHud(failure || 'Cue: couldn’t find its target', 2200);
        return;
      }
      r.timer = setTimeout(poll, POLL_MS);
    };
    r.timer = setTimeout(poll, POLL_MS);
  }

  function clearPending() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* storage blocked */ }
  }

  // The cue whose trigger is (or contains) the clicked element, if any.
  function cueForClick(target) {
    for (const cue of cues) {
      if (!cue.enabled || !pageMatches(cue)) continue;
      const el = resolve(cue.trigger.element);
      if (el && el.contains(target)) return cue;
    }
    return null;
  }

  // Capture phase on window, registered after content.js's listeners: the
  // click that places a following spotlight is swallowed there and never
  // reaches us. Never prevents the page's own handling of the click.
  function onClick(e) {
    if (!e.isTrusted || e.button !== 0 || api.isOverlay(e)) return;
    if (rec) { onRecordClick(e); return; }
    if (!armed || !(e.target instanceof Element)) return;
    const cue = cueForClick(e.target);
    if (!cue) return;
    // If this click loads another page, the new page finishes the cue.
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id: cue.id, t: Date.now() })); } catch { /* storage blocked */ }
    runCue(cue);
  }

  // ------------------------------------------------------------- recording

  const UI_CSS = `
    .cue-bar {
      position: fixed; left: 50%; top: 14px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 14px;
      background: rgba(31, 22, 51, 0.96); border: 1px solid #fd44b0; border-radius: 999px;
      box-shadow: 0 4px 14px rgba(24, 18, 37, 0.45); pointer-events: auto;
      font: 500 13px/1 Rubik, system-ui, -apple-system, sans-serif; color: #fff; white-space: nowrap;
    }
    /* Moves to the bottom while the cursor is near the top, so it never hides
       what you want to click. */
    .cue-bar.low { top: auto; bottom: 64px; }
    .cue-bar [hidden] { display: none; }
    .cue-bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #fd44b0; animation: cue-pulse 1.2s ease-in-out infinite; }
    @keyframes cue-pulse { 50% { opacity: 0.3; } }
    .cue-bar .hint { color: #c6becf; font-weight: 400; }
    .cue-bar button {
      all: unset; cursor: pointer; padding: 6px 11px; border-radius: 999px; font-size: 12px;
      background: #362d59; color: #fff;
    }
    .cue-bar button:hover { background: #4a3e78; }
    .cue-bar button.save { background: #7553ff; }
    .cue-bar button.save:hover { background: #6a5fc1; }
    .cue-bar button:disabled { opacity: 0.4; cursor: default; background: #362d59; }
    .cue-bar button:focus-visible { outline: 2px solid #fd44b0; outline-offset: 2px; }
    .cue-pick {
      position: fixed; left: 0; top: 0; display: none; pointer-events: none; box-sizing: border-box;
      border: 2px solid #fd44b0; border-radius: 4px; background: rgba(253, 68, 176, 0.12);
    }
    .cue-pick span {
      position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; max-width: 320px; overflow: hidden; text-overflow: ellipsis;
      font: 500 11px/1 Rubik, system-ui, sans-serif; color: #fff; background: #fd44b0; padding: 4px 6px; border-radius: 4px; white-space: nowrap;
    }`;

  function ensureUi() {
    if (ui?.root.isConnected) return;
    const root = document.createElement('div');
    root.innerHTML = `<style>${UI_CSS}</style>
      <div class="cue-pick"><span></span></div>
      <div class="cue-bar" role="dialog" aria-label="Recording a cue">
        <i class="dot"></i><span class="msg"></span><span class="hint"></span>
        <button class="save" hidden>Save cue</button>
        <button class="cancel">Cancel</button>
      </div>`;
    api.mount(root);
    ui = {
      root,
      pick: root.querySelector('.cue-pick'),
      pickLabel: root.querySelector('.cue-pick span'),
      msg: root.querySelector('.msg'),
      hint: root.querySelector('.hint'),
      save: root.querySelector('.save'),
      bar: root.querySelector('.cue-bar'),
    };
    ui.save.addEventListener('click', saveRecording);
    root.querySelector('.cancel').addEventListener('click', () => endRecording('Recording cancelled'));
  }

  function syncUi() {
    if (!rec) return;
    ensureUi();
    if (rec.step === 'trigger') {
      ui.msg.textContent = 'Recording a cue: click the element that triggers it';
      ui.hint.textContent = 'Esc to cancel';
      ui.save.hidden = true;
    } else {
      const s = api.getSpot();
      ui.pick.style.display = 'none';
      ui.msg.textContent = !s.spotlight ? 'Turn the spotlight back on (⌥S) to place it' : s.pinned ? 'Size and place the spotlight, then save' : 'Click to place the spotlight';
      ui.hint.textContent = s.pinned ? (s.zoomed ? 'Zoomed: the cue will zoom too' : 'Not zoomed (🔍 to zoom)') : 'Trigger saved';
      ui.save.hidden = false;
      ui.save.disabled = !s.pinned;
    }
  }

  function startRecording() {
    stopRun();
    api.setSpotlight(false);
    rec = { step: 'trigger' };
    syncUi();
  }

  // The element to treat as the trigger: the interactive element around the
  // click target, or the target itself.
  const triggerElement = (target) => target.closest(INTERACTIVE) || target;

  function onRecordMove(e) {
    if (!rec || !ui) return;
    const low = ui.bar.classList.contains('low');
    if (!low && e.clientY < 90) ui.bar.classList.add('low');
    else if (low && e.clientY > innerHeight - 150) ui.bar.classList.remove('low');
    if (rec.step !== 'trigger') return;
    if (!(e.target instanceof Element) || api.isOverlay(e)) {
      ui.pick.style.display = 'none';
      return;
    }
    const el = triggerElement(e.target);
    const r = el.getBoundingClientRect();
    Object.assign(ui.pick.style, { display: 'block', transform: `translate(${r.left}px, ${r.top}px)`, width: `${r.width}px`, height: `${r.height}px` });
    ui.pickLabel.textContent = describe(el);
  }

  function onRecordClick(e) {
    if (rec.step !== 'trigger' || !(e.target instanceof Element)) return;
    const el = triggerElement(e.target);
    const fp = fingerprint(el);
    if (!fp.length) {
      // Can't tell it apart from similar elements: don't click it, try again.
      e.preventDefault();
      e.stopImmediatePropagation();
      api.showHud('Can’t identify that element. Try a nearby one.', 2200);
      return;
    }
    // The click goes through, so the page shows whatever it opens.
    rec = { step: 'spotlight', trigger: fp, name: describe(el), page: suggestPage() };
    try { sessionStorage.setItem(RECORDING_KEY, JSON.stringify({ ...rec, t: Date.now() })); } catch { /* storage blocked */ }
    setTimeout(beginSpotlightStep, 300);
  }

  function beginSpotlightStep() {
    if (rec?.step !== 'spotlight') return;
    api.setSpotlight(true);
    api.setShape('rounded'); // a cue has a width and a height
    syncUi();
  }

  async function saveRecording() {
    const s = api.getSpot();
    if (rec?.step !== 'spotlight' || !s.pinned) return;
    const R = { l: s.x - s.w / 2, t: s.y - s.h / 2, r: s.x + s.w / 2, b: s.y + s.h / 2 };
    const anchor = chooseAnchor(R, s.shape);
    const C = anchor?.P ?? viewportRect();
    const circle = s.shape === 'circle';
    const cue = {
      v: 1,
      id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: `Click “${rec.name.slice(0, 40)}”`,
      enabled: true,
      page: rec.page,
      trigger: { event: 'click', element: rec.trigger },
      spotlight: {
        anchor: anchor?.fp ?? null,
        anchorName: anchor ? describe(anchor.el) : null,
        shape: s.shape,
        x: axisRule(R.l, R.r, C.l, C.r, !circle),
        y: axisRule(R.t, R.b, C.t, C.b, !circle),
        zoom: s.zoomed,
        scroll: true,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      createdAt: Date.now(),
    };
    const { cues: stored = [] } = await chrome.storage.local.get('cues');
    await chrome.storage.local.set({ cues: [...stored, cue] });
    const where = !anchor ? 'placed on the window' : cue.spotlight.x.pin === 'stretch' && cue.spotlight.y.pin === 'stretch' ? `fits ${cue.spotlight.anchorName}` : `inside ${cue.spotlight.anchorName}`;
    endRecording(`Cue saved (${where})${armed ? '' : ' · arm cues to use it'}`);
  }

  function endRecording(message) {
    rec = null;
    try { sessionStorage.removeItem(RECORDING_KEY); } catch { /* storage blocked */ }
    ui?.root.remove();
    ui = null;
    api.setSpotlight(false);
    if (message) api.showHud(message, 2600);
  }

  function onKeyDown(e) {
    if (!rec) return;
    if (e.key === 'Escape') endRecording('Recording cancelled');
    else if (e.key === 'Enter' && rec.step === 'spotlight' && api.getSpot().pinned) saveRecording();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // ------------------------------------------------- extension integration

  function setCues(list) {
    cues = Array.isArray(list) ? list.filter((c) => c?.trigger?.element && c?.spotlight && c?.page) : [];
  }

  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.cues) setCues(changes.cues.newValue);
  }

  function setArmed(value, { announce = false } = {}) {
    armed = !!value;
    if (!armed) stopRun();
    if (announce && document.visibilityState === 'visible') {
      const n = cues.filter((c) => c.enabled && pageMatches(c)).length;
      api.showHud(armed ? `Cues armed · ${n} on this page` : 'Cues off', 1600);
    }
  }

  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.action) {
      case 'cuesArmed':
        setArmed(msg.value, { announce: true });
        sendResponse(api.getState());
        return;
      case 'pageCues':
        sendResponse({
          armed,
          recording: !!rec,
          cues: cues.filter(pageMatches).map(({ id, name, enabled }) => ({ id, name, enabled })),
        });
        return;
      case 'recordCue':
        startRecording();
        sendResponse({ ok: true });
        return;
      case 'testCue': {
        const cue = cues.find((c) => c.id === msg.id);
        if (cue) runCue(cue);
        sendResponse({ ok: !!cue });
        return;
      }
      default:
    }
  }

  // Finish what a click on the previous page started.
  function resumeAfterLoad() {
    try {
      const recording = JSON.parse(sessionStorage.getItem(RECORDING_KEY) || 'null');
      if (recording && Date.now() - recording.t < RECORDING_MAX_AGE) {
        rec = { step: 'spotlight', trigger: recording.trigger, name: recording.name, page: recording.page };
        beginSpotlightStep();
        return;
      }
      sessionStorage.removeItem(RECORDING_KEY);
      const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
      clearPending();
      const cue = pending && Date.now() - pending.t < PENDING_MAX_AGE && cues.find((c) => c.id === pending.id);
      if (cue && armed) {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)); // still pending until placed
        runCue(cue);
      }
    } catch { /* storage blocked or bad JSON */ }
  }

  const listeners = [
    [window, 'click', onClick, { capture: true }],
    [window, 'mousemove', onRecordMove, { capture: true, passive: true }],
    [window, 'keydown', onKeyDown, { capture: true }],
  ];

  function teardown() {
    document.removeEventListener(TEARDOWN_EVENT, teardown);
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    stopRun();
    ui?.root.remove();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // extension context already gone
    }
  }

  for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
  document.addEventListener(TEARDOWN_EVENT, teardown);
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  api.onState(syncUi);

  Promise.all([
    chrome.storage.local.get({ cues: [] }).then(({ cues: list }) => setCues(list)),
    chrome.runtime.sendMessage({ type: 'getCuesArmed' }).then((v) => setArmed(v)).catch(() => {}),
  ]).then(resumeAfterLoad).catch(() => {});
})();
