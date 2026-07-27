// ─── "yo" → "Givs" AGE MACRO (shared across all campaign tools) ───────────────
// Typing a sequence "<number> yo" is converted, the moment the "yo" completes,
// into "<(number * 365) / 1000> Givs".  e.g.  "5 yo" → "1.825 Givs".
// Works in any <input>/<textarea> and in contenteditable fields. A single
// delegated listener on the document covers elements created dynamically.
(function () {
  'use strict';

  // "<number> yo" anchored to the caret. The number may be an integer or decimal.
  var RE = /(\d+(?:\.\d+)?) yo$/;

  // (n*365)/1000, rounded to a single decimal place.
  function convertNumber(n) {
    return ((n * 365) / 1000).toFixed(1);
  }

  // Given the text just before the caret, return the replacement span or null.
  function planReplacement(before) {
    var m = before.match(RE);
    if (!m) return null;
    // Don't fire mid-word (e.g. "abc5 yo") — the digit must start a fresh token.
    var idx  = before.length - m[0].length;
    var prev = idx > 0 ? before.charAt(idx - 1) : '';
    if (/[A-Za-z]/.test(prev)) return null;
    return { matchLen: m[0].length, text: convertNumber(parseFloat(m[1])) + ' Givs' };
  }

  var busy = false; // guards the synthetic input event we re-dispatch below

  function isTextField(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return /^(text|search|url|email|tel|)$/i.test(el.getAttribute('type') || 'text');
  }

  document.addEventListener('input', function (e) {
    if (busy || e.isComposing) return;
    var el = e.target;
    if (!el) return;

    // ── <input> / <textarea> ──────────────────────────────────────────────
    if (isTextField(el)) {
      var caret = el.selectionStart;
      if (caret == null) return;
      var value = el.value;
      var plan  = planReplacement(value.slice(0, caret));
      if (!plan) return;
      var start = caret - plan.matchLen;
      busy = true;
      el.value = value.slice(0, start) + plan.text + value.slice(caret);
      var nc = start + plan.text.length;
      try { el.setSelectionRange(nc, nc); } catch (_) {}
      el.dispatchEvent(new Event('input', { bubbles: true })); // let the host tool save
      busy = false;
      return;
    }

    // ── contenteditable ───────────────────────────────────────────────────
    if (el.isContentEditable) {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var range = sel.getRangeAt(0);
      if (!range.collapsed || range.startContainer.nodeType !== 3) return; // text node, collapsed caret
      var node = range.startContainer;
      var off  = range.startOffset;
      var text = node.nodeValue;
      var plan2 = planReplacement(text.slice(0, off));
      if (!plan2) return;
      var s = off - plan2.matchLen;
      busy = true;
      node.nodeValue = text.slice(0, s) + plan2.text + text.slice(off);
      var nc2 = s + plan2.text.length;
      try {
        var r = document.createRange();
        r.setStart(node, nc2); r.setEnd(node, nc2);
        sel.removeAllRanges(); sel.addRange(r);
      } catch (_) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      busy = false;
    }
  });
})();
