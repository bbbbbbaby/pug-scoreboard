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

const SQUAD_STYLE = {
  Verde:   { bg: "#339966", text: "#fff" },
  Gialla:  { bg: "#FDEF26", text: "#101010" },
  Azzurra: { bg: "#A3CFFE", text: "#101010" },
};

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
  @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&display=swap');

  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  html,body { height:100%; }
  body { font-family:'Funnel Display',sans-serif; background:#04080f; color:#e8f4ff; min-height:100vh; -webkit-font-smoothing:antialiased; }

  :root {
    --azzurro:#A3CFFE; --rosa:#FF6DEC; --giallo:#FDEF26; --verde:#339966; --rosso:#D41323;
    --neon-blue:#00d4ff; --neon-pink:#ff00cc; --neon-gold:#ffcc00; --neon-green:#00ff88;
    --nero:#04080f; --bianco:#FFFFFF;
    --surface:rgba(10,20,40,0.9); --surface2:rgba(15,28,55,0.85); --surface3:rgba(20,38,70,0.8);
    --border:rgba(0,212,255,0.12); --border2:rgba(0,212,255,0.22);
    --text:#e8f4ff; --text2:#7da8d0; --text3:#3a6080;
    --accent:#00d4ff; --accent2:#00ff88;
    --danger:#ff2244; --warning:#ffcc00;
    --radius:14px; --radius-sm:10px; --radius-lg:20px;
    --glow-blue:0 0 20px rgba(0,212,255,0.4), 0 0 60px rgba(0,212,255,0.15);
    --glow-pink:0 0 20px rgba(255,0,204,0.4), 0 0 60px rgba(255,0,204,0.15);
    --glow-gold:0 0 20px rgba(255,204,0,0.5), 0 0 60px rgba(255,204,0,0.15);
    --glow-green:0 0 20px rgba(0,255,136,0.4);
  }

  /* ═══ GLOBAL GAME BG ═══ */
  body::before {
    content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
    background:
      radial-gradient(ellipse 80% 50% at 20% -10%, rgba(0,100,200,0.25) 0%, transparent 60%),
      radial-gradient(ellipse 60% 40% at 90% 110%, rgba(180,0,150,0.2) 0%, transparent 55%),
      radial-gradient(ellipse 50% 60% at 50% 50%, rgba(0,20,60,0.5) 0%, transparent 70%),
      #04080f;
  }
  body::after {
    content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:
      linear-gradient(rgba(0,212,255,0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,212,255,0.03) 1px, transparent 1px);
    background-size:40px 40px;
  }

  /* ═══ LOGIN ═══ */
  .login-wrap { display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; position:relative; z-index:1; }
  .login-card {
    background:rgba(5,15,35,0.95); border:1px solid rgba(0,212,255,0.3);
    border-radius:20px; padding:36px 28px; width:100%; max-width:420px;
    box-shadow:0 0 0 1px rgba(0,212,255,0.08), var(--glow-blue), 0 40px 80px rgba(0,0,0,0.8);
    backdrop-filter:blur(20px); position:relative; overflow:hidden;
  }
  .login-card::before {
    content:''; position:absolute; top:0; left:0; right:0; height:2px;
    background:linear-gradient(90deg, transparent, var(--neon-blue), var(--neon-pink), transparent);
  }
  .login-title {
    font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:56px;
    text-transform:uppercase; letter-spacing:-1px; line-height:0.9;
    background:linear-gradient(135deg, var(--neon-blue) 0%, #fff 40%, var(--rosa) 100%);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
    text-align:center; margin-bottom:8px; filter:drop-shadow(0 0 20px rgba(0,212,255,0.3));
  }
  .login-sub { font-size:12px; color:var(--text3); text-align:center; margin-bottom:28px; letter-spacing:.15em; text-transform:uppercase; }
  .login-tabs { display:flex; background:rgba(0,212,255,0.05); border:1px solid var(--border); border-radius:12px; padding:4px; margin-bottom:24px; gap:4px; }
  .login-tab { flex:1; padding:10px; border-radius:9px; border:none; cursor:pointer; font-family:'Funnel Display'; font-size:13px; font-weight:700; background:transparent; color:var(--text2); transition:all .2s; }
  .login-tab.active { background:linear-gradient(135deg, rgba(0,212,255,0.2), rgba(0,212,255,0.08)); color:var(--neon-blue); border:1px solid rgba(0,212,255,0.3); box-shadow:var(--glow-blue); }
  .form-group { margin-bottom:14px; }
  .form-label { font-size:10px; font-weight:700; color:var(--text3); margin-bottom:5px; display:block; text-transform:uppercase; letter-spacing:.15em; }
  .form-input {
    width:100%; padding:13px 16px; background:rgba(0,212,255,0.04); border:1px solid var(--border2);
    border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display',sans-serif;
    font-size:16px; outline:none; transition:all .2s;
  }
  .form-input:focus { border-color:var(--neon-blue); background:rgba(0,212,255,0.08); box-shadow:0 0 0 3px rgba(0,212,255,0.1), var(--glow-blue); }
  .pin-input { text-align:center; font-family:'Barlow Condensed',sans-serif; font-size:40px; font-weight:900; letter-spacing:14px; color:var(--neon-blue); }
  .err-msg { font-size:12px; color:var(--danger); margin-top:10px; text-align:center; font-weight:700; letter-spacing:.05em; }

  /* ═══ NICKNAME SEARCH ═══ */
  .nickname-list { max-height:220px; overflow-y:auto; border:1px solid var(--border2); border-radius:var(--radius-sm); margin-top:6px; background:rgba(5,15,35,0.98); }
  .nickname-item { padding:12px 14px; cursor:pointer; font-size:14px; font-weight:600; color:var(--text); border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; transition:background .15s; }
  .nickname-item:hover { background:rgba(0,212,255,0.08); }
  .nickname-item:last-child { border-bottom:none; }

  /* ═══ BUTTONS ═══ */
  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:6px;
    padding:10px 18px; border-radius:var(--radius-sm); border:none; cursor:pointer;
    font-family:'Funnel Display',sans-serif; font-size:14px; font-weight:700;
    transition:all .15s; white-space:nowrap; min-height:44px; letter-spacing:.03em; position:relative;
  }
  .btn-primary {
    background:linear-gradient(135deg, #0066cc, #00aaff, #0066cc);
    background-size:200% 100%; color:#fff; width:100%; padding:15px;
    font-size:15px; font-weight:800; letter-spacing:.08em; text-transform:uppercase;
    border:1px solid rgba(0,212,255,0.5); box-shadow:var(--glow-blue), inset 0 1px 0 rgba(255,255,255,0.15);
    border-radius:12px;
  }
  .btn-primary:active { transform:scale(.97); opacity:.9; }
  .btn-ghost { background:rgba(0,212,255,0.06); color:var(--text2); border:1px solid var(--border2); border-radius:10px; }
  .btn-ghost:active { background:rgba(0,212,255,0.12); }
  .btn-danger { background:rgba(255,34,68,.12); color:#ff4466; border:1px solid rgba(255,34,68,.3); }
  .btn-yellow {
    background:linear-gradient(135deg, #cc9900, #ffcc00, #cc9900);
    background-size:200% 100%; color:#101010; font-weight:900;
    border:1px solid rgba(255,204,0,0.5); box-shadow:var(--glow-gold);
    text-transform:uppercase; letter-spacing:.06em;
  }
  .btn-sm { padding:7px 14px; font-size:12px; min-height:36px; }
  .btn-xs { padding:5px 10px; font-size:11px; min-height:30px; border-radius:8px; }

  /* ═══ EDUCATOR DESKTOP ═══ */
  .edu-layout { display:flex; min-height:100vh; position:relative; z-index:1; background:linear-gradient(160deg,#1a0e55 0%,#122a7a 50%,#1f0e5a 100%); }
  .sidebar { width:240px; background:rgba(0,0,20,0.7); border-right:1px solid rgba(255,255,255,.08); display:flex; flex-direction:column; position:fixed; top:0; left:0; height:100vh; overflow-y:auto; z-index:10; backdrop-filter:blur(24px); }
  .sidebar-logo { padding:20px 18px 16px; border-bottom:1px solid rgba(255,255,255,.08); }
  .sidebar-logo-box { background:#cc1111; border-radius:9px 12px 9px 14px; padding:5px 11px; display:inline-block; box-shadow:2px 3px 0 rgba(0,0,0,.3); transform:rotate(-1deg); }
  .sidebar-logo-t { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:15px; text-transform:uppercase; color:#111; line-height:1.05; letter-spacing:-.3px; }
  .sidebar-logo-sub { font-family:'Barlow Condensed',sans-serif; background:#111; color:#ffe600; font-size:8px; font-weight:900; border-radius:4px; padding:2px 7px; text-transform:uppercase; letter-spacing:.07em; margin-top:3px; display:inline-block; }
  .sidebar-badge { display:inline-flex; align-items:center; gap:5px; background:rgba(255,204,0,.12); border:1px solid rgba(255,204,0,.25); border-radius:99px; padding:3px 10px; font-size:9px; font-weight:800; color:#ffcc00; text-transform:uppercase; letter-spacing:.06em; margin-top:8px; }
  .nav { flex:1; padding:8px 0; }
  .nav-item { display:flex; align-items:center; gap:10px; padding:9px 18px; cursor:pointer; font-size:13px; font-weight:600; color:rgba(255,255,255,.38); border-left:2px solid transparent; transition:all .12s; min-height:42px; border-radius:0 10px 10px 0; margin:1px 8px 1px 0; }
  .nav-item:hover { background:rgba(255,255,255,.05); color:rgba(255,255,255,.75); }
  .nav-item.active { background:rgba(255,204,0,.1); color:#ffcc00; border-left-color:#ffcc00; font-weight:700; box-shadow:inset 0 0 20px rgba(255,204,0,.05); }
  .nav-icon { font-size:16px; width:22px; text-align:center; flex-shrink:0; }
  .sidebar-user { padding:14px 18px; border-top:1px solid rgba(255,255,255,.08); }
  .edu-main { margin-left:240px; flex:1; display:flex; flex-direction:column; min-height:100vh; }
  .topbar { padding:12px 24px; background:rgba(0,0,20,.6); border-bottom:1px solid rgba(255,255,255,.08); display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:5; backdrop-filter:blur(24px); }
  .topbar-title { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:26px; text-transform:uppercase; color:#fff; letter-spacing:.05em; }
  .content { flex:1; padding:20px 24px; }

  /* ═══ MOBILE EDUCATOR ═══ */
  .mob-header { display:none; position:fixed; top:0; left:0; right:0; height:56px; background:rgba(0,0,20,.75); border-bottom:1px solid rgba(255,255,255,.08); z-index:20; align-items:center; padding:0 14px; gap:10px; backdrop-filter:blur(24px); }
  .mob-header-title { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:20px; text-transform:uppercase; color:#fff; flex:1; letter-spacing:.05em; }
  .mob-drawer-bg { position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:30; backdrop-filter:blur(6px); }
  .mob-drawer { position:fixed; top:0; left:0; bottom:0; width:270px; background:rgba(10,5,40,.97); border-right:1px solid rgba(255,255,255,.08); z-index:40; transform:translateX(-100%); transition:transform .25s; display:flex; flex-direction:column; backdrop-filter:blur(24px); }
  .mob-drawer.open { transform:translateX(0); }
  .mob-bottom-nav { display:none; position:fixed; bottom:0; left:0; right:0; background:rgba(0,0,20,.88); border-top:1px solid rgba(255,255,255,.08); z-index:20; padding-bottom:env(safe-area-inset-bottom,0px); backdrop-filter:blur(24px); }
  .mob-bottom-nav-inner { display:flex; height:60px; }
  .mob-nav-btn { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; background:none; border:none; cursor:pointer; color:rgba(255,255,255,.28); font-family:'Funnel Display'; padding:0; transition:color .15s; }
  .mob-nav-btn.active { color:#ffcc00; }
  .mob-nav-btn { transition:color .2s; }

  /* ═══ SECTION BANNERS ═══ */
  .section-banner { border-radius:var(--radius-lg); padding:20px; margin-bottom:18px; position:relative; overflow:hidden; min-height:80px; display:flex; align-items:flex-end; }
  .section-banner-bg { position:absolute; inset:0; background-size:cover; background-position:center; }
  .section-banner-overlay { position:absolute; inset:0; background:linear-gradient(to top,rgba(0,0,0,.65),rgba(0,0,0,.2)); }
  .section-banner-content { position:relative; z-index:1; flex:1; }
  .section-banner-title { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:32px; text-transform:uppercase; color:#fff; letter-spacing:.02em; line-height:1; text-shadow:0 2px 12px rgba(0,0,0,.6); }
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
  .stat-card::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(255,204,0,0.3),transparent); }
  .stat-label { font-size:10px; color:var(--text3); text-transform:uppercase; letter-spacing:.12em; margin-bottom:4px; font-weight:700; }
  .stat-value { font-family:'Barlow Condensed',sans-serif; font-size:36px; font-weight:900; color:var(--text); line-height:1; }

  /* ═══ PLAYER GRID ═══ */
  .player-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px; }
  .player-card {
    background:rgba(10,22,48,0.9); border:1px solid var(--border);
    border-radius:var(--radius); padding:14px 10px; text-align:center;
    cursor:pointer; position:relative; transition:all .15s;
  }
  .player-card:hover { border-color:rgba(0,212,255,0.3); transform:translateY(-2px); }
  .player-card.selected { border-color:var(--neon-blue); background:rgba(0,212,255,0.08); box-shadow:var(--glow-blue); }
  .avatar-wrap { width:56px; height:56px; border-radius:50%; margin:0 auto 10px; overflow:hidden; display:flex; align-items:center; justify-content:center; font-size:26px; border:2px solid rgba(0,212,255,0.25); }
  .avatar-wrap img { width:100%; height:100%; object-fit:cover; }
  .p-name { font-size:12px; font-weight:700; color:var(--text); margin-bottom:2px; word-break:break-word; line-height:1.3; }
  .p-level { font-size:10px; color:var(--text3); margin-bottom:3px; }
  .p-xp { font-family:'Barlow Condensed',sans-serif; font-size:16px; font-weight:900; color:var(--neon-blue); }
  .p-coin { font-size:10px; color:var(--neon-gold); margin-top:1px; }
  .squad-pill { font-size:9px; padding:2px 8px; border-radius:99px; display:inline-block; margin-top:5px; font-weight:700; }
  .pts-row { display:flex; gap:4px; justify-content:center; margin-top:8px; }
  .pts-btn { width:30px; height:30px; border-radius:50%; border:1px solid var(--border2); background:rgba(0,212,255,0.05); cursor:pointer; font-size:15px; display:flex; align-items:center; justify-content:center; color:var(--text2); line-height:1; transition:all .12s; }
  .pts-btn.add { color:var(--neon-green); border-color:rgba(0,255,136,.3); }
  .pts-btn.rem { color:var(--danger); border-color:rgba(255,34,68,.3); }

  /* ═══ LEADERBOARD ═══ */
  .lb-list { display:flex; flex-direction:column; gap:6px; }
  .lb-row {
    display:flex; align-items:center; gap:12px;
    background:rgba(8,18,40,0.9); border:1px solid var(--border);
    border-radius:12px; padding:12px 14px; transition:all .15s; position:relative; overflow:hidden;
  }
  .lb-row::before { content:''; position:absolute; left:0; top:0; bottom:0; width:2px; background:var(--border); }
  .lb-rank { font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:900; width:32px; text-align:center; color:var(--text3); flex-shrink:0; }
  .lb-rank.gold { color:var(--neon-gold); text-shadow:0 0 16px rgba(255,204,0,0.7); }
  .lb-rank.silver { color:#aac8e0; }
  .lb-rank.bronze { color:#d4916a; }
  .lb-row:nth-child(1) { border-color:rgba(255,204,0,0.25); box-shadow:0 0 20px rgba(255,204,0,0.08); }
  .lb-row:nth-child(1)::before { background:linear-gradient(180deg,var(--neon-gold),transparent); }
  .lb-row:nth-child(2) { border-color:rgba(170,200,224,0.2); }
  .lb-row:nth-child(2)::before { background:linear-gradient(180deg,#aac8e0,transparent); }
  .lb-row:nth-child(3) { border-color:rgba(212,145,106,0.2); }
  .lb-row:nth-child(3)::before { background:linear-gradient(180deg,#d4916a,transparent); }
  .lb-av { width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; overflow:hidden; border:1.5px solid var(--border2); }
  .lb-av img { width:100%; height:100%; object-fit:cover; }
  .lb-name { flex:1; font-size:14px; font-weight:700; color:var(--text); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .lb-level { font-size:10px; color:var(--text3); margin-top:1px; }
  .lb-xp { font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:900; color:var(--neon-blue); flex-shrink:0; }

  /* ═══ PLAYER DETAIL ═══ */
  .player-detail { background:rgba(5,15,35,0.95); border:1px solid rgba(0,212,255,0.25); border-radius:var(--radius-lg); padding:20px; margin-top:12px; box-shadow:var(--glow-blue); }
  .player-detail-header { display:flex; gap:16px; align-items:center; margin-bottom:16px; }
  .player-detail-av { width:64px; height:64px; border-radius:50%; overflow:hidden; border:2px solid var(--neon-blue); display:flex; align-items:center; justify-content:center; font-size:30px; flex-shrink:0; box-shadow:var(--glow-blue); }
  .player-detail-av img { width:100%; height:100%; object-fit:cover; }
  .detail-tabs { display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
  .detail-tab { padding:6px 14px; border-radius:99px; border:1px solid var(--border2); background:transparent; color:var(--text2); font-family:'Funnel Display'; font-size:12px; font-weight:600; cursor:pointer; min-height:32px; transition:all .15s; }
  .detail-tab.active { background:rgba(0,212,255,0.15); color:var(--neon-blue); border-color:rgba(0,212,255,0.4); box-shadow:var(--glow-blue); }

  /* ═══ FILTER / CHIPS ═══ */
  .filter-bar { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
  .search-inp { padding:10px 16px; background:rgba(0,212,255,0.05); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:15px; outline:none; flex:1; min-width:140px; transition:all .15s; }
  .search-inp:focus { border-color:var(--neon-blue); box-shadow:0 0 0 3px rgba(0,212,255,0.1); }
  .chip { padding:7px 16px; border-radius:99px; border:1px solid var(--border2); background:rgba(0,212,255,0.04); color:var(--text2); font-family:'Funnel Display'; font-size:12px; font-weight:700; cursor:pointer; min-height:34px; transition:all .15s; letter-spacing:.03em; }
  .chip.active { background:rgba(0,212,255,0.15); color:var(--neon-blue); border-color:rgba(0,212,255,0.4); box-shadow:0 0 12px rgba(0,212,255,0.2); }

  /* ═══ BATCH ═══ */
  .batch-panel { background:rgba(0,212,255,0.05); border:1px solid rgba(0,212,255,0.2); border-radius:var(--radius); padding:12px 16px; margin-bottom:14px; }
  .batch-info { font-size:13px; color:var(--neon-blue); font-weight:700; margin-bottom:10px; }
  .batch-inp { width:70px; padding:8px 10px; background:rgba(0,212,255,0.08); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Barlow Condensed'; font-size:18px; font-weight:700; outline:none; text-align:center; }

  /* ═══ PRESENZE ═══ */
  .pres-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border-radius:var(--radius); border:1px solid var(--border); }
  .pres-table { width:100%; border-collapse:collapse; font-size:13px; min-width:420px; }
  .pres-table th { padding:10px 12px; text-align:left; font-size:10px; font-weight:700; color:var(--text3); border-bottom:1px solid var(--border); text-transform:uppercase; letter-spacing:.1em; background:rgba(4,8,20,0.95); }
  .pres-table td { padding:10px 12px; border-bottom:1px solid var(--border); color:var(--text); }
  .pres-dot { width:32px; height:32px; border-radius:8px; border:none; cursor:pointer; font-size:13px; display:inline-flex; align-items:center; justify-content:center; font-weight:700; transition:all .12s; }
  .pd-yes { background:rgba(0,255,136,.15); color:var(--neon-green); border:1px solid rgba(0,255,136,.3); }
  .pd-partial { background:rgba(255,204,0,.12); color:var(--neon-gold); border:1px solid rgba(255,204,0,.25); }
  .pd-completed { background:rgba(0,255,136,.25); color:#00ff88; border:1px solid rgba(0,255,136,.4); }
  .pd-none { background:rgba(255,255,255,.04); color:var(--text3); border:1px solid var(--border); }

  /* ═══ ACTIVITIES ═══ */
  .act-grid { display:grid; grid-template-columns:1fr; gap:10px; }
  .act-card {
    background:rgba(0,80,40,0.08); border:1px solid rgba(0,255,136,0.15);
    border-radius:var(--radius); padding:16px; position:relative;
    transition:all .15s;
  }
  .act-card:hover { border-color:rgba(0,255,136,0.3); box-shadow:var(--glow-green); }
  .act-title { font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:900; text-transform:uppercase; color:var(--text); margin-bottom:4px; letter-spacing:.02em; }
  .act-meta { font-size:12px; color:var(--text2); margin-bottom:10px; }
  .act-rewards { display:flex; gap:6px; flex-wrap:wrap; }
  .reward-tag { font-size:10px; padding:4px 12px; border-radius:6px; font-weight:700; letter-spacing:.04em; }
  .xp-tag { background:rgba(0,212,255,0.12); color:var(--neon-blue); border:1px solid rgba(0,212,255,0.2); }
  .coin-tag { background:rgba(255,204,0,0.1); color:var(--neon-gold); border:1px solid rgba(255,204,0,0.2); }
  .delete-btn { position:absolute; top:10px; right:10px; width:28px; height:28px; border-radius:6px; border:1px solid rgba(255,34,68,.3); background:rgba(255,34,68,.08); color:#ff4466; cursor:pointer; font-size:13px; display:flex; align-items:center; justify-content:center; transition:all .12s; }
  .delete-btn:hover { background:rgba(255,34,68,.2); }

  /* ═══ BADGES ═══ */
  .badge-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(100px,1fr)); gap:10px; }
  .badge-card {
    background:rgba(80,0,80,0.08); border:1px solid rgba(255,0,204,0.15);
    border-radius:var(--radius); padding:14px 10px; text-align:center;
    cursor:pointer; position:relative; transition:all .2s;
  }
  .badge-card:hover { border-color:rgba(255,0,204,0.4); box-shadow:var(--glow-pink); transform:translateY(-3px) scale(1.02); }
  .badge-img { width:60px; height:60px; border-radius:50%; object-fit:cover; margin:0 auto 8px; display:block; border:2px solid rgba(255,0,204,0.4); box-shadow:0 0 16px rgba(255,0,204,0.3); }
  .badge-emoji { font-size:40px; display:block; margin:0 auto 8px; line-height:1; }
  .badge-name { font-size:11px; font-weight:700; color:var(--text); line-height:1.3; }
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
    background:linear-gradient(90deg, transparent, var(--rosso), var(--rosa), transparent);
  }
  .sfida-label { font-family:'Barlow Condensed',sans-serif; font-size:11px; font-weight:900; text-transform:uppercase; color:var(--danger); letter-spacing:.18em; margin-bottom:6px; }
  .sfida-title { font-family:'Barlow Condensed',sans-serif; font-size:26px; font-weight:900; text-transform:uppercase; color:#fff; margin-bottom:6px; letter-spacing:.02em; text-shadow:0 0 20px rgba(255,34,68,0.3); }
  .sfida-desc { font-size:13px; color:rgba(255,255,255,.6); margin-bottom:12px; line-height:1.5; }
  .sfida-reward { display:inline-flex; align-items:center; gap:6px; background:rgba(255,204,0,0.12); border:1px solid rgba(255,204,0,0.3); border-radius:8px; padding:6px 14px; font-size:12px; font-weight:800; color:var(--neon-gold); letter-spacing:.04em; }

  /* ═══ DIARIO ═══ */
  .diary-day { margin-bottom:18px; }
  .diary-date { font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--neon-blue); margin-bottom:8px; letter-spacing:.05em; }
  .diary-entry { display:flex; align-items:center; gap:10px; padding:10px 14px; background:rgba(8,18,40,0.9); border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:5px; }
  .diary-icon { font-size:18px; flex-shrink:0; }
  .diary-text { flex:1; font-size:13px; color:var(--text); line-height:1.4; }
  .diary-pts { font-family:'Barlow Condensed',sans-serif; font-size:18px; font-weight:900; color:var(--neon-blue); flex-shrink:0; }

  /* ═══ MODAL ═══ */
  .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:100; display:flex; align-items:flex-end; justify-content:center; backdrop-filter:blur(8px); }
  .modal {
    background:rgba(5,12,30,0.98); border:1px solid rgba(0,212,255,0.25);
    border-radius:20px 20px 0 0; padding:24px 20px;
    padding-bottom:calc(24px + env(safe-area-inset-bottom,0px));
    width:100%; max-width:560px; max-height:92vh; overflow-y:auto;
    box-shadow:0 -20px 60px rgba(0,0,0,0.8), var(--glow-blue);
    position:relative;
  }
  .modal::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg,transparent,var(--neon-blue),var(--neon-pink),transparent); border-radius:20px 20px 0 0; }
  .modal-title { font-family:'Barlow Condensed',sans-serif; font-size:30px; font-weight:900; text-transform:uppercase; color:var(--text); margin-bottom:18px; letter-spacing:.04em; }
  .section-label { font-size:10px; font-weight:700; color:var(--text3); text-transform:uppercase; letter-spacing:.15em; margin:16px 0 8px; }

  /* ═══ PROFILE HERO ═══ */
  .profile-hero {
    border-radius:var(--radius-lg); margin-bottom:14px; overflow:hidden;
    position:relative;
    background:linear-gradient(160deg, rgba(0,40,100,0.8) 0%, rgba(4,8,20,0.95) 50%, rgba(60,0,80,0.6) 100%);
    border:1px solid rgba(0,212,255,0.2);
    box-shadow:var(--glow-blue), 0 20px 60px rgba(0,0,0,0.6);
  }
  .profile-hero::before {
    content:''; position:absolute; inset:0;
    background:
      radial-gradient(ellipse 80% 60% at 50% -20%, rgba(0,212,255,0.15) 0%, transparent 60%),
      radial-gradient(ellipse 50% 40% at 100% 100%, rgba(255,0,204,0.1) 0%, transparent 50%);
    pointer-events:none;
  }
  .profile-hero-bg { position:absolute; inset:0; pointer-events:none; }
  .profile-hero-inner { padding:32px 20px 24px; position:relative; z-index:1; text-align:center; }
  .profile-avatar {
    width:120px; height:120px; border-radius:50%; margin:0 auto 16px;
    display:flex; align-items:center; justify-content:center; font-size:56px; overflow:hidden;
    position:relative;
    border:2px solid transparent;
    background:linear-gradient(rgba(4,8,20,1),rgba(4,8,20,1)) padding-box, linear-gradient(135deg,var(--neon-blue),var(--neon-pink)) border-box;
    box-shadow:0 0 0 1px rgba(255,255,255,0.05), 0 0 40px rgba(0,212,255,0.3), 0 0 80px rgba(0,212,255,0.1), 0 16px 40px rgba(0,0,0,0.6);
  }
  .profile-avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
  .profile-avatar-ring {
    position:absolute; inset:-4px; border-radius:50%;
    border:1px solid transparent;
    background:linear-gradient(var(--nero),var(--nero)) padding-box, conic-gradient(from 0deg, var(--neon-blue), var(--neon-pink), var(--neon-blue)) border-box;
    animation:spin 4s linear infinite; opacity:0.6;
  }
  @keyframes spin { to { transform:rotate(360deg); } }
  .profile-name {
    font-family:'Barlow Condensed',sans-serif; font-size:38px; font-weight:900;
    text-transform:uppercase; letter-spacing:1px; color:#fff; margin-bottom:4px;
    text-shadow:0 0 30px rgba(0,212,255,0.4);
  }
  .profile-firstname { font-size:13px; color:rgba(255,255,255,.45); margin-bottom:8px; letter-spacing:.08em; }
  .profile-level {
    font-size:12px; font-weight:700; display:inline-flex; align-items:center; gap:6px;
    background:rgba(0,212,255,0.1); border:1px solid rgba(0,212,255,0.25);
    border-radius:99px; padding:5px 16px; color:var(--neon-blue); margin-bottom:14px;
    letter-spacing:.06em; text-transform:uppercase;
  }
  .profile-stats-row { display:flex; justify-content:center; gap:0; }
  .profile-stat { flex:1; text-align:center; padding:14px 8px; border-right:1px solid rgba(255,255,255,0.06); }
  .profile-stat:last-child { border-right:none; }
  .profile-stat-val { font-family:'Barlow Condensed',sans-serif; font-size:32px; font-weight:900; line-height:1; }
  .profile-stat-lbl { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:rgba(255,255,255,.35); margin-top:3px; }
  .profile-xp-section { padding:0 20px 22px; position:relative; z-index:1; }
  .xp-bar-wrap { height:8px; background:rgba(255,255,255,.07); border-radius:99px; overflow:hidden; margin:10px 0 4px; }
  .xp-bar { height:100%; background:linear-gradient(90deg,var(--neon-blue),var(--neon-pink)); border-radius:99px; transition:width .6s cubic-bezier(.4,0,.2,1); box-shadow:0 0 12px rgba(0,212,255,0.5); }
  .xp-label { display:flex; justify-content:space-between; font-size:10px; color:rgba(255,255,255,.35); font-weight:700; letter-spacing:.06em; }

  /* ═══ QR ═══ */
  .qr-code { font-family:'Barlow Condensed',sans-serif; font-size:52px; font-weight:900; color:var(--neon-blue); letter-spacing:10px; margin:16px 0; text-shadow:var(--glow-blue); }

  /* ═══ AVATAR UPLOAD ═══ */
  .avatar-upload-area { border:2px dashed rgba(0,212,255,0.25); border-radius:var(--radius); padding:20px; text-align:center; cursor:pointer; margin-bottom:12px; transition:all .15s; }
  .avatar-upload-area:hover { border-color:rgba(0,212,255,0.5); background:rgba(0,212,255,0.04); }
  .avatar-preview { width:80px; height:80px; border-radius:50%; object-fit:cover; margin:0 auto 8px; display:block; border:2px solid var(--neon-blue); box-shadow:var(--glow-blue); }

  /* ═══ THEME TOGGLE ═══ */
  .theme-toggle { width:44px; height:24px; border-radius:99px; border:1px solid var(--border2); cursor:pointer; position:relative; transition:background .2s; display:flex; align-items:center; padding:0 3px; background:rgba(0,212,255,0.08); }
  .theme-toggle-knob { width:18px; height:18px; border-radius:50%; background:var(--neon-blue); transition:transform .2s; box-shadow:var(--glow-blue); }

  /* ═══ MISC ═══ */
  .tag { font-size:11px; padding:3px 10px; border-radius:6px; display:inline-block; font-weight:700; letter-spacing:.04em; }
  .tag-green { background:rgba(0,255,136,.1); color:var(--neon-green); border:1px solid rgba(0,255,136,.2); }
  .tag-blue { background:rgba(0,212,255,.1); color:var(--neon-blue); border:1px solid rgba(0,212,255,.2); }
  .tag-amber { background:rgba(255,204,0,.1); color:var(--neon-gold); border:1px solid rgba(255,204,0,.2); }
  .tag-red { background:rgba(255,34,68,.1); color:#ff4466; border:1px solid rgba(255,34,68,.2); }
  .tag-gray { background:rgba(255,255,255,.05); color:var(--text2); border:1px solid var(--border); }
  .loading { display:flex; align-items:center; justify-content:center; min-height:160px; color:var(--text2); font-size:14px; gap:8px; }
  .empty { text-align:center; padding:40px 20px; color:var(--text3); font-size:14px; }
  select { padding:10px 12px; background:rgba(0,212,255,0.05); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:15px; outline:none; width:100%; }
  textarea { width:100%; padding:10px 14px; background:rgba(0,212,255,0.04); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:14px; outline:none; resize:vertical; min-height:80px; transition:all .15s; }
  textarea:focus { border-color:var(--neon-blue); box-shadow:0 0 0 3px rgba(0,212,255,0.08); }
  .color-swatch-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
  .color-swatch { width:36px; height:36px; border-radius:50%; border:3px solid transparent; cursor:pointer; transition:border-color .12s; }
  .color-swatch.active { border-color:var(--neon-blue); box-shadow:var(--glow-blue); }
  .squad-list { display:flex; flex-direction:column; gap:8px; }
  .squad-row { display:flex; align-items:center; gap:12px; background:rgba(8,18,40,0.9); border:1px solid var(--border); border-radius:var(--radius-sm); padding:14px 16px; }
  .squad-color-dot { width:16px; height:16px; border-radius:50%; flex-shrink:0; }
  .squad-name { flex:1; font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:900; text-transform:uppercase; color:var(--text); }

  /* ═══ MESSAGES ═══ */
  .msg-layout { display:flex; gap:12px; height:440px; }
  .msg-list { width:150px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; flex-shrink:0; }
  .msg-thread { background:rgba(8,18,40,0.9); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px 12px; cursor:pointer; transition:all .15s; }
  .msg-thread.active { border-color:rgba(0,212,255,0.4); background:rgba(0,212,255,0.08); box-shadow:0 0 12px rgba(0,212,255,0.1); }
  .mt-name { font-size:12px; font-weight:700; color:var(--text); }
  .msg-main { flex:1; display:flex; flex-direction:column; background:rgba(8,18,40,0.9); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; min-width:0; }
  .msg-hdr { padding:12px 16px; border-bottom:1px solid var(--border); font-weight:700; font-size:14px; color:var(--text); background:rgba(0,212,255,0.04); }
  .msg-body { flex:1; padding:14px 16px; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
  .bubble-wrap { display:flex; gap:8px; }
  .bubble-wrap.mine { flex-direction:row-reverse; }
  .bubble-av { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; flex-shrink:0; background:rgba(0,212,255,0.1); border:1px solid var(--border2); }
  .bubble { max-width:220px; padding:8px 12px; border-radius:12px; font-size:13px; line-height:1.5; }
  .bubble.them { background:rgba(255,255,255,.06); color:var(--text); border:1px solid var(--border); }
  .bubble.mine { background:rgba(0,212,255,.15); color:var(--neon-blue); border:1px solid rgba(0,212,255,.25); }
  .msg-inp-row { padding:10px 14px; border-top:1px solid var(--border); display:flex; gap:8px; background:rgba(0,212,255,0.02); }
  .msg-inp { flex:1; padding:10px 12px; background:rgba(0,212,255,0.06); border:1px solid var(--border2); border-radius:var(--radius-sm); color:var(--text); font-family:'Funnel Display'; font-size:14px; outline:none; }
  .notif-dot { width:8px; height:8px; border-radius:50%; background:var(--neon-pink); display:inline-block; margin-left:4px; vertical-align:middle; box-shadow:0 0 8px rgba(255,0,204,0.6); animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
  .notif-item { display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--border); }
  .notif-icon { font-size:24px; flex-shrink:0; }
  .notif-title { font-size:14px; font-weight:700; color:var(--text); margin-bottom:2px; }
  .notif-body { font-size:13px; color:var(--text2); }
  .notif-time { font-size:11px; color:var(--text3); margin-top:3px; }

  /* ═══ PIN DISPLAY ═══ */
  .pin-display { font-family:'Barlow Condensed',sans-serif; font-size:28px; font-weight:900; color:var(--neon-blue); letter-spacing:6px; background:rgba(0,212,255,0.08); border:1px solid rgba(0,212,255,0.2); border-radius:8px; padding:8px 16px; display:inline-block; box-shadow:var(--glow-blue); }

  /* ═══ PLAYER BOTTOM NAV ═══ */
  .player-bottom-nav {
    position:fixed; bottom:0; left:0; right:0;
    background:rgba(4,8,20,0.97); border-top:1px solid rgba(0,212,255,0.15);
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
  }

  /* ═══ PODIUM ═══ */
  .podium-wrap { display:flex; align-items:flex-end; gap:6px; margin:0 0 14px; padding:0 2px; }
  .pod-col { flex:1; text-align:center; }
  .pod-crown { font-size:18px; margin-bottom:3px; display:block; }
  .pod-av-wrap { border-radius:50%; margin:0 auto 6px; overflow:hidden; display:flex; align-items:center; justify-content:center; position:relative; }
  .pod-name { font-family:'Barlow Condensed',sans-serif; font-size:12px; font-weight:900; text-transform:uppercase; color:#fff; letter-spacing:.03em; line-height:1.2; word-break:break-word; }
  .pod-xp { font-size:10px; font-weight:700; margin-top:2px; }
  .pod-base { border-radius:12px 12px 0 0; padding:8px 4px 6px; margin-top:6px; }
  .pod-1 .pod-av-wrap { width:68px; height:68px; border:3px solid #ffcc00; box-shadow:0 0 24px rgba(255,204,0,.45); }
  .pod-2 .pod-av-wrap { width:54px; height:54px; border:2px solid #9090b0; box-shadow:0 0 14px rgba(150,150,200,.35); }
  .pod-3 .pod-av-wrap { width:48px; height:48px; border:2px solid #b87a30; box-shadow:0 0 12px rgba(200,130,50,.3); }
  .pod-1 .pod-base { background:rgba(255,204,0,.08); border:1px solid rgba(255,204,0,.22); border-bottom:none; min-height:70px; }
  .pod-2 .pod-base { background:rgba(140,140,180,.06); border:1px solid rgba(140,140,180,.15); border-bottom:none; min-height:52px; }
  .pod-3 .pod-base { background:rgba(180,120,50,.06); border:1px solid rgba(180,120,50,.14); border-bottom:none; min-height:40px; }
  .pod-1 .pod-xp { color:#ffcc00; }
  .pod-2 .pod-xp { color:#aac8e0; }
  .pod-3 .pod-xp { color:#d4916a; }

  /* ═══ STREAK ═══ */
  .streak-card { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(255,120,0,.25); border-radius:14px; padding:12px 14px; position:relative; z-index:2; }
  .streak-row { display:flex; gap:8px; }
  .streak-item { flex:1; text-align:center; }
  .streak-val { font-family:'Barlow Condensed',sans-serif; font-size:26px; font-weight:900; color:#ff8c00; line-height:1; display:block; }
  .streak-lbl { font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.1em; color:rgba(255,255,255,.35); margin-top:2px; display:block; }
  .month-prog { margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.07); }
  .month-prog-lbl { display:flex; justify-content:space-between; font-size:9px; font-weight:900; color:rgba(255,255,255,.3); text-transform:uppercase; letter-spacing:.06em; margin-bottom:5px; }
  .month-prog-bg { height:7px; background:rgba(255,255,255,.07); border-radius:99px; overflow:hidden; }
  .month-prog-fill { height:100%; background:linear-gradient(90deg,#ff6600,#ffaa00); border-radius:99px; }


  /* ═══ LIGHT MODE ═══ */
  .light body { background:#f0f4ff; color:#1a1a3a; }
  .light body::before { background: radial-gradient(ellipse 80% 50% at 20% -10%,rgba(100,140,255,.1) 0%,transparent 60%), #f0f4ff; }
  .light body::after { background-image: linear-gradient(rgba(80,80,200,.04) 1px,transparent 1px), linear-gradient(90deg,rgba(80,80,200,.04) 1px,transparent 1px); }

  /* Educator light */
  .light .edu-layout { background:#f0f4ff; }
  .light .sidebar { background:#ffffff; border-right:2px solid #e0e6f8; box-shadow:4px 0 16px rgba(0,0,80,.08); }
  .light .sidebar-logo-box { background:#cc1111; }
  .light .sidebar-badge { background:rgba(255,180,0,.15); border-color:rgba(255,180,0,.4); color:#8a5e00; }
  .light .nav-item { color:#5a5a8a; font-weight:600; }
  .light .nav-item:hover { background:#f0f4ff; color:#1a1a3a; }
  .light .nav-item.active { background:#fffbe0; color:#7a5800; border-left-color:#c09000; font-weight:700; }
  .light .sidebar-user { border-top:2px solid #e0e6f8; }
  .light .topbar { background:#ffffff; border-bottom:2px solid #e0e6f8; box-shadow:0 2px 12px rgba(0,0,80,.07); }
  .light .topbar-title { color:#1a1a3a; }
  .light .mob-header { background:#ffffff; border-bottom:2px solid #e0e6f8; }
  .light .mob-header-title { color:#1a1a3a; }
  .light .mob-bottom-nav { background:#ffffff; border-top:2px solid #e0e6f8; box-shadow:0 -2px 12px rgba(0,0,80,.06); }
  .light .mob-nav-btn { color:#8a8ab0; }
  .light .mob-nav-btn.active { color:#7a5800; }
  .light .mob-drawer { background:#ffffff; }
  .light .content { background:#f0f4ff; }

  /* Cards & elements */
  .light .card { background:#ffffff; border:1px solid #e0e6f8; box-shadow:0 2px 8px rgba(0,0,80,.06); color:#1a1a3a; }
  .light .card-sm { background:#ffffff; border:1px solid #e0e6f8; color:#1a1a3a; }
  .light .stat-card { background:#ffffff; border:2px solid #e0e6f8; box-shadow:0 2px 8px rgba(0,0,80,.06); }
  .light .stat-card::before { background:linear-gradient(90deg,transparent,rgba(180,130,0,.35),transparent); }
  .light .stat-label { color:#6a6a9a; font-weight:700; }
  .light .stat-value { color:#1a1a3a; }
  .light .lb-row { background:#ffffff; border:1px solid #e0e6f8; }
  .light .lb-row::before { background:rgba(100,100,200,.2); }
  .light .lb-name { color:#1a1a3a; font-weight:700; }
  .light .lb-level { color:#6a6a9a; }
  .light .lb-xp { color:#1a5fc0; }
  .light .lb-av { background:#f0f4ff; border-color:#dde4f8; }
  .light .form-input { background:#ffffff; border:2px solid #c8d4f0; color:#1a1a3a; font-weight:500; }
  .light .form-input:focus { border-color:#7070cc; box-shadow:0 0 0 3px rgba(112,112,204,.12); }
  .light .form-label { color:#5a5a8a; font-weight:700; }
  .light select { background:#ffffff; border:2px solid #c8d4f0; color:#1a1a3a; }
  .light textarea { background:#ffffff; border:2px solid #c8d4f0; color:#1a1a3a; }
  .light .search-inp { background:#ffffff; border:2px solid #c8d4f0; color:#1a1a3a; }
  .light .act-card { background:#ffffff; border:2px solid #b0e0c0; }
  .light .act-title { color:#1a1a3a; }
  .light .act-meta { color:#5a5a8a; }
  .light .badge-card { background:#ffffff; border:2px solid #e0b0e0; }
  .light .badge-name { color:#1a1a3a; }
  .light .modal { background:#ffffff; border:2px solid #c8d4f0; box-shadow:0 -20px 60px rgba(0,0,80,.15); }
  .light .modal-title { color:#1a1a3a; }
  .light .modal::before { background:linear-gradient(90deg,transparent,#7070cc,#cc4488,transparent); }
  .light .player-card { background:#ffffff; border:2px solid #dde4f8; }
  .light .player-card:hover { border-color:#7070cc; }
  .light .p-name { color:#1a1a3a; }
  .light .p-level { color:#6a6a9a; }
  .light .p-xp { color:#1a5fc0; }
  .light .p-coin { color:#8a6000; }
  .light .chip { background:#ffffff; border:2px solid #c8d4f0; color:#5a5a8a; }
  .light .chip.active { background:#fffbe0; color:#7a5800; border-color:#c09000; }
  .light .sfida-card { background:#ffffff; border:2px solid #f0b0b0; }
  .light .sfida-label { color:#cc2244; }
  .light .sfida-title { color:#1a1a3a; }
  .light .sfida-desc { color:#5a5a8a; }
  .light .sfida-reward { background:rgba(255,204,0,.15); border-color:rgba(255,180,0,.4); color:#7a5800; }
  .light .section-label { color:#6a6a9a; }
  .light .batch-panel { background:rgba(100,100,200,.06); border:2px solid rgba(100,100,200,.2); }
  .light .batch-info { color:#3a3a9a; }
  .light .pres-wrap { border:2px solid #e0e6f8; }
  .light .pres-table th { background:#f8f9ff; color:#5a5a8a; border-bottom:2px solid #e0e6f8; }
  .light .pres-table td { color:#1a1a3a; border-bottom:1px solid #eef0f8; }
  .light .squad-row { background:#ffffff; border:2px solid #e0e6f8; }
  .light .squad-name { color:#1a1a3a; }
  .light .diary-entry { background:#ffffff; border:1px solid #e0e6f8; }
  .light .diary-date { color:#1a5fc0; }
  .light .diary-text { color:#1a1a3a; }
  .light .notif-item { border-bottom:1px solid #eef0f8; }
  .light .notif-title { color:#1a1a3a; }
  .light .notif-body { color:#5a5a8a; }
  .light .msg-card { background:#ffffff; border:1px solid #e0e6f8; }
  .light .msg-hdr { background:#f8f9ff; color:#3a3a9a; border-bottom:1px solid #e0e6f8; }
  .light .bubble .them { background:#f0f4ff; color:#1a1a3a; border-color:#e0e6f8; }
  .light .lb-list .lb-row:nth-child(1) { border-color:rgba(200,160,0,.4); }
  .light .lb-list .lb-row:nth-child(2) { border-color:rgba(140,140,180,.35); }
  .light .lb-list .lb-row:nth-child(3) { border-color:rgba(180,120,50,.3); }
  .light .filter-bar .chip { background:#ffffff; }
  .light .act-rewards .reward-tag { filter:saturate(1.2) brightness(.8); }
  .light .player-detail { background:#ffffff; border:2px solid #c8d4f0; }
  .light .player-detail-header { border-bottom:1px solid #e0e6f8; }
  .light .detail-tab { background:#f0f4ff; border:1px solid #d0d8f0; color:#5a5a8a; }
  .light .detail-tab.active { background:#fffbe0; color:#7a5800; border-color:#c09000; }

  /* Player light mode */
  .light .player-wrap { background:linear-gradient(160deg,#e8f0ff 0%,#d8e8ff 50%,#e4dcff 100%) !important; }
  .light .pd-topbar { background:#ffffff; border-bottom:2px solid #dde4f8; box-shadow:0 2px 10px rgba(0,0,80,.08); }
  .light .pd-name-pill { background:#1a1a3a !important; color:#ffffff !important; }
  .light .pd-lv-pill { background:rgba(70,70,200,.1); border-color:rgba(70,70,200,.25); color:#3a3aaa; }
  .light .pd-card { background:#ffffff; border:1px solid #dde4f8; box-shadow:0 2px 8px rgba(0,0,80,.06); }
  .light .pd-card * { color:#1a1a3a; }
  .light .pd-sc { background:#ffffff; border:2px solid #dde4f8; }
  .light .pd-sv { color:#7a5800 !important; font-weight:900; }
  .light .pd-sl { color:#6a6a9a !important; }
  .light .pd-squad { background:#ffffff; border:1px solid #dde4f8; }
  .light .squad-nm { color:#1a1a3a !important; }
  .light .squad-role { color:#6a6a9a !important; }
  .light .pd-sfida { background:#1a1a3a !important; border:none; }
  .light .sfl { color:#ffcc00 !important; }
  .light .sft { color:#ffffff !important; }
  .light .sfida-desc, .light .sfd { color:rgba(255,255,255,.7) !important; }
  .light .sfr { background:rgba(255,204,0,.15); border-color:rgba(255,204,0,.35); color:#ffcc00; }
  .light .pd-checkin { background:#ffffff; border:2px solid #a0ddb0; }
  .light .cl { color:#1a8a3a !important; }
  .light .ci-inp { background:#f0fff4; border-color:#a0ddb0; color:#1a1a3a; }
  .light .ci-btn { background:linear-gradient(135deg,#1a7acc,#2a9aff); }
  .light .pd-badge-item { background:#ffffff; border:2px solid #e0d0f0; }
  .light .pd-badge-item div { color:#1a1a3a !important; }
  .light .streak-card { background:#ffffff; border:2px solid #f0c090; }
  .light .streak-val { color:#b86600 !important; }
  .light .streak-lbl { color:#6a6a9a !important; }
  .light .xp-bar-wrap { background:rgba(80,80,200,.12); }
  .light .month-prog-bg { background:rgba(80,80,200,.12); }
  .light .xp-bar { background:linear-gradient(90deg,#5050cc,#aa44ff); }
  .light .month-prog-fill { background:linear-gradient(90deg,#c07000,#ffaa00); }
  .light .player-bottom-nav { background:#ffffff !important; border-top:2px solid #dde4f8 !important; box-shadow:0 -2px 12px rgba(0,0,80,.07) !important; }
  .light .player-nav-btn { color:#8a8ab0 !important; }
  .light .player-nav-btn.active { color:#7a5800 !important; }
  .light .player-nav-btn.active::after { background:#c09000 !important; }
  .light .pd-tab-title { color:#1a1a3a !important; }
  .light .lb-list .lb-row { background:#ffffff; border-color:#dde4f8; }
  .light .lb-name { color:#1a1a3a !important; }
  .light .lb-xp { color:#1a5fc0 !important; }
  .light .lb-level { color:#6a6a9a !important; }
  .light .sfida-card { background:#ffffff !important; border:2px solid #f0b0b0 !important; }
  .light .sfida-title { color:#1a1a3a !important; }
  .light .act-card { background:#ffffff; border-left:4px solid currentColor; }
  .light .act-nm { color:#1a1a3a !important; }
  .light .act-edu { filter:brightness(.7) saturate(1.3); }
  .light .adsc { color:#5a5a8a !important; }
  .light .msg-card { background:#ffffff; border-color:#dde4f8; }
  .light .mhdr { background:#f8f9ff; color:#3a3a9a; }
  .light .bb-t { background:#f0f4ff; color:#1a1a3a; border-color:#e0e6f8; }
  .light .bb-m { background:#e0f0ff; color:#1a5fc0; border-color:#b0d4f8; }
  .light .notif-item { border-color:#eef0f8; }
  .light .ntit { color:#1a1a3a !important; }
  .light .nbdy { color:#5a5a8a !important; }
  .light .ntim { color:#8a8ab0 !important; }
  .light .xp-lbl { color:#6a6a9a !important; }
  .light .xp-sub { color:#6a6a9a !important; }
  .light .xp-bg { background:rgba(80,80,200,.12); }
  .light .form-input { background:#ffffff; border:2px solid #c8d4f0; color:#1a1a3a; }
  .light .pin-input { color:#3a3aaa !important; }
  .light .pst { background:rgba(100,100,200,.06); border-right:1px solid rgba(80,80,200,.12); }
  .light .pstv { color:#7a5800 !important; }
  .light .pstl { color:#6a6a9a !important; }
  .light .av-glow { background:radial-gradient(circle,rgba(180,180,255,.5) 0%,transparent 70%); }
  .light .xp-fill { background:linear-gradient(90deg,#5050cc,#aa44ff); }
  .light .nb.on { color:#7a5800 !important; }
  .light .nb.on::after { background:#c09000 !important; }
  .light .nb { color:#8a8ab0; }
  .light .bb { border-radius:12px; }
  .light .bav { background:#f0f4ff; border-color:#dde4f8; }

  /* ═══ PLAYER DASHBOARD — NEW DESIGN ═══ */
  .player-wrap { background:linear-gradient(160deg,#1e1060 0%,#1a3590 45%,#2a1275 100%); min-height:100vh; position:relative; z-index:1; }
  .pd-topbar { position:fixed; top:0; left:0; right:0; height:56px; background:rgba(0,0,0,.85); border-bottom:1px solid rgba(255,255,255,.1); z-index:20; display:flex; align-items:center; padding:0 14px; justify-content:space-between; backdrop-filter:blur(20px); }
  .pd-logo-box { background:#cc1111; border-radius:9px 12px 9px 14px; padding:4px 10px; transform:rotate(-1.5deg); box-shadow:2px 3px 0 rgba(0,0,0,.2); }
  .pd-logo-t { font-family:'Barlow Condensed',sans-serif; font-size:13px; font-weight:900; color:#111; line-height:1.05; text-transform:uppercase; letter-spacing:-.3px; }
  .pd-logo-sub { font-family:'Barlow Condensed',sans-serif; background:#111; color:#ffe600; font-size:8px; font-weight:900; border-radius:4px; padding:2px 7px; text-transform:uppercase; letter-spacing:.07em; margin-top:2px; display:inline-block; }
  .pd-scroll { padding-top:66px; padding-bottom:calc(68px + env(safe-area-inset-bottom,0px)); }
  .pd-av-zone { display:flex; flex-direction:column; align-items:center; padding-top:6px; position:relative; z-index:2; }
  .pd-av-glow { position:absolute; width:280px; height:240px; border-radius:50%; background:radial-gradient(circle,rgba(80,140,255,.38) 0%,transparent 70%); top:0; left:50%; transform:translateX(-50%); filter:blur(18px); pointer-events:none; }
  .pd-av-img { width:240px; height:240px; object-fit:contain; position:relative; z-index:3; filter:drop-shadow(0 12px 28px rgba(0,0,0,.55)) drop-shadow(0 0 50px rgba(100,160,255,.28)); margin-bottom:-14px; }
  .pd-av-emoji { font-size:160px; line-height:1; position:relative; z-index:3; margin-bottom:-14px; filter:drop-shadow(0 12px 28px rgba(0,0,0,.55)); display:block; text-align:center; }
  .pd-name-pill { background:#111; color:#fff; font-family:'Barlow Condensed',sans-serif; font-size:21px; font-weight:900; text-transform:uppercase; letter-spacing:.07em; border-radius:10px 13px 10px 15px; padding:5px 18px; position:relative; z-index:3; margin-bottom:4px; box-shadow:2px 3px 0 rgba(0,0,0,.3); }
  .pd-lv-pill { display:inline-flex; align-items:center; gap:5px; background:rgba(0,212,255,.1); border:1px solid rgba(0,212,255,.28); border-radius:99px; padding:4px 14px; font-size:10px; font-weight:700; color:var(--neon-blue); letter-spacing:.07em; text-transform:uppercase; position:relative; z-index:3; margin-bottom:12px; }
  .pd-card { margin:0 14px 8px; background:rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.12); border-radius:14px; padding:12px 14px; position:relative; z-index:2; }
  .pd-sg { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin:0 14px 8px; position:relative; z-index:2; }
  .pd-sc { background:rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:11px 6px; text-align:center; }
  .pd-sv { font-family:'Barlow Condensed',sans-serif; font-size:24px; font-weight:900; color:#ffcc00; line-height:1; display:block; }
  .pd-sl { font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.1em; color:rgba(255,255,255,.38); margin-top:2px; display:block; }
  .pd-squad { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(255,255,255,.12); border-radius:12px; padding:11px 14px; display:flex; align-items:center; gap:10px; position:relative; z-index:2; }
  .pd-sfida { margin:0 14px 8px; background:#111; border-radius:16px; padding:14px 16px; position:relative; z-index:2; overflow:hidden; }
  .pd-sfida::after { content:'★'; position:absolute; right:14px; top:50%; transform:translateY(-50%); font-size:44px; color:rgba(255,220,0,.1); line-height:1; }
  .pd-badges { margin:0 14px 8px; position:relative; z-index:2; }
  .pd-badge-row { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; scrollbar-width:none; }
  .pd-badge-row::-webkit-scrollbar { display:none; }
  .pd-badge-item { flex-shrink:0; background:rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:10px 8px; text-align:center; min-width:68px; cursor:pointer; transition:all .2s; }
  .pd-badge-item:hover { border-color:rgba(255,0,204,.4); transform:translateY(-2px); }
  .pd-checkin { margin:0 14px 8px; background:rgba(0,0,0,.4); border:1px solid rgba(0,255,136,.2); border-radius:16px; padding:14px; position:relative; z-index:2; }
  .pd-tab-title { font-family:'Barlow Condensed',sans-serif; font-size:30px; font-weight:900; text-transform:uppercase; letter-spacing:.04em; margin-bottom:14px; position:relative; z-index:2; padding:0 2px; }
  /* override bottom nav for new design */
  .player-bottom-nav { background:rgba(0,0,0,.88) !important; border-top:1px solid rgba(255,255,255,.1) !important; }
  .player-nav-btn { color:rgba(255,255,255,.28) !important; }
  .player-nav-btn.active { color:#ffcc00 !important; }
  .player-nav-btn.active::after { background:#ffcc00 !important; box-shadow:0 0 8px rgba(255,204,0,.5) !important; }
`;


// ─── UTILS ────────────────────────────────────────────────

function Avatar({ url, emoji, size = 40 }) {
  if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }} />;
  return <span style={{ fontSize: size * 0.52 }}>{emoji || "🌱"}</span>;
}

function XpBar({ xp, dark = false }) {
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
  const s = SQUAD_STYLE[name] || { bg: "#252525", text: "#999" };
  return <span className="squad-pill" style={{ background: s.bg, color: s.text }}>{name}</span>;
}

function SectionBanner({ sectionKey, title, sub, sectionColors, onEdit }) {
  const cfg = sectionColors?.[sectionKey] || DEFAULT_SECTION_COLORS[sectionKey] || { color: "#252525", image: null };
  return (
    <div className="section-banner" style={{ background: cfg.image ? undefined : cfg.color }}>
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

function AvatarUpload({ playerId, currentUrl, onUploaded }) {
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(currentUrl);

  async function handleFile(e) {
    const file = e.target.files[0]; if (!file) return;
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `avatars/${playerId}.${ext}`;
    const { error } = await sb.storage.from("avatars").upload(path, file, { upsert: true });
    if (error) { alert("Errore upload: " + error.message); setUploading(false); return; }
    const { data } = sb.storage.from("avatars").getPublicUrl(path);
    const url = data.publicUrl + "?t=" + Date.now();
    await sb.from("profiles").update({ avatar_url: url }).eq("id", playerId);
    setPreview(url); onUploaded && onUploaded(url); setUploading(false);
  }

  return (
    <div className="avatar-upload-area" onClick={() => fileRef.current.click()}>
      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
      {preview ? <img src={preview} className="avatar-preview" alt="avatar" /> : <div style={{ fontSize: 40, marginBottom: 8 }}>📷</div>}
      <div style={{ fontSize: 13, color: "var(--text2)" }}>{uploading ? "Caricamento…" : "Tocca per cambiare foto"}</div>
    </div>
  );
}

async function logAction({ playerId, action, xpDelta = 0, coinDelta = 0, note = "" }) {
  try {
    await sb.from("notifications").insert({
      user_id: playerId, type: "log_action", title: action,
      body: [xpDelta ? `+${xpDelta} XP` : "", coinDelta ? `+${coinDelta} Coin` : "", note].filter(Boolean).join(" · "),
    });
  } catch (_) {}
}

// ─── LOGIN ────────────────────────────────────────────────
// Due modalità: educator (email+password via Supabase Auth) e player (nickname+PIN diretto su profiles)

function Login({ onLogin }) {
  const [mode, setMode] = useState("player"); // "player" | "educator"

  // Player login
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState("");
  const [loadingPin, setLoadingPin] = useState(false);

  // Educator login
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [eduErr, setEduErr] = useState("");
  const [loadingEdu, setLoadingEdu] = useState(false);

  // Cerca nickname mentre digiti
  useEffect(() => {
    if (search.length < 2) { setSuggestions([]); return; }
    const t = setTimeout(async () => {
      const { data } = await sb.from("profiles").select("id, display_name, avatar_url, xp, squads(name)").eq("role", "player").ilike("display_name", `%${search}%`).limit(8);
      setSuggestions(data || []);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  async function loginPlayer() {
    if (!selectedPlayer || pin.length < 4) return;
    setLoadingPin(true); setPinErr("");
    const { data } = await sb.from("profiles").select("*, squads(name)").eq("id", selectedPlayer.id).single();
    if (!data) { setPinErr("Giocatore non trovato."); setLoadingPin(false); return; }
    const correctPin = data.pin || "1234";
    if (pin !== correctPin) { setPinErr("PIN non corretto!"); setLoadingPin(false); return; }
    // Salva sessione player in localStorage
    localStorage.setItem("pug_player", JSON.stringify({ ...data, _playerSession: true }));
    onLogin({ ...data, _playerSession: true });
    setLoadingPin(false);
  }

  async function loginEducator() {
    setLoadingEdu(true); setEduErr("");
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) { setEduErr(error.message); setLoadingEdu(false); return; }
    const { data: profile } = await sb.from("profiles").select("*, squads(name)").eq("id", data.user.id).single();
    onLogin(profile || { id: data.user.id, role: "educator", display_name: email.split("@")[0], xp: 0, coin: 100 });
    setLoadingEdu(false);
  }

  const lv = selectedPlayer ? getLevel(selectedPlayer.xp || 0) : null;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-title">Per·You<br/>Garden</div>
        <p className="login-sub">Accedi al tuo account</p>

        <div className="login-tabs">
          <button className={`login-tab ${mode === "player" ? "active" : ""}`} onClick={() => setMode("player")}>🌿 Sono un giocatore</button>
          <button className={`login-tab ${mode === "educator" ? "active" : ""}`} onClick={() => setMode("educator")}>🌱 Giardiniere</button>
        </div>

        {mode === "player" && (
          <>
            {!selectedPlayer ? (
              <>
                <div className="form-group">
                  <label className="form-label">Cerca il tuo nickname</label>
                  <input className="form-input" value={search} onChange={e => { setSearch(e.target.value); setSelectedPlayer(null); }} placeholder="Scrivi il tuo nome…" autoComplete="off" />
                </div>
                {suggestions.length > 0 && (
                  <div className="nickname-list">
                    {suggestions.map(p => {
                      const lv = getLevel(p.xp || 0);
                      return (
                        <div key={p.id} className="nickname-item" onClick={() => { setSelectedPlayer(p); setSearch(""); setSuggestions([]); }}>
                          <div style={{ width: 32, height: 32, borderRadius: "50%", overflow: "hidden", border: "2px solid var(--border2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <Avatar url={p.avatar_url} emoji={lv.emoji} size={32} />
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700 }}>{p.display_name}</div>
                            {p.squads?.name && <SquadPill name={p.squads.name} />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {search.length >= 2 && suggestions.length === 0 && (
                  <div style={{ fontSize: 13, color: "var(--text3)", textAlign: "center", padding: "12px 0" }}>Nessun giocatore trovato</div>
                )}
              </>
            ) : (
              <>
                {/* Giocatore selezionato — inserisci PIN */}
                <div style={{ textAlign: "center", marginBottom: 20 }}>
                  <div style={{ width: 64, height: 64, borderRadius: "50%", overflow: "hidden", border: "3px solid var(--azzurro)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px" }}>
                    <Avatar url={selectedPlayer.avatar_url} emoji={lv?.emoji} size={64} />
                  </div>
                  <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 24, fontWeight: 900, textTransform: "uppercase", color: "var(--text)" }}>{selectedPlayer.display_name}</div>
                  {selectedPlayer.squads?.name && <SquadPill name={selectedPlayer.squads.name} />}
                  <button className="btn btn-ghost btn-xs" style={{ marginTop: 8 }} onClick={() => { setSelectedPlayer(null); setPin(""); setPinErr(""); }}>← Cambia</button>
                </div>
                <div className="form-group">
                  <label className="form-label">PIN (4 cifre)</label>
                  <input className="form-input pin-input" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4} value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setPinErr(""); }} onKeyDown={e => e.key === "Enter" && loginPlayer()} placeholder="••••" autoFocus />
                </div>
                {pinErr && <p className="err-msg">{pinErr}</p>}
                <button className="btn btn-primary" onClick={loginPlayer} disabled={loadingPin || pin.length < 4}>{loadingPin ? "Accesso…" : "Entra"}</button>
              </>
            )}
          </>
        )}

        {mode === "educator" && (
          <>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && loginEducator()} placeholder="nome@email.com" autoComplete="email" />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input className="form-input" type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && loginEducator()} placeholder="••••••••" autoComplete="current-password" />
            </div>
            {eduErr && <p className="err-msg">{eduErr}</p>}
            <button className="btn btn-primary" onClick={loginEducator} disabled={loadingEdu}>{loadingEdu ? "Accesso…" : "Accedi"}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── EDUCATOR VIEWS ───────────────────────────────────────

function PlayersView({ sectionColors, setSectionColors }) {
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
  const [showCreatePlayer, setShowCreatePlayer] = useState(false);
  const [newPlayer, setNewPlayer] = useState({ display_name:"", first_name:"", pin:"1234", squad_id:"", xp:0, coin:0 });
  const [createPlayerErr, setCreatePlayerErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await sb.from("profiles").select("id,display_name,first_name,avatar_url,xp,coin,pin,squad_id,current_streak,role,squads(name,color)").eq("role", "player").order("xp", { ascending: false });
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
    await sb.from("profiles").update({ display_name: p.display_name, squad_id: p.squad_id, xp: p.xp, coin: p.coin, pin: p.pin || "1234" }).eq("id", p.id);
    setEditPlayer(null); load();
  }

  async function resetAllPins() {
    if (!confirm("Resettare tutti i PIN a 1234?")) return;
    await sb.from("profiles").update({ pin: "1234" }).eq("role", "player");
    setMsg("Tutti i PIN resettati a 1234");
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
    const payload = {
      id: crypto.randomUUID(),
      display_name: newPlayer.display_name.trim(),
      first_name: newPlayer.first_name.trim() || null,
      role: "player",
      pin: newPlayer.pin || "1234",
      squad_id: newPlayer.squad_id || null,
      xp: Number(newPlayer.xp) || 0,
      coin: Number(newPlayer.coin) || 0,
    };
    const { error } = await sb.from("profiles").insert(payload);
    if (error) { setCreatePlayerErr("Errore: " + error.message); return; }
    setShowCreatePlayer(false);
    setNewPlayer({ display_name:"", first_name:"", pin:"1234", squad_id:"", xp:0, coin:0 });
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
              return (
                <div key={p.id} className={`player-card ${selected.has(p.id) ? "selected" : ""}`} onClick={() => { const n = new Set(selected); n.has(p.id) ? n.delete(p.id) : n.add(p.id); setSelected(n); }}>
                  <div className="avatar-wrap"><Avatar url={p.avatar_url} emoji={lv.emoji} /></div>
                  <div className="p-name">{p.display_name}</div>
                  <div className="p-level">{lv.emoji} {lv.name}</div>
                  <div className="p-xp">{p.xp} XP</div>
                  <div className="p-coin">🪙 {p.coin}</div>
                  {p.squads?.name && <SquadPill name={p.squads.name} />}
                  <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>PIN: <span style={{ color: "var(--azzurro)", fontWeight: 700 }}>{p.pin || "1234"}</span></div>
                  <div className="pts-row" onClick={e => e.stopPropagation()}>
                    <button className="pts-btn rem" onClick={() => changeXP(p.id, -10)}>−</button>
                    <button className="pts-btn add" onClick={() => changeXP(p.id, 10)}>+</button>
                    <button className="pts-btn rem" style={{ fontSize: 10, width: 34, borderRadius: 8 }} onClick={() => changeXP(p.id, -5, "coin")}>🪙−</button>
                    <button className="pts-btn add" style={{ fontSize: 10, width: 34, borderRadius: 8 }} onClick={() => changeXP(p.id, 5, "coin")}>🪙+</button>
                  </div>
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
            <div className="form-group"><label className="form-label">Squadra</label>
              <select value={newPlayer.squad_id} onChange={e=>setNewPlayer(p=>({...p,squad_id:e.target.value}))}>
                <option value="">Nessuna squadra</option>
                {squads.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div className="form-group"><label className="form-label">PIN</label><input className="form-input" maxLength={4} value={newPlayer.pin} onChange={e=>setNewPlayer(p=>({...p,pin:e.target.value.replace(/\D/g,"").slice(0,4)}))} style={{textAlign:"center",fontFamily:"'Barlow Condensed'",fontSize:20,letterSpacing:4}}/></div>
              <div className="form-group"><label className="form-label">XP inizio</label><input className="form-input" type="number" value={newPlayer.xp} onChange={e=>setNewPlayer(p=>({...p,xp:e.target.value}))}/></div>
              <div className="form-group"><label className="form-label">Coin inizio</label><input className="form-input" type="number" value={newPlayer.coin} onChange={e=>setNewPlayer(p=>({...p,coin:e.target.value}))}/></div>
            </div>
            {createPlayerErr && <div style={{color:"var(--danger)",fontSize:12,fontWeight:700,marginBottom:8}}>{createPlayerErr}</div>}
            <div style={{background:"rgba(255,204,0,.06)",border:"1px solid rgba(255,204,0,.2)",borderRadius:10,padding:"8px 12px",fontSize:11,color:"var(--text3)",marginBottom:12}}>💡 Il giocatore potrà cambiare il PIN al primo accesso. Il nickname deve essere unico.</div>
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
            <AvatarUpload playerId={editPlayer.id} currentUrl={editPlayer.avatar_url} onUploaded={url => setEditPlayer(p => ({ ...p, avatar_url: url }))} />
            <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={editPlayer.display_name} onChange={e => setEditPlayer(p => ({ ...p, display_name: e.target.value }))} /></div>
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
              <div className="form-group"><label className="form-label">PIN</label><input className="form-input" type="text" maxLength={4} value={editPlayer.pin} onChange={e => setEditPlayer(p => ({ ...p, pin: e.target.value.replace(/\D/g, "").slice(0, 4) }))} style={{ textAlign: "center", fontFamily: "'Barlow Condensed'", fontSize: 20, letterSpacing: 4 }} /></div>
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

function PlayerDetailPanel({ playerId, squads, onClose }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("storia");
  const [editing, setEditing] = useState(null);
  const [saveMsg, setSaveMsg] = useState("");

  const loadData = useCallback(async () => {
    const [{ data: p }, { data: badges }, { data: att }, { data: notifs }] = await Promise.all([
      sb.from("profiles").select("*, squads(name)").eq("id", playerId).single(),
      sb.from("player_badges").select("*, badges(name,image_url)").eq("player_id", playerId).order("assigned_at", { ascending: false }),
      sb.from("attendances").select("*").eq("player_id", playerId).order("date", { ascending: false }).limit(30),
      sb.from("notifications").select("*").eq("user_id", playerId).order("created_at", { ascending: false }).limit(40),
    ]);
    setData({ profile: p, badges: badges || [], attendances: att || [], history: notifs || [] });
    if (p) setEditing({ xp: p.xp, coin: p.coin, pin: p.pin || "1234", display_name: p.display_name, squad_id: p.squad_id });
  }, [playerId]);

  useEffect(() => { loadData(); }, [loadData]);

  async function saveEdits() {
    if (!editing) return;
    await sb.from("profiles").update({ xp: Number(editing.xp), coin: Number(editing.coin), pin: editing.pin || "1234", display_name: editing.display_name, squad_id: editing.squad_id || null }).eq("id", playerId);
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

  const { profile, badges, attendances, history } = data;
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
            <div style={{fontFamily:"'Barlow Condensed'",fontSize:26,fontWeight:900,textTransform:"uppercase",color:"var(--text)",lineHeight:1}}>{profile?.display_name}</div>
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
          {[["storia","📜 Storia"],["badge","🎖️ Badge"],["presenze","✅ Presenze"],["modifica","✏️ Modifica"]].map(([id,label]) => (
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

        {tab==="presenze" && (
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            {attendances.length===0 && <div className="empty">Nessuna presenza.</div>}
            {attendances.map(a => {
              const icons={full:"✅",partial:"🟡",completed:"⭐",none:"❌"};
              return (
                <div key={a.id} style={{display:"flex",gap:10,alignItems:"center",padding:"8px 12px",background:"rgba(0,0,0,.15)",borderRadius:8}}>
                  <span style={{fontSize:16}}>{icons[a.status]||"—"}</span>
                  <span style={{flex:1,fontSize:13,color:"var(--text)"}}>{a.date}</span>
                  <span style={{fontSize:12,color:"var(--azzurro)",fontWeight:700}}>+{a.xp_awarded||0} XP</span>
                  <span style={{fontSize:12,color:"var(--neon-gold)",fontWeight:700}}>🪙 +{a.coin_awarded||0}</span>
                </div>
              );
            })}
          </div>
        )}

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
              <div className="form-group"><label className="form-label">PIN</label><input className="form-input" maxLength={4} value={editing.pin} onChange={e=>setEditing(p=>({...p,pin:e.target.value.replace(/[^0-9]/g,"").slice(0,4)}))} style={{textAlign:"center",fontFamily:"'Barlow Condensed'",fontSize:20,letterSpacing:4}}/></div>
            </div>
            {saveMsg && <div style={{color:"var(--verde)",fontWeight:700,fontSize:13,marginBottom:8}}>{saveMsg}</div>}
            <button className="btn btn-primary" onClick={saveEdits}>Salva modifiche</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Podium({ ranked, xpData, timeFilter, highlightId }) {
  const top3 = ranked.slice(0, 3);
  if (top3.length < 2) return null;
  const order = [1, 0, 2]; // silver, gold, bronze
  const cols = ["pod-2", "pod-1", "pod-3"];
  const crowns = [null, "👑", null];
  const xpColors = ["#aac8e0", "#ffcc00", "#d4916a"];
  const sizes = [54, 68, 48];
  return (
    <div className="podium-wrap">
      {order.map((pos, i) => {
        const p = top3[pos];
        if (!p) return <div key={i} className={`pod-col ${cols[i]}`}/>;
        const lv = getLevel(p.xp);
        const xpShown = timeFilter === "oggi" ? xpData[p.id]||0 : timeFilter === "mese" ? xpData[p.id]||0 : p.xp;
        const isMe = p.id === highlightId;
        return (
          <div key={p.id} className={`pod-col ${cols[i]}`}>
            {crowns[i] && <span className="pod-crown">{crowns[i]}</span>}
            <div className="pod-av-wrap" style={isMe?{outline:"2px solid var(--neon-blue)",outlineOffset:2}:{}}>
              <Avatar url={p.avatar_url} emoji={lv.emoji} size={sizes[i]}/>
            </div>
            <div className="pod-name">{p.display_name}{isMe&&<span style={{color:"var(--azzurro)",fontSize:9,display:"block"}}>TU</span>}</div>
            <div className="pod-xp">{xpShown} XP</div>
            <div className="pod-base">
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:900,color:xpColors[i]}}>{["2°","1°","3°"][i]}</div>
            </div>
          </div>
        );
      })}
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

  useEffect(() => {
    async function load() {
      const today = new Date().toISOString().split("T")[0];
      const monthStart = today.slice(0, 7) + "-01";
      const [{ data }, { data: sq }, { data: attToday }, { data: attMonth }] = await Promise.all([
        sb.from("profiles").select("id,display_name,avatar_url,xp,squad_id,squads(name)").eq("role", "player").order("xp", { ascending: false }),
        sb.from("squads").select("*"),
        sb.from("attendances").select("player_id, xp_awarded").eq("date", today),
        sb.from("attendances").select("player_id, xp_awarded").gte("date", monthStart),
      ]);
      setPlayers(data || []); setSquads(sq || []);
      // Aggregate XP today
      const td = {}; (attToday || []).forEach(a => { td[a.player_id] = (td[a.player_id] || 0) + (a.xp_awarded || 0); });
      setXpToday(td);
      // Aggregate XP this month
      const mt = {}; (attMonth || []).forEach(a => { mt[a.player_id] = (mt[a.player_id] || 0) + (a.xp_awarded || 0); });
      setXpMonth(mt);
      setLoading(false);
    }
    load();
  }, []);

  let ranked = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
  if (timeFilter === "oggi") {
    ranked = [...ranked].sort((a, b) => (xpToday[b.id] || 0) - (xpToday[a.id] || 0)).slice(0, 3);
  } else if (timeFilter === "mese") {
    ranked = [...ranked].sort((a, b) => (xpMonth[b.id] || 0) - (xpMonth[a.id] || 0)).slice(0, 10);
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
                <div key={p.id} className="lb-row">
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
  const [players, setPlayers] = useState([]);
  const [squads, setSquads] = useState([]);
  const [attendances, setAttendances] = useState({});
  const [squadFilter, setSquadFilter] = useState("all");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(true);
  const [customizing, setCustomizing] = useState(false);
  const config = { xp_daily_checkin: 10, coin_daily_checkin: 5, xp_week_bonus: 50 };

  useEffect(() => {
    async function load() {
      const [{ data: pl }, { data: sq }, { data: att }] = await Promise.all([
        sb.from("profiles").select("id,display_name,avatar_url,xp,coin,squad_id,squads(name)").eq("role","player").order("display_name"),
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
        <div className="stat-card"><div className="stat-label">XP pres.</div><div className="stat-value">{config.xp_daily_checkin}</div></div>
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
        <>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:10, padding:"8px 10px", background:"rgba(255,255,255,.03)", border:"1px solid var(--border)", borderRadius:10, fontSize:11, color:"var(--text3)" }}>
          <span><strong style={{color:"var(--text2)"}}>Legenda stati:</strong></span>
          <span><span className="pres-dot pd-none" style={{display:"inline-flex",width:22,height:22,fontSize:10}}>?</span> Assente</span>
          <span><span className="pres-dot pd-partial" style={{display:"inline-flex",width:22,height:22,fontSize:10}}>~</span> Parziale</span>
          <span><span className="pres-dot pd-yes" style={{display:"inline-flex",width:22,height:22,fontSize:10}}>✓</span> Presente (+XP)</span>
          <span><span className="pres-dot pd-completed" style={{display:"inline-flex",width:22,height:22,fontSize:10}}>★</span> Lab completata</span>
        </div>
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
        </>
      )}
      {customizing && <BannerCustomizer sectionKey="presenze" sectionColors={sectionColors} setSectionColors={setSectionColors} onClose={() => setCustomizing(false)} />}
    </div>
  );
}

function ActivitiesView({ sectionColors, setSectionColors }) {
  const [activities, setActivities] = useState([]);
  const [educators, setEducators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", link: "", educator_id: "", duration_days: 4, xp_partial: 10, xp_full: 20, xp_completed: 35, coin_partial: 5, coin_full: 10, coin_completed: 18, coin_cost: 20, max_participants: "" });

  const load = useCallback(async () => {
    const [{ data }, { data: edu }] = await Promise.all([
      sb.from("activities").select("*, profiles(display_name)").eq("is_active", true).order("created_at", { ascending: false }),
      sb.from("profiles").select("id,display_name").eq("role","educator").order("display_name"),
    ]);
    setActivities(data || []); setEducators(edu || []); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const [createErr, setCreateErr] = useState("");

  async function createActivity() {
    const name = (form.name || "").trim();
    if (!name) { setCreateErr("Nome obbligatorio"); return; }
    setCreateErr("Creazione in corso…");
    try {
      const { error } = await sb.from("activities").insert({
        name,
        description: (form.description || "").trim() || null,
        duration_days: Number(form.duration_days) || 1,
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
      });
      if (error) {
        setCreateErr("❌ " + error.message + " [" + error.code + "]");
        return;
      }
      setCreateErr("");
      setShowForm(false);
      setForm({ name:"", description:"", link:"", educator_id:"",
        duration_days:4, xp_partial:10, xp_full:20, xp_completed:35,
        coin_partial:5, coin_full:10, coin_completed:18, coin_cost:20, max_participants:"" });
      load();
    } catch(e) {
      setCreateErr("❌ Eccezione: " + (e?.message || String(e)));
    }
  }

  async function deleteActivity(id) {
    if (!confirm("Eliminare?")) return;
    await sb.from("activities").update({ is_active: false }).eq("id", id);
    setActivities(prev => prev.filter(a => a.id !== id));
  }

  return (
    <div>
      <SectionBanner sectionKey="attivita" title="Lab" sub={`${activities.length} attive`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-yellow btn-sm" onClick={() => setShowForm(true)}>+ Nuovo Lab</button>
      </div>
      {loading ? <div className="loading">⏳</div> : (
        <div className="act-grid">
          {activities.map(a => (
            <div key={a.id} className="act-card">
              <button className="delete-btn" onClick={() => deleteActivity(a.id)}>✕</button>
              <div className="act-title">{a.name}</div>
              <div className="act-meta">{a.description} · {a.duration_days}g</div>
              {a.profiles?.display_name && <div style={{ fontSize: 11, color: "var(--verde)", fontWeight: 700, marginBottom: 6 }}>🌱 Giardiniere: {a.profiles.display_name}</div>}
              {a.link && <a href={a.link} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--azzurro)", display: "block", marginBottom: 6, wordBreak: "break-all" }}>🔗 {a.link}</a>}
              <div className="act-rewards">
                <span className="reward-tag xp-tag">Max {a.xp_completed} XP</span>
                <span className="reward-tag coin-tag">🪙 {a.coin_cost}</span>
              </div>
            </div>
          ))}
          {activities.length === 0 && <div className="empty">Nessuna lab.</div>}
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Nuovo Lab</div>
            <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div className="form-group"><label className="form-label">Descrizione</label><textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
            <div className="form-group"><label className="form-label">Link (opzionale)</label><input className="form-input" type="url" value={form.link} onChange={e => setForm(f => ({ ...f, link: e.target.value }))} placeholder="https://…" /></div>
            <div className="form-group"><label className="form-label">🌱 Giardiniere presente</label>
              <select value={form.educator_id} onChange={e => setForm(f => ({ ...f, educator_id: e.target.value }))}>
                <option value="">Nessuno assegnato</option>
                {educators.map(e => <option key={e.id} value={e.id}>{e.display_name}</option>)}
              </select>
            </div>
            {[["duration_days","Durata (giorni)","number"],["coin_cost","Costo coin","number"],["max_participants","Max partecipanti (opt.)","number"]].map(([k,l,t]) => (
              <div className="form-group" key={k}><label className="form-label">{l}</label><input className="form-input" type={t} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} /></div>
            ))}
            <div className="section-label">XP per livello</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[["xp_partial","Parz."],["xp_full","Compl."],["xp_completed","Fine"]].map(([k,l]) => (
                <div key={k}><label className="form-label">{l}</label><input className="form-input" type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: Number(e.target.value) }))} /></div>
              ))}
            </div>
            {createErr && <div style={{ color:"var(--danger)", fontSize:12, fontWeight:700, marginBottom:8 }}>{createErr}</div>}
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
  const [newBadge, setNewBadge] = useState({ name: "", description: "", link: "", xp_default: 20, coin_default: 10, image_url: null });
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
            <div className="avatar-upload-area" onClick={() => badgeFileRef.current.click()}>
              <input ref={badgeFileRef} type="file" accept="image/*" onChange={uploadBadgeImage} style={{ display: "none" }} />
              {newBadge.image_url ? <img src={newBadge.image_url} className="avatar-preview" alt="badge" /> : <div style={{ fontSize: 40, marginBottom: 8 }}>🖼️</div>}
              <div style={{ fontSize: 13, color: "var(--text2)" }}>{uploadingBadge ? "Caricamento…" : "Carica immagine badge"}</div>
            </div>
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
  const [form, setForm] = useState({ title:"", description:"", xp_reward:20, coin_reward:10, expires_at:"" });

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
    };
    await sb.from("activities").insert(payload);
    setShowForm(false);
    setForm({ title:"", description:"", xp_reward:20, coin_reward:10, expires_at:"" });
    load();
  }

  async function deleteSfida(id) {
    if (!confirm("Disattivare questa sfida?")) return;
    await sb.from("activities").update({ is_active: false }).eq("id", id);
    setSfide(prev => prev.filter(s => s.id !== id));
  }

  return (
    <div>
      <SectionBanner sectionKey="sfida" title="Sfida del Giorno" sub={`${sfide.length} attive`} sectionColors={sectionColors} onEdit={() => setCustomizing(true)} />
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
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <span className="sfida-reward">🏆 +{s.xp_completed} XP · 🪙 +{s.coin_completed}</span>
                {s.expires_at && (
                  <span style={{ fontSize:10, color:"rgba(255,255,255,.4)", fontWeight:700 }}>
                    ⏰ Scade: {new Date(s.expires_at).toLocaleDateString("it-IT")}
                  </span>
                )}
              </div>
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
              <label className="form-label">Data scadenza (opzionale)</label>
              <input className="form-input" type="date" value={form.expires_at} onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} min={new Date().toISOString().split("T")[0]} />
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
  const [dateFilter, setDateFilter] = useState(new Date().toISOString().split("T")[0]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const dayStart = dateFilter + "T00:00:00";
      const dayEnd = dateFilter + "T23:59:59";
      const [{ data: notifs }, { data: atts }] = await Promise.all([
        sb.from("notifications").select("*, profiles(display_name)")
          .gte("created_at", dayStart).lte("created_at", dayEnd)
          .order("created_at", { ascending: false }).limit(200),
        sb.from("attendances").select("*, profiles(display_name)")
          .eq("date", dateFilter).neq("status","none")
          .order("created_at", { ascending: false }),
      ]);
      // Merge: notifiche + presenze come eventi
      const presEvents = (atts || []).filter(a => a.profiles).map(a => ({
        id: "att_" + a.id,
        type: "presenza",
        title: `Presenza ${a.status === "full" ? "completa" : a.status === "partial" ? "parziale" : "completata"}`,
        body: `+${a.xp_awarded || 0} XP · +${a.coin_awarded || 0} Coin`,
        profiles: a.profiles,
        created_at: a.created_at || (dateFilter + "T12:00:00"),
      }));
      const allEntries = [...(notifs||[]).filter(n => n.profiles), ...presEvents]
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      setEntries(allEntries); setLoading(false);
    }
    load();
  }, [dateFilter]);

  const typeIcon = { badge_assigned:"🎖️", booking_confirmed:"✅", booking_rejected:"❌", log_action:"📌", presenza:"✅", new_message:"💬", level_up:"🆙" };
  const typeColor = { badge_assigned:"var(--rosa)", booking_confirmed:"var(--verde)", booking_rejected:"var(--danger)", presenza:"var(--neon-green)", new_message:"var(--azzurro)", level_up:"var(--neon-gold)" };

  return (
    <div>
      <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 32, fontWeight: 900, textTransform: "uppercase", color: "var(--azzurro)", marginBottom: 16 }}>📜 Diario giornate</div>
      <div className="filter-bar">
        <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} style={{ padding: 10, background: "var(--surface2)", border: "1.5px solid var(--border2)", borderRadius: 10, color: "var(--text)", fontSize: 14, flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={() => setDateFilter(new Date().toISOString().split("T")[0])}>Oggi</button>
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
                  <span className="diary-icon" style={{ color: typeColor[e.type] || "var(--text2)" }}>{typeIcon[e.type] || "🔔"}</span>
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

function MessagesView({ profile }) {
  const [squads, setSquads] = useState([]);
  const [players, setPlayers] = useState([]);
  const [activities, setActivities] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [destType, setDestType] = useState("tutti"); // tutti | squad | player | activity
  const [destSquad, setDestSquad] = useState("");
  const [destPlayer, setDestPlayer] = useState("");
  const [destActivity, setDestActivity] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState("");

  useEffect(() => {
    async function load() {
      const [{ data: sq }, { data: pl }, { data: act }, { data: m }] = await Promise.all([
        sb.from("squads").select("*").order("name"),
        sb.from("profiles").select("id,display_name").eq("role","player").order("display_name"),
        sb.from("activities").select("id,name").eq("is_active",true).order("name"),
        sb.from("messages").select("*, profiles(display_name)").order("created_at", { ascending: false }).limit(50),
      ]);
      setSquads(sq || []); setPlayers(pl || []); setActivities(act || []); setMsgs(m || []); setLoading(false);
    }
    load();
  }, []);

  async function sendMessage() {
    if (!body.trim()) return;
    setSending(true);
    const msgData = { sender_id: profile.id, body: body.trim(), is_broadcast: false, squad_id: null, recipient_id: null };
    if (destType === "tutti") msgData.is_broadcast = true;
    else if (destType === "squad") msgData.squad_id = destSquad || null;
    else if (destType === "player") msgData.recipient_id = destPlayer || null;
    else if (destType === "activity") {
      // Send to all confirmed bookings for this activity
      const { data: bookings } = await sb.from("bookings").select("player_id").eq("activity_id", destActivity).eq("status","confirmed");
      if (bookings?.length) {
        for (const bk of bookings) {
          await sb.from("messages").insert({ ...msgData, recipient_id: bk.player_id });
          await sb.from("notifications").insert({ user_id: bk.player_id, type: "new_message", title: "Nuovo messaggio dal Giardiniere", body: body.trim() });
        }
        setBody(""); setSent(`Inviato a ${bookings.length} partecipanti ✅`); setTimeout(() => setSent(""), 3000); setSending(false); return;
      } else { setSent("Nessun partecipante confermato"); setTimeout(() => setSent(""), 3000); setSending(false); return; }
    }
    await sb.from("messages").insert(msgData);
    // Notify recipients
    if (destType === "tutti") {
      const { data: allPlayers } = await sb.from("profiles").select("id").eq("role","player");
      for (const p of (allPlayers || [])) {
        await sb.from("notifications").insert({ user_id: p.id, type: "new_message", title: "Nuovo messaggio dal Giardiniere", body: body.trim() });
      }
    } else if (destType === "squad" && destSquad) {
      const { data: squadPlayers } = await sb.from("profiles").select("id").eq("squad_id", destSquad);
      for (const p of (squadPlayers || [])) {
        await sb.from("notifications").insert({ user_id: p.id, type: "new_message", title: "Nuovo messaggio dal Giardiniere", body: body.trim() });
      }
    } else if (destType === "player" && destPlayer) {
      await sb.from("notifications").insert({ user_id: destPlayer, type: "new_message", title: "Nuovo messaggio dal Giardiniere", body: body.trim() });
    }
    setBody(""); setSent("Messaggio inviato ✅"); setTimeout(() => setSent(""), 3000);
    // Reload messages
    const { data: m } = await sb.from("messages").select("*, profiles(display_name)").order("created_at", { ascending: false }).limit(50);
    setMsgs(m || []); setSending(false);
  }

  const destLabel = destType === "tutti" ? "📢 Tutti i giocatori" : destType === "squad" ? `🛡️ Squadra` : destType === "player" ? "👤 Giocatore singolo" : "⚡ Partecipanti lab";

  return (
    <div>
      <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 28, fontWeight: 900, textTransform: "uppercase", color: "var(--text)", marginBottom: 16 }}>💬 Messaggi</div>

      {/* Compose */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>Nuovo messaggio</div>

        {/* Destinatario */}
        <div className="form-group">
          <label className="form-label">Destinatario</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {[["tutti","📢 Tutti"],["squad","🛡️ Squadra"],["player","👤 Giocatore"],["activity","⚡ Lab"]].map(([k,l]) => (
              <button key={k} className={`chip ${destType === k ? "active" : ""}`} onClick={() => setDestType(k)}>{l}</button>
            ))}
          </div>
          {destType === "squad" && (
            <select value={destSquad} onChange={e => setDestSquad(e.target.value)}>
              <option value="">Seleziona squadra…</option>
              {squads.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {destType === "player" && (
            <select value={destPlayer} onChange={e => setDestPlayer(e.target.value)}>
              <option value="">Seleziona giocatore…</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
          )}
          {destType === "activity" && (
            <select value={destActivity} onChange={e => setDestActivity(e.target.value)}>
              <option value="">Seleziona lab…</option>
              {activities.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
        </div>
        <div className="form-group">
          <label className="form-label">Testo</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} placeholder={`Scrivi un messaggio per ${destLabel}…`} />
        </div>
        {sent && <div style={{ fontSize: 13, color: "var(--verde)", fontWeight: 700, marginBottom: 8 }}>{sent}</div>}
        <button className="btn btn-primary" onClick={sendMessage} disabled={sending || !body.trim() || (destType === "squad" && !destSquad) || (destType === "player" && !destPlayer) || (destType === "activity" && !destActivity)}>
          {sending ? "Invio…" : "Invia messaggio"}
        </button>
      </div>

      {/* Storico */}
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>Storico messaggi</div>
      {loading ? <div className="loading">⏳</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {msgs.map(m => {
            const dest = m.is_broadcast ? "📢 Tutti" : m.squad_id ? "🛡️ Squadra" : m.recipient_id ? "👤 Diretto" : "—";
            return (
              <div key={m.id} className="card-sm">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--azzurro)" }}>{dest}</span>
                  <span style={{ fontSize: 10, color: "var(--text3)" }}>{new Date(m.created_at).toLocaleDateString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--text)" }}>{m.body}</div>
              </div>
            );
          })}
          {msgs.length === 0 && <div className="empty">Nessun messaggio inviato.</div>}
        </div>
      )}
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
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{b.profiles?.display_name}</div>
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
              <img src={`https://api.qrserver.com/v1/create-qr-code/?data=${qr.code}&size=200x200&bgcolor=ffffff&color=000000&qzone=1`} alt={qr.code} style={{ width:200, height:200, display:"block", borderRadius:8 }}/>
            </div>
            <div style={{ fontFamily:"'Barlow Condensed'", fontSize:34, fontWeight:900, color:"var(--neon-blue)", letterSpacing:8, margin:"10px 0 6px", textShadow:"var(--glow-blue)" }}>{qr.code}</div>
            <div style={{ fontSize:13, color:"var(--text2)", marginBottom:16 }}>Valido {new Date(qr.valid_from).getHours()}:00 – {new Date(qr.valid_until).getHours()}:00</div>
            <button className="btn btn-ghost" style={{ width:"100%" }} onClick={generateQr}>🔄 Rigenera</button>
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
      <div style={{fontFamily:"'Barlow Condensed'",fontSize:28,fontWeight:900,textTransform:"uppercase",color:"var(--text)",marginBottom:16}}>🔥 Streak & Badge Mensili</div>
      <div style={{background:"rgba(255,120,0,.06)",border:"1px solid rgba(255,120,0,.2)",borderRadius:14,padding:"12px 16px",marginBottom:16,fontSize:13,color:"var(--text2)",lineHeight:1.5}}>
        Configura i requisiti per guadagnare il badge mensile. Il badge viene assegnato automaticamente al primo check-in del mese successivo se il giocatore ha raggiunto il minimo di presenze.
      </div>
      {msg && <div style={{background:"rgba(0,255,136,.08)",border:"1px solid rgba(0,255,136,.2)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:"var(--neon-green)",fontWeight:700}}>{msg}</div>}
      {loading ? <div className="loading">⏳</div> : (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {months.map(m => {
            const cfg = configs.find(c => c.month === m.month) || { month: m.month, year: m.year, min_days: 10, xp_reward: 50, coin_reward: 25, badge_name: `${m.label} ${m.year}` };
            const isPast = m.month < now.getMonth() + 1;
            const isCurrent = m.month === now.getMonth() + 1;
            return (
              <div key={m.month} style={{background:"rgba(8,18,40,0.9)",border:`1px solid ${isCurrent?"rgba(255,140,0,.3)":isPast?"rgba(0,255,136,.15)":"var(--border)"}`,borderRadius:14,padding:"12px 16px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:editing?.month===m.month?12:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:20}}>{isPast?"✅":isCurrent?"🔥":"📅"}</span>
                    <div>
                      <div style={{fontFamily:"'Barlow Condensed'",fontSize:18,fontWeight:900,textTransform:"uppercase",color:"var(--text)"}}>{m.label} {m.year}</div>
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
  const [monthPresences, setMonthPresences] = useState(null);
  const [monthTarget, setMonthTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editingFirstName, setEditingFirstName] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [lbTimeFilter, setLbTimeFilter] = useState("generale");
  const [selectedBadge, setSelectedBadge] = useState(null);
  const [mustChangePin, setMustChangePin] = useState(profile.pin === "1234");
  const [playerTheme, setPlayerTheme] = useState(() => localStorage.getItem("pug_theme") || "dark");

  useEffect(() => {
    document.body.classList.toggle("light", playerTheme === "light");
    localStorage.setItem("pug_theme", playerTheme);
  }, [playerTheme]);
  const [newPin1, setNewPin1] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const [pinChangeErr, setPinChangeErr] = useState("");

  const load = useCallback(async () => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const monthStart = today.slice(0, 7) + "-01";
    const [{ data: p }, { data: b }, { data: a }, { data: bk }, { data: n }, { data: pl }, { data: m }, { data: attToday }, { data: attMonth }] = await Promise.all([
      sb.from("profiles").select("id,display_name,first_name,avatar_url,xp,coin,pin,squad_id,current_streak,longest_streak,last_checkin_date,squads(name)").eq("id", profile.id).single(),
      sb.from("player_badges").select("id,assigned_at,xp_awarded,coin_awarded,badges(name,image_url,xp_default,description,link)").eq("player_id", profile.id).order("assigned_at", { ascending: false }),
      sb.from("activities").select("id,name,description,link,duration_days,xp_partial,xp_full,xp_completed,coin_partial,coin_full,coin_completed,coin_cost,is_active,expires_at,max_participants,educator_id,profiles(display_name)").eq("is_active", true).order("created_at", { ascending: false }),
      sb.from("bookings").select("id,status,coin_held,created_at,activities(name)").eq("player_id", profile.id).order("created_at", { ascending: false }),
      sb.from("notifications").select("id,type,title,body,read_at,created_at").eq("user_id", profile.id).neq("type", "log_action").order("created_at", { ascending: false }).limit(20),
      sb.from("profiles").select("id,display_name,avatar_url,xp,squad_id,squads(name)").eq("role","player").order("xp", { ascending: false }),
      sb.from("messages").select("id,body,is_broadcast,squad_id,recipient_id,read_at,created_at,profiles(display_name)").or(`is_broadcast.eq.true,recipient_id.eq.${profile.id}${fullProfile?.squad_id ? `,squad_id.eq.${fullProfile.squad_id}` : ""}`).order("created_at", { ascending: false }).limit(20),
      sb.from("attendances").select("player_id, xp_awarded").eq("date", today),
      sb.from("attendances").select("player_id, xp_awarded").gte("date", monthStart),
    ]);
    if (p) setFullProfile(p);
    setBadges(b || []); setActivities(a || []); setBookings(bk || []); setNotifications(n || []); setPlayers(pl || []); setMessages(m || []);
    const td = {}; (attToday || []).forEach(a => { td[a.player_id] = (td[a.player_id] || 0) + (a.xp_awarded || 0); }); setXpToday(td);
    const mt = {}; (attMonth || []).forEach(a => { mt[a.player_id] = (mt[a.player_id] || 0) + (a.xp_awarded || 0); }); setXpMonth(mt);
    // Presenze mese corrente per il giocatore
    const now = new Date();
    const cm = now.getMonth() + 1;
    const cy = now.getFullYear();
    const mStart = `${cy}-${String(cm).padStart(2,"0")}-01`;
    const [{ data: myPres }, { data: mConfig }] = await Promise.all([
      sb.from("attendances").select("id").eq("player_id", profile.id).gte("date", mStart).neq("status","none"),
      sb.from("streak_config").select("min_days").eq("month", cm).eq("year", cy).single(),
    ]);
    setMonthPresences(myPres?.length || 0);
    setMonthTarget(mConfig?.min_days || null);
  } catch(err) {
    console.error("Errore caricamento dati:", err);
  } finally {
    setLoading(false);
  }
  }, [profile.id]);

  useEffect(() => {
    load();
    const channel = sb.channel("player_notifs_" + profile.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: `id=eq.${profile.id}` }, load)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${profile.id}` }, load)
      .subscribe();
    return () => sb.removeChannel(channel);
  }, [profile.id, load]);

  async function checkAndAssignMonthlyBadge(currentXp, currentCoin) {
    const now = new Date();
    if (now.getDate() > 5) return; // Solo nei primi 5 giorni del mese
    const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
    const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const { data: config } = await sb.from("streak_config").select("*").eq("month", prevMonth).eq("year", prevYear).single();
    if (!config) return;
    const badgeName = config.badge_name || `${MONTH_NAMES[prevMonth-1]} ${prevYear}`;
    const monthStart = `${prevYear}-${String(prevMonth).padStart(2,"0")}-01`;
    const monthEnd = `${prevYear}-${String(prevMonth).padStart(2,"0")}-31`;
    const [{ data: presences }, { data: existingBadge }] = await Promise.all([
      sb.from("attendances").select("id").eq("player_id", profile.id).gte("date", monthStart).lte("date", monthEnd).neq("status","none"),
      sb.from("player_badges").select("id, badges(name)").eq("player_id", profile.id),
    ]);
    const alreadyHas = existingBadge?.some(pb => pb.badges?.name === badgeName);
    if (alreadyHas) return;
    if ((presences?.length || 0) < config.min_days) return;
    let { data: badge } = await sb.from("badges").select("id").eq("name", badgeName).single();
    if (!badge) {
      const { data: nb } = await sb.from("badges").insert({ name: badgeName, description: `Presente almeno ${config.min_days} giorni in ${badgeName}!`, xp_default: config.xp_reward, coin_default: config.coin_reward }).select().single();
      badge = nb;
    }
    if (!badge) return;
    await sb.from("player_badges").insert({ player_id: profile.id, badge_id: badge.id, xp_awarded: config.xp_reward, coin_awarded: config.coin_reward });
    await sb.from("profiles").update({ xp: currentXp + config.xp_reward, coin: currentCoin + config.coin_reward }).eq("id", profile.id);
    await sb.from("notifications").insert({ user_id: profile.id, type: "badge_assigned", title: `🏅 Badge ${badgeName} sbloccato!`, body: `+${config.xp_reward} XP · +${config.coin_reward} Coin` });
    setQrMsg(prev => prev + ` · 🏅 Badge ${badgeName}!`);
    setFullProfile(prev => ({ ...prev, xp: prev.xp + config.xp_reward, coin: prev.coin + config.coin_reward }));
  }

  async function doCheckin() {
    const today = new Date().toISOString().split("T")[0];
    const { data: qr } = await sb.from("daily_qr").select("*").eq("date", today).single();
    if (!qr) { setQrMsg("Nessun QR attivo oggi."); return; }
    if (qrInput.toUpperCase() !== qr.code) { setQrMsg("❌ Codice non valido."); return; }
    const { error } = await sb.from("attendances").insert({ player_id: profile.id, date: today, check_type: "daily", status: "full", xp_awarded: 10, coin_awarded: 5, qr_verified: true });
    if (error?.code === "23505") { setQrMsg("Hai già fatto il check-in oggi!"); return; }
    // Calcola streak
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const wasYesterday = fullProfile?.last_checkin_date === yesterday;
    const newStreak = wasYesterday ? (fullProfile?.current_streak || 0) + 1 : 1;
    const newLongest = Math.max(newStreak, fullProfile?.longest_streak || 0);
    const newXp = (fullProfile?.xp || 0) + 10;
    const newCoin = (fullProfile?.coin || 0) + 5;
    await sb.from("profiles").update({ xp: newXp, coin: newCoin, current_streak: newStreak, longest_streak: newLongest, last_checkin_date: today }).eq("id", profile.id);
    setQrMsg(`✅ Check-in! +10 XP +5 Coin · 🔥 ${newStreak} giorni`);
    setFullProfile(prev => ({ ...prev, xp: newXp, coin: newCoin, current_streak: newStreak, longest_streak: newLongest, last_checkin_date: today }));
    await checkAndAssignMonthlyBadge(newXp, newCoin);
  }

  async function bookActivity(actId, cost) {
    if ((fullProfile?.coin || 0) < cost) { alert("Coin insufficienti!"); return; }
    await sb.from("bookings").insert({ player_id: profile.id, activity_id: actId, coin_held: cost });
    await sb.from("profiles").update({ coin: (fullProfile?.coin || 0) - cost }).eq("id", profile.id);
    setFullProfile(prev => ({ ...prev, coin: (prev?.coin || 0) - cost }));
    alert("✅ Prenotazione inviata!");
    load();
  }

  async function saveFirstName() {
    const v = newFirstName.trim().slice(0, 30);
    await sb.from("profiles").update({ first_name: v }).eq("id", profile.id);
    setFullProfile(prev => ({ ...prev, first_name: v }));
    setEditingFirstName(false);
  }

  const lv = getLevel(fullProfile?.xp || 0);
  const unread = notifications.filter(n => !n.read_at).length;
  const unreadMsgs = messages.filter(m => !m.read_at).length;

  // Leaderboard ranked
  let lbRanked = [...players];
  if (lbTimeFilter === "oggi") lbRanked = lbRanked.sort((a, b) => (xpToday[b.id] || 0) - (xpToday[a.id] || 0)).slice(0, 3);
  else if (lbTimeFilter === "mese") lbRanked = lbRanked.sort((a, b) => (xpMonth[b.id] || 0) - (xpMonth[a.id] || 0)).slice(0, 10);

  async function saveNewPin() {
    if (newPin1.length < 4) { setPinChangeErr("Il PIN deve avere 4 cifre"); return; }
    if (newPin1 !== newPin2) { setPinChangeErr("I PIN non coincidono"); return; }
    if (newPin1 === "1234") { setPinChangeErr("Scegli un PIN diverso da 1234"); return; }
    const { error } = await sb.from("profiles").update({ pin: newPin1 }).eq("id", profile.id);
    if (error) { setPinChangeErr("Errore: " + error.message); return; }
    const saved = JSON.parse(localStorage.getItem("pug_player") || "{}");
    localStorage.setItem("pug_player", JSON.stringify({ ...saved, pin: newPin1 }));
    setMustChangePin(false);
  }

  if (mustChangePin) return (
    <div style={{background:'linear-gradient(160deg,#1e1060 0%,#1a3590 45%,#2a1275 100%)',minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{background:'rgba(0,0,20,.7)',border:'1px solid rgba(255,255,255,.15)',borderRadius:20,padding:'32px 24px',width:'100%',maxWidth:360,backdropFilter:'blur(20px)'}}>
        <div style={{textAlign:'center',marginBottom:24}}>
          <div style={{fontSize:48,marginBottom:8}}>🔐</div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:900,textTransform:'uppercase',color:'#fff',marginBottom:8}}>Imposta il tuo PIN</div>
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
    <div style={{background:'linear-gradient(160deg,#1e1060 0%,#1a3590 45%,#2a1275 100%)',minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:900,textTransform:'uppercase',color:'#A3CFFE',letterSpacing:'.08em'}}>🌿 Caricamento…</div>
    </div>
  );

  const BOTTOM_TABS = [
    ["profilo","👤","Profilo"],
    ["classifica","🏆","Classifica"],
    ["attivita","⚡","Lab"],
    ["messaggi","💬","Messaggi"],
    ["notifiche","🔔","Notifiche"],
  ];

  const xpPct = (() => { const nxt = LEVELS.find(l => l.xp > (fullProfile?.xp||0)); return nxt ? Math.min(100,Math.round(((fullProfile.xp-lv.xp)/(nxt.xp-lv.xp))*100)) : 100; })();

    const TAB_BG = {
      profilo:    'linear-gradient(160deg,#1e1060 0%,#1a3590 45%,#2a1275 100%)',
      classifica: 'linear-gradient(160deg,#001a6e 0%,#0030b8 50%,#001a6e 100%)',
      attivita:   'linear-gradient(160deg,#043a14 0%,#0a6a28 50%,#043a14 100%)',
      messaggi:   'linear-gradient(160deg,#5a0535 0%,#a00860 50%,#5a0535 100%)',
      notifiche:  'linear-gradient(160deg,#3d2200 0%,#7a4400 50%,#3d2200 100%)',
    };
    return (
    <div className="player-wrap" style={{background:TAB_BG[tab]||TAB_BG.profilo,transition:'background 0.5s ease'}}>
      {/* Floral background */}
      <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:0,opacity:.07,overflow:'hidden'}}>
        <svg viewBox="0 0 380 700" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" style={{width:'100%',height:'100%'}}>
          <defs>
            <g id="fl"><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(0)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(60)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(120)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(180)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(240)"/><ellipse cx="0" cy="-12" rx="5" ry="10" fill="white" transform="rotate(300)"/><circle cx="0" cy="0" r="4" fill="white"/></g>
            <g id="lf"><ellipse cx="0" cy="-14" rx="4" ry="12" fill="white" transform="rotate(20)"/><ellipse cx="0" cy="-14" rx="4" ry="12" fill="white" transform="rotate(-20)"/></g>
          </defs>
          <use href="#fl" transform="translate(40,60) scale(1.2)"/><use href="#lf" transform="translate(90,130)"/><use href="#fl" transform="translate(320,80) scale(.9)"/><use href="#lf" transform="translate(280,170) scale(1.1)"/><use href="#fl" transform="translate(55,260) scale(.8)"/><use href="#lf" transform="translate(340,310)"/><use href="#fl" transform="translate(170,360) scale(1.3)"/><use href="#lf" transform="translate(45,430) scale(1.2)"/><use href="#fl" transform="translate(305,450) scale(.9)"/><use href="#lf" transform="translate(200,510)"/><use href="#fl" transform="translate(75,570) scale(1.1)"/><use href="#lf" transform="translate(335,595) scale(.8)"/><use href="#fl" transform="translate(185,640) scale(.9)"/><use href="#lf" transform="translate(115,690) scale(1.2)"/>
        </svg>
      </div>

      {/* Top bar */}
      <div className="pd-topbar">
        <div>
          <div className="pd-logo-box"><div className="pd-logo-t">PeR·You<br/>GaRDeN</div></div>
          <div className="pd-logo-sub">gratuito &amp; popolare</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {fullProfile?.squads?.name && (
            <div style={{background:'#111',color:'#ffcc00',fontSize:10,fontWeight:900,borderRadius:8,padding:'5px 10px',textTransform:'uppercase',letterSpacing:'.05em'}}>⚡ {fullProfile.squads.name}</div>
          )}
          <button onClick={()=>setPlayerTheme(t=>t==="dark"?"light":"dark")} style={{background:'rgba(255,255,255,.08)',border:'1px solid rgba(255,255,255,.15)',borderRadius:8,padding:'5px 9px',cursor:'pointer',fontSize:14,lineHeight:1}} title="Cambia tema">
            {playerTheme==="dark"?"☀️":"🌙"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onLogout} style={{fontSize:11}}>Esci</button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="pd-scroll">

        {/* ── PROFILO ── */}
        {tab === "profilo" && fullProfile && (
          <div>
            {/* Avatar Hero */}
            <div className="pd-av-zone">
              <div className="pd-av-glow"/>
              {fullProfile.avatar_url
                ? <img src={fullProfile.avatar_url} className="pd-av-img" alt="avatar"/>
                : <span className="pd-av-emoji">{lv.emoji}</span>
              }
              <div className="pd-name-pill">{fullProfile.display_name}</div>
              <div className="pd-lv-pill">{lv.emoji} LV.{lv.id} · {lv.name}</div>
            </div>

            {/* Profile card: thumbnail + nome editabile + XP */}
            <div className="pd-card">
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                <div style={{width:52,height:52,borderRadius:10,border:'2px solid rgba(255,204,0,.6)',overflow:'hidden',flexShrink:0,background:'rgba(0,0,0,.3)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <Avatar url={fullProfile.avatar_url} emoji={lv.emoji} size={52}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:900,color:'#fff',textTransform:'uppercase',letterSpacing:'.04em',marginBottom:2}}>{fullProfile.display_name}</div>
                  {fullProfile.squads?.name && <SquadPill name={fullProfile.squads.name}/>}
                </div>
              </div>
              {editingFirstName ? (
                <div style={{display:'flex',gap:8,marginBottom:8}}>
                  <input className="form-input" value={newFirstName} onChange={e=>setNewFirstName(e.target.value.slice(0,30))} placeholder="Il tuo nome…" style={{flex:1}} maxLength={30} autoFocus/>
                  <button className="btn btn-yellow btn-sm" onClick={saveFirstName} disabled={!newFirstName.trim()}>Salva</button>
                  <button className="btn btn-ghost btn-sm" onClick={()=>setEditingFirstName(false)}>✕</button>
                </div>
              ) : (
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                  <span style={{fontSize:14,color:'#ffcc00',fontWeight:800}}>{fullProfile.first_name || <span style={{color:'rgba(255,255,255,.3)',fontSize:12}}>Aggiungi il tuo nome ✏️</span>}</span>
                  <button className="btn btn-ghost btn-xs" onClick={()=>{setNewFirstName(fullProfile.first_name||'');setEditingFirstName(true);}}>✏️</button>
                </div>
              )}
              <div style={{fontSize:9,fontWeight:900,color:'rgba(255,255,255,.35)',textTransform:'uppercase',letterSpacing:'.07em',marginBottom:5,display:'flex',justifyContent:'space-between'}}>
                <span>{lv.emoji} {lv.name}</span>
                <span>{fullProfile.xp} / {LEVELS.find(l=>l.xp>(fullProfile.xp||0))?.xp||'MAX'} XP</span>
              </div>
              <div style={{height:8,background:'rgba(255,255,255,.08)',borderRadius:99,overflow:'hidden'}}>
                <div style={{height:'100%',background:'linear-gradient(90deg,#6644ff,#aa44ff)',borderRadius:99,width:xpPct+'%',boxShadow:'0 0 8px rgba(130,80,255,.5)'}}/>
              </div>
            </div>

            {/* Stats grid 1: XP, Coin, Badge */}
            <div className="pd-sg">
              {[['⭐',fullProfile.xp,'XP'],['🪙',fullProfile.coin,'Coin'],['🎖️',badges.length,'Badge']].map(([ic,v,l])=>(
                <div key={l} className="pd-sc"><span style={{fontSize:18,display:'block',marginBottom:3}}>{ic}</span><span className="pd-sv">{v}</span><span className="pd-sl">{l}</span></div>
              ))}
            </div>

            {/* Stats grid 2: Lab, Conf., Rank */}
            <div className="pd-sg">
              {[['🌿',activities.filter(a=>!a.description?.includes('SFIDA')).length,'Lab'],['✅',bookings.filter(b=>b.status==='confirmed').length,'Confermati'],['🏆',(players.findIndex(p=>p.id===profile.id)+1)||'-','Rank']].map(([ic,v,l])=>(
                <div key={l} className="pd-sc"><span style={{fontSize:18,display:'block',marginBottom:3}}>{ic}</span><span className="pd-sv">{v}</span><span className="pd-sl">{l}</span></div>
              ))}
            </div>

            {/* Streak */}
            {((fullProfile.current_streak||0) > 0 || (fullProfile.longest_streak||0) > 0) && (
              <div className="streak-card">
                <div style={{fontSize:9,fontWeight:900,textTransform:'uppercase',letterSpacing:'.12em',color:'rgba(255,140,0,.7)',marginBottom:8}}>🔥 Streak presenze</div>
                <div className="streak-row">
                  <div className="streak-item"><span className="streak-val">{fullProfile.current_streak||0}</span><span className="streak-lbl">Giorni attuali</span></div>
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
            {fullProfile.squads?.name && (
              <div className="pd-squad">
                <div style={{width:36,height:36,borderRadius:8,background:SQUAD_STYLE[fullProfile.squads.name]?.bg||'#339966',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>⚡</div>
                <div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:18,fontWeight:900,color:'#fff',textTransform:'uppercase',letterSpacing:'.04em',lineHeight:1}}>Squadra {fullProfile.squads.name}</div>
                  <div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,.38)',textTransform:'uppercase',letterSpacing:'.08em',marginTop:1}}>Membro</div>
                </div>
              </div>
            )}

            {/* Sfida del giorno */}
            {activities.filter(a=>a.description?.includes('SFIDA')).slice(0,1).map(s=>(
              <div key={s.id} className="pd-sfida">
                <div style={{fontSize:9,fontWeight:900,textTransform:'uppercase',letterSpacing:'.15em',color:'#ffcc00',marginBottom:4}}>⚡ Sfida del Giorno</div>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:900,textTransform:'uppercase',color:'#fff',marginBottom:7}}>{s.name}</div>
                <div style={{fontSize:12,color:'rgba(255,255,255,.5)',marginBottom:10,lineHeight:1.5}}>{s.description?.replace('SFIDA · ','')}</div>
                <div style={{display:'inline-flex',alignItems:'center',gap:5,background:'rgba(255,220,0,.14)',border:'1px solid rgba(255,220,0,.35)',borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:900,color:'#ffcc00'}}>🌟 +{s.xp_completed} XP · +{s.coin_completed} Coin</div>
              </div>
            ))}

            {/* Badge */}
            {badges.length > 0 && (
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

            {/* Check-in */}
            <div className="pd-checkin">
              <div style={{fontSize:9,fontWeight:900,textTransform:'uppercase',letterSpacing:'.15em',color:'var(--neon-green)',marginBottom:8}}>📍 Check-in giornaliero</div>
              <input className="form-input" value={qrInput} onChange={e=>setQrInput(e.target.value.toUpperCase())} placeholder="ABC123" style={{textAlign:'center',fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:900,letterSpacing:8,marginBottom:10}} maxLength={6}/>
              <button className="btn btn-primary" onClick={doCheckin}>Conferma presenza · +10 XP +5 🪙</button>
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
        {tab === "attivita" && (
          <div style={{ marginTop: 8 }}>
            <div className="pd-tab-title" style={{color:"#00ff88"}}>⚡ Lab</div>
            {activities.filter(a => a.description?.includes("SFIDA")).map(s => (
              <div key={s.id} className="sfida-card" style={{ marginBottom: 14 }}>
                <div className="sfida-label">⚡ Sfida del giorno</div>
                <div className="sfida-title">{s.name}</div>
                <div className="sfida-desc">{s.description?.replace("SFIDA · ", "")}</div>
                <span className="sfida-reward">🏆 +{s.xp_completed} XP · 🪙 +{s.coin_completed}</span>
              </div>
            ))}
            {activities.filter(a => !a.description?.includes("SFIDA")).map(a => {
              const booked = bookings.find(b => b.activities?.name === a.name || b.activity_id === a.id);
              return (
                <div key={a.id} className="act-card" style={{ marginBottom: 10 }}>
                  <div className="act-title">{a.name}</div>
                  <div className="act-meta">{a.description} · {a.duration_days} giorni</div>
                  {a.profiles?.display_name && <div style={{ fontSize: 12, color: "var(--verde)", fontWeight: 700, marginBottom: 6 }}>🌱 Giardiniere: {a.profiles.display_name}</div>}
                  {a.link && <a href={a.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "var(--azzurro)", display: "block", marginBottom: 8 }}>🔗 Scopri di più</a>}
                  <div className="act-rewards" style={{ marginBottom: 10 }}>
                    <span className="reward-tag xp-tag">Fino a {a.xp_completed} XP</span>
                    <span className="reward-tag coin-tag">🪙 {a.coin_cost} costo</span>
                  </div>
                  {booked ? (
                    <div className={`tag ${booked.status === "confirmed" ? "tag-green" : booked.status === "rejected" ? "tag-red" : "tag-amber"}`}>
                      {booked.status === "confirmed" ? "✅ Prenotato" : booked.status === "rejected" ? "❌ Rifiutata" : "⏳ In attesa"}
                    </div>
                  ) : (
                    <button className="btn btn-ghost btn-sm" style={{ width: "100%" }} onClick={() => bookActivity(a.id, a.coin_cost)} disabled={a.coin_cost > (fullProfile?.coin || 0)}>
                      {a.coin_cost > (fullProfile?.coin || 0) ? "🪙 Coin insufficienti" : "Prenota"}
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
            {messages.length === 0 ? <div className="empty">Nessun messaggio ricevuto.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {messages.map(m => (
                  <div key={m.id} className="card-sm">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 18 }}>🌱</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--verde)" }}>Giardiniere</span>
                      </div>
                      <span style={{ fontSize: 10, color: "var(--text3)" }}>{new Date(m.created_at).toLocaleDateString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <div style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.5 }}>{m.body}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── NOTIFICHE ── */}
        {tab === "notifiche" && (
          <div style={{ marginTop: 8 }}>
            <div className="pd-tab-title" style={{color:"#ffcc00"}}>🔔 Notifiche</div>
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
              <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 24, fontWeight: 900, textTransform: "uppercase", color: "var(--text)" }}>{selectedBadge.badges?.name}</div>
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

const EDUCATOR_TABS = [
  ["giocatori","👤","Giocatori"], ["classifica","🏆","Classifica"], ["squadre","🛡️","Squadre"],
  ["presenze","✅","Presenze"], ["attivita","⚡","Lab"], ["sfida","🔥","Sfida"],
  ["badge","🎖️","Badge"], ["streak","🔥","Streak"], ["prenotazioni","📋","Prenotazioni"], ["messaggi","💬","Messaggi"],
  ["diario","📜","Diario"], ["qr","📍","QR"],
];
const MOB_TABS_IDS = ["giocatori", "presenze", "classifica", "sfida", "qr"];

const EduTabColors = {
  giocatori:    { accent:"#A3CFFE", border:"rgba(163,207,254,.3)", bg:"rgba(163,207,254,.03)" },
  classifica:   { accent:"#ffcc00", border:"rgba(255,204,0,.3)",   bg:"rgba(255,204,0,.03)" },
  squadre:      { accent:"#00d4ff", border:"rgba(0,212,255,.3)",   bg:"rgba(0,212,255,.03)" },
  presenze:     { accent:"#00ff88", border:"rgba(0,255,136,.3)",   bg:"rgba(0,255,136,.03)" },
  attivita:     { accent:"#00ff88", border:"rgba(0,255,136,.3)",   bg:"rgba(0,255,136,.03)" },
  sfida:        { accent:"#ff2244", border:"rgba(255,34,68,.3)",   bg:"rgba(255,34,68,.03)" },
  badge:        { accent:"#ff00cc", border:"rgba(255,0,204,.3)",   bg:"rgba(255,0,204,.03)" },
  streak:       { accent:"#ff8c00", border:"rgba(255,140,0,.3)",   bg:"rgba(255,140,0,.03)" },
  prenotazioni: { accent:"#ffcc00", border:"rgba(255,204,0,.3)",   bg:"rgba(255,204,0,.03)" },
  messaggi:     { accent:"#aa44ff", border:"rgba(170,68,255,.3)",  bg:"rgba(170,68,255,.03)" },
  diario:       { accent:"#A3CFFE", border:"rgba(163,207,254,.3)", bg:"rgba(163,207,254,.03)" },
  qr:           { accent:"#00d4ff", border:"rgba(0,212,255,.3)",   bg:"rgba(0,212,255,.03)" },
};

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

  useEffect(() => { document.body.classList.toggle("light", theme === "light"); }, [theme]);

  const sharedProps = { sectionColors, setSectionColors };

  return (
    <div className="edu-layout">
      {/* Floral background */}
      <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:0,opacity:.04,overflow:'hidden'}}>
        <svg viewBox="0 0 1200 900" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" style={{width:'100%',height:'100%'}}>
          <defs><g id="ef"><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(0)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(60)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(120)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(180)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(240)"/><ellipse cx="0" cy="-14" rx="6" ry="12" fill="white" transform="rotate(300)"/><circle cx="0" cy="0" r="5" fill="white"/></g></defs>
          <use href="#ef" transform="translate(80,80) scale(1.4)"/><use href="#ef" transform="translate(350,60) scale(1.1)"/><use href="#ef" transform="translate(700,90) scale(1.3)"/><use href="#ef" transform="translate(1050,70) scale(1)"/><use href="#ef" transform="translate(200,300) scale(.9)"/><use href="#ef" transform="translate(550,280) scale(1.2)"/><use href="#ef" transform="translate(900,310) scale(1)"/><use href="#ef" transform="translate(100,550) scale(1.1)"/><use href="#ef" transform="translate(450,520) scale(.8)"/><use href="#ef" transform="translate(800,560) scale(1.3)"/><use href="#ef" transform="translate(250,780) scale(1)"/><use href="#ef" transform="translate(650,760) scale(1.2)"/><use href="#ef" transform="translate(1000,790) scale(.9)"/>
        </svg>
      </div>

      {/* Sidebar desktop */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-box"><div className="sidebar-logo-t">PeR·You<br/>GaRDeN</div></div>
          <div className="sidebar-logo-sub">gratuito &amp; popolare</div>
          <div className="sidebar-badge">🌱 Pannello Giardiniere</div>
        </div>
        <nav className="nav">
          {EDUCATOR_TABS.map(([id, icon, label]) => (
            <div key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <span className="nav-icon">{icon}</span><span>{label}</span>
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,cursor:"pointer",padding:"8px 10px",background:"rgba(255,255,255,.04)",borderRadius:10,border:"1px solid rgba(255,255,255,.07)"}} onClick={() => setShowAvatarModal(true)}>
            <div style={{width:34,height:34,borderRadius:"50%",overflow:"hidden",border:"2px solid rgba(255,204,0,.5)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
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
            <button className="theme-toggle" style={{background:theme==="light"?"rgba(255,204,0,.3)":"rgba(255,255,255,.1)",flexShrink:0}} onClick={()=>setTheme(t=>t==="dark"?"light":"dark")}>
              <div className="theme-toggle-knob" style={{background:theme==="light"?"#c08800":"rgba(255,255,255,.6)",transform:theme==="light"?"translateX(20px)":"translateX(0)"}}/>
            </button>
          </div>
          <button className="btn btn-ghost btn-sm" style={{width:"100%",color:"rgba(255,255,255,.45)",border:"1px solid rgba(255,255,255,.1)"}} onClick={onLogout}>Esci</button>
        </div>
      </div>

      {/* Header mobile */}
      <div className="mob-header">
        <button onClick={() => setDrawerOpen(true)} style={{background:"none",border:"none",color:"rgba(255,255,255,.6)",fontSize:22,cursor:"pointer",padding:4,lineHeight:1}}>☰</button>
        <div style={{transform:"rotate(-1deg)"}}>
          <div style={{background:"#cc1111",borderRadius:"7px 10px 7px 11px",padding:"3px 8px",display:"inline-block"}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:11,fontWeight:900,color:"#111",lineHeight:1.05,textTransform:"uppercase"}}>PeR·You GaRDeN</div>
          </div>
        </div>
        <span className="mob-header-title" style={{flex:1,marginLeft:8}}>{cur?.[2]}</span>
        <div style={{width:32,height:32,borderRadius:"50%",overflow:"hidden",border:"2px solid rgba(255,204,0,.5)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={() => setShowAvatarModal(true)}>
          <Avatar url={avatarUrl} emoji={lv.emoji} size={32}/>
        </div>
      </div>

      {/* Drawer mobile */}
      {drawerOpen && <div className="mob-drawer-bg" onClick={() => setDrawerOpen(false)}/>}
      <div className={`mob-drawer ${drawerOpen ? "open" : ""}`}>
        <div style={{padding:"18px 16px 14px",borderBottom:"1px solid rgba(255,255,255,.08)"}}>
          <div style={{transform:"rotate(-1deg)",marginBottom:8}}>
            <div style={{background:"#cc1111",borderRadius:"8px 11px 8px 12px",padding:"5px 10px",display:"inline-block"}}>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:14,fontWeight:900,color:"#111",lineHeight:1.05,textTransform:"uppercase"}}>PeR·You GaRDeN</div>
            </div>
          </div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",background:"#111",color:"#ffe600",fontSize:9,fontWeight:900,borderRadius:4,padding:"2px 8px",textTransform:"uppercase",letterSpacing:".07em",display:"inline-block"}}>🌱 Giardiniere</div>
        </div>
        <nav style={{flex:1,padding:"8px 0",overflowY:"auto"}}>
          {EDUCATOR_TABS.map(([id, icon, label]) => (
            <div key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => { setTab(id); setDrawerOpen(false); }}>
              <span className="nav-icon">{icon}</span><span>{label}</span>
            </div>
          ))}
        </nav>
        <div style={{padding:"14px 16px",borderTop:"1px solid rgba(255,255,255,.08)"}}>
          <button className="btn btn-ghost btn-sm" style={{width:"100%"}} onClick={onLogout}>Esci</button>
        </div>
      </div>

      {/* Main */}
      <div className="edu-main">
        <div className="topbar" style={{borderBottom:`1px solid ${["giocatori","classifica","squadre","presenze","attivita","sfida","badge","streak","prenotazioni","messaggi","diario","qr"].indexOf(tab) >= 0 ? EduTabColors[tab]?.border||"rgba(255,255,255,.08)" : "rgba(255,255,255,.08)"}`}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:6,height:28,borderRadius:3,background:EduTabColors[tab]?.accent||"rgba(255,255,255,.2)",flexShrink:0}}/>
            <div className="topbar-title">{cur?.[1]} {cur?.[2]}</div>
          </div>
          <div style={{fontSize:12,color:"rgba(255,255,255,.4)",fontWeight:700}}>{profile.display_name}</div>
        </div>
        <div className="content edu-content-wrap" style={{background:EduTabColors[tab]?.bg||"transparent"}}>
          {tab === "giocatori"    && <PlayersView {...sharedProps} />}
          {tab === "classifica"   && <LeaderboardView {...sharedProps} />}
          {tab === "squadre"      && <SquadsView />}
          {tab === "presenze"     && <AttendanceView {...sharedProps} />}
          {tab === "attivita"     && <ActivitiesView {...sharedProps} />}
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
    // Deregistra service worker se presente (evita cache stale)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(r => r.unregister());
      });
    }
    // Controlla prima sessione player (localStorage)
    const savedPlayer = localStorage.getItem("pug_player");
    if (savedPlayer) {
      try {
        const p = JSON.parse(savedPlayer);
        if (p?._playerSession && p?.id) {
          // Verifica che il profilo esista ancora
          sb.from("profiles").select("*, squads(name)").eq("id", p.id).single()
            .then(({ data }) => {
              if (data) setProfile({ ...data, _playerSession: true });
              else localStorage.removeItem("pug_player");
            })
            .catch(() => { localStorage.removeItem("pug_player"); })
            .finally(() => setChecking(false));
          return;
        }
      } catch (_) { localStorage.removeItem("pug_player"); }
    }

    // Poi controlla sessione educator (Supabase Auth)
    const _t = setTimeout(() => setChecking(false), 5000); // fallback timeout
    sb.auth.getSession()
      .then(async ({ data: { session } }) => {
        clearTimeout(_t);
        if (session) {
          const { data: p } = await sb.from("profiles").select("*, squads(name)").eq("id", session.user.id).single();
          setProfile(p || { id: session.user.id, role: "educator", display_name: session.user.email?.split("@")[0], xp: 0, coin: 100 });
        }
        setChecking(false);
      })
      .catch(() => { clearTimeout(_t); setChecking(false); });

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
    localStorage.removeItem("pug_player");
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
