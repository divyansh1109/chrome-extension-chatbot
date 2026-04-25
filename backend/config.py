"""Application configuration loaded from environment variables."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """Immutable application settings."""

    openai_api_key: str
    model_name: str
    chunk_size: int
    chunk_overlap: int
    max_context_tokens: int
    host: str
    port: int
    cors_origins: list[str]
    ollama_base_url: str
    fallback_model: str
    multilingual_model: str

    @classmethod
    def from_env(cls) -> "Settings":
        api_key = os.environ.get("OPENAI_API_KEY", "")
        if not api_key:
            raise ValueError(
                "OPENAI_API_KEY environment variable is required. "
                "Set it before starting the server."
            )
        origins_raw = os.environ.get("CORS_ORIGINS", "chrome-extension://*")
        return cls(
            openai_api_key=api_key,
            model_name=os.environ.get("CHAT_MODEL", "gpt-4o-mini"),
            chunk_size=int(os.environ.get("CHUNK_SIZE", "1500")),
            chunk_overlap=int(os.environ.get("CHUNK_OVERLAP", "200")),
            max_context_tokens=int(os.environ.get("MAX_CONTEXT_TOKENS", "6000")),
            host=os.environ.get("HOST", "0.0.0.0"),
            port=int(os.environ.get("PORT", "8765")),
            cors_origins=[o.strip() for o in origins_raw.split(",")],
            ollama_base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434"),
            fallback_model=os.environ.get("FALLBACK_MODEL", "gemma2:9b"),
            multilingual_model=os.environ.get("MULTILINGUAL_MODEL", "qwen2.5:7b"),
        )
