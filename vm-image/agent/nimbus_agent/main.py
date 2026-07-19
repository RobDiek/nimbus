"""
Nimbus in-VM Agent HTTP-Service.

POST /v1/ask  {
  "prompt": "...",
  "model": "optional",
  "system": "optional override",
  "messages": [{"role":"user|assistant","content":"..."}],
  "credentials": {"openai_api_key": "...", ...},
  "max_turns": 12
}
GET  /health
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

from .prompts import load_system_prompt
from . import tools

app = FastAPI(title="Nimbus VM Agent", version="1.1.0")
PORT = int(os.environ.get("NIMBUS_AGENT_PORT", "8100"))


class ChatMessage(BaseModel):
    role: str = "user"
    content: str = ""


class AskCredentials(BaseModel):
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    google_api_key: str | None = None
    openrouter_api_key: str | None = None


class AskRequest(BaseModel):
    prompt: str = ""
    model: str | None = None
    system: str | None = None
    messages: list[ChatMessage] = Field(default_factory=list)
    credentials: AskCredentials | None = None
    max_turns: int = Field(default=12, ge=1, le=40)


class AskResponse(BaseModel):
    ok: bool
    output: str
    tool_trace: list[dict[str, Any]] = []
    mode: str = "tools"


def _tool_registry():
    return {
        "bash": tools.bash,
        "read_file": tools.read_file,
        "write_file": tools.write_file,
        "list_directory": tools.list_directory,
        "agent_browser": tools.agent_browser,
    }


def _apply_credentials(creds: AskCredentials | None) -> dict[str, str]:
    """Setzt Provider-Keys temporär in die Prozess-Umgebung (Request-Scope)."""
    previous: dict[str, str | None] = {}
    if not creds:
        return previous

    mapping = {
        "OPENAI_API_KEY": creds.openai_api_key,
        "ANTHROPIC_API_KEY": creds.anthropic_api_key,
        "GEMINI_API_KEY": creds.google_api_key,
        "GOOGLE_API_KEY": creds.google_api_key,
        "OPENROUTER_API_KEY": creds.openrouter_api_key,
    }
    for key, value in mapping.items():
        if not value:
            continue
        previous[key] = os.environ.get(key)
        os.environ[key] = value
    return previous


def _restore_credentials(previous: dict[str, str | None]) -> None:
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _compose_prompt(req: AskRequest) -> str:
    if req.messages:
        parts: list[str] = []
        for m in req.messages:
            role = (m.role or "user").upper()
            text = (m.content or "").strip()
            if text:
                parts.append(f"{role}: {text}")
        if parts:
            return "\n\n".join(parts)
    return (req.prompt or "").strip()


async def run_with_pydantic_ai(req: AskRequest) -> AskResponse:
    """Bevorzugter Pfad: Pydantic-AI Agent mit Kern-Tools."""
    try:
        from pydantic_ai import Agent
    except ImportError:
        return await run_tool_loop_fallback(req.prompt or _compose_prompt(req))

    soul = load_system_prompt(os.environ.get("NIMBUS_AGENT_SOUL_PATH"))
    system = (req.system or "").strip() or soul
    model_name = req.model or os.environ.get("NIMBUS_AGENT_MODEL", "openai:gpt-4o-mini")

    agent = Agent(model_name, system_prompt=system)

    @agent.tool_plain
    async def bash(command: str, cwd: str | None = None) -> dict:
        return await tools.bash(command, cwd)

    @agent.tool_plain
    async def read_file(path: str) -> dict:
        return await tools.read_file(path)

    @agent.tool_plain
    async def write_file(path: str, content: str) -> dict:
        return await tools.write_file(path, content)

    @agent.tool_plain
    async def list_directory(path: str = ".") -> dict:
        return await tools.list_directory(path)

    @agent.tool_plain
    async def agent_browser(url: str, action: str = "snapshot", selector: str | None = None) -> dict:
        return await tools.agent_browser(url, action, selector)

    prompt = _compose_prompt(req)
    if not prompt:
        return AskResponse(ok=False, output="Leerer Prompt.", tool_trace=[], mode="error")

    result = await agent.run(prompt)
    text = result.data if hasattr(result, "data") else str(result)
    return AskResponse(ok=True, output=str(text), tool_trace=[], mode="pydantic-ai")


async def run_tool_loop_fallback(prompt: str) -> AskResponse:
    """
    Minimaler Fallback ohne LLM-Key:
    erkennt einfache Intent-Patterns und führt Tools aus.
    """
    trace: list[dict[str, Any]] = []
    lower = prompt.lower().strip()

    if lower.startswith("bash:") or lower.startswith("! "):
        cmd = prompt.split(":", 1)[-1].strip() if ":" in prompt[:8] else prompt[2:].strip()
        out = await tools.bash(cmd)
        trace.append({"tool": "bash", "input": {"command": cmd}, "result": out})
        return AskResponse(ok=True, output=out.get("stdout") or out.get("stderr") or "", tool_trace=trace)

    if lower.startswith("read:"):
        path = prompt.split(":", 1)[1].strip()
        out = await tools.read_file(path)
        trace.append({"tool": "read_file", "input": {"path": path}, "result": out})
        return AskResponse(ok=True, output=out.get("content") or out.get("error") or "", tool_trace=trace)

    if lower.startswith("ls:") or lower.startswith("list:"):
        path = prompt.split(":", 1)[1].strip() or "."
        out = await tools.list_directory(path)
        trace.append({"tool": "list_directory", "input": {"path": path}, "result": out})
        return AskResponse(ok=True, output=str(out), tool_trace=trace)

    listing = await tools.list_directory(".")
    trace.append({"tool": "list_directory", "result": listing})
    msg = (
        "Kein LLM-Key konfiguriert (Fallback-Modus).\n"
        "Nutze: `bash: <cmd>`, `read: <path>`, `list: <path>` "
        "oder setze OPENAI_API_KEY / NIMBUS_AGENT_MODEL für Pydantic-AI.\n"
        f"Workspace: {listing.get('path')}"
    )
    return AskResponse(ok=True, output=msg, tool_trace=trace, mode="fallback")


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "nimbus-agent",
        "version": "1.1.0",
        "workspace": str(tools.WORKSPACE),
        "tools": list(_tool_registry().keys()),
    }


@app.post("/v1/ask", response_model=AskResponse)
async def ask(req: AskRequest):
    previous = _apply_credentials(req.credentials)
    try:
        try:
            return await run_with_pydantic_ai(req)
        except Exception as err:  # noqa: BLE001 — operativer Fallback
            prompt = _compose_prompt(req)
            fallback = await run_tool_loop_fallback(prompt)
            fallback.output = f"[pydantic-ai error: {err}]\n\n{fallback.output}"
            fallback.mode = "fallback-after-error"
            return fallback
    finally:
        _restore_credentials(previous)


def main():
    import uvicorn
    uvicorn.run("nimbus_agent.main:app", host="0.0.0.0", port=PORT, reload=False)


if __name__ == "__main__":
    main()
