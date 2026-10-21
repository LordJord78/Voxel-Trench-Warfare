"""Loader for the single tunable data file.

`tunables.toml` is the only place feel values live.  Logic reads them by dotted
key; nothing hard-codes a magnitude.  Reloading is supported so values can be
adjusted without restarting a session.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

TUNABLES_PATH: Path = Path(__file__).with_name("tunables.toml")


class Tunables:
    """Read-only dotted-key view over the tuning file."""

    __slots__ = ("_raw", "_path")

    def __init__(self, raw: dict[str, Any], path: Path | None = None) -> None:
        self._raw = raw
        self._path = path

    def __getitem__(self, key: str) -> Any:
        node: Any = self._raw
        for part in key.split("."):
            if not isinstance(node, dict) or part not in node:
                raise KeyError(f"tunable {key!r} not found (missing {part!r})")
            node = node[part]
        return node

    def get(self, key: str, default: Any = None) -> Any:
        try:
            return self[key]
        except KeyError:
            return default

    def f(self, key: str) -> float:
        return float(self[key])

    def i(self, key: str) -> int:
        return int(self[key])

    def section(self, key: str) -> dict[str, Any]:
        node = self[key]
        if not isinstance(node, dict):
            raise KeyError(f"tunable {key!r} is not a section")
        return dict(node)

    def sections(self, key: str) -> list[str]:
        return sorted(self.section(key).keys())

    def reload(self) -> None:
        if self._path is not None:
            self._raw = tomllib.loads(self._path.read_text(encoding="utf-8"))

    def __repr__(self) -> str:
        return f"Tunables({sorted(self._raw)})"


def load_tunables(path: Path | None = None) -> Tunables:
    resolved = path or TUNABLES_PATH
    return Tunables(tomllib.loads(resolved.read_text(encoding="utf-8")), resolved)


__all__ = ["Tunables", "load_tunables", "TUNABLES_PATH"]
