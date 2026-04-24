/**
 * Content script – injected into every page.
 * Extracts meaningful text content from the DOM and sends it
 * to the background service worker on request.
 */

(() => {
  "use strict";

  /**
   * Extract readable text from the page, stripping nav/footer/script noise.
   * Uses a priority list of selectors to target main content areas.
   */
  function extractPageText() {
    // Remove noisy elements before extraction
    const noiseSelectors = [
      "script",
      "style",
      "noscript",
      "iframe",
      "svg",
      "nav",
      "footer",
      "header",
      "[role='navigation']",
      "[role='banner']",
      "[role='contentinfo']",
      ".cookie-banner",
      ".ad-container",
      "#cookie-consent",
    ];

    // Clone the body so we don't mutate the live DOM
    const clone = document.body.cloneNode(true);
    for (const sel of noiseSelectors) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }

    // Prefer structured main-content containers
    const mainSelectors = [
      "main",
      "[role='main']",
      "article",
      "#content",
      "#main-content",
      ".main-content",
      "#productTitle", // Amazon-style product pages
    ];

    let contentRoot = null;
    for (const sel of mainSelectors) {
      contentRoot = clone.querySelector(sel);
      if (contentRoot) break;
    }

    const source = contentRoot || clone;
    const rawText = source.innerText || source.textContent || "";

    // Collapse whitespace and limit length (≈100k chars ≈ 25k tokens)
    return rawText.replace(/\s+/g, " ").trim().slice(0, 100_000);
  }

  /**
   * Build structured metadata about the page.
   */
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

  // Listen for extraction requests from the background/popup
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
      // Return true to indicate async response
      return true;
    }
  });
})();
