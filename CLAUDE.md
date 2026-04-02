# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Scraper for [lyonstartup.com](https://www.lyonstartup.com) events. Logs in with user credentials, scrapes event listings, optionally auto-registers to events, exports ICS calendar files, and sends calendar invite emails. Can also diff against a previous local state or a live Google Calendar to detect new/modified/deleted events.

The project is in French (comments, logs, user-facing output). Communicate with the user in French.

## How to interact with the user

The user expects a conversational, direct experience. They will ask things like "inscris-moi à tel event", "c'est quoi les events d'aujourd'hui", "compare avec mon calendrier", etc. You should:

- **Run the appropriate npm command** based on what the user asks — don't just explain what to do
- **Parse and summarize the output** — the scraper logs are verbose (DEBUG lines), extract the useful info (event names, dates, statuses, errors) and present it clearly
- **Act on errors** — if an inscription fails, tell the user why (e.g. event already started). If SMTP fails, diagnose (auth, typo in address, etc.)
- **Chain actions** — if the user says "inscris-moi et envoie le mail", run `register` which does both automatically

## Commands

```bash
npm install                                        # Install dependencies
npm start                                          # Scrape all events, export ICS file
npm run register                                   # Auto-register to ALL unregistered events + export ICS + send invite emails
npm run register-event -- "nom de l'event"         # Register to a specific event (partial title match, case insensitive)
npm run update                                     # Diff against previous run (events-state.json), ICS with new events only
npm run update-gcal                                 # Diff against Google Calendar, ICS with new events + log modifications/deletions
```

## Architecture

Two entry points with different execution contexts:

- **`scraper.js`** — Node.js CLI tool (main). Handles login via CSRF token + manual cookie jar (PHPSESSID), scrapes events with cheerio, manages state diffs, generates ICS files, sends calendar invite emails via SMTP on successful registration. ESM module (`"type": "module"`). CLI flags (`--register`, `--register-event "name"`, `--update`, `--update-gcal`) select the operating mode.

- **`main.js`** — Browser console script (paste into DevTools on lyonstartup.com while logged in). Auto-registers to events and downloads an ICS file via blob URL. Shares the same DOM selector patterns as `scraper.js` but uses browser APIs (DOMParser, fetch with credentials, Blob).

Both files parse event details using the same CSS selectors (`.event-header h3`, `.event-header h5`, `.event-footer h6`, etc.) and share the same date parsing logic (DD.MM.YYYY format, time ranges from "horaires").

### Email invitations

On successful registration, `scraper.js` sends a calendar invite email (ICS with `METHOD:REQUEST`) via SMTP. The recipient receives the event in Gmail with Oui/Non/Peut-être buttons. Uses nodemailer with OVH SMTP (`ssl0.ovh.net:465`).

## Environment

Requires a `.env` file (see `.env.example`):
- `LSU_USERNAME` — lyonstartup.com login email
- `LSU_PASSWORD` — lyonstartup.com password
- `SMTP_USER` — SMTP sender email (OVH)
- `SMTP_PASS` — SMTP password (quote with `"` if it contains `#`, `%`, `@`)
- `SMTP_HOST` — SMTP host (default: `ssl0.ovh.net`)
- `SMTP_PORT` — SMTP port (default: `465`)
- `INVITE_TO` — email to send calendar invites to
