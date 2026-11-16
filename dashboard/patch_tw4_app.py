"""Patch tw4_app.js into the consolidated Tiwari Family Wealth app.

Usage (on the PC, in financial/reports):
    python patch_tw4_app.py            # backs up tw4_app.js, prepends tw5_consolidated.js, applies the patches
    python patch_tw4_app.py [path\to\tw4_app.js]
    python patch_tw4_app.py --check    # report whether tw4_app.js is already patched; changes nothing

Idempotent: a file that already carries the TW5 marker is left alone. Every replacement is an
exact-string replace guarded by an assert, per the TW write rules. build_v4.js then inlines the
patched tw4_app.js as before; nothing else in the pipeline changes.
"""
import io, os, sys, time, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
_pos = [a for a in sys.argv[1:] if not a.startswith('--')]
APP = os.path.abspath(_pos[0]) if _pos else os.path.join(os.getcwd(), 'tw4_app.js')
MOD = os.path.join(HERE, 'tw5_consolidated.js')
MARK = '/* TW5-CONSOLIDATED v1 */'

PATCHES = [
    # 1 tabs: Update & Audit after Brief, Behavioural after Advisor, History after Retirement, Export after Audit
    ("['brief', 'Brief'], ['family', 'Family Portfolio'], ['advisor', 'Advisor'],",
     "['brief', 'Brief'], ['update', 'Update & Audit'], ['family', 'Family Portfolio'], ['advisor', 'Advisor'], ['behaviour', 'Behavioural'],"),
    ("['plan', 'Retirement'], ['audit', 'Audit'],",
     "['plan', 'Retirement'], ['history', 'History'], ['audit', 'Audit'], ['export', 'Export'],"),
    # 2 views
    ("const VIEW = { health: [tabHealth],",
     "const VIEW = { update: [() => window.TW5.tabUpdate(), () => window.TW5.initUpdateTab()], behaviour: [() => window.TW5.tabBehaviour()], history: [() => window.TW5.tabHistory(), () => window.TW5.initHistory()], export: [() => window.TW5.tabExport()], health: [tabHealth],"),
    # 3 header Update button opens the Update & Audit tab
    ("if (t.id === 'upd-go') { go('maintain'); const bx = $q('#upd-box'); if (bx) bx.scrollIntoView({ block: 'center' }); return; }",
     "if (t.id === 'upd-go') { go('update'); return; }"),
    # 4 expose helpers to the consolidation layer
    ("window.TWAPP = { S, render, get R() { return R; } };",
     "window.TWAPP = { S, render, go, get R() { return R; }, h: { esc, money, sgn, pill, card, secH, kpi, fmtD, mname, dot, toast, copy, mkChart, killCharts, palette, cssv, barRow, cmd, initUpdate, ageBadge } };"),
    # 5 Asset health in the V2 layout (original scores kept below it); tab badge = stale rows
    ("health: [tabHealth], inbox:",
     "health: [() => window.TW5.tabHealth(tabHealth)], inbox:"),
    ("k === 'health' && R.health.rows.filter(r => r.status === 'attention' && (S.member === 'all' || r.member === S.member)).length ? '<span class=\"n\">' + R.health.rows.filter(r => r.status === 'attention' && (S.member === 'all' || r.member === S.member)).length + '</span>' : ",
     "k === 'health' && window.TW5 && window.TW5.staleCount(S.member) ? '<span class=\"n\">' + window.TW5.staleCount(S.member) + '</span>' : "),
    # 6 header shows the oldest equity-fund NAV date, not the liquid fund's calendar-day NAV
    ("' · NAV ' + fmtD(M.lineage[1].asOf)",
     "' · NAV ' + fmtD(M.lineage[1].oldest || M.lineage[1].asOf)"),
    # 5 boot: status bar, audit on open, live NSE check
    ("render(); startInbox();",
     "render(); startInbox(); if (window.TW5) window.TW5.boot();"),
]


def main():
    src = io.open(APP, encoding='utf-8').read()
    if MARK in src:
        print('already patched:', APP); return 0
    if '--check' in sys.argv:
        print('NOT patched:', APP); return 1
    for old, new in PATCHES:
        assert src.count(old) == 1, 'patch anchor not found exactly once: ' + old[:70]
        src = src.replace(old, new)
    mod = io.open(MOD, encoding='utf-8').read()
    bak = APP + '.bak.%d_tw5' % int(time.time() * 1000)
    shutil.copy2(APP, bak)
    io.open(APP, 'w', encoding='utf-8', newline='\n').write(MARK + '\n' + mod + '\n' + src)
    print('patched', APP, '| backup', bak)
    return 0


if __name__ == '__main__':
    sys.exit(main())
