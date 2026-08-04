# Pass grafico → app vera (lato RAGAZZO) · v2

## Novità di questa versione
- **Bordino bianco risolto**: le sorgenti avevano una striscia bianca sul lato destro (artefatto dell'export). L'ho ritagliata, ora lo sfondo arriva pulito fino al bordo.
- **Responsive**: due versioni per ogni sfondo — **telefono** (verticale) di default e **largo** (orizzontale, da browser) sopra i 640px. Le serve una media query, quindi lo sfondo non è più inline.

## Cosa committare

1. **`App.jsx`** — sostituisci quello attuale. Solo estetica, meccaniche intatte (compila con esbuild senza errori).
2. **`public/sfondi/`** — crea la cartella e mettici questi **13 file**:
   - Telefono: `sfondo-azzurro-tel.webp`, `sfondo-rosa-tel.webp`, `sfondo-giallo-tel.webp`, `sfondo-verde-tel.webp`, `sfondo-rosso-tel.webp`, `sfondo-notte-tel.webp`
   - Largo/browser: `sfondo-azzurro-wide.webp`, `sfondo-rosa-wide.webp`, `sfondo-giallo-wide.webp`, `sfondo-verde-wide.webp`, `sfondo-rosso-wide.webp`, `sfondo-notte-wide.webp`
   - Logo: `logo-riquadro.webp`
3. **`pug-theme.css` — NON si tocca.**

> `logo-riquadro.png` è solo scorta, non serve committarla.
> Se il bundler serve la cartella statica con prefisso diverso da `/`, correggi `/sfondi/` in `App.jsx`.

## Cosa è cambiato in App.jsx (lato ragazzo)
- Il `player-wrap` prende lo sfondo da una classe `bg-<colore>` (o `bg-notte`), con le immagini definite via CSS + media query (telefono/largo). Niente più colore/immagine inline.
- Vecchio overlay `.bg-doodles` del ragazzo rimosso (i disegni sono nell'immagine). Educatore e login intatti.
- Logo nel riquadro nero (testo bianco), servito da file.

## Ancora da decidere
- **Messaggi/Notifiche**: nell'app sono rosa/azzurro (nei camerini azzurro/giallo). Ho tenuto i colori dell'app. Se li vuoi come nei camerini, cambio la mappa `TAB_BG`.
- **Lato EDUCATORE**: non toccato — lì lo sfondo è personalizzabile dall'educatore (`sectionColors`). Decidiamo insieme se applicarlo come default o solo dove non personalizzato.
