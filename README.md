# Lyon Startup #19 - Scraper & Calendar Sync

Scrape les evenements de [lyonstartup.com](https://www.lyonstartup.com), exporte en ICS et synchronise avec Google Calendar.

## Setup

```bash
npm install
cp .env.example .env
# Remplir .env avec tes identifiants
```

## Commandes

| Commande | Description |
|---|---|
| `npm start` | Export tous les events en fichier ICS |
| `npm run register` | Inscription automatique a tous les events + export ICS |
| `npm run update` | Compare avec le dernier run, ICS avec seulement les nouveaux |
| `npm run update-gcal` | Compare avec Google Calendar, ICS des nouveaux + log des modifs/suppressions |

## Lien calendrier partageable

```
https://calendar.google.com/calendar/ical/c_fd90adfe043a9a8a835522b077cb6501356b444ea5b5ea89eeecfe036c0b2d8a%40group.calendar.google.com/public/basic.ics
```

Compatible Google Calendar, Apple Calendar, Outlook, etc. Se met a jour automatiquement.

## Fichiers generes

- `lyon-startup-events.ics` — fichier calendrier a importer
- `scraper.log` — logs detailles de chaque run
- `events-state.json` — etat sauvegarde pour le mode update
