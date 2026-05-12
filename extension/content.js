/**
 * Thin content script — extract page text, inject backend-served iframe,
 * observe DOM mutations, relay messages.
 */
(() => {
  "use strict";

  const PANEL_ID = "__webpage-chatbot-panel__";
  const PANEL_WIDTH = 400;
  const API_BASE = "https://chrome-extension-chatbot-production.up.railway.app";
  // const API_BASE = "http://127.0.0.1:8765";

  // ── Page text extraction ──────────────────────────────────

  function extractPageText() {
    const noiseSelectors = [
      "script","style","noscript","iframe","svg","nav","footer","header",
      "[role='navigation']","[role='banner']","[role='contentinfo']",
      ".cookie-banner",".ad-container","#cookie-consent",
    ];
    const clone = document.body.cloneNode(true);
    const panelClone = clone.querySelector(`#${PANEL_ID}`);
    if (panelClone) panelClone.remove();
    for (const sel of noiseSelectors) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    const mainSelectors = ["main","[role='main']","article","#content","#main-content",".main-content"];
    let root = null;
    for (const sel of mainSelectors) { root = clone.querySelector(sel); if (root) break; }
    const source = root || clone;
    return (source.innerText || source.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30_000);
  }

  function extractStructuredData() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    const results = [];
    for (const s of scripts) {
      try {
        const raw = JSON.parse(s.textContent);
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
          if (item["@graph"]) results.push(...item["@graph"]);
          else results.push(item);
        }
      } catch { /* skip malformed */ }
    }
    return results.length ? results : null;
  }

  // ── Side panel (iframe pointing to backend) ───────────────

  function createPanel(sessionId) {
    if (document.getElementById(PANEL_ID)) return;
    const wrapper = document.createElement("div");
    wrapper.id = PANEL_ID;
    Object.assign(wrapper.style, {
      position: "fixed", top: "0", right: "0",
      width: `${PANEL_WIDTH}px`, height: "100vh",
      zIndex: "2147483647", border: "none",
      boxShadow: "-2px 0 12px rgba(0,0,0,0.3)",
      transition: "transform 0.25s ease",
      transform: "translateX(0)", display: "block",
    });
    const iframe = document.createElement("iframe");
    iframe.src = `${API_BASE}/chat-ui?session_id=${encodeURIComponent(sessionId)}`;
    Object.assign(iframe.style, { width: "100%", height: "100%", border: "none" });
    wrapper.appendChild(iframe);
    document.body.appendChild(wrapper);

    // Listen for messages from the iframe (backend-served page)
    window.addEventListener("message", (e) => {
      if (e.data.type === "CLOSE_PANEL") {
        closePanel();
        chrome.runtime.sendMessage({ type: "PANEL_CLOSED" });
      }
      if (e.data.type === "RESET_SESSION") {
        chrome.runtime.sendMessage({ type: "RESET_SESSION" }, (resp) => {
          if (resp && resp.success) {
            iframe.src = `${API_BASE}/chat-ui?session_id=${encodeURIComponent(resp.sessionId)}`;
          }
        });
      }
      if (e.data.type === "INDEX_TAB") {
        chrome.runtime.sendMessage({ type: "INDEX_TAB", tabId: e.data.tabId }, (resp) => {
          if (iframe.contentWindow) {
            iframe.contentWindow.postMessage({ type: "TAB_INDEXED", tabId: e.data.tabId, success: resp?.success }, "*");
          }
        });
      }
    });
  }

  function togglePanel(sessionId) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) { createPanel(sessionId); return; }
    const hidden = panel.style.transform === "translateX(100%)";
    panel.style.transform = hidden ? "translateX(0)" : "translateX(100%)";
  }

  function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.transform = "translateX(100%)";
  }

  // ── Message listener ──────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "EXTRACT_PAGE_CONTENT") {
      try {
        sendResponse({
          success: true,
          data: {
            url: window.location.href,
            title: document.title,
            text_content: extractPageText(),
            structured_data: extractStructuredData(),
            language: document.documentElement.lang || "",
          },
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
    if (message.type === "TOGGLE_PANEL") {
      togglePanel(message.sessionId || "");
      sendResponse({ success: true });
      return true;
    }
    if (message.type === "CLOSE_PANEL") {
      closePanel();
      sendResponse({ success: true });
      return true;
    }
    if (message.type === "TABS_CHANGED") {
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
  });

  // ── MutationObserver — auto-re-index on significant DOM change ─

  let _lastText = "";
  let _timer = null;
  const DEBOUNCE_MS = 3000;
  const CHANGE_THRESHOLD = 0.15;

  function startObserver() {
    _lastText = extractPageText();
    new MutationObserver(() => {
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(() => {
        const newText = extractPageText();
        if (!_lastText || !newText) return;
        const diff = Math.abs(newText.length - _lastText.length);
        const avg = (_lastText.length + newText.length) / 2 || 1;
        if (diff / avg >= CHANGE_THRESHOLD) {
          _lastText = newText;
          chrome.runtime.sendMessage({ type: "PAGE_CONTENT_CHANGED" }).catch(() => {});
        }
      }, DEBOUNCE_MS);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === "complete") startObserver();
  else window.addEventListener("load", startObserver, { once: true });
})();
