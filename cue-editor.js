// Spotlight — cue editor, shared by the popup's Cues tab and the cue manager.
//
// CueStore reads and writes the cue list in chrome.storage.local. Every write
// re-reads the list and changes one cue by id, so the popup, the manager and
// a recording page can't overwrite each other's changes.
//
// CueEditor.create(cue, hooks) returns a collapsible editor for one cue.
// Hooks (all optional except where noted):
//   test()       show this cue's spotlight on the page now
//   redraw()     place and size its spotlight again on the page
//   measure()    -> Promise<{ w, h } | null>: its anchor's current size, used
//                to convert between area modes without moving the spotlight
//   pick(what)   pick the trigger ('trigger') or end ('end') element on the page
//   check(fp)    -> Promise<{ counts, found } | null>: what a fingerprint finds
//                on the page now (and outline it there)
//   changed(cue) called after each saved change (e.g. to refresh a preview)
// The spotlight's area rules are explained at the top of cues.js.

const CueStore = {
  async all() {
    const { cues = [] } = await chrome.storage.local.get('cues');
    return Array.isArray(cues) ? cues : [];
  },
  async update(id, fn) {
    const cues = await CueStore.all();
    const cue = cues.find((c) => c.id === id);
    if (!cue) return null;
    fn(cue);
    await chrome.storage.local.set({ cues });
    return cue;
  },
  async remove(id) {
    const cues = await CueStore.all();
    await chrome.storage.local.set({ cues: cues.filter((c) => c.id !== id) });
  },
  async add(list) {
    const byId = new Map((await CueStore.all()).map((c) => [c.id, c]));
    for (const cue of list) byId.set(cue.id, cue);
    await chrome.storage.local.set({ cues: [...byId.values()] });
  },
};

const CueEditor = (() => {
  const AXES = {
    x: { label: 'Width', edges: ['left', 'right'], dim: 'w' },
    y: { label: 'Height', edges: ['top', 'bottom'], dim: 'h' },
  };
  const FALLBACK_LENGTH = 600; // assumed anchor size when it can't be measured

  function validPattern(page) {
    try {
      new URLPattern({ hostname: page.hostname || '*', pathname: (page.pathname || '/').replace(/\/+$/, '') + '{/}?' });
      return true;
    } catch {
      return false;
    }
  }

  const isFit = (sp) => sp.x.pin === 'stretch' && sp.y.pin === 'stretch';
  const anchorWord = (sp) => (sp.anchor ? `“${sp.anchorName || 'element'}”` : 'the window');

  function summary(cue) {
    const sp = cue.spotlight;
    return `${isFit(sp) ? 'Fits' : 'In'} ${anchorWord(sp)} · ${sp.shape === 'circle' ? 'circle' : 'box'}${sp.zoom ? ' · zoom' : ''}`;
  }

  // The spotlight's span [s0, s1] along an axis of length L, and back.
  function span(rule, L) {
    switch (rule.pin) {
      case 'stretch': return [rule.a, L - rule.b];
      case 'start': return [rule.inset, rule.inset + rule.size];
      case 'end': return [L - rule.inset - rule.size, L - rule.inset];
      default: { const m = L / 2 + rule.offset; return [m - rule.size / 2, m + rule.size / 2]; }
    }
  }

  function ruleFor(pin, [s0, s1], L) {
    const size = Math.max(1, Math.round(s1 - s0));
    switch (pin) {
      case 'stretch': return { pin, a: Math.round(s0), b: Math.round(L - s1) };
      case 'start': return { pin, inset: Math.round(s0), size };
      case 'end': return { pin, inset: Math.round(L - s1), size };
      default: return { pin, offset: Math.round((s0 + s1) / 2 - L / 2), size };
    }
  }

  // The numbers shown for each mode, and how to write them back. Padding is
  // shown as outward from the anchor (the stored insets are inward).
  function fields(rule, axis) {
    const [e0, e1] = AXES[axis].edges;
    switch (rule.pin) {
      case 'stretch': return [
        { label: `Pad ${e0}`, value: -rule.a, set: (v) => { rule.a = -v; } },
        { label: `Pad ${e1}`, value: -rule.b, set: (v) => { rule.b = -v; } },
      ];
      case 'start': return [
        { label: 'Size', value: rule.size, min: 20, set: (v) => { rule.size = v; } },
        { label: `From ${e0}`, value: rule.inset, set: (v) => { rule.inset = v; } },
      ];
      case 'end': return [
        { label: 'Size', value: rule.size, min: 20, set: (v) => { rule.size = v; } },
        { label: `From ${e1}`, value: rule.inset, set: (v) => { rule.inset = v; } },
      ];
      default: return [
        { label: 'Size', value: rule.size, min: 20, set: (v) => { rule.size = v; } },
        { label: 'Offset', value: rule.offset, set: (v) => { rule.offset = v; } },
      ];
    }
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function check(label, checked, onChange) {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { className: 'ce-check' }, input, label);
  }

  function create(initial, hooks = {}) {
    let cue = structuredClone(initial);

    // Save a change: apply it to our copy and to the stored cue.
    async function change(fn) {
      fn(cue);
      const saved = await CueStore.update(cue.id, fn);
      if (saved) {
        head.summary.textContent = summary(cue);
        hooks.changed?.(cue);
      }
    }

    const root = el('details', { className: 'ce' });
    root.classList.toggle('off', !cue.enabled);

    // Header (always visible): enabled, name, test.
    const enabled = el('input', { type: 'checkbox', checked: cue.enabled, title: 'Enabled', ariaLabel: 'Enabled' });
    const head = {
      name: el('span', { className: 'ce-name', textContent: cue.name, title: cue.name }),
      summary: el('span', { className: 'ce-sum', textContent: summary(cue) }),
    };
    const sumEl = el('summary', {}, enabled, el('span', { className: 'ce-title' }, head.name, head.summary));
    if (hooks.test) {
      const test = el('button', { type: 'button', className: 'ce-btn', textContent: 'Test', title: 'Show this cue’s spotlight now' });
      test.addEventListener('click', (e) => { e.preventDefault(); hooks.test(cue); });
      sumEl.append(test);
    }
    const trash = el('button', { type: 'button', className: 'ce-btn ce-icon ce-danger', title: 'Delete this cue', ariaLabel: 'Delete cue' });
    trash.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.5h6.6l.7-8.5M6.8 7v4M9.2 7v4"/></svg>';
    trash.addEventListener('click', (e) => { e.preventDefault(); remove(); });
    sumEl.append(trash);
    // Clicks on the checkbox shouldn't open or close the editor.
    enabled.addEventListener('click', (e) => e.stopPropagation());
    enabled.addEventListener('change', () => {
      root.classList.toggle('off', !enabled.checked);
      change((c) => { c.enabled = enabled.checked; });
    });
    root.append(sumEl);

    const body = el('div', { className: 'ce-body' });
    root.append(body);

    // Name
    const name = el('input', { type: 'text', value: cue.name, ariaLabel: 'Name' });
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!v) { name.value = cue.name; return; }
      head.name.textContent = head.name.title = v;
      change((c) => { c.name = v; });
    });
    body.append(row('Name', name));

    // Page pattern
    const host = el('input', { type: 'text', value: cue.page.hostname, placeholder: 'any host', ariaLabel: 'Host name' });
    const path = el('input', { type: 'text', value: cue.page.pathname, ariaLabel: 'Path pattern' });
    const pageError = el('div', { className: 'ce-error', hidden: true, textContent: 'Not a valid pattern. Use :name for one segment, * for anything.' });
    const onPage = (commit) => {
      const page = { hostname: host.value.trim(), pathname: path.value.trim() || '/' };
      const ok = validPattern(page);
      pageError.hidden = ok;
      path.classList.toggle('invalid', !ok);
      if (ok && commit) change((c) => { c.page = page; });
    };
    for (const input of [host, path]) {
      input.addEventListener('input', () => onPage(false));
      input.addEventListener('change', () => onPage(true));
    }
    body.append(row('Page', el('div', { className: 'ce-stack' }, host, path, pageError)));

    // Trigger: re-pick it on the page, or edit how it's found.
    body.append(row('Trigger', elementEditor({
      what: 'trigger',
      get: () => cue.trigger.element,
      label: () => cue.trigger.name,
      set: (fp) => change((c) => { c.trigger = { ...c.trigger, element: fp }; }),
      describe: (name) => `Click on ${name}`,
    })));

    // Spotlight area
    const area = el('div', { className: 'ce-area' });
    body.append(row('Area', area));
    renderArea();

    function renderArea() {
      const sp = cue.spotlight;
      area.textContent = '';
      const anchorNote = el('div', { className: 'ce-note', textContent: sp.anchor ? `Placed relative to ${anchorWord(sp)}` : 'Placed relative to the window' });
      area.append(anchorNote);
      for (const axis of ['x', 'y']) area.append(axisEditor(axis));
      if (hooks.redraw) {
        const redraw = el('button', { type: 'button', className: 'ce-btn', textContent: 'Redraw on page', title: 'Place and size this spotlight again on the page' });
        redraw.addEventListener('click', () => hooks.redraw(cue));
        area.append(redraw);
      }
    }

    function axisEditor(axis) {
      const { label, edges, dim } = AXES[axis];
      const sp = cue.spotlight;
      const rule = sp[axis];
      const circleHeight = sp.shape === 'circle' && axis === 'y';
      const mode = el('select', { ariaLabel: `${label} mode` });
      const modes = [
        ['stretch', `Follows ${sp.anchor ? 'element' : 'window'}`],
        ['start', `Fixed, from ${edges[0]}`],
        ['end', `Fixed, from ${edges[1]}`],
        ['center', 'Fixed, centred'],
      ];
      for (const [value, text] of modes) mode.append(el('option', { value, textContent: text, selected: rule.pin === value }));
      mode.addEventListener('change', async () => {
        // Convert so the spotlight stays where it is at the anchor's current size.
        const size = await hooks.measure?.(cue);
        const L = size?.[dim] ?? FALLBACK_LENGTH;
        const next = ruleFor(mode.value, span(rule, L), L);
        await change((c) => { c.spotlight[axis] = next; });
        renderArea();
      });
      const inputs = fields(rule, axis).map((f) => {
        if (circleHeight && f.label === 'Size') return null; // a circle's height is its width
        const input = el('input', { type: 'number', value: f.value, step: 1, min: f.min ?? -2000, max: 4000, ariaLabel: `${label} ${f.label}` });
        input.addEventListener('change', () => {
          const v = Math.round(Number(input.value));
          if (!Number.isFinite(v)) { input.value = f.value; return; }
          change((c) => {
            // fields() writes into the rule object it was given.
            const target = c.spotlight[axis];
            fields(target, axis).find((g) => g.label === f.label).set(v);
          });
        });
        return el('label', { className: 'ce-num' }, el('span', { textContent: f.label }), input, el('span', { className: 'ce-unit', textContent: 'px' }));
      }).filter(Boolean);
      return el('div', { className: 'ce-axis' }, el('span', { className: 'ce-axis-label', textContent: label }), mode, el('div', { className: 'ce-nums' }, ...inputs));
    }

    // Shape
    const shape = el('div', { className: 'ce-seg' });
    for (const [value, text] of [['rounded', 'Box'], ['circle', 'Circle']]) {
      const b = el('button', { type: 'button', textContent: text });
      b.setAttribute('aria-pressed', String((cue.spotlight.shape || 'rounded') === value));
      b.addEventListener('click', async () => {
        for (const other of shape.children) other.setAttribute('aria-pressed', String(other === b));
        await change((c) => { c.spotlight.shape = value; });
        renderArea();
      });
      shape.append(b);
    }
    body.append(row('Shape', shape));

    // How the cue's spotlight ends (optional)
    const ends = el('div', { className: 'ce-stack' });
    body.append(row('Ends', ends));
    renderEnds();

    function renderEnds() {
      ends.textContent = '';
      // No field (older cues) means the default: a click outside.
      const end = cue.deactivate === undefined ? { on: 'outside' } : cue.deactivate;
      const mode = el('select', { ariaLabel: 'How the spotlight ends' });
      const modes = [
        ['outside', 'Click outside the spotlight (default)'],
        ['element', 'Click on an element'],
        ['timer', 'After a delay'],
        ['', 'Manually only (✕ or ⌥S)'],
      ];
      for (const [value, text] of modes) mode.append(el('option', { value, textContent: text, selected: (end?.on ?? '') === value }));
      mode.addEventListener('change', async () => {
        const next = mode.value === 'element' ? { on: 'element', element: null, name: null }
          : mode.value === 'outside' ? { on: 'outside' }
            : mode.value === 'timer' ? { on: 'timer', ms: 5000 } : null;
        await change((c) => { c.deactivate = next; });
        renderEnds();
      });
      ends.append(mode);
      if (end?.on === 'element') {
        ends.append(elementEditor({
          what: 'end',
          get: () => cue.deactivate?.element,
          label: () => cue.deactivate?.name,
          set: (fp) => change((c) => { c.deactivate = { ...c.deactivate, element: fp }; }),
          describe: (name) => `Ends on a click on ${name}`,
        }));
      } else if (end?.on === 'timer') {
        const secs = el('input', { type: 'number', value: end.ms / 1000, min: 1, max: 600, step: 1, ariaLabel: 'Seconds until the spotlight ends' });
        secs.addEventListener('change', () => {
          const v = Math.min(600, Math.max(1, Math.round(Number(secs.value)) || 5));
          secs.value = v;
          change((c) => { c.deactivate = { on: 'timer', ms: v * 1000 }; });
        });
        ends.append(el('label', { className: 'ce-num' }, el('span', { textContent: 'After' }), secs, el('span', { className: 'ce-unit', textContent: 's' })));
      }
    }

    // Options
    const wait = el('input', { type: 'number', value: (cue.spotlight.timeoutMs ?? 3000) / 1000, min: 0.5, max: 15, step: 0.5, ariaLabel: 'Wait up to (seconds)' });
    wait.addEventListener('change', () => {
      const v = Math.min(15, Math.max(0.5, Number(wait.value) || 3));
      wait.value = v;
      change((c) => { c.spotlight.timeoutMs = Math.round(v * 1000); });
    });
    body.append(row('Options', el('div', { className: 'ce-stack' },
      check('Zoom in', !!cue.spotlight.zoom, (v) => change((c) => { c.spotlight.zoom = v; })),
      check('Scroll into view', cue.spotlight.scroll !== false, (v) => change((c) => { c.spotlight.scroll = v; })),
      el('label', { className: 'ce-num' }, el('span', { textContent: 'Wait up to' }), wait, el('span', { className: 'ce-unit', textContent: 's' })),
    )));

    // Delete
    async function remove() {
      if (!confirm(`Delete “${cue.name}”?`)) return;
      await CueStore.remove(cue.id);
      root.remove();
      hooks.deleted?.(cue);
    }
    const del = el('button', { type: 'button', className: 'ce-btn ce-danger', textContent: 'Delete cue' });
    del.addEventListener('click', remove);
    body.append(el('div', { className: 'ce-foot' }, del));

    // An element a cue looks for (its trigger, or the one that ends it): a
    // summary, Pick on page / Check on page, and its matching strategies,
    // which can be edited, added and removed. A strategy is a CSS selector,
    // optionally narrowed to elements with an exact accessible name; the
    // first one that finds exactly one element is used.
    function elementEditor({ what, get, label, set, describe }) {
      const box = el('div', { className: 'ce-el' });
      render();
      return box;

      function render() {
        box.textContent = '';
        const fp = get() || [];
        const named = label() || fp.find((st) => st.name)?.name;
        box.append(el('div', { className: 'ce-note', textContent: fp.length ? describe(named ? `“${named}”` : fp[0].sel) : 'No element picked yet' }));

        const status = el('div', { className: 'ce-note ce-status', hidden: true });
        const actions = el('div', { className: 'ce-actions' });
        if (hooks.pick) {
          const pick = el('button', { type: 'button', className: 'ce-btn', textContent: fp.length ? 'Pick on page' : 'Pick element on page', title: 'Click the element on the page' });
          pick.addEventListener('click', () => hooks.pick(cue, what));
          actions.append(pick);
        }
        const counts = [];
        if (hooks.check && fp.length) {
          const checkBtn = el('button', { type: 'button', className: 'ce-btn', textContent: 'Check on page', title: 'Outline what this finds on the page' });
          checkBtn.addEventListener('click', async () => {
            const result = await hooks.check(get());
            status.hidden = false;
            if (!result) { status.textContent = 'Can’t check on this page'; return; }
            status.textContent = result.found ? `Finds “${result.found}” (outlined on the page)` : 'Finds nothing on this page right now';
            status.classList.toggle('ce-bad', !result.found);
            result.counts.forEach((n, i) => {
              if (!counts[i]) return;
              counts[i].textContent = n === 1 ? '1 match' : `${n} matches`;
              counts[i].classList.toggle('ce-bad', n !== 1);
            });
          });
          actions.append(checkBtn);
        }
        if (!hooks.pick && !fp.length) actions.append(el('div', { className: 'ce-note', textContent: 'Pick it from the popup’s Cues tab, on the cue’s page.' }));
        if (actions.children.length) box.append(actions);
        box.append(status);

        if (!fp.length) return;
        const adv = el('details', { className: 'ce-adv' });
        adv.append(el('summary', { textContent: `Matching (${fp.length} way${fp.length === 1 ? '' : 's'})` }));
        fp.forEach((st, i) => {
          const sel = el('input', { type: 'text', value: st.sel, spellcheck: false, ariaLabel: `Selector ${i + 1}`, placeholder: 'CSS selector' });
          const name = el('input', { type: 'text', value: st.name ?? '', ariaLabel: `Name ${i + 1}`, placeholder: 'any name' });
          const removeBtn = el('button', { type: 'button', className: 'ce-btn ce-icon', textContent: '×', title: 'Remove this way of finding it', ariaLabel: `Remove ${i + 1}` });
          counts[i] = el('span', { className: 'ce-count' });
          const save = () => {
            const value = sel.value.trim();
            const ok = validSelector(value);
            sel.classList.toggle('invalid', !ok);
            if (!ok) return;
            const next = structuredClone(get());
            const kind = st.kind === 'custom' || st.kind.endsWith('(edited)') ? st.kind : `${st.kind} (edited)`;
            next[i] = { kind, sel: value };
            if (name.value.trim()) next[i].name = name.value.trim();
            set(next);
          };
          sel.addEventListener('change', save);
          name.addEventListener('change', save);
          removeBtn.disabled = fp.length === 1; // keep at least one
          removeBtn.addEventListener('click', async () => {
            await set(get().filter((_, j) => j !== i));
            render();
          });
          adv.append(el('div', { className: 'ce-strat' },
            el('div', { className: 'ce-strat-head' }, el('span', { textContent: `${i + 1}. ${st.kind}` }), counts[i], removeBtn),
            sel, name));
        });
        const add = el('button', { type: 'button', className: 'ce-btn', textContent: 'Add a selector' });
        add.addEventListener('click', async () => {
          await set([...get(), { kind: 'custom', sel: fp[0].sel }]);
          render();
          box.querySelector('.ce-adv').open = true;
        });
        adv.append(el('div', { className: 'ce-hint', textContent: 'Tried in order; the first that finds exactly one element is used.' }), add);
        box.append(adv);
      }
    }

    return root;
  }

  function validSelector(sel) {
    if (!sel) return false;
    try {
      document.createDocumentFragment().querySelector(sel);
      return true;
    } catch {
      return false;
    }
  }

  function row(label, content) {
    return el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: label }), content);
  }

  const isCue = (c) => c && typeof c.id === 'string' && c.page && c.trigger?.element?.length && c.spotlight?.x && c.spotlight?.y;

  return { create, isCue, validPattern };
})();
