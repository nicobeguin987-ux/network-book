// Classifies LinkedIn connections by industry, geography, seniority and function.
// Port of the original Python rules; runs entirely in the browser.
import { RULES } from './rules-data.js';

/* Python's \b is Unicode-aware, JavaScript's is ASCII-only ("associé\b" would never match).
   Rewrite \b into an explicit Unicode word boundary. */
const W = '[\\p{L}\\p{N}_]';
const UB = `(?:(?<!${W})(?=${W})|(?<=${W})(?!${W}))`;
const cache = new Map();
export function rx(src) {
  let r = cache.get(src);
  if (!r) { r = new RegExp(src.replace(/\\b/g, UB), 'iu'); cache.set(src, r); }
  return r;
}
const t = (src, s) => rx(src).test(s);

export const INDUSTRIES = [
  'Investment Banking & M&A', 'Private Equity', 'Venture Capital', 'Private Credit & Infra', 'Asset & Wealth Management',
  'Banking & Markets', 'Insurance', 'Transaction Services & Audit', 'Consulting', 'Legal', 'Executive Search',
  'Tech & Software', 'Fintech', 'Healthcare & Life Sciences', 'Consumer, Retail & Luxury', 'Industrials & Energy',
  'Real Estate', 'Media, Telecom & Sport', 'Public Sector & Education', 'Business Services', 'Other'];
export const GEOGRAPHIES = ['France', 'United Kingdom', 'Europe (other)', 'North America', 'Middle East', 'Africa', 'Asia-Pacific', 'Latin America', 'Unknown'];
export const SENIORITIES = ['Founder / Owner', 'C-Suite & Board', 'Partner / MD', 'Director / Head', 'VP / Manager', 'Associate', 'Analyst / Junior', 'Intern / Student', 'Not specified'];
export const FUNCTIONS = ['M&A / Deal advisory', 'Investing', 'General management', 'Corp Dev & Strategy', 'Finance & Accounting', 'Sales & BD',
  'Tech & Product', 'Operations', 'HR & Recruiting', 'Legal & Compliance', 'Marketing & Comms', 'Research & Analysis', 'Consulting', 'Student', 'Other'];

const X = RULES.RX;
const INDEP = new Set(RULES.INDEP);
const BANKS = new Set(RULES.BANKS);
const GLOBAL = new Set(RULES.GLOBAL);
const FRENCH_HQ_GLOBAL = new Set(RULES.FRENCH_HQ_GLOBAL);
const UNDISCLOSED = 'Independent / undisclosed';

export function canon(c) {
  const c0 = (c || '').trim();
  if (INDEP.has(c0) || /^[^\p{L}\p{N}]*$/u.test(c0)) return UNDISCLOSED;
  return RULES.MERGE[c0] || c0;
}
const COMPANY_EXPLICIT = {};
for (const [k, v] of Object.entries(RULES.EXPLICIT)) COMPANY_EXPLICIT[canon(k)] = v;
for (const [k, v] of Object.entries(RULES.EXPLICIT)) if (canon(k) === k) COMPANY_EXPLICIT[k] = v;

export function industry(raw, company, pos) {
  const p = pos.toLowerCase();
  let ind = null;
  if (company in RULES.FINAL) ind = RULES.FINAL[company];
  else if (company in COMPANY_EXPLICIT) ind = COMPANY_EXPLICIT[company];
  else if (raw in RULES.EXPLICIT) ind = RULES.EXPLICIT[raw];
  if (BANKS.has(raw) || BANKS.has(company)) {
    if (t(X.POS_IB, p)) return 'Investment Banking & M&A';
    if (t(X.POS_VC, p)) return 'Venture Capital';
    if (t(X.POS_PE, p)) return 'Private Equity';
    if (t(X.POS_CREDIT, p)) return 'Private Credit & Infra';
    if (t(X.POS_AM, p)) return 'Asset & Wealth Management';
  }
  if (ind) return ind;
  const cl = company.toLowerCase();
  for (const [src, nm] of RULES.BRAND) {
    if (t(src, cl)) {
      if (nm === 'BANK') {
        if (t(X.POS_IB, p)) return 'Investment Banking & M&A';
        if (t(X.POS_PE, p)) return 'Private Equity';
        if (t(X.POS_CREDIT, p)) return 'Private Credit & Infra';
        if (t(X.POS_AM, p)) return 'Asset & Wealth Management';
        return 'Banking & Markets';
      }
      return nm;
    }
  }
  if (company !== UNDISCLOSED) {
    for (const [name, src] of RULES.KW) {
      if (t(src, company)) {
        if (['Private Equity', 'Investment Banking & M&A', 'Consulting'].includes(name)) {
          if (t(X.POS_VC, p)) return 'Venture Capital';
          if (t(X.POS_CREDIT, p)) return 'Private Credit & Infra';
          if (t(X.POS_AM, p)) return 'Asset & Wealth Management';
          if (t('m&a|corporate finance|fusions|investment bank', p) && name !== 'Private Equity') return 'Investment Banking & M&A';
          if (t(X.POS_PE, p)) return 'Private Equity';
        }
        return name;
      }
    }
  }
  const fallback = [['Investment Banking & M&A', X.POS_IB], ['Private Equity', X.POS_PE], ['Venture Capital', X.POS_VC],
    ['Private Credit & Infra', X.POS_CREDIT], ['Asset & Wealth Management', X.POS_AM],
    ['Executive Search', 'recruit|recrut|headhunt|executive search|talent acquisition partner'],
    ['Legal', 'avocat|lawyer|attorney|solicitor|counsel|juriste'],
    ['Tech & Software', 'software|developer|développeur|engineer|ingénieur|data scien|product (manager|owner)|\\bai\\b|cto|tech'],
    ['Consulting', 'consult|conseil|advis'], ['Real Estate', 'real estate|immobili'],
    ['Healthcare & Life Sciences', 'pharma|medical|médical|doctor|médecin|health|santé|biotech'],
    ['Public Sector & Education', 'student|étudiant|teacher|professeur|lecturer|research fellow']];
  for (const [name, src] of fallback) if (t(src, p)) return name;
  return 'Other';
}

export function geography(raw, company, pos, fullname) {
  const p = pos.toLowerCase();
  const order = [['United Kingdom', X.UK_HINT], ['Middle East', X.ME_HINT], ['Africa', X.AF_HINT], ['Asia-Pacific', X.AS_HINT],
    ['Latin America', X.LATAM_HINT], ['North America', '\\b(new york|nyc|san francisco|boston|chicago|toronto|montreal|montréal|\\busa\\b|canada)\\b']];
  for (const [g, src] of order) {
    if (t(src, g === 'United Kingdom' ? p + ' ' + fullname.toLowerCase() : p)) {
      if (g === 'United Kingdom' && t('excl\\.? uk|france|paris', p)) break;
      return [g, 'title'];
    }
  }
  if (t('\\b(paris|france|french|français)\\b', p)) return ['France', 'title'];
  if (t(X.EU_HINT, p)) return ['Europe (other)', 'title'];
  if (company in RULES.GEO_EXPLICIT) return [RULES.GEO_EXPLICIT[company], 'company'];
  if (raw in RULES.GEO_EXPLICIT) return [RULES.GEO_EXPLICIT[raw], 'company'];
  if (t(X.FR_HINT_POS, p)) return ['France', 'title'];
  if (FRENCH_HQ_GLOBAL.has(company) || FRENCH_HQ_GLOBAL.has(raw)) return ['France', 'company'];
  if (GLOBAL.has(raw) || GLOBAL.has(company)) return ['Unknown', 'none'];
  const rl = raw.toLowerCase();
  const order2 = [['United Kingdom', X.UK_HINT], ['Middle East', X.ME_HINT], ['Africa', X.AF_HINT], ['Asia-Pacific', X.AS_HINT],
    ['Latin America', X.LATAM_HINT], ['Europe (other)', X.EU_HINT], ['North America', '\\binc\\b|\\bllc\\b|\\bcorp\\b|\\bl\\.p\\.']];
  for (const [g, src] of order2) if (t(src, rl)) return [g, 'company'];
  if (t(X.FR_HINT_CO, rl)) return ['France', 'company'];
  if (company === UNDISCLOSED) return ['Unknown', 'none'];
  return ['France', 'assumed'];
}

export function seniority(pos) {
  const p = pos.toLowerCase();
  if (!p.trim()) return 'Not specified';
  if (t('\\bintern\\b|internship|stagiaire|\\bstage\\b|alternan|apprenti|trainee|student|étudiant|summer|off-cycle|working student|werkstudent|externship|graduate program|candidate|participant', p)) return 'Intern / Student';
  if (t('founder|fondat|co-?fondat|cofound|owner|propriétaire|gérant fondateur|entrepreneur', p)) return 'Founder / Owner';
  if (t('\\bpdg\\b|secrétaire général|board observer|membre du conseil|\\bmember of the board|conseil de surveillance', p)) return 'C-Suite & Board';
  if (t('\\bceo\\b|\\bcfo\\b|\\bcoo\\b|\\bcto\\b|\\bcmo\\b|\\bcro\\b|\\bcpo\\b|\\bcio\\b|\\bcso\\b|\\bcco\\b|chief|président|(?<!vice )president|directeur général|directrice générale|\\bdg\\b|chairman|chairwoman|\\bchair\\b|board member|non[- ]executive|supervisory board|conseil d.administration|administrat(eur|rice)|general manager|country manager|managing director.*head of (france|europe|emea)', p)) return 'C-Suite & Board';
  if (t('managing partner|senior partner|general partner|founding partner|\\bpartner\\b|associé|associée|managing director|\\bmd\\b|directeur associé|executive managing', p) &&
      !t('associate partner|business partner|hr partner|talent acquisition partner|client growth partner|partner manager|partnerships|partner talent', p)) return 'Partner / MD';
  if (t('director|directeur|directrice|head of|head\\b|responsable|principal|executive director|\\bsvp\\b|senior vice president|\\bevp\\b|leader|lead\\b|associate partner|chef de|deputy', p)) return 'Director / Head';
  if (t('vice president|\\bvp\\b|manager|senior consultant|chargé d.affaires senior|team lead|supervisor|senior manager|directeur de mission|consultant senior|engagement', p)) return 'VP / Manager';
  if (t('associate|associé junior|chargé|chargée|consultant|senior analyst|specialist|spécialiste|engineer|ingénieur|executive|account executive|investment professional|investor\\b|lawyer|avocat|counsel|officer|\\badvis[oe]r\\b|conseiller', p)) return 'Associate';
  if (t('analyst|analyste|junior|assistant|coordinator|representative|developer|développeur|researcher|research fellow', p)) return 'Analyst / Junior';
  if (t('auditor|auditeur|contrôleur|controleur|controller|comptable|accountant|sales|commercial|gérant|gerant|investisseur|professeur|teacher|tutor|agent|headhunter|collaborat|builder|reporter|journalist|vigneron|employé|generalist|derivatives|structured', p)) return 'Associate';
  return 'Not specified';
}

export function jobFunction(pos, ind, sen) {
  const p = pos.toLowerCase();
  if (sen === 'Intern / Student' && t('student|étudiant|candidate|participant', p)) return 'Student';
  if (ind === 'Executive Search' && !t('\\bceo\\b|founder|fondat|managing partner', p)) return 'HR & Recruiting';
  if (t('corp(orate)? ?dev|strategy|stratég|strategic|business development director|head of m&a|m&a director(?!.*(bank|advis))|directeur des acquisitions|chief of staff|bras droit|transformation', p) &&
      !['Investment Banking & M&A', 'Consulting', 'Transaction Services & Audit', 'Private Equity', 'Venture Capital'].includes(ind)) return 'Corp Dev & Strategy';
  if (t('\\bceo\\b|chief executive|founder|fondat|cofound|président|(?<!vice )president|directeur général|directrice générale|general manager|managing director|\\bdg\\b|owner|gérant|chairman|board|country manager', p) &&
      !['Investment Banking & M&A', 'Private Equity', 'Venture Capital', 'Asset & Wealth Management', 'Private Credit & Infra'].includes(ind)) return 'General management';
  if (t('m&a|mergers|fusions|corporate finance|investment bank|\\becm\\b|\\bdcm\\b|leveraged|transaction services|due diligence|deal advisory|financial advisory|valuation|restructuring|debt advisory', p) ||
      (['Investment Banking & M&A', 'Transaction Services & Audit'].includes(ind) && !t('recruit|talent|hr\\b|marketing|assistant', p))) return 'M&A / Deal advisory';
  if (t('private equity|investment|investissement|participations|venture|investor|portfolio|fund|gérant|asset management|capital|credit|debt|underwrit|trader|trading|sales trading|wealth|private bank', p) ||
      ['Private Equity', 'Venture Capital', 'Private Credit & Infra', 'Asset & Wealth Management'].includes(ind)) {
    if (!t('recruit|talent|\\bhr\\b|human|marketing|communication|assistant|office manager|legal|juriste|compliance|it\\b', p)) return 'Investing';
  }
  if (t('recruit|recrut|talent|\\bhr\\b|human resources|ressources humaines|people|rh\\b|headhunt|search consultant|executive search', p) || ind === 'Executive Search') return 'HR & Recruiting';
  if (t('avocat|lawyer|legal|juriste|counsel|compliance|attorney|solicitor|notaire|tax|fiscal', p) || ind === 'Legal') return 'Legal & Compliance';
  if (t('\\bcfo\\b|financ|comptab|account(ant|ing)|controll|contrôl|fp&a|treasur|trésor|audit|daf\\b|tax', p)) return 'Finance & Accounting';
  if (t('software|engineer|ingénieur|developer|développeur|\\bcto\\b|product|data|tech|\\bit\\b|devops|cloud|ai\\b|machine learning|scien', p)) return 'Tech & Product';
  if (t('sales|vente|commercial|business develop|account (executive|manager)|partnership|key account|growth|bd\\b|client|customer|go-to-market|gtm', p)) return 'Sales & BD';
  if (t('marketing|communication|brand|pr\\b|content|media|influence|événement|event|journalist|editor|rédact', p)) return 'Marketing & Comms';
  if (t('research|analyst|analyste|economist|économiste|rating', p)) return 'Research & Analysis';
  if (t('consult|conseil', p) || ind === 'Consulting') return 'Consulting';
  if (t('operations|opérations|ops\\b|supply|logisti|project|projet|office manager|assistant|coordinat|production|purchas|achats|procurement', p)) return 'Operations';
  return 'Other';
}

/* ------------------------------------------------ CSV import */
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
export const slugOf = url => String(url || '').trim().replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '').replace(/\/+$/, '');
export const contactId = slug => 'p-' + String(slug).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 150);
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
export function parseLinkedInDate(s) {
  const m = String(s || '').match(/(\d{1,2}) (\w{3}) (\d{4})/);
  if (!m || !MONTHS[m[2]]) return '';
  return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Reads a LinkedIn Connections.csv and returns {rows:[...], error} with raw fields. */
export function readConnections(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const h = rows.findIndex(r => r[0] && r[0].trim() === 'First Name' && r.some(x => x.trim() === 'Company'));
  if (h < 0) return { error: 'This is not a LinkedIn Connections.csv: the "First Name, Last Name, URL, Email Address, Company, Position, Connected On" header is missing.' };
  const col = Object.fromEntries(rows[h].map((k, i) => [k.trim(), i]));
  const get = (r, k) => (col[k] != null ? (r[col[k]] || '') : '').trim();
  const out = [];
  for (const r of rows.slice(h + 1)) {
    if (r.length < 3) continue;
    const fn = get(r, 'First Name'), ln = get(r, 'Last Name'), url = get(r, 'URL');
    if (!fn && !ln && !url) continue;              // LinkedIn exports hidden profiles as empty rows
    out.push({ fn, ln, slug: slugOf(url), email: get(r, 'Email Address'), company: get(r, 'Company'), pos: get(r, 'Position'), on: get(r, 'Connected On') });
  }
  return { rows: out };
}

/** Classifies one raw row into the record shape the app uses. */
export function classify(row) {
  const raw = row.company, comp = canon(raw), pos = row.pos;
  const name = `${row.fn} ${row.ln}`.trim() || 'Unnamed connection';
  const i = industry(raw, comp, pos);
  const [g, gc] = geography(raw, comp, pos, name);
  const s = seniority(pos);
  return {
    id: contactId(row.slug || name), n: name, fn: row.fn, p: pos, c: comp, cr: raw !== comp ? raw : '',
    u: row.slug, e: row.email, d: parseLinkedInDate(row.on), i, g, gc, s, f: jobFunction(pos, i, s), t: [],
  };
}
