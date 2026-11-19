"""FastAPI app: the dashboard page, its JSON state, and the Kite login round-trip."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from fo_dash.web.state import build_state

STATIC = Path(__file__).parent / "static"
log = logging.getLogger(__name__)


def create_app(store, orch, source, now_fn) -> FastAPI:
    app = FastAPI(title="F&O Expiry Dashboard", docs_url=None, redoc_url=None)
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/state")
    def state():
        return JSONResponse(build_state(store, orch, now_fn()))

    @app.get("/kite/login")
    def login():
        return RedirectResponse(source.login_url(), status_code=302)

    @app.get("/kite/callback")
    def callback(request_token: str | None = None, status: str | None = None):
        if status != "success" or not request_token:
            return RedirectResponse("/?login=failed", status_code=302)
        try:
            source.complete_login(request_token)
        except Exception:
            log.exception("Kite login failed")
            return RedirectResponse("/?login=failed", status_code=302)
        orch.status["login"] = "ok"
        try:
            orch.morning_setup()
        except Exception:
            log.exception("setup after login failed")
        return RedirectResponse("/", status_code=302)

    return app
