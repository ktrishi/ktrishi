def test_state_reports_login_needed(client, orch):
    orch.status["login"] = "login_needed"
    orch.source.logged_in = False
    st = client.get("/api/state").json()
    assert st["status"]["login"] == "login_needed" and st["status"]["stale"] is True


def test_state_panels_have_bands(client, orch, clock):
    clock.set(2026, 11, 19, 10, 0)
    orch.morning_setup()
    orch.snapshot_job()
    st = client.get("/api/state").json()
    assert [p["key"] for p in st["panels"]] == ["NIFTY-weekly", "NIFTY-monthly", "BANKNIFTY-monthly"]
    for p in st["panels"]:
        assert p["prediction"]["band68"] and p["prediction"]["band90"]
        assert p["oi_chart"]["strikes"] and len(p["oi_chart"]["ce_oi"]) == len(p["oi_chart"]["strikes"])
    assert st["panels"][0]["expiry_label"] == "Mon 23-Nov"
    assert st["status"]["calibration"] == "uncalibrated" and st["status"]["stale"] is False
    assert st["status"]["next_reassessment"] == "12:30"


def test_stale_after_ten_minutes(client, orch, clock):
    clock.set(2026, 11, 19, 10, 0)
    orch.morning_setup()
    orch.snapshot_job()
    clock.set(2026, 11, 19, 10, 11)
    assert client.get("/api/state").json()["status"]["stale"] is True


def test_drift_and_log_from_locked(client, orch, clock):
    from datetime import time
    clock.set(2026, 11, 19, 9, 45)
    orch.morning_setup()
    orch.reassess_job(time(9, 45))
    p = client.get("/api/state").json()["panels"][0]
    assert len(p["drift"]) == 1 and p["log"][0]["reason"] == "first prediction of the series"


def test_callback_completes_login(client, orch):
    r = client.get("/kite/callback?request_token=rt&status=success", follow_redirects=False)
    assert r.status_code == 302 and orch.source.completed_with == "rt" and orch.status["login"] == "ok"


def test_callback_failure_redirects(client, orch):
    r = client.get("/kite/callback?status=cancelled", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?login=failed"


def test_login_redirects_to_kite(client):
    r = client.get("/kite/login", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("https://kite.zerodha.com/")


def test_index_served(client):
    assert "Log in to Kite" in client.get("/").text
