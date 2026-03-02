from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Contract Intelligence API"
    app_env: str = Field(default="development", alias="APP_ENV")
    backend_cors_origins: str = Field(default="http://localhost:3000,http://localhost:8000,http://127.0.0.1:3000,http://127.0.0.1:8000")

    database_url: str = Field(
        default="postgresql://app:app@localhost:5432/contracts", alias="DATABASE_URL"
    )

    openrouter_api_key: Optional[str] = Field(default=None, alias="OPENROUTER_API_KEY")
    openai_api_key: Optional[str] = Field(default=None, alias="OPENAI_API_KEY")
    primary_model: str = Field(default="openrouter/anthropic/claude-3.5-sonnet", alias="PRIMARY_MODEL")
    fallback_model: str = Field(default="openrouter/openai/gpt-4o-mini", alias="FALLBACK_MODEL")
    embedding_model: str = Field(default="text-embedding-3-small", alias="EMBEDDING_MODEL")
    embedding_dimensions: int = Field(default=1536, alias="EMBEDDING_DIMENSIONS")


settings = Settings()
