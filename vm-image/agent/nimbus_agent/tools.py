"""Kern-Tools analog zo.computer — nur innerhalb der User-VM."""

from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path
from typing import Any

WORKSPACE = Path(os.environ.get("NIMBUS_WORKSPACE", "/home/workspace"))
MAX_OUT = 20_000


def _clip(text: str) -> str:
    text = str(text or "")
    if len(text) > MAX_OUT:
        return text[:MAX_OUT] + f"\n… [{len(text) - MAX_OUT} Zeichen abgeschnitten]"
    return text


def _resolve(path: str) -> Path:
    p = Path(path)
    if not p.is_absolute():
        p = WORKSPACE / p
    return p.resolve()


async def bash(command: str, cwd: str | None = None, timeout: int = 120) -> dict[str, Any]:
    """Führt einen Shell-Befehl aus."""
    work = _resolve(cwd) if cwd else WORKSPACE
    work.mkdir(parents=True, exist_ok=True)
    proc = await asyncio.create_subprocess_shell(
        command,
        cwd=str(work),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "NIMBUS": "1"},
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return {"exit_code": -1, "stdout": "", "stderr": f"Timeout nach {timeout}s"}
    return {
        "exit_code": proc.returncode,
        "stdout": _clip(stdout.decode("utf-8", errors="replace")),
        "stderr": _clip(stderr.decode("utf-8", errors="replace")),
    }


async def read_file(path: str) -> dict[str, Any]:
    full = _resolve(path)
    if not full.exists():
        return {"error": f"Nicht gefunden: {full}"}
    if full.stat().st_size > 512 * 1024:
        return {"error": "Datei > 512 KB — nutze bash mit head/tail."}
    return {"path": str(full), "content": _clip(full.read_text(encoding="utf-8", errors="replace"))}


async def write_file(path: str, content: str) -> dict[str, Any]:
    full = _resolve(path)
    full.parent.mkdir(parents=True, exist_ok=True)
    data = content or ""
    full.write_text(data, encoding="utf-8")
    return {"ok": True, "path": str(full), "bytes": len(data.encode("utf-8"))}


async def list_directory(path: str = ".") -> dict[str, Any]:
    full = _resolve(path)
    if not full.exists():
        return {"error": f"Nicht gefunden: {full}"}
    entries = []
    for name in sorted(os.listdir(full))[:500]:
        p = full / name
        try:
            st = p.stat()
            entries.append({
                "name": name,
                "type": "dir" if p.is_dir() else "file",
                "size": st.st_size,
            })
        except OSError:
            entries.append({"name": name, "type": "unknown", "size": 0})
    return {"path": str(full), "entries": entries}


async def agent_browser(url: str, action: str = "snapshot", selector: str | None = None) -> dict[str, Any]:
    """Playwright-Browser für Web-Aufgaben (Navigation / Text / Screenshot-Pfad)."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        # Fallback: curl + text
        result = subprocess.run(
            ["curl", "-fsSL", "-A", "NimbusAgent/1.0", url],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {
            "ok": result.returncode == 0,
            "mode": "curl_fallback",
            "url": url,
            "content": _clip(result.stdout),
            "stderr": _clip(result.stderr),
        }

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        title = await page.title()
        if action == "screenshot":
            shot_dir = WORKSPACE / "browser-shots"
            shot_dir.mkdir(parents=True, exist_ok=True)
            shot_path = shot_dir / "last.png"
            await page.screenshot(path=str(shot_path), full_page=True)
            await browser.close()
            return {"ok": True, "url": url, "title": title, "screenshot": str(shot_path)}
        if action == "click" and selector:
            await page.click(selector, timeout=10000)
        content = await page.inner_text("body")
        await browser.close()
        return {"ok": True, "url": url, "title": title, "content": _clip(content)}
