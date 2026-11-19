"""Windows-only helpers with safe no-op fallbacks elsewhere."""
from __future__ import annotations

import logging
import sys

log = logging.getLogger(__name__)
_ES_CONTINUOUS = 0x80000000
_ES_SYSTEM_REQUIRED = 0x00000001


def keep_awake(on: bool) -> None:
    if sys.platform != "win32":
        return
    import ctypes
    flags = _ES_CONTINUOUS | _ES_SYSTEM_REQUIRED if on else _ES_CONTINUOUS
    ctypes.windll.kernel32.SetThreadExecutionState(flags)


def notify(title: str, body: str) -> None:
    log.info("NOTIFY %s — %s", title, body)
    if sys.platform != "win32":
        return
    try:
        from winotify import Notification
        Notification(app_id="F&O Expiry Dashboard", title=title, msg=body).show()
    except Exception:  # a failed toast must never stop the scheduler
        log.exception("notification failed")
