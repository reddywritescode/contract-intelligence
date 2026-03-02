from __future__ import annotations

from typing import Any

from litellm import completion

from app.core.config import settings


class ModelGateway:
    def __init__(self) -> None:
        self.primary_model = settings.primary_model
        self.fallback_model = settings.fallback_model
        self.api_key = settings.openrouter_api_key

    def generate(self, prompt: str, system: str = "You are a precise legal AI assistant.") -> dict[str, Any]:
        if not self.api_key:
            # Deterministic fallback path for local development without API keys.
            return {
                "content": "Local mode response: configure OPENROUTER_API_KEY for live model outputs.",
                "model": "local-fallback",
                "used_fallback": False,
            }

        try:
            resp = completion(
                model=self.primary_model,
                api_key=self.api_key,
                base_url="https://openrouter.ai/api/v1",
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
            )
            return {
                "content": resp.choices[0].message.content,
                "model": self.primary_model,
                "used_fallback": False,
            }
        except Exception:
            resp = completion(
                model=self.fallback_model,
                api_key=self.api_key,
                base_url="https://openrouter.ai/api/v1",
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
            )
            return {
                "content": resp.choices[0].message.content,
                "model": self.fallback_model,
                "used_fallback": True,
            }


gateway = ModelGateway()
