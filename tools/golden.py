"""Print, or rewrite, the committed determinism digests.

The golden file is the record of what a seed is *supposed* to produce.  Change
generation, physics or an RNG draw and the digests move; that is the alarm
working.  Rewriting them is therefore a deliberate act with a diff to review,
not something a test does for itself.

    python -m tools.golden                 # show current vs committed
    python -m tools.golden --update        # rewrite the golden file
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from trenchline.session import Session, SessionConfig

GOLDEN_PATH = Path(__file__).resolve().parent.parent / "tests" / "golden_digests.json"

CASES: tuple[dict[str, object], ...] = (
    {"seed": 7, "ticks": 600, "script": "patrol"},
    {"seed": 21, "ticks": 600, "script": "random"},
    {"seed": 99, "ticks": 240, "script": "walk"},
)
"""Two scripts that draw from the RNG and one that does not, so a drift in the
input stream and a drift in the physics are distinguishable."""


def case_key(case: dict[str, object]) -> str:
    return f"seed{case['seed']}-{case['script']}-{case['ticks']}"


def run_case(case: dict[str, object]) -> dict[str, str]:
    session = Session(SessionConfig(seed=int(case["seed"])))
    session.run_scripted(str(case["script"]), int(case["ticks"]))
    return session.digests()


def compute() -> dict[str, dict[str, str]]:
    return {case_key(case): run_case(case) for case in CASES}


def load() -> dict[str, dict[str, str]]:
    if not GOLDEN_PATH.exists():
        return {}
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))["digests"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true", help="rewrite the golden file")
    args = ap.parse_args()

    current = compute()
    committed = load()

    drifted = False
    for key, digests in current.items():
        old = committed.get(key, {})
        for part in ("world", "entities", "rng", "state"):
            was, now = old.get(part), digests[part]
            flag = " " if was == now else ("+" if was is None else "!")
            if flag != " ":
                drifted = True
            print(f"{flag} {key:24s} {part:9s} {now}"
                  + ("" if was in (None, now) else f"   was {was}"))

    if args.update:
        GOLDEN_PATH.write_text(
            json.dumps(
                {
                    "_comment": (
                        "Committed determinism digests. Regenerate deliberately "
                        "with `python -m tools.golden --update` and review the diff: "
                        "a change here means the same seed no longer produces the "
                        "same run."
                    ),
                    "cases": list(CASES),
                    "digests": current,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"\nwrote {GOLDEN_PATH}")
        return 0

    if drifted:
        print("\ndigests differ from the golden file")
    return 1 if drifted else 0


if __name__ == "__main__":
    raise SystemExit(main())
