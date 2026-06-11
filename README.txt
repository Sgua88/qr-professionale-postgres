QR MANAGER - VERSIONE PROFESSIONALE POSTGRESQL

Credenziali default:
Utente: rasisnc
Password: Gianluca1

Questa versione sostituisce SQLite con PostgreSQL.
È pensata per uso online professionale con Railway, Render o server VPS.

FUNZIONI INCLUSE
- Dashboard moderna responsive desktop/smartphone
- Login
- PostgreSQL
- Import iniziale automatico da data/qrcode.db
- Import QR immagine
- Scanner fotocamera smartphone con HTTPS
- Import link manuale
- Sync intelligente
- Batch automatici
- Ripresa automatica
- Cache anti-ban AE su tabella PostgreSQL
- Salvataggio progressivo nel database
- Programmazione giornaliera, settimanale, mensile
- Paginazione 100 record per pagina
- Filtri Ultima VP mese/anno
- Reset Filtri
- Ricerca con Invio

LOCALE CON DOCKER
1. Installa Docker Desktop
2. Apri il prompt nella cartella
3. Esegui:
   docker compose up --build
4. Apri:
   http://localhost:3000

LOCALE SENZA DOCKER
1. Installa PostgreSQL
2. Crea database qrmanager
3. Copia .env.example in .env oppure imposta DATABASE_URL
4. Esegui:
   npm install
   npm start

VARIABILI IMPORTANTI
DATABASE_URL=postgresql://utente:password@host:porta/database
AUTH_USER=rasisnc
AUTH_PASS=Gianluca1

DEPLOY ONLINE CONSIGLIATO
Railway:
- crea progetto Node.js da GitHub
- aggiungi PostgreSQL
- imposta DATABASE_URL se non già presente
- deploy automatico

Render:
- usa render.yaml incluso
- crea Web Service + PostgreSQL
- imposta variabili AUTH_USER e AUTH_PASS

NOTA FOTOCAMERA
La fotocamera smartphone funziona correttamente solo con HTTPS.
Online Railway/Render danno HTTPS automatico.

AGGIORNAMENTO COLONNA CLIENTE
- La colonna Cliente viene visualizzata con massimo 62 caratteri.
- Se il nome cliente supera 62 caratteri viene mostrato con "..." finale.

AGGIORNAMENTO COLONNA CLIENTE
- La colonna Cliente viene visualizzata con massimo 42 caratteri.
- Se il nome cliente supera 42 caratteri viene mostrato con "..." finale.


AGGIORNAMENTO MOBILE
- Tabella trasformata automaticamente in schede su smartphone.
- Filtri ricerca sticky e più comodi da usare con il dito.
- Pulsanti e paginazione ingranditi per mobile.
- KPI e menu inferiore ottimizzati per schermi piccoli.
- Colonna Cliente mantenuta a 42 caratteri con puntini.


AGGIORNAMENTO MOBILE MENU
- Rimossa/nascosta la barra funzioni in basso su smartphone.
- Il pulsante menu in alto a sinistra è ora arancione, più visibile e coerente con il menu funzioni.
- Ridotto lo spazio vuoto inferiore della pagina dopo la rimozione della barra.


AGGIORNAMENTO TEMA CHIARO/SCURO
- Aggiunto pulsante Tema scuro / Tema chiaro nella parte bassa del menu funzioni.
- La preferenza viene salvata nel browser.
- Tema scuro applicato a dashboard, tabelle, filtri, input e menu.


LOGO INSERITO
- Inserito il logo QR Manager in alto a sinistra accanto alla scritta QR MANAGER.
- File logo aggiunto in: public/assets/logo-qrmanager.png


AGGIORNAMENTO SINCRONIZZAZIONE / TEMA
- Rimossa la selezione "Giorno mese" dalla schermata Sincronizzazione.
- Il pulsante Tema scuro / Tema chiaro è stato spostato sotto Log Attività nel menu funzioni.
- Il pulsante tema usa ora lo stesso stile/colore degli altri tasti funzione.


FIX MOBILE TEMA SCURO
- Corretta la leggibilità della matricola nella vista mobile con tema scuro.
- La matricola ora usa lo stesso colore delle altre scritte leggibili.


AGGIORNAMENTO WEBAPP / ICONA MOBILE
- Aggiunto manifest.json per installare il sito come webapp/PWA.
- Il logo QR Manager viene usato come icona su Android e iPhone.
- Aggiunte icone 192x192, 512x512, Apple Touch Icon e favicon.
- Aggiunto service-worker.js leggero per rendere la webapp installabile.
- Da smartphone: apri il sito HTTPS, poi usa "Aggiungi a schermata Home".


SOSTITUZIONE TOTALE LOGHI / WEBAPP
- Sostituiti tutti i loghi e le immagini icona della webapp con la nuova immagine fornita.
- Aggiornati:
  - logo del sito in alto a sinistra
  - favicon browser
  - icone Android
  - icona iPhone (apple-touch-icon)
  - icone PWA/manifest
  - icone webapp standalone
