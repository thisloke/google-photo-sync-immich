# Sincronizzazione Google Photos → Immich (TypeScript)

Questo progetto permette di sincronizzare automaticamente gli album condivisi di Google Photos con il tuo server Immich locale, scritto in TypeScript per una migliore manutenibilità e type safety.

## Caratteristiche

- Sincronizza foto da album specifici di Google Photos verso Immich
- Forte tipizzazione con TypeScript per evitare errori comuni
- Memorizza le foto già sincronizzate per evitare duplicati
- Crea automaticamente gli album in Immich se non esistono
- Supporta l'aggiornamento del token di autenticazione Google

## Prerequisiti

- Node.js (v14 o superiore)
- TypeScript installato globalmente o localmente
- Un server Immich funzionante
- Un account Google con accesso agli album condivisi
- Credenziali OAuth2 di Google Cloud Platform

## Installazione

1. Clona o scarica questo repository
2. Installa le dipendenze:

```bash
npm install
```

## Configurazione

### 1. Ottenere le credenziali OAuth2 di Google

1. Vai alla [Console Google Cloud](https://console.cloud.google.com/)
2. Crea un nuovo progetto o seleziona uno esistente
3. Vai a "API e servizi" > "Credenziali"
4. Clicca su "Crea credenziali" e seleziona "ID client OAuth"
5. Configura l'applicazione come "App web"
6. Aggiungi `http://localhost:3000/oauth2callback` come URI di reindirizzamento
7. Salva il Client ID e il Client Secret

### 2. Abilitare l'API di Google Photos

1. Nella Console Google Cloud, vai a "API e servizi" > "Libreria"
2. Cerca "Photos Library API" e abilitala

### 3. Ottenere l'API key di Immich

1. Accedi alla tua interfaccia web di Immich
2. Vai alle impostazioni del profilo
3. Nella sezione "API Keys", genera una nuova chiave

### 4. Configurare lo script

Modifica il file `google-photos-to-immich-sync.ts` e aggiorna la sezione `CONFIG`:

```typescript
const CONFIG: Config = {
  // Configurazione Google Photos
  googlePhotos: {
    clientId: 'TUO_CLIENT_ID', // Inserisci il tuo Client ID
    clientSecret: 'TUO_CLIENT_SECRET', // Inserisci il tuo Client Secret
    redirectUri: 'http://localhost:3000/oauth2callback',
    scopes: ['https://www.googleapis.com/auth/photoslibrary.readonly'],
    tokenPath: path.join(__dirname, 'google_token.json'),
    // IDs degli album da sincronizzare
    albumIds: [
      'ID_ALBUM_1', // Puoi trovare questi ID nell'URL quando apri un album su Google Photos
      'ID_ALBUM_2'
    ]
  },
  // Configurazione Immich
  immich: {
    apiKey: 'TUA_API_KEY_IMMICH', // Inserisci la tua API key di Immich
    serverUrl: 'http://localhost:3001/api', // Modifica con l'URL del tuo server Immich
    albumNames: {
      'ID_ALBUM_1': 'Nome Album 1 in Immich',
      'ID_ALBUM_2': 'Nome Album 2 in Immich'
    }
  },
  tempDir: path.join(__dirname, 'temp'),
  syncedPhotosFile: path.join(__dirname, 'synced_photos.json')
};
```

## Come trovare gli ID degli album di Google Photos

1. Apri Google Photos nel browser
2. Vai all'album di cui desideri l'ID
3. L'URL avrà un formato simile a: `https://photos.google.com/album/ABC123XYZ`
4. L'ID dell'album è la parte dopo `/album/` (in questo esempio, `ABC123XYZ`)

## Utilizzo

### Compilazione del codice TypeScript

Prima di eseguire lo script, compila il codice TypeScript:

```bash
npm run build
```

### Esecuzione

Per eseguire lo script compilato:

```bash
npm start
```

Oppure, per sviluppo e test, puoi eseguirlo direttamente con ts-node:

```bash
npm run dev
```

### Prima esecuzione

La prima volta che esegui lo script, ti verrà chiesto di autorizzare l'accesso a Google Photos:

1. Ti verrà mostrato un URL da visitare
2. Accedi con il tuo account Google e autorizza l'applicazione
3. Copia il codice fornito e incollalo nella console
4. Lo script inizierà la sincronizzazione

### Esecuzioni successive

Nelle esecuzioni successive, lo script utilizzerà il token salvato in `google_token.json` e sincronizzerà solo le nuove foto.

## Automatizzazione

Per automatizzare la sincronizzazione, puoi configurare un cron job:

```bash
# Esempio: esegui la sincronizzazione ogni giorno alle 3:00
0 3 * * * cd /percorso/al/progetto && npm start >> sync.log 2>&1
```

## Estensione del codice

Il codice TypeScript è strutturato con interfacce ben definite, rendendo facile l'estensione per aggiungere nuove funzionalità. Puoi facilmente:

- Aggiungere supporto per filtri basati su metadata delle foto
- Implementare la sincronizzazione bidirectionale
- Creare una versione con interfaccia grafica

## Risoluzione dei problemi

- **Errore di compilazione TypeScript**: Verifica che tutte le dipendenze siano installate con `npm install` e che TypeScript sia installato
- **Errore di autenticazione**: Elimina il file `google_token.json` e riavvia lo script
- **Errore nel caricamento delle foto**: Verifica che l'API key di Immich sia corretta e che il server sia raggiungibile
- **Errore nel recupero delle foto da Google**: Verifica che gli ID degli album siano corretti

## Contributi

Contributi e miglioramenti sono benvenuti! Sentiti libero di inviare pull request o segnalare problemi.

## Licenza

MIT
