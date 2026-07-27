#!/usr/bin/env python3
"""Banco di prova delle misure. Apre la pagina a ogni formato reale e
cerca: scroll orizzontale, elementi che escono dalla colonna, testo
tagliato, e cose che finiscono sotto la nav."""
import sys
from playwright.sync_api import sync_playwright

MISURE = [
    # nome, larghezza, altezza
    ("iPhone SE 1",        320, 568),
    ("Galaxy Fold chiuso", 344, 882),
    ("Android piccolo",    360, 640),
    ("iPhone SE 3",        375, 667),
    ("iPhone 13/14",       390, 844),
    ("iPhone 15",          393, 852),
    ("Pixel 7",            412, 915),
    ("iPhone 11",          414, 896),
    ("iPhone 14 Plus",     428, 926),
    ("iPhone 15 Pro Max",  430, 932),
    ("Fold aperto",        512, 882),
    ("iPad mini",          744, 1133),
    ("iPad 9",             768, 1024),
    ("iPad 10",            810, 1080),
    ("iPad Air",           820, 1180),
    ("iPad Pro 11",        834, 1194),
    ("iPad Pro 12.9",      1024, 1366),
    ("iPad 9 orizz.",      1024, 768),
    ("iPad mini orizz.",   1133, 744),
    ("iPad Air orizz.",    1180, 820),
    ("iPad Pro 11 orizz.", 1194, 834),
    ("iPad Pro 12.9 or.",  1366, 1024),
]

CONTROLLI = r"""() => {
  const guai = [];
  const W = window.innerWidth, H = window.innerHeight;
  const schermo = document.querySelector('.pug-screen');
  const s = schermo.getBoundingClientRect();

  if (document.documentElement.scrollWidth > W + 1)
    guai.push('scroll orizzontale (' + document.documentElement.scrollWidth + ' > ' + W + ')');

  // elementi che escono dai bordi della finestra
  for (const el of document.querySelectorAll('.pug-screen *')) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cls = el.className.toString().trim();
    const nome = (cls ? '.' + cls.split(/\s+/).join('.') : el.tagName)
                 + (el.id ? '#' + el.id : '');
    if (r.right > W + 1)  guai.push('esce a destra: ' + nome + ' (+' + Math.round(r.right - W) + 'px)');
    if (r.left  < -1)     guai.push('esce a sinistra: ' + nome + ' (' + Math.round(r.left) + 'px)');
  }

  // testo tagliato dentro il proprio contenitore
  for (const el of document.querySelectorAll('.pug-screen *')) {
    if (el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (!t) continue;
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible')
      guai.push('testo tagliato: "' + t.slice(0, 22) + '"');
  }

  // etichette della nav che sbordano dalla loro colonna
  for (const lb of document.querySelectorAll('.pug-navbtn .lb')) {
    const p = lb.parentElement.getBoundingClientRect();
    if (lb.getBoundingClientRect().width > p.width + 1)
      guai.push('etichetta nav larga: "' + lb.textContent + '"');
  }

  // contenuto che finisce sotto la nav fissa
  const nav = document.querySelector('.pug-nav');
  if (nav) {
    const n = nav.getBoundingClientRect();
    const ultimo = document.querySelector('.pug-scroll').lastElementChild;
    if (ultimo) {
      const u = ultimo.getBoundingClientRect();
      if (u.bottom > n.top + 1 && u.top < n.bottom) guai.push('ultimo blocco sotto la nav');
    }
  }

  return {
    guai: [...new Set(guai)],
    colonna: Math.round(s.width),
    stanza: Math.round((document.querySelector('.pug-room')||{getBoundingClientRect:()=>({width:0})})
             .getBoundingClientRect().width),
    margini: Math.round((W - s.width) / 2)
  };
}"""


def prova(url, notte=False):
    esiti = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for nome, w, h in MISURE:
            pg = b.new_page(viewport={"width": w, "height": h})
            pg.goto(url)
            pg.wait_for_timeout(1000)
            if notte:
                pg.evaluate("document.body.classList.add('night')")
                pg.wait_for_timeout(250)
            r = pg.evaluate(CONTROLLI)
            esiti.append((nome, w, h, r))
            pg.close()
        b.close()
    return esiti


def stampa(esiti, titolo):
    print("=" * 74)
    print("  " + titolo)
    print("=" * 74)
    print(f"{'formato':22s}{'finestra':>11s}{'colonna':>9s}{'stanza':>8s}{'margine':>9s}  esito")
    print("-" * 74)
    rotti = 0
    for nome, w, h, r in esiti:
        ok = not r["guai"]
        rotti += 0 if ok else 1
        print(f"{nome:22s}{w:5d}x{h:<5d}{r['colonna']:9d}{r['stanza']:8d}{r['margini']:9d}  "
              f"{'ok' if ok else 'X ' + str(len(r['guai']))}")
        for g in r["guai"][:4]:
            print(f"{'':22s}{'':32s}  · {g}")
        if len(r["guai"]) > 4:
            print(f"{'':22s}{'':32s}  · … e altri {len(r['guai'])-4}")
    print("-" * 74)
    print(f"  {len(esiti)-rotti}/{len(esiti)} formati puliti")
    return rotti


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else \
        "file:///mnt/user-data/outputs/00-campionario.html"
    a = stampa(prova(url), "GIORNO")
    print()
    b_ = stampa(prova(url, notte=True), "NOTTE")
    sys.exit(1 if (a or b_) else 0)
