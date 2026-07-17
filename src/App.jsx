import { sb, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase.js";
import { useState, useEffect, useCallback, useRef } from "react";

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

const DEFAULT_SECTION_COLORS = {
  classifica:   { color: "#FDEF26", image: null },
  badge:        { color: "#FF6DEC", image: null },
  presenze:     { color: "#FDEF26", image: null },
  attivita:     { color: "#339966", image: null },
  sfida:        { color: "#A3CFFE", image: null },
  bigtop:       { color: "#D41323", image: null },
  messaggi:     { color: "#FF6DEC", image: null },
  dashboard:    { color: "#A3CFFE", image: null },
  giocatori:    { color: "#A3CFFE", image: null },
  qr:           { color: "#A3CFFE", image: null },
  streak:       { color: "#D41323", image: null },
  prenotazioni: { color: "#339966", image: null },
  vista:        { color: "#A3CFFE", image: null },
  admin:        { color: "#FDEF26", image: null },
  pulizia:      { color: "#FF6DEC", image: null },
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

  .login-logo-full { width:min(320px,80vw); aspect-ratio:720/323; margin:0 auto; background-size:cover; background-position:center; border-radius:16px; background-image:url(data:image/webp;base64,UklGRmpHAABXRUJQVlA4IF5HAACQEQGdASrQAkMBPj0ci0SiIaEQ2Q5EIAPEtLd99yDELPUAdoD9ALoBozOqYzG5zmQDVzSoPIn9Y/GvzO/mP9N/sn7F/2X/4+Zn51+sfkD/dP+d8H+T/sD1HfjH1Z+6/1f+//7X+9/tj92v3j/M/k//hPRv5F/zf5pf4/5AvxH+L/3b+y/tJ/cv/n/qvdV+LngD6r/wv+7/jPYF9evoP+H/xP+a/239l/eX6Uvi/856F/X7/H/c99gH8w/pn+h/xP+H/2n+K////z/CP+T4LX4D/sewB/MP69/l/8Z/oP/X/h//////xh/lP93/kf9J/8/8r/////8Yvzj+//8P/Hf5n/7f6b///gT/Jv6N/qP7p/kf/P/lf///8/ur/7nuD/cf/u+6F+uP/c/P//8GPgWtn8v2CG2MGOKQqn4u1M8Kivcttl8WcUhUMBKMlyBg6Gh7Zl12K18WcUgzYCVhIIanuMLSGHAvFRFKyhGvNOddUjLPIUEJsppweGPZI2qkAsjPoywnDaXMxxHRARgrA+UFLr+5bbL34hlqd6u9Pr94HlXwb3Cjg62UPPMn/66S3ELBrgtpEAKzoU6adtGNHpQoF8ff6lRhgmurQ0iZEx3ILmRET083emPw29R0WVzGbOKhf56VGTj4GAZTWXGOTcvRLCG4RxIVT8XQVpvLnucex1RfWVaLbTq28PNnkafUx88fpm/hs/qAmN1b33KQN/6ji02k9IBXnfX5l4fhmIIZrBd1ti9MkAGndLX+crq5EojTwTw8DWU5HPbTfj4R7Wu+rNg/wfkZwjNLqItimqtzpuQaAlAM0Hbp+zjB/UTw2thHuPzBd/sz/XkPwoF7L8XSw0YnUipIn6MBdOKReVfKKTQxZDHUz+UqmTn6kgigoWuft9Gue70CLK+IRZzmMTnFIU/E6WoUycsQkc4jUolW0XRbuynF43AjwyqV+pj3iCgSecplWStJCvPrpoguLGi8OinurgU56ohLBwh4V38p/tqWS4BadXk2UeFM4Y9F/Rdd224DSqcVtm9mvp8cwGX79GxxJsSEGKjhZMsbio4IuepH6u8rnuFWSO+H36Mv075r0Ix+/Dh/en+gFzDOFW8R6/XjtMPbbdNYRHRcuOav+PqB+y8uorm56AHRDGz34IHue/vbtpHPBSKtpmYc2iVnDEJ0qxZQhGBC7E5IzL4uoVPLgovS74nDL/ILU8buerLfXfLVjWETRXuWgaj2JjbFKAmw5mzFX2nK67tc/7loxkLaLnv+DnMHHc//iu7XvN7lvvJS7G6dmX8NsoS2UHA7/Upcr/Qprhag6NbA1by9VVO/8XYr5wX0RKBoI3zty+Vsk+rTlC0mL+OPvKMDGhUBX10LxwpjzQ/92OA4gjmNrqt2ZXP3E9v8UhD4VXeQwzmc+q3K8fvhymPQnFXHnESiAyl/47dXYUHQ0ZJabA2ZPP4rcWAuNfkkmdoq8qp/72BEfqfBmkMOBtrMpZKm3BBLtniLSo2yZ+L5n1lHGYvp5Lvc1La2f/F2pnf4+1uWHG1Xr0jhlCP2Cs8flzrqXfzb0GXu7781WTKOzZuhuF8d38zaaZt/Dmzwcklu0jfXxonhVKJ6cukpNE0f1jw+9cMJ6CuVz6mBxwvntCOJFBQfPVsswQ/R3imivctHl4ZZdwB7zUJ6i1SQk3/dd1yHMOzMj7To1MvyoCMcTZz4Z9oNW/Zfc8GvqIzScPULcW1uqMOlDGioLtjJahTdaJWb0eqxXesI5knFwwXl/szZKQJRQP4CpVw0RrAspCqfQoraRfoli4f58vn/p7HvQzj9Pswfnvbd0PZX3hlRQ5vnzPB6K6gob5UzusGpZGZX1Cg9bwz3YreAuaG9sGkHchRTaXU8+AQmHsMFW8kNySpolG1wsQV/SudMNjcwmBooLd2UJ6vgsQ8fsCoM5rvzM+gTUuzSnjlFOmWEjMsVs2ZALLUgNlTCOTE/Zl9y4Qj/uDoPc3dDJJg8/Y8KFY5pfG4IpgHoiemn5i74l6HqxCNTHWIvXt0fsgJCHYAvwDhzSnjR/UtI89la7AcqLDELaVH4DlpnhUV7ltsvizikKp+LtTPCor3La+yGtl9vWkDJUx/AsB2MBi082ocnmw2ceWxjs4pn8Vcy6QT4pTksL2Vxc9vRqcClCLxOmwMvXCHseG9Jfa4tx94YdY+6HI2OJLxNnLYXZ++EC17qDFtANtdTHc4CxbFxBH4gZ85VSwC1LGy1Ynll0pfkUq7JX377BVcIUZv214PWwMJ2GqJgg09Rh6KBTPfWyUFgObqAiZrfs/O1afpluK8cB+NmkA5qlfAjYNg4Y6bmK4G+61gacUfZ/h4WH+/b7KRGVtomJRiCrHp7z9SAEL+J+wW1s0n4Ko3gW3DZvmevcP7ORdUX9oTiUEpBhj5ZUab8qeii5CAyZ4VFe5bbFWK5szD+fRs3tVgO1cU/cIyg9qXDcjQ0kkN3IJZhJVXhDkkV89ZjwKdJPV+qYxZMKcALePd+pJeviAwpJQYPjOUgyysV3f8kutNzalbAd729wU+o06DcIGlkkcQhEamNLZQp9dnO+Mw1f4VKfSRJ9MY4oJBvJnVeirchFhKZvMme9Ef4acrFlZ1GNmfDf/RlymBnbviwph8deczRXuW2y+LOEFAbgxg1qJCVN34a5ab7pRViNXBPYWHAcFNFYb2et5SovoNHXL3QfFcC0vq+T7edEeaZaocWw73OWJSEPLcHD0zeysimtcGlpIga1M9Zuh4cy0WYash0YhJ9cXoTjq4LtTPCor3LbZfG2UHKqflIYC1nfCu9l58jhkfu+QjS/B2qS8/BthgMYBN/FTxosaa/8rZm4c9y69h0tjDfV0wWOHMO3iIVT8XameFRXuW2y+LOKQqn4u4qLbNEgovQwDWqhiaSP9qcXvSW4iaK9y22XvYAAP79GfmT+Hpoy+W+Kq37pYhlImlMoHpCa5nP4gRqzDrl7PqgH0zeEVvPh82gkc4H/X6V7RBW7xs4qv6Gmgx08ADq43L28aPWnTjmowZ/zDwf5kXQ/eU8PHD3pp2vLAvnXAuXG8Be3sptEkeV6su9492DG0Tpz7MfScikqS01VBZqus4wrgP5NBhI6zeQUk7ZCImpJkW7LzZobWsAr8pDHXDb2j5vM1P/+9ey4v/6XMTP70d+kgS2QHyvjhszRbd63dZWL7vDyyu3MuA3W2y90CYueF5sM2Y2ghOXQLQtedj3Qv/TRmbkEvUQc8LsFJkvtN6Bj5WlTkC/jGfh7GhMt/sseMJK9A55M0970rNPjzLYw//o1NScskTUBvXxmxK0QN6xGSEN1aO1AO01KkbaOYx6yl1+pEyqZftpgSxe9BZTHlG61hSKsXR/mcijcHDq9MC5AUjuyK3M4hWzCU+lAvy7O6GcK7YHhVLDEbvDCk40lgROUmRo54AjPoH9P8Irsaq8pJD2U5UAN7JNWe//E3elpP5Q957ICAC6hezyfa95v/pTHYWHb8s6ra9gD0kNWz9Qi+B4UOnIlWAIpaw3Q9Y40uvhNvko5UqR7tb3BolLQnXoyo2pLoT3IoHqsKJBNn/5fj3+AWzPKqMdD7R/WlDnLl08znlpZN47uny9aJR/oCxGEmNVun5nglSPbBvifMMYxXeZy8n6PMoC8/S40kw0/xFPL7sXHFYX4llpHBFxjZFNshS1LDJ4h6I7svyxhxA8Jpa2VpMOQOFlL3TAChGlGzoz2s+2RIjyj0zzIE5KAfq13grUktobKNiDgQwfQxr8SAGRhFSnqd3Wdx9CDqsLA4yZ/dW3M75gY+Y3G6Fyvpl0uCuyIaZ8cvR5o3mQEdp8rS3h+nIQM/OEZWTJKcYFknHQd21PZB1ZZUn/8kPj0B5e+UH8eBGT8AT4KMQkCUq/9rIKlPwRr2p5HS4ecYUb3DudmeHYuuHmm3cshfAh8gjvCbjg/wUQGf3ikloDGveKCZoQ8hbThbG7nlqhgMcgft5lHlaorGLUDNZIGABRAfqwqQrJNK5KYm4ZwZhZrLSQUShlrMHSt8mYxH6yBtFrEQHBClJxeDpwljqmnDJ33zS80B0IMsvkbELcDKNiJIm8hbZusB2wTvB7V3ASQfhpxZwZw+dN0lW0moMCblfNFRwsOtOjI/CTLF5+VILAb0jROuyOCoY8ZOKoD8uzpzprGHWYqYSgZ8oWmV1shIzux9i8Hkg+QApfZh1eIWZ0CXMjRWfJWI1hOI/q8fBorlY+TYqaf7nKCQGvdiffIz4awyNZgYjAE7F0AZNki9dHPLmbYKHyVWFbfE5ISJSv+fDWoWa+Xn3pShLeEHczKsVsS3L1VBrsKGJDfynll+jVMEkgO1nv6IhOYPxiL0EG7l/PHhHyHQUxizXrRryftOoL9NsBsiOEM6SRRoMC10fZyFK86wO3NbGz+YtY9A9DkJlCePIFBznO3HljHhdf64u2iY6XrWVovrxw8N68Yyups4ZJgAoVnIFRMEnFWp3gF1ClyoO3LQSEKcWaFFVqNOmR+Xrrx+oqhFO+72gd1s33WXLZb3cX96vdK0S48uaTUmW4H1DeV10qEhaA4a76Zq4bq3VVeMxLcpu8npop3D/W//hMIP+C/0ToJWPqBYhj/3Nzxs8uI4h6nUvnU0fynCUiFKswEXB9Y4/sSVwevg2mixmYwAGcPOzZnh9+HDb00rXZ37j1YpLe+bwuKI/mW4qpdZhpG3m3qP/y1sqNKJQ4KhEqkcnLp9JeJ3kTNcOaOnl2ydAtgfr3+Zj3QOLKeGa+/WErMsXWmFEUl+H+LO0JMSRi1OvWGNId2SBx9F4EIbANXaZh5azgF0PWMFzD+HveqSg/86Z0Q/xNjyRLW21+FNQB21SCtP9cq3Kffzb57yST6joFj9QcSQdcv8ptmYTCKrJSIzy8Us874GIAqnzZZ8eX/o+iCSchaY+ZsRGSH9o8EprCi7NF9F2RLO5tfdaAJWm1+MXPiyU8+3fI7thQyhPXG34kskNBbqqZ5TKC8Yxo8xvmvESjf6Thjlbii4EAg4WhBvqSA0N9RoF8ygGFMmV0U5zzqtAcPQwN+nTXXS/pyuya/xpnfwcMhMC/WxfZFkazenhdnxA+vSXrWG2m1taPgcOXhxLV76I8ZKfI+Y/yOMhAtW0oqiCRnEulvUp7KzitJ5ffzlakY/tvEPslJYGV0cB+vW6sI64KjFgxxjizCnMZCqqLxV1D4YSe9+/UYSBA+1CPFjMLXXRx8tLMNAITbLRl/tsyWMJGGsBgSHrCDRN5G5ZbJqz/HoJ+3Xv0rny0l+CPEaKFfTINogvMt/TcNTocqezZSr5QpHio5ZBVWGp7sAMN7gNqFVJcllzpCEbe42HWIZugR+HIr7maYMYSnl16biM/8faAYDL5D0G7UgafuBEUXl8uHXVDc6u9o1dwa++8/YsKBn+2yFDCwcN2osa2uEciT0zeWH53b6OEGIC1FdMxRPyJ24QJIii2qGKUpLk1MJ9XL4JEbnzzNc8OKNn/1UuyQA84BGLQr5vXLKAc0C/RNMCmmd9QVARbMIbJE2eqi+AbQvR7vLHIJv2n2d22wI7cJtXjOatIQMR8M5jsV7j5fzV+TJX7Z2ayIA+7SblJsxWEER7QZ5cGv+0LURO5RcUOYzUwcwDSI08yaasYvcUuOpbcZ0/aQDNn+voGbuQFIC/sNn4iqJHjtg12BSpRWOywytsB93oMIx2g+UVWOiqO38vTvGXVchtSdOaJyJwKHePnAH0ke8aaPWSFZmErGbZYvXWXAm89vReXOMj3hPsB+t37oGpWxrH8g6QUBuo+5cw9sqrwBAwx3wqfPXGJvlRSvPIXas6j08X3+WwqZlM8ejtROvzVWz7pvmJbDu+Qr8UGSW56Y3S93vV2x1cViFmxP8p73k7H64fH0RycOZgvZHlCiKuz05NTi15UoI2B9UNtXm3XAX0nTEO4t+1zxUD5AXBStgSAUQ0fYD+d5TaG6Q4z0chvlffmQDXHZuczwwUuVF9Qb86Hp1rIIPdSDDS5+WrHXF6S0wzKhYeMYwJWIJ9wpVmF56snT9XkBIFgktFP59tBXNXFmDyGSIJKVRPAgk1wP+Ty+PLqlmee39qonAI43GNRkY8wevsipLWloD0GFKa5GbgrGdwoHubdZSQiMYO+cYMmCdYpyuP5AWEuOU/NGafpUhppYC/vdo9EF/83O64Rl6zcxdMvRTNynALtckjlC8T+NxhLLg2mCmIqWGtc210SghzgnCu9lecrjx8RiJHt7o9gkWltMm92smEZlGkzVz6VoiDiLLLz8fsHfMFtlpsphk9N+14k+s2VZffbqLMZS7hsN4b5wzWjeVJwnCRrEUMU7nvO6mXJCyTd5BQz1WL9X0xVk62ojngdJeplourD/2DuOjJe2XW5ftt55LqhtDeMwlPoX5vcE67+Sj5LqYjQhVBaPxk/lUYdt3UKuj6dpH7u4Ew7SoHFSxCmTlLHQR+5KWMvDCq+1ZxW4MCDcNE3tF6yTmeA6/QKU+zzf79FH7+MIv2F0OiDiq2inIwOHAumU/+niLKKc8rjnvKOT6CXHFkgjZA2EO7wQ1kpOoGF5+Tk0AweH/AXf9zJtuLZUn8RBLsiLi96ZLsGMDJll7jGchZLj/obahk+i2S3eWjk5Whj048wJwHsJDvVymsn0oF98eVqxx17AwBfa+cuc6Q8EursM91+BVnxwbnozstjtUguMJKM/jLBVHuRPfbaByPSEqdJCgGbkDH3Q8UAUM++tGh6u/Bc++py70mKUxMZoVdfvsSqs+yjvNoHtLIeCuTAP6LimF1uqwW+Gd3CZXKf6QI8XGQlfw8dAcv4+t9pJaxW406r496pbhcY0JrbGPAgWy+WapMywk5qUlIpjuWKA9XSvJhiXlvmNvH5IkIbFV+Dmp4vcQxsY27pKHQIc7VDGMiBPIhlYm/xhDvmkOz0Oddzj9qIrRt3myiF/JrWDkobhRE7kCiCgiQYB0MDgTzARuxP5Kf78idXBhAXIvHeq7DdmphIEFsPrVagX1rAQs4vJFBGdrVIlKgAa4OhD8byZQVHALraT5Oox9lVW4LEoBnB5BsLLoAwbSHxhGY8Ev5AkYVa9XXAtuPsfecyFq8/3Yi74UAq5RcL8CxTpIDo71KFfL/WIP+C3GmXpjpL9aF0hwcRQLm42F6oX1j4M/qfNggaT0a8bHit55/D/9DfF67r/y/9gTMQrsJNHdBRUtYYUsCTgWHK2SGu5F0H+jZqR8/bKB+yIAIgMGuO8oh0MU8GYv07G9qS+ZvshymCJhXKLT5ILBT7bhcI1R2RuXkOoK0JjbC9XiTw2Qr8eReFw64Aoh72N5aWhdikSrNWgaCfU6nSCyeAkvkgDshDyIlBYYjbsUulY9PUVsUt40KOXBoNRqQDAb7Wqyf1B8Q2jiZKYRYiaraib5csSADsGP4Hsiwax2zfaxMfHXDw11CL3Q0kMopDi6b/sCli0lWDwaagQQtWWAPNSGZaMkIQl1VH4blvefkUTKAA+kku8n/Lfykq+Jx0DdzUq4RYQH5o3oeOg2COh7V/yVjro83sPuX7TWV0lX3D/jL2ghA8HoaDjRxMTWs9ajOVo7eJxgykW28WEvDkM2m4ZcQV0T28t8ZnEmWE5EPTLUHjV1phHFEraZHZD2Wg6b2XnOubLlv/eQcrQWQioEHJbu7coNmhdySonC9PNNoRaWQU27H3+NccuEh88MfXVCHibRffQcgsV1tjo/Zfwl2im9ZkrIazwAS/gxOlr6u4AqF1T1njTpRUzQQu1aZJh293dxRZ4bxRyqbcNRXbuH0rRkkROaW46o56bFCBk1KvJrnkiuLHvL6O3gLhXiBvuN1xAmYPx5ItDmDla9E/wOLGTJ5Tu+pO0i+j5eGDiSWR6cbsYi7YTTli+U+h0j5v3SL5GVscM87y1hEUAS5UZtz6MFXNznDP71me4tuku6iXjlHzBKoSM8Tj2zwxcLDBmcdCyc0XWNTY70p+Sbb8B6yOBHrJi9/xmWrz6zSzRIR60tbHNlGnPfxmlHOASqK7DKAzyN7V1Wc6p+UWPwlnvWiDT1BYaFWtQRIJDa/IvU3isQIsCUJ27WaYbex8+hh1C9qqRBiHcjFwt6n2dfwjwcN/gCpDLn+C/TWHPd9sGzxr7QQFWiZ3M9hVFU+RqTvnEmx2qvrPP3bKzsw5TO6PUNXCgWnCGPE6j8Dsmu7jYV9KYErPfoM4Yd4mdAReVcpnQmAo/72wczrFcnYPfSxf+iHYS6JoxwGmQbxkZy79fZQIrnkf7tC5UBA2sUApsGOscXOUFtjQDGxpjbKpbZ0Xe/WI3XA1HWpF6J7W5QJSA/EAhJQ/ia3T8nMbnaSd0koSGo0i5KjJi2M0PiD0BsGxevqhyL5fLxVcWnhwTp5OZ8nVNfUlYK0TNaUgRIvq/Fe28gksgO3rmqKk4DDCEUQCFRjZohmTKM302nOwl7PqSf3qherVmqbENmncKjfWjewvHR0SeD1CNBi5eYLPK8RBVDq1c8C77h+RiCdM/1OrzJK/LU6uWF+lmyoVehWjZdoHOpm+Jj3IKh0nKf2z37VxzBoSqQoiOxuQxbJAxYacZQ09UhFvL5foxRh378OroEGZQEqxFEo0Qyt7Aj3B7Z+oQUd7/nQkvvsW454lnGBJN+3xiUI3auwyHzglzgrd0E+BkCaIBWg6f2U7HMOJ003D7AYuP24fV1FbynJiOr3jiLRmi4BzoopyBTBWU68bMOz6QMDyvy+eR8BL+46rCAuwTLkQph06i7xeHvxAt1fLbJ6ZwX5bUPVrX//tPfMq1L3YzFqaejVrrKrESvMNWpuzqkATmbykW+BOH9LyC8HlUUHrcFAr3yXe3KUGqpRlo9qCcuTfzeCGn5LmMnbkNekoX5x0PExB98A9EwNF0A0ZOQZZYLkUz9Lv48PY6DQJwAEl3sXs+EV2iOAGCJl+C4sF+RDmECf2foiod3V2akK4HERrWGSTbm1ThggSPsVis9m3rtQY8OnlD0Of+WtdClpUP5kbQ2ERm4+UGEq04GoGnwYtX8wqGBJjHcziOUFPiwGr/ST6uGztLtCSM3HY8Sf0BckeBrycWM1YJSibBnM+g7yKCWU9Pjsci3BguQsxZeT/TfDpcqNXMG7cMtSSHe8zy79owI928HOB9xuPzatnoPrmUg6FRV4r7QoWlwldJ2lmGp4PYXXRHTjMIQ1qAAAHFwAnML3Dl1IB33HlOvpJUCgAAhlNE6uVshWJ9MbQ3W8fg3nQIg9JjWTNRNM25hVyB2hlAB0vhPGwMjTQAfHaqrgCe2fRea4hyjcVNKXMYUFLnvNo4Gon0McG4Gdf/Zz2kFxRdp3wXpI1BK4Ql9Jg9w66Xw0WM7nt6EqHpCnG/1RuV96YRnd9mG87/b/Jh6iaKLOVXn+T8n4nEtuXOBWxPhT8y+ktc/ivOt/FQMVNjsFoJfWUMs6uYQidrpxI8EOrglqbCTBeiGman8wvlyvhZF4kjm1Qf+WUokCN9M0xL2PX2NoR6OuCCwNEfEpmxvdbw7353Zq0aNMbwvO397b9BxknboUckH09gpnnPyZh7s+eVNNyfg7/U2VSJaUZQke3OSHJswNz024kz/EhAKknrGJG5qmjo/Ml3Xic/RMJhVJDXYmAp8z6I5IQMByfdoPtYRE7PMX6cQQ00/Yz7N4M1Vc6uaU7XcWEwVFbK/kJXtY1ZIDpAsd7uRYNycB7V8lj6BSdQjBNEC1t2X72xRVBWN3/sy/MpT6YvTxyD+KyFMDLQprJQxgk8GcWkDHIJv6MR106AleZa1b6sjx6goBg5sjBedvpmSFuiqnrvHge1RvkQV4R9r9ed/Jd638oDX/2FaRARktGosuIna650wnGDMrCJbsSSVkmNUrwVh01GjQcxO0jMPDugpkX8BPsi/wYgdoLDDGCgHdWDjixlkF8C/lv71DCdwpuYDJt7do6FSxLr4p8M/GOaYzsMkfmdXZg9QPf1Nh3CDBEcOBIj9zdArQ5UxOnwMD20dCV8LacaeCx8d2frUQ6jn1GpeNSFzIkggfLk/QDlVzQtKoYzmkPMTHDObeg46aNLdP2ICYk3J+dHMga3JkZhZTQfJSg4dnHTo+74OgO9Xiz4VN6KrWnG5LfSOobuVzVjbi5Or8DDVYb5zkB9uBhDyO76NZyk468OY5dlCcqGi0MngriE68W6rVoxRL+kbEZLePjPOZU/X5cSNlRZZJoy7QXmajoFnMwhhZ6hP/Y/dptMK49bsYzAacolajDilCDdSyAb3gS5ge95Phh+qkJeUfnuNok0f2/yz8TUBAwe9tPnxs3BP0h96CEo4Y/fa0KqMrwhyuDLQ0ZbCQOeLrkzdM3wh4+jcRnfM0M+JMtKcseQqtOs/cfqxs3Kna6zS2dkhtkYRN96kWCWymdXah8vCDJ77hNxVONR9EKvHbdYAguGa1rYjjEy4Y9wBMYO9pwaxaT7i83gOx3MfPS3kjaKvZrOYHIjAdQ6CyhOm53CoQLnCphrM+zePcN4Dgi+w8e4rGA5pIfveZEcmWs5153M1ZpgQ6Mqi7A3+Zs3irQ30zswAOy6313I/U36sTlAMgJhtm9UHeViQJ5J7g/V2H9Ocx7ekj/t4W4EsmAZ/a5eEd6PP2gPeEJ+vYiluV1g4teKFJ0Q0HuPYWbLBkaJal4BO79bZlzomQ2Ws+wxw/CE664jtsWCBqx+Wn4wplNLpFLCQjcfV56y0nDxoxtE1dvyX4pKknhVSl38F0PGZDKYoQr46nlWGleR5YrGaNXJZPFViqQmkN0qYaUPOE+aLETRNqQv2UtoU5X0cCZUot3hIfmt9TZIYvrfDumGlQA035PdBWAHLYYs9rbcKPJchybefs2IvQDCLJwlP7UDE8JjEdfiZfzIChVWcFmiAKUqRhBfO2Jgddl+KLNobxP2qv7IavqtQ0d57uKYIPbtIJN/WgH6F6bBcJK/SPK/Vj7Wf9HZqc0Kk+FEoZ/lg9/eEi7UlL3cVtovB7IRvkLo9mTjVgIiO7ocIDjS5Vr6N0Hm/Rm4XI7g453++/e78l1q+pQ+XGKVzrUgmpv+prNiC+Pe+e+0/iCRev4u+Mg9FLjMiwwTFXS02bKjspEK816evrcubXD0uCfWfWDgtgJfi+MCdXK3aKjU4JER9x3+Au9s/Ddc/E+vLHW5Fkb9ymDzbtGj2cCirZ7s4uBO9Hpa93CyyviILjSFesuh10OW4caUjucUd/aNybZvhMAtOQXpE9y/b/Hq+pM5GHiUcZ6gc7YVFJyeLjxIDxgxjuPQoKEUb/804XPrRn58RfvmXNVe5Or/hDcHx+L/1D4b3Fo38oFTMizUcv+S/o2DYbVumhZr/qjaSZLou2Rcosd0Z19jsgIIHB1GQ6BtXTo440Jo4hN1BnaFjUzMcGXSzxT2YwWe7R0YZDqRaqt5QLKP8+p2eqM/kdCokhTOSTzeGuGDr2P5yV0XccacY88p9yN33KLhBTRdU0CI7udpBqlGCAowbHdAVK8nW1a/sp9lGQIQS/79L90PSm/OZqcCbXiLKpLDLXyy/60U9NllFSh4T3yXL7f7oxAIdTTc6ZUdemOkF7QjXEGZu75FhX1sZK2hlxXfFVIeB6ANoK8/3+JLmUlyeJG6eHFj2BNXZqTMwe/81K+M3TtlXEPPcia7gl62qi+SKhAgY9f2nstEGvabREn1zkaFkQHrhUPRKNKhlLtpkymFonbIYJGDr/OqeVsmIHunWNPseYDkPcaAdHOqTLQkR1pFaRQFwxi0F0cmbjWyuD8RzVJKSU0DcqEvgVgKkIzuR8b9DPDEoRsotNfkjH4uHOOgPYeqd5V9rz8MB7l0T0M+BoKsIg7ZjbWzOUiBy5/MyDO5dl7MBUhKmiuWtGP2OcwZSxIGDYDy5aB4S2Yfd9BqmO5V1IaWNiPsCDpN1yfMc4TMyvSVrhR0BjUL+xzltBntfqLXuHygnutPPG78hdTjo7JX4mTXpHVQh06S4gkDdriShTHor4L5wKQoxHbJUBk2/sR6QKitXmRzgZi/CwjLTe6zVnNyx9bAWn/ITwgtRQ9eyGJL75//33/ff99/uuLs4nv22OdjU2r+fpRy2Lg2NQZOTl9hTAg9n9BIBO2WTMqWQZQbnAsPRgXq0lHPiDsF5b9iktgcUfbgluhoeCLXw8AVGOL4uHeks7bTg0HTEc71aMVLOaq4TdSVZUn0IM3vn6I8z6pd24BWPxECaK4GkTwyl+3FGdXQBg5wekT3dDFKO4nAUS4kv2dkV8JWqguTAEGb2l8JNG0Bzwpaf4aRzcA/mCj8sHUhRK51lyhdzbTyfwbCqJMrKvV49TWIsvoJQ+eoBKNQWX4PEC+S0T48NuOqS62fXjPUF/mML35uATX3cslvDYgTEGWSL+jI2y/KqigDQAbXeed0pMM7HEoTuz5hPdg2Fr17N1BiB28BvV6HsClnlO3G/JsGdCKczoLKevq3DObjG3A1gwBwIAyi3hSZnJ9JKnh9u4nysAPA49jOAZTR7Act14Kk3QER7/JtPrPIGsdHd8qR+xalaAiQDscuWYfjBIg2zhy/2btHp6kr2SrTbPDv1r15CSCGqZZqNJn0z4VvtD1zd10Q5cdVqnN8+3v3E9GnDtAVtFNR+WvzCsZjWfwsQtJSiboWZQb01GxrR+g+Gp2lFabuGF+EoRXJOwE++evvQerdlVtnIF8NcfZd4sOo9mCVOmO06DaW1dWCzCy3FQlt6zawj8TxPDmC+Ij+4g8zCRXog4lTy8MELQwbd1Nyjy1opUFoUscK1L6ZCR618KinANqpK1YJ82It5OLcZ+AIDUo/WZVwVPhnp22cwUPnS55VsZqKt1xEydF3UFT2yNkNA60e1bSCIyH1YytGrA1zkWGaSJNk23ujDErwPq4ul0Z9wqpMDM+lgN1F2ccPCgObrJCUZQaEeHR71uQ48limdvwkbyxfEOtn/SWIrvPpyXgcjnOyxnqqcnnlK1TJvxVb+JvDTKKt37sg/GeswC4tocIZZjOnQmYMRXkxWur9PfluzDssqdbHHOOUubJ406CjJ1L05YcjAIxRUF3ID44FbdnJcD7mnxbP3AJJ9XhRn2aOovEwGL6Rt51UozUC+Fz/9j1oNhna21evMgkO1pFzGJevUnMvE28oBj2rJTfCrGaYkzz5TDJnnymGTPPlMMj35idVr4+TXgTUFtY5f0Af5ftdI6mLaroSMkd5NwiJTGY+iWk9m7VYID8EDDUu9kUiO2rFVGWGP965VfyQjKn1TAbeUXVuO374TMyMHDbE1zbcrov4BEEv97PpZllgNQaGg3hzQQFPmo084BZnc8feXXKpiKkIhoGi7jReOuGxQxls+P59ak6x6H/LzfARtbLhKIe/86jyZevBbYKhYRnyLsP7eDUs91oXYj/m0gpdg74AJT/RFf4YMC4Ku3al3nCr/0AoPzgFvDjqTtJ890LBhOqoo8x5TdWFDfQavN4ZunWLsIjYhpnnJGkg7YZtOyy7k3Y5gE3ViqI7tWfBYkDTBeQkhIgqkxWPOgQPHQbBHQ99U3VmHYYkoWz1eRli+Yqd7opiLKeSZY9dMgsNC0Js/5nv56IkCCXZMVN6w2sTEyaif3VuNndUD8GJg+Tic9hR8KPXZYaMT02vDpwIK/5JAsLe1/52syAzHvaP6WLwQ2Hu+cNhI+LF2etlPZoPLGUOLSs8EkJxevyKCrjemVhj/daKvfXgzegB7efkkiqcKCbHCEAItmFDmuuJSe00ThXBa3EO7Nt20CX+D3IHHQTYZxMQ+9C6ox8Lry9RspDvQeorGupvKy5Cq4SBftIFmHaWn2wOhtu2mECJPd8Pl/i45oo+PdlG9bes2sNQ1I8JQGd5crnuh5biiHPQN1i8jqaHcyHErarGh0KQwLmGarPi4IgSXC49j4X2T3vooTs6QRvN5O6sxON48wdESMeTTMfsZlKqt3GSidSY1KtDZUajqtwXl7qQpxkZCqv4jMi6nk0XjQmx0iAE/Cb50iOzW9gCfCOxpXulbKLCctHEgDRZiVZ0B4lnL9FuWwyJ7vknPy7agmW4kEDlZrKZwAp9SV31/8BfUrpj/rhtkk9vpRt4ZQzuXOpV1o6oHscGvkDnSNPcNdeS3GbdxzcucCJ2j51SYJ61HhzJH8Sr2LTy54Z0Vz5LU39QQ7mo3Qy48I8Z3eGZN4nkjDGGbc3VHDvTFDphcoT8j7MQiORNYBdcjFPzLvSDanmNqNeHj15xgDrdE4Qhf3cof/2vXaUmVobs7yYTGxqFQGwrfRrGC7Yex/i/zUwY0XIJwf5Z3d65hePGRWk/6+eyG6vw75WEDAM/cQRMc+9CYgbM5SY4WZJmAkn1m1ZqsJB2Ay9R3MKGflRPbXiPQZJDkQIDop12Iwa5a/RpanFL/d2K0cyJjLxPuI7ie9fv2z8NX0r94UR1JliIvy+xB26F41XrJCjbQfWCFV71J809Cq+pURzWD+cbjs5J79brbsDNet2/LyJYIxmMtyXKIyj/l8hRCGIE5lH2qyt+SCeAJ6ohRKGDAOUWuYjoPquJVQFcq92iG+7ruXlIgQrRKrWuJePVBC4KyI4oZf8+ic4x+s0X6G48Ty3pUjRpwY8RpHcSoTXCNkVrSbhiS7Xk1pGW6JrKQL34bCw6iJPMyswdmIc+4NPk9efW6k6LmNpfbycAp1m/ZxkhcQdL/m+TiM3koZoTrHQPXC+FZ3Xj6DO6Uf9IsVII5Uepld7lxHmyxXukVoZatJ3jtEJjtwi8h2Pazf8STPSwN5p43y7XFoLfsNwVv7rqRURDbGLVWpQLnSRfjOVfK4gEvGkKStKpy+mRJPCN/mz/uOUJHU1XmLWsxpE/kilJcBZob+ZqX3Ha8iJtzgjclY90MVOp9FY4siMf+V0TlPqW4FltvZjgDkWfNrjFpn7WsWu0ZdisPOCLvUNt4aONcGip28rIrHtaC6xdzhwv/v38Z4m/HmgwqrMdxcF6r2kZmZC4emSbZS29oaAL3SqO0AeMoOA8sxt5B76y1xq3spCrR6hTpUeP7AemDC2nvyN0Ro4DHE3xHJDngH71+ip1qNd9Jmfm4a0qBxVltVKeH0MuBAEE5a1NtttJNS4UnlrG2STtIvL3URF/k3FD6cuMfmyLxljlqnF0PlizEJq2JWfDDqhLLpX2DU/WciOu6lNlvKXID3NLYCZS4eknd9ACpWl308aNPBxtaJdNIUW0xP1dYs4Q7Us9+RJiHHCmXgtaoNWs+SKH0SgP1gVW/mWZbfIK23pEoZQo041qO3oitGO3JTu+syIpv98C8ZSPBwBWcHzA5SVtOWModD/AMJzDLWzgzwxGO45uAqzlU26x6zV+shC1t4vpUfWz2KEaDEX5V/DlEPbihBkSKxvJFTMdaY3No3QGCGKPYY1UfvPRIFKjuhV3C/s+aFoioz6uei65tJgoTbBQxFPI1/bRTgFA8hvvOA2nS/nXl1eI9VYRCphEIsRGsKyuy/MyaWERMTKgX0PzY0Ew7B2vOLPReEcr/kd3nl3W8kwUZbdkzS4+YeWHYEzQqUgbcvXBGsCqC9kLD0zFCDIjMgDVGO8Ei7QvpaX0yvL0gca5HeRU1BM5NE5GOb7hpLgOalY3CrC5Dqz4d2jEy7xRGfCnmV8DMxbuOkZiT84VLL4wJ0NVBVxpDZTaj/tI6a8MPcYYlBv7yhUy+cEGJ0dLv3hAStaEXCN024DYQIXXWKmqdtJ/27Owr+WSdwB/hBQ02NfFbDQkGmcDm6pfDPIRJvUSnpkebIoyEpVzl44bV4P1m9oFPqC4jx+wZFzCd/iw9kVoDmgFXnuNAGIY29tPFtNc+2Shu8gBG+GvM0epdJKwulQG1SOSEj9IgEQXppyFXn/s33X2N0/aFEyJI0Ib2BT2R3TIQ+VmDdp6uM83c0O/cJ4B9vTjzIqH0uJ5YIfECUm8i1C7/pz5uPhR4HMtOm9WVGhDQagCpruCuHc/0+o+xD6YBp4iMPPuf1jrrrkVzPYuuKzYARbLdF8lpH+xOWU1t5oy8hqvztAIE9FnIbcRRH0YMyKpHd0ACfS338JCBNWi5tx2ZoEILlW4n+XxfVolx430k+BYSAK7KBEJ1MCKuciLDld9L2xs6qb5WbP7jT8WCkMxE/rEAAAQj8RLmtaaMKDyuepW5UhQopMMFp3AgiWkwekFyLDjTJ79XEcnFKwnYw/06p0ciRlo9FGuRx0UVrtkF1B97ovlhyQcyNbv+pa39j65HAyUEtUgLwwTL66BP3XGxRmAQb8lhjGElFuUQyeThNP6mXyj26mEQ3oFfdusFBH40aXnciXbxIP7YiQlONJDgF5eVMUaKvqyX57R9xxJ6XGSFU809ZtdynzWmfPcqWru0AonrJis3X23xds6XOj+s0k29zYO3fXAN04liZcCBY7wn2LRZTFRQviMJoKCmaKUwRSpkioV1Vt/spCiyGCkx3Re/cHa/OZfJqVAXm4VDEuaJVz7HOnYBb6XPza9r2kZrNbOucrgVIcWrKDm8tNm029Hymo+p+v+c3NOIhOvCiFZJKDjj3shdhWMP9ZbYpNahlTF1qE97edmoLnM6VdxO8Adz1hsaEYpTF51ScCPNqwMwef0jf9mZ9JOZS+QfkojOTa0/F4JUpZ3zvyGGgeoQoAjr80Yee69tQjkkOvfVVT5wmp0Y//OFpU3I/wa9mbTgfYIqv85fcypWaZ4N8j6cBatWN36o1sKmH2oDqIzreEddPdSyOtIVZc20squmgKaNtyWxIt2NMT+yF8WyKmJgxvHJKb+v+7NBZsftUQidZh8j89mDGfSxhFymHKwZl11lGmOrlqtgINqWa0yrM78vanzMjZ7pR7nqXnr+QZNu8qx7HiQgNKCst7NrzHc4xNGlZMemFlrbi6E0tgCutMPMKE/iSJsompOB2OdfrKpaf2LTKZrodN1MIYY3fJgb+s+tJGcHg56125boW50EB+dGDAiJbLm9iRpxAcAw8SXXqZopeYlugmfcr2My4Z77XwH16kya4LslRHh6+NpdJ61DhNGpfP/LmPLO1X0XdUpjUXujJY/jBtxANgUvfDr5fXdPoVCNU/2nlqDnszuXgyLnJp2hBYqhQK9WY9rjJziq8UJTozGCIIot3rfEiVZwCfrTk9DX3dxdOVx+i1LuMDRwBhELVEHm+o1RYhZUpSeQNkkxxKqF4keuZCCijEgxs3gZcS6ARbko+yEds2KtRQZzMUMHOpPdU3ymmZ6UbHyrrUSEQHIW4Id4tFyHYZFQec6HvSgWFfjRSyv6pYGByCcYbb6/iSkZgRIpxqJJMllipGujy2jaz9vgaNX2ByQXGi1x8nS3ThR2tIdDMTlQS7soC+1Pkbx3uRs8kTBn9Xqjjq/onXhZD1d2eHOvotoHCF5/BzCX19l5ejaufQdp56zlUPc4YDzkSF0sc74MOIgVdu2vxIKEynwjET41MKPQ4K9nzzzJ8zBJbY7y+B7bUZi9lRRlWSKi+3ULWs7RJC29+gHPE0c1SjYe707voZK+GdP6rq4mzHkXJSG5SZWXIb02OINwx+SMEgmY7LdW1be6kHnVrthELBovb+Q89SqPmLW71hLgYsGsk1bo415mljdQnxU+jD4VHaaOWaO+l0tfa+n2/IAgsXWh20j2UzrgPMW26YsstBT6J7K5InpjaZoXDdhHB+C6gSdtJGh7FmLPBbNtGquczABH6sI2kGs/jQfalAR9da5tUBJvT9yrkrJTpwZ3dMVvTLCrvY+eHNwIWmBAj39du9Un3ypnf/2E5MJ+fjyxzlDRZTEB5nPD18GUZ+uHT+tzV7oiE75o9N/H7dX2tck1HMw61LiDOaBOJHLEeVW07ZQOHzMoFWaseFff1aQYsUp9PsB+SNOHi7SUgl5QwK7OJm2Gv0vJv7t3PsDYPnZZEJHGVzr8vQvUI0wsgCkcr/kkr+sSUTGwlWjAkA9yMey4QV140PwaK8dpBnme+4Ck0op+cNTYlEeKuazHNRb7ar7lRdAPs42MlEcI4dCteMy0J0onmSrfUt4vQASdUEUFsJnI5XVoy93YbCInoMvekrTK0gTpp++WXZGeTFrdEVw1zYAAGFz9OPkSjiMCGWHPwmYO+ki2ukbqta/yVC4mDskb6E7ii0KD2JYVpvrypGlY0rP7SXrqJYe+X+gwnzrn3ypozlEPimZ6lR+G1j/x/hN6o087NTotLPD7TMUHUTyRQGbnrfhr4P2dYXOn/yiFEYEfgy3a8KmkJ00YbqDS1W9EEhzRXVv7e4Jh7miySjZi0gdn+i/FJNyzMpVPHcgG7l7vr8HOWLNqS1Bn7Vuy6m+pGRB23YCIoWiXY6mLABlnX4iUUvhrMmNs0kywzhaWmq/NLbtl448/qJ5RWYL0IMfRnG3eZa7iSR/eeee7Rz+JulUvCNFleI2EvGpriu9jfukFltHR/YHCRMp1rKGk+JCP9m3RsZq3h+tbn0niJbX/V1NxFIy1UmGjlhkdr5jW6NpVnp1QrNaPhxd+/6XUDT19FxeRXHf21MnEHlY8TWaToyAC0CT5xCGIdJ8iQFkQuZqe3zc39hZch4LmS1VfdeKcrcI+4gk1C7co8MseBO8MMu3UiCfzk5dBCxZ5oCr+kEO1OcaWwDRMCXHJlIvHe1nBfpcf65DoEMkOG/R4zbksQs3kZ+FnyGYMkWXg8BIHGpF5mU4I8jH6BlF8h8Ek7Zcxc8/9h5w3jNMa3bfduvkdPR1v1MiSMebZ5Kt0InkR2xsQT2pa4sCgL2sbqfsxP8pp5qxduaL1aaSo4qYlyZA9VE3KYJv4KJ63V6BAjZ2b5fs8VVp4zH+Badgw7yT6rSIW1SAp8eiZiwqPiaFW5YaMqJKrMabQNtfrJpeox32GanXkaFZPkkMqWfHY9HWdzAmup0J8w2KeehQqX56m1x5OUgU0y3NlDtcSmCWsBn7HzTa6RRy3MzQQtiZw2tiIucn35EATaiPBRWY5FKDAFZIjDkv/ekZa7L5gdQZzbrSeNh8RUNk4EDxoK/MOaECj8XdFAzVEyM9K9/iMEDa6wXk3Jipe9nsOKGCd2/omXaOC40Q4N30ua3CNYleUuDrCHVPCiwVVHV9/Ebws3QE+t/WvlgoGJu+uD9NHP/nErgo0ws9Mmxs26YfWb8zTrR28r/A7sLHXHKmqwkgXj/dEUYE03UE4d1uRsGhrL/xKuylnLsggZQk9LGZhZ5LQZjXm9OHQYK69907RrGLrqkYvNpD2cwFd9y6EVH9JgtZUvC/IUFwBjMMA6+ao9jPYlKzZkidMUMz+bUTl6lUg4WuKhNCsFpN/QLT/OQi4mJV55CAuoXrE3csPbiV/xnzSpZYdCkgY5Q+epoQujwZ+v12E0W6DWByKVwgsEsVdNM2QjQxXQob2E3KTvm78VV6UFjsTgN5sjDAXp/eh2/PcnRQLtKWdg9X7hbYNzpWPpPirPdGVWRDM1/NZGW1K2fTpuWgksOaZ6YdR4skplVpzneoQ/4NWfL9y8qFJGYz+EEgFPv45mdgWnKYHF8uufW2iRqRQh+DR469c/ca/qIRPqIYzwhv82lmpSl343uqQ83ethGKlDS6ohp6gRI/O4R++qFGtvtKtQ6j2YYK4M39ZG2Nl4biarJgRKB/bzgvR1JK3dE7GFF8y08C1TbKSqIOSvwp2OAurYbu/egISEKWWh7J59CNFJ+V7wHH8iyUUt9twahRbomCfUQ6bvyWiNhxhiVGvNXS+/W5IKneH+/nYxYEEw1zYYzYvMQMAsGCXbVx7IXPoVHD0WJeR7rr0OnDQw76OElrjdeO6aSgvvwj2Yxp4I7lb7qeoCez4p8XRnWVIciwZtPT4fE5QT765hEXmfbDokJ5XIhZyGD7L5oM2MPaRv86ln3GMNpu4+rUaAC2j0MfnfYwOhqcLlS9mOhQtq6qXaxxm/qRlBv8QzPCCn64WtpnVYJbZoqX2v9mbU6YMYzs448x6dOv4JRtZIEV7MCtNURCuIxdHvycScsYO0vtYB0euF5k6112cm4CKaiT6LD3QimkvGrqkkj9bgyd+rUcXMyEKaJrvFPNW1j519OaBTrkYRP/yrdzOb0wisT8tn0oOtcvg8OBw1HNt0Q6i053qnx9qvCE0bc6ZnCRnId3Syl3iIOHEpFDSKxIdyJjEpsDJMsxJMFxo2KY1+jxnk9+jTMVIygD//fWvnYRid6IEyULgDwpWdxxVQQAZVogmhQSrbb24Y96DHNz+nkKsLTatwKQav8cj0lMEblRyJBNV5b8Uwc7B2srAgWWQQRi7a3x06g5l5NwPIXHJUEm6VK9QgdL5n8w3b5chk1lvfeYCtMLRLL42yNzluRNHTRtCa9lOYBOkCC8E1UpWj9UHhXeROqDjSqlhCcnJuwwbWspPMuRtUkRxhIANYVMEPl9ANU0MSqQ/rEukYG5bM7sImmVIbG316xu1ZKDYM7Qf6SE5D0hIhu4oKu5c4mOEv1s4g2f14W0mtQbedWXOMpS6NEHhBJVzfl10FGp06dRnkmAeOW0mlGco6X9R+dC2z/TyGLds0tJyBKhJbh96g+TY8jICeiuOJEPIAbUmfMbe5mA6fsBPgdrOwRPDkWX8EvMpkHrM8QpXw9J0EQZHXkG3ehU5TWC9/i5aQEA4GX7uhx7Z2gPDCkrxLzhVHxKyDrAQHgfEq3ApL955beAO9MNMpqNKx54Z3Gbh8waPa4KhYVF/s47LqGV5zvFloYuTMYGvhAy5RpYqZIf/8ObCbsjR4wkZ/xSmilydVsuARNoWwUzKd9NS8/ZDDxIvdZr8M1Bsy9Qtu5QF4HgR2aoD6qYhrllHmpEIdnIFvB7PJamycvW0XUyOKttBW1CrIPHw4c0Lii1NYUGD7goF8W6wUlFr19SkvyjiXVp6bm6sTIwUpZ/iuoIYRL9V3fC2vxp+mioj//pTfu+iM7VkrmHRzyi8EYwWoKfvAZBWRlclMrT6KaeiWoo2TqxLZ/3Fiw19QkcplPCdAh+lnNgt/GVMcaUcpEhgb2Q4heJwb8xAJNgmhTNpWWL3p05GEl8RF6rAFB2d3NbAzUMLaWzrrGiu9UODWYM2MLaiGg6EgK0ZOIoaUdk/I8rD5xYU+GwdXsrBC3L6ghjcLo1eHVFpyv0uQllb8KL+6TMBlTVL4hVQ9Fa7CTMzCvyVj9JHBMTP7JHepIeyykPNK1tkSmIb7rk4GwuW+6v95KugfPNsMZpqElcVnlZoN72C3xBosiac4K5D5zQ13L2ejjBXkj94ibPF91lt5i+5Msfk3jWi4BSlzjXuj7mYVdy8zw/xYT9gH4W56yeR2P9is+4iW0tiWEdTOpOX+4MvilTZALleVks70R5R8JbEmk5/2l55dURVqEg0boLR51pUVlSo5cO/4I+vw4Mg/zEmdDdBnNx8dTsKxQHF1fi3cIfq1xewb5U6tkjfgjBg0MWhN80wpY/5H/R9+hb0BQEe3F+wrFJesHklCfOI4GorciIEWKasW3fEW20/Zg4zYEvR8/1gE9V4Vkp3MZFNSoNpWxlwg2qsAYT796CZ8NOldKwnWbU5oYlCSw3mOH7C6Kw8wxU0gDvSFAK1xfsfUwhHgbtNxZNxz1Okj8CqHt0T/eA2Cxj6joK6095j49TGzN+zo56eG/2leVSuVSwc1VuPaV7oSw26vUjdG2Y2fZw730KUmvZ77wqXdt0DYZEB/C+EiqMTrJM58xmkyI0VDI95fvbBUe7Dka389E0q5Y5rW2hb/xVmBYzZXW5QppEpQR1CW8Y6mb7bNgRC4CQY7FAznryzA08uCWI2IE6GyrTG4/itjeCqXTdxGc4UP/SPcf7+OudZXsI6qHAa4h1tb13zhUC2C+ZoEthmXi7A2yCbCGDqhCC2uh6/gM7MFM/l15S3yLoXo0pLv5j1ljofwxS62AmFPGl8F0hvNz8sEkRukdF1Bd8y+aT4Qu6idIL33P5lQVT8f3jIMoQFDEPQFB19yGAKImnIuY24iT9gcHLGD7z7arQwf76k3e+VPHhb78iKapX5ihTUkSWnNNG4UAHjAFKvRS51/VMGfYjnANU3jK+NhjjDQ4J6cHBk2FFAzVrwlTJrbXTS71kYBFqYEFnQdEj8F9rJziOQP9Qx6xgiemoMeU0pvrvCUSNXetPZtwbvfr94a6bqZXv2W0lDvf9viJfco/UbA+8XPZSd+uWZKN4j2LS8Mr4AlwKzVqiSsQkeXIlqkyl1l5oMF/W/q18LyhscHgKqBQTF1UMUTOdp32Np18eId+zpcvguDMiO8SVx+VTfaLKy+TdHtxu3C3WS2Udg87pTpggFUYiWBRVMX54fj77Gston06Mnp3yx6Jc7Wdj+RElb8BkboMnVwpVxS51KTOqOPVUEcCbOk4yaRxn+Do5oUW4Cel5AWAQcd66iU6uAi6fnyAQh9V+SERPWzr3D5T22fPz0Rw5k0uAsKNARuKx9cCHf+/JveLWg8z+eeaNs1kp0qvhYgPTEpfdiT8gdU+TIvv67h4tzrPbRLItjxadwnj2BjqhZYvtOaaf5zoWXYp35d7e7ZXL7NAeR4/7ikHoLOPjxapmco66WCCJ1jHioe13tb2JwiZLfSays9NZUzUDPra2ge9HOP+LYQKzyoaJDYok7NvJgT6p/wQ56pJnTiAUy3M0nTBDJoDtpCNmTCCcHBEIQZ2OfQ8jMKxsvsZrYTQFA5WTsKxm0BSLmB1syWjHWCTgroHCe/ja+35o1vLJkWKgl2Jo6gCWNz0n3Yovx1mRcPfivUmiGbfqRrmgFHPsUUBG8mKAP+9vNDPIz+mfOyRQWFFsDGzacF8Qu1WyoUEFifSA9CVzXKbd+MbqL/0Huak8pQbxzzM8hrP2R0VZZ8acPqWlR8UCItLAvqxsqnXvc7UOGssgBqenQw87TRwsn7eQjfiAHK6qngSaMLik2lV6V+eef77YhjraqRgoRoNGSp6MTRK63s/XyyB9KxkHexHhvSIMtph25aMY3JIDpXtGwwm08Yks99eVrwi9TfAlezKw249DA28pOX7mu6sJxS54W3TtONs2FbpNz7k7bl6Jv8hShXABGpzjSxxIMIPMQKsirP7knNjU/6/1crNhRCz6jXgUABzXmFTAQVj2SWLLFgvzczhPPhEPTgHNUdfDYWUEcURa75gA5gmdruPG5CeOclAsyCtH0iZ/PakM4RspFiQ+l5h6DZgklnRlZuERhRawnOnY0fVC7S7M/gws72FsxxEZsxYZ0sDyDaQQ7XXF3RDvSK1g3052pt7aqNSXPsbvY6F0mLfuGxI7WqEAcTngcQWoRnimQRBgHLwrUUgDiw8AwLjOPCzD2WArV6Y6MOiVY0/s5oy0fAcfwdfmIQRIu84G8uXYFjHPQC8vuvQGmM+nOud6VUgRTHDy4ZoItey3yx4AAfsFHeFPCBL2U/pV1c6oQl51gwYQpQ5REEqaVqexuhMxgl37VQw9eVRMKBZQNjQwPGmVH2VT5SxrhYuYt1wAaFBCXKssfhG6biO+xCOxMBk1PBTp3buSMI3yfVZ5w43wodItPU5kiUnThfPt1fngIWRhYLVzbeu4uaXc/J21ljy/EmEXrfgm7V4vt4A8Gs5OLSUaekcFRVFLT+wk6R3+lPeq57NZwPdoYIotqu2A/DNICuXLkZqZFs0YUEX84lyGESHyuLzJFtkQ/JaYn/bwpQAANR1bnQB248PDoACUfxDhrE3LSWChl+xBYT0QXyhGA96wGpdby0tuC/DwN+1WNQh7RNuRnTG6VrNdL5g1PU33O+4brb2h7taQ+lHiYJFMkCA06MZA+A/HQhS001Yev7LLswSCIBcYrDBt4p3qzVk+dRtBwwDoVvvmu5WBpNs+psj3ej85k7haz3V3TL0SOSGsVzBws8CUVk8eUC2gavj7cIQQfXmA9MYNxtaCdEL8bHNWPTChEMnWrAEFIq3yEX4oKzoaeD4RDovs6++der2ooh0ndvnaqTPqJaQg9HfI3gRcj6lykh8VcA7/Nh1Kpm61PtyMNZ+s+iJV8nUy5cAJY3PbBGrNHCosULwP09cjySSJ0BBeu5M1YTbvuMGC+CYlGwmW75mHFXibYX70XU1Tm/KBMAeZYQXskyYzNPdiObkmIOp/skK9EPS4Y+2nU2kriIMPVlJ3Nt8PvLrl+OBoR1j7M0pnohzdIBBsUGWtdNJ9SDkVg/IcGZpepxkYPMhZC7ZNnQ9lEt7iojKlks0i1npo2yHnMnAF9XxAr29lI7LMy4lfRCVm2VN1esFUF6yqPIt+LeYLt2wlhA8smoZWUDI5EL99mw/V9oyzYN2zLnXh6PJoEQ8mJEI08rboQiBeO79B217D+Wz0CeXCfeZ39ePMJvlniTd8PG+IuRAOAfj22U3p5D2sYAAAAA=); }
  .login-claim { font-size:clamp(17px,4.5vw,23px); color:#fff; margin-top:12px; line-height:1.15; }
  .xp-missing-card { text-align:center; font-size:27px; margin-top:8px; color:#FDEF26; }
  .light .xp-missing-card { color:#D41323; }

  .logo-b{background-image:url(data:image/png;base64,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)}
  .logo-w{background-image:url(data:image/png;base64,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WLJu3br4Zs2aVUpISMDDhw8j3dzcdPn5+fD09Lx64sSJC7NmzTpkok1Oo0aNKqlUKklMTIzUVOfGjh1badasWT6nT5/WT548OSc3NzfRGie9a9euXwYOHBjK4/Fw586dlDFjxoTcunVLYo26bQAwSEnQoUMHAYBabdq04bRr1w4qlcotMjKybY0aNVCzZk24ubkJ796928nd3Z1Pg41SU1Nr8fl8kYODA8RiMcPj8Zg3tR+lDRtA4YRPqamp8pSUlMOHDh1atnHjxvCS1GPVQJV58+ZV6du373IfHx97pVIJhUKBR48egcfjoVatWmjbtm1LtVoNlUoFBwcHD6VS6RkaGhoSEBBQKS8vD5UqVULVqlUb0DyyPB6vsVgsHufm5lZ7zJgxcUWaE/7111/T6tWrN9DNzc2bx+NJ09LSkh4/frzyhx9+yDp8+HB3tVotWLp0adju3btvAUD79u3Xu7i49O3evbv+n3/++aB58+ZWEdAMw/jQ9JxCoVBECLEDYBPQ1oN907l06ZISwL1Lly4Z/n7W1MEtW7as0bJlS2GnTp1QuXJlwbFjxzp6eHiYztFqw0YZUavVKCgoeH7x4sU7ly5delLR/cGRI0dWqVQqIpFISFxcHGnbti3h8XhEJBKRvn37ktTUVJKfn0+kUim5f/++FIBfeHj47yqVikilUhIeHp4VFxd3MTIysiA7O5vI5XLy8OFD+axZswJoG66urs6NGjXyOXz48HW5XE4UCgVRKBREpVIRrVZLnj9/rtm2bVuEQqEger2enDp1ak23bt3sIyMju0RFRSXJ5XKiVqvJP//888uQIUP85s6daweACwChoaGu27ZtW7B169aVM2fObFncOVauXNkOQKGbu2/fvg0vX758KDc39/jx48c/LjImdh988IGd1QfbOKIPPvjA7lU/bdiwYeNlSHR4eHi8QqEgcrmcTJgwgQAo9Pn555+JUqkkMpmM5OXl3enWrVvAnTt38uRyOZFKpWT16tWzAGDDhg3L8/PziUKhIH/99demIk05HjlyZCt9EEilUvL48WNy7949kpmZSeRyOcnKyiK5ublEoVCQW7du/fLdd9+NkkgkRCKRkLy8PJKbm0ueP39OkpKSshISEhKuX78e9qrdaXK5nBBCSGxs7Omi57hz586xMTExCTdv3ozcuXNnD/r9Bx980Pj69etdly1b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);display:none}
  .pd-logo-img { width:98px; height:32px; background-size:contain; background-repeat:no-repeat; background-position:left center; }
  .logo-b { display:none; }
  .logo-w { display:block; }
  .light .logo-b { display:block; }
  .light .logo-w { display:none; }

  .bg-doodles { position:absolute; inset:0; z-index:-1; pointer-events:none; color:#fff; opacity:.20; overflow:hidden;
    background-color:currentColor;
    -webkit-mask-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27440%27 height=%27440%27 viewBox=%270 0 440 440%27%3E%3Cdefs%3E%3Cg id=%27fl%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(72)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(144)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(216)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(288)%27/%3E%3Ccircle r=%273.1%27 fill=%27white%27 stroke=%27none%27/%3E%3C/g%3E%3Cg id=%27st%27%3E%3Cpath d=%27M0 -13 L3 -3 L13 0 L3 3 L0 13 L-3 3 L-13 0 L-3 -3Z%27 fill=%27white%27/%3E%3C/g%3E%3Cg id=%27lf%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M0 0 C7 -4 11 -13 8 -20 C2 -15 -2 -7 0 0Z%27/%3E%3Cpath d=%27M2.5 -3 L7 -15%27/%3E%3C/g%3E%3C/defs%3E%3Cuse href=%27%23fl%27 transform=%27translate(72,84) scale(2.3)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(305,62) scale(1.5) rotate(12)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(388,178) scale(2.7) rotate(40)%27/%3E%3Cuse href=%27%23fl%27 transform=%27translate(215,292) scale(3.1) rotate(18)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(84,362) scale(1.2) rotate(-10)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(332,396) scale(1.9) rotate(-35)%27/%3E%3Cuse href=%27%23fl%27 transform=%27translate(410,330) scale(1.6) rotate(-25)%27/%3E%3C/svg%3E"); mask-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27440%27 height=%27440%27 viewBox=%270 0 440 440%27%3E%3Cdefs%3E%3Cg id=%27fl%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(72)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(144)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(216)%27/%3E%3Cpath d=%27M0 0 C-5 -9 -5 -20 0 -22 C5 -20 5 -9 0 0Z%27 transform=%27rotate(288)%27/%3E%3Ccircle r=%273.1%27 fill=%27white%27 stroke=%27none%27/%3E%3C/g%3E%3Cg id=%27st%27%3E%3Cpath d=%27M0 -13 L3 -3 L13 0 L3 3 L0 13 L-3 3 L-13 0 L-3 -3Z%27 fill=%27white%27/%3E%3C/g%3E%3Cg id=%27lf%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M0 0 C7 -4 11 -13 8 -20 C2 -15 -2 -7 0 0Z%27/%3E%3Cpath d=%27M2.5 -3 L7 -15%27/%3E%3C/g%3E%3C/defs%3E%3Cuse href=%27%23fl%27 transform=%27translate(72,84) scale(2.3)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(305,62) scale(1.5) rotate(12)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(388,178) scale(2.7) rotate(40)%27/%3E%3Cuse href=%27%23fl%27 transform=%27translate(215,292) scale(3.1) rotate(18)%27/%3E%3Cuse href=%27%23st%27 transform=%27translate(84,362) scale(1.2) rotate(-10)%27/%3E%3Cuse href=%27%23lf%27 transform=%27translate(332,396) scale(1.9) rotate(-35)%27/%3E%3Cuse href=%27%23fl%27 transform=%27translate(410,330) scale(1.6) rotate(-25)%27/%3E%3C/svg%3E");
    -webkit-mask-repeat:repeat; mask-repeat:repeat; -webkit-mask-size:440px 440px; mask-size:440px 440px; }
  .light .bg-doodles { color:#101010; opacity:.16; }

  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  html,body { height:100%; }
  body { font-family:'Funnel Display',sans-serif; background:#04080f; color:#e8f4ff; min-height:100vh; -webkit-font-smoothing:antialiased; overflow-x:hidden; }

  :root {
    --azzurro:#A3CFFE; --rosa:#FF6DEC; --giallo:#FDEF26; --verde:#339966; --rosso:#D41323;
    --neon-blue:#A3CFFE; --neon-pink:#FF6DEC; --neon-gold:#FDEF26; --neon-green:#339966;
    --nero:#101010; --bianco:#FFFFFF;
    --surface:rgba(18,18,18,0.92); --surface2:rgba(28,28,28,0.9); --surface3:rgba(38,38,38,0.85);
    --border:rgba(255,255,255,0.14); --border2:rgba(255,255,255,0.24);
    --text:#f4f4f4; --text2:rgba(255,255,255,.65); --text3:rgba(255,255,255,.4);
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
      #04080f;
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
    background:rgba(5,15,35,0.95); border:1px solid rgba(163,207,254,0.3);
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
    background:linear-gradient(135deg, var(--neon-blue) 0%, #fff 40%, var(--rosa) 100%);
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
  .nickname-list { max-height:220px; overflow-y:auto; border:1px solid var(--border2); border-radius:var(--radius-sm); margin-top:6px; background:rgba(5,15,35,0.98); }
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
  .btn-primary {
    background:#FDEF26; color:#101010; width:100%; padding:15px;
    font-size:15px; font-weight:800; letter-spacing:.08em; text-transform:uppercase;
    border:2px solid #101010; box-shadow:var(--glow-blue), inset 0 1px 0 rgba(255,255,255,0.15);
    border-radius:12px;
  }
  .btn-primary:active { transform:scale(.97); opacity:.9; }
  .btn-ghost { background:rgba(163,207,254,0.06); color:var(--text2); border:1px solid var(--border2); border-radius:10px; }
  .btn-ghost:active { background:rgba(163,207,254,0.12); }
  .btn-danger { background:rgba(255,34,68,.12); color:#ff4466; border:1px solid rgba(255,34,68,.3); }
  .btn-yellow {
    background:#FDEF26;
    background-size:200% 100%; color:#101010; font-weight:900;
    border:1px solid rgba(253,239,38,0.5); box-shadow:var(--glow-gold);
    text-transform:uppercase; letter-spacing:.06em;
  }
  .btn-sm { padding:7px 14px; font-size:12px; min-height:36px; }
  .btn-xs { padding:5px 10px; font-size:11px; min-height:30px; border-radius:8px; }

  /* ═══ EDUCATOR DESKTOP ═══ */
  .edu-layout { display:flex; min-height:100vh; position:relative; z-index:1; background:#0a0a0a; --dead:linear-gradient(160deg,#1a0e55 0%,#122a7a 50%,#1f0e5a 100%); }
  .sidebar { width:240px; background:#0d0d0d; border-right:1px solid #2a2a2a; display:flex; flex-direction:column; position:fixed; top:0; left:0; height:100vh; overflow-y:auto; z-index:10; backdrop-filter:blur(24px); }
  .sidebar-logo { padding:20px 18px 16px; border-bottom:1px solid rgba(255,255,255,.08); }
  .sidebar-logo-box { background:#cc1111; border-radius:9px 12px 9px 14px; padding:5px 11px; display:inline-block; box-shadow:2px 3px 0 rgba(0,0,0,.3); transform:rotate(-1deg); }
  .sidebar-logo-t { font-family:'Funnel Display',sans-serif; font-weight:900; font-size:15px; text-transform:uppercase; color:#111; line-height:1.05; letter-spacing:-.3px; }
  .sidebar-logo-sub { font-family:'Funnel Display',sans-serif; background:#111; color:#ffe600; font-size:8px; font-weight:900; border-radius:4px; padding:2px 7px; text-transform:uppercase; letter-spacing:.07em; margin-top:3px; display:inline-block; }
  .sidebar-badge { display:inline-flex; align-items:center; gap:5px; background:rgba(253,239,38,.12); border:1px solid rgba(253,239,38,.25); border-radius:99px; padding:3px 10px; font-size:9px; font-weight:800; color:#FDEF26; text-transform:uppercase; letter-spacing:.06em; margin-top:8px; }
  .nav { flex:1; padding:8px 0; }
  .nav-item { display:flex; align-items:center; gap:10px; padding:9px 18px; cursor:pointer; font-size:13px; font-weight:600; color:rgba(255,255,255,.38); border-left:2px solid transparent; transition:all .12s; min-height:42px; border-radius:0 10px 10px 0; margin:1px 8px 1px 0; }
  .nav-item:hover { background:rgba(255,255,255,.05); color:rgba(255,255,255,.75); }
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
  .mob-drawer { position:fixed; top:0; left:0; bottom:0; width:270px; background:rgba(10,5,40,.97); border-right:1px solid rgba(255,255,255,.08); z-index:40; transform:translateX(-100%); transition:transform .25s; display:flex; flex-direction:column; backdrop-filter:blur(24px); }
  .mob-drawer.open { transform:translateX(0); }
  .mob-bottom-nav { display:none; position:fixed; bottom:0; left:0; right:0; padding-bottom:env(safe-area-inset-bottom,0px); background:#0d0d0d; border-top:1px solid #2a2a2a; z-index:20; padding-bottom:env(safe-area-inset-bottom,0px); backdrop-filter:blur(24px); }
  .mob-bottom-nav-inner { display:flex; height:60px; }
  .mob-nav-btn { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; background:none; border:none; cursor:pointer; color:rgba(255,255,255,.28); font-family:'Funnel Display'; padding:0; transition:color .15s; }
  .mob-nav-btn.active { color:#FDEF26; }
  .mob-nav-btn { transition:color .2s; }

  /* ═══ SECTION BANNERS ═══ */
  .section-banner { padding:14px 8px 4px; margin-bottom:14px; position:relative; display:flex; align-items:center; justify-content:center; }
  .section-banner-content { text-align:center; }
  .section-banner-bg { position:absolute; inset:0; background-size:cover; background-position:center; }
  .section-banner-overlay { position:absolute; inset:0; background:rgba(0,0,0,.45); }
  .section-banner-content { position:relative; z-index:1; flex:1; }
  .section-banner-title { font-family:'Funnel Display',sans-serif; font-weight:900; font-size:36px; text-transform:uppercase; color:#fff !important; letter-spacing:.02em; line-height:1; text-shadow:none; }
  .light .section-banner-title { color:#101010 !important; }
  .section-banner-sub { font-size:12px; color:rgba(255,255,255,.65); margin-top:2px; }

  /* ═══ GAME CARDS ═══ */
  .card {
    background:rgba(0,0,20,0.45); border:1px solid rgba(255,255,255,0.09);
    border-radius:var(--radius); padding:16px 20px;
    backdrop-filter:blur(10px); position:relative;
  }
  .card-sm { background:rgba(0,0,20,0.4); border:1px solid rgba(255,255,255,0.08); border-radius:var(--radius-sm); padding:12px 14px; }
  .stats-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:18px; }
  .stat-card {
    background:rgba(0,0,20,0.4); border:1px solid rgba(255,255,255,0.1);
    border-radius:var(--radius); padding:14px; position:relative; overflow:hidden;
  }
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
    background:rgba(8,18,40,0.9); border:1px solid var(--border);
    border-radius:12px; padding:10px 12px; transition:all .15s; position:relative; overflow:hidden;
  }
  .lb-row::before { content:''; position:absolute; left:0; top:0; bottom:0; width:2px; background:var(--border); }
  .lb-rank { font-family:'Funnel Display',sans-serif; font-size:18px; font-weight:900; width:26px; text-align:center; color:var(--text3); flex-shrink:0; }
  .lb-rank.gold { color:var(--neon-gold); text-shadow:0 0 16px rgba(253,239,38,0.7); }
  .lb-rank.silver { color:#aac8e0; }
  .lb-rank.bronze { color:#d4916a; }
  .lb-row:nth-child(1) { border-color:rgba(253,239,38,0.25); box-shadow:0 0 20px rgba(253,239,38,0.08); }
  .lb-row:nth-child(1)::before { background:#FFD700; }
  .lb-row:nth-child(2) { border-color:rgba(170,200,224,0.2); }
  .lb-row:nth-child(2)::before { background:#C0C0C0; }
  .lb-row:nth-child(3) { border-color:rgba(212,145,106,0.2); }
  .lb-row:nth-child(3)::before { background:#CD7F32; }
  .lb-av { width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0; overflow:hidden; border:1.5px solid var(--border2); }
  .lb-av img { width:100%; height:100%; object-fit:cover; }
  .lb-name { flex:1; font-size:13px; font-weight:700; color:var(--text); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .lb-level { font-size:9px; color:var(--text3); margin-top:1px; }
  .lb-xp { font-family:'Funnel Display',sans-serif; font-size:18px; font-weight:900; color:var(--neon-blue); flex-shrink:0; }

  /* ═══ PLAYER DETAIL ═══ */
  .player-detail { background:rgba(5,15,35,0.95); border:1px solid rgba(163,207,254,0.25); border-radius:var(--radius-lg); padding:20px; margin-top:12px; box-shadow:var(--glow-blue); }
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
  .chip { padding:7px 16px; border-radius:99px; border:1px solid var(--border2); background:rgba(163,207,254,0.04); color:var(--text2); font-family:'Funnel Display'; font-size:12px; font-weight:700; cursor:pointer; min-height:34px; transition:all .15s; letter-spacing:.03em; }
  .chip.active { background:rgba(255,255,255,0); color:var(--neon-blue); border-color:rgba(163,207,254,0.4); box-shadow:0 0 12px rgba(163,207,254,0.2); }

  /* ═══ BATCH ═══ */
  .batch-panel { background:rgba(163,207,254,0.05); border:1px solid rgba(163,207,254,0.2); border-radius:var(--radius); padding:12px 16px; margin-bottom:14px; }
  .batch-info { font-size:13px; color:var(--neon-blue); font-weight:700; margin-bottom:10px; }
  .batch-inp { width:70px; padding:8px 10px; background:rgba(163,207,254,0.08); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:18px; font-weight:700; outline:none; text-align:center; }

  /* ═══ PRESENZE ═══ */
  .pres-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border-radius:var(--radius); border:1px solid var(--border); }
  .pres-table { width:100%; border-collapse:collapse; font-size:13px; min-width:420px; }
  .pres-table th { padding:10px 12px; text-align:left; font-size:10px; font-weight:700; color:var(--text3); border-bottom:1px solid var(--border); text-transform:uppercase; letter-spacing:.1em; background:rgba(4,8,20,0.95); }
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
    --pt-empty-bg:     #ffffff;
    --pt-empty-color:  #9e9e9e;
    --pt-empty-border: 2px solid #9e9e9e;
    --pt-done-bg:      #e8f5e9;
    --pt-done-color:   #2e7d32;
    --pt-done-border:  2px solid #2e7d32;
  }
  .pres-toggle { width:40px; height:40px; border-radius:10px; cursor:pointer; font-size:18px; font-weight:900; transition:all .15s; display:inline-flex; align-items:center; justify-content:center; }
  .pres-toggle.done  { background:var(--pt-done-bg);  color:var(--pt-done-color);  border:var(--pt-done-border);  box-shadow:0 0 10px rgba(51,153,102,.2); }
  .pres-toggle.empty { background:var(--pt-empty-bg); color:var(--pt-empty-color); border:var(--pt-empty-border); box-shadow:none; }
  .light .pres-toggle.done  { box-shadow:0 2px 8px rgba(46,125,50,.2); }
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
  .delete-btn { position:absolute; top:10px; right:10px; width:28px; height:28px; border-radius:6px; border:1px solid rgba(255,34,68,.3); background:rgba(255,34,68,.08); color:#ff4466; cursor:pointer; font-size:13px; display:flex; align-items:center; justify-content:center; transition:all .12s; }
  .delete-btn:hover { background:rgba(255,34,68,.2); }

  /* ═══ BADGES ═══ */
  .badge-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:18px; }
  .badge-card {
    background:rgba(80,0,80,0.08); border:1px solid rgba(255,0,204,0.15);
    border-radius:var(--radius); padding:18px 14px; text-align:center;
    cursor:pointer; position:relative; transition:all .2s;
  }
  .badge-card:hover { border-color:rgba(255,0,204,0.4); box-shadow:var(--glow-pink); transform:translateY(-3px) scale(1.02); }
  .badge-img { width:128px; height:128px; border-radius:50%; object-fit:cover; margin:0 auto 14px; display:block; border:3px solid rgba(255,0,204,0.5); box-shadow:0 0 20px rgba(255,0,204,0.35); }
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
  .sfida-desc { font-size:13px; color:rgba(255,255,255,.6); margin-bottom:12px; line-height:1.5; }
  .sfida-reward { display:inline-flex; align-items:center; gap:6px; background:rgba(253,239,38,0.12); border:1px solid rgba(253,239,38,0.3); border-radius:8px; padding:6px 14px; font-size:12px; font-weight:800; color:var(--neon-gold); letter-spacing:.04em; }

  /* ═══ DIARIO ═══ */
  .diary-day { margin-bottom:18px; }
  .diary-date { font-family:'Funnel Display',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--neon-blue); margin-bottom:8px; letter-spacing:.05em; }
  .diary-entry { display:flex; align-items:center; gap:10px; padding:10px 14px; background:rgba(8,18,40,0.9); border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:5px; }
  .diary-icon { font-size:18px; flex-shrink:0; }
  .diary-text { flex:1; font-size:13px; color:var(--text); line-height:1.4; }
  .diary-pts { font-family:'Funnel Display',sans-serif; font-size:18px; font-weight:900; color:var(--neon-blue); flex-shrink:0; }

  /* ═══ MODAL ═══ */
  .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:100; display:flex; align-items:flex-end; justify-content:center; backdrop-filter:blur(8px); }
  .modal {
    background:rgba(5,12,30,0.98); border:1px solid rgba(163,207,254,0.25);
    border-radius:20px 20px 0 0; padding:24px 20px;
    padding-bottom:calc(24px + env(safe-area-inset-bottom,0px));
    width:100%; max-width:560px; max-height:92vh; overflow-y:auto;
    box-shadow:0 -20px 60px rgba(0,0,0,0.8), var(--glow-blue);
    position:relative;
  }
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
  .profile-firstname { font-size:13px; color:rgba(255,255,255,.45); margin-bottom:8px; letter-spacing:.08em; }
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
  .profile-stat-lbl { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:rgba(255,255,255,.35); margin-top:3px; }
  .profile-xp-section { padding:0 20px 22px; position:relative; z-index:1; }
  .xp-bar-wrap { height:8px; background:rgba(255,255,255,.07); border-radius:99px; overflow:hidden; margin:10px 0 4px; }
  .xp-bar { height:100%; background:var(--verde); border-radius:99px; transition:width .6s cubic-bezier(.4,0,.2,1); box-shadow:0 0 12px rgba(163,207,254,0.5); }
  .xp-label { display:flex; justify-content:space-between; font-size:10px; color:rgba(255,255,255,.35); font-weight:700; letter-spacing:.06em; }

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
  .tag-red { background:rgba(255,34,68,.1); color:#ff4466; border:1px solid rgba(255,34,68,.2); }
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
  .squad-row { display:flex; align-items:center; gap:12px; background:rgba(8,18,40,0.9); border:1px solid var(--border); border-radius:var(--radius-sm); padding:14px 16px; }
  .squad-color-dot { width:16px; height:16px; border-radius:50%; flex-shrink:0; }
  .squad-name { flex:1; font-family:'Funnel Display',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--text); }

  /* ═══ MESSAGES ═══ */
  .msg-layout { display:flex; gap:12px; height:440px; }
  .msg-list { width:150px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; flex-shrink:0; }
  .msg-thread { background:rgba(8,18,40,0.9); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px 12px; cursor:pointer; transition:all .15s; }
  .msg-thread.active { border-color:rgba(163,207,254,0.4); background:rgba(163,207,254,0.08); box-shadow:0 0 12px rgba(163,207,254,0.1); }
  .mt-name { font-size:12px; font-weight:700; color:var(--text); }
  .msg-main { flex:1; display:flex; flex-direction:column; background:rgba(8,18,40,0.9); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; min-width:0; }
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
    background:rgba(4,8,20,0.97); border-top:1px solid rgba(255,255,255,0);
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
  .pod-2 .pod-av-wrap { width:54px; height:54px; border:2px solid #9090b0; box-shadow:0 0 14px rgba(150,150,200,.35); }
  .pod-3 .pod-av-wrap { width:48px; height:48px; border:2px solid #b87a30; box-shadow:0 0 12px rgba(200,130,50,.3); }
  .pod-1 .pod-base { background:rgba(253,239,38,.08); border:1px solid rgba(253,239,38,.22); border-bottom:none; min-height:70px; }
  .pod-2 .pod-base { background:rgba(140,140,180,.06); border:1px solid rgba(140,140,180,.15); border-bottom:none; min-height:52px; }
  .pod-3 .pod-base { background:rgba(180,120,50,.06); border:1px solid rgba(180,120,50,.14); border-bottom:none; min-height:40px; }
  .pod-1 .pod-xp { color:#FDEF26; }
  .pod-2 .pod-xp { color:#aac8e0; }
  .pod-3 .pod-xp { color:#d4916a; }

  /* ═══ STREAK ═══ */
  .streak-card { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(255,120,0,.25); border-radius:14px; padding:12px 14px; position:relative; z-index:2; }
  .streak-row { display:flex; gap:8px; }
  .streak-item { flex:1; text-align:center; }
  .streak-val { font-family:'Funnel Display',sans-serif; font-size:26px; font-weight:900; color:#D41323; line-height:1; display:block; }
  .streak-lbl { font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.1em; color:rgba(255,255,255,.35); margin-top:2px; display:block; }
  .month-prog { margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.07); }
  .month-prog-lbl { display:flex; justify-content:space-between; font-size:9px; font-weight:900; color:rgba(255,255,255,.3); text-transform:uppercase; letter-spacing:.06em; margin-bottom:5px; }
  .month-prog-bg { height:7px; background:rgba(255,255,255,.07); border-radius:99px; overflow:hidden; }
  .month-prog-fill { height:100%; background:#FDEF26; border-radius:99px; }


  /* ═══ LIGHT MODE — Redesign sistematico ═══ */

  /* ─ Step 1: Override di tutte le variabili root ─ */
  .light {
    --neon-blue:  #101010;
    --neon-pink:  #D41323;
    --neon-gold:  #D41323;
    --neon-green: #2e7d32;
    --azzurro:    #101010;
    --rosa:       #c2185b;
    --giallo:     #f9a825;
    --verde:      #388e3c;
    --rosso:      #c62828;
    --text:       #0d1117;
    --text2:      #3a4a5c;
    --text3:      #6b7e94;
    --surface:    rgba(255,255,255,0.95);
    --surface2:   rgba(240,244,255,0.9);
    --surface3:   rgba(230,236,252,0.85);
    --border:     rgba(0,0,0,0.10);
    --border2:    rgba(0,0,0,0.18);
    --accent:     #101010;
    --accent2:    #2e7d32;
    --danger:     #c62828;
    --warning:    #D41323;
    --glow-blue:  0 2px 12px rgba(16,16,16,.2);
    --glow-gold:  0 2px 12px rgba(245,127,23,.25);
    --glow-green: 0 2px 10px rgba(46,125,50,.2);
    --glow-pink:  0 2px 12px rgba(212,19,35,.2);
    --radius: 14px;
    --radius-sm: 10px;
    --radius-lg: 20px;
  }

  /* ─ Step 2: Base page ─ */
  .light body {
    background: #eef2fb;
    color: #0d1117;
  }
  .light body::before {
    background:
      radial-gradient(ellipse 80% 50% at 20% -10%, rgba(16,16,16,.08) 0%, transparent 60%),
      radial-gradient(ellipse 60% 40% at 90% 110%, rgba(212,19,35,.06) 0%, transparent 55%),
      #eef2fb;
  }
  .light body::after {
    background-image:
      linear-gradient(rgba(16,16,16,.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(16,16,16,.04) 1px, transparent 1px);
  }

  /* ─ Step 3: Educator layout ─ */
  .light .edu-layout { background: #eef2fb; }

  .light .topbar { background:#ffffff !important; border-bottom:2px solid #101010 !important; }
  .light .mob-header { background:#ffffff !important; border-bottom:2px solid #101010 !important; }
  .light .mob-header * { color:#101010; }
  .light .mob-bottom-nav { background:#ffffff !important; border-top:2px solid #101010 !important; }
  .light .mob-bottom-nav * { color:#101010 !important; }
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
    color: #90caff;
  }
  .light .nav-item { color: rgba(255,255,255,.38); }
  .light .nav-item:hover { background: rgba(255,255,255,.06); color: rgba(255,255,255,.75); }
  .light .nav-item.active {
    background: rgba(100,160,255,.12);
    color: #90caff;
    border-left-color: #90caff;
  }
  .light .nav-badge { background: #c62828; color: #fff; }
  .light .sidebar-user { border-top: 1px solid rgba(255,255,255,.08); }

  .light .topbar {
    background: rgba(13,20,40,.9);
    border-bottom: 1px solid rgba(255,255,255,.08);
    backdrop-filter: blur(20px);
  }
  .light .topbar-title { color: rgba(255,255,255,.9); }

  .light .mob-header {
    background: rgba(13,20,40,.92);
    border-bottom: 1px solid rgba(255,255,255,.08);
  }
  .light .mob-header-title { color: rgba(255,255,255,.9); }
  .light .mob-drawer { background:#ffffff; } .light .mob-drawer * { color:#101010 !important; }
  .light .mob-bottom-nav {
    background: rgba(13,20,40,.95);
    border-top: 1px solid rgba(255,255,255,.08);
  }
  .light .mob-nav-btn { color: rgba(255,255,255,.3); }
  .light .mob-nav-btn.active { color: #90caff; }
  .light .content { background: transparent; }
  .light .edu-content-wrap { background: transparent; }

  /* ─ Step 4: Cards ─ */
  .light .card {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.08);
    box-shadow: 0 2px 16px rgba(0,0,0,.06);
    color: #0d1117;
  }
  .light .card-sm {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.07);
    color: #0d1117;
  }
  .light .stat-card {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.08);
    box-shadow: 0 2px 12px rgba(0,0,0,.05);
  }
  .light .stat-card::before {
    background:rgba(16,16,16,.15);
  }
  .light .stat-label { color: #6b7e94; }
  .light .stat-value { color: #0d1117; }

  /* ─ Step 5: Forms & Inputs ─ */
  .light .form-input {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.18);
    color: #0d1117;
    font-weight: 500;
  }
  .light .form-input:focus {
    border-color: #101010;
    box-shadow: 0 0 0 3px rgba(16,16,16,.1);
    background: #ffffff;
  }
  .light .form-label { color: #3a4a5c; font-weight: 700; }
  .light select {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.15);
    color: #0d1117;
  }
  .light textarea {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.15);
    color: #0d1117;
  }
  .light .search-inp {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.15);
    color: #0d1117;
  }
  .light .search-inp:focus { border-color: #101010; box-shadow: 0 0 0 3px rgba(16,16,16,.1); }

  /* ─ Step 6: Buttons ─ */
  .light .btn-primary {
    background:#101010;
    border-color: rgba(16,16,16,.6);
    box-shadow: 0 2px 8px rgba(16,16,16,.3);
  }
  .light .btn-ghost {
    background: rgba(0,0,0,.05);
    color: #3a4a5c;
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
    color: #c62828;
    border: 1.5px solid rgba(198,40,40,.25);
  }

  /* ─ Step 7: Chips ─ */
  .light .chip {
    background: #ffffff;
    border: 1.5px solid rgba(0,0,0,.15);
    color: #3a4a5c;
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
  .light .tag-green  { background: #e8f5e9; color: #2e7d32; border: 1px solid #a5d6a7; }
  .light .tag-blue   { background: #e3f2fd; color: #101010; border: 1px solid #90caf9; }
  .light .tag-amber  { background: #fff8e1; color: #D41323; border: 1px solid #ffe082; }
  .light .tag-red    { background: #ffebee; color: #c62828; border: 1px solid #ef9a9a; }
  .light .tag-gray   { background: #f5f5f5; color: #546e7a; border: 1px solid #b0bec5; }

  /* ─ Step 9: Presenze (checkbox) ─ */
  .light .pres-wrap {
    border: 1.5px solid rgba(0,0,0,.1);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,.05);
  }
  .light .pres-table th {
    background: #f5f7ff;
    color: #3a4a5c;
    border-bottom: 2px solid rgba(0,0,0,.08);
    font-weight: 800;
  }
  .light .pres-table td {
    color: #0d1117;
    border-bottom: 1px solid rgba(0,0,0,.05);
    background: #ffffff;
  }
  .light .pres-table tr:hover td { background: #f8f9ff; }
  /* Checkbox presenze: visibile e solido */
  .light .pd-yes {
    background: #2e7d32 !important;
    color: #ffffff !important;
    border-color: #2e7d32 !important;
    box-shadow: 0 2px 6px rgba(46,125,50,.3) !important;
  }
  .light .pd-none {
    background: #ffffff !important;
    color: #9e9e9e !important;
    border: 2px solid #bdbdbd !important;
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
  .light .lb-rank      { color: #6b7e94; }
  .light .lb-rank.gold { color: #D41323; text-shadow: none; }
  .light .lb-rank.silver { color: #546e7a; }
  .light .lb-rank.bronze { color: #6d4c41; }
  .light .lb-name  { color: #0d1117; font-weight: 700; }
  .light .lb-level { color: #6b7e94; }
  .light .lb-xp    { color: #101010; }
  .light .lb-av    { background: #f5f7ff; border-color: rgba(0,0,0,.1); }

  /* ─ Step 11: Player grid ─ */
  .light .player-card {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.08);
    box-shadow: 0 2px 8px rgba(0,0,0,.05);
  }
  .light .player-card:hover { border-color: rgba(16,16,16,.3); box-shadow: 0 4px 16px rgba(16,16,16,.1); }
  .light .player-card.selected { border-color: #101010; background: rgba(16,16,16,.04); box-shadow: var(--glow-blue); }
  .light .p-name  { color: #0d1117; }
  .light .p-level { color: #6b7e94; }
  .light .p-xp    { color: #101010; }
  .light .p-coin  { color: #D41323; }
  .light .avatar-wrap { border-color: rgba(16,16,16,.25); }

  /* ─ Step 12: Activities ─ */
  .light .act-card {
    background: #f0fff4;
    border: 1.5px solid rgba(46,125,50,.25);
    box-shadow: 0 2px 8px rgba(46,125,50,.06);
  }
  .light .act-card:hover { border-color: rgba(46,125,50,.5); box-shadow: 0 4px 16px rgba(46,125,50,.1); }
  .light .act-title { color: #0d1117; }
  .light .act-meta  { color: #3a4a5c; }

  /* ─ Step 13: Badges ─ */
  .light .badge-card {
    background: #fff0f7;
    border: 1.5px solid rgba(212,19,35,.2);
    box-shadow: 0 2px 8px rgba(212,19,35,.05);
  }
  .light .badge-card:hover { border-color: rgba(212,19,35,.45); }
  .light .badge-name { color: #0d1117; }
  .light .badge-pts  { color: #D41323; }

  /* ─ Step 14: Sfida ─ */
  .light .sfida-card {
    background: #fff8f8;
    border: 1.5px solid rgba(198,40,40,.25);
  }
  .light .sfida-label  { color: #c62828; }
  .light .sfida-title  { color: #0d1117; text-shadow: none; }
  .light .sfida-desc   { color: #3a4a5c; }
  .light .sfida-reward { background: rgba(230,81,0,.08); border-color: rgba(230,81,0,.25); color: #D41323; }

  /* ─ Step 15: Modal ─ */
  .light .modal {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.12);
    box-shadow: 0 -16px 48px rgba(0,0,0,.12);
  }
  .light .modal::before { background:#101010; }
  .light .modal-title  { color: #0d1117; }
  .light .section-label { color: #3a4a5c; }
  .light .modal-bg { background: rgba(0,0,0,.45); }

  /* ─ Step 16: Section banner ─ */
  .light .section-banner-title { color: #0d1117 !important; }
  .light .section-banner-sub   { color: rgba(0,0,0,.5) !important; }

  /* ─ Step 17: Misc ─ */
  .light .empty   { color: #6b7e94; }
  .light .loading { color: #6b7e94; }
  .light .batch-panel { background: rgba(16,16,16,.06); border: 1.5px solid rgba(16,16,16,.2); }
  .light .batch-info  { color: #101010; }
  .light .filter-bar .chip { background: #ffffff; }
  .light .squad-row  { background: #ffffff; border: 1.5px solid rgba(0,0,0,.08); }
  .light .squad-name { color: #0d1117; }
  .light .diary-entry { background: #ffffff; border: 1px solid rgba(0,0,0,.07); }
  .light .diary-date  { color: #101010; }
  .light .diary-text  { color: #0d1117; }
  .light .notif-item  { border-bottom: 1px solid rgba(0,0,0,.06); }
  .light .notif-title { color: #0d1117; }
  .light .notif-body  { color: #3a4a5c; }
  .light .notif-time  { color: #6b7e94; }
  .light .notif-dot   { background: #c2185b; }
  .light .player-detail { background: #ffffff; border: 1.5px solid rgba(16,16,16,.2); }
  .light .detail-tab { background: #f5f7ff; border: 1px solid rgba(0,0,0,.1); color: #3a4a5c; }
  .light .detail-tab.active { background: #101010; color: #ffffff; border-color: #101010; }
  .light .color-swatch.active { border-color: #101010; box-shadow: var(--glow-blue); }
  .light .section-banner { box-shadow: none; }
  .light .podium-wrap .pod-name { color: #0d1117; }
  .light .lb-list .lb-row { background: #ffffff; }

  /* ─ Step 18: StreakConfig month cards ─ */
  .light .streak-month-card {
    background: #ffffff !important;
    border-color: rgba(0,0,0,.08) !important;
    box-shadow: 0 2px 8px rgba(0,0,0,.04);
  }
  .light .streak-month-card * { color: #0d1117 !important; }
  .light .streak-month-card div[style*="color:"var(--text3)""] { color: #6b7e94 !important; }

  /* ─ Step 19: Avatar picker ─ */
  .light .av-picker-wrap { background: #f5f7ff; border-radius: 8px; padding: 4px; }
  .light .av-picker-tab {
    background: #ffffff !important;
    color: #3a4a5c !important;
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
  .light .av-picker-item:hover { background: #f0f4ff !important; border-color: rgba(16,16,16,.3) !important; }
  .light .av-picker-item.sel   { border-color: #101010 !important; background: rgba(16,16,16,.06) !important; }
  .light .av-picker-item span  { color: #3a4a5c !important; }

  /* ─ Step 20: Player dashboard light ─ */
  .light .player-wrap { transition: background .4s ease; }
  .light .pd-topbar {
    background: #ffffff !important;
    border-bottom: 2px solid #101010 !important;
  }
  .light .pd-name-pill { background: #0d1428 !important; color: #e0eeff !important; }
  .light .pd-lv-pill {
    background: rgba(16,16,16,.1);
    border-color: rgba(16,16,16,.3);
    color: #101010;
  }
  .light .pd-card {
    background: rgba(255,255,255,.85) !important;
    border: 1px solid rgba(0,0,0,.08) !important;
    color: #0d1117;
  }
  .light .pd-card * { color: #0d1117; }
  .light .pd-sg .pd-sc {
    background: rgba(255,255,255,.9) !important;
    border: 1px solid rgba(0,0,0,.07) !important;
  }
  .light .pd-sv { color: #D41323 !important; }
  .light .pd-sl { color: #6b7e94 !important; }
  .light .pd-squad {
    background: rgba(255,255,255,.85) !important;
    border: 1px solid rgba(0,0,0,.08) !important;
  }
  .light .pd-sfida { background: #0d1428 !important; }
  .light .pd-checkin {
    background: rgba(255,255,255,.85) !important;
    border: 1px solid rgba(46,125,50,.25) !important;
  }
  .light .pd-tab-title { color: #0d1117 !important; }
  .light .pd-badge-item {
    background: rgba(255,255,255,.9) !important;
    border: 1px solid rgba(0,0,0,.07) !important;
  }
  .light .pd-badge-item div { color: #0d1117 !important; }
  .light .streak-card {
    background: rgba(255,255,255,.85) !important;
    border: 1px solid rgba(230,81,0,.25) !important;
  }
  .light .streak-val { color: #D41323 !important; }
  .light .streak-lbl { color: #6b7e94 !important; }
  .light .month-prog-bg   { background: rgba(0,0,0,.08); }
  .light .month-prog-fill { background: linear-gradient(90deg, #D41323, #D41323); }
  .light .xp-bar-wrap { background: rgba(16,16,16,.08); }
  .light .xp-bar { background:#101010; }
  .light .player-bottom-nav {
    background: #ffffff !important;
    border-top: 2px solid #101010 !important;
  }
  .light .player-bottom-nav * { color:#101010 !important; }
  .light .player-nav-btn       { color: rgba(255,255,255,.28) !important; }
  .light .player-nav-btn.active { color: #90caff !important; }
  .light .player-nav-btn.active::after { background: #90caff !important; }

  /* ─ Step 21: Login ─ */
  .light .login-wrap { background: #eef2fb; }
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
  .light .login-sub { color: #6b7e94; }
  .light .login-tabs { background: rgba(0,0,0,.04); border: 1px solid rgba(0,0,0,.08); }
  .light .login-tab  { color: #6b7e94; }
  .light .login-tab.active {
    background: rgba(16,16,16,.08);
    color: #101010;
    border-color: rgba(16,16,16,.3);
    box-shadow: none;
  }
  .light .nickname-list { background: #ffffff; border-color: rgba(0,0,0,.1); }
  .light .nickname-item { color: #0d1117; border-bottom-color: rgba(0,0,0,.06); }
  .light .nickname-item:hover { background: rgba(16,16,16,.04); }
  .light .err-msg { color: #c62828; }
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
  .light .edu-notif-header { color: #0d1117; border-bottom-color: rgba(0,0,0,.08); }
  .light .edu-notif-item:hover { background: rgba(0,0,0,.03); }
  .light .edu-notif-title { color: #0d1117; }
  .light .edu-notif-sub   { color: #6b7e94; }
  .light .edu-notif-count { color: #101010; }
  .light .edu-notif-empty { color: #6b7e94; }

  /* ─ Light mode global fixes ─ */
  .light * { box-sizing: border-box; }
  .light .pd-card { background: rgba(255,255,255,.88) !important; color: #0d1117 !important; }
  .light .pd-card * { color: #0d1117 !important; }
  .light .pd-tab-title { color: #0d1117 !important; }
  .light .search-inp { background:#fff; border:1.5px solid rgba(0,0,0,.18); color:#0d1117; }
  .light .search-inp::placeholder { color:#9e9e9e; }
  .light .form-input::placeholder { color:#9e9e9e; }
  .light textarea { background:#fff; color:#0d1117; border:1.5px solid rgba(0,0,0,.15); }
  .light textarea::placeholder { color:#9e9e9e; }
  .light select option { background:#ffffff; color:#0d1117; }
  .light .empty { color: #6b7e94; }
  .light .loading { color: #6b7e94; }
  /* Sfide always dark bg */
  .light .pd-sfida { background: #1a2035 !important; border-color: rgba(253,239,38,.3) !important; }
  .light .pd-sfida * { color: rgba(255,255,255,.9) !important; }
  /* Streak card */
  .light .streak-card { background: #fff !important; border: 1px solid rgba(230,81,0,.2) !important; }
  .light .streak-card .streak-val { color: #D41323 !important; }
  .light .streak-card .streak-lbl { color: #6b7e94 !important; }
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
  .edu-notif-badge { position:absolute; top:-5px; right:-5px; background:#ff2244; color:#fff; border-radius:99px; font-size:9px; font-weight:900; padding:2px 5px; min-width:16px; text-align:center; line-height:1.3; box-shadow:0 0 6px rgba(255,34,68,.5); }
  .nav-badge { display:inline-flex; align-items:center; justify-content:center; background:#ff2244; color:#fff; border-radius:99px; font-size:8px; font-weight:900; padding:1px 5px; min-width:14px; margin-left:6px; line-height:1.3; }
  .edu-notif-panel { position:fixed; top:56px; right:12px; width:300px; background:rgba(10,5,40,.98); border:1px solid rgba(255,255,255,.12); border-radius:16px; box-shadow:0 8px 32px rgba(0,0,0,.5); z-index:50; overflow:hidden; backdrop-filter:blur(20px); }
  .edu-notif-header { padding:12px 16px; border-bottom:1px solid rgba(255,255,255,.08); font-family:'Funnel Display',sans-serif; font-size:18px; font-weight:900; text-transform:uppercase; color:#fff; letter-spacing:.05em; }
  .edu-notif-item { display:flex; align-items:flex-start; gap:10px; padding:12px 16px; border-bottom:1px solid rgba(255,255,255,.06); cursor:pointer; transition:background .12s; }
  .edu-notif-item:hover { background:rgba(255,255,255,.04); }
  .edu-notif-item:last-child { border-bottom:none; }
  .edu-notif-icon { font-size:22px; flex-shrink:0; }
  .edu-notif-text { flex:1; }
  .edu-notif-title { font-size:13px; font-weight:700; color:#fff; margin-bottom:2px; }
  .edu-notif-sub { font-size:11px; color:rgba(255,255,255,.45); }
  .edu-notif-count { font-family:'Funnel Display',sans-serif; font-size:22px; font-weight:900; color:#FDEF26; flex-shrink:0; }
  .edu-notif-empty { padding:20px 16px; text-align:center; color:rgba(255,255,255,.35); font-size:13px; }
  /* ═══ AVATAR PICKER ═══ */
  .av-picker-wrap { max-height:340px; overflow-y:auto; scrollbar-width:thin; }
  .av-picker-tabs { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:10px; }
  .av-picker-tab { padding:5px 12px; border-radius:99px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.04); color:rgba(255,255,255,.45); font-size:11px; font-weight:700; cursor:pointer; transition:all .15s; }
  .av-picker-tab.on { background:rgba(253,239,38,.15); color:#FDEF26; border-color:rgba(253,239,38,.35); }
  .av-picker-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(64px,1fr)); gap:6px; }
  .av-picker-item { border-radius:10px; padding:5px; text-align:center; cursor:pointer; border:2px solid transparent; background:rgba(255,255,255,.04); transition:all .15s; }
  .av-picker-item:hover { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.15); }
  .av-picker-item.sel { border-color:#FDEF26; background:rgba(253,239,38,.1); }
  .av-picker-item img { width:52px; height:52px; object-fit:contain; display:block; margin:0 auto 3px; }
  .av-picker-item span { font-size:8px; color:rgba(255,255,255,.45); text-transform:capitalize; line-height:1.2; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
  .pres-av-2 { width:clamp(60px,10vw,100px); height:clamp(60px,10vw,100px); border-color:#aac8e0; box-shadow:0 0 20px rgba(170,200,224,.4); }
  .pres-av-3 { width:clamp(50px,8vw,84px); height:clamp(50px,8vw,84px); border-color:#d4916a; box-shadow:0 0 16px rgba(212,145,106,.4); }
  @keyframes glow-gold { 0%,100%{box-shadow:0 0 30px rgba(253,239,38,.6),0 0 80px rgba(253,239,38,.2)} 50%{box-shadow:0 0 60px rgba(253,239,38,.9),0 0 120px rgba(253,239,38,.4)} }
  .pres-pname { font-family:'Funnel Display',sans-serif; font-size:clamp(14px,2.5vw,26px); font-weight:900; text-transform:uppercase; color:#fff; text-align:center; text-shadow:0 0 20px rgba(255,255,255,.3); max-width:clamp(80px,14vw,160px); line-height:1.1; }
  .pres-pxp { font-size:clamp(11px,1.8vw,18px); font-weight:700; text-align:center; margin-top:2px; }
  .pres-base { border-radius:12px 12px 0 0; display:flex; align-items:center; justify-content:center; margin-top:8px; }
  .pres-base-1 { background:rgba(253,239,38,.15); border:2px solid rgba(253,239,38,.4); width:clamp(80px,14vw,130px); height:clamp(70px,12vh,100px); }
  .pres-base-2 { background:rgba(170,200,224,.1); border:2px solid rgba(170,200,224,.3); width:clamp(60px,10vw,100px); height:clamp(50px,9vh,76px); }
  .pres-base-3 { background:rgba(212,145,106,.1); border:2px solid rgba(212,145,106,.25); width:clamp(50px,8vw,84px); height:clamp(36px,7vh,56px); }
  .pres-rank { font-family:'Funnel Display',sans-serif; font-size:clamp(20px,4vw,40px); font-weight:900; }
  .pres-rank-1 { color:#FDEF26; text-shadow:0 0 16px rgba(253,239,38,.8); }
  .pres-rank-2 { color:#aac8e0; }
  .pres-rank-3 { color:#d4916a; }
  .pres-list { display:flex; flex-direction:column; gap:5px; width:100%; max-width:560px; padding:0 16px; max-height:55vh; overflow-y:auto; scrollbar-width:none; }
  .pres-list::-webkit-scrollbar { display:none; }
  .pres-list-row { display:flex; align-items:center; gap:12px; background:rgba(255,255,255,.05); border-radius:10px; padding:10px 14px; animation:fade-in .5s both; }
  @keyframes fade-in { from{opacity:0;transform:translateX(-20px)} to{opacity:1;transform:translateX(0)} }
  .pres-close { position:absolute; top:16px; right:16px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.15); border-radius:10px; padding:8px 14px; color:rgba(255,255,255,.5); font-size:13px; cursor:pointer; font-weight:700; letter-spacing:.05em; z-index:10; }
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
  @keyframes flamePulse { 0%,100%{transform:scale(1);filter:drop-shadow(0 0 4px #ff6b00)} 50%{transform:scale(1.15);filter:drop-shadow(0 0 12px #ff6b00)} }
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
  .pd-topbar { position:fixed; top:0; left:0; right:0; height:56px; background:#0d0d0d; border-bottom:1px solid rgba(255,255,255,.1); z-index:20; display:flex; align-items:center; padding:0 14px; justify-content:space-between; backdrop-filter:blur(20px); }
  .pd-logo-box { background:#cc1111; border-radius:9px 12px 9px 14px; padding:4px 10px; transform:rotate(-1.5deg); box-shadow:2px 3px 0 rgba(0,0,0,.2); }
  .pd-logo-t { font-family:'Funnel Display',sans-serif; font-size:13px; font-weight:900; color:#111; line-height:1.05; text-transform:uppercase; letter-spacing:-.3px; }
  .pd-logo-sub { font-family:'Funnel Display',sans-serif; background:#111; color:#ffe600; font-size:8px; font-weight:900; border-radius:4px; padding:2px 7px; text-transform:uppercase; letter-spacing:.07em; margin-top:2px; display:inline-block; }
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
  .pd-sl { font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.1em; color:rgba(255,255,255,.38); margin-top:2px; display:block; }
  .pd-squad { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(255,255,255,.12); border-radius:12px; padding:11px 14px; display:flex; align-items:center; gap:10px; position:relative; z-index:2; }
  .pd-sfida { margin:0 14px 8px; background:#111; border-radius:16px; padding:14px 16px; position:relative; z-index:2; overflow:hidden; }
  .pd-sfida::after { content:'★'; position:absolute; right:14px; top:50%; transform:translateY(-50%); font-size:44px; color:rgba(255,220,0,.1); line-height:1; }
  .pd-badges { margin:0 14px 8px; position:relative; z-index:2; }
  .pd-badge-row { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; scrollbar-width:none; }
  .pd-badge-row::-webkit-scrollbar { display:none; }
  .pd-badge-item { flex-shrink:0; background:rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:10px 8px; text-align:center; min-width:68px; cursor:pointer; transition:all .2s; }
  .pd-badge-item:hover { border-color:rgba(255,0,204,.4); transform:translateY(-2px); }
  .pd-checkin { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(51,153,102,.2); border-radius:16px; padding:14px; position:relative; z-index:2; }
  .pd-tab-title { font-family:'Funnel Display',sans-serif; font-size:30px; font-weight:900; text-transform:uppercase; letter-spacing:.04em; margin-bottom:14px; position:relative; z-index:2; padding:0 2px; }
  /* override bottom nav for new design */
  .player-bottom-nav { background:#0d0d0d !important; border-top:1px solid #2a2a2a !important; }
  .player-nav-btn { color:rgba(255,255,255,.28) !important; }
  .player-nav-btn.active { color:#FDEF26 !important; }
  .player-nav-btn.active::after { background:#FDEF26 !important; box-shadow:0 0 8px rgba(253,239,38,.5) !important; }
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
        <div className="section-banner-title" style={{ color: cfg.image ? "#fff" : "#101010" }}>{title}</div>
        {sub && <div className="section-banner-sub" style={{ color: cfg.image ? "rgba(255,255,255,.75)" : "rgba(0,0,0,.5)" }}>{sub}</div>}
      </div>
      {onEdit && (
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
        <div style={{color:"#ff4466",fontSize:13,padding:"12px",textAlign:"center",background:"rgba(255,34,68,.08)",borderRadius:10}}>{err}</div>
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
  { id:"happy", label:"😊 Felice!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}.b{animation:bounce .7s ease-in-out infinite}@keyframes blink{0%,90%,100%{scaleY:1}95%{transform:scaleY(0.1)}}</style><g class="b"><ellipse cx="50" cy="70" rx="32" ry="36" fill="#4caf50"/><ellipse cx="28" cy="45" rx="14" ry="7" fill="#388e3c" transform="rotate(-40,28,45)"/><ellipse cx="72" cy="45" rx="14" ry="7" fill="#388e3c" transform="rotate(40,72,45)"/><circle cx="50" cy="32" r="8" fill="#388e3c"/><circle cx="39" cy="65" r="8" fill="white"/><circle cx="61" cy="65" r="8" fill="white"/><circle cx="41" cy="66" r="5" fill="#1a237e"/><circle cx="63" cy="66" r="5" fill="#1a237e"/><circle cx="43" cy="64" r="2" fill="white"/><circle cx="65" cy="64" r="2" fill="white"/><path d="M 36 78 Q 50 92 64 78" stroke="#1b5e20" stroke-width="3.5" fill="none" stroke-linecap="round"/></g></svg>` },
  { id:"thumbsup", label:"👍 Grande!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes pop{0%{transform:scale(1)}30%{transform:scale(1.2)}100%{transform:scale(1)}}.p{animation:pop .6s ease-out infinite}</style><g class="p"><ellipse cx="50" cy="75" rx="28" ry="30" fill="#66bb6a"/><circle cx="50" cy="28" r="7" fill="#388e3c"/><rect x="30" y="35" width="10" height="25" rx="5" fill="#388e3c"/><rect x="60" y="35" width="10" height="25" rx="5" fill="#388e3c"/><rect x="38" y="55" width="24" height="18" rx="4" fill="#4caf50"/><rect x="35" y="45" width="30" height="14" rx="7" fill="#81c784"/><rect x="44" y="38" width="12" height="12" rx="6" fill="#66bb6a"/><circle cx="40" cy="72" r="7" fill="white"/><circle cx="60" cy="72" r="7" fill="white"/><circle cx="42" cy="73" r="4" fill="#1b5e20"/><circle cx="62" cy="73" r="4" fill="#1b5e20"/><path d="M 40 83 Q 50 90 60 83" stroke="#1b5e20" stroke-width="3" fill="none" stroke-linecap="round"/></g></svg>` },
  { id:"thumbsdown", label:"👎 Boh...", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes wilt{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-5deg)}}.w{animation:wilt 1s ease-in-out infinite;transform-origin:50% 80%}</style><g class="w"><ellipse cx="50" cy="65" rx="28" ry="30" fill="#78909c"/><ellipse cx="30" cy="42" rx="12" ry="6" fill="#546e7a" transform="rotate(-20,30,42)"/><ellipse cx="70" cy="42" rx="12" ry="6" fill="#546e7a" transform="rotate(20,70,42)"/><circle cx="50" cy="30" r="7" fill="#546e7a"/><circle cx="40" cy="62" r="7" fill="white"/><circle cx="60" cy="62" r="7" fill="white"/><circle cx="42" cy="63" r="4" fill="#263238"/><circle cx="62" cy="63" r="4" fill="#263238"/><path d="M 38 76 Q 50 70 62 76" stroke="#263238" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="35" y="75" width="30" height="14" rx="7" fill="#607d8b" transform="rotate(180,50,82)"/><rect x="44" y="82" width="12" height="12" rx="6" fill="#78909c" transform="rotate(180,50,88)"/></g></svg>` },
  { id:"kiss", label:"💋 Bacio!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes kiss{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}.k{animation:kiss .8s ease-in-out infinite}@keyframes heart{0%,100%{transform:scale(1) translate(0,0);opacity:1}100%{transform:scale(0) translate(10px,-20px);opacity:0}}.h{animation:heart 1.2s ease-out infinite}</style><g class="k"><ellipse cx="50" cy="68" rx="30" ry="34" fill="#f48fb1"/><ellipse cx="28" cy="44" rx="13" ry="7" fill="#e91e63" transform="rotate(-35,28,44)"/><ellipse cx="72" cy="44" rx="13" ry="7" fill="#e91e63" transform="rotate(35,72,44)"/><circle cx="50" cy="30" r="7" fill="#e91e63"/><circle cx="39" cy="63" r="7" fill="white"/><circle cx="61" cy="63" r="7" fill="white"/><circle cx="41" cy="64" r="4" fill="#880e4f"/><circle cx="63" cy="64" r="4" fill="#880e4f"/><circle cx="50" cy="78" r="7" fill="#e91e63"/><text x="68" y="55" font-size="14" class="h">❤️</text><text x="72" y="45" font-size="10" class="h" style="animation-delay:.4s">💕</text></g></svg>` },
  { id:"heart", label:"❤️ Cuore!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}.p{animation:pulse .6s ease-in-out infinite}</style><g class="p"><ellipse cx="50" cy="68" rx="30" ry="34" fill="#ef5350"/><ellipse cx="28" cy="44" rx="13" ry="7" fill="#b71c1c" transform="rotate(-35,28,44)"/><ellipse cx="72" cy="44" rx="13" ry="7" fill="#b71c1c" transform="rotate(35,72,44)"/><circle cx="50" cy="30" r="7" fill="#b71c1c"/><circle cx="39" cy="63" r="8" fill="white"/><circle cx="61" cy="63" r="8" fill="white"/><circle cx="41" cy="64" r="5" fill="#b71c1c"/><circle cx="63" cy="64" r="5" fill="#b71c1c"/><path d="M 35 77 Q 50 95 65 77" stroke="#7f0000" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M50 40 C45 35 35 35 35 43 C35 50 50 60 50 60 C50 60 65 50 65 43 C65 35 55 35 50 40Z" fill="#ff1744" opacity=".9" transform="translate(0,-10) scale(0.5) translate(50,0)"/></g></svg>` },
  { id:"laugh", label:"😂 Risata!", svg:`<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg"><style>@keyframes shake{0%,100%{transform:rotate(0deg)}25%{transform:rotate(-4deg)}75%{transform:rotate(4deg)}}.s{animation:shake .3s ease-in-out infinite}</style><g class="s"><ellipse cx="50" cy="68" rx="32" ry="36" fill="#ffd54f"/><ellipse cx="28" cy="43" rx="14" ry="7" fill="#f9a825" transform="rotate(-35,28,43)"/><ellipse cx="72" cy="43" rx="14" ry="7" fill="#f9a825" transform="rotate(35,72,43)"/><circle cx="50" cy="30" r="7" fill="#f9a825"/><path d="M 32 60 Q 50 57 68 60" stroke="#D41323" stroke-width="3" fill="none"/><ellipse cx="50" cy="62" rx="18" ry="4" fill="#D41323"/><path d="M 32 62 Q 50 85 68 62" fill="#D41323"/><rect x="38" y="62" width="24" height="8" fill="white" rx="3"/><text x="26" y="58" font-size="14">😂</text><text x="62" y="58" font-size="14">😂</text></g></svg>` },
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
      background:'linear-gradient(90deg,#0a2a1a,#0d3a22)',
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
        ? 'linear-gradient(90deg,#0a2a1a,#0d3a22)'
        : 'linear-gradient(90deg,#2a0a0a,#3a0d0d)',
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
        <div style={{fontSize:12,color:"var(--text3)",marginBottom:16,textAlign:"center"}}>
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
    if (!res?.ok || !res?.profile) { setErr("PIN errato. Riprova."); setPin(""); setLoadingPin(false); return; }
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
              <div style={{width:72,height:72,borderRadius:"50%",overflow:"hidden",border:"3px solid var(--neon-blue)",margin:"0 auto 12px",boxShadow:"var(--glow-blue)"}}>
                <Avatar url={selected.avatar_url} emoji="🌱" size={72}/>
              </div>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:24,fontWeight:900,color:"var(--text)",marginBottom:4}}>{selected.display_name}</div>
              
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
                  ? <div className="empty" style={{padding:16,textAlign:"center"}}>{debouncedSearch.length < 2 ? "✏️ Digita il tuo nome per trovare il profilo" : "Nessun giocatore trovato"}</div>
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
                {pb.badges?.image_url ? <img src={pb.badges.image_url} style={{width:52,height:52,borderRadius:"50%",objectFit:"cover",border:"2px solid var(--rosa)",display:"block",margin:"0 auto 5px"}} alt=""/> : <div style={{fontSize:36,marginBottom:5}}>🎖️</div>}
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
  const xpColors = ["#aac8e0", "#FDEF26", "#d4916a"];
  const sizes = [54, 68, 48];
  const ranks = ["2°", "1°", "3°"];

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
          <div className="pod-av-wrap" style={{background:["#FFD700","#C0C0C0","#CD7F32"][i],padding:7,boxShadow:"0 4px 12px rgba(0,0,0,.35)",...(isMe?{outline:"3px solid #101010",outlineOffset:2}:{})}}>
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
        <div style={{display:"flex",justifyContent:"center",gap:-6,marginBottom:6,flexWrap:"wrap",maxWidth:"100%"}}>
          {players.slice(0, 5).map(p => {
            const lv = getLevel(p.xp);
            const isMe = p.id === highlightId;
            return (
              <div key={p.id} className="pod-av-wrap" style={{marginLeft:-4, ...(isMe?{outline:"2px solid var(--neon-blue)",outlineOffset:1}:{})}}>
                <Avatar url={p.avatar_url} emoji={lv.emoji} size={tieSize}/>
              </div>
            );
          })}
        </div>
        <div className="pod-name" style={{fontSize:11}}>
          {players.length === 2 ? `${players[0].display_name} & ${players[1].display_name}` :
           players.length <= 5 ? `${players.length} a pari merito` :
           `${players.slice(0,5).length} a pari merito (+${players.length-5})`}
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
      <SectionBanner sectionKey="classifica" title="Classifica" sub={`${ranked.length} giocatori`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
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
      <SectionBanner sectionKey="presenze" title="Presenze"
        sub={presTab==="daily" ? `${presentCount}/${visible.length} presenti` : `${labAtts.length} check-in Lab`}
        sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />

      {/* Tab switcher */}
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <button className={`chip ${presTab==="daily"?"active":""}`} onClick={()=>setPresTab("daily")}
          style={presTab==="daily"?{background:"rgba(163,207,254,.15)",color:"var(--neon-blue)",borderColor:"rgba(163,207,254,.4)"}:{}}>
          📍 Giornaliere
        </button>
        <button className={`chip ${presTab==="lab"?"active":""}`} onClick={()=>setPresTab("lab")}
          style={presTab==="lab"?{background:"rgba(253,239,38,.15)",color:"#FDEF26",borderColor:"rgba(253,239,38,.4)"}:{}}>
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
            <div style={{background:"rgba(253,239,38,.06)",border:"1px solid rgba(253,239,38,.25)",borderRadius:12,padding:"12px 14px",marginBottom:12}}>
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
              <div key={labName} style={{marginBottom:14,background:"rgba(253,239,38,.04)",border:"1px solid rgba(253,239,38,.2)",borderRadius:14,padding:"12px 14px"}}>
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
      sb.from("activities").select("id,name,description,link,schedule,duration_days,xp_partial,xp_full,xp_completed,coin_partial,coin_full,coin_completed,coin_cost,is_active,expires_at,max_participants,educator_id").eq("is_active", true).order("created_at", { ascending: false }),
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
      lab_multiplier: a.lab_multiplier ?? 2,
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
        coin_partial:5, coin_full:10, coin_completed:18, coin_cost:0, max_participants:"", lab_multiplier:2 });
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
      <SectionBanner sectionKey="attivita" title="Lab" sub={`${activities.length} attive`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-yellow btn-sm" onClick={() => { setEditingId(null); setShowForm(true); }}>+ Nuovo Lab</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div className="act-grid">
          {activities.map(a => (
            <div key={a.id} className="act-card">
              <button className="delete-btn" onClick={() => deleteActivity(a.id)}>✕</button>
              <div className="act-title">{a.name}</div>
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
                    color: (bookingCounts[a.id]||0) >= a.max_participants ? "#ff4466" : "var(--neon-green)",
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
            <div style={{maxHeight:300,overflowY:"auto",border:"1px solid var(--border)",borderRadius:10,padding:6,marginBottom:12}}>
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
            <div style={{maxHeight:180,overflowY:"auto",border:"1px solid var(--border)",borderRadius:10,padding:6,marginBottom:8}}>
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
      <SectionBanner sectionKey="badge" title="Badge" sub={`${badges.length} badge`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
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
              {badges.find(b => b.id === showAssign)?.image_url ? <img src={badges.find(b => b.id === showAssign).image_url} style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", border: "3px solid var(--rosa)" }} alt="" /> : <span style={{ fontSize: 48 }}>🎖️</span>}
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

function SfidaView({ sectionColors, setSectionColors }) {
  const [sfide, setSfide] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [form, setForm] = useState({ title:"", description:"", link:"", xp_reward:20, coin_reward:10, expires_at:"" });

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
    };
    await sb.from("activities").insert(payload);
    setShowForm(false);
    setForm({ title:"", description:"", link:"", xp_reward:20, coin_reward:10, expires_at:"" });
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
        };
      });
      const allEntries = [
        ...(notifs||[]).filter(n => n.profiles && n.type !== "educator_msg"),
        ...xpEvents
      ].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      setEntries(allEntries); setLoading(false);
    }
    load();
  }, [dateFilter]);

  const typeIcon = { badge_assigned:"🎖️", booking_confirmed:"✅", booking_rejected:"❌", log_action:"📌", presenza:"✅", new_message:"💬", level_up:"🆙", xp_gain:"⭐" };
  const typeColor = { badge_assigned:"var(--rosa)", booking_confirmed:"var(--verde)", booking_rejected:"var(--danger)", presenza:"var(--neon-green)", new_message:"var(--azzurro)", level_up:"var(--neon-gold)", xp_gain:"var(--neon-gold)" };

  return (
    <div>
      <div style={{ fontFamily: "'Funnel Display'", fontSize: 32, fontWeight: 900, textTransform: "uppercase", color: "var(--azzurro)", marginBottom: 16 }}>📜 Diario giornate</div>
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
              background:"rgba(255,255,255,.04)",transition:"all .15s",
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
      sb.from("activities").select("id,name").eq("is_active",true).order("name"),
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
      <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:16}}>💬 Messaggi</div>

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
              {activities.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
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

  useEffect(() => {
    sb.from("daily_qr").select("*").eq("date", today).maybeSingle()
      .then(({ data }) => { setQr(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [today]);

  async function generateQr() {
    setWorking(true);
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    // Validità fissa: 13:00 – 19:00 della giornata
    const vf = new Date(); vf.setHours(13, 0, 0, 0);
    const vu = new Date(); vu.setHours(19, 0, 0, 0);
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
            <div style={{ fontSize:13, color:"var(--text2)", marginBottom:4 }}>Valido dalle 13:00 alle 19:00</div>
            <div style={{ fontSize:11, color: isWithinWindow ? "var(--verde)" : "var(--text3)", marginBottom:16, fontWeight:700 }}>
              {isWithinWindow ? "● Attivo ora" : beforeWindow ? "Si attiva alle 13:00" : "Finestra oraria conclusa"}
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
        <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"var(--text)"}}>📢 Bacheca Annunci</div>
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
  if (loading) return <div className="loading">⏳</div>;
  if (announcements.length===0) return <div className="empty" style={{padding:24}}>Nessun annuncio.</div>;
  return (
    <div>
      <div className="pd-tab-title">📢 Bacheca Annunci</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {announcements.map(a=>(
          <div key={a.id} className="pd-card" style={{padding:14,border:a.pinned?"1.5px solid rgba(253,239,38,.4)":""}}>
            {a.pinned&&<div style={{fontSize:11,color:"#FDEF26",fontWeight:700,marginBottom:4}}>📌 In evidenza</div>}
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              {a.profiles?.avatar_url
                ? <img src={a.profiles.avatar_url} style={{width:28,height:28,borderRadius:"50%",objectFit:"cover"}} alt=""/>
                : <span style={{fontSize:18}}>🌱</span>}
              <div>
                <div style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>{a.profiles?.display_name||"Giardiniere"}</div>
                <div style={{fontSize:9,color:"var(--text3)"}}>{new Date(a.created_at).toLocaleDateString("it-IT",{day:"numeric",month:"long"})}</div>
              </div>
            </div>
            <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:18,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:6}}>{a.title}</div>
            {a.body&&<div style={{fontSize:13,color:"var(--text2)",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{a.body}</div>}
            {a.image_data&&<img src={a.image_data} style={{width:"100%",borderRadius:10,marginTop:8,maxHeight:260,objectFit:"cover"}} alt=""/>}
          </div>
        ))}
      </div>
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
      <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:4}}>📌 Bacheca Team</div>
      <div style={{fontSize:12,color:"var(--text3)",marginBottom:14}}>Post-it visibili solo ai giardinieri.</div>

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
              <div style={{position:"absolute",top:-6,left:"50%",transform:"translateX(-50%)",width:12,height:12,borderRadius:"50%",background:"rgba(0,0,0,.3)",boxShadow:"0 2px 4px rgba(0,0,0,.3)"}}/>
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

  function toggle(key) {
    const next = { ...vis, [key]: vis[key] === false ? true : false };
    setVis(next);
    localStorage.setItem("pug_visibility", JSON.stringify(next));
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
  ];
  const allVisible = sections.every(s => vis[s.key] !== false);
  return (
    <div>
      <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:4}}>👁️ Visibilità player</div>
      <div style={{fontSize:12,color:"var(--text3)",marginBottom:16}}>Controlla cosa vedono i giocatori nel loro profilo. Le modifiche sono immediate.</div>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        <button className="btn btn-ghost btn-sm" onClick={()=>{const all={}; sections.forEach(s=>all[s.key]=true); setVis(all); localStorage.setItem("pug_visibility",JSON.stringify(all));}}>✅ Mostra tutto</button>
        <button className="btn btn-ghost btn-sm" onClick={()=>{const all={}; sections.forEach(s=>all[s.key]=false); setVis(all); localStorage.setItem("pug_visibility",JSON.stringify(all));}}>🙈 Nascondi tutto</button>
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
        💡 Le modifiche locali sono immediate. Clicca "Salva" per renderle permanenti e condividerle su tutti i dispositivi.
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
      <div style={{fontFamily:"'Funnel Display'",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:16}}>🔥 Streak & Badge Mensili</div>
      <div style={{background:"rgba(255,120,0,.06)",border:"1px solid rgba(255,120,0,.2)",borderRadius:14,padding:"12px 16px",marginBottom:16,fontSize:13,color:"var(--text2)",lineHeight:1.5}}>
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
              <div key={m.month} className="streak-month-card" style={{background:"rgba(8,18,40,0.9)",border:`1px solid ${isCurrent?"rgba(212,19,35,.3)":isPast?"rgba(51,153,102,.15)":"var(--border)"}`,borderRadius:14,padding:"12px 16px"}}>
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
    sb.from("profiles").select("id,display_name,avatar_url,xp,squad_id,squads(name)")
      .eq("role","player").order("xp",{ascending:false})
      .then(({data})=>setPlayers(data||[]));
  }, []);

  return (
    <div>
      <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:12}}>🌍 Social</div>
      <div style={{display:"flex",background:"rgba(255,255,255,.06)",borderRadius:12,padding:4,marginBottom:16,gap:4}}>
        {[["community","👥 Community"],["annunci","📢 Annunci"]].map(([v,l])=>(
          <button key={v} onClick={()=>setView(v)} style={{
            flex:1,padding:"10px 0",borderRadius:9,border:"none",cursor:"pointer",
            fontFamily:"'Funnel Display',sans-serif",fontWeight:900,fontSize:15,
            textTransform:"uppercase",letterSpacing:".05em",transition:"all .2s",
            background:view===v?"rgba(255,255,255,.12)":"transparent",
            color:view===v?"var(--text)":"var(--text3)",
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
      {/* Toggle */}
      <div style={{display:"flex",background:"rgba(255,255,255,.06)",borderRadius:12,padding:4,marginBottom:14,gap:4}}>
        {[["annunci","📢 Annunci"],["community","👥 Community"]].map(([v,l])=>(
          <button key={v} onClick={()=>setView(v)} style={{
            flex:1,padding:"10px 0",borderRadius:9,border:"none",cursor:"pointer",
            fontFamily:"'Funnel Display',sans-serif",fontWeight:900,fontSize:15,
            textTransform:"uppercase",letterSpacing:".05em",transition:"all .2s",
            background:view===v?"rgba(255,255,255,.12)":"transparent",
            color:view===v?"var(--text)":"var(--text3)",
          }}>{l}</button>
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
      <div style={{display:"flex",gap:4,marginTop:6,opacity:0.4}}>
        {EMOJIS.map(e=>(
          <button key={e} onClick={()=>react(e)}
            style={{background:"none",border:"none",fontSize:14,cursor:"pointer",padding:"2px 4px",borderRadius:6}}>
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
function ProfileReactions({ targetId, myId }) {
  const REACTS = ["❤️","🔥","👏","🤩","💪"];
  const [counts, setCounts] = useState({});
  const [mine, setMine] = useState(null);

  useEffect(() => {
    sb.from("reactions").select("type").eq("target_player_id", targetId).is("badge_id", null)
      .then(({ data }) => {
        const c = {};
        (data||[]).forEach(r => { c[r.type] = (c[r.type]||0)+1; });
        setCounts(c);
      });
    sb.from("reactions").select("type").eq("player_id", myId).eq("target_player_id", targetId).is("badge_id", null).maybeSingle()
      .then(({ data }) => { if (data) setMine(data.type); })
      .catch(()=>{});
  }, [targetId, myId]);

  async function react(type) {
    if (mine === type) {
      await sb.from("reactions").delete().eq("player_id", myId).eq("target_player_id", targetId).is("badge_id", null);
      setCounts(p => ({...p, [type]: Math.max(0,(p[type]||1)-1)}));
      setMine(null);
    } else {
      // Delete existing profile reaction first (NULL badge_id)
      await sb.from("reactions").delete().eq("player_id", myId).eq("target_player_id", targetId).is("badge_id", null);
      await sb.from("reactions").insert({ player_id:myId, target_player_id:targetId, badge_id:null, type });
      if (mine) setCounts(p => ({...p, [mine]: Math.max(0,(p[mine]||1)-1)}));
      setCounts(p => ({...p, [type]: (p[type]||0)+1}));
      setMine(type);
      playPixel("msg");
      if(navigator.vibrate) navigator.vibrate(30);
    }
  }

  const total = Object.values(counts).reduce((a,b)=>a+b,0);

  return (
    <div style={{marginTop:12}}>
      <div style={{fontSize:10,color:"var(--text3)",marginBottom:8,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700}}>
        {total > 0 ? `${total} reaction` : "Manda una reaction!"}
      </div>
      <div style={{display:"flex",justifyContent:"center",gap:8,flexWrap:"wrap"}}>
        {REACTS.map(r => {
          const count = counts[r]||0;
          const isMe = mine===r;
          return (
            <button key={r} onClick={()=>react(r)}
              style={{
                padding:"8px 14px",borderRadius:99,cursor:"pointer",
                border:`2px solid ${isMe?"var(--neon-blue)":"var(--border)"}`,
                background:isMe?"rgba(163,207,254,.15)":"rgba(255,255,255,.04)",
                fontSize:20,display:"flex",alignItems:"center",gap:6,
                transform:isMe?"scale(1.1)":"scale(1)",
                transition:"all .15s",
                boxShadow:isMe?"var(--glow-blue)":"none",
              }}>
              {r}
              {count>0 && <span style={{fontSize:12,fontWeight:700,color:isMe?"var(--neon-blue)":"var(--text3)"}}>{count}</span>}
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
    .filter(p=>p.id!==myId && (p.xp||0)>=0)
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
        <button onClick={()=>setSelected(null)} style={{display:"flex",alignItems:"center",gap:6,background:"rgba(255,255,255,.06)",border:"1px solid var(--border)",borderRadius:99,padding:"6px 14px",cursor:"pointer",color:"var(--text2)",fontSize:13,marginBottom:14,fontWeight:700}}>
          ← Torna alla community
        </button>

        {/* Player hero */}
        <div style={{background:"linear-gradient(160deg,rgba(255,255,255,.04),rgba(255,255,255,.02))",border:"1px solid var(--border)",borderRadius:20,padding:20,marginBottom:14,textAlign:"center"}}>
          <div style={{width:80,height:80,borderRadius:"50%",overflow:"hidden",border:"3px solid var(--neon-blue)",margin:"0 auto 10px",boxShadow:"var(--glow-blue)"}}>
            <Avatar url={selected.avatar_url} emoji={lv.emoji} size={80}/>
          </div>
          <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:26,fontWeight:900,color:"var(--text)",textTransform:"uppercase"}}>{selected.display_name}</div>
          <div style={{fontSize:13,color:"var(--text3)",marginBottom:10}}>{lv.emoji} {lv.name} · ⭐ {selected.xp} XP</div>
          {selected.squads?.name && <div style={{display:"inline-block",background:"rgba(255,255,255,.06)",borderRadius:99,padding:"3px 12px",fontSize:11,color:"var(--text2)",fontWeight:700,marginBottom:10}}>🛡️ {selected.squads.name}</div>}
          {/* Profile reactions */}
          <ProfileReactions targetId={selected.id} myId={myId}/>
        </div>

        {loadingProfile ? <div className="loading">⏳</div> : (
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"var(--text2)",marginBottom:8,textTransform:"uppercase",letterSpacing:".05em"}}>🎖️ Badge — reagisci!</div>
            {playerBadges.length===0
              ? <div className="empty">Nessun badge ancora.</div>
              : <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {playerBadges.map(pb=>{
                    const rxns = reactions[pb.id]||{};
                    const myR = myReactions[pb.id];
                    const total = Object.values(rxns).reduce((a,b)=>a+b,0);
                    return (
                      <div key={pb.id} style={{background:"rgba(255,255,255,.03)",border:"1px solid var(--border)",borderRadius:14,padding:"12px 14px"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                          <span style={{fontSize:32}}>{pb.badges?.icon||"🎖️"}</span>
                          <div>
                            <div style={{fontSize:14,fontWeight:700,color:"var(--text)"}}>{pb.badges?.name}</div>
                            <div style={{fontSize:10,color:"var(--text3)"}}>{new Date(pb.created_at).toLocaleDateString("it-IT",{day:"numeric",month:"short",year:"numeric"})}</div>
                          </div>
                          {total > 0 && <div style={{marginLeft:"auto",fontSize:11,color:"var(--text3)"}}>{total} reaction</div>}
                        </div>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                          {REACT_TYPES.map(r=>{
                            const count = rxns[r]||0;
                            const isMe = myR===r;
                            return (
                              <button key={r} onClick={()=>react(pb.id,r)}
                                style={{padding:"5px 10px",borderRadius:99,
                                  border:`1.5px solid ${isMe?"var(--neon-blue)":"var(--border)"}`,
                                  background:isMe?"rgba(163,207,254,.15)":"rgba(255,255,255,.04)",
                                  cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",gap:5,
                                  transform:isMe?"scale(1.1)":"scale(1)",transition:"all .15s",
                                }}>
                                {r}
                                {count>0&&<span style={{fontSize:11,fontWeight:700,color:isMe?"var(--neon-blue)":"var(--text3)"}}>{count}</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
            }
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="pd-tab-title">👥 Community</div>
      <input className="search-inp" placeholder="🔍 Cerca giocatore…" value={search}
        onChange={e=>setSearch(e.target.value)} style={{marginBottom:12}}/>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {others.length===0
          ? <div className="empty" style={{padding:32,textAlign:"center"}}>
                  <div style={{fontSize:36,marginBottom:8}}>🌱</div>
                  <div style={{fontWeight:700,marginBottom:4}}>Nessun giocatore</div>
                  <div style={{fontSize:12}}>Prova a cambiare la ricerca</div>
                </div>
          : others.map((p,i)=>{
              const lv = getLevel(p.xp||0);
              const rankColors = ["#FFD700","#C0C0C0","#CD7F32"];
              return (
                <div key={p.id} onClick={()=>openPlayer(p)}
                  style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                    background:"rgba(255,255,255,.03)",border:"1px solid var(--border)",borderRadius:14,
                    cursor:"pointer",transition:"all .15s",position:"relative"}}
                  onMouseOver={e=>{e.currentTarget.style.background="rgba(163,207,254,.06)";e.currentTarget.style.borderColor="rgba(163,207,254,.3)";}}
                  onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,.03)";e.currentTarget.style.borderColor="var(--border)";}}>
                  {i<3 && <div style={{position:"absolute",top:8,right:10,fontSize:16}}>{["🥇","🥈","🥉"][i]}</div>}
                  <div style={{width:46,height:46,borderRadius:"50%",overflow:"hidden",border:`2px solid ${i<3?rankColors[i]:"var(--border2)"}`,flexShrink:0,boxShadow:i===0?"0 0 12px rgba(253,239,38,.4)":"none"}}>
                    <Avatar url={p.avatar_url} emoji={lv.emoji} size={46}/>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.display_name}</div>
                    <div style={{fontSize:11,color:"var(--text3)"}}>{lv.emoji} {lv.name} · ⭐ {p.xp} XP</div>
                  </div>
                  <div style={{fontSize:12,color:"var(--text3)",flexShrink:0}}>→</div>
                </div>
              );
          })
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
              background:d.xp>0?"linear-gradient(180deg,var(--neon-blue),rgba(163,207,254,.4))":"rgba(255,255,255,.06)",
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
            background:"linear-gradient(135deg,var(--neon-blue),var(--azzurro))",
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
      background:"rgba(10,20,40,.97)",
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
      <div style={{background:"linear-gradient(135deg,#0d1428,#1a2540)",border:"2px solid rgba(253,239,38,.5)",borderRadius:28,padding:"40px 48px",textAlign:"center",animation:"lvlpop .6s cubic-bezier(.34,1.56,.64,1) forwards",position:"relative",overflow:"hidden",maxWidth:340,width:"90%",boxShadow:"0 0 60px rgba(253,239,38,.25)"}}>
        <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,background:"linear-gradient(105deg,transparent 40%,rgba(255,255,255,.1) 50%,transparent 60%)",animation:"lvlshine 2.5s .6s ease-in-out infinite"}}/>
        <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:11,fontWeight:900,textTransform:"uppercase",letterSpacing:".2em",color:"rgba(255,255,255,.4)",marginBottom:8}}>🌿 SEI CRESCIUTO! 🌿</div>
        <div style={{fontSize:76,lineHeight:1,marginBottom:10,filter:"drop-shadow(0 0 16px rgba(253,239,38,.5))"}}>{newLevel.emoji}</div>
        <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:34,fontWeight:900,textTransform:"uppercase",background:"linear-gradient(135deg,#FDEF26,#D41323)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:6}}>{newLevel.name}</div>
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
      {/* Nome livello centrato, % a destra */}
      <div style={{position:'relative',display:'flex',justifyContent:'center',alignItems:'center',gap:8,marginBottom:7}}>
        <span style={{fontSize:26,lineHeight:1,filter:'drop-shadow(0 0 6px rgba(255,109,236,.6))'}}>{lv.emoji}</span>
        <span style={{fontFamily:"'Funnel Display',sans-serif",fontSize:22,fontWeight:900,textTransform:'uppercase',letterSpacing:'.03em',lineHeight:1}}>{lv.name}</span>
        <div style={{position:'absolute',right:0,fontFamily:"'Funnel Display',sans-serif",fontSize:24,fontWeight:900,lineHeight:.9,color:bump?'#FF6DEC':'#FF6DEC',transition:'color .3s ease'}}>
          {shownPct}<span style={{fontSize:14}}>%</span>
        </div>
      </div>

      {/* LA BARRA — spessa, bordata, con strisce diagonali animate */}
      <div style={{
        height:22, background:'rgba(0,0,0,.45)', borderRadius:12, overflow:'hidden', position:'relative',
        border:'2px solid rgba(255,255,255,.12)',
        boxShadow: bump ? '0 0 22px rgba(255,109,236,.6), inset 0 2px 6px rgba(0,0,0,.5)' : 'inset 0 2px 6px rgba(0,0,0,.5)',
        transform: bump ? 'scale(1.02)' : 'scale(1)', transition:'transform .25s ease, box-shadow .3s ease',
      }}>
        <div style={{
          height:'100%', width:width+'%', borderRadius:9, position:'relative', overflow:'hidden',
          background:'linear-gradient(90deg,#339966,#FDEF26 50%,#FF6DEC)',
          boxShadow:'0 0 16px rgba(255,109,236,.7)',
          transition:'width 1.1s cubic-bezier(.22,1.5,.4,1)',
        }}>
          {/* Strisce diagonali che scorrono (effetto caricamento da gioco) */}
          <div style={{position:'absolute',inset:0,backgroundImage:'repeating-linear-gradient(45deg,rgba(255,255,255,.18) 0,rgba(255,255,255,.18) 10px,transparent 10px,transparent 20px)',backgroundSize:'28px 28px',animation:'barStripes .7s linear infinite'}}/>
          {/* Riflesso lucido in alto */}
          <div style={{position:'absolute',top:0,left:0,right:0,height:'45%',background:'linear-gradient(180deg,rgba(255,255,255,.35),transparent)',borderRadius:'9px 9px 0 0'}}/>
        </div>
      </div>

      {/* Numeri XP grossi sotto la barra */}
      <div style={{display:'flex',justifyContent:'space-between',marginTop:6,fontFamily:"'Funnel Display',sans-serif",fontWeight:800,fontSize:13}}>
        <span style={{color:'#FDEF26'}}>{xp} XP</span>
        <span style={{color:'rgba(255,255,255,.4)'}}>{nextLv?.xp || 'MAX'} XP</span>
      </div>

      {nextLv ? (
        <div className="hand xp-missing-card">
          mancano {remaining} xp a {nextLv.name}
        </div>
      ) : (
        <div style={{fontSize:13,color:'#FDEF26',marginTop:6,fontWeight:900,textAlign:'center'}}>🏆 LIVELLO MASSIMO!</div>
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
    fetchVisibilityConfig()
      .then((cfg) => {
        if (cfg && typeof cfg === "object") {
          localStorage.setItem("pug_visibility", JSON.stringify(cfg));
          setVisConfig(cfg);
        }
      })
      .catch(() => {})
      .finally(() => setVisReady(true));
  }, []);
  const [editingFirstName, setEditingFirstName] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [lbTimeFilter, setLbTimeFilter] = useState("generale");
  const [selectedBadge, setSelectedBadge] = useState(null);
  const [mustChangePin, setMustChangePin] = useState(profile._mustChangePin === true || profile.pin === "1234");
  const [playerTheme, setPlayerTheme] = useState(() => localStorage.getItem("pug_theme") || "dark");

  useEffect(() => {
    document.body.classList.toggle("light", playerTheme === "light");
    localStorage.setItem("pug_theme", playerTheme);
  }, [playerTheme]);
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
      sb.from("activities").select("id,name,description,link,duration_days,xp_partial,xp_full,xp_completed,coin_partial,coin_full,coin_completed,coin_cost,is_active,expires_at,max_participants,educator_id,created_by").eq("is_active", true).order("created_at", { ascending: false }),
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
    if (res?.error === "too_early") { setQrMsg("⏰ Il check-in apre alle 13:00."); return; }
    if (res?.error === "too_late") { setQrMsg("⏰ Il check-in è chiuso (orario 13–19)."); return; }
    if (res?.error || !res?.type) { setQrMsg("❌ Errore. Riprova."); return; }

    if (res.type === "lab") {
      setFullProfile(prev => ({ ...prev, xp: res.new_xp, coin: res.new_coin }));
      setQrInput("");
      if (res.completed) {
        setQrMsg(`🎉 LAB COMPLETATO "${res.name}"! Bonus ×→ +${res.bonus_xp} XP, +${res.bonus_coin} 🪙`);
        setQrCelebration({ xpGained: res.xp + (res.bonus_xp||0), playerName: fullProfile?.display_name||"", special: true });
      } else {
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
        (edus||[]).forEach(e => sendPush(e.id, "📋 Nuova prenotazione", `${fullProfile?.display_name||"Un giocatore"} ha prenotato un Lab`).catch(()=>{}));
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
    <div style={{background:'linear-gradient(160deg,#1e1060 0%,#1a3590 45%,#2a1275 100%)',minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{background:'rgba(0,0,20,.7)',border:'1px solid rgba(255,255,255,.15)',borderRadius:20,padding:'32px 24px',width:'100%',maxWidth:360,backdropFilter:'blur(20px)'}}>
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
        {pinChangeErr && <div style={{color:'#ff4466',fontSize:12,fontWeight:700,textAlign:'center',marginBottom:10}}>{pinChangeErr}</div>}
        <button className="btn btn-primary" onClick={saveNewPin} disabled={newPin1.length<4||newPin2.length<4}>Salva PIN</button>
      </div>
    </div>
  );

  if (loading) return (
    <div style={{background:'linear-gradient(160deg,#1e1060 0%,#1a3590 45%,#2a1275 100%)',minHeight:'100vh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16}}>
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
    classifica: '#FDEF26',
    attivita:   '#339966',
    bigtop:     '#D41323',
    messaggi:   '#FF6DEC',
    notifiche:  '#A3CFFE',
  };
  const NIGHT_BG = '#000';

    return (
    <div className="player-wrap" style={{background: playerTheme === "light" ? (TAB_BG[tab]||TAB_BG.profilo) : NIGHT_BG, transition:'background 0.5s ease'}}>
      <div className="bg-doodles"/>
      {/* Toast notification */}
      {toast && (
        <div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",zIndex:100,background:"rgba(0,0,0,.9)",border:`1px solid ${toast.color}`,borderRadius:12,padding:"10px 20px",fontSize:14,fontWeight:700,color:toast.color,boxShadow:`0 0 20px ${toast.color}44`,whiteSpace:"nowrap",backdropFilter:"blur(10px)"}}>
          {toast.msg}
        </div>
      )}
      {/* Floral background */}
      <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:0,opacity:.07,overflow:'hidden'}}>
        <svg viewBox="0 0 380 700" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" style={{animation:"float2 15s ease-in-out infinite"}} style={{width:'100%',height:'100%'}}>
          <defs>
            <g id="fl"><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(0)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(60)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(120)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(180)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(240)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(300)"/><circle cx="0" cy="0" r="4" fill="white"/></g>
            <g id="lf"><ellipse cx="0" cy="-14" rx="4" ry="12" fill="white" transform="rotate(20)"/><ellipse cx="0" cy="-14" rx="4" ry="12" fill="white" transform="rotate(-20)"/></g>
          </defs>
          <use href="#fl" transform="translate(40,60) scale(1.2)"/><use href="#lf" transform="translate(90,130)"/><use href="#fl" transform="translate(320,80) scale(.9)"/><use href="#lf" transform="translate(280,170) scale(1.1)"/><use href="#fl" transform="translate(55,260) scale(.8)"/><use href="#lf" transform="translate(340,310)"/><use href="#fl" transform="translate(170,360) scale(1.3)"/><use href="#lf" transform="translate(45,430) scale(1.2)"/><use href="#fl" transform="translate(305,450) scale(.9)"/><use href="#lf" transform="translate(200,510)"/><use href="#fl" transform="translate(75,570) scale(1.1)"/><use href="#lf" transform="translate(335,595) scale(.8)"/><use href="#fl" transform="translate(185,640) scale(.9)"/><use href="#lf" transform="translate(115,690) scale(1.2)"/>
        </svg>
      </div>

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
            <div style={{background:'#111',color:'#FDEF26',fontSize:10,fontWeight:900,borderRadius:8,padding:'5px 10px',textTransform:'uppercase',letterSpacing:'.05em'}}>⚡ {fullProfile.squads.name}</div>
          )}
          <button onClick={()=>setPlayerTheme(t=>t==="dark"?"light":"dark")} style={{background:'rgba(255,255,255,.08)',border:'1px solid rgba(255,255,255,.15)',borderRadius:8,padding:'5px 9px',cursor:'pointer',fontSize:14,lineHeight:1}} title="Cambia tema">
            {playerTheme==="dark"?"☀️":"🌙"}
          </button>
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
            <div className="pd-av-zone">
              <div className="pd-av-glow"/>
              {fullProfile.avatar_url
                ? <img src={fullProfile.avatar_url} className="pd-av-img" alt="avatar" style={{animation:"breathe 3.5s ease-in-out infinite"}}/>
                : <span className="pd-av-emoji" style={{animation:"breathe 3.5s ease-in-out infinite",display:"block"}}>{lv.emoji}</span>
              }
              <div className="pd-name-pill">{fullProfile.display_name}</div>

            </div>

            {/* Profile card: thumbnail + nome editabile + XP */}
            <div className="pd-card">
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                <div style={{width:52,height:52,borderRadius:10,border:'2px solid rgba(253,239,38,.6)',overflow:'hidden',flexShrink:0,background:'rgba(0,0,0,.3)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <Avatar url={fullProfile.avatar_url} emoji={lv.emoji} size={52}/>
                </div>
                <div style={{flex:1}}>
                  <div className="hand pd-first-hand" style={{fontSize:26,lineHeight:1.1,marginBottom:3,cursor:'pointer'}}
                    onClick={()=>{setNewFirstName(fullProfile.first_name||'');setEditingFirstName(true);}}>
                    {fullProfile.first_name || 'scrivi il tuo nome'} <span style={{fontSize:15,opacity:.65}}>✏️</span>
                  </div>
                  {visConfig.squadre !== false && fullProfile.squads?.name && <SquadPill name={fullProfile.squads.name}/>}
                </div>
              </div>
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
                    <div style={{height:"100%",width:`${pct}%`,borderRadius:99,background:pct>=100?"var(--neon-green)":"linear-gradient(90deg,var(--neon-blue),var(--azzurro))",transition:"width .5s ease"}}/>
                  </div>
                  {pct>=100 && <div style={{fontSize:11,color:"var(--neon-green)",marginTop:4,fontWeight:700}}>🏆 Obiettivo raggiunto!</div>}
                </div>
              ) : null;
            })()}
            {editingFirstName ? (
                <div style={{display:'flex',gap:8,marginBottom:8}}>
                  <input className="form-input" value={newFirstName} onChange={e=>setNewFirstName(e.target.value.slice(0,30))} placeholder="Il tuo nome…" style={{flex:1}} maxLength={30} autoFocus/>
                  <button className="btn btn-yellow btn-sm" onClick={saveFirstName} disabled={!newFirstName.trim()}>Salva</button>
                  <button className="btn btn-ghost btn-sm" onClick={()=>setEditingFirstName(false)}>✕</button>
                </div>
              ) : null}
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
                      <span style={{fontSize:18,display:'block',marginBottom:3}}>{ic}</span>
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
                <div key={l} className="pd-sc"><span style={{fontSize:18,display:'block',marginBottom:3}}>{ic}</span><span className="pd-sv">{v}</span><span className="pd-sl">{l}</span></div>
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
                <div style={{fontSize:9,fontWeight:900,textTransform:'uppercase',letterSpacing:'.1em',color:'rgba(255,255,255,.35)',textAlign:'center',marginBottom:6}}>— Badge —</div>
                <div className="pd-badge-row">
                  {badges.map(pb=>(
                    <div key={pb.id} className="pd-badge-item" onClick={()=>setSelectedBadge(pb)}>
                      {pb.badges?.image_url?<img src={pb.badges.image_url} style={{width:36,height:36,borderRadius:'50%',objectFit:'cover',border:'2px solid rgba(255,0,204,.4)',display:'block',margin:'0 auto 5px'}} alt=""/>:<div style={{fontSize:28,marginBottom:5}}>🎖️</div>}
                      <div style={{fontSize:9,fontWeight:700,color:'rgba(255,255,255,.65)',lineHeight:1.3}}>{pb.badges?.name}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
              <div style={{padding:'0 0 8px'}}>
                <div style={{fontSize:10,fontWeight:900,textTransform:'uppercase',letterSpacing:'.08em',color:'rgba(255,255,255,.3)',marginBottom:8,paddingLeft:2}}>Prenotazioni</div>
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
            <div className="pd-tab-title" style={{color:"#A3CFFE"}}>🏆 Classifica</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
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
                      <div className="lb-level">{plv.emoji} {plv.name} {p.squads?.name && <SquadPill name={p.squads.name} />}</div>
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
            <div className="pd-tab-title" style={{color:"#339966"}}>⚡ Lab</div>
            {/* Lab QR check-in */}
            <div style={{background:"rgba(0,0,0,.4)",border:"1px solid rgba(51,153,102,.2)",borderRadius:14,padding:12,marginBottom:12,position:"relative",zIndex:2}}>
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
                      color: (actBookingCounts[a.id]||0) >= a.max_participants ? "#ff4466" : "var(--neon-green)",
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
            <div className="pd-tab-title" style={{color:"#FF6DEC"}}>💬 Messaggi</div>
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
                            <div style={{fontSize:12,fontWeight:700,color:"var(--verde)",lineHeight:1}}>{m.profiles?.display_name||"Giardiniere"}</div>
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
            <SocialTab players={players} myId={profile.id} myProfile={fullProfile}/>
          </div>
        )}
        {tab === "notifiche" && (
          <div style={{ marginTop: 8 }}>
            <NotificheTab profile={profile} />
            <div style={{height:1,background:"var(--border)",margin:"20px 0 14px"}}/>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <div className="pd-tab-title" style={{color:"#FDEF26",marginBottom:0}}>🔔 Notifiche</div>
            {notifications.length > 0 && (
              <button onClick={async()=>{
                await sb.from("notifications").delete().eq("user_id",profile.id);
                setNotifications([]);
              }} style={{background:"rgba(255,34,68,.12)",border:"1px solid rgba(255,34,68,.3)",borderRadius:8,padding:"6px 12px",color:"#ff4466",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                🗑️ Cancella tutte
              </button>
            )}
          </div>
            {notifications.length === 0 ? <div className="empty">Nessuna notifica.</div> : notifications.map(n => {
              const icons = { badge_assigned: "🎖️", booking_confirmed: "✅", booking_rejected: "❌", new_activity: "⚡", level_up: "🆙", new_message: "💬" };
              return (
                <div key={n.id} className="notif-item">
                  <div className="notif-icon">{icons[n.type] || "🔔"}</div>
                  <div style={{ flex: 1 }}>
                    <div className="notif-title">{n.title}{!n.read_at && <span className="notif-dot" />}</div>
                    <div className="notif-body">{n.body}</div>
                    <div className="notif-time">{new Date(n.created_at).toLocaleDateString("it-IT")}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>{/* end pd-scroll */}

      {/* Badge detail modal */}
      {selectedBadge && (
        <div className="modal-bg" onClick={() => setSelectedBadge(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              {selectedBadge.badges?.image_url ? <img src={selectedBadge.badges.image_url} style={{ width: 80, height: 80, borderRadius: "50%", objectFit: "cover", border: "3px solid var(--rosa)", margin: "0 auto 10px", display: "block" }} alt="" /> : <div style={{ fontSize: 56, marginBottom: 10 }}>🎖️</div>}
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
                <div style={{fontSize:12,fontWeight:900,color:["#FDEF26","#aac8e0","#d4916a"][i]||"var(--text3)",width:18,textAlign:"center"}}>{i+1}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--text)",marginBottom:2}}>{p.display_name||"—"}</div>
                  <div style={{height:4,background:"rgba(255,255,255,.06)",borderRadius:99,overflow:"hidden"}}>
                    <div style={{height:"100%",background:"linear-gradient(90deg,var(--neon-blue),var(--neon-pink))",borderRadius:99,width:Math.round((p.xp/maxXp)*100)+"%"}}/>
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
      <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"#D41323",marginBottom:4}}>🧹 Pulizia account</div>
      <div style={{fontSize:12,color:"var(--text3)",marginBottom:16}}>Seleziona un giocatore per vedere e gestire notifiche e prenotazioni</div>

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
      {resetTarget && (
        <div className="modal-bg" onClick={()=>setResetTarget(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <AdminResetPwdForm educator={resetTarget} onClose={()=>setResetTarget(null)}/>
          </div>
        </div>
      )}
      <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"#FDEF26",marginBottom:16}}>⚙️ Gestione Giardinieri</div>

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
      <div className="pd-tab-title" style={{color:"#D41323"}}>🎪 BIG TOP</div>

      {/* Check-in col codice */}
      <div style={{background:"rgba(0,0,0,.4)",border:"1px solid rgba(212,19,35,.25)",borderRadius:14,padding:12,marginBottom:12}}>
        <div style={{fontSize:9,fontWeight:900,textTransform:"uppercase",letterSpacing:".12em",color:"#D41323",marginBottom:8}}>📍 Check-in BIG TOP — inserisci il codice del turno</div>
        <div style={{display:"flex",gap:8}}>
          <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="CODICE"
            maxLength={8}
            style={{flex:1,padding:"10px 12px",background:"var(--surface2)",border:"1.5px solid rgba(212,19,35,.3)",borderRadius:10,color:"var(--text)",fontSize:16,fontWeight:900,letterSpacing:4,textAlign:"center"}}/>
          <button className="btn btn-primary btn-sm" disabled={busy||code.trim().length<4} onClick={checkin}>{busy?"⏳":"Vai"}</button>
        </div>
      </div>

      {msg && <div style={{fontSize:13,fontWeight:800,textAlign:"center",padding:"8px 10px",marginBottom:10,background:"rgba(0,0,0,.35)",borderRadius:10}}>{msg}</div>}

      {/* Navigazione mese: solo corrente e successivo */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginBottom:12}}>
        <button className="btn btn-ghost btn-xs" disabled={!isNext} onClick={()=>setCursor(CUR)}>‹</button>
        <div style={{fontWeight:900,textTransform:"capitalize",minWidth:140,textAlign:"center"}}>{monthName}</div>
        <button className="btn btn-ghost btn-xs" disabled={isNext} onClick={()=>setCursor(NEXT)}>›</button>
      </div>

      {loading ? <div style={{color:"var(--text3)",fontSize:13,textAlign:"center"}}>⏳ Caricamento…</div> :
       slots.length === 0 ? <div style={{color:"var(--text3)",fontSize:13,textAlign:"center",padding:"18px 0"}}>Nessun turno in programma questo mese 🎪</div> :
       Object.entries(byDate).map(([date, daySlots]) => (
        <div key={date} style={{marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:900,textTransform:"uppercase",letterSpacing:".08em",color:"var(--text3)",marginBottom:6}}>
            {new Date(date+"T12:00").toLocaleDateString("it-IT",{weekday:"long",day:"numeric",month:"long"})}
            {date < localToday() && " · passato"}
          </div>
          {daySlots.map(s => {
            const my = mine[s.id];
            const free = s.max_participants - (counts[s.id] || 0);
            const isPast = s.date < localToday();
            const selectable = bookable(s);
            return (
              <div key={s.id}
                onClick={selectable ? ()=>toggle(s.id) : undefined}
                style={{
                  display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginBottom:6,
                  background: sel.has(s.id) ? "rgba(212,19,35,.18)" : "rgba(0,0,0,.35)",
                  border: sel.has(s.id) ? "1.5px solid #D41323" : "1px solid var(--border2)",
                  borderRadius:12, opacity: isPast ? .5 : 1,
                  cursor: selectable ? "pointer" : "default", transition:"all .15s ease",
                }}>
                {selectable && (
                  <div style={{width:20,height:20,borderRadius:6,border:"2px solid #D41323",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:900,color:"#D41323",flexShrink:0}}>
                    {sel.has(s.id) ? "✓" : ""}
                  </div>
                )}
                <div style={{flex:1}}>
                  <div style={{fontWeight:900,fontSize:15}}>{s.start_time.slice(0,5)}–{s.end_time.slice(0,5)}</div>
                  <div style={{fontSize:11,color:"var(--text3)"}}>
                    {my === "present" ? "✅ Presente!" :
                     my === "booked" ? "📌 Sei prenotato" :
                     my === "absent" ? "❌ Assente" :
                     free <= 0 ? "😕 Pieno" :
                     `${free} ${free === 1 ? "posto libero" : "posti liberi"}`}
                    {(s.xp_checkin > 0 || s.coin_checkin > 0) && ` · check-in: ${s.xp_checkin>0?`+${s.xp_checkin} XP`:""}${s.coin_checkin>0?` +${s.coin_checkin} 🪙`:""}`}
                  </div>
                </div>
                {my === "booked" && !isPast && canCancel(s) && (
                  <button className="btn btn-ghost btn-xs" style={{color:"#D41323"}} onClick={e=>{e.stopPropagation();cancel(s.id);}}>Disdici</button>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {sel.size > 0 && (
        <button className="btn btn-primary" disabled={busy}
          style={{position:"sticky",bottom:12,width:"100%",fontSize:16,fontWeight:900,boxShadow:"0 4px 20px rgba(212,19,35,.4)"}}
          onClick={book}>
          {busy ? "⏳…" : `🎪 Prenota ${sel.size} ${sel.size === 1 ? "turno" : "turni"}`}
        </button>
      )}

      <div style={{fontSize:10,color:"var(--text3)",textAlign:"center",marginTop:14,lineHeight:1.6}}>
        Il BIG TOP è gratis! Prenota i turni che vuoi (anche tutto il mese).<br/>
        Puoi disdire fino alle 22:00 del giorno prima. Se prenoti e non vieni: −2 🪙
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
    const { data: r, error } = await sb.rpc("bigtop_generate_month", { p_year: cursor.y, p_month: cursor.m });
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

  async function cancelSlot(s) {
    if (!confirm(`Annullare il turno del ${s.date.split("-").reverse().join("/")} ${s.start_time.slice(0,5)}?\n\nGli iscritti riceveranno una notifica.`)) return;
    const { data: r, error } = await sb.rpc("bigtop_cancel_slot", { p_slot_id: s.id });
    if (error || r?.error) { addToast("❌ " + (error?.message || r.error), "error"); return; }
    addToast(`Turno annullato (avvisati ${r.notified})`, "ok");
    load();
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
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginLeft:"auto"}}>
          <button className="btn btn-ghost btn-xs" onClick={()=>setCursor(c=>({ y: c.m===1?c.y-1:c.y, m: c.m===1?12:c.m-1 }))}>‹</button>
          <div style={{fontWeight:800,minWidth:130,textAlign:"center",textTransform:"capitalize"}}>{monthName}</div>
          <button className="btn btn-ghost btn-xs" onClick={()=>setCursor(c=>({ y: c.m===12?c.y+1:c.y, m: c.m===12?1:c.m+1 }))}>›</button>
        </div>
      </div>

      <button className="btn btn-yellow btn-sm" style={{width:"100%",marginBottom:14}} disabled={busy} onClick={generateMonth}>
        {busy ? "⏳…" : `➕ Genera turni di ${monthName} (mar/gio 16-17 e 17-18)`}
      </button>

      {loading ? <div style={{color:"var(--text3)",fontSize:13}}>⏳ Caricamento…</div> :
       slots.length === 0 ? <div style={{color:"var(--text3)",fontSize:13,textAlign:"center",padding:"20px 0"}}>Nessun turno questo mese — premi "Genera turni"</div> :
      slots.map(s => {
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
    const { data: att } = await sb.from("attendances").select("date,check_type,status,xp_awarded,coin_awarded,qr_verified,activity_id,profiles(display_name)").order("date",{ascending:false}).limit(2000);
    const actIds = [...new Set((att||[]).map(a=>a.activity_id).filter(Boolean))];
    let actMap = {};
    if (actIds.length) {
      const { data: acts } = await sb.from("activities").select("id,name").in("id",actIds);
      actMap = Object.fromEntries((acts||[]).map(a=>[a.id,a.name]));
    }
    const rows = [["Giocatore","Data","Tipo","Lab","Stato","XP","Coin","QR Verificato"]];
    (att||[]).forEach(a => rows.push([a.profiles?.display_name||"—", a.date, a.check_type==="lab"?"Lab":"Giornaliero", a.activity_id?actMap[a.activity_id]||"Lab":"—", a.status, a.xp_awarded||0, a.coin_awarded||0, a.qr_verified?"Sì":"No"]));
    downloadCSV(rows, `pug_presenze_${localToday()}.csv`);
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
    const { data } = await sb.from("notifications").select("title,body,type,created_at,profiles(display_name)").order("created_at",{ascending:false}).limit(2000);
    const rows = [["Giocatore","Azione","Dettaglio","Tipo","Data"]];
    (data||[]).filter(n=>n.profiles).forEach(n => rows.push([n.profiles?.display_name||"—", n.title, n.body||"", n.type, new Date(n.created_at).toLocaleDateString("it-IT")]));
    downloadCSV(rows, `pug_storico_${localToday()}.csv`);
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
      <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:8}}>📤 Export dati</div>
      <div style={{fontSize:13,color:"var(--text3)",marginBottom:20}}>I file vengono scaricati in formato CSV, compatibile con Excel, Google Fogli e Numbers.</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {exports.map(ex=>(
          <div key={ex.id} style={{background:"rgba(0,0,0,.3)",border:`1px solid rgba(255,255,255,.08)`,borderRadius:14,padding:"16px 18px",display:"flex",alignItems:"center",gap:14}}>
            <div style={{flex:1}}>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:20,fontWeight:900,color:ex.color,marginBottom:3}}>{ex.label}</div>
              <div style={{fontSize:12,color:"var(--text3)"}}>{ex.desc}</div>
            </div>
            <button className="btn btn-ghost btn-sm" style={{flexShrink:0,borderColor:ex.color,color:ex.color,minWidth:100}} onClick={ex.fn} disabled={loading===ex.id}>
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
  const medalColors = ["#aac8e0","#FDEF26","#d4916a"];

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
              const colors = ["#FDEF26","#aac8e0","#d4916a"];
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
  sfida:        { accent:"#ff2244", border:"rgba(255,34,68,.3)",   bg:"rgba(255,34,68,.03)" },
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
  const [theme, setTheme] = useState("dark");
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

  const sharedProps = { sectionColors, setSectionColors };

  return (
    <div className="edu-layout">
      {/* Floral background */}
      <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:0,opacity:.05,overflow:'hidden',maxWidth:'100vw'}}>
        <svg viewBox="0 0 1200 900" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" style={{width:'100%',height:'100%',animation:'float1 18s ease-in-out infinite'}}>
          <defs><g id="ef"><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(0)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(60)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(120)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(180)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(240)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(300)"/><circle cx="0" cy="0" r="5" fill="white"/></g></defs>
          <use href="#ef" transform="translate(80,80) scale(1.4)"/><use href="#ef" transform="translate(350,60) scale(1.1)"/><use href="#ef" transform="translate(700,90) scale(1.3)"/><use href="#ef" transform="translate(1050,70) scale(1)"/><use href="#ef" transform="translate(200,300) scale(.9)"/><use href="#ef" transform="translate(550,280) scale(1.2)"/><use href="#ef" transform="translate(900,310) scale(1)"/><use href="#ef" transform="translate(100,550) scale(1.1)"/><use href="#ef" transform="translate(450,520) scale(.8)"/><use href="#ef" transform="translate(800,560) scale(1.3)"/><use href="#ef" transform="translate(250,780) scale(1)"/><use href="#ef" transform="translate(650,760) scale(1.2)"/><use href="#ef" transform="translate(1000,790) scale(.9)"/>
        </svg>
      </div>

      {/* Sidebar desktop */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <div className="pd-logo-img logo-b" style={{width:130,height:42,margin:"0 auto"}}/>
          <div className="pd-logo-img logo-w" style={{width:130,height:42,margin:"0 auto"}}/>
          <div className="sidebar-badge">🌱 Pannello Giardiniere</div>
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
      <div className="mob-header" style={{paddingTop:"env(safe-area-inset-top,0px)"}}>
        <button onClick={() => setDrawerOpen(true)} style={{background:"none",border:"none",color:"rgba(255,255,255,.6)",fontSize:22,cursor:"pointer",padding:4,lineHeight:1}}>☰</button>
        <div style={{transform:"rotate(-1deg)"}}>
          <div style={{background:"#cc1111",borderRadius:"7px 10px 7px 11px",padding:"3px 8px",display:"inline-block"}}>
            <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:11,fontWeight:900,color:"#111",lineHeight:1.05,textTransform:"uppercase"}}>PeR·You GaRDeN</div>
          </div>
        </div>
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
            <div style={{background:"#cc1111",borderRadius:"8px 11px 8px 12px",padding:"5px 10px",display:"inline-block"}}>
              <div style={{fontFamily:"'Funnel Display',sans-serif",fontSize:14,fontWeight:900,color:"#111",lineHeight:1.05,textTransform:"uppercase"}}>PeR·You GaRDeN</div>
            </div>
          </div>
          <div style={{fontFamily:"'Funnel Display',sans-serif",background:"#111",color:"#ffe600",fontSize:9,fontWeight:900,borderRadius:4,padding:"2px 8px",textTransform:"uppercase",letterSpacing:".07em",display:"inline-block"}}>🌱 Giardiniere</div>
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
      <div className="edu-main" style={{background: theme === "light" ? ((sectionColors?.[tab] || DEFAULT_SECTION_COLORS[tab])?.color || "#A3CFFE") : "#0a0a0a", transition:"background .4s ease"}}>
        <div className="bg-doodles"/>
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
          {!["classifica","presenze","attivita","badge","sfida"].includes(tab) && (
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
      {!isOnline && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:9999,background:"#c62828",color:"#fff",textAlign:"center",padding:"8px",fontSize:13,fontWeight:700}}>📵 Nessuna connessione</div>}
      <div style={{position:"relative"}}>
        <div style={{position:"fixed",top:0,left:0,right:0,height:3,zIndex:9999,background:"linear-gradient(90deg,var(--neon-blue),var(--neon-pink),var(--neon-blue))",backgroundSize:"200% 100%",animation:"shimmer 1.5s linear infinite"}}/>
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
