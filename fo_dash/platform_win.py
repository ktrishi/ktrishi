"""Windows-only helpers with safe no-op fallbacks elsewhere."""
from __future__ import annotations

import logging
import queue
import sys
import threading
from typing import Callable

log = logging.getLogger(__name__)
_ES_CONTINUOUS = 0x80000000
_ES_SYSTEM_REQUIRED = 0x00000001


def _set_thread_state(on: bool) -> None:
    if sys.platform != "win32":
        return
    import ctypes
    flags = _ES_CONTINUOUS | _ES_SYSTEM_REQUIRED if on else _ES_CONTINUOUS
    ctypes.windll.kernel32.SetThreadExecutionState(flags)


class KeepAwake:
    """SetThreadExecutionState is per-thread, so every on/off call runs on one dedicated thread."""

    def __init__(self, setter: Callable[[bool], None] = _set_thread_state):
        self._setter = setter
        self._q: queue.Queue = queue.Queue()
        threading.Thread(target=self._run, name="keep-awake", daemon=True).start()

    def _run(self) -> None:
        while True:
            on = self._q.get()
            try:
                self._setter(on)
            except Exception:
                log.exception("keep-awake call failed")
            finally:
                self._q.task_done()

    def set(self, on: bool) -> None:
        self._q.put(on)

    def flush(self) -> None:
        self._q.join()


_keeper: KeepAwake | None = None


def keep_awake(on: bool) -> None:
    global _keeper
    if _keeper is None:
        _keeper = KeepAwake()
    _keeper.set(on)


def notify(title: str, body: str) -> None:
    log.info("NOTIFY %s — %s", title, body)
    if sys.platform != "win32":
        return
    try:
        from winotify import Notification
        Notification(app_id="F&O Expiry Dashboard", title=title, msg=body).show()
    except Exception:  # a failed toast must never stop the scheduler
        log.exception("notification failed")
