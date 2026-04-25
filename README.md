# Webpage Chatbot – Chrome Extension

A Chrome extension that lets you **chat about any webpage** you're viewing. Ask questions about product specs, article content, documentation — anything on the page. Powered by a Python/FastAPI backend with LangChain RAG (Retrieval-Augmented Generation).

**Target audience:** General web users, online shoppers, researchers, students — anyone who wants to interrogate page content conversationally.

### Key Features

- **Streaming chat** — token-by-token SSE responses for real-time typing effect
- **Multi-tab context** — query across multiple open tabs simultaneously (e.g. compare products)
- **Chat history persistence** — conversation survives popup close/reopen within the same tab session
- **Source highlighting** — click a source to scroll-to and highlight the relevant text on the page
- **Dynamic page support** — MutationObserver detects significant DOM changes and auto-re-indexes
- **Live tab detection** — new browser tabs appear in the multi-tab selector automatically
- **LLM fallback chain** — OpenAI → Ollama (Gemma 2 / Qwen2.5) waterfall so the extension never breaks
- **Rate limiting** — server-side rate limits via slowapi to prevent abuse
- **Deployable** — runs locally or on Railway / any cloud host

---

## Architecture Overview

```
┌──────────────────────────────────┐
│        Chrome Extension          │
│  ┌────────┐  ┌───────────────┐   │
│  │ Popup  │  │Content Script │   │
│  │  (UI)  │  │ (DOM + JSON-LD│   │
│  └───┬────┘  │   scraper)    │   │
│      │       └──────┬────────┘   │
│  ┌───┴───────────────┴────────┐  │
│  │   Background Service Worker │  │
│  └────────────┬───────────────┘  │
└───────────────┼──────────────────┘
                │  HTTP / SSE (localhost)
┌───────────────┼──────────────────┐
│  Python Backend (FastAPI)        │
│  ┌────────────┴───────────────┐  │
│  │    /session  →  build RAG  │  │
│  │    /chat     →  query RAG  │  │
│  │    /chat/stream → SSE RAG  │  │
│  │    /chat/multi  → multi-tab│  │
│  ├────────────────────────────┤  │
│  │  LangChain + FAISS         │  │
│  │  OpenAI (primary)          │  │
│  │  Ollama fallbacks:         │  │
│  │    Gemma 2 9B / Qwen2.5 7B│  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

### Data Flow

1. **User opens popup** → Background worker asks the content script to extract page text.
2. **Content script** strips noise (nav, footer, scripts, ads), extracts `<script type="application/ld+json">` structured data (product info, reviews, etc.), detects page language, and returns the data.
3. **Background worker** sends text + structured data + language to `POST /session` → backend splits it into chunks, embeds them into a FAISS vector index, and returns a session ID.
4. **User asks a question** → `POST /chat/stream` → backend retrieves the most relevant chunks, feeds them + chat history to the LLM, and **streams tokens back** via Server-Sent Events.
5. **Multi-tab query** *(optional)* → `POST /chat/multi` retrieves from multiple sessions' vectorstores, merges results with tab attribution, and streams the answer.
6. **Dynamic page update** → MutationObserver detects significant content changes → auto-re-indexes the page without user intervention.
7. **Tab closed / URL changed** → `DELETE /session/:id` cleans up server memory.

---

## Quickstart

### Prerequisites

- Python 3.12+
- An [OpenAI API key](https://platform.openai.com/api-keys)
- Google Chrome (or Chromium-based browser)
- *(Optional)* [Ollama](https://ollama.com/) for local fallback models

### 1. Backend Setup

```bash
# Clone & enter the project
cd chrome_ext_chatbot

# Create virtual environment
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

# Install dependencies
pip install -e ".[dev]"

# Configure environment
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# (Optional) Pull Ollama fallback models
ollama pull gemma2:9b
ollama pull qwen2.5:7b

# Start the backend server
python main.py
```

The server starts on `http://127.0.0.1:8765`. Verify with:
```bash
curl http://127.0.0.1:8765/health
# → {"status":"ok"}
```

### 2. Load the Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the extension icon to your toolbar

### 3. Use It

1. Navigate to any webpage
2. Click the extension icon → it indexes the page automatically
3. Type a question → get a streamed answer

---

## Project Structure

```
chrome_ext_chatbot/
├── backend/
│   ├── __init__.py
│   ├── config.py           # Settings from environment variables
│   ├── models.py           # Pydantic request/response schemas
│   ├── chain.py            # LangChain vectorstore + retrieval chain + LLM fallbacks
│   ├── session_manager.py  # Per-tab session lifecycle (TTL, eviction)
│   └── server.py           # FastAPI app with /session, /chat, /chat/stream, /health
├── extension/
│   ├── manifest.json       # Chrome MV3 manifest
│   ├── background.js       # Service worker (API bridge)
│   ├── content.js          # DOM text extraction (injected per page)
│   ├── icons/              # Extension icons (add your own PNGs)
│   └── popup/
│       ├── popup.html      # Chat UI shell
│       ├── popup.css       # Dark-themed styles
│       └── popup.js        # Chat logic + streaming UI
├── tests/
│   ├── test_config.py
│   ├── test_chain.py
│   ├── test_session_manager.py
│   └── test_server.py
├── main.py                 # Entry point (uvicorn launcher)
├── pyproject.toml
├── .env.example
└── README.md
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | *(required)* | Your OpenAI API key |
| `CHAT_MODEL` | `gpt-4o-mini` | Primary LLM model name |
| `CHUNK_SIZE` | `1500` | Text chunk size (chars) for splitting |
| `CHUNK_OVERLAP` | `200` | Overlap between chunks |
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `8765` | Server port |
| `CORS_ORIGINS` | `chrome-extension://*` | Allowed CORS origins |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL for fallback models |
| `FALLBACK_MODEL` | `gemma2:9b` | Ollama fallback model (English/general) |
| `MULTILINGUAL_MODEL` | `qwen2.5:7b` | Ollama fallback model (non-English pages) |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/session` | Index page content → returns `session_id` |
| `POST` | `/chat` | Ask a question → returns AI answer |
| `POST` | `/chat/stream` | Ask a question → streams tokens via SSE |
| `POST` | `/chat/multi` | Multi-tab query → streams answer with tab attribution via SSE |
| `DELETE` | `/session/{id}` | Delete a session |
| `GET` | `/docs` | Interactive Swagger docs |

**Rate limits** (via slowapi): `/session` 10/min, `/chat` 20/min, `/chat/stream` 20/min, `/chat/multi` 10/min.

---

## Running Tests

```bash
pytest -v
```

Tests use mocks for OpenAI/FAISS calls — no API key or network needed.

---

## Example User Interactions

### Amazon Product Page
```
User: "What is the battery life of these headphones?"
Bot:  "According to the page, the Sony WH-1000XM5 offers up to 30 hours
       of battery life with noise cancellation enabled, and 40 hours
       with it off."

User: "Does it support multipoint connection?"
Bot:  "Yes — the page states it supports simultaneous multi-point
       connection to two Bluetooth devices."

User: "Compare it with the XM4"
Bot:  "The page doesn't include a comparison with the XM4.
       From my general knowledge: the XM5 has improved noise
       cancellation and a lighter design, while the XM4 is
       often available at a lower price point."
```

### Wikipedia Article
```
User: "Summarize this article in 3 bullet points"
Bot:  "• The article covers the history of the Roman Empire from 27 BC...
       • Key sections discuss the Pax Romana period...
       • The decline is attributed to..."
```

### Edge Case: Missing Information
```
User: "What's the shipping cost?"
Bot:  "The page doesn't mention shipping cost. It primarily contains
       product description and specifications. From my general knowledge:
       Amazon shipping costs vary by seller and Prime membership status."
```

---

## Structured Data Extraction

The content script automatically parses `<script type="application/ld+json">` blocks found on e-commerce sites (Amazon, Google Shopping, Shopify, etc.). This provides clean, structured product data (price, brand, ratings, availability) without fighting the DOM.

- Handles single objects, arrays, and `@graph` containers
- Flattened into readable text and prepended to page content before indexing
- The retriever can then surface precise product details even when the DOM text is noisy

---

## LLM Fallback Strategy

The backend uses a **waterfall fallback** pattern so the extension never breaks if OpenAI is unavailable:

| Priority | English Pages | Non-English Pages |
|---|---|---|
| 1 (primary) | OpenAI (gpt-4o-mini) | OpenAI (gpt-4o-mini) |
| 2 (fallback) | Gemma 2 9B (via Ollama) | Qwen2.5 7B (via Ollama) |
| 3 (fallback) | Qwen2.5 7B (via Ollama) | Gemma 2 9B (via Ollama) |

- If the primary model fails (expired key, rate limit, network), the chain automatically tries the next model
- Non-English pages prioritize **Qwen2.5 7B** which excels at multilingual comprehension
- Page language is detected from `document.documentElement.lang`
- Requires Ollama running locally with models pulled (`ollama pull gemma2:9b && ollama pull qwen2.5:7b`)

---

## Streaming

Chat responses are **streamed token-by-token** via Server-Sent Events (SSE):

- Backend endpoint `POST /chat/stream` yields `data: {"token": "..."}` events
- The popup renders tokens incrementally as they arrive — no waiting for the full response
- A final `data: {"done": true, "sources": [...]}` event signals completion
- The background worker uses a Chrome port (`chrome.runtime.connect`) to relay tokens to the popup

---

## Multi-Tab Context

Query across multiple open browser tabs simultaneously — useful for comparing products, cross-referencing articles, or aggregating information:

1. Click the **⊞** button in the chat header to toggle multi-tab mode
2. A tab selector bar appears showing all open browser tabs (with indexing status)
3. Check the tabs you want to include → unindexed tabs are indexed on-demand
4. Ask a question → the backend retrieves from all selected vectorstores and merges results
5. Sources in the answer include **tab attribution** so you know which tab each fact came from

**Live tab detection:** When you open a new browser tab, it automatically appears in the multi-tab selector (no manual refresh needed). Previously selected tabs stay checked across updates.

---

## Chat History Persistence

Conversation history is stored in `chrome.storage.session` and survives popup close/reopen within the same browser session:

- Messages persist per-tab — reopening the popup on the same page restores the full conversation
- History is cleared when you reset the session (⟳ button), close the tab, or navigate to a new URL
- Uses Chrome's session storage (not synced across devices, cleared when browser closes)

---

## Source Highlighting

When the AI cites sources from the page, each source is **clickable**:

- Click a source → the page scrolls to the matching text and highlights it in yellow
- Uses the TreeWalker + Range API for precise text matching across DOM nodes
- Highlights are cleared automatically when new highlights are applied or on reset
- Multi-tab sources show which tab the source came from

---

## Dynamic Page Support (MutationObserver)

Pages that update via JavaScript after initial load (e.g. Amazon price changes, SPA navigations, infinite scroll) are handled automatically:

- A `MutationObserver` watches `document.body` for `childList`, `subtree`, and `characterData` mutations
- Changes are **debounced** (3-second window) to avoid firing on every tiny DOM update
- Only triggers re-indexing when content changes by **15%+** (length heuristic + content sampling)
- On significant change: the old session is deleted, page is re-indexed, and the chat continues with fresh context

---

## Multi-Turn Conversation

The backend uses conversation memory (last 10 turns) so follow-up questions work naturally:

```
User: "What processor does this laptop use?"
Bot:  "It uses an Intel Core i7-13700H."

User: "How much RAM does it have?"     ← implicit "it" = the laptop
Bot:  "The page lists 16 GB DDR5 RAM."
```

Sessions are per-tab and auto-evicted after 30 minutes of inactivity (max 50 concurrent sessions).

---

## Privacy & Security

| Concern | Mitigation |
|---|---|
| **Page scraping** | All extraction happens locally in your browser via the content script. No page data is sent to third parties — only to your localhost backend. |
| **API key** | Stored in `.env` on your machine. Never sent to the extension or exposed client-side. |
| **CORS** | Backend restricts origins to `chrome-extension://*` by default. |
| **Sensitive pages** | The content script runs on all URLs but only extracts when you open the popup. Banking/medical pages are not auto-scraped. |
| **Data retention** | Sessions are memory-only, never persisted to disk. Evicted on tab close or TTL expiry. |

---

## Known Limitations & Workarounds

| Challenge | Impact | Workaround |
|---|---|---|
| **JS-rendered SPAs** | Content script may miss dynamically loaded content | MutationObserver auto-re-indexes on significant DOM changes; click ⟳ as fallback |
| **Very large pages** | Content truncated at 30K chars, max 30 chunks | Increase limits in `content.js` / `chain.py`; consider chunking strategy tuning |
| **Cross-origin iframes** | Cannot access content inside iframes from different origins | Chrome security model limitation — no workaround |
| **Rate limits** | OpenAI API rate limits on heavy use | Use `gpt-4o-mini` (cheaper/faster); add client-side throttling |
| **Performance** | Initial indexing takes 2-5s depending on page size | Show loading indicator (implemented); indexing runs off-thread via `run_in_executor`; 60s timeout on fetch |
| **Scraping restrictions** | Some sites block content scripts or use shadow DOM | Fallback to `document.body.innerText`; manual text paste as alternative |

---

## Alternative Architectures

### JS-Heavy (No Python Backend)
Run everything in the extension using `transformers.js` or call OpenAI directly from the service worker. **Pros:** No server needed. **Cons:** No vector search, limited context window, API key exposed in extension code.

### Cloud-Hosted Backend
Deploy the FastAPI server to a cloud provider. **Pros:** Accessible from any machine. **Cons:** Latency, cost, need to secure the API, page content leaves the user's machine.

### Local LLM (Ollama/llama.cpp)
Replace OpenAI with a local model. **Pros:** Fully private, no API cost. **Cons:** Requires a capable GPU, slower inference, lower quality answers.

---

## Deployment

The backend can be deployed to [Railway](https://railway.app/) or any cloud host:

```bash
# railway.toml is included — just link & deploy
railway link
railway up
```

Set `OPENAI_API_KEY` as a Railway environment variable. The server reads `PORT` from the environment automatically.

Update `API_BASE` in `extension/background.js` to point to your deployed URL (e.g. `https://your-app.up.railway.app`).

---

## Future Enhancements

- **PDF / file viewer support** (extract text from embedded PDFs)
- **Summarize on open** — auto-generate a TL;DR when the popup opens
- **Export chat** — save conversation as markdown
- **Custom prompts** — let users define system prompts for different use cases

---

## License

MIT
