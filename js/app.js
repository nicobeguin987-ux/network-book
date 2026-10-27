import { openStore } from './store.js';
import { makeSample, aiErrorMessage, MODELS } from './ai.js';
import { readConnections, classify, seniority as senOf, jobFunction } from './classify.js';
import { encryptJson, decryptJson } from './vault.js';
import * as G from './google.js';

(() => {
'use strict';
/* ---------------------------------------------------------------- constants */
const IND_FAM = {
  'Investment Banking & M&A':'adv','Transaction Services & Audit':'adv','Consulting':'adv','Legal':'adv','Executive Search':'adv',
  'Private Equity':'inv','Venture Capital':'inv','Private Credit & Infra':'inv','Asset & Wealth Management':'inv',
  'Banking & Markets':'bank','Insurance':'bank',
  'Tech & Software':'corp','Fintech':'corp','Healthcare & Life Sciences':'corp','Consumer, Retail & Luxury':'corp','Industrials & Energy':'corp',
  'Real Estate':'corp','Media, Telecom & Sport':'corp','Business Services':'corp',
  'Public Sector & Education':'oth','Other':'oth'};
const FAM_NAME = {adv:'Advisory', inv:'Investors', bank:'Banks & insurers', corp:'Companies', oth:'Public & other'};
const INDS = Object.keys(IND_FAM);
const GEOS = ['France','United Kingdom','Europe (other)','North America','Middle East','Africa','Asia-Pacific','Latin America','Unknown'];
const SENS = ['Founder / Owner','C-Suite & Board','Partner / MD','Director / Head','VP / Manager','Associate','Analyst / Junior','Intern / Student','Not specified'];
const FUNS = ['M&A / Deal advisory','Investing','General management','Corp Dev & Strategy','Finance & Accounting','Sales & BD','Tech & Product','Operations','HR & Recruiting','Legal & Compliance','Marketing & Comms','Research & Analysis','Consulting','Student','Other'];
const STATUSES = [['', 'Not contacted','st-none'],['reach','To reach out','st-reach'],['cont','Contacted','st-cont'],['conv','In conversation','st-conv'],['met','Met','st-met'],['warm','Keep warm','st-warm'],['nr','Not relevant','st-nr']];
const ST = Object.fromEntries(STATUSES.map(s=>[s[0],s]));
const KINDS = ['Coffee','Call','Meeting','Email','LinkedIn msg','Event','Note'];
const DEFAULT_TAGS = ['Client','Prospect','Friend','Headhunter','Intro target','Buy-side','Sell-side','Mentor'];
const SENIOR = new Set(['Founder / Owner','C-Suite & Board','Partner / MD']);
const INVESTOR = new Set(['Private Equity','Venture Capital','Private Credit & Infra','Asset & Wealth Management']);

/* ---------------------------------------------------------------- state */
let BASE0 = [];           // contacts from export
let BASE = [];            // export + connections added by later imports
let BYID = new Map();
let COMPANIES = new Map(); // name -> {name, ids:[]}
const S = { people:{}, notes:[], tasks:[], drafts:{}, settings:{}, imports:{} };   // stored in db
let db = null, dbState = 'connecting';
const UI = {
  view:'home', q:'', f:{i:new Set(),g:new Set(),s:new Set(),f:new Set(),st:new Set(),pr:new Set(),tg:new Set(),y:new Set()},
  preset:null, shown:100, sel:new Set(), sort:'name',
  coQ:'', coInd:'', coSort:'count', coShown:120,
  homeTab:'i', jQ:'', jKind:'', jTag:'', jInd:'',
  drawer:null, facetOpen:false, moreF:{},
  dr:{purpose:'catch',channel:'li',lang:'auto'}, act:{goal:null,n:10,purpose:'catch',channel:'li',off:new Set()}, ev:{}, prep:null, imp:null
};

/* ---------------------------------------------------------------- utils */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => n.toLocaleString('en-GB');
const today = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const addDays = (n) => { const d=new Date(); d.setDate(d.getDate()+n); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const nice = iso => { if(!iso) return ''; const [y,m,d]=iso.split('-').map(Number); const dt=new Date(y,m-1,d); return dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',year: y===new Date().getFullYear()?undefined:'numeric'}); };
const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
let toastT; function toast(msg){ const l=$('#layer'); let t=document.querySelector('.toast'); if(!t){t=document.createElement('div');t.className='toast';t.setAttribute('role','status');document.body.appendChild(t);} t.textContent=msg; clearTimeout(toastT); toastT=setTimeout(()=>t.remove(),2200); }
const famDot = ind => `<span class="fam" style="background:var(--fam-${IND_FAM[ind]||'oth'})"></span>`;

/* effective record = export + saved edits */
function E(c){
  const o = S.people[c.id];
  if(!o) return c;
  const r = Object.assign({}, c, {
    i:o.i||c.i, g:o.g||c.g, gc:o.g?'set':c.gc, s:o.s||c.s, f:o.f||c.f,
    t: Array.isArray(o.tags)?o.tags:c.t, st:o.st||'', pr:o.pr||'', last:o.last||'',
    e:o.em||c.e, cad:+o.cad||0, since:o.since||'', sinceApprox:!!o.sinceApprox, chg:o.chg||'', prevC:o.prevC||'', prevP:o.prevP||''
  });
  if(o.c||o.p){ r.c=o.c||c.c; r.p=o.p||c.p; r._s=norm(r.n+' '+r.p+' '+r.c); }
  return r;
}
function openTasksFor(id){ return S.tasks.filter(t=>!t.done && t.cid===id); }

/* ---------------------------------------------------------------- data load */
function loadContacts(){
  BASE0 = db ? db.collection('contacts').all().map(([id,d])=>prepRec(Object.assign({}, d, {id, t:Array.isArray(d.t)?[...d.t]:[]}))) : [];
  rebuildBase();
}
function prepRec(o){ o.st=''; o.pr=''; o.last=''; o.cad=0; o.since=''; o.chg=''; o.cr=o.cr||''; o.t=o.t||[]; o.y=o.d?o.d.slice(0,4):''; o._s=norm(o.n+' '+o.p+' '+o.c); return o; }
function tagRules(){
  return String(SET().tagRules||'').split('\n').map(l=>l.split('=')).filter(x=>x.length===2&&x[0].trim()&&x[1].trim()).map(([a,b])=>[norm(a.trim()),b.trim()]);
}
function rebuildBase(){
  const rules=tagRules();
  BASE = rules.length ? BASE0.map(c=>{ const add=rules.filter(([co])=>norm(c.c)===co||(c.cr&&norm(c.cr)===co)).map(r=>r[1]); return add.length?Object.assign({},c,{t:[...new Set([...c.t,...add])]}):c; }) : BASE0;
  BYID = new Map(BASE.map(c=>[c.id,c]));
  $('#brandsub').textContent = BASE.length ? fmt(BASE.length)+' connections' : 'No contacts yet';
  const imp=S.imports&&S.imports.last; $('#srcdate').textContent = imp ? 'LinkedIn data of '+nice(imp) : '';
}

/* ---------------------------------------------------------------- db */
const writeChain = new Map();
function chain(key, fn){ const p=(writeChain.get(key)||Promise.resolve()).then(fn,fn); writeChain.set(key,p.catch(()=>{})); return p; }
function setSync(state, txt){ dbState=state; $('#syncdot').className='dot '+(state==='on'?'on':state==='off'?'off':''); $('#synctxt').textContent=txt; }
function onDbErr(e){ console.warn(e); }
async function connect(){
  try { db = await openStore(); }
  catch(e){ db=null; setSync('off','Storage blocked'); return; }
  setSync('on','Saved on this device');
  const m2o=s=>{ const m={}; s.docs.forEach(x=>m[x.id]=x.data()); return m; };
  db.collection('people').onSnapshot(s=>{ S.people=m2o(s); render(); }, onDbErr);
  db.collection('notes').onSnapshot(s=>{ S.notes=s.docs.map(x=>Object.assign({id:x.id},x.data())); render(); }, onDbErr);
  db.collection('tasks').onSnapshot(s=>{ S.tasks=s.docs.map(x=>Object.assign({id:x.id},x.data())); render(); }, onDbErr);
  db.collection('drafts').onSnapshot(s=>{ S.drafts=m2o(s); render(); }, onDbErr);
  db.collection('meta').onSnapshot(s=>{ const m=m2o(s); S.settings=m.settings||{}; S.imports=m.imports||{}; G.prepareGoogle(SET().googleClientId); rebuildBase(); render(); }, onDbErr);
  db.collection('contacts').onSnapshot(()=>{ loadContacts(); render(); }, onDbErr);
  loadContacts();
}
function needDb(){ if(!db){ toast('This browser is blocking local storage (private window?). Open the app in a normal window.'); return false;} return true; }
async function savePerson(id, patch){
  if(!needDb()) return;
  const cur = Object.assign({}, S.people[id]||{});
  Object.assign(cur, patch, {u:Date.now()});
  S.people = Object.assign({}, S.people, {[id]:cur}); render();
  try { await chain('p/'+id, ()=>db.collection('people').doc(id).set(cur)); }
  catch(e){ handleWriteErr(e); }
}
function handleWriteErr(e){ console.warn(e); if(e&&e.code==='quota_exceeded') toast('Storage is full. Delete old notes or tasks to add more.'); else toast('Could not save. Try again in a moment.'); }
async function addNote(n){
  if(!needDb()) return;
  const doc = Object.assign({createdAt:Date.now()}, n);
  try{ await db.collection('notes').add(doc); }catch(e){ return handleWriteErr(e); }
  if(n.cid){ const c=E(BYID.get(n.cid)); const patch={last: (c.last && c.last>n.date)?c.last:n.date};
    if(!c.st || c.st==='reach') patch.st = (n.kind==='Coffee'||n.kind==='Meeting')?'met':'cont';
    if(n.kind!=='Note' || patch.st) await savePerson(n.cid, patch); }
  toast('Logged to the journal');
}
async function delNote(id){ if(!needDb()) return; try{ await db.collection('notes').doc(id).delete(); toast('Note deleted'); }catch(e){handleWriteErr(e);} }
async function addTask(t){ if(!needDb()) return; try{ await db.collection('tasks').add(Object.assign({createdAt:Date.now(),done:false},t)); toast('Added to your to-do list'); }catch(e){handleWriteErr(e);} }
async function setTask(id, patch){ if(!needDb()) return; const t=S.tasks.find(x=>x.id===id); if(!t) return; const cur=Object.assign({},t,patch); delete cur.id; S.tasks=S.tasks.map(x=>x.id===id?Object.assign({id},cur):x); render(); try{ await chain('t/'+id,()=>db.collection('tasks').doc(id).set(cur)); }catch(e){handleWriteErr(e);} }
async function delTask(id){ if(!needDb()) return; try{ await db.collection('tasks').doc(id).delete(); }catch(e){handleWriteErr(e);} }

/* ================================================================ outreach: AI, follow-ups, connectors */
const DEFAULT_SETTINGS = {
  name: '', about: '', signoff: '', tripCity: '', tripDates: '', tripTag: 'Trip', followDays: 7,
  tone: 'warm, concise, professional — like a peer, never salesy', tagRules: '',
  apiKey: '', model: MODELS[0][0], googleClientId: '',
};
const ME = () => SET().name || 'the sender';
const fillP = d => { const s=SET(); return d.replace(/\{me\}/g, ME()).replace('{tripCity}', s.tripCity||'their city').replace('{tripDates}', s.tripDates||'soon'); };
const PURPOSES = {
  catch:   {l:'Catch-up',       d:'Reconnect after a while: ask how things are going and suggest a quick coffee or call.'},
  london:  {l:'Trip coffee',    d:'{me} will be in {tripCity} {tripDates}; ask for a 30-minute coffee near their office and offer two concrete slots.'},
  congrats:{l:'Congrats',       d:'Congratulate them on their current role or company (only use facts given below) and open a conversation.'},
  intro:   {l:'Ask an intro',   d:'Ask, lightly, whether they could introduce {me} to the right person in their team or network for a relevant conversation. Make it easy to say no.'},
  deal:    {l:'Sector chat',    d:'Open a sector conversation: {me} would value their view on their market, in light of what {me} works on (see About the sender); suggest a 20-minute call. Never mention confidential mandates or client names.'},
  follow:  {l:'Follow-up',      d:'Short, friendly follow-up to an earlier message that got no reply. No guilt, one line of value, same ask.'},
  thanks:  {l:'Thank you',      d:'Thank them for the recent conversation (use the latest journal entry) and confirm the agreed next steps.'},
};
const CADENCES = [[0,'No reminder'],[30,'Monthly'],[90,'Quarterly'],[180,'Every 6 months'],[365,'Yearly']];
const GOALS = {
  priority:{l:'Priority A & B',          fn:c=>(c.pr==='A'||c.pr==='B')&&c.st!=='nr'},
  london:  {l:'Tagged for your trip',    fn:c=>c.t.includes(SET().tripTag||'Trip')&&c.st!=='nr'},
  kit:     {l:'Catch-ups due',           fn:c=>catchupDue(c)},
  investors:{l:'Senior investors',       fn:c=>INVESTOR.has(c.i)&&(SENIOR.has(c.s)||c.s==='Director / Head')&&c.st!=='nr'},
  corp:    {l:'Founders, CEOs & Corp Dev', fn:c=>IND_FAM[c.i]==='corp'&&(c.s==='Founder / Owner'||c.s==='C-Suite & Board'||c.f==='Corp Dev & Strategy')&&c.st!=='nr'},
  cold:    {l:'Untouched decision-makers', fn:c=>SENIOR.has(c.s)&&!c.st},
};
const daysSince = iso => { if(!iso) return 9999; const [y,m,d]=iso.split('-').map(Number); return Math.floor((Date.now()-new Date(y,m-1,d).getTime())/864e5); };
function catchupDue(c){ return c.cad>0 && c.st!=='nr' && daysSince(c.last)>=c.cad; }
function SET(){ return Object.assign({}, DEFAULT_SETTINGS, S.settings||{}); }
function autoLang(c){ return c.g==='France' ? 'fr' : 'en'; }

/* Claude via the Anthropic API (key stored on this device) */
const SAMPLE = makeSample(() => SET());
async function getSample(){ return SET().apiKey ? SAMPLE : null; }
const sampleErr = aiErrorMessage;
const NO_KEY = 'Add your Anthropic API key in Settings to use Claude.';

/* context sent to Claude: only what the book holds */
function personCtx(c, opts={}){
  const notes=S.notes.filter(n=>n.cid===c.id).sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,opts.notes||5);
  const co=COMPANIES.get(c.c); const others=co?co.ids.filter(id=>id!==c.id).map(id=>E(BYID.get(id))):[];
  const lines=[
    `Name: ${c.n}`, `Title: ${c.p||'unknown'}`, `Company: ${c.c}`, `Industry: ${c.i}`, `Location: ${c.g}${c.gc==='assumed'||c.gc==='none'?' (not certain)':''}`,
    `Seniority: ${c.s}`, `LinkedIn connection since: ${c.d||'unknown'}`, `Relationship status: ${ST[c.st||''][1]}`, c.last?`Last contact: ${c.last}`:'Last contact: none logged',
    c.t.length?`Tags: ${c.t.join(', ')}`:'',
    notes.length?'Past interactions (newest first):\n'+notes.map(n=>`- ${n.date} ${n.kind}: ${String(n.text).slice(0,500)}`).join('\n'):'Past interactions: none logged',
  ];
  if(opts.colleagues) lines.push(others.length?`Other people ${ME()} knows at ${c.c} (${others.length}):\n`+others.slice(0,12).map(o=>`- ${o.n}, ${o.p}${o.st?' ['+ST[o.st][1]+']':''}`).join('\n'):`${ME()} knows no one else at ${c.c}.`);
  return lines.filter(Boolean).join('\n');
}
function draftPrompt(c, purpose, channel, lang, extra){
  const s=SET(); const p=PURPOSES[purpose];
  return `You write outreach messages that ${ME()} sends personally, in their own voice.
About the sender: ${s.about||'not provided'}. They sign "${s.signoff||ME()}". Tone: ${s.tone}.

Recipient (facts from the sender's own contact book; use nothing else about them):
${personCtx(c)}

Goal: ${fillP(p.d)}
${extra?`Extra context from the sender: ${extra}`:''}
Channel: ${channel==='email'?'email. First line must be "Subject: ..." then a blank line, then the body (90-150 words).':'LinkedIn message, 50-100 words, no subject line.'}
Language: ${lang==='fr'?'French (vouvoiement unless the past interactions show they use "tu")':'English'}.

Rules: sound like a real person who knows them; reference a shared point only if it is in the facts above; one clear ask; when proposing to meet, offer two concrete options; no flattery clichés, no em dashes, no emojis, no hashtags; do not invent anything about their company, deals or career; never mention confidential mandates. End with "${s.signoff||ME()}".
Reply with the message only.`;
}
function fallbackDraft(c, purpose, channel, lang){
  const s=Object.assign({},SET()); s.signoff=s.signoff||s.name||''; const fn=c.fn||c.n.split(' ')[0];
  const fr=lang==='fr';
  const body={
    catch: fr?`Bonjour ${fn},\n\nJ'espère que tout va bien chez ${c.c}. Cela fait un moment, je serais ravi de prendre un café pour échanger sur vos sujets du moment. Seriez-vous disponible la semaine prochaine ?\n\n${s.signoff}`:`Hi ${fn},\n\nHope all is well at ${c.c}. It's been a while and I'd love to catch up over a coffee. Would you have 30 minutes next week?\n\n${s.signoff}`,
    london: fr?`Bonjour ${fn},\n\nJe serai à ${s.tripCity||'…'} ${s.tripDates} et serais ravi de prendre un café si vous avez 30 minutes. Auriez-vous un créneau près de votre bureau ?\n\n${s.signoff}`:`Hi ${fn},\n\nI'll be in ${s.tripCity||'…'} ${s.tripDates} and would love to grab a coffee if you have 30 minutes. Would a slot near your office work?\n\n${s.signoff}`,
    congrats: fr?`Bonjour ${fn},\n\nFélicitations pour votre rôle chez ${c.c}. Je serais ravi d'échanger rapidement sur vos priorités du moment.\n\n${s.signoff}`:`Hi ${fn},\n\nCongratulations on your role at ${c.c}. I'd be glad to hear what's on your plate at the moment, happy to buy the coffee.\n\n${s.signoff}`,
    intro: fr?`Bonjour ${fn},\n\nPetite question : y aurait-il quelqu'un chez ${c.c} avec qui il serait pertinent d'échanger sur mes sujets ? Aucun souci si ce n'est pas le bon moment.\n\n${s.signoff}`:`Hi ${fn},\n\nQuick one: is there someone at ${c.c} it would make sense for me to speak with? No worries at all if the timing isn't right.\n\n${s.signoff}`,
    deal: fr?`Bonjour ${fn},\n\nVotre regard sur votre marché m'intéresserait beaucoup. Auriez-vous 20 minutes pour un appel ?\n\n${s.signoff}`:`Hi ${fn},\n\nI would really value your view on your market. Would you have 20 minutes for a call?\n\n${s.signoff}`,
    follow: fr?`Bonjour ${fn},\n\nJe me permets de relancer mon message, au cas où il serait passé inaperçu. Toujours partant pour un échange quand cela vous convient.\n\n${s.signoff}`:`Hi ${fn},\n\nJust bumping this in case it got buried. Still keen to connect whenever suits you.\n\n${s.signoff}`,
    thanks: fr?`Bonjour ${fn},\n\nMerci encore pour notre échange. Je reviens vers vous comme convenu.\n\n${s.signoff}`:`Hi ${fn},\n\nThanks again for your time. I'll come back to you on what we discussed.\n\n${s.signoff}`,
  }[purpose];
  return channel==='email' ? `Subject: ${fr?'Café':'Coffee'} · ${s.signoff} / ${fn}\n\n${body}` : body;
}

/* ---------------- draft in the person drawer */
let draftCtl=null;
async function generateDraft(cid){
  const c=E(BYID.get(cid)); const dr=UI.dr; const el=document.getElementById('dr-text');
  const lang=dr.lang==='auto'?autoLang(c):dr.lang; const extra=(document.getElementById('dr-extra')||{}).value||'';
  const sample=await getSample();
  if(!sample){ el.value=fallbackDraft(c,dr.purpose,dr.channel,lang); dr.msg='No Anthropic API key yet (Settings), so this is a template. Edit it before sending.'; render(); return; }
  dr.busy=true; dr.msg=''; render(); draftCtl=new AbortController();
  const box=()=>document.getElementById('dr-text');
  try{
    const {text}=await sample(draftPrompt(c,dr.purpose,dr.channel,lang,extra),{signal:draftCtl.signal,cache:false,onText:({text})=>{ const b=box(); if(b) b.value=text; }});
    const b=box(); if(b) b.value=text.trim();
    if(db) await chain('d/'+cid,()=>db.collection('drafts').doc(cid).set({text:text.trim(),purpose:dr.purpose,channel:dr.channel,createdAt:Date.now()}));
  }catch(e){ dr.msg=sampleErr(e); const b=box(); if(b && e.text) b.value=e.text; }
  dr.busy=false; render();
}
async function saveDraftText(cid, text, purpose, channel){
  if(!db) return; const cur=S.drafts[cid]||{};
  const doc=Object.assign({},cur,{text,purpose:purpose||cur.purpose||'catch',channel:channel||cur.channel||'li',createdAt:cur.createdAt||Date.now()});
  try{ await chain('d/'+cid,()=>db.collection('drafts').doc(cid).set(doc)); }catch(e){ handleWriteErr(e); }
}
async function discardDraft(cid){ if(!db) return; try{ await db.collection('drafts').doc(cid).delete(); }catch(e){ handleWriteErr(e); } }
async function copyText(text){
  try{ await navigator.clipboard.writeText(text); toast('Copied. Paste it in LinkedIn.'); return true; }
  catch(e){ toast('Copy blocked here: select the text and copy it manually'); return false; }
}
async function markSent(cid, text, channel, purpose){
  if(!needDb()) return; if(!text.trim()){ toast('There is no message to log'); return; }
  const c=E(BYID.get(cid)); const s=SET();
  await addNote({text:text.trim(), kind:channel==='email'?'Email':'LinkedIn msg', date:today(), tags:[PURPOSES[purpose]?PURPOSES[purpose].l:'Outreach'], cid, co:c.c});
  for(const t of S.tasks.filter(t=>!t.done&&t.cid===cid&&(t.auto==='fu'||/^reach out|^ask .* coffee/i.test(t.title)))) await setTask(t.id,{done:true,doneAt:Date.now()});
  await addTask({title:`Follow up with ${c.fn||c.n} if no reply`, due:addDays(+s.followDays||7), cid, co:c.c, auto:'fu'});
  if(S.drafts[cid]) await discardDraft(cid);
  toast(`Logged. Follow-up set for ${nice(addDays(+s.followDays||7))}`);
}
async function markReplied(cid){
  await savePerson(cid,{st:'conv', last:today()});
  for(const t of S.tasks.filter(t=>!t.done&&t.cid===cid&&t.auto==='fu')) await setTask(t.id,{done:true,doneAt:Date.now()});
  toast('Marked as in conversation. Pending follow-ups closed.');
}

/* ---------------- debrief: raw notes -> clean entry + to-dos */
async function debrief(k, cid){
  const ta=document.getElementById(k+'-text'); const raw=(ta&&ta.value||'').trim();
  if(!raw){ toast('Paste or type your rough notes first'); return; }
  const sample=await getSample(); if(!sample){ UI['deb_'+k]={msg:NO_KEY}; render(); return; }
  const c=cid?E(BYID.get(cid)):null;
  UI['deb_'+k]={busy:true}; render();
  const prompt=`Turn ${ME()}'s rough meeting notes into a clean journal entry and next steps.
${c?'The person:\n'+personCtx(c,{notes:3})+'\n':''}
Rough notes:
"""${raw.slice(0,12000)}"""

Reply with only JSON: {"note": string, "tags": string[], "todos": [{"title": string, "in_days": number}], "status": "met"|"conv"|"cont"|"warm"}
- note: plain text, under 160 words, lines starting with "- " grouped as: key points, people or companies mentioned, what they need, agreed next steps. Keep names, numbers and dates exactly as written; invent nothing.
- tags: up to 4 short tags (e.g. "Buy-side", "Fundraising", "Intro target").
- todos: concrete follow-ups for ${ME()} only, each starting with a verb, due in 1-30 days.
- status: the relationship status after this conversation.`;
  try{
    const r=await sample.json(prompt,{cache:false});
    if(ta && r && typeof r.note==='string') ta.value=r.note;
    const tg=document.getElementById(k+'-tags'); if(tg && Array.isArray(r.tags)) tg.value=[...new Set([...parseTags(tg.value),...r.tags.map(String)])].join(', ');
    UI['deb_'+k]={todos:(Array.isArray(r.todos)?r.todos:[]).slice(0,6).map(t=>({title:String(t.title||'').slice(0,160), d:Math.min(60,Math.max(1,+t.in_days||7)), on:true})), status:r.status};
  }catch(e){ UI['deb_'+k]={msg:sampleErr(e)}; }
  render();
}

/* ---------------- prep brief */
async function prepBrief(cid){
  const c=E(BYID.get(cid)); const sample=await getSample();
  if(!sample){ UI.prep={cid,text:'',msg:NO_KEY}; render(); return; }
  UI.prep={cid,busy:true,text:''}; render();
  const s=SET(); const tasks=S.tasks.filter(t=>!t.done&&t.cid===cid).map(t=>`- ${t.title} (${t.due||'no date'})`).join('\n');
  const prompt=`Write a one-page meeting prep brief for ${ME()} (${s.about||'no profile given'}) before they meet this person. Use only the facts below; where something is unknown, say what to find out instead of guessing.

${personCtx(c,{notes:8,colleagues:true})}
${tasks?'Open to-dos with them:\n'+tasks:''}

Format (plain text, no markdown symbols except "- " bullets, under 260 words):
WHO THEY ARE — 2 lines
YOUR HISTORY — what has been discussed and promised
OTHERS YOU KNOW THERE — who could matter and why
TALKING POINTS — 4 bullets
QUESTIONS TO ASK — 3 bullets
YOUR ASK — one sentence`;
  const ctl=new AbortController(); UI.prep.ctl=ctl;
  try{ const {text}=await sample(prompt,{signal:ctl.signal,onText:({text})=>{ UI.prep.text=text; const el=document.getElementById('prep-out'); if(el) el.textContent=text; }}); UI.prep={cid,text}; }
  catch(e){ UI.prep={cid,text:e.text||'',msg:sampleErr(e)}; }
  render();
}

/* ---------------- activation plan: pick people, draft all in one call */
function activationPicks(goal, n){
  const fn=GOALS[goal].fn;
  const score=c=>(c.pr==='A'?5:c.pr==='B'?3:0)+(SENIOR.has(c.s)?2:c.s==='Director / Head'?1:0)+(catchupDue(c)?3:0)+(c.st==='reach'?2:0)+(c.f==='Corp Dev & Strategy'||INVESTOR.has(c.i)?1:0)+(c.t.includes(SET().tripTag||'Trip')?1:0)-(S.drafts[c.id]?10:0)-(S.tasks.some(t=>!t.done&&t.cid===c.id&&t.due>today())?3:0);
  return EFF.filter(c=>fn(c)&&c.n).map(c=>[score(c),c]).sort((a,b)=>b[0]-a[0]||a[1].n.localeCompare(b[1].n)).slice(0,n).map(x=>x[1]);
}
async function draftBatch(ids, purpose, channel){
  if(!needDb()) return; const sample=await getSample(); const s=SET();
  const people=ids.map(id=>E(BYID.get(id)));
  if(!sample){ for(const c of people) await saveDraftText(c.id, fallbackDraft(c,purpose,channel,autoLang(c)), purpose, channel); toast(`${people.length} template drafts ready. Add an API key in Settings for Claude-written drafts.`); return; }
  UI.act.busy=true; UI.act.msg=''; render();
  const prompt=`You write outreach messages that ${ME()} sends personally, in their own voice.
About the sender: ${s.about||'not provided'}. They sign "${s.signoff||ME()}". Tone: ${s.tone}.
Goal for every message: ${fillP(PURPOSES[purpose].d)}
Channel: ${channel==='email'?'email; start each message with "Subject: ..." then a blank line; 90-150 words':'LinkedIn message, 50-100 words'}.
Language: French for recipients located in France, English otherwise. Use vouvoiement in French.
Rules: personalise each message from the facts given (title, company, past interactions); one clear ask; when proposing to meet, offer two concrete options; no flattery clichés, no em dashes, no emojis; invent nothing about them; never mention confidential mandates; end with "${s.signoff||ME()}".

Recipients:
${people.map(c=>`### id=${c.id}\n${personCtx(c,{notes:2})}`).join('\n\n')}

Reply with only a JSON array: [{"id": "<id>", "message": "<text>"}], one item per recipient, same ids.`;
  try{
    const out=await sample.json(prompt,{cache:false,modelTier:'default'});
    let k=0; for(const r of (Array.isArray(out)?out:[])){ if(r&&BYID.has(r.id)&&typeof r.message==='string'){ await saveDraftText(r.id, r.message.trim(), purpose, channel); k++; } }
    toast(`${k} drafts ready to review`);
  }catch(e){ UI.act.msg=sampleErr(e); }
  UI.act.busy=false; UI.act.sel=new Set(); render();
}

/* ---------------- Gmail & Calendar (Google APIs, or pre-filled links) */
function splitSubject(text){ let subject='', body=text.trim(); const m=body.match(/^subject:\s*(.+)\n+/i); if(m){ subject=m[1].trim(); body=body.slice(m[0].length); } return {subject, body}; }
async function gmailDraft(cid, text){
  const c=E(BYID.get(cid)); const email=(c.e||'').trim();
  if(!email){ toast('Add their email address first'); return; }
  const {subject, body}=splitSubject(text);
  UI.dr.gm='Creating Gmail draft…'; render();
  try{ const r=await G.createGmailDraft({to:email, subject, body}); UI.dr.gm=''; UI.dr.gmUrl=r.viewUrl; toast('Draft saved in Gmail'); }
  catch(e){ UI.dr.gm=e.message; }
  render();
}
function eventArgs(c){
  const g=id=>(document.getElementById(id)||{}).value||'';
  const date=g('ev-date'), time=g('ev-time'), dur=+g('ev-dur')||45, place=g('ev-place'), tz=g('ev-tz'), invite=(document.getElementById('ev-inv')||{}).checked;
  if(!date||!time) return null;
  const [h,mi]=time.split(':').map(Number); const st=new Date(2000,0,1,h,mi); const en=new Date(st.getTime()+dur*6e4);
  const pad=n=>String(n).padStart(2,'0');
  return { summary:g('ev-title')||`Coffee: ${c.n} / ${SET().name||'me'}`, description:`${c.n}, ${c.p} at ${c.c}\nLinkedIn: https://www.linkedin.com/in/${c.u}`,
    location:place, date, start:time, end:`${pad(en.getHours())}:${pad(en.getMinutes())}`,
    timeZone: tz==='london'?'Europe/London':(Intl.DateTimeFormat().resolvedOptions().timeZone||'Europe/Paris'), attendeeEmail: invite&&c.e?c.e:'', tzLabel: tz==='london'?' London time':'' };
}
async function afterMeetingBooked(c, a){
  await savePerson(c.id,{st:'conv'});
  await addTask({title:`Meeting with ${c.fn||c.n}: prep and log notes after`, due:a.date, cid:c.id, co:c.c, auto:'mtg'});
}
async function calendarEvent(cid){
  const c=E(BYID.get(cid)); const a=eventArgs(c); if(!a){ toast('Pick a date and a time'); return; }
  UI.ev={busy:true,open:true}; render();
  try{ const r=await G.createCalendarEvent(a); UI.ev={open:true, done:`Added to your calendar for ${nice(a.date)} at ${a.start}${a.tzLabel}.`, link:r.htmlLink}; await afterMeetingBooked(c,a); }
  catch(e){ UI.ev={open:true, msg:e.message}; }
  render();
}

/* ================================================================ tenure, re-import, activation view */
function tenure(since){
  if(!since) return ''; const [y,m]=since.split('-').map(Number); if(!y||!m) return '';
  const now=new Date(); const months=(now.getFullYear()-y)*12+(now.getMonth()+1-m); if(months<0) return '';
  const yy=Math.floor(months/12), mm=months%12;
  if(!yy) return mm<=1?'under 2 months':mm+' months';
  return yy+' yr'+(yy>1?'s':'')+(mm?' '+mm+' mo'+(mm>1?'s':''):'');
}
const monthName = ym => { if(!ym) return ''; const [y,m]=ym.split('-').map(Number); return new Date(y,m-1,1).toLocaleDateString('en-GB',{month:'short',year:'numeric'}); };

async function importCsv(file){
  if(!needDb()) return;
  UI.imp={busy:true,msg:'Reading the file…'}; render();
  let parsed; try{ parsed=readConnections(await file.text()); }catch(e){ UI.imp={msg:'Could not read that file. Use the Connections.csv from LinkedIn.'}; render(); return; }
  if(parsed.error){ UI.imp={msg:parsed.error}; render(); return; }
  const runDate=today();
  const first=!BASE0.length;
  const bySlug=new Map(BASE.map(c=>[c.u,c]));
  const fresh=[], moves=[], titles=[], seen=new Set(BASE.map(c=>c.id));
  for(const r of parsed.rows){
    const ex=r.slug?bySlug.get(r.slug):null;
    if(!ex){ const rec=classify(r); let id=rec.id, k=2; while(seen.has(id)) id=rec.id+'-'+(k++); seen.add(id); rec.id=id; if(!first) rec.t=['New connection']; fresh.push(rec); continue; }
    const e=E(ex); const o=S.people[ex.id]||{}; const oldRaw=o.craw||ex.cr||ex.c;
    if(r.company && norm(r.company)!==norm(oldRaw) && norm(r.company)!==norm(e.c)) moves.push({id:ex.id,e,row:r});
    else if(r.pos && norm(r.pos)!==norm(e.p)) titles.push({id:ex.id,e,row:r});
  }
  UI.imp={busy:true,msg:first?`Classifying and saving ${fmt(fresh.length)} connections…`:`Saving ${fresh.length} new connections, ${moves.length} job changes, ${titles.length} new titles…`}; render();
  const ym=runDate.slice(0,7); let n=0;
  try{
    if(fresh.length) await db.collection('contacts').putMany(fresh.map(r=>{ const {id,...rest}=r; return [id, Object.assign(rest,{addedAt:runDate})]; }));
    for(const m of moves){
      const k=classify(m.row); const cur=Object.assign({},S.people[m.id]||{});
      Object.assign(cur,{c:k.c, craw:m.row.company, p:m.row.pos||m.e.p, prevC:m.e.c, prevP:m.e.p, chg:runDate, since:ym, sinceApprox:true,
        i:k.i, g:k.g, s:k.s, f:k.f, tags:[...new Set([...(m.e.t||[]),'Job change'])], u:Date.now()});
      await chain('p/'+m.id,()=>db.collection('people').doc(m.id).set(cur)); S.people[m.id]=cur;
      if(n<100){ await db.collection('tasks').add({title:`Congratulate ${m.e.fn||m.e.n} on the move to ${m.row.company}`, due:addDays(2+Math.floor(n/8)), cid:m.id, co:m.row.company, auto:'jc', done:false, createdAt:Date.now()}); n++; }
    }
    for(const t of titles){
      const s2=senOf(t.row.pos); const cur=Object.assign({},S.people[t.id]||{}); Object.assign(cur,{p:t.row.pos, prevP:t.e.p, chg:runDate, s:s2, f:jobFunction(t.row.pos,t.e.i,s2), tags:[...new Set([...(t.e.t||[]),'New title'])], u:Date.now()});
      await chain('p/'+t.id,()=>db.collection('people').doc(t.id).set(cur)); S.people[t.id]=cur;
    }
    const prev=(S.imports&&S.imports.runs)||[];
    await db.collection('meta').doc('imports').set({last:runDate, runs:[...prev,{date:runDate,fresh:fresh.length,moves:moves.length,titles:titles.length}].slice(-24)});
    const pl=(n,w)=>fmt(n)+' '+w+(n===1?'':'s');
    UI.imp={msg:first?`Done: ${pl(fresh.length,'connection')} imported and classified.`:`Done: ${pl(fresh.length,'new connection')}, ${pl(moves.length,'job change')} (each with a congratulate to-do), ${pl(titles.length,'title change')}.`, done:true};
    if(first){ location.hash='#home'; setView('home'); toast('Your network is ready'); }
  }catch(e){ handleWriteErr(e); UI.imp={msg:'The import stopped part-way. Run it again with the same file: what was saved is skipped.'}; }
  render();
}

/* ---------------- Activate view */
function vActivate(){
  const A=UI.act; const s=SET();
  if(!A.goal || (!A.touched && !activationPicks(A.goal,1).length)) A.goal=['priority','kit','london','investors','cold'].find(g=>activationPicks(g,1).length)||'cold';
  const drafts=Object.entries(S.drafts).map(([id,d])=>[BYID.get(id)?E(BYID.get(id)):null,d]).filter(x=>x[0]).sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0));
  const picks=activationPicks(A.goal, A.n); const chosen=picks.filter(c=>!A.off.has(c.id));
  const kit=EFF.filter(catchupDue).length; const fu=S.tasks.filter(t=>!t.done&&t.auto==='fu'&&t.due&&t.due<=today()).length;
  const sent7=S.notes.filter(n=>(n.kind==='LinkedIn msg'||n.kind==='Email')&&daysSince(n.date)<=7).length;
  const jc=EFF.filter(c=>c.chg).length;
  const imp=S.imports&&S.imports.last;
  return `${banner()}<div class="head"><div><h1>Activate</h1><div class="sub">Pick who to contact this week. Claude drafts every message from what your book knows, you edit, send it on LinkedIn, and log it in one click. Follow-ups schedule themselves. Nothing is ever sent for you.</div></div></div>
  <div class="kpis" style="grid-template-columns:repeat(5,minmax(0,1fr))">
    <div class="kpi"><span class="v">${drafts.length}</span><span class="l">Drafts to review</span></div>
    <div class="kpi click ${fu?'warn':''}" data-preset="due"><span class="v">${fu}</span><span class="l">Follow-ups due</span></div>
    <div class="kpi click ${kit?'warn':''}" data-preset="kit"><span class="v">${kit}</span><span class="l">Catch-ups due</span></div>
    <div class="kpi click" data-preset="jc"><span class="v">${jc}</span><span class="l">Job changes spotted</span></div>
    <div class="kpi"><span class="v">${sent7}</span><span class="l">Messages sent, last 7 days</span></div>
  </div>
  <section class="card pad" style="margin-bottom:18px"><h2>Step 1 · This week's list</h2>
    <div class="toolbar">
      <label class="hint" for="agoal">From</label><select class="inp" id="agoal">${Object.entries(GOALS).map(([k,g])=>`<option value="${k}" ${A.goal===k?'selected':''}>${g.l}</option>`).join('')}</select>
      <label class="hint" for="an">How many</label><select class="inp" id="an">${[5,10,15,20].map(n=>`<option ${A.n===n?'selected':''}>${n}</option>`).join('')}</select>
      <label class="hint" for="apur">Message</label><select class="inp" id="apur">${Object.entries(PURPOSES).map(([k,p])=>`<option value="${k}" ${A.purpose===k?'selected':''}>${p.l}</option>`).join('')}</select>
      <select class="inp" id="ach" aria-label="Channel"><option value="li" ${A.channel==='li'?'selected':''}>LinkedIn</option><option value="email" ${A.channel==='email'?'selected':''}>Email</option></select>
    </div>
    <div class="hint" style="margin-bottom:8px">Ranked by priority, seniority, catch-up reminders and pending outreach. People with a draft or a to-do already planned drop down the list.</div>
    ${picks.length?`<div class="card">${picks.map(c=>`<label class="prow" style="grid-template-columns:28px minmax(0,1fr) minmax(0,1fr) 116px;cursor:pointer"><input type="checkbox" class="ck" data-aoff="${c.id}" ${A.off.has(c.id)?'':'checked'}><span class="who"><b>${c.pr?`<span class="prio ${c.pr}" style="margin-right:6px">${c.pr}</span>`:''}${esc(c.n)}</b><span>${esc(c.p)}</span></span><span class="cl">${esc(c.c)} · ${esc(c.g)}</span><span><span class="st ${ST[c.st||''][2]}">${ST[c.st||''][1]}</span></span></label>`).join('')}</div>`:`<div class="empty"><b>No one in this list right now</b>Pick another source above.</div>`}
    <div class="r" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px">
      <button class="btn pri" data-act="adraft" ${A.busy||!chosen.length?'disabled':''}>${A.busy?'Claude is drafting '+chosen.length+' messages…':'Draft '+chosen.length+' messages with Claude'}</button>
      <span class="hint">${A.msg?esc(A.msg):(SET().apiKey?'One request for the whole batch on your Anthropic key (typically a few cents). Takes 30 to 90 seconds.':'No API key yet: drafts will be templates. Add a key in Settings.')}</span></div>
  </section>
  <section style="margin-bottom:18px"><h2>Step 2 · Review, send, log (${drafts.length})</h2>
    ${drafts.length?`<div class="dq">${drafts.map(([c,d])=>`<div class="card pad dqc">
      <div class="dqh"><button class="colink" data-pid="${c.id}" style="display:inline">${esc(c.n)}</button><span class="hint">${esc(c.p)} · ${esc(c.c)}</span><span class="chip">${esc((PURPOSES[d.purpose]||{}).l||'Message')} · ${d.channel==='email'?'Email':'LinkedIn'}</span></div>
      <textarea class="inp" id="dq-${c.id}" data-dqid="${c.id}" aria-label="Message to ${esc(c.n)}" style="min-height:150px">${esc(d.text)}</textarea>
      <div class="dqa"><button class="btn sm" data-qcopy="${c.id}">Copy</button>${c.u?`<a class="btn sm" href="https://www.linkedin.com/in/${esc(c.u)}" target="_blank" rel="noopener">Open LinkedIn ↗</a>`:''}<span style="flex:1"></span><button class="btn sm ghost" data-qdiscard="${c.id}">Discard</button><button class="btn sm pri" data-qsent="${c.id}">Mark as sent</button></div></div>`).join('')}</div>`
    :`<div class="card"><div class="empty"><b>No drafts waiting</b>Build a list in step 1, or open anyone's record and use “Draft with Claude”.</div></div>`}
  </section>
  <div class="hint">Your name, bio, sign-off, trip details, API key and Google connection live in <a href="#settings">Settings</a>.</div>`;
}

/* ---------------------------------------------------------------- filtering */
const PRESETS = {
  dm:   {name:'Decision-makers', desc:'Founders, C-suite, partners & MDs', fn:c=>SENIOR.has(c.s)},
  inv:  {name:'Senior investors', desc:'PE, VC, credit & AM — director and above', fn:c=>INVESTOR.has(c.i) && (SENIOR.has(c.s)||c.s==='Director / Head')},
  cd:   {name:'Corp Dev & strategy', desc:'Inside companies, the people who buy', fn:c=>c.f==='Corp Dev & Strategy'},
  ceo:  {name:'Founders & CEOs at companies', desc:'Operating-company leaders', fn:c=>IND_FAM[c.i]==='corp' && (c.s==='Founder / Owner'||/\bceo\b|chief executive|directeur général|président/i.test(c.p))},
  hh:   {name:'Headhunters', desc:'Executive search & recruiters', fn:c=>c.i==='Executive Search'},
  uk:   {name:'United Kingdom', desc:'Based in the UK', fn:c=>c.g==='United Kingdom'},
  lin:  {name:'Connected this year', desc:'Added in the last 12 months', fn:c=>daysSince(c.d)<=365},
  cold: {name:'Untouched decision-makers', desc:'Senior, never contacted', fn:c=>SENIOR.has(c.s) && !c.st},
  pipe: {name:'Active pipeline', desc:'To reach out or in conversation', fn:c=>['reach','cont','conv'].includes(c.st)},
  due:  {name:'Follow-up due', desc:'Open task due today or earlier', fn:c=>S.tasks.some(t=>!t.done&&t.cid===c.id&&t.due&&t.due<=today())},
  kit:  {name:'Catch-up due', desc:'Keep-in-touch reminder has come round', fn:c=>catchupDue(c)},
  drafts:{name:'Drafts ready', desc:'Messages waiting to be sent', fn:c=>!!S.drafts[c.id]},
  jc:   {name:'Job changes', desc:'New company or title since an import', fn:c=>!!c.chg},
};
const FKEYS = {i:'i',g:'g',s:'s',f:'f',st:'st',pr:'pr',y:'y'};
function matches(c, skip){
  const f=UI.f;
  for(const k of ['i','g','s','f','st','pr','y']){ if(k===skip) continue; const set=f[k]; if(set.size && !set.has(c[FKEYS[k]]||'')) return false; }
  if(skip!=='tg' && f.tg.size){ let ok=false; for(const t of f.tg) if(c.t.includes(t)){ok=true;break;} if(!ok) return false; }
  if(UI.preset && !PRESETS[UI.preset].fn(c)) return false;
  if(UI.q){ const words=norm(UI.q).split(/\s+/).filter(Boolean); for(const w of words) if(!c._s.includes(w) && !(c.t||[]).some(t=>norm(t).includes(w))) return false; }
  return true;
}
let EFF = [];
function computeEff(){
  EFF = BASE.map(E); COMPANIES = new Map();
  for(const c of EFF){ if(!COMPANIES.has(c.c)) COMPANIES.set(c.c,{name:c.c,ids:[]}); COMPANIES.get(c.c).ids.push(c.id); }
}
function filtered(){ return EFF.filter(c=>matches(c)); }
function sortList(list){
  const so=UI.sort; const sr=Object.fromEntries(SENS.map((s,i)=>[s,i]));
  const by = {
    name:(a,b)=>a.n.localeCompare(b.n),
    company:(a,b)=>a.c.localeCompare(b.c)||a.n.localeCompare(b.n),
    seniority:(a,b)=>(sr[a.s]-sr[b.s])||a.n.localeCompare(b.n),
    recent:(a,b)=>(b.d||'').localeCompare(a.d||''),
    touch:(a,b)=>(b.last||'').localeCompare(a.last||'')||((a.pr||'z').localeCompare(b.pr||'z')),
  }[so];
  return list.sort(by);
}
function allTags(){ const s=new Set(DEFAULT_TAGS); for(const c of EFF) for(const t of c.t) s.add(t); for(const n of S.notes) for(const t of (n.tags||[])) s.add(t); return [...s]; }

/* ---------------------------------------------------------------- render: shell */
function setView(v){ UI.view=v; document.querySelectorAll('#nav a').forEach(a=>a.classList.toggle('on',a.dataset.v===v)); render(); window.scrollTo(0,0); }
window.addEventListener('hashchange',()=>{ const v=(location.hash||'#home').slice(1); if(['home','activate','people','companies','tasks','journal','settings'].includes(v)) setView(v); });
let raf=0; function render(){ if(raf) return; raf=requestAnimationFrame(()=>{ raf=0; draw(); }); }
function draw(){
  if(!BASE.length && UI.view!=='settings'){ const m=$('#main'); m.dataset.view='welcome'; const vk=String(!!VAULT); if(!m.querySelector('#welcome')||m.dataset.vault!==vk){ m.innerHTML=vWelcome(); m.dataset.vault=vk; } else { const st=$('#wmsg'); if(st) st.innerHTML=welcomeMsg(); } drawDrawer(); return; }
  computeEff();
  const open=S.tasks.filter(t=>!t.done); const dueN=open.filter(t=>t.due&&t.due<=today()).length;
  $('#nc-people').textContent=fmt(BASE.length); $('#nc-co').textContent=fmt(COMPANIES.size);
  const nt=$('#nc-tasks'); nt.textContent=dueN?dueN+' due':(open.length||''); nt.classList.toggle('hot',dueN>0);
  $('#nc-notes').textContent=S.notes.length||'';
  const nd=Object.keys(S.drafts).length; $('#nc-act').textContent=nd?nd+' drafts':'';
  const m=$('#main'); const keep=document.activeElement && document.activeElement.id ? {id:document.activeElement.id, s:document.activeElement.selectionStart} : null;
  const keepV={}; m.querySelectorAll('input[id]:not([type=checkbox]):not([type=search]),textarea[id]').forEach(el=>{ keepV[el.id]=el.value; });
  const sameView = m.dataset.view===UI.view; m.dataset.view=UI.view;
  m.innerHTML = ({home:vHome, settings:vSettings, welcome:vWelcome, activate:vActivate, people:vPeople, companies:vCompanies, tasks:vTasks, journal:vJournal}[UI.view])();
  if(sameView) Object.entries(keepV).forEach(([k,v])=>{ const el=document.getElementById(k); if(el && m.contains(el)) el.value=v; });
  if(keep){ const el=document.getElementById(keep.id); if(el && m.contains(el)){ el.focus(); try{ if(keep.s!=null) el.setSelectionRange(keep.s,keep.s);}catch(e){} } }
  drawDrawer();
}
const banner = () => db ? '' : (dbState==='off' ? `<div class="banner">This browser is blocking local storage, so nothing can be saved. Private windows and some privacy settings do this: open the app in a normal window.</div>` : '');

/* ---------------------------------------------------------------- view: home */
function vHome(){
  const all=EFF; const open=S.tasks.filter(t=>!t.done);
  const due=open.filter(t=>t.due&&t.due<=today()).sort((a,b)=>a.due.localeCompare(b.due));
  const week=open.filter(t=>t.due&&t.due>today()&&t.due<=addDays(7));
  const touched=all.filter(c=>c.st&&c.st!=='nr').length;
  const sen=all.filter(c=>SENIOR.has(c.s)).length;
  const tab=UI.homeTab;
  const dim = {i:['i',INDS,'Industry'], g:['g',GEOS,'Geography'], s:['s',SENS,'Seniority'], f:['f',FUNS,'Function']}[tab];
  const counts={}; for(const c of all) counts[c[dim[0]]]=(counts[c[dim[0]]]||0)+1;
  const rows=dim[1].filter(k=>counts[k]).sort((a,b)=>tab==='s'||tab==='g'?0:counts[b]-counts[a]);
  const max=Math.max(...rows.map(k=>counts[k]));
  const yrs={}; for(const c of all) if(c.y) yrs[c.y]=(yrs[c.y]||0)+1; const ys=Object.keys(yrs).sort(); const ymax=Math.max(...ys.map(y=>yrs[y]));
  const topCo=[...COMPANIES.values()].filter(c=>c.name!=='Independent / undisclosed').sort((a,b)=>b.ids.length-a.ids.length).slice(0,12);
  const recent=[...S.notes].sort((a,b)=>(b.date||'').localeCompare(a.date||'')||b.createdAt-a.createdAt).slice(0,4);
  const unknownGeo=all.filter(c=>c.g==='Unknown').length;
  return `${banner()}
  <div class="head"><div><h1>Your network, organised</h1><div class="sub">Every LinkedIn connection tagged by industry, geography, seniority and function. Open anyone to log a conversation or set a follow-up.</div></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="newtask">+ To-do</button><button class="btn pri" data-act="newnote">+ Log a conversation</button></div></div>
  <div class="kpis">
    <div class="kpi click" data-go="people"><span class="v">${fmt(all.length)}</span><span class="l">Connections</span></div>
    <div class="kpi click" data-go="companies"><span class="v">${fmt(COMPANIES.size)}</span><span class="l">Companies</span></div>
    <div class="kpi click" data-preset="dm"><span class="v">${fmt(sen)}</span><span class="l">Decision-makers</span></div>
    <div class="kpi click" data-preset="pipe"><span class="v">${fmt(touched)}</span><span class="l">In your pipeline</span></div>
    <div class="kpi click ${due.length?'warn':''}" data-go="tasks"><span class="v">${due.length}</span><span class="l">${due.length?'To-dos due now':'To-dos due · '+week.length+' this week'}</span></div>
  </div>
  <div class="grid2">
    <div class="stack">
      <section class="card pad">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">Network map</h2>
        <div class="tabs" role="tablist">${[['i','Industry'],['g','Geography'],['s','Seniority'],['f','Function']].map(([k,l])=>`<button role="tab" aria-selected="${k===tab}" class="${k===tab?'on':''}" data-htab="${k}">${l}</button>`).join('')}</div></div>
        <div class="bars">${rows.map(k=>`<div class="bar" data-fk="${dim[0]}" data-fv="${esc(k)}" title="Show ${esc(k)}"><span class="lab">${tab==='i'?famDot(k):''}${esc(k)}</span><span class="trk"><span class="fill" style="width:${(counts[k]/max*100).toFixed(1)}%;${tab==='i'?`background:var(--fam-${IND_FAM[k]})`:''}"></span></span><span class="n">${fmt(counts[k])}</span></div>`).join('')}</div>
        ${tab==='i'?`<div class="legend">${Object.entries(FAM_NAME).map(([k,v])=>`<span><i class="fam" style="background:var(--fam-${k})"></i>${v}</span>`).join('')}</div>`:''}
        ${tab==='g'?`<div class="hint" style="margin-top:8px">Geography comes from the job title or the company's base. ${fmt(unknownGeo)} people at global firms (banks, Big 4, big tech) are marked Unknown until you set them. Open a company to set everyone at once.</div>`:''}
      </section>
      <section class="card pad"><h2>Smart lists</h2>
        <div class="lists">${Object.entries(PRESETS).map(([k,p])=>`<button class="preset" data-preset="${k}"><b>${p.name}</b><span>${p.desc}</span><span class="c">${fmt(all.filter(p.fn).length)} people</span></button>`).join('')}</div>
      </section>
    </div>
    <div class="stack">
      ${(()=>{ const nd=Object.keys(S.drafts).length, kit=EFF.filter(catchupDue).length, jc=EFF.filter(c=>c.chg).length;
        return `<section class="card pad" style="border-color:var(--accent)"><h2 style="display:flex;justify-content:space-between">This week <a href="#activate" style="font-size:12px;text-transform:none;letter-spacing:0">Open Activate</a></h2>
        <div class="sub" style="margin:0 0 10px">${nd?`<b>${nd}</b> draft${nd>1?'s':''} ready to send. `:''}${kit?`<b>${kit}</b> catch-up${kit>1?'s':''} due. `:''}${jc?`<b>${jc}</b> job change${jc>1?'s':''} to congratulate. `:''}${!nd&&!kit&&!jc?'Build this week\'s outreach list and let Claude draft the messages.':''}</div>
        <a class="btn pri sm" href="#activate">Plan this week's outreach</a></section>`; })()}
      <section class="card pad"><h2 style="display:flex;justify-content:space-between">Today <a href="#tasks" style="font-size:12px;text-transform:none;letter-spacing:0">All to-dos</a></h2>
        ${due.length||week.length ? `<div>${[...due,...week].slice(0,6).map(taskRow).join('')}</div>` : `<div class="empty"><b>Nothing due</b>Add a to-do from anyone's record, or bulk-create outreach tasks from a smart list.</div>`}
      </section>
      <section class="card pad"><h2 style="display:flex;justify-content:space-between">Latest in the journal <a href="#journal" style="font-size:12px;text-transform:none;letter-spacing:0">Open journal</a></h2>
        ${recent.length? recent.map(noteRow).join('') : `<div class="empty"><b>No conversations logged yet</b>Use “Log a conversation” after a coffee or call. The person's status and last-contact date update for you.</div>`}
      </section>
      <section class="card pad"><h2>Largest companies in your network</h2>
        <div class="bars">${topCo.map(c=>`<div class="bar" data-co="${esc(c.name)}"><span class="lab">${famDot(BYID.get(c.ids[0]).i)}${esc(c.name)}</span><span class="trk"><span class="fill" style="width:${(c.ids.length/topCo[0].ids.length*100).toFixed(1)}%;background:var(--line-strong)"></span></span><span class="n">${c.ids.length}</span></div>`).join('')}</div>
      </section>
      <section class="card pad"><h2>Connections added per year</h2>
        <div class="years">${ys.map(y=>`<div class="yr" data-fk="y" data-fv="${y}" title="${yrs[y]} connections in ${y}"><span class="yv">${yrs[y]}</span><div class="col" style="height:${Math.max(4,yrs[y]/ymax*80)}px"></div><small>${y.slice(2)}</small></div>`).join('')}</div>
      </section>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- view: people */
function facetBlock(key, label, options, counts, max=8){
  const set=UI.f[key]; const showAll=UI.moreF[key];
  const opts=options.filter(o=>counts[o]||set.has(o));
  const list=showAll?opts:opts.slice(0,max);
  return `<div class="facet"><h3>${label}${set.size?`<button data-fclear="${key}">Clear</button>`:''}</h3>
    ${list.map(o=>`<label class="fo ${counts[o]?'':'zero'}"><input type="checkbox" class="ck" data-fk="${key}" data-fv="${esc(o)}" ${set.has(o)?'checked':''}><span class="t">${key==='i'?famDot(o):''}${esc(key==='st'?ST[o][1]:key==='pr'?(o?'Priority '+o:'No priority'):o)}</span><span class="n">${fmt(counts[o]||0)}</span></label>`).join('')}
    ${opts.length>max?`<button class="fmore" data-fmore="${key}">${showAll?'Show less':'Show all '+opts.length}</button>`:''}</div>`;
}
function vPeople(){
  const list=sortList(filtered());
  const cnt=(key,field)=>{ const m={}; for(const c of EFF) if(matches(c,key)){ const v=c[field]||''; m[v]=(m[v]||0)+1; } return m; };
  const tgc={}; for(const c of EFF) if(matches(c,'tg')) for(const t of c.t) tgc[t]=(tgc[t]||0)+1;
  const years=[...new Set(BASE.map(c=>c.y).filter(Boolean))].sort().reverse();
  const tags=Object.keys(tgc).sort((a,b)=>tgc[b]-tgc[a]);
  const actives=[];
  for(const k of Object.keys(UI.f)) for(const v of UI.f[k]) actives.push([k,v]);
  const page=list.slice(0,UI.shown);
  const selN=UI.sel.size;
  return `${banner()}
  <div class="head"><div><h1>People</h1><div class="sub"><span class="mono">${fmt(list.length)}</span> of ${fmt(BASE.length)} connections${UI.preset?` · smart list <b>${PRESETS[UI.preset].name}</b>`:''}</div></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn mfilter" data-act="facets">Filters${actives.length?' ('+actives.length+')':''}</button><button class="btn" data-act="export">Export CSV</button><button class="btn" data-act="selall">Select all ${fmt(Math.min(list.length,500))}</button></div></div>
  <div class="ppl">
    <aside class="facets ${UI.facetOpen?'open':''}" aria-label="Filters">
      <div class="facet"><h3>Smart list${UI.preset?`<button data-act="nopreset">Clear</button>`:''}</h3>
        <select class="inp" id="presetSel" style="width:100%"><option value="">All connections</option>${Object.entries(PRESETS).map(([k,p])=>`<option value="${k}" ${UI.preset===k?'selected':''}>${p.name}</option>`).join('')}</select></div>
      ${facetBlock('st','Status',STATUSES.map(s=>s[0]),cnt('st','st'),7)}
      ${facetBlock('i','Industry',INDS,cnt('i','i'),8)}
      ${facetBlock('g','Geography',GEOS,cnt('g','g'),9)}
      ${facetBlock('s','Seniority',SENS,cnt('s','s'),9)}
      ${facetBlock('f','Function',FUNS,cnt('f','f'),6)}
      ${facetBlock('tg','Tags',tags,tgc,8)}
      ${facetBlock('pr','Priority',['A','B','C',''],cnt('pr','pr'),4)}
      ${facetBlock('y','Connected in',years,cnt('y','y'),6)}
    </aside>
    <section style="min-width:0">
      <div class="toolbar"><input class="inp q" id="pq" type="search" placeholder="Search name, title, company or tag" value="${esc(UI.q)}" aria-label="Search people">
        <select class="inp" id="psort" aria-label="Sort"><option value="name">Sort: name</option><option value="company">Company</option><option value="seniority">Seniority</option><option value="recent">Recently connected</option><option value="touch">Last contact</option></select></div>
      ${actives.length?`<div class="activef">${actives.map(([k,v])=>`<span class="chip" data-rm="${k}" data-rv="${esc(v)}">${esc(k==='st'?ST[v][1]:k==='pr'?(v?'Priority '+v:'No priority'):v)} ✕</span>`).join('')}<span class="chip" data-act="clearall" style="background:transparent;color:var(--accent)">Clear all</span></div>`:''}
      ${selN?bulkBar(selN):''}
      <div class="card"><div class="rowlist">
        <div class="prow hdr"><span></span><span>Name</span><span class="c-pos">Position</span><span class="c-co">Company</span><span class="c-ind">Industry</span><span>Status</span></div>
        ${page.length?page.map(personRow).join(''):`<div class="empty"><b>No one matches these filters</b>Remove a filter or clear the search.</div>`}
      </div>${list.length>UI.shown?`<div class="more"><button class="btn" data-act="more">Show ${Math.min(200,list.length-UI.shown)} more · ${fmt(list.length-UI.shown)} left</button></div>`:''}</div>
    </section>
  </div>`;
}
function personRow(c){
  const s=ST[c.st||''];
  return `<div class="prow" data-pid="${c.id}" tabindex="0" role="button" aria-label="Open ${esc(c.n)}"><input type="checkbox" class="ck" data-sel="${c.id}" ${UI.sel.has(c.id)?'checked':''} aria-label="Select ${esc(c.n)}">
    <span class="who"><b>${c.pr?`<span class="prio ${c.pr}" style="margin-right:6px">${c.pr}</span>`:''}${esc(c.n)}</b><span>${esc(c.s)} · ${esc(c.g)}${c.gc==='assumed'?'<span class="geoq" title="Assumed from company">?</span>':''}</span></span>
    <span class="pos c-pos">${esc(c.p)||'<span class="hint">No title</span>'}</span>
    <span class="c-co" style="min-width:0"><button class="colink" data-co="${esc(c.c)}">${esc(c.c)}</button></span>
    <span class="c-ind" style="min-width:0"><span class="chip">${famDot(c.i)}${esc(c.i)}</span></span>
    <span><span class="st ${s[2]}">${s[1]}</span></span></div>`;
}
function bulkBar(n){
  return `<div class="bulk"><b>${fmt(n)} selected</b>
    <select class="inp" id="bkSt" aria-label="Set status"><option value="">Set status…</option>${STATUSES.map(s=>`<option value="${s[0]||'_none'}">${s[1]}</option>`).join('')}</select>
    <select class="inp" id="bkPr" aria-label="Set priority"><option value="">Set priority…</option><option>A</option><option>B</option><option>C</option><option value="_none">None</option></select>
    <input class="inp" id="bkTag" list="taglist" placeholder="Add tag" style="width:140px"><button class="btn sm" data-act="bktag">Tag</button>
    <button class="btn sm" data-act="bktask">Create outreach to-dos</button>
    <button class="btn sm ghost" data-act="selnone" style="color:inherit">Clear selection</button>
    <datalist id="taglist">${allTags().map(t=>`<option value="${esc(t)}">`).join('')}</datalist></div>`;
}

/* ---------------------------------------------------------------- view: companies */
function coStats(co){
  const ppl=co.ids.map(id=>E(BYID.get(id)));
  const ic={}, gc={}; let sen=0, touched=0;
  for(const p of ppl){ ic[p.i]=(ic[p.i]||0)+1; gc[p.g]=(gc[p.g]||0)+1; if(SENIOR.has(p.s)) sen++; if(p.st) touched++; }
  const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1])[0][0];
  return {ppl, ind:top(ic), geo:top(gc), sen, touched, n:ppl.length};
}
function vCompanies(){
  const q=norm(UI.coQ);
  let cos=[...COMPANIES.values()].filter(c=>!q || norm(c.name).includes(q));
  let rows=cos.map(c=>Object.assign({name:c.name}, coStats(c)));
  if(UI.coInd) rows=rows.filter(r=>r.ind===UI.coInd);
  rows.sort(UI.coSort==='name'?(a,b)=>a.name.localeCompare(b.name):UI.coSort==='senior'?(a,b)=>b.sen-a.sen||b.n-a.n:(a,b)=>b.n-a.n||a.name.localeCompare(b.name));
  const page=rows.slice(0,UI.coShown);
  return `${banner()}<div class="head"><div><h1>Companies</h1><div class="sub"><span class="mono">${fmt(rows.length)}</span> companies. Click one to see everyone you know there.</div></div></div>
  <div class="toolbar"><input class="inp q" id="cq" type="search" placeholder="Search companies" value="${esc(UI.coQ)}" aria-label="Search companies">
    <select class="inp" id="cind" aria-label="Industry"><option value="">All industries</option>${INDS.map(i=>`<option ${UI.coInd===i?'selected':''}>${esc(i)}</option>`).join('')}</select>
    <select class="inp" id="csort" aria-label="Sort"><option value="count" ${UI.coSort==='count'?'selected':''}>Most contacts</option><option value="senior" ${UI.coSort==='senior'?'selected':''}>Most decision-makers</option><option value="name" ${UI.coSort==='name'?'selected':''}>A–Z</option></select></div>
  <div class="card"><div class="crow hdr"><span>Company</span><span class="c-ind">Main industry</span><span class="c-geo">Base</span><span>People</span><span class="c-sen">Senior</span><span>Contacted</span></div>
  ${page.map(r=>`<div class="crow" data-co="${esc(r.name)}" tabindex="0" role="button"><b>${esc(r.name)}</b><span class="c-ind" style="min-width:0"><span class="chip">${famDot(r.ind)}${esc(r.ind)}</span></span><span class="c-geo cl">${esc(r.geo)}</span><span class="mono">${r.n}</span><span class="c-sen mono">${r.sen||'–'}</span><span><span class="mini" title="${r.touched} of ${r.n} contacted"><i style="width:${r.touched/r.n*100}%;background:var(--accent)"></i></span></span></div>`).join('')}
  ${rows.length?'':`<div class="empty"><b>No company matches</b>Try a shorter search.</div>`}
  </div>${rows.length>UI.coShown?`<div class="more"><button class="btn" data-act="comore">Show more · ${fmt(rows.length-UI.coShown)} left</button></div>`:''}`;
}

/* ---------------------------------------------------------------- view: tasks */
function taskRow(t){
  const c=t.cid?E(BYID.get(t.cid)||{}):null; const td=today();
  const cls=t.done?'':(t.due&&t.due<td?'late':t.due===td?'today':'');
  return `<div class="task ${t.done?'done':''}"><input type="checkbox" class="ck" data-tdone="${t.id}" ${t.done?'checked':''} aria-label="Mark done">
    <div style="min-width:0"><div class="tt">${esc(t.title)}</div><div class="meta">
      ${t.due?`<span class="due ${cls}">${t.due<td&&!t.done?'Overdue · ':t.due===td?'Today · ':''}${nice(t.due)}</span>`:'<span class="due">No date</span>'}
      ${c&&c.n?`<button class="colink" style="font-weight:500;font-size:12px" data-pid="${c.id}">${esc(c.n)}</button><span>${esc(c.c)}</span>`:''}
      ${!c&&t.co?`<button class="colink" style="font-weight:500;font-size:12px" data-co="${esc(t.co)}">${esc(t.co)}</button>`:''}
    </div></div>
    <div style="display:flex;gap:2px;flex-wrap:wrap;justify-content:flex-end">${!t.done&&t.cid&&(t.auto==='fu'||t.auto==='jc'||/reach out|coffee/i.test(t.title))?`<button class="btn sm ai" data-pid="${t.cid}" data-pur="${t.auto==='fu'?'follow':t.auto==='jc'?'congrats':/london/i.test(t.title)?'london':'catch'}">Draft</button>`:''}${!t.done?`<button class="btn sm ghost" data-tsnooze="${t.id}" title="Push one week">+1w</button>`:''}<button class="btn sm ghost" data-tdel="${t.id}" aria-label="Delete">✕</button></div></div>`;
}
function vTasks(){
  const td=today(), wk=addDays(7);
  const open=S.tasks.filter(t=>!t.done).sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'));
  const groups=[['Overdue',open.filter(t=>t.due&&t.due<td)],['Today',open.filter(t=>t.due===td)],['Next 7 days',open.filter(t=>t.due>td&&t.due<=wk)],['Later',open.filter(t=>t.due>wk)],['No date',open.filter(t=>!t.due)]];
  const done=S.tasks.filter(t=>t.done).sort((a,b)=>(b.doneAt||0)-(a.doneAt||0)).slice(0,15);
  return `${banner()}<div class="head"><div><h1>To-do</h1><div class="sub">Who to reach, when. Tick a to-do when it's done; push it a week if you need more time.</div></div></div>
  <section class="card pad" style="margin-bottom:18px"><h2>New to-do</h2>${taskComposer('tk',null)}</section>
  ${open.length?groups.filter(g=>g[1].length).map(([n,l])=>`<div class="tgroup"><h2>${n} <span class="count">${l.length}</span></h2><div class="card">${l.map(taskRow).join('')}</div></div>`).join(''):`<div class="card"><div class="empty"><b>Your to-do list is empty</b>Add one above, or open the People view, pick a smart list such as “Untouched decision-makers”, select people and choose “Create outreach to-dos”.</div></div>`}
  ${done.length?`<div class="tgroup" style="margin-top:24px"><h2>Recently done</h2><div class="card">${done.map(taskRow).join('')}</div></div>`:''}`;
}
function taskComposer(k, cid, co){
  const c=cid?E(BYID.get(cid)):null;
  return `<div class="composer" data-comp="${k}">
    <div class="r"><input class="inp" style="flex:1;min-width:200px" id="${k}-title" placeholder="${c?'e.g. Ask '+esc(c.fn||c.n)+' for a coffee':'e.g. Send the sector note to the team'}" aria-label="To-do">
    <input class="inp mono" type="date" id="${k}-due" value="${addDays(3)}" aria-label="Due date"></div>
    <div class="r">${[['Tomorrow',1],['Next week',7],['2 weeks',14],['1 month',30]].map(([l,d])=>`<button class="btn sm ghost" data-due="${k}" data-d="${addDays(d)}">${l}</button>`).join('')}
    ${cid||co?`<span class="linked">${esc(c?c.n:co)}</span>`:personPicker(k)}
    <span style="flex:1"></span><button class="btn pri sm" data-addtask="${k}" data-cid="${cid||''}" data-co="${esc(co||'')}">Add to-do</button></div></div>`;
}
function personPicker(k){
  const sel=UI['pick_'+k];
  if(sel){ const c=BYID.get(sel); return `<span class="linked">${esc(c.n)} · ${esc(c.c)}<button data-unpick="${k}" aria-label="Unlink">✕</button></span>`; }
  return `<span class="ac" style="min-width:220px"><input class="inp" id="${k}-who" placeholder="Link a person (optional)" autocomplete="off" style="width:100%" aria-label="Link a person"><span class="menu" id="${k}-menu" hidden></span></span>`;
}

/* ---------------------------------------------------------------- view: journal */
function noteRow(n){
  const c=n.cid?E(BYID.get(n.cid)||{}):null;
  return `<div class="note"><div class="when"><span class="kind">${esc(n.kind||'Note')}</span>${nice(n.date)}</div>
   <div style="min-width:0">${c&&c.n?`<div style="margin-bottom:4px"><button class="colink" data-pid="${c.id}" style="display:inline">${esc(c.n)}</button> <span class="hint">· ${esc(c.p)} · </span><button class="colink" data-co="${esc(c.c)}" style="display:inline;font-weight:500">${esc(c.c)}</button></div>`:n.co?`<div style="margin-bottom:4px"><button class="colink" data-co="${esc(n.co)}" style="display:inline">${esc(n.co)}</button></div>`:''}
   <div class="txt">${esc(n.text)}</div>
   <div class="meta">${(n.tags||[]).map(t=>`<span class="chip tag">${esc(t)}</span>`).join('')}${c&&c.i?`<span class="chip">${famDot(c.i)}${esc(c.i)}</span><span class="chip">${esc(c.g)}</span>`:''}<span style="flex:1"></span><button class="btn sm ghost" data-ndel="${n.id}">Delete</button></div></div></div>`;
}
function vJournal(){
  const q=norm(UI.jQ);
  let notes=[...S.notes].sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.createdAt||0)-(a.createdAt||0));
  notes=notes.filter(n=>{ const c=n.cid?E(BYID.get(n.cid)||{}):{};
    if(UI.jKind && n.kind!==UI.jKind) return false;
    if(UI.jTag && !(n.tags||[]).includes(UI.jTag) && !(c.t||[]).includes(UI.jTag)) return false;
    if(UI.jInd && c.i!==UI.jInd) return false;
    if(q && !norm(n.text+' '+(c.n||'')+' '+(c.c||n.co||'')+' '+(n.tags||[]).join(' ')).includes(q)) return false;
    return true; });
  const tags=allTags();
  return `${banner()}<div class="head"><div><h1>Journal</h1><div class="sub">Every conversation, in order. Filter by the person's industry or tags to see what you've heard across a sector.</div></div></div>
  <section class="card pad" style="margin-bottom:18px"><h2>Log a conversation</h2>${noteComposer('jn',null)}</section>
  <div class="toolbar"><input class="inp q" id="jq" type="search" placeholder="Search notes, people, companies" value="${esc(UI.jQ)}" aria-label="Search the journal">
   <select class="inp" id="jkind" aria-label="Type"><option value="">All types</option>${KINDS.map(k=>`<option ${UI.jKind===k?'selected':''}>${k}</option>`).join('')}</select>
   <select class="inp" id="jind" aria-label="Industry"><option value="">All industries</option>${INDS.map(k=>`<option ${UI.jInd===k?'selected':''}>${esc(k)}</option>`).join('')}</select>
   <select class="inp" id="jtag" aria-label="Tag"><option value="">All tags</option>${tags.map(k=>`<option ${UI.jTag===k?'selected':''}>${esc(k)}</option>`).join('')}</select></div>
  <div class="card pad">${notes.length?notes.map(noteRow).join(''):`<div class="empty"><b>${S.notes.length?'No notes match':'Your journal is empty'}</b>${S.notes.length?'Loosen the filters above.':'Log your first conversation above, or from anyone\'s record.'}</div>`}</div>`;
}
function debriefBlock(k, cid){
  const D=UI['deb_'+k]; const pid=cid||UI['pick_'+k]||'';
  let out=`<div class="r"><button class="btn sm ai ${D&&D.busy?'busy':''}" data-debrief="${k}" data-cid="${pid}" ${D&&D.busy?'disabled':''}>${D&&D.busy?'Tidying up':'Tidy up with Claude'}</button><span class="hint">Paste rough notes, get a clean entry and suggested to-dos.</span></div>`;
  if(D&&D.msg) out+=`<div class="hint" style="color:var(--danger)">${esc(D.msg)}</div>`;
  if(D&&D.todos&&D.todos.length) out+=`<div class="sugtodo"><span class="hint">Suggested to-dos${pid?'':' (link a person to attach them)'}</span>${D.todos.map((t,i)=>`<label><input type="checkbox" class="ck" data-debtodo="${k}" data-i="${i}" ${t.on?'checked':''}>${esc(t.title)} <span class="due">in ${t.d} days</span></label>`).join('')}<div><button class="btn sm" data-debadd="${k}" data-cid="${pid}">Add selected to-dos</button></div></div>`;
  return out;
}
function noteComposer(k, cid, co){
  const c=cid?E(BYID.get(cid)):null;
  return `<div class="composer" data-comp="${k}">
   <div class="r"><div class="seg" role="radiogroup" aria-label="Type">${KINDS.map((x,i)=>`<button role="radio" aria-checked="${(UI['kind_'+k]||'Coffee')===x}" class="${(UI['kind_'+k]||'Coffee')===x?'on':''}" data-kind="${k}" data-v="${x}">${x}</button>`).join('')}</div>
   <input class="inp mono" type="date" id="${k}-date" value="${today()}" aria-label="Date"></div>
   <textarea class="inp" id="${k}-text" placeholder="${c?'What did you discuss with '+esc(c.fn||c.n)+'? Deals, people mentioned, next steps…':'What was discussed, who said what, next steps…'}" aria-label="Note"></textarea>
   ${debriefBlock(k, cid)}
   <div class="r">${cid||co?`<span class="linked">${esc(c?c.n:co)}</span>`:personPicker(k)}
    <input class="inp" id="${k}-tags" list="${k}-tl" placeholder="Tags, comma separated" style="flex:1;min-width:160px" aria-label="Tags"><datalist id="${k}-tl">${allTags().map(t=>`<option value="${esc(t)}">`).join('')}</datalist>
    <button class="btn pri sm" data-addnote="${k}" data-cid="${cid||''}" data-co="${esc(co||'')}">Save note</button></div></div>`;
}

/* ---------------------------------------------------------------- drawer */
function openPerson(id, from, purpose){ if(!UI.drawer||UI.drawer.id!==id){ UI.ev={}; UI.prep=null; UI.dr={purpose:purpose||'catch',channel:'li',lang:'auto'}; } else if(purpose) UI.dr.purpose=purpose; UI.drawer={type:'p', id, from}; render(); }
function openCompany(name){ UI.drawer={type:'c', name}; render(); }
function closeDrawer(){ UI.drawer=null; const L=$('#layer'); L.innerHTML=''; L.dataset.key=''; if(UI.prep&&UI.prep.ctl) UI.prep.ctl.abort(); UI.prep=null; UI.ev={}; }
function drawDrawer(){
  const L=$('#layer'); const d=UI.drawer;
  if(!d){ L.innerHTML=''; return; }
  const ae=document.activeElement; const keepId=ae&&L.contains(ae)?ae.id:null; const sc=L.querySelector('.db')?L.querySelector('.db').scrollTop:0;
  const key=d.type+':'+(d.id||d.name); const sameKey=L.dataset.key===key; L.dataset.key=key;
  const keepVals={}; if(sameKey) L.querySelectorAll('input[id],textarea[id]').forEach(el=>{ if(el.type!=='checkbox'&&el.type!=='file') keepVals[el.id]=el.value; });
  L.innerHTML = `<div class="scrim" data-act="close"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Record">${d.type==='p'?drawerPerson(d):drawerCompany(d)}</aside>`;
  Object.entries(keepVals).forEach(([k,v])=>{ const el=document.getElementById(k); if(el&&v) el.value=v; });
  const b=L.querySelector('.db'); if(b) b.scrollTop=sc;
  if(keepId){ const el=document.getElementById(keepId); if(el) el.focus(); }
}
function reachOut(c){
  const dr=UI.dr; const saved=S.drafts[c.id]; const lang=dr.lang==='auto'?autoLang(c):dr.lang;
  return `<div class="sec"><h3>Reach out ${saved?'<span class="chip tag" style="text-transform:none;letter-spacing:0">Draft saved</span>':''}</h3><div class="dr">
    <div class="seg" role="radiogroup" aria-label="Purpose">${Object.entries(PURPOSES).map(([k,p])=>`<button role="radio" aria-checked="${dr.purpose===k}" class="${dr.purpose===k?'on':''}" data-drp="${k}">${p.l}</button>`).join('')}</div>
    <div class="r"><div class="seg">${[['li','LinkedIn'],['email','Email']].map(([k,l])=>`<button class="${dr.channel===k?'on':''}" data-drc="${k}">${l}</button>`).join('')}</div>
      <div class="seg">${[['auto','Auto ('+(autoLang(c)==='fr'?'FR':'EN')+')'],['en','English'],['fr','Français']].map(([k,l])=>`<button class="${dr.lang===k?'on':''}" data-drl="${k}">${l}</button>`).join('')}</div></div>
    <input class="inp" id="dr-extra" placeholder="Anything to mention? e.g. saw their Series B, met at the HL dinner">
    <div class="r"><button class="btn pri sm ai ${dr.busy?'busy':''}" data-act="gen" ${dr.busy?'disabled':''}>${dr.busy?'Drafting':'Draft with Claude'}</button>${dr.busy?'<button class="btn sm ghost" data-act="genstop">Stop</button>':''}<span class="hint">Uses only what your book knows about ${esc(c.fn||c.n)}.</span></div>
    <textarea class="inp" id="dr-text" aria-label="Message" placeholder="Your message appears here. Edit freely.">${esc(saved?saved.text:'')}</textarea>
    ${dr.msg?`<div class="msg">${esc(dr.msg)}</div>`:''}
    <div class="r"><button class="btn sm" data-act="drcopy">Copy</button>${c.u?`<a class="btn sm" href="https://www.linkedin.com/in/${esc(c.u)}" target="_blank" rel="noopener">Open LinkedIn ↗</a>`:''}
      ${dr.channel==='email'?(G.googleConnected()?`<button class="btn sm" data-act="gmail" ${c.e?'':'disabled title="Add their email under Classification"'}>Create Gmail draft</button>`:`<button class="btn sm" data-act="gmailopen">Open in Gmail</button>${SET().googleClientId?'<button class="btn sm ghost" data-act="gconnect">Connect Google</button>':''}`):''}
      <span style="flex:1"></span><button class="btn sm ghost" data-act="drsave">Save draft</button><button class="btn sm pri" data-act="drsent">Mark as sent</button></div>
    ${dr.gm?`<div class="msg">${esc(dr.gm)}</div>`:''}${dr.gmUrl?`<div class="hint"><a href="${esc(dr.gmUrl)}" target="_blank" rel="noopener">Open the draft in Gmail ↗</a></div>`:''}
    <div class="hint">“Mark as sent” logs the message in the journal, sets ${esc(c.fn||'them')} to Contacted and schedules a follow-up in ${SET().followDays} days.</div>
  </div></div>`;
}
function scheduleBlock(c){
  const ev=UI.ev||{};
  return `<details class="sec" ${ev.open?'open':''} data-evdet><summary>Schedule a meeting</summary>
    <div class="ev"><input class="inp" id="ev-title" placeholder="Coffee: ${esc(c.n)} / ${esc(SET().name||'me')}" style="grid-column:1/-1">
    <input class="inp mono" type="date" id="ev-date" value="${addDays(7)}" aria-label="Date"><input class="inp mono" type="time" id="ev-time" value="09:00" aria-label="Start time">
    <select class="inp" id="ev-dur" aria-label="Duration"><option value="30">30 min</option><option value="45" selected>45 min</option><option value="60">1 hour</option><option value="90">1 h 30</option></select>
    <input class="inp" id="ev-place" placeholder="Place (optional)" style="grid-column:1/3"><select class="inp" id="ev-tz" aria-label="Time zone"><option value="local">My time zone</option><option value="london">London time</option></select></div>
    <label class="hint" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" class="ck" id="ev-inv" ${c.e?'':'disabled'}>Send ${esc(c.fn||'them')} a calendar invite ${c.e?'('+esc(c.e)+')':'(add their email first)'}</label>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px">${G.googleConnected()?`<button class="btn sm pri ${ev.busy?'busy':''}" data-act="evcreate" ${ev.busy?'disabled':''}>Add to Google Calendar</button>`:`<button class="btn sm pri" data-act="evopen">Open in Google Calendar</button>${SET().googleClientId?'<button class="btn sm ghost" data-act="gconnect">Connect Google</button>':''}`}<span class="hint">${ev.done?esc(ev.done)+(ev.link?` <a href="${esc(ev.link)}" target="_blank" rel="noopener">Open ↗</a>`:''):ev.msg?`<span style="color:var(--danger)">${esc(ev.msg)}</span>`:'Also creates a prep to-do on the day.'}</span></div></details>`;
}
function prepBlock(c){
  const P=UI.prep&&UI.prep.cid===c.id?UI.prep:null;
  return `<div class="sec"><h3>Meeting prep</h3>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn sm ai ${P&&P.busy?'busy':''}" data-act="prep" ${P&&P.busy?'disabled':''}>${P&&P.busy?'Writing brief':'Prep brief with Claude'}</button><span class="hint">Built from your history with ${esc(c.fn||c.n)} and who else you know at ${esc(c.c)}.</span></div>
    ${P&&(P.text||P.busy)?`<div class="prep" id="prep-out" style="margin-top:10px">${esc(P.text||'Thinking…')}</div>`:''}${P&&P.msg?`<div class="hint" style="color:var(--danger);margin-top:6px">${esc(P.msg)}</div>`:''}</div>`;
}
function drawerPerson(d){
  const c=E(BYID.get(d.id)); const s=ST[c.st||''];
  const notes=S.notes.filter(n=>n.cid===c.id).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const tasks=S.tasks.filter(t=>t.cid===c.id).sort((a,b)=>(a.done-b.done)||(a.due||'9').localeCompare(b.due||'9'));
  const sel=(id,opts,val,lab)=>`<select class="inp" id="${id}" data-pf="${id.slice(3)}" aria-label="${lab}">${opts.map(o=>`<option ${o===val?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
  const colleagues=COMPANIES.get(c.c).ids.length-1;
  const sugg=allTags().filter(t=>!c.t.includes(t)).slice(0,10);
  return `<div class="dh"><div class="top"><div class="crumb">${d.from?`<button data-co="${esc(d.from)}">← ${esc(d.from)}</button>`:'Person'}</div><button class="btn sm ghost" data-act="close" aria-label="Close">✕ Close</button></div>
    <h2>${esc(c.n)}</h2><div style="color:var(--ink-2)">${esc(c.p)||'No title on LinkedIn'}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><button class="colink" data-co="${esc(c.c)}" style="display:inline">${esc(c.c)}</button>${colleagues>0?`<span class="hint">+${colleagues} more you know there</span>`:''}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">${c.u?`<a class="btn sm" href="https://www.linkedin.com/in/${esc(c.u)}" target="_blank" rel="noopener">LinkedIn profile ↗</a>`:''}${c.e?`<span class="chip mono" style="user-select:all">${esc(c.e)}</span>`:''}<span class="chip">Connected ${nice(c.d)||'–'}</span>${c.last?`<span class="chip">Last contact ${nice(c.last)}</span>`:''}<span class="chip ten" title="${c.since?'Since '+monthName(c.since)+(c.sinceApprox?' (approximate, from an import)':''):'Not in the LinkedIn export. Add it under Classification.'}">${c.since?`At ${esc(c.c)} ${tenure(c.since)}${c.sinceApprox?' (approx.)':''}`:'Time at company unknown'}</span>${catchupDue(c)?'<span class="chip" style="background:var(--brass-soft);color:var(--brass)">Catch-up due</span>':''}</div>
    ${c.chg&&c.prevC?`<div class="hint">Moved from ${esc(c.prevC)}${c.prevP?' ('+esc(c.prevP)+')':''}, spotted ${nice(c.chg)}</div>`:''}</div>
  <div class="db">
    ${reachOut(c)}
    <div class="sec"><h3>Relationship</h3>
      <div class="seg" role="radiogroup" aria-label="Status">${STATUSES.map(x=>`<button role="radio" aria-checked="${(c.st||'')===x[0]}" class="${(c.st||'')===x[0]?'on':''}" data-pst="${x[0]}">${x[1]}</button>`).join('')}</div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:10px"><span class="hint" style="margin-right:4px">Priority</span>${['A','B','C',''].map(p=>`<button class="btn sm ${c.pr===p?'pri':''}" data-ppr="${p}">${p||'None'}</button>`).join('')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px"><label class="hint" for="pcad">Keep in touch</label><select class="inp" id="pcad" style="padding:5px 8px">${CADENCES.map(([d,l])=>`<option value="${d}" ${c.cad===d?'selected':''}>${l}</option>`).join('')}</select>
      ${['cont','reach'].includes(c.st)||S.tasks.some(t=>!t.done&&t.cid===c.id&&t.auto==='fu')?`<button class="btn sm" data-act="replied">They replied</button>`:''}</div></div>
    ${scheduleBlock(c)}
    ${prepBlock(c)}
    <div class="sec"><h3>Tags</h3><div class="tagbox">${c.t.map(t=>`<span class="chip tag x" data-untag="${esc(t)}" title="Remove">${esc(t)} ✕</span>`).join('')}<input id="tagin" list="ptl" placeholder="+ add tag" aria-label="Add tag"><datalist id="ptl">${allTags().map(t=>`<option value="${esc(t)}">`).join('')}</datalist></div>
      <div class="sugg">${sugg.map(t=>`<button data-tagadd="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div></div>
    <div class="sec"><h3>Classification <span class="hint" style="text-transform:none;letter-spacing:0;font-weight:400">${c.gc==='assumed'?'Geography assumed from company':c.gc==='none'?'Geography unknown — set it':''}</span></h3>
      <div class="kv"><span class="k">Industry</span>${sel('pf-i',INDS,c.i,'Industry')}<span class="k">Geography</span>${sel('pf-g',GEOS,c.g,'Geography')}<span class="k">Seniority</span>${sel('pf-s',SENS,c.s,'Seniority')}<span class="k">Function</span>${sel('pf-f',FUNS,c.f,'Function')}
        <span class="k">At company since</span><span style="display:flex;gap:8px;align-items:center"><input class="inp mono" type="month" id="psince" value="${esc(c.since)}" style="flex:1"><span class="hint">${c.since?tenure(c.since):'from their profile'}</span></span>
        <span class="k">Email</span><input class="inp" type="email" id="pemail" value="${esc(c.e)}" placeholder="name@company.com"></div></div>
    <div class="sec"><h3>To-do <span class="count">${tasks.filter(t=>!t.done).length} open</span></h3>
      ${tasks.length?`<div class="card" style="margin-bottom:10px">${tasks.map(taskRow).join('')}</div>`:''}
      ${taskComposer('pt',c.id)}</div>
    <div class="sec"><h3>Conversations <span class="count">${notes.length}</span></h3>
      ${noteComposer('pn',c.id)}
      <div style="margin-top:8px">${notes.map(noteRow).join('')}</div></div>
  </div>`;
}
function drawerCompany(d){
  const co=COMPANIES.get(d.name); if(!co) return '';
  const st=coStats(co); const sr=Object.fromEntries(SENS.map((s,i)=>[s,i]));
  const ppl=st.ppl.sort((a,b)=>(sr[a.s]-sr[b.s])||a.n.localeCompare(b.n));
  const ids=new Set(co.ids);
  const notes=S.notes.filter(n=>ids.has(n.cid)||n.co===d.name).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const tasks=S.tasks.filter(t=>!t.done&&(ids.has(t.cid)||t.co===d.name));
  const senC={}; for(const p of ppl) senC[p.s]=(senC[p.s]||0)+1;
  const raw=[...new Set(ppl.map(p=>p.cr).filter(Boolean))];
  return `<div class="dh"><div class="top"><div class="crumb">Company</div><button class="btn sm ghost" data-act="close" aria-label="Close">✕ Close</button></div>
    <h2>${esc(d.name)}</h2>
    <div style="display:flex;flex-wrap:wrap;gap:6px"><span class="chip">${famDot(st.ind)}${esc(st.ind)}</span><span class="chip">${esc(st.geo)}</span><span class="chip mono">${st.n} ${st.n>1?'people':'person'}</span><span class="chip mono">${st.sen} decision-maker${st.sen===1?'':'s'}</span><span class="chip mono">${st.touched} contacted</span></div>
    ${raw.length?`<div class="hint">Also listed as: ${raw.map(esc).join(', ')}</div>`:''}</div>
  <div class="db">
    <div class="sec"><h3>People you know here</h3><div class="card">${ppl.map(p=>{const s=ST[p.st||''];return `<div class="prow" style="grid-template-columns:minmax(0,1fr) auto" data-pid="${p.id}" data-from="${esc(d.name)}" tabindex="0" role="button"><span class="who"><b>${p.pr?`<span class="prio ${p.pr}" style="margin-right:6px">${p.pr}</span>`:''}${esc(p.n)}</b><span style="white-space:normal">${esc(p.p)}</span></span><span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px"><span class="st ${s[2]}">${s[1]}</span><span class="hint">${esc(p.s)}${p.since?' · '+tenure(p.since):''}</span></span></div>`}).join('')}</div></div>
    <div class="sec"><h3>Set for everyone here</h3>
      <div class="kv"><span class="k">Geography</span><select class="inp" id="cog" aria-label="Geography for all"><option value="">Choose…</option>${GEOS.map(g=>`<option>${g}</option>`).join('')}</select>
      <span class="k">Industry</span><select class="inp" id="coi" aria-label="Industry for all"><option value="">Choose…</option>${INDS.map(g=>`<option>${esc(g)}</option>`).join('')}</select>
      <span class="k">Tag</span><span style="display:flex;gap:6px"><input class="inp" id="cot" list="ctl" placeholder="e.g. Client" style="flex:1"><datalist id="ctl">${allTags().map(t=>`<option value="${esc(t)}">`).join('')}</datalist><button class="btn sm" data-act="cotag">Add</button></span></div>
      <div class="hint" style="margin-top:6px">Useful for global firms: set the office your contacts sit in once.</div></div>
    <div class="sec"><h3>To-do for this company <span class="count">${tasks.length} open</span></h3>${tasks.length?`<div class="card" style="margin-bottom:10px">${tasks.map(taskRow).join('')}</div>`:''}${taskComposer('ct',null,d.name)}</div>
    <div class="sec"><h3>Conversations <span class="count">${notes.length}</span></h3>${noteComposer('cn',null,d.name)}<div style="margin-top:8px">${notes.map(noteRow).join('')}</div></div>
  </div>`;
}

/* ---------------------------------------------------------------- actions */
function applyFilter(k,v){ UI.f={i:new Set(),g:new Set(),s:new Set(),f:new Set(),st:new Set(),pr:new Set(),tg:new Set(),y:new Set()}; UI.preset=null; UI.q=''; UI.f[k].add(v); UI.shown=100; UI.sel.clear(); location.hash='#people'; setView('people'); }
function applyPreset(p){ UI.f={i:new Set(),g:new Set(),s:new Set(),f:new Set(),st:new Set(),pr:new Set(),tg:new Set(),y:new Set()}; UI.q=''; UI.preset=p; UI.shown=100; UI.sel.clear(); location.hash='#people'; setView('people'); }
function parseTags(s){ return [...new Set(String(s||'').split(',').map(x=>x.trim()).filter(Boolean))]; }
async function bulk(ids, patchFn, label){
  if(!needDb()) return; ids=[...ids].slice(0,500); let i=0;
  for(const id of ids){ const c=E(BYID.get(id)); const p=patchFn(c); if(p){ i++; const cur=Object.assign({}, S.people[id]||{}, p, {u:Date.now()}); S.people[id]=cur; try{ await chain('p/'+id,()=>db.collection('people').doc(id).set(cur)); }catch(e){ handleWriteErr(e); break; } if(i%25===0){ toast(`${label}: ${i} of ${ids.length}`); } } }
  render(); toast(`${label}: done for ${i}`);
}
document.addEventListener('click', async ev => {
  const t=ev.target.closest('[data-drp],[data-drc],[data-drl],[data-debrief],[data-debadd],[data-debtodo],[data-aoff],[data-qcopy],[data-qsent],[data-qdiscard],[data-act],[data-go],[data-preset],[data-htab],[data-fk],[data-co],[data-pid],[data-fclear],[data-fmore],[data-rm],[data-tdone],[data-tdel],[data-tsnooze],[data-due],[data-addtask],[data-addnote],[data-kind],[data-ndel],[data-pst],[data-ppr],[data-untag],[data-tagadd],[data-unpick],[data-pick],[data-sel]');
  if(!t) return;
  const D=t.dataset;
  if(D.drp){ UI.dr.purpose=D.drp; render(); return; }
  if(D.drc){ UI.dr.channel=D.drc; render(); return; }
  if(D.drl){ UI.dr.lang=D.drl; render(); return; }
  if(D.debrief){ debrief(D.debrief, D.cid||null); return; }
  if(D.debtodo){ const X=UI['deb_'+D.debtodo]; if(X&&X.todos) X.todos[+D.i].on=t.checked; return; }
  if(D.debadd){ const X=UI['deb_'+D.debadd]; const cid=D.cid||UI['pick_'+D.debadd]||null; const c=cid?BYID.get(cid):null; if(!X||!X.todos) return;
    for(const td of X.todos.filter(x=>x.on)) await addTask({title:td.title, due:addDays(td.d), cid, co:c?c.c:''}); UI['deb_'+D.debadd]=null; toast('To-dos added'); render(); return; }
  if(D.aoff){ if(t.checked) UI.act.off.delete(D.aoff); else UI.act.off.add(D.aoff); render(); return; }
  if(D.qcopy){ const el=document.getElementById('dq-'+D.qcopy); if(el){ if(!(await copyText(el.value))){ el.select(); } } return; }
  if(D.qsent){ const el=document.getElementById('dq-'+D.qsent); const d=S.drafts[D.qsent]||{}; await markSent(D.qsent, el?el.value:d.text||'', d.channel||'li', d.purpose||'catch'); return; }
  if(D.qdiscard){ discardDraft(D.qdiscard); return; }
  if(D.sel!==undefined){ ev.stopPropagation(); if(t.checked) UI.sel.add(D.sel); else UI.sel.delete(D.sel); render(); return; }
  if(D.pick){ const k=D.pick; UI['pick_'+k]=D.pid; render(); return; }
  if(D.fk && t.matches('input')){ const set=UI.f[D.fk]; set.has(D.fv)?set.delete(D.fv):set.add(D.fv); UI.shown=100; render(); return; }
  if(D.fk){ applyFilter(D.fk, D.fv); return; }
  if(D.act==='close'){ closeDrawer(); return; }
  if(D.go){ location.hash='#'+D.go; return; }
  if(D.preset){ applyPreset(D.preset); return; }
  if(D.htab){ UI.homeTab=D.htab; render(); return; }
  if(D.pid && !t.matches('input')){ openPerson(D.pid, D.from||null, D.pur||null); return; }
  if(D.co!==undefined && t.matches('button,[data-co]') && !D.addtask && !D.addnote){ openCompany(D.co); return; }
  if(D.fclear){ UI.f[D.fclear].clear(); render(); return; }
  if(D.fmore){ UI.moreF[D.fmore]=!UI.moreF[D.fmore]; render(); return; }
  if(D.rm){ UI.f[D.rm].delete(D.rv); render(); return; }
  if(D.tdone){ await setTask(D.tdone,{done:t.checked, doneAt:t.checked?Date.now():null}); if(t.checked){ const tk=S.tasks.find(x=>x.id===D.tdone); if(tk&&tk.cid){ const c=E(BYID.get(tk.cid)); if(!c.st) savePerson(tk.cid,{st:'cont'}); } } return; }
  if(D.tdel){ delTask(D.tdel); return; }
  if(D.tsnooze){ const tk=S.tasks.find(x=>x.id===D.tsnooze); const base=tk.due&&tk.due>today()?tk.due:today(); const [y,m,dd]=base.split('-').map(Number); const nd=new Date(y,m-1,dd+7); setTask(D.tsnooze,{due:nd.getFullYear()+'-'+String(nd.getMonth()+1).padStart(2,'0')+'-'+String(nd.getDate()).padStart(2,'0')}); return; }
  if(D.due){ const el=document.getElementById(D.due+'-due'); if(el) el.value=D.d; return; }
  if(D.addtask){ const k=D.addtask; const title=document.getElementById(k+'-title').value.trim(); if(!title){ document.getElementById(k+'-title').focus(); toast('Write the to-do first'); return; }
    const cid=D.cid||UI['pick_'+k]||null; await addTask({title, due:document.getElementById(k+'-due').value||'', cid, co:D.co||(cid?BYID.get(cid).c:'')});
    document.getElementById(k+'-title') && (document.getElementById(k+'-title').value=''); UI['pick_'+k]=null; if(cid){ const c=E(BYID.get(cid)); if(!c.st) savePerson(cid,{st:'reach'}); } render(); return; }
  if(D.kind){ UI['kind_'+D.kind]=D.v; render(); return; }
  if(D.addnote){ const k=D.addnote; const text=document.getElementById(k+'-text').value.trim(); if(!text){ document.getElementById(k+'-text').focus(); toast('Write the note first'); return; }
    const cid=D.cid||UI['pick_'+k]||null; const tags=parseTags(document.getElementById(k+'-tags').value);
    await addNote({text, kind:UI['kind_'+k]||'Coffee', date:document.getElementById(k+'-date').value||today(), tags, cid, co:D.co||(cid?BYID.get(cid).c:'')});
    document.getElementById(k+'-text').value=''; document.getElementById(k+'-tags').value=''; UI['pick_'+k]=null; render(); return; }
  if(D.ndel){ delNote(D.ndel); return; }
  if(D.pst!==undefined && UI.drawer){ savePerson(UI.drawer.id,{st:D.pst}); return; }
  if(D.ppr!==undefined && UI.drawer){ savePerson(UI.drawer.id,{pr:D.ppr}); return; }
  if(D.untag && UI.drawer){ const c=E(BYID.get(UI.drawer.id)); savePerson(c.id,{tags:c.t.filter(x=>x!==D.untag)}); return; }
  if(D.tagadd && UI.drawer){ const c=E(BYID.get(UI.drawer.id)); savePerson(c.id,{tags:[...new Set([...c.t,D.tagadd])]}); return; }
  if(D.unpick){ UI['pick_'+D.unpick]=null; render(); return; }
  switch(D.act){
    case 'more': UI.shown+=200; render(); break;
    case 'comore': UI.coShown+=200; render(); break;
    case 'facets': UI.facetOpen=!UI.facetOpen; render(); break;
    case 'nopreset': UI.preset=null; render(); break;
    case 'clearall': UI.f={i:new Set(),g:new Set(),s:new Set(),f:new Set(),st:new Set(),pr:new Set(),tg:new Set(),y:new Set()}; UI.preset=null; UI.q=''; render(); break;
    case 'selall': { const l=sortList(filtered()).slice(0,500); l.forEach(c=>UI.sel.add(c.id)); render(); if(filtered().length>500) toast('Selected the first 500'); break; }
    case 'selnone': UI.sel.clear(); render(); break;
    case 'bktag': { const tag=$('#bkTag').value.trim(); if(!tag){ toast('Type a tag first'); break; } await bulk(UI.sel, c=>c.t.includes(tag)?null:{tags:[...c.t,tag]}, 'Tagging'); break; }
    case 'bktask': { if(!needDb()) break; const ids=[...UI.sel].slice(0,200); let i=0; for(const id of ids){ const c=BYID.get(id); try{ await db.collection('tasks').add({title:'Reach out to '+(c.fn||c.n), due:addDays(3+Math.floor(i/10)), cid:id, co:c.c, done:false, createdAt:Date.now()}); i++; }catch(e){ handleWriteErr(e); break; } }
      await bulk(ids, c=>c.st?null:{st:'reach'}, 'Outreach'); toast(`${i} to-dos created, spread ten a day`); UI.sel.clear(); render(); break; }
    case 'newnote': location.hash='#journal'; setTimeout(()=>{ const el=$('#jn-text'); if(el) el.focus(); },60); break;
    case 'newtask': location.hash='#tasks'; setTimeout(()=>{ const el=$('#tk-title'); if(el) el.focus(); },60); break;
    case 'cotag': { const tag=$('#cot').value.trim(); if(!tag) break; await bulk(COMPANIES.get(UI.drawer.name).ids, c=>c.t.includes(tag)?null:{tags:[...c.t,tag]}, 'Tagging'); break; }
    case 'export': exportCsv(); break;
    case 'gen': generateDraft(UI.drawer.id); break;
    case 'genstop': if(draftCtl) draftCtl.abort(); break;
    case 'drcopy': { const el=$('#dr-text'); if(el&&el.value.trim()){ if(!(await copyText(el.value))) el.select(); } else toast('Draft a message first'); break; }
    case 'drsave': { const el=$('#dr-text'); if(el&&el.value.trim()){ await saveDraftText(UI.drawer.id, el.value, UI.dr.purpose, UI.dr.channel); toast('Draft saved. Find it in Activate.'); } break; }
    case 'drsent': { const el=$('#dr-text'); const v=el?el.value:''; await markSent(UI.drawer.id, v, UI.dr.channel, UI.dr.purpose); const el2=$('#dr-text'); if(el2) el2.value=''; break; }
    case 'gmail': { const el=$('#dr-text'); if(!el||!el.value.trim()){ toast('Draft the email first'); break; } gmailDraft(UI.drawer.id, el.value); break; }
    case 'gmailopen': { const el=$('#dr-text'); const c=E(BYID.get(UI.drawer.id)); const {subject,body}=splitSubject(el?el.value:''); window.open(G.gmailComposeUrl({to:c.e||'',subject,body}),'_blank','noopener'); break; }
    case 'gconnect': { G.connectGoogle(SET().googleClientId).then(()=>{ toast('Google connected'); render(); }).catch(e=>toast(e.message)); break; }
    case 'gdisconnect': G.disconnectGoogle(); toast('Google disconnected'); render(); break;
    case 'evopen': { const c=E(BYID.get(UI.drawer.id)); const a=eventArgs(c); if(!a){ toast('Pick a date and a time'); break; } window.open(G.calendarTemplateUrl(a),'_blank','noopener'); UI.ev={open:true,done:'Opened Google Calendar with the event filled in. Save it there.'}; afterMeetingBooked(c,a); break; }
    case 'replied': markReplied(UI.drawer.id); break;
    case 'prep': prepBrief(UI.drawer.id); break;
    case 'evcreate': UI.ev=Object.assign({},UI.ev,{open:true}); calendarEvent(UI.drawer.id); break;
    case 'adraft': { const picks=activationPicks(UI.act.goal,UI.act.n).filter(c=>!UI.act.off.has(c.id)); draftBatch(picks.map(c=>c.id), UI.act.purpose, UI.act.channel); break; }
    case 'saveset': saveSettings(); break;
    case 'showkey': { const el=$('#set-key'); if(el) el.type=el.type==='password'?'text':'password'; break; }
    case 'testkey': testKey(); break;
    case 'backup': exportBackup(); break;
    case 'vaultmake': makeVault(); break;
    case 'unlock': unlockVault(); break;
    case 'wipe': if(!UI.wipeArm){ UI.wipeArm=true; render(); setTimeout(()=>{ UI.wipeArm=false; render(); },5000); } else { db&&db.wipe().then(()=>location.reload()); } break;
  }
});
document.addEventListener('change', async ev => {
  const t=ev.target;
  if(t.id==='psort'){ UI.sort=t.value; render(); }
  else if(t.id==='presetSel'){ UI.preset=t.value||null; UI.shown=100; render(); }
  else if(t.id==='cind'){ UI.coInd=t.value; render(); }
  else if(t.id==='csort'){ UI.coSort=t.value; render(); }
  else if(t.id==='jkind'){ UI.jKind=t.value; render(); }
  else if(t.id==='jind'){ UI.jInd=t.value; render(); }
  else if(t.id==='jtag'){ UI.jTag=t.value; render(); }
  else if(t.id==='impfile' && t.files && t.files[0]){ importCsv(t.files[0]); t.value=''; }
  else if(t.id==='restfile' && t.files && t.files[0]){ restoreBackup(t.files[0]); t.value=''; }
  else if(t.id==='agoal'){ UI.act.goal=t.value; UI.act.touched=true; UI.act.off=new Set(); render(); }
  else if(t.id==='an'){ UI.act.n=+t.value; render(); }
  else if(t.id==='apur'){ UI.act.purpose=t.value; }
  else if(t.id==='ach'){ UI.act.channel=t.value; }
  else if(t.dataset.dqid){ saveDraftText(t.dataset.dqid, t.value); }
  else if(t.id==='pcad' && UI.drawer){ savePerson(UI.drawer.id,{cad:+t.value}); }
  else if(t.id==='psince' && UI.drawer){ savePerson(UI.drawer.id,{since:t.value, sinceApprox:false}); }
  else if(t.id==='pemail' && UI.drawer){ const v=t.value.trim(); if(v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)){ toast('That email address looks incomplete'); return; } savePerson(UI.drawer.id,{em:v}); }
  else if(t.matches('details[data-evdet]')){}
  else if(t.dataset.pf && UI.drawer){ const map={i:'i',g:'g',s:'s',f:'f'}; savePerson(UI.drawer.id,{[map[t.dataset.pf]]:t.value}); }
  else if(t.id==='bkSt' && t.value){ const v=t.value==='_none'?'':t.value; await bulk(UI.sel, ()=>({st:v}), 'Status'); }
  else if(t.id==='bkPr' && t.value){ const v=t.value==='_none'?'':t.value; await bulk(UI.sel, ()=>({pr:v}), 'Priority'); }
  else if(t.id==='cog' && t.value && UI.drawer){ const v=t.value; await bulk(COMPANIES.get(UI.drawer.name).ids, ()=>({g:v}), 'Geography'); }
  else if(t.id==='coi' && t.value && UI.drawer){ const v=t.value; await bulk(COMPANIES.get(UI.drawer.name).ids, ()=>({i:v}), 'Industry'); }
});
let qT; document.addEventListener('input', ev => {
  const t=ev.target;
  if(t.id==='pq'){ clearTimeout(qT); qT=setTimeout(()=>{ UI.q=t.value; UI.shown=100; render(); },140); }
  else if(t.id==='cq'){ clearTimeout(qT); qT=setTimeout(()=>{ UI.coQ=t.value; UI.coShown=120; render(); },140); }
  else if(t.id==='jq'){ clearTimeout(qT); qT=setTimeout(()=>{ UI.jQ=t.value; render(); },140); }
  else if(/-who$/.test(t.id)){ const k=t.id.slice(0,-4); const menu=document.getElementById(k+'-menu'); const q=norm(t.value).trim(); if(q.length<2){ menu.hidden=true; return; }
    const hits=BASE.filter(c=>c._s.includes(q)).slice(0,8); menu.innerHTML=hits.map(c=>`<button data-pick="${k}" data-pid="${c.id}"><span>${esc(c.n)}</span><small>${esc(c.p)} · ${esc(c.c)}</small></button>`).join('')||'<div class="hint" style="padding:8px 10px">No match</div>'; menu.hidden=false; }
});
document.addEventListener('toggle', ev => { if(ev.target.matches && ev.target.matches('details[data-evdet]')) UI.ev=Object.assign({},UI.ev,{open:ev.target.open}); }, true);
document.addEventListener('keydown', ev => {
  if(ev.key==='Escape' && UI.drawer){ closeDrawer(); return; }
  if(ev.key==='Enter' && ev.target.id==='vpass'){ ev.preventDefault(); unlockVault(); return; }
  if((ev.key==='Enter'||ev.key===' ') && ev.target.matches('[role=button][tabindex]')){ ev.preventDefault(); ev.target.click(); return; }
  if(ev.target.id==='tagin' && ev.key==='Enter' && UI.drawer){ ev.preventDefault(); const v=ev.target.value.trim(); if(!v) return; const c=E(BYID.get(UI.drawer.id)); ev.target.value=''; savePerson(c.id,{tags:[...new Set([...c.t,v])]}); }
  if(ev.key==='/' && !/input|textarea|select/i.test(ev.target.tagName) && UI.view==='people'){ ev.preventDefault(); $('#pq')&&$('#pq').focus(); }
});
async function exportCsv(){
  const list=sortList(filtered()); const cols=['Name','Position','Company','At company since','Industry','Geography','Seniority','Function','Status','Priority','Tags','Last contact','Connected','LinkedIn','Email'];
  const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const csv=[cols.join(',')].concat(list.map(c=>[c.n,c.p,c.c,c.since,c.i,c.g,c.s,c.f,ST[c.st||''][1],c.pr,c.t.join('; '),c.last,c.d,c.u?'https://www.linkedin.com/in/'+c.u:'',c.e].map(q).join(','))).join('\n');
  saveFile('network-'+today()+'.csv', '\uFEFF'+csv, 'text/csv'); toast('CSV exported');
}

/* ---------------------------------------------------------------- settings, welcome, backups */
function saveFile(name, data, type){
  const blob=new Blob([data],{type:type||'application/octet-stream'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),2000);
}
const field=id=>{ const el=document.getElementById(id); return el?el.value:undefined; };
async function saveSettings(){
  if(!needDb()) return;
  const map={name:'set-name',about:'set-about',signoff:'set-sign',tone:'set-tone',followDays:'set-fu',tripCity:'set-city',tripDates:'set-dates',tripTag:'set-tag',tagRules:'set-rules',apiKey:'set-key',model:'set-model',googleClientId:'set-gid'};
  const cur=Object.assign({},S.settings||{});
  for(const [k,id] of Object.entries(map)){ const v=field(id); if(v!==undefined) cur[k]=k==='followDays'?(+v||7):String(v).trim(); }
  if(cur.googleClientId) cur.googleClientId=cur.googleClientId.replace(/\s+/g,'').toLowerCase();
  if(cur.apiKey) cur.apiKey=cur.apiKey.replace(/\s+/g,'');
  S.settings=cur;
  try{ await db.collection('meta').doc('settings').set(cur); rebuildBase(); toast('Settings saved'); }catch(e){ handleWriteErr(e); }
}
async function testKey(){
  await saveSettings(); const sample=await getSample(); if(!sample){ toast(NO_KEY); return; }
  UI.keyMsg='Testing…'; render();
  try{ await sample('Reply with the single word OK.',{maxTokens:5}); UI.keyMsg='The key works.'; }catch(e){ UI.keyMsg=sampleErr(e); }
  render();
}
function dumpForExport(includeKey){
  const d=db.dump(); const st=Object.assign({},(d.meta&&d.meta.settings)||{});
  if(!includeKey){ delete st.apiKey; }
  d.meta=Object.assign({},d.meta,{settings:st});
  return {app:'network-book', format:1, exportedAt:new Date().toISOString(), stores:d};
}
function exportBackup(){ if(!needDb()) return; const inc=(document.getElementById('bk-key')||{}).checked; saveFile(`network-book-backup-${today()}.json`, JSON.stringify(dumpForExport(inc)), 'application/json'); toast('Backup downloaded. Keep it somewhere private.'); }
async function applyDump(stores){
  const keep=Object.assign({}, S.settings||{});
  const st=Object.assign({}, (stores.meta&&stores.meta.settings)||{});
  for(const k of ['apiKey','googleClientId']) if(keep[k] && !st[k]) st[k]=keep[k];
  stores.meta=Object.assign({}, stores.meta||{}, {settings:st});
  await db.restore(stores);
}
async function restoreBackup(file){
  if(!needDb()) return;
  try{
    const j=JSON.parse(await file.text());
    if(!j||j.app!=='network-book'||!j.stores||!j.stores.contacts) throw new Error('not a backup');
    UI.imp={busy:true,msg:'Restoring…'}; render();
    await applyDump(j.stores); UI.imp={msg:`Restored ${fmt(Object.keys(j.stores.contacts).length)} contacts with their notes and to-dos.`};
    location.hash='#home'; setView('home');
  }catch(e){ UI.imp={msg:'That file is not a Network Book backup.'}; render(); }
}
let VAULT=null;
async function checkVault(){
  try{ const r=await fetch('data/vault.json',{cache:'no-store'}); if(r.ok){ const j=await r.json(); if(j&&j.app==='network-book'&&j.data){ VAULT=j; render(); } } }catch(e){ /* no bundle */ }
}
async function unlockVault(){
  if(!VAULT||!needDb()) return; const raw=(field('vpass')||'').trim(); const pass=raw; if(!pass){ toast('Type the passphrase'); return; }
  UI.vmsg='Decrypting…'; render();
  const alt=raw.toLowerCase().replace(/[‐-―−]/g,'-');
  try{ let j; try{ j=await decryptJson(VAULT, pass); }catch(e1){ if(e1.code==='bad_passphrase'&&alt!==raw) j=await decryptJson(VAULT, alt); else throw e1; } await applyDump(j.stores); UI.vmsg=''; toast('Unlocked. Your network is ready.'); location.hash='#home'; setView('home'); }
  catch(e){ UI.vmsg=e.code==='bad_passphrase'?'That passphrase does not match. Check capitals and spaces.':'Could not open the saved data: '+e.message; render(); }
}
async function makeVault(){
  if(!needDb()) return; const p1=(field('vp1')||'').trim(), p2=(field('vp2')||'').trim();
  if(p1.length<12){ toast('Use at least 12 characters, ideally 4 or more random words'); return; }
  if(p1!==p2){ toast('The two passphrases differ'); return; }
  UI.vaultMsg='Encrypting…'; render();
  try{ const v=await encryptJson(dumpForExport(false), p1); saveFile('vault.json', JSON.stringify(v), 'application/json'); UI.vaultMsg='vault.json downloaded. Replace data/vault.json in your repo with it, then commit.'; }
  catch(e){ UI.vaultMsg='Encryption failed: '+e.message; }
  render();
}
function welcomeMsg(){
  const m=(UI.imp&&UI.imp.msg)||UI.vmsg||'';
  return m?`<div class="banner" style="margin:0">${esc(m)}</div>`:'';
}
function vWelcome(){
  return `<div id="welcome" class="welcome">
    <div class="head"><div><h1>Network Book</h1><div class="sub">A private CRM for your LinkedIn network: tag everyone by industry, geography and seniority, log conversations, and let Claude draft your outreach. Everything is stored in this browser.</div></div></div>
    <div id="wmsg">${welcomeMsg()}</div>
    <div class="wgrid">
      ${VAULT?`<section class="card pad"><h2>Unlock your saved network</h2><div class="sub" style="margin:0 0 12px">This copy of the app comes with an encrypted data file. Enter its passphrase to load your contacts, notes and to-dos into this browser.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><input class="inp" type="password" id="vpass" placeholder="Passphrase" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" style="flex:1;min-width:200px"><button class="btn pri" data-act="unlock">Unlock</button></div></section>`:''}
      <section class="card pad"><h2>${VAULT?'Or start':'Start'} from your LinkedIn export</h2>
        <ol class="steps"><li>On LinkedIn, open <b>Settings &amp; Privacy → Data privacy → Get a copy of your data</b>.</li><li>Choose <b>Download larger data archive</b> and request it. The email usually arrives within minutes.</li><li>Unzip it and pick <b>Connections.csv</b> below.</li></ol>
        <label class="btn pri" for="impfile">Choose Connections.csv</label><input type="file" id="impfile" accept=".csv,text/csv" hidden>
        <div class="hint" style="margin-top:8px">The file is read and classified on your device. Nothing is uploaded.</div></section>
      <section class="card pad"><h2>Restore a backup</h2><div class="sub" style="margin:0 0 12px">Moving to another browser? Pick a backup file downloaded from Settings.</div>
        <label class="btn" for="restfile">Choose backup file</label><input type="file" id="restfile" accept=".json,application/json" hidden></section>
    </div></div>`;
}
function vSettings(){
  const s=SET(); const gOn=G.googleConnected();
  return `${banner()}<div class="head"><div><h1>Settings</h1><div class="sub">Stored in this browser only. Nothing here is ever written to the repo.</div></div><button class="btn pri" data-act="saveset">Save settings</button></div>
  <div class="setgrid">
    <section class="card pad"><h2>About you</h2><div class="hint" style="margin-bottom:10px">Claude uses this in every draft.</div>
      <div class="kv"><span class="k">First name</span><input class="inp" id="set-name" value="${esc(s.name)}" placeholder="e.g. Nico">
      <span class="k">About you</span><textarea class="inp" id="set-about" style="min-height:70px" placeholder="e.g. Associate on the tech M&A team at a Paris investment bank">${esc(s.about)}</textarea>
      <span class="k">Sign-off</span><input class="inp" id="set-sign" value="${esc(s.signoff)}" placeholder="Defaults to your first name">
      <span class="k">Tone</span><input class="inp" id="set-tone" value="${esc(s.tone)}">
      <span class="k">Follow up after</span><select class="inp" id="set-fu">${[3,5,7,10,14].map(n=>`<option value="${n}" ${+s.followDays===n?'selected':''}>${n} days without reply</option>`).join('')}</select></div></section>
    <section class="card pad"><h2>Next trip</h2><div class="hint" style="margin-bottom:10px">Used by the “Trip coffee” message and the “Tagged for your trip” list.</div>
      <div class="kv"><span class="k">City</span><input class="inp" id="set-city" value="${esc(s.tripCity)}" placeholder="e.g. London">
      <span class="k">Dates</span><input class="inp" id="set-dates" value="${esc(s.tripDates)}" placeholder="e.g. from 17 to 20 November">
      <span class="k">Tag</span><input class="inp" id="set-tag" value="${esc(s.tripTag)}" placeholder="Trip"></div></section>
    <section class="card pad"><h2>Claude</h2><div class="hint" style="margin-bottom:10px">Create a key at console.anthropic.com → API keys, and set a monthly spend limit there. The key stays in this browser and is sent only to Anthropic.</div>
      <div class="kv"><span class="k">API key</span><span style="display:flex;gap:6px"><input class="inp mono" type="password" id="set-key" value="${esc(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="flex:1"><button class="btn sm ghost" data-act="showkey">Show</button></span>
      <span class="k">Model</span><select class="inp" id="set-model">${MODELS.map(([v,l])=>`<option value="${v}" ${s.model===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px"><button class="btn sm" data-act="testkey">Save and test</button><span class="hint">${esc(UI.keyMsg||'')}</span></div></section>
    <section class="card pad"><h2>Google (Gmail drafts, Calendar events)</h2><div class="hint" style="margin-bottom:10px">Paste the OAuth client ID from your Google Cloud project (setup steps in the README). Without it, the buttons open pre-filled Gmail and Calendar pages instead.</div>
      <div class="kv"><span class="k">Client ID</span><input class="inp mono" id="set-gid" value="${esc(s.googleClientId)}" placeholder="1234-abc.apps.googleusercontent.com" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url">${s.googleClientId&&!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(s.googleClientId)?'<span class="hint" style="grid-column:2;color:var(--danger)">This does not look like a client ID. It should be digits, a dash, letters and digits, then .apps.googleusercontent.com</span>':''}
      <span class="k">Status</span><span>${gOn?'<span class="st st-met">Connected for this session</span> <button class="btn sm ghost" data-act="gdisconnect">Disconnect</button>':s.googleClientId?'<button class="btn sm" data-act="gconnect">Connect Google</button>':'<span class="hint">Add a client ID, save, then connect.</span>'}</span></div></section>
    <section class="card pad"><h2>Automatic tags</h2><div class="hint" style="margin-bottom:10px">One rule per line: <span class="mono">Company = Tag</span>. Applied to everyone at that company.</div>
      <textarea class="inp mono" id="set-rules" style="min-height:90px" placeholder="Lincoln International = Ex-Lincoln&#10;Houlihan Lokey = Colleague">${esc(s.tagRules)}</textarea></section>
    <section class="card pad"><h2>Your data</h2>
      <div class="drow"><div><b>Update from LinkedIn</b><div class="hint">Upload a fresh Connections.csv to add new connections and spot job changes.</div></div><label class="btn sm" for="impfile">Choose CSV</label><input type="file" id="impfile" accept=".csv,text/csv" hidden></div>
      ${UI.imp&&UI.imp.msg?`<div class="hint" style="margin:-4px 0 10px">${esc(UI.imp.msg)}</div>`:''}
      <div class="drow"><div><b>Backup</b><div class="hint">Everything in one JSON file, to move browsers or keep safe. <label><input type="checkbox" class="ck" id="bk-key"> include API key</label></div></div><span style="display:flex;gap:6px"><button class="btn sm" data-act="backup">Download</button><label class="btn sm ghost" for="restfile">Restore</label><input type="file" id="restfile" accept=".json,application/json" hidden></span></div>
      <div class="drow" style="flex-direction:column;align-items:stretch"><div><b>Encrypted copy for the repo</b><div class="hint">Creates <span class="mono">vault.json</span>, readable only with your passphrase. Commit it as <span class="mono">data/vault.json</span> so any browser can unlock your network. Your API key is never included.</div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><input class="inp" type="password" id="vp1" placeholder="New passphrase" autocomplete="new-password" style="flex:1;min-width:150px"><input class="inp" type="password" id="vp2" placeholder="Repeat it" autocomplete="new-password" style="flex:1;min-width:150px"><button class="btn sm" data-act="vaultmake">Create vault.json</button></div>
        ${UI.vaultMsg?`<div class="hint">${esc(UI.vaultMsg)}</div>`:''}</div>
      <div class="drow"><div><b>Delete everything on this device</b><div class="hint">Contacts, notes, to-dos and settings in this browser. The repo is not touched.</div></div><button class="btn sm" data-act="wipe" style="${UI.wipeArm?'background:var(--danger);color:#fff;border-color:var(--danger)':''}">${UI.wipeArm?'Click again to delete':'Delete'}</button></div>
    </section>
  </div>`;
}

/* ---------------------------------------------------------------- boot */
(async function boot(){
  await connect();
  const gm=(location.hash||'').match(/^#gid=([0-9a-z.\-]+)$/i);
  if(gm && db){ const cur=Object.assign({},S.settings||{},{googleClientId:gm[1].toLowerCase()}); S.settings=cur; await db.collection('meta').doc('settings').set(cur); history.replaceState(null,'','#settings'); setTimeout(()=>toast('Google client ID saved. Tap Connect Google.'),300); }
  const v=(location.hash||'#home').slice(1); UI.view=['home','activate','people','companies','tasks','journal','settings'].includes(v)?v:'home';
  document.querySelectorAll('#nav a').forEach(a=>a.classList.toggle('on',a.dataset.v===UI.view));
  checkVault();
  draw();
})();
})();
