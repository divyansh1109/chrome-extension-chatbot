"""FastAPI server exposing chat endpoints for the Chrome extension."""

from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.responses import JSONResponse

from backend import chat_store
from backend.config import Settings
from backend.models import ChatRequest, ChatResponse, MultiTabChatRequest, PageContent, SessionInfo
from backend.session_manager import SessionManager

logger = logging.getLogger(__name__)


def _create_limiter() -> Limiter:
    return Limiter(key_func=get_remote_address)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Application factory."""
    if settings is None:
        settings = Settings.from_env()

    rate_limiter = _create_limiter()

    app = FastAPI(
        title="Webpage Chatbot API",
        version="0.1.0",
        docs_url="/docs",
    )

    app.state.limiter = rate_limiter

    @app.exception_handler(RateLimitExceeded)
    async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded. Please slow down."},
        )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    manager = SessionManager(settings)

    # ── Jinja2 templates & static files ────────────────────────
    templates_dir = Path(__file__).parent / "templates"
    static_dir = Path(__file__).parent / "static"
    templates = Jinja2Templates(directory=str(templates_dir))
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    # ── Startup: init SQLite + periodic cleanup ────────────────

    @app.on_event("startup")
    async def on_startup():
        await chat_store.init_db()

        async def _periodic_cleanup():
            while True:
                await asyncio.sleep(600)  # Every 10 minutes
                try:
                    await chat_store.cleanup_stale()
                except Exception:
                    logger.exception("Periodic cleanup failed")

        asyncio.create_task(_periodic_cleanup())

    # ── Endpoints ──────────────────────────────────────────────

    @app.get("/health")
    async def health_check():
        return {"status": "ok"}

    @app.post("/session", response_model=SessionInfo)
    @rate_limiter.limit("10/minute")
    async def create_session(request: Request, payload: PageContent):
        """Receive page content from the extension and build a chat session."""
        if not payload.text_content.strip():
            raise HTTPException(
                status_code=400,
                detail="Page content is empty; nothing to chat about.",
            )

        session_id = uuid.uuid4().hex[:12]
        loop = asyncio.get_event_loop()
        session = await loop.run_in_executor(
            None,
            lambda: manager.create_session(
                session_id=session_id,
                url=payload.url,
                title=payload.title,
                text_content=payload.text_content,
                structured_data=payload.structured_data,
                language=payload.language,
            ),
        )
        return SessionInfo(
            session_id=session.session_id,
            url=session.url,
            title=session.title,
            chunk_count=session.chunk_count,
        )

    @app.post("/chat", response_model=ChatResponse)
    @rate_limiter.limit("20/minute")
    async def chat(request: Request, req: ChatRequest):
        """Answer a user question using the session's retrieval chain."""
        session = manager.get_session(req.session_id)
        if not session:
            raise HTTPException(
                status_code=404,
                detail="Session not found. Please reload the page to start a new session.",
            )

        try:
            result = await _run_chain(session, req.question)
        except Exception:
            logger.exception("Chain invocation failed for session %s", req.session_id)
            raise HTTPException(
                status_code=500,
                detail="Failed to generate a response. Please try again.",
            )

        sources = result.get("source_documents", [])
        return ChatResponse(
            answer=result["answer"],
            session_id=req.session_id,
            sources=sources,
        )

    @app.post("/chat/stream")
    @rate_limiter.limit("20/minute")
    async def chat_stream(request: Request, req: ChatRequest):
        """Return a complete chat response (non-streaming)."""
        session = manager.get_session(req.session_id)
        if not session:
            raise HTTPException(
                status_code=404,
                detail="Session not found. Please reload the page to start a new session.",
            )
        result = await _run_chain(session, req.question)
        return ChatResponse(
            answer=result["answer"],
            session_id=req.session_id,
            sources=result.get("source_documents", []),
        )

    @app.delete("/session/{session_id}")
    async def delete_session(session_id: str):
        """Clean up a session when a tab is closed."""
        manager.delete_session(session_id)
        await chat_store.clear_history(session_id)
        return {"status": "deleted"}

    @app.post("/chat/multi")
    @rate_limiter.limit("10/minute")
    async def chat_multi(request: Request, req: MultiTabChatRequest):
        """Return a chat response drawing context from multiple tab sessions."""
        result = await _run_multi_chain(manager, req.session_ids, req.question)
        return result

    # ── Chat UI (server-rendered) ──────────────────────────────

    @app.get("/chat-ui")
    async def chat_ui(request: Request, session_id: str = ""):
        """Render the chat UI. Called by the extension iframe."""
        session = manager.get_session(session_id) if session_id else None
        history = []
        if session_id:
            history = await chat_store.get_history(session_id)

        session_info = None
        if session:
            session_info = {
                "session_id": session.session_id,
                "title": session.title,
                "chunk_count": session.chunk_count,
            }

        return templates.TemplateResponse(
            request=request,
            name="chat.html",
            context={
                "session": session_info,
                "history": history,
            },
        )

    # ── Chat history persistence ───────────────────────────────

    @app.post("/history/{session_id}")
    async def save_history(session_id: str, request: Request):
        """Save chat messages from the UI."""
        body = await request.json()
        messages = body.get("messages", [])
        if messages:
            await chat_store.save_messages(session_id, messages)
        return {"status": "saved"}

    # ── Tab registry ───────────────────────────────────────────

    @app.get("/tabs")
    async def list_tabs():
        """Return all registered tabs for the multi-tab selector."""
        tabs = await chat_store.get_all_tabs()
        return {"tabs": tabs}

    @app.post("/tabs/{tab_id}")
    async def register_tab_endpoint(tab_id: str, request: Request):
        """Register a tab when it's indexed (called by background.js)."""
        body = await request.json()
        await chat_store.register_tab(
            tab_id=tab_id,
            session_id=body.get("session_id", ""),
            url=body["url"],
            title=body.get("title", ""),
            indexed=bool(body.get("session_id")),
        )
        return {"status": "registered"}

    @app.delete("/tabs/{tab_id}")
    async def unregister_tab_endpoint(tab_id: str):
        """Remove a tab from the registry (called on tab close)."""
        await chat_store.unregister_tab(tab_id)
        return {"status": "removed"}

    return app


async def _run_chain(session, question: str) -> dict:
    """Invoke the chat session; run in executor since LangChain may block."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: session.chat_session.invoke(question),
    )


async def _run_multi_chain(manager, session_ids: list[str], question: str) -> dict:
    """Invoke chat across multiple tab sessions and return combined response."""
    sessions = manager.get_sessions(session_ids)
    if not sessions:
        raise HTTPException(
            status_code=404,
            detail="No valid sessions found for the given IDs.",
        )

    def _invoke():
        all_docs = []
        docs_by_tab = {}
        for s in sessions:
            docs = s.chat_session.retriever.invoke(question)
            for doc in docs:
                doc.metadata["_tab_title"] = s.title
                doc.metadata["_tab_url"] = s.url
            all_docs.extend(docs)
            docs_by_tab[s.session_id] = docs

        num_tabs = len(sessions)
        per_tab_min = max(1, 8 // num_tabs)
        total_budget = max(8, num_tabs * 2)
        top_docs = []
        used = set()

        for sid, docs in docs_by_tab.items():
            for doc in docs[:per_tab_min]:
                top_docs.append(doc)
                used.add(id(doc))

        remaining = total_budget - len(top_docs)
        for doc in all_docs:
            if remaining <= 0:
                break
            if id(doc) not in used:
                top_docs.append(doc)
                used.add(id(doc))
                remaining -= 1

        context_parts = []
        sources = []
        for doc in top_docs:
            tab_title = doc.metadata.get("_tab_title", "Unknown")
            snippet = doc.page_content[:200]
            context_parts.append(f"[From: {tab_title}]\n{doc.page_content}")
            sources.append({"text": snippet, "tab": tab_title})

        context = "\n\n".join(context_parts)

        primary = sessions[0].chat_session
        formatted = primary.prompt.invoke({
            "context": context,
            "chat_history": [],
            "question": question,
        })
        result = primary.llm.invoke(formatted.to_messages())
        answer = result.content if hasattr(result, "content") else str(result)
        return {"answer": answer, "sources": sources}

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _invoke)
