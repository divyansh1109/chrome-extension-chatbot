/**
 * Content script – injected into every page.
 * 1. Extracts meaningful text content from the DOM on request.
 * 2. Injects a persistent side-panel (iframe) for the chat UI.
 */

(() => {
  "use strict";

  const PANEL_ID = "__webpage-chatbot-panel__";
  const PANEL_WIDTH = 400;

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
    return rawText.replace(/\s+/g, " ").trim().slice(0, 100_000);
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
    iframe.allow = "microphone"; // for voice input
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
        sendResponse({
          success: true,
          data: {
            url: window.location.href,
            title: document.title,
            text_content: text,
            meta,
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
  });
})();
