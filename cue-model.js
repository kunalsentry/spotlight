// Spotlight — the cue format, shared by the content scripts, the popup and
// the cue manager.
//
// A cue has a list of triggers (a click on any of them starts it) and a list
// of ends (any of them ends it):
//   triggers: [{ event: 'click', element: Fingerprint, name }]
//   ends:     [{ on: 'outside' }                                a click outside the spotlight
//              { on: 'element', element: Fingerprint, name }   a click on that element
//              { on: 'timer', ms }]                            after a delay
// No ends means the spotlight only ends like any other: ✕ or ⌥S.
//
// Earlier versions saved one `trigger` and an optional `deactivate` (missing
// meant a click outside, null meant manual only). normalize() turns a cue
// in either format into the current one, in place.

// `var`, not `const`: as a content script this may run again in the same
// page (re-injected), and redeclaring a const would throw.
// eslint-disable-next-line no-var
var CueModel = (() => {
  const DEFAULT_END = { on: 'outside' };

  function normalize(cue) {
    if (!cue || typeof cue !== 'object') return cue;
    if (!Array.isArray(cue.triggers)) cue.triggers = cue.trigger ? [cue.trigger] : [];
    if (!Array.isArray(cue.ends)) {
      cue.ends = cue.deactivate === undefined ? [{ ...DEFAULT_END }] : cue.deactivate ? [cue.deactivate] : [];
    }
    delete cue.trigger;
    delete cue.deactivate;
    return cue;
  }

  return { DEFAULT_END, normalize };
})();
