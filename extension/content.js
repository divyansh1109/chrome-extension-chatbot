/**
 * Content script – injected into every page.
 * 1. Extracts meaningful text content from the DOM on request.
 * 2. Injects a persistent side-panel (iframe) for the chat UI.
 */

(() => {
  "use strict";

  const PANEL_ID = "__webpage-chatbot-panel__";
  const PANEL_WIDTH = 400;

  // ── Structured data extraction (JSON-LD) ────────────────────

  function extractStructuredData() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    const results = [];

    for (const script of scripts) {
      try {
        const raw = JSON.parse(script.textContent);
        // JSON-LD can be a single object or an array
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
          // Also handle @graph containers (common on e-commerce sites)
          if (item["@graph"]) {
            results.push(...item["@graph"]);
          } else {
            results.push(item);
          }
        }
      } catch {
        // Ignore malformed JSON-LD blocks
      }
    }
    return results.length ? results : null;
  }

  // ── Page text extraction ───────────────────────────────────

  function extractPageText() {
    const noiseSelectors = [
      "script", "style", "noscript", "iframe", "svg",
      "nav", "footer", "header",
      "[role='navigation']", "[role='banner']", "[role='contentinfo']",
      ".cookie-banner", ".ad-container", "#cookie-consent",
    ];

    const clone = document.body.cloneNode(true);
    // Also remove our own panel from the clone
    const panelClone = clone.querySelector(`#${PANEL_ID}`);
    if (panelClone) panelClone.remove();

    for (const sel of noiseSelectors) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }

    const mainSelectors = [
      "main", "[role='main']", "article",
      "#content", "#main-content", ".main-content",
      "#productTitle",
    ];

    let contentRoot = null;
    for (const sel of mainSelectors) {
      contentRoot = clone.querySelector(sel);
      if (contentRoot) break;
    }

    const source = contentRoot || clone;
    const rawText = source.innerText || source.textContent || "";
    return rawText.replace(/\s+/g, " ").trim().slice(0, 30_000);
  }

  function getPageMeta() {
    const meta = {};
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const desc = document.querySelector('meta[name="description"]');
    if (ogTitle) meta.ogTitle = ogTitle.content;
    if (ogDesc) meta.ogDescription = ogDesc.content;
    if (desc) meta.description = desc.content;
    return meta;
  }

  // ── Side-panel injection ───────────────────────────────────

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const wrapper = document.createElement("div");
    wrapper.id = PANEL_ID;
    Object.assign(wrapper.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: `${PANEL_WIDTH}px`,
      height: "100vh",
      zIndex: "2147483647",
      border: "none",
      boxShadow: "-2px 0 12px rgba(0,0,0,0.3)",
      transition: "transform 0.25s ease",
      transform: "translateX(0)",
      display: "block",
    });

    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("popup/popup.html");
    Object.assign(iframe.style, {
      width: "100%",
      height: "100%",
      border: "none",
    });

    wrapper.appendChild(iframe);
    document.body.appendChild(wrapper);
  }

  function togglePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      createPanel();
      return;
    }
    const isHidden = panel.style.transform === "translateX(100%)";
    panel.style.transform = isHidden ? "translateX(0)" : "translateX(100%)";
  }

  function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.style.transform = "translateX(100%)";
    }
  }

  // ── Message listener ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "EXTRACT_PAGE_CONTENT") {
      try {
        const text = extractPageText();
        const meta = getPageMeta();
        const structured_data = extractStructuredData();
        sendResponse({
          success: true,
          data: {
            url: window.location.href,
            title: document.title,
            text_content: text,
            meta,
            structured_data,
            language: document.documentElement.lang || "",
          },
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (message.type === "TOGGLE_PANEL") {
      togglePanel();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === "CLOSE_PANEL") {
      closePanel();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === "TABS_CHANGED") {
      // Relay to the popup iframe so it can refresh the multi-tab list
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        const iframe = panel.querySelector("iframe");
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: "TABS_CHANGED" }, "*");
        }
      }
      sendResponse({ success: true });
      return true;
    }

    if (message.type === "HIGHLIGHT_SOURCE") {
      clearHighlights();
      const found = highlightText(message.text);
      sendResponse({ success: found });
      return true;
    }

    if (message.type === "CLEAR_HIGHLIGHTS") {
      clearHighlights();
      sendResponse({ success: true });
      return true;
    }
  });

  // ── DOM MutationObserver — re-extract on significant changes ─

  let _lastExtractedText = "";
  let _mutationTimer = null;
  const MUTATION_DEBOUNCE_MS = 3000; // wait 3s after last mutation
  const CHANGE_THRESHOLD = 0.15;     // 15% content change triggers re-index

  function startObserver() {
    // Capture initial content fingerprint
    _lastExtractedText = extractPageText();

    const observer = new MutationObserver(() => {
      // Debounce: reset timer on each batch of mutations
      if (_mutationTimer) clearTimeout(_mutationTimer);
      _mutationTimer = setTimeout(() => {
        checkForSignificantChange();
      }, MUTATION_DEBOUNCE_MS);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function checkForSignificantChange() {
    try {
      const newText = extractPageText();
      if (!_lastExtractedText || !newText) return;

      // Quick length-based heuristic first
      const lenDiff = Math.abs(newText.length - _lastExtractedText.length);
      const avgLen = (_lastExtractedText.length + newText.length) / 2 || 1;

      if (lenDiff / avgLen >= CHANGE_THRESHOLD) {
        _lastExtractedText = newText;
        notifyContentChanged();
        return;
      }

      // Sample-based comparison: check a few slices for text changes
      const sampleSize = 500;
      const oldSample = _lastExtractedText.slice(0, sampleSize) + _lastExtractedText.slice(-sampleSize);
      const newSample = newText.slice(0, sampleSize) + newText.slice(-sampleSize);

      if (oldSample !== newSample) {
        _lastExtractedText = newText;
        notifyContentChanged();
      }
    } catch {
      // Ignore extraction errors during observation
    }
  }

  function notifyContentChanged() {
    // Tell the background the page content has changed significantly
    chrome.runtime.sendMessage({ type: "PAGE_CONTENT_CHANGED" }).catch(() => {});
  }

  // Start observing once the page is stable
  if (document.readyState === "complete") {
    startObserver();
  } else {
    window.addEventListener("load", startObserver, { once: true });
  }

  // ── Source text highlighting ──────────────────────────────

  const HIGHLIGHT_CLASS = "__chatbot-highlight__";

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
  }

  function highlightText(snippet) {
    // Normalize the snippet: collapse whitespace to match how innerText works
    const needle = snippet.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!needle) return false;

    const treeWalker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          // Skip our panel and script/style elements
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(`#${PANEL_ID}`)) return NodeFilter.FILTER_REJECT;
          if (parent.closest("script, style, noscript")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    // Build a map of text nodes to search across node boundaries
    const nodes = [];
    let fullText = "";
    while (treeWalker.nextNode()) {
      const node = treeWalker.currentNode;
      nodes.push({ node, start: fullText.length });
      fullText += node.textContent;
    }

    // Search in normalized text
    const normalizedFull = fullText.replace(/\s+/g, " ");
    const idx = normalizedFull.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) return false;

    // Map back to original position (approximate — normalized offsets)
    // Find which text nodes contain the match
    const matchEnd = idx + needle.length;
    let highlighted = false;

    for (let i = 0; i < nodes.length; i++) {
      const { node, start } = nodes[i];
      const nodeEnd = start + node.textContent.length;

      if (nodeEnd <= idx || start >= matchEnd) continue;

      // This node overlaps the match
      const highlightStart = Math.max(0, idx - start);
      const highlightEnd = Math.min(node.textContent.length, matchEnd - start);

      const range = document.createRange();
      range.setStart(node, highlightStart);
      range.setEnd(node, highlightEnd);

      const mark = document.createElement("mark");
      mark.className = HIGHLIGHT_CLASS;
      mark.style.cssText = "background: #facc15; color: #000; padding: 1px 2px; border-radius: 2px; scroll-margin: 80px;";
      range.surroundContents(mark);

      if (!highlighted) {
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
        highlighted = true;
      }

      // After surroundContents the treewalker is invalidated, but we only
      // need the first continuous match, so break after highlighting.
      break;
    }

    return highlighted;
  }
})();
