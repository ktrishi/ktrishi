import threading

from fo_dash.platform_win import KeepAwake


def test_keep_awake_on_and_off_run_on_one_thread():
    seen = []
    ka = KeepAwake(setter=lambda on: seen.append((on, threading.get_ident())))
    ka.set(True)
    ka.set(False)
    ka.flush()
    assert [s[0] for s in seen] == [True, False] and seen[0][1] == seen[1][1]
    assert seen[0][1] != threading.get_ident()
