# ninetto-pdf

App web per visualizzare e modificare i PDF da PC e smartphone, senza installare programmi.
I documenti restano sul dispositivo: l'app non carica nulla online e non richiede login.

## Cosa fa
- **Visualizza**: scorrimento, zoom (anche con due dita), ricerca nel testo.
- **Annota**: evidenziatore, testo libero, note, disegno a mano.
- **Compila e firma**: campi dei moduli, firma disegnata (fino a 3 firme o sigle salvate sul dispositivo).
- **Pagine**: riordina trascinando la maniglia ⠿, inserisci un altro PDF dopo la pagina scelta, estrai, ruota, elimina.
- **Correggi**: tocca una riga di testo per coprirla e riscriverla (stesso punto e stessa dimensione), oppure trascina un riquadro.
- **Cancella**: tocca una scritta o un'aggiunta per toglierla, oppure trascina un riquadro sulla zona da cancellare (testo, immagini, loghi, firme).
- **Bianchetto**: rettangoli pieni bianchi o neri per coprire dati; restano spostabili e ridimensionabili fino al salvataggio.
- **Timbri rapidi** vettoriali: PAGATO IL (data di oggi), COPIA CONFORME, APPROVATO, ANNULLATO. In più le proprie immagini (timbro aziendale, logo).
- **Oggetti**: ogni aggiunta selezionata ha maniglie ai quattro angoli e una ✕ per eliminarla. Tasti: Ctrl+Z / Ctrl+Y, Canc, Ctrl+S.
- **Due dita**: zoom e spostamento della pagina senza lasciare segni.
- **Salva / Condividi**: crea sempre una copia «nome - modificato.pdf»; l'originale non viene toccato.
- **Da altre app** (Android, con l'app installata da Chrome): menu «Condividi» di WhatsApp, Gmail ecc. → ninetto-pdf.

## Garanzie e limiti
- **Correggi cancella davvero**: il testo coperto viene tolto dal file, non solo nascosto. Dopo il salvataggio l'app riapre il PDF e
  controlla che sotto le coperture non sia rimasto nulla e che il resto del testo ci sia ancora. Se la cancellazione «pulita» non è
  possibile (scansioni, copertura che taglia una riga a metà, PDF con struttura particolare), quella pagina viene salvata come immagine
  con la copertura impressa.
- **Pagine eliminate**: il loro contenuto viene rimosso dal file, non resta nascosto.
- **PDF protetti**: vengono sbloccati con qpdf (serve la password solo se il PDF la chiede per aprirsi) e restano testo vero.
- **Moduli**: i campi compilati restano modificabili nel file salvato (per il documento principale; quelli di eventuali PDF aggiunti
  in coda vengono fissati).
- «Correggi» resta un «copri e riscrivi»: adatto a importi, date e righe brevi, non a riscrivere paragrafi.
- La cancellazione riguarda testo, immagini e annotazioni della pagina. Proprietà del documento (titolo, autore) e segnalibri non vengono toccati.

## Com'è fatta
- `index.html`, `app.js`: l'app (nessun passaggio di compilazione).
- `sw.js`: funzionamento offline e ricezione dei file condivisi. A ogni rilascio aumentare `CACHE` (`-shell-vN`).
- `manifest.webmanifest`, `icons/`: installazione come app. L'icona di partenza è `icons/icon.svg`; i PNG (192, 512, maskable, favicon) si rigenerano da quella.
- `lib/`: pdf.js 4.10.38 (visualizzazione), pdf-lib 1.17.1 (scrittura), qpdf-wasm 0.3.1 (sblocco dei PDF protetti), copiate nel repository.
- Versione mostrata nella schermata iniziale: costante `VERSIONE` in `app.js`.

Pubblicazione: GitHub Pages dal ramo `gh-pages` (https://dipierronino-hub.github.io/editor-pdf/). Dopo ogni modifica su `main`: `git push origin main:gh-pages`.
