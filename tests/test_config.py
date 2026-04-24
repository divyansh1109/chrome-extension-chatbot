"""Unit tests for the config module."""

import os
from unittest.mock import patch

import pytest

from backend.config import Settings


class TestSettingsFromEnv:
    """Test Settings.from_env() with various environment configurations."""

    def test_raises_when_no_api_key(self):
        with patch.dict(os.environ, {}, clear=True):
            # Remove OPENAI_API_KEY if present
            os.environ.pop("OPENAI_API_KEY", None)
            with pytest.raises(ValueError, match="OPENAI_API_KEY"):
                Settings.from_env()

    def test_default_values(self):
        env = {"OPENAI_API_KEY": "sk-test-key-123"}
        with patch.dict(os.environ, env, clear=True):
            s = Settings.from_env()
            assert s.openai_api_key == "sk-test-key-123"
            assert s.model_name == "gpt-4o-mini"
            assert s.chunk_size == 1000
            assert s.chunk_overlap == 200
            assert s.max_context_tokens == 6000
            assert s.host == "127.0.0.1"
            assert s.port == 8765
            assert s.cors_origins == ["chrome-extension://*"]

    def test_custom_values(self):
        env = {
            "OPENAI_API_KEY": "sk-custom",
            "CHAT_MODEL": "gpt-4o",
            "CHUNK_SIZE": "500",
            "CHUNK_OVERLAP": "100",
            "MAX_CONTEXT_TOKENS": "4000",
            "HOST": "0.0.0.0",
            "PORT": "9999",
            "CORS_ORIGINS": "http://localhost:3000, http://example.com",
        }
        with patch.dict(os.environ, env, clear=True):
            s = Settings.from_env()
            assert s.model_name == "gpt-4o"
            assert s.chunk_size == 500
            assert s.chunk_overlap == 100
            assert s.port == 9999
            assert s.cors_origins == ["http://localhost:3000", "http://example.com"]

    def test_settings_are_frozen(self):
        env = {"OPENAI_API_KEY": "sk-test"}
        with patch.dict(os.environ, env, clear=True):
            s = Settings.from_env()
            with pytest.raises(AttributeError):
                s.model_name = "changed"
