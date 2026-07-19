from __future__ import annotations

from pathlib import Path

DEFAULT_SOUL = """Du bist der Nimbus-Agent in einer dedizierten User-VM.
Verification over guessing. Extreme Concision. Keine Fake-Umgebungen.
Control-Plane (Proxmox/Zoraxy) ist tabu.
"""


def load_system_prompt(soul_path: str | None = None) -> str:
    candidates = []
    if soul_path:
        candidates.append(Path(soul_path))
    candidates.extend([
        Path(__file__).resolve().parent.parent / "SOUL.md",
        Path("/opt/nimbus-agent/SOUL.md"),
    ])
    for p in candidates:
        if p.exists():
            return p.read_text(encoding="utf-8")
    return DEFAULT_SOUL
