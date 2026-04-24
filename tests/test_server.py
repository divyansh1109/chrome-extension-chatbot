"""Integration tests for the FastAPI server endpoints."""

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


class TestDeleteSession:
    def test_delete_returns_ok(self, client):
        resp = client.delete("/session/any-id")
        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"
