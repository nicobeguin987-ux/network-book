// Google sign-in (Google Identity Services token flow) for Gmail drafts and Calendar events.
// Needs an OAuth "Web application" client ID from your own Google Cloud project (see README).
// Tokens live in memory for about an hour; nothing is stored on a server.

const SCOPES = 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events';
let gisLoading = null, tokenClient = null, clientIdInUse = '', token = null, tokenExp = 0, pendingResolve = null, pendingReject = null;

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (!gisLoading) gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => resolve(); s.onerror = () => { gisLoading = null; reject(new Error('Could not load Google sign-in. Check your connection or ad blocker.')); };
    document.head.appendChild(s);
  });
  return gisLoading;
}

export function googleConnected() { return !!token && Date.now() < tokenExp - 60000; }

/** Preload the Google script so the sign-in popup can open straight from a click. */
export function prepareGoogle(clientId) { if (clientId) loadGis().catch(() => {}); }

/** Must be called from a click handler (opens Google's consent popup). */
export async function connectGoogle(clientId) {
  if (!clientId) throw Object.assign(new Error('Add your Google OAuth client ID in Settings first.'), { code: 'no_client' });
  await loadGis();
  if (!tokenClient || clientIdInUse !== clientId) {
    clientIdInUse = clientId;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPES,
      callback: r => {
        if (r && r.access_token) { token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000; pendingResolve && pendingResolve(); }
        else pendingReject && pendingReject(Object.assign(new Error((r && r.error_description) || 'Google sign-in was not completed.'), { code: 'denied' }));
        pendingResolve = pendingReject = null;
      },
      error_callback: e => { pendingReject && pendingReject(Object.assign(new Error(e && e.type === 'popup_closed' ? 'The Google window was closed.' : 'Google sign-in failed or the popup was blocked.'), { code: 'denied' })); pendingResolve = pendingReject = null; },
    });
  }
  return new Promise((resolve, reject) => { pendingResolve = resolve; pendingReject = reject; tokenClient.requestAccessToken({ prompt: token ? '' : 'consent' }); });
}

export function disconnectGoogle() {
  if (token && window.google && window.google.accounts) window.google.accounts.oauth2.revoke(token, () => {});
  token = null; tokenExp = 0;
}

async function gapi(url, body) {
  if (!googleConnected()) throw Object.assign(new Error('Connect Google first.'), { code: 'not_connected' });
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) { token = null; throw Object.assign(new Error('Your Google session expired. Click “Connect Google” again.'), { code: 'not_connected' }); }
  let j = {}; try { j = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) {
    const m = (j.error && j.error.message) || ('HTTP ' + res.status);
    if (res.status === 403 && /has not been used|disabled/i.test(m)) throw Object.assign(new Error('Enable the Gmail API and Google Calendar API in your Google Cloud project.'), { code: 'api_disabled' });
    if (res.status === 403) throw Object.assign(new Error('Google refused: ' + m + '. Reconnect Google and allow Gmail and Calendar access.'), { code: 'forbidden' });
    throw Object.assign(new Error('Google error: ' + m), { code: 'google_error' });
  }
  return j;
}

const utf8b64 = s => { const b = new TextEncoder().encode(s); let bin = ''; for (const x of b) bin += String.fromCharCode(x); return btoa(bin); };
const b64url = s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function createGmailDraft({ to, subject, body }) {
  const mime = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${utf8b64(subject || '')}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    utf8b64(body).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  const d = await gapi('https://gmail.googleapis.com/gmail/v1/users/me/drafts', { message: { raw: b64url(utf8b64(mime)) } });
  return { id: d.id, viewUrl: d.message && d.message.id ? `https://mail.google.com/mail/#drafts?compose=${d.message.id}` : 'https://mail.google.com/mail/#drafts' };
}

export async function createCalendarEvent({ summary, description, location, date, start, end, timeZone, attendeeEmail }) {
  const body = {
    summary, description, location: location || undefined,
    start: { dateTime: `${date}T${start}:00`, timeZone }, end: { dateTime: `${date}T${end}:00`, timeZone },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : undefined,
  };
  const q = attendeeEmail ? 'all' : 'none';
  const ev = await gapi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${q}`, body);
  return { htmlLink: ev.htmlLink };
}

/* Fallbacks that need no Google setup: open a pre-filled compose window or event form. */
export function gmailComposeUrl({ to, subject, body }) {
  const p = new URLSearchParams({ view: 'cm', fs: '1', to: to || '', su: subject || '', body: body || '' });
  return 'https://mail.google.com/mail/?' + p.toString();
}
export function calendarTemplateUrl({ summary, description, location, date, start, end, timeZone, attendeeEmail }) {
  const f = (d, t) => d.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
  const p = new URLSearchParams({ action: 'TEMPLATE', text: summary, details: description || '', location: location || '', dates: `${f(date, start)}/${f(date, end)}`, ctz: timeZone });
  if (attendeeEmail) p.set('add', attendeeEmail);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}
