import { load } from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import nodemailer from 'nodemailer';

config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_URL = 'https://www.lyonstartup.com';
const LOGIN_PAGE = `${BASE_URL}/connexion`;
const LOGIN_ACTION = `${BASE_URL}/connexion/login_check`;
const EVENTS_PAGE = `${BASE_URL}/candidat/lsu/evenements`;
const GCAL_PUBLIC_ICS = 'https://calendar.google.com/calendar/ical/c_fd90adfe043a9a8a835522b077cb6501356b444ea5b5ea89eeecfe036c0b2d8a%40group.calendar.google.com/public/basic.ics';
const USERNAME = process.env.LSU_USERNAME;
const PASSWORD = process.env.LSU_PASSWORD;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const INVITE_TO = process.env.INVITE_TO || 'liam.faucitano@nopthingelse.fr';

if (!USERNAME || !PASSWORD) {
  console.error('Missing LSU_USERNAME or LSU_PASSWORD in .env file');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'scraper.log');
const ICS_FILE = path.join(__dirname, 'lyon-startup-events.ics');
const STATE_FILE = path.join(__dirname, 'events-state.json');

// CLI flags
const AUTO_REGISTER = process.argv.includes('--register');
const UPDATE_MODE = process.argv.includes('--update');
const UPDATE_GCAL = process.argv.includes('--update-gcal');
const REGISTER_EVENT = (() => {
  const idx = process.argv.indexOf('--register-event');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// Delay between requests (ms) to be polite
const REQUEST_DELAY = 400;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
// Truncate log file on each run
fs.writeFileSync(LOG_FILE, '', 'utf-8');

function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] [${level}] ${args.join(' ')}`;
  console.log(msg);
  fs.appendFileSync(LOG_FILE, msg + '\n', 'utf-8');
}

const info  = (...a) => log('INFO',  ...a);
const debug = (...a) => log('DEBUG', ...a);
const warn  = (...a) => log('WARN',  ...a);
const error = (...a) => log('ERROR', ...a);

// ---------------------------------------------------------------------------
// Cookie jar (simple manual management — we only need PHPSESSID)
// ---------------------------------------------------------------------------
let cookies = {};

function parseCookies(response) {
  const setCookie = response.headers.getSetCookie?.() || [];
  for (const raw of setCookie) {
    const [pair] = raw.split(';');
    const [name, ...rest] = pair.split('=');
    cookies[name.trim()] = rest.join('=').trim();
  }
  debug('Cookies after parse:', JSON.stringify(cookies));
}

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr,fr-FR;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function httpGet(url) {
  debug(`GET ${url}`);
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...COMMON_HEADERS, Cookie: cookieHeader() },
    redirect: 'manual', // handle redirects manually to track cookies
  });
  debug(`  -> status ${res.status} ${res.statusText}`);
  parseCookies(res);

  // Follow redirects manually
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    const redirectUrl = loc.startsWith('http') ? loc : new URL(loc, url).href;
    debug(`  -> redirect to ${redirectUrl}`);
    return httpGet(redirectUrl);
  }

  const body = await res.text();
  debug(`  -> body length: ${body.length}`);
  return { status: res.status, body, headers: res.headers };
}

async function httpPost(url, formData) {
  debug(`POST ${url}`);
  debug(`  -> form data keys: ${Object.keys(formData).join(', ')}`);
  const encoded = new URLSearchParams(formData).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(),
      'Origin': BASE_URL,
      'Referer': LOGIN_PAGE,
    },
    body: encoded,
    redirect: 'manual',
  });
  debug(`  -> status ${res.status} ${res.statusText}`);
  parseCookies(res);

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    const redirectUrl = loc.startsWith('http') ? loc : new URL(loc, url).href;
    debug(`  -> redirect to ${redirectUrl}`);
    return httpGet(redirectUrl);
  }

  const body = await res.text();
  debug(`  -> body length: ${body.length}`);
  return { status: res.status, body, headers: res.headers };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Step 1 — Get login page, extract CSRF token
// ---------------------------------------------------------------------------
async function getLoginPage() {
  info('=== STEP 1: Fetching login page ===');
  const { body } = await httpGet(LOGIN_PAGE);

  const $ = load(body);
  const csrfToken = $('input[name="_csrf_token"]').val();

  if (!csrfToken) {
    error('Could not find _csrf_token on login page!');
    debug('Login page HTML (first 2000 chars):', body.substring(0, 2000));
    throw new Error('CSRF token not found');
  }

  info(`CSRF token extracted: ${csrfToken.substring(0, 20)}...`);
  debug(`Full CSRF token: ${csrfToken}`);
  debug(`PHPSESSID: ${cookies.PHPSESSID || 'NOT SET'}`);
  return csrfToken;
}

// ---------------------------------------------------------------------------
// Step 2 — Login
// ---------------------------------------------------------------------------
async function login(csrfToken) {
  info('=== STEP 2: Logging in ===');
  info(`Username: ${USERNAME}`);

  const result = await httpPost(LOGIN_ACTION, {
    _csrf_token: csrfToken,
    _username: USERNAME,
    _password: PASSWORD,
    _submit: 'Connexion',
  });

  // Check if login succeeded — after redirect we should NOT be on the login page
  const isLoginPage = result.body.includes('login_check') || result.body.includes('Identifiants invalides');
  if (isLoginPage) {
    error('Login FAILED — still on login page or invalid credentials');
    debug('Response body (first 2000 chars):', result.body.substring(0, 2000));
    throw new Error('Login failed');
  }

  info('Login successful!');
  debug(`Current cookies: ${JSON.stringify(cookies)}`);
  return result;
}

// ---------------------------------------------------------------------------
// Step 3 — Fetch events list
// ---------------------------------------------------------------------------
async function fetchEventsList() {
  info('=== STEP 3: Fetching events list ===');
  const { body } = await httpGet(EVENTS_PAGE);

  const $ = load(body);

  // Extract event URLs from onclick attributes (same logic as main.js)
  const eventUrls = [];
  $('[onclick]').each((_, el) => {
    const onclick = $(el).attr('onclick');
    const match = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (match) {
      eventUrls.push(match[1]);
    }
  });

  info(`Found ${eventUrls.length} events on the page`);
  eventUrls.forEach((url, i) => debug(`  Event ${i + 1}: ${url}`));

  if (eventUrls.length === 0) {
    warn('No events found! Dumping page HTML for debug...');
    debug('Events page HTML (first 5000 chars):', body.substring(0, 5000));
  }

  return eventUrls;
}

// ---------------------------------------------------------------------------
// Step 4 — Fetch each event detail
// ---------------------------------------------------------------------------
async function fetchEventDetail(eventPath) {
  const fullUrl = BASE_URL + eventPath;
  debug(`Fetching event detail: ${fullUrl}`);
  const { body } = await httpGet(fullUrl);

  const $ = load(body);

  const title       = $('.event-header h3').text().trim() || 'Event sans titre';
  const dateRaw     = $('.event-header h5').text().trim() || '';
  const timeRaw     = $('.event-header p span:last-child').text().trim() || '';
  const location    = $('.event-footer h6:first-of-type').text().trim() || '';
  const address     = $('.event-footer p div:first-child').text().trim() || '';
  const description = $('.event-body div:nth-child(2) p').text().trim() || '';
  const horaires    = $('.event-body div:nth-child(3) p').text().trim() || '';
  const isRegistered = body.includes("Se désinscrire de l'événement");

  const event = { title, dateRaw, timeRaw, location, address, description, horaires, isRegistered, url: fullUrl, path: eventPath };

  debug(`  Title: ${title}`);
  debug(`  Date raw: ${dateRaw}`);
  debug(`  Time raw: ${timeRaw}`);
  debug(`  Horaires: ${horaires}`);
  debug(`  Location: ${location}`);
  debug(`  Address: ${address}`);
  debug(`  Description: ${description.substring(0, 100)}...`);
  debug(`  Registered: ${isRegistered}`);

  return event;
}

// ---------------------------------------------------------------------------
// Step 4b — Register to an event (POST /reservation)
// ---------------------------------------------------------------------------
async function registerToEvent(event) {
  const reservationUrl = event.url + '/reservation';
  info(`  Attempting registration: ${event.title}`);
  debug(`  POST ${reservationUrl}`);

  const res = await fetch(reservationUrl, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(),
      'Origin': BASE_URL,
      'Referer': event.url,
    },
    redirect: 'manual',
  });
  debug(`  -> status ${res.status} ${res.statusText}`);
  parseCookies(res);

  // Follow redirect
  let body;
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    const redirectUrl = loc.startsWith('http') ? loc : new URL(loc, reservationUrl).href;
    debug(`  -> redirect to ${redirectUrl}`);
    const result = await httpGet(redirectUrl);
    body = result.body;
  } else {
    body = await res.text();
  }

  const success = body.includes("Se désinscrire de l'événement");
  if (success) {
    info(`  INSCRIPTION OK: ${event.title}`);
  } else {
    warn(`  INSCRIPTION ECHOUEE: ${event.title}`);
  }
  return success;
}

// ---------------------------------------------------------------------------
// State management (for --update mode)
// ---------------------------------------------------------------------------
function eventFingerprint(event) {
  return JSON.stringify({
    title: event.title,
    dateRaw: event.dateRaw,
    timeRaw: event.timeRaw,
    horaires: event.horaires,
    location: event.location,
    address: event.address,
    description: event.description,
  });
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    debug('No state file found, starting fresh');
    return {};
  }
  const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  debug(`Loaded state with ${Object.keys(data).length} events`);
  return data;
}

function saveState(events) {
  const state = {};
  for (const e of events) {
    state[e.path] = {
      title: e.title,
      dateRaw: e.dateRaw,
      timeRaw: e.timeRaw,
      horaires: e.horaires,
      location: e.location,
      address: e.address,
      description: e.description,
      isRegistered: e.isRegistered,
      url: e.url,
      fingerprint: eventFingerprint(e),
    };
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  info(`State saved: ${STATE_FILE} (${Object.keys(state).length} events)`);
}

function diffEvents(oldState, newEvents) {
  const added = [];
  const modified = [];
  const unchanged = [];
  const skippedPast = [];
  const newPaths = new Set();

  for (const e of newEvents) {
    newPaths.add(e.path);
    const old = oldState[e.path];
    if (!old) {
      added.push(e);
    } else if (old.fingerprint !== eventFingerprint(e)) {
      // Skip past events
      if (isEventPast(e)) {
        unchanged.push(e);
        continue;
      }
      const changes = [];
      if (old.title !== e.title) changes.push(`titre: "${old.title}" -> "${e.title}"`);
      if (old.dateRaw !== e.dateRaw) changes.push(`date: "${old.dateRaw}" -> "${e.dateRaw}"`);
      if (old.horaires !== e.horaires) changes.push(`horaires: "${old.horaires}" -> "${e.horaires}"`);
      if (old.location !== e.location) changes.push(`lieu: "${old.location}" -> "${e.location}"`);
      if (old.address !== e.address) changes.push(`adresse: "${old.address}" -> "${e.address}"`);
      if (old.description !== e.description) changes.push('description modifiee');
      modified.push({ event: e, changes });
    } else {
      unchanged.push(e);
    }
  }

  const deleted = [];
  for (const [p, old] of Object.entries(oldState)) {
    if (!newPaths.has(p)) {
      if (isEventPast(old)) {
        skippedPast.push(old);
      } else {
        deleted.push(old);
      }
    }
  }

  return { added, modified, deleted, unchanged, skippedPast };
}

// ---------------------------------------------------------------------------
// Google Calendar ICS fetcher & parser (for --update-gcal)
// ---------------------------------------------------------------------------
async function fetchGoogleCalendarEvents() {
  info('=== Fetching Google Calendar ICS ===');
  debug(`GET ${GCAL_PUBLIC_ICS}`);
  const res = await fetch(GCAL_PUBLIC_ICS);
  if (!res.ok) {
    throw new Error(`Failed to fetch Google Calendar ICS: ${res.status} ${res.statusText}`);
  }
  const icsText = await res.text();
  debug(`  Google Calendar ICS: ${icsText.length} bytes`);

  // Parse VEVENT blocks
  const events = new Map(); // UID -> { summary, dtstart, dtend, location, description }
  const blocks = icsText.split('BEGIN:VEVENT');
  blocks.shift(); // remove header

  for (const block of blocks) {
    const raw = block.split('END:VEVENT')[0];

    // Unfold ICS lines (lines starting with space are continuations)
    const unfolded = raw.replace(/\r?\n[ \t]/g, '');

    const get = (key) => {
      const regex = new RegExp(`^${key}[;:](.*)$`, 'm');
      const m = unfolded.match(regex);
      return m ? m[1].trim() : '';
    };

    const uid = get('UID');
    const summary = get('SUMMARY');
    const dtstart = get('DTSTART').replace(/^.*:/, ''); // remove VALUE=DATE: prefix if any
    const dtend = get('DTEND').replace(/^.*:/, '');
    const location = get('LOCATION').replace(/\\,/g, ',').replace(/\\;/g, ';');
    const description = get('DESCRIPTION').replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');

    if (uid) {
      events.set(uid, { uid, summary, dtstart, dtend, location, description });
      debug(`  GCal event: ${summary} (UID: ${uid})`);
    }
  }

  info(`Google Calendar has ${events.size} events`);
  return events;
}

function makeUID(event) {
  const slug = (event.path || event.title).replace(/[^a-zA-Z0-9]/g, '-').substring(0, 80);
  return `lsu-${slug}@lyonstartup.com`;
}

function normalizeTitle(title) {
  return (title || '').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Check if an event date is in the past
function isEventPast(event) {
  // For scraped events: parse dateRaw (DD.MM.YYYY)
  if (event.dateRaw) {
    const m = event.dateRaw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) {
      const eventDate = new Date(`${m[3]}-${m[2]}-${m[1]}T23:59:59`);
      return eventDate < new Date();
    }
  }
  // For GCal events: parse dtstart (YYYYMMDD or YYYYMMDDTHHmmssZ)
  if (event.dtstart) {
    const dt = event.dtstart.replace('Z', '');
    const y = dt.substring(0, 4), mo = dt.substring(4, 6), d = dt.substring(6, 8);
    const eventDate = new Date(`${y}-${mo}-${d}T23:59:59`);
    return eventDate < new Date();
  }
  return false;
}

function diffWithGoogleCalendar(gcalEvents, scrapedEvents) {
  const added = [];
  const modified = [];
  const unchanged = [];
  const skippedPast = [];

  // Build a lookup by normalized title for GCal events
  const gcalByTitle = new Map();
  for (const [uid, ev] of gcalEvents) {
    gcalByTitle.set(normalizeTitle(ev.summary), { ...ev, uid });
  }

  const matchedGcalTitles = new Set();

  for (const event of scrapedEvents) {
    const normTitle = normalizeTitle(event.title);
    const gcalEvent = gcalByTitle.get(normTitle);

    if (!gcalEvent) {
      added.push(event);
    } else {
      matchedGcalTitles.add(normTitle);

      // Skip past events — no need to flag modifications
      if (isEventPast(event)) {
        unchanged.push(event);
        continue;
      }

      // Compare location — normalize trailing " - " and whitespace
      const changes = [];
      const normLoc = (s) => (s || '').replace(/\s*-\s*$/, '').replace(/\s+/g, ' ').trim();
      const scrapedLoc = normLoc(event.location + (event.address ? ' - ' + event.address : ''));
      const gcalLoc = normLoc(gcalEvent.location);
      if (gcalLoc && gcalLoc !== scrapedLoc && gcalLoc !== normLoc(event.location)) {
        changes.push(`lieu: "${gcalLoc}" -> "${scrapedLoc}"`);
      }

      if (changes.length > 0) {
        modified.push({ event, changes });
      } else {
        unchanged.push(event);
      }
    }
  }

  // Events in GCal but not matched to any scraped event — skip past ones
  const deleted = [];
  for (const [uid, gcalEvent] of gcalEvents) {
    if (!matchedGcalTitles.has(normalizeTitle(gcalEvent.summary))) {
      if (isEventPast(gcalEvent)) {
        skippedPast.push(gcalEvent);
      } else {
        deleted.push(gcalEvent);
      }
    }
  }

  return { added, modified, deleted, unchanged, skippedPast };
}

// ---------------------------------------------------------------------------
// Step 5 — Parse dates for ICS
// ---------------------------------------------------------------------------
function parseDates(event) {
  const { dateRaw, timeRaw, horaires } = event;

  const dateMatch = dateRaw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!dateMatch) {
    warn(`  Cannot parse date from: "${dateRaw}"`);
    return { startDate: null, endDate: null };
  }

  const [, day, month, year] = dateMatch;

  // Try to parse time range from horaires (e.g. "19:30 - 21:30")
  const timeMatch = horaires.match(/(\d{2}):(\d{2}).*?(\d{2}):(\d{2})/);
  if (timeMatch) {
    const [, startH, startM, endH, endM] = timeMatch;
    return {
      startDate: `${year}${month}${day}T${startH}${startM}00`,
      endDate:   `${year}${month}${day}T${endH}${endM}00`,
    };
  }

  // Fallback: single time, assume 2h duration
  const singleTime = timeRaw.match(/(\d{2}):(\d{2})/);
  if (singleTime) {
    const [, h, m] = singleTime;
    const endH = String(parseInt(h) + 2).padStart(2, '0');
    return {
      startDate: `${year}${month}${day}T${h}${m}00`,
      endDate:   `${year}${month}${day}T${endH}${m}00`,
    };
  }

  // Last fallback: all-day event
  warn(`  No time found, using all-day event for "${event.title}"`);
  return {
    startDate: `${year}${month}${day}`,
    endDate:   `${year}${month}${day}`,
    allDay: true,
  };
}

// ---------------------------------------------------------------------------
// Send calendar invite email
// ---------------------------------------------------------------------------
async function sendCalendarInvite(event) {
  if (!SMTP_USER || !SMTP_PASS) {
    warn(`  Skipping email invite (SMTP_USER/SMTP_PASS not configured)`);
    return;
  }

  const { startDate, endDate, allDay } = parseDates(event);
  if (!startDate) {
    warn(`  Skipping email invite — no valid date for "${event.title}"`);
    return;
  }

  const uid = makeUID(event);
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const loc = (event.location + (event.address ? ' - ' + event.address : '')).replace(/,/g, '\\,').replace(/;/g, '\\;');
  const desc = (event.description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;').substring(0, 500);
  const titleClean = (event.title || '').replace(/,/g, '\\,').replace(/;/g, '\\;');

  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lyon Startup//LSU19 Scraper//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    allDay ? `DTSTART;VALUE=DATE:${startDate}` : `DTSTART;TZID=Europe/Paris:${startDate}`,
    allDay ? `DTEND;VALUE=DATE:${endDate}` : `DTEND;TZID=Europe/Paris:${endDate}`,
    `DTSTAMP:${now}`,
    `UID:${uid}`,
    `SUMMARY:${titleClean}`,
    `DESCRIPTION:${desc}\\n\\nLien: ${event.url}`,
    `LOCATION:${loc}`,
    `URL:${event.url}`,
    `ORGANIZER;CN=Lyon Startup:mailto:${SMTP_USER}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${INVITE_TO}`,
    'STATUS:CONFIRMED',
    `SEQUENCE:0`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'ssl0.ovh.net',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"Lyon Startup" <${SMTP_USER}>`,
    to: INVITE_TO,
    subject: `Invitation: ${event.title}`,
    text: `${event.title}\n${event.dateRaw} ${event.horaires}\n${event.location} ${event.address}\n\n${event.description}\n\n${event.url}`,
    icalEvent: {
      method: 'REQUEST',
      content: icsContent,
    },
  });

  info(`  Email invite sent to ${INVITE_TO} for "${event.title}"`);
}

// ---------------------------------------------------------------------------
// Step 6 — Generate ICS
// ---------------------------------------------------------------------------
function escapeICS(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function generateICS(events) {
  info('=== STEP 6: Generating ICS file ===');
  info(`Events to include: ${events.length}`);

  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lyon Startup//LSU19 Scraper//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Lyon Startup - Evenements',
    'X-WR-TIMEZONE:Europe/Paris',
  ].join('\r\n') + '\r\n';

  for (const event of events) {
    const { startDate, endDate, allDay } = parseDates(event);
    if (!startDate) {
      warn(`  Skipping "${event.title}" — no valid date`);
      continue;
    }

    // Stable UID based on event path so we can track across runs
    const slug = (event.path || event.title).replace(/[^a-zA-Z0-9]/g, '-').substring(0, 80);
    const uid = `lsu-${slug}@lyonstartup.com`;
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

    const lines = [
      'BEGIN:VEVENT',
      allDay ? `DTSTART;VALUE=DATE:${startDate}` : `DTSTART:${startDate}`,
      allDay ? `DTEND;VALUE=DATE:${endDate}` : `DTEND:${endDate}`,
      `DTSTAMP:${now}`,
      `UID:${uid}`,
      `SUMMARY:${escapeICS(event.title)}`,
      `DESCRIPTION:${escapeICS(event.description).substring(0, 500)}\\n\\nLien: ${event.url}`,
      `LOCATION:${escapeICS(event.location + (event.address ? ' - ' + event.address : ''))}`,
      `URL:${event.url}`,
      `STATUS:CONFIRMED`,
      'END:VEVENT',
    ];

    ics += lines.join('\r\n') + '\r\n';

    debug(`  Added VEVENT: ${event.title} (${startDate} -> ${endDate})`);
  }

  ics += 'END:VCALENDAR\r\n';

  fs.writeFileSync(ICS_FILE, ics, 'utf-8');
  info(`ICS file written: ${ICS_FILE}`);
  info(`ICS file size: ${fs.statSync(ICS_FILE).size} bytes`);

  return ics;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startTime = Date.now();
  info('========================================');
  info('  Lyon Startup Event Scraper');
  info('========================================');
  const mode = UPDATE_GCAL ? 'UPDATE vs GOOGLE CALENDAR' : UPDATE_MODE ? 'UPDATE (diff local)' : REGISTER_EVENT ? `REGISTER: "${REGISTER_EVENT}"` : AUTO_REGISTER ? 'SCRAPE + AUTO-REGISTER' : 'SCRAPE ONLY';
  info(`Mode: ${mode}`);
  info(`Start time: ${new Date().toISOString()}`);
  info(`Log file: ${LOG_FILE}`);
  info(`ICS output: ${ICS_FILE}`);
  info('');

  try {
    // Step 1 — Get CSRF token
    const csrfToken = await getLoginPage();
    await sleep(REQUEST_DELAY);

    // Step 2 — Login
    await login(csrfToken);
    await sleep(REQUEST_DELAY);

    // Step 3 — Get events list
    const eventUrls = await fetchEventsList();
    await sleep(REQUEST_DELAY);

    // Step 4 — Fetch all event details
    info(`=== STEP 4: Fetching ${eventUrls.length} event details ===`);
    const allEvents = [];
    for (let i = 0; i < eventUrls.length; i++) {
      info(`  [${i + 1}/${eventUrls.length}] Fetching event...`);
      try {
        const event = await fetchEventDetail(eventUrls[i]);
        allEvents.push(event);
      } catch (err) {
        error(`  Failed to fetch event ${eventUrls[i]}: ${err.message}`);
      }
      await sleep(REQUEST_DELAY);
    }

    // Step 4b — Auto-register if --register or --register-event flag
    const newlyRegistered = [];
    const registrationFailed = [];
    if (AUTO_REGISTER || REGISTER_EVENT) {
      const toRegister = REGISTER_EVENT
        ? allEvents.filter(e => !e.isRegistered && normalizeTitle(e.title).includes(normalizeTitle(REGISTER_EVENT)))
        : allEvents.filter(e => !e.isRegistered);
      info('');
      info(`=== STEP 4b: Auto-registering to ${toRegister.length} events ===`);
      if (toRegister.length === 0) {
        info('  Already registered to all events!');
      }
      for (let i = 0; i < toRegister.length; i++) {
        info(`  [${i + 1}/${toRegister.length}] Registering...`);
        try {
          const success = await registerToEvent(toRegister[i]);
          if (success) {
            toRegister[i].isRegistered = true;
            newlyRegistered.push(toRegister[i]);
            try { await sendCalendarInvite(toRegister[i]); } catch (e) { warn(`  Email invite failed: ${e.message}`); }
          } else {
            registrationFailed.push(toRegister[i]);
          }
        } catch (err) {
          error(`  Registration error for "${toRegister[i].title}": ${err.message}`);
          registrationFailed.push(toRegister[i]);
        }
        await sleep(REQUEST_DELAY);
      }
    }

    // Step 5 — Diff
    info('');
    info('=== STEP 5: Summary ===');

    let eventsForICS = allEvents;

    if (UPDATE_GCAL) {
      // Compare with live Google Calendar
      const gcalEvents = await fetchGoogleCalendarEvents();
      const { added, modified, deleted, unchanged, skippedPast } = diffWithGoogleCalendar(gcalEvents, allEvents);

      info('');
      info(`--- Comparaison avec Google Calendar (${gcalEvents.size} events) ---`);
      info(`Deja dans GCal (OK): ${unchanged.length}`);
      info(`A AJOUTER: ${added.length}`);
      info(`A MODIFIER: ${modified.length}`);
      info(`A SUPPRIMER de GCal: ${deleted.length}`);
      if (skippedPast.length > 0) {
        info(`Ignores (passes): ${skippedPast.length}`);
      }

      if (added.length > 0) {
        info('');
        info('--- A AJOUTER (genere dans le ICS) ---');
        added.forEach(e => info(`  + ${e.title} | ${e.dateRaw} | ${e.location}`));
      }

      if (modified.length > 0) {
        info('');
        info('--- A MODIFIER (manuellement dans Google Calendar) ---');
        modified.forEach(({ event, changes }) => {
          info(`  ~ ${event.title}`);
          changes.forEach(c => info(`      ${c}`));
        });
      }

      if (deleted.length > 0) {
        info('');
        info('--- A SUPPRIMER (manuellement dans Google Calendar) ---');
        deleted.forEach(e => info(`  - ${e.summary}`));
      }

      if (added.length === 0 && modified.length === 0 && deleted.length === 0) {
        info('');
        info('Google Calendar est a jour !');
      }

      eventsForICS = added;

    } else if (UPDATE_MODE) {
      // Compare with local state file
      const oldState = loadState();
      const hasOldState = Object.keys(oldState).length > 0;

      if (!hasOldState) {
        info('No previous state found — full export (same as first run)');
      } else {
        const { added, modified, deleted, unchanged, skippedPast } = diffEvents(oldState, allEvents);

        info(`Unchanged: ${unchanged.length}`);
        info(`New events to ADD: ${added.length}`);
        info(`Modified events (update manually): ${modified.length}`);
        info(`Deleted events (remove manually): ${deleted.length}`);
        if (skippedPast.length > 0) {
          info(`Ignores (passes): ${skippedPast.length}`);
        }

        if (added.length > 0) {
          info('');
          info('--- A AJOUTER (dans le ICS) ---');
          added.forEach(e => info(`  + ${e.title} | ${e.dateRaw} | ${e.location}`));
        }

        if (modified.length > 0) {
          info('');
          info('--- A MODIFIER (manuellement dans Google Calendar) ---');
          modified.forEach(({ event, changes }) => {
            info(`  ~ ${event.title}`);
            changes.forEach(c => info(`      ${c}`));
          });
        }

        if (deleted.length > 0) {
          info('');
          info('--- A SUPPRIMER (manuellement dans Google Calendar) ---');
          deleted.forEach(e => info(`  - ${e.title} | ${e.dateRaw}`));
        }

        if (added.length === 0 && modified.length === 0 && deleted.length === 0) {
          info('');
          info('Aucun changement detecte !');
        }

        eventsForICS = added;
      }
    }

    // Registration summary
    const registered = allEvents.filter(e => e.isRegistered);
    const notRegistered = allEvents.filter(e => !e.isRegistered);
    info('');
    info(`Total events: ${allEvents.length} | Inscrits: ${registered.length} | Non-inscrits: ${notRegistered.length}`);
    if (AUTO_REGISTER) {
      info(`Newly registered: ${newlyRegistered.length} | Failed: ${registrationFailed.length}`);
    }

    if (!UPDATE_MODE) {
      info('');
      info('--- All events ---');
      allEvents.forEach((e, i) => {
        const tag = newlyRegistered.includes(e) ? 'NOUVEAU' : e.isRegistered ? 'INSCRIT' : 'NON-INSCRIT';
        info(`  ${i + 1}. [${tag}] ${e.title} | ${e.dateRaw} | ${e.location}`);
      });
    }

    if (newlyRegistered.length > 0) {
      info('');
      info('--- Nouvelles inscriptions ---');
      newlyRegistered.forEach(e => info(`  + ${e.title}`));
    }

    if (registrationFailed.length > 0) {
      info('');
      info('--- Inscriptions echouees ---');
      registrationFailed.forEach(e => info(`  x ${e.title}`));
    }

    // Step 6 — Generate ICS
    if (eventsForICS.length > 0) {
      const label = UPDATE_MODE ? 'new events only' : 'all events';
      info('');
      generateICS(eventsForICS);
      info(`ICS contains: ${eventsForICS.length} ${label}`);
    } else if (UPDATE_MODE) {
      info('');
      info('Rien de nouveau a importer, pas de ICS genere');
    } else {
      warn('No events found, no ICS file generated');
    }

    // Save state for future --update runs
    saveState(allEvents);

    // Final stats
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    info('');
    info('========================================');
    info('  DONE');
    info(`  Total time: ${elapsed}s`);
    info(`  Events: ${allEvents.length}`);
    if (UPDATE_MODE && eventsForICS.length > 0) {
      info(`  ICS (new only): ${ICS_FILE}`);
    } else if (!UPDATE_MODE) {
      info(`  ICS: ${ICS_FILE}`);
    }
    info(`  Log: ${LOG_FILE}`);
    info(`  State: ${STATE_FILE}`);
    info('========================================');

  } catch (err) {
    error(`Fatal error: ${err.message}`);
    error(`Stack: ${err.stack}`);
    process.exit(1);
  }
}

main();
