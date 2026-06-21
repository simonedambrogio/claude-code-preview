// Injected into VS Code's built-in markdown preview (see package.json
// markdown.previewScripts). Adds a copy button to each code block — but only
// on Claude Code Preview responses, which we detect via the marker comment
// the extension writes at the top of every file (MD_PREFIX in extension.js).
// On any other markdown the script returns immediately.

(function () {
  const MARKER = 'claude-code-preview';

  // True when this preview is one of ours. The marker is an HTML comment at
  // the very top of the document, so we stop at the first comment node —
  // constant-time, independent of document length (no innerHTML serialize).
  function isClaudePreview() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    let n = walker.nextNode();
    let scanned = 0;
    // The marker is first; cap the scan so a stray comment can't make this walk.
    while (n && scanned < 5) {
      if (n.nodeValue && n.nodeValue.indexOf(MARKER) !== -1) return true;
      n = walker.nextNode();
      scanned++;
    }
    return false;
  }

  function copyText(text) {
    // navigator.clipboard can silently no-op inside a webview, so use the
    // textarea + execCommand fallback, which works in the click gesture.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function addButton(pre) {
    if (pre.querySelector('.ccp-copy-btn')) return; // already decorated
    const code = pre.querySelector('code');
    if (!code) return;

    pre.classList.add('ccp-has-copy');
    const btn = document.createElement('button');
    btn.className = 'ccp-copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const ok = copyText(code.innerText.replace(/\n$/, ''));
      btn.textContent = ok ? 'Copied!' : 'Failed';
      btn.classList.toggle('ccp-copied', ok);
      setTimeout(function () {
        btn.textContent = 'Copy';
        btn.classList.remove('ccp-copied');
      }, 1500);
    });

    pre.appendChild(btn);
  }

  function decorate() {
    if (!isClaudePreview()) return;
    const blocks = document.querySelectorAll('pre');
    for (let i = 0; i < blocks.length; i++) addButton(blocks[i]);
  }

  // Run now and after each preview content update (VS Code re-runs preview
  // scripts on render, but observe too so refreshes within a render are
  // covered).
  decorate();
  const observer = new MutationObserver(function () {
    decorate();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
