"""Entry point – starts the FastAPI backend server."""

import logging

import uvicorn
from dotenv import load_dotenv

from backend.config import Settings
from backend.server import create_app


def main() -> None:
    load_dotenv()  # Load .env file if present
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    settings = Settings.from_env()
    app = create_app(settings)

    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
