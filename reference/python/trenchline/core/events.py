"""Minimal typed event bus.

Systems talk through events rather than holding references to each other; this
is what keeps `combat` from importing `render` to make a muzzle flash.  Events
are frozen dataclasses; subscribers are keyed by event class.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Callable, TypeVar

E = TypeVar("E")


@dataclass(frozen=True, slots=True)
class Event:
    """Base class.  Subclass with frozen dataclasses carrying plain data."""


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[type, list[Callable[..., None]]] = defaultdict(list)
        self._queue: list[Event] = []

    def subscribe(self, event_type: type[E], handler: Callable[[E], None]) -> None:
        self._subs[event_type].append(handler)

    def unsubscribe(self, event_type: type[E], handler: Callable[[E], None]) -> None:
        handlers = self._subs.get(event_type)
        if handlers and handler in handlers:
            handlers.remove(handler)

    def publish(self, event: Event) -> None:
        """Deliver immediately, in subscription order."""
        for handler in self._subs.get(type(event), ()):
            handler(event)

    def post(self, event: Event) -> None:
        """Defer until the next `drain()`.  Use when publishing from a handler."""
        self._queue.append(event)

    def drain(self) -> None:
        while self._queue:
            batch, self._queue = self._queue, []
            for event in batch:
                self.publish(event)

    def clear(self) -> None:
        self._subs.clear()
        self._queue.clear()
