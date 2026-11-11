# Editor PDF

App web per visualizzare e modificare i PDF da PC e smartphone, senza installare programmi.
I documenti restano sul dispositivo: l'app non carica nulla online e non richiede login.

## Cosa fa
- **Visualizza**: scorrimento, zoom (anche con due dita), ricerca nel testo.
- **Annota**: evidenziatore, testo libero, note, disegno a mano.
- **Compila e firma**: campi dei moduli, firma disegnata, timbri da immagine. Firme e timbri restano salvati sul singolo dispositivo.
- **Pagine**: unisci più PDF, estrai, ruota, elimina, riordina.
- **Correggi**: tocca una riga di testo per coprirla e riscriverla (stesso punto e stessa dimensione), oppure trascina un riquadro.
- **Salva / Condividi**: crea sempre una copia «nome - modificato.pdf»; l'originale non viene toccato.
- **Da altre app** (Android, con l'app installata da Chrome): menu «Condividi» di WhatsApp, Gmail ecc. → Editor PDF.

## Limiti da conoscere
- «Correggi» copre il testo vecchio e scrive sopra: va bene per importi, date e righe brevi, non per riscrivere paragrafi.
  Il testo coperto resta dentro il file (non è una cancellazione sicura di dati riservati).
- I PDF protetti vengono salvati come immagini: il testo non è più selezionabile.
- I moduli compilati vengono «appiattiti» nel file salvato: i campi non sono più modificabili.

## Com'è fatta
- `index.html`, `app.js`: l'app (nessun passaggio di compilazione).
- `sw.js`: funzionamento offline e ricezione dei file condivisi. A ogni rilascio aumentare `CACHE` (`-shell-vN`).
- `manifest.webmanifest`, `icons/`: installazione come app.
- `lib/`: pdf.js 4.10.38 (visualizzazione) e pdf-lib 1.17.1 (scrittura), copiate nel repository.
- Versione mostrata nella schermata iniziale: costante `VERSIONE` in `app.js`.

Pubblicazione: GitHub Pages dal ramo `gh-pages` (https://dipierronino-hub.github.io/editor-pdf/). Dopo ogni modifica su `main`: `git push origin main:gh-pages`.
