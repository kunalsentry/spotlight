// Spotlight — content script.
//
// The spotlight is a click-through, viewport-sized layer (inside a closed
// shadow root attached to <html>) that applies the chosen effect — dim, blur,
// or both — to everything except a hole. The hole is an SVG shape used as a
// CSS mask layer, combined with a full-coverage layer via mask-composite:
// exclude, so any shape and an optional soft edge work with any effect.
//
// Flow: activate -> the spotlight follows the cursor -> click to place it ->
// drag it by its edge or the toolbar handle; the page underneath stays fully
// usable (scroll, click, type). The toolbar also re-enables following, zooms
// the page so the spotlit area fills the screen, and closes the spotlight.
//
// Zoom is a CSS transform on <body> (the overlay lives on <html>, so it isn't
// scaled), animated so the spotlight's centre glides to the middle of the
// viewport while the page scales up around it.

(() => {
  'use strict';

  // If an older copy of this script is still in the page (the extension was
  // reloaded, or we were re-injected), tell it to clean up before we start.
  // DOM events cross content-script worlds, so this reaches orphaned copies.
  const TEARDOWN_EVENT = 'spotlight:teardown';
  document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT));

  const DEFAULTS = {
    shape: 'circle',   // circle | rounded
    width: 280,        // px (the diameter for a circle)
    height: 180,       // px (ignored for a circle)
    effect: 'dim',     // dim | blur | blur-dim
    intensity: 70,     // 0..100, meaning depends on the effect
    autoZoomResize: true, // zoom in after resizing a placed spotlight with a handle
    autoZoomPlace: false, // zoom in as soon as the spotlight is placed (stops following)
  };
  const MIN_SIZE = 60;
  const ROUNDED_RADIUS = 18;
  const SOFT_EDGE = 6;      // px of feathering on the spotlight edge
  const GRAB_WIDTH = 18;    // px of the edge you can grab to drag
  const RING_MARGIN = 12;   // room around the shape inside the ring SVG
  const FOLLOW_EASE = 0.35; // per-frame easing toward the cursor
  const SIZE_EASE = 0.2;    // per-frame easing toward a new size
  const ZOOM_EASE = 0.16;   // per-frame easing of the zoom animation
  const ZOOM_FILL = 0.8;    // preferred: the zoomed spotlight fills 80% of the window, keeping context
  const ZOOM_MIN_GAIN = 1.25; // large spotlights still zoom at least this much, if it fits
  const ZOOM_MARGIN = 12;   // px kept clear between a zoomed spotlight and the window edge
  const TOOLBAR_GAP = 16;   // px between the spotlight and its toolbar
  const MAX_ZOOM = 6;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let settings = { ...DEFAULTS };
  const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
  const spot = {
    active: false,
    pinned: false,
    x: mouse.x, y: mouse.y,       // rendered centre
    pinX: mouse.x, pinY: mouse.y, // placed centre
  };
  let maskSize = { w: 0, h: 0 }; // size of the hole's mask image (shape + feather)
  // Size set by the resize handles on a placed spotlight. It's
  // temporary: going back to following the cursor, or turning the spotlight
  // off, returns to the configured size from the popup.
  let sizeOverride = null;       // { w, h } or null
  let drawn = null;              // size currently on screen, eases toward shapeSize()
  let drag = null;               // { pointerId, offX, offY } while dragging
  // The zoom is one view transform: a page point v (in normal, unzoomed
  // viewport coordinates) is shown at  screen = o + s·v.  `view` eases toward
  // `goal` each frame, all components by the same fraction, so any point that
  // starts and ends at the same screen spot stays put throughout. The
  // spotlight's own coordinates (spot.*) are page coordinates.
  //   mode 'in'       zoomed in on the spotlight
  //   mode 'anchored' back at normal size, offset so the point under the
  //                   pointer when a drag started stays under it
  //   mode 'out'      returning to the normal view; ends the zoom
  // `base` is <body>'s unscaled top-left; `saved` its inline transform
  // styles, restored when the zoom ends.
  const IDENTITY = { ox: 0, oy: 0, s: 1 };
  const zoom = { mode: 'none', view: { ...IDENTITY }, goal: { ...IDENTITY }, el: null, base: null, saved: null };
  let swallowClick = false;      // eat the rest of the click that placed the spotlight
  let swallowTimer = 0;
  let rafId = 0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // The spotlight can be as large as the viewport (a circle up to its longer
  // side). Stored sizes beyond that are kept, just drawn clamped.
  function maxSize() {
    const w = Math.max(MIN_SIZE, innerWidth);
    const h = Math.max(MIN_SIZE, innerHeight);
    return settings.shape === 'circle' ? { w: Math.max(w, h), h: Math.max(w, h) } : { w, h };
  }

  function shapeSize() {
    const max = maxSize();
    const src = sizeOverride ?? { w: settings.width, h: settings.height };
    const w = clamp(src.w, MIN_SIZE, max.w);
    const h = settings.shape === 'circle' ? w : clamp(src.h, MIN_SIZE, max.h);
    return { w, h };
  }

  function cornerRadii(w, h) {
    if (settings.shape === 'circle') return { rx: w / 2, ry: h / 2 };
    const r = Math.min(ROUNDED_RADIUS, w / 2, h / 2);
    return { rx: r, ry: r };
  }

  // Map settings saved by older versions (more shapes/effects) onto the
  // current options.
  function normalizeSettings() {
    if (!['circle', 'rounded'].includes(settings.shape)) {
      settings.shape = settings.shape === 'ellipse' ? 'circle' : 'rounded';
    }
    if (!['dim', 'blur', 'blur-dim'].includes(settings.effect)) settings.effect = 'dim';
  }

  // ---------------------------------------------------------------- overlay

  let host = null;
  let zoomBtn, rootEl, maskEl, ringEl, grabRect, lineRect, haloRect, handlesEl, handleEls, toolbarEl, hudEl;
  let hudTimer = 0;

  const ICONS = {
    move: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="3" r="1.4"/><circle cx="11" cy="3" r="1.4"/><circle cx="5" cy="8" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="13" r="1.4"/></svg>',
    follow: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/></svg>',
    zoomIn: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14M5 7h4M7 5v4"/></svg>',
    zoomOut: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14M5 7h4"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  };

  function ensureOverlay() {
    if (host?.isConnected) return;
    host = document.createElement('spotlight-overlay');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .root { position: fixed; inset: 0; pointer-events: none; }
        .mask {
          position: fixed; inset: 0; pointer-events: none;
          mask-repeat: no-repeat; mask-composite: exclude;
          opacity: 0; transition: opacity 180ms ease;
        }
        .ring {
          position: fixed; left: 0; top: 0; overflow: visible; pointer-events: none;
          opacity: 0; transition: opacity 180ms ease; will-change: transform;
        }
        .on .mask, .on .ring { opacity: 1; }
        /* Dashed outline: hidden while the cursor is outside the spotlight,
           faint inside it, and clearly visible near the edge (where it can be
           grabbed) or while dragging/resizing. White dashes over a dark halo
           so it reads on both light and dark pages. */
        .ring .outline { opacity: 0; transition: opacity 160ms ease; }
        .ring .line, .ring .halo { fill: none; stroke-dasharray: 6 5; transition: stroke-width 160ms ease; }
        .ring .line { stroke: #fff; stroke-width: 1.5; }
        .ring .halo { stroke: rgba(0, 0, 0, 0.45); stroke-width: 3.5; }
        .ring .grab { fill: none; stroke: transparent; stroke-width: ${GRAB_WIDTH}; pointer-events: none; }
        .pinned .ring .grab { pointer-events: stroke; cursor: grab; }
        .inside .ring .outline { opacity: 0.55; }
        .edge .ring .outline { opacity: 1; }
        .edge .ring .line { stroke-width: 2; }
        .edge .ring .halo { stroke-width: 4; }
        .dragging, .dragging * { cursor: grabbing !important; }

        .handles { position: fixed; left: 0; top: 0; display: none; pointer-events: none; will-change: transform; }
        .on.pinned .handles { display: block; }
        .handle {
          position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; box-sizing: border-box;
          border-radius: 3px; background: #fff; pointer-events: auto; cursor: nwse-resize;
          box-shadow: 0 0 0 1.5px #7553ff, 0 1px 3px rgba(24, 18, 37, 0.5);
          opacity: 0; transition: opacity 160ms ease, transform 120ms ease;
        }
        .handle:hover { transform: scale(1.25); }
        /* Same visibility as the outline. Hidden handles stay grabbable, and
           since they sit on the outline, reaching one counts as "near the edge"
           and reveals it. */
        .inside .handle { opacity: 0.55; }
        .edge .handle { opacity: 1; }

        .toolbar {
          position: fixed; left: 0; top: 0; display: none; gap: 2px; padding: 3px;
          background: rgba(31, 22, 51, 0.95); border: 1px solid #362d59; border-radius: 9px;
          box-shadow: 0 4px 14px rgba(24, 18, 37, 0.45);
          pointer-events: auto; will-change: transform;
        }
        .on.pinned .toolbar { display: flex; }
        /* When the toolbar has to sit over the spotlight area ("inset"), it
           goes nearly transparent so it doesn't hide what's being shown;
           fully visible on hover/keyboard focus, and briefly ("peek") when it
           first appears or the zoom changes, so it's easy to find. Above or
           below the spotlight it's always fully visible. */
        .toolbar { transition: opacity 180ms ease; }
        .toolbar.inset { opacity: 0.15; }
        .toolbar.inset:hover, .toolbar.inset:focus-within, .toolbar.inset.peek, .dragging .toolbar.inset { opacity: 1; }
        .toolbar button {
          all: unset; box-sizing: border-box; width: 28px; height: 26px; border-radius: 6px;
          display: grid; place-items: center; color: #ececf1; cursor: pointer;
        }
        .toolbar button:hover { background: #362d59; color: #fff; }
        .toolbar button:focus-visible { outline: 2px solid #7553ff; outline-offset: -2px; }
        .toolbar button.move { cursor: grab; }
        .toolbar button.close:hover { background: #c73852; color: #fff; }
        /* Keep "turn off" apart from everything else, and while zoomed make
           zoom-out its own labelled, accented button so the two can't be
           mistaken for each other. */
        .toolbar .sep { width: 1px; margin: 4px 3px; background: #362d59; }
        .toolbar button.zoom.active {
          width: auto; padding: 0 10px 0 8px; gap: 5px; display: flex; align-items: center;
          background: #7553ff; color: #fff; font: 500 12px/1 Rubik, system-ui, -apple-system, sans-serif;
        }
        .toolbar button.zoom.active:hover { background: #6a5fc1; }

        .hud {
          position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
          font: 500 13px/1 Rubik, system-ui, -apple-system, sans-serif; white-space: nowrap;
          color: #fff; background: rgba(31, 22, 51, 0.92); border: 1px solid #362d59;
          padding: 9px 14px; border-radius: 999px;
          opacity: 0; transition: opacity 200ms ease; pointer-events: none;
        }
        .hud.show { opacity: 1; }
        .hud.top { top: 20px; bottom: auto; } /* out of the toolbar's way */
      </style>
      <div class="root">
        <div class="mask"></div>
        <svg class="ring" xmlns="${SVG_NS}">
          <rect class="grab"></rect>
          <g class="outline"><rect class="halo"></rect><rect class="line"></rect></g>
        </svg>
        <div class="handles">
          <div class="handle" data-corner="nw" title="Drag to resize"></div>
          <div class="handle" data-corner="se" title="Drag to resize"></div>
        </div>
        <div class="toolbar" role="toolbar" aria-label="Spotlight">
          <button class="move" title="Drag to move">${ICONS.move}</button>
          <button class="follow" title="Follow the cursor again">${ICONS.follow}</button>
          <button class="zoom" title="Zoom in to the spotlight">${ICONS.zoomIn}</button>
          <span class="sep" aria-hidden="true"></span>
          <button class="close" title="Turn off spotlight">${ICONS.close}</button>
        </div>
        <div class="hud"></div>
      </div>`;
    rootEl = root.querySelector('.root');
    maskEl = root.querySelector('.mask');
    ringEl = root.querySelector('.ring');
    grabRect = root.querySelector('.grab');
    lineRect = root.querySelector('.line');
    haloRect = root.querySelector('.halo');
    toolbarEl = root.querySelector('.toolbar');
    hudEl = root.querySelector('.hud');
    handlesEl = root.querySelector('.handles');
    handleEls = [...root.querySelectorAll('.handle')];

    for (const el of [grabRect, root.querySelector('.move'), ...handleEls]) {
      el.addEventListener('pointerdown', onDragStart);
      el.addEventListener('pointermove', onDragMove);
      el.addEventListener('pointerup', onDragEnd);
      el.addEventListener('pointercancel', onDragEnd);
    }
    root.querySelector('.follow').addEventListener('click', () => setPinned(false));
    root.querySelector('.close').addEventListener('click', () => setSpotlight(false));
    zoomBtn = root.querySelector('.zoom');
    zoomBtn.addEventListener('click', () => setZoom(zoom.mode !== 'in'));

    document.documentElement.appendChild(host);
    applyShape();
    applyEffect();
  }

  // The hole: an SVG of the shape (black on transparent), feathered with a
  // Gaussian blur, used as the top mask layer and excluded from a full layer.
  // Size changes (popup sliders, returning to the configured size) ease
  // toward the new size over a few frames; `instant` is for the resize handle,
  // which must track the pointer exactly, and for the first draw.
  function applyShape(instant = false) {
    if (!maskEl) return;
    const target = shapeSize();
    if (instant || !drawn || !spot.active) drawShape(target.w, target.h);
    else {
      drawShape(drawn.w, drawn.h); // pick up shape/softness changes right away
      startLoop();
    }
  }

  function drawShape(w, h) {
    drawn = { w, h };
    clampPin();
    paint();
  }

  // Where the spotlight is on screen: its own centre/size, or — while zoomed —
  // gliding toward the viewport centre and scaled up with the page.
  function visual() {
    if (!zoom.el) return { x: spot.x, y: spot.y, w: drawn.w, h: drawn.h };
    const { ox, oy, s: k } = zoom.view;
    return { x: ox + k * spot.x, y: oy + k * spot.y, w: drawn.w * k, h: drawn.h * k };
  }

  // Screen point -> page point under it, through the current zoom view.
  function toPage(x, y) {
    if (!zoom.el) return { x, y };
    const { ox, oy, s: k } = zoom.view;
    return { x: (x - ox) / k, y: (y - oy) / k };
  }


  // Rebuild the hole, outline and handle geometry for the on-screen size.
  function paint() {
    if (!maskEl || !drawn) return;
    const { w, h } = visual();
    const { rx, ry } = cornerRadii(w, h);
    const soft = SOFT_EDGE;
    const pad = soft * 2;
    const W = w + pad * 2;
    const H = h + pad * 2;
    const filter = soft
      ? `<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${soft / 2}"/></filter>`
      : '';
    const svg = `<svg xmlns="${SVG_NS}" width="${W}" height="${H}">${filter}`
      + `<rect x="${pad}" y="${pad}" width="${w}" height="${h}" rx="${rx}" ry="${ry}" fill="#000"${soft ? ' filter="url(#f)"' : ''}/></svg>`;
    maskEl.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}"), linear-gradient(#000, #000)`;
    maskEl.style.maskSize = `${W}px ${H}px, 100% 100%`;
    maskSize = { w: W, h: H };

    // Outline + grab zone share the shape's geometry.
    ringEl.setAttribute('width', w + RING_MARGIN * 2);
    ringEl.setAttribute('height', h + RING_MARGIN * 2);
    for (const rect of [grabRect, haloRect, lineRect]) {
      rect.setAttribute('x', RING_MARGIN);
      rect.setAttribute('y', RING_MARGIN);
      rect.setAttribute('width', w);
      rect.setAttribute('height', h);
      rect.setAttribute('rx', rx);
      rect.setAttribute('ry', ry);
    }
    // The resize handle sits on the outline at its bottom-right, 45° point.
    const inset = (r) => r * (1 - Math.SQRT1_2);
    for (const el of handleEls) {
      const se = el.dataset.corner === 'se';
      el.style.left = `${se ? w - inset(rx) : inset(rx)}px`;
      el.style.top = `${se ? h - inset(ry) : inset(ry)}px`;
    }
    render();
  }

  function applyEffect() {
    if (!maskEl) return;
    const t = clamp(settings.intensity, 0, 100) / 100;
    let background;
    let filter = 'none';
    switch (settings.effect) {
      case 'blur':
        background = 'rgba(0, 0, 0, 0.1)';
        filter = `blur(${(2 + t * 22).toFixed(1)}px)`;
        break;
      case 'blur-dim':
        background = `rgba(0, 0, 0, ${(0.15 + t * 0.6).toFixed(2)})`;
        filter = 'blur(8px)';
        break;
      default: // dim
        background = `rgba(0, 0, 0, ${(0.2 + t * 0.75).toFixed(2)})`;
    }
    maskEl.style.background = background;
    maskEl.style.backdropFilter = filter;
  }

  // Signed distance (px) from the cursor to the spotlight's outline:
  // negative inside, positive outside. Exact for circles and rounded boxes
  // (and close enough for the brief ellipse while morphing between them).
  function edgeDistance(px, py) {
    const { x, y, w, h } = visual();
    const dx = Math.abs(px - x);
    const dy = Math.abs(py - y);
    if (settings.shape === 'circle') {
      const a = w / 2;
      const b = h / 2;
      const d = Math.hypot(dx / a, dy / b);
      return (d - 1) * Math.min(a, b);
    }
    const { rx } = cornerRadii(w, h);
    const qx = dx - (w / 2 - rx);
    const qy = dy - (h / 2 - rx);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rx;
  }

  function updateHover() {
    if (!rootEl) return;
    const dist = edgeDistance(mouse.x, mouse.y);
    const nearEdge = !!drag || (spot.pinned && Math.abs(dist) <= GRAB_WIDTH);
    rootEl.classList.toggle('edge', nearEdge);
    rootEl.classList.toggle('inside', !nearEdge && dist < 0);
  }

  function render() {
    if (!maskEl || !drawn) return;
    const { x, y, w, h } = visual();
    maskEl.style.maskPosition = `${x - maskSize.w / 2}px ${y - maskSize.h / 2}px, 0 0`;
    ringEl.style.transform = `translate3d(${x - w / 2 - RING_MARGIN}px, ${y - h / 2 - RING_MARGIN}px, 0)`;
    handlesEl.style.transform = `translate3d(${x - w / 2}px, ${y - h / 2}px, 0)`;

    if (spot.pinned) {
      // Sit above the spotlight, or below it when there's no room at the top.
      const tw = toolbarEl.offsetWidth;
      const th = toolbarEl.offsetHeight;
      // Above the spotlight (clear of the top resize handle), else below it,
      // else tucked just inside its top edge.
      const above = y - h / 2 - TOOLBAR_GAP - th;
      const below = y + h / 2 + TOOLBAR_GAP;
      let top;
      if (above >= 8) top = above;
      else if (below + th <= innerHeight - 8) top = below;
      else top = y - h / 2 + 8;
      top = clamp(top, 8, innerHeight - th - 8);
      const left = clamp(x - tw / 2, 8, innerWidth - tw - 8);
      toolbarEl.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      const overlaps = left < x + w / 2 && left + tw > x - w / 2 && top < y + h / 2 && top + th > y - h / 2;
      toolbarEl.classList.toggle('inset', overlaps);
      hudEl.classList.toggle('top', top > innerHeight / 2);
    }
    updateHover();
  }

  function showHud(text, ms = 1200) {
    ensureOverlay();
    hudEl.textContent = text;
    hudEl.classList.add('show');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hudEl.classList.remove('show'), ms);
  }

  // -------------------------------------------------------------- spotlight

  function setSpotlight(on) {
    if (on === spot.active) return;
    spot.active = on;
    if (on) {
      ensureOverlay();
      spot.pinned = false;
      rootEl.classList.remove('pinned');
      resetSize(true);
      spot.x = mouse.x;
      spot.y = mouse.y;
      render();
      maskEl.getBoundingClientRect(); // flush styles so the fade-in runs
      rootEl.classList.add('on');
      showHud('Click to place the spotlight', 2200);
      startLoop();
    } else {
      endDrag();
      if (zoom.el) setZoom(false);
      rootEl?.classList.remove('on', 'pinned');
      spot.pinned = false;
      hudEl?.classList.remove('show');
    }
    reportState();
  }

  function resetSize(instant = false) {
    if (!sizeOverride) return;
    sizeOverride = null;
    applyShape(instant);
  }

  function setPinned(pinned) {
    if (!spot.active || pinned === spot.pinned) return;
    setZoom(false); // any spotlight interaction zooms out first
    spot.pinned = pinned;
    rootEl.classList.toggle('pinned', pinned);
    if (pinned) {
      clearTimeout(hudTimer);
      hudEl.classList.remove('show');
      const m = toPage(mouse.x, mouse.y);
      spot.pinX = spot.x = m.x;
      spot.pinY = spot.y = m.y;
      clampPin();
      render();
      peekToolbar();
      if (settings.autoZoomPlace) setZoom(true, { quiet: true });
    } else {
      endDrag();
      resetSize();
      showHud('Following the cursor · click to place', 1600);
      startLoop();
    }
    reportState();
  }

  function clampPin() {
    spot.pinX = clamp(spot.pinX, 0, innerWidth);
    spot.pinY = clamp(spot.pinY, 0, innerHeight);
    if (spot.pinned && !drag) {
      spot.x = spot.pinX;
      spot.y = spot.pinY;
    }
  }

  // ------------------------------------------------------------------- zoom

  // How far to zoom and where the zoomed spotlight goes.
  //
  // Scale: by default the spotlight fills ZOOM_FILL of the window, so some of
  // the surroundings stay visible. For large spotlights, where that would
  // barely zoom, go up to ZOOM_MIN_GAIN — but never past `fit`, the most that
  // keeps the whole spotlight on screen. Blending (rather than switching)
  // means a bigger spotlight always zooms a little less, never suddenly more.
  //
  // Position: centred when the toolbar fits above or below; otherwise shifted
  // down just enough to make room for the toolbar above (render() tucks the
  // toolbar inside the top edge if even that isn't possible).
  function zoomPlan() {
    const { w, h } = drawn ?? shapeSize();
    const preferred = Math.min((innerWidth * ZOOM_FILL) / w, (innerHeight * ZOOM_FILL) / h);
    const fit = Math.min((innerWidth - 2 * ZOOM_MARGIN) / w, (innerHeight - 2 * ZOOM_MARGIN) / h);
    const scale = clamp(Math.max(preferred, Math.min(fit, ZOOM_MIN_GAIN)), 1, Math.min(fit, MAX_ZOOM));
    const zh = h * scale;
    const toolbarRoom = (toolbarEl?.offsetHeight || 34) + TOOLBAR_GAP + 8;
    const to = { x: innerWidth / 2, y: innerHeight / 2 };
    const top = (innerHeight - zh) / 2;
    if (top < toolbarRoom) {
      // No room above or below when centred: move down, staying on screen.
      const shifted = Math.min(toolbarRoom, innerHeight - ZOOM_MARGIN - zh);
      if (shifted > top) to.y = shifted + zh / 2;
    }
    return { scale, to };
  }

  function beginZoom() {
    if (zoom.el) return;
    const el = document.body || document.documentElement;
    const rect = el.getBoundingClientRect(); // unscaled: no transform yet
    zoom.el = el;
    zoom.base = { x: rect.left, y: rect.top };
    zoom.saved = ['transform', 'transform-origin', 'transition'].map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
    zoom.view = { ...IDENTITY };
  }

  let peekTimer = 0;
  function peekToolbar(ms = 1500) {
    toolbarEl.classList.add('peek');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => toolbarEl?.classList.remove('peek'), ms);
  }

  function syncZoomButton() {
    const on = zoom.mode === 'in';
    zoomBtn.innerHTML = on ? `${ICONS.zoomOut}<span>Zoom out</span>` : ICONS.zoomIn;
    zoomBtn.title = on ? 'Zoom out' : 'Zoom in to the spotlight';
    zoomBtn.classList.toggle('active', on);
    peekToolbar();
  }

  // Zoom in on the spotlight (on) or animate back to the normal view (off).
  // `quiet`: an automatic zoom skips the "make it smaller" notice. Returns
  // whether a zoom-in started.
  function setZoom(on, { quiet = false } = {}) {
    if (on) {
      if (!spot.pinned || zoom.mode === 'in') return false;
      const plan = zoomPlan();
      if (plan.scale < 1.05) {
        if (!quiet) showHud('Make the spotlight smaller to zoom in', 1600);
        return false;
      }
      endDrag();
      beginZoom();
      // Spotlight centre (page coords) -> plan.to on screen, at plan.scale.
      zoom.goal = { ox: plan.to.x - plan.scale * spot.pinX, oy: plan.to.y - plan.scale * spot.pinY, s: plan.scale };
      zoom.mode = 'in';
      rootEl.classList.add('zoomed');
      showHud(`Zoomed to ${Math.round(plan.scale * 100)}%`, 1400);
    } else {
      if (!zoom.el || zoom.mode === 'out') return false;
      zoom.goal = { ...IDENTITY };
      zoom.mode = 'out';
    }
    syncZoomButton();
    startLoop();
    reportState();
    return on;
  }

  // Back to normal size around the screen point (px, py): the page point
  // under it stays exactly there, so a handle or edge grabbed while zoomed
  // stays under the pointer, at the spotlight's real size. The page is left
  // offset until the drag ends.
  function anchorZoomOut(px, py) {
    if (!zoom.el) return;
    const p = toPage(px, py);
    zoom.goal = { ox: px - p.x, oy: py - p.y, s: 1 };
    zoom.mode = 'anchored';
    syncZoomButton();
    startLoop();
    reportState();
  }

  // Returns true while still animating.
  function stepZoom() {
    const v = zoom.view;
    const g = zoom.goal;
    const moving = Math.abs(g.s - v.s) > 0.0005 || Math.abs(g.ox - v.ox) > 0.1 || Math.abs(g.oy - v.oy) > 0.1;
    if (moving) {
      v.s += (g.s - v.s) * ZOOM_EASE;
      v.ox += (g.ox - v.ox) * ZOOM_EASE;
      v.oy += (g.oy - v.oy) * ZOOM_EASE;
    } else {
      Object.assign(v, g);
    }

    if (!moving && zoom.mode === 'out') {
      endZoom();
    } else {
      // screen = o + s·v  for page point v, applied to <body> scaled around
      // its own top-left: screen = base + t + s·(v − base)  =>  t = o + (s−1)·base
      const tx = v.ox + (v.s - 1) * zoom.base.x;
      const ty = v.oy + (v.s - 1) * zoom.base.y;
      const st = zoom.el.style;
      st.setProperty('transform-origin', '0 0', 'important');
      st.setProperty('transition', 'none', 'important');
      st.setProperty('transform', `translate(${tx}px, ${ty}px) scale(${v.s})`, 'important');
    }
    paint();
    return moving;
  }

  function endZoom() {
    const el = zoom.el;
    if (!el) return;
    for (const [prop, value, priority] of zoom.saved) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
    Object.assign(zoom, { mode: 'none', view: { ...IDENTITY }, goal: { ...IDENTITY }, el: null, base: null, saved: null });
    rootEl?.classList.remove('zoomed');
  }

  // ------------------------------------------------- dragging and resizing

  // One pointer-capture gesture for both: the ring edge and the ⠿ handle move
  // the spotlight; the white square resizes it.
  function onDragStart(e) {
    if (!spot.pinned || e.button !== 0) return;
    // Zoomed: return to normal size around the grabbed point, so the handle or
    // edge stays under the pointer and the spotlight keeps its size.
    if (zoom.el) anchorZoomOut(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = { el: e.currentTarget, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    const corner = e.currentTarget.dataset?.corner;
    if (corner) {
      const { w, h } = drawn;
      drag.resize = {
        corner, w, h,
        left: spot.pinX - w / 2, top: spot.pinY - h / 2,
        right: spot.pinX + w / 2, bottom: spot.pinY + h / 2,
      };
    } else {
      const p = toPage(e.clientX, e.clientY);
      drag.offX = spot.pinX - p.x;
      drag.offY = spot.pinY - p.y;
      rootEl.classList.add('dragging');
    }
    updateHover();
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.resize) {
      resizeTo(e.clientX, e.clientY);
      return;
    }
    const p = toPage(e.clientX, e.clientY);
    spot.pinX = p.x + drag.offX;
    spot.pinY = p.y + drag.offY;
    spot.x = spot.pinX; // no easing while dragging: it should feel attached
    spot.y = spot.pinY;
    render();
  }

  // Resize by the pointer's movement since the drag started, keeping the
  // opposite corner fixed. Using the delta (not the absolute position) means the
  // handle doesn't jump, wherever on the outline it sits.
  function resizeTo(px, py) {
    const { corner, left, top, right, bottom, w: w0, h: h0 } = drag.resize;
    // Bottom-right handle grows with +x/+y and keeps the top-left fixed;
    // top-left handle is the mirror image.
    const sign = corner === 'se' ? 1 : -1;
    // On a curved outline the handle sits at (0.5 + 0.5·cos45°) of the size,
    // so scale the movement up to keep the handle under the pointer.
    const k = settings.shape === 'circle' ? 2 / (1 + Math.SQRT1_2) : 1;
    const dx = (px - drag.startX) * k * sign;
    const dy = (py - drag.startY) * k * sign;
    const max = maxSize();
    let w = Math.round(clamp(w0 + dx, MIN_SIZE, max.w));
    let h = Math.round(clamp(h0 + dy, MIN_SIZE, max.h));
    if (settings.shape === 'circle') {
      w = h = Math.round(clamp(w0 + (dx + dy) / 2, MIN_SIZE, max.w));
    }
    spot.pinX = spot.x = corner === 'se' ? left + w / 2 : right - w / 2;
    spot.pinY = spot.y = corner === 'se' ? top + h / 2 : bottom - h / 2;
    sizeOverride = { w, h };
    drag.resized = true;
    applyShape(true);
    showHud(settings.shape === 'circle' ? `${w}px` : `${w} × ${h}px`, 900);
  }

  function onDragEnd(e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    // Finishing a resize of a placed spotlight zooms in to the new area.
    const zoomAfter = settings.autoZoomResize && !!drag.resized && e?.type === 'pointerup';
    endDrag();
    if (zoomAfter && setZoom(true, { quiet: true })) return;
    // Otherwise glide an anchored (offset) page back to its normal position;
    // the spotlight moves with it, still framing the same content.
    if (zoom.mode === 'anchored') setZoom(false);
  }

  function endDrag() {
    if (!drag) return;
    try { drag.el.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
    drag = null;
    rootEl?.classList.remove('dragging');
    updateHover();
  }

  // ------------------------------------------------------------- frame loop

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function tick() {
    rafId = 0;
    let moving = false;
    if (zoom.el && stepZoom()) moving = true;
    if (!spot.active) {
      if (moving) startLoop(); // let a zoom-out finish while fading
      return;
    }

    const m = toPage(mouse.x, mouse.y);
    const tx = spot.pinned ? spot.pinX : m.x;
    const ty = spot.pinned ? spot.pinY : m.y;
    const dx = tx - spot.x;
    const dy = ty - spot.y;
    if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
      spot.x += dx * FOLLOW_EASE;
      spot.y += dy * FOLLOW_EASE;
      moving = true;
    } else {
      spot.x = tx;
      spot.y = ty;
    }

    if (!drag) {
      const target = shapeSize();
      const dw = target.w - drawn.w;
      const dh = target.h - drawn.h;
      if (Math.abs(dw) > 0.5 || Math.abs(dh) > 0.5) {
        drawShape(drawn.w + dw * SIZE_EASE, drawn.h + dh * SIZE_EASE);
        moving = true;
      } else if (dw || dh) {
        drawShape(target.w, target.h);
      }
    }

    render();
    if (moving) startLoop(); // idle once converged; input restarts it
  }


  // ------------------------------------------------------------ page events

  const fromOverlay = (e) => !!host && e.composedPath().includes(host);

  function onMouseMove(e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (!spot.active) return;
    if (spot.pinned) updateHover();
    else startLoop();
  }

  function onPointerDown(e) {
    if (!spot.active || spot.pinned || e.button !== 0 || fromOverlay(e)) return;
    // This click places the spotlight; don't let it also click the page.
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    setPinned(true);
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowClick = true;
    clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => { swallowClick = false; }, 800);
  }

  function onSwallowable(e) {
    if (!swallowClick || fromOverlay(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click') swallowClick = false;
  }

  function onResize() {
    clampPin();
    if (zoom.mode === 'in') {
      const plan = zoomPlan();
      zoom.goal = { ox: plan.to.x - plan.scale * spot.pinX, oy: plan.to.y - plan.scale * spot.pinY, s: plan.scale };
    }
    if (zoom.el) startLoop();
    if (spot.active) paint();
  }

  // ------------------------------------------------- extension integration

  function getState() {
    return { spotlight: spot.active, pinned: spot.pinned, zoomed: zoom.mode === 'in', viewport: { w: innerWidth, h: innerHeight } };
  }

  function reportState() {
    try {
      chrome.runtime.sendMessage({ type: 'state', state: getState() }).catch(() => {});
    } catch {
      teardown(); // extension was reloaded/removed; this copy is orphaned
    }
  }

  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.action) {
      case 'toggleSpotlight': setSpotlight(!spot.active); break;
      case 'setSpotlight': setSpotlight(!!msg.value); break;
      case 'getState': break;
      default: return;
    }
    sendResponse(getState());
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue ?? DEFAULTS[key];
    }
    normalizeSettings();
    // A new size or shape from the popup replaces any handle resize, and
    // counts as a spotlight interaction, so it zooms out.
    if (changes.width || changes.height || changes.shape) {
      sizeOverride = null;
      if (zoomBtn) setZoom(false);
    }
    applyShape();
    applyEffect();
  }

  const listeners = [
    [window, 'mousemove', onMouseMove, { capture: true, passive: true }],
    // Right-click menu: start the spotlight exactly where the menu was opened.
    [window, 'contextmenu', onMouseMove, { capture: true, passive: true }],
    [window, 'pointerdown', onPointerDown, { capture: true }],
    [window, 'mousedown', onSwallowable, { capture: true }],
    [window, 'pointerup', onSwallowable, { capture: true }],
    [window, 'mouseup', onSwallowable, { capture: true }],
    [window, 'click', onSwallowable, { capture: true }],
    [window, 'resize', onResize, { passive: true }],
  ];

  function teardown() {
    document.removeEventListener(TEARDOWN_EVENT, teardown);
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    cancelAnimationFrame(rafId);
    clearTimeout(hudTimer);
    clearTimeout(swallowTimer);
    clearTimeout(peekTimer);
    endZoom();
    host?.remove();
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
  chrome.storage.local.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    normalizeSettings();
    applyShape();
    applyEffect();
  }).catch(() => {});
})();
