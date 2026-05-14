"""Integration tests for the FastAPI server endpoints."""

import json
import os
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
        host="0.0.0.0",
        port=8765,
        cors_origins=["*"],
        ollama_base_url="http://localhost:11434",
        fallback_model="gemma2:9b",
        multilingual_model="qwen2.5:7b",
    )


@pytest.fixture()
def client(settings, tmp_path):
    # Use an isolated SQLite database for each test
    db_file = str(tmp_path / "test.db")
    with patch("backend.chat_store.DB_PATH", db_file), \
         patch("backend.server.chat_store.DB_PATH", db_file):
        app = create_app(settings)
        with TestClient(app) as c:
            yield c


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
    def test_stream_returns_answer(
        self, mock_build_vs, mock_chat_session_cls, client
    ):
        mock_vs = MagicMock()
        mock_vs.index.ntotal = 3
        mock_build_vs.return_value = mock_vs

        mock_chat = MagicMock()
        mock_chat.invoke.return_value = {
            "answer": "Hello world",
            "source_documents": ["chunk1"],
        }
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

        # Chat
        resp = client.post(
            "/chat/stream",
            json={"session_id": session_id, "question": "Hi?"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["answer"] == "Hello world"
        assert data["sources"] == ["chunk1"]

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


class TestChatUI:
    def test_chat_ui_renders(self, client):
        resp = client.get("/chat-ui")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert "chatApp" in resp.text

    def test_chat_ui_with_session_id(self, client):
        resp = client.get("/chat-ui?session_id=test123")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]


class TestTabsEndpoints:
    def test_list_tabs_empty(self, client):
        resp = client.get("/tabs")
        assert resp.status_code == 200
        assert resp.json()["tabs"] == []

    def test_register_and_list_tab(self, client):
        client.post(
            "/tabs/42",
            json={"session_id": "s1", "url": "https://x.com", "title": "X"},
        )
        resp = client.get("/tabs")
        assert resp.status_code == 200
        tabs = resp.json()["tabs"]
        assert len(tabs) == 1
        assert tabs[0]["session_id"] == "s1"

    def test_unregister_tab(self, client):
        client.post(
            "/tabs/42",
            json={"session_id": "s1", "url": "https://x.com", "title": "X"},
        )
        resp = client.delete("/tabs/42")
        assert resp.status_code == 200
        tabs = client.get("/tabs").json()["tabs"]
        assert len(tabs) == 0


class TestHistoryEndpoint:
    def test_save_history(self, client):
        resp = client.post(
            "/history/sess1",
            json={"messages": [{"role": "user", "text": "hi"}]},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "saved"
