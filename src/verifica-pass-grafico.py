#!/usr/bin/env python3
# ══════════════════════════════════════════════════════════════════
#  verifica-pass-grafico.py — il guardiano del pass grafico
#
#  Uso:   python3 verifica-pass-grafico.py App.jsx
#         python3 verifica-pass-grafico.py App.jsx --dettagli
#         python3 verifica-pass-grafico.py App.jsx --solo contrasto
#
#  Non modifica niente. Legge il file e dice cosa non rispetta ancora
#  il design system, riga per riga. Esce con codice 1 se trova
#  qualcosa di BLOCCANTE (testo illeggibile, colori fuori palette).
#
#  Da rilanciare dopo OGNI modifica, prima di ogni push su staging.
# ══════════════════════════════════════════════════════════════════
import re
import sys
from collections import defaultdict

# ── il design system, in una sola tabella ────────────────────────
PALETTE = {
    "#A3CFFE": "azzurro", "#FF6DEC": "rosa", "#FDEF26": "giallo",
    "#339966": "verde", "#D41323": "rosso", "#101010": "nero",
    "#FFFFFF": "bianco",
}
# neutri di servizio ammessi (superfici notte, tracce, bordi tenui)
NEUTRI_OK = {
    "#0D0D0D", "#17181C", "#33353C", "#1A1A1A", "#000000", "#26272C",
    "#EFE6CF", "#2A2A22", "#ECECEC", "#F2F2EF", "#111111", "#2A2A2A",
    "#444444", "#E9E9E4", "#141414", "#0A0A0A", "#222222", "#555555",
    "#CCCCCC", "#DDDDDD", "#EEEEEE", "#E8E8E8", "#F0F0F0", "#F5F5F5",
    "#F8F9FF",
}
# medaglie del podio: dichiarate come variabili, sono un sistema semantico
MEDAGLIE_OK = {"#E8B923", "#B8C4CE", "#C87A3F"}
CORPI_OK = {10, 12, 14, 18, 26, 38}          # scala tipografica
RAGGI_OK = {0, 6, 10, 16, 24, 99, 50}         # scala dei raggi (99/50 = pillole e cerchi)
BORDI_OK = {2, 2.5, 3}                        # spessori di bordo
OMBRE_OK = {2, 3}                             # sfalsamento delle ombre dure

# Una riga che porta questo marchio viene saltata e contata a parte.
#   color:rgba(255,255,255,.55);  /* pug-ok: su fondo nero */
# Serve per le eccezioni volute: così ognuna resta una scelta scritta,
# non una dimenticanza.
PRAGMA = re.compile(r"pug-ok\s*:?\s*([^*/\n]*)")

# Un colore dichiarato una volta in :root è una scelta. Lo stesso colore
# scritto a mano dieci volte è un problema. Il linter impara da solo le
# variabili del foglio di stile e le considera legittime.
DICHIARAZIONE = re.compile(r"--[\w-]+\s*:\s*(#[0-9a-fA-F]{3,6})\b")

EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U0001F000-\U0001F0FF\U0001F1E6-\U0001F1FF"
    "\U00002600-\U000026FF\U00002700-\U000027BF\U00002B00-\U00002BFF"
    "\U0000203C\U00002049\U000024C2\U00002122\U00002139]"
)
# U+FE0F e U+200D non sono emoji: sono cuciture invisibili. Non si contano.
# Le frecce tipografiche (→ ←) sono testo legittimo e restano ammesse.
FRECCE_OK = set("→←↑↓↔⟶⟵")

# ══════════════════════════════════════════════════════════════════


def luminanza(hexcol):
    hexcol = hexcol.lstrip("#")
    if len(hexcol) == 3:
        hexcol = "".join(c * 2 for c in hexcol)
    canali = []
    for i in (0, 2, 4):
        c = int(hexcol[i:i + 2], 16) / 255
        canali.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * canali[0] + 0.7152 * canali[1] + 0.0722 * canali[2]


def contrasto(a, b):
    la, lb = luminanza(a), luminanza(b)
    chiaro, scuro = max(la, lb), min(la, lb)
    return (chiaro + 0.05) / (scuro + 0.05)


def su_bianco(r, g, b, alpha):
    """Colore risultante sovrapponendo rgba(...) a una card bianca."""
    return "#%02X%02X%02X" % tuple(
        round(255 + (v - 255) * alpha) for v in (r, g, b)
    )


def norm_hex(h):
    h = h.upper()
    if len(h) == 4:
        h = "#" + "".join(c * 2 for c in h[1:])
    return h


# ══════════════════════════════════════════════════════════════════
import json as _json
import os as _os

def _carica_eccezioni(percorso):
    """Legge pug-eccezioni.json accanto al file controllato: mappa
    numero-riga -> ragione. Sostituisce i commenti /* pug-ok */ nel codice,
    che dentro il JSX diventerebbero testo visibile a schermo."""
    d = _os.path.join(_os.path.dirname(_os.path.abspath(percorso)), "pug-eccezioni.json")
    if _os.path.exists(d):
        try:
            return {int(k): v for k, v in _json.load(open(d, encoding="utf-8")).items()}
        except Exception:
            return {}
    return {}

def controlla(percorso):
    righe = open(percorso, encoding="utf-8").read().split("\n")
    trovati = defaultdict(list)   # categoria → [(riga, testo, nota)]
    eccezioni = []                # righe marcate pug-ok o in pug-eccezioni.json
    allow = _carica_eccezioni(percorso)

    # giro preliminare: quali colori sono dichiarati come variabili
    dichiarati = set()
    for riga in righe:
        for h in DICHIARAZIONE.findall(riga):
            dichiarati.add(norm_hex(h))

    # solo il colore del TESTO: border-color, background-color, outline-color
    # e text-decoration-color non c'entrano niente con la leggibilità
    rgba_col = re.compile(
        r"(?<![-\w])color\s*:\s*['\"]?rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)", re.I)
    hexcol = re.compile(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b")
    fs = re.compile(r"(?:fontSize\s*:\s*|font-size\s*:\s*)['\"]?(\d+(?:\.\d+)?)")
    br = re.compile(r"(?:borderRadius\s*:\s*|border-radius\s*:\s*)['\"]?([0-9. ]+)")
    bw = re.compile(r"(?:border|borderWidth)\s*:\s*['\"]?(\d+(?:\.\d+)?)px\s+solid")
    bs = re.compile(r"box[- ]?[Ss]hadow\s*:\s*['\"]?(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s+0")

    for i, riga in enumerate(righe, 1):
        t = riga.strip()
        if not t or t.startswith("//"):
            continue
        m = PRAGMA.search(riga)
        if m:
            eccezioni.append((i, t[:70], m.group(1).strip() or "senza motivo scritto"))
            continue
        if i in allow:
            eccezioni.append((i, t[:70], allow[i]))
            continue
        breve = t[:96]
        e_dichiarazione = bool(DICHIARAZIONE.search(riga))

        # ① CONTRASTO — testo chiaro che finisce su card bianca
        for m in rgba_col.finditer(riga):
            r, g, b, a = int(m[1]), int(m[2]), int(m[3]), float(m[4])
            reso = su_bianco(r, g, b, a)
            cr = contrasto(reso, "#FFFFFF")
            if cr < 2.0:
                trovati["invisibile"].append(
                    (i, breve, f"rgba({r},{g},{b},{a}) su bianco = {reso} · {cr:.2f}:1"))
            elif cr < 4.5:
                trovati["debole"].append(
                    (i, breve, f"rgba({r},{g},{b},{a}) su bianco = {reso} · {cr:.2f}:1"))

        # ② PALETTE — colori inventati (una dichiarazione in :root è una scelta)
        for h in hexcol.findall(riga):
            h = norm_hex(h)
            if h in PALETTE or h in NEUTRI_OK or h in MEDAGLIE_OK:
                continue
            if e_dichiarazione and h in dichiarati:
                continue          # è la riga che lo dichiara: legittima
            nota = h + ("  (dichiarato: usa var())" if h in dichiarati else "")
            trovati["palette"].append((i, breve, nota))

        # ③ EMOJI residue
        e = [c for c in EMOJI.findall(riga) if c not in FRECCE_OK]
        if e:
            trovati["emoji"].append((i, breve, " ".join(sorted(set(e)))))

        # ④ CORPI TIPOGRAFICI fuori scala
        for v in fs.findall(riga):
            v = float(v)
            if v == int(v) and int(v) not in CORPI_OK:
                trovati["corpi"].append((i, breve, f"{int(v)}px"))

        # ⑤ RAGGI fuori scala (e raggi storti a 4 valori)
        for v in br.findall(riga):
            vals = [float(x) for x in v.split() if x.replace(".", "").isdigit()]
            if len(vals) > 1:
                trovati["raggi"].append((i, breve, "raggio storto: " + v.strip()))
            elif vals and vals[0] not in RAGGI_OK:
                trovati["raggi"].append((i, breve, f"{vals[0]:g}px"))

        # ⑥ BORDI e ⑦ OMBRE fuori scala
        for v in bw.findall(riga):
            if float(v) not in BORDI_OK:
                trovati["bordi"].append((i, breve, f"{float(v):g}px"))
        for x, y in bs.findall(riga):
            if float(x) not in OMBRE_OK or float(y) not in OMBRE_OK:
                trovati["ombre"].append((i, breve, f"{float(x):g}px {float(y):g}px"))

    return trovati, len(righe), eccezioni


TITOLI = {
    "invisibile": ("TESTO INVISIBILE", "BLOCCANTE",
                   "testo chiaro rimasto dal vecchio tema scuro: su card bianca sparisce"),
    "palette":    ("COLORI FUORI PALETTE", "BLOCCANTE",
                   "tinte che non stanno nel BrandBook"),
    "debole":     ("TESTO A BASSO CONTRASTO", "da fare",
                   "si legge male: sotto 4.5:1, la soglia per il testo corrente"),
    "emoji":      ("EMOJI RESIDUE", "da fare",
                   "vanno sostituite con le icone disegnate"),
    "corpi":      ("CORPI FUORI SCALA", "da fare",
                   "ammessi solo 10 · 12 · 14 · 18 · 26 · 38"),
    "raggi":      ("RAGGI FUORI SCALA", "da fare",
                   "ammessi solo 6 · 10 · 16 · 24 (99 per le pillole)"),
    "bordi":      ("BORDI FUORI SCALA", "da fare", "ammessi solo 2 · 2.5 · 3"),
    "ombre":      ("OMBRE FUORI SCALA", "da fare", "ammesse solo 2px e 3px"),
}
ORDINE = ["invisibile", "palette", "debole", "emoji", "corpi", "raggi", "bordi", "ombre"]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("uso: python3 verifica-pass-grafico.py App.jsx [--dettagli] [--solo CATEGORIA]")
        sys.exit(2)
    percorso = args[0]
    dettagli = "--dettagli" in sys.argv
    solo = None
    if "--solo" in sys.argv:
        solo = sys.argv[sys.argv.index("--solo") + 1]

    trovati, nrighe, eccezioni = controlla(percorso)

    print("═" * 68)
    print(f"  VERIFICA PASS GRAFICO · {percorso} · {nrighe} righe")
    print("═" * 68)

    bloccanti = 0
    for cat in ORDINE:
        if solo and cat != solo:
            continue
        titolo, gravita, nota = TITOLI[cat]
        casi = trovati[cat]
        if gravita == "BLOCCANTE":
            bloccanti += len(casi)
        segno = "✗" if casi and gravita == "BLOCCANTE" else ("·" if casi else "✓")
        print(f"\n{segno} {titolo:24s} {len(casi):4d}   [{gravita}]")
        print(f"  {nota}")
        if not casi:
            continue
        quante = len(casi) if dettagli else min(6, len(casi))
        for n, testo, extra in casi[:quante]:
            print(f"    r.{n:<5d} {extra}")
            if dettagli:
                print(f"           {testo}")
        if len(casi) > quante:
            print(f"    … e altre {len(casi)-quante} (rilancia con --dettagli)")

    print("\n" + "═" * 68)
    if bloccanti:
        print(f"  ✗ {bloccanti} problemi BLOCCANTI: non mandare su staging.")
    else:
        print("  ✓ nessun problema bloccante.")
    totale = sum(len(v) for v in trovati.values())
    print(f"  {totale} scostamenti in tutto dal design system.")
    if eccezioni:
        print(f"  {len(eccezioni)} eccezioni dichiarate con /* pug-ok */:")
        for n, _, motivo in eccezioni[:8]:
            print(f"      r.{n:<5d} {motivo}")
        if len(eccezioni) > 8:
            print(f"      … e altre {len(eccezioni)-8}")
    print("═" * 68)
    sys.exit(1 if bloccanti else 0)


if __name__ == "__main__":
    main()
