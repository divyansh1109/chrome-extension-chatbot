"""FastAPI server exposing chat endpoints for the Chrome extension."""

from __future__ import annotations

import json
import logging
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.responses import JSONResponse, StreamingResponse

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
        session = manager.create_session(
            session_id=session_id,
            url=payload.url,
            title=payload.title,
            text_content=payload.text_content,
            structured_data=payload.structured_data,
            language=payload.language,
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
        """Stream tokens back as Server-Sent Events."""
        session = manager.get_session(req.session_id)
        if not session:
            raise HTTPException(
                status_code=404,
                detail="Session not found. Please reload the page to start a new session.",
            )

        import asyncio

        _STREAM_END = object()

        def _next_token(gen):
            """Wrapper around next() that converts StopIteration to a sentinel."""
            try:
                return next(gen)
            except StopIteration as e:
                return _STREAM_END, e.value

        async def event_generator():
            loop = asyncio.get_event_loop()
            gen = await loop.run_in_executor(
                None,
                lambda: session.chat_session.stream(req.question),
            )
            sources = []
            try:
                while True:
                    result = await loop.run_in_executor(None, _next_token, gen)
                    if isinstance(result, tuple) and result[0] is _STREAM_END:
                        meta = result[1] or {}
                        sources = meta.get("source_documents", [])
                        break
                    yield f"data: {json.dumps({'token': result})}\n\n"
            except Exception:
                logger.exception(
                    "Streaming failed for session %s", req.session_id
                )
                yield f"data: {json.dumps({'error': 'Stream failed'})}\n\n"
                return
            yield f"data: {json.dumps({'done': True, 'sources': sources})}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @app.delete("/session/{session_id}")
    async def delete_session(session_id: str):
        """Clean up a session when a tab is closed."""
        manager.delete_session(session_id)
        return {"status": "deleted"}

    @app.post("/chat/multi")
    @rate_limiter.limit("10/minute")
    async def chat_multi(request: Request, req: MultiTabChatRequest):
        """Stream an answer that draws context from multiple tab sessions."""
        sessions = manager.get_sessions(req.session_ids)
        if not sessions:
            raise HTTPException(
                status_code=404,
                detail="No valid sessions found for the given IDs.",
            )

        import asyncio

        _STREAM_END = object()

        def _next_token(gen):
            try:
                return next(gen)
            except StopIteration as e:
                return _STREAM_END, e.value

        def _multi_stream():
            # Retrieve from all sessions' vectorstores
            all_docs = []
            tab_labels = {}
            for s in sessions:
                docs = s.chat_session.retriever.invoke(req.question)
                for doc in docs:
                    doc.metadata["_tab_title"] = s.title
                    doc.metadata["_tab_url"] = s.url
                all_docs.extend(docs)
                tab_labels[s.session_id] = s.title

            # Score and take top-k across all tabs
            all_docs.sort(key=lambda d: len(d.page_content), reverse=True)
            top_docs = all_docs[:6]

            # Build combined context with tab attribution
            context_parts = []
            sources = []
            for doc in top_docs:
                tab_title = doc.metadata.get("_tab_title", "Unknown")
                snippet = doc.page_content[:200]
                context_parts.append(f"[From: {tab_title}]\n{doc.page_content}")
                sources.append({"text": snippet, "tab": tab_title})

            context = "\n\n".join(context_parts)

            # Use the first session's LLM and prompt to generate
            primary = sessions[0].chat_session
            from langchain_core.messages import HumanMessage as HM
            formatted = primary.prompt.invoke({
                "context": context,
                "chat_history": [],
                "question": req.question,
            })
            chunks = []
            for token in primary.llm.stream(formatted.to_messages()):
                text = token.content if hasattr(token, "content") else str(token)
                chunks.append(text)
                yield text

            return {"source_documents": sources}

        async def event_generator():
            loop = asyncio.get_event_loop()
            gen = await loop.run_in_executor(None, _multi_stream)
            sources = []
            try:
                while True:
                    result = await loop.run_in_executor(None, _next_token, gen)
                    if isinstance(result, tuple) and result[0] is _STREAM_END:
                        meta = result[1] or {}
                        sources = meta.get("source_documents", [])
                        break
                    yield f"data: {json.dumps({'token': result})}\n\n"
            except Exception:
                logger.exception("Multi-tab streaming failed")
                yield f"data: {json.dumps({'error': 'Stream failed'})}\n\n"
                return
            yield f"data: {json.dumps({'done': True, 'sources': sources})}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    return app


async def _run_chain(session, question: str) -> dict:
    """Invoke the chat session; run in executor since LangChain may block."""
    import asyncio

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: session.chat_session.invoke(question),
    )
