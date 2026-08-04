# Pass grafico → app vera (lato RAGAZZO) · v3 — tutto incorporato

## Perché è cambiato l'approccio
L'app **non usa file esterni**: ogni immagine è già incorporata in base64. Il percorso `/sfondi/` che avevo usato dava 404 nel tuo build (l'immagine non si caricava, restava solo il colore → sembrava "non applicato"). Ho quindi **incorporato gli sfondi e il logo dentro App.jsx**, come è fatto tutto il resto dell'app. Così funzionano sempre, senza file da caricare.

## Cosa committare
- **Solo `App.jsx`.** Nient'altro. Niente cartelle, niente `pug-theme.css` (resta invariata).
- Compila con esbuild senza errori. Solo estetica, meccaniche intatte.

App.jsx è più pesante (~1,7 MB) perché ora contiene anche i 12 sfondi (telefono + largo) e il logo. È il prezzo dell'autonomia; in futuro, se attiviamo una cartella statica servita davvero dal deploy, li possiamo tirare fuori e alleggerire.

## Cosa fa
- Sfondo reale per tab coi disegni sbiaditi, **responsive**: verticale su telefono, orizzontale (largo) da ≥640px. Notte: nero uguale per tutte.
- Bordino bianco delle sorgenti ritagliato.
- Vecchio overlay `.bg-doodles` del ragazzo rimosso; logo nel riquadro nero (testo bianco).

## Ancora da decidere
- **Messaggi/Notifiche**: nell'app rosa/azzurro, nei camerini azzurro/giallo. Tenuti i colori dell'app.
- **Lato educatore**: non toccato (sfondo personalizzabile dall'educatore) — da fare insieme.
