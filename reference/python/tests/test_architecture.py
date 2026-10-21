"""The simulation must never be able to reach the renderer.

This is the load-bearing architectural rule: if `combat` can import `ursina`
then headless mode, deterministic replay and the test suite all rot from the
inside.  Enforced two ways — statically over the import graph, and dynamically
by importing and running the simulation with the engine blocked entirely.
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "trenchline"

SIMULATION_DIRS = (
    "core", "world", "physics", "combat", "vehicles", "drones", "ai", "data",
)
FORBIDDEN_ROOTS = ("ursina", "panda3d", "direct")
FORBIDDEN_PACKAGE_PARTS = ("render", "ui", "audio")


def _simulation_modules() -> list[Path]:
    files = [PACKAGE / "session.py"]
    for name in SIMULATION_DIRS:
        files.extend(sorted((PACKAGE / name).rglob("*.py")))
    return files


def _resolve(node: ast.ImportFrom, path: Path) -> str:
    """Turn a relative import into a dotted module path."""
    if not node.level:
        return node.module or ""
    parts = path.relative_to(ROOT).with_suffix("").parts
    if parts[-1] == "__init__":
        parts = parts[:-1]
    base = list(parts[: len(parts) - node.level])
    if node.module:
        base.extend(node.module.split("."))
    return ".".join(base)


@pytest.mark.parametrize("path", _simulation_modules(), ids=lambda p: p.name)
def test_simulation_module_imports_no_renderer(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    offences: list[str] = []
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [_resolve(node, path)]
        for name in names:
            head = name.split(".")[0]
            if head in FORBIDDEN_ROOTS:
                offences.append(f"line {node.lineno}: {name}")
            if name.startswith("trenchline."):
                part = name.split(".")[1]
                if part in FORBIDDEN_PACKAGE_PARTS:
                    offences.append(f"line {node.lineno}: {name}")
    assert not offences, f"{path.relative_to(ROOT)} imports presentation code: {offences}"


def test_simulation_runs_with_engine_blocked() -> None:
    """Import and tick the whole simulation with ursina/panda3d unimportable."""
    script = """
import sys

class Blocker:
    def find_module(self, name, path=None):
        return self.find_spec(name, path)
    def find_spec(self, name, path=None, target=None):
        if name.split('.')[0] in ('ursina', 'panda3d', 'direct'):
            raise ImportError(f'engine import blocked in simulation: {name}')
        return None

sys.meta_path.insert(0, Blocker())

from trenchline.session import Session, SessionConfig
s = Session(SessionConfig(seed=5))
s.run_ticks(120)
assert 'ursina' not in sys.modules and 'panda3d' not in sys.modules
print('OK', s.state_digest())
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, cwd=ROOT
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("OK"), result.stdout
