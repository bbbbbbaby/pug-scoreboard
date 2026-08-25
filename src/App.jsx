import { sb, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase.js";
import { useState, useEffect, useCallback, useRef } from "react";
import { PugIcon } from "./PugIcon";
import "./pug-theme.css";

// ─── PUSH NOTIFICATIONS ───────────────────────────────
// URL e chiave derivano dall'ambiente (vedi supabase.js): in produzione
// non cambia nulla, sullo staging puntano al progetto di prova.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "BB29nPfLuESEo3G7G7yKcIZ6pERzx13f9_kR8EIe-4BpE8tReQ-nHAjOniz0vCK95-TmbaRx5sVkZRx5lmsMTNg";
const PUSH_EDGE_URL = `${SUPABASE_URL}/functions/v1/send-push`;
const PUSH_ANON_KEY = SUPABASE_ANON_KEY;

// ─── AUTH GIOCATORI ───────────────────────────────────────────
// Email sintetica e password derivata: DEVONO combaciare con lo
// script di migrazione (migra-auth-players.mjs) e la edge function.
// Il giocatore non le vede mai: login resta nickname + PIN.
const playerEmail = (id) => `p-${id}@players.pug.local`;
const playerPwd   = (pin, id) => `${pin || "1234"}.${id}`;
const PLAYER_ADMIN_FN = `${SUPABASE_URL}/functions/v1/player-admin`;

// Operazioni educatore sui giocatori: funzioni SQL nel database
// (admin_set_player_pin / admin_create_player / admin_delete_player)
async function playerAdmin(action, payload = {}) {
  let call = null;
  if (action === "set_pin") {
    call = sb.rpc("admin_set_player_pin", { p_player_id: payload.player_id, p_pin: payload.pin });
  } else if (action === "create_player") {
    call = sb.rpc("admin_create_player", {
      p_display_name: payload.display_name,
      p_first_name: payload.first_name || null,
      p_pin: payload.pin || "1234",
      p_squad_id: payload.squad_id || null,
      p_avatar_url: payload.avatar_url || null,
    });
  } else if (action === "delete_player") {
    call = sb.rpc("admin_delete_player", { p_player_id: payload.player_id });
  } else {
    return { error: "unknown_action" };
  }
  const { data, error } = await call;
  if (error) return { error: error.message };
  return data || { error: "risposta vuota" };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}

// Data locale in formato YYYY-MM-DD (NON UTC — evita lo sfasamento dopo mezzanotte)
function localToday() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().split("T")[0];
}

// Fetch della config di visibilità con dedupe: chiamate concorrenti
// condividono la stessa richiesta (evita doppio fetch al mount).
let _visFetch = null;
async function fetchVisibilityConfig() {
  if (_visFetch) return _visFetch;
  _visFetch = (async () => {
    try {
      const { data } = await sb.from("profiles").select("app_config")
        .eq("id", "00000000-0000-0000-0000-000000000099").single();
      return data?.app_config || null;
    } catch(_) {
      return null;
    } finally {
      setTimeout(() => { _visFetch = null; }, 1000);
    }
  })();
  return _visFetch;
}

// Converte una Date in YYYY-MM-DD locale (stessa logica di localToday)
function localDateStr(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0];
}


async function registerPush(playerId) {
  const log = (m) => { try { addToast(m, 'ok'); } catch(_) {} };
  const err = (m) => { try { addToast(m, 'error'); } catch(_) {} };
  try {
    if (!('serviceWorker' in navigator)) { err('1️⃣ No serviceWorker'); return; }
    if (!('PushManager' in window))      { err('1️⃣ No PushManager — installa la PWA'); return; }
    log('1️⃣ API ok');

    let reg;
    try { reg = await navigator.serviceWorker.register('/sw.js'); log('2️⃣ SW registrato'); }
    catch(e) { err('2️⃣ SW fail: ' + e.message); return; }

    const swReady = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_,r) => setTimeout(() => r(new Error('timeout 8s')), 8000))
    ]).catch((e) => { err('3️⃣ SW ready fail: ' + e.message); return null; });
    if (!swReady) return;
    log('3️⃣ SW ready');

    const perm = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (perm !== 'granted') { err('4️⃣ Permesso: ' + perm); return; }
    log('4️⃣ Permesso ok');

    const pm = swReady.pushManager || reg.pushManager;
    if (!pm) { err('5️⃣ pushManager null'); return; }
    log('5️⃣ pushManager ok');

    let sub;
    try {
      sub = await pm.getSubscription();
      if (!sub) {
        sub = await pm.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      log('6️⃣ Subscription ok');
    } catch(e) { err('6️⃣ Subscribe fail: ' + e.message); return; }

    const { error } = await sb.from('push_subscriptions').upsert(
      { player_id: playerId, subscription: JSON.parse(JSON.stringify(sub)) },
      { onConflict: 'player_id' }
    );
    if (error) { err('7️⃣ DB fail: ' + error.message); return; }
    log('✅ Notifiche attivate!');
  } catch(e) {
    err('❌ ' + (e?.message || e));
  }
}

async function sendPush(playerId, title, body) {
  try {
    // Cerca subscription su player_id (compatibile con educatori e giocatori)
    const { data: subs } = await sb.from('push_subscriptions')
      .select('subscription').eq('player_id', playerId).limit(5);
    if (!subs?.length) return;
    await Promise.all(subs.map(sub =>
      fetch(PUSH_EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PUSH_ANON_KEY}` },
        body: JSON.stringify({ subscription: sub.subscription, title, body }),
      }).catch(()=>{})
    ));
  } catch(e) { }
}

async function sendPushToAll(playerIds, title, body) {
  if (!playerIds?.length) return;
  try {
    // Una sola query per tutte le subscription, poi invii in parallelo
    const { data: subs } = await sb.from('push_subscriptions')
      .select('subscription').in('player_id', playerIds);
    if (!subs?.length) return;
    await Promise.all(subs.map(sub =>
      fetch(PUSH_EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PUSH_ANON_KEY}` },
        body: JSON.stringify({ subscription: sub.subscription, title, body }),
      }).catch(()=>{})
    ));
  } catch(e) { }
}


// ─── LIVELLI ──────────────────────────────────────────────
const LEVELS = [
  {id:1,name:"Seme",emoji:"🌱",xp:0},{id:2,name:"Germoglio",emoji:"🌿",xp:50},
  {id:3,name:"Foglia",emoji:"🍃",xp:100},{id:4,name:"Fiore",emoji:"🌸",xp:150},
  {id:5,name:"Frutto",emoji:"🍎",xp:200},{id:6,name:"Radice",emoji:"🪴",xp:250},
  {id:7,name:"Stelo",emoji:"🌾",xp:300},{id:8,name:"Tronco",emoji:"🪵",xp:350},
  {id:9,name:"Albero",emoji:"🌳",xp:400},{id:10,name:"Bosco",emoji:"🌲",xp:450},
  {id:11,name:"Micelio",emoji:"🍄",xp:610},{id:12,name:"Creatura Selvatica",emoji:"🦊",xp:730},
  {id:13,name:"Guardiano Notturno",emoji:"🌙",xp:860},{id:14,name:"Fauno del Blocco",emoji:"🔥",xp:1000},
  {id:15,name:"Dryad Kid",emoji:"🧚",xp:1150},{id:16,name:"Spirito Verde",emoji:"🌀",xp:1350},
  {id:17,name:"Folletto Hyper",emoji:"⚡",xp:1560},{id:18,name:"Custode Segreto",emoji:"👁️",xp:1780},
  {id:19,name:"Campione della Chioma",emoji:"🏆",xp:2010},{id:20,name:"Re/Regina delle Fronde",emoji:"👑",xp:2250},
  {id:21,name:"Foresta Mistica",emoji:"🌌",xp:2550},{id:22,name:"Creatura Leggendaria",emoji:"🐉",xp:2860},
  {id:23,name:"Mythic Verde",emoji:"💎",xp:3180},{id:24,name:"Boss della Radura",emoji:"🔥",xp:3510},
  {id:25,name:"Garden Boss",emoji:"👑🌿",xp:4000},
];

const MONTH_NAMES = ["Gennaio","Febbraio","Marzo","Aprile","Maggio","Giugno","Luglio","Agosto","Settembre","Ottobre","Novembre","Dicembre"];

function getLevel(xp) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i].xp) return LEVELS[i];
  }
  return LEVELS[0];
}

const BRAND = {
  azzurro: "#A3CFFE", rosa: "#FF6DEC", giallo: "#FDEF26",
  verde: "#339966", rosso: "#D41323", nero: "#101010", bianco: "#FFFFFF",
};

const DOODLE_SVG = `<svg viewBox="0 0 390 960" width="100%" height="100%" preserveAspectRatio="xMidYMin slice"><defs><g id="fl" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z"/><path d="M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z" transform="rotate(72)"/><path d="M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z" transform="rotate(144)"/><path d="M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z" transform="rotate(216)"/><path d="M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z" transform="rotate(288)"/><circle r="3.1" fill="currentColor" stroke="none"/></g><g id="st"><path d="M0 -13 L3 -3 L13 0 L3 3 L0 13 L-3 3 L-13 0 L-3 -3Z" fill="currentColor"/></g><g id="lf" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M0 0 C7 -4 11 -13 8 -20 C2 -15 -2 -7 0 0Z"/><path d="M2.5 -3 L7 -15"/></g></defs><use href="#st" transform="translate(47,73) scale(1.05) rotate(231)"/><use href="#fl" transform="translate(201,75) scale(1.41) rotate(243)"/><use href="#st" transform="translate(359,77) scale(0.74) rotate(155)"/><use href="#fl" transform="translate(28,163) scale(1.47) rotate(324)"/><use href="#lf" transform="translate(171,196) scale(1.28) rotate(334)"/><use href="#fl" transform="translate(366,197) scale(1.29) rotate(270)"/><use href="#fl" transform="translate(23,281) scale(1.47) rotate(307)"/><use href="#fl" transform="translate(170,307) scale(1.26) rotate(100)"/><use href="#fl" transform="translate(352,292) scale(1.2) rotate(339)"/><use href="#fl" transform="translate(24,427) scale(1.13) rotate(282)"/><use href="#fl" transform="translate(174,414) scale(1.01) rotate(147)"/><use href="#fl" transform="translate(320,402) scale(0.93) rotate(55)"/><use href="#fl" transform="translate(37,542) scale(0.86) rotate(350)"/><use href="#fl" transform="translate(169,531) scale(1.49) rotate(240)"/><use href="#fl" transform="translate(343,543) scale(1.25) rotate(101)"/><use href="#fl" transform="translate(68,681) scale(0.91) rotate(170)"/><use href="#st" transform="translate(169,664) scale(0.75) rotate(126)"/><use href="#fl" transform="translate(364,644) scale(1.18) rotate(249)"/><use href="#fl" transform="translate(30,801) scale(1.16) rotate(97)"/><use href="#fl" transform="translate(215,766) scale(1.12) rotate(202)"/><use href="#fl" transform="translate(345,771) scale(1.46) rotate(303)"/><use href="#fl" transform="translate(38,879) scale(1.13) rotate(308)"/><use href="#fl" transform="translate(210,914) scale(1.54) rotate(109)"/><use href="#fl" transform="translate(347,894) scale(1.28) rotate(151)"/><use href="#st" transform="translate(215,115) scale(0.42) rotate(106)"/><use href="#st" transform="translate(316,691) scale(0.47) rotate(307)"/><use href="#st" transform="translate(206,420) scale(0.59) rotate(65)"/><use href="#st" transform="translate(318,535) scale(0.65) rotate(69)"/><use href="#st" transform="translate(215,227) scale(0.59) rotate(159)"/><use href="#st" transform="translate(134,877) scale(0.58) rotate(97)"/><use href="#st" transform="translate(99,797) scale(0.59) rotate(283)"/></svg>`;

const SQUAD_STYLE = {
  Verde:   { bg: "#339966", text: "#fff" },
  Gialla:  { bg: "#FDEF26", text: "#101010" },
  Azzurra: { bg: "#A3CFFE", text: "#101010" },
};

const COLORE_NOME = {"#FDEF26":"giallo","#FF6DEC":"rosa","#339966":"verde","#A3CFFE":"azzurro","#D41323":"rosso"};
const DEFAULT_SECTION_COLORS = {
  classifica:   { color: "#FDEF26", image: null },
  badge:        { color: "#FF6DEC", image: null },
  presenze:     { color: "#FDEF26", image: null },
  attivita:     { color: "#339966", image: null },
  sfida:        { color: "#A3CFFE", image: null },
  bigtop:       { color: "#D41323", image: null },
  messaggi:     { color: "#FF6DEC", image: null },
  dashboard:    { color: "#A3CFFE", image: null },
  giocatori:    { color: "#339966", image: null },
  qr:           { color: "#D41323", image: null },
  streak:       { color: "#D41323", image: null },
  prenotazioni: { color: "#339966", image: null },
  vista:        { color: "#A3CFFE", image: null },
  admin:        { color: "#FDEF26", image: null },
  pulizia:      { color: "#FF6DEC", image: null },
  export:       { color: "#339966", image: null },
  bacheca:      { color: "#FF6DEC", image: null },
  notifiche:    { color: "#D41323", image: null },
  annunci:      { color: "#FDEF26", image: null },
  social_edu:   { color: "#339966", image: null },
  visibilita:   { color: "#A3CFFE", image: null },
  squadre:      { color: "#A3CFFE", image: null },
  diario:       { color: "#A3CFFE", image: null },
};

// ─── CSS ──────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Funnel+Display:wght@300;400;500;600;700;800&display=swap');

  /* ═══ PASS GRAFICO G1 — brand PUG (dal Camerino) ═══ */
  @font-face{font-family:'Jelek Type';src:url(data:font/woff2;base64,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) format('woff2');font-display:swap}
  .hand { font-family:'Jelek Type', cursive; }
  .pd-first-hand { color:#fff; }
  .light .pd-first-hand { color:#101010; }
  .pd-xp-missing { text-align:center; font-size:23px; margin-top:8px; color:#FDEF26; }
  .light .pd-xp-missing { color:#D41323; }

  /* ═══ SCHERMATA D'AVVIO: sipario nero ═══ */
  .login-wrap { background:#000; }
  .login-wrap::before { content:''; position:fixed; inset:0; background:#000; z-index:-1; }
  .form-input, .form-group select, .form-group textarea, textarea.form-input {
    background:#FDEF26 !important; color:#101010 !important; border:2px solid #101010 !important;
    font-weight:700; box-shadow:none !important; }
  .form-input::placeholder, .form-group textarea::placeholder { color:rgba(16,16,16,.4) !important; }
  .login-card { background:#ffffff !important; border:2.5px solid #101010 !important;
    box-shadow:6px 6px 0 rgba(255,255,255,.14) !important; color:#101010;
    position:relative; z-index:0; overflow:hidden; }
  .login-card .form-label { color:#101010 !important; }
  .login-card .form-input { background:#fff !important; color:#101010 !important; border:2px solid #101010 !important; box-shadow:none !important; }
  .login-card .form-input::placeholder { color:rgba(16,16,16,.35) !important; }
  .login-card .search-inp { background:#FDEF26 !important; color:#101010 !important;
    border:2px solid #101010 !important; font-weight:800; box-shadow:3px 3px 0 rgba(16,16,16,.9) !important; }
  .login-card .search-inp::placeholder { color:rgba(16,16,16,.5) !important; }
  .edu-login-card .form-input { background:#FDEF26 !important; color:#101010 !important;
    border:2px solid #101010 !important; font-weight:800; box-shadow:3px 3px 0 rgba(16,16,16,.9) !important; }
  .edu-login-card .form-input::placeholder { color:rgba(16,16,16,.45) !important; }
  .login-card button:not(.btn-primary):not(.btn) { color:#101010 !important; }
  .login-doodles { color:#101010 !important; opacity:.10 !important; z-index:-1; }

  .login-logo-full { width:min(320px,80vw); aspect-ratio:720/323; margin:0 auto; background-size:cover; background-position:center; border-radius:16px; background-image:url(data:image/webp;base64,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); }
  .login-claim { font-size:clamp(17px,4.5vw,23px); color:#fff; margin-top:12px; line-height:1.15; }
  .xp-missing-card { text-align:center; font-size:27px; margin-top:8px; color:#FDEF26; }
  .light .xp-missing-card { color:#D41323; }

  .logo-b{background-image:url(/public/sfondi/logo-riquadro_nero.webp)}
  .logo-w{background-image:url(/public/sfondi/logo-riquadro_bianco.webp);display:none}
  .pd-logo-img { width:104px; height:44px; background-size:contain; background-repeat:no-repeat; background-position:left center; }
  .logo-b { display:none; }
  .logo-w { display:block; }
  .light .logo-b { display:block; }
  .light .logo-w { display:none; }

  .bg-doodles { position:absolute; inset:0; z-index:-1; pointer-events:none; color:#fff; opacity:.20; overflow:hidden;
    background-color:currentColor;
    -webkit-mask-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27380%27 height=%27380%27 viewBox=%270 0 380 380%27%3E%3Cdefs%3E%3Cg id=%27fl%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(72)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(144)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(216)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(288)%27/%3E%3Ccircle r=%273.1%27 fill=%27white%27 stroke=%27none%27/%3E%3C/g%3E%3Cg id=%27st%27%3E%3Cpath d=%27M0 -13 L3 -3 L13 0 L3 3 L0 13 L-3 3 L-13 0 L-3 -3Z%27 fill=%27white%27/%3E%3C/g%3E%3Cg id=%27lf%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M0 0 C7 -4 11 -13 8 -20 C2 -15 -2 -7 0 0Z%27/%3E%3Cpath d=%27M2.5 -3 L7 -15%27/%3E%3C/g%3E%3C/defs%3E%3Cuse href=%27%23fl%27 transform=%27translate(60,70) scale(2.6)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(250,50) scale(1.7) rotate(12)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(330,120) scale(3) rotate(40)%27/%3E%3Cuse href=%27%23fl%27 transform=%27translate(180,190) scale(3.4) rotate(18)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(60,250) scale(1.4) rotate(-10)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(120,340) scale(2.2) rotate(-35)%27/%3E%3Cuse href=%27%23fl%27 transform=%27translate(330,300) scale(2.2) rotate(-25)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(300,215) scale(1.2) rotate(30)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(230,300) scale(1.8) rotate(70)%27/%3E%3C/svg%3E"); mask-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27380%27 height=%27380%27 viewBox=%270 0 380 380%27%3E%3Cdefs%3E%3Cg id=%27fl%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(72)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(144)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(216)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(288)%27/%3E%3Ccircle r=%273.1%27 fill=%27white%27 stroke=%27none%27/%3E%3C/g%3E%3Cg id=%27st%27%3E%3Cpath d=%27M0 -13 L3 -3 L13 0 L3 3 L0 13 L-3 3 L-13 0 L-3 -3Z%27 fill=%27white%27/%3E%3C/g%3E%3Cg id=%27lf%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M0 0 C7 -4 11 -13 8 -20 C2 -15 -2 -7 0 0Z%27/%3E%3Cpath d=%27M2.5 -3 L7 -15%27/%3E%3C/g%3E%3C/defs%3E%3Cuse href=%27%23fl%27 transform=%27translate(60,70) scale(2.6)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(250,50) scale(1.7) rotate(12)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(330,120) scale(3) rotate(40)%27/%3E%3Cuse href=%27%23fl%27 transform=%27translate(180,190) scale(3.4) rotate(18)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(60,250) scale(1.4) rotate(-10)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(120,340) scale(2.2) rotate(-35)%27/%3E%3Cuse href=%27%23fl%27 transform=%27translate(330,300) scale(2.2) rotate(-25)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(300,215) scale(1.2) rotate(30)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(230,300) scale(1.8) rotate(70)%27/%3E%3C/svg%3E");
    -webkit-mask-repeat:repeat; mask-repeat:repeat; -webkit-mask-size:380px 380px; mask-size:380px 380px; }
  .light .bg-doodles { color:#101010; opacity:.16; }

  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  html,body { height:100%; }
  body { font-family:'Funnel Display',sans-serif; background:#0a0a0a; color:var(--surface3); min-height:100vh; -webkit-font-smoothing:antialiased; overflow-x:hidden; }

  :root {
    --azzurro:#A3CFFE; --rosa:#FF6DEC; --giallo:#FDEF26; --verde:#339966; --rosso:#D41323;
    --neon-blue:#A3CFFE; --neon-pink:#FF6DEC; --neon-gold:#FDEF26; --neon-green:#339966;
    /* medaglie podio — oro/argento/bronzo realistici */
    --oro:#E8B923; --argento:#B8C4CE; --bronzo:#C87A3F;
    --nero:#101010; --bianco:#FFFFFF;
    --surface:rgba(18,18,18,0.92); --surface2:rgba(28,28,28,0.9); --surface3:rgba(38,38,38,0.85);
    --border:rgba(255,255,255,0.14); --border2:rgba(255,255,255,0.24);
    --text:var(--surface3); --text2:rgba(255,255,255,.65); --text3:rgba(255,255,255,.4);
    --accent:#A3CFFE; --accent2:#339966;
    --danger:#D41323; --warning:#FDEF26;
    --radius:14px; --radius-sm:10px; --radius-lg:20px;
    --glow-blue:0 0 14px rgba(163,207,254,0.25);
    --glow-pink:0 0 14px rgba(255,109,236,0.25);
  }

  /* ═══ GLOBAL GAME BG ═══ */
  body::before {
    content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
    background:
      radial-gradient(ellipse 80% 50% at 20% -10%, rgba(255,255,255,0) 0%, transparent 60%),
      radial-gradient(ellipse 60% 40% at 90% 110%, rgba(255,255,255,0) 0%, transparent 55%),
      radial-gradient(ellipse 50% 60% at 50% 50%, rgba(0,0,0,0) 0%, transparent 70%),
      #0a0a0a;
  }
  body::after {
    content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:
      linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
    background-size:40px 40px;
  }

  /* ═══ LOGIN ═══ */
  .login-wrap { display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; position:relative; z-index:1; }
  .login-card {
    background:rgba(16,16,16,0.95); border:1px solid rgba(163,207,254,0.3);
    border-radius:20px; padding:36px 28px; width:100%; max-width:420px;
    box-shadow:0 0 0 1px rgba(163,207,254,0.08), var(--glow-blue), 0 40px 80px rgba(0,0,0,0.8);
    backdrop-filter:blur(20px); position:relative; overflow:hidden;
  }
  .login-card::before {
    content:''; position:absolute; top:0; left:0; right:0; height:2px;
    background:var(--azzurro);
  }
  .login-title {
    font-family:'Funnel Display',sans-serif; font-weight:900; font-size:56px;
    text-transform:uppercase; letter-spacing:-1px; line-height:0.9;
    background:var(--azzurro) 100%);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
    text-align:center; margin-bottom:8px; filter:drop-shadow(0 0 20px rgba(163,207,254,0.3));
  }
  .login-sub { font-size:12px; color:var(--text3); text-align:center; margin-bottom:28px; letter-spacing:.15em; text-transform:uppercase; }
  .login-tabs { display:flex; background:rgba(163,207,254,0.05); border:1px solid var(--border); border-radius:12px; padding:4px; margin-bottom:24px; gap:4px; }
  .login-tab { flex:1; padding:10px; border-radius:9px; border:none; cursor:pointer; font-family:'Funnel Display'; font-size:13px; font-weight:700; background:transparent; color:var(--text2); transition:all .2s; }
  .login-tab.active { background:#FDEF26; color:#101010; border:2px solid #101010; border-color:rgba(16,16,16,0.3); box-shadow:var(--glow-blue); }
  .form-group { margin-bottom:16px; }
  .form-input:focus + .form-hint, .form-input:focus ~ .form-hint { color: var(--neon-blue); }
  .form-hint { font-size:11px; color:var(--text3); margin-top:4px; }
  .form-label { font-size:10px; font-weight:700; color:var(--text3); margin-bottom:5px; display:block; text-transform:uppercase; letter-spacing:.15em; }
  .form-input {
    width:100%; padding:13px 16px; background:rgba(163,207,254,0.04); border:1px solid var(--border2);
    border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display',sans-serif;
    font-size:16px; outline:none; transition:all .2s;
  }
  .form-input:focus { border-color:var(--neon-blue); background:rgba(163,207,254,0.08); box-shadow:0 0 0 3px rgba(163,207,254,0.1), var(--glow-blue); }
  .pin-input { text-align:center; font-family:'Funnel Display',sans-serif; font-size:40px; font-weight:900; letter-spacing:14px; color:var(--neon-blue); }
  .err-msg { font-size:12px; color:var(--danger); margin-top:10px; text-align:center; font-weight:700; letter-spacing:.05em; }

  /* ═══ NICKNAME SEARCH ═══ */
  .nickname-list { max-height:220px; overflow-y:auto; border:1px solid var(--border2); border-radius:var(--radius-sm); margin-top:6px; background:rgba(16,16,16,0.98); }
  .nickname-item { padding:12px 14px; cursor:pointer; font-size:14px; font-weight:600; color:var(--text); border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; transition:background .15s; }
  .nickname-item:hover { background:rgba(163,207,254,0.08); }
  .nickname-item:last-child { border-bottom:none; }

  /* ═══ BUTTONS ═══ */
  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:6px;
    padding:10px 18px; border-radius:var(--radius-sm); border:none; cursor:pointer;
    font-family:'Funnel Display',sans-serif; font-size:14px; font-weight:700;
    transition:all .15s; white-space:nowrap; min-height:44px; letter-spacing:.03em; position:relative;
  }
  .btn-primary { background:#101010; color:#FDEF26; border:none; border-radius:9px; font-weight:800; text-transform:uppercase; box-shadow:2px 2px 0 rgba(0,0,0,.3); }
  body:not(.light) .btn-primary { background:#FDEF26; color:#101010; }
  .btn-primary:active { transform:scale(.97); opacity:.9; }
  .btn-ghost { background:rgba(163,207,254,0.06); color:var(--text2); border:1px solid var(--border2); border-radius:10px; }
  .btn-ghost:active { background:rgba(163,207,254,0.12); }
  .btn-danger { background:rgba(255,34,68,.12); color:var(--rosso); border:1px solid rgba(255,34,68,.3); }
  .btn-yellow {
    background:#FDEF26;
    background-size:200% 100%; color:#101010; font-weight:900;
    border:1px solid rgba(253,239,38,0.5); box-shadow:var(--glow-gold);
    text-transform:uppercase; letter-spacing:.06em;
  }
  .btn-sm { padding:7px 14px; font-size:12px; min-height:36px; }
  .btn-xs { padding:5px 10px; font-size:11px; min-height:30px; border-radius:8px; }

  /* ═══ EDUCATOR DESKTOP ═══ */
  .edu-layout { display:flex; min-height:100vh; position:relative; z-index:1; background:#0a0a0a; --dead:linear-gradient(160deg,#1a0e55 0%,#122a7a 50%,#1f0e5a 100%); } /* pug-ok: gradiente fondo notte */
  .sidebar { width:240px; background:#0d0d0d; border-right:1px solid #2a2a2a; display:flex; flex-direction:column; position:fixed; top:0; left:0; height:100vh; overflow-y:auto; z-index:10; backdrop-filter:blur(24px); }
  .sidebar-logo { padding:20px 18px 16px; border-bottom:1px solid rgba(255,255,255,.08); }
  .sidebar-logo-box { background:var(--rosso); border-radius:9px 12px 9px 14px; padding:5px 11px; display:inline-block; box-shadow:2px 3px 0 rgba(0,0,0,.3); transform:rotate(-1deg); }
  .sidebar-logo-t { font-family:'Funnel Display',sans-serif; font-weight:900; font-size:15px; text-transform:uppercase; color:#111; line-height:1.05; letter-spacing:-.3px; }
  .sidebar-logo-sub { font-family:'Funnel Display',sans-serif; background:#111; color:var(--giallo); font-size:8px; font-weight:900; border-radius:4px; padding:2px 7px; text-transform:uppercase; letter-spacing:.07em; margin-top:3px; display:inline-block; }
  .sidebar-badge { display:inline-flex; align-items:center; gap:5px; background:rgba(253,239,38,.12); border:1px solid rgba(253,239,38,.25); border-radius:99px; padding:3px 10px; font-size:9px; font-weight:800; color:#FDEF26; text-transform:uppercase; letter-spacing:.06em; margin-top:8px; }
  .nav { flex:1; padding:8px 0; }
  .nav-item { display:flex; align-items:center; gap:10px; padding:9px 18px; cursor:pointer; font-size:13px; font-weight:600; color:rgba(255,255,255,.38); border-left:2px solid transparent; transition:all .12s; min-height:42px; border-radius:0 10px 10px 0; margin:1px 8px 1px 0; }  /* pug-ok: testo su fondo nero */
  .nav-item:hover { background:rgba(255,255,255,.05); color:rgba(255,255,255,.75); }  /* pug-ok: testo su fondo nero */
  .nav-item.active { background:rgba(253,239,38,.1); color:#FDEF26; border-left-color:#FDEF26; font-weight:700; box-shadow:inset 0 0 20px rgba(253,239,38,.05); }
  .nav-icon { font-size:16px; width:22px; text-align:center; flex-shrink:0; }
  .sidebar-user { padding:14px 18px; border-top:1px solid rgba(255,255,255,.08); }
  .edu-main { margin-left:240px; flex:1; display:flex; flex-direction:column; min-height:100vh; }
  .topbar { padding:12px 24px; background:#0d0d0d; border-bottom:1px solid #2a2a2a; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:5; backdrop-filter:blur(24px); }
  .topbar-title { font-family:'Funnel Display',sans-serif; font-weight:900; font-size:26px; text-transform:uppercase; color:#fff; letter-spacing:.05em; }
  .content { flex:1; padding:20px 24px; }

  /* ═══ MOBILE EDUCATOR ═══ */
  .mob-header { display:none; position:fixed; top:0; left:0; right:0; min-height:56px; background:#0d0d0d; border-bottom:1px solid #2a2a2a; z-index:20; align-items:center; padding:env(safe-area-inset-top,0px) 14px; gap:10px; backdrop-filter:blur(24px);  height:calc(56px + env(safe-area-inset-top,0px)); }
  .mob-header-title { font-family:'Funnel Display',sans-serif; font-weight:900; font-size:20px; text-transform:uppercase; color:#fff; flex:1; letter-spacing:.05em; }
  .mob-drawer-bg { position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:30; backdrop-filter:blur(6px); }
  .mob-drawer { position:fixed; top:0; left:0; bottom:0; width:270px; background:rgba(16,16,16,.97); border-right:1px solid rgba(255,255,255,.08); z-index:40; transform:translateX(-100%); transition:transform .25s; display:flex; flex-direction:column; backdrop-filter:blur(24px); }
  .mob-drawer.open { transform:translateX(0); }
  .mob-bottom-nav { display:none; position:fixed; bottom:0; left:0; right:0; padding-bottom:env(safe-area-inset-bottom,0px); background:#0d0d0d; border-top:1px solid #2a2a2a; z-index:20; padding-bottom:env(safe-area-inset-bottom,0px); backdrop-filter:blur(24px); }
  .mob-bottom-nav-inner { display:flex; height:60px; }
  .mob-nav-btn { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; background:none; border:none; cursor:pointer; color:rgba(255,255,255,.28); font-family:'Funnel Display'; padding:0; transition:color .15s; }  /* pug-ok: testo su fondo nero */
  .mob-nav-btn.active { color:#FDEF26; }
  .mob-nav-btn { transition:color .2s; }

  /* ═══ SECTION BANNERS ═══ */
  .section-banner { padding:14px 8px 4px; margin-bottom:14px; position:relative; display:flex; align-items:center; justify-content:center; }
  .section-banner-content { text-align:center; }
  .section-banner-bg { position:absolute; inset:0; background-size:cover; background-position:center; }
  .section-banner-overlay { position:absolute; inset:0; background:rgba(0,0,0,.45); }
  .section-banner-content { position:relative; z-index:1; flex:1; }
  .section-banner-title { font-family:'Funnel Display',sans-serif; font-weight:800; font-size:26px; text-transform:uppercase; color:#fff !important; letter-spacing:.02em; line-height:1; text-shadow:none; }
  .light .section-banner-title { color:#101010 !important; }
  .section-banner-sub { font-size:12px; color:var(--text2); margin-top:2px; }

  /* ═══ GAME CARDS ═══ */
  .card { background:#ffffff; border:3px solid #101010; border-radius:16px 20px 14px 22px; box-shadow:4px 4px 0 #101010; padding:16px; margin-bottom:12px; position:relative; z-index:2; }
  body:not(.light) .card { background:#17181c; border-color:#33353c; box-shadow:4px 4px 0 #000; color:#f0f0f0; }
  .card-sm { background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.08); border-radius:var(--radius-sm); padding:12px 14px; }
  .stats-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:18px; }
  .stat-card { background:#ffffff; border:3px solid #101010; border-radius:16px 20px 14px 22px; box-shadow:4px 4px 0 #101010; border-radius:15px 18px 13px 17px; padding:14px; position:relative; z-index:2; }
  body:not(.light) .stat-card { background:#17181c; border-color:#33353c; box-shadow:4px 4px 0 #000; color:#f0f0f0; }
  .stat-card::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:rgba(253,239,38,.4); }
  .stat-label { font-size:10px; color:var(--text3); text-transform:uppercase; letter-spacing:.12em; margin-bottom:4px; font-weight:700; }
  .stat-value { font-family:'Funnel Display',sans-serif; font-size:36px; font-weight:900; color:var(--text); line-height:1; }

  /* ═══ PLAYER GRID ═══ */
  .player-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px; }
  .player-card {
    background:rgba(10,22,48,0.9); border:1px solid var(--border);
    border-radius:var(--radius); padding:14px 10px; text-align:center;
    cursor:pointer; position:relative; transition:all .15s;
  }
  .player-card:hover { border-color:rgba(163,207,254,0.3); transform:translateY(-2px); }
  .player-card.selected { border-color:var(--neon-blue); background:rgba(163,207,254,0.08); box-shadow:var(--glow-blue); }
  .avatar-wrap { width:56px; height:56px; border-radius:50%; margin:0 auto 10px; overflow:hidden; display:flex; align-items:center; justify-content:center; font-size:26px; border:2px solid rgba(163,207,254,0.25); }
  .avatar-wrap img { width:100%; height:100%; object-fit:cover; }
  .p-name { font-size:12px; font-weight:700; color:var(--text); margin-bottom:2px; word-break:break-word; line-height:1.3; }
  .p-level { font-size:10px; color:var(--text3); margin-bottom:3px; }
  .p-xp { font-family:'Funnel Display',sans-serif; font-size:16px; font-weight:900; color:var(--neon-blue); }
  .p-coin { font-size:10px; color:var(--neon-gold); margin-top:1px; }
  .squad-pill { font-size:9px; padding:2px 8px; border-radius:99px; display:inline-block; margin-top:5px; font-weight:700; }
  .pts-row { display:flex; gap:4px; justify-content:center; margin-top:8px; }
  .pts-btn { width:30px; height:30px; border-radius:50%; border:1px solid var(--border2); background:rgba(163,207,254,0.05); cursor:pointer; font-size:15px; display:flex; align-items:center; justify-content:center; color:var(--text2); line-height:1; transition:all .12s; }
  .pts-btn.add { color:var(--neon-green); border-color:rgba(51,153,102,.3); }
  .pts-btn.rem { color:var(--danger); border-color:rgba(255,34,68,.3); }

  /* ═══ LEADERBOARD ═══ */
  .lb-list { display:flex; flex-direction:column; gap:6px; }
  .lb-row {
    display:flex; align-items:center; gap:8px;
    background:rgba(16,16,16,0.9); border:1px solid var(--border);
    border-radius:12px; padding:10px 12px; transition:all .15s; position:relative; overflow:hidden;
  }
  .lb-row::before { content:''; position:absolute; left:0; top:0; bottom:0; width:2px; background:var(--border); }
  .lb-rank { font-family:'Funnel Display',sans-serif; font-size:18px; font-weight:900; width:26px; text-align:center; color:var(--text3); flex-shrink:0; }
  .lb-rank.gold { color:var(--neon-gold); text-shadow:0 0 16px rgba(253,239,38,0.7); }
  .lb-rank.silver { color:var(--argento); }
  .lb-rank.bronze { color:var(--bronzo); }
  .lb-row:nth-child(1) { border-color:rgba(253,239,38,0.25); box-shadow:0 0 20px rgba(253,239,38,0.08); }
  .lb-row:nth-child(1)::before { background:var(--oro); }
  .lb-row:nth-child(2) { border-color:rgba(170,200,224,0.2); }
  .lb-row:nth-child(2)::before { background:var(--text3); }
  .lb-row:nth-child(3) { border-color:rgba(212,145,106,0.2); }
  .lb-row:nth-child(3)::before { background:var(--bronzo); }
  .lb-av { width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0; overflow:hidden; border:1.5px solid var(--border2); }
  .lb-av img { width:100%; height:100%; object-fit:cover; }
  .lb-name { flex:1; font-size:13px; font-weight:700; color:var(--text); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .lb-level { font-size:9px; color:var(--text3); margin-top:1px; }
  .lb-xp { font-family:'Funnel Display',sans-serif; font-size:18px; font-weight:900; color:var(--neon-blue); flex-shrink:0; }

  /* ═══ PLAYER DETAIL ═══ */
  .player-detail { background:rgba(16,16,16,0.95); border:1px solid rgba(163,207,254,0.25); border-radius:var(--radius-lg); padding:20px; margin-top:12px; box-shadow:var(--glow-blue); }
  .player-detail-header { display:flex; gap:16px; align-items:center; margin-bottom:16px; }
  .player-detail-av { width:64px; height:64px; border-radius:50%; overflow:hidden; border:2px solid var(--neon-blue); display:flex; align-items:center; justify-content:center; font-size:30px; flex-shrink:0; box-shadow:var(--glow-blue); }
  .player-detail-av img { width:100%; height:100%; object-fit:cover; }
  .detail-tabs { display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
  .detail-tab { padding:6px 14px; border-radius:99px; border:1px solid var(--border2); background:transparent; color:var(--text2); font-family:'Funnel Display'; font-size:12px; font-weight:600; cursor:pointer; min-height:32px; transition:all .15s; }
  .detail-tab.active { background:rgba(255,255,255,0); color:var(--neon-blue); border-color:rgba(163,207,254,0.4); box-shadow:var(--glow-blue); }

  /* ═══ FILTER / CHIPS ═══ */
  .filter-bar { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
  .search-inp { padding:10px 16px; background:rgba(163,207,254,0.05); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:15px; outline:none; flex:1; min-width:140px; transition:all .15s; }
  .search-inp:focus { border-color:var(--neon-blue); box-shadow:0 0 0 3px rgba(163,207,254,0.1); }
  .chip { font-weight:800; font-size:12px; text-transform:uppercase; background:#ffffff !important; border:2.5px solid #101010 !important; border-radius:99px; padding:7px 13px 5px; color:#101010 !important; box-shadow:2px 2px 0 #101010; cursor:pointer; }
  body:not(.light) .chip { background:#17181c !important; border-color:#000 !important; color:#ccc !important; box-shadow:2px 2px 0 #000; }
  .chip.active { background:#101010 !important; color:#FDEF26 !important; border-color:#101010 !important; box-shadow:2px 2px 0 rgba(0,0,0,.35); }
  body:not(.light) .chip.active { background:#FDEF26 !important; color:#101010 !important; }

  /* ═══ BATCH ═══ */
  .batch-panel { background:rgba(163,207,254,0.05); border:1px solid rgba(163,207,254,0.2); border-radius:var(--radius); padding:12px 16px; margin-bottom:14px; }
  .batch-info { font-size:13px; color:var(--neon-blue); font-weight:700; margin-bottom:10px; }
  .batch-inp { width:70px; padding:8px 10px; background:rgba(163,207,254,0.08); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:18px; font-weight:700; outline:none; text-align:center; }

  /* ═══ PRESENZE ═══ */
  .pres-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border-radius:var(--radius); border:1px solid var(--border); }
  .pres-table { width:100%; border-collapse:collapse; font-size:13px; min-width:420px; }
  .pres-table th { padding:10px 12px; text-align:left; font-size:10px; font-weight:700; color:var(--text3); border-bottom:1px solid var(--border); text-transform:uppercase; letter-spacing:.1em; background:rgba(10,10,10,0.95); }
  .pres-table td { padding:10px 12px; border-bottom:1px solid var(--border); color:var(--text); }
  .pres-dot { width:32px; height:32px; border-radius:8px; border:none; cursor:pointer; font-size:13px; display:inline-flex; align-items:center; justify-content:center; font-weight:700; transition:all .12s; }
  /* Toggle presenza: variabili per light/dark */
  :root {
    --pt-empty-bg:     rgba(255,255,255,.07);
    --pt-empty-color:  rgba(255,255,255,.3);
    --pt-empty-border: 1.5px solid rgba(255,255,255,.18);
    --pt-done-bg:      rgba(51,153,102,.18);
    --pt-done-color:   #339966;
    --pt-done-border:  1.5px solid rgba(51,153,102,.4);
  }
  .light {
    --surface:#ffffff; --surface2:#ffffff; --surface3:var(--surface3);
    --border:rgba(16,16,16,.2); --border2:rgba(16,16,16,.35);
    --text:#101010; --text2:rgba(16,16,16,.62); --text3:rgba(16,16,16,.45);
    --glow-blue:none; --glow-pink:none;
    --pt-empty-bg:     #ffffff;
    --pt-empty-color:  var(--text3);
    --pt-empty-border: 2px solid var(--text3);
    --pt-done-bg:      var(--surface3);
    --pt-done-color:   var(--verde);
    --pt-done-border:  2px solid var(--verde);
  }
  .pres-toggle { width:40px; height:40px; border-radius:10px; cursor:pointer; font-size:18px; font-weight:900; transition:all .15s; display:inline-flex; align-items:center; justify-content:center; }
  .pres-toggle.done  { background:var(--pt-done-bg);  color:var(--pt-done-color);  border:var(--pt-done-border);  box-shadow:0 0 10px rgba(51,153,102,.2); }
  .pres-toggle.empty { background:var(--pt-empty-bg); color:var(--pt-empty-color); border:var(--pt-empty-border); box-shadow:none; }
  .light .pres-toggle.done  { box-shadow:0 2px 8px rgba(46,125,50,.2); }
/* Presenze: toggle pieno (non translucido) in notte + dimensione fissa (non si riduce) */
body:not(.light){--pt-empty-bg:#17181c;--pt-empty-color:rgba(255,255,255,.55);--pt-empty-border:2px solid #33353c;--pt-done-bg:#1c2b22;--pt-done-color:#4ade80;--pt-done-border:2px solid #339966}
.pres-toggle,.pres-toggle.done,.pres-toggle.empty{box-sizing:border-box!important;width:42px!important;height:42px!important;flex-shrink:0!important}
  .pd-yes { background:rgba(51,153,102,.15); color:var(--neon-green); border:1px solid rgba(51,153,102,.3); }
  .pd-partial { background:rgba(253,239,38,.12); color:var(--neon-gold); border:1px solid rgba(253,239,38,.25); }
  .pd-completed { background:rgba(51,153,102,.25); color:#339966; border:1px solid rgba(51,153,102,.4); }
  .pd-none { background:rgba(255,255,255,.04); color:var(--text3); border:1px solid var(--border); }

  /* ═══ ACTIVITIES ═══ */
  .act-grid { display:grid; grid-template-columns:1fr; gap:10px; }
  .act-card {
    background:rgba(0,80,40,0.08); border:1px solid rgba(51,153,102,0.15);
    border-radius:var(--radius); padding:16px; position:relative;
    transition:all .15s;
    overflow:hidden; word-break:break-word;
  }
  .act-title, .act-meta { overflow-wrap:anywhere; }
  .act-card:hover { border-color:rgba(51,153,102,0.3); box-shadow:var(--glow-green); }
  .act-title { font-family:'Funnel Display',sans-serif; font-size:22px; font-weight:900; text-transform:uppercase; color:var(--text); margin-bottom:4px; letter-spacing:.02em; }
  .act-meta { font-size:12px; color:var(--text2); margin-bottom:10px; }
  .act-rewards { display:flex; gap:6px; flex-wrap:wrap; }
  .reward-tag { font-size:10px; padding:4px 12px; border-radius:6px; font-weight:700; letter-spacing:.04em; }
  .xp-tag { background:rgba(163,207,254,0.12); color:var(--neon-blue); border:1px solid rgba(163,207,254,0.2); }
  .coin-tag { background:rgba(253,239,38,0.1); color:var(--neon-gold); border:1px solid rgba(253,239,38,0.2); }
  .delete-btn { position:absolute; top:10px; right:10px; width:28px; height:28px; border-radius:6px; border:1px solid rgba(255,34,68,.3); background:rgba(255,34,68,.08); color:var(--rosso); cursor:pointer; font-size:13px; display:flex; align-items:center; justify-content:center; transition:all .12s; }
  .delete-btn:hover { background:rgba(255,34,68,.2); }

  /* ═══ BADGES ═══ */
  .badge-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:18px; }
  .badge-card {
    background:rgba(80,0,80,0.08); border:1px solid rgba(255,0,204,0.15);
    border-radius:var(--radius); padding:18px 14px; text-align:center;
    cursor:pointer; position:relative; transition:all .2s;
  }
  .badge-card:hover { border-color:rgba(255,0,204,0.4); box-shadow:var(--glow-pink); transform:translateY(-3px) scale(1.02); }
  .badge-img { width:120px; height:120px; border-radius:14px; object-fit:contain; margin:0 auto 14px; display:block; border:3px solid rgba(255,0,204,0.5); box-shadow:0 0 20px rgba(255,0,204,0.35); }
  .badge-emoji { font-size:88px; display:block; margin:0 auto 14px; line-height:1; }
  .badge-name { font-size:14px; font-weight:700; color:var(--text); line-height:1.3; }
  .badge-pts { font-size:10px; color:var(--rosa); margin-top:3px; font-weight:700; }

  /* ═══ SFIDA ═══ */
  .sfida-card {
    border-radius:var(--radius-lg); padding:20px; margin-bottom:14px;
    position:relative; overflow:hidden;
    border:1px solid rgba(255,34,68,0.35);
    background:rgba(80,0,20,0.15);
    box-shadow:0 0 30px rgba(255,34,68,0.12), inset 0 1px 0 rgba(255,34,68,0.15);
  }
  .sfida-card::before {
    content:''; position:absolute; top:0; left:0; right:0; height:2px;
    background:var(--rosso);
  }
  .sfida-label { font-family:'Funnel Display',sans-serif; font-size:11px; font-weight:900; text-transform:uppercase; color:var(--danger); letter-spacing:.18em; margin-bottom:6px; }
  .sfida-title { font-family:'Funnel Display',sans-serif; font-size:26px; font-weight:900; text-transform:uppercase; color:#fff; margin-bottom:6px; letter-spacing:.02em; text-shadow:0 0 20px rgba(255,34,68,0.3); }
  .sfida-desc { font-size:13px; color:rgba(255,255,255,.6); margin-bottom:12px; line-height:1.5; }  /* pug-ok: testo su fondo nero */
  .sfida-reward { display:inline-flex; align-items:center; gap:6px; background:rgba(253,239,38,0.12); border:1px solid rgba(253,239,38,0.3); border-radius:8px; padding:6px 14px; font-size:12px; font-weight:800; color:var(--neon-gold); letter-spacing:.04em; }

  /* ═══ DIARIO ═══ */
  .diary-day { margin-bottom:18px; }
  .diary-date { font-family:'Funnel Display',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--neon-blue); margin-bottom:8px; letter-spacing:.05em; }
  .diary-entry { display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:5px; }
  .diary-icon { font-size:18px; flex-shrink:0; }
  .diary-text { flex:1; font-size:13px; color:var(--text); line-height:1.4; }
  .diary-pts { font-family:'Funnel Display',sans-serif; font-size:18px; font-weight:900; color:var(--neon-blue); flex-shrink:0; }

  /* ═══ MODAL ═══ */
  .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:100; display:flex; align-items:flex-end; justify-content:center; backdrop-filter:blur(8px); }
  .modal { background:#ffffff; border:3px solid #101010; border-radius:18px 22px 16px 24px; box-shadow:6px 6px 0 #101010; padding:22px; width:100%; max-width:460px; max-height:88vh; overflow-y:auto; color:#101010; }
  body:not(.light) .modal { background:#17181c; border-color:#33353c; box-shadow:6px 6px 0 #000; color:#f0f0f0; }
  .modal::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; background:var(--azzurro); border-radius:20px 20px 0 0; }
  .modal-title { font-family:'Funnel Display',sans-serif; font-size:30px; font-weight:900; text-transform:uppercase; color:var(--text); margin-bottom:18px; letter-spacing:.04em; }
  .section-label { font-size:10px; font-weight:700; color:var(--text3); text-transform:uppercase; letter-spacing:.15em; margin:16px 0 8px; }

  /* ═══ PROFILE HERO ═══ */
  .profile-hero {
    border-radius:var(--radius-lg); margin-bottom:14px; overflow:hidden;
    position:relative;
    background:#141414;
    border:1px solid rgba(163,207,254,0.2);
    box-shadow:var(--glow-blue), 0 20px 60px rgba(0,0,0,0.6);
  }
  .profile-hero::before {
    content:''; position:absolute; inset:0;
    background:
      radial-gradient(ellipse 80% 60% at 50% -20%, rgba(255,255,255,0) 0%, transparent 60%),
      radial-gradient(ellipse 50% 40% at 100% 100%, rgba(255,255,255,0) 0%, transparent 50%);
    pointer-events:none;
  }
  .profile-hero-bg { position:absolute; inset:0; pointer-events:none; }
  .profile-hero-inner { padding:32px 20px 24px; position:relative; z-index:1; text-align:center; }
  .profile-avatar {
    width:120px; height:120px; border-radius:50%; margin:0 auto 16px;
    display:flex; align-items:center; justify-content:center; font-size:56px; overflow:hidden;
    position:relative;
    border:2px solid transparent;
    background:#141414; border-color:#A3CFFE;
    box-shadow:0 0 0 1px rgba(255,255,255,0.05), 0 0 40px rgba(163,207,254,0.3), 0 0 80px rgba(163,207,254,0.1), 0 16px 40px rgba(0,0,0,0.6);
  }
  .profile-avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
  .profile-avatar-ring {
    position:absolute; inset:-4px; border-radius:50%;
    border:1px solid transparent;
    background:#101010; border-color:#FF6DEC;
    animation:spin 4s linear infinite; opacity:0.6;
  }
  @keyframes spin { to { transform:rotate(360deg); } }
  .profile-name {
    font-family:'Funnel Display',sans-serif; font-size:38px; font-weight:900;
    text-transform:uppercase; letter-spacing:1px; color:#fff; margin-bottom:4px;
    text-shadow:0 0 30px rgba(163,207,254,0.4);
  }
  .profile-firstname { font-size:13px; color:rgba(255,255,255,.45); margin-bottom:8px; letter-spacing:.08em; }  /* pug-ok: testo su fondo nero */
  .profile-level {
    font-size:12px; font-weight:700; display:inline-flex; align-items:center; gap:6px;
    background:rgba(163,207,254,0.1); border:1px solid rgba(163,207,254,0.25);
    border-radius:99px; padding:5px 16px; color:var(--neon-blue); margin-bottom:14px;
    letter-spacing:.06em; text-transform:uppercase;
  }
  .profile-stats-row { display:flex; justify-content:center; gap:0; }
  .profile-stat { flex:1; text-align:center; padding:14px 8px; border-right:1px solid rgba(255,255,255,0.06); }
  .profile-stat:last-child { border-right:none; }
  .profile-stat-val { font-family:'Funnel Display',sans-serif; font-size:32px; font-weight:900; line-height:1; }
  .profile-stat-lbl { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:var(--text3); margin-top:3px; }
  .profile-xp-section { padding:0 20px 22px; position:relative; z-index:1; }
  .xp-bar-wrap { height:8px; background:rgba(255,255,255,.07); border-radius:99px; overflow:hidden; margin:10px 0 4px; }
  .xp-bar { height:100%; background:var(--verde); border-radius:99px; transition:width .6s cubic-bezier(.4,0,.2,1); box-shadow:0 0 12px rgba(163,207,254,0.5); }
  .xp-label { display:flex; justify-content:space-between; font-size:10px; color:var(--text3); font-weight:700; letter-spacing:.06em; }

  /* ═══ QR ═══ */
  .qr-code { font-family:'Funnel Display',sans-serif; font-size:52px; font-weight:900; color:var(--neon-blue); letter-spacing:10px; margin:16px 0; text-shadow:var(--glow-blue); }

  /* ═══ AVATAR UPLOAD ═══ */
  .avatar-upload-area { border:2px dashed rgba(163,207,254,0.25); border-radius:var(--radius); padding:20px; text-align:center; cursor:pointer; margin-bottom:12px; transition:all .15s; }
  .avatar-upload-area:hover { border-color:rgba(163,207,254,0.5); background:rgba(163,207,254,0.04); }
  .avatar-preview { width:80px; height:80px; border-radius:50%; object-fit:cover; margin:0 auto 8px; display:block; border:2px solid var(--neon-blue); box-shadow:var(--glow-blue); }

  /* ═══ THEME TOGGLE ═══ */
  .theme-toggle { width:44px; height:24px; border-radius:99px; border:1px solid var(--border2); cursor:pointer; position:relative; transition:background .2s; display:flex; align-items:center; padding:0 3px; background:rgba(163,207,254,0.08); }
  .theme-toggle-knob { width:18px; height:18px; border-radius:50%; background:var(--neon-blue); transition:transform .2s; box-shadow:var(--glow-blue); }

  /* ═══ MISC ═══ */
  .tag { font-size:11px; padding:3px 10px; border-radius:6px; display:inline-block; font-weight:700; letter-spacing:.04em; }
  .tag-green { background:rgba(51,153,102,.1); color:var(--neon-green); border:1px solid rgba(51,153,102,.2); }
  .tag-blue { background:rgba(163,207,254,.1); color:var(--neon-blue); border:1px solid rgba(163,207,254,.2); }
  .tag-amber { background:rgba(253,239,38,.1); color:var(--neon-gold); border:1px solid rgba(253,239,38,.2); }
  .tag-red { background:rgba(255,34,68,.1); color:var(--rosso); border:1px solid rgba(255,34,68,.2); }
  .tag-gray { background:rgba(255,255,255,.05); color:var(--text2); border:1px solid var(--border); }
  .loading { display:flex; align-items:center; justify-content:center; min-height:160px; color:var(--text2); font-size:14px; gap:8px; }
  .empty { text-align:center; padding:40px 20px; color:var(--text3); font-size:14px; }
  select { padding:10px 12px; background:rgba(163,207,254,0.05); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:15px; outline:none; width:100%; }
  textarea { width:100%; padding:10px 14px; background:rgba(163,207,254,0.04); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:14px; outline:none; resize:vertical; min-height:80px; transition:all .15s; }
  textarea:focus { border-color:var(--neon-blue); box-shadow:0 0 0 3px rgba(163,207,254,0.08); }
  .color-swatch-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
  .color-swatch { width:36px; height:36px; border-radius:50%; border:3px solid transparent; cursor:pointer; transition:border-color .12s; }
  .color-swatch.active { border-color:var(--neon-blue); box-shadow:var(--glow-blue); }
  .squad-list { display:flex; flex-direction:column; gap:8px; }
  .squad-row { display:flex; align-items:center; gap:12px; background:rgba(16,16,16,0.9); border:1px solid var(--border); border-radius:var(--radius-sm); padding:14px 16px; }
  .squad-color-dot { width:16px; height:16px; border-radius:50%; flex-shrink:0; }
  .squad-name { flex:1; font-family:'Funnel Display',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--text); }

  /* ═══ MESSAGES ═══ */
  .msg-layout { display:flex; gap:12px; height:440px; }
  .msg-list { width:150px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; flex-shrink:0; }
  .msg-thread { background:rgba(16,16,16,0.9); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px 12px; cursor:pointer; transition:all .15s; }
  .msg-thread.active { border-color:rgba(163,207,254,0.4); background:rgba(163,207,254,0.08); box-shadow:0 0 12px rgba(163,207,254,0.1); }
  .mt-name { font-size:12px; font-weight:700; color:var(--text); }
  .msg-main { flex:1; display:flex; flex-direction:column; background:rgba(16,16,16,0.9); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; min-width:0; }
  .msg-hdr { padding:12px 16px; border-bottom:1px solid var(--border); font-weight:700; font-size:14px; color:var(--text); background:rgba(163,207,254,0.04); }
  .msg-body { flex:1; padding:14px 16px; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
  .bubble-wrap { display:flex; gap:8px; }
  .bubble-wrap.mine { flex-direction:row-reverse; }
  .bubble-av { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; flex-shrink:0; background:rgba(163,207,254,0.1); border:1px solid var(--border2); }
  .bubble { max-width:220px; padding:8px 12px; border-radius:12px; font-size:13px; line-height:1.5; }
  .bubble.them { background:rgba(255,255,255,.06); color:var(--text); border:1px solid var(--border); }
  .bubble.mine { background:rgba(163,207,254,.15); color:var(--neon-blue); border:1px solid rgba(163,207,254,.25); }
  .msg-inp-row { padding:10px 14px; border-top:1px solid var(--border); display:flex; gap:8px; background:rgba(163,207,254,0.02); }
  .msg-inp { flex:1; padding:10px 12px; background:rgba(163,207,254,0.06); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:14px; outline:none; }
  .notif-dot { width:8px; height:8px; border-radius:50%; background:var(--neon-pink); animation:pulse2 2s infinite; display:inline-block; margin-left:4px; vertical-align:middle; box-shadow:0 0 8px rgba(255,0,204,0.6); animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
  .notif-item { display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--border); }
  .notif-icon { font-size:24px; flex-shrink:0; }
  .notif-title { font-size:14px; font-weight:700; color:var(--text); margin-bottom:2px; }
  .notif-body { font-size:13px; color:var(--text2); }
  .notif-time { font-size:11px; color:var(--text3); margin-top:3px; }

  /* ═══ PIN DISPLAY ═══ */
  .pin-display { font-family:'Funnel Display',sans-serif; font-size:28px; font-weight:900; color:var(--neon-blue); letter-spacing:6px; background:rgba(163,207,254,0.08); border:1px solid rgba(163,207,254,0.2); border-radius:8px; padding:8px 16px; display:inline-block; box-shadow:var(--glow-blue); }

  /* ═══ PLAYER BOTTOM NAV ═══ */
  .player-bottom-nav {
    position:fixed; bottom:0; left:0; right:0;
    background:rgba(10,10,10,0.97); border-top:1px solid rgba(255,255,255,0);
    z-index:20; display:flex; padding-bottom:env(safe-area-inset-bottom,0px);
    backdrop-filter:blur(20px);
  }
  .player-nav-btn {
    flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:4px; padding:10px 0; background:none; border:none; cursor:pointer;
    color:var(--text3); font-family:'Funnel Display'; position:relative; transition:color .15s;
  }
  .player-nav-btn.active { color:var(--neon-blue); }
  .player-nav-btn.active::after {
    content:''; position:absolute; bottom:0; left:15%; right:15%; height:2px;
    background:var(--neon-blue); border-radius:99px;
    box-shadow:0 0 8px var(--neon-blue);
  }
  .player-nav-icon { font-size:20px; line-height:1; }
  .player-nav-label { font-size:8px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }

  /* ═══ RESPONSIVE ═══ */
  @media (min-width:768px) {
    .stats-grid { grid-template-columns:repeat(4,1fr); }
    .act-grid { grid-template-columns:1fr 1fr; }
    .modal-bg { align-items:center; }
    .modal { border-radius:20px; }
    .lb-av { width:40px; height:40px; font-size:20px; }
    .lb-rank { font-size:22px; width:32px; }
    .lb-name { font-size:14px; }
    .lb-xp { font-size:22px; }
    .lb-row { gap:12px; padding:12px 14px; }
  }
  @media (max-width:767px) {
    .sidebar { display:none; }
    .edu-main { margin-left:0; overflow-x:hidden; }
    .edu-layout { overflow-x:hidden; }
    .topbar { display:none; }
    .content { padding:12px; overflow-x:hidden; }
    .mob-header { display:flex; }
    .mob-bottom-nav { display:block; }
    .edu-content-wrap { padding-top:calc(58px + env(safe-area-inset-top,0px)); padding-bottom:calc(62px + env(safe-area-inset-bottom,0px) + 8px); overflow-x:hidden; }
    .player-grid { grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; }
    .msg-layout { flex-direction:column; height:auto; }
    .msg-list { width:100%; flex-direction:row; overflow-x:auto; flex-wrap:nowrap; padding-bottom:4px; height:auto; }
    .msg-thread { flex-shrink:0; width:130px; }
    .msg-main { height:340px; }
    .stats-grid { grid-template-columns:repeat(2,1fr) !important; }
    .lb-list { width:100%; }
  }

  /* ═══ PODIUM ═══ */
  .podium-wrap { display:flex; align-items:flex-end; gap:4px; margin:0 0 14px; padding:0 2px; overflow-x:auto; }
  .pod-col { flex:1; text-align:center; }
  .pod-crown { font-size:18px; margin-bottom:3px; display:block; }
  .pod-av-wrap { border-radius:50%; margin:0 auto 6px; overflow:hidden; display:flex; align-items:center; justify-content:center; position:relative; }
  .pod-name { font-family:'Funnel Display',sans-serif; font-size:12px; font-weight:900; text-transform:uppercase; color:#fff; letter-spacing:.03em; line-height:1.2; word-break:break-word; }
  .pod-xp { font-size:10px; font-weight:700; margin-top:2px; }
  .pod-base { border-radius:12px 12px 0 0; padding:8px 4px 6px; margin-top:6px; }
  .pod-1 .pod-av-wrap { width:68px; height:68px; border:3px solid #FDEF26; box-shadow:0 0 24px rgba(253,239,38,.45); }
  .pod-2 .pod-av-wrap { width:54px; height:54px; border:2px solid var(--argento); box-shadow:0 0 14px rgba(150,150,200,.35); }
  .pod-3 .pod-av-wrap { width:48px; height:48px; border:2px solid var(--bronzo); box-shadow:0 0 12px rgba(200,130,50,.3); }
  .pod-1 .pod-base { background:rgba(253,239,38,.08); border:1px solid rgba(253,239,38,.22); border-bottom:none; min-height:70px; }
  .pod-2 .pod-base { background:rgba(140,140,180,.06); border:1px solid rgba(140,140,180,.15); border-bottom:none; min-height:52px; }
  .pod-3 .pod-base { background:rgba(180,120,50,.06); border:1px solid rgba(180,120,50,.14); border-bottom:none; min-height:40px; }
  .pod-1 .pod-xp { color:#FDEF26; }
  .pod-2 .pod-xp { color:var(--argento); }
  .pod-3 .pod-xp { color:var(--bronzo); }

  /* ═══ STREAK ═══ */
  .streak-card { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(255,120,0,.25); border-radius:14px; padding:12px 14px; position:relative; z-index:2; }
  .streak-row { display:flex; gap:8px; }
  .streak-item { flex:1; text-align:center; }
  .streak-val { font-family:'Funnel Display',sans-serif; font-size:26px; font-weight:900; color:#D41323; line-height:1; display:block; }
  .streak-lbl { font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.1em; color:var(--text3); margin-top:2px; display:block; }
  .month-prog { margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.07); }
  .month-prog-lbl { display:flex; justify-content:space-between; font-size:9px; font-weight:900; color:rgba(255,255,255,.3); text-transform:uppercase; letter-spacing:.06em; margin-bottom:5px; }  /* pug-ok: testo su fondo nero */
  .month-prog-bg { height:7px; background:rgba(255,255,255,.07); border-radius:99px; overflow:hidden; }
  .month-prog-fill { height:100%; background:#FDEF26; border-radius:99px; }


  /* ═══ LIGHT MODE — Redesign sistematico ═══ */

  /* ─ Step 1: Override di tutte le variabili root ─ */
  .light {
    --neon-blue:  #A3CFFE;
    --neon-pink:  #FF6DEC;
    --neon-gold:  #FDEF26;
    --neon-green: #339966;
    --azzurro:    #A3CFFE;
    --rosa:       #FF6DEC;
    --giallo:     #FDEF26;
    --verde:      #339966;
    --rosso:      #D41323;
    --text:       #101010;
    --text2:      rgba(16,16,16,.66);
    --text3:      rgba(16,16,16,.45);
    --surface:    #FFFFFF;
    --surface2:   #FFFFFF;
    --surface3:   #F2F2EF;
    --border:     #101010;
    --border2:    #101010;
    --accent:     #A3CFFE;
    --accent2:    #339966;
    --danger:     #D41323;
    --warning:    #FDEF26;
    --glow-blue:  3px 3px 0 #101010;
    --glow-gold:  3px 3px 0 #101010;
    --glow-green: 3px 3px 0 #101010;
    --glow-pink:  3px 3px 0 #101010;
    --radius: 14px;
    --radius-sm: 10px;
    --radius-lg: 20px;
  }

  /* ─ Step 2: Base page ─ */
  .light body {
    background: var(--surface3);
    color: #101010;
  }
  .light body::before {
    background:
      radial-gradient(ellipse 80% 50% at 20% -10%, rgba(16,16,16,.08) 0%, transparent 60%),
      radial-gradient(ellipse 60% 40% at 90% 110%, rgba(212,19,35,.06) 0%, transparent 55%),
      var(--surface3);
  }
  .light body::after {
    background-image:
      linear-gradient(rgba(16,16,16,.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(16,16,16,.04) 1px, transparent 1px);
  }

  /* ─ Step 3: Educator layout ─ */
  .light .edu-layout { background: var(--surface3); }

  .light .topbar { background:#ffffff !important; border-bottom:3px solid #101010 !important; }
  .light .mob-header { background:#ffffff !important; border-bottom:3px solid #101010 !important; }
  .light .mob-header * { color:#101010; }
  .light .mob-bottom-nav { background:#101010 !important; border-top:none !important; }
  .light .mob-bottom-nav * { color:rgba(255,255,255,.55) !important; }  /* pug-ok: testo su fondo nero */
  .light .topbar * { color:#101010; }
  .light .sidebar {
    background: #ffffff;
    border-right: 2px solid #101010;
    box-shadow: none;
  }
  .light .sidebar-logo-box { background: transparent; }
  .light .sidebar * { color:#101010 !important; }
  .light .sidebar-user * { color:#101010 !important; }
  .light .sidebar .sidebar-badge { background:#FDEF26; border:2px solid #101010; color:#101010; }
  .light .sidebar .nav-item.active { background:#FDEF26 !important; color:#101010 !important; border:2px solid #101010; }
  .light .sidebar-user { border-top:2px solid #101010; }
  .light .sidebar-badge {
    background: rgba(100,160,255,.15);
    border-color: rgba(100,160,255,.3);
    color: var(--azzurro);
  }
  .light .nav-item { color: rgba(255,255,255,.38); }  /* pug-ok: testo su fondo nero */
  .light .nav-item:hover { background: rgba(255,255,255,.06); color: rgba(255,255,255,.75); }  /* pug-ok: testo su fondo nero */
  .light .nav-item.active {
    background: rgba(100,160,255,.12);
    color: var(--azzurro);
    border-left-color: var(--azzurro);
  }
  .light .nav-badge { background: var(--rosso); color: #fff; }
  .light .sidebar-user { border-top: 1px solid rgba(255,255,255,.08); }

  .light .topbar {
    background: rgba(18,18,18,.9);
    border-bottom: 1px solid rgba(255,255,255,.08);
    backdrop-filter: blur(20px);
  }
  .light .topbar-title { color: rgba(255,255,255,.9); }  /* pug-ok: testo su fondo nero */

  .light .mob-header {
    background: rgba(18,18,18,.92);
    border-bottom: 1px solid rgba(255,255,255,.08);
  }
  .light .mob-header-title { color: rgba(255,255,255,.9); }  /* pug-ok: testo su fondo nero */
  .light .mob-drawer { background:#ffffff; } .light .mob-drawer * { color:#101010 !important; }
  .light .mob-bottom-nav {
    background: rgba(18,18,18,.95);
    border-top: 1px solid rgba(255,255,255,.08);
  }
  .light .mob-nav-btn { color: rgba(255,255,255,.3); }  /* pug-ok: testo su fondo nero */
  .light .mob-nav-btn.active { color: var(--azzurro); }
  .light .content { background: transparent; }
  .light .edu-content-wrap { background: transparent; }

  /* ─ Step 4: Cards ─ */
  .light .card {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.08);
    box-shadow: 0 2px 16px rgba(0,0,0,.06);
    color: #101010;
  }
  .light .card-sm {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.07);
    color: #101010;
  }
  .light .stat-card {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.08);
    box-shadow: 0 2px 12px rgba(0,0,0,.05);
  }
  .light .stat-card::before {
    background:rgba(16,16,16,.15);
  }
  .light .stat-label { color: var(--text3); }
  .light .stat-value { color: #101010; }

  /* ─ Step 5: Forms & Inputs ─ */
  .light .form-input {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.18);
    color: #101010;
    font-weight: 500;
  }
  .light .form-input:focus {
    border-color: #101010;
    box-shadow: 0 0 0 3px rgba(16,16,16,.1);
    background: #ffffff;
  }
  .light .form-label { color:#101010; font-weight: 700; }
  .light select {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.15);
    color: #101010;
  }
  .light textarea {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.15);
    color: #101010;
  }
  .light .search-inp {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.15);
    color: #101010;
  }
  .light .search-inp:focus { border-color: #101010; box-shadow: 0 0 0 3px rgba(16,16,16,.1); }

  /* ─ Step 6: Buttons ─ */
  .light .btn-primary { background:#101010 !important; color:#FDEF26 !important; border:none !important; }
  .light .btn-ghost {
    background: rgba(0,0,0,.05);
    color:#101010;
    border: 1.5px solid rgba(0,0,0,.15);
  }
  .light .btn-ghost:hover { background: rgba(0,0,0,.09); }
  .light .btn-yellow {
    background: linear-gradient(135deg, #D41323, #D41323);
    border-color: rgba(230,81,0,.5);
    box-shadow: 0 2px 8px rgba(230,81,0,.25);
    color: #fff;
  }
  .light .btn-danger {
    background: rgba(198,40,40,.08);
    color: var(--rosso);
    border: 1.5px solid rgba(198,40,40,.25);
  }

  /* ─ Step 7: Chips ─ */
  .light .chip {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.15);
    color:#101010;
    font-weight: 700;
  }
  .light .chip.active {
    background: #101010;
    color: #ffffff;
    border-color: #101010;
    box-shadow: 0 2px 8px rgba(16,16,16,.3);
  }
  .light .chip:hover { background: rgba(16,16,16,.06); border-color: rgba(16,16,16,.3); }

  /* ─ Step 8: Tags ─ */
  .light .tag-green  { background: var(--surface3); color: var(--verde); border: 1px solid var(--verde); }
  .light .tag-blue   { background: var(--surface3); color: #101010; border: 1px solid var(--azzurro); }
  .light .tag-amber  { background: var(--surface3); color: #D41323; border: 1px solid var(--giallo); }
  .light .tag-red    { background: var(--surface3); color: var(--rosso); border: 1px solid var(--rosso); }
  .light .tag-gray   { background: var(--surface3); color: var(--argento); border: 1px solid var(--text3); }

  /* ─ Step 9: Presenze (checkbox) ─ */
  .light .pres-wrap {
    border: 1.5px solid rgba(0,0,0,.1);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,.05);
  }
  .light .pres-table th {
    background: var(--surface3);
    color:#101010;
    border-bottom: 2px solid rgba(0,0,0,.08);
    font-weight: 800;
  }
  .light .pres-table td {
    color: #101010;
    border-bottom: 1px solid rgba(0,0,0,.05);
    background: #ffffff;
  }
  .light .pres-table tr:hover td { background: var(--surface3); }
  /* Checkbox presenze: visibile e solido */
  .light .pd-yes {
    background: var(--verde) !important;
    color: #ffffff !important;
    border-color: var(--verde) !important;
    box-shadow: 0 2px 6px rgba(46,125,50,.3) !important;
  }
  .light .pd-none {
    background: #ffffff !important;
    color: var(--text3) !important;
    border: 2px solid var(--text3) !important;
  }

  /* ─ Step 10: Leaderboard ─ */
  .light .lb-row {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.07);
    box-shadow: 0 2px 8px rgba(0,0,0,.05);
  }
  .light .lb-row:nth-child(1) { border-color: rgba(245,127,23,.4); box-shadow: 0 2px 12px rgba(245,127,23,.12); }
  .light .lb-row:nth-child(2) { border-color: rgba(96,125,139,.3); }
  .light .lb-row:nth-child(3) { border-color: rgba(121,85,72,.3); }
  .light .lb-rank      { color: var(--text3); }
  .light .lb-rank.gold { color: #D41323; text-shadow: none; }
  .light .lb-rank.silver { color: var(--argento); }
  .light .lb-rank.bronze { color: var(--bronzo); }
  .light .lb-name  { color: #101010; font-weight: 700; }
  .light .lb-level { color: var(--text3); }
  .light .lb-xp    { color: #101010; }
  .light .lb-av    { background: var(--surface3); border-color: rgba(0,0,0,.1); }

  /* ─ Step 11: Player grid ─ */
  .light .player-card {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.08);
    box-shadow: 0 2px 8px rgba(0,0,0,.05);
  }
  .light .player-card:hover { border-color: rgba(16,16,16,.3); box-shadow: 0 4px 16px rgba(16,16,16,.1); }
  .light .player-card.selected { border-color: #101010; background: rgba(16,16,16,.04); box-shadow: var(--glow-blue); }
  .light .p-name  { color: #101010; }
  .light .p-level { color: var(--text3); }
  .light .p-xp    { color: #101010; }
  .light .p-coin  { color: #D41323; }
  .light .avatar-wrap { border-color: rgba(16,16,16,.25); }

  /* ─ Step 12: Activities ─ */
  .light .act-card {
    background: var(--surface3);
    border: 1.5px solid rgba(46,125,50,.25);
    box-shadow: 0 2px 8px rgba(46,125,50,.06);
  }
  .light .act-card:hover { border-color: rgba(46,125,50,.5); box-shadow: 0 4px 16px rgba(46,125,50,.1); }
  .light .act-title { color: #101010; }
  .light .act-meta  { color:#101010; }

  /* ─ Step 13: Badges ─ */
  .light .badge-card {
    background: var(--surface3);
    border: 1.5px solid rgba(212,19,35,.2);
    box-shadow: 0 2px 8px rgba(212,19,35,.05);
  }
  .light .badge-card:hover { border-color: rgba(212,19,35,.45); }
  .light .badge-name { color: #101010; }
  .light .badge-pts  { color: #D41323; }

  /* ─ Step 14: Sfida ─ */
  .light .sfida-card {
    background: var(--surface3);
    border: 1.5px solid rgba(198,40,40,.25);
  }
  .light .sfida-label  { color: var(--rosso); }
  .light .sfida-title  { color: #101010; text-shadow: none; }
  .light .sfida-desc   { color:#101010; }
  .light .sfida-reward { background: rgba(230,81,0,.08); border-color: rgba(230,81,0,.25); color: #D41323; }

  /* ─ Step 15: Modal ─ */
  .light .modal {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.12);
    box-shadow: 0 -16px 48px rgba(0,0,0,.12);
  }
  .light .modal::before { background:#101010; }
  .light .modal-title  { color: #101010; }
  .light .section-label { color:#101010; }
  .light .modal-bg { background: rgba(0,0,0,.45); }

  /* ─ Step 16: Section banner ─ */
  .light .section-banner-title { color: #101010 !important; }
  .light .section-banner-sub   { color: rgba(0,0,0,.5) !important; }

  /* ─ Step 17: Misc ─ */
  .light .empty   { color: var(--text3); }
  .light .loading { color: var(--text3); }
  .light .batch-panel { background: rgba(16,16,16,.06); border: 1.5px solid rgba(16,16,16,.2); }
  .light .batch-info  { color: #101010; }
  .light .filter-bar .chip { background: #ffffff; }
  .light .squad-row  { background: #ffffff; border: 1.5px solid rgba(0,0,0,.08); }
  .light .squad-name { color: #101010; }
  .light .diary-entry { background: #ffffff; border: 1px solid rgba(0,0,0,.07); }
  .light .diary-date  { color: #101010; }
  .light .diary-text  { color: #101010; }
  .light .notif-item  { border-bottom: 1px solid rgba(0,0,0,.06); }
  .light .notif-title { color: #101010; }
  .light .notif-body  { color:#101010; }
  .light .notif-time  { color: var(--text3); }
  .light .notif-dot   { background: var(--rosa); }
  .light .player-detail { background: #ffffff; border: 1.5px solid rgba(16,16,16,.2); }
  .light .detail-tab { background: var(--surface3); border: 1px solid rgba(0,0,0,.1); color:#101010; }
  .light .detail-tab.active { background: #101010; color: #ffffff; border-color: #101010; }
  .light .color-swatch.active { border-color: #101010; box-shadow: var(--glow-blue); }
  .light .section-banner { box-shadow: none; }
  .light .podium-wrap .pod-name { color: #101010; }
  .light .lb-list .lb-row { background: #ffffff; }

  /* ─ Step 18: StreakConfig month cards ─ */
  .light .streak-month-card {
    background: #ffffff !important;
    border-color: rgba(0,0,0,.08) !important;
    box-shadow: 0 2px 8px rgba(0,0,0,.04);
  }
  .light .streak-month-card * { color: #101010 !important; }
  .light .streak-month-card div[style*="color:"var(--text3)""] { color: var(--text3) !important; }

  /* ─ Step 19: Avatar picker ─ */
  .light .av-picker-wrap { background: var(--surface3); border-radius: 8px; padding: 4px; }
  .light .av-picker-tab {
    background: #ffffff !important;
    color: var(--text2) !important;
    border: 1.5px solid rgba(0,0,0,.12) !important;
  }
  .light .av-picker-tab.on {
    background: #101010 !important;
    color: #ffffff !important;
    border-color: #101010 !important;
  }
  .light .av-picker-item {
    background: #ffffff !important;
    border: 1.5px solid rgba(0,0,0,.08) !important;
  }
  .light .av-picker-item:hover { background: var(--surface3) !important; border-color: rgba(16,16,16,.3) !important; }
  .light .av-picker-item.sel   { border-color: #101010 !important; background: rgba(16,16,16,.06) !important; }
  .light .av-picker-item span  { color: var(--text2) !important; }

  /* ─ Step 20: Player dashboard light ─ */
  .light .player-wrap { transition: background .4s ease; }
  .light .pd-topbar {
    background: #ffffff !important;
    border-bottom: 2px solid #101010 !important;
  }
  .light .pd-name-pill { background: #141414 !important; color: var(--surface3) !important; }
  .light .pd-lv-pill {
    background: rgba(16,16,16,.1);
    border-color: rgba(16,16,16,.3);
    color: #101010;
  }
  .light .pd-card { background:#ffffff; border:3px solid #101010; border-radius:16px 20px 14px 22px; box-shadow:4px 4px 0 #101010; padding:16px; margin-bottom:14px; position:relative; z-index:2; }
  body:not(.light) .pd-card { background:#17181c; border-color:#33353c; box-shadow:4px 4px 0 #000; color:#f0f0f0; }
  .light .pd-card * { color: #101010; }
  .light .pd-sg .pd-sc {
    background: rgba(255,255,255,.9) !important;
    border: 1px solid rgba(0,0,0,.07) !important;
  }
  .light .pd-sv { color: #D41323 !important; }
  .light .pd-sl { color: var(--text3) !important; }
  .light .pd-squad {
    background: rgba(255,255,255,.85) !important;
    border: 1px solid rgba(0,0,0,.08) !important;
  }
  .light .pd-sfida { background: #141414 !important; }
  .light .pd-checkin {
    background: rgba(255,255,255,.85) !important;
    border: 1px solid rgba(46,125,50,.25) !important;
  }
  .light .pd-tab-title {}
  .light .pd-badge-item {
    background: rgba(255,255,255,.9) !important;
    border: 1px solid rgba(0,0,0,.07) !important;
  }
  .light .pd-badge-item div { color: #101010 !important; }
  .light .streak-card {
    background: rgba(255,255,255,.85) !important;
    border: 1px solid rgba(230,81,0,.25) !important;
  }
  .light .streak-val { color: #D41323 !important; }
  .light .streak-lbl { color: var(--text3) !important; }
  .light .month-prog-bg   { background: rgba(0,0,0,.08); }
  .light .month-prog-fill { background: linear-gradient(90deg, #D41323, #D41323); }
  .light .xp-bar-wrap { background: rgba(16,16,16,.08); }
  .light .xp-bar { background:#101010; }
  .light .player-bottom-nav { background:#101010 !important; border-top:none !important; }
  .light .player-bottom-nav * { color:rgba(255,255,255,.5); }  /* pug-ok: testo su fondo nero */
  .light .player-nav-btn       { color: rgba(255,255,255,.28) !important; }  /* pug-ok: testo su fondo nero */
  .light .player-nav-btn.active { color: var(--azzurro) !important; }
  .light .player-nav-btn.active::after { background: var(--azzurro) !important; }

  /* ─ Step 21: Login ─ */
  .light .login-wrap { background: var(--surface3); }
  .light .login-card {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.1);
    box-shadow: 0 8px 40px rgba(0,0,0,.08), inset 0 1px 0 rgba(255,255,255,1);
  }
  .light .login-card::before {
    background:#101010;
  }
  .light .login-title {
    background: #101010;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .light .login-sub { color: var(--text3); }
  .light .login-tabs { background: rgba(0,0,0,.04); border: 1px solid rgba(0,0,0,.08); }
  .light .login-tab  { color: var(--text3); }
  .light .login-tab.active {
    background: rgba(16,16,16,.08);
    color: #101010;
    border-color: rgba(16,16,16,.3);
    box-shadow: none;
  }
  .light .nickname-list { background: #ffffff; border-color: rgba(0,0,0,.1); }
  .light .nickname-item { color: #101010; border-bottom-color: rgba(0,0,0,.06); }
  .light .nickname-item:hover { background: rgba(16,16,16,.04); }
  .light .err-msg { color: var(--rosso); }
  .light .pin-display { background: rgba(16,16,16,.06); border-color: rgba(16,16,16,.2); color: #101010; }

  /* ─ Step 22: Edu notifications bell ─ */
  .light .edu-notif-bell {
    background: rgba(255,255,255,.1);
    border-color: rgba(255,255,255,.15);
  }
  .light .edu-notif-panel {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.1);
    box-shadow: 0 8px 32px rgba(0,0,0,.12);
  }
  .light .edu-notif-header { color: #101010; border-bottom-color: rgba(0,0,0,.08); }
  .light .edu-notif-item:hover { background: rgba(0,0,0,.03); }
  .light .edu-notif-title { color: #101010; }
  .light .edu-notif-sub   { color: var(--text3); }
  .light .edu-notif-count { color: #101010; }
  .light .edu-notif-empty { color: var(--text3); }

  /* ─ Light mode global fixes ─ */
  .light * { box-sizing: border-box; }
  .light .pd-card { background: rgba(255,255,255,.88) !important; color: #101010 !important; }
  .light .pd-card * { color: #101010 !important; }
  .light .pd-tab-title {}
  .light .search-inp { background:#fff; border:1.5px solid rgba(0,0,0,.18); color:#101010; }
  .light .search-inp::placeholder { color:var(--text3); }
  .light .form-input::placeholder { color:var(--text3); }
  .light textarea { background:#fff; color:#101010; border:1.5px solid rgba(0,0,0,.15); }
  .light textarea::placeholder { color:var(--text3); }
  .light select option { background:#ffffff; color:#101010; }
  .light .empty { color: var(--text3); }
  .light .loading { color: var(--text3); }
  /* Sfide always dark bg */
  .light .pd-sfida { background: #1a2035 !important; border-color: rgba(253,239,38,.3) !important; } /* pug-ok: fondo card sfida notte */
  .light .pd-sfida * { color: rgba(255,255,255,.9) !important; }  /* pug-ok: testo su pd-sfida blu notte */
  /* Streak card */
  .light .streak-card { background: #fff !important; border: 1px solid rgba(230,81,0,.2) !important; }
  .light .streak-card .streak-val { color: #D41323 !important; }
  .light .streak-card .streak-lbl { color: var(--text3) !important; }
  /* Community in light */
  .light .community-card { background: #fff; border: 1px solid rgba(0,0,0,.08); }
  /* Announcements in light */
  .light .ann-card { background: #fff; }
  /* XP chart in light */
  .light .xp-chart-bar { background:#101010; }
  /* Buttons in light */
  .light .btn-yellow { background:#FDEF26 !important; color:#101010 !important; border:2px solid #101010 !important; }

  /* ═══ EDUCATOR NOTIFICATIONS ═══ */
  .edu-notif-bell { position:relative; cursor:pointer; width:36px; height:36px; border-radius:10px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.1); display:flex; align-items:center; justify-content:center; font-size:18px; transition:all .15s; flex-shrink:0; }
  .edu-notif-bell:hover { background:rgba(255,255,255,.12); }
  .edu-notif-badge { position:absolute; top:-5px; right:-5px; background:var(--rosso); color:#fff; border-radius:99px; font-size:9px; font-weight:900; padding:2px 5px; min-width:16px; text-align:center; line-height:1.3; box-shadow:0 0 6px rgba(255,34,68,.5); }
  .nav-badge { display:inline-flex; align-items:center; justify-content:center; background:var(--rosso); color:#fff; border-radius:99px; font-size:8px; font-weight:900; padding:1px 5px; min-width:14px; margin-left:6px; line-height:1.3; }
  .edu-notif-panel { position:fixed; top:56px; right:12px; width:300px; background:rgba(16,16,16,.98); border:1px solid rgba(255,255,255,.12); border-radius:16px; box-shadow:0 8px 32px rgba(0,0,0,.5); z-index:50; overflow:hidden; backdrop-filter:blur(20px); }
  .edu-notif-header { padding:12px 16px; border-bottom:1px solid rgba(255,255,255,.08); font-family:'Funnel Display',sans-serif; font-size:18px; font-weight:900; text-transform:uppercase; color:#fff; letter-spacing:.05em; }
  .edu-notif-item { display:flex; align-items:flex-start; gap:10px; padding:12px 16px; border-bottom:1px solid rgba(255,255,255,.06); cursor:pointer; transition:background .12s; }
  .edu-notif-item:hover { background:rgba(255,255,255,.04); }
  .edu-notif-item:last-child { border-bottom:none; }
  .edu-notif-icon { font-size:22px; flex-shrink:0; }
  .edu-notif-text { flex:1; }
  .edu-notif-title { font-size:13px; font-weight:700; color:#fff; margin-bottom:2px; }
  .edu-notif-sub { font-size:11px; color:var(--text3); }
  .edu-notif-count { font-family:'Funnel Display',sans-serif; font-size:22px; font-weight:900; color:#FDEF26; flex-shrink:0; }
  .edu-notif-empty { padding:20px 16px; text-align:center; color:var(--text3); font-size:13px; }
  /* ═══ AVATAR PICKER ═══ */
  .av-picker-wrap { max-height:340px; overflow-y:auto; scrollbar-width:thin; }
  .av-picker-tabs { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:10px; }
  .av-picker-tab { padding:5px 12px; border-radius:99px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.04); color:var(--text3); font-size:11px; font-weight:700; cursor:pointer; transition:all .15s; }
  .av-picker-tab.on { background:rgba(253,239,38,.15); color:#FDEF26; border-color:rgba(253,239,38,.35); }
  .av-picker-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(64px,1fr)); gap:6px; }
  .av-picker-item { border-radius:10px; padding:5px; text-align:center; cursor:pointer; border:2px solid transparent; background:rgba(255,255,255,.04); transition:all .15s; }
  .av-picker-item:hover { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.15); }
  .av-picker-item.sel { border-color:#FDEF26; background:rgba(253,239,38,.1); }
  .av-picker-item img { width:52px; height:52px; object-fit:contain; display:block; margin:0 auto 3px; }
  .av-picker-item span { font-size:8px; color:var(--text3); text-transform:capitalize; line-height:1.2; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .av-picker-item.sel span { color:#FDEF26; }
  /* ═══ QR SCANNER ═══ */
  .qr-scanner-wrap { position:relative; width:100%; max-width:320px; margin:0 auto; }
  .qr-scanner-video { width:100%; border-radius:14px; display:block; background:#000; }
  .qr-scanner-overlay { position:absolute; inset:0; border-radius:14px; pointer-events:none; }
  .qr-scanner-frame { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:200px; height:200px; }
  .qr-scanner-frame::before,.qr-scanner-frame::after { content:''; position:absolute; width:40px; height:40px; border-color:#FDEF26; border-style:solid; }
  .qr-scanner-frame::before { top:0; left:0; border-width:3px 0 0 3px; border-radius:4px 0 0 0; }
  .qr-scanner-frame::after  { bottom:0; right:0; border-width:0 3px 3px 0; border-radius:0 0 4px 0; }
  .qr-scanner-corner-tr { position:absolute; top:0; right:0; width:40px; height:40px; border-top:3px solid #FDEF26; border-right:3px solid #FDEF26; border-radius:0 4px 0 0; }
  .qr-scanner-corner-bl { position:absolute; bottom:0; left:0; width:40px; height:40px; border-bottom:3px solid #FDEF26; border-left:3px solid #FDEF26; border-radius:0 0 0 4px; }
  .qr-scanner-line { position:absolute; left:10%; right:10%; height:2px; background:#FDEF26; animation:scan-line 2s linear infinite; }
  @keyframes scan-line { 0%{top:10%} 100%{top:90%} }
  /* ═══ PRESENTATION MODE ═══ */
  .pres-overlay { position:fixed; inset:0; background:#101010; z-index:1000; display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden; }
  .pres-stars { position:absolute; inset:0; pointer-events:none; }
  .pres-star { position:absolute; width:3px; height:3px; border-radius:50%; background:#fff; animation:twinkle 3s infinite; }
  @keyframes twinkle { 0%,100%{opacity:.2;transform:scale(1)} 50%{opacity:1;transform:scale(1.5)} }
  .pres-title { font-family:'Funnel Display',sans-serif; font-size:clamp(28px,6vw,64px); font-weight:900; text-transform:uppercase; letter-spacing:.1em; background:linear-gradient(135deg,#A3CFFE,#fff,#FDEF26); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; margin-bottom:clamp(16px,4vh,40px); text-align:center; filter:drop-shadow(0 0 20px rgba(163,207,254,.4)); }
  .pres-podium-wrap { display:flex; align-items:flex-end; gap:clamp(10px,3vw,32px); margin-bottom:clamp(16px,4vh,40px); }
  .pres-col { display:flex; flex-direction:column; align-items:center; animation:rise .8s cubic-bezier(.34,1.56,.64,1) both; }
  .pres-col-1 { animation-delay:.1s; }
  .pres-col-2 { animation-delay:.3s; }
  .pres-col-3 { animation-delay:.5s; }
  @keyframes rise { from{transform:translateY(80px);opacity:0} to{transform:translateY(0);opacity:1} }
  .pres-crown { font-size:clamp(20px,4vw,36px); margin-bottom:4px; animation:bounce 2s infinite; }
  @keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
  .pres-av { border-radius:50%; border:4px solid; display:flex; align-items:center; justify-content:center; overflow:hidden; margin-bottom:clamp(6px,1.5vh,12px); }
  .pres-av img, .pres-av span { width:100%; height:100%; object-fit:cover; }
  .pres-av-1 { width:clamp(80px,14vw,130px); height:clamp(80px,14vw,130px); border-color:#FDEF26; box-shadow:0 0 30px rgba(253,239,38,.6),0 0 80px rgba(253,239,38,.2); animation:glow-gold 2s infinite; }
  .pres-av-2 { width:clamp(60px,10vw,100px); height:clamp(60px,10vw,100px); border-color:var(--argento); box-shadow:0 0 20px rgba(170,200,224,.4); }
  .pres-av-3 { width:clamp(50px,8vw,84px); height:clamp(50px,8vw,84px); border-color:var(--bronzo); box-shadow:0 0 16px rgba(212,145,106,.4); }
  @keyframes glow-gold { 0%,100%{box-shadow:0 0 30px rgba(253,239,38,.6),0 0 80px rgba(253,239,38,.2)} 50%{box-shadow:0 0 60px rgba(253,239,38,.9),0 0 120px rgba(253,239,38,.4)} }
  .pres-pname { font-family:'Funnel Display',sans-serif; font-size:clamp(14px,2.5vw,26px); font-weight:900; text-transform:uppercase; color:#fff; text-align:center; text-shadow:0 0 20px rgba(255,255,255,.3); max-width:clamp(80px,14vw,160px); line-height:1.1; }
  .pres-pxp { font-size:clamp(11px,1.8vw,18px); font-weight:700; text-align:center; margin-top:2px; }
  .pres-base { border-radius:12px 12px 0 0; display:flex; align-items:center; justify-content:center; margin-top:8px; }
  .pres-base-1 { background:rgba(253,239,38,.15); border:2px solid rgba(253,239,38,.4); width:clamp(80px,14vw,130px); height:clamp(70px,12vh,100px); }
  .pres-base-2 { background:rgba(170,200,224,.1); border:2px solid rgba(170,200,224,.3); width:clamp(60px,10vw,100px); height:clamp(50px,9vh,76px); }
  .pres-base-3 { background:rgba(212,145,106,.1); border:2px solid rgba(212,145,106,.25); width:clamp(50px,8vw,84px); height:clamp(36px,7vh,56px); }
  .pres-rank { font-family:'Funnel Display',sans-serif; font-size:clamp(20px,4vw,40px); font-weight:900; }
  .pres-rank-1 { color:#FDEF26; text-shadow:0 0 16px rgba(253,239,38,.8); }
  .pres-rank-2 { color:var(--argento); }
  .pres-rank-3 { color:var(--bronzo); }
  .pres-list { display:flex; flex-direction:column; gap:5px; width:100%; max-width:560px; padding:0 16px; max-height:55vh; overflow-y:auto; scrollbar-width:none; }
  .pres-list::-webkit-scrollbar { display:none; }
  .pres-list-row { display:flex; align-items:center; gap:12px; background:rgba(255,255,255,.05); border-radius:10px; padding:10px 14px; animation:fade-in .5s both; }
  @keyframes fade-in { from{opacity:0;transform:translateX(-20px)} to{opacity:1;transform:translateX(0)} }
  .pres-close { position:absolute; top:16px; right:16px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.15); border-radius:10px; padding:8px 14px; color:rgba(255,255,255,.5); font-size:13px; cursor:pointer; font-weight:700; letter-spacing:.05em; z-index:10; }  /* pug-ok: testo su fondo nero */
  .pres-close:hover { background:rgba(255,255,255,.15); color:#fff; }
  @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

  /* ─ Animated background particles ─ */
  @keyframes float1 { 0%,100%{transform:translate(0,0) rotate(0deg)} 33%{transform:translate(15px,-20px) rotate(5deg)} 66%{transform:translate(-10px,10px) rotate(-3deg)} }
  @keyframes float2 { 0%,100%{transform:translate(0,0) rotate(0deg)} 33%{transform:translate(-20px,15px) rotate(-6deg)} 66%{transform:translate(10px,-8px) rotate(4deg)} }
  @keyframes float3 { 0%,100%{transform:translate(0,0) rotate(0deg)} 50%{transform:translate(12px,18px) rotate(8deg)} }
  .bg-float-1 { animation:float1 8s ease-in-out infinite; }
  .bg-float-2 { animation:float2 11s ease-in-out infinite; }
  .bg-float-3 { animation:float3 14s ease-in-out infinite; }

  /* Toast animation */
  @keyframes toastIn { 0%{transform:translateX(120%) scale(.8);opacity:0} 100%{transform:translateX(0) scale(1);opacity:1} }

  /* Particle burst */
  @keyframes burst { 0%{transform:translate(0,0) scale(1);opacity:1} 100%{transform:translate(var(--tx),var(--ty)) scale(0);opacity:0} }

  /* XP bar animated fill */
  @keyframes xpFill { from{width:0} }
  @keyframes barShine { 0%{background-position:0% 50%} 100%{background-position:200% 50%} }
  @keyframes barStripes { 0%{background-position:0 0} 100%{background-position:28px 0} }
  @keyframes leaffall { 0%{transform:translateY(-20px) rotate(0) scale(var(--s,1));opacity:0} 10%{opacity:1} 100%{transform:translateY(110vh) rotate(var(--r,360deg)) scale(var(--s,1));opacity:0} }
  @keyframes leafsway { 0%,100%{margin-left:-12px} 50%{margin-left:12px} }

  /* Avatar idle breathe */
  @keyframes breathe { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(-6px) scale(1.02)} }
  .avatar-breathe { animation:breathe 3.5s ease-in-out infinite; }

  /* Streak flame pulse */
  @keyframes flamePulse { 0%,100%{transform:scale(1);filter:drop-shadow(0 0 4px var(--giallo))} 50%{transform:scale(1.15);filter:drop-shadow(0 0 12px var(--giallo))} }
  .flame-pulse { animation:flamePulse 1.2s ease-in-out infinite; display:inline-block; }

  /* Leaderboard row entrance */
  @keyframes slideInRow { from{transform:translateX(-20px);opacity:0} to{transform:translateX(0);opacity:1} }

  /* XP number count */
  @keyframes numPop { 0%{transform:scale(1)} 50%{transform:scale(1.3)} 100%{transform:scale(1)} }
  .num-pop { animation:numPop .4s cubic-bezier(.34,1.56,.64,1); }

  /* ═══ SMOOTH TRANSITIONS ═══ */
  * { -webkit-tap-highlight-color: transparent; }
  button, [role="button"] { touch-action: manipulation; }
  .card, .card-sm, .player-card, .lb-row { transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease; }
  .card:active, .player-card:active { transform: scale(.98); }
  .btn:active { transform: scale(.96) !important; }
  input, select, textarea { -webkit-appearance: none; appearance: none; }
  .content { animation:fade-up .2s ease; }
  @keyframes fade-up { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
  .player-bottom-nav { transition:background .3s; }
  img { transition:opacity .2s; }
  img[loading="lazy"] { opacity:0; }
  img[loading="lazy"].loaded { opacity:1; }
  /* ═══ PLAYER DASHBOARD — NEW DESIGN ═══ */
  .player-wrap { background:#000; min-height:100vh; position:relative; z-index:1; transition:background .4s ease; }
/* pass grafico: sfondi reali responsive (telefono default, largo da >=640px) */
/* topbar in tinta col tab (giorno) e senza riga di stacco — come il camerino */
.pd-topbar{border-bottom:none!important;box-shadow:none}
.player-wrap.bg-azzurro .pd-topbar{background:#A3CFFF}
.player-wrap.bg-rosa .pd-topbar{background:#FF6DEC}
.player-wrap.bg-giallo .pd-topbar{background:#FCEF25}
.player-wrap.bg-verde .pd-topbar{background:#339967}
.player-wrap.bg-rosso .pd-topbar{background:#D41423}
/* Big Top calendario — caselle e testo sempre pieni */
.btcal-head{display:flex;align-items:center;justify-content:space-between;margin:4px 0 12px}
.btcal-nav{width:40px;height:40px;border:3px solid #101010;border-radius:11px;background:#fff;box-shadow:3px 3px 0 #101010;font-weight:900;font-size:19px;color:#101010;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.btcal-nav:disabled{background:#e2e2e2;box-shadow:none;color:#a3a3a3;cursor:default}
.btcal-title{font-weight:900;font-size:20px;text-transform:capitalize;color:#101010;text-align:center}
.btcal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.btcal-dow{margin-bottom:4px}
.btcal-dowc{text-align:center;font-weight:800;font-size:11px;color:#101010;text-transform:uppercase}
.btcal-cell{aspect-ratio:1;border:2.5px solid #101010;border-radius:11px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:800;font-size:15px;background:#fff;color:#101010;box-shadow:2px 2px 0 #101010;cursor:pointer;position:relative}
.btcal-cell.blank{border:none;background:transparent;box-shadow:none;cursor:default}
.btcal-cell.past{background:#d6d6d6;color:#7a7a7a;box-shadow:none}
.btcal-cell.free{background:#FDEF26}
.btcal-cell.mine{background:#339966;color:#fff}
.btcal-cell.full{background:#101010;color:#fff}
.btcal-cell.today{outline:3px solid #101010;outline-offset:2px}
.btcal-cell.open{transform:translate(1px,1px);box-shadow:0 0 0 3px #D41323,2px 2px 0 #101010}
.btcal-dot{font-size:9px;font-weight:900;margin-top:1px;line-height:1}
.btcal-legend{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0 0;font-size:11px;font-weight:800;color:#101010}
.btcal-legend span{display:inline-flex;align-items:center;gap:5px}
.btcal-legend i{width:14px;height:14px;border:2px solid #101010;border-radius:4px;display:inline-block}
.btcal-panel{margin:16px 0 0;border:3px solid #101010;border-radius:18px 22px 16px 22px;background:#fff;box-shadow:5px 5px 0 #101010;padding:14px}
.btcal-tape{display:inline-block;font-weight:800;font-size:12px;text-transform:uppercase;background:#FDEF26;color:#101010;border:2px solid #101010;box-shadow:2px 2px 0 #101010;padding:5px 11px;transform:rotate(-2deg);margin-bottom:10px}
.btcal-turno{display:flex;align-items:center;gap:10px;border:2.5px solid #101010;border-radius:12px;padding:10px 12px;margin-top:10px;background:#fff;color:#101010;box-shadow:2px 2px 0 #101010;cursor:pointer}
.btcal-turno.sel{background:#FDEF26}
.btcal-turno.full{background:#101010;color:#fff;cursor:default}
.btcal-turno.mine{background:#339966;color:#fff}
.btcal-turno.past{background:#d6d6d6;color:#6f6f6f;cursor:default;box-shadow:none}
.btcal-tt{font-weight:900;font-size:15px}
.btcal-tm{font-size:11px;font-weight:700;margin-top:2px}
.btcal-cap{margin-left:auto;font-weight:900;font-size:18px}
.btcal-disdici{margin-left:auto;border:2px solid currentColor;background:transparent;color:inherit;font-weight:800;font-size:12px;border-radius:8px;padding:5px 9px;cursor:pointer}
.btcal-book{position:sticky;bottom:12px;width:100%;margin-top:14px;border:3px solid #101010;border-radius:14px;background:#339966;color:#fff;box-shadow:4px 4px 0 #101010;font-weight:900;font-size:16px;padding:14px;cursor:pointer}
.btcal-msg{font-weight:800;font-size:13px;color:#101010;background:#FDEF26;border:2.5px solid #101010;border-radius:12px;box-shadow:3px 3px 0 #101010;padding:10px 12px;margin-bottom:10px;text-align:center}
.btcal-checkin{border:3px solid #101010;border-radius:16px;background:#A3CFFE;box-shadow:4px 4px 0 #101010;padding:14px;margin-bottom:12px}
.btcal-checkin-h{font-weight:800;font-size:12px;text-transform:uppercase;color:#101010;margin-bottom:8px}
.btcal-code{flex:1;border:2.5px solid #101010;border-radius:10px;padding:10px;font-weight:800;font-size:15px;text-transform:uppercase;background:#fff;color:#101010;font-family:inherit}
.btcal-code-btn{border:2.5px solid #101010;border-radius:10px;background:#FDEF26;color:#101010;font-weight:900;padding:10px 16px;box-shadow:2px 2px 0 #101010;cursor:pointer}
.btcal-foot{font-size:10px;color:#101010;text-align:center;margin-top:14px;line-height:1.6;font-weight:600}
.player-wrap.bg-notte .btcal-title,.player-wrap.bg-notte .btcal-dowc,.player-wrap.bg-notte .btcal-legend,.player-wrap.bg-notte .btcal-foot{color:#fff}
.player-wrap.bg-notte .btcal-nav{background:#17181c;color:#fff;border-color:#3a3a3a;box-shadow:3px 3px 0 #000}
.player-wrap.bg-notte .btcal-nav:disabled{background:#141414;color:#555}
.player-wrap.bg-notte .btcal-cell{background:#17181c;color:#fff;border-color:#3a3a3a;box-shadow:2px 2px 0 #000}
.player-wrap.bg-notte .btcal-cell.past{background:#242424;color:#6f6f6f}
.player-wrap.bg-notte .btcal-cell.free{background:#FDEF26;color:#101010}
.player-wrap.bg-notte .btcal-cell.mine{background:#339966;color:#fff}
.player-wrap.bg-notte .btcal-cell.full{background:#D41323;color:#fff}
.player-wrap.bg-notte .btcal-cell.today{outline-color:#fff}
.player-wrap.bg-notte .btcal-panel{background:#17181c;border-color:#33353c;box-shadow:5px 5px 0 #000;color:#fff}
.player-wrap.bg-notte .btcal-turno{background:#0f1013;color:#fff;border-color:#3a3a3a;box-shadow:2px 2px 0 #000}
.player-wrap.bg-notte .btcal-turno.sel{background:#FDEF26;color:#101010}
.player-wrap.bg-notte .btcal-turno.mine{background:#339966;color:#fff}
.player-wrap.bg-notte .btcal-turno.full{background:#D41323;color:#fff}
.player-wrap.bg-notte .btcal-turno.past{background:#242424;color:#6f6f6f}
.player-wrap.bg-notte .btcal-checkin{background:#17181c;border-color:#33353c;box-shadow:4px 4px 0 #000}
.player-wrap.bg-notte .btcal-checkin-h{color:#fff}
.player-wrap.bg-notte .btcal-code{background:#0f1013;color:#fff;border-color:#3a3a3a}
/* ── Profilo: nomi bianchi in notte, vitali sempre leggibili (colori pieni) ── */
.pug-name,.pug-realname{color:#fff}
body.light .pug-name,body.light .pug-realname{color:#101010}
.pug-card{background:#17181c;border-color:#33353c;box-shadow:4px 4px 0 #000}
body.light .pug-card{background:#fff;border-color:#101010;box-shadow:4px 4px 0 #101010}
.pug-vital .n,.pug-vpct{color:#f0f0f0}
body.light .pug-vital .n,body.light .pug-vpct{color:#101010}
/* ── Notifiche come riquadri: card piena + titolo in box giallo ── */
.notif-item{display:flex;gap:10px;align-items:flex-start;background:#17181c;border:3px solid #33353c;border-radius:14px;box-shadow:4px 4px 0 #000;padding:12px;margin-bottom:12px}
body.light .notif-item{background:#fff;border-color:#101010;box-shadow:4px 4px 0 #101010}
.notif-title{display:inline-block;background:#FDEF26;color:#101010;border:2px solid #101010;box-shadow:2px 2px 0 #101010;font-weight:800;font-size:13px;padding:4px 9px;border-radius:8px;margin-bottom:7px}
.notif-body{color:#f0f0f0;font-size:13px;font-weight:600}
body.light .notif-body{color:#101010}
.notif-time{color:#9a9a9a;font-size:11px;font-weight:700;margin-top:5px}
body.light .notif-time{color:#6b6b6b}
.notif-icon{font-size:22px;flex-shrink:0}
/* ── Lab come riquadri: card piena + titolo in box colorato ── */
.act-card{background:#17181c;border:3px solid #33353c;border-radius:14px;box-shadow:4px 4px 0 #000;padding:12px}
body.light .act-card{background:#fff;border-color:#101010;box-shadow:4px 4px 0 #101010}
.act-title{display:inline-block;background:#FDEF26;color:#101010;border:2px solid #101010;box-shadow:2px 2px 0 #101010;font-size:16px;line-height:1.15;padding:5px 11px;border-radius:8px;margin-bottom:9px}
.act-meta{color:#e0e0e0}
body.light .act-meta{color:#101010}
.sfida-card{background:#17181c;border:3px solid #33353c;border-radius:14px;box-shadow:4px 4px 0 #000;padding:12px}
body.light .sfida-card{background:#fff;border-color:#101010;box-shadow:4px 4px 0 #101010}
.sfida-title{display:inline-block;background:#FF6DEC;color:#101010;border:2px solid #101010;box-shadow:2px 2px 0 #101010;font-size:18px;line-height:1.15;padding:5px 11px;border-radius:8px;margin-bottom:8px}
.sfida-label{color:#FF6DEC}
body.light .sfida-label{color:#D41323}
.sfida-desc{color:#e0e0e0}
body.light .sfida-desc{color:#101010}
/* ── Titolo pagina: barra centrata, bianca di giorno / nera di notte, lettering nel colore pagina ── */
.pd-tab-title{display:block;width:fit-content;max-width:calc(100% - 30px);margin:10px auto 22px;text-align:center;font-size:22px;line-height:1.15;padding:13px 34px;border-radius:14px;transform:rotate(-2deg);background:var(--pg,#101010);color:#101010;border:3px solid #101010;box-shadow:4px 4px 0 #101010}
body.light .pd-tab-title{background:#fff}
/* ── Profilo: 6 caselle stile "Come sta" (piene), scritte+icone piu grandi ── */
.pd-sg{gap:9px!important;margin:0 14px 12px!important}
.pd-sg .pd-sc{background:#17181c!important;border:3px solid #33353c!important;border-radius:14px!important;box-shadow:3px 3px 0 #000!important;padding:15px 8px!important}
.light .pd-sg .pd-sc{background:#fff!important;border-color:#101010!important;box-shadow:3px 3px 0 #101010!important}
.pd-sv{font-size:30px!important;color:#f5f5f5!important}
.light .pd-sv{color:#101010!important}
.pd-sl{font-size:11px!important;letter-spacing:.04em!important;color:#cfcfcf!important;margin-top:5px!important}
.light .pd-sl{color:#101010!important}
/* badge come riquadri pieni, non in cerchio */
.pd-badge-item{background:#17181c!important;border:3px solid #33353c!important;border-radius:14px!important;padding:12px 10px!important}
.light .pd-badge-item{background:#fff!important;border-color:#101010!important;box-shadow:3px 3px 0 #101010!important}
/* nastro giallo obliquo per etichette sezione (Badge, Prenotazioni) */
.pd-tape-lite{display:inline-block;background:#FDEF26;color:#101010;font-weight:800;font-size:12px;text-transform:uppercase;border:2px solid #101010;box-shadow:2px 2px 0 #101010;padding:5px 12px;border-radius:8px;transform:rotate(-2deg);margin:4px 0 12px}
/* ── Classifica: podio come camerino (avatar liberi, piedistalli pieni) ── */
.pod-av-wrap{border-radius:0!important;border:none!important;overflow:visible!important;background:transparent!important;box-shadow:none!important}
.pod-1 .pod-av-wrap,.pod-2 .pod-av-wrap,.pod-3 .pod-av-wrap{border:none!important;box-shadow:none!important}
.pod-base{border-radius:12px 12px 0 0!important;border:3px solid #101010!important;border-bottom:none!important;box-shadow:3px 3px 0 #101010!important;padding:10px 4px 8px!important}
.pod-1 .pod-base{background:#339966!important;min-height:74px!important}
.pod-2 .pod-base{background:#A3CFFE!important;min-height:56px!important}
.pod-3 .pod-base{background:#FF6DEC!important;min-height:44px!important}
.pod-base>div{color:#101010!important;font-size:26px!important;font-weight:900!important}
.pod-xp{color:#f0f0f0!important;font-size:11px!important;font-weight:800!important}
body.light .pod-xp{color:#101010!important}
/* corona podio obliqua */
.pod-crown{transform:rotate(-14deg)!important;font-size:22px!important;margin-bottom:2px!important}
/* Big Top: claim in alto, grande */
.btcal-claim{background:#FDEF26;color:#101010;border:3px solid #101010;border-radius:14px;box-shadow:4px 4px 0 #101010;padding:12px 14px;margin:0 0 14px;font-size:14px;font-weight:800;line-height:1.5;text-align:center}
.btcal-legend{margin:0 0 12px!important}
/* podio: avatar liberi, contenitore che abbraccia l'avatar (niente box fisso nero) */
.pod-1 .pod-av-wrap,.pod-2 .pod-av-wrap,.pod-3 .pod-av-wrap{width:auto!important;height:auto!important;background:transparent!important;overflow:visible!important;border:none!important;box-shadow:none!important}
.pod-av-wrap img{border-radius:16px!important;background:transparent!important}
/* Lab: immagine grande + reward tag ben leggibili */
.act-img{width:auto;height:auto;max-width:100%;max-height:400px;object-fit:contain;border:3px solid #101010;border-radius:12px;margin:0 auto 10px;display:block}
.act-rewards .reward-tag{font-size:14px!important;font-weight:800!important;padding:8px 14px!important;border:2px solid #101010!important;border-radius:8px!important}
/* Community: griglia di avatar grandi (tap per aprire) */
.comm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px}
.comm-tile{position:relative;background:#17181c;border:3px solid #33353c;border-radius:14px;box-shadow:3px 3px 0 #000;padding:12px 6px 10px;text-align:center;cursor:pointer}
.light .comm-tile{background:#fff;border-color:#101010;box-shadow:3px 3px 0 #101010}
.comm-medal{position:absolute;top:-9px;left:-9px;font-size:23px;transform:rotate(-12deg)}
.comm-av{width:64px;height:64px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;font-size:38px;line-height:1}
.comm-av-img{width:64px;height:64px;border-radius:14px;object-fit:cover;border:2.5px solid #101010;display:block}
.comm-nm{font-family:'Funnel Display',sans-serif;font-weight:800;font-size:13px;text-transform:uppercase;line-height:1.05;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.light .comm-nm{color:#101010}
.comm-xp{font-size:10px;font-weight:700;color:#cfcfcf;margin-top:3px}
.light .comm-xp{color:#101010}
/* check-in giornaliero/lab: pieni come le altre card */
.pd-checkin{background:#17181c!important;border:3px solid #33353c!important;box-shadow:3px 3px 0 #000!important;border-radius:16px!important}
.light .pd-checkin{background:#fff!important;border-color:#101010!important;box-shadow:3px 3px 0 #101010!important}
/* Big Top: legenda più grande, claim e calendario staccati dai bordi */
.btcal-legend{font-size:13px!important;gap:14px!important;margin:0 6px 12px!important}
.btcal-legend i{width:16px!important;height:16px!important}
.btcal-claim,.btcal-head,.btcal-grid,.btcal-panel,.btcal-checkin,.btcal-book{margin-left:6px!important;margin-right:6px!important}
.btcal-book{width:calc(100% - 12px)!important}
/* nastri e titoli più spaziati e coerenti con "COME STA LA CREATURA" */
.tape{font-family:var(--body)!important;font-weight:800!important;font-size:15px!important;text-transform:uppercase!important;padding:9px 20px!important;border:3px solid #101010!important;border-radius:11px!important;box-shadow:3px 3px 0 #101010!important;letter-spacing:.02em!important}
.pd-tape-lite{padding:8px 18px!important;font-size:13px!important;box-shadow:3px 3px 0 #101010!important;border-width:3px!important}
.pd-tab-title{padding:15px 44px!important;font-size:23px!important;margin:12px auto 22px!important}
.section-title{margin:16px 14px 8px!important}
/* reward tag Lab leggibili (pieni, testo nero) */
.act-rewards .xp-tag{background:#A3CFFE!important;color:#101010!important;border-color:#101010!important}
.act-rewards .coin-tag{background:#FDEF26!important;color:#101010!important;border-color:#101010!important}
/* righe classifica più distanziate */
.lb-list{gap:14px!important}
/* ricerca community: font Funnel + stile sticker */
.comm-search{width:100%;font-family:var(--body);font-weight:700;font-size:14px;border:3px solid #101010;border-radius:12px;padding:11px 14px;background:#fff;color:#101010}
.comm-search::placeholder{font-family:var(--body);font-weight:600;color:#8a8a8a}
body:not(.light) .comm-search{background:#17181c;border-color:#33353c;color:#fff}
body:not(.light) .comm-search::placeholder{color:#9a9a9a}
/* ── spaziatura laterale coerente su tutte le viste player (come il badge) ── */
.act-card{margin-left:14px!important;margin-right:14px!important}
.comm-grid{margin:0 14px!important}
/* Classifica: più spazio laterale */
.lb-row{margin-left:18px!important;margin-right:18px!important}
.podium{margin-left:18px!important;margin-right:18px!important}
/* spazio dopo i chip ANNUNCI/COMMUNITY */
.chiprow{margin-bottom:18px!important}
/* Community: avatar più grandi, tile bianche bordate come i titoli */
.comm-av{width:76px!important;height:76px!important;font-size:46px!important}
.comm-av-img{width:76px!important;height:76px!important;border-width:3px!important}
.comm-tile{border-width:3px!important}
/* Prenotazioni (.card-sm) leggibili anche in dark */
.card-sm{background:#fff!important;border:2.5px solid #101010!important;box-shadow:2px 2px 0 #101010!important;border-radius:12px!important;color:#101010!important}
body:not(.light) .card-sm{background:#17181c!important;border-color:#33353c!important;box-shadow:2px 2px 0 #000!important;color:#f0f0f0!important}
body:not(.light) .card-sm *{color:#f0f0f0!important}
/* prenotazioni: non attaccate al bordo */
.card-sm{margin-left:14px!important;margin-right:14px!important}
/* Classifica leggibile in dark (era testo sbiadito su nero) */
body:not(.light) .lb-name{color:#ffffff!important}
body:not(.light) .lb-rank{color:#d8d8d8!important}
body:not(.light) .lb-level{color:#b8b8b8!important}
body:not(.light) .lb-xp{color:#A3CFFE!important}
/* podio: niente overflow, colonne uguali dentro i margini */
.podium-wrap{overflow:visible!important;gap:6px!important}
.pod-col{flex:1!important;min-width:0!important}
.pod-base{width:100%!important;box-sizing:border-box!important}
/* barra livello piena (no trasparenza) di giorno */
.pug-lvltrack{background:#ECE6D5!important;border:3px solid #101010!important}
body:not(.light) .pug-lvltrack{background:#2a2a22!important;border-color:#33353c!important}
.podium-wrap{margin-left:18px!important;margin-right:18px!important}
.lb-list .lb-row{background:#fff!important;border:3px solid #101010!important;box-shadow:3px 3px 0 #101010!important}
body:not(.light) .lb-list .lb-row{background:#17181c!important;border-color:#101010!important;box-shadow:3px 3px 0 #000!important}
.card-sm{margin-left:0!important;margin-right:0!important}
.btcal-d{font-size:14px;font-weight:800;line-height:1}
.btcal-info{font-size:8px;font-weight:900;line-height:1;margin-top:2px;letter-spacing:-.02em}
.btcal-cell.full,.player-wrap.bg-notte .btcal-cell.full{background:#FF6DEC!important;color:#101010!important}
.btcal-turno.full,.player-wrap.bg-notte .btcal-turno.full{background:#FF6DEC!important;color:#101010!important}
.pd-badge-item{padding:14px 10px!important}
/* card livello: piena (era translucida rgba .88) */
.pd-card{background:#17181c!important;border:3px solid #33353c!important;box-shadow:3px 3px 0 #000!important}
.light .pd-card{background:#fff!important;border-color:#101010!important;box-shadow:3px 3px 0 #101010!important}
/* mittente-titolo: testo nero su giallo anche in dark */
.card-sm .msg-sender{color:#101010!important}
/* annunci: bordo nero pieno */
.ann-card{border:3px solid #101010!important;border-radius:14px!important;background:#fff!important}
body:not(.light) .ann-card{border-color:#33353c!important;background:#17181c!important;color:#f0f0f0!important}
/* Educatore: sfondi reali per sezione (wide), night nero, doodle vecchi via */
.edu-main.ebg-azzurro{background:#A3CFFF url(/public/sfondi/sfondo-azzurro-wide.webp?v4) top center/cover no-repeat!important}
.edu-main.ebg-rosa{background:#FF6DEC url(/public/sfondi/sfondo-rosa-wide.webp?v4) top center/cover no-repeat!important}
.edu-main.ebg-giallo{background:#FCEF25 url(/public/sfondi/sfondo-giallo-wide.webp?v4) top center/cover no-repeat!important}
.edu-main.ebg-verde{background:#339967 url(/public/sfondi/sfondo-verde-wide.webp?v4) top center/cover no-repeat!important}
.edu-main.ebg-rosso{background:#D41423 url(/public/sfondi/sfondo-rosso-wide.webp?v4) top center/cover no-repeat!important}
body:not(.light) .edu-main{background:#0d0d0d url(/public/sfondi/sfondo-notte-wide.webp?v4) top center/cover no-repeat!important}
.edu-main .bg-doodles{display:none!important}
/* === Sfondo educatore su LAYER FISSO dietro il contenuto (desktop + mobile/iOS, viste lunghe) === */
.edu-main{position:relative}
.edu-main[class*="ebg-"]{background:transparent!important}
body:not(.light) .edu-main{background:transparent!important}
.edu-main::before{content:"";position:fixed;inset:0;z-index:0;background-size:cover;background-position:center;background-repeat:no-repeat;pointer-events:none}
.edu-main>*{position:relative;z-index:1}
.edu-main.ebg-azzurro::before{background-color:#A3CFFF;background-image:url(/public/sfondi/sfondo-azzurro-tel2.webp)}
.edu-main.ebg-rosa::before{background-color:#FF6DEC;background-image:url(/public/sfondi/sfondo-rosa-tel2.webp)}
.edu-main.ebg-giallo::before{background-color:#FCEF25;background-image:url(/public/sfondi/sfondo-giallo-tel2.webp)}
.edu-main.ebg-verde::before{background-color:#339967;background-image:url(/public/sfondi/sfondo-verde-tel2.webp)}
.edu-main.ebg-rosso::before{background-color:#D41423;background-image:url(/public/sfondi/sfondo-rosso-tel2.webp)}
body:not(.light) .edu-main::before{background-color:#0d0d0d;background-image:url(/public/sfondi/sfondo-notte-tel2.webp)}
@media(min-width:768px){
.edu-main.ebg-azzurro::before{background-image:url(/public/sfondi/sfondo-azzurro-wide.webp?v4)}
.edu-main.ebg-rosa::before{background-image:url(/public/sfondi/sfondo-rosa-wide.webp?v4)}
.edu-main.ebg-giallo::before{background-image:url(/public/sfondi/sfondo-giallo-wide.webp?v4)}
.edu-main.ebg-verde::before{background-image:url(/public/sfondi/sfondo-verde-wide.webp?v4)}
.edu-main.ebg-rosso::before{background-image:url(/public/sfondi/sfondo-rosso-wide.webp?v4)}
body:not(.light) .edu-main::before{background-image:url(/public/sfondi/sfondo-notte-wide.webp?v4)}
}
/* desktop: sfondo agganciato alla finestra (viste lunghe ok). Mobile: scroll + immagine verticale. */
@media(min-width:768px){
.edu-main[class*="ebg-"]{background-attachment:fixed!important;background-position:center top!important}
body:not(.light) .edu-main{background-attachment:fixed!important;background-position:center top!important}
.player-wrap[class*="bg-"]{background-attachment:fixed!important;background-position:center top!important}
}
@media(max-width:767px){
.edu-main.ebg-azzurro{background-image:url(/public/sfondi/sfondo-azzurro-tel2.webp)!important}
.edu-main.ebg-rosa{background-image:url(/public/sfondi/sfondo-rosa-tel2.webp)!important}
.edu-main.ebg-giallo{background-image:url(/public/sfondi/sfondo-giallo-tel2.webp)!important}
.edu-main.ebg-verde{background-image:url(/public/sfondi/sfondo-verde-tel2.webp)!important}
.edu-main.ebg-rosso{background-image:url(/public/sfondi/sfondo-rosso-tel2.webp)!important}
body:not(.light) .edu-main{background-image:url(/public/sfondi/sfondo-notte-tel2.webp)!important}
}

/* Educatore: titolo a barra come player */
.edu-titlebar{display:inline-block;background:var(--pg,#101010);color:#101010;border:3px solid #101010;border-radius:12px;box-shadow:4px 4px 0 #101010;padding:9px 20px;font-family:'Funnel Display',sans-serif;font-weight:800;font-size:19px;text-transform:uppercase;transform:rotate(-1.5deg);letter-spacing:.02em;line-height:1.05}
.light .edu-titlebar{background:#fff}
/* Educatore: superfici piene (niente trasparenze in notte) */
body:not(.light){--surface:#17181c;--surface2:#1e1e20;--surface3:#262629;--text:#f0f0f0;--text2:rgba(255,255,255,.74);--text3:rgba(255,255,255,.55);--border:#33353c;--border2:#4a4a4c;--card:#17181c}
.mob-header-title{display:none!important}
/* Educatore: ogni casella piena — nera in notte, bianca di giorno (niente blu/trasparenze) */
body:not(.light) .player-card,body:not(.light) .squad-row,body:not(.light) .stat-card,body:not(.light) .card,body:not(.light) .card-sm{background:#17181c!important;border:2.5px solid #33353c!important;box-shadow:3px 3px 0 #000!important}
.light .player-card,.light .squad-row,.light .stat-card,.light .card,.light .card-sm{background:#fff!important;border:2.5px solid #101010!important;box-shadow:3px 3px 0 #101010!important}
/* titolo vista in casella, centrato (nero notte / bianco giorno) */
.edu-vtitle{display:block!important;width:fit-content!important;max-width:calc(100% - 24px)!important;margin:8px auto 18px!important;background:#101010;color:#fff!important;border:3px solid #101010;border-radius:12px;box-shadow:4px 4px 0 rgba(0,0,0,.45);padding:12px 30px!important;transform:rotate(-1.5deg);text-align:center}
.light .edu-vtitle{background:#fff;color:#101010!important;border-color:#101010;box-shadow:4px 4px 0 #101010}
/* Titolo sezione educatore in casella (come player) */
.section-banner-title{display:inline-block!important;width:auto!important;margin:6px auto 8px!important;background:var(--pg,#101010)!important;color:#101010!important;border:3px solid #101010!important;border-radius:12px!important;box-shadow:4px 4px 0 rgba(0,0,0,.45)!important;padding:12px 30px!important;transform:rotate(-1.5deg)!important;font-family:'Funnel Display',sans-serif!important;font-weight:900!important;text-transform:uppercase!important}
.light .section-banner-title{background:#fff!important;color:#101010!important;border-color:#101010!important;box-shadow:4px 4px 0 #101010!important}
.section-banner-content{text-align:center!important}
/* sottotitolo banner (es. "0 attive"): calcato e bianco leggibile */
.section-banner-sub{color:#fff!important;font-weight:800!important;font-size:13px!important;text-shadow:0 1px 3px rgba(0,0,0,.55)!important;opacity:1!important}
/* testi secondari più pieni (meno opachi) */
body:not(.light){--text3:rgba(255,255,255,.78)}
.mob-header{border-bottom:none!important}
.mob-header{z-index:40!important}
/* fix ghosting iOS su scroll (header fisso che sembra doppio) */
.mob-header{transform:translateZ(0)!important;-webkit-transform:translateZ(0)!important;will-change:transform;-webkit-backface-visibility:hidden;backface-visibility:hidden}
/* barra doppia: la topbar desktop non deve mai comparire su mobile */
@media(max-width:767px){.topbar{display:none!important}}
/* #6 login: avatar quadrato e più grande */
.avatar-preview{width:112px!important;height:112px!important;border-radius:16px!important;object-fit:cover!important;border:3px solid #101010!important}
/* #4 presenze: toggle dimensione fissa (non si stringe da segnato) */
.pres-toggle,.pres-toggle.done,.pres-toggle.empty{min-width:42px!important;min-height:42px!important;width:42px!important;height:42px!important;box-sizing:border-box!important;flex-shrink:0!important}
/* #5 Big Top player: legenda con fondo a contrasto */
.btcal-legend{background:rgba(255,255,255,.82)!important;padding:9px 12px!important;border-radius:10px!important}
.player-wrap.bg-notte .btcal-legend{background:rgba(23,24,28,.82)!important;color:#fff!important}
/* #4 presenze: toggle dimensione fissa e coerente (regola forte) */
.pres-table td .pres-toggle{width:42px!important;height:42px!important;aspect-ratio:1!important;padding:0!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-sizing:border-box!important}
/* #7 login: foglia ferma su mobile */
@media(max-width:767px){@keyframes leafsway{0%,50%,100%{margin-left:0}}}
/* #5 rispetta la riduzione movimento di sistema */
.pug-roomzone .pug-room{overflow:visible!important;position:relative}
body:not(.light) .pug-roomzone .pug-room{background-image:url(data:image/webp;base64,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)!important;background-size:cover!important;background-position:center!important}
@keyframes pugfoodpop{0%{transform:translate(-50%,-50%) scale(.4);opacity:0}22%{transform:translate(-50%,-50%) scale(1.12);opacity:1}38%{transform:translate(-50%,-50%) scale(1);opacity:1}80%{transform:translate(-50%,-50%) scale(1);opacity:1}100%{transform:translate(-50%,-50%) scale(.8);opacity:0}}
@keyframes pugburp{0%{opacity:0;transform:translateY(8px) rotate(-8deg) scale(.5)}10%{opacity:1;transform:translateY(0) rotate(-8deg) scale(1.2)}18%{transform:translateY(-4px) rotate(-8deg) scale(1)}82%{opacity:1;transform:translateY(-6px) rotate(-8deg) scale(1)}100%{opacity:0;transform:translateY(-9px) rotate(-8deg) scale(.95)}}
@media (prefers-reduced-motion: reduce){ [style*="pugfoodpop"]{animation-duration:1s!important} [style*="pugburp"]{animation-duration:2.5s!important} }
@media (prefers-reduced-motion: reduce){ *,*::before,*::after{ animation-duration:.001s!important; animation-iteration-count:1!important; transition-duration:.001s!important; scroll-behavior:auto!important } }
/* #5 night: bottoni filtro/ghost nelle barre filtro non translucidi */
body:not(.light) .filter-bar .btn-ghost{background:var(--surface2)!important;border-color:var(--border)!important;color:var(--text)!important}
body:not(.light) .pres-table td, body:not(.light) .pres-table th{background:var(--surface)!important}
/* #10 podio: nome come mini-titolo, niente a-capo (ellissi se lungo) */
.podium-wrap .pod-name{display:inline-block!important;max-width:100%!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;background:#101010!important;color:#fff!important;border:2px solid #101010!important;border-radius:8px!important;padding:3px 10px!important;box-shadow:2px 2px 0 rgba(0,0,0,.4)!important;font-size:11px!important;line-height:1.15!important;margin-top:6px!important}
.light .podium-wrap .pod-name{background:#fff!important;color:#101010!important;box-shadow:2px 2px 0 #101010!important}
.podium-wrap .pod-name span{background:transparent!important}
.light{--text3:rgba(16,16,16,.82)}
body:not(.light){--text3:rgba(255,255,255,.82)}
/* via le righe gialle sopra le stat-card (dashboard/giocatori) */
.stat-card::before{display:none!important}
/* testi notte più pieni (meno sfumati) */
body:not(.light){--text2:rgba(255,255,255,.86);--text3:rgba(255,255,255,.7)}
.topbar{overflow:visible}

.player-wrap[class*="bg-"]{position:relative;background:transparent!important}
.player-wrap[class*="bg-"]::before{content:"";position:fixed;inset:0;z-index:-1;background-size:cover;background-position:top center;background-repeat:no-repeat;pointer-events:none}
.player-wrap.bg-azzurro::before{background-color:#A3CFFF;background-image:url(/public/sfondi/sfondo-azzurro-tel2.webp)}
.player-wrap.bg-rosa::before{background-color:#FF6DEC;background-image:url(/public/sfondi/sfondo-rosa-tel2.webp)}
.player-wrap.bg-giallo::before{background-color:#FCEF25;background-image:url(/public/sfondi/sfondo-giallo-tel2.webp)}
.player-wrap.bg-verde::before{background-color:#339967;background-image:url(/public/sfondi/sfondo-verde-tel2.webp)}
.player-wrap.bg-rosso::before{background-color:#D41423;background-image:url(/public/sfondi/sfondo-rosso-tel2.webp)}
.player-wrap.bg-notte::before{background-color:#0d0d0d;background-image:url(/public/sfondi/sfondo-notte-tel2.webp)}
@media(min-width:640px){
.player-wrap.bg-azzurro::before{background-image:url(/public/sfondi/sfondo-azzurro-wide.webp?v4)}
.player-wrap.bg-rosa::before{background-image:url(/public/sfondi/sfondo-rosa-wide.webp?v4)}
.player-wrap.bg-giallo::before{background-image:url(/public/sfondi/sfondo-giallo-wide.webp?v4)}
.player-wrap.bg-verde::before{background-image:url(/public/sfondi/sfondo-verde-wide.webp?v4)}
.player-wrap.bg-rosso::before{background-image:url(/public/sfondi/sfondo-rosso-wide.webp?v4)}
.player-wrap.bg-notte::before{background-image:url(/public/sfondi/sfondo-notte-wide.webp?v4)}
}

  .pd-topbar { position:fixed; top:0; left:0; right:0; height:56px; background:#0d0d0d; border-bottom:1px solid rgba(255,255,255,.1); z-index:20; display:flex; align-items:center; padding:0 14px; justify-content:space-between; backdrop-filter:blur(20px); }
  .pd-logo-box { background:var(--rosso); border-radius:9px 12px 9px 14px; padding:4px 10px; transform:rotate(-1.5deg); box-shadow:2px 3px 0 rgba(0,0,0,.2); }
  .pd-logo-t { font-family:'Funnel Display',sans-serif; font-size:13px; font-weight:900; color:#111; line-height:1.05; text-transform:uppercase; letter-spacing:-.3px; }
  .pd-logo-sub { font-family:'Funnel Display',sans-serif; background:#111; color:var(--giallo); font-size:8px; font-weight:900; border-radius:4px; padding:2px 7px; text-transform:uppercase; letter-spacing:.07em; margin-top:2px; display:inline-block; }
  .pd-scroll { padding-top:66px; padding-bottom:calc(68px + env(safe-area-inset-bottom,0px)); }
  .pd-av-zone { display:flex; flex-direction:column; align-items:center; padding-top:6px; position:relative; z-index:2; }
  .pd-av-glow { position:absolute; width:280px; height:240px; border-radius:50%; background:radial-gradient(circle,rgba(255,255,255,.38) 0%,transparent 70%); top:0; left:50%; transform:translateX(-50%); filter:blur(18px); pointer-events:none; }
  .pd-av-img { width:240px; height:240px; object-fit:contain; position:relative; z-index:3; filter:drop-shadow(0 12px 28px rgba(0,0,0,.55)) drop-shadow(0 0 50px rgba(100,160,255,.28)); margin-bottom:-14px; }
  .pd-av-emoji { font-size:160px; line-height:1; position:relative; z-index:3; margin-bottom:-14px; filter:drop-shadow(0 12px 28px rgba(0,0,0,.55)); display:block; text-align:center; }
  .pd-name-pill { transform:rotate(-2deg); margin-top:16px; background:#111; color:#fff; font-family:'Funnel Display',sans-serif; font-size:21px; font-weight:900; text-transform:uppercase; letter-spacing:.07em; border-radius:10px 13px 10px 15px; padding:5px 18px; position:relative; z-index:3; margin-bottom:4px; box-shadow:2px 3px 0 rgba(0,0,0,.3); }
  .pd-lv-pill { display:inline-flex; align-items:center; gap:5px; background:rgba(163,207,254,.1); border:1px solid rgba(163,207,254,.28); border-radius:99px; padding:4px 14px; font-size:10px; font-weight:700; color:var(--neon-blue); letter-spacing:.07em; text-transform:uppercase; position:relative; z-index:3; margin-bottom:12px; }
  .pd-card { margin:0 14px 8px; background:rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.12); border-radius:14px; padding:12px 14px; position:relative; z-index:2; }
  .pd-sg { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin:0 14px 8px; position:relative; z-index:2; }
  .pd-sc { background:rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:11px 6px; text-align:center; }
  .pd-sv { font-family:'Funnel Display',sans-serif; font-size:24px; font-weight:900; color:#FDEF26; line-height:1; display:block; }
  .pd-sl { font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.1em; color:var(--text3); margin-top:2px; display:block; }
  .pd-squad { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(255,255,255,.12); border-radius:12px; padding:11px 14px; display:flex; align-items:center; gap:10px; position:relative; z-index:2; }
  .pd-sfida { margin:0 14px 8px; background:#111; border-radius:16px; padding:14px 16px; position:relative; z-index:2; overflow:hidden; }
  .pd-sfida::after { content:'★'; position:absolute; right:14px; top:50%; transform:translateY(-50%); font-size:44px; color:rgba(255,220,0,.1); line-height:1; }  /* pug-ok: stella decorativa su pd-sfida blu notte */
  .pd-badges { margin:0 14px 8px; position:relative; z-index:2; }
  .pd-badge-row { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; scrollbar-width:none; }
  .pd-badge-row::-webkit-scrollbar { display:none; }
  .pd-badge-item { flex-shrink:0; background:rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:10px 8px; text-align:center; min-width:68px; cursor:pointer; transition:all .2s; }
  .pd-badge-item:hover { border-color:rgba(255,0,204,.4); transform:translateY(-2px); }
  .pd-checkin { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(51,153,102,.2); border-radius:16px; padding:14px; position:relative; z-index:2; }
  .pd-tab-title { font-family:'Funnel Display',sans-serif; font-size:30px; font-weight:900; text-transform:uppercase; letter-spacing:.04em; margin-bottom:14px; position:relative; z-index:2; padding:0 2px; }
  /* override bottom nav for new design */
  .player-bottom-nav { background:#0d0d0d !important; border-top:1px solid #2a2a2a !important; }
  .player-nav-btn { color:rgba(255,255,255,.28) !important; }  /* pug-ok: testo su fondo nero */
  .player-nav-btn.active { color:#FDEF26 !important; }
  .player-nav-btn.active::after { background:#FDEF26 !important; box-shadow:0 0 8px rgba(253,239,38,.5) !important; }


  /* ═══════ CAMERINO 18 — FOGLIO UFFICIALE (vince su tutto) ═══════ */

  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  :root{--azzurro:#A3CFFE;--rosa:#FF6DEC;--giallo:#FDEF26;--verde:#339966;--rosso:#D41323;--nero:#101010;--bianco:#FFFFFF;--body:'Funnel Display',sans-serif;--hand:'Jelek Type',cursive}
  
  body:not(.light){background:#000}
  .toolbar{position:sticky;top:0;z-index:100;display:flex;justify-content:center;gap:10px;padding:12px;background:rgba(0,0,0,.6);backdrop-filter:blur(10px)}
  
  body:not(.light) 
  .side-label{font-family:var(--body);font-weight:800;font-size:22px;text-transform:uppercase;color:#fff;text-align:center;margin:34px 0 4px;letter-spacing:.04em}
  .gallery{display:flex;flex-wrap:wrap;gap:26px;justify-content:center;padding:20px 16px 40px}
  .col{display:flex;flex-direction:column;align-items:center;gap:10px}
  .plabel{font-family:var(--body);font-weight:800;font-size:14px;text-transform:uppercase;color:#fff}
  
  body:not(.light) 
  .bg-doodles{position:absolute;inset:0;z-index:0;pointer-events:none}
  body:not(.light) .bg-doodles{color:#fff !important;opacity:.20 !important}
  .topbar{position:relative;z-index:20;height:58px;border-bottom:3px solid var(--nero);display:flex;align-items:center;padding:0 14px;justify-content:space-between}
  body:not(.light) .topbar{border-color:#2a2a2a}
  .logo-img{width:86px;height:38px;background-position:left center;background-repeat:no-repeat;background-size:contain}
   .logo-w{background-image:url(/public/sfondi/logo-riquadro_bianco.webp) .logo-w{display:block}
  .coinbox{font-family:var(--body);font-weight:800;font-size:14px;background:#fff;border:2.5px solid var(--nero);border-radius:9px;padding:5px 10px 3px;box-shadow:2px 2px 0 var(--nero);display:flex;gap:4px;align-items:center}
  body:not(.light) .coinbox{background:#1a1a1a;border-color:#444;color:#fff;box-shadow:2px 2px 0 #000}
  .icon-btn{background:var(--bianco);border:2.5px solid var(--nero);border-radius:9px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;box-shadow:2px 2px 0 var(--nero)}
  body:not(.light) .icon-btn{background:#1a1a1a;border-color:#444;color:#fff;box-shadow:2px 2px 0 #000}
  .scroll{position:relative;z-index:2;padding-bottom:80px;min-height:560px}
  .section-title{font-family:var(--body);font-weight:800;font-size:26px;text-transform:uppercase;margin:14px 14px 4px;position:relative;z-index:2}
  body:not(.light) .section-title{color:#fff !important}
  .card{position:relative;z-index:2;margin:12px 14px;background:var(--bianco);border:3px solid var(--nero);border-radius:16px 20px 14px 22px;padding:14px 15px;box-shadow:4px 4px 0 var(--nero)}
  body:not(.light) .card{background:#17181c;border-color:#33353c;box-shadow:4px 4px 0 #000;color:#f0f0f0}
  .tape{display:inline-block;font-family:var(--body);font-weight:800;font-size:14px;text-transform:uppercase;padding:6px 12px;transform:rotate(-2deg);box-shadow:2px 2px 0 var(--nero);border:2px solid var(--nero);margin-bottom:11px}
  .chiprow{display:flex;gap:7px;flex-wrap:wrap;margin:0 14px 12px;position:relative;z-index:2}
  .chip{font-family:var(--body);font-weight:800;font-size:12px;text-transform:uppercase;background:var(--bianco);border:2.5px solid var(--nero);border-radius:99px;padding:7px 13px 5px;cursor:pointer;box-shadow:2px 2px 0 var(--nero)}
  .chip.on{background:var(--nero);color:var(--giallo)}
  body:not(.light) .chip{background:#17181c;border-color:#000;color:#ccc;box-shadow:2px 2px 0 #000}
  body:not(.light) .chip.on{background:var(--giallo);color:#000}
  /* stanza */
  .hero{position:relative;padding:14px 0 8px;display:flex;flex-direction:column;align-items:center}
  .room-zone{position:relative;margin-bottom:12px}
  .room{position:relative;width:336px;height:300px;border:4px solid var(--nero);border-radius:24px;overflow:hidden;box-shadow:5px 6px 0 var(--nero);background-image:url(data:image/webp;base64,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
  .ppimg{position:absolute;top:0;left:0;width:160px;height:120px;transform-origin:0 0;transform:matrix3d(0.239281,-0.030579,0,-0.000160,-0.028710,0.315293,0,-0.000299,0,0,1,0,95.9,111.5,0,1);background-size:cover;box-shadow:inset 0 0 8px rgba(0,0,0,.45);opacity:0;transition:opacity .25s;pointer-events:none;z-index:4}
  .ppimg.on{opacity:1}
  .frame-hit{position:absolute;top:110px;left:92px;width:50px;height:48px;z-index:6;cursor:pointer}
  .obj{position:absolute;z-index:6;cursor:pointer;width:40px;height:40px}
  .obj .glow,.frame-hit .glow{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(255,255,255,.85);animation:ping 2.4s ease-out infinite;pointer-events:none}
  .frame-hit .glow{border-radius:6px}
  @keyframes ping{0%{transform:scale(.6);opacity:.85}100%{transform:scale(1.5);opacity:0}}
  .obj-bowl{top:150px;left:50%;transform:translateX(-50%)} .obj-shelf{top:74px;left:82px} .obj-door{top:100px;left:20px;width:44px;height:64px} .obj-cab{bottom:88px;right:18px}
  .pet-shadow{position:absolute;bottom:14px;left:50%;width:104px;height:22px;transform:translateX(-50%);background:radial-gradient(ellipse,rgba(0,0,0,.34),transparent 70%);filter:blur(4px);z-index:2;animation:shadowbob 3.4s ease-in-out infinite}
  .pet{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);width:112px;cursor:pointer;filter:drop-shadow(0 10px 8px rgba(0,0,0,.24));animation:bob 3.4s ease-in-out infinite;z-index:3}
  @keyframes bob{0%,100%{transform:translateX(-50%) translateY(0) rotate(-1deg)}50%{transform:translateX(-50%) translateY(-7px) rotate(1deg)}}
  @keyframes shadowbob{0%,100%{transform:translateX(-50%) scale(1);opacity:.8}50%{transform:translateX(-50%) scale(.82);opacity:.5}}
  .visitor{position:absolute;bottom:26px;right:-6px;width:64px;z-index:4;filter:drop-shadow(0 6px 5px rgba(0,0,0,.2));animation:peekin 6s ease-in-out infinite}
  @keyframes peekin{0%,55%,100%{transform:translateX(32px)}70%,90%{transform:translateX(0)}}
  .squad-tab-v{position:absolute;top:50%;left:calc(100% - 12px);transform:translateY(-50%);writing-mode:vertical-rl;font-family:var(--body);font-weight:800;font-size:13px;text-transform:uppercase;border:3px solid var(--nero);border-left:none;border-radius:0 13px 13px 0;padding:14px 7px 14px 18px;box-shadow:3px 2px 0 rgba(0,0,0,.28);z-index:1}
  .name-plain{position:relative;z-index:3;font-family:var(--body);font-weight:800;font-size:32px;color:var(--nero);text-transform:uppercase;text-shadow:2px 3px 0 rgba(0,0,0,.18)}
  body:not(.light) .name-plain{color:#fff;text-shadow:2px 3px 0 rgba(0,0,0,.6)}
  .real-name{position:relative;z-index:3;font-family:var(--hand);font-size:26px;margin-top:6px;display:inline-flex;gap:8px;border-bottom:2px dotted rgba(0,0,0,.3);padding:0 6px 2px;line-height:1}
  body:not(.light) .real-name{color:#eee;border-color:rgba(255,255,255,.3)}
  .vital{display:flex;align-items:center;gap:9px;margin-bottom:8px} .vital:last-child{margin-bottom:0}
  .vital .vi{font-size:17px;width:22px;text-align:center} .vital .vname{font-weight:800;font-size:11px;text-transform:uppercase;width:60px}
  .vbar{flex:1;height:14px;background:#eee;border:2.5px solid var(--nero);border-radius:99px;overflow:hidden} body:not(.light) .vbar{background:#26272c}
  .vfill{height:100%;border-radius:99px} .vpct{font-weight:800;font-size:12px;width:32px;text-align:right}
  .lvl-track{position:relative;height:26px;background:#efe6cf;border:3px solid var(--nero);border-radius:99px;box-shadow:inset 2px 2px 0 rgba(0,0,0,.1);margin-top:6px} body:not(.light) .lvl-track{background:#2a2a22;border-color:#33353c}
  .lvl-grow{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:var(--verde);width:71%}
  .lvl-grow::after{content:'';position:absolute;top:3px;left:8px;right:8px;height:5px;border-radius:99px;background:rgba(255,255,255,.3)}
  .lvl-tip{position:absolute;right:-6px;top:-13px;font-size:19px;transform:rotate(18deg)}
  .lvl-rem{font-weight:600;font-size:13px;margin-top:8px;display:flex;gap:6px} .lvl-rem b{color:var(--rosso)} .lvl-rem .goal{margin-left:auto;font-weight:800;text-transform:uppercase;font-size:11px;opacity:.75}
  body:not(.light) .lvl-rem{color:#e8e8e8}
  /* podio */
  .podium{display:flex;align-items:flex-end;justify-content:center;gap:8px;margin:6px 14px 12px;position:relative;z-index:2}
  .pod{flex:1;text-align:center}
  .pod .pav{font-size:38px;display:block;margin-bottom:3px}
  .pod .pname{font-weight:800;font-size:11px;text-transform:uppercase;margin-bottom:4px;line-height:1}
  .pod .pblock{border:3px solid var(--nero);border-radius:12px 12px 0 0;box-shadow:3px 3px 0 var(--nero);display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:800}
  body:not(.light) .pod .pblock{border-color:#000;box-shadow:3px 3px 0 #000}
  .pod .medal{font-size:20px} .pod .pxp{font-size:12px}
  .lb-row{display:flex;align-items:center;gap:10px;border:3px solid var(--nero);border-radius:13px 17px 12px 16px;padding:8px 12px;margin:0 14px 8px;box-shadow:3px 3px 0 var(--nero);position:relative;z-index:2;background:var(--bianco)}
  body:not(.light) .lb-row{background:#17181c;border-color:#33353c;box-shadow:3px 3px 0 #000;color:#f0f0f0}
  .lb-rank{font-weight:800;font-size:19px;width:32px;text-align:center} .lb-av{font-size:27px;width:34px;text-align:center}
  .lb-name{font-weight:800;font-size:15px;text-transform:uppercase;line-height:1} .lb-sub{font-size:10px;font-weight:700;opacity:.65;margin-top:2px}
  .lb-xp{margin-left:auto;font-weight:800;font-size:17px} .lb-xp small{font-size:10px;opacity:.6;display:block;text-align:right}
  .me-badge{font-weight:800;font-size:10px;background:var(--nero);color:var(--giallo);border-radius:6px;padding:2px 6px;margin-left:6px}
  .row-item{display:flex;align-items:center;gap:11px}
  .btn-dark{font-family:var(--body);font-weight:800;font-size:13px;background:var(--nero);color:var(--giallo);border:none;border-radius:9px;padding:9px 13px;cursor:pointer;text-transform:uppercase;box-shadow:2px 2px 0 rgba(0,0,0,.3)}
  body:not(.light) .btn-dark{background:var(--giallo);color:var(--nero)}
  .code-box{flex:1;font-weight:800;font-size:19px;letter-spacing:5px;text-align:center;background:#f2f2ef;border:3px dashed var(--nero);border-radius:11px;padding:8px}
  body:not(.light) .code-box{background:#111;border-color:#444;color:#fff}
  /* chat */
  .msg{max-width:78%;border:2.5px solid var(--nero);border-radius:14px 14px 14px 3px;padding:9px 12px;margin:0 14px 9px;position:relative;z-index:2;background:var(--bianco);box-shadow:2px 2px 0 var(--nero);font-size:13px;font-weight:600}
  .msg .who{font-weight:800;font-size:10px;text-transform:uppercase;opacity:.6;margin-bottom:2px}
  .msg.me{margin-left:auto;border-radius:14px 14px 3px 14px}
  body:not(.light) .msg{background:#17181c;border-color:#33353c;box-shadow:2px 2px 0 #000;color:#f0f0f0}
  .msgbar{display:flex;gap:8px;margin:4px 14px 10px;position:relative;z-index:2}
  .msgbar input{flex:1;font-family:var(--body);font-weight:600;font-size:13px;border:3px solid var(--nero);border-radius:99px;padding:10px 14px;background:var(--bianco)}
  body:not(.light) .msgbar input{background:#17181c;border-color:#33353c;color:#fff}
  /* notifiche */
  .notif{display:flex;gap:11px;align-items:flex-start;border:3px solid var(--nero);border-radius:14px;padding:11px 13px;margin:0 14px 9px;background:var(--bianco);box-shadow:3px 3px 0 var(--nero);position:relative;z-index:2}
  body:not(.light) .notif{background:#17181c;border-color:#33353c;box-shadow:3px 3px 0 #000;color:#f0f0f0}
  .notif .ni{font-size:24px;width:30px;text-align:center}
  .notif .nt{font-weight:800;font-size:13px;text-transform:uppercase} .notif .nb{font-size:12px;font-weight:600;opacity:.75;margin-top:2px} .notif .nd{font-size:10px;opacity:.5;margin-top:3px;font-weight:700}
  .ndot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rosso);margin-left:6px}
  /* annuncio/bacheca */
  .ann{border:3px solid var(--nero);border-radius:16px;margin:0 14px 10px;background:var(--bianco);box-shadow:3px 3px 0 var(--nero);overflow:hidden;position:relative;z-index:2}
  body:not(.light) .ann{background:#17181c;border-color:#33353c;box-shadow:3px 3px 0 #000;color:#f0f0f0}
  .ann .ahead{padding:8px 13px;font-weight:800;font-size:12px;text-transform:uppercase;border-bottom:2.5px solid var(--nero);display:flex;justify-content:space-between}
  body:not(.light) .ann .ahead{border-color:#33353c}
  .ann .abody{padding:11px 13px;font-size:13px;font-weight:600}
  /* educatore */
  .edu-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 14px;position:relative;z-index:2}
  .edu-stat{border:3px solid var(--nero);border-radius:15px 18px 13px 17px;padding:12px 13px;box-shadow:3px 3px 0 var(--nero);background:var(--bianco)}
  body:not(.light) .edu-stat{border-color:#000;box-shadow:3px 3px 0 #000}
  .edu-stat .ic{font-size:19px} .edu-stat .v{font-weight:800;font-size:29px;line-height:1;display:block;margin-top:4px}
  .edu-stat .l{font-size:10px;font-weight:800;text-transform:uppercase;margin-top:3px;opacity:.72}
  .chart{display:flex;gap:6px;align-items:flex-end;height:90px;margin-top:6px}
  .chart .bcol{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
  .chart .bar{width:100%;background:var(--nero);border-radius:5px 5px 0 0;min-height:5px} .chart .bar.today{background:var(--verde)}
  body:not(.light) .chart .bar{background:#555}
  .chart .bn{font-weight:800;font-size:11px} .chart .bd{font-size:9px;font-weight:800;text-transform:uppercase;opacity:.6}
  .prow{display:flex;align-items:center;gap:10px;border:3px solid var(--nero);border-radius:13px;padding:8px 12px;margin:0 14px 8px;box-shadow:3px 3px 0 var(--nero);background:var(--bianco);position:relative;z-index:2}
  body:not(.light) .prow{background:#17181c;border-color:#33353c;box-shadow:3px 3px 0 #000;color:#f0f0f0}
  .prow .pav{font-size:26px} .prow .pnm{font-weight:800;font-size:14px;text-transform:uppercase;line-height:1} .prow .psb{font-size:10px;font-weight:700;opacity:.6;margin-top:2px}
  .togglerow{display:flex;align-items:center;gap:11px;border:3px solid var(--nero);border-radius:13px;padding:10px 13px;margin:0 14px 8px;box-shadow:3px 3px 0 var(--nero);background:var(--bianco);position:relative;z-index:2}
  body:not(.light) .togglerow{background:#17181c;border-color:#33353c;box-shadow:3px 3px 0 #000;color:#f0f0f0}
  .togglerow .tl{flex:1;font-weight:800;font-size:13px;text-transform:uppercase}
  .sw{width:44px;height:24px;border:2.5px solid var(--nero);border-radius:99px;position:relative;cursor:pointer;background:#ddd}
  .sw::after{content:'';position:absolute;top:1px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid var(--nero);transition:left .15s}
  .sw.on{background:var(--verde)} .sw.on::after{left:20px}
  .qrbig{width:150px;height:150px;margin:8px auto 4px;border:4px solid var(--nero);border-radius:14px;background:
    repeating-conic-gradient(#101010 0% 25%, #fff 0% 50%) 0 0/22px 22px;position:relative;z-index:2;box-shadow:4px 4px 0 var(--nero)}
  body:not(.light) .qrbig{box-shadow:4px 4px 0 #000;border-color:#fff}
  .heart{position:absolute;bottom:120px;left:50%;font-size:22px;pointer-events:none;animation:floatup 1.1s ease-out forwards;z-index:11}
  @keyframes floatup{0%{opacity:1;transform:translateY(0) scale(.6)}100%{opacity:0;transform:translateY(-70px) scale(1.2)}}
  .toast{position:absolute;left:50%;bottom:88px;transform:translateX(-50%) translateY(10px);z-index:60;background:var(--nero);color:#fff;font-weight:800;font-size:12px;padding:9px 16px;border-radius:99px;opacity:0;transition:all .25s;white-space:nowrap}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .bnav{position:relative;z-index:30;display:flex;background:var(--nero);padding:8px 0 12px} body:not(.light) .bnav{background:#000;border-top:2px solid #222}
  .nav-btn{flex:1;background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;color:rgba(255,255,255,.45);font-family:var(--body);position:relative}  /* pug-ok: testo su fondo nero */
  .nav-btn .nic{font-size:19px} .nav-btn .nlb{font-size:8px;font-weight:800;text-transform:uppercase}
  .nav-btn.active{color:var(--giallo)} .nav-btn.active::after{content:'';position:absolute;top:-8px;left:50%;transform:translateX(-50%);width:24px;height:4px;border-radius:99px;background:var(--giallo)}
  .nav-btn .nbadge{position:absolute;top:-4px;right:22%;background:var(--rosso);color:#fff;font-size:9px;font-weight:800;border-radius:99px;padding:1px 5px}

`;


// ─── UTILS ────────────────────────────────────────────────

function Avatar({ url, emoji, size = 40 }) {
  if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}/>;
  return <span style={{ fontSize: size * 0.52 }}>{emoji || "🌱"}</span>;
}

function XpBar({ xp, dark = false }) {
  const lv = getLevel(xp);
  const nextLv = LEVELS.find(l => l.xp > xp);
  const pct = nextLv ? Math.round(((xp - lv.xp) / (nextLv.xp - lv.xp)) * 100) : 100;
  return (
    <div>
      <div className="xp-bar-wrap"><div className="xp-bar" style={{ width: pct + "%", animation:"xpFill 1s ease-out forwards" }} /></div>
      <div className="xp-label"><span>{xp} XP</span>{nextLv && <span>{nextLv.xp} XP</span>}</div>
    </div>
  );
}

function SquadPill({ name }) {
  const s = SQUAD_STYLE[name] || { bg: "#252525", text: "#999" };
  return <span className="squad-pill" style={{ background: s.bg, color: s.text }}>{name}</span>;
}

function SectionBanner({ sectionKey, title, sub, sectionColors, onEdit }) {
  const cfg = sectionColors?.[sectionKey] || DEFAULT_SECTION_COLORS[sectionKey] || { color: "#A3CFFE", image: null };
  return (
    <div className="section-banner" style={{ background: cfg.image ? undefined : "transparent" }}>
      {cfg.image && <div className="section-banner-bg" style={{ backgroundImage: `url(${cfg.image})` }} />}
      {cfg.image && <div className="section-banner-overlay" />}
      <div className="section-banner-content">
        <div className="section-banner-title" style={{ "--pg": cfg.color, color: cfg.image ? "#fff" : "#101010" }}>{title}</div>
        {sub && <div className="section-banner-sub" style={{ color: cfg.image ? "rgba(255,255,255,.75)" : "rgba(0,0,0,.5)" }}>{sub}</div>}
      </div>
      {false && (
        <button className="btn btn-xs" style={{ position: "absolute", top: 10, right: 10, background: "rgba(0,0,0,.35)", color: "#fff", border: "none", fontSize: 11, backdropFilter: "blur(4px)" }} onClick={onEdit}>✏️</button>
      )}
    </div>
  );
}

function BannerCustomizer({ sectionKey, sectionColors, setSectionColors, onClose }) {
  const cfg = sectionColors?.[sectionKey] || DEFAULT_SECTION_COLORS[sectionKey] || { color: "#A3CFFE", image: null };
  const [color, setColor] = useState(cfg.color);
  const [image, setImage] = useState(cfg.image);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();
  const PRESET_COLORS = [BRAND.azzurro, BRAND.rosa, BRAND.giallo, BRAND.verde, BRAND.rosso, "#252525", "#ffffff"];

  async function handleImageUpload(e) {
    const file = e.target.files[0]; if (!file) return;
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `banners/${sectionKey}.${ext}`;
    await sb.storage.from("avatars").upload(path, file, { upsert: true });
    const { data } = sb.storage.from("avatars").getPublicUrl(path);
    setImage(data.publicUrl + "?t=" + Date.now());
    setUploading(false);
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">Personalizza sezione</div>
        <div className="section-label">Colore sfondo</div>
        <div className="color-swatch-row">
          {PRESET_COLORS.map(c => <div key={c} className={`color-swatch ${color === c ? "active" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />)}
          <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ width: 36, height: 36, border: "none", borderRadius: "50%", cursor: "pointer", padding: 0 }} />
        </div>
        <div className="section-label">Immagine di sfondo (opzionale)</div>
        <div className="avatar-upload-area" onClick={() => fileRef.current.click()}>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display: "none" }} />
          {image ? <img src={image} alt="banner" style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 8, marginBottom: 6 }} /> : <div style={{ fontSize: 30, marginBottom: 6 }}>🖼️</div>}
          <div style={{ fontSize: 13, color: "var(--text2)" }}>{uploading ? "Caricamento…" : "Tocca per caricare un'immagine"}</div>
        </div>
        {image && <button className="btn btn-danger btn-sm" style={{ marginBottom: 8 }} onClick={() => setImage(null)}>Rimuovi immagine</button>}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => { setSectionColors(prev => ({ ...prev, [sectionKey]: { color, image } })); onClose(); }}>Salva</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Annulla</button>
        </div>
      </div>
    </div>
  );
}

// ─── IMAGE COMPRESSION ──────────────────────────────────

async function compressToWebP(file, maxPx = 400, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > maxPx || h > maxPx) {
        if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
        else        { w = Math.round(w * maxPx / h); h = maxPx; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob || file), "image/webp", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// Carica una foto messaggio nel bucket Storage e ritorna l'URL pubblico.
// Avviene in automatico quando l'educatore sceglie il file: nessun passo
// manuale. Le immagini pesano nel bucket, non nella tabella messages.
async function uploadMessageMedia(file) {
  const compressed = await compressToWebP(file, 1024, 0.82);
  const path = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const { error } = await sb.storage.from("message-media")
    .upload(path, compressed, { contentType: "image/webp", cacheControl: "31536000" });
  if (error) throw error;
  const { data } = sb.storage.from("message-media").getPublicUrl(path);
  return data.publicUrl;
}

// Carica un'immagine badge nel bucket Storage e ritorna l'URL pubblico.
async function uploadBadgeImage(file) {
  const compressed = await compressToWebP(file, 512, 0.85);
  const path = `badge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const { error } = await sb.storage.from("badge-images")
    .upload(path, compressed, { contentType: "image/webp", cacheControl: "31536000" });
  if (error) throw error;
  const { data } = sb.storage.from("badge-images").getPublicUrl(path);
  return data.publicUrl;
}

function AvatarUpload({ playerId, currentUrl, onUploaded }) {
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(currentUrl);
  async function handleFile(e) {
    const file = e.target.files[0]; if (!file) return;
    setUploading(true);
    try {
      const compressed = await compressToWebP(file, 400, 0.82);
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const base64url = ev.target.result;
        const kb = Math.round(base64url.length * 0.75 / 1024);
        if (kb > 200) { addToast(`⚠️ Foto troppo grande (${kb}KB)`, 'error'); setUploading(false); return; }
        await sb.from("profiles").update({ avatar_url: base64url }).eq("id", playerId);
        setPreview(base64url); onUploaded && onUploaded(base64url);
        setUploading(false);
      };
      reader.onerror = () => { addToast('❌ Errore lettura file', 'error'); setUploading(false); };
      reader.readAsDataURL(compressed);
    } catch(err) { addToast("❌ " + err.message, "error"); setUploading(false); }
  }
  return (
    <div className="avatar-upload-area" onClick={() => fileRef.current.click()}>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{display:"none"}}/>
      {preview ? <img src={preview} className="avatar-preview" alt="avatar"/> : <div style={{fontSize:40,marginBottom:8}}>📷</div>}
      <div style={{fontSize:13,color:"var(--text2)"}}>{uploading ? "⏳ Compressione…" : "Tocca per cambiare foto"}</div>
    </div>
  );
}

async function logXPGain(playerId, xpGained, xpTotal, reason) {
  if (!xpGained || xpGained === 0) return;
  try {
    const { error } = await sb.from("xp_history").insert({ player_id:playerId, xp_gained:xpGained, xp_total:xpTotal, reason });
    if (error) console.warn("[xp_history]", error.message);
  } catch(e) { console.warn("[xp_history]", e); }
}

// Se il giocatore è salito di livello: notifica in-app + push. Ritorna true se level-up.
async function checkLevelUp(playerId, oldXp, newXp) {
  const oldLv = getLevel(oldXp); const newLv = getLevel(newXp);
  if (newLv.name === oldLv.name) return false;
  sendPush(playerId, "🆙 Sei salito di livello!", `Sei diventato ${newLv.emoji} ${newLv.name}!`).catch(()=>{});
  await sb.from("notifications").insert({user_id:playerId, type:"level_up", title:"🆙 Nuovo livello!", body:`${newLv.emoji} ${newLv.name}`});
  if (newLv.id % 5 === 0) {
    try {
      const { data: pl } = await sb.from("profiles").select("display_name").eq("id", playerId).single();
      const nm = pl?.display_name || "Un giocatore";
      const { data: edus } = await sb.from("profiles").select("id").in("role", ["educator","admin"]);
      const rows = (edus||[]).map(e => ({ user_id: e.id, type: "level_up", title: "🆙 Traguardo di livello", body: `${nm} è salito a ${newLv.emoji} ${newLv.name}` }));
      if (rows.length) await sb.from("notifications").insert(rows);
    } catch(_){}
  }
  return true;
}

async function logAction({ playerId, action, xpDelta = 0, coinDelta = 0, note = "" }) {
  try {
    await sb.from("notifications").insert({
      user_id: playerId, type: "log_action", title: action,
      body: [xpDelta ? `+${xpDelta} XP` : "", coinDelta ? `+${coinDelta} Coin` : "", note].filter(Boolean).join(" · "),
    });
  } catch (_) {}
}

// ─── QR SCANNER COMPONENT ────────────────────────────────

function QRScanner({ onScan, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [err, setErr] = useState(null);
  const [scanning, setScanning] = useState(true);
  const streamRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    let active = true;
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        tick();
      } catch(e) { setErr("Camera non disponibile. " + (e.message || "")); }
    }
    function tick() {
      if (!active) return;
      const video = videoRef.current; const canvas = canvasRef.current;
      if (video && canvas && video.readyState === 4) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d"); ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (window.jsQR) {
          const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts:"dontInvert" });
          if (code?.data) { active = false; setScanning(false); onScan(code.data.toUpperCase()); return; }
        }
      }
      frameRef.current = requestAnimationFrame(tick);
    }
    start();
    return () => { active = false; if (frameRef.current) cancelAnimationFrame(frameRef.current); if (streamRef.current) streamRef.current.getTracks().forEach(t=>t.stop()); };
  }, [onScan]);

  return (
    <div style={{padding:"0 0 12px"}}>
      {err ? (
        <div style={{color:"var(--rosso)",fontSize:13,padding:"12px",textAlign:"center",background:"rgba(255,34,68,.08)",borderRadius:10}}>{err}</div>
      ) : (
        <div className="qr-scanner-wrap">
          <video ref={videoRef} className="qr-scanner-video" playsInline muted/>
          <canvas ref={canvasRef} style={{display:"none"}}/>
          <div className="qr-scanner-overlay">
            <div className="qr-scanner-frame">
              <div className="qr-scanner-corner-tr"/>
              <div className="qr-scanner-corner-bl"/>
              <div className="qr-scanner-line"/>
            </div>
          </div>
        </div>
      )}
      {!window.jsQR && !err && <div style={{fontSize:11,color:"rgba(255,255,255,.4)",textAlign:"center",marginTop:8}}>Caricamento libreria QR…</div>}
      {scanning && !err && <div style={{fontSize:12,color:"rgba(255,255,255,.5)",textAlign:"center",marginTop:10}}>🔍 Punta la camera al codice QR</div>}
      <button className="btn btn-ghost btn-sm" style={{width:"100%",marginTop:10}} onClick={onClose}>Annulla</button>
    </div>
  );
}

// ─── AVATAR PICKER ───────────────────────────────────────

function AvatarPicker({ selected, onSelect, squadFilter }) {
  const [manifest, setManifest] = useState(null);
  const [activeTab, setActiveTab] = useState(squadFilter || "Azzurra");

  useEffect(() => {
    fetch("/avatars/_manifest.json")
      .then(r => r.json())
      .then(data => {
        setManifest(data);
        if (squadFilter && data[squadFilter]) setActiveTab(squadFilter);
      })
      .catch(() => setManifest(null));
  }, [squadFilter]);

  if (!manifest) return <div style={{fontSize:13,color:"var(--text3)",padding:"12px 0"}}>⏳ Caricamento avatar…</div>;

  const tabs = Object.keys(manifest).filter(k => {
    if (k === "Special") return false;
    if (k === "Badge") return squadFilter === "Badge"; // only show Badge tab when picking badges
    if (squadFilter === "Badge") return false; // in badge mode, only show Badge
    return true;
  });

  return (
    <div>
      <div className="av-picker-tabs">
        {tabs.map(sq => (
          <button key={sq} className={`av-picker-tab ${activeTab===sq?"on":""}`} onClick={()=>setActiveTab(sq)}>{sq}</button>
        ))}
      </div>
      <div className="av-picker-wrap">
        <div className="av-picker-grid">
          {(manifest[activeTab]||[]).map(name => {
            const url = `/avatars/${name}.webp`;
            const isSel = selected === url;
            return (
              <div key={name} className={`av-picker-item ${isSel?"sel":""}`} onClick={()=>onSelect(isSel ? "" : url)}>
                <img src={url} alt={name}
                  style={{width:52,height:52,objectFit:"contain",display:"block"}}
                  onError={e=>{e.target.src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 52 52'%3E%3Crect width='52' height='52' fill='%23333'/%3E%3Ctext x='26' y='34' text-anchor='middle' font-size='24'%3E🌱%3C/text%3E%3C/svg%3E";}}/>
                <span>{name.replace(/^[agvn]_/,"")}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── STICKER & GIF ───────────────────────────────────────
const ANIMATED_STICKERS = [
  { id:"happy", label:"😊 Felice!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}.b{animation:bounce .7s ease-in-out infinite}@keyframes blink{0%,90%,100%{scaleY:1}95%{transform:scaleY(0.1)}}</style><g class="b"><ellipse cx="50" cy="70" rx="32" ry="36" fill="#4caf50"/><ellipse cx="28" cy="45" rx="14" ry="7" fill="var(--verde)" transform="rotate(-40,28,45)"/><ellipse cx="72" cy="45" rx="14" ry="7" fill="var(--verde)" transform="rotate(40,72,45)"/><circle cx="50" cy="32" r="8" fill="var(--verde)"/><circle cx="39" cy="65" r="8" fill="white"/><circle cx="61" cy="65" r="8" fill="white"/><circle cx="41" cy="66" r="5" fill="#1a237e"/><circle cx="63" cy="66" r="5" fill="#1a237e"/><circle cx="43" cy="64" r="2" fill="white"/><circle cx="65" cy="64" r="2" fill="white"/><path d="M 36 78 Q 50 92 64 78" stroke="#1b5e20" stroke-width="3.5" fill="none" stroke-linecap="round"/></g></svg>` },
  { id:"thumbsup", label:"👍 Grande!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes pop{0%{transform:scale(1)}30%{transform:scale(1.2)}100%{transform:scale(1)}}.p{animation:pop .6s ease-out infinite}</style><g class="p"><ellipse cx="50" cy="75" rx="28" ry="30" fill="#66bb6a"/><circle cx="50" cy="28" r="7" fill="var(--verde)"/><rect x="30" y="35" width="10" height="25" rx="5" fill="var(--verde)"/><rect x="60" y="35" width="10" height="25" rx="5" fill="var(--verde)"/><rect x="38" y="55" width="24" height="18" rx="4" fill="#4caf50"/><rect x="35" y="45" width="30" height="14" rx="7" fill="#81c784"/><rect x="44" y="38" width="12" height="12" rx="6" fill="#66bb6a"/><circle cx="40" cy="72" r="7" fill="white"/><circle cx="60" cy="72" r="7" fill="white"/><circle cx="42" cy="73" r="4" fill="#1b5e20"/><circle cx="62" cy="73" r="4" fill="#1b5e20"/><path d="M 40 83 Q 50 90 60 83" stroke="#1b5e20" stroke-width="3" fill="none" stroke-linecap="round"/></g></svg>` },
  { id:"thumbsdown", label:"👎 Boh...", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes wilt{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-5deg)}}.w{animation:wilt 1s ease-in-out infinite;transform-origin:50% 80%}</style><g class="w"><ellipse cx="50" cy="65" rx="28" ry="30" fill="#78909c"/><ellipse cx="30" cy="42" rx="12" ry="6" fill="var(--argento)" transform="rotate(-20,30,42)"/><ellipse cx="70" cy="42" rx="12" ry="6" fill="var(--argento)" transform="rotate(20,70,42)"/><circle cx="50" cy="30" r="7" fill="var(--argento)"/><circle cx="40" cy="62" r="7" fill="white"/><circle cx="60" cy="62" r="7" fill="white"/><circle cx="42" cy="63" r="4" fill="#263238"/><circle cx="62" cy="63" r="4" fill="#263238"/><path d="M 38 76 Q 50 70 62 76" stroke="#263238" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="35" y="75" width="30" height="14" rx="7" fill="#607d8b" transform="rotate(180,50,82)"/><rect x="44" y="82" width="12" height="12" rx="6" fill="#78909c" transform="rotate(180,50,88)"/></g></svg>` },
  { id:"kiss", label:"💋 Bacio!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes kiss{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}.k{animation:kiss .8s ease-in-out infinite}@keyframes heart{0%,100%{transform:scale(1) translate(0,0);opacity:1}100%{transform:scale(0) translate(10px,-20px);opacity:0}}.h{animation:heart 1.2s ease-out infinite}</style><g class="k"><ellipse cx="50" cy="68" rx="30" ry="34" fill="#f48fb1"/><ellipse cx="28" cy="44" rx="13" ry="7" fill="#e91e63" transform="rotate(-35,28,44)"/><ellipse cx="72" cy="44" rx="13" ry="7" fill="#e91e63" transform="rotate(35,72,44)"/><circle cx="50" cy="30" r="7" fill="#e91e63"/><circle cx="39" cy="63" r="7" fill="white"/><circle cx="61" cy="63" r="7" fill="white"/><circle cx="41" cy="64" r="4" fill="#880e4f"/><circle cx="63" cy="64" r="4" fill="#880e4f"/><circle cx="50" cy="78" r="7" fill="#e91e63"/><text x="68" y="55" font-size="14" class="h">❤️</text><text x="72" y="45" font-size="10" class="h" style="animation-delay:.4s">💕</text></g></svg>` },
  { id:"heart", label:"❤️ Cuore!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}.p{animation:pulse .6s ease-in-out infinite}</style><g class="p"><ellipse cx="50" cy="68" rx="30" ry="34" fill="#ef5350"/><ellipse cx="28" cy="44" rx="13" ry="7" fill="#b71c1c" transform="rotate(-35,28,44)"/><ellipse cx="72" cy="44" rx="13" ry="7" fill="#b71c1c" transform="rotate(35,72,44)"/><circle cx="50" cy="30" r="7" fill="#b71c1c"/><circle cx="39" cy="63" r="8" fill="white"/><circle cx="61" cy="63" r="8" fill="white"/><circle cx="41" cy="64" r="5" fill="#b71c1c"/><circle cx="63" cy="64" r="5" fill="#b71c1c"/><path d="M 35 77 Q 50 95 65 77" stroke="#7f0000" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M50 40 C45 35 35 35 35 43 C35 50 50 60 50 60 C50 60 65 50 65 43 C65 35 55 35 50 40Z" fill="#ff1744" opacity=".9" transform="translate(0,-10) scale(0.5) translate(50,0)"/></g></svg>` },
  { id:"laugh", label:"😂 Risata!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes shake{0%,100%{transform:rotate(0deg)}25%{transform:rotate(-4deg)}75%{transform:rotate(4deg)}}.s{animation:shake .3s ease-in-out infinite}</style><g class="s"><ellipse cx="50" cy="68" rx="32" ry="36" fill="#ffd54f"/><ellipse cx="28" cy="43" rx="14" ry="7" fill="var(--giallo)" transform="rotate(-35,28,43)"/><ellipse cx="72" cy="43" rx="14" ry="7" fill="var(--giallo)" transform="rotate(35,72,43)"/><circle cx="50" cy="30" r="7" fill="var(--giallo)"/><path d="M 32 60 Q 50 57 68 60" stroke="#D41323" stroke-width="3" fill="none"/><ellipse cx="50" cy="62" rx="18" ry="4" fill="#D41323"/><path d="M 32 62 Q 50 85 68 62" fill="#D41323"/><rect x="38" y="62" width="24" height="8" fill="white" rx="3"/><text x="26" y="58" font-size="14">😂</text><text x="62" y="58" font-size="14">😂</text></g></svg>` },
  { id:"rofl", label:"🤣 XDDD", svg:`<svg viewBox="0 0 110 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes roll{0%{transform:rotate(0deg) translate(0,0)}25%{transform:rotate(-30deg) translate(-5px,5px)}75%{transform:rotate(30deg) translate(5px,5px)}100%{transform:rotate(0deg) translate(0,0)}}.r{animation:roll .5s ease-in-out infinite;transform-origin:55px 65px}</style><g class="r"><ellipse cx="55" cy="68" rx="32" ry="36" fill="#ffb300"/><ellipse cx="30" cy="43" rx="14" ry="7" fill="#ff8f00" transform="rotate(-35,30,43)"/><ellipse cx="80" cy="43" rx="14" ry="7" fill="#ff8f00" transform="rotate(35,80,43)"/><circle cx="55" cy="30" r="7" fill="#ff8f00"/><path d="M 35 60 Q 55 57 75 60" stroke="#D41323" stroke-width="3" fill="none"/><ellipse cx="55" cy="62" rx="20" ry="5" fill="#D41323"/><path d="M 35 62 Q 55 90 75 62" fill="#D41323"/><rect x="43" y="62" width="24" height="8" fill="white" rx="3"/><ellipse cx="30" cy="60" rx="10" ry="6" fill="#29b6f6" opacity=".7" transform="rotate(-20,30,60)"/><ellipse cx="80" cy="60" rx="10" ry="6" fill="#29b6f6" opacity=".7" transform="rotate(20,80,60)"/></g></svg>` }
];



// GIF curate dalla CDN Giphy — ID verificati, no API key
const CURATED_GIFS = {
  "🎉 Festa": [
    "3oz8xAFtqoOUUrsh7W","l0MYt5jPR6QX5pnqM","26ufdipQqU84QcCa8",
    "xT9IgDEI1iZyb2wqo8","l3vRhj2MhHQBLO0cI","5GoVLqeAOo6PK",
    "g9582DNuQppxC","jJxG7UrGV7R1l0GDCA","CjmvTCZf2U3p09Cn0h",
    "YTzh0J5qSE9pq","26u4cqiYI9LBb252w","xUPGcguWZHRC2HyBRS",
  ],
  "🔥 Hype": [
    "l0HlHFRbmaZtBKljO","26BROrSHlmXoUKP1q","3o7aCTPHNxKiRcBbio",
    "l2SpZkQ0yCbDZqHgk","xT9IgG4r9HjEb8bW8g","UqZ5bP8yfKH5Q",
    "l1J9wJ0gMMvvPcSBW","Ll22OLDm49fss","26BRrSp9Io0wTFqCY",
    "l0MYt5jPR6QX5pnqM","3oz8xAFtqoOUUrsh7W","YQitE4YNQNahy",
  ],
  "👍 Grande": [
    "XreQmk7ETCak0","l0MYGb1RjuCFbkmrC","jnQXQ3GNdIqp3FgmIe",
    "111ebonMD8EPXO","QABiTtSGKSEVO","3o6Zt11Hm1PLQNF71K",
    "efK0x7qvmLBzLFh1YK","dIxkmtCuuBQunyCV01","3oFzmMgUr2EXE6PZGE",
    "l4pTjOu0NsrLApt0c","26BRMhUqMnslIGxck","YJ8VWc8uG05PB4ONQX",
  ],
  "😂 Risata": [
    "l3vRhj2MhHQBLO0cI","xT9IgNVgHEH6AeEMRy","13CoXDiaCcCoyk",
    "oyjkqi5ejHwFq","W7DgFVhFuKaS8","3oEduSbkbhM3ORM4pi",
    "cnuNz0fTBKeW0","nL6hfnpjPFrmo","ZEU9ryYGZzttn0Cva7",
    "jV13A4jgrIJFGkRbCe","l0HlNNFKZAagHiuCc","LONX4aPDFWmXu",
  ],
  "💪 Forza": [
    "3o6Zt11Hm1PLQNF71K","l0MYGb1RjuCFbkmrC","26BROrSHlmXoUKP1q",
    "l41YkFIiBxQdRlMnS","lp8GQr4FkDMkM3Zv7a","mGOrABZGDy4lXjIZGU",
    "3o7TKP9ln2Dr6ze6f6","LmHFBDHoGFnkQ","3oxHQCI8tqsubDjSQE",
    "9D7eCKPHDmMkT41GmC","l0HlyMZa5EalehFNK","1zSs5T1kmVLlqD8kIM",
  ],
  "🏆 Win": [
    "g9582DNuQppxC","YTzh0J5qSE9pq","CjmvTCZf2U3p09Cn0h",
    "5GoVLqeAOo6PK","jJxG7UrGV7R1l0GDCA","3oEdv9Y9md8Y3J3zXq",
    "26u4pMkMiYRlEGkO4","d3mlYwpf96kMuFjO","xT9IgcnemkhlPRMNAI",
    "Mab0WjHBHE9ViDHY5l","l0Iy8XcCsHHobNvK0","ZfNtFNUQBVRMWNNQGi",
  ],
  "😮 WOW": [
    "xT9IgDEI1iZyb2wqo8","5xtDarBZalMXVwg7SuA","14aUt4VETfCOyY",
    "4X8noKbFCuLMk","JoMJkRUMl3fzG","3oFzmcMECQgF3ub1nW",
    "l0HlyMZa5EalehFNK","xT9IgNVgHEH6AeEMRy","3o6Zt11Hm1PLQNF71K",
    "l3vRhj2MhHQBLO0cI","oyjkqi5ejHwFq","W7DgFVhFuKaS8",
  ],
  "❤️ Amore": [
    "l0HlNNFKZAagHiuCc","26BRrSp9Io0wTFqCY","CjmvTCZf2U3p09Cn0h",
    "l0MYt5jPR6QX5pnqM","26ufdipQqU84QcCa8","LONX4aPDFWmXu",
    "ZEU9ryYGZzttn0Cva7","nL6hfnpjPFrmo","cnuNz0fTBKeW0",
    "YJ8VWc8uG05PB4ONQX","XreQmk7ETCak0","jnQXQ3GNdIqp3FgmIe",
  ],
};


// ─── TOAST NOTIFICATION SYSTEM ───────────────────────────
let _addToast = null;
function addToast(msg, type="xp") { if(_addToast) _addToast(msg,type); }

function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    _addToast = (msg, type) => {
      const id = Date.now() + Math.random();
      setToasts(p => [...p, { id, msg, type }]);
      setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 2800);
    };
    return () => { _addToast = null; };
  }, []);
  return (
    <div style={{ position:"fixed", bottom:90, right:16, zIndex:8888, display:"flex", flexDirection:"column", gap:8, pointerEvents:"none" }}>
      {toasts.map(t => <Toast key={t.id} {...t}/>)}
    </div>
  );
}

function Toast({ msg, type }) {
  const colors = {
    xp:    { bg:"rgba(163,207,254,.15)",  border:"rgba(163,207,254,.4)",  color:"#A3CFFE" },
    coin:  { bg:"rgba(253,239,38,.15)",  border:"rgba(253,239,38,.4)",  color:"#FDEF26" },
    badge: { bg:"rgba(255,109,236,.15)", border:"rgba(255,109,236,.4)", color:"#FF6DEC" },
    ok:    { bg:"rgba(51,153,102,.15)",  border:"rgba(51,153,102,.4)",  color:"#339966" },
    error: { bg:"rgba(255,50,50,.15)",  border:"rgba(255,50,50,.4)",  color:"#ff4444" },
  };
  const c = colors[type] || colors.ok;
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.border}`, color: c.color,
      borderRadius: 12, padding: "10px 16px",
      fontFamily: "'Funnel Display',sans-serif", fontSize: 16, fontWeight: 900,
      letterSpacing: ".04em", whiteSpace: "nowrap",
      animation: "toastIn .35s cubic-bezier(.34,1.56,.64,1) forwards",
      backdropFilter: "blur(10px)",
      boxShadow: `0 4px 20px ${c.border}`,
    }}>{msg}</div>
  );
}


// ─── PARTICLE BURST ──────────────────────────────────────
function ParticleBurst({ x, y, color="#FDEF26", onDone }) {
  const particles = Array.from({length:12}, (_,i) => ({
    id:i, angle:(360/12)*i,
    dist: 30+Math.random()*30,
    size: 4+Math.random()*5,
  }));
  useEffect(() => { const t=setTimeout(onDone,700); return ()=>clearTimeout(t); }, [onDone]);
  return (
    <div style={{position:"fixed",left:x,top:y,zIndex:9990,pointerEvents:"none"}}>
      {particles.map(p => {
        const rad = (p.angle*Math.PI)/180;
        const tx = Math.cos(rad)*p.dist, ty = Math.sin(rad)*p.dist;
        return (
          <div key={p.id} style={{
            position:"absolute", left:0, top:0,
            width:p.size, height:p.size, borderRadius:"50%", background:color,
            animation:`burst .6s ease-out forwards`,
            "--tx":`${tx}px`, "--ty":`${ty}px`,
          }}/>
        );
      })}
    </div>
  );
}


// ─── COUNTING NUMBER HOOK ────────────────────────────────
function useCountUp(target, duration=800) {
  const [val, setVal] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    if (prev.current === target) return;
    const start = prev.current, diff = target - start;
    const startTime = performance.now();
    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed/duration, 1);
      const ease = 1 - Math.pow(1-progress, 3); // easeOutCubic
      setVal(Math.round(start + diff*ease));
      if (progress < 1) requestAnimationFrame(tick);
      else { setVal(target); prev.current = target; }
    }
    requestAnimationFrame(tick);
    prev.current = target;
  }, [target, duration]);
  return val;
}


// ─── COUNTDOWN TO MIDNIGHT ───────────────────────────────
function useCountdown() {
  const [time, setTime] = useState("");
  useEffect(() => {
    function update() {
      const now = new Date();
      const midnight = new Date(now); midnight.setHours(24,0,0,0);
      const diff = midnight - now;
      const h = Math.floor(diff/3600000).toString().padStart(2,"0");
      const m = Math.floor((diff%3600000)/60000).toString().padStart(2,"0");
      const s = Math.floor((diff%60000)/1000).toString().padStart(2,"0");
      setTime(`${h}:${m}:${s}`);
    }
    update(); const iv = setInterval(update,1000); return ()=>clearInterval(iv);
  }, []);
  return time;
}

function SfidePanel({ activities }) {
  const sfide = (activities||[]).filter(a=>a.description?.includes('SFIDA')||a.duration==="weekly"||a.duration==="monthly");
  const daily = (activities||[]).filter(a=>a.description?.includes('SFIDA') && a.duration!=="weekly" && a.duration!=="monthly").slice(0,1);
  const weekly = sfide.filter(a=>a.duration==="weekly").slice(0,1);
  const monthly = sfide.filter(a=>a.duration==="monthly").slice(0,1);
  const all = [...daily, ...weekly, ...monthly];
  if (all.length === 0) return null;

  const DurationBadge = ({dur}) => {
    const labels = { daily:["⚡","OGGI"], weekly:["📅","SETTIMANA"], monthly:["🗓️","MESE"] };
    const [icon, label] = labels[dur]||["⚡","SFIDA"];
    return <span style={{fontSize:9,fontWeight:900,color:"var(--rosso)",letterSpacing:".1em",textTransform:"uppercase"}}>{icon} {label}</span>;
  };

  return (
    <div style={{margin:"0 0 8px"}}>
      {all.map(s=>(
        <div key={s.id} className="pd-sfida" style={{marginBottom:6}}>
          <SfidaCountdown duration={s.duration||"daily"}/>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
            <DurationBadge dur={s.duration||"daily"}/>
            <div style={{display:"flex",gap:6}}>
              <span style={{fontSize:11,color:"rgba(255,255,255,.5)"}}>+{s.coin_full||s.coin_partial||10} 🪙</span>
              <span style={{fontSize:11,color:"rgba(255,255,255,.5)"}}>+{s.xp_full||20} ⭐</span>
            </div>
          </div>
          <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,textTransform:"uppercase",color:"#fff",lineHeight:1.1,marginBottom:4}}>{s.name}</div>
          {s.description&&<div style={{fontSize:11,color:"rgba(255,255,255,.55)",lineHeight:1.4}}>{s.description.replace("SFIDA:","").trim()}</div>}
        </div>
      ))}
    </div>
  );
}

function SfidaCountdown({ duration }) {
  const [time, setTime] = useState("");
  useEffect(() => {
    function update() {
      const now = new Date();
      let target;
      if (duration === "weekly") {
        // Next Monday
        const d = new Date(); d.setDate(d.getDate() + (7-d.getDay()+1)%7||7); d.setHours(0,0,0,0);
        target = d;
      } else if (duration === "monthly") {
        // End of month
        const d = new Date(now.getFullYear(), now.getMonth()+1, 1);
        target = d;
      } else {
        // Midnight
        const d = new Date(); d.setHours(24,0,0,0);
        target = d;
      }
      const diff = target - now;
      const h = Math.floor(diff/3600000);
      const m = Math.floor((diff%3600000)/60000).toString().padStart(2,"0");
      const s = Math.floor((diff%60000)/1000).toString().padStart(2,"0");
      const dLabel = duration==="weekly"||duration==="monthly" ? `${Math.floor(h/24)}g ${(h%24).toString().padStart(2,"0")}:${m}:${s}` : `${h.toString().padStart(2,"0")}:${m}:${s}`;
      setTime(dLabel);
    }
    update(); const iv = setInterval(update,1000); return ()=>clearInterval(iv);
  }, [duration]);
  return <div style={{fontSize:10,color:"rgba(255,255,255,.4)",fontFamily:"monospace",fontWeight:700,marginBottom:4}}>⏱ Scade in {time}</div>;
}

function CountUpStat({ val }) {
  const animated = useCountUp(typeof val==="number" ? val : 0);
  return <span className="pd-sv">{typeof val==="number" ? animated : val}</span>;
}


// ─── DEBOUNCE ────────────────────────────────────────────
function useDebounce(value, delay=300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ─── UPDATE BANNER ───────────────────────────────────────
function UpdateBanner() {
  const [pending, setPending] = useState(null); // waiting SW worker
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    // Nuova versione trovata mentre la pagina è aperta
    function onUpdateReady(e) {
      setPending(e.detail?.worker || true);
    }
    window.addEventListener('sw-update-ready', onUpdateReady);
    return () => window.removeEventListener('sw-update-ready', onUpdateReady);
  }, []);

  if (!pending || reloading) return null;

  function applyUpdate() {
    setReloading(true);
    // Dì al nuovo SW di prendere controllo subito
    if (pending?.postMessage) pending.postMessage({ type: 'SKIP_WAITING' });
    // Aspetta che il nuovo SW sia attivo, poi ricarica
    const reload = () => window.location.reload();
    window.addEventListener('sw-activated', reload, { once: true });
    // Fallback: ricarica dopo 2s anche senza evento
    setTimeout(reload, 2000);
  }

  return (
    <div style={{
      position:'fixed', top:0, left:0, right:0, zIndex:99999,
      background:'#0e2e1c',
      borderBottom:'2px solid #339966',
      paddingTop:'calc(env(safe-area-inset-top, 0px) + 10px)',
      paddingBottom:'10px',
      paddingLeft:'calc(env(safe-area-inset-left, 0px) + 16px)',
      paddingRight:'calc(env(safe-area-inset-right, 0px) + 16px)',
      display:'flex', alignItems:'center', gap:12,
      boxShadow:'0 2px 20px rgba(51,153,102,.3)',
      animation:'slideDown .3s ease',
    }}>
      <span style={{fontSize:20}}>🆕</span>
      <div style={{flex:1}}>
        <div style={{fontSize:13,fontWeight:700,color:'#339966'}}>Nuova versione disponibile</div>
        <div style={{fontSize:11,color:'rgba(255,255,255,.5)'}}>Aggiorna per avere le ultime novità</div>
      </div>
      <button onClick={applyUpdate} style={{
        background:'#339966', border:'none', borderRadius:99,
        padding:'10px 20px', color:'#000', fontSize:14,
        fontWeight:900, cursor:'pointer', flexShrink:0,
        fontFamily:"'Funnel Display',sans-serif", letterSpacing:'.04em',
        minHeight:'44px',
      }}>
        {reloading ? '⏳' : 'Aggiorna'}
      </button>
      <button onClick={()=>setPending(null)} style={{
        background:'none', border:'none', color:'rgba(255,255,255,.4)',
        cursor:'pointer', fontSize:20, flexShrink:0, padding:'8px 10px',
        minWidth:'40px', minHeight:'40px',
      }}>✕</button>
    </div>
  );
}

// ─── OFFLINE BANNER ──────────────────────────────────────
function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [justBack, setJustBack] = useState(false);

  useEffect(() => {
    function onOnline() {
      setOffline(false);
      setJustBack(true);
      setTimeout(() => setJustBack(false), 3000);
    }
    function onOffline() { setOffline(true); setJustBack(false); }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (!offline && !justBack) return null;

  return (
    <div style={{
      position:'fixed', bottom:'calc(env(safe-area-inset-bottom, 0px) + 80px)', left:12, right:12, zIndex:9998,
      background: justBack
        ? '#0e2e1c'
        : '#2e0d0d',
      border:`2px solid ${justBack?'#339966':'#ff4444'}`,
      borderRadius:14,
      padding:'12px 16px',
      display:'flex', alignItems:'center', gap:10,
      boxShadow:`0 4px 20px ${justBack?'rgba(51,153,102,.3)':'rgba(255,68,68,.3)'}`,
      animation:'slideUp .3s ease',
    }}>
      <style>{`@keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
      <span style={{fontSize:22}}>
        {justBack ? '✅' : '📵'}
      </span>
      <div>
        <div style={{fontSize:13,fontWeight:700,color:justBack?'#339966':'#ff6666'}}>
          {justBack ? 'Connessione ripristinata' : 'Sei offline'}
        </div>
        <div style={{fontSize:11,color:'rgba(255,255,255,.45)'}}>
          {justBack ? 'Tutto torna a funzionare normalmente' : "L'app funziona con gli ultimi dati salvati"}
        </div>
      </div>
    </div>
  );
}

// ─── NOTIFICHE TAB (pagina intera) ───────────────────────
function NotificheTab({ profile }) {
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [permState, setPermState] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );

  function add(label, status, detail) {
    setSteps(prev => [...prev, { label, status, detail: detail || "" }]);
  }

  async function attiva() {
    if (typeof Notification === "undefined") {
      addToast("⚠️ Notifiche non supportate", "error"); return;
    }
    const p = await Notification.requestPermission();
    setPermState(p);
    if (p === "granted") {
      await registerPush(profile.id);
    } else {
      addToast("⚠️ Permesso negato — abilita dalle impostazioni del telefono", "error");
    }
  }

  async function diagnostica() {
    setSteps([]);
    setRunning(true);

    const hasSW = "serviceWorker" in navigator;
    const hasPush = "PushManager" in window;
    const hasNotif = "Notification" in window;
    add("API browser", hasSW && hasPush && hasNotif ? "ok" : "fail",
      `SW:${hasSW?"sì":"NO"} · Push:${hasPush?"sì":"NO"} · Notif:${hasNotif?"sì":"NO"}`);
    if (!hasSW || !hasPush || !hasNotif) {
      add("STOP", "fail", "Browser senza supporto. Su iPhone installa l'app da Safari → Condividi → Aggiungi a Home, poi aprila dall'icona.");
      setRunning(false); return;
    }

    const standalone = window.navigator.standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
    add("App installata (PWA)", standalone ? "ok" : "warn",
      standalone ? "Gira come app installata" : "Aperta dal browser — su iPhone le push richiedono l'app installata");

    let reg;
    try {
      reg = await navigator.serviceWorker.register("/sw.js");
      add("Service Worker", "ok", "Registrato");
    } catch (e) {
      add("Service Worker", "fail", e.message);
      setRunning(false); return;
    }

    let swReady;
    try {
      swReady = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, r) => setTimeout(() => r(new Error("timeout 8s")), 8000)),
      ]);
      add("Service Worker attivo", "ok", "Pronto");
    } catch (e) {
      add("Service Worker attivo", "fail", e.message);
      setRunning(false); return;
    }

    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    setPermState(perm);
    add("Permesso notifiche", perm === "granted" ? "ok" : "fail", `Stato: ${perm}`);
    if (perm !== "granted") {
      add("STOP", "fail", "Permesso non concesso. Abilita le notifiche per PUG nelle impostazioni del telefono.");
      setRunning(false); return;
    }

    let sub;
    try {
      const pm = swReady.pushManager || reg.pushManager;
      sub = await pm.getSubscription();
      if (!sub) {
        sub = await pm.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      add("Subscription push", "ok", "Creata");
    } catch (e) {
      add("Subscription push", "fail", e.message);
      setRunning(false); return;
    }

    try {
      const { error } = await sb.from("push_subscriptions").upsert(
        { player_id: profile.id, subscription: JSON.parse(JSON.stringify(sub)) },
        { onConflict: "player_id" }
      );
      if (error) { add("Salvataggio DB", "fail", error.message); setRunning(false); return; }
      add("Salvataggio DB", "ok", "Subscription salvata nel database");
    } catch (e) {
      add("Salvataggio DB", "fail", e.message);
      setRunning(false); return;
    }

    try {
      const resp = await fetch(PUSH_EDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${PUSH_ANON_KEY}` },
        body: JSON.stringify({
          subscription: JSON.parse(JSON.stringify(sub)),
          title: "🔔 Test PUG",
          body: "Notifica di prova — se la vedi, funziona tutto!",
        }),
      });
      const txt = await resp.text();
      if (resp.ok) add("Invio notifica test", "ok", "Inviata! Controlla se arriva la notifica sul telefono.");
      else add("Invio notifica test", "fail", `Server ${resp.status}: ${txt.slice(0,250)}`);
    } catch (e) {
      add("Invio notifica test", "fail", e.message);
    }

    setRunning(false);
  }

  const COLORS = { ok:"#00cc66", fail:"#ee3333", warn:"#dd9900" };
  const ICONS  = { ok:"✅", fail:"❌", warn:"⚠️" };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontFamily:"'Funnel Display'", fontSize:18, fontWeight:900, textTransform:"uppercase", color:"var(--text)", marginBottom:6 }}>
          🔔 Notifiche push
        </div>
        <div style={{ fontSize:13, color:"var(--text2)", lineHeight:1.5, marginBottom:14 }}>
          Attiva le notifiche per ricevere messaggi e avvisi anche quando l'app è chiusa.
        </div>
        <div style={{
          fontSize:12, fontWeight:700, marginBottom:14,
          color: permState === "granted" ? "var(--verde)" : permState === "denied" ? "var(--rosso)" : "var(--text3)",
        }}>
          Stato permesso: {permState === "granted" ? "✅ Concesso" : permState === "denied" ? "❌ Negato" : "⏳ Da attivare"}
        </div>
        <button className="btn btn-primary" style={{ width:"100%", marginBottom:8 }} onClick={attiva}>
          🔔 Attiva notifiche
        </button>
        <button className="btn btn-ghost" style={{ width:"100%" }} onClick={diagnostica} disabled={running}>
          {running ? "⏳ Diagnostica in corso…" : "🔧 Esegui diagnostica"}
        </button>
      </div>

      {steps.length > 0 && (
        <div className="card">
          <div style={{ fontSize:13, fontWeight:900, textTransform:"uppercase", color:"var(--text2)", marginBottom:12, fontFamily:"'Funnel Display'" }}>
            Risultato diagnostica
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {steps.map((s,i) => (
              <div key={i} style={{
                background:"rgba(255,255,255,.04)",
                border:`1px solid ${COLORS[s.status]}44`,
                borderRadius:10, padding:"10px 12px",
              }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span>{ICONS[s.status]}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:"var(--text)" }}>{s.label}</span>
                </div>
                {s.detail && (
                  <div style={{ fontSize:11, color:COLORS[s.status], marginTop:4, marginLeft:24, lineHeight:1.45 }}>
                    {s.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PUSH DIAGNOSTICS ────────────────────────────────────
function PushDiagnostics({ playerId, onClose }) {
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);

  function add(label, status, detail) {
    setSteps(prev => [...prev, { label, status, detail: detail || "" }]);
  }

  async function runDiagnostics() {
    setSteps([]);
    setRunning(true);

    // 1. API disponibili
    const hasSW = "serviceWorker" in navigator;
    const hasPush = "PushManager" in window;
    const hasNotif = "Notification" in window;
    add("API browser", hasSW && hasPush && hasNotif ? "ok" : "fail",
      `SW:${hasSW?"sì":"NO"} Push:${hasPush?"sì":"NO"} Notif:${hasNotif?"sì":"NO"}`);
    if (!hasSW || !hasPush || !hasNotif) {
      add("STOP", "fail", "Il browser non supporta le notifiche. Su iPhone l'app DEVE essere installata da Safari → Condividi → Aggiungi a Home.");
      setRunning(false); return;
    }

    // 2. Modalità standalone (PWA installata)
    const standalone = window.navigator.standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
    add("App installata (PWA)", standalone ? "ok" : "warn",
      standalone ? "Sì, gira come app" : "NO — aperta dal browser. Su iPhone le push NON funzionano dal browser.");

    // 3. Service Worker
    let reg;
    try {
      reg = await navigator.serviceWorker.register("/sw.js");
      add("Service Worker", "ok", "Registrato");
    } catch (e) {
      add("Service Worker", "fail", e.message);
      setRunning(false); return;
    }

    // 4. SW pronto
    let swReady;
    try {
      swReady = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, r) => setTimeout(() => r(new Error("timeout 8s")), 8000)),
      ]);
      add("Service Worker attivo", "ok", "Pronto");
    } catch (e) {
      add("Service Worker attivo", "fail", e.message);
      setRunning(false); return;
    }

    // 5. Permesso notifiche
    let perm = Notification.permission;
    if (perm === "default") {
      perm = await Notification.requestPermission();
    }
    add("Permesso notifiche", perm === "granted" ? "ok" : "fail", `Stato: ${perm}`);
    if (perm !== "granted") {
      add("STOP", "fail", "Permesso negato. Vai nelle impostazioni del telefono e abilita le notifiche per PUG.");
      setRunning(false); return;
    }

    // 6. Subscription push
    let sub;
    try {
      const pm = swReady.pushManager || reg.pushManager;
      sub = await pm.getSubscription();
      if (!sub) {
        sub = await pm.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      add("Subscription push", "ok", "Creata correttamente");
    } catch (e) {
      add("Subscription push", "fail", e.message);
      setRunning(false); return;
    }

    // 7. Salvataggio nel database
    try {
      const { error } = await sb.from("push_subscriptions").upsert(
        { player_id: playerId, subscription: JSON.parse(JSON.stringify(sub)) },
        { onConflict: "player_id" }
      );
      if (error) {
        add("Salvataggio DB", "fail", error.message);
        setRunning(false); return;
      }
      add("Salvataggio DB", "ok", "Subscription salvata");
    } catch (e) {
      add("Salvataggio DB", "fail", e.message);
      setRunning(false); return;
    }

    // 8. Test invio reale
    try {
      const resp = await fetch(PUSH_EDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${PUSH_ANON_KEY}` },
        body: JSON.stringify({
          subscription: JSON.parse(JSON.stringify(sub)),
          title: "🔔 Test PUG",
          body: "Se vedi questa notifica, funziona tutto!",
        }),
      });
      const txt = await resp.text();
      if (resp.ok) {
        add("Invio notifica test", "ok", "Inviata! Controlla se arriva la notifica.");
      } else {
        add("Invio notifica test", "fail", `Server ${resp.status}: ${txt.slice(0,200)}`);
      }
    } catch (e) {
      add("Invio notifica test", "fail", e.message);
    }

    setRunning(false);
  }

  const COLORS = { ok:"#339966", fail:"#ff5555", warn:"#ffbb33" };
  const ICONS = { ok:"✅", fail:"❌", warn:"⚠️" };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:380,maxHeight:"85vh",overflowY:"auto"}}>
        <div className="modal-title">🔧 Diagnostica notifiche</div>
        <div style={{fontSize:12.5,fontWeight:600,color:"#101010",background:"rgba(255,255,255,.82)",padding:"8px 12px",borderRadius:10,marginBottom:16,textAlign:"center"}}>
          Premi Avvia e controlla riga per riga dove si ferma.
        </div>

        {steps.length === 0 && !running && (
          <button className="btn btn-primary" style={{width:"100%",marginBottom:12}} onClick={runDiagnostics}>
            ▶️ Avvia diagnostica
          </button>
        )}

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {steps.map((s,i) => (
            <div key={i} style={{
              background:"rgba(255,255,255,.04)",
              border:`1px solid ${COLORS[s.status]}44`,
              borderRadius:10, padding:"10px 12px",
            }}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span>{ICONS[s.status]}</span>
                <span style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>{s.label}</span>
              </div>
              {s.detail && (
                <div style={{fontSize:11,color:COLORS[s.status],marginTop:4,marginLeft:24,lineHeight:1.4}}>
                  {s.detail}
                </div>
              )}
            </div>
          ))}
        </div>

        {running && (
          <div style={{textAlign:"center",padding:12,fontSize:13,color:"var(--text3)"}}>⏳ In corso…</div>
        )}

        {steps.length > 0 && !running && (
          <button className="btn btn-ghost" style={{width:"100%",marginTop:12}} onClick={runDiagnostics}>
            🔄 Ripeti test
          </button>
        )}
        <button className="btn btn-ghost" style={{width:"100%",marginTop:8}} onClick={onClose}>
          Chiudi
        </button>
      </div>
    </div>
  );
}

// ─── INSTALL PWA (Android) ──────────────────────────────
let _deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredPrompt = e;
  // Notifica tutti i componenti in ascolto
  window.dispatchEvent(new Event('pwa-installable'));
});
window.addEventListener('appinstalled', () => {
  _deferredPrompt = null;
  window.dispatchEvent(new Event('pwa-installed'));
});

function InstallPWAButton() {
  const [canInstall, setCanInstall] = useState(!!_deferredPrompt);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    function onInstallable() { setCanInstall(true); }
    function onInstalled() { setCanInstall(false); setInstalled(true); }
    window.addEventListener('pwa-installable', onInstallable);
    window.addEventListener('pwa-installed', onInstalled);
    return () => {
      window.removeEventListener('pwa-installable', onInstallable);
      window.removeEventListener('pwa-installed', onInstalled);
    };
  }, []);

  if (!canInstall || installed) return null;

  async function install() {
    if (!_deferredPrompt) return;
    _deferredPrompt.prompt();
    const { outcome } = await _deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      _deferredPrompt = null;
      setCanInstall(false);
      addToast('✅ App installata!', 'ok');
    }
  }

  return (
    <div onClick={install} style={{
      display:'flex', alignItems:'center', gap:10,
      background:'rgba(163,207,254,.08)',
      border:'1px solid rgba(163,207,254,.25)',
      borderRadius:14, padding:'12px 14px', marginBottom:10,
      cursor:'pointer', transition:'all .15s',
    }}
    onMouseOver={e=>e.currentTarget.style.background='rgba(163,207,254,.15)'}
    onMouseOut={e=>e.currentTarget.style.background='rgba(163,207,254,.08)'}
    >
      <span style={{fontSize:22,flexShrink:0}}>📲</span>
      <div style={{flex:1}}>
        <div style={{fontSize:13,fontWeight:700,color:'var(--neon-blue)'}}>Installa app</div>
        <div style={{fontSize:11,color:'var(--text3)',marginTop:1}}>Aggiunge PUG alla schermata Home</div>
      </div>
      <span style={{fontSize:11,color:'var(--neon-blue)',fontWeight:700,flexShrink:0}}>Installa →</span>
    </div>
  );
}

// ─── PIXEL SOUNDS ────────────────────────────────────────
let soundEnabled = localStorage.getItem("pug_sounds") !== "false";

function playPixel(type) {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const play = (freq, start, dur, vol=0.08, wave="square") => {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.connect(gain);
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(vol, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };

    if (type === "levelfill") {
      // "baing" felice: campanella ascendente arrotondata
      play(523,.0,.12,.07,"sine"); play(659,.1,.12,.07,"sine"); play(784,.2,.18,.08,"sine"); play(1047,.34,.25,.06,"sine");
    } else if (type === "xp") {
      play(440, 0, .1); play(660, .1, .15);
    } else if (type === "coin") {
      play(523, 0, .08); play(784, .08, .12);
    } else if (type === "levelup") {
      play(262,.0,.1); play(330,.1,.1); play(392,.2,.1); play(523,.3,.2,"sine");
    } else if (type === "checkin") {
      play(440,.0,.06); play(880,.07,.1,"sine");
    } else if (type === "badge") {
      play(523,.0,.08); play(659,.09,.08); play(784,.18,.08); play(1047,.27,.3,"sine");
    } else if (type === "msg") {
      play(660,.0,.06,.05,"sine"); play(880,.08,.1,.04,"sine");
    } else if (type === "error") {
      play(220,.0,.15,.06); play(180,.15,.2,.06);
    }
  } catch(_) {}
}


// ─── QR CHECK-IN CELEBRATION ─────────────────────────────
function QRCelebration({ xpGained, playerName, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{position:"fixed",inset:0,zIndex:9998,background:"rgba(0,0,0,.7)",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onDone}>
      <style>{`
        @keyframes qrPop{0%{transform:scale(0);opacity:0}60%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
        @keyframes xpFloat{0%{transform:translateY(0);opacity:1}100%{transform:translateY(-60px);opacity:0}}
        @keyframes qrSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
      `}</style>
      <div style={{textAlign:"center",animation:"qrPop .5s cubic-bezier(.34,1.56,.64,1) forwards"}}>
        <div style={{fontSize:80,marginBottom:8,animation:"qrSpin .6s ease-out"}}>✅</div>
        <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:32,fontWeight:900,color:"#fff",marginBottom:4}}>
          {playerName}
        </div>
        <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:48,fontWeight:900,
          color:"#FDEF26",animation:"xpFloat 2s 1s ease-out forwards"}}>
          +{xpGained} ⭐ XP
        </div>
        <div style={{fontSize:13,color:"rgba(255,255,255,.5)",marginTop:8}}>Presenza registrata!</div>
      </div>
    </div>
  );
}

// ─── CHANGE PASSWORD MODAL ───────────────────────────────
function ChangePwdModal({ onClose }) {
  const [newPwd, setNewPwd]   = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");
  const [ok, setOk]           = useState(false);

  async function save() {
    setErr("");
    if (newPwd.length < 8) { setErr("La password deve avere almeno 8 caratteri."); return; }
    if (newPwd !== confirm)  { setErr("Le password non coincidono."); return; }
    setLoading(true);
    const { error } = await sb.auth.updateUser({ password: newPwd });
    setLoading(false);
    if (error) { setErr(error.message); return; }
    setOk(true);
    setTimeout(onClose, 2000);
  }

  return (
    <div>
      <div className="modal-title">🔑 Cambia Password</div>
      {ok ? (
        <div style={{textAlign:"center",padding:"20px 0"}}>
          <div style={{fontSize:40,marginBottom:8}}>✅</div>
          <div style={{fontWeight:700,color:"var(--neon-green)"}}>Password aggiornata!</div>
        </div>
      ) : (
        <>
          <div className="form-group">
            <label className="form-label">Nuova password</label>
            <input type="password" className="form-input" value={newPwd}
              onChange={e=>setNewPwd(e.target.value)} placeholder="Minimo 8 caratteri" autoFocus/>
          </div>
          <div className="form-group">
            <label className="form-label">Conferma password</label>
            <input type="password" className="form-input" value={confirm}
              onChange={e=>setConfirm(e.target.value)} placeholder="Ripeti la nuova password"/>
          </div>
          {err && <div style={{color:"var(--danger)",fontSize:13,marginBottom:12}}>{err}</div>}
          <div style={{display:"flex",gap:8}}>
            <button className="btn btn-primary" style={{flex:1}} onClick={save} disabled={loading||!newPwd||!confirm}>
              {loading?"⏳ Salvataggio…":"Salva password"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Annulla</button>
          </div>
        </>
      )}
    </div>
  );
}


// ─── LOGIN ────────────────────────────────────────────────
// Due modalità: educator (email+password via Supabase Auth) e player (nickname+PIN diretto su profiles)

function Login({ onLogin }) {
  const [mode, setMode] = useState("player");
  const [search, setSearch] = useState("");
  const [players, setPlayers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [pin, setPin] = useState("");
  const [loadingPin, setLoadingPin] = useState(false);
  const [err, setErr] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loadingEdu, setLoadingEdu] = useState(false);
  const [showEduLogin, setShowEduLogin] = useState(false);
  const [leafTaps, setLeafTaps] = useState(0);
  const debouncedSearch = useDebounce(search, 200);

  const [showSquadLogin, setShowSquadLogin] = useState(true);
  useEffect(() => {
    // Carica visibilità per squadre (anche senza login)
    sb.from("profiles").select("app_config").eq("id","00000000-0000-0000-0000-000000000099").single()
      .then(({data})=>{ if(data?.app_config?.squadre===false) setShowSquadLogin(false); }).catch(()=>{});
    sb.from("profiles")
      .select("id,display_name,first_name,avatar_url,squad_id,squads(name)")
      .eq("role","player").neq("display_name","AppConfig")
      .order("display_name").limit(300)
      .then(({ data }) => setPlayers(data || []));
  }, []);

  // Hidden educator access: tap 🌿 3 times
  function handleLeafTap() {
    const next = leafTaps + 1;
    setLeafTaps(next);
    if (next >= 3) { setShowEduLogin(true); setLeafTaps(0); }
    else setTimeout(() => setLeafTaps(0), 2000);
  }

  // Mostra giocatori solo se l'utente ha digitato almeno 2 lettere
  const filtered = debouncedSearch.length >= 2
    ? players.filter(p =>
        p.display_name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
        (p.first_name||"").toLowerCase().includes(debouncedSearch.toLowerCase())
      )
    : [];

  async function loginPlayer() {
    if (!selected || pin.length !== 4) return;
    const _lk = "pug_lock_" + selected.id;
    const _lu = parseInt(localStorage.getItem(_lk) || "0", 10);
    if (_lu > Date.now()) { setErr("Troppi tentativi. Riprova tra " + Math.ceil((_lu - Date.now())/60000) + " min o chiedi a un operatore."); setPin(""); return; }
    setLoadingPin(true); setErr("");

    // ① Login Auth vero: crea una sessione Supabase firmata (serve alle RLS).
    //    Il giocatore vede solo nome+PIN; email e password sono sintetiche.
    const { data: authData, error: authErr } = await sb.auth.signInWithPassword({
      email: playerEmail(selected.id),
      password: playerPwd(pin, selected.id),
    });

    if (!authErr && authData?.user) {
      // Sessione Auth ottenuta → carica il profilo e entra
      const { data: prof } = await sb.from("profiles")
        .select("id,display_name,first_name,avatar_url,xp,coin,squad_id,role,current_streak,longest_streak,last_checkin_date,xp_goal,created_at,squads(name)")
        .eq("id", selected.id).single();
      const data = { ...(prof || { id: selected.id, display_name: selected.display_name }), _playerSession: true, _mustChangePin: pin === "1234" };
      localStorage.removeItem("pug_att_"+selected.id); localStorage.removeItem("pug_lock_"+selected.id);
      localStorage.setItem("pug_player", JSON.stringify(data));
      onLogin(data);
      setTimeout(() => registerPush(data.id), 2000);
      setLoadingPin(false);
      return;
    }

    // ② Fallback (paracadute): se Auth non va (giocatore non ancora
    //    migrato, o problema di rete), usa la verifica server verify_pin.
    const { data: res, error } = await sb.rpc("verify_pin", { p_player_id: selected.id, p_pin: pin });
    if (error) { setErr("Errore di rete. Riprova."); setLoadingPin(false); return; }
    if (res?.error === "rate_limited") { setErr("Troppi tentativi errati. Riprova tra 10 minuti."); setPin(""); setLoadingPin(false); return; }
    if (!res?.ok || !res?.profile) { const _ak="pug_att_"+selected.id; const _at=parseInt(localStorage.getItem(_ak)||"0",10)+1; if(_at>=4){ localStorage.setItem("pug_lock_"+selected.id, String(Date.now()+300000)); localStorage.removeItem(_ak); setErr("Troppi tentativi. Bloccato 5 minuti (o chiedi a un operatore)."); } else { localStorage.setItem(_ak, String(_at)); setErr("PIN errato ("+_at+"/4). Riprova."); } setPin(""); setLoadingPin(false); return; }
    localStorage.removeItem("pug_att_"+selected.id); localStorage.removeItem("pug_lock_"+selected.id);
    const data = { ...res.profile, _playerSession: true, _mustChangePin: res.must_change_pin === true };
    localStorage.setItem("pug_player", JSON.stringify(data));
    onLogin(data);
    setTimeout(() => registerPush(data.id), 2000);
    setLoadingPin(false);
  }

  async function loginEducator() {
    if (!email || !password) return;
    setLoadingEdu(true); setErr("");
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { setErr(error.message); setLoadingEdu(false); return; }
    const { data: profile } = await sb.from("profiles").select("id,display_name,role,avatar_url,squad_id,xp,coin,level_id,created_at,updated_at,first_name,current_streak,longest_streak,last_checkin_date,app_config,xp_goal,squads(name)").eq("id", data.user.id).single();
    onLogin(profile || { id: data.user.id, role: "educator", display_name: email.split("@")[0], xp: 0, coin: 100 });
    if (profile?.id) setTimeout(() => registerPush(profile.id), 2000);
    setLoadingEdu(false);
  }

  return (
    <div className="login-wrap" style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"20px 16px",position:"relative"}}>

      {/* Logo ufficiale + claim */}
      <div style={{textAlign:"center",marginBottom:32}}>
        <div className="login-logo-full"/>
        <div className="hand login-claim">IL GRANDE GIOCO DEL GARDEN</div>
      </div>

      {/* Player login card */}
      {!showEduLogin ? (
        <div className="login-card" style={{width:"100%",maxWidth:420,borderRadius:20,padding:"24px 20px",position:"relative"}}>
          <div className="bg-doodles login-doodles"/>
          {selected ? (
            /* PIN entry */
            <div style={{textAlign:"center"}}>
              <button onClick={()=>{setSelected(null);setPin("");setErr("");}} style={{position:"absolute",top:16,left:16,background:"none",border:"none",color:"var(--text3)",cursor:"pointer",fontSize:20}}>←</button>
              <div style={{width:110,height:110,borderRadius:16,overflow:"hidden",border:"3px solid #101010",margin:"0 auto 12px",boxShadow:"4px 4px 0 #101010"}}>
                <Avatar url={selected.avatar_url} emoji="🌱" size={110}/>
              </div>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:24,fontWeight:900,color:"#101010",marginBottom:4}}>{selected.display_name}</div>
              
              <div style={{marginTop:20,marginBottom:6}}>
                <label className="form-label" style={{textAlign:"left",display:"block"}}>PIN (4 cifre)</label>
                <input className="form-input pin-input" type="password" inputMode="numeric" maxLength={4}
                  value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))}
                  onKeyDown={e=>e.key==="Enter"&&loginPlayer()}
                  placeholder="• • • •" autoFocus
                  style={{textAlign:"center",fontSize:28,letterSpacing:8}}/>
              </div>
              {err && <div className="err-msg" style={{marginBottom:8}}>{err}</div>}
              <button className="btn btn-primary" style={{width:"100%",padding:"14px",fontSize:16,marginTop:4}}
                onClick={loginPlayer} disabled={loadingPin||pin.length!==4}>
                {loadingPin?"⏳ Accesso…":"ENTRA"}
              </button>
            </div>
          ) : (
            /* Player selector */
            <div>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,textTransform:"uppercase",color:"#101010",marginBottom:12,letterSpacing:".05em"}}>
                Chi sei?
              </div>
              <input className="search-inp" placeholder="🔍 Scrivi il tuo nome…" value={search}
                onChange={e=>setSearch(e.target.value)} style={{marginBottom:10}}/>
              <div style={{maxHeight:300,overflowY:"auto",display:"flex",flexDirection:"column",gap:6}}>
                {filtered.length===0
                  ? <div className="empty" style={{padding:16,textAlign:"center"}}>{debouncedSearch.length < 2 ? "Digita il tuo nome per trovare il profilo" : "Nessun giocatore trovato"}</div>
                  : filtered.map(p => (
                    <div key={p.id} onClick={()=>{setSelected(p);setPin("");setErr("");}}
                      style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",
                        background:"#fff",border:"1.5px solid rgba(16,16,16,.3)",
                        borderRadius:12,cursor:"pointer",transition:"all .15s"}}
                      onMouseOver={e=>{e.currentTarget.style.background="#FDEF26";e.currentTarget.style.borderColor="#101010";}}
                      onMouseOut={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.borderColor="rgba(16,16,16,.3)";}}>
                      <div style={{width:36,height:36,borderRadius:"50%",overflow:"hidden",border:"1.5px solid var(--border2)",flexShrink:0}}>
                        <Avatar url={p.avatar_url} emoji="🌱" size={36}/>
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:14,fontWeight:800,color:"#101010",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.display_name}</div>
                        {p.first_name && <div style={{fontSize:11,color:"rgba(16,16,16,.55)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.first_name}</div>}
                        {showSquadLogin && p.squads?.name && <SquadPill name={p.squads.name}/>}
                      </div>
                      <span style={{color:"var(--text3)",fontSize:16}}>→</span>
                    </div>
                  ))
                }
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Educator login */
        <div className="login-card edu-login-card" style={{width:"100%",maxWidth:420,borderRadius:20,padding:"24px 20px",position:"relative"}}>
          <button onClick={()=>setShowEduLogin(false)} style={{position:"absolute",top:16,left:16,background:"none",border:"none",color:"#101010",cursor:"pointer",fontSize:20}}>←</button>
          <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,textTransform:"uppercase",color:"#101010",marginBottom:16,textAlign:"center"}}>
            🌱 Accesso Giardiniere
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input className="form-input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@esempio.it" autoFocus/>
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input className="form-input" type="password" value={password} onChange={e=>setPassword(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&loginEducator()} placeholder="••••••••"/>
          </div>
          {err && <div className="err-msg" style={{marginBottom:8}}>{err}</div>}
          <button className="btn btn-primary" style={{width:"100%",padding:"14px",fontSize:16}}
            onClick={loginEducator} disabled={loadingEdu||!email||!password}>
            {loadingEdu?"⏳ Accesso…":"ENTRA"}
          </button>
        </div>
      )}

      {/* Hidden educator trigger — piccola foglia in basso a destra */}
      {!showEduLogin && (
        <button onClick={handleLeafTap} style={{
          position:"fixed",bottom:110,right:20,
          background:"none",border:"none",cursor:"pointer",
          fontSize:18,opacity:0.3,
          filter:"grayscale(1) brightness(0) invert(1)",
          transition:"opacity .2s",
          WebkitTapHighlightColor:"transparent",
          userSelect:"none",
        }}
        onMouseOver={e=>e.currentTarget.style.opacity="0.4"}
        onMouseOut={e=>e.currentTarget.style.opacity="0.18"}
        title="">🌿</button>
      )}
    </div>
  );
}


// ─── EDUCATOR VIEWS ───────────────────────────────────────

function PlayersView({ sectionColors, setSectionColors }) {
    const [players, setPlayers] = useState([]);
  const [squads, setSquads] = useState([]);
  const [search, setSearch] = useState("");
  const searchDeb = useDebounce(search, 250);
  const [sortBy, setSortBy] = useState("alpha");
  const [squadFilter, setSquadFilter] = useState("all");
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(false);
  const [batchXp, setBatchXp] = useState(10);
  const [batchCoin, setBatchCoin] = useState(5);
  const [msg, setMsg] = useState("");
  const [editPlayer, setEditPlayer] = useState(null);
  const [expandedPlayer, setExpandedPlayer] = useState(null);
  const [showCreatePlayer, setShowCreatePlayer] = useState(false);
  const [newPlayer, setNewPlayer] = useState({ display_name:"", first_name:"", pin:"1234", squad_id:"", xp:0, coin:0, avatar_url:"" });
  const [createPlayerErr, setCreatePlayerErr] = useState("");

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    // Timeout di sicurezza: se il caricamento va storto, sblocca dopo 8s
    const safetyTimeout = setTimeout(() => {
      loadingRef.current = false;
      setLoading(false);
    }, 8000);
    try {
      const [{ data }, { data: sq }, { data: pins }] = await Promise.all([
        sb.from("profiles").select("id,display_name,first_name,avatar_url,xp,coin,squad_id,current_streak,role,squads(name,color)").eq("role", "player").order("xp", { ascending: false }),
        sb.from("squads").select("*"),
        sb.rpc("educator_player_pins"),
      ]);
      const pinMap = Object.fromEntries((pins || []).map(r => [r.player_id, r.pin]));
      setPlayers((data || []).map(p => ({ ...p, pin: pinMap[p.id] || "1234" })));
      setSquads(sq || []);
    } finally {
      clearTimeout(safetyTimeout);
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Fallback: force-clear loading after 6s to avoid infinite spinner
    const t = setTimeout(() => setLoading(false), 6000);
    return () => clearTimeout(t);
  }, [load]);

  const visible = players.filter(p => {
    const sq = squadFilter === "all" || p.squads?.name === squadFilter;
    const sr = !searchDeb || p.display_name.toLowerCase().includes(searchDeb.toLowerCase()) || (p.first_name||"").toLowerCase().includes(searchDeb.toLowerCase());
    return sq && sr;
  }).sort((a, b) => {
    switch (sortBy) {
      case "xp":     return (b.xp||0) - (a.xp||0);
      case "coin":   return (b.coin||0) - (a.coin||0);
      case "level":  return (b.xp||0) - (a.xp||0);
      case "recent": return (new Date(b.created_at||0)) - (new Date(a.created_at||0));
      case "squad":  return (a.squads?.name||"zzz").localeCompare(b.squads?.name||"zzz");
      case "alpha":
      default:       return (a.display_name||"").localeCompare(b.display_name||"");
    }
  });

  async function changeXP(playerId, delta, field = "xp") {
    const p = players.find(x => x.id === playerId);
    if (!p) return;
    // RPC atomica: update + xp_history + log in un'unica transazione lato server
    const { data: res, error } = await sb.rpc("award_xp", {
      p_player_id: playerId,
      p_xp: field === "xp" ? delta : 0,
      p_coin: field === "coin" ? delta : 0,
      p_reason: "manuale",
      p_log_title: field === "xp" ? "XP manuale" : "Coin manuale",
    });
    if (error) { addToast("Errore: " + error.message, "error"); return; }
    const newXp = res?.xp ?? Math.max(0, p.xp + (field === "xp" ? delta : 0));
    const newCoin = res?.coin ?? Math.max(0, p.coin + (field === "coin" ? delta : 0));
    if (field === "xp" && delta > 0) {
      const leveled = await checkLevelUp(playerId, p.xp, newXp);
      if (!leveled) sendPush(playerId, "⭐ Hai ricevuto XP!", `+${delta} XP — continua così!`).catch(()=>{});
    }
    if (field === "coin" && delta > 0) sendPush(playerId, "🪙 Hai ricevuto Coin!", `+${delta} Coin!`).catch(()=>{});
    setPlayers(prev => prev.map(x => x.id === playerId ? { ...x, xp: newXp, coin: newCoin } : x));
  }

  async function applyBatch() {
    if (!selected.size) return;
    await Promise.all([...selected].map(async (id) => {
      const p = players.find(x => x.id === id);
      if (!p) return;
      // RPC atomica: 1 query al posto di 3-4, niente aggiornamenti persi
      const { data: res, error } = await sb.rpc("award_xp", {
        p_player_id: id,
        p_xp: Number(batchXp),
        p_coin: Number(batchCoin),
        p_reason: "batch",
        p_log_title: "Assegnazione batch",
      });
      if (error) return;
      const newXp = res?.xp ?? (p.xp + Number(batchXp));
      const leveled = await checkLevelUp(id, p.xp, newXp);
      if (!leveled && Number(batchXp) > 0) {
        sendPush(id, "⭐ Hai ricevuto XP!", `+${batchXp} XP e +${batchCoin} Coin!`).catch(()=>{});
      }
    }));
    setMsg(`+${batchXp} XP e +${batchCoin} coin assegnati a ${selected.size} giocatori`);
    setSelected(new Set()); load();
    setTimeout(() => setMsg(""), 3000);
  }

  async function savePlayer(p) {
    // Calcola il delta XP rispetto al valore originale del giocatore
    const prev = players.find(pl => pl.id === p.id);
    const newXp = Number(p.xp) || 0;
    const newCoin = Number(p.coin) || 0;
    const deltaXp = newXp - (prev?.xp || 0);
    await sb.from("profiles").update({ display_name: p.display_name, first_name: p.first_name || null, squad_id: p.squad_id, xp: newXp, coin: newCoin, avatar_url: p.avatar_url || null }).eq("id", p.id);
    if ((p.pin || "1234") !== (prev?.pin || "1234")) {
      const r = await playerAdmin("set_pin", { player_id: p.id, pin: p.pin || "1234" });
      if (r?.error) { setMsg("⚠️ PIN non aggiornato: " + r.error); setTimeout(() => setMsg(""), 4000); }
    }
    if (deltaXp !== 0) await logXPGain(p.id, deltaXp, newXp, "modifica_manuale");
    setEditPlayer(null); load();
  }

  async function resetAllPins() {
    const hasSelection = selected.size > 0;
    let target;
    if (hasSelection) {
      target = confirm(`Resettare il PIN a 1234 per i ${selected.size} giocatori selezionati?\n\nOK = solo selezionati\nAnnulla = scegli`)
        ? "selected" : null;
      if (!target) {
        if (!confirm("Resettare il PIN di TUTTI i giocatori a 1234?")) return;
        target = "all";
      }
    } else {
      if (!confirm("Resettare il PIN di tutti i giocatori a 1234?")) return;
      target = "all";
    }
    const ids = target === "selected" ? [...selected] : players.map(p => p.id);
    setMsg(`Reset PIN in corso… (0/${ids.length})`);
    let done = 0, fails = 0;
    for (let i = 0; i < ids.length; i += 5) {
      const chunk = ids.slice(i, i + 5);
      const results = await Promise.all(chunk.map(id => playerAdmin("set_pin", { player_id: id, pin: "1234" })));
      results.forEach(r => { if (r?.error) fails++; else done++; });
      setMsg(`Reset PIN in corso… (${done}/${ids.length})`);
    }
    setMsg(fails ? `PIN resettati: ${done}. ⚠️ Falliti: ${fails} (riprova)` : `PIN resettati a 1234 per ${done} giocatori`);
    if (target === "selected") setSelected(new Set());
    load();
    setTimeout(() => setMsg(""), 3000);
  }

  async function deletePlayer(id, name) {
    if (!confirm(`Eliminare definitivamente il giocatore "${name}"? L'operazione non è reversibile.`)) return;
    const { error } = await sb.from("profiles").delete().eq("id", id);
    if (error) { alert("Errore: " + error.message); return; }
    setPlayers(prev => prev.filter(p => p.id !== id));
    setMsg(`Giocatore "${name}" eliminato`);
    setTimeout(() => setMsg(""), 3000);
  }

  async function createPlayer() {
    setCreatePlayerErr("");
    if (!newPlayer.display_name.trim()) { setCreatePlayerErr("Inserisci il nickname"); return; }
    // La edge function crea profilo + utente Auth insieme (con rollback)
    const r = await playerAdmin("create_player", {
      display_name: newPlayer.display_name.trim(),
      first_name: newPlayer.first_name.trim() || null,
      pin: newPlayer.pin || "1234",
      squad_id: newPlayer.squad_id || null,
      avatar_url: newPlayer.avatar_url || null,
    });
    if (r?.error) { setCreatePlayerErr("Errore: " + r.error); return; }
    // XP/coin iniziali (se impostati) con un update successivo
    if ((Number(newPlayer.xp) || 0) !== 0 || (Number(newPlayer.coin) || 0) !== 0) {
      await sb.from("profiles").update({ xp: Number(newPlayer.xp) || 0, coin: Number(newPlayer.coin) || 0 }).eq("id", r.player_id);
    }
    setShowCreatePlayer(false);
    setNewPlayer({ display_name:"", first_name:"", pin:"1234", squad_id:"", xp:0, coin:0, avatar_url:"" });
    { const nm = newPlayer.display_name.trim();
      sb.from("profiles").select("id").eq("role","educator").then(({ data: edus }) => {
        const rows=(edus||[]).map(e=>({user_id:e.id,type:"new_player",title:"🌱 Nuovo giocatore",body:`${nm} è stato aggiunto al gioco`}));
        if(rows.length) sb.from("notifications").insert(rows).then(()=>{}).catch(()=>{});
      }); }
    setMsg("Giocatore creato! PIN: " + (newPlayer.pin || "1234"));
    setTimeout(() => setMsg(""), 4000);
    load();
  }

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label">Totali</div><div className="stat-value">{visible.length}</div></div>
        <div className="stat-card"><div className="stat-label">Attivi</div><div className="stat-value">{visible.filter(p => p.xp > 1).length}</div></div>
        <div className="stat-card"><div className="stat-label">Selezionati</div><div className="stat-value">{selected.size}</div></div>
        <div className="stat-card"><div className="stat-label">Squadre</div><div className="stat-value">{squads.length}</div></div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn btn-yellow btn-sm" onClick={() => setShowCreatePlayer(true)}>➕ Nuovo giocatore</button>
        <button className="btn btn-ghost btn-sm" onClick={resetAllPins}>🔑 Reset PIN</button>
      </div>

      {selected.size > 0 && (
        <div className="batch-panel">
          <div className="batch-info">{selected.size} giocatori selezionati</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input className="batch-inp" type="number" value={batchXp} onChange={e => setBatchXp(e.target.value)} />
            <span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 700 }}>XP</span>
            <input className="batch-inp" type="number" value={batchCoin} onChange={e => setBatchCoin(e.target.value)} />
            <span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 700 }}>Coin</span>
            <button className="btn btn-yellow btn-sm" onClick={applyBatch}>Assegna</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Annulla</button>
          </div>
        </div>
      )}

      {msg && <div style={{ background: "rgba(163,207,254,.1)", border: "1.5px solid rgba(163,207,254,.3)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "var(--azzurro)", fontWeight: 600 }}>{msg}</div>}

      <div className="filter-bar">
        <input className="search-inp" placeholder="Cerca per nickname o nome…" value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
          <span style={{fontSize:11,color:"var(--text3)",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em"}}>Ordina</span>
          <select value={sortBy} onChange={e=>setSortBy(e.target.value)}
            style={{padding:"6px 10px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:10,color:"var(--text)",fontSize:12,fontWeight:700,cursor:"pointer"}}>
            <option value="alpha">A→Z (nickname)</option>
            <option value="xp">XP più alti</option>
            <option value="coin">Coin più alti</option>
            <option value="squad">Per squadra</option>
            <option value="recent">Aggiunti di recente</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
          {squads.map(s => <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>)}
        </div>
      </div>

      {loading ? <div className="loading">⏳ Caricamento…</div> : (
        <>
          <div className="player-grid">
            {visible.map(p => {
              const lv = getLevel(p.xp);
              return (
                <div key={p.id} className={`player-card ${selected.has(p.id) ? "selected" : ""}`} onClick={() => { const n = new Set(selected); n.has(p.id) ? n.delete(p.id) : n.add(p.id); setSelected(n); }}>
                  <div className="avatar-wrap"><Avatar url={p.avatar_url} emoji={lv.emoji} /></div>
                  <div className="p-name">{p.display_name}</div>
                  {p.first_name && <div style={{fontSize:10,color:"var(--text3)",marginTop:-2,marginBottom:2}}>{p.first_name}</div>}
                  <div className="p-level">{lv.emoji} {lv.name}</div>
                  <div className="p-xp">{p.xp} XP</div>
                  <div className="p-coin">🪙 {p.coin}</div>
                  {p.squads?.name && <SquadPill name={p.squads.name} />}
                  <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>PIN: <span style={{ color: "var(--azzurro)", fontWeight: 700 }}>{p.pin || "1234"}</span></div>

                  <button className="btn btn-ghost btn-xs" style={{ marginTop: 8, width: "100%" }} onClick={e => { e.stopPropagation(); setExpandedPlayer(expandedPlayer === p.id ? null : p.id); }}>
                    {expandedPlayer === p.id ? "▲ Chiudi" : "🔍 Dettagli"}
                  </button>
                  <button className="btn btn-ghost btn-xs" style={{ marginTop: 4, width: "100%" }} onClick={e => { e.stopPropagation(); setEditPlayer({ ...p, pin: p.pin || "1234" }); }}>✏️ Modifica</button>

                  <button className="btn btn-danger btn-xs" style={{ marginTop: 4, width: "100%", fontSize: 11 }} onClick={e => { e.stopPropagation(); deletePlayer(p.id, p.display_name); }}>🗑️ Elimina</button>
                </div>
              );
            })}
          </div>
          {expandedPlayer && <PlayerDetailPanel playerId={expandedPlayer} squads={squads} onClose={() => setExpandedPlayer(null)} />}
        </>
      )}

      {showCreatePlayer && (
        <div className="modal-bg" onClick={() => setShowCreatePlayer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">➕ Nuovo giocatore</div>
            <div className="form-group"><label className="form-label">Nickname *</label><input className="form-input" value={newPlayer.display_name} onChange={e=>setNewPlayer(p=>({...p,display_name:e.target.value}))} placeholder="es. FoxTrot99" autoFocus/></div>
            <div className="form-group"><label className="form-label">Nome reale</label><input className="form-input" value={newPlayer.first_name} onChange={e=>setNewPlayer(p=>({...p,first_name:e.target.value}))} placeholder="es. Marco R."/></div>
            <div className="section-label">Avatar pianta</div>
            {newPlayer.avatar_url && (
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,padding:"8px 10px",background:"rgba(253,239,38,.06)",border:"1px solid rgba(253,239,38,.2)",borderRadius:10}}>
                <img src={newPlayer.avatar_url} style={{width:48,height:48,objectFit:"contain"}} alt="avatar"/>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"#FDEF26"}}>{newPlayer.avatar_url.split('/').pop().replace('.webp','')}</div>
                  <button className="btn btn-ghost btn-xs" style={{marginTop:4}} onClick={()=>setNewPlayer(p=>({...p,avatar_url:""}))}>✕ Rimuovi</button>
                </div>
              </div>
            )}
            <AvatarPicker
              selected={newPlayer.avatar_url}
              onSelect={url=>setNewPlayer(p=>({...p,avatar_url:url}))}
              squadFilter={squads.find(s=>s.id===newPlayer.squad_id)?.name || "Azzurra"}
            />
            <div className="form-group" style={{marginTop:10}}><label className="form-label">Squadra</label>
              <select value={newPlayer.squad_id} onChange={e=>setNewPlayer(p=>({...p,squad_id:e.target.value}))}>
                <option value="">Nessuna squadra</option>
                {squads.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div className="form-group"><label className="form-label">PIN</label><input className="form-input" maxLength={4} value={newPlayer.pin} onChange={e=>setNewPlayer(p=>({...p,pin:e.target.value.replace(/\D/g,"").slice(0,4)}))} style={{textAlign:"center",fontFamily:"'Funnel Display'",fontSize:20,letterSpacing:4}}/></div>
              <div className="form-group"><label className="form-label">XP inizio</label><input className="form-input" type="number" value={newPlayer.xp} onChange={e=>setNewPlayer(p=>({...p,xp:e.target.value}))}/></div>
              <div className="form-group"><label className="form-label">Coin inizio</label><input className="form-input" type="number" value={newPlayer.coin} onChange={e=>setNewPlayer(p=>({...p,coin:e.target.value}))}/></div>
            </div>
            {createPlayerErr && <div style={{color:"var(--danger)",fontSize:12,fontWeight:700,marginBottom:8}}>{createPlayerErr}</div>}
            <div style={{background:"rgba(253,239,38,.06)",border:"1px solid rgba(253,239,38,.2)",borderRadius:10,padding:"8px 12px",fontSize:11,color:"var(--text3)",marginBottom:12}}>💡 Il giocatore potrà cambiare il PIN al primo accesso. Il nickname deve essere unico.</div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-primary" style={{flex:1}} onClick={createPlayer} disabled={!newPlayer.display_name.trim()}>Crea giocatore</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>setShowCreatePlayer(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}

      {editPlayer && (
        <div className="modal-bg" onClick={() => setEditPlayer(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Modifica profilo</div>
            {/* Avatar picker - seleziona da predefiniti */}
            <div className="section-label">Cambia avatar pianta</div>
            <AvatarPicker
              selected={editPlayer.avatar_url}
              onSelect={url => setEditPlayer(p => ({ ...p, avatar_url: url }))}
              squadFilter={squads.find(s=>s.id===editPlayer.squad_id)?.name || "Azzurra"}
            />
            <div style={{height:1,background:"var(--border)",margin:"10px 0"}}/>
            <div className="form-group"><label className="form-label">Nickname</label><input className="form-input" value={editPlayer.display_name} onChange={e => setEditPlayer(p => ({ ...p, display_name: e.target.value }))} /></div>
            <div className="form-group"><label className="form-label">Nome reale</label><input className="form-input" value={editPlayer.first_name || ""} placeholder="Nome del ragazzo" onChange={e => setEditPlayer(p => ({ ...p, first_name: e.target.value }))} /></div>
            <div className="form-group">
              <label className="form-label">Squadra</label>
              <select value={editPlayer.squad_id || ""} onChange={e => setEditPlayer(p => ({ ...p, squad_id: e.target.value || null }))}>
                <option value="">Nessuna squadra</option>
                {squads.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP</label><input className="form-input" type="number" value={editPlayer.xp} onChange={e => setEditPlayer(p => ({ ...p, xp: Number(e.target.value) }))} /></div>
              <div className="form-group"><label className="form-label">Coin</label><input className="form-input" type="number" value={editPlayer.coin} onChange={e => setEditPlayer(p => ({ ...p, coin: Number(e.target.value) }))} /></div>
              <div className="form-group"><label className="form-label">PIN</label><input className="form-input" type="text" maxLength={4} value={editPlayer.pin} onChange={e => setEditPlayer(p => ({ ...p, pin: e.target.value.replace(/\D/g, "").slice(0, 4) }))} style={{ textAlign: "center", fontFamily: "'Funnel Display'", fontSize: 20, letterSpacing: 4 }} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => savePlayer(editPlayer)}>Salva</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditPlayer(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineAvatarUpload({ playerId, onUploaded }) {
  const ref = useRef();
  const [uploading, setUploading] = useState(false);
  async function handleFile(e) {
    const file = e.target.files[0]; if (!file) return;
    setUploading(true);
    try {
      const compressed = await compressToWebP(file, 400, 0.82);
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const base64url = ev.target.result;
        const kb = Math.round(base64url.length * 0.75 / 1024);
        if (kb > 200) { addToast(`⚠️ Foto troppo grande (${kb}KB)`, 'error'); setUploading(false); return; }
        if (playerId && !playerId.startsWith("new_edu_")) {
          await sb.from("profiles").update({ avatar_url: base64url }).eq("id", playerId);
        }
        onUploaded(base64url);
        setUploading(false);
      };
      reader.onerror = () => { addToast('❌ Errore lettura file', 'error'); setUploading(false); };
      reader.readAsDataURL(compressed);
    } catch(err) { addToast("❌ " + err.message, "error"); setUploading(false); }
  }
  return (
    <div>
      <input ref={ref} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{display:"none"}}/>
      <button className="btn btn-ghost btn-sm" style={{width:"100%"}} onClick={()=>ref.current.click()} disabled={uploading}>
        {uploading ? "⏳ Compressione…" : "📷 Carica foto da dispositivo"}
      </button>
      {!uploading && <div style={{fontSize:10,color:"var(--text3)",marginTop:4,textAlign:"center"}}>Compressa in WebP · salvata nel profilo senza Storage</div>}
    </div>
  );
}

function PlayerDetailPanel({ playerId, squads, onClose }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("storia");
  const [editing, setEditing] = useState(null);
  const [saveMsg, setSaveMsg] = useState("");

  const loadData = useCallback(async () => {
    const [{ data: p }, { data: badges }, { data: att }, { data: notifs }] = await Promise.all([
      sb.from("profiles").select("id,display_name,role,avatar_url,squad_id,xp,coin,level_id,created_at,updated_at,first_name,current_streak,longest_streak,last_checkin_date,app_config,xp_goal,squads(name)").eq("id", playerId).single(),
      sb.from("player_badges").select("*, badges(name,image_url)").eq("player_id", playerId).order("assigned_at", { ascending: false }),
      sb.from("attendances").select("*").eq("player_id", playerId).order("date", { ascending: false }).limit(30),
      sb.from("notifications").select("*").eq("user_id", playerId).order("created_at", { ascending: false }).limit(40),
    ]);
    // Fetch lab names for lab attendances
      const labIds = [...new Set((att||[]).map(a=>a.activity_id).filter(Boolean))];
      let labNames = {};
      if (labIds.length > 0) {
        const { data: labs } = await sb.from("activities").select("id,name").in("id", labIds);
        labNames = Object.fromEntries((labs||[]).map(l=>[l.id,l.name]));
      }
      setData({ profile: p, badges: badges || [], attendances: att || [], history: notifs || [], labNames });
    if (p) {
      let curPin = "1234";
      try {
        const { data: pins } = await sb.rpc("educator_player_pins");
        curPin = (pins || []).find(r => r.player_id === playerId)?.pin || "1234";
      } catch(_) {}
      setEditing({ xp: p.xp, coin: p.coin, pin: curPin, _origPin: curPin, display_name: p.display_name, squad_id: p.squad_id, avatar_url: p.avatar_url || "" });
    }
  }, [playerId]);

  useEffect(() => { loadData(); }, [loadData]);

  async function saveEdits() {
    if (!editing) return;
    await sb.from("profiles").update({ xp: Number(editing.xp), coin: Number(editing.coin), display_name: editing.display_name, squad_id: editing.squad_id || null, xp_goal: Number(editing.xp_goal||0), avatar_url: editing.avatar_url || null }).eq("id", playerId);
    if ((editing.pin || "1234") !== (editing._origPin || "1234")) {
      const r = await playerAdmin("set_pin", { player_id: playerId, pin: editing.pin || "1234" });
      if (r?.error) { setSaveMsg("⚠️ PIN non salvato: " + r.error); setTimeout(() => setSaveMsg(""), 4000); }
    }
    if (deltaXp !== 0) await logXPGain(playerId, deltaXp, Number(editing.xp), "modifica_dettagli");
    setSaveMsg("Salvato ✅"); setTimeout(() => setSaveMsg(""), 2000);
    loadData();
  }

  if (!data) return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:200}}>
        <div className="loading">Caricamento…</div>
      </div>
    </div>
  );

  const { profile, badges, attendances, history, labNames = {} } = data;
  const lv = getLevel(profile?.xp || 0);
  const presentDays = attendances.filter(a => a.status !== "none").length;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxHeight:"92vh",borderRadius:16,overflowY:"auto"}}>
        {/* Header */}
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16,paddingBottom:14,borderBottom:"1px solid var(--border)"}}>
          <div style={{width:64,height:64,borderRadius:"50%",overflow:"hidden",border:"2.5px solid var(--neon-blue)",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"var(--glow-blue)"}}>
            <Avatar url={profile?.avatar_url} emoji={lv.emoji} size={64}/>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:"'Funnel Display'",fontSize:26,fontWeight:900,textTransform:"uppercase",color:"var(--text)",lineHeight:1}}>{profile?.display_name}</div>
            <div style={{fontSize:12,color:"var(--azzurro)",fontWeight:600,marginTop:2}}>{lv.emoji} {lv.name}</div>
            <div style={{display:"flex",gap:10,marginTop:4,flexWrap:"wrap"}}>
              <span style={{fontSize:12,color:"var(--neon-blue)",fontWeight:700}}>⭐ {profile?.xp} XP</span>
              <span style={{fontSize:12,color:"var(--neon-gold)",fontWeight:700}}>🪙 {profile?.coin}</span>
              <span style={{fontSize:12,color:"var(--neon-green)",fontWeight:700}}>📅 {presentDays} presenze</span>
              <span style={{fontSize:12,color:"var(--rosa)",fontWeight:700}}>🎖️ {badges.length} badge</span>
            </div>
          </div>
          <button className="btn btn-ghost btn-xs" onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div className="detail-tabs" style={{marginBottom:14}}>
          {[["storia","📜 Storia"],["badge","🎖️ Badge"],["presenze","📍 Giornaliere"],["labpres","⚡ Lab"],["modifica","✏️ Modifica"]].map(([id,label]) => (
            <button key={id} className={`detail-tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{label}</button>
          ))}
        </div>

        {tab==="storia" && (
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {history.length===0 && <div className="empty">Nessuna azione.</div>}
            {history.map(n => (
              <div key={n.id} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:"1px solid var(--border)"}}>
                <span style={{fontSize:15}}>📌</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--text)"}}>{n.title}</div>
                  <div style={{fontSize:11,color:"var(--text2)"}}>{n.body}</div>
                </div>
                <div style={{fontSize:10,color:"var(--text3)",flexShrink:0}}>{new Date(n.created_at).toLocaleDateString("it-IT")}</div>
              </div>
            ))}
          </div>
        )}

        {tab==="badge" && (
          <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
            {badges.length===0 && <div className="empty" style={{width:"100%"}}>Nessun badge.</div>}
            {badges.map(pb => (
              <div key={pb.id} style={{textAlign:"center",width:72}}>
                {pb.badges?.image_url ? <img src={pb.badges.image_url} style={{width:64,height:64,borderRadius:12,objectFit:"contain",border:"2px solid #101010",display:"block",margin:"0 auto 5px"}} alt=""/> : <div style={{fontSize:36,marginBottom:5}}>🎖️</div>}
                <div style={{fontSize:10,color:"var(--text2)",lineHeight:1.3}}>{pb.badges?.name}</div>
              </div>
            ))}
          </div>
        )}

        {(tab==="presenze"||tab==="labpres") && (() => {
          const daily = attendances.filter(a => !(a.check_type==="lab"||!!a.activity_id));
          const labs  = attendances.filter(a => a.check_type==="lab"||!!a.activity_id);
          const list  = tab==="labpres" ? labs : daily;
          return (
            <div>
              {/* Summary cards */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
                {(tab==="presenze" ? [
                  ["Totali", daily.length, "var(--neon-blue)"],
                  ["XP", daily.reduce((s,a)=>s+(a.xp_awarded||0),0), "var(--neon-blue)"],
                  ["QR verificati", daily.filter(a=>a.qr_verified).length, "var(--neon-green)"],
                ] : [
                  ["Sessioni Lab", labs.length, "#FDEF26"],
                  ["XP Lab", labs.reduce((s,a)=>s+(a.xp_awarded||0),0), "#FDEF26"],
                  ["Lab diversi", [...new Set(labs.map(a=>a.activity_id).filter(Boolean))].length, "var(--rosa)"],
                ]).map(([l,v,c])=>(
                  <div key={l} style={{background:"rgba(0,0,0,.25)",borderRadius:10,padding:"8px",textAlign:"center"}}>
                    <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:22,fontWeight:900,color:c}}>{v}</div>
                    <div style={{fontSize:9,color:"var(--text3)",fontWeight:700,textTransform:"uppercase",marginTop:2}}>{l}</div>
                  </div>
                ))}
              </div>
              {/* List */}
              <div style={{display:"flex",flexDirection:"column",gap:5,maxHeight:280,overflowY:"auto"}}>
                {list.length===0 && <div className="empty">{tab==="labpres"?"Nessun check-in Lab.":"Nessuna presenza giornaliera."}</div>}
                {list.map(a=>{
                  const labName = a.activity_id ? (labNames[a.activity_id]||"Lab") : null;
                  const statusIcon = {full:"✅",partial:"🟡",completed:"⭐",none:"❌"}[a.status]||"—";
                  return (
                    <div key={a.id} style={{display:"flex",gap:8,alignItems:"center",padding:"8px 10px",background:tab==="labpres"?"rgba(253,239,38,.05)":"rgba(163,207,254,.04)",borderRadius:8,borderLeft:`3px solid ${tab==="labpres"?"#FDEF26":"rgba(163,207,254,.3)"}`}}>
                      <span style={{fontSize:14}}>{statusIcon}</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,color:"var(--text)",fontWeight:600}}>{a.date}</div>
                        {labName && <div style={{fontSize:10,color:"#FDEF26",fontWeight:700}}>⚡ {labName}</div>}
                        {a.qr_verified && <span style={{fontSize:9,color:"var(--neon-green)"}}>QR verificato ✓</span>}
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div style={{fontSize:12,color:"var(--neon-blue)",fontWeight:700}}>+{a.xp_awarded||0} XP</div>
                        {(a.coin_awarded||0)>0&&<div style={{fontSize:10,color:"var(--neon-gold)"}}>🪙+{a.coin_awarded}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {tab==="modifica" && editing && (
          <div>
            <div className="form-group"><label className="form-label">Nickname</label><input className="form-input" value={editing.display_name} onChange={e=>setEditing(p=>({...p,display_name:e.target.value}))}/></div>
            <div className="form-group"><label className="form-label">Squadra</label>
              <select value={editing.squad_id||""} onChange={e=>setEditing(p=>({...p,squad_id:e.target.value||null}))}>
                <option value="">Nessuna squadra</option>
                {squads.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div className="form-group"><label className="form-label">XP</label><input className="form-input" type="number" value={editing.xp} onChange={e=>setEditing(p=>({...p,xp:e.target.value}))}/></div>
              <div className="form-group"><label className="form-label">Coin</label><input className="form-input" type="number" value={editing.coin} onChange={e=>setEditing(p=>({...p,coin:e.target.value}))}/></div>
              <div className="form-group"><label className="form-label">PIN</label><input className="form-input" maxLength={4} value={editing.pin} onChange={e=>setEditing(p=>({...p,pin:e.target.value.replace(/[^0-9]/g,"").slice(0,4)}))} style={{textAlign:"center",fontFamily:"'Funnel Display'",fontSize:20,letterSpacing:4}}/></div>
            </div>
            {saveMsg && <div style={{color:"var(--verde)",fontWeight:700,fontSize:13,marginBottom:8}}>{saveMsg}</div>}
            <button className="btn btn-primary" onClick={saveEdits}>Salva modifiche</button>
            <div style={{height:1,background:"var(--border)",margin:"12px 0"}}/>
            <div style={{fontSize:10,fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:8}}>Avatar</div>
            {editing.avatar_url && (
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,padding:"8px",background:"rgba(255,255,255,.04)",borderRadius:10}}>
                <img src={editing.avatar_url} style={{width:52,height:52,objectFit:"contain",borderRadius:8}} alt=""/>
                <div style={{fontSize:12,color:"var(--text2)",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis"}}>{editing.avatar_url.split("/").pop().replace(".webp","")}</div>
              </div>
            )}
            <InlineAvatarUpload playerId={playerId} onUploaded={url=>{setEditing(p=>({...p,avatar_url:url}));setSaveMsg("Avatar aggiornato ✅");setTimeout(()=>setSaveMsg(""),2500);}}/>
            <div className="form-group" style={{marginTop:8}}>
              <label className="form-label">Oppure URL pianta predefinita (/avatars/nome.webp)</label>
              <input className="form-input" value={editing.avatar_url||""} onChange={e=>setEditing(p=>({...p,avatar_url:e.target.value}))} placeholder="/avatars/nomepianta.webp" style={{fontSize:13}}/>
            </div>
            <div style={{display:"flex",gap:8,marginTop:4}}>
              <button className="btn btn-primary" style={{flex:1}} onClick={saveEdits}>Salva</button>
              <button className="btn btn-danger btn-sm" onClick={async()=>{
                await sb.from("profiles").update({avatar_url:null}).eq("id",playerId);
                setSaveMsg("Avatar rimosso ✅"); setEditing(p=>({...p,avatar_url:""})); setTimeout(()=>setSaveMsg(""),2500);
              }}>🗑️ Reset</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Podium({ ranked, xpData, timeFilter, highlightId }) {
  // Funzione che restituisce la "tripla di confronto" per un giocatore
  // (XP, livello-derivato-da-XP, coin). Due giocatori condividono il podio
  // solo se hanno TUTTI E TRE i valori uguali.
  const tieKey = (p) => {
    const xp = timeFilter === "oggi" || timeFilter === "mese" ? (xpData[p.id]||0) : (p.xp||0);
    const lv = getLevel(p.xp||0).name;
    return `${xp}|${lv}|${p.coin||0}`;
  };

  // Raggruppa in posizioni: 1ª, 2ª, 3ª. Stesso gruppo = stessa tieKey.
  // Scorri ranked e crea gruppi consecutivi con stessa key
  if (!ranked || ranked.length === 0) return null;
  const groups = [];
  let current = { key: tieKey(ranked[0]), players: [ranked[0]] };
  for (let i = 1; i < ranked.length && groups.length < 3; i++) {
    const k = tieKey(ranked[i]);
    if (k === current.key) {
      current.players.push(ranked[i]);
    } else {
      groups.push(current);
      current = { key: k, players: [ranked[i]] };
    }
  }
  if (groups.length < 3) groups.push(current);
  const top3groups = groups.slice(0, 3);
  if (top3groups.length < 1) return null;

  // Render: 2°, 1°, 3° (layout podio classico)
  const order = [1, 0, 2];
  const cols = ["pod-2", "pod-1", "pod-3"];
  const crowns = [null, "👑", null];
  const xpColors = ["var(--argento)", "#FDEF26", "var(--bronzo)"];
  const sizes = [84, 110, 76];
  const ranks = ["🥈", "🥇", "🥉"];

  function renderGroup(group, i) {
    if (!group) return <div key={i} className={`pod-col ${cols[i]}`}/>;
    const players = group.players;
    // Se solo uno: render normale
    if (players.length === 1) {
      const p = players[0];
      const lv = getLevel(p.xp);
      const xpShown = timeFilter === "oggi" || timeFilter === "mese" ? xpData[p.id]||0 : p.xp;
      const isMe = p.id === highlightId;
      return (
        <div key={p.id} className={`pod-col ${cols[i]}`}>
          {crowns[i] && <span className="pod-crown">{crowns[i]}</span>}
          <div className="pod-av-wrap" style={{filter:"drop-shadow(0 5px 10px rgba(0,0,0,.35))"}}>
            <Avatar url={p.avatar_url} emoji={lv.emoji} size={sizes[i]}/>
          </div>
          <div className="pod-name">{p.display_name}{isMe&&<span style={{color:"var(--azzurro)",fontSize:9,display:"block"}}>TU</span>}</div>
          <div className="pod-xp">{xpShown} XP</div>
          <div className="pod-base">
            <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:xpColors[i]}}>{ranks[i]}</div>
          </div>
        </div>
      );
    }
    // Pari merito: avatar piccoli affiancati
    const xpShown = timeFilter === "oggi" || timeFilter === "mese" ? xpData[players[0].id]||0 : players[0].xp;
    const tieSize = Math.max(24, sizes[i] - 9 * Math.min(players.length - 1, 4));
    return (
      <div key={"tie-" + i} className={`pod-col ${cols[i]}`}>
        {crowns[i] && <span className="pod-crown">{crowns[i]}</span>}
        <div style={{display:"flex",width:"fit-content",maxWidth:"100%",margin:"0 auto 6px",alignItems:"flex-end",gap:0}}>
          {players.slice(0, 3).map(p => {
            const lv = getLevel(p.xp);
            const isMe = p.id === highlightId;
            return (
              <div key={p.id} className="pod-av-wrap" style={{marginLeft:-14, ...(isMe?{outline:"2px solid var(--neon-blue)",outlineOffset:1}:{})}}>
                <Avatar url={p.avatar_url} emoji={lv.emoji} size={tieSize}/>
              </div>
            );
          })}
        </div>
        <div className="pod-name" style={{fontSize:11}}>
          {players.length === 2 ? `${players[0].display_name} & ${players[1].display_name}` :
           `${players.length} a pari merito`}
        </div>
        <div className="pod-xp">{xpShown} XP</div>
        <div className="pod-base">
          <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:xpColors[i]}}>{ranks[i]}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="podium-wrap">
      {order.map((pos, i) => renderGroup(top3groups[pos], i))}
    </div>
  );
}

function LeaderboardView({ sectionColors, setSectionColors }) {
  const [players, setPlayers] = useState([]);
  const [squadFilter, setSquadFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState("generale"); // "generale" | "oggi" | "mese"
  const [squads, setSquads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [customizing, setCustomizing] = useState(false);
  const [xpToday, setXpToday] = useState({});
  const [xpMonth, setXpMonth] = useState({});

  const load = useCallback(async () => {
    const today = localToday();
    const monthStart = today.slice(0, 7) + "-01";
    const [{ data }, { data: sq }, { data: xpToday_hist }, { data: xpMonth_hist }] = await Promise.all([
      sb.from("profiles").select("id,display_name,avatar_url,xp,coin,squad_id,squads(name)").eq("role", "player").gt("xp", 2).order("xp", { ascending: false }).order("coin", { ascending: false }),
      sb.from("squads").select("*"),
      sb.from("xp_history").select("player_id, xp_gained").gte("created_at", today + "T00:00:00"),
      sb.from("xp_history").select("player_id, xp_gained").gte("created_at", monthStart + "T00:00:00"),
    ]);
    setPlayers(data || []); setSquads(sq || []);
    const td = {}; (xpToday_hist || []).forEach(a => { td[a.player_id] = (td[a.player_id] || 0) + (a.xp_gained || 0); });
    setXpToday(td);
    const mt = {}; (xpMonth_hist || []).forEach(a => { mt[a.player_id] = (mt[a.player_id] || 0) + (a.xp_gained || 0); });
    setXpMonth(mt);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();

    // Realtime: ogni volta che un giocatore guadagna XP (presenza, lab, manuale, badge…)
    // la classifica si aggiorna istantaneamente, senza ricaricare.
    const today = localToday();
    const monthStart = today.slice(0, 7) + "-01";

    const ch = sb.channel("leaderboard-realtime")
      // Nuove righe in xp_history → aggiorna xpToday e xpMonth
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "xp_history" }, (payload) => {
        const row = payload.new;
        if (!row || !row.created_at) return;
        if (row.created_at >= monthStart + "T00:00:00") {
          setXpMonth(prev => ({ ...prev, [row.player_id]: (prev[row.player_id] || 0) + (row.xp_gained || 0) }));
        }
        if (row.created_at >= today + "T00:00:00") {
          setXpToday(prev => ({ ...prev, [row.player_id]: (prev[row.player_id] || 0) + (row.xp_gained || 0) }));
        }
      })
      // Aggiornamenti dei profili (xp/coin totali) → aggiorna la classifica generale
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, (payload) => {
        const row = payload.new;
        if (!row) return;
        setPlayers(prev => {
          const idx = prev.findIndex(p => p.id === row.id);
          if (idx < 0) {
            // Nuovo giocatore appena salito sopra 2 XP: aggiungilo
            if (row.xp > 2 && row.role === "player") return [...prev, row].sort((a,b)=>(b.xp||0)-(a.xp||0));
            return prev;
          }
          const updated = [...prev];
          updated[idx] = { ...updated[idx], xp: row.xp, coin: row.coin, display_name: row.display_name, avatar_url: row.avatar_url, squad_id: row.squad_id };
          return updated;
        });
      })
      .subscribe();

    return () => { sb.removeChannel(ch); };
  }, [load]);

  let ranked = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
  if (timeFilter === "oggi") {
    ranked = [...ranked]
      .filter(p => (xpToday[p.id]||0) > 0)
      .sort((a, b) => {
        const xpA = xpToday[a.id]||0, xpB = xpToday[b.id]||0;
        if (xpA !== xpB) return xpB - xpA;
        return (b.coin || 0) - (a.coin || 0);
      })
      .slice(0, 3);
  } else if (timeFilter === "mese") {
    ranked = [...ranked]
      .filter(p => (xpMonth[p.id]||0) > 0)
      .sort((a, b) => {
        const xpA = xpMonth[a.id]||0, xpB = xpMonth[b.id]||0;
        if (xpA !== xpB) return xpB - xpA;
        return (b.coin || 0) - (a.coin || 0);
      })
      .slice(0, 10);
  }

  return (
    <div>
      <SectionBanner sectionKey="classifica" title="🏆 Classifica" sub={`${ranked.length} giocatori`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div className="filter-bar" style={{ marginBottom: 8 }}>
        <button className={`chip ${timeFilter === "generale" ? "active" : ""}`} onClick={() => setTimeFilter("generale")}>🏆 Generale</button>
        <button className={`chip ${timeFilter === "oggi" ? "active" : ""}`} style={{ borderColor: timeFilter === "oggi" ? "var(--giallo)" : undefined, background: timeFilter === "oggi" ? "var(--giallo)" : undefined, color: timeFilter === "oggi" ? "#101010" : undefined }} onClick={() => setTimeFilter("oggi")}>⚡ Top 3 Oggi</button>
        <button className={`chip ${timeFilter === "mese" ? "active" : ""}`} style={{ borderColor: timeFilter === "mese" ? "var(--rosa)" : undefined, background: timeFilter === "mese" ? "var(--rosa)" : undefined, color: timeFilter === "mese" ? "#101010" : undefined }} onClick={() => setTimeFilter("mese")}>📅 Top 10 Mese</button>
      </div>
      <div className="filter-bar">
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>)}
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <>
          <Podium ranked={ranked} xpData={timeFilter==="oggi"?xpToday:timeFilter==="mese"?xpMonth:{}} timeFilter={timeFilter} highlightId={null}/>
          <div className="lb-list">
            {ranked.slice(ranked.length>=3?3:0).map((p, i) => {
              const lv = getLevel(p.xp);
              const realIdx = (ranked.length>=3?3:0)+i;
              const xpShown = timeFilter === "oggi" ? xpToday[p.id] || 0 : timeFilter === "mese" ? xpMonth[p.id] || 0 : p.xp;
              const xpLabel = timeFilter === "oggi" ? "XP oggi" : timeFilter === "mese" ? "XP mese" : "XP";
              return (
                <div key={p.id} className="lb-row" style={{animation:`slideInRow .3s ${Math.min(i*.06,.5)}s both`}}>
                  <span className="lb-rank">{(realIdx+1)+"°"}</span>
                  <div className="lb-av"><Avatar url={p.avatar_url} emoji={lv.emoji} size={38} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="lb-name">{p.display_name}</div>
                    <div className="lb-level">{lv.emoji} {lv.name} {p.squads?.name && <SquadPill name={p.squads.name} />}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span className="lb-xp">{xpShown}</span>
                    <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>{xpLabel}</div>
                  </div>
                </div>
              );
            })}
            {ranked.length === 0 && <div className="empty">Nessun dato disponibile.</div>}
          </div>
        </>
      )}
      {customizing && <BannerCustomizer sectionKey="classifica" sectionColors={sectionColors} setSectionColors={setSectionColors} onClose={() => setCustomizing(false)} />}
    </div>
  );
}

function SquadsView() {
  const [squads, setSquads] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newSquad, setNewSquad] = useState({ name: "", color: "#A3CFFE" });
  const COLORS = [BRAND.azzurro, BRAND.rosa, BRAND.giallo, BRAND.verde, BRAND.rosso];

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: sq }, { data: pl }] = await Promise.all([
      sb.from("squads").select("*").order("name"),
      sb.from("profiles").select("id,squad_id").eq("role","player"),
    ]);
    setSquads(sq || []); setPlayers(pl || []); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createSquad() {
    if (!newSquad.name.trim()) return;
    await sb.from("squads").insert(newSquad);
    setShowForm(false); setNewSquad({ name: "", color: "#A3CFFE" }); load();
  }

  async function deleteSquad(id) {
    if (!confirm("Eliminare questa squadra?")) return;
    await sb.from("squads").delete().eq("id", id); load();
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-yellow btn-sm" onClick={() => setShowForm(true)}>+ Nuova squadra</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div className="squad-list">
          {squads.map(s => (
            <div key={s.id} className="squad-row">
              <div className="squad-color-dot" style={{ background: s.color || "#A3CFFE" }} />
              <span className="squad-name">{s.name}</span>
              <span className="squad-count" style={{ fontSize: 12, color: "var(--text3)" }}>{players.filter(p => p.squad_id === s.id).length} giocatori</span>
              <button className="btn btn-danger btn-sm" onClick={() => deleteSquad(s.id)}>Elimina</button>
            </div>
          ))}
          {squads.length === 0 && <div className="empty">Nessuna squadra.</div>}
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Nuova squadra</div>
            <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={newSquad.name} onChange={e => setNewSquad(f => ({ ...f, name: e.target.value }))} placeholder="es. Rossa" /></div>
            <div className="form-group">
              <label className="form-label">Colore</label>
              <div className="color-swatch-row">
                {COLORS.map(c => <div key={c} className={`color-swatch ${newSquad.color === c ? "active" : ""}`} style={{ background: c }} onClick={() => setNewSquad(f => ({ ...f, color: c }))} />)}
                <input type="color" value={newSquad.color} onChange={e => setNewSquad(f => ({ ...f, color: e.target.value }))} style={{ width: 36, height: 36, border: "none", borderRadius: "50%", cursor: "pointer", padding: 0 }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createSquad} disabled={!newSquad.name.trim()}>Crea</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AttendanceView({ sectionColors, setSectionColors }) {
  const [players, setPlayers]     = useState([]);
  const [squads, setSquads]       = useState([]);
  const [attendances, setAttendances] = useState({});
  const [labAtts, setLabAtts]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [date, setDate]           = useState(localToday());
  const [config, setConfig]       = useState({ xp_daily_checkin:10, coin_daily_checkin:5, xp_week_bonus:5 });
  const [customizing, setCustomizing] = useState(false);
  const [search, setSearch]       = useState("");
  const [sortBy, setSortBy]       = useState("name");
  const [squadFilter, setSquadFilter] = useState("all");
  const [presTab, setPresTab]     = useState("daily");
  const [err, setErr]             = useState(null);
  const [editConfig, setEditConfig] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true); setErr(null);
      try {
        // Load players and squads
        const [{ data: pl, error: plErr }, { data: sq }] = await Promise.all([
          sb.from("profiles").select("id,display_name,first_name,avatar_url,xp,coin,squad_id,squads(name)").eq("role","player").order("display_name"),
          sb.from("squads").select("*"),
        ]);
        if (plErr) throw plErr;
        setPlayers(pl || []); setSquads(sq || []);

        // Load all attendances for date
        const { data: att } = await sb.from("attendances")
          .select("id,player_id,activity_id,check_type,status,xp_awarded,coin_awarded,created_at")
          .eq("date", date);

        // Split daily vs lab
        const daily = (att||[]).filter(a => !a.check_type || a.check_type === "daily");
        const labRaw = (att||[]).filter(a => a.check_type === "lab");
        const map = {}; daily.forEach(a => { map[a.player_id] = a; });
        setAttendances(map);

        // Enrich lab with player + activity names
        const playerMap = Object.fromEntries((pl||[]).map(p => [p.id, p]));
        const actIds = [...new Set(labRaw.map(a => a.activity_id).filter(Boolean))];
        let actMap = {};
        if (actIds.length) {
          const { data: acts } = await sb.from("activities").select("id,name").in("id", actIds);
          actMap = Object.fromEntries((acts||[]).map(a => [a.id, a.name]));
        }
        setLabAtts(labRaw.map(a => ({
          ...a,
          playerName: playerMap[a.player_id]?.display_name || "—",
          actName: actMap[a.activity_id] || "Lab",
          avatar_url: playerMap[a.player_id]?.avatar_url || null,
          lv: getLevel(playerMap[a.player_id]?.xp || 0),
        })));

        // Config: carica da profiles.app_config (sistema) — più affidabile di una tabella dedicata
        const { data: sysProfile } = await sb.from("profiles").select("app_config")
          .eq("id", "00000000-0000-0000-0000-000000000099").maybeSingle();
        const labMult = sysProfile?.app_config?.lab_multiplier;
        const stored = sysProfile?.app_config?.attendance_config;
        if (stored) {
          setConfig({
            lab_multiplier: labMult ?? 2,
            xp_daily_checkin: stored.xp_daily_checkin ?? 10,
            coin_daily_checkin: stored.coin_daily_checkin ?? 5,
            xp_week_bonus: stored.xp_week_bonus ?? 5,
            min_days: stored.min_days ?? 10,
            xp_reward: stored.xp_reward ?? 50,
            coin_reward: stored.coin_reward ?? 25,
            badge_name: stored.badge_name ?? "Badge mese",
          });
        }
      } catch(e) {
        setErr("Errore caricamento: " + (e?.message || String(e)));
      }
      setLoading(false);
    }
    load();
  }, [date]);

  const visible = players
    .filter(p => {
      const matchSquad = squadFilter === "all" || p.squads?.name === squadFilter;
      const matchSearch = !search || (p.display_name||"").toLowerCase().includes(search.toLowerCase()) || (p.first_name||"").toLowerCase().includes(search.toLowerCase());
      return matchSquad && matchSearch;
    })
    .sort((a,b) => {
      if (sortBy === "xp")    return (b.xp||0) - (a.xp||0);
      if (sortBy === "squad") return (a.squads?.name||"").localeCompare(b.squads?.name||"");
      return (a.display_name||"").localeCompare(b.display_name||"");
    });

  const presentCount = Object.values(attendances).filter(a => a.status !== "none").length;

  async function setStatus(playerId, status) {
    const today = date;
    const xp = status === "full" ? (config.xp_daily_checkin||10) : status === "completed" ? (config.xp_daily_checkin||10) + 5 : status === "partial" ? Math.round((config.xp_daily_checkin||10)/2) : 0;
    const coin = status === "full" ? (config.coin_daily_checkin||5) : status === "completed" ? (config.coin_daily_checkin||5) : status === "partial" ? Math.round((config.coin_daily_checkin||5)/2) : 0;
    const existing = attendances[playerId];
    // XP/coin già assegnati in precedenza (per non sommarli due volte)
    const prevXp = existing?.xp_awarded || 0;
    const prevCoin = existing?.coin_awarded || 0;

    if (existing) {
      await sb.from("attendances").update({ status, xp_awarded:xp, coin_awarded:coin }).eq("id", existing.id);
    } else {
      await sb.from("attendances").insert({ player_id:playerId, date:today, status, xp_awarded:xp, coin_awarded:coin, check_type:"daily" });
    }

    // Aggiorna il profilo: togli i punti vecchi, aggiungi quelli nuovi (delta)
    const deltaXp = xp - prevXp;
    const deltaCoin = coin - prevCoin;
    if (deltaXp !== 0 || deltaCoin !== 0) {
      const p = players.find(pl => pl.id === playerId);
      if (p) {
        const newXp = Math.max(0, (p.xp || 0) + deltaXp);
        const newCoin = Math.max(0, (p.coin || 0) + deltaCoin);
        await sb.from("profiles").update({ xp: newXp, coin: newCoin }).eq("id", playerId);
        // Traccia per classifica oggi/mese
        if (deltaXp !== 0) {
          await logXPGain(playerId, deltaXp, newXp, "presenza");
        }
        setPlayers(prev => prev.map(pl => pl.id === playerId ? { ...pl, xp: newXp, coin: newCoin } : pl));
        // Push solo se ha guadagnato qualcosa
        if (deltaXp > 0) sendPush(playerId, "✅ Presenza registrata!", `+${deltaXp} XP${deltaCoin>0?` e +${deltaCoin} Coin`:""}`).catch(()=>{});
      }
    }
    setAttendances(prev => ({ ...prev, [playerId]: { ...(existing||{}), player_id:playerId, status, xp_awarded:xp, coin_awarded:coin } }));
  }

  return (
    <div>
      <SectionBanner sectionKey="presenze" title="✅ Presenze"
        sub={presTab==="daily" ? `${presentCount}/${visible.length} presenti` : `${labAtts.length} check-in Lab`}
        sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />

      {/* Tab switcher */}
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <button className={`chip ${presTab==="daily"?"active":""}`} onClick={()=>setPresTab("daily")}
          style={presTab==="daily"?{background:"var(--surface3)",color:"var(--neon-blue)",borderColor:"#A3CFFE"}:{}}>
          📍 Giornaliere
        </button>
        <button className={`chip ${presTab==="lab"?"active":""}`} onClick={()=>setPresTab("lab")}
          style={presTab==="lab"?{background:"var(--surface3)",color:"#FDEF26",borderColor:"#FDEF26"}:{}}>
          ⚡ Lab {labAtts.length>0 && <span style={{background:"#FDEF26",color:"#111",borderRadius:99,fontSize:8,fontWeight:900,padding:"1px 5px",marginLeft:4}}>{labAtts.length}</span>}
        </button>
      </div>

      {/* Date picker */}
      <div className="filter-bar">
        <input type="date" value={date} onChange={e=>setDate(e.target.value)}
          style={{padding:10,background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:10,color:"var(--text)",fontSize:14,flex:1}}/>
        {presTab==="daily" && <button className="btn btn-yellow btn-sm" onClick={async()=>{ for(const p of visible) await setStatus(p.id,"full"); }}>✓ Tutti</button>}
      </div>

      {err && <div style={{color:"var(--danger)",padding:"10px",background:"rgba(255,34,68,.08)",borderRadius:10,marginBottom:10,fontSize:13}}>{err}</div>}

      {/* ── DAILY TAB ── */}
      {presTab==="daily" && (
        <div>
          <div className="stats-grid">
            <div className="stat-card"><div className="stat-label">Presenti</div><div className="stat-value">{presentCount}</div></div>
            <div className="stat-card"><div className="stat-label">Totale</div><div className="stat-value">{visible.length}</div></div>
            <div className="stat-card" style={{cursor:"pointer"}} onClick={()=>setEditConfig(c=>!c)}>
              <div className="stat-label">XP pres. ✏️</div>
              <div className="stat-value">{config.xp_daily_checkin||10}</div>
            </div>
            <div className="stat-card" style={{cursor:"pointer"}} onClick={()=>setEditConfig(c=>!c)}>
              <div className="stat-label">Coin ✏️</div>
              <div className="stat-value">{config.coin_daily_checkin||5}</div>
            </div>
          </div>
          {editConfig && (
            <div style={{background:"var(--surface2)",border:"2px solid var(--border2)",borderRadius:12,padding:"12px 14px",marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:700,color:"#FDEF26",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>⚙️ Valore presenza oggi</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
                <div>
                  <label style={{fontSize:10,color:"var(--text3)",fontWeight:700,textTransform:"uppercase",display:"block",marginBottom:4}}>XP presenza</label>
                  <input type="number" value={config.xp_daily_checkin ?? 10}
                    onChange={e=>setConfig(c=>({...c,xp_daily_checkin:Number(e.target.value)}))}
                    style={{width:"100%",padding:"8px 10px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:8,color:"var(--text)",fontSize:16,fontWeight:900,textAlign:"center"}}/>
                </div>
                <div>
                  <label style={{fontSize:10,color:"var(--text3)",fontWeight:700,textTransform:"uppercase",display:"block",marginBottom:4}}>Coin presenza</label>
                  <input type="number" value={config.coin_daily_checkin ?? 5}
                    onChange={e=>setConfig(c=>({...c,coin_daily_checkin:Number(e.target.value)}))}
                    style={{width:"100%",padding:"8px 10px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:8,color:"var(--text)",fontSize:16,fontWeight:900,textAlign:"center"}}/>
                </div>
                <div>
                  <label style={{fontSize:10,color:"var(--text3)",fontWeight:700,textTransform:"uppercase",display:"block",marginBottom:4}}>XP bonus settimana</label>
                  <input type="number" value={config.xp_week_bonus ?? 5}
                    onChange={e=>setConfig(c=>({...c,xp_week_bonus:Number(e.target.value)}))}
                    style={{width:"100%",padding:"8px 10px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:8,color:"var(--text)",fontSize:16,fontWeight:900,textAlign:"center"}}/>
                </div>
              </div>
              <button className="btn btn-yellow btn-sm" style={{width:"100%"}} onClick={async()=>{
                const payload = {
                  xp_daily_checkin: Number(config.xp_daily_checkin ?? 10),
                  coin_daily_checkin: Number(config.coin_daily_checkin ?? 5),
                  xp_week_bonus: Number(config.xp_week_bonus ?? 5),
                  min_days: Number(config.min_days ?? 10),
                  xp_reward: Number(config.xp_reward ?? 50),
                  coin_reward: Number(config.coin_reward ?? 25),
                  badge_name: config.badge_name ?? "Badge mese",
                };
                // Leggi app_config esistente (per non sovrascrivere altre impostazioni)
                const { data: existing } = await sb.from("profiles").select("app_config")
                  .eq("id", "00000000-0000-0000-0000-000000000099").maybeSingle();
                const newAppConfig = { ...(existing?.app_config || {}), attendance_config: payload };
                const { error } = await sb.from("profiles").update({ app_config: newAppConfig })
                  .eq("id", "00000000-0000-0000-0000-000000000099");
                if (error) {
                  if (typeof addToast === "function") addToast("❌ " + error.message, "error");
                  return;
                }
                setConfig(prev => ({ ...prev, ...payload }));
                setEditConfig(false);
                if (typeof addToast === "function") addToast("✅ Configurazione salvata per tutti", "ok");
              }}>💾 Salva configurazione</button>
              <div style={{fontSize:10,color:"var(--text3)",marginTop:6}}>Le nuove presenze di oggi useranno questi valori. Le presenze già segnate non cambiano.</div>
            </div>
          )}
          <div className="filter-bar">
            <input className="search-inp" placeholder="🔍 Cerca nome…" value={search} onChange={e=>setSearch(e.target.value)} style={{flex:1}}/>
            <select value={sortBy} onChange={e=>setSortBy(e.target.value)}
              style={{padding:"8px 10px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:10,color:"var(--text)",fontSize:13}}>
              <option value="name">A→Z</option>
              <option value="xp">XP ↓</option>
              <option value="squad">Squadra</option>
            </select>
          </div>
          <div className="filter-bar">
            <button className={`chip ${squadFilter==="all"?"active":""}`} onClick={()=>setSquadFilter("all")}>Tutti</button>
            {squads.map(s=><button key={s.id} className={`chip ${squadFilter===s.name?"active":""}`} onClick={()=>setSquadFilter(s.name)}>{s.name}</button>)}
          </div>
          {loading ? <div className="loading">⏳ Caricamento…</div> : (
            <div className="pres-wrap">
              <table className="pres-table">
                <thead><tr><th>Giocatore</th><th>Squadra</th><th>Stato</th><th>XP</th></tr></thead>
                <tbody>
                  {visible.map(p => {
                    const lv = getLevel(p.xp);
                    const status = attendances[p.id]?.status || "none";
                    return (
                      <tr key={p.id}>
                        <td><div style={{display:"flex",alignItems:"center",gap:8}}><Avatar url={p.avatar_url} emoji={lv.emoji} size={28}/><span style={{fontWeight:600}}>{p.display_name}</span></div></td>
                        <td>{p.squads?.name && <SquadPill name={p.squads.name}/>}</td>
                        <td>
                          <button
                            className={`pres-toggle ${status!=="none"?"done":"empty"}`}
                            onClick={()=>setStatus(p.id, status!=="none"?"none":"full")}>
                            {status!=="none" ? "✓" : "○"}
                          </button>
                        </td>
                        <td style={{fontFamily:"'Funnel Display'",fontSize:16,fontWeight:900,color:"var(--neon-blue)"}}>{p.xp} <span style={{fontSize:10,color:"var(--text3)",fontWeight:400}}>XP</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── LAB TAB ── */}
      {presTab==="lab" && (
        <div>
          <div style={{marginBottom:10,fontSize:12,color:"var(--text3)"}}>Check-in Lab via QR — {date}</div>
          {loading ? <div className="loading">⏳</div> : labAtts.length===0 ? (
            <div className="empty">Nessun check-in Lab per oggi.</div>
          ) : (
            Object.entries(labAtts.reduce((acc,a)=>{ (acc[a.actName]=acc[a.actName]||[]).push(a); return acc; },{})).map(([labName,entries])=>(
              <div key={labName} style={{marginBottom:14,background:"var(--surface2)",border:"2px solid var(--border2)",borderRadius:14,padding:"12px 14px"}}>
                <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:"#FDEF26",marginBottom:8}}>
                  ⚡ {labName} <span style={{fontSize:13,color:"var(--text3)",fontWeight:400}}>· {entries.length} check-in</span>
                </div>
                {entries.map(a=>(
                  <div key={a.id} style={{display:"flex",gap:10,alignItems:"center",padding:"7px 0",borderBottom:"1px solid rgba(255,255,255,.05)"}}>
                    <div style={{width:30,height:30,borderRadius:"50%",overflow:"hidden",border:"1.5px solid rgba(253,239,38,.4)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <Avatar url={a.avatar_url} emoji={a.lv?.emoji} size={30}/>
                    </div>
                    <div style={{flex:1,fontSize:13,fontWeight:600,color:"var(--text)"}}>{a.playerName}</div>
                    <div style={{fontSize:11,color:"var(--neon-blue)",fontWeight:700}}>+{a.xp_awarded||0} XP</div>
                    <div style={{fontSize:10,color:"var(--text3)"}}>{new Date(a.created_at).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"})}</div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}

      {customizing && <BannerCustomizer sectionKey="presenze" sectionColors={sectionColors} setSectionColors={setSectionColors} onClose={()=>setCustomizing(false)}/>}
    </div>
  );
}

function LabQRButton({ actId, actName }) {
  const [code, setCode] = useState(null);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  async function generate() {
    setLoading(true);
    const today = localToday();
    // Check if exists
    // Generazione lato server (gli educatori non scrivono più direttamente su lab_qr)
    const { data: res, error } = await sb.rpc("generate_lab_qr", { p_activity_id: actId });
    if (error || !res?.code) { addToast("❌ Errore generazione QR: " + (error?.message || ""), "error"); setLoading(false); return; }
    setCode(res.code); setShow(true); setLoading(false);
  }

  return (
    <div style={{marginTop:8}}>
      <button className="btn btn-ghost btn-xs" onClick={show ? ()=>setShow(false) : generate} style={{fontSize:11,width:"100%"}}>
        {loading ? "⏳ Generazione…" : show ? "▲ Nascondi QR Lab" : "📍 Genera / Mostra QR Lab oggi"}
      </button>
      {show && code && (
        <div style={{marginTop:8,background:"rgba(0,0,0,.5)",borderRadius:12,padding:12,textAlign:"center",border:"1px solid rgba(163,207,254,.2)"}}>
          <div style={{fontSize:10,color:"var(--text3)",marginBottom:6,textTransform:"uppercase",letterSpacing:".08em"}}>QR Lab · {actName} · {new Date().toLocaleDateString("it-IT")}</div>
          <img src={`https://api.qrserver.com/v1/create-qr-code/?data=${code}&size=180x180&bgcolor=ffffff&color=000000&qzone=1`} alt={code} style={{width:180,height:180,borderRadius:8,display:"block",margin:"0 auto 8px"}}/>
          <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,color:"var(--neon-blue)",letterSpacing:8,cursor:"pointer"}}
            onClick={()=>navigator.clipboard?.writeText(code).then(()=>addToast("📋 Codice copiato!","ok")).catch(()=>{})}
            title="Tocca per copiare"
          >{code}</div>
          <div style={{fontSize:10,color:"var(--text3)",marginTop:-4}}>Tocca per copiare</div>
          <div style={{fontSize:10,color:"rgba(255,255,255,.4)",marginTop:4}}>Valido solo oggi — codice diverso dal check-in giornaliero</div>
        </div>
      )}
    </div>
  );
}

function ActivitiesView({ sectionColors, setSectionColors }) {
  const [activities, setActivities] = useState([]);
  const [educators, setEducators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [bookingCounts, setBookingCounts] = useState({});
  const [players, setPlayers] = useState([]);
  const [selectedPlayers, setSelectedPlayers] = useState(new Set());
  const [addPlayersTo, setAddPlayersTo] = useState(null); // lab a cui aggiungere player
  const [playerSearch, setPlayerSearch] = useState("");
  const [form, setForm] = useState({ name: "", description: "", link: "", educator_id: "", duration_days: 6, xp_partial: 10, xp_full: 20, xp_completed: 35, coin_partial: 5, coin_full: 10, coin_completed: 18, coin_cost: 0, max_participants: "", lab_multiplier: 2 });
  const [editingId, setEditingId] = useState(null);
  const [origAppointments, setOrigAppointments] = useState(null);

  const load = useCallback(async () => {
    const [{ data }, { data: edu }, { data: pls }] = await Promise.all([
      sb.from("activities").select("id,name,description,link,schedule,duration_days,xp_partial,xp_full,xp_completed,coin_partial,coin_full,coin_completed,coin_cost,is_active,expires_at,max_participants,educator_id,image_data").eq("is_active", true).order("created_at", { ascending: false }),
      sb.from("profiles").select("id,display_name").eq("role","educator").order("display_name"),
      sb.from("profiles").select("id,display_name,first_name,avatar_url,squad_id,squads(name)").eq("role","player").order("display_name"),
    ]);
    const acts = (data || []).filter(a => !(a.description || "").startsWith("SFIDA"));
    setPlayers(pls || []); setActivities(acts); setEducators(edu || []);

    if (acts.length > 0) {
      const { data: bk } = await sb.from("bookings")
        .select("activity_id,status")
        .in("activity_id", acts.map(a => a.id))
        .in("status", ["confirmed","pending"]);
      const counts = {};
      (bk || []).forEach(b => { counts[b.activity_id] = (counts[b.activity_id] || 0) + 1; });
      setBookingCounts(counts);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const [createErr, setCreateErr] = useState("");


  async function enrollPlayers(actId, playerIds, actName) {
    if (!playerIds.length) return;
    // Crea bookings confermati per i player scelti (salta i già iscritti)
    const { data: existing } = await sb.from("bookings").select("player_id").eq("activity_id", actId).in("status",["pending","confirmed"]);
    const already = new Set((existing||[]).map(b => b.player_id));
    const toAdd = playerIds.filter(pid => !already.has(pid));
    if (!toAdd.length) { addToast("Già tutti iscritti", "ok"); return; }
    const rows = toAdd.map(pid => ({ player_id: pid, activity_id: actId, status: "confirmed", coin_held: 0 }));
    const { error } = await sb.from("bookings").insert(rows);
    if (error) { addToast("❌ " + error.message, "error"); return; }
    // Notifica i player aggiunti
    toAdd.forEach(pid => {
      sb.from("notifications").insert({ user_id: pid, type: "booking_confirmed", title: "⚡ Iscritto a un Lab", body: `Sei stato iscritto a "${actName||"un Lab"}"` }).then(()=>{});
      sendPush(pid, "⚡ Iscritto a un Lab", `Sei stato iscritto a "${actName||"un Lab"}"`).catch(()=>{});
    });
    addToast(`✅ ${toAdd.length} giocatori iscritti`, "ok");
  }

  function openEdit(a) {
    setEditingId(a.id);
    setOrigAppointments(a.duration_days || 1);
    setForm({
      name: a.name || "", description: a.description || "", link: a.link || "",
      educator_id: a.educator_id || "", schedule: a.schedule || "",
      duration_days: a.duration_days || 1,
      xp_partial: a.xp_partial ?? 10, xp_full: a.xp_full ?? 20, xp_completed: a.xp_completed ?? 35,
      coin_partial: a.coin_partial ?? 5, coin_full: a.coin_full ?? 10, coin_completed: a.coin_completed ?? 18,
      coin_cost: a.coin_cost ?? 0, max_participants: a.max_participants ?? "",
      lab_multiplier: a.lab_multiplier ?? 2, image_data: a.image_data || null,
    });
    setSelectedPlayers(new Set());
    setCreateErr("");
    setShowForm(true);
  }

  async function saveEdit() {
    const name = (form.name || "").trim();
    if (!name) { setCreateErr("Nome obbligatorio"); return; }
    if (Number(form.duration_days) !== Number(origAppointments)) {
      if (!confirm(`Stai cambiando gli appuntamenti da ${origAppointments} a ${form.duration_days}.\n\nLe presenze già registrate restano invariate; la modifica vale solo da ora. Chi avrà segnato tutti gli appuntamenti riceverà il bonus completamento.\n\nConfermi?`)) return;
    }
    setCreateErr("Salvataggio…");
    const { error } = await sb.from("activities").update({
      name,
      description: (form.description || "").trim() || null,
      schedule: (form.schedule || "").trim() || null,
      duration_days: Number(form.duration_days) || 1,
      lab_multiplier: Number(form.lab_multiplier) || 2,
      xp_partial: Number(form.xp_partial) || 0,
      coin_partial: Number(form.coin_partial) || 0,
      coin_cost: Number(form.coin_cost) || 0,
      max_participants: form.max_participants ? Number(form.max_participants) : null,
      educator_id: form.educator_id || null,
      link: (form.link || "").trim() || null,
      image_data: form.image_data || null,
    }).eq("id", editingId);
    if (error) { setCreateErr("❌ " + error.message); return; }
    setCreateErr(""); setShowForm(false); setEditingId(null); setOrigAppointments(null);
    load();
    addToast("✅ Lab aggiornato", "ok");
  }

  async function createActivity() {
    const name = (form.name || "").trim();
    if (!name) { setCreateErr("Nome obbligatorio"); return; }
    setCreateErr("Creazione in corso…");
    try {
      const { error } = await sb.from("activities").insert({
        name,
        description: (form.description || "").trim() || null,
        schedule: (form.schedule || "").trim() || null,
        duration_days: Number(form.duration_days) || 1,
        lab_multiplier: Number(form.lab_multiplier) || 2,
        xp_partial:    Number(form.xp_partial)    || 0,
        xp_full:       Number(form.xp_full)       || 0,
        xp_completed:  Number(form.xp_completed)  || 0,
        coin_partial:  Number(form.coin_partial)  || 0,
        coin_full:     Number(form.coin_full)     || 0,
        coin_completed:Number(form.coin_completed)|| 0,
        coin_cost:     Number(form.coin_cost)     || 0,
        max_participants: form.max_participants ? Number(form.max_participants) : null,
        educator_id: form.educator_id || null,
        link: (form.link || "").trim() || null,
        image_data: form.image_data || null,
        is_active: true,
      });
      if (error) {
        setCreateErr("❌ " + error.message + " [" + error.code + "]");
        return;
      }
      setCreateErr("");
      setShowForm(false);
      setForm({ name:"", description:"", link:"", educator_id:"",
        duration_days:6, xp_partial:10, xp_full:20, xp_completed:35,
        coin_partial:5, coin_full:10, coin_completed:18, coin_cost:0, max_participants:"", lab_multiplier:2, image_data:null });
      // Notifica tutti i giocatori del nuovo lab
      sb.from("profiles").select("id").eq("role","player").then(({data})=>{
        (data||[]).forEach(p => sendPush(p.id, "⚡ Nuovo Lab disponibile!", `"${name}" è ora disponibile — prenota ora!`).catch(()=>{}));
      });
      // Iscrivi i player selezionati durante la creazione
      if (selectedPlayers.size > 0) {
        const { data: newAct } = await sb.from("activities").select("id").eq("name", name).order("created_at",{ascending:false}).limit(1);
        const actId = newAct && newAct[0]?.id;
        if (actId) await enrollPlayers(actId, [...selectedPlayers], name);
        setSelectedPlayers(new Set());
      }
      load();
    } catch(e) {
      setCreateErr("❌ Eccezione: " + (e?.message || String(e)));
    }
  }

  async function deleteActivity(id) {
    if (!confirm("Eliminare il lab? Le prenotazioni verranno annullate e le coin rimborsate.")) return;
    // Rimborsa coin per prenotazioni pending/confirmed
    const { data: bks } = await sb.from("bookings").select("player_id,coin_held,status").eq("activity_id",id).in("status",["pending","confirmed"]);
    // Prima pulisce le vecchie notifiche booking (una query), POI rimborsa
    // e notifica — così la notifica di rimborso non viene cancellata.
    const playerIdsToClean = [...new Set((bks||[]).map(b=>b.player_id).filter(Boolean))];
    if (playerIdsToClean.length) {
      await sb.from("notifications").delete().in("user_id", playerIdsToClean).in("type",["booking_confirmed","booking_rejected"]);
    }
    // Rimborsi aggregati per giocatore, atomici lato server
    const refunds = {};
    for (const b of (bks||[])) {
      if ((b.coin_held||0) > 0 && b.player_id) refunds[b.player_id] = (refunds[b.player_id]||0) + b.coin_held;
    }
    await Promise.all(Object.entries(refunds).map(([pid, amount]) =>
      sb.rpc("award_xp", { p_player_id: pid, p_xp: 0, p_coin: amount, p_reason: "rimborso", p_log_title: null })
    ));
    if (Object.keys(refunds).length) {
      await sb.from("notifications").insert(Object.keys(refunds).map(pid =>
        ({ user_id: pid, type: "booking_rejected", title: "Lab cancellato", body: "Le tue coin sono state rimborsate." })
      ));
    }
    // Cancella prenotazioni
    await sb.from("bookings").delete().eq("activity_id", id);
    // Disattiva lab
    await sb.from("activities").update({ is_active: false }).eq("id", id);
    setActivities(prev => prev.filter(a => a.id !== id));
  }

  return (
    <div>
      <SectionBanner sectionKey="attivita" title="⚡ Lab" sub={`${activities.length} attive`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-yellow btn-sm" onClick={() => { setEditingId(null); setShowForm(true); }}>+ Nuovo Lab</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div className="act-grid">
          {activities.map(a => (
            <div key={a.id} className="act-card">
              <button className="delete-btn" onClick={() => deleteActivity(a.id)}>✕</button>
              <div className="act-title">{a.name}</div>
              {a.image_data && <img src={a.image_data} className="act-img" alt=""/>}
              <div className="act-meta">{a.description}{a.duration_days ? ` · ${a.duration_days}g` : ""}</div>
              {a.schedule && <div style={{fontSize:11,color:"#FDEF26",fontWeight:700,marginBottom:4}}>📅 {a.schedule}</div>}
              {a.educator_id && <div style={{ fontSize: 11, color: "var(--verde)", fontWeight: 700, marginBottom: 6 }}>🌱 Lab assegnato</div>}
              <LabQRButton actId={a.id} actName={a.name}/>
              <button className="btn btn-ghost btn-xs" style={{width:"100%",marginTop:6,color:"#FDEF26"}}
                onClick={()=>openEdit(a)}>
                ✏️ Modifica Lab
              </button>
              <button className="btn btn-ghost btn-xs" style={{width:"100%",marginTop:6,marginBottom:6,color:"var(--neon-blue)"}}
                onClick={()=>{ setAddPlayersTo(a); setSelectedPlayers(new Set()); setPlayerSearch(""); }}>
                ➕ Aggiungi giocatori
              </button>
              {a.link && (
                <a href={a.link} target="_blank" rel="noreferrer"
                  style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, color:"var(--azzurro)", fontWeight:700, textDecoration:"none", background:"rgba(163,207,254,.06)", border:"1px solid rgba(163,207,254,.18)", borderRadius:8, padding:"4px 10px", marginBottom:8 }}>
                  🔗 Link / file allegato
                </a>
              )}
              <div className="act-rewards" style={{flexWrap:"wrap",gap:6}}>
                <span className="reward-tag xp-tag">Max {a.xp_completed} XP</span>
                <span className="reward-tag coin-tag">🪙 {a.coin_cost}</span>
                {a.max_participants && (
                  <span className="reward-tag" style={{
                    background: (bookingCounts[a.id]||0) >= a.max_participants ? "rgba(255,34,68,.12)" : "rgba(51,153,102,.08)",
                    color: (bookingCounts[a.id]||0) >= a.max_participants ? "var(--rosso)" : "var(--neon-green)",
                    border: `1px solid ${(bookingCounts[a.id]||0) >= a.max_participants ? "rgba(255,34,68,.25)" : "rgba(51,153,102,.2)"}`,
                  }}>
                    👥 {bookingCounts[a.id]||0}/{a.max_participants} iscritti
                    {(bookingCounts[a.id]||0) >= a.max_participants ? " · PIENO" : ` · ${a.max_participants-(bookingCounts[a.id]||0)} posti`}
                  </span>
                )}
              </div>
            </div>
          ))}
          {activities.length === 0 && <div className="empty">Nessuna lab.</div>}
        </div>
      )}
      {/* Modale: aggiungi giocatori a un Lab esistente */}
      {addPlayersTo && (
        <div className="modal-bg" onClick={()=>setAddPlayersTo(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-title">➕ Aggiungi giocatori</div>
            <div style={{fontSize:13,color:"var(--text2)",marginBottom:12,textAlign:"center"}}>
              a <strong style={{color:"var(--text)"}}>{addPlayersTo.name}</strong>
            </div>
            <input className="form-input" placeholder="🔍 Cerca giocatore…" value={playerSearch}
              onChange={e=>setPlayerSearch(e.target.value)} style={{marginBottom:8}}/>
            <div style={{maxHeight:200,overflowY:"auto",border:"1px solid var(--border)",borderRadius:10,padding:6,marginBottom:12}}>
              {players.filter(p => !playerSearch || p.display_name.toLowerCase().includes(playerSearch.toLowerCase()) || (p.first_name||"").toLowerCase().includes(playerSearch.toLowerCase())).map(p => {
                const sel = selectedPlayers.has(p.id);
                return (
                  <div key={p.id} onClick={()=>setSelectedPlayers(prev=>{const n=new Set(prev); n.has(p.id)?n.delete(p.id):n.add(p.id); return n;})}
                    style={{display:"flex",alignItems:"center",gap:8,padding:"8px",borderRadius:8,cursor:"pointer",
                      background: sel ? "rgba(163,207,254,.12)" : "transparent"}}>
                    <span style={{fontSize:16}}>{sel?"☑️":"⬜"}</span>
                    {p.avatar_url ? <img src={p.avatar_url} style={{width:28,height:28,borderRadius:"50%",objectFit:"cover"}} alt=""/> : <span style={{fontSize:18}}>🌱</span>}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:700}}>{p.display_name}</div>
                      {p.first_name && <div style={{fontSize:11,color:"var(--text3)"}}>{p.first_name}</div>}
                    </div>
                    {p.squads?.name && <SquadPill name={p.squads.name}/>}
                  </div>
                );
              })}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-primary" style={{flex:2}} disabled={selectedPlayers.size===0}
                onClick={async()=>{
                  await enrollPlayers(addPlayersTo.id, [...selectedPlayers], addPlayersTo.name);
                  setAddPlayersTo(null); setSelectedPlayers(new Set());
                  load();
                }}>
                ✅ Iscrivi {selectedPlayers.size > 0 ? `(${selectedPlayers.size})` : ""}
              </button>
              <button className="btn btn-ghost" style={{flex:1}} onClick={()=>setAddPlayersTo(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => { setShowForm(false); setEditingId(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{editingId ? "✏️ Modifica Lab" : "Nuovo Lab"}</div>
            <div className="form-group">
              <label className="form-label">Foto del Lab (opzionale)</label>
              {form.image_data && (
                <div style={{position:"relative",marginBottom:8}}>
                  <img src={form.image_data} style={{width:"100%",maxHeight:200,objectFit:"cover",borderRadius:10,border:"2px solid #101010",display:"block"}} alt=""/>
                  <button type="button" onClick={()=>setForm(f=>({...f,image_data:null}))} style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,.7)",border:"none",color:"#fff",borderRadius:8,padding:"4px 9px",cursor:"pointer",fontWeight:800}}>✕</button>
                </div>
              )}
              <label className="btn btn-ghost btn-sm" style={{cursor:"pointer",display:"inline-block"}}>
                📷 {form.image_data ? "Cambia foto" : "Carica foto"}
                <input type="file" accept="image/*" style={{display:"none"}} onChange={async e=>{ const f=e.target.files[0]; if(!f) return; const c=await compressToWebP(f,800,.8); const r=new FileReader(); r.onload=ev=>setForm(fm=>({...fm,image_data:ev.target.result})); r.readAsDataURL(c); }}/>
              </label>
            </div>
            <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div className="form-group"><label className="form-label">Descrizione</label><textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
            <div className="form-group"><label className="form-label">Link (opzionale)</label><input className="form-input" type="url" value={form.link} onChange={e => setForm(f => ({ ...f, link: e.target.value }))} placeholder="https://…" /></div>
            <div className="form-group"><label className="form-label">🌱 Giardiniere presente</label>
              <select value={form.educator_id} onChange={e => setForm(f => ({ ...f, educator_id: e.target.value }))}>
                <option value="">Nessuno assegnato</option>
                {educators.map(e => <option key={e.id} value={e.id}>{e.display_name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">📅 Giorni e orari Lab (opzionale)</label>
              <input className="form-input" value={form.schedule||""} onChange={e=>setForm(f=>({...f,schedule:e.target.value}))} placeholder="es. Martedì e Giovedì 15:00–17:00"/>
              <div style={{fontSize:10,color:"var(--text3)",marginTop:3}}>Indica i giorni e gli orari delle sessioni</div>
            </div>
            {[["duration_days","Numero di appuntamenti","number"],["coin_cost","Costo coin iscrizione","number"],["max_participants","Max partecipanti (opt.)","number"]].map(([k,l,t]) => (
              <div className="form-group" key={k}><label className="form-label">{l}</label><input className="form-input" type={t} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} /></div>
            ))}
            <div className="section-label">Punti per ogni presenza</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div><label className="form-label">XP a presenza</label><input className="form-input" type="number" value={form.xp_partial} onChange={e => setForm(f => ({ ...f, xp_partial: Number(e.target.value) }))} /></div>
              <div><label className="form-label">Coin a presenza</label><input className="form-input" type="number" value={form.coin_partial} onChange={e => setForm(f => ({ ...f, coin_partial: Number(e.target.value) }))} /></div>
              <div><label className="form-label">Moltiplic. ×</label><input className="form-input" type="number" step="0.5" min="1" value={form.lab_multiplier} onChange={e => setForm(f => ({ ...f, lab_multiplier: Number(e.target.value) }))} /></div>
            </div>
            <div style={{fontSize:10,color:"var(--text3)",marginTop:4,lineHeight:1.5}}>
              Completando tutti i {form.duration_days||"N"} appuntamenti il giocatore riceve il totale ×{form.lab_multiplier||2} (presenze × XP × moltiplicatore).
            </div>
            {/* Selezione player da iscrivere subito — solo in creazione */}
            {!editingId && <>
            <div className="section-label" style={{marginTop:8}}>Iscrivi giocatori (opzionale)</div>
            <input className="form-input" placeholder="🔍 Cerca giocatore…" value={playerSearch}
              onChange={e=>setPlayerSearch(e.target.value)} style={{marginBottom:8}}/>
            <div style={{maxHeight:130,overflowY:"auto",border:"1px solid var(--border)",borderRadius:10,padding:6,marginBottom:8}}>
              {players.filter(p => !playerSearch || p.display_name.toLowerCase().includes(playerSearch.toLowerCase()) || (p.first_name||"").toLowerCase().includes(playerSearch.toLowerCase())).map(p => {
                const sel = selectedPlayers.has(p.id);
                return (
                  <div key={p.id} onClick={()=>setSelectedPlayers(prev=>{const n=new Set(prev); n.has(p.id)?n.delete(p.id):n.add(p.id); return n;})}
                    style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",borderRadius:8,cursor:"pointer",
                      background: sel ? "rgba(163,207,254,.12)" : "transparent"}}>
                    <span style={{fontSize:14}}>{sel?"☑️":"⬜"}</span>
                    {p.avatar_url ? <img src={p.avatar_url} style={{width:24,height:24,borderRadius:"50%",objectFit:"cover"}} alt=""/> : <span>🌱</span>}
                    <span style={{flex:1,fontSize:13,fontWeight:600}}>{p.display_name}{p.first_name?` · ${p.first_name}`:""}</span>
                  </div>
                );
              })}
            </div>
            {selectedPlayers.size > 0 && <div style={{fontSize:12,color:"var(--neon-blue)",fontWeight:700,marginBottom:8}}>{selectedPlayers.size} giocatori selezionati</div>}
            </>}
            {createErr && <div style={{ color:"var(--danger)", fontSize:12, fontWeight:700, marginBottom:8 }}>{createErr}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={editingId ? saveEdit : createActivity}>{editingId ? "Salva modifiche" : "Crea"}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setShowForm(false); setEditingId(null); }}>Annulla</button>
            </div>
          </div>
        </div>
      )}
      {customizing && <BannerCustomizer sectionKey="attivita" sectionColors={sectionColors} setSectionColors={setSectionColors} onClose={() => setCustomizing(false)} />}
    </div>
  );
}

function BadgesView({ sectionColors, setSectionColors }) {
  const [badges, setBadges] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAssign, setShowAssign] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [assignTarget, setAssignTarget] = useState("");
  const [assignXp, setAssignXp] = useState(0);
  const [assignCoin, setAssignCoin] = useState(0);
  const [newBadge, setNewBadge] = useState({ name: "", description: "", link: "", xp_default: 20, coin_default: 10, image_url: null });
  const [badgeImgUploading, setBadgeImgUploading] = useState(false);
  const badgeImgRef = useRef(null);


  const load = useCallback(async () => {
    const [{ data: b }, { data: p }] = await Promise.all([
      sb.from("badges").select("*").order("created_at", { ascending: false }),
      sb.from("profiles").select("id,display_name,xp,coin").eq("role","player").order("display_name"),
    ]);
    setBadges(b || []); setPlayers(p || []); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function assignBadge() {
    if (!assignTarget || !showAssign) return;
    const badge = badges.find(b => b.id === showAssign);
    // 1. Registra il badge — se fallisce, lo dice (prima falliva in silenzio)
    const { error: insErr } = await sb.from("player_badges").insert({ player_id: assignTarget, badge_id: showAssign, xp_awarded: Number(assignXp), coin_awarded: Number(assignCoin) });
    if (insErr) { addToast("❌ Badge non assegnato: " + insErr.message, "error"); return; }
    // 2. XP/Coin in transazione atomica lato server (traccia anche xp_history)
    const { error: xpErr } = await sb.rpc("award_xp", { p_player_id: assignTarget, p_xp: Number(assignXp), p_coin: Number(assignCoin), p_reason: "badge", p_log_title: null });
    if (xpErr) { addToast("❌ Badge registrato ma XP non assegnati: " + xpErr.message + " — prova logout/login", "error"); return; }
    // 3. Solo ora notifica e push (dopo che badge e XP sono davvero a posto)
    await sb.from("notifications").insert({ user_id: assignTarget, type: "badge_assigned", title: `Badge: ${badge?.name}`, body: `+${assignXp} XP, +${assignCoin} Coin` });
    sendPush(assignTarget, `🎖️ Badge: ${badge?.name}`, `Hai guadagnato +${assignXp} XP e +${assignCoin} Coin!`).catch(()=>{});
    playPixel("badge");
    addToast("🎖️ Badge assegnato!", "ok");
    setShowAssign(null);
  }

  async function createBadge() {
    await sb.from("badges").insert(newBadge);
    load(); setShowCreate(false); setNewBadge({ name: "", description: "", link: "", xp_default: 20, coin_default: 10, image_url: null });
  }

  async function deleteBadge(id) {
    if (!confirm("Eliminare?")) return;
    await sb.from("badges").delete().eq("id", id);
    setBadges(prev => prev.filter(b => b.id !== id));
  }

  return (
    <div>
      <SectionBanner sectionKey="badge" title="🎖️ Badge" sub={`${badges.length} badge`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-yellow btn-sm" onClick={() => setShowCreate(true)}>+ Nuovo badge</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div className="badge-grid">
          {badges.map(b => (
            <div key={b.id} className="badge-card">
              <button className="delete-btn" onClick={e => { e.stopPropagation(); deleteBadge(b.id); }}>✕</button>
              <div onClick={() => { setShowAssign(b.id); setAssignXp(b.xp_default); setAssignCoin(b.coin_default); }}>
                {b.image_url ? <img className="badge-img" src={b.image_url} alt={b.name} /> : <span className="badge-emoji">🎖️</span>}
                <div className="badge-name">{b.name}</div>
                <div className="badge-pts">+{b.xp_default} XP</div>
              </div>
            </div>
          ))}
          {badges.length === 0 && <div className="empty" style={{ gridColumn: "1/-1" }}>Nessun badge.</div>}
        </div>
      )}

      {showAssign && (
        <div className="modal-bg" onClick={() => setShowAssign(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Assegna badge</div>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              {badges.find(b => b.id === showAssign)?.image_url ? <img src={badges.find(b => b.id === showAssign).image_url} style={{ width: 76, height: 76, borderRadius: 12, objectFit: "contain", border: "3px solid #101010" }} alt="" /> : <span style={{ fontSize: 48 }}>🎖️</span>}
              <div style={{ fontFamily: "'Funnel Display'", fontSize: 20, fontWeight: 900, textTransform: "uppercase", color: "var(--text)", marginTop: 6 }}>{badges.find(b => b.id === showAssign)?.name}</div>
            </div>
            <div className="form-group"><label className="form-label">Giocatore</label>
              <select value={assignTarget} onChange={e => setAssignTarget(e.target.value)}>
                <option value="">Seleziona…</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP</label><input className="form-input" type="number" value={assignXp} onChange={e => setAssignXp(e.target.value)} /></div>
              <div className="form-group"><label className="form-label">Coin</label><input className="form-input" type="number" value={assignCoin} onChange={e => setAssignCoin(e.target.value)} /></div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={assignBadge} disabled={!assignTarget}>Assegna</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAssign(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="modal-bg" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Crea badge</div>
            <div className="section-label">Immagine badge</div>
            {newBadge.image_url && (
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,padding:"8px",background:"rgba(255,0,204,.06)",border:"1px solid rgba(255,0,204,.2)",borderRadius:10}}>
                <img src={newBadge.image_url} style={{width:48,height:48,objectFit:"contain",borderRadius:8}} alt="badge"/>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--rosa)"}}>{newBadge.image_url.split("/").pop().replace(".webp","")}</div>
                  <button className="btn btn-ghost btn-xs" style={{marginTop:4}} onClick={()=>setNewBadge(f=>({...f,image_url:null}))}>✕ Rimuovi</button>
                </div>
              </div>
            )}
            <input ref={badgeImgRef} type="file" accept="image/*" style={{display:"none"}} onChange={async e => {
              const file = e.target.files[0]; if (!file) return;
              setBadgeImgUploading(true);
              try {
                const url = await uploadBadgeImage(file);
                setNewBadge(f => ({ ...f, image_url: url }));
              } catch(err) {
                addToast("❌ Errore caricamento: " + (err?.message || ""), "error");
              } finally {
                setBadgeImgUploading(false);
                e.target.value = "";
              }
            }}/>
            <button className="btn btn-ghost btn-sm" style={{width:"100%",marginBottom:10}} disabled={badgeImgUploading} onClick={() => badgeImgRef.current?.click()}>
              {badgeImgUploading ? "⏳ Caricamento…" : "📷 Carica immagine (anche da telefono)"}
            </button>
            <div className="section-label" style={{marginTop:2}}>…oppure scegli dalla galleria</div>
            <AvatarPicker selected={newBadge.image_url||""} onSelect={url=>setNewBadge(f=>({...f,image_url:url||null}))} squadFilter="Badge"/>
            <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={newBadge.name} onChange={e => setNewBadge(f => ({ ...f, name: e.target.value }))} /></div>
            <div className="form-group"><label className="form-label">Descrizione</label><textarea value={newBadge.description} onChange={e => setNewBadge(f => ({ ...f, description: e.target.value }))} placeholder="Racconta questo badge…" /></div>
            <div className="form-group"><label className="form-label">Link (opzionale)</label><input className="form-input" type="url" value={newBadge.link} onChange={e => setNewBadge(f => ({ ...f, link: e.target.value }))} placeholder="https://…" /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP</label><input className="form-input" type="number" value={newBadge.xp_default} onChange={e => setNewBadge(f => ({ ...f, xp_default: Number(e.target.value) }))} /></div>
              <div className="form-group"><label className="form-label">Coin</label><input className="form-input" type="number" value={newBadge.coin_default} onChange={e => setNewBadge(f => ({ ...f, coin_default: Number(e.target.value) }))} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createBadge} disabled={!newBadge.name}>Crea</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
      {customizing && <BannerCustomizer sectionKey="badge" sectionColors={sectionColors} setSectionColors={setSectionColors} onClose={() => setCustomizing(false)} />}
    </div>
  );
}

function SfidaView({ sectionColors, setSectionColors, profile }) {
  const [sfide, setSfide] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [form, setForm] = useState({ title:"", description:"", link:"", xp_reward:20, coin_reward:10, expires_at:"", image_data:null, location:"CHILL" });

  const load = useCallback(async () => {
    const now = new Date().toISOString();
    const { data } = await sb.from("activities").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(20);
    const active = (data || []).filter(a =>
      a.description?.includes("SFIDA") &&
      (!a.expires_at || a.expires_at > now)
    );
    setSfide(active); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createSfida() {
    if (!form.title.trim()) return;
    const payload = {
      name: form.title,
      description: "SFIDA · " + form.description,
      duration_days: 1,
      xp_full: Number(form.xp_reward),
      xp_completed: Number(form.xp_reward),
      xp_partial: Math.round(Number(form.xp_reward) / 2),
      coin_full: Number(form.coin_reward),
      coin_completed: Number(form.coin_reward),
      coin_partial: Math.round(Number(form.coin_reward) / 2),
      coin_cost: 0,
      is_active: true,
      expires_at: form.expires_at ? new Date(form.expires_at + "T23:59:59").toISOString() : null,
      link: form.link.trim() || null,
      image_data: form.image_data || null,
      location: form.location || null,
      author_name: profile?.display_name || null,
      educator_id: profile?.id || null,
    };
    await sb.from("activities").insert(payload);
    setShowForm(false);
    setForm({ title:"", description:"", link:"", xp_reward:20, coin_reward:10, expires_at:"", image_data:null, location:"CHILL" });
    load();
  }

  async function deleteSfida(id) {
    if (!confirm("Disattivare questa sfida?")) return;
    await sb.from("activities").update({ is_active: false }).eq("id", id);
    setSfide(prev => prev.filter(s => s.id !== id));
  }

  return (
    <div>
      <SectionBanner sectionKey="sfida" title="⚡ Sfide" sub={`${sfide.length} attive`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-yellow btn-sm" onClick={() => setShowForm(true)}>+ Nuova sfida</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div>
          {sfide.map(s => (
            <div key={s.id} className="sfida-card">
              <button className="delete-btn" onClick={() => deleteSfida(s.id)} title="Disattiva sfida">✕</button>
              <div className="sfida-label">⚡ Sfida attiva</div>
              <div className="sfida-title">{s.name}</div>
              <div className="sfida-desc">{s.description?.replace("SFIDA · ", "")}</div>
                {s.image_data && <img src={s.image_data} style={{maxWidth:"100%",maxHeight:400,width:"auto",height:"auto",borderRadius:10,border:"2px solid #101010",margin:"8px auto",display:"block"}} alt=""/>}
                {(s.location||s.author_name) && <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",margin:"6px 0"}}>{s.location && <span style={{background:s.location==="BIG TOP"?"#D41323":"#339966",color:"#fff",fontWeight:800,fontSize:11,padding:"4px 10px",borderRadius:8,border:"2px solid #101010"}}>{s.location==="BIG TOP"?"🎪":"🛋️"} {s.location}</span>}{s.author_name && <span style={{fontSize:11,fontWeight:700,color:"var(--text3)"}}>🌱 {s.author_name}</span>}</div>}
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:s.link?8:0 }}>
                <span className="sfida-reward">🏆 +{s.xp_completed} XP · 🪙 +{s.coin_completed}</span>
                {s.expires_at && (
                  <span style={{ fontSize:10, color:"rgba(255,255,255,.4)", fontWeight:700 }}>
                    ⏰ Scade: {new Date(s.expires_at).toLocaleDateString("it-IT")}
                  </span>
                )}
              </div>
              {s.link && (
                <a href={s.link} target="_blank" rel="noreferrer"
                  style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, color:"var(--azzurro)", fontWeight:700, textDecoration:"none", background:"rgba(163,207,254,.08)", border:"1px solid rgba(163,207,254,.2)", borderRadius:8, padding:"4px 10px" }}>
                  🔗 Apri link / file
                </a>
              )}
            </div>
          ))}
          {sfide.length === 0 && <div className="empty">Nessuna sfida attiva.</div>}
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Nuova sfida</div>
            <div className="form-group"><label className="form-label">Titolo</label><input className="form-input" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="es. Corri 5 giri!" /></div>
            <div className="form-group"><label className="form-label">Descrizione</label><textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP premio</label><input className="form-input" type="number" value={form.xp_reward} onChange={e => setForm(f => ({ ...f, xp_reward: e.target.value }))} /></div>
              <div className="form-group"><label className="form-label">Coin premio</label><input className="form-input" type="number" value={form.coin_reward} onChange={e => setForm(f => ({ ...f, coin_reward: e.target.value }))} /></div>
            </div>
            <div className="form-group">
              <label className="form-label">Link o file (opzionale)</label>
              <input className="form-input" type="url" value={form.link} onChange={e => setForm(f => ({ ...f, link: e.target.value }))} placeholder="https:// oppure link Google Drive, PDF…"/>
              <div style={{fontSize:10,color:"var(--text3)",marginTop:3}}>Puoi incollare un link a un sito, Google Drive, Dropbox, PDF online…</div>
            </div>
            <div className="form-group">
              <label className="form-label">Data scadenza (opzionale)</label>
              <input className="form-input" type="date" value={form.expires_at} onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} min={localToday()} />
              <div style={{ fontSize:10, color:"var(--text3)", marginTop:4 }}>Lascia vuoto per sfida senza scadenza</div>
            </div>
            <div className="form-group">
              <label className="form-label">Luogo</label>
              <div style={{display:"flex",gap:8}}>
                {["CHILL","BIG TOP"].map(loc=>(
                  <button key={loc} type="button" onClick={()=>setForm(f=>({...f,location:loc}))} className="btn btn-sm" style={{flex:1,background:form.location===loc?"#101010":"#fff",color:form.location===loc?"#FDEF26":"#101010",border:"2.5px solid #101010",fontWeight:800}}>{loc==="CHILL"?"🛋️ CHILL":"🎪 BIG TOP"}</button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Foto (opzionale)</label>
              {form.image_data && <div style={{position:"relative",marginBottom:8}}><img src={form.image_data} style={{width:"100%",maxHeight:180,objectFit:"cover",borderRadius:10,border:"2px solid #101010",display:"block"}} alt=""/><button type="button" onClick={()=>setForm(f=>({...f,image_data:null}))} style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,.7)",border:"none",color:"#fff",borderRadius:8,padding:"4px 9px",cursor:"pointer",fontWeight:800}}>✕</button></div>}
              <label className="btn btn-ghost btn-sm" style={{cursor:"pointer",display:"inline-block"}}>📷 {form.image_data?"Cambia foto":"Carica foto"}<input type="file" accept="image/*" style={{display:"none"}} onChange={async e=>{ const f=e.target.files[0]; if(!f) return; const c=await compressToWebP(f,800,.8); const r=new FileReader(); r.onload=ev=>setForm(fm=>({...fm,image_data:ev.target.result})); r.readAsDataURL(c); }}/></label>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createSfida} disabled={!form.title.trim()}>Pubblica</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
      {customizing && <BannerCustomizer sectionKey="sfida" sectionColors={sectionColors} setSectionColors={setSectionColors} onClose={() => setCustomizing(false)} />}
    </div>
  );
}

function DiaryView() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState(localToday());

  useEffect(() => {
    async function load() {
      setLoading(true);
      const dayStart = dateFilter + "T00:00:00";
      const dayEnd = dateFilter + "T23:59:59";
      const [{ data: notifs }, { data: xpHist }] = await Promise.all([
        sb.from("notifications").select("*, profiles(display_name)")
          .gte("created_at", dayStart).lte("created_at", dayEnd)
          .order("created_at", { ascending: false }).limit(300),
        sb.from("xp_history").select("id,player_id,xp_gained,xp_total,reason,created_at,profiles(display_name)")
          .gte("created_at", dayStart).lte("created_at", dayEnd)
          .order("created_at", { ascending: false }).limit(300),
      ]);
      // Eventi XP: ogni guadagno tracciato (presenza, lab, badge, manuale, batch...)
      const reasonMap = {
        presenza: { title: "📍 Presenza", icon: "📍" },
        presenza_qr: { title: "📍 Check-in QR", icon: "📍" },
        lab_checkin: { title: "⚡ Lab QR", icon: "⚡" },
        badge: { title: "🎖️ Badge ricevuto", icon: "🎖️" },
        manuale: { title: "✋ XP manuali", icon: "✋" },
        modifica_manuale: { title: "✏️ Modifica profilo", icon: "✏️" },
        modifica_dettagli: { title: "✏️ Modifica dettagli", icon: "✏️" },
        batch: { title: "📋 Assegnazione gruppo", icon: "📋" },
        streak_mensile: { title: "🔥 Premio streak", icon: "🔥" },
      };
      const xpEvents = (xpHist || []).filter(h => h.profiles).map(h => {
        const info = reasonMap[h.reason] || { title: `+ ${h.xp_gained} XP`, icon: "⭐" };
        return {
          id: "xp_" + h.id,
          type: "xp_gain",
          title: info.title,
          body: `${h.xp_gained >= 0 ? "+" : ""}${h.xp_gained} XP`,
          profiles: h.profiles,
          created_at: h.created_at,
          _icon: info.icon,
          _pid: h.profiles?.id,
          _xp: h.xp_gained,
          _day: (h.created_at||"").slice(0,10),
        };
      });
      const _seenPres = new Set();
      const xpEventsClean = xpEvents.filter(e => {
        if (!/presenz/i.test(e.title)) return true;
        if ((e._xp||0) < 0) return false;
        const k = (e._pid||"") + "|" + e._day;
        if (_seenPres.has(k)) return false;
        _seenPres.add(k); return true;
      });
      const allEntries = [
        ...(notifs||[]).filter(n => n.profiles && n.type !== "educator_msg"),
        ...xpEventsClean
      ].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      setEntries(allEntries); setLoading(false);
    }
    load();
  }, [dateFilter]);

  const typeIcon = { badge_assigned:"🎖️", booking_confirmed:"✅", booking_rejected:"❌", log_action:"📌", presenza:"✅", new_message:"💬", level_up:"🆙", xp_gain:"⭐" };
  const typeColor = { badge_assigned:"var(--rosa)", booking_confirmed:"var(--verde)", booking_rejected:"var(--danger)", presenza:"var(--neon-green)", new_message:"var(--azzurro)", level_up:"var(--neon-gold)", xp_gain:"var(--neon-gold)" };

  return (
    <div>
      <div className="filter-bar">
        <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} style={{ padding: 10, background: "var(--surface2)", border: "1.5px solid var(--border2)", borderRadius: 10, color: "var(--text)", fontSize: 14, flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={() => setDateFilter(localToday())}>Oggi</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        entries.length === 0
          ? <div className="empty">Nessuna azione per questo giorno.</div>
          : (
            <div>
              <div style={{ fontSize:12, color:"var(--text3)", marginBottom:10, fontWeight:700 }}>
                {entries.length} azioni · {new Date(dateFilter).toLocaleDateString("it-IT", { weekday:"long", day:"numeric", month:"long" })}
              </div>
              {entries.map(e => (
                <div key={e.id} className="diary-entry">
                  <span className="diary-icon" style={{ color: typeColor[e.type] || "var(--text2)" }}>{e._icon || typeIcon[e.type] || "🔔"}</span>
                  <div className="diary-text">
                    <strong style={{ color:"var(--text)" }}>{e.profiles?.display_name}</strong>
                    <span style={{ color:"var(--text2)", marginLeft:6 }}>{e.title}</span>
                    {e.body && <span style={{ color:"var(--text3)", marginLeft:6, fontSize:11 }}>{e.body}</span>}
                  </div>
                  <div className="diary-pts">{new Date(e.created_at).toLocaleTimeString("it-IT", { hour:"2-digit", minute:"2-digit" })}</div>
                </div>
              ))}
            </div>
          )
      )}
    </div>
  );
}

function AvatarStickerPicker({ onSelect }) {
  return (
    <div style={{marginTop:8,background:"var(--surface2)",borderRadius:12,border:"1px solid var(--border)",padding:10}}>
      <div style={{fontSize:11,color:"var(--text3)",marginBottom:8,fontWeight:700}}>Tocca per inviare</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        {ANIMATED_STICKERS.map(s=>(
          <div key={s.id} onClick={()=>onSelect("sticker:" + s.id)}
            style={{cursor:"pointer",borderRadius:12,padding:6,border:"2px solid transparent",
              background:"var(--surface2)",transition:"all .15s",
              display:"flex",flexDirection:"column",alignItems:"center",gap:3}}
            onMouseOver={e=>{e.currentTarget.style.borderColor="var(--neon-blue)";e.currentTarget.style.background="rgba(163,207,254,.08)";}}
            onMouseOut={e=>{e.currentTarget.style.borderColor="transparent";e.currentTarget.style.background="rgba(255,255,255,.04)";}}>
            <div style={{width:60,height:60}} dangerouslySetInnerHTML={{__html:s.svg}}/>
            <span style={{fontSize:9,color:"var(--text2)",fontWeight:700,textAlign:"center"}}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GifSearch({ onSelect }) {
  const [tab, setTab] = useState(Object.keys(CURATED_GIFS)[0]);
  const [customUrl, setCustomUrl] = useState("");

  const tabs = Object.keys(CURATED_GIFS);
  const gifs = CURATED_GIFS[tab] || [];

  return (
    <div>
      {/* Category tabs */}
      <div style={{display:"flex",gap:4,marginBottom:8,flexWrap:"wrap"}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{padding:"3px 8px",borderRadius:99,border:"1px solid var(--border2)",
              background:tab===t?"var(--neon-blue)":"transparent",
              color:tab===t?"#fff":"var(--text2)",fontSize:11,fontWeight:700,cursor:"pointer"}}>
            {t}
          </button>
        ))}
      </div>

      {/* GIF grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:4,marginBottom:8}}>
        {gifs.map(id=>{
          const url = `https://media.giphy.com/media/${id}/giphy.gif`;
          return (
            <img key={id} src={url} alt="" onClick={()=>onSelect(url)}
              style={{width:"100%",aspectRatio:"1",objectFit:"cover",borderRadius:8,cursor:"pointer",border:"2px solid transparent",transition:"border .1s"}}
              onMouseOver={e=>e.target.style.borderColor="var(--neon-blue)"}
              onMouseOut={e=>e.target.style.borderColor="transparent"}/>
          );
        })}
      </div>

      {/* Paste URL custom */}
      <div style={{borderTop:"1px solid var(--border)",paddingTop:8}}>
        <div style={{fontSize:10,color:"var(--text3)",marginBottom:4}}>Oppure incolla URL di una GIF da Giphy/Tenor:</div>
        <div style={{display:"flex",gap:6}}>
          <input className="search-inp" placeholder="https://media.giphy.com/..." value={customUrl}
            onChange={e=>setCustomUrl(e.target.value)} style={{flex:1,fontSize:12}}/>
          <button className="btn btn-ghost btn-sm" onClick={()=>{if(customUrl.trim()){onSelect(customUrl.trim());setCustomUrl("");}}} disabled={!customUrl.trim()}>Usa</button>
        </div>
      </div>
      <div style={{fontSize:9,color:"var(--text3)",marginTop:6,textAlign:"right"}}>Powered by GIPHY</div>
    </div>
  );
}

function MessagesView({ profile }) {
  const [squads, setSquads]     = useState([]);
  const [players, setPlayers]   = useState([]);
  const [activities, setActivities] = useState([]);
  const [msgs, setMsgs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [destType, setDestType] = useState("tutti");
  const [destSquad, setDestSquad]     = useState("");
  const [selectedPlayers, setSelectedPlayers] = useState([]);
  const [destActivity, setDestActivity] = useState("");
  const [playerSort, setPlayerSort]   = useState("alpha");
  const [playerSearch, setPlayerSearch] = useState("");
  const [body, setBody]   = useState("");
  const [expiry, setExpiry] = useState(""); // optional expiry date
  const [sending, setSending] = useState(false);
  const [sent, setSent]   = useState("");
  const [educators, setEducators] = useState([]);
  const [mediaData, setMediaData] = useState(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaType, setMediaType] = useState(null);
  const mediaRef = useRef();

  async function loadAll() {
    const [{ data: sq }, { data: pl }, { data: act }, { data: m }] = await Promise.all([
      sb.from("squads").select("*").order("name"),
      sb.from("profiles").select("id,display_name,xp,avatar_url").eq("role","player").order("display_name"),
      sb.from("activities").select("id,name,description").eq("is_active",true).order("name"),
      sb.from("messages").select("id,body,media_data,is_broadcast,squad_id,recipient_id,sender_id,expires_at,cancelled_at,created_at,profiles!sender_id(display_name,avatar_url)").or(`sender_id.eq.${profile.id},recipient_id.eq.${profile.id},is_broadcast.eq.true,squad_id.not.is.null`).order("created_at",{ascending:false}).gt("expires_at", new Date().toISOString()).limit(100),
    ]);
    setSquads(sq||[]); setPlayers(pl||[]); setActivities(act||[]); setMsgs(m||[]); setLoading(false);
  }
  useEffect(() => {
    loadAll();
    sb.from("profiles").select("id,display_name,avatar_url").in("role",["educator","admin"])
      .then(({data})=>{
        // Escludi se stesso dalla lista
        setEducators((data||[]).filter(e=>e.id!==profile.id));
      });
  }, []);

  async function sendMessage() {
    if (!body.trim()) return;
    setSending(true);
    const senderName = profile?.display_name || "Giardiniere";
    const expiresAt = expiry ? new Date(expiry + "T23:59:59").toISOString() : null;
    const defaultExpiry = new Date(Date.now() + 30*24*60*60*1000).toISOString();
    const base = { sender_id: profile.id, body: body.trim(), media_data: mediaData || null, is_broadcast:false, squad_id:null, recipient_id:null, expires_at: expiresAt || defaultExpiry };

    // Helper locali: insert batch notifiche (1 query) + push in parallelo
    const notifyBatch = (rows) => rows.length ? sb.from("notifications").insert(rows) : Promise.resolve();
    const pushBatch = (ids, title, txt) => sendPushToAll(ids, title, txt).catch(()=>{});

    if (destType === "tutti") {
      const [{ data: allP }, { data: newMsg }] = await Promise.all([
        sb.from("profiles").select("id").eq("role","player"),
        sb.from("messages").insert({...base, is_broadcast:true}).select("id").single(),
      ]);
      const msgId = newMsg?.id || null;
      const ids = (allP||[]).map(p => p.id);
      await notifyBatch(ids.map(id => ({user_id:id, type:"new_message", title:"Hai un nuovo messaggio", body:`${senderName} ha scritto a tutti`, message_id:msgId})));
      pushBatch(ids, "💬 Messaggio", `${senderName}: ${body.trim().slice(0,60)}`);
    } else if (destType === "squad" && destSquad) {
      const sq = squads.find(s=>s.id===destSquad);
      const [{ data: sqMsg }, { data: sqP }] = await Promise.all([
        sb.from("messages").insert({...base, squad_id:destSquad}).select("id").single(),
        sb.from("profiles").select("id").eq("squad_id",destSquad),
      ]);
      const sqMsgId = sqMsg?.id || null;
      const ids = (sqP||[]).map(p => p.id);
      await notifyBatch(ids.map(id => ({user_id:id, type:"new_message", title:"Hai un nuovo messaggio", body:`${senderName} ha scritto alla squadra ${sq?.name||""}`, message_id:sqMsgId})));
      pushBatch(ids, "💬 Messaggio squadra", `${senderName}: ${body.trim().slice(0,60)}`);
    } else if (destType === "educators") {
      // Invia a TUTTI i giardinieri (esclude chi invia)
      const { data: eduP } = await sb.from("profiles").select("id").eq("role","educator").neq("id", profile.id);
      const recipients = eduP || [];
      // Un messaggio per destinatario (in parallelo), poi notifiche in un solo insert
      const pms = await Promise.all(recipients.map(e =>
        sb.from("messages").insert({...base, recipient_id:e.id}).select("id").single()
      ));
      await notifyBatch(recipients.map((e, i) => ({user_id:e.id, type:"educator_msg", title:"💬 Messaggio dal team", body:`${senderName}: ${body.trim().slice(0,60)}`, message_id:pms[i]?.data?.id||null})));
      pushBatch(recipients.map(e=>e.id), "💬 Messaggio team", `${senderName}: ${body.trim().slice(0,60)}`);
      setSent(`Inviato a ${recipients.length} giardinieri ✅`);
    } else if (destType === "selection" && selectedPlayers.length > 0) {
      // Selezione mista: player + giardinieri insieme
      const pms = await Promise.all(selectedPlayers.map(pid =>
        sb.from("messages").insert({...base, recipient_id:pid}).select("id").single()
      ));
      await notifyBatch(selectedPlayers.map((pid, i) => {
        const isEdu = educators.some(e => e.id === pid);
        return {user_id:pid, type: isEdu ? "educator_msg" : "new_message", title: isEdu ? "💬 Messaggio dal team" : "Hai un nuovo messaggio", body:`${senderName} ti ha scritto`, message_id:pms[i]?.data?.id||null};
      }));
      pushBatch(selectedPlayers, `💬 ${senderName}`, body.trim().slice(0,80));
      setSent(`Inviato a ${selectedPlayers.length} destinatari ✅`);
    } else if (destType === "player" && selectedPlayers.length > 0) {
      const pms = await Promise.all(selectedPlayers.map(pid =>
        sb.from("messages").insert({...base, recipient_id:pid}).select("id").single()
      ));
      await notifyBatch(selectedPlayers.map((pid, i) => ({user_id:pid, type:"new_message", title:"Hai un nuovo messaggio", body:`${senderName} ti ha scritto`, message_id:pms[i]?.data?.id||null})));
      pushBatch(selectedPlayers, `💬 ${senderName}`, body.trim().slice(0,80));
    } else if (destType === "activity" && destActivity) {
      const { data: bk } = await sb.from("bookings").select("player_id").eq("activity_id",destActivity).eq("status","confirmed");
      if (bk?.length) {
        const ids = bk.map(b => b.player_id);
        await Promise.all([
          sb.from("messages").insert(ids.map(pid => ({...base, recipient_id:pid}))),
          notifyBatch(ids.map(pid => ({user_id:pid, type:"new_message", title:"Hai un nuovo messaggio", body:`${senderName} ha scritto ai partecipanti del Lab`}))),
        ]);
        pushBatch(ids, "💬 Messaggio lab", `${senderName}: ${body.trim().slice(0,60)}`);
        setSent(`Inviato a ${bk.length} partecipanti ✅`);
      } else { setSent("Nessun partecipante confermato"); }
      setSending(false); setTimeout(()=>setSent(""),3000); setBody(""); setExpiry(""); return;
    }

    setBody(""); setExpiry(""); setSelectedPlayers([]); setMediaData(null); setMediaType(null);
    setSent("Messaggio inviato ✅"); setTimeout(()=>setSent(""),3000);
    loadAll(); setSending(false);
  }

  async function cancelMsg(id) {
    if (!confirm("Annullare questo messaggio? I giocatori non lo vedranno più.")) return;
    await sb.from("messages").update({ cancelled_at: new Date().toISOString() }).eq("id", id);
    // Cancella notifiche collegate
    await sb.from("notifications").delete().eq("message_id", id);
    // Fallback: cancella notifiche di tipo new_message create nello stesso minuto del messaggio
    const msg = msgs.find(m=>m.id===id);
    if (msg?.created_at) {
      const t0 = new Date(msg.created_at);
      const t1 = new Date(t0.getTime() + 2*60000).toISOString();
      await sb.from("notifications")
        .delete()
        .eq("type","new_message")
        .gte("created_at", msg.created_at)
        .lte("created_at", t1);
    }
    setMsgs(prev => prev.map(m => m.id===id ? {...m, cancelled_at: new Date().toISOString()} : m));
  }

  // In modalità "selection" includiamo player + giardinieri (esclude se stesso)
  const selectableList = destType === "selection"
    ? [...players, ...educators.filter(e => e.id !== profile.id).map(e => ({...e, _isEdu:true}))]
    : [...players];
  const sortedPlayers = selectableList
    .filter(p => !playerSearch || (p.display_name||"").toLowerCase().includes(playerSearch.toLowerCase()) || (p.first_name||"").toLowerCase().includes(playerSearch.toLowerCase()))
    .sort((a,b) => {
      // Giardinieri sempre in cima (in modalità selezione)
      if (a._isEdu !== b._isEdu) return a._isEdu ? -1 : 1;
      return playerSort === "level" ? (b.xp||0)-(a.xp||0) : (a.display_name||"").localeCompare(b.display_name||"");
    });

  const now = new Date().toISOString();
  const activeMsgs = msgs.filter(m => !m.cancelled_at && (!m.expires_at || m.expires_at > now));
  const cancelledMsgs = msgs.filter(m => m.cancelled_at || (m.expires_at && m.expires_at <= now));

  return (
    <div>

      {/* Compose */}
      <div className="card" style={{marginBottom:18}}>
        <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Nuovo messaggio</div>

        {/* Tipo destinatario */}
        <div className="form-group">
          <label className="form-label">Destinatario</label>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {[["tutti","📢 Tutti i giocatori"],["squad","🛡️ Squadra"],["activity","⚡ Lab"],["educators","🌱 Tutti i giardinieri"],["selection","👤 Selezione"]].map(([k,l])=>(
              <button key={k} className={`chip ${destType===k?"active":""}`} onClick={()=>setDestType(k)}>{l}</button>
            ))}
          </div>
          {destType==="squad" && (
            <select value={destSquad} onChange={e=>setDestSquad(e.target.value)}>
              <option value="">Seleziona squadra…</option>
              {squads.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {destType==="educators" && (
            <div style={{fontSize:13,color:"var(--text3)",padding:"8px 12px",background:"rgba(163,207,254,.06)",border:"1px solid rgba(163,207,254,.2)",borderRadius:10,marginBottom:8}}>
              Il messaggio verrà inviato a tutti gli altri giardinieri ({educators.filter(e=>e.id!==profile.id).length}).
            </div>
          )}
{destType==="selection" && (
            <div>
              <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                <input className="search-inp" placeholder="🔍 Cerca…" value={playerSearch} onChange={e=>setPlayerSearch(e.target.value)} style={{flex:1,minWidth:100}}/>
                <select value={playerSort} onChange={e=>setPlayerSort(e.target.value)} style={{padding:"8px 10px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:10,color:"var(--text)",fontSize:12}}>
                  <option value="alpha">A→Z</option>
                  <option value="level">Livello ↓</option>
                </select>
                {selectedPlayers.length>0 && <button className="btn btn-ghost btn-xs" onClick={()=>setSelectedPlayers([])}>✕ Reset</button>}
              </div>
              <div style={{maxHeight:200,overflowY:"auto",border:"1px solid var(--border)",borderRadius:10}}>
                {sortedPlayers.map(p=>{
                  const lv = getLevel(p.xp||0);
                  const sel = selectedPlayers.includes(p.id);
                  return (
                    <div key={p.id} onClick={()=>setSelectedPlayers(prev=>sel?prev.filter(id=>id!==p.id):[...prev,p.id])}
                      style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",cursor:"pointer",background:sel?"rgba(163,207,254,.1)":"transparent",borderBottom:"1px solid var(--border)",transition:"background .1s"}}>
                      <div style={{width:20,height:20,borderRadius:5,border:`2px solid ${sel?"var(--neon-blue)":"var(--border2)"}`,background:sel?"var(--neon-blue)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:11,color:"#000",fontWeight:900}}>
                        {sel?"✓":""}
                      </div>
                      <div style={{width:28,height:28,borderRadius:"50%",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>
                        {p.avatar_url?<img src={p.avatar_url} style={{width:"100%",height:"100%",objectFit:"cover"}} alt=""/>:lv.emoji}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:600,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.display_name}</div>
                        <div style={{fontSize:10,color:"var(--text3)"}}>
                          {p._isEdu ? "🌱 Giardiniere" : `${lv.emoji} Lv.${lv.id} · ${p.xp} XP`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {selectedPlayers.length>0 && <div style={{fontSize:12,color:"var(--neon-blue)",fontWeight:700,marginTop:6}}>✓ {selectedPlayers.length} selezionat{selectedPlayers.length===1?"o":"i"}</div>}
            </div>
          )}
          {destType==="activity" && (
            <select value={destActivity} onChange={e=>setDestActivity(e.target.value)}>
              <option value="">Seleziona lab…</option>
              {activities.filter(a=>!a.description?.startsWith("SFIDA")).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
        </div>

        {/* Testo */}
        <div className="form-group">
          <label className="form-label">Testo</label>
          <textarea value={body} onChange={e=>setBody(e.target.value)} placeholder="Scrivi un messaggio…" />
        </div>

        {/* Immagine allegata */}
        <div className="form-group">
          <label className="form-label">📷 Immagine allegata (opzionale)</label>
          <input ref={mediaRef} type="file" accept="image/*" style={{display:"none"}} onChange={async e => {
            const file = e.target.files[0]; if (!file) return;
            setMediaUploading(true);
            try {
              // Upload automatico su Storage: nel messaggio va solo l'URL
              const url = await uploadMessageMedia(file);
              setMediaData(url); setMediaType("image");
            } catch(err) {
              addToast("❌ Errore caricamento foto: " + (err?.message || ""), "error");
            } finally {
              setMediaUploading(false);
              e.target.value = "";
            }
          }}/>
          {mediaUploading ? (
            <div style={{fontSize:13,color:"var(--text2)",padding:"8px 0"}}>⏳ Caricamento foto…</div>
          ) : mediaData ? (
            <div style={{position:"relative",display:"inline-block",marginBottom:8}}>
              <img src={mediaData} style={{maxWidth:"100%",maxHeight:180,borderRadius:12,border:"1px solid var(--border)",display:"block"}} alt="" loading="lazy"/>
              <button onClick={()=>{setMediaData(null);setMediaType(null);}} style={{position:"absolute",top:-8,right:-8,background:"rgba(0,0,0,.8)",border:"none",color:"#fff",borderRadius:"50%",width:24,height:24,cursor:"pointer",fontSize:14,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={()=>mediaRef.current.click()}>📷 Aggiungi foto</button>
          )}
        </div>

        {/* Scadenza opzionale */}
        <div className="form-group">
          <label className="form-label">Scadenza (opzionale) — dopo questa data il messaggio sparisce</label>
          <input type="date" className="form-input" value={expiry} onChange={e=>setExpiry(e.target.value)} min={localToday()}/>
        </div>

        {sent && <div style={{fontSize:13,color:"var(--verde)",fontWeight:700,marginBottom:8}}>{sent}</div>}
        <button className="btn btn-primary"
          onClick={sendMessage}
          disabled={sending || !body.trim() || (destType==="squad"&&!destSquad) || (destType==="player"&&selectedPlayers.length===0) || (destType==="activity"&&!destActivity)}>
          {sending?"Invio…":"Invia messaggio"}
        </button>
      </div>

      {/* Storico attivi */}
      <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>
        Messaggi attivi ({activeMsgs.length})
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
          {activeMsgs.map(m=>{
            const recipientPlayer = players.find(p=>p.id===m.recipient_id);
            const recipientEdu = educators.find(e=>e.id===m.recipient_id);
            const dest = m.is_broadcast?"📢 Tutti":m.squad_id?`🛡️ ${squads.find(s=>s.id===m.squad_id)?.name||"Squadra"}`:m.recipient_id?`👤 ${recipientPlayer?.display_name||recipientEdu?.display_name||"Destinatario"}`:"—";
            return (
              <div key={m.id} className="card-sm">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:7}}>
                    {m.profiles?.avatar_url
                      ? <img src={m.profiles.avatar_url} style={{width:26,height:26,borderRadius:"50%",objectFit:"cover",flexShrink:0}} alt=""/>
                      : <span style={{fontSize:16,flexShrink:0}}>🌱</span>}
                    <div>
                      <div style={{fontSize:12,fontWeight:700,color:"var(--text)",lineHeight:1}}>{m.profiles?.display_name||"Giardiniere"}</div>
                      <div style={{fontSize:10,color:"var(--text3)",marginTop:1}}>→ {dest}</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {m.expires_at && <span style={{fontSize:9,color:"var(--text3)",fontWeight:700}}>⏰ {new Date(m.expires_at).toLocaleDateString("it-IT")}</span>}
                    <span style={{fontSize:10,color:"var(--text3)"}}>{new Date(m.created_at).toLocaleDateString("it-IT",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span>
                    <button className="btn btn-danger btn-xs" onClick={()=>cancelMsg(m.id)} title="Annulla messaggio">✕</button>
                  </div>
                </div>
                {m.media_data && !m.media_data.startsWith("sticker:") && (
                  <img src={m.media_data}
                    style={{maxWidth:"100%",maxHeight:200,borderRadius:10,marginBottom:6,display:"block"}}
                    alt="media" loading="lazy"/>
                )}
                <div style={{fontSize:13,color:"var(--text)"}}>{m.body}</div>
              {m.media_data&&<img src={m.media_data} style={{maxWidth:"100%",maxHeight:180,borderRadius:10,marginTop:4}} alt=""/>}
              <MsgReactions msgId={m.id} myId={profile.id}/>
              </div>
            );
          })}
          {activeMsgs.length===0 && <div className="empty">Nessun messaggio attivo</div>}
        </div>
      )}

      {/* Storico annullati/scaduti */}
      {cancelledMsgs.length>0 && (
        <>
          <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>
            Annullati / scaduti ({cancelledMsgs.length})
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {cancelledMsgs.map(m=>(
              <div key={m.id} className="card-sm" style={{opacity:0.45}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:11,fontWeight:700,color:"var(--text3)"}}>{m.is_broadcast?"📢 Tutti":m.squad_id?"🛡️ Squadra":"👤 Diretto"}</span>
                  <span style={{fontSize:10,color:"var(--danger)",fontWeight:700}}>{m.cancelled_at?"✕ Annullato":"⏰ Scaduto"}</span>
                </div>
                <div style={{fontSize:12,color:"var(--text2)"}}>{m.body}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BookingsView() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showArchive, setShowArchive] = useState(false);

  const cutoff = new Date(Date.now() - 7*86400000).toISOString();

  async function load() {
    setLoading(true);
    try {
      const { data: bkData } = await sb.from("bookings")
        .select("id,player_id,activity_id,coin_held,status,reviewed_at,created_at")
        .order("created_at", { ascending: false });
      const playerIds = [...new Set((bkData||[]).map(b=>b.player_id).filter(Boolean))];
      const actIds    = [...new Set((bkData||[]).map(b=>b.activity_id).filter(Boolean))];
      const [{ data: pData }, { data: aData }] = await Promise.all([
        playerIds.length ? sb.from("profiles").select("id,display_name").in("id", playerIds) : Promise.resolve({data:[]}),
        actIds.length    ? sb.from("activities").select("id,name,coin_cost").in("id", actIds)  : Promise.resolve({data:[]}),
      ]);
      const pMap = Object.fromEntries((pData||[]).map(p=>[p.id,p]));
      const aMap = Object.fromEntries((aData||[]).map(a=>[a.id,a]));
      setBookings((bkData||[]).map(b=>({...b, profiles: pMap[b.player_id]||null, activities: aMap[b.activity_id]||null })));
    } catch(e) { }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function review(id, status, playerId, coinHeld) {
    await sb.from("bookings").update({ status, reviewed_at: new Date().toISOString() }).eq("id", id);
    if (status === "rejected" && (coinHeld||0) > 0) {
      // Rimborso atomico lato server (registra anche chi l'ha fatto)
      await sb.rpc("award_xp", { p_player_id: playerId, p_xp: 0, p_coin: coinHeld, p_reason: "rimborso", p_log_title: null });
    }
    const pushTitle = status==="confirmed" ? "✅ Prenotazione confermata!" : "❌ Prenotazione rifiutata";
    const pushBody  = status==="confirmed" ? "Sei dentro! Apri l'app per i dettagli." : "Le tue coin sono state restituite.";
    await sb.from("notifications").insert({ user_id: playerId, type: status==="confirmed"?"booking_confirmed":"booking_rejected", title: status==="confirmed"?"Prenotazione confermata!":"Prenotazione rifiutata", body: status==="confirmed"?"Sei dentro!":"Coin restituite." });
    sendPush(playerId, pushTitle, pushBody).catch(()=>{});
    load();
  }

  const visible = showArchive ? bookings : bookings.filter(b => (b.created_at||"") >= cutoff);
  const statusTag = { pending:["tag-amber","In attesa"], confirmed:["tag-green","Confermata"], rejected:["tag-red","Rifiutata"], cancelled:["tag-gray","Annullata"] };

  return (
    <div>
      {/* Filtro */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div style={{fontSize:13,color:"var(--text3)"}}>
          {showArchive ? `Tutte · ${bookings.length}` : `Ultimi 7 giorni · ${visible.length}`}
        </div>
        <div style={{display:"flex",gap:6}}>
          <button className={`chip ${!showArchive?"active":""}`} onClick={()=>setShowArchive(false)}>📅 7 giorni</button>
          <button className={`chip ${showArchive?"active":""}`} onClick={()=>setShowArchive(true)}>📦 Archivio</button>
        </div>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {visible.map(b => {
            const [tc, tl] = statusTag[b.status] || ["tag-gray", b.status];
            return (
              <div key={b.id} className="card-sm">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                  <div>
                    <div style={{fontSize:15,fontWeight:700}}>{b.profiles?.display_name||"—"}</div>
                    <div style={{fontSize:12,color:"var(--text2)",marginTop:2}}>{b.activities?.name||"—"} · 🪙 {b.coin_held}</div>
                    <div style={{fontSize:10,color:"var(--text3)",marginTop:2}}>{new Date(b.created_at).toLocaleDateString("it-IT",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</div>
                  </div>
                  <span className={`tag ${tc}`}>{tl}</span>
                </div>
                {b.status === "pending" && (
                  <div style={{display:"flex",gap:8}}>
                    <button className="btn btn-sm" style={{flex:1,background:"rgba(51,153,102,.15)",color:"var(--verde)",border:"1px solid rgba(51,153,102,.3)"}} onClick={()=>review(b.id,"confirmed",b.player_id,b.coin_held)}>✓ Conferma</button>
                    <button className="btn btn-danger btn-sm" style={{flex:1}} onClick={()=>review(b.id,"rejected",b.player_id,b.coin_held)}>✗ Rifiuta</button>
                  </div>
                )}
              </div>
            );
          })}
          {visible.length === 0 && <div className="empty">Nessuna prenotazione{!showArchive?" negli ultimi 7 giorni":""}</div>}
        </div>
      )}
    </div>
  );
}

function QrView() {
  const [qr, setQr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const today = localToday();
  const [fromTime, setFromTime] = useState("13:00");
  const [toTime, setToTime] = useState("19:00");

  useEffect(() => {
    sb.from("daily_qr").select("*").eq("date", today).maybeSingle()
      .then(({ data }) => { setQr(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [today]);

  async function generateQr() {
    setWorking(true);
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    // Validità fissa: 13:00 – 19:00 della giornata
    const [fh,fm] = fromTime.split(":").map(Number);
    const [th,tm] = toTime.split(":").map(Number);
    const vf = new Date(); vf.setHours(fh||0, fm||0, 0, 0);
    const vu = new Date(); vu.setHours(th||0, tm||0, 0, 0);
    const { data } = await sb.from("daily_qr").upsert(
      { date: today, code, valid_from: vf.toISOString(), valid_until: vu.toISOString() },
      { onConflict: "date" }
    ).select().single();
    setQr(data);
    setWorking(false);
    if (typeof addToast === "function") addToast("✅ Nuovo QR generato", "ok");
  }

  async function cancelQr() {
    if (!qr) return;
    if (!window.confirm("Annullare il QR di oggi? I ragazzi non potranno più usarlo finché non ne generi uno nuovo.")) return;
    setWorking(true);
    await sb.from("daily_qr").delete().eq("date", today);
    setQr(null);
    setWorking(false);
    if (typeof addToast === "function") addToast("🗑️ QR annullato", "ok");
  }

  // Stato orario: il QR è "attivo" solo tra 13:00 e 19:00
  const now = new Date();
  const isWithinWindow = qr && now >= new Date(qr.valid_from) && now <= new Date(qr.valid_until);
  const beforeWindow = qr && now < new Date(qr.valid_from);

  return (
    <div className="card" style={{ maxWidth: 400, margin: "0 auto", textAlign: "center" }}>
      <div style={{ padding: "24px 0" }}>
        <div style={{ fontFamily: "'Funnel Display'", fontSize: 13, fontWeight: 900, textTransform: "uppercase", color: "var(--text2)", letterSpacing: ".1em", marginBottom: 4 }}>QR Check-in</div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 24 }}>{today}</div>
        <div style={{display:"flex",gap:8,alignItems:"flex-end",justifyContent:"center",marginBottom:20,flexWrap:"wrap"}}>
          <div style={{textAlign:"left"}}><label className="form-label" style={{fontSize:10,marginBottom:2}}>Dalle</label><input type="time" className="form-input" value={fromTime} onChange={e=>setFromTime(e.target.value)} style={{width:120}}/></div>
          <div style={{textAlign:"left"}}><label className="form-label" style={{fontSize:10,marginBottom:2}}>Alle</label><input type="time" className="form-input" value={toTime} onChange={e=>setToTime(e.target.value)} style={{width:120}}/></div>
        </div>
        {loading ? <div className="loading">⏳</div> : qr ? (
          <>
            <div style={{ background: "var(--surface2)", borderRadius: 16, padding: "24px 32px", marginBottom: 16, display: "inline-block", border: "1.5px solid var(--border2)", position:"relative" }}>
              <img src={`https://api.qrserver.com/v1/create-qr-code/?data=${qr.code}&size=200x200&bgcolor=ffffff&color=000000&qzone=1`} alt={qr.code} style={{ width:200, height:200, display:"block", borderRadius:8, opacity: isWithinWindow ? 1 : 0.35 }}/>
              {!isWithinWindow && (
                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <span style={{background:"rgba(0,0,0,.75)",color:"#fff",padding:"6px 14px",borderRadius:99,fontSize:12,fontWeight:700}}>
                    {beforeWindow ? "⏰ Non ancora attivo" : "⏰ Scaduto"}
                  </span>
                </div>
              )}
            </div>
            <div style={{ fontFamily:"'Funnel Display'", fontSize:34, fontWeight:900, color: isWithinWindow ? "var(--neon-blue)" : "var(--text3)", letterSpacing:8, margin:"10px 0 6px", textShadow: isWithinWindow ? "var(--glow-blue)" : "none" }}>{qr.code}</div>
            <div style={{ fontSize:13, color:"var(--text2)", marginBottom:4 }}>Valido dalle {new Date(qr.valid_from).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"})} alle {new Date(qr.valid_until).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"})}</div>
            <div style={{ fontSize:11, color: isWithinWindow ? "var(--verde)" : "var(--text3)", marginBottom:16, fontWeight:700 }}>
              {isWithinWindow ? "● Attivo ora" : beforeWindow ? `Si attiva alle ${new Date(qr.valid_from).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"})}` : "Finestra oraria conclusa"}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-ghost" style={{ flex:1 }} disabled={working} onClick={generateQr}>🔄 Rigenera</button>
              <button className="btn btn-danger" style={{ flex:1 }} disabled={working} onClick={cancelQr}>🗑️ Annulla</button>
            </div>
            <div style={{ fontSize:10, color:"var(--text3)", marginTop:10, lineHeight:1.4 }}>
              Rigenera se il codice è stato condiviso con assenti — il vecchio smette subito di funzionare.
            </div>
          </>
        ) : (
          <>
            <div style={{ color: "var(--text3)", fontSize: 14, marginBottom: 24 }}>Nessun codice per oggi</div>
            <button className="btn btn-primary" disabled={working} onClick={generateQr}>Genera QR di oggi</button>
          </>
        )}
      </div>
    </div>
  );
}


// ─── BACHECA ANNUNCI ─────────────────────────────────────
function AnnouncementsView({ profile }) {
  const [announcements, setAnnouncements] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const imgRef = useRef();
  const [imgData, setImgData] = useState(null);

  useEffect(() => { load(); }, []);
  async function load() {
    const { data } = await sb.from("announcements")
      .select("*, profiles(display_name,avatar_url)")
      .order("pinned",{ascending:false}).order("created_at",{ascending:false}).limit(50);
    setAnnouncements(data||[]);
  }

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    await sb.from("announcements").insert({ educator_id:profile.id, title:title.trim(), body:body.trim()||null, image_data:imgData||null, pinned });
    setTitle(""); setBody(""); setImgData(null); setPinned(false); setShowForm(false); setSaving(false);
    load();
  }

  async function del(id) {
    if (!confirm("Eliminare annuncio?")) return;
    await sb.from("announcements").delete().eq("id",id);
    setAnnouncements(p=>p.filter(a=>a.id!==id));
  }

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div/>
        <button className="btn btn-yellow btn-sm" onClick={()=>setShowForm(p=>!p)}>
          {showForm?"✕ Annulla":"+ Nuovo"}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{marginBottom:16}}>
          <div className="form-group">
            <label className="form-label">Titolo *</label>
            <input className="form-input" value={title} onChange={e=>setTitle(e.target.value)} placeholder="Titolo annuncio…"/>
          </div>
          <div className="form-group">
            <label className="form-label">Testo</label>
            <textarea className="form-input" rows={3} value={body} onChange={e=>setBody(e.target.value)} placeholder="Descrizione, info, orari…" style={{resize:"vertical"}}/>
          </div>
          <div className="form-group">
            <label className="form-label">Immagine (opzionale)</label>
            <input ref={imgRef} type="file" accept="image/*" style={{display:"none"}} onChange={async e=>{
              const f = e.target.files[0]; if(!f) return;
              const compressed = await compressToWebP(f,800,.8);
              const r = new FileReader(); r.onload=ev=>setImgData(ev.target.result); r.readAsDataURL(compressed);
            }}/>
            {imgData ? (
              <div style={{position:"relative",display:"inline-block"}}>
                <img src={imgData} style={{maxWidth:"100%",maxHeight:160,borderRadius:8}} alt="" loading="lazy"/>
                <button onClick={()=>setImgData(null)} style={{position:"absolute",top:4,right:4,background:"rgba(0,0,0,.7)",border:"none",color:"#fff",borderRadius:"50%",width:22,height:22,cursor:"pointer",fontSize:12}}>✕</button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={()=>imgRef.current.click()}>📷 Aggiungi immagine</button>
            )}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <input type="checkbox" id="pinned" checked={pinned} onChange={e=>setPinned(e.target.checked)} style={{width:16,height:16}}/>
            <label htmlFor="pinned" style={{fontSize:13,color:"var(--text2)",cursor:"pointer"}}>📌 Fissa in cima</label>
          </div>
          <button className="btn btn-primary" onClick={save} disabled={saving||!title.trim()}>
            {saving?"⏳ Salvataggio…":"📢 Pubblica"}
          </button>
        </div>
      )}

      {announcements.length===0 ? (
        <div className="empty" style={{padding:24}}>Nessun annuncio ancora.</div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {announcements.map(a=>(
            <div key={a.id} className="card" style={{position:"relative",border:a.pinned?"1.5px solid rgba(253,239,38,.4)":""}}>
              {a.pinned&&<div style={{position:"absolute",top:10,right:12,fontSize:14}}>📌</div>}
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                {a.profiles?.avatar_url
                  ? <img src={a.profiles.avatar_url} style={{width:32,height:32,borderRadius:"50%",objectFit:"cover"}} alt=""/>
                  : <span style={{fontSize:22}}>🌱</span>
                }
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>{a.profiles?.display_name||"Giardiniere"}</div>
                  <div style={{fontSize:10,color:"var(--text3)"}}>{new Date(a.created_at).toLocaleDateString("it-IT",{day:"numeric",month:"long",year:"numeric"})}</div>
                </div>
              </div>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:22,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:6}}>{a.title}</div>
              {a.body&&<div style={{fontSize:13,color:"var(--text2)",lineHeight:1.5,marginBottom:8,whiteSpace:"pre-wrap"}}>{a.body}</div>}
              {a.image_data&&<img src={a.image_data} style={{width:"100%",borderRadius:10,marginBottom:8,maxHeight:300,objectFit:"cover"}} alt=""/>}
              <button onClick={()=>del(a.id)} style={{background:"none",border:"none",color:"rgba(255,34,68,.5)",cursor:"pointer",fontSize:12,padding:"4px 0"}}>🗑️ Elimina</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlayerAnnouncementsTab() {
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    sb.from("announcements").select("*, profiles(display_name,avatar_url)")
      .order("pinned",{ascending:false}).order("created_at",{ascending:false}).limit(30)
      .then(({ data }) => { setAnnouncements(data||[]); setLoading(false); })
      .catch(()=>setLoading(false));
  }, []);

  // Data relativa in stile Camerino ("oggi" / "ieri" / "12 lug")
  function relDay(iso) {
    const d = new Date(iso);
    const today = new Date(); today.setHours(0,0,0,0);
    const day = new Date(d); day.setHours(0,0,0,0);
    const diff = Math.round((today - day) / 86400000);
    if (diff <= 0) return "oggi";
    if (diff === 1) return "ieri";
    return d.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
  }

  if (loading) return <div className="loading">⏳</div>;
  if (announcements.length===0) return <div className="empty" style={{padding:24}}>Nessun annuncio.</div>;
  return (
    <div>
      {announcements.map(a=>(
        <div key={a.id} className="ann">
          <div className="ahead" style={{background:a.pinned?"#FDEF26":"#A3CFFE",color:"#101010"}}>
            <span>{a.pinned?"📌":"📢"} {a.profiles?.display_name||"Dal centro"}</span>
            <span>{relDay(a.created_at)}</span>
          </div>
          <div className="abody">
            {a.title && <div style={{fontWeight:800,textTransform:"uppercase",fontSize:14,marginBottom:a.body?4:0}}>{a.title}</div>}
            {a.body && <div style={{whiteSpace:"pre-wrap"}}>{a.body}</div>}
            {a.image_data && <img src={a.image_data} style={{width:"100%",borderRadius:10,marginTop:8,maxHeight:260,objectFit:"cover"}} alt=""/>}
          </div>
        </div>
      ))}
    </div>
  );
}


// ─── BACHECA POST-IT EDUCATORI ───────────────────────────
function BachecaView({ profile }) {
  const [notes, setNotes] = useState([]);
  const [body, setBody] = useState("");
  const [color, setColor] = useState("#FDEF26");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const COLORS = ["#FDEF26","#FF6DEC","#A3CFFE","#339966","#D41323"];

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const { data, error } = await sb.from("educator_notes")
      .select("id,body,color,created_at,educator_id,educator_id,profiles(display_name,avatar_url)")
      .order("created_at",{ascending:false}).limit(50);
    if (error) {
      addToast("❌ Errore caricamento bacheca", "error");
    }
    setNotes(data||[]);
    setLoading(false);
  }

  async function addNote() {
    if (!body.trim()) return;
    setSaving(true);
    const { error } = await sb.from("educator_notes").insert({ educator_id:profile.id, body:body.trim(), color });
    // Notifica gli altri giardinieri del nuovo post-it
    try {
      const { data: otherEdu } = await sb.from("profiles").select("id").eq("role","educator").neq("id", profile.id);
      (otherEdu || []).forEach(e => {
        sb.from("notifications").insert({ user_id:e.id, type:"educator_msg", title:"📌 Nuovo post-it in bacheca", body:`${profile.display_name}: ${body.trim().slice(0,50)}` }).then(()=>{});
        sendPush(e.id, "📌 Bacheca team", `${profile.display_name} ha aggiunto un post-it`).catch(()=>{});
      });
    } catch(_) {}
    if (error) {
      addToast("❌ Errore: " + error.message, "error");
      setSaving(false);
      return;
    }
    setBody("");
    setSaving(false);
    addToast("📌 Post-it pubblicato!", "ok");
    load();
  }

  const rotation = (id) => ((id.charCodeAt(0)%5)-2)*0.8;

  return (
    <div>
      <div style={{fontSize:12,fontWeight:600,color:"#101010",background:"rgba(255,255,255,.82)",padding:"8px 12px",borderRadius:10,marginBottom:14}}>Post-it visibili solo ai giardinieri.</div>

      {/* Form aggiunta */}
      <div className="card" style={{marginBottom:16}}>
        <textarea
          className="form-input"
          rows={3}
          value={body}
          onChange={e=>setBody(e.target.value)}
          placeholder="Scrivi un messaggio per il team…"
          style={{resize:"none",marginBottom:10,width:"100%"}}
        />
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:5}}>
            {COLORS.map(c=>(
              <div key={c} onClick={()=>setColor(c)} style={{
                width:22,height:22,borderRadius:"50%",background:c,cursor:"pointer",
                outline:color===c?`3px solid ${c}`:""  ,outlineOffset:2,
                boxShadow:color===c?"0 0 0 1px white inset":"none",
                transition:"all .15s",flexShrink:0
              }}/>
            ))}
          </div>
          <button
            onClick={addNote}
            disabled={saving||!body.trim()}
            className="btn btn-primary btn-sm"
            style={{marginLeft:"auto"}}>
            {saving?"⏳":"📌 Pubblica"}
          </button>
        </div>
      </div>

      {/* Grid post-it */}
      {loading ? (
        <div className="loading">⏳ Caricamento…</div>
      ) : notes.length===0 ? (
        <div className="empty" style={{padding:32,textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:8}}>📌</div>
          <div style={{fontWeight:700}}>Nessun post-it ancora</div>
          <div style={{fontSize:12,marginTop:4}}>Aggiungi il primo messaggio al team</div>
        </div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:14}}>
          {notes.map(n=>(
            <div key={n.id} style={{
              background:n.color||"#FDEF26",
              borderRadius:4,
              padding:"14px 14px 12px",
              position:"relative",
              boxShadow:"3px 3px 10px rgba(0,0,0,.25), 0 1px 2px rgba(0,0,0,.15)",
              transform:`rotate(${rotation(n.id)}deg)`,
              transition:"transform .2s",
              cursor:"default",
            }}
            onMouseOver={e=>e.currentTarget.style.transform="rotate(0deg) scale(1.02)"}
            onMouseOut={e=>e.currentTarget.style.transform=`rotate(${rotation(n.id)}deg)`}>
              {/* Puntina effetto */}
              <div style={{position:"absolute",top:-6,left:"50%",transform:"translateX(-50%)",width:12,height:12,borderRadius:"50%",background:"var(--surface)",boxShadow:"0 2px 4px rgba(0,0,0,.3)"}}/>
              <div className="hand" style={{fontSize:17,color:(n.color==="#339966"||n.color==="#D41323")?"#fff":"rgba(0,0,0,.88)",lineHeight:1.45,marginBottom:10,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{n.body}</div>
              <div style={{display:"flex",alignItems:"center",gap:5,borderTop:"1px solid rgba(0,0,0,.1)",paddingTop:8}}>
                {n.profiles?.avatar_url
                  ? <img src={n.profiles.avatar_url} style={{width:18,height:18,borderRadius:"50%",objectFit:"cover"}} alt=""/>
                  : <span style={{fontSize:12}}>🌱</span>}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:10,color:(n.color==="#339966"||n.color==="#D41323")?"rgba(255,255,255,.85)":"rgba(0,0,0,.7)",fontWeight:800,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n.profiles?.display_name}</div>
                  {n.created_at && <div style={{fontSize:8.5,color:"rgba(0,0,0,.45)",fontWeight:600}}>{new Date(n.created_at).toLocaleDateString("it-IT",{day:"2-digit",month:"2-digit"})} · {new Date(n.created_at).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"})}</div>}
                </div>
                {n.educator_id===profile.id && (
                  <button
                    onClick={async()=>{
                      await sb.from("educator_notes").delete().eq("id",n.id);
                      setNotes(p=>p.filter(x=>x.id!==n.id));
                      addToast("🗑️ Post-it rimosso","ok");
                    }}
                    style={{background:"rgba(0,0,0,.12)",border:"none",cursor:"pointer",
                      fontSize:11,color:"rgba(0,0,0,.6)",padding:"2px 6px",
                      borderRadius:99,lineHeight:1,fontWeight:700}}>
                    ✕ Rimuovi
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── ANNOUNCEMENTS EDUCATOR ─────────────────────────────


function VisibilityView() {
  const [vis, setVis] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pug_visibility")||"{}"); } catch(_){ return {}; }
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Carica da profiles — sempre accessibile
    sb.from("profiles").select("app_config").eq("id", "00000000-0000-0000-0000-000000000099").single()
      .then(({ data }) => {
        const cfg = data?.app_config;
        if (cfg && typeof cfg === "object") {
          setVis(cfg);
          localStorage.setItem("pug_visibility", JSON.stringify(cfg));
        }
      }).catch(console.error);
  }, []);

  async function toggle(key) {
    const next = { ...vis, [key]: vis[key] === false ? true : false };
    setVis(next);
    localStorage.setItem("pug_visibility", JSON.stringify(next));
    await sb.from("profiles").update({ app_config: next }).eq("id", "00000000-0000-0000-0000-000000000099");
  }

  async function saveToSupabase() {
    setSaving(true);
    // Salva in profiles del primo admin/educator — profiles è sempre accessibile
    const { error } = await sb.from("profiles")
      .update({ app_config: vis })
      .eq("id", "00000000-0000-0000-0000-000000000099");
    if (error) { alert("Errore: " + error.message); setSaving(false); return; }
    localStorage.setItem("pug_visibility", JSON.stringify(vis));
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }
  const sections = [
    { key:"squadre",    label:"🛡️ Squadra",           desc:"Mostra la squadra del giocatore nel suo profilo" },
    { key:"streak",     label:"🔥 Streak & presenze",  desc:"Mostra il contatore di presenze consecutive" },
    { key:"sfida",      label:"⚡ Sfide",              desc:"Mostra il pannello sfide nel profilo player" },
    { key:"badge",      label:"🎖️ Badge",             desc:"Mostra la collezione badge nel profilo" },
    { key:"classifica", label:"🏆 Classifica",         desc:"Mostra la posizione in classifica" },
    { key:"coin",       label:"🪙 Coin",               desc:"Mostra il saldo coin nel profilo" },
    { key:"xp",         label:"⭐ XP",                 desc:"Mostra i punti XP nel profilo" },
    { key:"lab",        label:"⚡ Tab Lab",            desc:"Mostra la tab Lab nel menu player" },
    { key:"bigtop",     label:"🎪 Tab BIG TOP",        desc:"Mostra la sezione Circo nel menu player" },
    { key:"messaggi",   label:"💬 Messaggi",           desc:"Mostra la tab messaggi nel menu player" },
    { key:"creatura",   label:"🌱 Barre creatura",     desc:"Mostra le barre Energia/Socialità/Felicità nel profilo" },
    { key:"giochi",     label:"🎮 Giochi",             desc:"Mostra PIN PUG e XOXO nel profilo player" },
  ];
  const allVisible = sections.every(s => vis[s.key] !== false);
  return (
    <div>
      <div style={{fontSize:12.5,fontWeight:600,color:"#101010",background:"rgba(255,255,255,.82)",padding:"8px 12px",borderRadius:10,marginBottom:16}}>Controlla cosa vedono i giocatori nel loro profilo. Le modifiche sono immediate.</div>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        <button className="btn btn-sm" style={{background:"#fff",color:"#101010",border:"2.5px solid #101010",boxShadow:"3px 3px 0 #101010",fontWeight:800}} onClick={()=>{const all={}; sections.forEach(s=>all[s.key]=true); setVis(all); localStorage.setItem("pug_visibility",JSON.stringify(all));}}>✅ Mostra tutto</button>
        <button className="btn btn-sm" style={{background:"#fff",color:"#101010",border:"2.5px solid #101010",boxShadow:"3px 3px 0 #101010",fontWeight:800}} onClick={()=>{const all={}; sections.forEach(s=>all[s.key]=false); setVis(all); localStorage.setItem("pug_visibility",JSON.stringify(all));}}>🙈 Nascondi tutto</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {sections.map(s => {
          const on = vis[s.key] !== false;
          return (
            <div key={s.key} className="card-sm" style={{display:"flex",alignItems:"center",gap:14,cursor:"pointer",border:`1px solid ${on?"rgba(51,153,102,.2)":"rgba(255,34,68,.15)"}`,background:on?"rgba(51,153,102,.03)":"rgba(255,34,68,.03)"}}>
              <div style={{flex:1}} onClick={()=>toggle(s.key)}>
                <div style={{fontSize:14,fontWeight:700,color:"var(--text)"}}>{s.label}</div>
                <div style={{fontSize:11,color:"var(--text3)",marginTop:2}}>{s.desc}</div>
              </div>
              <div onClick={()=>toggle(s.key)} style={{width:44,height:24,borderRadius:99,background:on?"var(--neon-green)":"rgba(255,255,255,.1)",border:`2px solid ${on?"var(--neon-green)":"rgba(255,255,255,.2)"}`,position:"relative",cursor:"pointer",flexShrink:0,transition:"all .2s"}}>
                <div style={{position:"absolute",top:2,left:on?20:2,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"left .2s",boxShadow:"0 1px 4px rgba(0,0,0,.3)"}}/>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",gap:8,marginTop:16}}>
        <button className="btn btn-primary" style={{flex:1}} onClick={saveToSupabase} disabled={saving}>
          {saving ? "⏳ Salvataggio…" : saved ? "✅ Salvato!" : "💾 Salva impostazioni"}
        </button>
      </div>
      <div style={{background:"rgba(163,207,254,.05)",border:"1px solid rgba(163,207,254,.12)",borderRadius:10,padding:"10px 14px",marginTop:12,fontSize:11,color:"var(--text3)"}}>
        💡 Le modifiche vengono salvate e condivise automaticamente su tutti i dispositivi (giocatori inclusi). "Salva" forza una nuova sincronizzazione.
      </div>
    </div>
  );
}

// ─── STREAK CONFIG VIEW ───────────────────────────────────

function StreakConfigView() {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState("");

  const now = new Date();
  const months = Array.from({length:12},(_,i) => ({
    month: i+1, year: now.getFullYear(), label: MONTH_NAMES[i]
  }));

  const load = useCallback(async () => {
    const { data } = await sb.from("streak_config").select("*").eq("year", now.getFullYear()).order("month");
    setConfigs(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveConfig(cfg) {
    await sb.from("streak_config").upsert({
      month: cfg.month, year: cfg.year,
      min_days: Number(cfg.min_days),
      xp_reward: Number(cfg.xp_reward),
      coin_reward: Number(cfg.coin_reward),
      badge_name: cfg.badge_name || `${MONTH_NAMES[cfg.month-1]} ${cfg.year}`
    }, { onConflict: "month,year" });
    setEditing(null);
    setMsg("Configurazione salvata ✅");
    setTimeout(() => setMsg(""), 3000);
    load();
  }

  return (
    <div>
      <div style={{background:"rgba(255,255,255,.86)",border:"2px solid #101010",borderRadius:14,padding:"12px 16px",marginBottom:16,fontSize:13,fontWeight:600,color:"#101010",lineHeight:1.5}}>
        Configura i requisiti per guadagnare il badge mensile. Il badge viene assegnato automaticamente al primo check-in del mese successivo se il giocatore ha raggiunto il minimo di presenze.
      </div>
      {msg && <div style={{background:"rgba(51,153,102,.08)",border:"1px solid rgba(51,153,102,.2)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:"var(--neon-green)",fontWeight:700}}>{msg}</div>}
      {loading ? <div className="loading">⏳</div> : (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {months.map(m => {
            const cfg = configs.find(c => c.month === m.month) || { month: m.month, year: m.year, min_days: 10, xp_reward: 50, coin_reward: 25, badge_name: `${m.label} ${m.year}` };
            const isPast = m.month < now.getMonth() + 1;
            const isCurrent = m.month === now.getMonth() + 1;
            return (
              <div key={m.month} className="streak-month-card" style={{background:"var(--surface)",border:`1px solid ${isCurrent?"rgba(212,19,35,.3)":isPast?"rgba(51,153,102,.15)":"var(--border)"}`,borderRadius:14,padding:"12px 16px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:editing?.month===m.month?12:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:20}}>{isPast?"✅":isCurrent?"🔥":"📅"}</span>
                    <div>
                      <div style={{fontFamily:"'Funnel Display'",fontSize:18,fontWeight:900,textTransform:"uppercase",color:"var(--text)"}}>{m.label} {m.year}</div>
                      <div style={{fontSize:11,color:"var(--text3)"}}>Min. {cfg.min_days}gg · +{cfg.xp_reward} XP · +{cfg.coin_reward} Coin</div>
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-xs" onClick={() => setEditing(editing?.month===m.month?null:{...cfg})}>
                    {editing?.month===m.month?"▲":"✏️"}
                  </button>
                </div>
                {editing?.month === m.month && (
                  <div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
                      <div><label className="form-label">Min. giorni</label><input className="form-input" type="number" min="1" max="31" value={editing.min_days} onChange={e=>setEditing(p=>({...p,min_days:e.target.value}))}/></div>
                      <div><label className="form-label">XP badge</label><input className="form-input" type="number" value={editing.xp_reward} onChange={e=>setEditing(p=>({...p,xp_reward:e.target.value}))}/></div>
                      <div><label className="form-label">Coin badge</label><input className="form-input" type="number" value={editing.coin_reward} onChange={e=>setEditing(p=>({...p,coin_reward:e.target.value}))}/></div>
                    </div>
                    <div className="form-group"><label className="form-label">Nome badge</label><input className="form-input" value={editing.badge_name||""} onChange={e=>setEditing(p=>({...p,badge_name:e.target.value}))} placeholder={`${m.label} ${m.year}`}/></div>
                    <div style={{display:"flex",gap:8}}>
                      <button className="btn btn-primary" style={{flex:1}} onClick={()=>saveConfig(editing)}>Salva</button>
                      <button className="btn btn-ghost btn-sm" onClick={()=>setEditing(null)}>Annulla</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── PLAYER DASHBOARD ─────────────────────────────────────







// ─── EDUCATOR SOCIAL VIEW ────────────────────────────────
function EducatorSocialView({ profile }) {
  const [view, setView] = useState("community");
  const [players, setPlayers] = useState([]);
  useEffect(() => {
    sb.from("profiles").select("id,display_name,first_name,avatar_url,xp,squad_id,squads(name)")
      .eq("role","player").order("xp",{ascending:false})
      .then(({data})=>setPlayers(data||[]));
  }, []);

  return (
    <div>
      <div style={{display:"flex",background:"var(--surface2)",borderRadius:12,padding:4,marginBottom:16,gap:4}}>
        {[["community","👥 Community"],["annunci","📢 Annunci"]].map(([v,l])=>(
          <button key={v} onClick={()=>setView(v)} style={{
            flex:1,padding:"10px 0",borderRadius:9,border:"none",cursor:"pointer",
            fontFamily:"'Funnel Display',sans-serif",fontWeight:900,fontSize:15,
            textTransform:"uppercase",letterSpacing:".05em",transition:"all .2s",
            background:view===v?"#101010":"transparent",
            color:view===v?"#fff":"var(--text3)",
          }}>{l}</button>
        ))}
      </div>
      {view==="community" && (
        <CommunityTab
          players={players.filter(p=>(p.role==="player"||!p.role) && (p.xp||0) > 2)}
          myId={profile.id}
          myProfile={profile}
        />
      )}
      {view==="annunci" && <AnnouncementsView profile={profile}/>}
    </div>
  );
}

// ─── SOCIAL TAB ──────────────────────────────────────────
function SocialTab({ players, myId, myProfile }) {
  const [view, setView] = useState("annunci"); // "annunci" | "community"

  return (
    <div>
      <div className="chiprow">
        {[["annunci","📢 Annunci"],["community","👥 Community"]].map(([v,l])=>(
          <button key={v} className={`chip ${view===v?"active":""}`} onClick={()=>setView(v)}>{l}</button>
        ))}
      </div>
      {view==="annunci" && <PlayerAnnouncementsTab/>}
      {view==="community" && <CommunityTab players={players} myId={myId} myProfile={myProfile}/>}
    </div>
  );
}


// ─── MSG REACTIONS ───────────────────────────────────────
function MsgReactions({ msgId, myId }) {
  const EMOJIS = ["❤️","😂","😮","👏","🔥"];
  const [counts, setCounts] = useState({});
  const [mine, setMine] = useState(null);

  useEffect(() => {
    sb.from("reactions")
      .select("type").eq("badge_id", null).eq("target_player_id", msgId)
      .then(({data}) => {
        const c = {};
        (data||[]).forEach(r => { c[r.type]=(c[r.type]||0)+1; });
        setCounts(c);
      }).catch(()=>{});
    sb.from("reactions").select("type")
      .eq("player_id", myId).eq("target_player_id", msgId).is("badge_id", null)
      .maybeSingle().then(({data})=>{ if(data) setMine(data.type); }).catch(()=>{});
  }, [msgId, myId]);

  async function react(emoji) {
    if (mine === emoji) {
      await sb.from("reactions").delete().eq("player_id", myId).eq("target_player_id", msgId).is("badge_id", null);
      setCounts(p=>({...p,[emoji]:Math.max(0,(p[emoji]||1)-1)}));
      setMine(null);
    } else {
      await sb.from("reactions").delete().eq("player_id", myId).eq("target_player_id", msgId).is("badge_id", null);
      await sb.from("reactions").insert({player_id:myId,target_player_id:msgId,badge_id:null,type:emoji});
      if(mine) setCounts(p=>({...p,[mine]:Math.max(0,(p[mine]||1)-1)}));
      setCounts(p=>({...p,[emoji]:(p[emoji]||0)+1}));
      setMine(emoji);
      if(navigator.vibrate) navigator.vibrate(20);
    }
  }

  const total = Object.values(counts).reduce((a,b)=>a+b,0);
  if (total === 0 && !mine) {
    return (
      <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
        {EMOJIS.map(e=>(
          <button key={e} onClick={()=>react(e)}
            style={{background:mine===e?"#FDEF26":"#fff",border:"2px solid #101010",fontSize:20,cursor:"pointer",padding:"3px 9px",borderRadius:9,boxShadow:"2px 2px 0 #101010",lineHeight:1}}>
            {e}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div style={{display:"flex",gap:4,marginTop:6,flexWrap:"wrap"}}>
      {EMOJIS.filter(e=>counts[e]||mine===e).map(e=>(
        <button key={e} onClick={()=>react(e)}
          style={{
            background:mine===e?"rgba(163,207,254,.15)":"rgba(255,255,255,.06)",
            border:`1px solid ${mine===e?"var(--neon-blue)":"rgba(255,255,255,.1)"}`,
            borderRadius:99,fontSize:12,cursor:"pointer",
            padding:"3px 8px",display:"flex",alignItems:"center",gap:3,
            color:"var(--text2)",fontWeight:mine===e?700:400,
          }}>
          {e}{counts[e]>0&&<span style={{fontSize:10}}>{counts[e]}</span>}
        </button>
      ))}
      {EMOJIS.filter(e=>!counts[e]&&mine!==e).map(e=>(
        <button key={e} onClick={()=>react(e)}
          style={{background:"none",border:"none",fontSize:14,cursor:"pointer",
            padding:"2px 4px",borderRadius:6,opacity:0.4}}>
          {e}
        </button>
      ))}
    </div>
  );
}

// ─── PROFILE REACTIONS ───────────────────────────────────
function GamesHub({ myId, initialTab }) {
  const [tab, setTab] = useState(initialTab || "pong");
  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <button className="btn btn-sm" style={{flex:1,background:tab==="pong"?"#101010":"#fff",color:tab==="pong"?"#fff":"#101010",border:"2px solid #101010",fontWeight:800}} onClick={()=>setTab("pong")}>🕹️ PIN PUG</button>
        <button className="btn btn-sm" style={{flex:1,background:tab==="xoxo"?"#101010":"#fff",color:tab==="xoxo"?"#fff":"#101010",border:"2px solid #101010",fontWeight:800}} onClick={()=>setTab("xoxo")}>🆚 XOXO</button>
      </div>
      {tab==="pong" ? <PongGame myId={myId}/> : <XoxoGame myId={myId}/>}
    </div>
  );
}
function XoxoGame({ myId }) {
  const [matches, setMatches] = useState([]);
  const [names, setNames] = useState({});
  const [opp, setOpp] = useState([]);
  const [active, setActive] = useState(null);
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState("");
  const [wins, setWins] = useState([]);
  useEffect(() => {
    load(); loadOpp(); loadWins();
    const ch = sb.channel("xoxo-" + Math.random().toString(36).slice(2))
      .on("postgres_changes", { event: "*", schema: "public", table: "oxo_matches" }, () => load())
      .subscribe();
    return () => { try { sb.removeChannel(ch); } catch(_){} };
  }, []);
  async function load() {
    try {
      const { data } = await sb.from("oxo_matches").select("*").or("player_x.eq." + myId + ",player_o.eq." + myId).order("updated_at", { ascending: false }).limit(40);
      const ms = data || [];
      setMatches(ms);
      const ids = [...new Set(ms.flatMap(m => [m.player_x, m.player_o]))];
      if (ids.length) { const { data: ps } = await sb.from("profiles").select("id,display_name,avatar_url").in("id", ids); setNames(Object.fromEntries((ps||[]).map(p => [p.id, p]))); }
      setActive(a => a ? (ms.find(m => m.id === a.id) || null) : null);
    } catch(_){}
  }
  async function loadWins() {
    try {
      const { data } = await sb.from("oxo_matches").select("winner,player_x,player_o").eq("status","done").neq("winner","draw").limit(1000);
      const cnt = {};
      (data||[]).forEach(m => { const wid = m.winner === "x" ? m.player_x : m.player_o; if (wid) cnt[wid] = (cnt[wid]||0) + 1; });
      const ids = Object.keys(cnt);
      let nm = {};
      if (ids.length) { const { data: ps } = await sb.from("profiles").select("id,display_name,avatar_url").in("id", ids); nm = Object.fromEntries((ps||[]).map(p => [p.id, p])); }
      setWins(ids.map(id => ({ id, w: cnt[id], p: nm[id] })).sort((a,b) => b.w - a.w).slice(0, 8));
    } catch(_){}
  }
  async function loadOpp() {
    try { const { data } = await sb.from("profiles").select("id,display_name,role,avatar_url").in("role", ["player","educator"]).neq("id", myId).order("display_name"); setOpp(data || []); } catch(_){}
  }
  async function challenge(toId) {
    setPicking(false);
    const { data: r } = await sb.rpc("oxo_challenge", { p_from: myId, p_to: toId });
    if (r && r.ok) { try { await sb.from("notifications").insert({ user_id: toId, type: "xoxo", title: "\u{1F19A} Sfida XOXO!", body: "Ti hanno sfidato a XOXO" }); } catch(_){} load(); pugSound("success"); }
    else setMsg((r && r.error) || "Errore");
  }
  async function respond(m, accept) { const { data: r } = await sb.rpc("oxo_respond", { p_match: m.id, p_player: myId, p_accept: accept }); if (r && r.ok) load(); }
  async function move(m, cell) {
    const { data: r } = await sb.rpc("oxo_move", { p_match: m.id, p_player: myId, p_cell: cell + 1 });
    if (r && r.ok) { if (r.coin || r.xp) { setMsg("\u{1F3C6} Hai vinto!" + (r.coin ? " +" + r.coin + " \u{1FA99}" : "") + (r.xp ? " +" + r.xp + " XP" : "")); pugSound("success"); } load(); }
    else setMsg((r && r.error) || "");
  }
  const myMark = (m) => m.player_x === myId ? "x" : "o";
  const oppName = (m) => { const p = names[m.player_x === myId ? m.player_o : m.player_x]; return (p && p.display_name) || "\u2014"; };
  const Av = ({ id }) => { const p = names[id]; return p && p.avatar_url ? <img src={p.avatar_url} alt="" style={{width:22,height:22,borderRadius:"50%",objectFit:"cover",border:"2px solid #101010",verticalAlign:"middle",marginRight:6}}/> : <span style={{display:"inline-flex",width:22,height:22,borderRadius:"50%",border:"2px solid #101010",background:"#fff",alignItems:"center",justifyContent:"center",fontSize:11,verticalAlign:"middle",marginRight:6}}>👤</span>; };
  const oppId = (m) => m.player_x === myId ? m.player_o : m.player_x;
  const pending = matches.filter(m => m.status === "pending" && m.player_o === myId);
  const sent = matches.filter(m => m.status === "pending" && m.player_x === myId);
  const activeM = matches.filter(m => m.status === "active");
  const done = matches.filter(m => m.status === "done").slice(0, 5);

  if (active && active.status !== "declined") {
    const m = active; const mark = myMark(m); const myTurn = m.status === "active" && m.turn === mark;
    return (<div>
      <button className="btn btn-ghost btn-sm" onClick={() => { setActive(null); setMsg(""); }}>‹ Indietro</button>
      <div style={{ textAlign: "center", fontWeight: 800, margin: "8px 0" }}>Tu ({mark.toUpperCase()}) vs <Av id={oppId(m)}/>{oppName(m)}</div>
      <div style={{ textAlign: "center", fontWeight: 700, fontSize: 13, marginBottom: 10, color: m.status === "done" ? "#339966" : "#101010" }}>
        {m.status === "done" ? (m.winner === "draw" ? "Pareggio" : (m.winner === mark ? "\u{1F3C6} Hai vinto!" : "Hai perso")) : (myTurn ? "Tocca a te" : "Aspetta l'avversario\u2026")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,72px)", gap: 6, justifyContent: "center", margin: "0 auto", width: "fit-content" }}>
        {m.board.split("").map((c, i) => (
          <button key={i} disabled={!myTurn || c !== "."} onClick={() => move(m, i)}
            style={{ width: 72, height: 72, fontSize: 34, fontWeight: 900, border: "3px solid #101010", borderRadius: 10, background: c === "." ? "#fff" : (c === "x" ? "#A3CFFE" : "#FF6DEC"), color: "#101010", cursor: myTurn && c === "." ? "pointer" : "default" }}>
            {c === "." ? "" : c.toUpperCase()}
          </button>
        ))}
      </div>
      {msg && <div style={{ textAlign: "center", marginTop: 10, fontWeight: 800 }}>{msg}</div>}
    </div>);
  }
  return (<div>
    <button className="btn" style={{ width: "100%", background: "#FDEF26", color: "#101010", border: "3px solid #101010", boxShadow: "3px 3px 0 #101010", fontWeight: 900, padding: "12px", marginBottom: 12 }} onClick={() => setPicking(p => !p)}>➕ Nuova sfida</button>
    {picking && <div style={{ border: "2px solid #101010", borderRadius: 12, padding: 10, marginBottom: 12, maxHeight: 220, overflowY: "auto" }}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>Sfida chi?</div>
      {opp.map(o => (<button key={o.id} className="btn btn-ghost btn-sm" style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 4 }} onClick={() => challenge(o.id)}><span style={{display:"inline-flex",alignItems:"center",gap:8}}>{o.avatar_url ? <img src={o.avatar_url} alt="" style={{width:24,height:24,borderRadius:"50%",objectFit:"cover",border:"2px solid #101010"}}/> : <span style={{width:24,height:24,borderRadius:"50%",border:"2px solid #101010",display:"inline-flex",alignItems:"center",justifyContent:"center",background:"#fff",fontSize:13}}>{o.role === "educator" ? "🌱" : "👤"}</span>}{o.display_name}</span></button>))}
    </div>}
    {msg && <div style={{ marginBottom: 8, fontWeight: 700, fontSize: 13 }}>{msg}</div>}
    {pending.length > 0 && <div style={{ marginBottom: 12 }}><div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4 }}>Sfide ricevute</div>
      {pending.map(m => (<div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginBottom: 4 }}><span style={{ fontSize: 13 }}><Av id={oppId(m)}/>{oppName(m)} ti sfida</span><span><button className="btn btn-sm" style={{ background: "#339966", color: "#fff", marginRight: 4 }} onClick={() => respond(m, true)}>Accetta</button><button className="btn btn-ghost btn-sm" onClick={() => respond(m, false)}>Rifiuta</button></span></div>))}
    </div>}
    {activeM.length > 0 && <div style={{ marginBottom: 12 }}><div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4 }}>Partite in corso</div>
      {activeM.map(m => (<button key={m.id} className="btn btn-ghost btn-sm" style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 4 }} onClick={() => { setActive(m); setMsg(""); }}><Av id={oppId(m)}/>{oppName(m)} — {m.turn === myMark(m) ? "tocca a te" : "aspetta"}</button>))}
    </div>}
    {sent.length > 0 && <div style={{ marginBottom: 10, fontSize: 12, opacity: .7 }}>In attesa di risposta: {sent.map(m => oppName(m)).join(", ")}</div>}
    {wins.length > 0 && <div style={{ marginBottom: 12 }}><div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>🏆 Classifica vittorie</div>
      {wins.map((r, i) => (<div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, padding: "3px 0", borderBottom: "1px solid var(--border)" }}><span style={{ display: "flex", alignItems: "center" }}>{i+1}. {r.p && r.p.avatar_url ? <img src={r.p.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", border: "2px solid #101010", margin: "0 6px" }}/> : <span style={{ margin: "0 6px" }}>👤</span>}{(r.p && r.p.display_name) || "—"}</span><span style={{ fontWeight: 800 }}>{r.w}</span></div>))}
    </div>}
    {done.length > 0 && <div><div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4 }}>Ultime partite</div>
      {done.map(m => (<div key={m.id} style={{ fontSize: 12, padding: "3px 0", display:"flex", alignItems:"center" }}><Av id={oppId(m)}/>{oppName(m)}: {m.winner === "draw" ? "pareggio" : (m.winner === myMark(m) ? "vinta 🏆" : "persa")}</div>))}
    </div>}
  </div>);
}
function PongGame({ myId }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const g = useRef({ over: true });
  const [phase, setPhase] = useState("ready");
  const [score, setScore] = useState(0);
  const [result, setResult] = useState(null);
  const [board, setBoard] = useState([]);
  useEffect(() => { loadBoard(); return () => cancelAnimationFrame(rafRef.current); }, []);
  async function loadBoard() {
    try {
      const { data } = await sb.from("game_scores").select("score,player_id,profiles(display_name)").eq("game","pong").order("score",{ascending:false}).limit(40);
      const seen=new Set(); const top=[];
      (data||[]).forEach(r=>{ if(!seen.has(r.player_id)){ seen.add(r.player_id); top.push(r);} });
      setBoard(top.slice(0,8));
    } catch(_){}
  }
  function draw() {
    const c=canvasRef.current; if(!c) return; const ctx=c.getContext("2d"); const W=c.width,H=c.height; const s=g.current;
    ctx.fillStyle="#101010"; ctx.fillRect(0,0,W,H);
    ctx.fillStyle="#A3CFFE"; ctx.fillRect((s.px||W/2)-(s.pw||72)/2, H-22, s.pw||72, 12);
    if(s.bx!=null){ ctx.fillStyle="#FDEF26"; ctx.beginPath(); ctx.arc(s.bx,s.by,s.r,0,Math.PI*2); ctx.fill(); }
  }
  function step() {
    const c=canvasRef.current; if(!c) return; const W=c.width,H=c.height; const s=g.current;
    if(s.over) return;
    s.bx+=s.vx; s.by+=s.vy;
    if(s.bx<s.r){s.bx=s.r;s.vx=Math.abs(s.vx);}
    if(s.bx>W-s.r){s.bx=W-s.r;s.vx=-Math.abs(s.vx);}
    if(s.by<s.r){s.by=s.r;s.vy=Math.abs(s.vy);}
    const py=H-22;
    if(s.vy>0 && s.by>py-s.r && s.by<py+14 && s.bx>s.px-s.pw/2 && s.bx<s.px+s.pw/2){
      const rel=Math.max(-1,Math.min(1,(s.bx-s.px)/(s.pw/2)));
      s.speed+=0.75;
      const sp=7.5+s.speed*0.95;
      const ang=(-Math.PI/2)+rel*(Math.PI/3);
      s.vx=Math.cos(ang)*sp; s.vy=Math.sin(ang)*sp;
      if(s.vy>-2.5) s.vy=-2.5;
      s.score++; setScore(s.score); pugSound("coin");
    }
    if(s.by>H+s.r){ s.over=true; end(); return; }
    draw();
    rafRef.current=requestAnimationFrame(step);
  }
  function begin() {
    const c=canvasRef.current; if(!c) return; const W=c.width,H=c.height;
    g.current={ px:W/2, pw:72, bx:W/2, by:H/3, vx:4*(Math.random()>.5?1:-1), vy:7.5, r:9, speed:0, score:0, over:false };
    setScore(0); setResult(null); setPhase("playing");
    cancelAnimationFrame(rafRef.current); rafRef.current=requestAnimationFrame(step);
  }
  async function end() {
    cancelAnimationFrame(rafRef.current); setPhase("over"); pugSound("error");
    const fin=g.current.score;
    try { const { data:r } = await sb.rpc("pong_submit",{ p_player_id: myId, p_score: fin }); setResult(r||{score:fin,coins:0}); } catch(_){ setResult({score:fin,coins:0}); }
    loadBoard();
  }
  function movePaddle(clientX){
    const c=canvasRef.current; if(!c||g.current.over) return; const rect=c.getBoundingClientRect();
    const x=(clientX-rect.left)*(c.width/rect.width);
    g.current.px=Math.max(g.current.pw/2, Math.min(c.width-g.current.pw/2, x));
  }
  return (
    <div style={{textAlign:"center"}}>
      <canvas ref={canvasRef} width={320} height={430}
        style={{width:"100%",maxWidth:320,borderRadius:14,border:"3px solid #101010",touchAction:"none",background:"#101010",display:"block",margin:"0 auto"}}
        onMouseMove={e=>movePaddle(e.clientX)}
        onTouchStart={e=>{ movePaddle(e.touches[0].clientX); }}
        onTouchMove={e=>{ e.preventDefault(); movePaddle(e.touches[0].clientX); }}
      />
      <div style={{fontWeight:900,fontSize:20,margin:"8px 0"}}>Punti: {score}</div>
      {phase!=="playing" && <button className="btn" style={{background:"#FDEF26",color:"#101010",border:"3px solid #101010",boxShadow:"3px 3px 0 #101010",fontWeight:900,padding:"12px 24px",marginBottom:10}} onClick={begin}>{phase==="over"?"↻ Rigioca":"▶️ Gioca"}</button>}
      {result && <div style={{marginBottom:10,fontWeight:700,fontSize:14}}>Hai fatto {result.score} punti{result.coins>0?" · +"+result.coins+" 🪙":""}{result.best?" · record "+result.best:""}</div>}
      <div style={{textAlign:"left",marginTop:8,maxWidth:320,marginLeft:"auto",marginRight:"auto"}}>
        <div style={{fontWeight:800,marginBottom:6}}>🏆 Classifica</div>
        {board.length? board.map((r,i)=>(<div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"3px 0",borderBottom:"1px solid var(--border)"}}><span>{i+1}. {r.profiles?.display_name||"—"}</span><span style={{fontWeight:800}}>{r.score}</span></div>)) : <div style={{fontSize:12,opacity:.6}}>Ancora nessun punteggio</div>}
      </div>
      <div style={{fontSize:11,opacity:.65,marginTop:10}}>Trascina per muovere · +2 🪙 ogni 60 punti (max 20/giorno)</div>
    </div>
  );
}
function OwnReactions({ myId }) {
  const [count, setCount] = useState(0);
  const [byType, setByType] = useState({});
  const [vis, setVis] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const { data: rx } = await sb.from("reactions").select("player_id,type,created_at").eq("target_player_id", myId).is("badge_id", null).order("created_at",{ascending:false}).limit(100);
        const rxs = rx||[];
        setCount(rxs.length);
        const bt = {}; rxs.forEach(r=>{bt[r.type]=(bt[r.type]||0)+1;}); setByType(bt);
        const ids=[...new Set(rxs.map(r=>r.player_id))].slice(0,12);
        if (ids.length){ const { data: gs } = await sb.from("profiles").select("id,display_name,avatar_url").in("id", ids); const gm=Object.fromEntries((gs||[]).map(g=>[g.id,g])); const seen=new Set(); const v=[]; for(const r of rxs){const g=gm[r.player_id]; if(g&&!seen.has(g.id)){seen.add(g.id);v.push(g);} if(v.length>=12)break;} setVis(v); }
      } catch(_){}
    })();
  }, [myId]);
  return (
    <div style={{textAlign:"center"}}>
      <div style={{fontWeight:900,fontSize:18,marginBottom:6}}>💥 {count} reaction ricevute</div>
      <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap",marginBottom:12}}>
        {Object.entries(byType).map(([t,n])=>(<span key={t} style={{fontWeight:700,fontSize:15}}>{t} {n}</span>))}
      </div>
      <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>👋 Passati a trovarti</div>
      <div style={{display:"flex",justifyContent:"center",flexWrap:"wrap"}}>
        {vis.length ? vis.map((v,i)=>(v.avatar_url
          ? <img key={i} src={v.avatar_url} alt="" title={v.display_name} style={{width:36,height:36,borderRadius:"50%",border:"2px solid #101010",marginLeft:i?-8:0,objectFit:"cover"}}/>
          : <span key={i} title={v.display_name} style={{width:36,height:36,borderRadius:"50%",border:"2px solid #101010",marginLeft:i?-8:0,background:"#fff",display:"inline-flex",alignItems:"center",justifyContent:"center"}}>🙂</span>
        )) : <span style={{fontSize:12,opacity:.6}}>Ancora nessuna visita</span>}
      </div>
    </div>
  );
}
function ProfileReactions({ targetId, myId, myName }) {
  const REACTS = ["❤️","🔥","👏","🤩","💪"];
  const [counts, setCounts] = useState({});
  const [mine, setMine] = useState(null);
  const [mineId, setMineId] = useState(null);

  useEffect(() => {
    sb.from("reactions").select("type").eq("target_player_id", targetId).is("badge_id", null)
      .then(({ data }) => {
        const c = {};
        (data||[]).forEach(r => { c[r.type] = (c[r.type]||0)+1; });
        setCounts(c);
      });
    const _ts = new Date(); _ts.setHours(0,0,0,0);
    sb.from("reactions").select("id,type").eq("player_id", myId).eq("target_player_id", targetId).is("badge_id", null).gte("created_at", _ts.toISOString()).order("created_at",{ascending:false}).limit(1).maybeSingle()
      .then(({ data }) => { if (data) { setMine(data.type); setMineId(data.id); } else { setMine(null); setMineId(null); } })
      .catch(()=>{});
  }, [targetId, myId]);

  async function react(type) {
    // Cumulativa: max 1 reaction al giorno per giocatore; le reaction dei giorni precedenti restano.
    if (mineId && mine === type) {
      await sb.from("reactions").delete().eq("id", mineId);
      setCounts(p => ({...p, [type]: Math.max(0,(p[type]||1)-1)}));
      setMine(null); setMineId(null);
    } else if (mineId) {
      await sb.from("reactions").update({ type }).eq("id", mineId);
      if (mine) setCounts(p => ({...p, [mine]: Math.max(0,(p[mine]||1)-1)}));
      setCounts(p => ({...p, [type]: (p[type]||0)+1}));
      setMine(type);
      playPixel("msg"); if(navigator.vibrate) navigator.vibrate(30);
    } else {
      const { data } = await sb.from("reactions").insert({ player_id:myId, target_player_id:targetId, badge_id:null, type }).select("id").single();
      try { await sb.from("notifications").insert({ user_id: targetId, type:"reaction", title:"💥 Nuova reaction!", body:(myName||"Un giocatore")+" ti ha lasciato "+type }); } catch(_){}
      setCounts(p => ({...p, [type]: (p[type]||0)+1}));
      setMine(type); setMineId(data?.id || "x");
      playPixel("msg"); if(navigator.vibrate) navigator.vibrate(30);
    }
  }

  const total = Object.values(counts).reduce((a,b)=>a+b,0);

  return (
    <div style={{marginTop:12}}>
      <div style={{fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:".1em",opacity:.6,marginBottom:8}}>
        {total > 0 ? `${total} reaction` : "Manda una reaction!"}
      </div>
      <div style={{display:"flex",justifyContent:"center",gap:8,flexWrap:"wrap"}}>
        {REACTS.map(r => {
          const count = counts[r]||0;
          const isMe = mine===r;
          return (
            <button key={r} onClick={()=>react(r)} className={`chip ${isMe?"active":""}`}
              style={{fontSize:18,padding:"6px 12px",display:"flex",alignItems:"center",gap:5}}>
              {r}
              {count>0 && <span style={{fontSize:11,fontWeight:800}}>{count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── COMMUNITY TAB + REACTIONS ───────────────────────────
function CommunityTab({ players, myId, myProfile }) {
  const [selected, setSelected] = useState(null);
  const [playerBadges, setPlayerBadges] = useState([]);
  const [playerXP, setPlayerXP] = useState(0);
  const [reactions, setReactions] = useState({});
  const [myReactions, setMyReactions] = useState({});
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [search, setSearch] = useState("");
  const REACT_TYPES = ["❤️","🔥","👏","😮","⭐"];

  const others = players
    .filter(p=>(p.xp||0)>=0)
    .filter(p=>!search || p.display_name.toLowerCase().includes(search.toLowerCase()))
    .sort((a,b)=>(b.xp||0)-(a.xp||0));

  async function openPlayer(p) {
    setSelected(p); setLoadingProfile(true);
    const [{ data: badges }, { data: rxns }, { data: mine }] = await Promise.all([
      sb.from("player_badges").select("id,badge_id,badges(name,icon),created_at").eq("player_id", p.id).order("created_at",{ascending:false}),
      sb.from("reactions").select("badge_id,type").eq("target_player_id", p.id),
      sb.from("reactions").select("badge_id,type").eq("player_id", myId).eq("target_player_id", p.id),
    ]);
    const rxMap = {};
    (rxns||[]).forEach(r => { if (!rxMap[r.badge_id]) rxMap[r.badge_id] = {}; rxMap[r.badge_id][r.type] = (rxMap[r.badge_id][r.type]||0)+1; });
    const myMap = {};
    (mine||[]).forEach(r => { myMap[r.badge_id] = r.type; });
    setPlayerBadges(badges||[]); setReactions(rxMap); setMyReactions(myMap);
    setLoadingProfile(false);
  }

  async function react(badgeId, type) {
    const current = myReactions[badgeId];
    if (current === type) {
      await sb.from("reactions").delete().eq("player_id", myId).eq("badge_id", badgeId);
      setMyReactions(p=>({...p,[badgeId]:null}));
      setReactions(p=>({...p,[badgeId]:{...p[badgeId],[type]:Math.max(0,(p[badgeId]?.[type]||1)-1)}}));
    } else {
      await sb.from("reactions").upsert({player_id:myId,target_player_id:selected.id,badge_id:badgeId,type},{onConflict:"player_id,badge_id"});
      const prev = myReactions[badgeId];
      setMyReactions(p=>({...p,[badgeId]:type}));
      setReactions(p=>({...p,[badgeId]:{...p[badgeId],[type]:(p[badgeId]?.[type]||0)+1,...(prev?{[prev]:Math.max(0,(p[badgeId]?.[prev]||1)-1)}:{})}}));
      playPixel("msg");
      if(navigator.vibrate) navigator.vibrate(30);
      // Push al proprietario del badge
      if (selected.id !== myId) {
        const badge = playerBadges.find(pb=>pb.id===badgeId);
        sendPush(selected.id, `${type} Reaction sul tuo badge!`, `Hai ricevuto una reaction su "${badge?.badges?.name||"Badge"}"`).catch(()=>{});
      }
    }
  }

  if (selected) {
    const lv = getLevel(selected.xp||0);
    return (
      <div>
        <div className="chiprow">
          <button className="chip" onClick={()=>setSelected(null)}>← Torna alla community</button>
        </div>

        {/* Scheda giocatore */}
        <div className="card" style={{textAlign:"center"}}>
          <div style={{width:84,height:84,borderRadius:"50%",overflow:"hidden",border:"3px solid #101010",margin:"0 auto 10px",boxShadow:"3px 3px 0 rgba(0,0,0,.28)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Avatar url={selected.avatar_url} emoji={lv.emoji} size={84}/>
          </div>
          <div style={{fontFamily:"'Funnel Display',sans-serif",fontWeight:800,fontSize:26,textTransform:"uppercase",lineHeight:1}}>{selected.display_name}</div>
          <div className="psb" style={{marginTop:4}}>{lv.emoji} {lv.name} · ⭐ {selected.xp} XP</div>
          {selected.squads?.name && (
            <div style={{marginTop:8}}>
              <span className="me-badge" style={{marginLeft:0}}>🛡️ {selected.squads.name}</span>
            </div>
          )}
          {/* Profile reactions */}
          {selected.id === myId ? <OwnReactions myId={myId}/> : <ProfileReactions targetId={selected.id} myId={myId} myName={myProfile?.display_name}/>}
        </div>

        {loadingProfile ? <div className="loading">⏳</div> : (
          <div className="card">
            <div className="tape" style={{background:"#FF6DEC",color:"#101010"}}>🎖️ Badge — reagisci!</div>
            {playerBadges.length===0
              ? <div className="empty">Nessun badge ancora.</div>
              : playerBadges.map(pb=>{
                  const rxns = reactions[pb.id]||{};
                  const myR = myReactions[pb.id];
                  const total = Object.values(rxns).reduce((a,b)=>a+b,0);
                  return (
                    <div key={pb.id} className="prow" style={{margin:"0 0 8px",boxShadow:"none",borderWidth:"2.5px",flexWrap:"wrap"}}>
                      <span className="pav">{pb.badges?.icon||"🎖️"}</span>
                      <div>
                        <div className="pnm">{pb.badges?.name}</div>
                        <div className="psb">{new Date(pb.created_at).toLocaleDateString("it-IT",{day:"numeric",month:"short",year:"numeric"})}</div>
                      </div>
                      {total > 0 && <span className="psb" style={{marginLeft:"auto"}}>{total} reaction</span>}
                      <div style={{width:"100%",display:"flex",gap:6,flexWrap:"wrap",marginTop:8}}>
                        {REACT_TYPES.map(r=>{
                          const count = rxns[r]||0;
                          const isMe = myR===r;
                          return (
                            <button key={r} onClick={()=>react(pb.id,r)} className={`chip ${isMe?"active":""}`}
                              style={{fontSize:16,padding:"4px 10px",display:"flex",alignItems:"center",gap:5}}>
                              {r}
                              {count>0&&<span style={{fontSize:11,fontWeight:800}}>{count}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="tape" style={{background:"#D41323",color:"#fff"}}>👥 Community</div>
        <div className="msgbar" style={{margin:"14px 0 10px"}}>
          <input className="comm-search" placeholder="🔍 Cerca giocatore…" value={search} onChange={e=>setSearch(e.target.value)}/>
        </div>
        {others.length===0
          ? <div className="empty" style={{padding:24,textAlign:"center"}}>
              <div style={{fontSize:36,marginBottom:8}}>🌱</div>
              <div style={{fontWeight:700,marginBottom:4}}>Nessun giocatore</div>
              <div style={{fontSize:12}}>Prova a cambiare la ricerca</div>
            </div>
          : <div className="comm-grid">{others.map((p,i)=>{
              const lv = getLevel(p.xp||0);
              return (
                <div key={p.id} className="comm-tile" onClick={()=>openPlayer(p)}>
                  {i<3 && <span className="comm-medal">{["🥇","🥈","🥉"][i]}</span>}
                  <div className="comm-av">
                    {p.avatar_url
                      ? <img src={p.avatar_url} alt="" className="comm-av-img"/>
                      : <span className="comm-av-emoji">{lv.emoji}</span>}
                  </div>
                  <div className="comm-nm">{p.display_name}</div>
                  {p.first_name && <div style={{fontSize:11,opacity:.7,fontWeight:600,marginTop:1}}>{p.first_name}</div>}
                  <div className="comm-xp">⭐ {p.xp||0} XP · Lv {lv.name}</div>
                </div>
              );
          })}</div>
        }
      </div>
    </div>
  );
}


// ─── XP HISTORY CHART ────────────────────────────────────
function XPHistoryChart({ playerId }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const since = new Date(Date.now()-30*86400000).toISOString();
    sb.from("xp_history").select("xp_gained,xp_total,reason,created_at")
      .eq("player_id", playerId).gte("created_at", since)
      .order("created_at", {ascending:true})
      .then(({ data: rows }) => {
        // Aggregate by day
        const byDay = {};
        (rows||[]).forEach(r => {
          const day = r.created_at.slice(0,10);
          byDay[day] = (byDay[day]||0) + r.xp_gained;
        });
        // Last 14 days
        const days = [];
        for (let i=13; i>=0; i--) {
          const d = new Date(Date.now()-i*86400000);
          const key = localDateStr(d);
          days.push({ label: d.toLocaleDateString("it-IT",{day:"numeric",month:"short"}), xp: byDay[key]||0, key });
        }
        setData(days); setLoading(false);
      }).catch(()=>setLoading(false));
  }, [playerId]);

  if (loading) return <div style={{padding:12,textAlign:"center",fontSize:12,color:"var(--text3)"}}>⏳</div>;
  if (data.every(d=>d.xp===0)) return <div className="empty" style={{padding:12}}>Nessuna attività nelle ultime 2 settimane.</div>;

  const max = Math.max(...data.map(d=>d.xp), 1);
  return (
    <div style={{marginTop:8}}>
      <div style={{display:"flex",alignItems:"flex-end",gap:3,height:80}}>
        {data.map(d=>(
          <div key={d.key} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
            <div style={{fontSize:8,color:"var(--text3)",fontWeight:700,opacity:d.xp>0?1:.3}}>{d.xp>0?`+${d.xp}`:""}</div>
            <div style={{
              width:"100%",borderRadius:"3px 3px 0 0",
              height:`${Math.max((d.xp/max)*60,d.xp>0?4:0)}px`,
              background:d.xp>0?"var(--azzurro))":"rgba(255,255,255,.06)",
              transition:"height .3s ease",
            }}/>
          </div>
        ))}
      </div>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
        <span style={{fontSize:8,color:"var(--text3)"}}>{data[0]?.label}</span>
        <span style={{fontSize:8,color:"var(--text3)"}}>{data[data.length-1]?.label}</span>
      </div>
    </div>
  );
}


// ─── NOTIFICATION TOGGLE ────────────────────────────────
function NotificationToggle({ playerId }) {
  const [status, setStatus] = useState("unknown");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      if (!("Notification" in window)) { setStatus("unsupported"); return; }
      setStatus(Notification.permission);
    } catch(_) { setStatus("unsupported"); }
  }, []);

  async function requestPermission() {
    setLoading(true);
    // Diagnostica completa
    const isStandalone = window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
    const hasSW = 'serviceWorker' in navigator;
    const hasPush = 'PushManager' in window;
    const hasNotif = 'Notification' in window;
    if (!hasSW || !hasPush || !hasNotif) {
      const missing = [!hasSW&&'SW',!hasPush&&'Push',!hasNotif&&'Notif'].filter(Boolean).join(',');
      addToast(`⚠️ Mancante: ${missing} — standalone:${isStandalone}`, 'error');
      setStatus("unsupported"); setLoading(false); return;
    }
    try {
      const perm = await Notification.requestPermission();
      setStatus(perm);
      if (perm === "granted") {
        await registerPush(playerId);
        setStatus("granted");
      } else {
        addToast("⚠️ Permesso negato", "error");
      }
    } catch(e) {
      addToast("⚠️ Errore: "+e.message, "error");
    }
    setLoading(false);
  }

  if (status === "unsupported") return null;

  const isGranted = status === "granted";
  const isDenied  = status === "denied";

  return (
    <div style={{
      background:"rgba(255,255,255,.04)",border:"1px solid var(--border)",
      borderRadius:14,padding:"12px 14px",marginBottom:10,
      display:"flex",alignItems:"center",gap:12,
    }}>
      <span style={{fontSize:22,flexShrink:0}}>{isGranted?"🔔":"🔕"}</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>Notifiche push</div>
        <div style={{fontSize:11,color:"var(--text3)",marginTop:1}}>
          {isGranted ? "Attive — ricevi avvisi in tempo reale" :
           isDenied  ? "Bloccate — attivale nelle impostazioni del telefono" :
           "Ricevi notifiche per badge, messaggi e prenotazioni"}
        </div>
      </div>
      {!isGranted && !isDenied && (
        <button onClick={requestPermission} disabled={loading}
          style={{
            background:"var(--azzurro))",
            border:"none",borderRadius:99,padding:"8px 14px",
            color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",
            whiteSpace:"nowrap",flexShrink:0,
          }}>
          {loading?"⏳":"Attiva"}
        </button>
      )}
      {isGranted && (
        <div style={{width:10,height:10,borderRadius:"50%",background:"var(--neon-green)",flexShrink:0,boxShadow:"0 0 8px var(--neon-green)"}}/>
      )}
      {isDenied && (
        <div style={{fontSize:11,color:"var(--danger)",flexShrink:0,fontWeight:700}}>Bloccate</div>
      )}
    </div>
  );
}


// ─── IN-APP NOTIFICATION ─────────────────────────────────
let _showInApp = null;
function showInAppNotif(title, body) { if (_showInApp) _showInApp(title, body); }

function InAppNotifBanner() {
  const [notif, setNotif] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    _showInApp = (title, body) => {
      setNotif({ title, body });
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setNotif(null), 4000);
    };
    return () => { _showInApp = null; clearTimeout(timerRef.current); };
  }, []);

  if (!notif) return null;

  return (
    <div onClick={()=>setNotif(null)} style={{
      position:"fixed",top:0,left:0,right:0,zIndex:9999,
      padding:"max(env(safe-area-inset-top,12px),12px) 16px 14px",
      background:"rgba(18,18,18,.97)",
      borderBottom:"2px solid var(--neon-blue)",
      boxShadow:"0 4px 24px rgba(0,0,0,.5)",
      display:"flex",alignItems:"center",gap:12,
      animation:"slideDown .3s cubic-bezier(.34,1.56,.64,1)",
      cursor:"pointer",
    }}>
      <style>{`@keyframes slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}`}</style>
      <div style={{width:40,height:40,borderRadius:12,background:"rgba(163,207,254,.15)",border:"1px solid rgba(163,207,254,.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
        {notif.title.startsWith("💬") ? "💬" : notif.title.startsWith("📢") ? "📢" : "🔔"}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:700,color:"#fff",marginBottom:2}}>{notif.title}</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,.6)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{notif.body}</div>
      </div>
      <div style={{fontSize:11,color:"rgba(255,255,255,.3)",flexShrink:0}}>tocca per chiudere</div>
    </div>
  );
}

// ─── LEVEL UP ANIMATION ──────────────────────────────────
function LevelUpOverlay({ oldLevel, newLevel, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  useEffect(() => { try { playPixel("levelup"); } catch(_){} }, []);
  // Foglie e petali che cadono ondeggiando (effetto floreale celebrativo)
  const leafColors = ["#339966","#3ddc84","#7CFC00","#FDEF26","#FF6DEC","#FF6DEC"];
  const particles = Array.from({length:34},(_,i)=>({
    id:i, left:Math.random()*100, delay:Math.random()*1.8, dur:2.6+Math.random()*2.2,
    color:leafColors[i%6], size:10+Math.random()*14, rot:(Math.random()*720-360)+"deg",
    scale:0.7+Math.random()*0.8, leaf:i%2===0,
  }));
  return (
    <div onClick={onDone} style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,.88)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
      <style>{`
        @keyframes cffall{0%{transform:translateY(-10px) rotate(0);opacity:1}100%{transform:translateY(105vh) rotate(540deg);opacity:0}}
        @keyframes lvlpop{0%{transform:scale(0) rotate(-8deg);opacity:0}60%{transform:scale(1.15) rotate(2deg)}100%{transform:scale(1);opacity:1}}
        @keyframes lvlshine{0%{transform:translateX(-100%) skew(-15deg)}100%{transform:translateX(300%) skew(-15deg)}}
        @keyframes pulse2{0%,100%{opacity:1}50%{opacity:.6}}
      `}</style>
      {particles.map(p=>(
        <div key={p.id} style={{position:"absolute",top:-20,left:`${p.left}%`,animation:`leaffall ${p.dur}s ${p.delay}s ease-in infinite`,["--r"]:p.rot,["--s"]:p.scale}}>
          <div style={{animation:`leafsway ${1.2+Math.random()}s ease-in-out infinite`,fontSize:p.size,filter:"drop-shadow(0 0 4px rgba(51,153,102,.4))"}}>
            {p.leaf ? "🍃" : "🌸"}
          </div>
        </div>
      ))}
      <div style={{background:"#161616",border:"2px solid rgba(253,239,38,.5)",borderRadius:28,padding:"40px 48px",textAlign:"center",animation:"lvlpop .6s cubic-bezier(.34,1.56,.64,1) forwards",position:"relative",overflow:"hidden",maxWidth:340,width:"90%",boxShadow:"0 0 60px rgba(253,239,38,.25)"}}>
        <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,background:"linear-gradient(105deg,transparent 40%,rgba(255,255,255,.1) 50%,transparent 60%)",animation:"lvlshine 2.5s .6s ease-in-out infinite"}}/>
        <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:11,fontWeight:900,textTransform:"uppercase",letterSpacing:".2em",color:"rgba(255,255,255,.4)",marginBottom:8}}>🌿 SEI CRESCIUTO! 🌿</div>
        <div style={{fontSize:76,lineHeight:1,marginBottom:10,filter:"drop-shadow(0 0 16px rgba(253,239,38,.5))"}}>{newLevel.emoji}</div>
        <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:34,fontWeight:900,textTransform:"uppercase",background:"#FDEF26",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:6}}>{newLevel.name}</div>
        <div style={{fontSize:13,color:"rgba(255,255,255,.5)",marginBottom:20}}>Hai sbloccato il livello <strong style={{color:"#FDEF26"}}>{newLevel.name}</strong>!</div>
        <div style={{display:"flex",justifyContent:"center",gap:24,marginBottom:18}}>
          <div style={{textAlign:"center",opacity:.6}}><div style={{fontSize:11,color:"rgba(255,255,255,.4)",marginBottom:4}}>PRIMA</div><div style={{fontSize:20}}>{oldLevel.emoji}</div><div style={{fontSize:11,color:"rgba(255,255,255,.4)"}}>{oldLevel.name}</div></div>
          <div style={{display:"flex",alignItems:"center",fontSize:18,color:"#FDEF26"}}>→</div>
          <div style={{textAlign:"center"}}><div style={{fontSize:11,color:"#FDEF26",marginBottom:4,fontWeight:700}}>ORA</div><div style={{fontSize:24}}>{newLevel.emoji}</div><div style={{fontSize:13,color:"#FDEF26",fontWeight:700}}>{newLevel.name}</div></div>
        </div>
        <div style={{fontSize:10,color:"rgba(255,255,255,.2)",animation:"pulse2 2s infinite"}}>Tocca per continuare</div>
      </div>
    </div>
  );
}

// Barra livello animata: all'apertura si riempie da 0 al valore reale
// con un "baing"; quando gli XP aumentano, fa un guizzo. Estetica
// volutamente semplice (le grafiche definitive cambieranno solo i colori).
function AnimatedLevelBar({ xp, lv }) {
  const nextLv = LEVELS.find(l => l.xp > (xp || 0));
  const target = nextLv ? Math.min(100, Math.round(((xp - lv.xp) / (nextLv.xp - lv.xp)) * 100)) : 100;
  const remaining = nextLv ? Math.max(0, nextLv.xp - xp) : 0;
  const [width, setWidth] = useState(0);
  const [shownPct, setShownPct] = useState(0);
  const [bump, setBump] = useState(false);
  const prevXp = useRef(null);

  // Conta la percentuale a schermo da 0 al target (effetto "tachimetro")
  function countTo(to) {
    let cur = 0;
    const step = Math.max(1, Math.round(to / 28));
    const iv = setInterval(() => {
      cur += step;
      if (cur >= to) { cur = to; clearInterval(iv); }
      setShownPct(cur);
    }, 22);
  }

  // Riempimento all'apertura (una volta) + baing + conteggio
  useEffect(() => {
    const t1 = setTimeout(() => { setWidth(target); countTo(target); }, 300);
    const t2 = setTimeout(() => { try { playPixel("levelfill"); } catch(_){} }, 340);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []); // solo al mount

  // Guizzo + ri-conteggio quando gli XP aumentano durante l'uso
  useEffect(() => {
    if (prevXp.current !== null && xp > prevXp.current) {
      setWidth(target); countTo(target);
      setBump(true);
      try { playPixel("xp"); } catch(_){}
      const t = setTimeout(() => setBump(false), 900);
      return () => clearTimeout(t);
    }
    prevXp.current = xp;
  }, [xp, target]);

  return (
    <div>
      {/* header camerino: albero + livello, percentuale grande a destra */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',marginBottom:6}}>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <span style={{fontSize:26,lineHeight:1}}>{lv.emoji}</span>
          <span style={{fontWeight:800,fontSize:17,textTransform:'uppercase'}}>{lv.name}</span>
        </div>
        <div style={{fontWeight:800,fontSize:36,lineHeight:.85}}>{shownPct}<small style={{fontSize:17}}>%</small></div>
      </div>

      {/* barra camerino: terra + crescita + germoglio/fioritura */}
      <div className="pug-lvltrack">
        <div className={"pug-lvlgrow"+(bump?" bloomed":"")} style={{width:width+'%'}}>
          <span className="pug-lvltip">🌱</span>
          <span className="pug-lvlbloom">🌸</span>
        </div>
      </div>

      {/* mancano X XP + prossimo stadio, stile camerino */}
      {nextLv ? (
        <div className="pug-lvlrem">
          <span>Ti mancano <b>{remaining} XP</b></span>
          <span className="goal">{nextLv.emoji} {nextLv.name}</span>
        </div>
      ) : (
        <div className="pug-lvlrem"><span className="goal">🏆 Livello massimo</span></div>
      )}
    </div>
  );
}

function PlayerDashboard({ profile, onLogout, sectionColors }) {
  const [tab, setTab] = useState("profilo");
  const [fullProfile, setFullProfile] = useState(profile);
  const [badges, setBadges] = useState([]);
  const [activities, setActivities] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [messages, setMessages] = useState([]);
  const [players, setPlayers] = useState([]);
  const [xpToday, setXpToday] = useState({});
  const [xpMonth, setXpMonth] = useState({});
  const [qrInput, setQrInput] = useState("");
  const [qrMsg, setQrMsg] = useState("");
  const [qrCelebration, setQrCelebration] = useState(null);
  const [showCamera, setShowCamera] = useState(false);
  const [toast, setToast] = useState(null);
  const [monthPresences, setMonthPresences] = useState(null);
  const [monthTarget, setMonthTarget] = useState(null);
  const [actBookingCounts, setActBookingCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(false);
  const hasDataRef = useRef(false); // true dopo il primo load riuscito
  const [visConfig, setVisConfig] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pug_visibility")||"{}"); } catch(_) { return {}; }
  });
  const [visReady, setVisReady] = useState(false);
  const [levelUpData, setLevelUpData] = useState(null);


  // Carica visibilità PRIMA di mostrare qualsiasi cosa
  useEffect(() => {
    let alive = true;
    const applyCfg = (cfg) => {
      if (alive && cfg && typeof cfg === "object") {
        localStorage.setItem("pug_visibility", JSON.stringify(cfg));
        setVisConfig(cfg);
      }
    };
    const refetch = async () => {
      try {
        const { data } = await sb.from("profiles").select("app_config")
          .eq("id", "00000000-0000-0000-0000-000000000099").single();
        applyCfg(data?.app_config);
      } catch(_) {}
    };
    fetchVisibilityConfig().then(applyCfg).catch(() => {}).finally(() => { if (alive) setVisReady(true); });
    const ch = sb.channel("vis-config-" + Math.random().toString(36).slice(2))
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: "id=eq.00000000-0000-0000-0000-000000000099" },
        (payload) => applyCfg(payload?.new?.app_config))
      .subscribe();
    const onFocus = () => { if (document.visibilityState === "visible") refetch(); };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      try { sb.removeChannel(ch); } catch(_) {}
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  const [editingFirstName, setEditingFirstName] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [lbTimeFilter, setLbTimeFilter] = useState("generale");
  const [selectedBadge, setSelectedBadge] = useState(null);
  const [mustChangePin, setMustChangePin] = useState(profile._mustChangePin === true || profile.pin === "1234");
  // Tema a 3 stati: "auto" (segue il sistema) · "light" · "dark".
  // Default al primo avvio: "auto".
  const [themeChoice, setThemeChoice] = useState(() => localStorage.getItem("pug_theme") || "auto");
  const [soundOn, setSoundOn] = useState(() => (typeof localStorage!=="undefined" && localStorage.getItem("pug_sound")!=="off"));
  const [nextSlot, setNextSlot] = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [creatureBars, setCreatureBars] = useState(null);
  const [visitors, setVisitors] = useState([]);
  const [reactionsReceived, setReactionsReceived] = useState(0);
  const [visIdx, setVisIdx] = useState(0);
  useEffect(() => {
    if (visitors.length <= 1) { setVisIdx(0); return; }
    const t = setInterval(() => setVisIdx(i => (i + 1) % visitors.length), 2600);
    return () => clearInterval(t);
  }, [visitors.length]);
  const [selectedFood, setSelectedFood] = useState(0);
  const [feeding, setFeeding] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const [burp, setBurp] = useState(false);
  const [feedAnim, setFeedAnim] = useState(false);
  const [showGames, setShowGames] = useState(false);
  const [gamesTab, setGamesTab] = useState("pong");
  const [feedMsg, setFeedMsg] = useState("");
  const FOODS = [
    { name:"Muffin", emoji:"🧁", img:"data:image/webp;base64,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" },
    { name:"Pasta al pesto", emoji:"🍝", img:"data:image/webp;base64,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" },
    { name:"Insalata", emoji:"🥗", img:"data:image/webp;base64,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" },
    { name:"Sushi", emoji:"🍣", img:"data:image/webp;base64,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" },
  ];
  async function feedPet() {
    if (feeding) return;
    setFeeding(true);
    setPopKey(k => k + 1); setFeedAnim(true); setBurp(false);
    pugSound("coin"); if (navigator.vibrate) navigator.vibrate(35);
    setTimeout(() => setFeedAnim(false), 1150);
    setTimeout(() => setBurp(true), 1250);
    setTimeout(() => setBurp(false), 3750);
    const { data: r, error } = await sb.rpc("pug_feed", { p_player_id: fullProfile.id, p_food: FOODS[selectedFood]?.name || null });
    setFeeding(false);
    if (!error && r?.ok) {
      setCreatureBars(b => ({ ...(b||{}), energia: r.energia }));
      if (r.sazio) { setFeedMsg("😋 Sazio!"); setTimeout(()=>setFeedMsg(""), 2000); }
    } else {
      pugSound("error"); setFeedMsg(r?.error || error?.message || "Errore"); setTimeout(()=>setFeedMsg(""), 2800);
    }
  }
  useEffect(() => {
    if (!fullProfile?.id) return;
    let alive = true;
    (async () => {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7*86400000);
      const weekAgoDate = weekAgo.toISOString().slice(0,10);
      const weekAgoISO = weekAgo.toISOString();
      const today = localToday();
      try {
        const { data: bks } = await sb.from("bigtop_bookings").select("status, bigtop_slots(date,start_time,end_time,cancelled_at)").eq("player_id", fullProfile.id);
        const up = (bks||[])
          .filter(x => x.bigtop_slots && !x.bigtop_slots.cancelled_at && x.status !== "cancelled" && x.bigtop_slots.date >= today)
          .map(x => x.bigtop_slots)
          .sort((a,b) => (a.date+a.start_time).localeCompare(b.date+b.start_time));
        if (alive) setNextSlot(up[0] || null);
      } catch(_) { if (alive) setNextSlot(null); }
      try {
        const [att, xph, pb] = await Promise.all([
          sb.from("attendances").select("id").eq("player_id", fullProfile.id).gte("date", weekAgoDate).neq("status","none"),
          sb.from("xp_history").select("xp_gained").eq("player_id", fullProfile.id).gte("created_at", weekAgoISO),
          sb.from("player_badges").select("id").eq("player_id", fullProfile.id).gte("assigned_at", weekAgoISO),
        ]);
        const xpSum = (xph.data||[]).reduce((sm,r)=> sm + (r.xp_gained||0), 0);
        if (alive) setWeekly({ presenze: (att.data||[]).length, xp: xpSum, badge: (pb.data||[]).length });
      } catch(_) { if (alive) setWeekly(null); }
      try {
        const w14 = new Date(now.getTime() - 14*86400000).toISOString().slice(0,10);
        const w21 = new Date(now.getTime() - 21*86400000).toISOString();
        const daysAgo = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime())/86400000));
        const [pres, lab, bt, rx] = await Promise.all([
          sb.from("attendances").select("date").eq("player_id", fullProfile.id).gte("date", w14).neq("status","none"),
          sb.from("bookings").select("created_at").eq("player_id", fullProfile.id).gte("created_at", w21),
          sb.from("bigtop_bookings").select("created_at,status").eq("player_id", fullProfile.id).gte("created_at", w21),
          sb.from("reactions").select("created_at").eq("target_player_id", fullProfile.id).is("badge_id", null).gte("created_at", w21),
        ]);
        const clampV = (v) => Math.max(5, Math.min(100, Math.round(v)));
        let fel = 5; (pres.data||[]).forEach(r => { fel += 25 * Math.pow(0.93, daysAgo(r.date)); });
        let soc = 5;
        (lab.data||[]).forEach(r => { soc += 15 * Math.pow(0.92, daysAgo(r.created_at)); });
        (bt.data||[]).filter(r => r.status !== "cancelled").forEach(r => { soc += 10 * Math.pow(0.92, daysAgo(r.created_at)); });
        (rx.data||[]).forEach(r => { soc += 8 * Math.pow(0.92, daysAgo(r.created_at)); });
        try {
          const [{ data: xm }, { data: pg }] = await Promise.all([
            sb.from("oxo_matches").select("winner,player_x,player_o,status,updated_at").or("player_x.eq." + fullProfile.id + ",player_o.eq." + fullProfile.id),
            sb.from("game_scores").select("score,created_at").eq("player_id", fullProfile.id).eq("game","pong"),
          ]);
          (xm||[]).forEach(m => {
            const d = daysAgo(m.updated_at);
            if (m.status === "active" || m.status === "done") soc += 3 * Math.pow(0.92, d);
            const iWon = m.status === "done" && ((m.winner === "x" && m.player_x === fullProfile.id) || (m.winner === "o" && m.player_o === fullProfile.id));
            if (iWon) fel += 4 * Math.pow(0.93, d);
          });
          const pgSorted = (pg||[]).slice().sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
          let bestSoFar = -1;
          pgSorted.forEach(r => { const sc = r.score||0; if (sc > bestSoFar) { bestSoFar = sc; fel += 5 * Math.pow(0.93, daysAgo(r.created_at)); } });
        } catch(_) {}
        let ene = 100;
        try { const { data: me } = await sb.from("profiles").select("energia,energia_at").eq("id", fullProfile.id).single(); if (me?.energia != null) { ene = me.energia_at ? Math.max(5, Math.round(me.energia - 15 * ((Date.now()-new Date(me.energia_at).getTime())/86400000))) : me.energia; } } catch(_) {}
        if (alive) setCreatureBars({ felicita: clampV(fel), socialita: clampV(soc), energia: ene });
      } catch(_) {}
      try {
        const { data: rx } = await sb.from("reactions").select("player_id,type,created_at").eq("target_player_id", fullProfile.id).is("badge_id", null).order("created_at",{ascending:false}).limit(50);
        const rxs = rx||[];
        const _t0 = new Date(); _t0.setHours(0,0,0,0);
        const giverIds = [...new Set(rxs.map(r=>r.player_id))].slice(0,10);
        let gmap = {};
        if (giverIds.length) { const { data: gs } = await sb.from("profiles").select("id,display_name,avatar_url").in("id", giverIds); gmap = Object.fromEntries((gs||[]).map(g=>[g.id,g])); }
        const vis = []; const seen = new Set();
        for (const r of rxs) { if (new Date(r.created_at) < _t0) continue; const g = gmap[r.player_id]; if (g && !seen.has(g.id)) { seen.add(g.id); vis.push({ ...g, type:r.type }); } if (vis.length>=6) break; }
        if (alive) { setReactionsReceived(rxs.length); setVisitors(vis); }
      } catch(_) {}
    })();
    return () => { alive = false; };
  }, [fullProfile?.id]);
  const [sysDark, setSysDark] = useState(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches : true);

  // se il sistema cambia (giorno→notte del telefono) e siamo in auto, seguiamo
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = e => setSysDark(e.matches);
    mq.addEventListener ? mq.addEventListener("change", onChange) : mq.addListener(onChange);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", onChange) : mq.removeListener(onChange); };
  }, []);

  // il tema EFFETTIVO: in auto lo decide il sistema
  const playerTheme = themeChoice === "auto" ? (sysDark ? "dark" : "light") : themeChoice;

  useEffect(() => {
    document.body.classList.toggle("light", playerTheme === "light");
    localStorage.setItem("pug_theme", themeChoice);
  }, [playerTheme, themeChoice]);
  const [newPin1, setNewPin1] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const [pinChangeErr, setPinChangeErr] = useState("");

  const loadTimeoutRef = useRef(null);
  const [loadStuck, setLoadStuck] = useState(false);
  const load = useCallback(async () => {
    // Debounce: ignora se già in corso, con safety reset dopo 12s
    if (loadingRef.current) return;
    // Offline: solo se ci sono già dati cached, non bloccare al primo load
    if (!navigator.onLine && hasDataRef.current) {
      setLoading(false); return;
    }
    loadingRef.current = true;
    setLoading(true);
    clearTimeout(loadTimeoutRef.current);
    loadTimeoutRef.current = setTimeout(() => {
      loadingRef.current = false;
      setLoading(false);
    }, 12000);
  try {
    // Carica visibilità PRIMA di tutto — evita flash con vecchi dati
    const visCfg = await fetchVisibilityConfig();
    if (visCfg && typeof visCfg === "object") {
      localStorage.setItem("pug_visibility", JSON.stringify(visCfg));
      setVisConfig(visCfg);
    }
  } catch(_) {}
  try {
    const today = localToday();
    const monthStart = today.slice(0, 7) + "-01";
    const _now = new Date();
    const cm = _now.getMonth() + 1;
    const cy = _now.getFullYear();
    const mStart = `${cy}-${String(cm).padStart(2,"0")}-01`;
    const [{ data: p }, { data: b }, { data: a }, { data: bk }, { data: n }, { data: pl }, { data: m }, { data: attToday }, { data: attMonth }, { data: myPres }, { data: mConfig }] = await Promise.all([
      sb.from("profiles").select("id,display_name,first_name,avatar_url,xp,coin,squad_id,current_streak,longest_streak,last_checkin_date,squads(name)").eq("id", profile.id).single(),
      sb.from("player_badges").select("id,assigned_at,xp_awarded,coin_awarded,badges(name,image_url,xp_default,description,link)").eq("player_id", profile.id).order("assigned_at", { ascending: false }),
      sb.from("activities").select("id,name,description,link,duration_days,xp_partial,xp_full,xp_completed,coin_partial,coin_full,coin_completed,coin_cost,is_active,expires_at,max_participants,educator_id,created_by,image_data,location,author_name").eq("is_active", true).order("created_at", { ascending: false }),
      sb.from("bookings").select("id,status,coin_held,created_at,activities(name)").eq("player_id", profile.id).order("created_at", { ascending: false }),
      sb.from("notifications").select("id,type,title,body,read_at,created_at").eq("user_id", profile.id).neq("type", "log_action").order("created_at", { ascending: false }).limit(20),
      sb.from("profiles").select("id,display_name,avatar_url,xp,squad_id,squads(name)").eq("role","player").gt("xp", 2).order("xp", { ascending: false }),
      sb.from("messages").select("id,body,media_data,is_broadcast,squad_id,recipient_id,expires_at,cancelled_at,created_at,sender_id,profiles!sender_id(display_name,avatar_url)").or(`is_broadcast.eq.true,recipient_id.eq.${profile.id}${fullProfile?.squad_id ? `,squad_id.eq.${fullProfile.squad_id}` : ""}`).order("created_at",{ascending:false}).limit(30),
      sb.from("attendances").select("player_id, xp_awarded").eq("date", today),
      sb.from("attendances").select("player_id, xp_awarded").gte("date", monthStart),
      sb.from("attendances").select("id").eq("player_id", profile.id).gte("date", mStart).neq("status","none"),
      sb.from("streak_config").select("min_days").eq("month", cm).eq("year", cy).maybeSingle(),
    ]);
    if (p) setFullProfile(p);
    const prevXP = parseInt(localStorage.getItem("pug_xp_"+p.id)||"0");
    const curXP = p.xp||0;
    if (prevXP > 0 && curXP > prevXP) {
      const oldLv = getLevel(prevXP); const newLv = getLevel(curXP);
      if (newLv.name !== oldLv.name) setLevelUpData({ oldLevel:oldLv, newLevel:newLv });
    }
    localStorage.setItem("pug_xp_"+p.id, String(curXP));
    const acts = (a || []).filter(x => !(x.description || "").startsWith("SFIDA"));
    setBadges(b || []); setActivities(acts); setBookings(bk || []); setNotifications(n || []); setPlayers(pl || []); setMessages(m || []);
    hasDataRef.current = true;
    if (acts.length > 0) {
      const { data: actBk } = await sb.from("bookings")
        .select("activity_id,status")
        .in("activity_id", acts.map(x => x.id))
        .in("status", ["confirmed","pending"]);
      const acounts = {};
      (actBk || []).forEach(b => { acounts[b.activity_id] = (acounts[b.activity_id] || 0) + 1; });
      setActBookingCounts(acounts);
    }
    const td = {}; (attToday || []).forEach(a => { td[a.player_id] = (td[a.player_id] || 0) + (a.xp_awarded || 0); }); setXpToday(td);
    const mt = {}; (attMonth || []).forEach(a => { mt[a.player_id] = (mt[a.player_id] || 0) + (a.xp_awarded || 0); }); setXpMonth(mt);
    // Presenze mese corrente per il giocatore (già caricate nel batch sopra)
    setMonthPresences(myPres?.length || 0);
    setMonthTarget(mConfig?.min_days || null);
  } catch(err) {
  } finally {
    clearTimeout(loadTimeoutRef.current);
    loadingRef.current = false;
    setLoading(false);
  }
  }, [profile.id]);


  // Coalesce i reload da eventi realtime: una raffica di eventi → un solo load
  const reloadTimerRef = useRef(null);
  const scheduleLoad = useCallback((ms = 500) => {
    clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => load(), ms);
  }, [load]);

  // Ricarica quando l'app torna in primo piano
  useEffect(() => {
    let hiddenAt = 0;
    function onVis() {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        // Reset loadingRef quando va in background — evita blocchi
        clearTimeout(loadTimeoutRef.current);
        loadingRef.current = false;
        return;
      }
      if (hiddenAt > 0 && Date.now() - hiddenAt > 20000) {
        hiddenAt = 0;
        load(); // loadingRef già false, può partire
      } else {
        hiddenAt = 0;
      }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);
  useEffect(() => {
    load();
    const channel = sb.channel("player_notifs_" + profile.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: `id=eq.${profile.id}` }, () => scheduleLoad(300))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${profile.id}` }, (payload) => {
        scheduleLoad(500);
        // Show toast for important notifications
        const n = payload.new;
        if (n?.type === "booking_confirmed") setToast({ msg:"✅ Prenotazione confermata!", color:"var(--verde)" });
        else if (n?.type === "booking_rejected") setToast({ msg:"❌ Prenotazione rifiutata", color:"var(--danger)" });
        else if (n?.type === "badge_assigned") setToast({ msg:"🎖️ " + (n?.title||"Badge sbloccato!"), color:"var(--rosa)" });
        setTimeout(() => setToast(null), 4000);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "bookings", filter: `player_id=eq.${profile.id}` }, () => scheduleLoad(500))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages",
          filter: `recipient_id=eq.${profile.id}` }, (payload) => {
        scheduleLoad(200);
        const m = payload.new;
        showInAppNotif("💬 Nuovo messaggio", m?.body?.slice(0,60)||"Hai un nuovo messaggio");
        playPixel("msg");
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages",
          filter: `is_broadcast=eq.true` }, (payload) => {
        scheduleLoad(200);
        const m = payload.new;
        showInAppNotif("📢 Annuncio", m?.body?.slice(0,60)||"Nuovo messaggio per tutti");
      })
      // Realtime classifica: tutti gli XP guadagnati da chiunque, in tempo reale
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "xp_history" }, (payload) => {
        const row = payload.new;
        if (!row?.created_at) return;
        const today = localToday();
        const monthStart = today.slice(0, 7) + "-01";
        if (row.created_at >= monthStart + "T00:00:00") {
          setXpMonth(prev => ({ ...prev, [row.player_id]: (prev[row.player_id]||0) + (row.xp_gained||0) }));
        }
        if (row.created_at >= today + "T00:00:00") {
          setXpToday(prev => ({ ...prev, [row.player_id]: (prev[row.player_id]||0) + (row.xp_gained||0) }));
        }
      })
      // Aggiornamenti dei profili altrui (classifica generale)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, (payload) => {
        const row = payload.new;
        if (!row || row.id === profile.id) return; // il proprio è già gestito sopra
        setPlayers(prev => {
          const idx = prev.findIndex(p => p.id === row.id);
          if (idx < 0) return prev;
          const updated = [...prev];
          updated[idx] = { ...updated[idx], xp: row.xp, coin: row.coin, display_name: row.display_name, avatar_url: row.avatar_url, squad_id: row.squad_id };
          return updated;
        });
      })
      .subscribe();
    return () => { clearTimeout(reloadTimerRef.current); sb.removeChannel(channel); };
  }, [profile.id, load]);

  async function checkAndAssignMonthlyBadge(currentXp, currentCoin) {
    // Tutta la logica (finestra primi 5 giorni, config mese, conteggio
    // presenze, creazione badge, premi) avviene lato server in una
    // transazione: il client riceve solo l'esito.
    const { data: res } = await sb.rpc("claim_monthly_badge", { p_player_id: profile.id });
    if (!res?.ok) return;
    setQrMsg(prev => prev + ` · 🏅 Badge ${res.badge_name}!`);
    setFullProfile(prev => ({ ...prev, xp: res.new_xp, coin: res.new_coin }));
  }

  async function doCheckin(codeOverride) {
    const code = (codeOverride || qrInput).toUpperCase();
    if (!code) { setQrMsg("Inserisci o scansiona un codice."); return; }
    if (codeOverride) setQrInput(codeOverride);

    // Tutta la validazione (codice, finestra oraria, doppioni, XP dalla
    // config, streak) avviene lato server in una transazione atomica.
    const { data: res, error } = await sb.rpc("do_checkin", { p_player_id: profile.id, p_code: code });
    if (error) { setQrMsg("❌ Errore di rete. Riprova."); return; }
    if (res?.error === "lab_already") { setQrMsg("Hai già fatto il check-in per questo Lab oggi!"); return; }
    if (res?.error === "already") { setQrMsg("Hai già fatto il check-in oggi!"); return; }
    if (res?.error === "no_qr") { setQrMsg("Nessun QR attivo oggi."); return; }
    if (res?.error === "invalid_code") { setQrMsg("❌ Codice non valido."); return; }
    if (res?.error === "too_early") { setQrMsg("⏰ Il check-in non è ancora aperto."); return; }
    if (res?.error === "too_late") { setQrMsg("⏰ Il check-in è chiuso (orario 13–19)."); return; }
    if (res?.error || !res?.type) { setQrMsg("❌ Errore. Riprova."); return; }

    if (res.type === "lab") {
      setFullProfile(prev => ({ ...prev, xp: res.new_xp, coin: res.new_coin }));
      setQrInput("");
      if (res.completed) {
        setQrMsg(`🎉 LAB COMPLETATO "${res.name}"! Bonus ×→ +${res.bonus_xp} XP, +${res.bonus_coin} 🪙`);
        setQrCelebration({ xpGained: res.xp + (res.bonus_xp||0), playerName: fullProfile?.display_name||"", special: true });
      } else {
        try { const AC=window.AudioContext||window.webkitAudioContext; if(AC){ const ctx=new AC(); const now=ctx.currentTime; [[988,0],[1319,0.09]].forEach(([f,t])=>{ const o=ctx.createOscillator(),g=ctx.createGain(); o.type="square"; o.frequency.value=f; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(0.0001,now+t); g.gain.exponentialRampToValueAtTime(0.16,now+t+0.01); g.gain.exponentialRampToValueAtTime(0.0001,now+t+0.22); o.start(now+t); o.stop(now+t+0.24); }); setTimeout(()=>{try{ctx.close();}catch(_){}} ,700); } if(navigator.vibrate) navigator.vibrate([25,20,45]); } catch(_){}
        setQrMsg(`✅ Presenza "${res.name}" (${res.progress}/${res.total})! +${res.xp} XP +${res.coin} 🪙`);
        setQrCelebration({ xpGained: res.xp, playerName: fullProfile?.display_name||"" });
      }
      playPixel(res.completed ? "badge" : "checkin");
      return;
    }

    // Check-in giornaliero riuscito
    setQrMsg(`✅ Check-in! +${res.xp} XP +${res.coin} Coin · 🔥 ${res.streak} giorni`);
    playPixel("checkin"); setQrCelebration({ xpGained: res.xp, playerName: fullProfile?.display_name||"" });
    setFullProfile(prev => ({ ...prev, xp: res.new_xp, coin: res.new_coin, current_streak: res.streak, longest_streak: Math.max(res.streak, prev?.longest_streak || 0), last_checkin_date: localToday() }));
    await checkAndAssignMonthlyBadge(res.new_xp, res.new_coin);
  }

  async function bookActivity(actId, cost) {
    try {
      // Costo letto dal server e saldo verificato in un'unica transazione
      const { data: res, error } = await sb.rpc("book_activity", { p_player_id: profile.id, p_activity_id: actId });
      if (error) { alert("❌ Errore prenotazione: " + error.message); return; }
      if (res?.error === "insufficient") { alert("Coin insufficienti!"); return; }
      if (res?.error === "not_found") { alert("❌ Lab non disponibile."); return; }
      if (!res?.ok) { alert("❌ Errore prenotazione."); return; }
      // Notifica push a tutti gli educator
      sb.from("profiles").select("id").in("role",["educator","admin"]).then(({ data: edus }) => {
        const nm = fullProfile?.display_name||"Un giocatore";
        (edus||[]).forEach(e => sendPush(e.id, "📋 Nuova prenotazione", `${nm} ha prenotato un Lab`).catch(()=>{}));
        const rows=(edus||[]).map(e=>({user_id:e.id,type:"booking",title:"📋 Nuova prenotazione Lab",body:`${nm} ha prenotato un Lab`}));
        if(rows.length) sb.from("notifications").insert(rows).then(()=>{}).catch(()=>{});
      });
      if (res.coin_held > 0) setFullProfile(prev => ({ ...prev, coin: res.new_coin }));
      alert("✅ Prenotazione inviata!");
      load();
    } catch(e) {
      alert("❌ Errore: " + (e?.message || String(e)));
    }
  }

  async function saveFirstName() {
    const v = newFirstName.trim().slice(0, 30);
    await sb.from("profiles").update({ first_name: v }).eq("id", profile.id);
    setFullProfile(prev => ({ ...prev, first_name: v }));
    setEditingFirstName(false);
  }

  const lv = getLevel(fullProfile?.xp || 0);
  const unread = notifications.filter(n => !n.read_at).length;
  const unreadMsgs = messages.filter(m => !m.read_at && !m.cancelled_at && (!m.expires_at || new Date(m.expires_at) > new Date())).length;

  // Leaderboard ranked
  let lbRanked = [...players];
  if (lbTimeFilter === "oggi") {
    lbRanked = lbRanked
      .filter(p => (xpToday[p.id]||0) > 0)
      .sort((a, b) => {
        const xpA = xpToday[a.id]||0, xpB = xpToday[b.id]||0;
        if (xpA !== xpB) return xpB - xpA;
        return (b.coin || 0) - (a.coin || 0);
      })
      .slice(0, 3);
  } else if (lbTimeFilter === "mese") {
    lbRanked = lbRanked
      .filter(p => (xpMonth[p.id]||0) > 0)
      .sort((a, b) => {
        const xpA = xpMonth[a.id]||0, xpB = xpMonth[b.id]||0;
        if (xpA !== xpB) return xpB - xpA;
        return (b.coin || 0) - (a.coin || 0);
      })
      .slice(0, 10);
  }

  async function saveNewPin() {
    if (newPin1.length < 4) { setPinChangeErr("Il PIN deve avere 4 cifre"); return; }
    if (newPin1 !== newPin2) { setPinChangeErr("I PIN non coincidono"); return; }
    if (newPin1 === "1234") { setPinChangeErr("Scegli un PIN diverso da 1234"); return; }
    // Aggiorna sia la colonna pin (change_pin) sia la password Auth,
    // così il prossimo login funziona con il nuovo PIN.
    const { data: res, error } = await sb.rpc("change_pin", { p_player_id: profile.id, p_new_pin: newPin1 });
    if (error || res?.error) { setPinChangeErr("Errore: " + (error?.message || res?.error)); return; }
    // Aggiorna la password Auth ri-loggando con la nuova (la sessione è la propria)
    try {
      await sb.auth.updateUser({ password: playerPwd(newPin1, profile.id) });
    } catch(_) { /* se la sessione Auth non c'è, il change_pin basta per il fallback */ }
    const saved = JSON.parse(localStorage.getItem("pug_player") || "{}");
    delete saved.pin;
    localStorage.setItem("pug_player", JSON.stringify({ ...saved, _mustChangePin: false }));
    setMustChangePin(false);
  }

  // Aspetta caricamento visibilità (evita flash con dati sbagliati)
  if (!visReady) return (
    <>
      <style>{css}</style>
      <div className="player-wrap" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
        <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:24,fontWeight:900,textTransform:"uppercase",color:"var(--azzurro)",letterSpacing:".1em",opacity:.6}}>🌿</div>
      </div>
    </>
  );

  if (levelUpData) return (
    <>
      <style>{css}</style>
      <LevelUpOverlay oldLevel={levelUpData.oldLevel} newLevel={levelUpData.newLevel} onDone={()=>setLevelUpData(null)}/>
    </>
  );

  if (mustChangePin) return (
    <div style={{background:'#000',minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{background:'rgba(0,0,0,.7)',border:'1px solid rgba(255,255,255,.15)',borderRadius:20,padding:'32px 24px',width:'100%',maxWidth:360,backdropFilter:'blur(20px)'}}>
        <div style={{textAlign:'center',marginBottom:24}}>
          <div style={{fontSize:48,marginBottom:8}}>🔐</div>
          <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:'uppercase',color:'#fff',marginBottom:8}}>Imposta il tuo PIN</div>
          <div style={{fontSize:13,color:'rgba(255,255,255,.5)',lineHeight:1.5}}>Stai usando il PIN predefinito 1234. Scegli un PIN personale per proteggere il tuo account.</div>
        </div>
        <div style={{marginBottom:12}}>
          <label className="form-label">Nuovo PIN (4 cifre)</label>
          <input className="form-input pin-input" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4} value={newPin1} onChange={e=>{setNewPin1(e.target.value.replace(/\D/g,""));setPinChangeErr("");}} placeholder="••••" autoFocus/>
        </div>
        <div style={{marginBottom:16}}>
          <label className="form-label">Conferma PIN</label>
          <input className="form-input pin-input" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4} value={newPin2} onChange={e=>{setNewPin2(e.target.value.replace(/\D/g,""));setPinChangeErr("");}} onKeyDown={e=>e.key==="Enter"&&saveNewPin()} placeholder="••••"/>
        </div>
        {pinChangeErr && <div style={{color:'var(--rosso)',fontSize:12,fontWeight:700,textAlign:'center',marginBottom:10}}>{pinChangeErr}</div>}
        <button className="btn btn-primary" onClick={saveNewPin} disabled={newPin1.length<4||newPin2.length<4}>Salva PIN</button>
      </div>
    </div>
  );

  if (loading) return (
    <div style={{background:'#000',minHeight:'100vh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16}}>
      <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:'uppercase',color:'#A3CFFE',letterSpacing:'.08em'}}>🌿 Caricamento…</div>
      {loadStuck && (
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:12,color:'rgba(255,255,255,.4)',marginBottom:12}}>Qualcosa non va — riprova</div>
          <button onClick={()=>{ loadingRef.current=false; setLoading(false); load(); }}
            style={{background:'rgba(163,207,254,.15)',border:'1px solid rgba(163,207,254,.4)',borderRadius:99,padding:'10px 24px',color:'#A3CFFE',fontSize:14,fontWeight:700,cursor:'pointer'}}>
            🔄 Ricarica
          </button>
        </div>
      )}
    </div>
  );

  const BOTTOM_TABS = [
    ["profilo","👤","Profilo"],
    ["social","🌍","Social"],
    visConfig.classifica !== false ? ["classifica","🏆","Classifica"] : null,
    visConfig.lab !== false ? ["attivita","⚡","Lab"] : null,
    visConfig.bigtop !== false ? ["bigtop","🎪","BIG TOP"] : null,
    visConfig.messaggi !== false ? ["messaggi","💬","Messaggi"] : null,
    ["notifiche","🔔","Notifiche"],
  ].filter(Boolean);

  // Day: un colore pieno della palette per ogni tab (dal Camerino).
  // Night: nero pieno con doodles bianchi, uguale ovunque.
  const TAB_BG = {
    profilo:    '#A3CFFE',
    social:     '#FF6DEC',
    classifica: '#FDEF26',
    attivita:   '#339966',
    bigtop:     '#D41323',
    messaggi:   '#FF6DEC',
    notifiche:  '#A3CFFE',
  };
  const NIGHT_BG = '#0d0d0d';
  const COLORE_SFONDO = {'#A3CFFE':'azzurro','#FF6DEC':'rosa','#FDEF26':'giallo','#339966':'verde','#D41323':'rosso'};

    return (
    <div className={`player-wrap bg-${playerTheme === "light" ? (COLORE_SFONDO[TAB_BG[tab]]||'azzurro') : 'notte'}`} style={{transition:'background 0.5s ease'}}>
      {/* Toast notification */}
      {toast && (
        <div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:100,background:"rgba(0,0,0,.9)",border:`1px solid ${toast.color}`,borderRadius:12,padding:"10px 20px",fontSize:14,fontWeight:700,color:toast.color,boxShadow:`0 0 20px ${toast.color}44`,whiteSpace:"nowrap",backdropFilter:"blur(10px)"}}>
          {toast.msg}
        </div>
      )}

      {/* Toast notifications */}
      <ToastContainer/>
      <InAppNotifBanner/>
      {qrCelebration && <QRCelebration xpGained={qrCelebration.xpGained} playerName={qrCelebration.playerName} onDone={()=>setQrCelebration(null)}/>}
      {/* Top bar */}
      <div className="pd-topbar" style={{paddingTop:"max(10px, calc(env(safe-area-inset-top, 0px) + 8px))"}}>
        <div>
          <div className="pd-logo-img logo-b"/>
          <div className="pd-logo-img logo-w"/>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {visConfig.squadre !== false && fullProfile?.squads?.name && (
             <div style={{background:'#111',color:'var(--giallo)',fontSize:10,fontWeight:900,borderRadius:'var(--radius-sm)',padding:'5px 10px',textTransform:'uppercase',letterSpacing:'.05em',display:'inline-flex',alignItems:'center',gap:5}}><PugIcon nome="presenze" dim={11}/> {fullProfile.squads.name}</div>
          )}
          <button onClick={()=>{ const next=!soundOn; setSoundOn(next); localStorage.setItem("pug_sound", next?"on":"off"); if(next) pugSound("coin"); }} title="Suoni" style={{background:'rgba(16,16,16,.9)',border:'1px solid rgba(255,255,255,.22)',borderRadius:'var(--r-s)',padding:'5px 9px',cursor:'pointer',fontSize:16}}>{soundOn?"🔊":"🔇"}</button>
          <button onClick={()=>setThemeChoice(c=>c==="auto"?"light":c==="light"?"dark":"auto")} style={{background:'rgba(16,16,16,.9)',border:'1px solid rgba(255,255,255,.22)',borderRadius:'var(--r-s)',padding:'5px 9px',cursor:'pointer',lineHeight:1,display:'flex',alignItems:'center',gap:5,color:'#fff'}} title={themeChoice==="auto"?"Tema: automatico":themeChoice==="light"?"Tema: chiaro":"Tema: scuro"}>
            {themeChoice==="auto"
              ? <PugIcon nome={sysDark?"luna":"sole"} dim={15} style={{opacity:.9}}/>
              : themeChoice==="light" ? <PugIcon nome="sole" dim={15}/> : <PugIcon nome="luna" dim={15}/>}
            <span style={{fontSize:9,fontWeight:800,textTransform:'uppercase',letterSpacing:'.04em',opacity:.7}}>{themeChoice==="auto"?"Auto":themeChoice==="light"?"Giorno":"Notte"}</span>
          </button>
          <span style={{fontSize:7,fontWeight:600,color:"rgba(120,120,120,.45)",marginRight:4,letterSpacing:0}}>b28</span>
          <button className="btn btn-ghost btn-sm" onClick={onLogout} style={{fontSize:11}}>Esci</button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="pd-scroll"
        onTouchStart={e=>{window._swipeX0=e.touches[0].clientX; window._swipeY0=e.touches[0].clientY;}}
        onScroll={e=>{
          if(e.target.scrollTop === 0 && window._pulling) { window._pulling=false; load(); addToast("🔄 Aggiornamento…","ok"); }
        }}
        onTouchMove={e=>{
          const dy=e.touches[0].clientY-(window._swipeY0||0);
          if(dy>60 && e.currentTarget.scrollTop===0) window._pulling=true;
        }}
        onTouchEnd={e=>{
          const dx=e.changedTouches[0].clientX-(window._swipeX0||0);
          if(Math.abs(dx)<50)return;
          const ts=BOTTOM_TABS.map(t=>t[0]);
          const ci=ts.indexOf(tab);
          if(dx<0&&ci<ts.length-1)setTab(ts[ci+1]);
          else if(dx>0&&ci>0)setTab(ts[ci-1]);
        }}>

        {/* ── PROFILO ── */}
        {tab === "profilo" && fullProfile && (
          <div>
            {/* Avatar Hero */}
            {/* Avatar Hero — markup camerino */}
            <div className="pug-hero" style={{paddingTop:6}}>
              {/* Stanza tamagocification — spogliata: solo la porta rimanda al Social */}
              <div className="pug-roomzone">
                <div className="pug-room" style={{overflow:"visible"}}>
                  <div className="pug-petshadow" style={{display:"none"}}/>
                  {fullProfile.avatar_url
                    ? <img className="pug-pet" src={fullProfile.avatar_url} alt="creatura" style={{position:"absolute",left:"27%",top:"42%",width:150,height:150,objectFit:"contain",zIndex:3}}/>
                    : <span className="pug-pet" style={{position:"absolute",left:"27%",top:"42%",width:150,fontSize:110,textAlign:'center',lineHeight:'150px',display:"inline-block",zIndex:3}}>{lv.emoji}</span>}
                  <div className="pug-hot hot-door" onClick={()=>setTab("social")} title="Vai al Social" style={{position:"absolute",left:"8.5%",top:"15%",width:"10%",aspectRatio:"1",borderRadius:"50%",cursor:"pointer",zIndex:4}}><span className="g"/></div>
                  {visConfig.creatura !== false && feedAnim && <img key={popKey} src={FOODS[selectedFood]?.img} alt="" style={{position:"absolute",left:"49%",top:"56%",width:48,height:48,objectFit:"contain",transform:"translate(-50%,-50%)",opacity:0,filter:"drop-shadow(0 5px 3px rgba(0,0,0,.35))",animation:"pugfoodpop 1s ease-out both",zIndex:4,pointerEvents:"none"}}/>}
                  {visConfig.creatura !== false && burp && <div style={{position:"absolute",left:"34%",top:"48%",fontFamily:"var(--hand), 'Jelek Type', cursive",fontSize:24,fontWeight:700,color:"#101010",lineHeight:1.6,padding:"6px 4px",overflow:"visible",animation:"pugburp 2.5s ease-out forwards",zIndex:7,pointerEvents:"none",whiteSpace:"nowrap",transformOrigin:"left center"}}>BURP!</div>}
                  {visConfig.creatura !== false && <button onClick={feedPet} disabled={feeding} title={"Dai da mangiare: " + (FOODS[selectedFood]?.name||"")} style={{position:"absolute",right:8,bottom:8,width:54,height:54,borderRadius:12,border:"2.5px solid #101010",background:"#fff",boxShadow:"2px 2px 0 #101010",cursor:"pointer",padding:5,display:"flex",alignItems:"center",justifyContent:"center",zIndex:6}}>{FOODS[selectedFood]?.img ? <img src={FOODS[selectedFood].img} alt={FOODS[selectedFood].name} style={{width:42,height:42,objectFit:"contain"}}/> : <span style={{fontSize:26}}>{FOODS[selectedFood]?.emoji}</span>}</button>}
                  {(visitors[visIdx]||visitors[0]) && ((visitors[visIdx]||visitors[0]).avatar_url
                    ? <img key={visIdx} className="visitor" src={(visitors[visIdx]||visitors[0]).avatar_url} alt="" title={"Passato a trovarti: "+((visitors[visIdx]||visitors[0]).display_name||"")} style={{position:"absolute",right:"3%",bottom:"12%",width:150,height:150,objectFit:"contain",zIndex:2}}/>
                    : <span key={visIdx} className="visitor" title={"Passato a trovarti: "+((visitors[visIdx]||visitors[0]).display_name||"")} style={{position:"absolute",right:"3%",bottom:"12%",width:150,fontSize:110,textAlign:"center",zIndex:2}}>🙂</span>)}
                </div>
                {visConfig.creatura !== false && (<>
                <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:8}}>
                  {FOODS.map((f,i)=>(
                    <button key={i} onClick={()=>setSelectedFood(i)} title={f.name} style={{width:13,height:13,borderRadius:"50%",border:"2px solid #101010",background:selectedFood===i?"#101010":"#fff",cursor:"pointer",padding:0}}/>
                  ))}
                </div>
                {feedMsg && <div style={{background: feedMsg.includes("Sazio")?"#339966":"#D41323", color:"#fff", fontWeight:900, fontSize:15, padding:"10px 16px", borderRadius:12, textAlign:"center", marginTop:10, border:"2.5px solid #101010", boxShadow:"3px 3px 0 #101010"}}>{feedMsg}</div>}
                </>)}
                {visConfig.squadre !== false && fullProfile.squads?.name && (
                  <div className="pug-squadtab" style={{background:SQUAD_STYLE[fullProfile.squads.name]?.bg||'#339966',color:'#fff'}}>Squadra {fullProfile.squads.name}</div>
                )}
              </div>
              <div className="pug-name">{fullProfile.display_name}</div>
              {editingFirstName ? (
                <div style={{display:'flex',gap:6,alignItems:'center',marginTop:4,marginBottom:4,flexWrap:'wrap'}}>
                  <input className="form-input" autoFocus value={newFirstName} onChange={e=>setNewFirstName(e.target.value.slice(0,30))} onKeyDown={e=>{if(e.key==='Enter'&&newFirstName.trim())saveFirstName();}} placeholder="Il tuo nome…" maxLength={30} style={{flex:'1 1 120px',minWidth:0}}/>
                  <button className="btn btn-yellow btn-sm" onClick={saveFirstName} disabled={!newFirstName.trim()}>Salva</button>
                  <button className="btn btn-ghost btn-sm" onClick={()=>setEditingFirstName(false)}>✕</button>
                </div>
              ) : (
                <div className="pug-realname" style={{cursor:'pointer'}}
                  onClick={()=>{setNewFirstName(fullProfile.first_name||'');setEditingFirstName(true);}}>
                  {fullProfile.first_name || 'scrivi il tuo nome'} <span style={{opacity:.7,fontSize:12}}>✏️</span>
                </div>
              )}
            </div>

            {/* Barre bisogni creatura (nascondibili da Vista) */}
            {visConfig.creatura !== false && (<div className="pug-card">
              <div className="pug-tape" style={{background:'#FDEF26',color:'#101010'}}>🌱 Come stai al Garden</div>
              {[
                ['Energia', creatureBars?.energia ?? fullProfile.energia, '#FDEF26', '⚡'],
                ['Socialità', creatureBars?.socialita ?? fullProfile.socialita, '#A3CFFE', '👥'],
                ['Felicità', creatureBars?.felicita ?? fullProfile.felicita, '#FF6DEC', '❤️'],
              ].map(([nome, val, col, ic]) => {
                const pct = Math.max(0, Math.min(100, Math.round(Number(val ?? 100))));
                return (
                  <div className="pug-vital" key={nome}>
                    <span className="i">{ic}</span>
                    <span className="n">{nome}</span>
                    <div className="pug-vbar"><div className="pug-vfill" style={{width:pct+'%',background:col}}/></div>
                    <span className="pug-vpct">{pct}%</span>
                  </div>
                );
              })}
            </div>)}

            {nextSlot && (
              <div className="pd-card" style={{marginBottom:12}}>
                <div style={{fontWeight:800,fontSize:13,marginBottom:4}}>🎪 Prossimo turno Big Top</div>
                <div style={{fontWeight:900,fontSize:16}}>{nextSlot.date.split("-").reverse().join("/")} · {nextSlot.start_time.slice(0,5)}–{(nextSlot.end_time||"").slice(0,5)}</div>
              </div>
            )}
            {weekly && (
              <div className="pd-card" style={{marginBottom:12}}>
                <div style={{fontWeight:800,fontSize:13,marginBottom:8}}>📅 Questa settimana</div>
                <div style={{display:"flex",gap:8,textAlign:"center"}}>
                  <div style={{flex:1}}><div style={{fontWeight:900,fontSize:20}}>{weekly.presenze}</div><div style={{fontSize:11,opacity:.7}}>presenze</div></div>
                  <div style={{flex:1}}><div style={{fontWeight:900,fontSize:20}}>+{weekly.xp}</div><div style={{fontSize:11,opacity:.7}}>XP</div></div>
                  <div style={{flex:1}}><div style={{fontWeight:900,fontSize:20}}>{weekly.badge}</div><div style={{fontSize:11,opacity:.7}}>badge</div></div>
                </div>
              </div>
            )}
            {/* Profile card: nome editabile + XP */}
            <div className="pd-card">
              {/* Goal XP personale */}
            {(() => {
              const goal = fullProfile.xp_goal || 0;
              const pct = goal > 0 ? Math.min(100, Math.round((fullProfile.xp/goal)*100)) : 0;
              return goal > 0 ? (
                <div style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:12,padding:"12px 14px",marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontSize:12,fontWeight:700,color:"var(--text2)"}}>🎯 Obiettivo XP</span>
                    <span style={{fontSize:12,fontWeight:700,color:"var(--neon-blue)"}}>{fullProfile.xp} / {goal} XP ({pct}%)</span>
                  </div>
                  <div style={{height:8,borderRadius:99,background:"rgba(255,255,255,.08)",overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${pct}%`,borderRadius:99,background:pct>=100?"var(--neon-green)":"var(--azzurro))",transition:"width .5s ease"}}/>
                  </div>
                  {pct>=100 && <div style={{fontSize:11,color:"var(--neon-green)",marginTop:4,fontWeight:700}}>🏆 Obiettivo raggiunto!</div>}
                </div>
              ) : null;
            })()}

              <AnimatedLevelBar xp={fullProfile.xp||0} lv={lv} />
            </div>

            {/* Stats grid 1: XP, Coin, Badge */}
            {(() => {
              const stats = [
                visConfig.xp !== false ? ['⭐',fullProfile.xp,'XP'] : null,
                visConfig.coin !== false ? ['🪙',fullProfile.coin,'Coin'] : null,
                visConfig.badge !== false ? ['🎖️',badges.length,'Badge'] : null,
              ].filter(Boolean);
              return stats.length > 0 ? (
                <div className="pd-sg" style={{gridTemplateColumns:`repeat(${stats.length},1fr)`}}>
                  {stats.map(([ic,v,l])=>(
                    <div key={l} className="pd-sc">
                      <span style={{fontSize:30,display:'block',marginBottom:5}}>{ic}</span>
                      <CountUpStat val={typeof v==="number"?v:fullProfile.xp}/>
                      <span className="pd-sl">{l}</span>
                    </div>
                  ))}
                </div>
              ) : null;
            })()}

            {/* Stats grid 2: Lab, Conf., Rank */}
            <div className="pd-sg">
              {[['🌿',activities.filter(a=>!a.description?.includes('SFIDA')).length,'Lab'],['✅',bookings.filter(b=>b.status==='confirmed').length,'Confermati'],['🏆',(players.findIndex(p=>p.id===profile.id)+1)||'-','Rank']].map(([ic,v,l])=>(
                <div key={l} className="pd-sc"><span style={{fontSize:30,display:'block',marginBottom:5}}>{ic}</span><span className="pd-sv">{v}</span><span className="pd-sl">{l}</span></div>
              ))}
            </div>

            {/* Streak */}
            {visConfig.streak !== false && ((fullProfile.current_streak||0) > 0 || (fullProfile.longest_streak||0) > 0) && (
              <div className="streak-card">
                <div style={{fontSize:9,fontWeight:900,textTransform:'uppercase',letterSpacing:'.12em',color:'rgba(212,19,35,.7)',marginBottom:8}}>🔥 Streak presenze</div>
                <div className="streak-row">
                  <div className="streak-item"><span className="streak-val">{fullProfile.current_streak||0}</span><span className="streak-lbl"><span className="flame-pulse">🔥</span> Giorni attuali</span></div>
                  <div className="streak-item"><span className="streak-val">{fullProfile.longest_streak||0}</span><span className="streak-lbl">Record</span></div>
                  <div className="streak-item"><span className="streak-val">{(() => { const now=new Date(); return new Date(now.getFullYear(),now.getMonth()+1,0).getDate(); })()}</span><span className="streak-lbl">Giorni mese</span></div>
                </div>
                {monthPresences !== null && monthTarget !== null && (
                  <div className="month-prog">
                    <div className="month-prog-lbl"><span>🗓️ {MONTH_NAMES[new Date().getMonth()]}</span><span>{monthPresences}/{monthTarget} giorni</span></div>
                    <div className="month-prog-bg"><div className="month-prog-fill" style={{width:Math.min(100,Math.round((monthPresences/Math.max(1,monthTarget))*100))+'%'}}/></div>
                  </div>
                )}
              </div>
            )}

            {/* Squadra */}
            {(() => {
              const showSquad = visConfig.squadre !== false;
              if (!showSquad) return null;
              if (!fullProfile.squads?.name) return (
                <div className="pd-squad" style={{opacity:.5}}>
                  <div style={{width:36,height:36,borderRadius:8,background:'rgba(255,255,255,.1)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>🔒</div>
                  <div>
                    <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:18,fontWeight:900,color:'#fff',textTransform:'uppercase',letterSpacing:'.04em',lineHeight:1}}>Squadre</div>
                    <div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,.4)',textTransform:'uppercase',letterSpacing:'.08em',marginTop:1}}>🚧 Coming soon</div>
                  </div>
                </div>
              );
              return (
                <div className="pd-squad">
                  <div style={{width:36,height:36,borderRadius:8,background:SQUAD_STYLE[fullProfile.squads.name]?.bg||'#339966',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>⚡</div>
                  <div>
                    <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:18,fontWeight:900,color:'#fff',textTransform:'uppercase',letterSpacing:'.04em',lineHeight:1}}>Squadra {fullProfile.squads.name}</div>
                    <div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,.38)',textTransform:'uppercase',letterSpacing:'.08em',marginTop:1}}>Membro</div>
                  </div>
                </div>
              );
            })()}

            {/* Sfide */}
            {visConfig.sfida !== false && (
              <SfidePanel activities={activities}/>
            )}
            
            {/* Badge */}
            {visConfig.badge !== false && badges.length > 0 && (
              <div className="pd-badges">
                <div className="pd-tape-lite">🎖️ Badge</div>
                <div className="pd-badge-row">
                  {badges.map(pb=>(
                    <div key={pb.id} className="pd-badge-item" onClick={()=>setSelectedBadge(pb)}>
                      {pb.badges?.image_url?<img src={pb.badges.image_url} style={{width:74,height:74,borderRadius:12,objectFit:'contain',border:'2px solid rgba(255,0,204,.4)',display:'block',margin:'0 auto 5px'}} alt=""/>:<div style={{fontSize:28,marginBottom:5}}>🎖️</div>}
                      <div style={{fontSize:11,fontWeight:800,color:'#f0f0f0',lineHeight:1.3}}>{pb.badges?.name}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {visConfig.giochi !== false && <div style={{padding:"0 14px",marginBottom:12}}><button className="btn" style={{width:"100%",background:"#FF6DEC",color:"#101010",border:"3px solid #101010",boxShadow:"3px 3px 0 #101010",fontWeight:900,fontSize:16,padding:"14px"}} onClick={()=>{setGamesTab("pong");setShowGames(true);}}>🎮 Giochi</button></div>}
            {showGames && <div className="modal-bg" onClick={()=>setShowGames(false)}><div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:410}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><div style={{fontWeight:900,fontSize:18}}>🎮 Giochi</div><button className="btn btn-ghost btn-sm" onClick={()=>setShowGames(false)}>✕</button></div><GamesHub myId={fullProfile.id} initialTab={gamesTab}/></div></div>}

            <InstallPWAButton/>

            {/* Check-in */}
            <div className="pd-checkin">
              <div style={{fontSize:9,fontWeight:900,textTransform:'uppercase',letterSpacing:'.15em',color:'var(--neon-green)',marginBottom:8}}>📍 Check-in · Giornaliero o Lab</div>
              {showCamera ? (
                <QRScanner onScan={code=>{setShowCamera(false);doCheckin(code);}} onClose={()=>setShowCamera(false)}/>
              ) : (
                <>
                  <input className="form-input" value={qrInput} onChange={e=>setQrInput(e.target.value.toUpperCase())} placeholder="ABC123" style={{textAlign:'center',fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,letterSpacing:8,marginBottom:8}} maxLength={6}/>
                  <div style={{display:'flex',gap:8,marginBottom:0}}>
                    <button className="btn btn-primary" style={{flex:1}} onClick={()=>doCheckin()}>✓ Conferma</button>
                    <button className="btn btn-ghost btn-sm" style={{flexShrink:0,fontSize:18}} onClick={()=>setShowCamera(true)} title="Scansiona con camera">📷</button>
                  </div>
                </>
              )}
              {qrMsg&&<div style={{marginTop:10,fontSize:14,fontWeight:700,color:qrMsg.includes('✅')?'var(--verde)':'var(--danger)',textAlign:'center'}}>{qrMsg}</div>}
            </div>

            {/* Prenotazioni */}
            {bookings.length>0&&(
              <div style={{padding:'0 14px 8px'}}>
                <div className="pd-tape-lite">🎫 Prenotazioni</div>
                {bookings.slice(0,5).map(b=>{
                  const s={pending:['tag-amber','In attesa'],confirmed:['tag-green','Confermata'],rejected:['tag-red','Rifiutata']};
                  const[cls,label]=s[b.status]||['tag-gray',b.status];
                  return <div key={b.id} className="card-sm" style={{marginBottom:6,display:'flex',justifyContent:'space-between',alignItems:'center'}}><span style={{fontSize:13,fontWeight:600}}>{b.activities?.name}</span><span className={`tag ${cls}`}>{label}</span></div>;
                })}
              </div>
            )}
          </div>
        )}

        {/* ── CLASSIFICA ── */}
        {tab === "classifica" && (
          <div>
            <div className="pd-tab-title" style={{"--pg":"#FDEF26"}}>🏆 Classifica</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0 18px 14px" }}>
              <button className={`chip ${lbTimeFilter === "generale" ? "active" : ""}`} onClick={() => setLbTimeFilter("generale")}>🏆 Generale</button>
              <button className={`chip ${lbTimeFilter === "oggi" ? "active" : ""}`} style={{ borderColor: lbTimeFilter === "oggi" ? "var(--giallo)" : undefined, background: lbTimeFilter === "oggi" ? "var(--giallo)" : undefined, color: lbTimeFilter === "oggi" ? "#101010" : undefined }} onClick={() => setLbTimeFilter("oggi")}>⚡ Top 3 Oggi</button>
              <button className={`chip ${lbTimeFilter === "mese" ? "active" : ""}`} style={{ borderColor: lbTimeFilter === "mese" ? "var(--rosa)" : undefined, background: lbTimeFilter === "mese" ? "var(--rosa)" : undefined, color: lbTimeFilter === "mese" ? "#101010" : undefined }} onClick={() => setLbTimeFilter("mese")}>📅 Top 10 Mese</button>
            </div>
            <Podium ranked={lbRanked} xpData={lbTimeFilter==="oggi"?xpToday:lbTimeFilter==="mese"?xpMonth:{}} timeFilter={lbTimeFilter} highlightId={profile.id}/>
            <div className="lb-list">
              {lbRanked.slice(lbRanked.length>=3?3:0).map((p, i) => {
                const plv = getLevel(p.xp);
                const realIdx = (lbRanked.length>=3?3:0)+i;
                const xpShown = lbTimeFilter === "oggi" ? xpToday[p.id] || 0 : lbTimeFilter === "mese" ? xpMonth[p.id] || 0 : p.xp;
                const isMe = p.id === profile.id;
                return (
                  <div key={p.id} className="lb-row" style={{ border: isMe ? "1.5px solid var(--azzurro)" : undefined, background: isMe ? "rgba(163,207,254,.06)" : undefined }}>
                    <span className="lb-rank">{(realIdx+1)+"°"}</span>
                    <div className="lb-av"><Avatar url={p.avatar_url} emoji={plv.emoji} size={38} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="lb-name">{p.display_name}{isMe && <span style={{ fontSize: 10, color: "var(--azzurro)", marginLeft: 6, fontWeight: 700 }}>TU</span>}</div>
                      <div className="lb-level">{plv.emoji} {plv.name}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span className="lb-xp">{xpShown}</span>
                      <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>XP</div>
                    </div>
                  </div>
                );
              })}
              {lbRanked.length === 0 && <div className="empty">Nessun dato.</div>}
            </div>
          </div>
        )}

        {/* ── ATTIVITÀ ── */}
        {tab === "bigtop" && fullProfile && (
          <BigTopPlayerView fullProfile={fullProfile} setFullProfile={setFullProfile} />
        )}

        {tab === "attivita" && (
          <div style={{ marginTop: 8 }}>
            <div className="pd-tab-title" style={{"--pg":"#339966"}}>⚡ Lab</div>
            {/* Lab QR check-in */}
            <div className="pd-checkin" style={{marginBottom:12}}>
              <div style={{fontSize:9,fontWeight:900,textTransform:"uppercase",letterSpacing:".12em",color:"var(--neon-green)",marginBottom:8}}>📍 Check-in Lab — scansiona il QR della sessione</div>
              {showCamera ? (
                <QRScanner onScan={code=>{setShowCamera(false);doCheckin(code);}} onClose={()=>setShowCamera(false)}/>
              ) : (
                <div style={{display:"flex",gap:8}}>
                  <input className="form-input" value={qrInput} onChange={e=>setQrInput(e.target.value.toUpperCase())} placeholder="Codice Lab" style={{flex:1,textAlign:"center",fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,letterSpacing:5}} maxLength={6}/>
                  <button className="btn btn-primary" style={{flexShrink:0}} onClick={()=>doCheckin()}>✓</button>
                  <button className="btn btn-ghost btn-sm" style={{flexShrink:0,fontSize:18}} onClick={()=>setShowCamera(true)}>📷</button>
                </div>
              )}
              {qrMsg && <div style={{marginTop:8,fontSize:13,fontWeight:700,color:qrMsg.includes("✅")?"var(--verde)":"var(--danger)",textAlign:"center"}}>{qrMsg}</div>}
            </div>
            {activities.filter(a => a.description?.includes("SFIDA")).map(s => (
              <div key={s.id} className="sfida-card" style={{ marginBottom: 14 }}>
                <div className="sfida-label">⚡ Sfide</div>
                <div className="sfida-title">{s.name}</div>
                <div className="sfida-desc">{s.description?.replace("SFIDA · ", "")}</div>
                {s.image_data && <img src={s.image_data} style={{maxWidth:"100%",maxHeight:400,width:"auto",height:"auto",borderRadius:10,border:"2px solid #101010",margin:"8px auto",display:"block"}} alt=""/>}
                {(s.location||s.author_name) && <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",margin:"6px 0"}}>{s.location && <span style={{background:s.location==="BIG TOP"?"#D41323":"#339966",color:"#fff",fontWeight:800,fontSize:11,padding:"4px 10px",borderRadius:8,border:"2px solid #101010"}}>{s.location==="BIG TOP"?"🎪":"🛋️"} {s.location}</span>}{s.author_name && <span style={{fontSize:11,fontWeight:700,color:"var(--text3)"}}>🌱 {s.author_name}</span>}</div>}
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginTop:6}}>
                  <span className="sfida-reward">🏆 +{s.xp_completed} XP · 🪙 +{s.coin_completed}</span>
                  {s.link && <a href={s.link} target="_blank" rel="noreferrer" style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,color:"var(--azzurro)",fontWeight:700,textDecoration:"none",background:"rgba(163,207,254,.1)",border:"1px solid rgba(163,207,254,.25)",borderRadius:8,padding:"4px 10px"}}>🔗 Apri link</a>}
                </div>
              </div>
            ))}
            {activities.filter(a => !a.description?.includes("SFIDA")).map(a => {
              const booked = bookings.find(b => b.activities?.name === a.name || b.activity_id === a.id);
              return (
                <div key={a.id} className="act-card" style={{ marginBottom: 10 }}>
                  <div className="act-title">{a.name}</div>
                  {a.image_data && <img src={a.image_data} className="act-img" alt=""/>}
                  <div className="act-meta">{a.description}{a.duration_days ? ` · ${a.duration_days}g` : ""}</div>
                  {a.schedule && <div style={{fontSize:11,color:"#FDEF26",fontWeight:700,marginBottom:4}}>📅 {a.schedule}</div>}
                  {a.educator_id && <div style={{ fontSize: 12, color: "var(--verde)", fontWeight: 700, marginBottom: 6 }}>🌱 Lab guidato</div>}
                  {a.link && <a href={a.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "var(--azzurro)", display: "block", marginBottom: 8 }}>🔗 Scopri di più</a>}
                  <div className="act-rewards" style={{ marginBottom: 10 }}>
                    <span className="reward-tag xp-tag">Fino a {a.xp_completed} XP</span>
                    <span className="reward-tag coin-tag">🪙 {a.coin_cost} costo</span>
                  </div>
                  {a.max_participants && (
                    <div style={{
                      fontSize:11, fontWeight:800, marginBottom:8,
                      color: (actBookingCounts[a.id]||0) >= a.max_participants ? "var(--rosso)" : "var(--neon-green)",
                    }}>
                      👥 {actBookingCounts[a.id]||0}/{a.max_participants} iscritti
                      {(actBookingCounts[a.id]||0) >= a.max_participants
                        ? " · PIENO"
                        : ` · ${a.max_participants-(actBookingCounts[a.id]||0)} posti rimasti`}
                    </div>
                  )}
                  {booked && booked.status !== "cancelled" ? (
                    <div>
                      <div className={`tag ${booked.status === "confirmed" ? "tag-green" : booked.status === "rejected" ? "tag-red" : "tag-amber"}`} style={{marginBottom:booked.status==="confirmed"?6:0}}>
                        {booked.status === "confirmed" ? "✅ Iscritto" : booked.status === "rejected" ? "❌ Rifiutata" : "⏳ In attesa"}
                      </div>
                      {booked.status === "confirmed" && (
                        <button className="btn btn-ghost btn-xs" style={{width:"100%",fontSize:11}} onClick={()=>setShowCamera(true)}>
                          📷 Scansiona QR Lab · check-in sessione
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ width: "100%" }}
                      onClick={() => bookActivity(a.id, a.coin_cost)}
                      disabled={a.coin_cost > (fullProfile?.coin || 0) || (a.max_participants && (actBookingCounts[a.id]||0) >= a.max_participants)}
                    >
                      {a.coin_cost > (fullProfile?.coin || 0) ? "🪙 Coin insufficienti"
                        : (a.max_participants && (actBookingCounts[a.id]||0) >= a.max_participants) ? "🚫 Lab pieno"
                        : "Prenota"}
                    </button>
                  )}
                </div>
              );
            })}
            {activities.length === 0 && <div className="empty">Nessuna lab attiva.</div>}
          </div>
        )}

        {/* ── MESSAGGI ── */}
        {tab === "messaggi" && (
          <div>
            <div className="pd-tab-title" style={{"--pg":"#FF6DEC"}}>💬 Messaggi</div>
            {(() => {
              const now = new Date().toISOString();
              const visibleMsgs = messages.filter(m => !m.cancelled_at && (!m.expires_at || m.expires_at > now));
              return visibleMsgs.length === 0 ? <div className="empty">Nessun messaggio ricevuto.</div> : (
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {visibleMsgs.map(m => (
                    <div key={m.id} className="card-sm">
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          {m.profiles?.avatar_url
                            ? <img src={m.profiles.avatar_url} style={{width:28,height:28,borderRadius:"50%",objectFit:"cover",flexShrink:0}} alt=""/>
                            : <span style={{fontSize:18,flexShrink:0}}>🌱</span>}
                          <div>
                            <div className="msg-sender" style={{display:"inline-block",background:"#FDEF26",color:"#101010",fontWeight:800,fontSize:13,padding:"4px 10px",border:"2px solid #101010",borderRadius:8,boxShadow:"2px 2px 0 #101010",lineHeight:1.1}}>{m.profiles?.display_name||"Giardiniere"}</div>
                            <div style={{fontSize:10,color:"var(--text3)",marginTop:1}}>
                              {m.is_broadcast?"📢 a tutti":m.squad_id?"🛡️ alla squadra":"👤 a te"}
                            </div>
                          </div>
                        </div>
                        <div style={{display:"flex",gap:6,alignItems:"center"}}>
                          {m.expires_at && <span style={{fontSize:9,color:"var(--text3)"}}>⏰ {new Date(m.expires_at).toLocaleDateString("it-IT")}</span>}
                          <span style={{fontSize:10,color:"var(--text3)"}}>{new Date(m.created_at).toLocaleDateString("it-IT",{day:"numeric",month:"short"})}</span>
                        </div>
                      </div>
                      {m.media_data && m.media_data.startsWith("sticker:") && (() => {
                        const st = ANIMATED_STICKERS.find(s=>s.id===m.media_data.split(":")[1]);
                        return st ? <div style={{width:80,height:80,marginBottom:6}} dangerouslySetInnerHTML={{__html:st.svg}}/> : null;
                      })()}
                      {m.media_data && !m.media_data.startsWith("sticker:") && (
                        <img src={m.media_data} style={{maxWidth:"100%",maxHeight:240,borderRadius:12,marginBottom:6,display:"block"}} alt=""
                          onError={e => {
                            const a = document.createElement("a");
                            a.href = m.media_data; a.target = "_blank"; a.rel = "noopener";
                            a.textContent = "📷 Apri foto";
                            a.style.cssText = "display:inline-block;padding:8px 14px;background:rgba(0,0,0,.4);border:1px solid var(--border2);border-radius:10;color:var(--neon-blue);font-weight:800;font-size:13px;text-decoration:none;margin-bottom:6px";
                            e.currentTarget.replaceWith(a);
                          }}/>
                      )}
                      <MsgReactions msgId={m.id} myId={profile.id}/>
                      <div style={{fontSize:14,color:"var(--text)",lineHeight:1.5}}>{m.body}</div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {/* ── NOTIFICHE ── */}
        {tab === "social" && (
          <div className="tab-content" style={{ marginTop: 8 }}>
            <div className="pd-tab-title" style={{"--pg":"#A3CFFE"}}>🌍 Social</div>
              <SocialTab players={players} myId={profile.id} myProfile={fullProfile}/>
          </div>
        )}
        {tab === "notifiche" && (
          <div style={{ marginTop: 8 }}>
            <div style={{textAlign:"center",marginBottom:14}}>
            <div className="pd-tab-title" style={{"--pg":"#FDEF26"}}>🔔 Notifiche</div>
            {notifications.length > 0 && (
              <button onClick={async()=>{
                await sb.from("notifications").delete().eq("user_id",profile.id);
                setNotifications([]);
              }} style={{background:"rgba(255,34,68,.12)",border:"1px solid rgba(255,34,68,.3)",borderRadius:8,padding:"6px 12px",color:"var(--rosso)",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                🗑️ Cancella tutte
              </button>
            )}
          </div>
            {notifications.length === 0 ? <div className="empty">Nessuna notifica.</div> : notifications.map(n => {
              const icons = { badge_assigned: "🎖️", booking_confirmed: "✅", booking_rejected: "❌", new_activity: "⚡", level_up: "🆙", new_message: "💬", reaction: "💥", xoxo: "🆚", educator_msg: "💬", bigtop: "🎪" };
              return (
                <div key={n.id} className="notif-item" style={{cursor:"pointer"}} onClick={()=>{
                  if(!n.read_at){ sb.from("notifications").update({read_at:new Date().toISOString()}).eq("id",n.id).then(()=>{}); setNotifications(ns=>ns.map(x=>x.id===n.id?{...x,read_at:new Date().toISOString()}:x)); }
                  const t=n.type;
                  if(t==="reaction") setTab("social");
                  else if(t==="xoxo"){ setGamesTab("xoxo"); setShowGames(true); setTab("profilo"); }
                  else if(t==="educator_msg"||t==="new_message"||t==="message") setTab("messaggi");
                  else if(t==="booking_confirmed"||t==="booking_rejected"||t==="bigtop") setTab("bigtop");
                  else setTab("profilo");
                }}>
                  <div className="notif-icon">{icons[n.type] || "🔔"}</div>
                  <div style={{ flex: 1 }}>
                    <div className="notif-title">{n.title}{!n.read_at && <span className="notif-dot" />}</div>
                    <div className="notif-body">{n.body}</div>
                    <div className="notif-time">{new Date(n.created_at).toLocaleDateString("it-IT")}</div>
                  </div>
                </div>
              );
            })}
            <div style={{height:1,background:"var(--border)",margin:"24px 0 14px"}}/>
            <NotificheTab profile={profile} />
          </div>
        )}
      </div>{/* end pd-scroll */}

      {/* Badge detail modal */}
      {selectedBadge && (
        <div className="modal-bg" onClick={() => setSelectedBadge(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              {selectedBadge.badges?.image_url ? <img src={selectedBadge.badges.image_url} style={{ width:"min(300px,74vw)", height:"auto", maxHeight:"56vh", borderRadius:16, objectFit:"contain", border: "3px solid var(--rosa)", margin: "0 auto 12px", display: "block" }} alt="" /> : <div style={{ fontSize: 90, marginBottom: 10 }}>🎖️</div>}
              <div style={{ fontFamily: "'Funnel Display'", fontSize: 24, fontWeight: 900, textTransform: "uppercase", color: "var(--text)" }}>{selectedBadge.badges?.name}</div>
              <div style={{ fontSize: 13, color: "var(--azzurro)", fontWeight: 700, marginTop: 4 }}>+{selectedBadge.xp_awarded} XP · 🪙 +{selectedBadge.coin_awarded}</div>
            </div>
            {selectedBadge.badges?.description && <p style={{ fontSize: 14, color: "var(--text2)", lineHeight: 1.6, marginBottom: 12 }}>{selectedBadge.badges.description}</p>}
            {selectedBadge.badges?.link && <a href={selectedBadge.badges.link} target="_blank" rel="noreferrer" className="btn btn-ghost" style={{ width: "100%", marginBottom: 8 }}>🔗 Scopri di più</a>}
            <div style={{ fontSize: 11, color: "var(--text3)", textAlign: "center", marginBottom: 12 }}>Assegnato il {new Date(selectedBadge.assigned_at).toLocaleDateString("it-IT")}</div>
            <button className="btn btn-ghost" style={{ width: "100%" }} onClick={() => setSelectedBadge(null)}>Chiudi</button>
          </div>
        </div>
      )}

      {/* Bottom nav */}
      <div className="player-bottom-nav">
        {BOTTOM_TABS.map(([id, icon, label]) => (
          <button key={id} className={`player-nav-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            <span className="player-nav-icon">{icon}</span>
            {id === "notifiche" && unread > 0 && <span style={{ position: "absolute", top: 8, right: "calc(50% - 16px)", background: "var(--neon-pink)", color: "#fff", borderRadius: 99, fontSize: 8, fontWeight: 800, padding: "1px 4px", boxShadow: "0 0 8px rgba(255,0,204,0.6)" }}>{unread}</span>}
            {id === "messaggi" && unreadMsgs > 0 && <span style={{ position: "absolute", top: 8, right: "calc(50% - 16px)", background: "var(--neon-green)", color: "#000", borderRadius: 99, fontSize: 8, fontWeight: 800, padding: "1px 4px" }}>{unreadMsgs}</span>}
            <span className="player-nav-label">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── EDUCATOR SHELL ───────────────────────────────────────

// ─── DASHBOARD VIEW ──────────────────────────────────────

function DashboardView() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
      const today = localToday();
      const weekAgo = localDateStr(new Date(Date.now()-7*86400000));
      const monthStart = today.slice(0,7)+"-01";

      const [
        { data: players },
        { data: todayAtt },
        { data: weekAtt },
        { data: bookings },
        { data: labs },
        { data: badges },
      ] = await Promise.all([
        sb.from("profiles").select("id,display_name,xp,coin,squad_id,squads(name)").eq("role","player"),
        sb.from("attendances").select("player_id,status,xp_awarded").eq("date", today).neq("status","none"),
        sb.from("attendances").select("date,xp_awarded,player_id").gte("date", weekAgo).neq("status","none"),
        sb.from("bookings").select("status,created_at").gte("created_at", monthStart),
        sb.from("activities").select("id,name,max_participants").eq("is_active", true),
        sb.from("player_badges").select("id,created_at").gte("created_at", monthStart),
      ]);

      const active = (players||[]).filter(p=>p.xp>1);
      const totalXP = (players||[]).reduce((s,p)=>s+(p.xp||0),0);
      const totalCoin = (players||[]).reduce((s,p)=>s+(p.coin||0),0);

      // XP per day last 7 days
      const days = Array.from({length:7},(_,i)=>{
        const d = new Date(Date.now()-(6-i)*86400000);
        return { date: localDateStr(d), label: d.toLocaleDateString("it-IT",{weekday:"short"}) };
      });
      const xpByDay = {};
      const pressByDay = {};
      (weekAtt||[]).forEach(a => {
        xpByDay[a.date] = (xpByDay[a.date]||0)+(a.xp_awarded||0);
        pressByDay[a.date] = (pressByDay[a.date]||0)+1;
      });

      // Squad distribution
      const squadMap = {};
      (players||[]).forEach(p => {
        const sq = p.squads?.name||"N/A";
        squadMap[sq] = (squadMap[sq]||0)+1;
      });

      // Top 5 players
      const top5 = [...(players||[])].filter(p=>p.xp>1).sort((a,b)=>b.xp-a.xp).slice(0,5);

      setStats({ active, totalXP, totalCoin, todayAtt:todayAtt||[], days, xpByDay, pressByDay, squadMap, bookings:bookings||[], labs:labs||[], badges:badges||[], top5, allPlayers: players||[] });
      } catch(e) { }
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="loading">⏳ Caricamento dashboard…</div>;
  if (!stats) return null;

  const maxPressDay = Math.max(...stats.days.map(d=>stats.pressByDay[d.date]||0), 1);
  const SQUAD_COLORS = { Azzurra:"#A3CFFE", Gialla:"#FDEF26", Verde:"#339966", "N/A":"rgba(255,255,255,.2)" };

  return (
    <div>

      {/* Stat cards */}
      <div className="stats-grid" style={{gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",marginBottom:16}}>
        {[
          ["Giocatori attivi", stats.active.length, "🌿", "var(--neon-green)"],
          ["XP totali", stats.totalXP.toLocaleString(), "⭐", "var(--neon-blue)"],
          ["Presenti oggi", stats.todayAtt.length, "✅", "#FDEF26"],
          ["Badge questo mese", stats.badges.length, "🎖️", "var(--rosa)"],
          ["Lab attivi", stats.labs.length, "⚡", "var(--verde)"],
          ["Prenotazioni mese", stats.bookings.length, "📋", "var(--azzurro)"],
        ].map(([label,val,icon,color])=>(
          <div key={label} className="stat-card">
            <div style={{fontSize:22,marginBottom:4}}>{icon}</div>
            <div className="stat-value" style={{color,fontSize:28}}>{val}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      {/* Presenze ultimi 7 giorni */}
      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:12}}>📅 Presenze ultimi 7 giorni</div>
        <div style={{display:"flex",gap:6,alignItems:"flex-end",height:80}}>
          {stats.days.map(d=>{
            const count = stats.pressByDay[d.date]||0;
            const pct = Math.round((count/maxPressDay)*100);
            const isToday = d.date === localToday();
            return (
              <div key={d.date} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                <div style={{fontSize:10,color:"var(--neon-blue)",fontWeight:700}}>{count||""}</div>
                <div style={{width:"100%",background:isToday?"var(--neon-blue)":"rgba(163,207,254,.25)",borderRadius:"4px 4px 0 0",height:Math.max(4,pct*0.7)+"px",transition:"height .4s",minHeight:4}}/>
                <div style={{fontSize:9,color:isToday?"var(--neon-blue)":"var(--text3)",fontWeight:isToday?700:400,textTransform:"capitalize"}}>{d.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:14,marginBottom:16}}>
        {/* Top 5 players */}
        <div className="card">
          <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>🏆 Top 5 giocatori</div>
          {stats.top5.map((p,i)=>{
            const maxXp = stats.top5[0]?.xp||1;
            return (
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
                <div style={{fontSize:12,fontWeight:900,color:["#FDEF26","var(--argento)","var(--bronzo)"][i]||"var(--text3)",width:18,textAlign:"center"}}>{i+1}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--text)",marginBottom:2}}>{p.display_name||"—"}</div>
                  <div style={{height:4,background:"rgba(255,255,255,.06)",borderRadius:99,overflow:"hidden"}}>
                    <div style={{height:"100%",background:"var(--azzurro))",borderRadius:99,width:Math.round((p.xp/maxXp)*100)+"%"}}/>
                  </div>
                </div>
                <div style={{fontSize:11,fontWeight:900,color:"var(--neon-blue)"}}>{p.xp}</div>
              </div>
            );
          })}
        </div>

        {/* Squad distribution */}
        <div className="card">
          <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>🛡️ Distribuzione squadre</div>
          {Object.entries(stats.squadMap).map(([sq,count])=>{
            const total = stats.allPlayers.length||1;
            const pct = Math.round((count/total)*100);
            return (
              <div key={sq} style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{fontSize:11,fontWeight:700,color:SQUAD_COLORS[sq]||"var(--text2)"}}>{sq}</span>
                  <span style={{fontSize:11,color:"var(--text3)"}}>{count} ({pct}%)</span>
                </div>
                <div style={{height:6,background:"rgba(255,255,255,.06)",borderRadius:99,overflow:"hidden"}}>
                  <div style={{height:"100%",background:SQUAD_COLORS[sq]||"rgba(255,255,255,.2)",borderRadius:99,width:pct+"%"}}/>
                </div>
              </div>
            );
          })}

          {/* Bookings status */}
          <div style={{marginTop:12,paddingTop:10,borderTop:"1px solid var(--border)"}}>
            <div style={{fontSize:10,fontWeight:700,color:"var(--text3)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:8}}>Prenotazioni mese</div>
            <div style={{display:"flex",gap:8}}>
              {[["confirmed","✅","var(--verde)"],["pending","⏳","#FDEF26"],["rejected","❌","var(--danger)"]].map(([status,icon,color])=>{
                const c = stats.bookings.filter(b=>b.status===status).length;
                return <div key={status} style={{flex:1,textAlign:"center",padding:"6px 4px",background:"rgba(255,255,255,.03)",borderRadius:8}}>
                  <div style={{fontSize:14}}>{icon}</div>
                  <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color}}>{c}</div>
                  <div style={{fontSize:8,color:"var(--text3)",textTransform:"capitalize"}}>{status}</div>
                </div>;
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PULIZIA VIEW ────────────────────────────────────────

function PuliziaView() {
  const [players, setPlayers]   = useState([]);
  const [selected, setSelected] = useState(null); // player object
  const [notifs, setNotifs]     = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [msg, setMsg]           = useState("");

  useEffect(() => {
    sb.from("profiles").select("id,display_name,avatar_url,xp,squads(name)")
      .eq("role","player").order("display_name")
      .then(({ data }) => setPlayers(data||[]));
  }, []);

  async function loadPlayer(p) {
    setSelected(p); setLoading(true); setMsg("");
    const [{ data: n }, { data: b }] = await Promise.all([
      sb.from("notifications").select("*").eq("user_id",p.id).order("created_at",{ascending:false}),
      sb.from("bookings").select("id,status,coin_held,created_at,activities(name)").eq("player_id",p.id).order("created_at",{ascending:false}),
    ]);
    setNotifs(n||[]); setBookings(b||[]); setLoading(false);
  }

  async function loadAllPlayers() {
    setLoading(true); setMsg("");
    const { data: allNotifs } = await sb.from("notifications").select("*,profiles(display_name)").order("created_at",{ascending:false}).limit(500);
    const { data: allBookings } = await sb.from("bookings").select("id,status,coin_held,created_at,player_id,activities(name),profiles(display_name)").order("created_at",{ascending:false}).limit(500);
    setNotifs((allNotifs||[]).map(n=>({...n, _playerName: n.profiles?.display_name})));
    setBookings((allBookings||[]).map(b=>({...b, _playerName: b.profiles?.display_name})));
    setLoading(false);
  }

  async function deleteNotif(id) {
    await sb.from("notifications").delete().eq("id",id);
    setNotifs(prev => prev.filter(n=>n.id!==id));
  }

  async function deleteAllNotifs() {
    if (selected?.id === "__all__") {
      if (!confirm("Cancellare TUTTE le notifiche di TUTTI i giocatori? Operazione irreversibile.")) return;
      await sb.from("notifications").delete().in("user_id", players.map(p => p.id));
      setNotifs([]); setMsg("✅ Notifiche di tutti i giocatori cancellate");
      return;
    }
    if (!confirm(`Cancellare tutte le notifiche di ${selected.display_name}?`)) return;
    await sb.from("notifications").delete().eq("user_id",selected.id);
    setNotifs([]); setMsg("✅ Notifiche cancellate");
  }

  async function deleteBooking(bk) {
    if (!confirm(`Eliminare prenotazione di ${selected.display_name}?`)) return;
    if ((bk.coin_held||0) > 0 && bk.status !== "rejected") {
      await sb.rpc("award_xp", { p_player_id: selected.id, p_xp: 0, p_coin: bk.coin_held, p_reason: "rimborso", p_log_title: null });
      setMsg(`✅ Prenotazione eliminata · +${bk.coin_held} 🪙 rimborsate`);
    }
    await sb.from("bookings").delete().eq("id",bk.id);
    setBookings(prev=>prev.filter(b=>b.id!==bk.id));
  }

  async function deleteAllBookings() {
    if (!confirm(`Eliminare tutte le prenotazioni di ${selected.display_name}? Le coin verranno rimborsate.`)) return;
    // Rimborso calcolato in una volta sola, poi delete batch (evita N round-trip e race sulle coin)
    const refund = bookings.reduce((s,b) => s + ((b.status!=="rejected" && (b.coin_held||0)>0) ? b.coin_held : 0), 0);
    if (refund > 0) {
      await sb.rpc("award_xp", { p_player_id: selected.id, p_xp: 0, p_coin: refund, p_reason: "rimborso", p_log_title: null });
    }
    await sb.from("bookings").delete().in("id", bookings.map(b => b.id));
    setBookings([]); setMsg("✅ Prenotazioni cancellate e coin rimborsate");
  }

  const typeIcon = { badge_assigned:"🎖️", booking_confirmed:"✅", booking_rejected:"❌", new_message:"💬", level_up:"🆙", log_action:"📌" };
  const statusTag = { pending:"⏳", confirmed:"✅", rejected:"❌", cancelled:"🚫" };

  return (
    <div>
      <div style={{fontSize:12.5,fontWeight:600,color:"#101010",background:"rgba(255,255,255,.82)",padding:"8px 12px",borderRadius:10,marginBottom:16}}>Seleziona un giocatore per vedere e gestire notifiche e prenotazioni</div>

      {msg && <div style={{background:"rgba(51,153,102,.08)",border:"1px solid rgba(51,153,102,.2)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,fontWeight:700,color:"var(--neon-green)"}}>{msg}</div>}

      {/* Player selector */}
      <div style={{marginBottom:16}}>
        <label className="form-label">Giocatore</label>
        <div style={{display:"flex",gap:8}}>
          <select onChange={e=>{
            if (e.target.value === "__all__") { setSelected({id:"__all__",display_name:"Tutti i giocatori"}); loadAllPlayers(); return; }
            const p = players.find(p=>p.id===e.target.value);
            if (p) loadPlayer(p);
          }} style={{flex:1,padding:"10px 12px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:10,color:"var(--text)",fontSize:15}}>
            <option value="">Seleziona un giocatore…</option>
            <option value="__all__">🌍 Tutti i giocatori</option>
            {players.map(p=><option key={p.id} value={p.id}>{p.display_name} · {p.xp} XP</option>)}
          </select>
        </div>
      </div>

      {loading && <div className="loading">⏳ Caricamento…</div>}

      {selected && !loading && (
        <div>
          {/* Player header */}
          <div style={{display:"flex",alignItems:"center",gap:12,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:12,padding:"12px 16px",marginBottom:16}}>
            <div style={{width:44,height:44,borderRadius:"50%",border:"2px solid rgba(212,19,35,.4)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>
              {selected.id==="__all__" ? "🌍" : selected.avatar_url ? <img src={selected.avatar_url} style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"50%"}} alt=""/> : getLevel(selected.xp||0).emoji}
            </div>
            <div style={{flex:1}}>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:"#fff"}}>{selected.display_name}</div>
              <div style={{fontSize:12,color:"var(--text3)"}}>
                {selected.id==="__all__" ? `${players.length} giocatori · ${notifs.length} notifiche · ${bookings.length} prenotazioni` : `${selected.squads?.name||"Nessuna squadra"} · ${selected.xp} XP`}
              </div>
            </div>
          </div>

          {/* Notifiche */}
          <div className="card" style={{marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:"#fff"}}>🔔 Notifiche ({notifs.length})</div>
              {notifs.length>0 && <button className="btn btn-danger btn-sm" onClick={deleteAllNotifs}>🗑️ Cancella tutte</button>}
            </div>
            {notifs.length===0 ? <div className="empty" style={{padding:"12px 0"}}>Nessuna notifica</div> : (
              <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:260,overflowY:"auto"}}>
                {notifs.map(n=>(
                  <div key={n.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:"rgba(255,255,255,.03)",borderRadius:8,border:"1px solid rgba(255,255,255,.06)"}}>
                    <span style={{fontSize:16,flexShrink:0}}>{typeIcon[n.type]||"🔔"}</span>
                    <div style={{flex:1,minWidth:0}}>
                      {selected?.id==="__all__" && n._playerName && <div style={{fontSize:10,color:"#FDEF26",fontWeight:700,marginBottom:1}}>{n._playerName}</div>}
                      <div style={{fontSize:12,fontWeight:700,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n.title}</div>
                      {n.body&&<div style={{fontSize:10,color:"var(--text3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n.body}</div>}
                      <div style={{fontSize:9,color:"var(--text3)"}}>{new Date(n.created_at).toLocaleDateString("it-IT",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</div>
                    </div>
                    <button onClick={()=>deleteNotif(n.id)} style={{background:"none",border:"none",color:"rgba(255,34,68,.6)",cursor:"pointer",fontSize:14,flexShrink:0,padding:"2px 6px"}}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Prenotazioni */}
          <div className="card">
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:"#fff"}}>📋 Prenotazioni ({bookings.length})</div>
              {bookings.length>0 && <button className="btn btn-danger btn-sm" onClick={deleteAllBookings}>🗑️ Cancella tutte</button>}
            </div>
            {bookings.length===0 ? <div className="empty" style={{padding:"12px 0"}}>Nessuna prenotazione</div> : (
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {bookings.map(b=>(
                  <div key={b.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:"rgba(255,255,255,.03)",borderRadius:8,border:"1px solid rgba(255,255,255,.06)"}}>
                    <span style={{fontSize:14,flexShrink:0}}>{statusTag[b.status]||"?"}</span>
                    <div style={{flex:1,minWidth:0}}>
                      {selected?.id==="__all__" && b._playerName && <div style={{fontSize:10,color:"#FDEF26",fontWeight:700,marginBottom:1}}>{b._playerName}</div>}
                      <div style={{fontSize:12,fontWeight:700,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.activities?.name||"Lab eliminato"}</div>
                      <div style={{fontSize:10,color:"var(--text3)"}}>🪙 {b.coin_held||0} · {new Date(b.created_at).toLocaleDateString("it-IT")}</div>
                    </div>
                    <button onClick={()=>deleteBooking(b)} style={{background:"none",border:"none",color:"rgba(255,34,68,.6)",cursor:"pointer",fontSize:14,flexShrink:0,padding:"2px 6px"}}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ADMIN RESET PASSWORD ───────────────────────────────
function AdminResetPwdForm({ educator, onClose }) {
  const [newPwd, setNewPwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");

  async function reset() {
    if (newPwd.length < 8) { setErr("Minimo 8 caratteri"); return; }
    setLoading(true); setErr("");
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-educator`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${PUSH_ANON_KEY}` },
        body: JSON.stringify({ action: "reset_password", educator_id: educator.id, new_password: newPwd }),
      });
      const data = await res.json();
      setLoading(false);
      if (data.error) { setErr(data.error); return; }
      setOk(true);
      setTimeout(onClose, 2000);
    } catch(e) { setErr(e.message); setLoading(false); }
  }

  return (
    <div>
      <div className="modal-title">🔑 Reset password</div>
      <div style={{fontSize:13,color:"var(--text3)",marginBottom:14}}>Giardiniere: <strong style={{color:"var(--text)"}}>{educator.display_name}</strong></div>
      {ok ? (
        <div style={{textAlign:"center",padding:"20px 0"}}>
          <div style={{fontSize:40,marginBottom:8}}>✅</div>
          <div style={{fontWeight:700,color:"var(--neon-green)"}}>Password aggiornata!</div>
        </div>
      ) : (
        <>
          <div className="form-group">
            <label className="form-label">Nuova password</label>
            <input type="password" className="form-input" value={newPwd}
              onChange={e=>setNewPwd(e.target.value)} placeholder="Minimo 8 caratteri" autoFocus/>
          </div>
          {err && <div style={{color:"var(--danger)",fontSize:13,marginBottom:12}}>{err}</div>}
          <div style={{display:"flex",gap:8}}>
            <button className="btn btn-primary" style={{flex:1}} onClick={reset} disabled={loading||newPwd.length<8}>
              {loading?"⏳ Aggiornamento…":"Salva nuova password"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Annulla</button>
          </div>
        </>
      )}
    </div>
  );
}


// ─── ACCOUNT ADMIN (cessione account) ────────────────────
// Permette all'admin di cambiare nome visualizzato ed email di accesso,
// così l'account capo può essere ceduto a un'altra persona.
function AdminAccountCard({ profile }) {
  const [open, setOpen] = useState(false);
  const [showGames, setShowGames] = useState(false);
  const [curEmail, setCurEmail] = useState("");
  const [newName, setNewName] = useState(profile.display_name || "");
  const [newEmail, setNewEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    sb.auth.getUser().then(({ data }) => setCurEmail(data?.user?.email || "")).catch(()=>{});
  }, []);

  async function saveName() {
    setErr(""); setMsg("");
    const name = newName.trim();
    if (!name) { setErr("Il nome non può essere vuoto."); return; }
    if (name === profile.display_name) { setErr("Il nome è già questo."); return; }
    setSaving(true);
    const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", profile.id);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setMsg(`✅ Nome aggiornato in "${name}" — lo vedrai ovunque al prossimo accesso.`);
  }

  async function saveEmail() {
    setErr(""); setMsg("");
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr("Inserisci un'email valida."); return; }
    if (email === curEmail) { setErr("Questa è già l'email attuale."); return; }
    if (!confirm(`Cambiare l'email di accesso admin in:\n\n${email}\n\nVerrà inviata una mail di conferma. Finché il link non viene cliccato, continua a valere l'email attuale.`)) return;
    setSaving(true);
    const { error } = await sb.auth.updateUser({ email });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setNewEmail("");
    setMsg(`📧 Richiesta inviata! Controlla la casella di ${email} (e per sicurezza anche ${curEmail}) e clicca il link di conferma. Dopo la conferma si accede SOLO con la nuova email.`);
  }

  return (
    <div className="card-sm" style={{marginBottom:16,border:"1px solid rgba(253,239,38,.35)"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={()=>setOpen(o=>!o)}>
        <div style={{fontSize:22}}>👑</div>
        <div style={{flex:1}}>
          <div style={{fontWeight:800,color:"#FDEF26"}}>Account Admin</div>
          <div style={{fontSize:12,color:"var(--text3)"}}>Cambia nome o email per cedere l'account · {curEmail || "…"}</div>
        </div>
        <div style={{fontSize:14,color:"var(--text3)"}}>{open ? "▲" : "▼"}</div>
      </div>

      <button className="btn" style={{width:"100%",marginTop:10,background:"#A3CFFE",color:"#101010",border:"2px solid #101010",fontWeight:800}} onClick={()=>setShowGames(true)}>🎮 Giochi (PIN PUG · XOXO)</button>
      {showGames && <div className="modal-bg" onClick={()=>setShowGames(false)}><div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:410}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><div style={{fontWeight:900,fontSize:18}}>🎮 Giochi</div><button className="btn btn-ghost btn-sm" onClick={()=>setShowGames(false)}>✕</button></div><GamesHub myId={profile.id}/></div></div>}

      {open && (
        <div style={{marginTop:14}}>
          {msg && <div style={{background:"rgba(51,153,102,.1)",border:"1px solid rgba(51,153,102,.3)",borderRadius:10,padding:"10px 14px",marginBottom:10,fontSize:13,fontWeight:700,color:"var(--neon-green)"}}>{msg}</div>}
          {err && <div style={{background:"rgba(255,34,68,.1)",border:"1px solid rgba(255,34,68,.3)",borderRadius:10,padding:"10px 14px",marginBottom:10,fontSize:13,fontWeight:700,color:"var(--danger)"}}>{err}</div>}

          <div className="form-group">
            <label className="form-label">Nome visualizzato</label>
            <div style={{display:"flex",gap:8}}>
              <input className="form-input" style={{flex:1}} value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Nuovo nome"/>
              <button className="btn btn-yellow btn-sm" onClick={saveName} disabled={saving}>{saving?"⏳":"Salva"}</button>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Nuova email di accesso</label>
            <div style={{display:"flex",gap:8}}>
              <input className="form-input" type="email" style={{flex:1}} value={newEmail} onChange={e=>setNewEmail(e.target.value)} placeholder="nuova@email.it"/>
              <button className="btn btn-yellow btn-sm" onClick={saveEmail} disabled={saving||!newEmail.trim()}>{saving?"⏳":"Cambia"}</button>
            </div>
            <div style={{fontSize:11,color:"var(--text3)",marginTop:6,lineHeight:1.5}}>
              Per cedere l'account: ① inserisci qui l'email del nuovo responsabile → ② lui clicca il link di conferma che riceve → ③ cambia la password dal menu (🔑 Cambia password) e aggiorna il nome qui sopra. Da quel momento l'account admin è suo.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ADMIN VIEW ──────────────────────────────────────────

function AdminNotifiche({ profile }) {
  const [items, setItems] = useState([]);
  const [openN, setOpenN] = useState(true);
  useEffect(() => {
    load();
    const ch = sb.channel("adminnotif-" + Math.random().toString(36).slice(2))
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: "user_id=eq." + profile.id }, () => load())
      .subscribe();
    return () => { try { sb.removeChannel(ch); } catch(_){} };
  }, []);
  async function load() {
    try { const { data } = await sb.from("notifications").select("*").eq("user_id", profile.id).order("created_at", { ascending: false }).limit(40); setItems(data || []); } catch(_){}
  }
  async function markRead(n) {
    if (n.read_at) return;
    await sb.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id);
    setItems(it => it.map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
  }
  async function clearAll() {
    if (!confirm("Cancellare tutte le notifiche?")) return;
    await sb.from("notifications").delete().eq("user_id", profile.id); setItems([]);
  }
  const unread = items.filter(n => !n.read_at).length;
  const icons = { booking: "\ud83d\udccb", booking_confirmed: "\u2705", educator_msg: "\ud83d\udcac", xoxo: "\ud83c\udd9a", reaction: "\ud83d\udca5", bigtop: "\ud83c\udfaa", badge_assigned: "\ud83c\udf96\ufe0f", level_up: "\ud83c\udd99", new_player: "\ud83c\udf31" };
  return (
    <div className="card-sm" style={{ marginBottom: 16, border: "1px solid rgba(163,207,255,.4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setOpenN(o => !o)}>
        <div style={{ fontSize: 22 }}>\ud83d\udd14</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, color: "#A3CFFE" }}>Notifiche giardiniere {unread > 0 && <span style={{ background: "#FF6DEC", color: "#fff", borderRadius: 99, fontSize: 11, padding: "1px 7px", marginLeft: 6 }}>{unread}</span>}</div>
          <div style={{ fontSize: 12, color: "var(--text3)" }}>Prenotazioni, messaggi tra giardinieri, sfide</div>
        </div>
        <div style={{ fontSize: 14, color: "var(--text3)" }}>{openN ? "\u25b2" : "\u25bc"}</div>
      </div>
      {openN && <div style={{ marginTop: 12 }}>
        {items.length === 0 ? <div style={{ fontSize: 13, opacity: .6 }}>Nessuna notifica.</div> : items.map(n => (
          <div key={n.id} onClick={() => markRead(n)} style={{ display: "flex", gap: 10, padding: "8px 4px", borderBottom: "1px solid var(--border)", cursor: "pointer", opacity: n.read_at ? .55 : 1 }}>
            <div style={{ fontSize: 18 }}>{icons[n.type] || "\ud83d\udd14"}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{n.title}{!n.read_at && <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 99, background: "#FF6DEC", marginLeft: 6 }} />}</div>
              <div style={{ fontSize: 12, color: "var(--text2)" }}>{n.body}</div>
              <div style={{ fontSize: 10, color: "var(--text3)" }}>{new Date(n.created_at).toLocaleDateString("it-IT")}</div>
            </div>
          </div>
        ))}
        {items.length > 0 && <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={clearAll}>\ud83d\uddd1\ufe0f Cancella tutte</button>}
      </div>}
    </div>
  );
}
function AdminView({ profile }) {
  const [educators, setEducators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [form, setForm] = useState({ display_name:"", email:"", password:"", avatar_url:"" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [editEdu, setEditEdu] = useState(null);
  const [editAvatar, setEditAvatar] = useState(null); // {id, avatar_url}

  const [diag, setDiag] = useState([]);
  const [diagRunning, setDiagRunning] = useState(false);
  async function runDiagnostics() {
    const ADMIN_ID = "00000000-0000-0000-0000-000000000099";
    setDiagRunning(true);
    const res = [];
    const push = (name, okv, detail) => { res.push({ name, ok: okv, detail: detail || "" }); setDiag([...res]); };
    const col = async (label, table, cols) => {
      try { const { error } = await sb.from(table).select(cols).limit(1); if (error) throw new Error(error.message); push(label, true, "ok"); }
      catch (e) { push(label, false, e.message || String(e)); }
    };
    await col("Foto attività: si salvano? (migr. 020)", "activities", "image_data");
    await col("Sfide: luogo e autore si salvano? (migr. 021)", "activities", "location,author_name");
    await col("Impostazioni visibilità: si salvano?", "profiles", "app_config");
    try { const { error } = await sb.rpc("bigtop_generate_month", { p_year: 2000, p_month: 1, p_days: [], p_times: ["16:00-17:00"] }); if (error) throw new Error(error.message); push("Big Top: generazione turni OK? (migr. 024)", true, "ok (prova a vuoto)"); }
    catch (e) { push("Big Top: generazione turni OK? (migr. 024)", false, e.message || String(e)); }
    try { const { error } = await sb.rpc("bigtop_cancel_slot", { p_slot_id: "00000000-0000-0000-0000-000000000000" }); if (error && /could not find|does not exist|schema cache/i.test(error.message)) throw new Error(error.message); push("Big Top: annullo turni OK?", true, "ok"); }
    catch (e) { push("Big Top: annullo turni OK?", false, e.message || String(e)); }
    try { const { error } = await sb.rpc("verify_pin", { p_player_id: "00000000-0000-0000-0000-000000000000", p_pin: "0000" }); if (error && /could not find|does not exist|schema cache/i.test(error.message)) throw new Error(error.message); push("Accesso giocatori (PIN): risponde?", true, "ok"); }
    catch (e) { push("Accesso giocatori (PIN)", false, e.message || String(e)); }
    try { const { error } = await sb.rpc("do_checkin", { p_player_id: "00000000-0000-0000-0000-000000000000", p_code: "DIAG_NO" }); if (error && /could not find|does not exist|schema cache/i.test(error.message)) throw new Error(error.message); push("Check-in presenze: risponde?", true, "ok"); }
    catch (e) { push("Check-in presenze", false, e.message || String(e)); }
    for (const [rpc, args, lbl] of [["bigtop_book",{p_player_id:"00000000-0000-0000-0000-000000000000",p_slot_ids:[]},"Big Top: prenotazione risponde?"],["bigtop_checkin",{p_player_id:"00000000-0000-0000-0000-000000000000",p_code:"DIAG_NO"},"Big Top: check-in risponde?"],["bigtop_generate_qr",{p_slot_id:"00000000-0000-0000-0000-000000000000"},"Big Top: QR risponde?"]]) {
      try { const { error } = await sb.rpc(rpc, args); if (error && /could not find|does not exist|schema cache/i.test(error.message)) throw new Error(error.message); push(lbl, true, "ok"); }
      catch (e) { push(lbl, false, e.message || String(e)); }
    }
    try { const { error } = await sb.from("profiles").select("energia,energia_at,meals_count,meals_date").limit(1); if (error) throw new Error(error.message); push("Cibo creatura: colonne pronte? (migr. 025)", true, "ok"); }
    catch (e) { push("Cibo creatura: colonne (migr. 025)", false, e.message || String(e)); }
    try { const { error } = await sb.rpc("pug_feed", { p_player_id: "00000000-0000-0000-0000-000000000000", p_food: "diag" }); if (error && /could not find|does not exist|schema cache/i.test(error.message)) throw new Error(error.message); push("Cibo creatura: dai da mangiare risponde?", true, "ok"); }
    catch (e) { push("Cibo creatura: dai da mangiare", false, e.message || String(e)); }
    try { const { error } = await sb.from("reactions").select("id,type,created_at,badge_id,target_player_id,player_id").limit(1); if (error) throw new Error(error.message); push("Reaction: accesso e campi ok?", true, "ok"); }
    catch (e) { push("Reaction: accesso", false, e.message || String(e)); }
    try { const { error } = await sb.from("game_scores").select("id").limit(1); if (error) throw new Error(error.message); push("Giochi: classifica accessibile? (migr. 027)", true, "ok"); }
    catch (e) { push("Giochi: classifica (migr. 027)", false, e.message || String(e)); }
    try { const { error } = await sb.rpc("pong_submit", { p_player_id: "00000000-0000-0000-0000-000000000000", p_score: 0 }); if (error && /could not find|does not exist|schema cache/i.test(error.message)) throw new Error(error.message); push("Giochi: PONG salva punteggio?", true, "ok"); }
    catch (e) { push("Giochi: PONG punteggio", false, e.message || String(e)); }
    try { const { error } = await sb.from("oxo_matches").select("id").limit(1); if (error) throw new Error(error.message); push("Giochi: XOXO partite accessibili? (migr. 028)", true, "ok"); }
    catch (e) { push("Giochi: XOXO partite (migr. 028)", false, e.message || String(e)); }
    try { const { error } = await sb.rpc("oxo_move", { p_match: "00000000-0000-0000-0000-000000000000", p_player: "00000000-0000-0000-0000-000000000000", p_cell: 1 }); if (error && /could not find|does not exist|schema cache/i.test(error.message)) throw new Error(error.message); push("Giochi: XOXO mosse rispondono?", true, "ok"); }
    catch (e) { push("Giochi: XOXO mosse", false, e.message || String(e)); }
    const _tn = { activities:"Attività", bigtop_slots:"Turni Big Top", bigtop_bookings:"Prenotazioni Big Top", profiles:"Giocatori", messages:"Messaggi", badges:"Badge", player_badges:"Badge assegnati", bookings:"Prenotazioni Lab", attendances:"Presenze", xp_history:"Storico punti", squads:"Squadre", notifications:"Notifiche" };
    for (const t of ["activities","bigtop_slots","bigtop_bookings","profiles","messages","badges","player_badges","bookings","attendances","xp_history","squads","notifications"]) { await col("Accesso ai dati: " + (_tn[t]||t), t, "id"); }
    try {
      const { data: cur } = await sb.from("profiles").select("app_config").eq("id", ADMIN_ID).single();
      const okRT = await new Promise((resolve) => {
        let done = false;
        const ch = sb.channel("diag-rt-" + Math.random().toString(36).slice(2))
          .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles", filter: "id=eq." + ADMIN_ID }, () => { if (!done) { done = true; try { sb.removeChannel(ch); } catch (_) {} resolve(true); } })
          .subscribe(async (status) => { if (status === "SUBSCRIBED") { await sb.from("profiles").update({ app_config: cur?.app_config || {} }).eq("id", ADMIN_ID); } });
        setTimeout(() => { if (!done) { done = true; try { sb.removeChannel(ch); } catch (_) {} resolve(false); } }, 5000);
      });
      push("Aggiornamenti istantanei (visibilità) attivi?", okRT, okRT ? "sì, in tempo reale" : "no: abilita Realtime su 'profiles'");
    } catch (e) { push("Realtime su profiles", false, e.message || String(e)); }
    // Notifiche: scrittura + realtime end-to-end (notifica di prova a se stessi, poi cancellata)
    try {
      let testId = null;
      const okN = await new Promise((resolve) => {
        let done = false;
        const ch = sb.channel("diag-notif-" + Math.random().toString(36).slice(2))
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: "user_id=eq." + ADMIN_ID }, () => { if (!done) { done = true; resolve(true); } })
          .subscribe(async (status) => {
            if (status === "SUBSCRIBED") {
              const { data, error } = await sb.from("notifications").insert({ user_id: ADMIN_ID, type: "diag", title: "DIAG", body: "test" }).select("id").single();
              if (error) { if (!done) { done = true; resolve("insert_fail:" + error.message); } } else { testId = data?.id; }
            }
          });
        setTimeout(() => { if (!done) { done = true; resolve(false); } }, 5000);
      }).finally(async () => {});
      if (testId) { try { await sb.from("notifications").delete().eq("id", testId); } catch (_) {} }
      if (okN === true) push("Notifiche in tempo reale: OK", true, "arrivate (prova cancellata)");
      else if (typeof okN === "string" && okN.startsWith("insert_fail")) push("Notifiche: scrittura fallita", false, okN.replace("insert_fail:", ""));
      else push("Notifiche: realtime spento?", false, "scrittura ok ma nessun evento in 5s: abilita Realtime su 'notifications'");
    } catch (e) { push("Notifiche (scrittura/realtime)", false, e.message || String(e)); }
    // Messaggi: canale realtime raggiungibile
    try {
      const okM = await new Promise((resolve) => {
        let done = false;
        const ch = sb.channel("diag-msg-" + Math.random().toString(36).slice(2))
          .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {})
          .subscribe((status) => { if (!done && status === "SUBSCRIBED") { done = true; try { sb.removeChannel(ch); } catch (_) {} resolve(true); } });
        setTimeout(() => { if (!done) { done = true; try { sb.removeChannel(ch); } catch (_) {} resolve(false); } }, 4000);
      });
      push("Canale messaggi attivo?", okM, okM ? "sì (la consegna al telefono va provata sul dispositivo)" : "no: canale non connesso");
    } catch (e) { push("Canale realtime 'messages'", false, e.message || String(e)); }
    setDiagRunning(false);
  }

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await sb.from("profiles").select("id,display_name,avatar_url,xp,created_at").eq("role","educator").order("display_name");
    setEducators(data || []); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createEducator() {
    setErr(""); setMsg("");
    if (!form.display_name.trim() || !form.email.trim() || !form.password.trim()) { setErr("Nome, email e password obbligatori."); return; }
    if (form.password.length < 6) { setErr("Password minimo 6 caratteri."); return; }
    setCreating(true);
    const adminId = profile.id;
    const { data: a, error: ae } = await sb.auth.signUp({ email: form.email.trim(), password: form.password.trim() });
    if (ae) { setErr("Errore: " + ae.message); setCreating(false); return; }
    const uid = a?.user?.id;
    if (!uid) { setErr("Account non creato — email già esistente?"); setCreating(false); return; }
    const { error: pe } = await sb.from("profiles").insert({ id: uid, display_name: form.display_name.trim(), role: "educator", avatar_url: form.avatar_url.trim() || null, pin: "1234" });
    if (pe) { setErr("Profilo: " + pe.message); setCreating(false); return; }
    setMsg(`✅ Giardiniere "${form.display_name}" creato! Email: ${form.email} · Password: ${form.password}`);
    setForm({ display_name:"", email:"", password:"", avatar_url:"" }); setShowCreate(false); load();
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user?.id !== adminId) { await sb.auth.signOut(); window.location.reload(); }
    setCreating(false);
  }

  async function saveEdu(e) {
    await sb.from("profiles").update({ display_name: e.display_name, avatar_url: e.avatar_url || null }).eq("id", e.id);
    setEditEdu(null); load();
  }

  async function saveAvatar(id, url) {
    await sb.from("profiles").update({ avatar_url: url || null }).eq("id", id);
    setEditAvatar(null); load();
  }

  async function deleteEdu(id, name) {
    if (!confirm(`Eliminare il giardiniere "${name}"?`)) return;
    await sb.from("profiles").delete().eq("id", id); load();
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 16, border: "3px solid #101010" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: diag.length ? 10 : 0 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>🔧 Diagnostica (solo admin)</div>
          <button className="btn btn-sm" style={{ background: "#FDEF26", color: "#101010", border: "2.5px solid #101010", boxShadow: "3px 3px 0 #101010", fontWeight: 800 }} disabled={diagRunning} onClick={runDiagnostics}>{diagRunning ? "⏳ Test in corso…" : "▶️ Esegui test"}</button>
        </div>
        {diag.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {diag.map((d, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13 }}>
                <span>{d.ok ? "✅" : "❌"}</span>
                <div><div style={{ fontWeight: 700 }}>{d.name}</div>{d.detail && <div style={{ fontSize: 11, color: d.ok ? "var(--text3)" : "#D41323" }}>{d.detail}</div>}</div>
              </div>
            ))}
            <div style={{ fontSize: 12, fontWeight: 800, marginTop: 6 }}>{diag.filter(d => d.ok).length}/{diag.length} test superati</div>
          </div>
        )}
      </div>
      {resetTarget && (
        <div className="modal-bg" onClick={()=>setResetTarget(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <AdminResetPwdForm educator={resetTarget} onClose={()=>setResetTarget(null)}/>
          </div>
        </div>
      )}

      <AdminNotifiche profile={profile} />
      <AdminAccountCard profile={profile} />
      {msg && <div style={{background:"rgba(51,153,102,.1)",border:"1px solid rgba(51,153,102,.3)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,fontWeight:700,color:"var(--neon-green)"}}>{msg}</div>}
      {err && <div style={{background:"rgba(255,34,68,.1)",border:"1px solid rgba(255,34,68,.3)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,fontWeight:700,color:"var(--danger)"}}>{err}</div>}

      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
        <button className="btn btn-yellow btn-sm" onClick={()=>{setShowCreate(true);setErr("");setMsg("");}}>+ Nuovo giardiniere</button>
      </div>

      {/* Lista educators */}
      {loading ? <div className="loading">⏳</div> : (
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
          {educators.length === 0 && <div className="empty">Nessun giardiniere ancora.</div>}
          {educators.map(e => (
            <div key={e.id} className="card-sm" style={{display:"flex",alignItems:"center",gap:12}}>
              <div style={{width:40,height:40,borderRadius:"50%",overflow:"hidden",border:"2px solid rgba(253,239,38,.3)",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>
                {e.avatar_url ? <img src={e.avatar_url} style={{width:"100%",height:"100%",objectFit:"cover"}} alt=""/> : "🌱"}
              </div>
              <div style={{flex:1}}>
                {editEdu?.id === e.id ? (
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <input className="form-input" value={editEdu.display_name} onChange={ev=>setEditEdu(p=>({...p,display_name:ev.target.value}))} style={{flex:1,minWidth:120,padding:"6px 10px"}} placeholder="Nome"/>
                    <input className="form-input" value={editEdu.avatar_url||""} onChange={ev=>setEditEdu(p=>({...p,avatar_url:ev.target.value}))} style={{flex:1,minWidth:120,padding:"6px 10px"}} placeholder="/avatars/nome.webp"/>
                    <button className="btn btn-primary btn-xs" onClick={()=>saveEdu(editEdu)}>✓</button>
                    <button className="btn btn-ghost btn-xs" onClick={()=>setEditEdu(null)}>✕</button>
                  </div>
                ) : (
                  <div>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--text)"}}>{e.display_name}</div>
                    <div style={{fontSize:11,color:"var(--text3)"}}>Creato: {new Date(e.created_at).toLocaleDateString("it-IT")}</div>
                  </div>
                )}
              </div>
              {editEdu?.id !== e.id && (
                <div style={{display:"flex",gap:6}}>
                  <button className="btn btn-ghost btn-xs" onClick={()=>setEditEdu({...e})}>✏️</button>
                  <button className="btn btn-ghost btn-xs" onClick={()=>setEditAvatar({id:e.id,display_name:e.display_name,avatar_url:e.avatar_url||""})} title="Cambia avatar">🖼️</button>
                  <button className="btn btn-danger btn-xs" onClick={()=>deleteEdu(e.id,e.display_name)}>🗑️</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modal avatar editor */}
      {editAvatar && (
        <div className="modal-bg" onClick={()=>setEditAvatar(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-title">🖼️ Cambia avatar giardiniere</div>
            {editAvatar.avatar_url && (
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,padding:"8px",background:"rgba(253,239,38,.06)",border:"1px solid rgba(253,239,38,.2)",borderRadius:10}}>
                <img src={editAvatar.avatar_url} style={{width:52,height:52,objectFit:"contain",borderRadius:8}} alt=""/>
                <div style={{fontSize:12,color:"#FDEF26",flex:1}}>{editAvatar.avatar_url.split("/").pop().replace(".webp","")}</div>
                <button className="btn btn-ghost btn-xs" onClick={()=>setEditAvatar(p=>({...p,avatar_url:""}))}>✕</button>
              </div>
            )}
            <div className="section-label">Scegli dall'archivio giardinieri</div>
            <AvatarPicker selected={editAvatar.avatar_url} onSelect={url=>setEditAvatar(p=>({...p,avatar_url:url}))} squadFilter="Giardinieri"/>
            <div style={{height:1,background:"var(--border)",margin:"12px 0"}}/>
            <div className="section-label">Oppure carica una foto</div>
            <InlineAvatarUpload playerId={editAvatar.id} onUploaded={url=>{setEditAvatar(p=>({...p,avatar_url:url}));saveAvatar(editAvatar.id,url);}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button className="btn btn-primary" style={{flex:1}} onClick={()=>saveAvatar(editAvatar.id,editAvatar.avatar_url)}>Salva avatar</button>
              <button className="btn btn-ghost btn-sm" style={{color:"rgba(253,239,38,.8)",borderColor:"rgba(253,239,38,.3)"}} onClick={()=>{setEditAvatar(null);setResetTarget(editAvatar);}}>🔑 Password</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>setEditAvatar(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}

      {/* Form crea */}
      {showCreate && (
        <div className="card" style={{border:"1px solid rgba(253,239,38,.25)"}}>
          <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:22,fontWeight:900,color:"#FDEF26",marginBottom:14}}>Nuovo giardiniere</div>
          <div className="form-group"><label className="form-label">Nome visualizzato *</label><input className="form-input" value={form.display_name} onChange={e=>setForm(f=>({...f,display_name:e.target.value}))} placeholder="es. Massi"/></div>
          <div className="form-group"><label className="form-label">Email *</label><input className="form-input" type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="giardiniere@email.com"/></div>
          <div className="form-group"><label className="form-label">Password * (min 6 caratteri)</label><input className="form-input" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} placeholder="es. pug2026!"/></div>
          <div className="form-group">
            <label className="form-label">Avatar</label>
            {form.avatar_url && (
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,padding:"8px",background:"rgba(253,239,38,.06)",border:"1px solid rgba(253,239,38,.2)",borderRadius:10}}>
                <img src={form.avatar_url} style={{width:44,height:44,objectFit:"contain",borderRadius:8}} alt=""/>
                <div style={{flex:1,fontSize:12,color:"#FDEF26"}}>{form.avatar_url.split("/").pop().replace(".webp","")}</div>
                <button className="btn btn-ghost btn-xs" onClick={()=>setForm(f=>({...f,avatar_url:""}))}>✕</button>
              </div>
            )}
            <AvatarPicker selected={form.avatar_url} onSelect={url=>setForm(f=>({...f,avatar_url:url}))} squadFilter="Giardinieri"/>
            <div style={{height:1,background:"var(--border)",margin:"8px 0"}}/>
            <div style={{fontSize:10,color:"var(--text3)",marginBottom:4}}>Oppure carica una foto:</div>
            <InlineAvatarUpload playerId={"new_edu_" + Date.now()} onUploaded={url=>setForm(f=>({...f,avatar_url:url}))}/>
          </div>
          <div style={{display:"flex",gap:8,marginTop:4}}>
            <button className="btn btn-primary" style={{flex:1}} onClick={createEducator} disabled={creating}>{creating?"⏳ Creazione…":"Crea giardiniere"}</button>
            <button className="btn btn-ghost btn-sm" onClick={()=>setShowCreate(false)}>Annulla</button>
          </div>
          <div style={{fontSize:11,color:"var(--text3)",marginTop:10}}>💡 Comunica email e password al giardiniere. Accede dal tab "Giardiniere" nel login.</div>
        </div>
      )}
    </div>
  );
}

// ─── BIG TOP 🎪: tab giocatore ──────────────────────────────────
function BigTopPlayerView({ fullProfile, setFullProfile }) {
  const now = new Date();
  const CUR = { y: now.getFullYear(), m: now.getMonth() + 1 };
  const NEXT = CUR.m === 12 ? { y: CUR.y + 1, m: 1 } : { y: CUR.y, m: CUR.m + 1 };
  const [cursor, setCursor] = useState(CUR);
  const [slots, setSlots] = useState([]);
  const [counts, setCounts] = useState({});
  const [mine, setMine] = useState({});      // slot_id -> status
  const [sel, setSel] = useState(new Set());
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const [openDay, setOpenDay] = useState(null);
  const isNext = cursor.m === NEXT.m && cursor.y === NEXT.y;
  const monthName = new Date(cursor.y, cursor.m - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });

  const load = useCallback(async () => {
    setLoading(true);
    const from = `${cursor.y}-${String(cursor.m).padStart(2,"0")}-01`;
    const toD = new Date(cursor.y, cursor.m, 0).getDate();
    const to = `${cursor.y}-${String(cursor.m).padStart(2,"0")}-${String(toD).padStart(2,"0")}`;
    const { data: sl } = await sb.from("bigtop_slots").select("*").gte("date", from).lte("date", to).is("cancelled_at", null).order("date").order("start_time");
    const ids = (sl || []).map(s => s.id);
    let bk = [];
    if (ids.length) {
      const { data } = await sb.from("bigtop_bookings").select("slot_id,player_id,status").in("slot_id", ids);
      bk = data || [];
    }
    const cnt = {}, my = {};
    bk.forEach(b => {
      if (["booked","present"].includes(b.status)) cnt[b.slot_id] = (cnt[b.slot_id] || 0) + 1;
      if (b.player_id === fullProfile.id) my[b.slot_id] = b.status;
    });
    setSlots(sl || []); setCounts(cnt); setMine(my); setSel(new Set()); setLoading(false);
  }, [cursor, fullProfile.id]);

  useEffect(() => { load(); }, [load]);

  function canCancel(s) {
    // fino alle 22:00 del giorno prima
    const d = new Date(s.date + "T22:00:00");
    d.setDate(d.getDate() - 1);
    return new Date() <= d;
  }
  function bookable(s) {
    return s.date >= localToday() && !mine[s.id] && (counts[s.id] || 0) < s.max_participants;
  }
  function toggle(sid) {
    setSel(prev => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });
  }

  async function book() {
    if (sel.size === 0) return;
    setBusy(true); setMsg("");
    const { data: r, error } = await sb.rpc("bigtop_book", { p_player_id: fullProfile.id, p_slot_ids: [...sel] });
    setBusy(false);
    if (error || r?.error) { setMsg("❌ " + (error?.message || r.error)); return; }
    const errs = (r.errors || []).length;
    setMsg(r.booked > 0 ? `🎪 Prenotati ${r.booked} turni!${errs ? ` (${errs} non disponibili)` : ""}` : "⚠️ Nessun turno prenotato (pieni o non disponibili)");
    playPixel("checkin");
    if (r.booked > 0) {
      const nm = fullProfile?.display_name||"Un giocatore";
      sb.from("profiles").select("id").in("role",["educator","admin"]).then(({ data: edus }) => {
        (edus||[]).forEach(e => sendPush(e.id, "🎪 Nuova prenotazione Big Top", `${nm} ha prenotato ${r.booked} turno/i`).catch(()=>{}));
        const rows=(edus||[]).map(e=>({user_id:e.id,type:"bigtop",title:"🎪 Nuova prenotazione Big Top",body:`${nm} ha prenotato ${r.booked} turno/i`}));
        if(rows.length) sb.from("notifications").insert(rows).then(()=>{}).catch(()=>{});
      });
    }
    load();
  }

  async function cancel(sid) {
    if (!confirm("Disdire questa prenotazione?")) return;
    const { data: r, error } = await sb.rpc("bigtop_cancel", { p_player_id: fullProfile.id, p_slot_id: sid });
    if (error || r?.error) {
      setMsg(r?.error === "troppo_tardi" ? "⏰ Troppo tardi per disdire (entro le 22:00 del giorno prima)" : "❌ " + (error?.message || r?.error));
      return;
    }
    setMsg("Prenotazione disdetta 👍");
    load();
  }

  async function checkin() {
    if (code.trim().length < 4) return;
    setBusy(true); setMsg("");
    const { data: r, error } = await sb.rpc("bigtop_checkin", { p_player_id: fullProfile.id, p_code: code.trim() });
    setBusy(false);
    if (error) { setMsg("❌ Errore di rete, riprova"); return; }
    if (r?.error) {
      const M = { invalid_code: "❌ Codice non valido (o non è il giorno del turno)", already: "✅ Check-in già fatto per questo turno!", pieno: "😕 Turno pieno, niente posti walk-in" };
      setMsg(M[r.error] || "❌ " + r.error);
      return;
    }
    setFullProfile(prev => ({ ...prev, xp: r.new_xp, coin: r.new_coin }));
    setMsg(`🎪 Check-in BIG TOP ${r.slot}!${r.xp > 0 ? ` +${r.xp} XP` : ""}${r.coin > 0 ? ` +${r.coin} 🪙` : ""}`);
    setCode("");
    playPixel("checkin");
    load();
  }

  // Raggruppa per data
  const byDate = {};
  slots.forEach(s => { (byDate[s.date] = byDate[s.date] || []).push(s); });

  return (
    <div style={{ marginTop: 8 }}>
      <div className="pd-tab-title" style={{"--pg":"#D41323"}}>🎪 BIG TOP</div>

      <div className="btcal-claim">
        🎪 Il BIG TOP è <b>gratis</b>! Prenota i turni che vuoi, anche tutto il mese.<br/>
        Disdici entro le 22:00 del giorno prima — se prenoti e non vieni: <b>−2 🪙</b>
      </div>

      {msg && <div className="btcal-msg">{msg}</div>}

      <div className="btcal-legend">
        <span><i style={{background:"#FDEF26"}}/>liberi</span>
        <span><i style={{background:"#339966"}}/>prenotato</span>
        <span><i style={{background:"#FF6DEC"}}/>pieno</span>
        <span><i style={{background:"#d6d6d6"}}/>passato</span>
      </div>

      <div className="btcal-head">
        <button className="btcal-nav" disabled={!isNext} onClick={()=>setCursor(CUR)}>‹</button>
        <div className="btcal-title">{monthName}</div>
        <button className="btcal-nav" disabled={isNext} onClick={()=>setCursor(NEXT)}>›</button>
      </div>

      {loading ? <div style={{textAlign:"center",padding:"18px 0",fontWeight:700}}>⏳ Caricamento…</div> : (
       <>
        <div className="btcal-grid btcal-dow">
          {["Lun","Mar","Mer","Gio","Ven","Sab","Dom"].map(d=><div key={d} className="btcal-dowc">{d}</div>)}
        </div>
        <div className="btcal-grid">
          {(()=>{
            const first=(new Date(cursor.y,cursor.m-1,1).getDay()+6)%7;
            const dim=new Date(cursor.y,cursor.m,0).getDate();
            const cells=[];
            for(let i=0;i<first;i++) cells.push(<div key={"b"+i} className="btcal-cell blank"/>);
            for(let d=1;d<=dim;d++){
              const dk=`${cursor.y}-${String(cursor.m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
              const ds=byDate[dk]; let cls="", turni=0, free=0;
              if(ds){
                turni=ds.length;
                free=ds.reduce((a,x)=>a+Math.max(0,x.max_participants-(counts[x.id]||0)),0);
                if(dk<localToday()) cls="past";
                else if(ds.some(x=>["booked","present"].includes(mine[x.id]))) cls="mine";
                else if(free<=0) cls="full";
                else cls="free";
              }
              const today = dk===localToday() ? " today":"";
              const opened = dk===openDay ? " open":"";
              cells.push(
                <div key={dk} className={`btcal-cell ${cls}${today}${opened}`} onClick={ds?()=>setOpenDay(dk):undefined}>
                  <span className="btcal-d">{d}</span>
                  {ds && cls!=="past" && <span className="btcal-info">{turni}t · {cls==="full"?"pieno":free+"p"}</span>}
                </div>
              );
            }
            return cells;
          })()}
        </div>

        {openDay && byDate[openDay] && (
          <div className="btcal-panel">
            <span className="btcal-tape">{new Date(openDay+"T12:00").toLocaleDateString("it-IT",{weekday:"long",day:"numeric",month:"long"})}</span>
            {byDate[openDay].map(s=>{
              const my=mine[s.id];
              const free=s.max_participants-(counts[s.id]||0);
              const isPast=s.date<localToday();
              const selectable=bookable(s);
              let cls="btcal-turno";
              if(my==="booked"||my==="present") cls+=" mine";
              else if(isPast) cls+=" past";
              else if(free<=0) cls+=" full";
              else if(sel.has(s.id)) cls+=" sel";
              return (
                <div key={s.id} className={cls} onClick={selectable?()=>toggle(s.id):undefined}>
                  <div style={{flex:1}}>
                    <div className="btcal-tt">{s.start_time.slice(0,5)}–{s.end_time.slice(0,5)}</div>
                    <div className="btcal-tm">
                      {my==="present"?"✅ Presente!":my==="booked"?"📌 Sei prenotato":my==="absent"?"❌ Assente":free<=0?"😕 Pieno":`${free} ${free===1?"posto libero":"posti liberi"}`}
                      {(s.xp_checkin>0||s.coin_checkin>0)?` · ${s.xp_checkin>0?`+${s.xp_checkin} XP`:""}${s.coin_checkin>0?` +${s.coin_checkin} 🪙`:""}`:""}
                    </div>
                  </div>
                  {my==="booked"&&!isPast&&canCancel(s)
                    ? <button className="btcal-disdici" onClick={e=>{e.stopPropagation();cancel(s.id);}}>Disdici</button>
                    : selectable ? <span className="btcal-cap">{sel.has(s.id)?"✓":"＋"}</span>
                    : null}
                </div>
              );
            })}
          </div>
        )}

        {slots.length===0 && <div style={{textAlign:"center",padding:"18px 0",fontWeight:700}}>Nessun turno in programma questo mese 🎪</div>}
       </>
      )}

      {sel.size>0 && (
        <button className="btcal-book" disabled={busy} onClick={book}>
          {busy?"⏳…":`🎪 Prenota ${sel.size} ${sel.size===1?"turno":"turni"}`}
        </button>
      )}

      <div className="btcal-checkin" style={{marginTop:16}}>
        <div className="btcal-checkin-h">📍 Check-in del giorno — inserisci il codice del turno</div>
        <div style={{display:"flex",gap:8}}>
          <input className="btcal-code" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="CODICE" maxLength={8}/>
          <button className="btcal-code-btn" disabled={busy||code.trim().length<4} onClick={checkin}>{busy?"⏳":"Vai"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── BIG TOP 🎪: pannello educatore ─────────────────────────────
function BigTopEducatorView({ profile }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });
  const [slots, setSlots] = useState([]);
  const [books, setBooks] = useState({});   // slot_id -> array prenotazioni
  const [expanded, setExpanded] = useState(null);
  const [editSlot, setEditSlot] = useState(null);
  const [qrShow, setQrShow] = useState({}); // slot_id -> code
  const [players, setPlayers] = useState([]);
  const [bookFor, setBookFor] = useState("");
  const [squadsList, setSquadsList] = useState([]);
  const [detailPlayer, setDetailPlayer] = useState(null);
  const [msgTo, setMsgTo] = useState(null);   // { id, name }
  const [msgBody, setMsgBody] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [genDays, setGenDays] = useState([2,4]);
  const [genTimes, setGenTimes] = useState([{start:"16:00",end:"17:00"},{start:"17:00",end:"18:00"}]);

  const monthName = new Date(cursor.y, cursor.m - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });

  const load = useCallback(async () => {
    setLoading(true);
    const from = `${cursor.y}-${String(cursor.m).padStart(2,"0")}-01`;
    const toD = new Date(cursor.y, cursor.m, 0).getDate();
    const to = `${cursor.y}-${String(cursor.m).padStart(2,"0")}-${String(toD).padStart(2,"0")}`;
    const { data: sl } = await sb.from("bigtop_slots").select("*").gte("date", from).lte("date", to).order("date").order("start_time");
    const ids = (sl || []).map(s => s.id);
    let bk = [];
    if (ids.length) {
      const { data, error } = await sb.from("bigtop_bookings").select("*, profiles!bigtop_bookings_player_id_fkey(display_name, avatar_url, squads(name, color))").in("slot_id", ids);
      if (error) addToast("❌ Prenotazioni: " + error.message, "error");
      bk = data || [];
    }
    const map = {};
    bk.forEach(b => { (map[b.slot_id] = map[b.slot_id] || []).push(b); });
    setSlots(sl || []); setBooks(map); setLoading(false);
  }, [cursor]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    sb.from("profiles").select("id,display_name").eq("role","player").order("display_name")
      .then(({ data }) => setPlayers(data || []));
    sb.from("squads").select("*").then(({ data }) => setSquadsList(data || []));
  }, []);

  async function sendQuickMsg() {
    const body = msgBody.trim();
    if (!body || !msgTo) return;
    setSending(true);
    const { data: m, error } = await sb.from("messages")
      .insert({ sender_id: profile.id, recipient_id: msgTo.id, body, is_broadcast: false })
      .select("id").single();
    if (error) { addToast("❌ " + error.message, "error"); setSending(false); return; }
    await sb.from("notifications").insert({
      user_id: msgTo.id, type: "new_message",
      title: `💬 Messaggio da ${profile.display_name}`,
      body: body.slice(0, 80), message_id: m?.id || null,
    });
    sendPush(msgTo.id, `💬 ${profile.display_name}`, body.slice(0, 100)).catch(()=>{});
    addToast(`✉️ Inviato a ${msgTo.name}`, "ok");
    setSending(false); setMsgTo(null); setMsgBody("");
  }

  function taken(sid) { return (books[sid] || []).filter(b => ["booked","present"].includes(b.status)).length; }
  function isPast(s) { return s.date < localToday(); }

  async function generateMonth() {
    setBusy(true);
    const { data: r, error } = await sb.rpc("bigtop_generate_month", { p_year: cursor.y, p_month: cursor.m, p_days: genDays, p_times: genTimes.map(t=>t.start+"-"+t.end) });
    setBusy(false);
    if (error || r?.error) { addToast("❌ " + (error?.message || r.error), "error"); return; }
    addToast(r.created > 0 ? `🎪 Creati ${r.created} turni di ${monthName}` : "Turni già tutti presenti", "ok");
    load();
  }

  async function showQr(sid) {
    if (qrShow[sid]) { setQrShow(q => { const n = { ...q }; delete n[sid]; return n; }); return; }
    const { data: r, error } = await sb.rpc("bigtop_generate_qr", { p_slot_id: sid });
    if (error || r?.error || !r?.code) { addToast("❌ QR: " + (error?.message || r?.error || ""), "error"); return; }
    setQrShow(q => ({ ...q, [sid]: r.code }));
  }

  async function saveSlot() {
    const s = editSlot;
    const { error } = await sb.from("bigtop_slots").update({
      start_time: s.start_time, end_time: s.end_time,
      max_participants: Number(s.max_participants) || 10,
      xp_checkin: Number(s.xp_checkin) || 0, coin_checkin: Number(s.coin_checkin) || 0,
    }).eq("id", s.id);
    if (error) { addToast("❌ " + error.message, "error"); return; }
    setEditSlot(null); addToast("✅ Turno aggiornato", "ok"); load();
  }

  async function markAbsents(s) {
    if (!confirm(`Segnare come ASSENTI tutti i prenotati senza check-in del turno ${s.date.split("-").reverse().join("/")} ${s.start_time.slice(0,5)}?\n\nOgnuno riceverà −2 🪙 e una notifica.`)) return;
    const { data: r, error } = await sb.rpc("bigtop_mark_absents", { p_slot_id: s.id });
    if (error || r?.error) { addToast("❌ " + (error?.message || r.error), "error"); return; }
    addToast(r.absents > 0 ? `Segnati ${r.absents} assenti (−2 🪙 ciascuno)` : "Nessun assente da segnare", "ok");
    load();
  }

  async function markAllPresent(s) {
    if (!confirm(`Segnare PRESENTI tutti i prenotati del turno ${s.date.split("-").reverse().join("/")} ${s.start_time.slice(0,5)}?`)) return;
    const { data: qr, error: qe } = await sb.rpc("bigtop_generate_qr", { p_slot_id: s.id });
    if (qe || qr?.error || !qr?.code) { addToast("❌ " + (qe?.message || qr?.error || "QR non generato"), "error"); return; }
    const { data: bks } = await sb.from("bigtop_bookings").select("player_id,status").eq("slot_id", s.id);
    const toMark = (bks || []).filter(b => b.status !== "cancelled" && b.status !== "checked_in");
    if (!toMark.length) { addToast("Nessun prenotato da segnare presente", "ok"); return; }
    let done = 0, fail = 0;
    for (const b of toMark) {
      const { data: r, error } = await sb.rpc("bigtop_checkin", { p_player_id: b.player_id, p_code: qr.code });
      if (error || r?.error) fail++; else done++;
    }
    addToast(`\u2705 Presenti: ${done}${fail ? ` \u00b7 ${fail} non riusciti` : ""}`, done ? "ok" : "error");
    load();
  }

  async function cancelSlot(s) {
    if (!confirm(`Annullare il turno del ${s.date.split("-").reverse().join("/")} ${s.start_time.slice(0,5)}?\n\nGli iscritti riceveranno una notifica.`)) return;
    const { data: r, error } = await sb.rpc("bigtop_cancel_slot", { p_slot_id: s.id });
    if (error || r?.error) { addToast("❌ " + (error?.message || r.error), "error"); return; }
    addToast(`Turno annullato (avvisati ${r.notified})`, "ok");
    load();
  }

  async function cancelMonth() {
    const fut = slots.filter(s => !s.cancelled_at && s.date >= localToday());
    if (!fut.length) { addToast("Nessun turno futuro da annullare", "error"); return; }
    if (!confirm(`Annullare ${fut.length} turni futuri di questo mese? Gli iscritti verranno avvisati.`)) return;
    setBusy(true);
    for (const s of fut) { await sb.rpc("bigtop_cancel_slot", { p_slot_id: s.id }); }
    addToast("Turni futuri annullati", "ok"); load(); setBusy(false);
  }

  async function notifyPlayers() {
    const { data } = await sb.from("profiles").select("id").eq("role","player");
    const ids = (data||[]).map(p=>p.id);
    if (!ids.length) { addToast("Nessun giocatore", "error"); return; }
    await sb.from("notifications").insert(ids.map(pid=>({ user_id:pid, type:"bigtop", title:"🎪 Nuovi turni Big Top", body:"I NUOVI TURNI DEL BIG TOP SONO DISPONIBILI, PRENOTATI SUBITO!" })));
    try { sendPushToAll(ids, "🎪 Big Top", "I nuovi turni del Big Top sono disponibili, prenotati subito!"); } catch(e){}
    addToast("Giocatori avvisati", "ok");
  }

  async function bookForPlayer(sid) {
    if (!bookFor) { addToast("Scegli un giocatore", "error"); return; }
    const { data: r, error } = await sb.rpc("bigtop_book", { p_player_id: bookFor, p_slot_ids: [sid] });
    if (error || r?.error) { addToast("❌ " + (error?.message || r.error), "error"); return; }
    if (r.booked > 0) addToast("✅ Prenotato!", "ok");
    else addToast("⚠️ " + ((r.errors?.[0]?.why) || "non prenotabile").replace(/_/g, " "), "error");
    load();
  }

  const STATUS = { booked: ["📌", "prenotato", "var(--neon-blue)"], present: ["✅", "presente", "#339966"], absent: ["❌", "assente", "#D41323"], cancelled: ["🚫", "disdetto", "var(--text3)"] };

  return (
    <div>
      <div style={{textAlign:"center",marginBottom:14}}>
        <div className="section-banner-title" style={{ "--pg": "#D41323", color: "#101010", marginBottom: 10 }}>🎪 Big Top</div>
        <div style={{display:"flex",alignItems:"center",gap:6,justifyContent:"center"}}>
          <button className="btn btn-ghost btn-xs" onClick={()=>setCursor(c=>({ y: c.m===1?c.y-1:c.y, m: c.m===1?12:c.m-1 }))}>‹</button>
          <div style={{fontWeight:800,minWidth:130,textAlign:"center",textTransform:"capitalize",background:"rgba(255,255,255,.85)",color:"#101010",padding:"4px 12px",borderRadius:8}}>{monthName}</div>
          <button className="btn btn-ghost btn-xs" onClick={()=>setCursor(c=>({ y: c.m===12?c.y+1:c.y, m: c.m===12?1:c.m+1 }))}>›</button>
        </div>
      </div>

      <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center",marginBottom:8}}>
        {[[1,"LUN"],[2,"MAR"],[3,"MER"],[4,"GIO"],[5,"VEN"],[6,"SAB"],[0,"DOM"]].map(([dow,lbl])=>(
          <button key={dow} type="button" onClick={()=>setGenDays(g=>g.includes(dow)?g.filter(x=>x!==dow):[...g,dow])} className="btn btn-xs" style={{background:genDays.includes(dow)?"#101010":"#fff",color:genDays.includes(dow)?"#FDEF26":"#101010",border:"2px solid #101010",fontWeight:800,padding:"5px 10px"}}>{lbl}</button>
        ))}
      </div>
      <div style={{marginBottom:8}}>
        {genTimes.map((t,i)=>(
          <div key={i} style={{display:"flex",gap:6,alignItems:"center",justifyContent:"center",marginBottom:6}}>
            <input type="time" className="form-input" value={t.start} onChange={e=>setGenTimes(g=>g.map((x,j)=>j===i?{...x,start:e.target.value}:x))} style={{width:118}}/>
            <span style={{fontWeight:800}}>–</span>
            <input type="time" className="form-input" value={t.end} onChange={e=>setGenTimes(g=>g.map((x,j)=>j===i?{...x,end:e.target.value}:x))} style={{width:118}}/>
            {genTimes.length>1 && <button type="button" className="btn btn-xs" onClick={()=>setGenTimes(g=>g.filter((_,j)=>j!==i))} style={{border:"2px solid #101010",background:"#fff",color:"#101010",fontWeight:800}}>✕</button>}
          </div>
        ))}
        <div style={{textAlign:"center"}}><button type="button" className="btn btn-xs" onClick={()=>setGenTimes(g=>[...g,{start:"18:00",end:"19:00"}])} style={{border:"2px solid #101010",background:"#fff",color:"#101010",fontWeight:800}}>➕ Aggiungi orario</button></div>
      </div>
      <button className="btn btn-yellow btn-sm" style={{width:"100%",marginBottom:14}} disabled={busy || genDays.length===0 || genTimes.length===0} onClick={generateMonth}>
        {busy ? "⏳…" : `➕ Genera turni di ${monthName}`}
      </button>
      <button className="btn btn-sm" style={{width:"100%",marginBottom:14,background:"#fff",color:"#D41323",border:"3px solid #101010",boxShadow:"3px 3px 0 #101010",fontWeight:800}} disabled={busy} onClick={cancelMonth}>🗑️ Annulla turni futuri del mese</button>
      <button className="btn" style={{width:"100%",marginBottom:14,background:"#FDEF26",color:"#101010",border:"3px solid #101010",boxShadow:"4px 4px 0 #101010",fontWeight:900,fontSize:16,padding:"14px 12px",textTransform:"uppercase",letterSpacing:".01em"}} onClick={notifyPlayers}>🔔 Avvisa i giocatori dei nuovi turni</button>

      {loading ? <div style={{color:"var(--text3)",fontSize:13}}>⏳ Caricamento…</div> :
       slots.length === 0 ? <div style={{color:"var(--text3)",fontSize:13,textAlign:"center",padding:"20px 0"}}>Nessun turno questo mese — premi "Genera turni"</div> :
      slots.filter(s => !s.cancelled_at).map(s => {
        const t = taken(s.id);
        const dead = !!s.cancelled_at;
        return (
        <div key={s.id} className="card" style={{marginBottom:10,opacity:dead?.55:1}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div>
              <div style={{fontWeight:900,fontSize:15}}>
                {new Date(s.date+"T12:00").toLocaleDateString("it-IT",{weekday:"short",day:"numeric",month:"short"})} · {s.start_time.slice(0,5)}–{s.end_time.slice(0,5)}
                {dead && <span style={{color:"#D41323",fontSize:11,marginLeft:8}}>ANNULLATO</span>}
              </div>
              <div style={{fontSize:12,color:"var(--text3)"}}>
                👥 {t}/{s.max_participants} · {s.xp_checkin>0 && `+${s.xp_checkin} XP `}{s.coin_checkin>0 && `+${s.coin_checkin} 🪙`}{s.xp_checkin===0&&s.coin_checkin===0&&"nessun punto extra"}
              </div>
            </div>
            <div style={{display:"flex",gap:6,marginLeft:"auto",flexWrap:"wrap"}}>
              {!dead && <button className="btn btn-ghost btn-xs" onClick={()=>showQr(s.id)}>{qrShow[s.id]?"▲ QR":"📍 QR"}</button>}
              {!dead && <button className="btn btn-ghost btn-xs" style={{color:"#FDEF26"}} onClick={()=>setEditSlot({...s})}>✏️</button>}
              <button className="btn btn-ghost btn-xs" onClick={()=>setExpanded(expanded===s.id?null:s.id)}>👥</button>
              {!dead && isPast(s) === false && s.date === localToday() && null}
              {!dead && <button className="btn btn-ghost btn-xs" style={{color:"#339966"}} onClick={()=>markAllPresent(s)}>Presenti</button>}
              {!dead && s.date <= localToday() && <button className="btn btn-ghost btn-xs" style={{color:"#D41323"}} onClick={()=>markAbsents(s)}>Assenti</button>}
              {!dead && s.date >= localToday() && <button className="btn btn-ghost btn-xs" style={{color:"#D41323"}} onClick={()=>cancelSlot(s)}>🚫</button>}
            </div>
          </div>

          {qrShow[s.id] && (
            <div style={{marginTop:10,background:"rgba(0,0,0,.5)",borderRadius:12,padding:12,textAlign:"center",border:"1px solid rgba(163,207,254,.2)"}}>
              <div style={{fontSize:10,color:"var(--text3)",marginBottom:6,textTransform:"uppercase",letterSpacing:".08em"}}>QR BIG TOP · {s.start_time.slice(0,5)}–{s.end_time.slice(0,5)}</div>
              <img src={`https://api.qrserver.com/v1/create-qr-code/?data=${qrShow[s.id]}&size=180x180&bgcolor=ffffff&color=000000&qzone=1`} alt={qrShow[s.id]} style={{width:180,height:180,borderRadius:8,display:"block",margin:"0 auto 8px"}}/>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,color:"var(--neon-blue)",letterSpacing:8,cursor:"pointer"}}
                onClick={()=>navigator.clipboard?.writeText(qrShow[s.id]).then(()=>addToast("📋 Codice copiato!","ok")).catch(()=>{})}>{qrShow[s.id]}</div>
              <div style={{fontSize:10,color:"rgba(255,255,255,.4)",marginTop:4}}>Valido solo il giorno del turno</div>
            </div>
          )}

          {expanded === s.id && (
            <div style={{marginTop:10,borderTop:"1px solid var(--border2)",paddingTop:10}}>
              {(books[s.id]||[]).length === 0 && <div style={{fontSize:12,color:"var(--text3)"}}>Nessuna prenotazione</div>}
              {(books[s.id]||[]).map(b => {
                const [ic, lbl, col] = STATUS[b.status] || ["·", b.status, "var(--text3)"];
                const pr = b.profiles || {};
                return (
                  <div key={b.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",fontSize:13,borderBottom:"1px solid rgba(255,255,255,.05)"}}>
                    {pr.avatar_url
                      ? <img src={pr.avatar_url} alt="" style={{width:30,height:30,borderRadius:"50%",objectFit:"cover",flexShrink:0}}/>
                      : <div style={{width:30,height:30,borderRadius:"50%",background:"var(--surface2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>👤</div>}
                    <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>setDetailPlayer(b.player_id)} title="Apri scheda giocatore">
                      <div style={{fontWeight:800,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{pr.display_name || "?"}</div>
                      {pr.squads?.name && <div style={{fontSize:10,fontWeight:800,color:pr.squads.color||"var(--text3)"}}>{pr.squads.name}</div>}
                    </div>
                    <span style={{fontSize:11,color:col,fontWeight:800,textTransform:"uppercase"}}>{ic} {lbl}</span>
                    <button className="btn btn-ghost btn-xs" title="Scrivi al giocatore"
                      onClick={()=>{ setMsgTo({ id: b.player_id, name: pr.display_name || "?" }); setMsgBody(""); }}>✉️</button>
                  </div>
                );
              })}
              {!dead && s.date >= localToday() && (
                <div style={{display:"flex",gap:6,marginTop:8}}>
                  <select value={bookFor} onChange={e=>setBookFor(e.target.value)}
                    style={{flex:1,padding:"7px 9px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:8,color:"var(--text)",fontSize:13}}>
                    <option value="">Prenota per un giocatore…</option>
                    {players.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}
                  </select>
                  <button className="btn btn-primary btn-xs" onClick={()=>bookForPlayer(s.id)}>➕</button>
                </div>
              )}
            </div>
          )}
        </div>
      );})}

      {msgTo && (
        <div className="modal-bg" onClick={()=>setMsgTo(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-title">✉️ Messaggio a {msgTo.name}</div>
            <textarea value={msgBody} onChange={e=>setMsgBody(e.target.value)} rows={4}
              placeholder="Scrivi qui… (es. Ci vediamo domani al BIG TOP alle 16!)"
              style={{width:"100%",padding:"10px 12px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:10,color:"var(--text)",fontSize:14,resize:"vertical"}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button className="btn btn-primary" style={{flex:1}} disabled={sending||!msgBody.trim()} onClick={sendQuickMsg}>{sending?"⏳…":"Invia"}</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>setMsgTo(null)}>Annulla</button>
            </div>
            <div style={{fontSize:10,color:"var(--text3)",marginTop:8}}>Arriva nella sua tab Messaggi, con notifica e push.</div>
          </div>
        </div>
      )}

      {detailPlayer && <PlayerDetailPanel playerId={detailPlayer} squads={squadsList} onClose={()=>setDetailPlayer(null)} />}

      {editSlot && (
        <div className="modal-bg" onClick={()=>setEditSlot(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-title">✏️ Modifica turno</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div><label className="form-label">Inizio</label><input className="form-input" type="time" value={editSlot.start_time.slice(0,5)} onChange={e=>setEditSlot(s=>({...s,start_time:e.target.value}))}/></div>
              <div><label className="form-label">Fine</label><input className="form-input" type="time" value={editSlot.end_time.slice(0,5)} onChange={e=>setEditSlot(s=>({...s,end_time:e.target.value}))}/></div>
              <div><label className="form-label">Max partecipanti</label><input className="form-input" type="number" value={editSlot.max_participants} onChange={e=>setEditSlot(s=>({...s,max_participants:e.target.value}))}/></div>
              <div/>
              <div><label className="form-label">XP check-in</label><input className="form-input" type="number" value={editSlot.xp_checkin} onChange={e=>setEditSlot(s=>({...s,xp_checkin:e.target.value}))}/></div>
              <div><label className="form-label">Coin check-in</label><input className="form-input" type="number" value={editSlot.coin_checkin} onChange={e=>setEditSlot(s=>({...s,coin_checkin:e.target.value}))}/></div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button className="btn btn-primary" style={{flex:1}} onClick={saveSlot}>Salva</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>setEditSlot(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const EDUCATOR_TABS = [
  ["dashboard","📊","Dashboard"], ["giocatori","👤","Giocatori"], ["classifica","🏆","Classifica"], ["squadre","🛡️","Squadre"],
  ["presenze","✅","Presenze"], ["attivita","⚡","Lab"], ["bigtop","🎪","BIG TOP"], ["sfida","🔥","Sfida"],
  ["badge","🎖️","Badge"], ["streak","🔥","Streak"], ["prenotazioni","📋","Prenotazioni"], ["messaggi","💬","Messaggi"],
  ["diario","📜","Diario"], ["qr","📍","QR"], ["annunci","📢","Annunci"], ["bacheca","📌","Bacheca"], ["social_edu","🌍","Social"], ["export","📤","Export"], ["pulizia","🧹","Pulizia"], ["visibilita","👁️","Vista"], ["notifiche","🔔","Notifiche"], ["admin","⚙️","Admin"],
]

// Macro-cartelle per la sidebar giardiniere
const EDUCATOR_GROUPS = [
  { id:"gioco", icon:"🎮", label:"Gioco",
    tabs:["dashboard","giocatori","classifica","squadre","presenze","qr"] },
  { id:"attivita_grp", icon:"⚡", label:"Attività",
    tabs:["attivita","bigtop","sfida","badge","streak","prenotazioni"] },
  { id:"comunicazione", icon:"💬", label:"Comunicazione",
    tabs:["messaggi","annunci","bacheca","social_edu"] },
  { id:"gestione", icon:"📊", label:"Gestione",
    tabs:["diario","export","pulizia","visibilita","notifiche","admin"] },
];
const MOB_TABS_IDS = ["giocatori", "presenze", "classifica", "sfida", "qr"];

// ─── CSV EXPORT UTILITY ──────────────────────────────────

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(c => `"${String(c==null?"":c).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function ExportView() {
  const [loading, setLoading] = useState("");
  const [dFrom, setDFrom] = useState("");
  const [dTo, setDTo] = useState("");
  const _range = () => (dFrom||dTo) ? `_${dFrom||"inizio"}_${dTo||"oggi"}` : "";

  async function exportPlayers() {
    setLoading("players");
    const { data } = await sb.from("profiles").select("display_name,first_name,xp,coin,current_streak,longest_streak,squads(name)").eq("role","player").order("xp",{ascending:false});
    const rows = [["Nickname","Nome","Squadra","XP","Coin","Streak attuale","Streak record","Livello"]];
    (data||[]).forEach(p => rows.push([p.display_name, p.first_name||"", p.squads?.name||"", p.xp, p.coin, p.current_streak||0, p.longest_streak||0, getLevel(p.xp).name]));
    downloadCSV(rows, `pug_giocatori_${localToday()}.csv`);
    setLoading("");
  }

  async function exportAttendances() {
    setLoading("att");
    let _qa = sb.from("attendances").select("date,check_type,status,xp_awarded,coin_awarded,qr_verified,activity_id,profiles(display_name)").order("date",{ascending:false}).limit(5000);
    if (dFrom) _qa = _qa.gte("date", dFrom);
    if (dTo) _qa = _qa.lte("date", dTo);
    const { data: att } = await _qa;
    const actIds = [...new Set((att||[]).map(a=>a.activity_id).filter(Boolean))];
    let actMap = {};
    if (actIds.length) {
      const { data: acts } = await sb.from("activities").select("id,name").in("id",actIds);
      actMap = Object.fromEntries((acts||[]).map(a=>[a.id,a.name]));
    }
    const rows = [["Giocatore","Data","Tipo","Lab","Stato","XP","Coin","QR Verificato"]];
    (att||[]).forEach(a => rows.push([a.profiles?.display_name||"—", a.date, a.check_type==="lab"?"Lab":"Giornaliero", a.activity_id?actMap[a.activity_id]||"Lab":"—", a.status, a.xp_awarded||0, a.coin_awarded||0, a.qr_verified?"Sì":"No"]));
    downloadCSV(rows, `pug_presenze${_range()}_${localToday()}.csv`);
    setLoading("");
  }

  async function exportLabs() {
    setLoading("labs");
    const { data: acts } = await sb.from("activities").select("id,name,schedule,duration_days,max_participants,xp_completed,coin_cost").eq("is_active",true);
    const { data: bk } = await sb.from("bookings").select("activity_id,player_id,status");
    const { data: att } = await sb.from("attendances").select("activity_id,player_id").eq("check_type","lab");
    const rows = [["Lab","Giorni/Orari","Durata (gg)","Max partecipanti","XP max","Prenotazioni confermate","Check-in totali"]];
    (acts||[]).forEach(a => {
      const confirmed = (bk||[]).filter(b=>b.activity_id===a.id&&b.status==="confirmed").length;
      const checkins = (att||[]).filter(b=>b.activity_id===a.id).length;
      rows.push([a.name, a.schedule||"—", a.duration_days, a.max_participants||"∞", a.xp_completed, confirmed, checkins]);
    });
    downloadCSV(rows, `pug_lab_${localToday()}.csv`);
    setLoading("");
  }

  async function exportHistory() {
    setLoading("hist");
    let _qh = sb.from("notifications").select("title,body,type,created_at,profiles(display_name)").order("created_at",{ascending:false}).limit(5000);
    if (dFrom) _qh = _qh.gte("created_at", dFrom + "T00:00:00");
    if (dTo) _qh = _qh.lte("created_at", dTo + "T23:59:59");
    const { data } = await _qh;
    const rows = [["Giocatore","Azione","Dettaglio","Tipo","Data"]];
    (data||[]).filter(n=>n.profiles).forEach(n => rows.push([n.profiles?.display_name||"—", n.title, n.body||"", n.type, new Date(n.created_at).toLocaleDateString("it-IT")]));
    downloadCSV(rows, `pug_storico${_range()}_${localToday()}.csv`);
    setLoading("");
  }

  const exports = [
    { id:"players", label:"👥 Giocatori", desc:"Nickname, nome, squadra, XP, Coin, streak, livello", fn: exportPlayers, color:"var(--azzurro)" },
    { id:"att",     label:"📅 Presenze complete", desc:"Tutte le presenze: data, tipo, lab, XP, QR verificato", fn: exportAttendances, color:"var(--neon-green)" },
    { id:"labs",    label:"⚡ Riepilogo Lab", desc:"Lab attivi con prenotazioni e check-in totali", fn: exportLabs, color:"#FDEF26" },
    { id:"hist",    label:"📜 Storico azioni", desc:"Tutte le azioni: badge, punti, messaggi, prenotazioni", fn: exportHistory, color:"var(--rosa)" },
  ];

  return (
    <div>
      <div style={{fontSize:13,fontWeight:600,color:"#101010",background:"rgba(255,255,255,.82)",padding:"8px 12px",borderRadius:10,marginBottom:20}}>I file vengono scaricati in formato CSV, compatibile con Excel, Google Fogli e Numbers.</div>
      <div style={{display:"flex",gap:8,alignItems:"flex-end",marginBottom:12,flexWrap:"wrap"}}>
        <div><label className="form-label" style={{fontSize:10,marginBottom:2}}>Dal</label><input type="date" className="form-input" value={dFrom} onChange={e=>setDFrom(e.target.value)} style={{width:150}}/></div>
        <div><label className="form-label" style={{fontSize:10,marginBottom:2}}>Al</label><input type="date" className="form-input" value={dTo} onChange={e=>setDTo(e.target.value)} style={{width:150}}/></div>
        {(dFrom||dTo) && <button className="btn btn-ghost btn-xs" onClick={()=>{setDFrom("");setDTo("");}}>Azzera</button>}
      </div>
      <div style={{fontSize:11,color:"var(--text3)",marginBottom:12}}>L\u2019intervallo di date si applica a <b>Presenze</b> e <b>Storico azioni</b> (gli altri esportano tutto).</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {exports.map(ex=>(
          <div key={ex.id} style={{background:"var(--surface)",border:"1.5px solid var(--border2)",borderRadius:14,padding:"16px 18px",display:"flex",alignItems:"center",gap:14}}>
            <div style={{flex:1}}>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:"var(--text)",marginBottom:3}}>{ex.label}</div>
              <div style={{fontSize:12,color:"var(--text3)"}}>{ex.desc}</div>
            </div>
            <button className="btn btn-ghost btn-sm" style={{flexShrink:0,minWidth:100}} onClick={ex.fn} disabled={loading===ex.id}>
              {loading===ex.id ? "⏳ Export…" : "⬇️ Scarica"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── PRESENTATION MODE ────────────────────────────────────

function PresentationMode({ onClose, settings }) {
  const cfg = settings || { title:"🏆 Classifica PUG", squadFilter:"all", topN:0, podioDuration:10, scrollSpeed:"medium" };
  const speedMap = { slow:0.3, medium:0.6, fast:1.2 };
  const [allPlayers, setAllPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase]     = useState("podio");
  const scrollRef = useRef(null);
  const animRef   = useRef(null);

  useEffect(() => {
    sb.from("profiles").select("id,display_name,avatar_url,xp,squads(name)")
      .eq("role","player").gt("xp",0).order("xp",{ascending:false})
      .then(({data}) => { setAllPlayers(data||[]); setLoading(false); });
    const handler = e => { if(e.key==="Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Filter and limit players
  const players = allPlayers
    .filter(p => cfg.squadFilter === "all" || p.squads?.name === cfg.squadFilter)
    .slice(0, cfg.topN > 0 ? cfg.topN : allPlayers.length);

  // Switch to lista after podioDuration seconds
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => setPhase("lista"), (cfg.podioDuration || 10) * 1000);
    return () => clearTimeout(t);
  }, [loading, cfg.podioDuration]);

  // Auto-scroll ticker
  useEffect(() => {
    if (phase !== "lista") return;
    const el = scrollRef.current;
    if (!el) return;
    let pos = 0;
    const speed = speedMap[cfg.scrollSpeed] || 0.6;
    function tick() {
      pos += speed;
      if (pos >= el.scrollHeight / 2) pos = 0;
      el.scrollTop = pos;
      animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [phase, players, cfg.scrollSpeed]);

  const stars = Array.from({length:60},(_,i)=>({
    left:Math.random()*100+"%", top:Math.random()*100+"%",
    animationDelay:(Math.random()*3)+"s", opacity:Math.random()*.8+.2,
    width:(Math.random()*3+1)+"px", height:(Math.random()*3+1)+"px",
  }));

  const order = [1,0,2];
  const medals = ["🥈","🥇","🥉"];
  const medalColors = ["var(--argento)","#FDEF26","var(--bronzo)"];

  if (loading) return (
    <div className="pres-overlay">
      <div style={{color:"#A3CFFE",fontFamily:"'Funnel Display',sans-serif",fontSize:32,fontWeight:900}}>⏳ Caricamento…</div>
    </div>
  );

  // Doubled list for seamless loop
  const doubled = [...players, ...players];

  return (
    <div className="pres-overlay">
      <div className="pres-stars">{stars.map((s,i)=><div key={i} className="pres-star" style={s}/>)}</div>
      <button className="pres-close" onClick={onClose}>✕ ESC</button>

      {/* Phase dots */}
      <div style={{position:"absolute",bottom:14,left:"50%",transform:"translateX(-50%)",display:"flex",gap:8,zIndex:5}}>
        <button onClick={()=>setPhase("podio")} style={{width:10,height:10,borderRadius:"50%",background:phase==="podio"?"#FDEF26":"rgba(255,255,255,.2)",border:"none",cursor:"pointer"}}/>
        <button onClick={()=>setPhase("lista")} style={{width:10,height:10,borderRadius:"50%",background:phase==="lista"?"#FDEF26":"rgba(255,255,255,.2)",border:"none",cursor:"pointer"}}/>
      </div>

      {/* ── PODIO ── */}
      {phase==="podio" && (
        <>
          <div className="pres-title">{cfg.title || "🏆 Classifica PUG"}</div>
          <div className="pres-podium-wrap">
            {order.map((pos,i) => {
              const p = players[pos];
              if (!p) return <div key={i} style={{width:"clamp(80px,12vw,120px)"}}/>;
              const lv = getLevel(p.xp);
              const avCls = ["pres-av pres-av-2","pres-av pres-av-1","pres-av pres-av-3"][i];
              const baseCls = ["pres-base pres-base-2","pres-base pres-base-1","pres-base pres-base-3"][i];
              const rnkCls = ["pres-rank pres-rank-2","pres-rank pres-rank-1","pres-rank pres-rank-3"][i];
              const colCls = ["pres-col pres-col-2","pres-col pres-col-1","pres-col pres-col-3"][i];
              return (
                <div key={p.id} className={colCls}>
                  {i===1 && <div className="pres-crown">👑</div>}
                  <div className={avCls} style={{fontSize:i===1?"52px":i===0?"40px":"34px"}}>
                    {p.avatar_url ? <img src={p.avatar_url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : lv.emoji}
                  </div>
                  <div className="pres-pname" style={{color:medalColors[i]}}>{p.display_name}</div>
                  <div className="pres-pxp" style={{color:medalColors[i]}}>{(p.xp||0).toLocaleString()} XP</div>
                  <div className={baseCls}><span className={rnkCls}>{medals[i]}</span></div>
                </div>
              );
            })}
          </div>
          {/* Mini lista sotto il podio */}
          <div style={{display:"flex",flexDirection:"column",gap:4,width:"100%",maxWidth:400,padding:"0 20px"}}>
            {players.slice(3,8).map((p,i)=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,background:"rgba(255,255,255,.04)",borderRadius:8,padding:"6px 12px"}}>
                <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:16,fontWeight:900,color:"var(--text3)",width:28,textAlign:"center"}}>{i+4}°</div>
                <div style={{fontSize:14,fontWeight:700,color:"#fff",flex:1}}>{p.display_name}</div>
                <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:16,fontWeight:900,color:"var(--neon-blue)"}}>{(p.xp||0).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── LISTA SCORREVOLE ── */}
      {phase==="lista" && (
        <>
          <div className="pres-title" style={{fontSize:"clamp(20px,4vw,44px)",marginBottom:"clamp(8px,2vh,16px)"}}>
            {cfg.squadFilter !== "all" ? `🛡️ Squadra ${cfg.squadFilter}` : "🌿 Tutti i giocatori"} · {players.length}
          </div>
          <div ref={scrollRef} style={{width:"100%",maxWidth:560,overflow:"hidden",height:"65vh",padding:"0 16px"}}>
            {doubled.map((p,i) => {
              const lv = getLevel(p.xp||0);
              const rank = (i % players.length) + 1;
              const isTop = rank <= 3;
              const colors = ["#FDEF26","var(--argento)","var(--bronzo)"];
              return (
                <div key={i} style={{
                  display:"flex",alignItems:"center",gap:12,
                  background:isTop?"rgba(253,239,38,.07)":"rgba(255,255,255,.04)",
                  borderRadius:10,padding:"10px 14px",marginBottom:6,
                  borderLeft:isTop?`3px solid ${colors[rank-1]}`:"3px solid transparent",
                }}>
                  <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:22,fontWeight:900,width:38,textAlign:"center",color:isTop?colors[rank-1]:"var(--text3)"}}>{rank}°</div>
                  <div style={{width:36,height:36,borderRadius:"50%",overflow:"hidden",border:`2px solid ${isTop?colors[rank-1]:"rgba(255,255,255,.15)"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
                    {p.avatar_url?<img src={p.avatar_url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:lv.emoji}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.display_name}</div>
                    <div style={{fontSize:10,color:p.squads?.name?"var(--azzurro)":"var(--text3)",fontWeight:600}}>{p.squads?.name||lv.name}</div>
                  </div>
                  <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:22,fontWeight:900,color:isTop?colors[rank-1]:"var(--neon-blue)",flexShrink:0}}>{(p.xp||0).toLocaleString()}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const EduTabColors = {
  dashboard:    { accent:"#A3CFFE", border:"rgba(163,207,254,.3)",   bg:"rgba(163,207,254,.03)" },
  export:       { accent:"#339966", border:"rgba(51,153,102,.3)",   bg:"rgba(51,153,102,.03)" },
  pulizia:      { accent:"#D41323", border:"rgba(212,19,35,.3)",   bg:"rgba(212,19,35,.03)" },
  bacheca:      { accent:"#FDEF26", border:"rgba(253,239,38,.3)",   bg:"rgba(253,239,38,.03)" },
  annunci:      { accent:"#FDEF26", border:"rgba(253,239,38,.3)",   bg:"rgba(253,239,38,.03)" },
  social_edu:   { accent:"#339966", border:"rgba(51,153,102,.3)",   bg:"rgba(51,153,102,.03)" },
  visibilita:   { accent:"#A3CFFE", border:"rgba(163,207,254,.3)",   bg:"rgba(163,207,254,.03)" },
  admin:        { accent:"#FDEF26", border:"rgba(253,239,38,.3)",   bg:"rgba(253,239,38,.03)" },
  giocatori:    { accent:"#A3CFFE", border:"rgba(163,207,254,.3)", bg:"rgba(163,207,254,.03)" },
  classifica:   { accent:"#FDEF26", border:"rgba(253,239,38,.3)",   bg:"rgba(253,239,38,.03)" },
  squadre:      { accent:"#A3CFFE", border:"rgba(163,207,254,.3)",   bg:"rgba(163,207,254,.03)" },
  presenze:     { accent:"#339966", border:"rgba(51,153,102,.3)",   bg:"rgba(51,153,102,.03)" },
  attivita:     { accent:"#339966", border:"rgba(51,153,102,.3)",   bg:"rgba(51,153,102,.03)" },
  sfida:        { accent:"var(--rosso)", border:"rgba(255,34,68,.3)",   bg:"rgba(255,34,68,.03)" },
  badge:        { accent:"#ff00cc", border:"rgba(255,0,204,.3)",   bg:"rgba(255,0,204,.03)" },
  streak:       { accent:"#D41323", border:"rgba(212,19,35,.3)",   bg:"rgba(212,19,35,.03)" },
  prenotazioni: { accent:"#FDEF26", border:"rgba(253,239,38,.3)",   bg:"rgba(253,239,38,.03)" },
  messaggi:     { accent:"#FF6DEC", border:"rgba(255,109,236,.3)",  bg:"rgba(255,109,236,.03)" },
  diario:       { accent:"#A3CFFE", border:"rgba(163,207,254,.3)", bg:"rgba(163,207,254,.03)" },
  qr:           { accent:"#A3CFFE", border:"rgba(163,207,254,.3)",   bg:"rgba(163,207,254,.03)" },
};

function EducatorShell({ profile, onLogout }) {
  const [tab, setTab] = useState("dashboard");
  const [openGroup, setOpenGroup] = useState("gioco");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url);
  const [theme, setTheme] = useState(() => { try { return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"; } catch(_) { return "light"; } });
  const [sectionColors, setSectionColors] = useState(DEFAULT_SECTION_COLORS);
  const [showPresentation, setShowPresentation] = useState(false);
  const [showPresSettings, setShowPresSettings] = useState(false);
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [visibility, setVisibility] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pug_visibility") || "{}"); } catch(_) { return {}; }
  });
  function saveVisibility(key, val) {
    const next = { ...visibility, [key]: val };
    setVisibility(next);
    localStorage.setItem("pug_visibility", JSON.stringify(next));
  }
  const [presSettings, setPresSettings] = useState({
    title: "🏆 Classifica PUG",
    squadFilter: "all",
    topN: 0, // 0 = tutti
    podioDuration: 10,
    scrollSpeed: "medium", // slow/medium/fast
  });
  const [notifCounts, setNotifCounts] = useState({ pendingBookings:0, missingAttendance:0, total:0 });
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  // Load educator notification counts
  const loadNotifCounts = useCallback(async () => {
    const today = localToday();
    const since24h = new Date(Date.now()-24*3600000).toISOString();
    const [{ count: pendingCount }, { data: allPlayers }, { data: todayAtt }, { count: msgCount }] = await Promise.all([
      sb.from("bookings").select("id", { count: "exact", head: true }).eq("status","pending"),
      sb.from("profiles").select("id").eq("role","player").gt("xp", 1),
      sb.from("attendances").select("player_id").eq("date", today),
      sb.from("messages").select("id", { count: "exact", head: true }).eq("recipient_id", profile.id)
        .is("cancelled_at", null).gt("expires_at", new Date().toISOString())
        .gt("created_at", since24h),
    ]);
    const markedIds = new Set((todayAtt||[]).map(a => a.player_id));
    const missing = (allPlayers||[]).filter(p => !markedIds.has(p.id)).length;
    const pBook = pendingCount || 0;
    const msgs = msgCount || 0;
    setNotifCounts({ pendingBookings: pBook, missingAttendance: 0, unreadMessages: msgs, total: pBook + msgs });
  }, [profile.id]);

  const notifDebounceRef = useRef(null);
  const debouncedLoadNotif = useCallback(() => {
    clearTimeout(notifDebounceRef.current);
    notifDebounceRef.current = setTimeout(loadNotifCounts, 800);
  }, [loadNotifCounts]);

    useEffect(() => {
    const g = EDUCATOR_GROUPS.find(grp => grp.tabs.includes(tab));
    if (g) setOpenGroup(g.id);
  }, [tab]);

  useEffect(() => {
    loadNotifCounts();
    const interval = setInterval(loadNotifCounts, 90000);
    const channel = sb.channel("edu_realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "bookings" }, debouncedLoadNotif)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "bookings" }, debouncedLoadNotif)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages",
          filter: `recipient_id=eq.${profile.id}` }, (payload) => {
        loadNotifCounts();
        const m = payload.new;
        showInAppNotif("💬 Nuovo messaggio", m?.body?.slice(0,60)||"Hai un nuovo messaggio");
        playPixel("msg");
      })
      .subscribe();
    return () => { clearInterval(interval); sb.removeChannel(channel); };
  }, [loadNotifCounts]);

  const cur = EDUCATOR_TABS.find(t => t[0] === tab);
  const lv = getLevel(profile.xp || 0);
  const mobTabs = EDUCATOR_TABS.filter(t => MOB_TABS_IDS.includes(t[0]));

  useEffect(() => { document.body.classList.toggle("light", theme === "light"); }, [theme]);

  const sharedProps = { sectionColors, setSectionColors, profile };

  return (
    <div className="edu-layout">
      
      {/* Sidebar desktop */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <div className="pd-logo-img logo-b" style={{width:130,height:42,margin:"0 auto"}}/>
          <div className="pd-logo-img logo-w" style={{width:130,height:42,margin:"0 auto"}}/>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8,marginTop:6}}>
            <div style={{width:76,height:76,borderRadius:16,overflow:"hidden",border:"3px solid #101010",boxShadow:"3px 3px 0 #101010"}}><Avatar url={profile.avatar_url} emoji="🌱" size={76}/></div>
            <div style={{fontFamily:"'Funnel Display',sans-serif",fontWeight:800,fontSize:16,background:"#FDEF26",color:"#101010",padding:"5px 14px",border:"2px solid #101010",borderRadius:10,transform:"rotate(-1.5deg)",boxShadow:"2px 2px 0 #101010"}}>{profile.display_name}</div>
          </div>
        </div>
        <nav className="nav">
          {EDUCATOR_GROUPS.map(group => {
            // Voci del gruppo (Admin solo per ruolo admin)
            const groupTabs = group.tabs
              .filter(tid => tid !== "admin" || profile.role === "admin")
              .map(tid => EDUCATOR_TABS.find(t => t[0] === tid))
              .filter(Boolean);
            if (groupTabs.length === 0) return null;
            const isOpen = openGroup === group.id;
            const hasActiveTab = groupTabs.some(([tid]) => tid === tab);
            // Badge totale del gruppo (somma notifiche delle voci dentro)
            let groupBadge = 0;
            groupTabs.forEach(([tid]) => {
              if (tid === "prenotazioni") groupBadge += notifCounts.pendingBookings || 0;
              if (tid === "presenze" && notifCounts.missingAttendance > 0) groupBadge += 1;
              if (tid === "notifiche") groupBadge += notifCounts.unreadMessages || 0;
            });
            return (
              <div key={group.id} style={{marginBottom:4}}>
                {/* Intestazione cartella */}
                <div
                  className="nav-item"
                  onClick={() => setOpenGroup(isOpen ? null : group.id)}
                  style={{
                    fontWeight:800,
                    background: hasActiveTab && !isOpen ? "rgba(163,207,254,.08)" : undefined,
                  }}>
                  <span className="nav-icon">{group.icon}</span>
                  <span style={{flex:1}}>{group.label}</span>
                  {groupBadge > 0 && !isOpen && <span className="nav-badge">{groupBadge}</span>}
                  <span style={{fontSize:11,opacity:.5,transition:"transform .2s",
                    transform:isOpen?"rotate(90deg)":"rotate(0deg)",display:"inline-block"}}>▶</span>
                </div>
                {/* Voci della cartella */}
                {isOpen && groupTabs.map(([id, icon, label]) => (
                  <div key={id}
                    className={`nav-item ${tab === id ? "active" : ""}`}
                    onClick={() => setTab(id)}
                    style={{paddingLeft:28,fontSize:13}}>
                    <span className="nav-icon" style={{fontSize:15}}>{icon}</span>
                    <span style={{flex:1}}>{label}</span>
                    {id === "prenotazioni" && notifCounts.pendingBookings > 0 && <span className="nav-badge">{notifCounts.pendingBookings}</span>}
                    {id === "presenze" && notifCounts.missingAttendance > 0 && <span className="nav-badge">{notifCounts.missingAttendance}</span>}
                    {id === "notifiche" && notifCounts.unreadMessages > 0 && <span className="nav-badge">{notifCounts.unreadMessages}</span>}
                  </div>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-user">
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,cursor:"pointer",padding:"8px 10px",background:"rgba(255,255,255,.04)",borderRadius:10,border:"1px solid rgba(255,255,255,.07)"}} onClick={() => setShowAvatarModal(true)}>
            <div style={{width:34,height:34,borderRadius:"50%",overflow:"hidden",border:"2px solid rgba(253,239,38,.5)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <Avatar url={avatarUrl} emoji={lv.emoji} size={34}/>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12,fontWeight:700,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{profile.display_name}</div>
              <div style={{fontSize:10,color:"rgba(255,255,255,.35)"}}>🌱 Giardiniere</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,padding:"6px 10px",background:"rgba(255,255,255,.04)",borderRadius:10,border:"1px solid rgba(255,255,255,.07)"}}>
            <span style={{fontSize:13}}>{theme==="dark"?"🌙":"☀️"}</span>
            <span style={{fontSize:11,color:"rgba(255,255,255,.4)",flex:1}}>{theme==="dark"?"Scuro":"Chiaro"}</span>
            <button className="theme-toggle" style={{background:theme==="light"?"rgba(253,239,38,.3)":"rgba(255,255,255,.1)",flexShrink:0}} onClick={()=>setTheme(t=>t==="dark"?"light":"dark")}>
              <div className="theme-toggle-knob" style={{background:theme==="light"?"#c08800":"rgba(255,255,255,.6)",transform:theme==="light"?"translateX(20px)":"translateX(0)"}}/>
            </button>
          </div>
          <InstallPWAButton/>
          <div style={{display:"flex",gap:6,marginTop:6}}>
            <button className="btn btn-ghost btn-sm" style={{flex:1,color:"rgba(255,255,255,.45)",border:"1px solid rgba(255,255,255,.1)"}} onClick={onLogout}>Esci</button>
            <button className="btn btn-ghost btn-sm" style={{color:"rgba(253,239,38,.7)",border:"1px solid rgba(253,239,38,.2)",padding:"6px 10px"}} onClick={()=>setShowChangePwd(true)} title="Cambia password">🔑</button>
          </div>
        </div>
      </div>

      {/* Header mobile */}
      <div className="mob-header" style={{paddingTop:"env(safe-area-inset-top,0px)",background: theme==="light" ? (DEFAULT_SECTION_COLORS[tab]?.color||"#fff") : "#0d0d0d"}}>
        <button onClick={() => setDrawerOpen(true)} style={{background:"none",border:"none",color: theme==="light"?"#101010":"rgba(255,255,255,.6)",fontSize:22,cursor:"pointer",padding:4,lineHeight:1}}>☰</button>
        <span className="mob-header-title" style={{flex:1,marginLeft:8}}>{cur?.[2]}</span>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <button onClick={()=>setShowPresSettings(true)} style={{background:"rgba(253,239,38,.15)",border:"1px solid rgba(253,239,38,.3)",borderRadius:8,padding:"4px 8px",cursor:"pointer",fontSize:14,color:"#FDEF26",lineHeight:1}} title="Presentazione">🎮</button>
          <button onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} style={{background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.15)",borderRadius:8,padding:"4px 8px",cursor:"pointer",fontSize:14,lineHeight:1}} title="Tema">
            {theme==="dark"?"☀️":"🌙"}
          </button>
          <div style={{width:30,height:30,borderRadius:"50%",overflow:"hidden",border:"2px solid rgba(253,239,38,.5)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={() => setShowAvatarModal(true)}>
            <Avatar url={avatarUrl} emoji={lv.emoji} size={30}/>
          </div>
        </div>
      </div>

      {/* Drawer mobile */}
      {drawerOpen && <div className="mob-drawer-bg" onClick={() => setDrawerOpen(false)}/>}
      <div className={`mob-drawer ${drawerOpen ? "open" : ""}`}>
        <div style={{padding:"18px 16px 14px",borderBottom:"1px solid rgba(255,255,255,.08)"}}>
          <div style={{transform:"rotate(-1deg)",marginBottom:8}}>
          <div className="logo-b" style={{width:120,height:40,backgroundSize:"contain",backgroundRepeat:"no-repeat",backgroundPosition:"left center"}}/>
          <div className="logo-w" style={{width:120,height:40,backgroundSize:"contain",backgroundRepeat:"no-repeat",backgroundPosition:"left center"}}/>
          </div>
          <div style={{display:"inline-block",background:"#FDEF26",color:"#101010",fontFamily:"'Funnel Display',sans-serif",fontWeight:800,fontSize:13,padding:"5px 12px",border:"2px solid #101010",borderRadius:8,boxShadow:"2px 2px 0 #101010",transform:"rotate(-1.5deg)"}}>🌱 {profile.display_name||"Giardiniere"}</div>
        </div>
        <nav style={{flex:1,padding:"8px 0",overflowY:"auto"}}>
          {EDUCATOR_GROUPS.map(group => {
            const groupTabs = group.tabs
              .filter(tid => tid !== "admin" || profile.role === "admin")
              .map(tid => EDUCATOR_TABS.find(t => t[0] === tid))
              .filter(Boolean);
            if (groupTabs.length === 0) return null;
            const isOpen = openGroup === group.id;
            const hasActiveTab = groupTabs.some(([tid]) => tid === tab);
            let groupBadge = 0;
            groupTabs.forEach(([tid]) => {
              if (tid === "prenotazioni") groupBadge += notifCounts.pendingBookings || 0;
              if (tid === "presenze" && notifCounts.missingAttendance > 0) groupBadge += 1;
              if (tid === "notifiche") groupBadge += notifCounts.unreadMessages || 0;
            });
            return (
              <div key={group.id} style={{marginBottom:4}}>
                <div className="nav-item"
                  onClick={() => setOpenGroup(isOpen ? null : group.id)}
                  style={{fontWeight:800, background: hasActiveTab && !isOpen ? "rgba(163,207,254,.08)" : undefined}}>
                  <span className="nav-icon">{group.icon}</span>
                  <span style={{flex:1}}>{group.label}</span>
                  {groupBadge > 0 && !isOpen && <span className="nav-badge">{groupBadge}</span>}
                  <span style={{fontSize:11,opacity:.5,transition:"transform .2s",
                    transform:isOpen?"rotate(90deg)":"rotate(0deg)",display:"inline-block"}}>▶</span>
                </div>
                {isOpen && groupTabs.map(([id, icon, label]) => (
                  <div key={id}
                    className={`nav-item ${tab === id ? "active" : ""}`}
                    onClick={() => { setTab(id); setDrawerOpen(false); }}
                    style={{paddingLeft:28,fontSize:13}}>
                    <span className="nav-icon" style={{fontSize:15}}>{icon}</span>
                    <span style={{flex:1}}>{label}</span>
                    {id === "prenotazioni" && notifCounts.pendingBookings > 0 && <span className="nav-badge">{notifCounts.pendingBookings}</span>}
                    {id === "presenze" && notifCounts.missingAttendance > 0 && <span className="nav-badge">{notifCounts.missingAttendance}</span>}
                    {id === "notifiche" && notifCounts.unreadMessages > 0 && <span className="nav-badge">{notifCounts.unreadMessages}</span>}
                  </div>
                ))}
              </div>
            );
          })}
        </nav>
        <div style={{padding:"14px 16px",borderTop:"1px solid rgba(255,255,255,.08)"}}>
          <button className="btn btn-ghost btn-sm" style={{width:"100%"}} onClick={onLogout}>Esci</button>
        </div>
      </div>

      {/* Main */}
      <div className={`edu-main${theme==="light"&&COLORE_NOME[DEFAULT_SECTION_COLORS[tab]?.color]?" ebg-"+COLORE_NOME[DEFAULT_SECTION_COLORS[tab]?.color]:""}`} style={{transition:"background .4s ease", background:(theme==="light"&&COLORE_NOME[DEFAULT_SECTION_COLORS[tab]?.color])?undefined:(theme==="light"?(DEFAULT_SECTION_COLORS[tab]?.color||"#A3CFFE"):"#0d0d0d")}}>
        <div className="topbar" style={{borderBottom:`1px solid ${EduTabColors[tab]?.border||"rgba(255,255,255,.08)"}`}}>
          <div/>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontSize:12,color:"rgba(255,255,255,.4)",fontWeight:700}}>{profile.display_name}</div>
            <button onClick={()=>setShowPresSettings(true)} style={{background:"rgba(253,239,38,.1)",border:"1px solid rgba(253,239,38,.3)",borderRadius:10,padding:"5px 10px",cursor:"pointer",fontSize:12,fontWeight:700,color:"#FDEF26",whiteSpace:"nowrap"}} title="Modalità presentazione">🎮</button>
            <div className="edu-notif-bell" onClick={()=>setShowNotifPanel(p=>!p)}>
              🔔
              {notifCounts.total > 0 && <div className="edu-notif-badge">{notifCounts.total}</div>}
            </div>
          </div>
        </div>
        {/* Notification panel */}
        {showNotifPanel && (
          <div className="edu-notif-panel">
            <div className="edu-notif-header">🔔 Promemoria</div>
            {notifCounts.pendingBookings > 0 && (
              <div className="edu-notif-item" onClick={()=>{ setTab("prenotazioni"); setShowNotifPanel(false); loadNotifCounts(); }}>
                <div className="edu-notif-icon">📋</div>
                <div className="edu-notif-text">
                  <div className="edu-notif-title">Prenotazioni in attesa</div>
                  <div className="edu-notif-sub">Clicca per confermare o rifiutare</div>
                </div>
                <div className="edu-notif-count">{notifCounts.pendingBookings}</div>
              </div>
            )}
            {notifCounts.unreadMessages > 0 && (
              <div className="edu-notif-item" onClick={()=>{ setTab("messaggi"); setShowNotifPanel(false); }}>
                <div className="edu-notif-icon">💬</div>
                <div className="edu-notif-text">
                  <div className="edu-notif-title">Messaggi ricevuti</div>
                  <div className="edu-notif-sub">Ultimi 24 ore</div>
                </div>
                <div className="edu-notif-count">{notifCounts.unreadMessages}</div>
              </div>
            )}
            {notifCounts.total === 0 && (
              <div className="edu-notif-empty">✨ Tutto in ordine!</div>
            )}
            <div style={{padding:"8px 16px",borderTop:"1px solid rgba(255,255,255,.06)"}}>
              <button className="btn btn-ghost btn-xs" style={{width:"100%",fontSize:10}} onClick={()=>{loadNotifCounts();setShowNotifPanel(false);}}>Aggiorna</button>
            </div>
          </div>
        )}
        <div className="content edu-content-wrap">
          {!["classifica","presenze","attivita","badge","sfida","bigtop"].includes(tab) && (
            <SectionBanner sectionKey={tab} title={`${cur?.[1]||""} ${cur?.[2]||""}`} sectionColors={sectionColors}/>
          )}
          {tab === "dashboard"   && <DashboardView />}
          {tab === "export"       && <ExportView />}
          {tab === "pulizia"      && <PuliziaView />}
          {tab === "bacheca"      && <BachecaView profile={profile}/>}
          {tab === "annunci"      && <AnnouncementsView profile={profile}/>}
          {tab === "social_edu"   && <EducatorSocialView profile={profile}/>}
          {tab === "visibilita"   && <VisibilityView />}
          {tab === "notifiche"    && <NotificheTab profile={profile} />}
          {tab === "admin"        && <AdminView profile={profile} />}
          {tab === "giocatori"    && <PlayersView {...sharedProps} />}
          {tab === "classifica"   && <LeaderboardView {...sharedProps} />}
          {tab === "squadre"      && <SquadsView />}
          {tab === "presenze"     && <AttendanceView {...sharedProps} />}
          {tab === "attivita"     && <ActivitiesView {...sharedProps} />}
          {tab === "bigtop"       && <BigTopEducatorView profile={profile} />}
          {tab === "sfida"        && <SfidaView {...sharedProps} />}
          {tab === "badge"        && <BadgesView {...sharedProps} />}
          {tab === "streak"       && <StreakConfigView />}
          {tab === "prenotazioni" && <BookingsView />}
          {tab === "messaggi"     && <MessagesView profile={profile} />}
          {tab === "diario"       && <DiaryView />}
          {tab === "qr"           && <QrView />}
        </div>
      </div>

      {/* Bottom nav mobile */}
      <div className="mob-bottom-nav">
        <div className="mob-bottom-nav-inner">
          {mobTabs.map(([id, icon, label]) => (
            <button key={id} className={`mob-nav-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <span style={{ fontSize: 22 }}>{icon}</span>
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" }}>{label}</span>
            </button>
          ))}
          <button className={`mob-nav-btn ${!MOB_TABS_IDS.includes(tab) ? "active" : ""}`} onClick={() => setDrawerOpen(true)}>
            <span style={{ fontSize: 22 }}>⋯</span>
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" }}>Altro</span>
          </button>
        </div>
      </div>

      <InAppNotifBanner/>
      {showChangePwd && (
        <div className="modal-bg" onClick={()=>setShowChangePwd(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <ChangePwdModal onClose={()=>setShowChangePwd(false)}/>
          </div>
        </div>
      )}
      {showPresSettings && (
        <div className="modal-bg" onClick={()=>setShowPresSettings(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-title">🎮 Impostazioni Presentazione</div>
            <div className="form-group">
              <label className="form-label">Titolo</label>
              <input className="form-input" value={presSettings.title} onChange={e=>setPresSettings(p=>({...p,title:e.target.value}))} placeholder="🏆 Classifica PUG"/>
            </div>
            <div className="form-group">
              <label className="form-label">Mostra solo squadra</label>
              <select value={presSettings.squadFilter} onChange={e=>setPresSettings(p=>({...p,squadFilter:e.target.value}))}>
                <option value="all">Tutti i giocatori</option>
                <option value="Verde">🟢 Squadra Verde</option>
                <option value="Azzurra">🔵 Squadra Azzurra</option>
                <option value="Gialla">🟡 Squadra Gialla</option>
              </select>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div className="form-group">
                <label className="form-label">Top N giocatori (0 = tutti)</label>
                <input type="number" min="0" max="200" className="form-input" value={presSettings.topN} onChange={e=>setPresSettings(p=>({...p,topN:Number(e.target.value)}))}/>
              </div>
              <div className="form-group">
                <label className="form-label">Secondi fase podio</label>
                <input type="number" min="3" max="60" className="form-input" value={presSettings.podioDuration} onChange={e=>setPresSettings(p=>({...p,podioDuration:Number(e.target.value)}))}/>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Velocità scorrimento lista</label>
              <div style={{display:"flex",gap:8}}>
                {[["slow","🐢 Lento"],["medium","🚶 Medio"],["fast","⚡ Veloce"]].map(([v,l])=>(
                  <button key={v} className={`chip ${presSettings.scrollSpeed===v?"active":""}`} onClick={()=>setPresSettings(p=>({...p,scrollSpeed:v}))}>{l}</button>
                ))}
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:8}}>
              <button className="btn btn-primary" style={{flex:1}} onClick={()=>{setShowPresSettings(false);setShowPresentation(true);}}>▶ Avvia presentazione</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>setShowPresSettings(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
      {showPresentation && <PresentationMode settings={presSettings} onClose={()=>setShowPresentation(false)}/>}

      {showAvatarModal && (
        <div className="modal-bg" onClick={() => setShowAvatarModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Il tuo avatar</div>
            <AvatarUpload playerId={profile.id} currentUrl={avatarUrl} onUploaded={url => setAvatarUrl(url)} />
            <button className="btn btn-ghost btn-sm" style={{width:"100%",marginTop:10,color:"rgba(253,239,38,.8)",borderColor:"rgba(253,239,38,.3)"}}
              onClick={()=>{setShowAvatarModal(false);setShowChangePwd(true);}}>
              🔑 Cambia password
            </button>
            <button className="btn btn-ghost" style={{width:"100%",marginTop:6}} onClick={() => setShowAvatarModal(false)}>Chiudi</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────

let _pugAC = null;
function pugSound(type){
  try{
    if(typeof localStorage!=="undefined" && localStorage.getItem("pug_sound")==="off") return;
    const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
    if(!_pugAC) _pugAC=new AC();
    if(_pugAC.state==="suspended"){ _pugAC.resume(); }
    const ctx=_pugAC, now=ctx.currentTime;
    const beep=(f,t,dur,vol,wave)=>{ const o=ctx.createOscillator(),g=ctx.createGain(); o.type=wave||"square"; o.frequency.value=f; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(0.0001,now+t); g.gain.exponentialRampToValueAtTime(vol,now+t+0.006); g.gain.exponentialRampToValueAtTime(0.0001,now+t+dur); o.start(now+t); o.stop(now+t+dur+0.02); };
    const slide=(f1,f2,t,dur,vol,wave)=>{ const o=ctx.createOscillator(),g=ctx.createGain(); o.type=wave||"square"; o.frequency.setValueAtTime(f1,now+t); o.frequency.exponentialRampToValueAtTime(f2,now+t+dur); o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(0.0001,now+t); g.gain.exponentialRampToValueAtTime(vol,now+t+0.01); g.gain.exponentialRampToValueAtTime(0.0001,now+t+dur+0.03); o.start(now+t); o.stop(now+t+dur+0.06); };
    if(type==="tab"){ slide(300,780,0,0.12,0.06,"triangle"); beep(880,0.12,0.08,0.05,"square"); }
    else if(type==="coin"){ beep(988,0,0.09,0.14,"square"); beep(1319,0.08,0.26,0.14,"square"); }
    else if(type==="success"){ beep(523,0,0.08,0.07,"square"); beep(659,0.08,0.08,0.07,"square"); beep(784,0.16,0.08,0.07,"square"); beep(1047,0.24,0.22,0.09,"square"); }
    else if(type==="error"){ slide(420,110,0,0.3,0.09,"sawtooth"); }
    else { slide(520,940,0,0.05,0.055,"square"); beep(1180,0.05,0.04,0.03,"square"); }
  }catch(_){}
}
export default function App() {

  const [profile, setProfile] = useState(null);
  const [checking, setChecking] = useState(true);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    const onClick = (e) => { const t = e.target; if (!t || !t.closest) return; if (t.closest(".nav-item")) pugSound("tab"); else if (t.closest("button, .btn, [role='button']")) pugSound("click"); };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  const [sectionColors] = useState(DEFAULT_SECTION_COLORS);

  // Background: soft ping quando torna in primo piano (no reload)
  useEffect(() => {
    let hiddenAt = 0;
    function onVis() {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt > 0 && Date.now() - hiddenAt > 30000) {
        sb.from("profiles").select("id").limit(1).then(()=>{}).catch(()=>{});
      }
      hiddenAt = 0;
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    sb.from("profiles").select("id").limit(1).then(()=>{}).catch(()=>{});
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(()=>{});
    }
    // ═══ SESSIONE PERMANENTE ═══
    // Filosofia: la cache localStorage È la sessione.
    // Il logout avviene SOLO con il tasto Esci. Mai automaticamente.
    // La verifica di rete aggiorna solo i dati, non slogga mai.

    // ── PLAYER: sessione cache-based, mai scade ──
    try {
      const sp = localStorage.getItem("pug_player");
      if (sp) {
        const p = JSON.parse(sp);
        if (p?._playerSession && p?.id) {
          // Mostra SUBITO dal cache — nessuna attesa
          setProfile({ ...p, _playerSession: true });
          setChecking(false);
          // Verifica in background: aggiorna i dati, NON slogga mai
          sb.from("profiles").select("id,display_name,first_name,avatar_url,xp,coin,squad_id,role,current_streak,longest_streak,last_checkin_date,xp_goal,created_at,squads(name)").eq("id", p.id).single()
            .then(({ data }) => {
              if (data) {
                const updated = { ...data, _playerSession: true, _mustChangePin: p._mustChangePin === true };
                setProfile(updated);
                localStorage.setItem("pug_player", JSON.stringify(updated));
              }
              // Qualsiasi errore (rete, not found, RLS): rimani loggato col cache
            })
            .catch(() => {}); // rimani loggato
          return; // sessione player attiva, stop
        }
      }
    } catch(_) {} // anche su errore parse: non sloggare, prova educator

    // ── EDUCATOR: sessione cache-based + Supabase auth in background ──
    try {
      const se = localStorage.getItem("pug_edu");
      if (se) {
        const cached = JSON.parse(se);
        if (cached?.id) {
          // Mostra SUBITO dal cache — nessuna attesa
          setProfile(cached);
          setChecking(false);
          // Verifica/aggiorna in background — NON slogga mai per errori
          (async () => {
            try {
              let { data: { session } } = await sb.auth.getSession();
              if (!session) {
                // Token scaduto: prova a rinnovarlo
                const r = await sb.auth.refreshSession().catch(() => ({ data: null }));
                session = r?.data?.session || null;
              }
              if (session) {
                const { data: p } = await sb.from("profiles")
                  .select("id,display_name,role,avatar_url,squad_id,xp,coin,level_id,created_at,updated_at,first_name,current_streak,longest_streak,last_checkin_date,app_config,xp_goal,squads(name)").eq("id", session.user.id).single();
                if (p) {
                  setProfile(p);
                  localStorage.setItem("pug_edu", JSON.stringify(p));
                }
              }
              // Se non c'è sessione: NON sloggare. L'educator resta col cache.
              // Potrà ri-autenticarsi se serve, ma la navigazione resta fluida.
            } catch(_) {} // rimani loggato
          })();
          // Ascolta solo il logout ESPLICITO
          const { data: { subscription: sub1 } } = sb.auth.onAuthStateChange((event, session) => {
            if (event === "SIGNED_IN" && session) {
              sb.from("profiles").select("id,display_name,role,avatar_url,squad_id,xp,coin,level_id,created_at,updated_at,first_name,current_streak,longest_streak,last_checkin_date,app_config,xp_goal,squads(name)").eq("id", session.user.id).single()
                .then(({ data: p }) => {
                  if (p) { setProfile(p); localStorage.setItem("pug_edu", JSON.stringify(p)); }
                });
            }
            // SIGNED_OUT NON slogga qui — solo il tasto Esci slogga
          });
          return () => sub1.unsubscribe();
        }
      }
    } catch(_) {} // anche su errore parse: vai al login pulito

    // ── Nessuna cache: primo accesso assoluto → mostra login ──
    setChecking(false);
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        sb.from("profiles").select("id,display_name,role,avatar_url,squad_id,xp,coin,level_id,created_at,updated_at,first_name,current_streak,longest_streak,last_checkin_date,app_config,xp_goal,squads(name)").eq("id", session.user.id).single()
          .then(({ data: p }) => {
            if (p) { setProfile(p); localStorage.setItem("pug_edu", JSON.stringify(p)); }
          });
      }
    });
    return () => subscription.unsubscribe();
  }, []);
  async function onLogout() {
    localStorage.removeItem("pug_player");
    localStorage.removeItem("pug_edu");
    try { await sb.auth.signOut(); } catch(_) {}
    setProfile(null);
    document.body.classList.remove("light");
  }

  // Mentre verifica la sessione, mostra il login con indicatore sottile
  // così l'utente vede subito qualcosa e può anche interagire
  if (checking) return (
    <>
      <style>{css}</style>
      {!isOnline && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:9999,background:"var(--rosso)",color:"#fff",textAlign:"center",padding:"8px",fontSize:13,fontWeight:700}}>📵 Nessuna connessione</div>}
      <div style={{position:"relative"}}>
        <div style={{position:"fixed",top:0,left:0,right:0,height:3,zIndex:9999,background:"var(--azzurro),var(--neon-blue))",backgroundSize:"200% 100%",animation:"shimmer 1.5s linear infinite"}}/>
        <Login onLogin={setProfile} />
      </div>
    </>
  );

  return (
    <>
      <style>{css}</style>
      <UpdateBanner/>
      <OfflineBanner/>
      {!profile
        ? <Login onLogin={setProfile} />
        : profile.role === "player"
          ? <PlayerDashboard profile={profile} onLogout={onLogout} sectionColors={sectionColors} />
          : <EducatorShell profile={profile} onLogout={onLogout} />
      }
    </>
  );
}
