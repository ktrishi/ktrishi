from fo_dash.config import UNDERLYINGS, load_settings
from fo_dash.models import Prediction


def test_underlyings_config():
    names = [u.name for u in UNDERLYINGS]
    assert names == ["NIFTY", "BANKNIFTY"]
    assert UNDERLYINGS[0].kinds == ("weekly", "monthly") and UNDERLYINGS[0].strike_step == 50
    assert UNDERLYINGS[1].kinds == ("monthly",) and UNDERLYINGS[1].change_threshold == 0.004


def test_load_settings_reads_env(tmp_path, monkeypatch):
    for k in ("KITE_API_KEY", "KITE_API_SECRET", "FO_DATA_DIR"):
        monkeypatch.delenv(k, raising=False)
    env = tmp_path / ".env"
    env.write_text(f"KITE_API_KEY=k\nKITE_API_SECRET=s\nFO_DATA_DIR={tmp_path/'d'}\n")
    s = load_settings(env)
    assert (s.api_key, s.api_secret) == ("k", "s") and s.data_dir.is_dir()


def test_prediction_roundtrip(sample_prediction):
    assert Prediction.from_dict(sample_prediction.to_dict()) == sample_prediction
