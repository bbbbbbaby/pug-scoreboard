import { sb } from "./supabase.js";
import { useState, useEffect, useCallback, useRef } from "react";

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

function getLevel(xp) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i].xp) return LEVELS[i];
  }
  return LEVELS[0];
}

// ─── BRAND PALETTE ────────────────────────────────────────
const BRAND = {
  azzurro: "#A3CFFE",
  rosa:    "#FF6DEC",
  giallo:  "#FDEF26",
  verde:   "#339966",
  rosso:   "#D41323",
  nero:    "#101010",
  bianco:  "#FFFFFF",
};

const SQUAD_STYLE = {
  Verde:   { bg: "#339966", text: "#fff", border: "#339966" },
  Gialla:  { bg: "#FDEF26", text: "#101010", border: "#FDEF26" },
  Azzurra: { bg: "#A3CFFE", text: "#101010", border: "#A3CFFE" },
};

// Colori di default per le sezioni personalizzabili
const DEFAULT_SECTION_COLORS = {
  classifica: { color: "#A3CFFE", image: null },
  badge:      { color: "#FF6DEC", image: null },
  presenze:   { color: "#FDEF26", image: null },
  attivita:   { color: "#339966", image: null },
  sfida:      { color: "#D41323", image: null },
};

// ─── CSS ──────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Funnel+Display:wght@300;400;500;600;700;800&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body {
    font-family: 'Funnel Display', sans-serif;
    background: #101010;
    color: #f0f0f0;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  :root {
    /* Brand */
    --azzurro: #A3CFFE; --rosa: #FF6DEC; --giallo: #FDEF26;
    --verde: #339966; --rosso: #D41323;
    --nero: #101010; --bianco: #FFFFFF;
    /* UI surfaces */
    --surface: #1c1c1c; --surface2: #252525; --surface3: #303030;
    --border: rgba(255,255,255,0.09); --border2: rgba(255,255,255,0.16);
    --text: #f0f0f0; --text2: #999; --text3: #555;
    /* Accents (remap to brand) */
    --accent: #339966; --accent2: #4db880;
    --danger: #D41323; --warning: #FDEF26;
    --radius: 14px; --radius-sm: 10px; --radius-lg: 20px;
  }

  /* LIGHT THEME */
  body.light {
    background: #f5f5f5; color: #101010;
    --surface: #ffffff; --surface2: #f0f0f0; --surface3: #e5e5e5;
    --border: rgba(0,0,0,0.08); --border2: rgba(0,0,0,0.14);
    --text: #101010; --text2: #555; --text3: #999;
  }

  /* TYPOGRAPHY */
  .font-display { font-family: 'Barlow Condensed', sans-serif; font-weight: 900; text-transform: uppercase; letter-spacing: -0.02em; }
  .font-ui { font-family: 'Funnel Display', sans-serif; }

  /* ── LOGIN ── */
  .login-wrap { display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; background: var(--nero); }
  .login-card { background:var(--surface); border:1px solid var(--border2); border-radius:var(--radius-lg); padding:36px 28px; width:100%; max-width:420px; }
  .login-logo { text-align:center; margin-bottom:32px; }
  .login-title { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:52px; text-transform:uppercase; letter-spacing:-1px; line-height:1; color:var(--azzurro); }
  .login-sub { font-size:13px; color:var(--text2); margin-top:6px; }
  .form-group { margin-bottom:14px; }
  .form-label { font-size:10px; font-weight:700; color:var(--text2); margin-bottom:5px; display:block; text-transform:uppercase; letter-spacing:.1em; }
  .form-input { width:100%; padding:13px 14px; background:var(--surface2); border:1.5px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display',sans-serif; font-size:16px; outline:none; transition:border-color .15s; }
  .form-input:focus { border-color:var(--azzurro); }
  .remember-row { display:flex; align-items:center; gap:8px; margin-bottom:16px; cursor:pointer; }
  .remember-row input[type=checkbox] { width:18px; height:18px; accent-color:var(--azzurro); }
  .remember-row span { font-size:14px; color:var(--text2); }
  .err-msg { font-size:12px; color:var(--danger); margin-top:10px; text-align:center; }

  /* ── BUTTONS ── */
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:10px 18px; border-radius:var(--radius-sm); border:none; cursor:pointer; font-family:'Funnel Display',sans-serif; font-size:14px; font-weight:600; transition:all .15s; white-space:nowrap; min-height:44px; }
  .btn-primary { background:var(--azzurro); color:var(--nero); width:100%; padding:14px; font-size:15px; font-weight:700; }
  .btn-primary:active { opacity:.85; }
  .btn-ghost { background:transparent; color:var(--text2); border:1.5px solid var(--border2); }
  .btn-ghost:active { background:var(--surface2); }
  .btn-danger { background:rgba(212,19,35,.15); color:var(--danger); border:1px solid rgba(212,19,35,.3); }
  .btn-yellow { background:var(--giallo); color:var(--nero); font-weight:700; border:none; }
  .btn-sm { padding:7px 14px; font-size:13px; min-height:38px; }
  .btn-xs { padding:5px 10px; font-size:12px; min-height:32px; border-radius:8px; }

  /* ── EDUCATOR DESKTOP ── */
  .edu-layout { display:flex; min-height:100vh; }
  .sidebar { width:230px; background:var(--nero); border-right:1px solid var(--border); display:flex; flex-direction:column; flex-shrink:0; position:fixed; top:0; left:0; height:100vh; overflow-y:auto; z-index:10; }
  .sidebar-logo { padding:22px 20px 18px; border-bottom:1px solid var(--border); }
  .sidebar-logo-title { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:28px; text-transform:uppercase; color:var(--azzurro); letter-spacing:-0.5px; line-height:1; }
  .sidebar-logo-sub { font-size:11px; color:var(--text3); margin-top:3px; }
  .nav { flex:1; padding:10px 0; }
  .nav-item { display:flex; align-items:center; gap:12px; padding:10px 20px; cursor:pointer; font-size:13px; font-weight:500; color:var(--text2); border-left:3px solid transparent; transition:all .12s; min-height:44px; }
  .nav-item:hover { background:var(--surface2); color:var(--text); }
  .nav-item.active { background:rgba(163,207,254,.08); color:var(--azzurro); border-left-color:var(--azzurro); font-weight:700; }
  .nav-icon { font-size:17px; width:22px; text-align:center; flex-shrink:0; }
  .sidebar-user { padding:16px 20px; border-top:1px solid var(--border); }
  .edu-main { margin-left:230px; flex:1; display:flex; flex-direction:column; min-height:100vh; }
  .topbar { padding:14px 26px; background:var(--nero); border-bottom:1px solid var(--border); display:flex; align-items:center; position:sticky; top:0; z-index:5; gap:12px; }
  .topbar-title { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:26px; text-transform:uppercase; color:var(--text); letter-spacing:-0.5px; }
  .content { flex:1; padding:22px 26px; }

  /* ── MOBILE EDUCATOR ── */
  .mob-header { display:none; position:fixed; top:0; left:0; right:0; height:58px; background:var(--nero); border-bottom:1px solid var(--border); z-index:20; align-items:center; padding:0 16px; gap:12px; }
  .mob-header-title { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:22px; text-transform:uppercase; color:var(--azzurro); flex:1; letter-spacing:-0.3px; }
  .mob-drawer-bg { position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:30; }
  .mob-drawer { position:fixed; top:0; left:0; bottom:0; width:270px; background:var(--nero); z-index:40; transform:translateX(-100%); transition:transform .25s; display:flex; flex-direction:column; }
  .mob-drawer.open { transform:translateX(0); }
  .mob-bottom-nav { display:none; position:fixed; bottom:0; left:0; right:0; background:var(--nero); border-top:1px solid var(--border); z-index:20; padding-bottom:env(safe-area-inset-bottom,0px); }
  .mob-bottom-nav-inner { display:flex; height:62px; }
  .mob-nav-btn { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; background:none; border:none; cursor:pointer; color:var(--text3); font-family:'Funnel Display'; padding:0; transition:color .12s; }
  .mob-nav-btn.active { color:var(--azzurro); }

  /* ── SECTION BANNERS ── */
  .section-banner { border-radius:var(--radius-lg); padding:20px; margin-bottom:18px; position:relative; overflow:hidden; min-height:80px; display:flex; align-items:flex-end; }
  .section-banner-bg { position:absolute; inset:0; background-size:cover; background-position:center; }
  .section-banner-overlay { position:absolute; inset:0; background:linear-gradient(to top, rgba(0,0,0,.55) 0%, rgba(0,0,0,.1) 100%); }
  .section-banner-content { position:relative; z-index:1; }
  .section-banner-title { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:32px; text-transform:uppercase; color:#fff; letter-spacing:-0.5px; line-height:1; text-shadow:0 2px 8px rgba(0,0,0,.4); }
  .section-banner-sub { font-size:12px; color:rgba(255,255,255,.75); margin-top:2px; }

  /* ── CARDS ── */
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px 20px; }
  .card-sm { background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px 14px; }
  .stats-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:18px; }
  .stat-card { background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius); padding:14px; }
  .stat-label { font-size:10px; color:var(--text3); text-transform:uppercase; letter-spacing:.08em; margin-bottom:4px; font-weight:600; }
  .stat-value { font-family:'Barlow Condensed',sans-serif; font-size:32px; font-weight:900; color:var(--text); line-height:1; }
  .stat-sub { font-size:11px; color:var(--text2); margin-top:2px; }

  /* ── PLAYER GRID ── */
  .player-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px; }
  .player-card { background:var(--surface2); border:1.5px solid var(--border); border-radius:var(--radius); padding:14px 10px; text-align:center; cursor:pointer; position:relative; transition:border-color .15s; }
  .player-card.selected { border-color:var(--azzurro); background:rgba(163,207,254,.06); }
  .avatar-wrap { width:56px; height:56px; border-radius:50%; margin:0 auto 10px; overflow:hidden; display:flex; align-items:center; justify-content:center; font-size:26px; border:2.5px solid var(--border2); }
  .avatar-wrap img { width:100%; height:100%; object-fit:cover; }
  .p-name { font-size:12px; font-weight:700; color:var(--text); margin-bottom:2px; word-break:break-word; line-height:1.3; }
  .p-level { font-size:10px; color:var(--text2); margin-bottom:3px; }
  .p-xp { font-family:'Barlow Condensed',sans-serif; font-size:16px; font-weight:900; color:var(--azzurro); }
  .p-coin { font-size:10px; color:var(--giallo); margin-top:1px; }
  .squad-pill { font-size:9px; padding:2px 8px; border-radius:99px; display:inline-block; margin-top:5px; font-weight:700; }
  .pts-row { display:flex; gap:4px; justify-content:center; margin-top:8px; }
  .pts-btn { width:30px; height:30px; border-radius:50%; border:1.5px solid var(--border2); background:var(--surface3); cursor:pointer; font-size:15px; display:flex; align-items:center; justify-content:center; color:var(--text2); font-family:'Funnel Display'; line-height:1; transition:all .1s; }
  .pts-btn.add { color:var(--verde); border-color:rgba(51,153,102,.4); }
  .pts-btn.rem { color:var(--danger); border-color:rgba(212,19,35,.3); }

  /* ── LEADERBOARD ── */
  .lb-list { display:flex; flex-direction:column; gap:6px; }
  .lb-row { display:flex; align-items:center; gap:10px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px 14px; transition:border-color .15s; cursor:pointer; }
  .lb-row:hover { border-color:var(--border2); }
  .lb-rank { font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:900; width:30px; text-align:center; color:var(--text3); flex-shrink:0; }
  .lb-rank.gold { color:var(--giallo); } .lb-rank.silver { color:#ccc; } .lb-rank.bronze { color:#e8956d; }
  .lb-av { width:38px; height:38px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; overflow:hidden; border:1.5px solid var(--border2); }
  .lb-av img { width:100%; height:100%; object-fit:cover; }
  .lb-name { flex:1; font-size:14px; font-weight:700; color:var(--text); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .lb-level { font-size:10px; color:var(--text3); margin-top:1px; }
  .lb-xp { font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:900; color:var(--azzurro); flex-shrink:0; }

  /* ── PLAYER DETAIL PANEL ── */
  .player-detail { background:var(--surface); border:1.5px solid var(--azzurro); border-radius:var(--radius-lg); padding:20px; margin-top:12px; }
  .player-detail-header { display:flex; gap:16px; align-items:center; margin-bottom:16px; }
  .player-detail-av { width:64px; height:64px; border-radius:50%; overflow:hidden; border:3px solid var(--azzurro); display:flex; align-items:center; justify-content:center; font-size:30px; flex-shrink:0; }
  .player-detail-av img { width:100%; height:100%; object-fit:cover; }
  .detail-tabs { display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
  .detail-tab { padding:6px 14px; border-radius:99px; border:1.5px solid var(--border2); background:transparent; color:var(--text2); font-family:'Funnel Display'; font-size:12px; font-weight:600; cursor:pointer; min-height:32px; }
  .detail-tab.active { background:var(--azzurro); color:var(--nero); border-color:var(--azzurro); }

  /* ── FILTER ── */
  .filter-bar { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
  .search-inp { padding:10px 14px; background:var(--surface2); border:1.5px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:16px; outline:none; flex:1; min-width:140px; }
  .search-inp:focus { border-color:var(--azzurro); }
  .chip { padding:8px 16px; border-radius:99px; border:1.5px solid var(--border2); background:transparent; color:var(--text2); font-family:'Funnel Display'; font-size:12px; font-weight:600; cursor:pointer; min-height:36px; transition:all .12s; }
  .chip.active { background:var(--azzurro); color:var(--nero); border-color:var(--azzurro); }

  /* ── BATCH ── */
  .batch-panel { background:rgba(163,207,254,.06); border:1.5px solid rgba(163,207,254,.25); border-radius:var(--radius); padding:12px 16px; margin-bottom:14px; }
  .batch-info { font-size:13px; color:var(--azzurro); font-weight:700; margin-bottom:10px; }
  .batch-inp { width:70px; padding:8px 10px; background:var(--surface2); border:1.5px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Barlow Condensed'; font-size:18px; font-weight:700; outline:none; text-align:center; }

  /* ── PRESENZE ── */
  .pres-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border-radius:var(--radius); border:1px solid var(--border); }
  .pres-table { width:100%; border-collapse:collapse; font-size:13px; min-width:420px; }
  .pres-table th { padding:10px 12px; text-align:left; font-size:10px; font-weight:700; color:var(--text3); border-bottom:1px solid var(--border); text-transform:uppercase; letter-spacing:.08em; background:var(--nero); }
  .pres-table td { padding:10px 12px; border-bottom:1px solid var(--border); color:var(--text); }
  .pres-dot { width:32px; height:32px; border-radius:50%; border:none; cursor:pointer; font-size:13px; display:inline-flex; align-items:center; justify-content:center; font-family:'Funnel Display'; font-weight:700; transition:opacity .12s; }
  .pd-yes { background:rgba(51,153,102,.25); color:var(--verde); }
  .pd-partial { background:rgba(253,239,38,.2); color:#b8a000; }
  .pd-completed { background:rgba(51,153,102,.45); color:#4db880; }
  .pd-none { background:var(--surface3); color:var(--text3); }

  /* ── ACTIVITIES ── */
  .act-grid { display:grid; grid-template-columns:1fr; gap:10px; }
  .act-card { background:var(--surface2); border:1.5px solid var(--border); border-radius:var(--radius); padding:16px; position:relative; }
  .act-title { font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--text); margin-bottom:4px; letter-spacing:-0.3px; }
  .act-meta { font-size:12px; color:var(--text2); margin-bottom:10px; }
  .act-rewards { display:flex; gap:6px; flex-wrap:wrap; }
  .reward-tag { font-size:10px; padding:4px 10px; border-radius:99px; font-weight:700; }
  .xp-tag { background:rgba(163,207,254,.15); color:var(--azzurro); }
  .coin-tag { background:rgba(253,239,38,.15); color:#b8a000; }
  .delete-btn { position:absolute; top:10px; right:10px; width:28px; height:28px; border-radius:50%; border:1px solid rgba(212,19,35,.3); background:rgba(212,19,35,.1); color:var(--danger); cursor:pointer; font-size:13px; display:flex; align-items:center; justify-content:center; }

  /* ── BADGES ── */
  .badge-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(100px,1fr)); gap:10px; }
  .badge-card { background:var(--surface2); border:1.5px solid var(--border); border-radius:var(--radius); padding:12px 10px; text-align:center; cursor:pointer; position:relative; transition:border-color .15s; }
  .badge-card:hover { border-color:var(--rosa); }
  .badge-img { width:56px; height:56px; border-radius:50%; object-fit:cover; margin:0 auto 8px; display:block; border:2.5px solid var(--border2); }
  .badge-emoji { font-size:36px; display:block; margin:0 auto 8px; line-height:1; }
  .badge-name { font-size:11px; font-weight:700; color:var(--text); line-height:1.3; }
  .badge-pts { font-size:10px; color:var(--text2); margin-top:3px; }

  /* ── SQUAD ── */
  .squad-list { display:flex; flex-direction:column; gap:8px; }
  .squad-row { display:flex; align-items:center; gap:12px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius-sm); padding:14px 16px; }
  .squad-color-dot { width:16px; height:16px; border-radius:50%; flex-shrink:0; }
  .squad-name { flex:1; font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--text); }
  .squad-count { font-size:12px; color:var(--text3); }

  /* ── MESSAGES ── */
  .msg-layout { display:flex; gap:12px; height:440px; }
  .msg-list { width:150px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; flex-shrink:0; }
  .msg-thread { background:var(--surface2); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:10px 12px; cursor:pointer; }
  .msg-thread.active { border-color:var(--azzurro); background:rgba(163,207,254,.08); }
  .mt-name { font-size:12px; font-weight:700; color:var(--text); }
  .msg-main { flex:1; display:flex; flex-direction:column; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; min-width:0; }
  .msg-hdr { padding:12px 16px; border-bottom:1px solid var(--border); font-weight:700; font-size:14px; color:var(--text); }
  .msg-body { flex:1; padding:14px 16px; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
  .bubble-wrap { display:flex; gap:8px; }
  .bubble-wrap.mine { flex-direction:row-reverse; }
  .bubble-av { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; flex-shrink:0; background:var(--surface3); }
  .bubble { max-width:220px; padding:8px 12px; border-radius:12px; font-size:13px; line-height:1.5; }
  .bubble.them { background:var(--surface3); color:var(--text); }
  .bubble.mine { background:rgba(163,207,254,.2); color:var(--azzurro); }
  .msg-inp-row { padding:10px 14px; border-top:1px solid var(--border); display:flex; gap:8px; }
  .msg-inp { flex:1; padding:10px 12px; background:var(--surface3); border:1.5px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:14px; outline:none; }

  /* ── NOTIFICATIONS ── */
  .notif-dot { width:8px; height:8px; border-radius:50%; background:var(--rosa); display:inline-block; margin-left:4px; vertical-align:middle; }
  .notif-item { display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--border); }
  .notif-icon { font-size:24px; flex-shrink:0; }
  .notif-title { font-size:14px; font-weight:700; color:var(--text); margin-bottom:2px; }
  .notif-body { font-size:13px; color:var(--text2); }
  .notif-time { font-size:11px; color:var(--text3); margin-top:3px; }

  /* ── MODAL ── */
  .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:100; display:flex; align-items:flex-end; justify-content:center; }
  .modal { background:var(--surface); border:1px solid var(--border2); border-radius:20px 20px 0 0; padding:24px 20px; padding-bottom:calc(24px + env(safe-area-inset-bottom,0px)); width:100%; max-width:560px; max-height:92vh; overflow-y:auto; }
  .modal-title { font-family:'Barlow Condensed',sans-serif; font-size:28px; font-weight:900; text-transform:uppercase; color:var(--text); margin-bottom:18px; letter-spacing:-0.5px; }
  .section-label { font-size:10px; font-weight:700; color:var(--text3); text-transform:uppercase; letter-spacing:.1em; margin:16px 0 8px; }

  /* ── PROFILE (player) ── */
  .profile-hero { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); padding:24px; text-align:center; margin-bottom:14px; position:relative; overflow:hidden; }
  .profile-hero-bg { position:absolute; inset:0; background-size:cover; background-position:center; opacity:.18; }
  .profile-avatar { width:90px; height:90px; border-radius:50%; margin:0 auto 14px; border:3px solid var(--azzurro); display:flex; align-items:center; justify-content:center; font-size:42px; overflow:hidden; position:relative; }
  .profile-avatar img { width:100%; height:100%; object-fit:cover; }
  .profile-name { font-family:'Barlow Condensed',sans-serif; font-size:32px; font-weight:900; text-transform:uppercase; color:var(--text); margin-bottom:4px; letter-spacing:-0.5px; position:relative; }
  .profile-level { font-size:14px; color:var(--azzurro); margin-bottom:10px; font-weight:600; position:relative; }
  .xp-bar-wrap { height:7px; background:var(--surface3); border-radius:99px; overflow:hidden; margin:8px 0; position:relative; }
  .xp-bar { height:100%; background:linear-gradient(90deg, var(--azzurro), var(--rosa)); border-radius:99px; transition:width .5s; }
  .xp-label { display:flex; justify-content:space-between; font-size:10px; color:var(--text3); position:relative; }

  /* ── SFIDA DEL GIORNO ── */
  .sfida-card { border-radius:var(--radius-lg); padding:18px; margin-bottom:14px; position:relative; overflow:hidden; border:2px solid var(--rosso); background:rgba(212,19,35,.06); }
  .sfida-label { font-family:'Barlow Condensed',sans-serif; font-size:13px; font-weight:900; text-transform:uppercase; color:var(--rosso); letter-spacing:.1em; margin-bottom:4px; }
  .sfida-title { font-family:'Barlow Condensed',sans-serif; font-size:24px; font-weight:900; text-transform:uppercase; color:var(--text); letter-spacing:-0.3px; margin-bottom:6px; }
  .sfida-desc { font-size:13px; color:var(--text2); margin-bottom:12px; line-height:1.5; }
  .sfida-reward { display:inline-flex; align-items:center; gap:6px; background:rgba(253,239,38,.15); border:1px solid rgba(253,239,38,.3); border-radius:99px; padding:4px 12px; font-size:12px; font-weight:700; color:var(--giallo); }

  /* ── DIARIO ── */
  .diary-day { margin-bottom:18px; }
  .diary-date { font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--azzurro); margin-bottom:8px; letter-spacing:-0.3px; }
  .diary-entry { display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:5px; }
  .diary-icon { font-size:18px; flex-shrink:0; }
  .diary-text { flex:1; font-size:13px; color:var(--text); line-height:1.4; }
  .diary-pts { font-family:'Barlow Condensed',sans-serif; font-size:18px; font-weight:900; color:var(--azzurro); flex-shrink:0; }

  /* ── QR ── */
  .qr-code { font-family:'Barlow Condensed',sans-serif; font-size:52px; font-weight:900; color:var(--azzurro); letter-spacing:10px; margin:16px 0; }

  /* ── AVATAR UPLOAD ── */
  .avatar-upload-area { border:2px dashed var(--border2); border-radius:var(--radius); padding:20px; text-align:center; cursor:pointer; margin-bottom:12px; transition:border-color .15s; }
  .avatar-upload-area:hover { border-color:var(--azzurro); }
  .avatar-preview { width:80px; height:80px; border-radius:50%; object-fit:cover; margin:0 auto 8px; display:block; border:2.5px solid var(--azzurro); }

  /* ── THEME TOGGLE ── */
  .theme-toggle { width:44px; height:24px; border-radius:99px; border:none; cursor:pointer; position:relative; transition:background .2s; display:flex; align-items:center; padding:0 3px; }
  .theme-toggle-knob { width:18px; height:18px; border-radius:50%; background:#fff; transition:transform .2s; box-shadow:0 1px 4px rgba(0,0,0,.3); }

  /* ── MISC ── */
  .tag { font-size:11px; padding:3px 9px; border-radius:99px; display:inline-block; font-weight:700; }
  .tag-green { background:rgba(51,153,102,.15); color:var(--verde); }
  .tag-blue { background:rgba(163,207,254,.15); color:var(--azzurro); }
  .tag-amber { background:rgba(253,239,38,.15); color:#b8a000; }
  .tag-red { background:rgba(212,19,35,.15); color:var(--danger); }
  .tag-gray { background:var(--surface3); color:var(--text2); }
  .loading { display:flex; align-items:center; justify-content:center; min-height:160px; color:var(--text2); font-size:14px; gap:8px; }
  .empty { text-align:center; padding:40px 20px; color:var(--text3); font-size:14px; }
  select { padding:10px 12px; background:var(--surface2); border:1.5px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:16px; outline:none; width:100%; }
  textarea { width:100%; padding:10px 12px; background:var(--surface2); border:1.5px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:14px; outline:none; resize:vertical; min-height:80px; }
  .color-swatch-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
  .color-swatch { width:36px; height:36px; border-radius:50%; border:3px solid transparent; cursor:pointer; transition:border-color .12s; }
  .color-swatch.active { border-color:var(--text); }

  /* ── RESPONSIVE ── */
  @media (min-width:768px) {
    .stats-grid { grid-template-columns:repeat(4,1fr); }
    .act-grid { grid-template-columns:1fr 1fr; }
    .modal-bg { align-items:center; }
    .modal { border-radius:20px; }
  }
  @media (max-width:767px) {
    .sidebar { display:none; }
    .edu-main { margin-left:0; }
    .topbar { display:none; }
    .content { padding:14px; }
    .mob-header { display:flex; }
    .mob-bottom-nav { display:block; }
    .edu-content-wrap { padding-top:58px; padding-bottom:calc(62px + env(safe-area-inset-bottom,0px) + 8px); }
    .player-grid { grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; }
    .msg-layout { flex-direction:column; height:auto; }
    .msg-list { width:100%; flex-direction:row; overflow-x:auto; flex-wrap:nowrap; padding-bottom:4px; height:auto; }
    .msg-thread { flex-shrink:0; width:130px; }
    .msg-main { height:340px; }
    .player-detail { padding:14px; }
  }
`;

// ─── UTILS ────────────────────────────────────────────────

function Avatar({ url, emoji, size = 40 }) {
  if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }} />;
  return <span style={{ fontSize: size * 0.52 }}>{emoji || "🌱"}</span>;
}

function XpBar({ xp }) {
  const lv = getLevel(xp);
  const nextLv = LEVELS.find(l => l.xp > xp);
  const pct = nextLv ? Math.round(((xp - lv.xp) / (nextLv.xp - lv.xp)) * 100) : 100;
  return (
    <div>
      <div className="xp-bar-wrap"><div className="xp-bar" style={{ width: pct + "%" }} /></div>
      <div className="xp-label"><span>{xp} XP</span>{nextLv && <span>{nextLv.xp} XP</span>}</div>
    </div>
  );
}

function SquadPill({ name }) {
  const s = SQUAD_STYLE[name] || { bg: "#252525", text: "#999", border: "#303030" };
  return <span className="squad-pill" style={{ background: s.bg, color: s.text }}>{name}</span>;
}

// Banner colorato per le sezioni (colore + eventuale immagine)
function SectionBanner({ sectionKey, title, sub, sectionColors, onEdit }) {
  const cfg = sectionColors?.[sectionKey] || DEFAULT_SECTION_COLORS[sectionKey] || { color: "#252525", image: null };
  return (
    <div className="section-banner" style={{ background: cfg.image ? undefined : cfg.color }}>
      {cfg.image && <div className="section-banner-bg" style={{ backgroundImage: `url(${cfg.image})` }} />}
      {cfg.image && <div className="section-banner-overlay" />}
      <div className="section-banner-content" style={{ flex: 1 }}>
        <div className="section-banner-title" style={{ color: cfg.image ? "#fff" : "#101010" }}>{title}</div>
        {sub && <div className="section-banner-sub" style={{ color: cfg.image ? "rgba(255,255,255,.75)" : "rgba(0,0,0,.5)" }}>{sub}</div>}
      </div>
      {onEdit && (
        <button className="btn btn-xs btn-ghost" style={{ position: "absolute", top: 10, right: 10, background: "rgba(0,0,0,.35)", color: "#fff", border: "none", fontSize: 11, backdropFilter: "blur(4px)" }} onClick={onEdit}>✏️ Personalizza</button>
      )}
    </div>
  );
}

// Personalizzazione banner (colore + immagine)
function BannerCustomizer({ sectionKey, sectionColors, setSectionColors, onClose }) {
  const cfg = sectionColors?.[sectionKey] || DEFAULT_SECTION_COLORS[sectionKey] || { color: "#A3CFFE", image: null };
  const [color, setColor] = useState(cfg.color);
  const [image, setImage] = useState(cfg.image);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  const PRESET_COLORS = [BRAND.azzurro, BRAND.rosa, BRAND.giallo, BRAND.verde, BRAND.rosso, "#252525", "#ffffff"];

  async function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `banners/${sectionKey}.${ext}`;
    const { error } = await sb.storage.from("avatars").upload(path, file, { upsert: true });
    if (!error) {
      const { data } = sb.storage.from("avatars").getPublicUrl(path);
      setImage(data.publicUrl + "?t=" + Date.now());
    }
    setUploading(false);
  }

  function save() {
    setSectionColors(prev => ({ ...prev, [sectionKey]: { color, image } }));
    onClose();
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">Personalizza sezione</div>
        <div className="section-label">Colore sfondo</div>
        <div className="color-swatch-row">
          {PRESET_COLORS.map(c => (
            <div key={c} className={`color-swatch ${color === c ? "active" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
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
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={save}>Salva</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Annulla</button>
        </div>
      </div>
    </div>
  );
}

function AvatarUpload({ playerId, currentUrl, onUploaded }) {
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(currentUrl);

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `avatars/${playerId}.${ext}`;
    const { error: upErr } = await sb.storage.from("avatars").upload(path, file, { upsert: true });
    if (upErr) { alert("Errore upload: " + upErr.message); setUploading(false); return; }
    const { data } = sb.storage.from("avatars").getPublicUrl(path);
    const url = data.publicUrl + "?t=" + Date.now();
    await sb.from("profiles").update({ avatar_url: url }).eq("id", playerId);
    setPreview(url);
    onUploaded && onUploaded(url);
    setUploading(false);
  }

  return (
    <div className="avatar-upload-area" onClick={() => fileRef.current.click()}>
      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
      {preview ? <img src={preview} className="avatar-preview" alt="avatar" /> : <div style={{ fontSize: 40, marginBottom: 8 }}>📷</div>}
      <div style={{ fontSize: 13, color: "var(--text2)" }}>{uploading ? "Caricamento…" : "Tocca per cambiare foto"}</div>
    </div>
  );
}

// ─── LOG HELPER ───────────────────────────────────────────
async function logAction({ playerId, action, xpDelta = 0, coinDelta = 0, note = "" }) {
  try {
    await sb.from("notifications").insert({
      user_id: playerId,
      type: "log_action",
      title: action,
      body: [xpDelta ? `+${xpDelta} XP` : "", coinDelta ? `+${coinDelta} Coin` : "", note].filter(Boolean).join(" · "),
    });
  } catch (_) {}
}

// ─── LOGIN ────────────────────────────────────────────────

function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(true);

  async function handleLogin() {
    setLoading(true); setErr("");
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) { setErr(error.message); setLoading(false); return; }
    const { data: profile } = await sb.from("profiles").select("*, squads(name)").eq("id", data.user.id).single();
    onLogin(profile || { id: data.user.id, role: "educator", display_name: email.split("@")[0], xp: 0, coin: 100 });
    setLoading(false);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <div className="login-title">Per·You<br/>Garden</div>
          <p className="login-sub">Accedi al tuo account</p>
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="nome@email.com" autoComplete="email" />
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <input className="form-input" type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="••••••••" autoComplete="current-password" />
        </div>
        <label className="remember-row">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          <span>Resta collegato</span>
        </label>
        <button className="btn btn-primary" onClick={handleLogin} disabled={loading}>{loading ? "Accesso…" : "Accedi"}</button>
        {err && <p className="err-msg">{err}</p>}
      </div>
    </div>
  );
}

// ─── EDUCATOR VIEWS ───────────────────────────────────────

function PlayersView({ profile, sectionColors, setSectionColors }) {
  const [players, setPlayers] = useState([]);
  const [squads, setSquads] = useState([]);
  const [search, setSearch] = useState("");
  const [squadFilter, setSquadFilter] = useState("all");
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [batchXp, setBatchXp] = useState(10);
  const [batchCoin, setBatchCoin] = useState(5);
  const [msg, setMsg] = useState("");
  const [editPlayer, setEditPlayer] = useState(null);
  const [expandedPlayer, setExpandedPlayer] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await sb.from("profiles").select("*, squads(name,color)").eq("role", "player").order("xp", { ascending: false });
    const { data: sq } = await sb.from("squads").select("*");
    setPlayers(data || []); setSquads(sq || []); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = players.filter(p => {
    const sq = squadFilter === "all" || p.squads?.name === squadFilter;
    const sr = !search || p.display_name.toLowerCase().includes(search.toLowerCase());
    return sq && sr;
  });

  async function changeXP(playerId, delta, field = "xp") {
    const p = players.find(x => x.id === playerId);
    if (!p) return;
    const newVal = Math.max(0, p[field] + delta);
    await sb.from("profiles").update({ [field]: newVal }).eq("id", playerId);
    await logAction({ playerId, action: field === "xp" ? "XP manuale" : "Coin manuale", xpDelta: field === "xp" ? delta : 0, coinDelta: field === "coin" ? delta : 0 });
    setPlayers(prev => prev.map(x => x.id === playerId ? { ...x, [field]: newVal } : x));
  }

  async function applyBatch() {
    if (!selected.size) return;
    for (const id of [...selected]) {
      const p = players.find(x => x.id === id);
      if (!p) continue;
      await sb.from("profiles").update({ xp: p.xp + Number(batchXp), coin: p.coin + Number(batchCoin) }).eq("id", id);
      await logAction({ playerId: id, action: "Assegnazione batch", xpDelta: Number(batchXp), coinDelta: Number(batchCoin) });
    }
    setMsg(`+${batchXp} XP e +${batchCoin} coin assegnati a ${selected.size} giocatori`);
    setSelected(new Set()); load();
    setTimeout(() => setMsg(""), 3000);
  }

  async function savePlayer(p) {
    await sb.from("profiles").update({ display_name: p.display_name, squad_id: p.squad_id, xp: p.xp, coin: p.coin }).eq("id", p.id);
    setEditPlayer(null); load();
  }

  function toggleSelect(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label">Giocatori</div><div className="stat-value">{visible.length}</div></div>
        <div className="stat-card"><div className="stat-label">XP totali</div><div className="stat-value">{visible.reduce((a, p) => a + p.xp, 0).toLocaleString()}</div></div>
        <div className="stat-card"><div className="stat-label">Selezionati</div><div className="stat-value">{selected.size}</div></div>
        <div className="stat-card"><div className="stat-label">Squadre</div><div className="stat-value">{squads.length}</div></div>
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
        <input className="search-inp" placeholder="Cerca giocatore…" value={search} onChange={e => setSearch(e.target.value)} />
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
              const sq = p.squads?.name;
              return (
                <div key={p.id} className={`player-card ${selected.has(p.id) ? "selected" : ""}`} onClick={() => { toggleSelect(p.id); setExpandedPlayer(null); }}>
                  <div className="avatar-wrap" style={{ borderColor: SQUAD_STYLE[sq]?.bg || "var(--border2)" }}>
                    <Avatar url={p.avatar_url} emoji={lv.emoji} />
                  </div>
                  <div className="p-name">{p.display_name}</div>
                  <div className="p-level">{lv.emoji} {lv.name}</div>
                  <div className="p-xp">{p.xp} XP</div>
                  <div className="p-coin">🪙 {p.coin}</div>
                  {sq && <SquadPill name={sq} />}
                  <div className="pts-row" onClick={e => e.stopPropagation()}>
                    <button className="pts-btn rem" onClick={() => changeXP(p.id, -10)}>−</button>
                    <button className="pts-btn add" onClick={() => changeXP(p.id, 10)}>+</button>
                    <button className="pts-btn rem" style={{ fontSize: 10, width: 34, borderRadius: 8 }} onClick={() => changeXP(p.id, -5, "coin")}>🪙−</button>
                    <button className="pts-btn add" style={{ fontSize: 10, width: 34, borderRadius: 8 }} onClick={() => changeXP(p.id, 5, "coin")}>🪙+</button>
                  </div>
                  <button className="btn btn-ghost btn-xs" style={{ marginTop: 8, width: "100%" }} onClick={e => { e.stopPropagation(); setExpandedPlayer(expandedPlayer === p.id ? null : p.id); }}>
                    {expandedPlayer === p.id ? "▲ Chiudi" : "🔍 Dettagli"}
                  </button>
                  <button className="btn btn-ghost btn-xs" style={{ marginTop: 4, width: "100%" }} onClick={e => { e.stopPropagation(); setEditPlayer({ ...p }); }}>✏️ Modifica</button>
                </div>
              );
            })}
          </div>

          {/* Pannello dettaglio giocatore espandibile */}
          {expandedPlayer && (
            <PlayerDetailPanel playerId={expandedPlayer} squads={squads} onClose={() => setExpandedPlayer(null)} />
          )}
        </>
      )}

      {editPlayer && (
        <div className="modal-bg" onClick={() => setEditPlayer(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Modifica profilo</div>
            <AvatarUpload playerId={editPlayer.id} currentUrl={editPlayer.avatar_url} onUploaded={url => setEditPlayer(p => ({ ...p, avatar_url: url }))} />
            <div className="form-group">
              <label className="form-label">Nome</label>
              <input className="form-input" value={editPlayer.display_name} onChange={e => setEditPlayer(p => ({ ...p, display_name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Squadra</label>
              <select value={editPlayer.squad_id || ""} onChange={e => setEditPlayer(p => ({ ...p, squad_id: e.target.value || null }))}>
                <option value="">Nessuna squadra</option>
                {squads.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP</label><input className="form-input" type="number" value={editPlayer.xp} onChange={e => setEditPlayer(p => ({ ...p, xp: Number(e.target.value) }))} /></div>
              <div className="form-group"><label className="form-label">Coin</label><input className="form-input" type="number" value={editPlayer.coin} onChange={e => setEditPlayer(p => ({ ...p, coin: Number(e.target.value) }))} /></div>
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

// Pannello dettaglio giocatore (feature #4)
function PlayerDetailPanel({ playerId, squads, onClose }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("storia");

  useEffect(() => {
    async function load() {
      const [{ data: p }, { data: badges }, { data: att }, { data: notifs }] = await Promise.all([
        sb.from("profiles").select("*, squads(name)").eq("id", playerId).single(),
        sb.from("player_badges").select("*, badges(name,image_url)").eq("player_id", playerId).order("assigned_at", { ascending: false }),
        sb.from("attendances").select("*").eq("player_id", playerId).order("date", { ascending: false }).limit(20),
        sb.from("notifications").select("*").eq("user_id", playerId).order("created_at", { ascending: false }).limit(30),
      ]);
      setData({ profile: p, badges: badges || [], attendances: att || [], history: notifs || [] });
    }
    load();
  }, [playerId]);

  if (!data) return <div className="loading" style={{ minHeight: 80 }}>Caricamento dettagli…</div>;

  const { profile, badges, attendances, history } = data;
  const lv = getLevel(profile?.xp || 0);

  return (
    <div className="player-detail">
      <div className="player-detail-header">
        <div className="player-detail-av">
          <Avatar url={profile?.avatar_url} emoji={lv.emoji} size={64} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 24, fontWeight: 900, textTransform: "uppercase", color: "var(--text)" }}>{profile?.display_name}</div>
          <div style={{ fontSize: 12, color: "var(--azzurro)", fontWeight: 600 }}>{lv.emoji} {lv.name} · {profile?.xp} XP · 🪙 {profile?.coin}</div>
          {profile?.squads?.name && <SquadPill name={profile.squads.name} />}
        </div>
        <button className="btn btn-ghost btn-xs" onClick={onClose}>✕</button>
      </div>

      <div className="detail-tabs">
        {[["storia","📜 Storia"],["badge","🎖️ Badge"],["presenze","✅ Presenze"]].map(([id, label]) => (
          <button key={id} className={`detail-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === "storia" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
          {history.length === 0 && <div className="empty" style={{ padding: "20px" }}>Nessuna azione registrata.</div>}
          {history.map(n => (
            <div key={n.id} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontSize: 16 }}>📌</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{n.title}</div>
                <div style={{ fontSize: 12, color: "var(--text2)" }}>{n.body}</div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text3)", flexShrink: 0 }}>{new Date(n.created_at).toLocaleDateString("it-IT")}</div>
            </div>
          ))}
        </div>
      )}

      {tab === "badge" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {badges.length === 0 && <div className="empty" style={{ padding: "20px", width: "100%" }}>Nessun badge.</div>}
          {badges.map(pb => (
            <div key={pb.id} style={{ textAlign: "center", width: 70 }}>
              {pb.badges?.image_url ? <img src={pb.badges.image_url} style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", border: "2px solid var(--rosa)" }} alt={pb.badges?.name} /> : <div style={{ fontSize: 32 }}>🎖️</div>}
              <div style={{ fontSize: 10, color: "var(--text2)", marginTop: 4, lineHeight: 1.2 }}>{pb.badges?.name}</div>
            </div>
          ))}
        </div>
      )}

      {tab === "presenze" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 240, overflowY: "auto" }}>
          {attendances.length === 0 && <div className="empty" style={{ padding: "20px" }}>Nessuna presenza registrata.</div>}
          {attendances.map(a => {
            const icons = { full: "✅", partial: "🟡", completed: "⭐", none: "❌" };
            return (
              <div key={a.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontSize: 16 }}>{icons[a.status] || "—"}</span>
                <span style={{ flex: 1, fontSize: 13, color: "var(--text)" }}>{a.date}</span>
                <span style={{ fontSize: 12, color: "var(--azzurro)", fontWeight: 700 }}>+{a.xp_awarded || 0} XP</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LeaderboardView({ sectionColors, setSectionColors }) {
  const [players, setPlayers] = useState([]);
  const [squadFilter, setSquadFilter] = useState("all");
  const [squads, setSquads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => {
    async function load() {
      const { data } = await sb.from("profiles").select("*, squads(name)").eq("role", "player").order("xp", { ascending: false });
      const { data: sq } = await sb.from("squads").select("*");
      setPlayers(data || []); setSquads(sq || []); setLoading(false);
    }
    load();
  }, []);

  const visible = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);

  return (
    <div>
      <SectionBanner sectionKey="classifica" title="Classifica" sub={`${visible.length} giocatori`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div className="filter-bar">
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>)}
      </div>
      {loading ? <div className="loading">⏳ Caricamento…</div> : (
        <div className="lb-list">
          {visible.map((p, i) => {
            const lv = getLevel(p.xp);
            const medals = ["gold","silver","bronze"];
            return (
              <div key={p.id} className="lb-row">
                <span className={`lb-rank ${i < 3 ? medals[i] : ""}`}>{i < 3 ? ["1°","2°","3°"][i] : (i+1)+"°"}</span>
                <div className="lb-av"><Avatar url={p.avatar_url} emoji={lv.emoji} size={38} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="lb-name">{p.display_name}</div>
                  <div className="lb-level">{lv.emoji} {lv.name} {p.squads?.name && <SquadPill name={p.squads.name} />}</div>
                </div>
                <span className="lb-xp">{p.xp} XP</span>
              </div>
            );
          })}
        </div>
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
              <span className="squad-count">{players.filter(p => p.squad_id === s.id).length} giocatori</span>
              <button className="btn btn-danger btn-sm" onClick={() => deleteSquad(s.id)}>Elimina</button>
            </div>
          ))}
          {squads.length === 0 && <div className="empty">Nessuna squadra. Creane una!</div>}
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Nuova squadra</div>
            <div className="form-group">
              <label className="form-label">Nome</label>
              <input className="form-input" value={newSquad.name} onChange={e => setNewSquad(f => ({ ...f, name: e.target.value }))} placeholder="es. Rossa" />
            </div>
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
  const [players, setPlayers] = useState([]);
  const [squads, setSquads] = useState([]);
  const [attendances, setAttendances] = useState({});
  const [squadFilter, setSquadFilter] = useState("all");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(true);
  const [config] = useState({ xp_daily_checkin: 10, coin_daily_checkin: 5, xp_week_bonus: 50 });
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => {
    async function load() {
      const [{ data: pl }, { data: sq }, { data: att }] = await Promise.all([
        sb.from("profiles").select("*, squads(name)").eq("role","player").order("display_name"),
        sb.from("squads").select("*"),
        sb.from("attendances").select("*").eq("date", date).eq("check_type","daily"),
      ]);
      setPlayers(pl || []); setSquads(sq || []);
      const map = {}; (att || []).forEach(a => { map[a.player_id] = a; }); setAttendances(map);
      setLoading(false);
    }
    load();
  }, [date]);

  async function setStatus(playerId, status) {
    const existing = attendances[playerId];
    const xp = status === "none" ? 0 : config.xp_daily_checkin;
    const coin = status === "none" ? 0 : config.coin_daily_checkin;
    if (existing) {
      await sb.from("attendances").update({ status, xp_awarded: xp, coin_awarded: coin }).eq("id", existing.id);
    } else {
      await sb.from("attendances").insert({ player_id: playerId, date, check_type: "daily", status, xp_awarded: xp, coin_awarded: coin, qr_verified: false });
      if (status !== "none") await logAction({ playerId, action: "Presenza segnata", xpDelta: xp, coinDelta: coin });
    }
    setAttendances(prev => ({ ...prev, [playerId]: { ...existing, status, player_id: playerId } }));
  }

  const visible = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
  const presentCount = Object.values(attendances).filter(a => a.status !== "none").length;

  return (
    <div>
      <SectionBanner sectionKey="presenze" title="Presenze" sub={`${presentCount}/${visible.length} presenti`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label">Presenti</div><div className="stat-value">{presentCount}</div></div>
        <div className="stat-card"><div className="stat-label">Totale</div><div className="stat-value">{visible.length}</div></div>
        <div className="stat-card"><div className="stat-label">XP presenza</div><div className="stat-value">{config.xp_daily_checkin}</div></div>
        <div className="stat-card"><div className="stat-label">Bonus sett.</div><div className="stat-value">{config.xp_week_bonus}</div></div>
      </div>
      <div className="filter-bar">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ padding: 10, background: "var(--surface2)", border: "1.5px solid var(--border2)", borderRadius: 10, color: "var(--text)", fontSize: 14, flex: 1 }} />
        <button className="btn btn-yellow btn-sm" onClick={async () => { for (const p of visible) await setStatus(p.id, "full"); }}>✓ Tutti</button>
      </div>
      <div className="filter-bar">
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>)}
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div className="pres-wrap">
          <table className="pres-table">
            <thead><tr><th>Giocatore</th><th>Squadra</th><th>Stato</th><th>XP</th></tr></thead>
            <tbody>
              {visible.map(p => {
                const lv = getLevel(p.xp);
                const status = attendances[p.id]?.status || "none";
                return (
                  <tr key={p.id}>
                    <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar url={p.avatar_url} emoji={lv.emoji} size={28} /><span style={{ fontWeight: 600 }}>{p.display_name}</span></div></td>
                    <td>{p.squads?.name && <SquadPill name={p.squads.name} />}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[["none","?","pd-none"],["partial","~","pd-partial"],["full","✓","pd-yes"],["completed","★","pd-completed"]].map(([s, label, cls]) => (
                          <button key={s} className={`pres-dot ${cls}`} style={{ opacity: status === s ? 1 : 0.3 }} onClick={() => setStatus(p.id, s)}>{label}</button>
                        ))}
                      </div>
                    </td>
                    <td style={{ fontFamily: "'Barlow Condensed'", fontSize: 18, fontWeight: 900, color: "var(--azzurro)" }}>{p.xp}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {customizing && <BannerCustomizer sectionKey="presenze" sectionColors={sectionColors} setSectionColors={setSectionColors} onClose={() => setCustomizing(false)} />}
    </div>
  );
}

function ActivitiesView({ sectionColors, setSectionColors }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", duration_days: 4, xp_partial: 10, xp_full: 20, xp_completed: 35, coin_partial: 5, coin_full: 10, coin_completed: 18, coin_cost: 20, max_participants: "" });

  const load = useCallback(async () => {
    const { data } = await sb.from("activities").select("*").eq("is_active", true).order("created_at", { ascending: false });
    setActivities(data || []); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createActivity() {
    const { data } = await sb.from("activities").insert({ ...form, max_participants: form.max_participants || null }).select().single();
    if (data) { setActivities(prev => [data, ...prev]); setShowForm(false); }
  }

  async function deleteActivity(id) {
    if (!confirm("Eliminare?")) return;
    await sb.from("activities").update({ is_active: false }).eq("id", id);
    setActivities(prev => prev.filter(a => a.id !== id));
  }

  return (
    <div>
      <SectionBanner sectionKey="attivita" title="Attività" sub={`${activities.length} attive`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-yellow btn-sm" onClick={() => setShowForm(true)}>+ Nuova attività</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div className="act-grid">
          {activities.map(a => (
            <div key={a.id} className="act-card">
              <button className="delete-btn" onClick={() => deleteActivity(a.id)}>✕</button>
              <div className="act-title">{a.name}</div>
              <div className="act-meta">{a.description} · {a.duration_days}g</div>
              <div className="act-rewards">
                <span className="reward-tag xp-tag">Max {a.xp_completed} XP</span>
                <span className="reward-tag coin-tag">🪙 {a.coin_cost}</span>
              </div>
            </div>
          ))}
          {activities.length === 0 && <div className="empty">Nessuna attività. Creane una!</div>}
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Nuova attività</div>
            {[["name","Nome","text"],["description","Descrizione","text"],["duration_days","Durata (giorni)","number"],["coin_cost","Costo coin","number"],["max_participants","Max partecipanti (opt.)","number"]].map(([k, label, type]) => (
              <div className="form-group" key={k}><label className="form-label">{label}</label><input className="form-input" type={type} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} /></div>
            ))}
            <div className="section-label">XP per livello</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[["xp_partial","Parz."],["xp_full","Compl."],["xp_completed","Fine"]].map(([k,label]) => (
                <div key={k}><label className="form-label">{label}</label><input className="form-input" type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: Number(e.target.value) }))} /></div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createActivity}>Crea</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>Annulla</button>
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
  const [newBadge, setNewBadge] = useState({ name: "", xp_default: 20, coin_default: 10, image_url: null });
  const [uploadingBadge, setUploadingBadge] = useState(false);
  const badgeFileRef = useRef();

  const load = useCallback(async () => {
    const [{ data: b }, { data: p }] = await Promise.all([
      sb.from("badges").select("*").order("created_at", { ascending: false }),
      sb.from("profiles").select("id,display_name,xp,coin").eq("role","player").order("display_name"),
    ]);
    setBadges(b || []); setPlayers(p || []); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function uploadBadgeImage(e) {
    const file = e.target.files[0]; if (!file) return;
    setUploadingBadge(true);
    const ext = file.name.split(".").pop();
    const path = `badges/badge_${Date.now()}.${ext}`;
    await sb.storage.from("avatars").upload(path, file, { upsert: true });
    const { data } = sb.storage.from("avatars").getPublicUrl(path);
    setNewBadge(f => ({ ...f, image_url: data.publicUrl + "?t=" + Date.now() }));
    setUploadingBadge(false);
  }

  async function assignBadge() {
    if (!assignTarget || !showAssign) return;
    const badge = badges.find(b => b.id === showAssign);
    const player = players.find(p => p.id === assignTarget);
    await sb.from("player_badges").insert({ player_id: assignTarget, badge_id: showAssign, xp_awarded: Number(assignXp), coin_awarded: Number(assignCoin) });
    await sb.from("profiles").update({ xp: (player?.xp || 0) + Number(assignXp), coin: (player?.coin || 0) + Number(assignCoin) }).eq("id", assignTarget);
    await sb.from("notifications").insert({ user_id: assignTarget, type: "badge_assigned", title: `Badge: ${badge?.name}`, body: `+${assignXp} XP, +${assignCoin} Coin` });
    await logAction({ playerId: assignTarget, action: `Badge assegnato: ${badge?.name}`, xpDelta: Number(assignXp), coinDelta: Number(assignCoin) });
    setShowAssign(null);
  }

  async function createBadge() {
    const { data } = await sb.from("badges").insert(newBadge).select().single();
    if (data) { setBadges(prev => [data, ...prev]); setShowCreate(false); setNewBadge({ name: "", xp_default: 20, coin_default: 10, image_url: null }); }
  }

  async function deleteBadge(id) {
    if (!confirm("Eliminare?")) return;
    await sb.from("badges").delete().eq("id", id);
    setBadges(prev => prev.filter(b => b.id !== id));
  }

  return (
    <div>
      <SectionBanner sectionKey="badge" title="Badge" sub={`${badges.length} badge creati`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
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
          {badges.length === 0 && <div className="empty" style={{ gridColumn: "1/-1" }}>Nessun badge. Creane uno!</div>}
        </div>
      )}

      {showAssign && (
        <div className="modal-bg" onClick={() => setShowAssign(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Assegna badge</div>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              {badges.find(b => b.id === showAssign)?.image_url
                ? <img src={badges.find(b => b.id === showAssign).image_url} style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", border: "3px solid var(--rosa)" }} alt="" />
                : <span style={{ fontSize: 48 }}>🎖️</span>}
              <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 20, fontWeight: 900, textTransform: "uppercase", color: "var(--text)", marginTop: 6 }}>{badges.find(b => b.id === showAssign)?.name}</div>
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
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
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
            <div className="avatar-upload-area" onClick={() => badgeFileRef.current.click()}>
              <input ref={badgeFileRef} type="file" accept="image/*" onChange={uploadBadgeImage} style={{ display: "none" }} />
              {newBadge.image_url ? <img src={newBadge.image_url} className="avatar-preview" alt="badge" /> : <div style={{ fontSize: 40, marginBottom: 8 }}>🖼️</div>}
              <div style={{ fontSize: 13, color: "var(--text2)" }}>{uploadingBadge ? "Caricamento…" : "Carica immagine badge"}</div>
            </div>
            <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={newBadge.name} onChange={e => setNewBadge(f => ({ ...f, name: e.target.value }))} /></div>
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

// Sfida del giorno (feature #1)
function SfidaView({ sectionColors, setSectionColors }) {
  const [sfide, setSfide] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", xp_reward: 20, coin_reward: 10, expires_at: "" });

  const load = useCallback(async () => {
    const { data } = await sb.from("activities").select("*").eq("is_active", true).ilike("description", "%sfida%").order("created_at", { ascending: false }).limit(10);
    // Se non c'è una tabella sfide separata, usiamo le attività con tag sfida
    // Per ora mostriamo le ultime attività come sfide
    const { data: all } = await sb.from("activities").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(5);
    setSfide(all || []); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createSfida() {
    await sb.from("activities").insert({ name: form.title, description: "SFIDA · " + form.description, duration_days: 1, xp_full: Number(form.xp_reward), xp_completed: Number(form.xp_reward), xp_partial: Math.round(Number(form.xp_reward) / 2), coin_full: Number(form.coin_reward), coin_completed: Number(form.coin_reward), coin_partial: Math.round(Number(form.coin_reward) / 2), coin_cost: 0, is_active: true });
    setShowForm(false); load();
  }

  return (
    <div>
      <SectionBanner sectionKey="sfida" title="Sfida del Giorno" sub="Crea sfide a tempo per i tuoi giocatori" sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-yellow btn-sm" onClick={() => setShowForm(true)}>+ Nuova sfida</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sfide.map(s => (
            <div key={s.id} className="sfida-card">
              <div className="sfida-label">⚡ Sfida attiva</div>
              <div className="sfida-title">{s.name}</div>
              <div className="sfida-desc">{s.description?.replace("SFIDA · ", "")}</div>
              <span className="sfida-reward">🏆 +{s.xp_completed} XP · 🪙 +{s.coin_completed}</span>
            </div>
          ))}
          {sfide.length === 0 && <div className="empty">Nessuna sfida attiva. Creane una!</div>}
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Nuova sfida del giorno</div>
            <div className="form-group"><label className="form-label">Titolo sfida</label><input className="form-input" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="es. Corri 5 giri!" /></div>
            <div className="form-group"><label className="form-label">Descrizione</label><textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Descrivi la sfida..." /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP premio</label><input className="form-input" type="number" value={form.xp_reward} onChange={e => setForm(f => ({ ...f, xp_reward: e.target.value }))} /></div>
              <div className="form-group"><label className="form-label">Coin premio</label><input className="form-input" type="number" value={form.coin_reward} onChange={e => setForm(f => ({ ...f, coin_reward: e.target.value }))} /></div>
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

// Diario giornate (educator-only)
function DiaryView() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState("");

  useEffect(() => {
    async function load() {
      let q = sb.from("notifications").select("*, profiles(display_name, avatar_url)").order("created_at", { ascending: false }).limit(200);
      if (dateFilter) {
        q = q.gte("created_at", dateFilter + "T00:00:00").lte("created_at", dateFilter + "T23:59:59");
      }
      const { data } = await q;
      setEntries(data || []); setLoading(false);
    }
    load();
  }, [dateFilter]);

  // Raggruppa per data
  const grouped = {};
  entries.forEach(e => {
    const d = e.created_at?.split("T")[0] || "?";
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(e);
  });

  const typeIcon = { badge_assigned: "🎖️", booking_confirmed: "✅", booking_rejected: "❌", log_action: "📌", xp_manual: "⭐", default: "🔔" };

  return (
    <div>
      <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 32, fontWeight: 900, textTransform: "uppercase", color: "var(--azzurro)", marginBottom: 16, letterSpacing: "-0.5px" }}>📜 Diario giornate</div>
      <div className="filter-bar">
        <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} style={{ padding: 10, background: "var(--surface2)", border: "1.5px solid var(--border2)", borderRadius: 10, color: "var(--text)", fontSize: 14, flex: 1 }} />
        {dateFilter && <button className="btn btn-ghost btn-sm" onClick={() => setDateFilter("")}>✕ Tutto</button>}
      </div>
      {loading ? <div className="loading">⏳ Caricamento…</div> : (
        Object.keys(grouped).length === 0
          ? <div className="empty">Nessuna azione registrata.</div>
          : Object.entries(grouped).map(([date, dayEntries]) => (
            <div key={date} className="diary-day">
              <div className="diary-date">{new Date(date).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}</div>
              {dayEntries.filter(e => e.profiles).map(e => (
                <div key={e.id} className="diary-entry">
                  <span className="diary-icon">{typeIcon[e.type] || typeIcon.default}</span>
                  <div className="diary-text">
                    <strong>{e.profiles?.display_name}</strong> · {e.title}
                    {e.body && <span style={{ color: "var(--text2)", marginLeft: 4 }}>{e.body}</span>}
                  </div>
                  <div className="diary-pts">{new Date(e.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</div>
                </div>
              ))}
            </div>
          ))
      )}
    </div>
  );
}

function MessagesView({ profile }) {
  const threads = [
    { id: "verde", name: "Squadra Verde" }, { id: "gialla", name: "Squadra Gialla" },
    { id: "azzurra", name: "Squadra Azzurra" }, { id: "tutti", name: "Tutti" },
  ];
  const [active, setActive] = useState(threads[0]);
  const [msgs, setMsgs] = useState([{ id: 1, body: "Benvenuto nella chat! 🌿", mine: false }]);
  const [input, setInput] = useState("");

  function send() {
    if (!input.trim()) return;
    setMsgs(prev => [...prev, { id: Date.now(), body: input, mine: true }]);
    setInput("");
  }

  return (
    <div className="msg-layout">
      <div className="msg-list">
        {threads.map(t => <div key={t.id} className={`msg-thread ${active.id === t.id ? "active" : ""}`} onClick={() => setActive(t)}><div className="mt-name">{t.name}</div></div>)}
      </div>
      <div className="msg-main">
        <div className="msg-hdr">{active.name}</div>
        <div className="msg-body">
          {msgs.map(m => <div key={m.id} className={`bubble-wrap ${m.mine ? "mine" : ""}`}><div className="bubble-av">{m.mine ? "👑" : "🌿"}</div><div className={`bubble ${m.mine ? "mine" : "them"}`}>{m.body}</div></div>)}
        </div>
        <div className="msg-inp-row">
          <input className="msg-inp" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Scrivi…" />
          <button className="btn btn-yellow btn-sm" onClick={send}>Invia</button>
        </div>
      </div>
    </div>
  );
}

function BookingsView() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await sb.from("bookings").select("*, profiles(display_name), activities(name,coin_cost)").order("created_at", { ascending: false });
      setBookings(data || []); setLoading(false);
    }
    load();
  }, []);

  async function review(id, status, playerId, coinHeld) {
    await sb.from("bookings").update({ status, reviewed_at: new Date().toISOString() }).eq("id", id);
    if (status === "rejected") {
      const { data: p } = await sb.from("profiles").select("coin").eq("id", playerId).single();
      await sb.from("profiles").update({ coin: (p?.coin || 0) + coinHeld }).eq("id", playerId);
    }
    await sb.from("notifications").insert({ user_id: playerId, type: status === "confirmed" ? "booking_confirmed" : "booking_rejected", title: status === "confirmed" ? "Prenotazione confermata!" : "Prenotazione rifiutata", body: status === "confirmed" ? "Sei dentro!" : "Coin restituite." });
    setBookings(prev => prev.map(b => b.id === id ? { ...b, status } : b));
  }

  const statusTag = { pending: ["tag-amber","In attesa"], confirmed: ["tag-green","Confermata"], rejected: ["tag-red","Rifiutata"], cancelled: ["tag-gray","Annullata"] };

  return (
    <div>
      {loading ? <div className="loading">⏳</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {bookings.map(b => {
            const [tc, tl] = statusTag[b.status] || ["tag-gray", b.status];
            return (
              <div key={b.id} className="card-sm">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{b.profiles?.display_name}</div>
                    <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>{b.activities?.name} · 🪙 {b.coin_held}</div>
                  </div>
                  <span className={`tag ${tc}`}>{tl}</span>
                </div>
                {b.status === "pending" && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-sm" style={{ flex: 1, background: "rgba(51,153,102,.15)", color: "var(--verde)", border: "1px solid rgba(51,153,102,.3)" }} onClick={() => review(b.id, "confirmed", b.player_id, b.coin_held)}>✓ Conferma</button>
                    <button className="btn btn-danger btn-sm" style={{ flex: 1 }} onClick={() => review(b.id, "rejected", b.player_id, b.coin_held)}>✗ Rifiuta</button>
                  </div>
                )}
              </div>
            );
          })}
          {bookings.length === 0 && <div className="empty">Nessuna prenotazione</div>}
        </div>
      )}
    </div>
  );
}

function QrView() {
  const [qr, setQr] = useState(null);
  const [loading, setLoading] = useState(true);
  const today = new Date().toISOString().split("T")[0];

  useEffect(() => {
    sb.from("daily_qr").select("*").eq("date", today).single().then(({ data }) => { setQr(data); setLoading(false); });
  }, [today]);

  async function generateQr() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const vf = new Date(); vf.setHours(8, 0, 0, 0);
    const vu = new Date(); vu.setHours(18, 0, 0, 0);
    const { data } = await sb.from("daily_qr").upsert({ date: today, code, valid_from: vf.toISOString(), valid_until: vu.toISOString() }).select().single();
    setQr(data);
  }

  return (
    <div className="card" style={{ maxWidth: 400, margin: "0 auto", textAlign: "center" }}>
      <div style={{ padding: "24px 0" }}>
        <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 13, fontWeight: 900, textTransform: "uppercase", color: "var(--text2)", letterSpacing: ".1em", marginBottom: 4 }}>QR Check-in</div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 24 }}>{today}</div>
        {loading ? <div className="loading">⏳</div> : qr ? (
          <>
            <div style={{ background: "var(--surface2)", borderRadius: 16, padding: "24px 32px", marginBottom: 16, display: "inline-block", border: "1.5px solid var(--border2)" }}>
              <div className="qr-code">{qr.code}</div>
            </div>
            <div style={{ fontSize: 13, color: "var(--text2)" }}>Valido {new Date(qr.valid_from).getHours()}:00 – {new Date(qr.valid_until).getHours()}:00</div>
            <button className="btn btn-ghost" style={{ marginTop: 16, width: "100%" }} onClick={generateQr}>Rigenera</button>
          </>
        ) : (
          <>
            <div style={{ color: "var(--text3)", fontSize: 14, marginBottom: 24 }}>Nessun codice per oggi</div>
            <button className="btn btn-primary" onClick={generateQr}>Genera QR di oggi</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── PLAYER DASHBOARD ─────────────────────────────────────

function PlayerDashboard({ profile, onLogout, sectionColors, theme }) {
  const [tab, setTab] = useState("profilo");
  const [fullProfile, setFullProfile] = useState(null);
  const [badges, setBadges] = useState([]);
  const [activities, setActivities] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [qrInput, setQrInput] = useState("");
  const [qrMsg, setQrMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [savingName, setSavingName] = useState(false);

  const load = useCallback(async () => {
    const [{ data: p }, { data: b }, { data: a }, { data: bk }, { data: n }] = await Promise.all([
      sb.from("profiles").select("*, squads(name)").eq("id", profile.id).single(),
      sb.from("player_badges").select("*, badges(name,image_url,xp_default)").eq("player_id", profile.id).order("assigned_at", { ascending: false }),
      sb.from("activities").select("*").eq("is_active", true).order("created_at", { ascending: false }),
      sb.from("bookings").select("*, activities(name)").eq("player_id", profile.id).order("created_at", { ascending: false }),
      sb.from("notifications").select("*").eq("user_id", profile.id).neq("type", "log_action").order("created_at", { ascending: false }).limit(20),
    ]);
    setFullProfile(p); setBadges(b || []); setActivities(a || []); setBookings(bk || []); setNotifications(n || []);
    setLoading(false);
  }, [profile.id]);

  // Realtime (feature #6)
  useEffect(() => {
    load();
    const channel = sb.channel("player_" + profile.id)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${profile.id}` }, () => { load(); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${profile.id}` }, () => { load(); })
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [profile.id, load]);

  async function doCheckin() {
    const today = new Date().toISOString().split("T")[0];
    const { data: qr } = await sb.from("daily_qr").select("*").eq("date", today).single();
    if (!qr) { setQrMsg("Nessun QR attivo oggi."); return; }
    if (qrInput.toUpperCase() !== qr.code) { setQrMsg("❌ Codice non valido."); return; }
    const now = new Date();
    if (now < new Date(qr.valid_from) || now > new Date(qr.valid_until)) { setQrMsg("⏰ Codice scaduto."); return; }
    const { error } = await sb.from("attendances").insert({ player_id: profile.id, date: today, check_type: "daily", status: "full", xp_awarded: 10, coin_awarded: 5, qr_verified: true });
    if (error?.code === "23505") { setQrMsg("Hai già fatto il check-in oggi!"); return; }
    await sb.from("profiles").update({ xp: (fullProfile?.xp || 0) + 10, coin: (fullProfile?.coin || 0) + 5 }).eq("id", profile.id);
    setQrMsg("✅ Check-in! +10 XP, +5 Coin");
    setFullProfile(prev => ({ ...prev, xp: (prev?.xp || 0) + 10, coin: (prev?.coin || 0) + 5 }));
  }

  async function bookActivity(actId, cost) {
    if ((fullProfile?.coin || 0) < cost) { alert("Coin insufficienti!"); return; }
    await sb.from("bookings").insert({ player_id: profile.id, activity_id: actId, coin_held: cost });
    await sb.from("profiles").update({ coin: (fullProfile?.coin || 0) - cost }).eq("id", profile.id);
    setFullProfile(prev => ({ ...prev, coin: (prev?.coin || 0) - cost }));
    alert("✅ Prenotazione inviata!");
  }

  async function saveName() {
    if (!newName.trim() || newName.length > 30) return;
    setSavingName(true);
    await sb.from("profiles").update({ display_name: newName.trim() }).eq("id", profile.id);
    setFullProfile(prev => ({ ...prev, display_name: newName.trim() }));
    setEditingName(false); setSavingName(false);
  }

  const lv = getLevel(fullProfile?.xp || 0);
  const unread = notifications.filter(n => !n.read_at).length;

  const PLAYER_TABS = [
    ["profilo","👤","Profilo"],
    ["checkin","📍","Check-in"],
    ["attivita","⚡","Attività"],
    ["badge","🎖️","Badge"],
    ["notifiche","🔔",""],
  ];

  if (loading) return <div className="loading" style={{ minHeight: "100vh" }}>🌿 Caricamento…</div>;

  return (
    <div style={{ background: "var(--nero)", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 58, background: "var(--nero)", borderBottom: "1px solid var(--border)", zIndex: 20, display: "flex", alignItems: "center", padding: "0 16px", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", overflow: "hidden", border: "2.5px solid var(--azzurro)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Avatar url={fullProfile?.avatar_url} emoji={lv.emoji} size={36} />
          </div>
          <div>
            <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 18, fontWeight: 900, textTransform: "uppercase", color: "var(--text)", lineHeight: 1 }}>{fullProfile?.display_name}</div>
            <div style={{ fontSize: 11, color: "var(--azzurro)", fontWeight: 600 }}>{lv.emoji} {lv.name}</div>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onLogout}>Esci</button>
      </div>

      {/* Contenuto */}
      <div style={{ paddingTop: 66, paddingBottom: "calc(70px + env(safe-area-inset-bottom,0px))", padding: "70px 14px calc(70px + env(safe-area-inset-bottom,0px))" }}>

        {/* PROFILO */}
        {tab === "profilo" && fullProfile && (
          <>
            <div className="profile-hero">
              <div className="profile-avatar"><Avatar url={fullProfile.avatar_url} emoji={lv.emoji} size={90} /></div>
              <div className="profile-name">{fullProfile.display_name}</div>
              <div className="profile-level">{lv.emoji} {lv.name}</div>
              {fullProfile.squads?.name && <SquadPill name={fullProfile.squads.name} />}
              <div style={{ marginTop: 16, position: "relative" }}><XpBar xp={fullProfile.xp} /></div>
              <div style={{ display: "flex", justifyContent: "center", gap: 32, marginTop: 18 }}>
                <div style={{ textAlign: "center" }}><div style={{ fontFamily: "'Barlow Condensed'", fontSize: 28, fontWeight: 900, color: "var(--azzurro)" }}>{fullProfile.xp}</div><div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>XP</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontFamily: "'Barlow Condensed'", fontSize: 28, fontWeight: 900, color: "var(--giallo)" }}>🪙 {fullProfile.coin}</div><div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>Coin</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontFamily: "'Barlow Condensed'", fontSize: 28, fontWeight: 900, color: "var(--rosa)" }}>{badges.length}</div><div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>Badge</div></div>
              </div>
            </div>

            {/* Modifica nome (unica cosa editabile) */}
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>Il tuo nome in gioco</div>
              {editingName ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="form-input" value={newName} onChange={e => setNewName(e.target.value.slice(0, 30))} placeholder="Inserisci nome…" style={{ flex: 1 }} maxLength={30} autoFocus />
                  <button className="btn btn-yellow btn-sm" onClick={saveName} disabled={savingName || !newName.trim()}>{savingName ? "…" : "Salva"}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingName(false)}>✕</button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontFamily: "'Barlow Condensed'", fontSize: 22, fontWeight: 900, textTransform: "uppercase", color: "var(--text)" }}>{fullProfile.display_name}</span>
                  <button className="btn btn-ghost btn-xs" onClick={() => { setNewName(fullProfile.display_name); setEditingName(true); }}>✏️ Modifica</button>
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 6 }}>Puoi cambiare solo il tuo nome · Max 30 caratteri</div>
            </div>

            {/* Badge nel profilo */}
            {badges.length > 0 && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>I tuoi badge</div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {badges.map(pb => (
                    <div key={pb.id} style={{ textAlign: "center", width: 64 }}>
                      {pb.badges?.image_url
                        ? <img src={pb.badges.image_url} style={{ width: 52, height: 52, borderRadius: "50%", objectFit: "cover", border: "2.5px solid var(--rosa)", display: "block", margin: "0 auto 4px" }} alt={pb.badges?.name} />
                        : <div style={{ fontSize: 36, marginBottom: 4 }}>🎖️</div>}
                      <div style={{ fontSize: 10, color: "var(--text2)", lineHeight: 1.2, fontWeight: 600 }}>{pb.badges?.name}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Prenotazioni recenti */}
            {bookings.length > 0 && (
              <>
                <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 14, fontWeight: 900, textTransform: "uppercase", color: "var(--text3)", letterSpacing: ".08em", marginBottom: 8 }}>Prenotazioni</div>
                {bookings.slice(0, 5).map(b => {
                  const s = { pending: ["tag-amber","In attesa"], confirmed: ["tag-green","Confermata"], rejected: ["tag-red","Rifiutata"] };
                  const [cls, label] = s[b.status] || ["tag-gray", b.status];
                  return <div key={b.id} className="card-sm" style={{ marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 13, fontWeight: 600 }}>{b.activities?.name}</span><span className={`tag ${cls}`}>{label}</span></div>;
                })}
              </>
            )}
          </>
        )}

        {/* CHECK-IN */}
        {tab === "checkin" && (
          <div className="card" style={{ marginTop: 8 }}>
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <div style={{ fontSize: 60, marginBottom: 12 }}>📍</div>
              <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 32, fontWeight: 900, textTransform: "uppercase", color: "var(--text)", marginBottom: 6 }}>Check-in</div>
              <div style={{ fontSize: 14, color: "var(--text2)", marginBottom: 28 }}>Inserisci il codice mostrato in loco</div>
              <input className="form-input" value={qrInput} onChange={e => setQrInput(e.target.value.toUpperCase())} placeholder="ABC123" style={{ textAlign: "center", fontFamily: "'Barlow Condensed'", fontSize: 36, fontWeight: 900, letterSpacing: 10, marginBottom: 16 }} maxLength={6} />
              <button className="btn btn-primary" onClick={doCheckin}>Conferma presenza</button>
              {qrMsg && <div style={{ marginTop: 16, fontSize: 15, fontWeight: 700, color: qrMsg.includes("✅") ? "var(--verde)" : "var(--danger)" }}>{qrMsg}</div>}
              <div style={{ marginTop: 24, display: "flex", justifyContent: "center", gap: 20 }}>
                <div style={{ textAlign: "center" }}><div style={{ fontFamily: "'Barlow Condensed'", fontSize: 28, fontWeight: 900, color: "var(--azzurro)" }}>+10</div><div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>XP</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontFamily: "'Barlow Condensed'", fontSize: 28, fontWeight: 900, color: "var(--giallo)" }}>+5</div><div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Coin</div></div>
              </div>
            </div>
          </div>
        )}

        {/* ATTIVITÀ + SFIDE */}
        {tab === "attivita" && (
          <div style={{ marginTop: 8 }}>
            {/* Sfida del giorno in evidenza */}
            {activities.filter(a => a.description?.includes("SFIDA")).map(s => (
              <div key={s.id} className="sfida-card" style={{ marginBottom: 14 }}>
                <div className="sfida-label">⚡ Sfida del giorno</div>
                <div className="sfida-title">{s.name}</div>
                <div className="sfida-desc">{s.description?.replace("SFIDA · ", "")}</div>
                <span className="sfida-reward">🏆 +{s.xp_completed} XP · 🪙 +{s.coin_completed}</span>
              </div>
            ))}
            {activities.filter(a => !a.description?.includes("SFIDA")).map(a => (
              <div key={a.id} className="act-card" style={{ marginBottom: 10 }}>
                <div className="act-title">{a.name}</div>
                <div className="act-meta">{a.description} · {a.duration_days} giorni</div>
                <div className="act-rewards">
                  <span className="reward-tag xp-tag">Fino a {a.xp_completed} XP</span>
                  <span className="reward-tag coin-tag">🪙 {a.coin_cost}</span>
                </div>
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 12, width: "100%" }} onClick={() => bookActivity(a.id, a.coin_cost)} disabled={a.coin_cost > (fullProfile?.coin || 0)}>
                  {a.coin_cost > (fullProfile?.coin || 0) ? "🪙 Coin insufficienti" : "Prenota"}
                </button>
              </div>
            ))}
            {activities.length === 0 && <div className="empty">Nessuna attività disponibile.</div>}
          </div>
        )}

        {/* BADGE */}
        {tab === "badge" && (
          <div style={{ marginTop: 8 }}>
            <SectionBanner sectionKey="badge" title="I tuoi badge" sub={`${badges.length} badge conquistati`} sectionColors={sectionColors} />
            {badges.length === 0 ? <div className="empty">Nessun badge ancora. Continua così!</div> : (
              <div className="badge-grid">
                {badges.map(pb => (
                  <div key={pb.id} className="badge-card">
                    {pb.badges?.image_url ? <img className="badge-img" src={pb.badges.image_url} alt={pb.badges?.name} /> : <span className="badge-emoji">🎖️</span>}
                    <div className="badge-name">{pb.badges?.name}</div>
                    <div className="badge-pts">+{pb.xp_awarded} XP</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* NOTIFICHE */}
        {tab === "notifiche" && (
          <div style={{ marginTop: 8 }}>
            {notifications.length === 0 ? <div className="empty">Nessuna notifica.</div> : notifications.map(n => {
              const icons = { badge_assigned: "🎖️", booking_confirmed: "✅", booking_rejected: "❌", new_activity: "⚡", level_up: "🆙", week_bonus: "🏆" };
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
      </div>

      {/* Bottom nav giocatore */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "var(--nero)", borderTop: "1px solid var(--border)", zIndex: 20, display: "flex", paddingBottom: "env(safe-area-inset-bottom,0px)" }}>
        {PLAYER_TABS.map(([id, icon, badge]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "10px 0", background: "none", border: "none", cursor: "pointer", color: tab === id ? "var(--azzurro)" : "var(--text3)", fontFamily: "'Funnel Display'", position: "relative" }}>
            <span style={{ fontSize: 22 }}>{icon}</span>
            {id === "notifiche" && unread > 0 && <span style={{ position: "absolute", top: 6, right: "calc(50% - 18px)", background: "var(--rosa)", color: "#fff", borderRadius: 99, fontSize: 9, fontWeight: 700, padding: "1px 5px" }}>{unread}</span>}
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>{["Profilo","Check-in","Attività","Badge","Notifiche"][["profilo","checkin","attivita","badge","notifiche"].indexOf(id)]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── EDUCATOR SHELL ───────────────────────────────────────

const EDUCATOR_TABS = [
  ["giocatori","👤","Giocatori"],
  ["classifica","🏆","Classifica"],
  ["squadre","🛡️","Squadre"],
  ["presenze","✅","Presenze"],
  ["attivita","⚡","Attività"],
  ["sfida","🔥","Sfida"],
  ["badge","🎖️","Badge"],
  ["prenotazioni","📋","Prenotazioni"],
  ["messaggi","💬","Messaggi"],
  ["diario","📜","Diario"],
  ["qr","📍","QR"],
];

const MOB_TABS_IDS = ["giocatori", "presenze", "classifica", "sfida", "qr"];

function EducatorShell({ profile, onLogout }) {
  const [tab, setTab] = useState("giocatori");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url);
  const [theme, setTheme] = useState("dark");
  const [sectionColors, setSectionColors] = useState(DEFAULT_SECTION_COLORS);

  const cur = EDUCATOR_TABS.find(t => t[0] === tab);
  const lv = getLevel(profile.xp || 0);
  const mobTabs = EDUCATOR_TABS.filter(t => MOB_TABS_IDS.includes(t[0]));

  // Theme toggle (feature #5)
  useEffect(() => {
    document.body.classList.toggle("light", theme === "light");
  }, [theme]);

  function goTo(id) { setTab(id); setDrawerOpen(false); }

  const sharedProps = { sectionColors, setSectionColors };

  return (
    <div className="edu-layout">
      {/* Sidebar desktop */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-title">Per·You Garden</div>
          <div className="sidebar-logo-sub">Pannello educatore</div>
        </div>
        <nav className="nav">
          {EDUCATOR_TABS.map(([id, icon, label]) => (
            <div key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <span className="nav-icon">{icon}</span><span>{label}</span>
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }} onClick={() => setShowAvatarModal(true)}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", overflow: "hidden", border: "2.5px solid var(--azzurro)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Avatar url={avatarUrl} emoji={lv.emoji} size={36} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{profile.display_name}</div>
              <div style={{ fontSize: 11, color: "var(--text3)" }}>{profile.role}</div>
            </div>
          </div>
          {/* Theme toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--text3)" }}>{theme === "dark" ? "🌙" : "☀️"}</span>
            <button className="theme-toggle" style={{ background: theme === "light" ? "var(--azzurro)" : "var(--surface3)" }} onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>
              <div className="theme-toggle-knob" style={{ transform: theme === "light" ? "translateX(20px)" : "translateX(0)" }} />
            </button>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ width: "100%" }} onClick={onLogout}>Esci</button>
        </div>
      </div>

      {/* Header mobile */}
      <div className="mob-header">
        <button onClick={() => setDrawerOpen(true)} style={{ background: "none", border: "none", color: "var(--text2)", fontSize: 24, cursor: "pointer", padding: 4, lineHeight: 1 }}>☰</button>
        <span className="mob-header-title">{cur?.[2]}</span>
        <button className="theme-toggle" style={{ background: theme === "light" ? "var(--azzurro)" : "var(--surface3)", width: 38, height: 22 }} onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>
          <div className="theme-toggle-knob" style={{ width: 16, height: 16, transform: theme === "light" ? "translateX(16px)" : "translateX(0)" }} />
        </button>
        <div style={{ width: 36, height: 36, borderRadius: "50%", overflow: "hidden", border: "2.5px solid var(--azzurro)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowAvatarModal(true)}>
          <Avatar url={avatarUrl} emoji={lv.emoji} size={36} />
        </div>
      </div>

      {/* Drawer mobile */}
      {drawerOpen && <div className="mob-drawer-bg" onClick={() => setDrawerOpen(false)} />}
      <div className={`mob-drawer ${drawerOpen ? "open" : ""}`}>
        <div style={{ padding: "22px 20px 16px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 24, fontWeight: 900, textTransform: "uppercase", color: "var(--azzurro)" }}>Per·You Garden</div>
        </div>
        <nav style={{ flex: 1, padding: "10px 0", overflowY: "auto" }}>
          {EDUCATOR_TABS.map(([id, icon, label]) => (
            <div key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => goTo(id)}>
              <span className="nav-icon">{icon}</span><span>{label}</span>
            </div>
          ))}
        </nav>
        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, cursor: "pointer" }} onClick={() => { setShowAvatarModal(true); setDrawerOpen(false); }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", overflow: "hidden", border: "2.5px solid var(--azzurro)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Avatar url={avatarUrl} emoji={lv.emoji} size={36} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{profile.display_name}</div>
              <div style={{ fontSize: 11, color: "var(--text3)" }}>{profile.role}</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ width: "100%" }} onClick={onLogout}>Esci</button>
        </div>
      </div>

      {/* Main */}
      <div className="edu-main">
        <div className="topbar">
          <div className="topbar-title">{cur?.[1]} {cur?.[2]}</div>
        </div>
        <div className="content edu-content-wrap">
          {tab === "giocatori"    && <PlayersView profile={profile} {...sharedProps} />}
          {tab === "classifica"   && <LeaderboardView {...sharedProps} />}
          {tab === "squadre"      && <SquadsView />}
          {tab === "presenze"     && <AttendanceView {...sharedProps} />}
          {tab === "attivita"     && <ActivitiesView {...sharedProps} />}
          {tab === "sfida"        && <SfidaView {...sharedProps} />}
          {tab === "badge"        && <BadgesView {...sharedProps} />}
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
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em" }}>{label}</span>
            </button>
          ))}
          <button className={`mob-nav-btn ${!MOB_TABS_IDS.includes(tab) ? "active" : ""}`} onClick={() => setDrawerOpen(true)}>
            <span style={{ fontSize: 22 }}>⋯</span>
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" }}>Altro</span>
          </button>
        </div>
      </div>

      {/* Avatar modal */}
      {showAvatarModal && (
        <div className="modal-bg" onClick={() => setShowAvatarModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Il tuo avatar</div>
            <AvatarUpload playerId={profile.id} currentUrl={avatarUrl} onUploaded={url => setAvatarUrl(url)} />
            <button className="btn btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => setShowAvatarModal(false)}>Chiudi</button>
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
  const [sectionColors] = useState(DEFAULT_SECTION_COLORS);

  useEffect(() => {
    sb.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        const { data: p } = await sb.from("profiles").select("*, squads(name)").eq("id", session.user.id).single();
        setProfile(p || { id: session.user.id, role: "educator", display_name: session.user.email?.split("@")[0], xp: 0, coin: 100 });
      }
      setChecking(false);
    });
    const { data: { subscription } } = sb.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") setProfile(null);
      if (event === "SIGNED_IN" && session) {
        const { data: p } = await sb.from("profiles").select("*, squads(name)").eq("id", session.user.id).single();
        if (p) setProfile(p);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  async function onLogout() {
    await sb.auth.signOut();
    setProfile(null);
    document.body.classList.remove("light");
  }

  if (checking) return (
    <>
      <style>{css}</style>
      <div className="loading" style={{ minHeight: "100vh" }}>
        <span style={{ fontFamily: "'Barlow Condensed'", fontSize: 28, fontWeight: 900, textTransform: "uppercase", color: "var(--azzurro)" }}>Per·You Garden</span>
      </div>
    </>
  );

  return (
    <>
      <style>{css}</style>
      {!profile
        ? <Login onLogin={setProfile} />
        : profile.role === "player"
          ? <PlayerDashboard profile={profile} onLogout={onLogout} sectionColors={sectionColors} />
          : <EducatorShell profile={profile} onLogout={onLogout} />
      }
    </>
  );
}
