// ══════════════════════════════════════════════════════════════════
//  PugIcon — un'icona del design system, in una riga di JSX
//
//  Sostituisce le emoji sparse nell'app. Non è un <svg>: è uno <span>
//  vuoto che prende la forma da una maschera CSS (definita in
//  pug-theme.css) e il colore dal testo in cui sta. Quindi:
//    · si colora da solo su qualsiasi fondo della palette
//    · in night mode si inverte senza una seconda versione
//    · pesa pochissimo (nessun path SVG ripetuto nel DOM)
//
//  USO
//    import { PugIcon } from "./PugIcon";
//    <PugIcon nome="classifica" />                 // 18px, dal contesto
//    <PugIcon nome="fiore" dim={30} />             // misura esplicita
//    <PugIcon nome="coin" className="mia-classe" />
//
//  MIGRAZIONE — nel JSX un'emoji diventa:
//    {"\u{1F3C6}"}   ->   <PugIcon nome="classifica" />
//  La tabella completa emoji -> nome sta in fondo a questo file.
// ══════════════════════════════════════════════════════════════════

import React from "react";

// I 22 nomi validi. Se ne passi uno sbagliato, in sviluppo lo vedi
// subito a console invece di trovarti un'icona muta a runtime.
export const PUG_ICONE = [
  "profilo", "social", "classifica", "lab", "bigtop", "messaggi",
  "notifiche", "coin", "luna", "sole", "nutri", "regala", "visita",
  "arreda", "poster", "germoglio", "fiore", "cuore", "energia",
  "streak", "presenze", "xp",
];

export function PugIcon({ nome, dim, className = "", style, ...rest }) {
  if (process.env.NODE_ENV !== "production" && !PUG_ICONE.includes(nome)) {
    console.warn(
      `[PugIcon] nome sconosciuto: "${nome}". ` +
      `Ammessi: ${PUG_ICONE.join(", ")}`
    );
  }
  const misura = dim != null
    ? { width: dim, height: dim }   // px numerici o stringa con unità
    : null;
  return (
    <span
      className={`pug-ic pug-ic--${nome} ${className}`.trim()}
      style={misura ? { ...misura, ...style } : style}
      aria-hidden="true"
      {...rest}
    />
  );
}

export default PugIcon;

// ── TABELLA DI MIGRAZIONE emoji -> nome ─────────────────────────────
//  profilo     nutri        germoglio
//  social      regala       fiore
//  classifica  visita       xp
//  lab         arreda       coin
//  bigtop      poster       streak
//  messaggi    luna         presenze
//  notifiche   sole         cuore
//                           energia
//
//  Nota: il fulmine faceva sia da "Lab" sia da "Energia". In fase di
//  migrazione scegli il nome giusto in base al punto: nella nav e'
//  "lab", nei vitali della creatura e' "energia".
//  La tabella con le emoji vere sta in LEGGIMI.md.
