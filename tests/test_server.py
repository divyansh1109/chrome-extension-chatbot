"""Integration tests for the FastAPI server endpoints."""

import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from backend.config import Settings
from backend.server import create_app


@pytest.fixture()
def settings():
    return Settings(
        openai_api_key="sk-test",
        model_name="gpt-4o-mini",
        chunk_size=500,
        chunk_overlap=100,
        max_context_tokens=4000,
        host="127.0.0.1",
        port=8765,
        cors_origins=["*"],
        ollama_base_url="http://localhost:11434",
        fallback_model="gemma2:9b",
        multilingual_model="qwen2.5:7b",
    )


@pytest.fixture()
def client(settings):
    app = create_app(settings)
    return TestClient(app)


class TestHealthEndpoint:
    def test_health_returns_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestCreateSession:
    @patch("backend.server.SessionManager")
    def test_rejects_empty_content(self, _mock_mgr, settings):
        app = create_app(settings)
        c = TestClient(app)
        resp = c.post(
            "/session",
            json={"url": "https://example.com", "title": "Ex", "text_content": "   "},
        )
        assert resp.status_code == 400
        assert "empty" in resp.json()["detail"].lower()

    @patch("backend.session_manager.ChatSession")
    @patch("backend.session_manager.build_vectorstore")
    def test_creates_session_successfully(
        self, mock_build_vs, mock_chat_session_cls, client
    ):
        mock_vs = MagicMock()
        mock_vs.index.ntotal = 7
        mock_build_vs.return_value = mock_vs
        mock_chat_session_cls.return_value = MagicMock()

        resp = client.post(
            "/session",
            json={
                "url": "https://example.com/product",
                "title": "Great Product",
                "text_content": "This is a great product with many features.",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "session_id" in data
        assert data["url"] == "https://example.com/product"
        assert data["chunk_count"] == 7

    @patch("backend.session_manager.ChatSession")
    @patch("backend.session_manager.build_vectorstore")
    def test_creates_session_with_structured_data(
        self, mock_build_vs, mock_chat_session_cls, client
    ):
        mock_vs = MagicMock()
        mock_vs.index.ntotal = 10
        mock_build_vs.return_value = mock_vs
        mock_chat_session_cls.return_value = MagicMock()

        structured_data = [
            {
                "@type": "Product",
                "name": "Sony WH-1000XM5",
                "offers": {"@type": "Offer", "price": "299.99", "priceCurrency": "USD"},
            }
        ]

        resp = client.post(
            "/session",
            json={
                "url": "https://example.com/product",
                "title": "Sony Headphones",
                "text_content": "Sony headphones page content.",
                "structured_data": structured_data,
            },
        )
        assert resp.status_code == 200
        # Verify build_vectorstore was called with structured_data
        mock_build_vs.assert_called_once()
        call_kwargs = mock_build_vs.call_args
        assert call_kwargs[1]["structured_data"] == structured_data


class TestChatEndpoint:
    @patch("backend.session_manager.ChatSession")
    @patch("backend.session_manager.build_vectorstore")
    def test_chat_returns_answer(self, mock_build_vs, mock_chat_session_cls, client):
        # Setup: create a session first
        mock_vs = MagicMock()
        mock_vs.index.ntotal = 3
        mock_build_vs.return_value = mock_vs

        mock_chat = MagicMock()
        mock_chat.invoke.return_value = {
            "answer": "The product has noise cancellation.",
            "source_documents": [],
        }
        mock_chat_session_cls.return_value = mock_chat

        # Create session
        resp = client.post(
            "/session",
            json={
                "url": "https://amazon.in/product",
                "title": "Sony Headphones",
                "text_content": "Sony headphones with active noise cancellation.",
            },
        )
        session_id = resp.json()["session_id"]

        # Chat
        resp = client.post(
            "/chat",
            json={"session_id": session_id, "question": "Does it have noise cancellation?"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "noise cancellation" in data["answer"].lower()

    def test_chat_with_unknown_session(self, client):
        resp = client.post(
            "/chat",
            json={"session_id": "nonexistent", "question": "Hello?"},
        )
        assert resp.status_code == 404


class TestChatStreamEndpoint:
    @patch("backend.session_manager.ChatSession")
    @patch("backend.session_manager.build_vectorstore")
    def test_stream_returns_tokens_and_done(
        self, mock_build_vs, mock_chat_session_cls, client
    ):
        mock_vs = MagicMock()
        mock_vs.index.ntotal = 3
        mock_build_vs.return_value = mock_vs

        # Build a mock chat_session with a stream() that yields tokens
        def fake_stream(question):
            yield "Hello"
            yield " world"
            return {"answer": "Hello world", "source_documents": ["chunk1"]}

        mock_chat = MagicMock()
        mock_chat.stream = fake_stream
        mock_chat_session_cls.return_value = mock_chat

        # Create session
        resp = client.post(
            "/session",
            json={
                "url": "https://example.com",
                "title": "Test",
                "text_content": "Some content here.",
            },
        )
        session_id = resp.json()["session_id"]

        # Stream chat
        resp = client.post(
            "/chat/stream",
            json={"session_id": session_id, "question": "Hi?"},
        )
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]

        # Parse SSE events
        events = []
        for line in resp.text.strip().split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))

        # Should have token events and a done event
        token_events = [e for e in events if "token" in e]
        done_events = [e for e in events if e.get("done")]

        assert len(token_events) == 2
        assert token_events[0]["token"] == "Hello"
        assert token_events[1]["token"] == " world"
        assert len(done_events) == 1
        assert done_events[0]["sources"] == ["chunk1"]

    def test_stream_with_unknown_session(self, client):
        resp = client.post(
            "/chat/stream",
            json={"session_id": "nonexistent", "question": "Hello?"},
        )
        assert resp.status_code == 404


class TestDeleteSession:
    def test_delete_returns_ok(self, client):
        resp = client.delete("/session/any-id")
        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"
