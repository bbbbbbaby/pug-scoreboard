import { sb } from "./supabase.js";
import { useState, useEffect, useCallback } from "react";

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

const SQUAD_STYLE = {
  Verde:   { bg: "#EAF3DE", text: "#3B6D11", border: "#97C459" },
  Gialla:  { bg: "#FAEEDA", text: "#854F0B", border: "#EF9F27" },
  Azzurra: { bg: "#E6F1FB", text: "#185FA5", border: "#85B7EB" },
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', sans-serif; background: #0f1412; color: #e8f0ec; min-height: 100vh; }
  :root {
    --green: #3B6D11; --green-light: #EAF3DE; --green-mid: #639922;
    --amber: #854F0B; --amber-light: #FAEEDA;
    --blue: #185FA5; --blue-light: #E6F1FB;
    --surface: #1a2420; --surface2: #222e29; --surface3: #2a3830;
    --border: rgba(255,255,255,0.08); --border2: rgba(255,255,255,0.14);
    --text: #e8f0ec; --text2: #8fa898; --text3: #5a6e62;
    --accent: #4a9e2a; --accent2: #63c93a;
    --danger: #e24b4a; --warning: #EF9F27;
    --radius: 12px; --radius-sm: 8px;
  }
  .app { display: flex; min-height: 100vh; }
  .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; width: 100%; background: #0f1412; }
  .login-card { background: var(--surface); border: 1px solid var(--border2); border-radius: 20px; padding: 40px; width: 100%; max-width: 400px; }
  .login-logo { text-align: center; margin-bottom: 32px; }
  .login-logo-icon { font-size: 48px; display: block; margin-bottom: 8px; }
  .login-logo h1 { font-size: 22px; font-weight: 600; color: var(--text); letter-spacing: -0.5px; }
  .login-logo p { font-size: 13px; color: var(--text2); margin-top: 4px; }
  .form-group { margin-bottom: 16px; }
  .form-label { font-size: 12px; font-weight: 500; color: var(--text2); margin-bottom: 6px; display: block; text-transform: uppercase; letter-spacing: .05em; }
  .form-input { width: 100%; padding: 11px 14px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; outline: none; transition: border-color .15s; }
  .form-input:focus { border-color: var(--accent); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 18px; border-radius: var(--radius-sm); border: none; cursor: pointer; font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 500; transition: all .15s; white-space: nowrap; }
  .btn-primary { background: var(--accent); color: #fff; width: 100%; padding: 13px; font-size: 14px; }
  .btn-primary:hover { background: var(--accent2); }
  .btn-ghost { background: transparent; color: var(--text2); border: 1px solid var(--border2); }
  .btn-ghost:hover { background: var(--surface2); color: var(--text); }
  .btn-danger { background: rgba(226,75,74,.15); color: var(--danger); border: 1px solid rgba(226,75,74,.3); }
  .btn-danger:hover { background: rgba(226,75,74,.25); }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .btn-icon { width: 32px; height: 32px; padding: 0; border-radius: 50%; }
  .err-msg { font-size: 12px; color: var(--danger); margin-top: 10px; text-align: center; }
  .sidebar { width: 220px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .sidebar-logo { padding: 20px 18px 16px; border-bottom: 1px solid var(--border); }
  .sidebar-logo-title { font-size: 15px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .sidebar-logo-sub { font-size: 11px; color: var(--text3); margin-top: 3px; }
  .nav { flex: 1; padding: 10px 0; }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 18px; cursor: pointer; font-size: 13px; color: var(--text2); border-left: 2px solid transparent; transition: all .12s; }
  .nav-item:hover { background: var(--surface2); color: var(--text); }
  .nav-item.active { background: rgba(74,158,42,.1); color: var(--accent2); border-left-color: var(--accent); font-weight: 500; }
  .nav-icon { font-size: 15px; width: 20px; text-align: center; }
  .sidebar-user { padding: 14px 18px; border-top: 1px solid var(--border); }
  .sidebar-user-name { font-size: 12px; font-weight: 500; color: var(--text); }
  .sidebar-user-role { font-size: 11px; color: var(--text3); margin-top: 2px; }
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .topbar { padding: 14px 24px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  .topbar h2 { font-size: 16px; font-weight: 600; color: var(--text); margin-right: auto; }
  .content { flex: 1; overflow-y: auto; padding: 20px 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; }
  .card-sm { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .stat-label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px; }
  .stat-value { font-size: 24px; font-weight: 600; color: var(--text); }
  .stat-sub { font-size: 11px; color: var(--text2); margin-top: 3px; }
  .player-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
  .player-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 10px; text-align: center; cursor: pointer; transition: all .15s; position: relative; }
  .player-card:hover { border-color: var(--border2); transform: translateY(-1px); }
  .player-card.selected { border-color: var(--accent); background: rgba(74,158,42,.08); }
  .avatar-wrap { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 26px; border: 2px solid var(--border2); }
  .avatar-wrap img { width: 100%; height: 100%; object-fit: cover; }
  .p-name { font-size: 11px; font-weight: 500; color: var(--text); margin-bottom: 3px; word-break: break-word; line-height: 1.3; }
  .p-level { font-size: 10px; color: var(--text2); margin-bottom: 4px; }
  .p-xp { font-size: 11px; font-weight: 500; color: var(--accent2); }
  .p-coin { font-size: 10px; color: var(--amber); }
  .squad-pill { font-size: 9px; padding: 2px 7px; border-radius: 99px; display: inline-block; margin-top: 5px; font-weight: 500; }
  .pts-row { display: flex; gap: 4px; justify-content: center; margin-top: 8px; }
  .pts-btn { width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border2); background: var(--surface3); cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; color: var(--text2); font-family: 'DM Sans', sans-serif; transition: all .1s; line-height: 1; }
  .pts-btn:hover { background: var(--surface); }
  .pts-btn.add { color: var(--accent2); border-color: rgba(99,201,58,.3); }
  .pts-btn.rem { color: var(--danger); border-color: rgba(226,75,74,.3); }
  .badge-indicator { position: absolute; top: 8px; right: 8px; width: 8px; height: 8px; border-radius: 50%; background: var(--warning); }
  .lb-list { display: flex; flex-direction: column; gap: 6px; }
  .lb-row { display: flex; align-items: center; gap: 12px; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; transition: border-color .12s; }
  .lb-row:hover { border-color: var(--border2); }
  .lb-rank { font-size: 13px; font-weight: 600; width: 28px; text-align: center; color: var(--text3); flex-shrink: 0; }
  .lb-rank.gold { color: #EF9F27; } .lb-rank.silver { color: #8fa898; } .lb-rank.bronze { color: #D85A30; }
  .lb-av { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; overflow: hidden; border: 1px solid var(--border2); }
  .lb-av img { width: 100%; height: 100%; object-fit: cover; }
  .lb-name { flex: 1; font-size: 13px; font-weight: 500; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lb-level { font-size: 11px; color: var(--text3); }
  .lb-bar-wrap { width: 80px; height: 4px; background: var(--surface3); border-radius: 99px; overflow: hidden; flex-shrink: 0; }
  .lb-bar { height: 100%; background: var(--accent); border-radius: 99px; transition: width .4s; }
  .lb-xp { font-size: 12px; font-weight: 500; color: var(--accent2); width: 55px; text-align: right; flex-shrink: 0; }
  .lb-coin { font-size: 11px; color: var(--amber); width: 45px; text-align: right; flex-shrink: 0; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  .search-inp { padding: 8px 12px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; flex: 1; min-width: 160px; transition: border-color .15s; }
  .search-inp:focus { border-color: var(--accent); }
  .chip { padding: 6px 14px; border-radius: 99px; border: 1px solid var(--border2); background: transparent; color: var(--text2); font-family: 'DM Sans', sans-serif; font-size: 12px; cursor: pointer; transition: all .12s; font-weight: 500; }
  .chip:hover { background: var(--surface2); color: var(--text); }
  .chip.active { background: rgba(74,158,42,.15); color: var(--accent2); border-color: rgba(74,158,42,.4); }
  .batch-panel { background: rgba(74,158,42,.06); border: 1px solid rgba(74,158,42,.2); border-radius: var(--radius); padding: 14px 18px; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .batch-info { font-size: 13px; color: var(--accent2); font-weight: 500; flex: 1; }
  .batch-inp { width: 80px; padding: 7px 10px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Mono', monospace; font-size: 13px; outline: none; text-align: center; }
  .batch-inp:focus { border-color: var(--accent); }
  .pres-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .pres-table th { padding: 8px 10px; text-align: left; font-size: 10px; font-weight: 600; color: var(--text3); border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: .05em; position: sticky; top: 0; background: #0f1412; }
  .pres-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); color: var(--text); }
  .pres-dot { width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; font-family: 'DM Sans', sans-serif; transition: transform .1s; }
  .pres-dot:active { transform: scale(.9); }
  .pd-yes { background: rgba(74,158,42,.2); color: var(--accent2); }
  .pd-partial { background: rgba(239,159,39,.2); color: var(--warning); }
  .pd-completed { background: rgba(74,158,42,.35); color: #63c93a; }
  .pd-none { background: var(--surface3); color: var(--text3); }
  .act-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .act-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; transition: border-color .12s; }
  .act-card:hover { border-color: var(--border2); }
  .act-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .act-meta { font-size: 11px; color: var(--text2); margin-bottom: 10px; }
  .act-rewards { display: flex; gap: 6px; flex-wrap: wrap; }
  .reward-tag { font-size: 10px; padding: 2px 8px; border-radius: 99px; font-weight: 500; }
  .xp-tag { background: rgba(74,158,42,.15); color: var(--accent2); }
  .coin-tag { background: rgba(239,159,39,.15); color: var(--warning); }
  .day-tag { background: var(--surface3); color: var(--text2); }
  .badge-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; }
  .badge-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 10px; text-align: center; cursor: pointer; transition: all .15s; }
  .badge-card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .badge-img { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; margin: 0 auto 8px; display: block; border: 2px solid var(--border2); }
  .badge-emoji { font-size: 32px; display: block; margin: 0 auto 8px; }
  .badge-name { font-size: 11px; font-weight: 500; color: var(--text); line-height: 1.3; }
  .badge-pts { font-size: 10px; color: var(--text2); margin-top: 3px; }
  .msg-layout { display: flex; gap: 12px; height: 500px; }
  .msg-list { width: 180px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; flex-shrink: 0; }
  .msg-thread { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; cursor: pointer; transition: border-color .12s; }
  .msg-thread:hover { border-color: var(--border2); }
  .msg-thread.active { border-color: var(--accent); background: rgba(74,158,42,.08); }
  .mt-name { font-size: 12px; font-weight: 500; color: var(--text); }
  .mt-last { font-size: 11px; color: var(--text3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .msg-main { flex: 1; display: flex; flex-direction: column; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .msg-hdr { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 500; color: var(--text); }
  .msg-body { flex: 1; padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .bubble-wrap { display: flex; gap: 8px; }
  .bubble-wrap.mine { flex-direction: row-reverse; }
  .bubble-av { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; background: var(--surface3); overflow: hidden; }
  .bubble-av img { width: 100%; height: 100%; object-fit: cover; }
  .bubble { max-width: 220px; padding: 8px 12px; border-radius: 12px; font-size: 12px; line-height: 1.6; }
  .bubble.them { background: var(--surface3); color: var(--text); border-bottom-left-radius: 4px; }
  .bubble.mine { background: rgba(74,158,42,.2); color: var(--accent2); border-bottom-right-radius: 4px; }
  .msg-inp-row { padding: 10px 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; }
  .msg-inp { flex: 1; padding: 8px 12px; background: var(--surface3); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 12px; outline: none; }
  .msg-inp:focus { border-color: var(--accent); }
  .notif-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); display: inline-block; margin-left: 4px; vertical-align: middle; }
  .notif-item { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
  .notif-icon { font-size: 20px; flex-shrink: 0; }
  .notif-title { font-size: 13px; font-weight: 500; color: var(--text); margin-bottom: 2px; }
  .notif-body { font-size: 12px; color: var(--text2); }
  .notif-time { font-size: 10px; color: var(--text3); margin-top: 3px; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 16px; padding: 24px; width: 100%; max-width: 460px; max-height: 80vh; overflow-y: auto; }
  .modal-title { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 16px; }
  .section-label { font-size: 10px; font-weight: 600; color: var(--text3); text-transform: uppercase; letter-spacing: .08em; margin: 14px 0 8px; }
  .profile-hero { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 28px; text-align: center; margin-bottom: 16px; }
  .profile-avatar { width: 88px; height: 88px; border-radius: 50%; margin: 0 auto 14px; border: 3px solid var(--accent); display: flex; align-items: center; justify-content: center; font-size: 40px; overflow: hidden; }
  .profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .profile-name { font-size: 20px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .profile-level { font-size: 14px; color: var(--accent2); margin-bottom: 12px; }
  .xp-bar-wrap { height: 6px; background: var(--surface3); border-radius: 99px; overflow: hidden; margin: 8px 0; }
  .xp-bar { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 99px; transition: width .6s; }
  .xp-label { display: flex; justify-content: space-between; font-size: 10px; color: var(--text3); }
  .qr-wrap { text-align: center; padding: 24px; }
  .qr-code { font-family: 'DM Mono', monospace; font-size: 48px; font-weight: 500; color: var(--accent2); letter-spacing: 8px; margin: 16px 0; }
  .qr-date { font-size: 13px; color: var(--text2); }
  .loading { display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--text2); font-size: 14px; }
  .empty { text-align: center; padding: 40px; color: var(--text3); font-size: 13px; }
  .tag { font-size: 10px; padding: 2px 8px; border-radius: 99px; display: inline-block; font-weight: 500; }
  .tag-green { background: rgba(74,158,42,.15); color: var(--accent2); }
  .tag-amber { background: rgba(239,159,39,.15); color: var(--warning); }
  .tag-red { background: rgba(226,75,74,.15); color: var(--danger); }
  .tag-gray { background: var(--surface3); color: var(--text2); }
  select { padding: 8px 12px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; }
  select:focus { border-color: var(--accent); }
  textarea { width: 100%; padding: 10px 12px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; resize: vertical; min-height: 80px; }
  textarea:focus { border-color: var(--accent); }
  @media (max-width: 768px) {
    .sidebar { width: 56px; }
    .sidebar-logo-title span, .nav-item span, .sidebar-user { display: none; }
    .nav-item { justify-content: center; padding: 12px; }
    .stats-grid { grid-template-columns: 1fr 1fr; }
    .act-grid { grid-template-columns: 1fr; }
    .player-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
  }
`;

// ─── HELPER: crea profilo fallback da sessione ─────────────
// Usato quando il profilo non esiste ancora nel DB
function makeFallbackProfile(userId, email) {
  return { id: userId, role: "educator", display_name: email.split("@")[0], xp: 0, coin: 100 };
}

// ─── COMPONENTS ───────────────────────────────────────────

function Avatar({ url, emoji, size = 40 }) {
  if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }} />;
  return <span style={{ fontSize: size * 0.55 }}>{emoji || "🌱"}</span>;
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
  const s = SQUAD_STYLE[name] || { bg: "#1a2420", text: "#8fa898", border: "#2a3830" };
  return <span className="squad-pill" style={{ background: s.bg + "33", color: s.text, border: `1px solid ${s.border}44` }}>{name}</span>;
}

// ─── LOGIN ────────────────────────────────────────────────

function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setLoading(true); setErr("");
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) { setErr(error.message); setLoading(false); return; }
    const { data: profile } = await sb.from("profiles").select("*").eq("id", data.user.id).single();
    // ✅ FIX 1: se il profilo non esiste usa educator come fallback (non player)
    onLogin(profile || makeFallbackProfile(data.user.id, email));
    setLoading(false);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <span className="login-logo-icon">🌿</span>
          <h1>PUG Scoreboard</h1>
          <p>Accedi al tuo account</p>
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="nome@email.com" />
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <input className="form-input" type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="••••••••" />
        </div>
        <button className="btn btn-primary" onClick={handleLogin} disabled={loading}>
          {loading ? "Accesso in corso…" : "Accedi"}
        </button>
        {err && <p className="err-msg">{err}</p>}
      </div>
    </div>
  );
}

// ─── EDUCATOR VIEWS ───────────────────────────────────────

function PlayersView({ profile }) {
  const [players, setPlayers] = useState([]);
  const [squads, setSquads] = useState([]);
  const [search, setSearch] = useState("");
  const [squadFilter, setSquadFilter] = useState("all");
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [batchXp, setBatchXp] = useState(10);
  const [batchCoin, setBatchCoin] = useState(5);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await sb.from("profiles").select("*, squads(name, color)").eq("role", "player").order("xp", { ascending: false });
    const { data: sq } = await sb.from("squads").select("*");
    setPlayers(data || []);
    setSquads(sq || []);
    setLoading(false);
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
    setPlayers(prev => prev.map(x => x.id === playerId ? { ...x, [field]: newVal } : x));
  }

  async function applyBatch() {
    if (!selected.size) return;
    const ids = [...selected];
    for (const id of ids) {
      const p = players.find(x => x.id === id);
      if (!p) continue;
      await sb.from("profiles").update({ xp: p.xp + Number(batchXp), coin: p.coin + Number(batchCoin) }).eq("id", id);
    }
    setMsg(`+${batchXp} XP e +${batchCoin} coin assegnati a ${ids.length} giocatori`);
    setSelected(new Set());
    load();
    setTimeout(() => setMsg(""), 3000);
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function selectAll() {
    setSelected(prev => prev.size === visible.length ? new Set() : new Set(visible.map(p => p.id)));
  }

  const totalXP = visible.reduce((a, p) => a + p.xp, 0);

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label">Giocatori</div><div className="stat-value">{visible.length}</div></div>
        <div className="stat-card"><div className="stat-label">XP totali</div><div className="stat-value">{totalXP.toLocaleString()}</div></div>
        <div className="stat-card"><div className="stat-label">Selezionati</div><div className="stat-value">{selected.size}</div></div>
        <div className="stat-card"><div className="stat-label">Squadre</div><div className="stat-value">{squads.length}</div></div>
      </div>

      {selected.size > 0 && (
        <div className="batch-panel">
          <span className="batch-info">{selected.size} giocatori selezionati</span>
          <input className="batch-inp" type="number" value={batchXp} onChange={e => setBatchXp(e.target.value)} placeholder="XP" />
          <span style={{ fontSize: 12, color: "var(--text3)" }}>XP</span>
          <input className="batch-inp" type="number" value={batchCoin} onChange={e => setBatchCoin(e.target.value)} placeholder="Coin" />
          <span style={{ fontSize: 12, color: "var(--text3)" }}>Coin</span>
          <button className="btn btn-primary btn-sm" onClick={applyBatch}>Assegna</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Annulla</button>
        </div>
      )}
      {msg && <div style={{ background: "rgba(74,158,42,.1)", border: "1px solid rgba(74,158,42,.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "var(--accent2)" }}>{msg}</div>}

      <div className="filter-bar">
        <input className="search-inp" placeholder="Cerca giocatore…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => (
          <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>
        ))}
        <button className="btn btn-ghost btn-sm" onClick={selectAll}>{selected.size === visible.length ? "Deseleziona tutti" : "Seleziona tutti"}</button>
      </div>

      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="player-grid">
          {visible.map(p => {
            const lv = getLevel(p.xp);
            const sq = p.squads?.name;
            const sqStyle = SQUAD_STYLE[sq] || {};
            return (
              <div key={p.id} className={`player-card ${selected.has(p.id) ? "selected" : ""}`} onClick={() => toggleSelect(p.id)}>
                {p.player_badges?.length > 0 && <div className="badge-indicator" />}
                <div className="avatar-wrap" style={{ borderColor: sqStyle.border || "var(--border2)" }}>
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
                  <button className="pts-btn rem" style={{ fontSize: 10, width: 32, borderRadius: 8 }} onClick={() => changeXP(p.id, -5, "coin")}>🪙−</button>
                  <button className="pts-btn add" style={{ fontSize: 10, width: 32, borderRadius: 8 }} onClick={() => changeXP(p.id, 5, "coin")}>🪙+</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LeaderboardView() {
  const [players, setPlayers] = useState([]);
  const [squadFilter, setSquadFilter] = useState("all");
  const [squads, setSquads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await sb.from("profiles").select("*, squads(name)").eq("role", "player").order("xp", { ascending: false });
      const { data: sq } = await sb.from("squads").select("*");
      setPlayers(data || []);
      setSquads(sq || []);
      setLoading(false);
    }
    load();
  }, []);

  const visible = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
  const maxXP = visible[0]?.xp || 1;
  const medals = ["gold", "silver", "bronze"];
  const medalLabel = ["1°", "2°", "3°"];

  return (
    <div>
      <div className="filter-bar">
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>)}
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="lb-list">
          {visible.map((p, i) => {
            const lv = getLevel(p.xp);
            return (
              <div key={p.id} className="lb-row">
                <span className={`lb-rank ${i < 3 ? medals[i] : ""}`}>{i < 3 ? medalLabel[i] : (i + 1) + "°"}</span>
                <div className="lb-av"><Avatar url={p.avatar_url} emoji={lv.emoji} size={36} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="lb-name">{p.display_name}</div>
                  <div className="lb-level">{lv.emoji} {lv.name} {p.squads?.name && <SquadPill name={p.squads.name} />}</div>
                </div>
                <div className="lb-bar-wrap"><div className="lb-bar" style={{ width: Math.round(p.xp / maxXP * 100) + "%" }} /></div>
                <span className="lb-xp">{p.xp} XP</span>
                <span className="lb-coin">🪙 {p.coin}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AttendanceView() {
  const [players, setPlayers] = useState([]);
  const [squads, setSquads] = useState([]);
  const [attendances, setAttendances] = useState({});
  const [squadFilter, setSquadFilter] = useState("all");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState({ xp_daily_checkin: "10", coin_daily_checkin: "5", xp_week_bonus: "50", coin_week_bonus: "25" });

  useEffect(() => {
    async function load() {
      const [{ data: pl }, { data: sq }, { data: att }, { data: cfg }] = await Promise.all([
        sb.from("profiles").select("*, squads(name)").eq("role", "player").order("display_name"),
        sb.from("squads").select("*"),
        sb.from("attendances").select("*").eq("date", date).eq("check_type", "daily"),
        sb.from("config").select("*"),
      ]);
      setPlayers(pl || []);
      setSquads(sq || []);
      const attMap = {};
      (att || []).forEach(a => { attMap[a.player_id] = a; });
      setAttendances(attMap);
      const cfgMap = {};
      (cfg || []).forEach(c => { cfgMap[c.key] = c.value; });
      setConfig(prev => ({ ...prev, ...cfgMap }));
      setLoading(false);
    }
    load();
  }, [date]);

  async function setStatus(playerId, status) {
    const existing = attendances[playerId];
    const xp = status === "none" ? 0 : Number(config.xp_daily_checkin);
    const coin = status === "none" ? 0 : Number(config.coin_daily_checkin);
    if (existing) {
      await sb.from("attendances").update({ status, xp_awarded: xp, coin_awarded: coin }).eq("id", existing.id);
    } else {
      await sb.from("attendances").insert({ player_id: playerId, date, check_type: "daily", status, xp_awarded: xp, coin_awarded: coin, qr_verified: false });
    }
    if (status !== "none") {
      await sb.from("profiles").update({ xp: (players.find(p => p.id === playerId)?.xp || 0) + xp, coin: (players.find(p => p.id === playerId)?.coin || 0) + coin }).eq("id", playerId);
    }
    setAttendances(prev => ({ ...prev, [playerId]: { ...existing, status, player_id: playerId } }));
  }

  async function markAllPresent() {
    const vis = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
    for (const p of vis) { await setStatus(p.id, "full"); }
  }

  const visible = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
  const presentCount = Object.values(attendances).filter(a => a.status !== "none").length;

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label">Presenti oggi</div><div className="stat-value">{presentCount}</div></div>
        <div className="stat-card"><div className="stat-label">Totale</div><div className="stat-value">{visible.length}</div></div>
        <div className="stat-card"><div className="stat-label">XP presenza</div><div className="stat-value">{config.xp_daily_checkin}</div></div>
        <div className="stat-card"><div className="stat-label">Bonus settimana</div><div className="stat-value">{config.xp_week_bonus} XP</div></div>
      </div>
      <div className="filter-bar">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ padding: "7px 10px", background: "var(--surface2)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontFamily: "DM Sans", fontSize: 13 }} />
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>)}
        <button className="btn btn-primary btn-sm" onClick={markAllPresent}>✓ Tutti presenti</button>
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="pres-table">
            <thead><tr><th>Giocatore</th><th>Squadra</th><th>Livello</th><th>Stato</th><th>XP</th><th>Coin</th></tr></thead>
            <tbody>
              {visible.map(p => {
                const lv = getLevel(p.xp);
                const att = attendances[p.id];
                const status = att?.status || "none";
                return (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 500 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar url={p.avatar_url} emoji={lv.emoji} size={28} />{p.display_name}</div></td>
                    <td>{p.squads?.name && <SquadPill name={p.squads.name} />}</td>
                    <td style={{ fontSize: 11, color: "var(--text2)" }}>{lv.emoji} {lv.name}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[["none","?","pd-none"],["partial","~","pd-partial"],["full","✓","pd-yes"],["completed","★","pd-completed"]].map(([s, label, cls]) => (
                          <button key={s} className={`pres-dot ${cls}`} style={{ opacity: status === s ? 1 : 0.35 }} onClick={() => setStatus(p.id, s)}>{label}</button>
                        ))}
                      </div>
                    </td>
                    <td style={{ fontFamily: "DM Mono", fontSize: 12, color: "var(--accent2)" }}>{p.xp}</td>
                    <td style={{ fontFamily: "DM Mono", fontSize: 12, color: "var(--warning)" }}>{p.coin}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivitiesView() {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", duration_days: 4, xp_partial: 10, xp_full: 20, xp_completed: 35, coin_partial: 5, coin_full: 10, coin_completed: 18, coin_cost: 20, max_participants: "" });

  useEffect(() => {
    sb.from("activities").select("*").eq("is_active", true).order("created_at", { ascending: false }).then(({ data }) => { setActivities(data || []); setLoading(false); });
  }, []);

  async function createActivity() {
    const { data } = await sb.from("activities").insert({ ...form, max_participants: form.max_participants || null }).select().single();
    if (data) { setActivities(prev => [data, ...prev]); setShowForm(false); setForm({ name: "", description: "", duration_days: 4, xp_partial: 10, xp_full: 20, xp_completed: 35, coin_partial: 5, coin_full: 10, coin_completed: 18, coin_cost: 20, max_participants: "" }); }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>+ Nuova attività</button>
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="act-grid">
          {activities.map(a => (
            <div key={a.id} className="act-card">
              <div className="act-title">{a.name}</div>
              <div className="act-meta">{a.description} · <span className="tag tag-gray">{a.duration_days} giorni</span></div>
              <div className="act-rewards">
                <span className="reward-tag xp-tag">Parziale: {a.xp_partial} XP</span>
                <span className="reward-tag xp-tag">Completa: {a.xp_full} XP</span>
                <span className="reward-tag xp-tag">Completata: {a.xp_completed} XP</span>
                <span className="reward-tag coin-tag">🪙 {a.coin_cost} per prenotare</span>
              </div>
            </div>
          ))}
          {activities.length === 0 && <div className="empty" style={{ gridColumn: "1/-1" }}>Nessuna attività ancora. Creane una!</div>}
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Nuova attività</div>
            {[["name","Nome attività","text"],["description","Descrizione","text"],["duration_days","Durata (giorni)","number"],["coin_cost","Costo prenotazione (coin)","number"],["max_participants","Max partecipanti (opzionale)","number"]].map(([k, label, type]) => (
              <div className="form-group" key={k}>
                <label className="form-label">{label}</label>
                <input className="form-input" type={type} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
              </div>
            ))}
            <div className="section-label">XP per livello di presenza</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[["xp_partial","Parziale"],["xp_full","Completa"],["xp_completed","Completata"]].map(([k, label]) => (
                <div key={k}>
                  <label className="form-label">{label}</label>
                  <input className="form-input" type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: Number(e.target.value) }))} />
                </div>
              ))}
            </div>
            <div className="section-label">Coin per livello di presenza</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[["coin_partial","Parziale"],["coin_full","Completa"],["coin_completed","Completata"]].map(([k, label]) => (
                <div key={k}>
                  <label className="form-label">{label}</label>
                  <input className="form-input" type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: Number(e.target.value) }))} />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createActivity}>Crea attività</button>
              <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BadgesView() {
  const [badges, setBadges] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAssign, setShowAssign] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assignTarget, setAssignTarget] = useState("");
  const [assignXp, setAssignXp] = useState(0);
  const [assignCoin, setAssignCoin] = useState(0);
  const [newBadge, setNewBadge] = useState({ name: "", xp_default: 20, coin_default: 10 });

  useEffect(() => {
    async function load() {
      const [{ data: b }, { data: p }] = await Promise.all([sb.from("badges").select("*").order("created_at", { ascending: false }), sb.from("profiles").select("id, display_name").eq("role", "player").order("display_name")]);
      setBadges(b || []); setPlayers(p || []); setLoading(false);
    }
    load();
  }, []);

  async function assignBadge() {
    if (!assignTarget || !showAssign) return;
    const badge = badges.find(b => b.id === showAssign);
    await sb.from("player_badges").insert({ player_id: assignTarget, badge_id: showAssign, xp_awarded: Number(assignXp), coin_awarded: Number(assignCoin) });
    await sb.from("profiles").update({ xp: (players.find(p => p.id === assignTarget)?.xp || 0) + Number(assignXp), coin: (players.find(p => p.id === assignTarget)?.coin || 0) + Number(assignCoin) }).eq("id", assignTarget);
    await sb.from("notifications").insert({ user_id: assignTarget, type: "badge_assigned", title: "Nuovo badge ricevuto!", body: `Hai ricevuto il badge "${badge?.name}"` });
    setShowAssign(null);
  }

  async function createBadge() {
    const { data } = await sb.from("badges").insert(newBadge).select().single();
    if (data) { setBadges(prev => [data, ...prev]); setShowCreate(false); }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ Nuovo badge</button>
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="badge-grid">
          {badges.map(b => (
            <div key={b.id} className="badge-card" onClick={() => { setShowAssign(b.id); setAssignXp(b.xp_default); setAssignCoin(b.coin_default); }}>
              {b.image_url ? <img className="badge-img" src={b.image_url} alt={b.name} /> : <span className="badge-emoji">🎖️</span>}
              <div className="badge-name">{b.name}</div>
              <div className="badge-pts">+{b.xp_default} XP · 🪙{b.coin_default}</div>
            </div>
          ))}
          {badges.length === 0 && <div className="empty" style={{ gridColumn: "1/-1" }}>Nessun badge ancora.</div>}
        </div>
      )}
      {showAssign && (
        <div className="modal-bg" onClick={() => setShowAssign(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Assegna badge</div>
            <div className="form-group">
              <label className="form-label">Giocatore</label>
              <select style={{ width: "100%" }} value={assignTarget} onChange={e => setAssignTarget(e.target.value)}>
                <option value="">Seleziona giocatore…</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP</label><input className="form-input" type="number" value={assignXp} onChange={e => setAssignXp(e.target.value)} /></div>
              <div className="form-group"><label className="form-label">Coin</label><input className="form-input" type="number" value={assignCoin} onChange={e => setAssignCoin(e.target.value)} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={assignBadge} disabled={!assignTarget}>Assegna</button>
              <button className="btn btn-ghost" onClick={() => setShowAssign(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
      {showCreate && (
        <div className="modal-bg" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Crea nuovo badge</div>
            <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={newBadge.name} onChange={e => setNewBadge(f => ({ ...f, name: e.target.value }))} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP default</label><input className="form-input" type="number" value={newBadge.xp_default} onChange={e => setNewBadge(f => ({ ...f, xp_default: Number(e.target.value) }))} /></div>
              <div className="form-group"><label className="form-label">Coin default</label><input className="form-input" type="number" value={newBadge.coin_default} onChange={e => setNewBadge(f => ({ ...f, coin_default: Number(e.target.value) }))} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createBadge} disabled={!newBadge.name}>Crea badge</button>
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MessagesView({ profile }) {
  const [threads] = useState([
    { id: "verde", name: "Squadra Verde", last: "Ottimo allenamento!" },
    { id: "gialla", name: "Squadra Gialla", last: "Ci vediamo sabato?" },
    { id: "azzurra", name: "Squadra Azzurra", last: "Grande partita!" },
    { id: "tutti", name: "Tutti", last: "Evento sabato!" },
  ]);
  const [active, setActive] = useState(threads[0]);
  const [msgs, setMsgs] = useState([{ id: 1, sender: "Sistema", body: "Benvenuto nella chat!", mine: false }]);
  const [input, setInput] = useState("");

  function send() {
    if (!input.trim()) return;
    setMsgs(prev => [...prev, { id: Date.now(), sender: profile.display_name, body: input, mine: true }]);
    setInput("");
  }

  return (
    <div className="msg-layout">
      <div className="msg-list">
        <div className="section-label" style={{ marginTop: 0 }}>Canali</div>
        {threads.map(t => (
          <div key={t.id} className={`msg-thread ${active.id === t.id ? "active" : ""}`} onClick={() => setActive(t)}>
            <div className="mt-name">{t.name}</div>
            <div className="mt-last">{t.last}</div>
          </div>
        ))}
      </div>
      <div className="msg-main">
        <div className="msg-hdr">{active.name}</div>
        <div className="msg-body">
          {msgs.map(m => (
            <div key={m.id} className={`bubble-wrap ${m.mine ? "mine" : ""}`}>
              <div className="bubble-av">{m.mine ? "👑" : "🌿"}</div>
              <div>
                {!m.mine && <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 2 }}>{m.sender}</div>}
                <div className={`bubble ${m.mine ? "mine" : "them"}`}>{m.body}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="msg-inp-row">
          <input className="msg-inp" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Scrivi un messaggio…" />
          <button className="btn btn-primary btn-sm" onClick={send}>Invia</button>
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
      const { data } = await sb.from("bookings").select("*, profiles(display_name), activities(name, coin_cost)").order("created_at", { ascending: false });
      setBookings(data || []);
      setLoading(false);
    }
    load();
  }, []);

  async function review(id, status, playerId, coinHeld) {
    await sb.from("bookings").update({ status, reviewed_at: new Date().toISOString() }).eq("id", id);
    if (status === "rejected") {
      const { data: p } = await sb.from("profiles").select("coin").eq("id", playerId).single();
      await sb.from("profiles").update({ coin: (p?.coin || 0) + coinHeld }).eq("id", playerId);
    }
    await sb.from("notifications").insert({ user_id: playerId, type: status === "confirmed" ? "booking_confirmed" : "booking_rejected", title: status === "confirmed" ? "Prenotazione confermata!" : "Prenotazione non accettata", body: status === "confirmed" ? "La tua prenotazione è stata confermata." : "Le tue coin sono state restituite." });
    setBookings(prev => prev.map(b => b.id === id ? { ...b, status } : b));
  }

  const statusTag = { pending: ["tag-amber", "In attesa"], confirmed: ["tag-green", "Confermata"], rejected: ["tag-red", "Rifiutata"], cancelled: ["tag-gray", "Annullata"] };

  return (
    <div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="pres-table">
            <thead><tr><th>Giocatore</th><th>Attività</th><th>Coin</th><th>Stato</th><th>Azioni</th></tr></thead>
            <tbody>
              {bookings.map(b => {
                const [tagClass, tagLabel] = statusTag[b.status] || ["tag-gray", b.status];
                return (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 500 }}>{b.profiles?.display_name}</td>
                    <td>{b.activities?.name}</td>
                    <td style={{ color: "var(--warning)" }}>🪙 {b.coin_held}</td>
                    <td><span className={`tag ${tagClass}`}>{tagLabel}</span></td>
                    <td>
                      {b.status === "pending" && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="btn btn-sm" style={{ background: "rgba(74,158,42,.15)", color: "var(--accent2)", border: "1px solid rgba(74,158,42,.3)" }} onClick={() => review(b.id, "confirmed", b.player_id, b.coin_held)}>✓ Conferma</button>
                          <button className="btn btn-danger btn-sm" onClick={() => review(b.id, "rejected", b.player_id, b.coin_held)}>✗ Rifiuta</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {bookings.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", padding: 32, color: "var(--text3)" }}>Nessuna prenotazione</td></tr>}
            </tbody>
          </table>
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
    async function load() {
      const { data } = await sb.from("daily_qr").select("*").eq("date", today).single();
      setQr(data);
      setLoading(false);
    }
    load();
  }, [today]);

  async function generateQr() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const validFrom = new Date(); validFrom.setHours(8, 0, 0, 0);
    const validUntil = new Date(); validUntil.setHours(12, 0, 0, 0);
    const { data } = await sb.from("daily_qr").upsert({ date: today, code, valid_from: validFrom.toISOString(), valid_until: validUntil.toISOString() }).select().single();
    setQr(data);
  }

  return (
    <div className="card" style={{ maxWidth: 400, margin: "0 auto" }}>
      <div className="qr-wrap">
        <div style={{ fontSize: 14, color: "var(--text2)", marginBottom: 8 }}>QR Check-in giornaliero</div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 20 }}>{today}</div>
        {loading ? <div className="loading">Caricamento…</div> : qr ? (
          <>
            <div style={{ background: "var(--surface3)", borderRadius: 16, padding: "20px 28px", marginBottom: 16 }}>
              <div className="qr-code">{qr.code}</div>
            </div>
            <div className="qr-date">Valido dalle {new Date(qr.valid_from).getHours()}:00 alle {new Date(qr.valid_until).getHours()}:00</div>
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--text3)" }}>Mostra o stampa questo codice in loco</div>
            <button className="btn btn-ghost" style={{ marginTop: 16, width: "100%" }} onClick={generateQr}>Rigenera codice</button>
          </>
        ) : (
          <>
            <div style={{ color: "var(--text3)", fontSize: 13, marginBottom: 20 }}>Nessun codice generato per oggi</div>
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={generateQr}>Genera QR di oggi</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── PLAYER VIEW ──────────────────────────────────────────

function PlayerDashboard({ profile, onLogout }) {
  const [tab, setTab] = useState("profilo");
  const [fullProfile, setFullProfile] = useState(null);
  const [badges, setBadges] = useState([]);
  const [activities, setActivities] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [qrInput, setQrInput] = useState("");
  const [qrMsg, setQrMsg] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [{ data: p }, { data: b }, { data: a }, { data: bk }, { data: n }] = await Promise.all([
        sb.from("profiles").select("*, squads(name)").eq("id", profile.id).single(),
        sb.from("player_badges").select("*, badges(*)").eq("player_id", profile.id).order("assigned_at", { ascending: false }),
        sb.from("activities").select("*").eq("is_active", true).order("created_at", { ascending: false }),
        sb.from("bookings").select("*, activities(name)").eq("player_id", profile.id).order("created_at", { ascending: false }),
        sb.from("notifications").select("*").eq("user_id", profile.id).order("created_at", { ascending: false }).limit(20),
      ]);
      setFullProfile(p); setBadges(b || []); setActivities(a || []); setBookings(bk || []); setNotifications(n || []);
      setLoading(false);
    }
    load();
  }, [profile.id]);

  async function doCheckin() {
    const today = new Date().toISOString().split("T")[0];
    const { data: qr } = await sb.from("daily_qr").select("*").eq("date", today).single();
    if (!qr) { setQrMsg("Nessun QR attivo oggi."); return; }
    if (qrInput.toUpperCase() !== qr.code) { setQrMsg("Codice non valido. Riprova."); return; }
    const now = new Date();
    if (now < new Date(qr.valid_from) || now > new Date(qr.valid_until)) { setQrMsg("Il codice non è più valido per questa fascia oraria."); return; }
    const { error } = await sb.from("attendances").insert({ player_id: profile.id, date: today, check_type: "daily", status: "full", xp_awarded: 10, coin_awarded: 5, qr_verified: true });
    if (error?.code === "23505") { setQrMsg("Hai già fatto il check-in oggi!"); return; }
    await sb.from("profiles").update({ xp: (fullProfile?.xp || 0) + 10, coin: (fullProfile?.coin || 0) + 5 }).eq("id", profile.id);
    setQrMsg("✓ Check-in effettuato! +10 XP, +5 Coin");
    setFullProfile(prev => ({ ...prev, xp: (prev?.xp || 0) + 10, coin: (prev?.coin || 0) + 5 }));
  }

  async function bookActivity(actId, cost) {
    if ((fullProfile?.coin || 0) < cost) { alert("Coin insufficienti!"); return; }
    await sb.from("bookings").insert({ player_id: profile.id, activity_id: actId, coin_held: cost });
    await sb.from("profiles").update({ coin: (fullProfile?.coin || 0) - cost }).eq("id", profile.id);
    setFullProfile(prev => ({ ...prev, coin: (prev?.coin || 0) - cost }));
    alert("Prenotazione inviata! Attendi la conferma dell'educatore.");
  }

  const lv = getLevel(fullProfile?.xp || 0);
  const nextLv = LEVELS.find(l => l.xp > (fullProfile?.xp || 0));
  const unread = notifications.filter(n => !n.read_at).length;
  const tabs = [["profilo","👤","Profilo"],["checkin","📍","Check-in"],["attivita","⚡","Attività"],["badge","🎖️","Badge"],["notifiche","🔔",`Notifiche${unread > 0 ? " ●" : ""}`]];

  if (loading) return <div className="loading" style={{ minHeight: "100vh" }}>Caricamento…</div>;

  return (
    <div style={{ maxWidth: 500, margin: "0 auto", padding: "16px", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>🌿 PUG Scoreboard</div>
        <button className="btn btn-ghost btn-sm" onClick={onLogout}>Esci</button>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, overflow: "auto", paddingBottom: 4 }}>
        {tabs.map(([id, icon, label]) => (
          <button key={id} className={`chip ${tab === id ? "active" : ""}`} onClick={() => setTab(id)} style={{ flexShrink: 0 }}>{icon} {label}</button>
        ))}
      </div>

      {tab === "profilo" && fullProfile && (
        <>
          <div className="profile-hero">
            <div className="profile-avatar"><Avatar url={fullProfile.avatar_url} emoji={lv.emoji} size={88} /></div>
            <div className="profile-name">{fullProfile.display_name}</div>
            <div className="profile-level">{lv.emoji} {lv.name}</div>
            {fullProfile.squads?.name && <SquadPill name={fullProfile.squads.name} />}
            <div style={{ marginTop: 16 }}>
              <XpBar xp={fullProfile.xp} />
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 16 }}>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 600, color: "var(--accent2)" }}>{fullProfile.xp}</div><div style={{ fontSize: 11, color: "var(--text3)" }}>XP totali</div></div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 600, color: "var(--warning)" }}>🪙 {fullProfile.coin}</div><div style={{ fontSize: 11, color: "var(--text3)" }}>Coin</div></div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>{badges.length}</div><div style={{ fontSize: 11, color: "var(--text3)" }}>Badge</div></div>
            </div>
          </div>
          <div className="section-label">Le mie prenotazioni</div>
          {bookings.slice(0, 5).map(b => {
            const s = { pending: ["tag-amber","In attesa"], confirmed: ["tag-green","Confermata"], rejected: ["tag-red","Rifiutata"] };
            const [cls, label] = s[b.status] || ["tag-gray", b.status];
            return <div key={b.id} className="card-sm" style={{ marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 13 }}>{b.activities?.name}</span><span className={`tag ${cls}`}>{label}</span></div>;
          })}
        </>
      )}

      {tab === "checkin" && (
        <div className="card">
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📍</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>Check-in giornaliero</div>
            <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 24 }}>Inserisci il codice mostrato in loco</div>
            <input className="form-input" value={qrInput} onChange={e => setQrInput(e.target.value.toUpperCase())} placeholder="es. ABC123" style={{ textAlign: "center", fontSize: 24, fontFamily: "DM Mono", letterSpacing: 6, marginBottom: 12 }} maxLength={6} />
            <button className="btn btn-primary" style={{ width: "100%", marginTop: 8 }} onClick={doCheckin}>Conferma presenza</button>
            {qrMsg && <div style={{ marginTop: 14, fontSize: 13, color: qrMsg.startsWith("✓") ? "var(--accent2)" : "var(--danger)" }}>{qrMsg}</div>}
            <div style={{ marginTop: 20, fontSize: 11, color: "var(--text3)" }}>Presenza confermata = +10 XP + 5 Coin</div>
          </div>
        </div>
      )}

      {tab === "attivita" && (
        <div>
          {activities.map(a => (
            <div key={a.id} className="act-card" style={{ marginBottom: 10 }}>
              <div className="act-title">{a.name}</div>
              <div className="act-meta">{a.description} · {a.duration_days} giorni</div>
              <div className="act-rewards">
                <span className="reward-tag xp-tag">Fino a {a.xp_completed} XP</span>
                <span className="reward-tag coin-tag">🪙 {a.coin_cost} per prenotare</span>
              </div>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 10, width: "100%" }} onClick={() => bookActivity(a.id, a.coin_cost)}>
                Prenota {a.coin_cost > (fullProfile?.coin || 0) ? "(coin insufficienti)" : ""}
              </button>
            </div>
          ))}
          {activities.length === 0 && <div className="empty">Nessuna attività disponibile al momento.</div>}
        </div>
      )}

      {tab === "badge" && (
        <div>
          {badges.length === 0 ? <div className="empty">Nessun badge ancora. Partecipa alle attività!</div> : (
            <div className="badge-grid">
              {badges.map(pb => (
                <div key={pb.id} className="badge-card">
                  {pb.badges?.image_url ? <img className="badge-img" src={pb.badges.image_url} alt={pb.badges?.name} /> : <span className="badge-emoji">🎖️</span>}
                  <div className="badge-name">{pb.badges?.name}</div>
                  <div className="badge-pts">+{pb.xp_awarded} XP · 🪙{pb.coin_awarded}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "notifiche" && (
        <div>
          {notifications.length === 0 ? <div className="empty">Nessuna notifica.</div> : notifications.map(n => {
            const icons = { badge_assigned: "🎖️", booking_confirmed: "✅", booking_rejected: "❌", new_activity: "⚡", level_up: "🆙", week_bonus: "🏆", new_message: "💬" };
            return (
              <div key={n.id} className="notif-item">
                <div className="notif-icon">{icons[n.type] || "🔔"}</div>
                <div>
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
  );
}

// ─── EDUCATOR SHELL ───────────────────────────────────────

const EDUCATOR_TABS = [
  ["giocatori", "👤", "Giocatori"],
  ["classifica", "🏆", "Classifica"],
  ["presenze", "✅", "Presenze"],
  ["attivita", "⚡", "Attività"],
  ["badge", "🎖️", "Badge"],
  ["prenotazioni", "📋", "Prenotazioni"],
  ["messaggi", "💬", "Messaggi"],
  ["qr", "📍", "QR Check-in"],
];

function EducatorShell({ profile, onLogout }) {
  const [tab, setTab] = useState("giocatori");
  const cur = EDUCATOR_TABS.find(t => t[0] === tab);

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-title"><span>🌿</span><span>PUG</span></div>
          <div className="sidebar-logo-sub">Pannello educatore</div>
        </div>
        <nav className="nav">
          {EDUCATOR_TABS.map(([id, icon, label]) => (
            <div key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <span className="nav-icon">{icon}</span>
              <span>{label}</span>
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="sidebar-user-name">{profile.display_name}</div>
          <div className="sidebar-user-role">{profile.role}</div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8, width: "100%" }} onClick={onLogout}>Esci</button>
        </div>
      </div>
      <div className="main">
        <div className="topbar">
          <h2>{cur?.[2]}</h2>
        </div>
        <div className="content">
          {tab === "giocatori"    && <PlayersView profile={profile} />}
          {tab === "classifica"   && <LeaderboardView />}
          {tab === "presenze"     && <AttendanceView />}
          {tab === "attivita"     && <ActivitiesView />}
          {tab === "badge"        && <BadgesView />}
          {tab === "prenotazioni" && <BookingsView />}
          {tab === "messaggi"     && <MessagesView profile={profile} />}
          {tab === "qr"           && <QrView />}
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────

export default function App() {
  const [profile, setProfile] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    sb.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        const { data: p } = await sb.from("profiles").select("*, squads(name)").eq("id", session.user.id).single();
        // ✅ FIX 2: se il profilo non esiste nel DB, usa fallback educator invece di null
        setProfile(p || makeFallbackProfile(session.user.id, session.user.email));
      }
      setChecking(false);
    });
    const { data: { subscription } } = sb.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") setProfile(null);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function onLogout() {
    await sb.auth.signOut();
    setProfile(null);
  }

  if (checking) return <div className="loading" style={{ minHeight: "100vh" }}>🌿 Caricamento…</div>;

  return (
    <>
      <style>{css}</style>import { sb } from "./supabase.js";
import { useState, useEffect, useCallback, useRef } from "react";

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

const SQUAD_STYLE = {
  Verde:   { bg: "#EAF3DE", text: "#3B6D11", border: "#97C459" },
  Gialla:  { bg: "#FAEEDA", text: "#854F0B", border: "#EF9F27" },
  Azzurra: { bg: "#E6F1FB", text: "#185FA5", border: "#85B7EB" },
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', sans-serif; background: #0f1412; color: #e8f0ec; min-height: 100vh; }
  :root {
    --green: #3B6D11; --green-light: #EAF3DE; --green-mid: #639922;
    --amber: #854F0B; --amber-light: #FAEEDA;
    --blue: #185FA5; --blue-light: #E6F1FB;
    --surface: #1a2420; --surface2: #222e29; --surface3: #2a3830;
    --border: rgba(255,255,255,0.08); --border2: rgba(255,255,255,0.14);
    --text: #e8f0ec; --text2: #8fa898; --text3: #5a6e62;
    --accent: #4a9e2a; --accent2: #63c93a;
    --danger: #e24b4a; --warning: #EF9F27;
    --radius: 12px; --radius-sm: 8px;
  }
  .app { display: flex; min-height: 100vh; }
  .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; width: 100%; background: #0f1412; }
  .login-card { background: var(--surface); border: 1px solid var(--border2); border-radius: 20px; padding: 40px; width: 100%; max-width: 400px; }
  .login-logo { text-align: center; margin-bottom: 32px; }
  .login-logo-icon { font-size: 48px; display: block; margin-bottom: 8px; }
  .login-logo h1 { font-size: 22px; font-weight: 600; color: var(--text); letter-spacing: -0.5px; }
  .login-logo p { font-size: 13px; color: var(--text2); margin-top: 4px; }
  .form-group { margin-bottom: 16px; }
  .form-label { font-size: 12px; font-weight: 500; color: var(--text2); margin-bottom: 6px; display: block; text-transform: uppercase; letter-spacing: .05em; }
  .form-input { width: 100%; padding: 11px 14px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; outline: none; transition: border-color .15s; }
  .form-input:focus { border-color: var(--accent); }
  .remember-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; cursor: pointer; }
  .remember-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
  .remember-row span { font-size: 13px; color: var(--text2); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 18px; border-radius: var(--radius-sm); border: none; cursor: pointer; font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 500; transition: all .15s; white-space: nowrap; }
  .btn-primary { background: var(--accent); color: #fff; width: 100%; padding: 13px; font-size: 14px; }
  .btn-primary:hover { background: var(--accent2); }
  .btn-ghost { background: transparent; color: var(--text2); border: 1px solid var(--border2); }
  .btn-ghost:hover { background: var(--surface2); color: var(--text); }
  .btn-danger { background: rgba(226,75,74,.15); color: var(--danger); border: 1px solid rgba(226,75,74,.3); }
  .btn-danger:hover { background: rgba(226,75,74,.25); }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .btn-icon { width: 32px; height: 32px; padding: 0; border-radius: 50%; }
  .err-msg { font-size: 12px; color: var(--danger); margin-top: 10px; text-align: center; }
  .sidebar { width: 220px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .sidebar-logo { padding: 20px 18px 16px; border-bottom: 1px solid var(--border); }
  .sidebar-logo-title { font-size: 15px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .sidebar-logo-sub { font-size: 11px; color: var(--text3); margin-top: 3px; }
  .nav { flex: 1; padding: 10px 0; }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 18px; cursor: pointer; font-size: 13px; color: var(--text2); border-left: 2px solid transparent; transition: all .12s; }
  .nav-item:hover { background: var(--surface2); color: var(--text); }
  .nav-item.active { background: rgba(74,158,42,.1); color: var(--accent2); border-left-color: var(--accent); font-weight: 500; }
  .nav-icon { font-size: 15px; width: 20px; text-align: center; }
  .sidebar-user { padding: 14px 18px; border-top: 1px solid var(--border); }
  .sidebar-user-name { font-size: 12px; font-weight: 500; color: var(--text); }
  .sidebar-user-role { font-size: 11px; color: var(--text3); margin-top: 2px; }
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .topbar { padding: 14px 24px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  .topbar h2 { font-size: 16px; font-weight: 600; color: var(--text); margin-right: auto; }
  .content { flex: 1; overflow-y: auto; padding: 20px 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; }
  .card-sm { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .stat-label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px; }
  .stat-value { font-size: 24px; font-weight: 600; color: var(--text); }
  .stat-sub { font-size: 11px; color: var(--text2); margin-top: 3px; }
  .player-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
  .player-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 10px; text-align: center; cursor: pointer; transition: all .15s; position: relative; }
  .player-card:hover { border-color: var(--border2); transform: translateY(-1px); }
  .player-card.selected { border-color: var(--accent); background: rgba(74,158,42,.08); }
  .avatar-wrap { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 26px; border: 2px solid var(--border2); }
  .avatar-wrap img { width: 100%; height: 100%; object-fit: cover; }
  .p-name { font-size: 11px; font-weight: 500; color: var(--text); margin-bottom: 3px; word-break: break-word; line-height: 1.3; }
  .p-level { font-size: 10px; color: var(--text2); margin-bottom: 4px; }
  .p-xp { font-size: 11px; font-weight: 500; color: var(--accent2); }
  .p-coin { font-size: 10px; color: var(--amber); }
  .squad-pill { font-size: 9px; padding: 2px 7px; border-radius: 99px; display: inline-block; margin-top: 5px; font-weight: 500; }
  .pts-row { display: flex; gap: 4px; justify-content: center; margin-top: 8px; }
  .pts-btn { width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border2); background: var(--surface3); cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; color: var(--text2); font-family: 'DM Sans', sans-serif; transition: all .1s; line-height: 1; }
  .pts-btn:hover { background: var(--surface); }
  .pts-btn.add { color: var(--accent2); border-color: rgba(99,201,58,.3); }
  .pts-btn.rem { color: var(--danger); border-color: rgba(226,75,74,.3); }
  .badge-indicator { position: absolute; top: 8px; right: 8px; width: 8px; height: 8px; border-radius: 50%; background: var(--warning); }
  .lb-list { display: flex; flex-direction: column; gap: 6px; }
  .lb-row { display: flex; align-items: center; gap: 12px; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; transition: border-color .12s; }
  .lb-row:hover { border-color: var(--border2); }
  .lb-rank { font-size: 13px; font-weight: 600; width: 28px; text-align: center; color: var(--text3); flex-shrink: 0; }
  .lb-rank.gold { color: #EF9F27; } .lb-rank.silver { color: #8fa898; } .lb-rank.bronze { color: #D85A30; }
  .lb-av { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; overflow: hidden; border: 1px solid var(--border2); }
  .lb-av img { width: 100%; height: 100%; object-fit: cover; }
  .lb-name { flex: 1; font-size: 13px; font-weight: 500; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lb-level { font-size: 11px; color: var(--text3); }
  .lb-bar-wrap { width: 80px; height: 4px; background: var(--surface3); border-radius: 99px; overflow: hidden; flex-shrink: 0; }
  .lb-bar { height: 100%; background: var(--accent); border-radius: 99px; transition: width .4s; }
  .lb-xp { font-size: 12px; font-weight: 500; color: var(--accent2); width: 55px; text-align: right; flex-shrink: 0; }
  .lb-coin { font-size: 11px; color: var(--amber); width: 45px; text-align: right; flex-shrink: 0; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  .search-inp { padding: 8px 12px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; flex: 1; min-width: 160px; transition: border-color .15s; }
  .search-inp:focus { border-color: var(--accent); }
  .chip { padding: 6px 14px; border-radius: 99px; border: 1px solid var(--border2); background: transparent; color: var(--text2); font-family: 'DM Sans', sans-serif; font-size: 12px; cursor: pointer; transition: all .12s; font-weight: 500; }
  .chip:hover { background: var(--surface2); color: var(--text); }
  .chip.active { background: rgba(74,158,42,.15); color: var(--accent2); border-color: rgba(74,158,42,.4); }
  .batch-panel { background: rgba(74,158,42,.06); border: 1px solid rgba(74,158,42,.2); border-radius: var(--radius); padding: 14px 18px; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .batch-info { font-size: 13px; color: var(--accent2); font-weight: 500; flex: 1; }
  .batch-inp { width: 80px; padding: 7px 10px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Mono', monospace; font-size: 13px; outline: none; text-align: center; }
  .batch-inp:focus { border-color: var(--accent); }
  .pres-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .pres-table th { padding: 8px 10px; text-align: left; font-size: 10px; font-weight: 600; color: var(--text3); border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: .05em; position: sticky; top: 0; background: #0f1412; }
  .pres-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); color: var(--text); }
  .pres-dot { width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; font-family: 'DM Sans', sans-serif; transition: transform .1s; }
  .pres-dot:active { transform: scale(.9); }
  .pd-yes { background: rgba(74,158,42,.2); color: var(--accent2); }
  .pd-partial { background: rgba(239,159,39,.2); color: var(--warning); }
  .pd-completed { background: rgba(74,158,42,.35); color: #63c93a; }
  .pd-none { background: var(--surface3); color: var(--text3); }
  .act-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .act-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; transition: border-color .12s; position: relative; }
  .act-card:hover { border-color: var(--border2); }
  .act-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .act-meta { font-size: 11px; color: var(--text2); margin-bottom: 10px; }
  .act-rewards { display: flex; gap: 6px; flex-wrap: wrap; }
  .reward-tag { font-size: 10px; padding: 2px 8px; border-radius: 99px; font-weight: 500; }
  .xp-tag { background: rgba(74,158,42,.15); color: var(--accent2); }
  .coin-tag { background: rgba(239,159,39,.15); color: var(--warning); }
  .day-tag { background: var(--surface3); color: var(--text2); }
  .badge-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; }
  .badge-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 10px; text-align: center; cursor: pointer; transition: all .15s; position: relative; }
  .badge-card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .badge-img { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; margin: 0 auto 8px; display: block; border: 2px solid var(--border2); }
  .badge-emoji { font-size: 32px; display: block; margin: 0 auto 8px; }
  .badge-name { font-size: 11px; font-weight: 500; color: var(--text); line-height: 1.3; }
  .badge-pts { font-size: 10px; color: var(--text2); margin-top: 3px; }
  .msg-layout { display: flex; gap: 12px; height: 500px; }
  .msg-list { width: 180px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; flex-shrink: 0; }
  .msg-thread { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; cursor: pointer; transition: border-color .12s; }
  .msg-thread:hover { border-color: var(--border2); }
  .msg-thread.active { border-color: var(--accent); background: rgba(74,158,42,.08); }
  .mt-name { font-size: 12px; font-weight: 500; color: var(--text); }
  .mt-last { font-size: 11px; color: var(--text3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .msg-main { flex: 1; display: flex; flex-direction: column; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .msg-hdr { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 500; color: var(--text); }
  .msg-body { flex: 1; padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .bubble-wrap { display: flex; gap: 8px; }
  .bubble-wrap.mine { flex-direction: row-reverse; }
  .bubble-av { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; background: var(--surface3); overflow: hidden; }
  .bubble-av img { width: 100%; height: 100%; object-fit: cover; }
  .bubble { max-width: 220px; padding: 8px 12px; border-radius: 12px; font-size: 12px; line-height: 1.6; }
  .bubble.them { background: var(--surface3); color: var(--text); border-bottom-left-radius: 4px; }
  .bubble.mine { background: rgba(74,158,42,.2); color: var(--accent2); border-bottom-right-radius: 4px; }
  .msg-inp-row { padding: 10px 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; }
  .msg-inp { flex: 1; padding: 8px 12px; background: var(--surface3); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 12px; outline: none; }
  .msg-inp:focus { border-color: var(--accent); }
  .notif-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); display: inline-block; margin-left: 4px; vertical-align: middle; }
  .notif-item { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
  .notif-icon { font-size: 20px; flex-shrink: 0; }
  .notif-title { font-size: 13px; font-weight: 500; color: var(--text); margin-bottom: 2px; }
  .notif-body { font-size: 12px; color: var(--text2); }
  .notif-time { font-size: 10px; color: var(--text3); margin-top: 3px; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 16px; padding: 24px; width: 100%; max-width: 460px; max-height: 80vh; overflow-y: auto; }
  .modal-title { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 16px; }
  .section-label { font-size: 10px; font-weight: 600; color: var(--text3); text-transform: uppercase; letter-spacing: .08em; margin: 14px 0 8px; }
  .profile-hero { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 28px; text-align: center; margin-bottom: 16px; }
  .profile-avatar { width: 88px; height: 88px; border-radius: 50%; margin: 0 auto 14px; border: 3px solid var(--accent); display: flex; align-items: center; justify-content: center; font-size: 40px; overflow: hidden; }
  .profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .profile-name { font-size: 20px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .profile-level { font-size: 14px; color: var(--accent2); margin-bottom: 12px; }
  .xp-bar-wrap { height: 6px; background: var(--surface3); border-radius: 99px; overflow: hidden; margin: 8px 0; }
  .xp-bar { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 99px; transition: width .6s; }
  .xp-label { display: flex; justify-content: space-between; font-size: 10px; color: var(--text3); }
  .qr-wrap { text-align: center; padding: 24px; }
  .qr-code { font-family: 'DM Mono', monospace; font-size: 48px; font-weight: 500; color: var(--accent2); letter-spacing: 8px; margin: 16px 0; }
  .qr-date { font-size: 13px; color: var(--text2); }
  .loading { display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--text2); font-size: 14px; }
  .empty { text-align: center; padding: 40px; color: var(--text3); font-size: 13px; }
  .tag { font-size: 10px; padding: 2px 8px; border-radius: 99px; display: inline-block; font-weight: 500; }
  .tag-green { background: rgba(74,158,42,.15); color: var(--accent2); }
  .tag-amber { background: rgba(239,159,39,.15); color: var(--warning); }
  .tag-red { background: rgba(226,75,74,.15); color: var(--danger); }
  .tag-gray { background: var(--surface3); color: var(--text2); }
  .delete-btn { position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; border-radius: 50%; border: 1px solid rgba(226,75,74,.3); background: rgba(226,75,74,.1); color: var(--danger); cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
  .act-card:hover .delete-btn, .badge-card:hover .delete-btn { opacity: 1; }
  .squad-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .squad-row { display: flex; align-items: center; gap: 12px; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 16px; }
  .squad-color-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .squad-name { flex: 1; font-size: 13px; font-weight: 500; color: var(--text); }
  .squad-count { font-size: 12px; color: var(--text3); }
  .avatar-upload-area { border: 2px dashed var(--border2); border-radius: var(--radius); padding: 20px; text-align: center; cursor: pointer; transition: border-color .15s; margin-bottom: 12px; }
  .avatar-upload-area:hover { border-color: var(--accent); }
  .avatar-upload-area input { display: none; }
  .avatar-preview { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; margin: 0 auto 8px; display: block; border: 2px solid var(--accent); }
  select { padding: 8px 12px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; }
  select:focus { border-color: var(--accent); }
  textarea { width: 100%; padding: 10px 12px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius-sm); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; resize: vertical; min-height: 80px; }
  textarea:focus { border-color: var(--accent); }
  @media (max-width: 768px) {
    .sidebar { width: 56px; }
    .sidebar-logo-title span, .nav-item span, .sidebar-user { display: none; }
    .nav-item { justify-content: center; padding: 12px; }
    .stats-grid { grid-template-columns: 1fr 1fr; }
    .act-grid { grid-template-columns: 1fr; }
    .player-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
  }
`;

// ─── COMPONENTS ───────────────────────────────────────────

function Avatar({ url, emoji, size = 40 }) {
  if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }} />;
  return <span style={{ fontSize: size * 0.55 }}>{emoji || "🌱"}</span>;
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
  const s = SQUAD_STYLE[name] || { bg: "#1a2420", text: "#8fa898", border: "#2a3830" };
  return <span className="squad-pill" style={{ background: s.bg + "33", color: s.text, border: `1px solid ${s.border}44` }}>{name}</span>;
}

// ─── AVATAR UPLOAD ────────────────────────────────────────

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
      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} />
      {preview
        ? <img src={preview} className="avatar-preview" alt="avatar" />
        : <div style={{ fontSize: 32, marginBottom: 8 }}>📷</div>
      }
      <div style={{ fontSize: 12, color: "var(--text2)" }}>{uploading ? "Caricamento…" : "Clicca per cambiare avatar"}</div>
    </div>
  );
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
    if (!remember) {
      // Se non vuole restare loggato, segna nella sessionStorage
      sessionStorage.setItem("pug_no_persist", "1");
    }
    onLogin(profile || { id: data.user.id, role: "educator", display_name: email.split("@")[0], xp: 0, coin: 100 });
    setLoading(false);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <span className="login-logo-icon">🌿</span>
          <h1>PUG Scoreboard</h1>
          <p>Accedi al tuo account</p>
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="nome@email.com" />
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <input className="form-input" type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="••••••••" />
        </div>
        <label className="remember-row">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          <span>Resta collegato</span>
        </label>
        <button className="btn btn-primary" onClick={handleLogin} disabled={loading}>
          {loading ? "Accesso in corso…" : "Accedi"}
        </button>
        {err && <p className="err-msg">{err}</p>}
      </div>
    </div>
  );
}

// ─── EDUCATOR VIEWS ───────────────────────────────────────

function PlayersView({ profile }) {
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

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await sb.from("profiles").select("*, squads(name, color)").eq("role", "player").order("xp", { ascending: false });
    const { data: sq } = await sb.from("squads").select("*");
    setPlayers(data || []);
    setSquads(sq || []);
    setLoading(false);
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
    setPlayers(prev => prev.map(x => x.id === playerId ? { ...x, [field]: newVal } : x));
  }

  async function applyBatch() {
    if (!selected.size) return;
    const ids = [...selected];
    for (const id of ids) {
      const p = players.find(x => x.id === id);
      if (!p) continue;
      await sb.from("profiles").update({ xp: p.xp + Number(batchXp), coin: p.coin + Number(batchCoin) }).eq("id", id);
    }
    setMsg(`+${batchXp} XP e +${batchCoin} coin assegnati a ${ids.length} giocatori`);
    setSelected(new Set());
    load();
    setTimeout(() => setMsg(""), 3000);
  }

  async function savePlayer(p) {
    await sb.from("profiles").update({
      display_name: p.display_name,
      squad_id: p.squad_id,
      xp: p.xp,
      coin: p.coin,
    }).eq("id", p.id);
    setEditPlayer(null);
    load();
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function selectAll() {
    setSelected(prev => prev.size === visible.length ? new Set() : new Set(visible.map(p => p.id)));
  }

  const totalXP = visible.reduce((a, p) => a + p.xp, 0);

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label">Giocatori</div><div className="stat-value">{visible.length}</div></div>
        <div className="stat-card"><div className="stat-label">XP totali</div><div className="stat-value">{totalXP.toLocaleString()}</div></div>
        <div className="stat-card"><div className="stat-label">Selezionati</div><div className="stat-value">{selected.size}</div></div>
        <div className="stat-card"><div className="stat-label">Squadre</div><div className="stat-value">{squads.length}</div></div>
      </div>

      {selected.size > 0 && (
        <div className="batch-panel">
          <span className="batch-info">{selected.size} giocatori selezionati</span>
          <input className="batch-inp" type="number" value={batchXp} onChange={e => setBatchXp(e.target.value)} placeholder="XP" />
          <span style={{ fontSize: 12, color: "var(--text3)" }}>XP</span>
          <input className="batch-inp" type="number" value={batchCoin} onChange={e => setBatchCoin(e.target.value)} placeholder="Coin" />
          <span style={{ fontSize: 12, color: "var(--text3)" }}>Coin</span>
          <button className="btn btn-primary btn-sm" onClick={applyBatch}>Assegna</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Annulla</button>
        </div>
      )}
      {msg && <div style={{ background: "rgba(74,158,42,.1)", border: "1px solid rgba(74,158,42,.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "var(--accent2)" }}>{msg}</div>}

      <div className="filter-bar">
        <input className="search-inp" placeholder="Cerca giocatore…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => (
          <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>
        ))}
        <button className="btn btn-ghost btn-sm" onClick={selectAll}>{selected.size === visible.length ? "Deseleziona tutti" : "Seleziona tutti"}</button>
      </div>

      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="player-grid">
          {visible.map(p => {
            const lv = getLevel(p.xp);
            const sq = p.squads?.name;
            const sqStyle = SQUAD_STYLE[sq] || {};
            return (
              <div key={p.id} className={`player-card ${selected.has(p.id) ? "selected" : ""}`} onClick={() => toggleSelect(p.id)}>
                <div className="avatar-wrap" style={{ borderColor: sqStyle.border || "var(--border2)" }}>
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
                  <button className="pts-btn rem" style={{ fontSize: 10, width: 32, borderRadius: 8 }} onClick={() => changeXP(p.id, -5, "coin")}>🪙−</button>
                  <button className="pts-btn add" style={{ fontSize: 10, width: 32, borderRadius: 8 }} onClick={() => changeXP(p.id, 5, "coin")}>🪙+</button>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: 8, width: "100%", fontSize: 10 }}
                  onClick={e => { e.stopPropagation(); setEditPlayer({ ...p }); }}
                >✏️ Modifica</button>
              </div>
            );
          })}
        </div>
      )}

      {/* MODAL MODIFICA GIOCATORE */}
      {editPlayer && (
        <div className="modal-bg" onClick={() => setEditPlayer(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Modifica giocatore</div>
            <AvatarUpload
              playerId={editPlayer.id}
              currentUrl={editPlayer.avatar_url}
              onUploaded={url => setEditPlayer(p => ({ ...p, avatar_url: url }))}
            />
            <div className="form-group">
              <label className="form-label">Nome</label>
              <input className="form-input" value={editPlayer.display_name} onChange={e => setEditPlayer(p => ({ ...p, display_name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Squadra</label>
              <select style={{ width: "100%" }} value={editPlayer.squad_id || ""} onChange={e => setEditPlayer(p => ({ ...p, squad_id: e.target.value || null }))}>
                <option value="">Nessuna squadra</option>
                {squads.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group">
                <label className="form-label">XP</label>
                <input className="form-input" type="number" value={editPlayer.xp} onChange={e => setEditPlayer(p => ({ ...p, xp: Number(e.target.value) }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Coin</label>
                <input className="form-input" type="number" value={editPlayer.coin} onChange={e => setEditPlayer(p => ({ ...p, coin: Number(e.target.value) }))} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => savePlayer(editPlayer)}>Salva</button>
              <button className="btn btn-ghost" onClick={() => setEditPlayer(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LeaderboardView() {
  const [players, setPlayers] = useState([]);
  const [squadFilter, setSquadFilter] = useState("all");
  const [squads, setSquads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await sb.from("profiles").select("*, squads(name)").eq("role", "player").order("xp", { ascending: false });
      const { data: sq } = await sb.from("squads").select("*");
      setPlayers(data || []);
      setSquads(sq || []);
      setLoading(false);
    }
    load();
  }, []);

  const visible = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
  const maxXP = visible[0]?.xp || 1;
  const medals = ["gold", "silver", "bronze"];
  const medalLabel = ["1°", "2°", "3°"];

  return (
    <div>
      <div className="filter-bar">
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>)}
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="lb-list">
          {visible.map((p, i) => {
            const lv = getLevel(p.xp);
            return (
              <div key={p.id} className="lb-row">
                <span className={`lb-rank ${i < 3 ? medals[i] : ""}`}>{i < 3 ? medalLabel[i] : (i + 1) + "°"}</span>
                <div className="lb-av"><Avatar url={p.avatar_url} emoji={lv.emoji} size={36} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="lb-name">{p.display_name}</div>
                  <div className="lb-level">{lv.emoji} {lv.name} {p.squads?.name && <SquadPill name={p.squads.name} />}</div>
                </div>
                <div className="lb-bar-wrap"><div className="lb-bar" style={{ width: Math.round(p.xp / maxXP * 100) + "%" }} /></div>
                <span className="lb-xp">{p.xp} XP</span>
                <span className="lb-coin">🪙 {p.coin}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SquadsView() {
  const [squads, setSquads] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newSquad, setNewSquad] = useState({ name: "", color: "#4a9e2a" });

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: sq }, { data: pl }] = await Promise.all([
      sb.from("squads").select("*").order("name"),
      sb.from("profiles").select("id, squad_id").eq("role", "player"),
    ]);
    setSquads(sq || []);
    setPlayers(pl || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createSquad() {
    if (!newSquad.name.trim()) return;
    await sb.from("squads").insert(newSquad);
    setShowForm(false);
    setNewSquad({ name: "", color: "#4a9e2a" });
    load();
  }

  async function deleteSquad(id) {
    if (!confirm("Eliminare questa squadra? I giocatori resteranno senza squadra.")) return;
    await sb.from("squads").delete().eq("id", id);
    load();
  }

  const countFor = (id) => players.filter(p => p.squad_id === id).length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>+ Nuova squadra</button>
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="squad-list">
          {squads.map(s => (
            <div key={s.id} className="squad-row">
              <div className="squad-color-dot" style={{ background: s.color || "#4a9e2a" }} />
              <span className="squad-name">{s.name}</span>
              <span className="squad-count">{countFor(s.id)} giocatori</span>
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
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="color" value={newSquad.color} onChange={e => setNewSquad(f => ({ ...f, color: e.target.value }))} style={{ width: 40, height: 36, border: "none", background: "none", cursor: "pointer" }} />
                <span style={{ fontSize: 13, color: "var(--text2)" }}>{newSquad.color}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createSquad} disabled={!newSquad.name.trim()}>Crea</button>
              <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AttendanceView() {
  const [players, setPlayers] = useState([]);
  const [squads, setSquads] = useState([]);
  const [attendances, setAttendances] = useState({});
  const [squadFilter, setSquadFilter] = useState("all");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState({ xp_daily_checkin: "10", coin_daily_checkin: "5", xp_week_bonus: "50", coin_week_bonus: "25" });

  useEffect(() => {
    async function load() {
      const [{ data: pl }, { data: sq }, { data: att }, { data: cfg }] = await Promise.all([
        sb.from("profiles").select("*, squads(name)").eq("role", "player").order("display_name"),
        sb.from("squads").select("*"),
        sb.from("attendances").select("*").eq("date", date).eq("check_type", "daily"),
        sb.from("config").select("*"),
      ]);
      setPlayers(pl || []);
      setSquads(sq || []);
      const attMap = {};
      (att || []).forEach(a => { attMap[a.player_id] = a; });
      setAttendances(attMap);
      const cfgMap = {};
      (cfg || []).forEach(c => { cfgMap[c.key] = c.value; });
      setConfig(prev => ({ ...prev, ...cfgMap }));
      setLoading(false);
    }
    load();
  }, [date]);

  async function setStatus(playerId, status) {
    const existing = attendances[playerId];
    const xp = status === "none" ? 0 : Number(config.xp_daily_checkin);
    const coin = status === "none" ? 0 : Number(config.coin_daily_checkin);
    if (existing) {
      await sb.from("attendances").update({ status, xp_awarded: xp, coin_awarded: coin }).eq("id", existing.id);
    } else {
      await sb.from("attendances").insert({ player_id: playerId, date, check_type: "daily", status, xp_awarded: xp, coin_awarded: coin, qr_verified: false });
    }
    if (status !== "none") {
      await sb.from("profiles").update({ xp: (players.find(p => p.id === playerId)?.xp || 0) + xp, coin: (players.find(p => p.id === playerId)?.coin || 0) + coin }).eq("id", playerId);
    }
    setAttendances(prev => ({ ...prev, [playerId]: { ...existing, status, player_id: playerId } }));
  }

  async function markAllPresent() {
    const vis = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
    for (const p of vis) { await setStatus(p.id, "full"); }
  }

  const visible = players.filter(p => squadFilter === "all" || p.squads?.name === squadFilter);
  const presentCount = Object.values(attendances).filter(a => a.status !== "none").length;

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label">Presenti oggi</div><div className="stat-value">{presentCount}</div></div>
        <div className="stat-card"><div className="stat-label">Totale</div><div className="stat-value">{visible.length}</div></div>
        <div className="stat-card"><div className="stat-label">XP presenza</div><div className="stat-value">{config.xp_daily_checkin}</div></div>
        <div className="stat-card"><div className="stat-label">Bonus settimana</div><div className="stat-value">{config.xp_week_bonus} XP</div></div>
      </div>
      <div className="filter-bar">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ padding: "7px 10px", background: "var(--surface2)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontFamily: "DM Sans", fontSize: 13 }} />
        <button className={`chip ${squadFilter === "all" ? "active" : ""}`} onClick={() => setSquadFilter("all")}>Tutti</button>
        {squads.map(s => <button key={s.id} className={`chip ${squadFilter === s.name ? "active" : ""}`} onClick={() => setSquadFilter(s.name)}>{s.name}</button>)}
        <button className="btn btn-primary btn-sm" onClick={markAllPresent}>✓ Tutti presenti</button>
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="pres-table">
            <thead><tr><th>Giocatore</th><th>Squadra</th><th>Livello</th><th>Stato</th><th>XP</th><th>Coin</th></tr></thead>
            <tbody>
              {visible.map(p => {
                const lv = getLevel(p.xp);
                const att = attendances[p.id];
                const status = att?.status || "none";
                return (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 500 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar url={p.avatar_url} emoji={lv.emoji} size={28} />{p.display_name}</div></td>
                    <td>{p.squads?.name && <SquadPill name={p.squads.name} />}</td>
                    <td style={{ fontSize: 11, color: "var(--text2)" }}>{lv.emoji} {lv.name}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[["none","?","pd-none"],["partial","~","pd-partial"],["full","✓","pd-yes"],["completed","★","pd-completed"]].map(([s, label, cls]) => (
                          <button key={s} className={`pres-dot ${cls}`} style={{ opacity: status === s ? 1 : 0.35 }} onClick={() => setStatus(p.id, s)}>{label}</button>
                        ))}
                      </div>
                    </td>
                    <td style={{ fontFamily: "DM Mono", fontSize: 12, color: "var(--accent2)" }}>{p.xp}</td>
                    <td style={{ fontFamily: "DM Mono", fontSize: 12, color: "var(--warning)" }}>{p.coin}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivitiesView() {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", duration_days: 4, xp_partial: 10, xp_full: 20, xp_completed: 35, coin_partial: 5, coin_full: 10, coin_completed: 18, coin_cost: 20, max_participants: "" });

  const load = useCallback(async () => {
    const { data } = await sb.from("activities").select("*").eq("is_active", true).order("created_at", { ascending: false });
    setActivities(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createActivity() {
    const { data } = await sb.from("activities").insert({ ...form, max_participants: form.max_participants || null }).select().single();
    if (data) { setActivities(prev => [data, ...prev]); setShowForm(false); setForm({ name: "", description: "", duration_days: 4, xp_partial: 10, xp_full: 20, xp_completed: 35, coin_partial: 5, coin_full: 10, coin_completed: 18, coin_cost: 20, max_participants: "" }); }
  }

  async function deleteActivity(id) {
    if (!confirm("Eliminare questa attività?")) return;
    await sb.from("activities").update({ is_active: false }).eq("id", id);
    setActivities(prev => prev.filter(a => a.id !== id));
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>+ Nuova attività</button>
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="act-grid">
          {activities.map(a => (
            <div key={a.id} className="act-card">
              <button className="delete-btn" onClick={() => deleteActivity(a.id)} title="Elimina">✕</button>
              <div className="act-title">{a.name}</div>
              <div className="act-meta">{a.description} · <span className="tag tag-gray">{a.duration_days} giorni</span></div>
              <div className="act-rewards">
                <span className="reward-tag xp-tag">Parziale: {a.xp_partial} XP</span>
                <span className="reward-tag xp-tag">Completa: {a.xp_full} XP</span>
                <span className="reward-tag xp-tag">Completata: {a.xp_completed} XP</span>
                <span className="reward-tag coin-tag">🪙 {a.coin_cost} per prenotare</span>
              </div>
            </div>
          ))}
          {activities.length === 0 && <div className="empty" style={{ gridColumn: "1/-1" }}>Nessuna attività ancora. Creane una!</div>}
        </div>
      )}
      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Nuova attività</div>
            {[["name","Nome attività","text"],["description","Descrizione","text"],["duration_days","Durata (giorni)","number"],["coin_cost","Costo prenotazione (coin)","number"],["max_participants","Max partecipanti (opzionale)","number"]].map(([k, label, type]) => (
              <div className="form-group" key={k}>
                <label className="form-label">{label}</label>
                <input className="form-input" type={type} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
              </div>
            ))}
            <div className="section-label">XP per livello di presenza</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[["xp_partial","Parziale"],["xp_full","Completa"],["xp_completed","Completata"]].map(([k, label]) => (
                <div key={k}><label className="form-label">{label}</label><input className="form-input" type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: Number(e.target.value) }))} /></div>
              ))}
            </div>
            <div className="section-label">Coin per livello di presenza</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[["coin_partial","Parziale"],["coin_full","Completa"],["coin_completed","Completata"]].map(([k, label]) => (
                <div key={k}><label className="form-label">{label}</label><input className="form-input" type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: Number(e.target.value) }))} /></div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createActivity}>Crea attività</button>
              <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BadgesView() {
  const [badges, setBadges] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAssign, setShowAssign] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assignTarget, setAssignTarget] = useState("");
  const [assignXp, setAssignXp] = useState(0);
  const [assignCoin, setAssignCoin] = useState(0);
  const [newBadge, setNewBadge] = useState({ name: "", xp_default: 20, coin_default: 10 });

  const load = useCallback(async () => {
    const [{ data: b }, { data: p }] = await Promise.all([
      sb.from("badges").select("*").order("created_at", { ascending: false }),
      sb.from("profiles").select("id, display_name").eq("role", "player").order("display_name"),
    ]);
    setBadges(b || []); setPlayers(p || []); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function assignBadge() {
    if (!assignTarget || !showAssign) return;
    const badge = badges.find(b => b.id === showAssign);
    await sb.from("player_badges").insert({ player_id: assignTarget, badge_id: showAssign, xp_awarded: Number(assignXp), coin_awarded: Number(assignCoin) });
    await sb.from("profiles").update({ xp: (players.find(p => p.id === assignTarget)?.xp || 0) + Number(assignXp), coin: (players.find(p => p.id === assignTarget)?.coin || 0) + Number(assignCoin) }).eq("id", assignTarget);
    await sb.from("notifications").insert({ user_id: assignTarget, type: "badge_assigned", title: "Nuovo badge ricevuto!", body: `Hai ricevuto il badge "${badge?.name}"` });
    setShowAssign(null);
  }

  async function createBadge() {
    const { data } = await sb.from("badges").insert(newBadge).select().single();
    if (data) { setBadges(prev => [data, ...prev]); setShowCreate(false); setNewBadge({ name: "", xp_default: 20, coin_default: 10 }); }
  }

  async function deleteBadge(id) {
    if (!confirm("Eliminare questo badge?")) return;
    await sb.from("badges").delete().eq("id", id);
    setBadges(prev => prev.filter(b => b.id !== id));
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ Nuovo badge</button>
      </div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="badge-grid">
          {badges.map(b => (
            <div key={b.id} className="badge-card">
              <button className="delete-btn" onClick={e => { e.stopPropagation(); deleteBadge(b.id); }} title="Elimina">✕</button>
              <div onClick={() => { setShowAssign(b.id); setAssignXp(b.xp_default); setAssignCoin(b.coin_default); }}>
                {b.image_url ? <img className="badge-img" src={b.image_url} alt={b.name} /> : <span className="badge-emoji">🎖️</span>}
                <div className="badge-name">{b.name}</div>
                <div className="badge-pts">+{b.xp_default} XP · 🪙{b.coin_default}</div>
              </div>
            </div>
          ))}
          {badges.length === 0 && <div className="empty" style={{ gridColumn: "1/-1" }}>Nessun badge ancora.</div>}
        </div>
      )}
      {showAssign && (
        <div className="modal-bg" onClick={() => setShowAssign(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Assegna badge</div>
            <div className="form-group">
              <label className="form-label">Giocatore</label>
              <select style={{ width: "100%" }} value={assignTarget} onChange={e => setAssignTarget(e.target.value)}>
                <option value="">Seleziona giocatore…</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP</label><input className="form-input" type="number" value={assignXp} onChange={e => setAssignXp(e.target.value)} /></div>
              <div className="form-group"><label className="form-label">Coin</label><input className="form-input" type="number" value={assignCoin} onChange={e => setAssignCoin(e.target.value)} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={assignBadge} disabled={!assignTarget}>Assegna</button>
              <button className="btn btn-ghost" onClick={() => setShowAssign(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
      {showCreate && (
        <div className="modal-bg" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Crea nuovo badge</div>
            <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={newBadge.name} onChange={e => setNewBadge(f => ({ ...f, name: e.target.value }))} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="form-group"><label className="form-label">XP default</label><input className="form-input" type="number" value={newBadge.xp_default} onChange={e => setNewBadge(f => ({ ...f, xp_default: Number(e.target.value) }))} /></div>
              <div className="form-group"><label className="form-label">Coin default</label><input className="form-input" type="number" value={newBadge.coin_default} onChange={e => setNewBadge(f => ({ ...f, coin_default: Number(e.target.value) }))} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createBadge} disabled={!newBadge.name}>Crea badge</button>
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MessagesView({ profile }) {
  const [threads] = useState([
    { id: "verde", name: "Squadra Verde", last: "Ottimo allenamento!" },
    { id: "gialla", name: "Squadra Gialla", last: "Ci vediamo sabato?" },
    { id: "azzurra", name: "Squadra Azzurra", last: "Grande partita!" },
    { id: "tutti", name: "Tutti", last: "Evento sabato!" },
  ]);
  const [active, setActive] = useState(threads[0]);
  const [msgs, setMsgs] = useState([{ id: 1, sender: "Sistema", body: "Benvenuto nella chat!", mine: false }]);
  const [input, setInput] = useState("");

  function send() {
    if (!input.trim()) return;
    setMsgs(prev => [...prev, { id: Date.now(), sender: profile.display_name, body: input, mine: true }]);
    setInput("");
  }

  return (
    <div className="msg-layout">
      <div className="msg-list">
        <div className="section-label" style={{ marginTop: 0 }}>Canali</div>
        {threads.map(t => (
          <div key={t.id} className={`msg-thread ${active.id === t.id ? "active" : ""}`} onClick={() => setActive(t)}>
            <div className="mt-name">{t.name}</div>
            <div className="mt-last">{t.last}</div>
          </div>
        ))}
      </div>
      <div className="msg-main">
        <div className="msg-hdr">{active.name}</div>
        <div className="msg-body">
          {msgs.map(m => (
            <div key={m.id} className={`bubble-wrap ${m.mine ? "mine" : ""}`}>
              <div className="bubble-av">{m.mine ? "👑" : "🌿"}</div>
              <div>
                {!m.mine && <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 2 }}>{m.sender}</div>}
                <div className={`bubble ${m.mine ? "mine" : "them"}`}>{m.body}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="msg-inp-row">
          <input className="msg-inp" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Scrivi un messaggio…" />
          <button className="btn btn-primary btn-sm" onClick={send}>Invia</button>
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
      const { data } = await sb.from("bookings").select("*, profiles(display_name), activities(name, coin_cost)").order("created_at", { ascending: false });
      setBookings(data || []);
      setLoading(false);
    }
    load();
  }, []);

  async function review(id, status, playerId, coinHeld) {
    await sb.from("bookings").update({ status, reviewed_at: new Date().toISOString() }).eq("id", id);
    if (status === "rejected") {
      const { data: p } = await sb.from("profiles").select("coin").eq("id", playerId).single();
      await sb.from("profiles").update({ coin: (p?.coin || 0) + coinHeld }).eq("id", playerId);
    }
    await sb.from("notifications").insert({ user_id: playerId, type: status === "confirmed" ? "booking_confirmed" : "booking_rejected", title: status === "confirmed" ? "Prenotazione confermata!" : "Prenotazione non accettata", body: status === "confirmed" ? "La tua prenotazione è stata confermata." : "Le tue coin sono state restituite." });
    setBookings(prev => prev.map(b => b.id === id ? { ...b, status } : b));
  }

  const statusTag = { pending: ["tag-amber", "In attesa"], confirmed: ["tag-green", "Confermata"], rejected: ["tag-red", "Rifiutata"], cancelled: ["tag-gray", "Annullata"] };

  return (
    <div>
      {loading ? <div className="loading">Caricamento…</div> : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="pres-table">
            <thead><tr><th>Giocatore</th><th>Attività</th><th>Coin</th><th>Stato</th><th>Azioni</th></tr></thead>
            <tbody>
              {bookings.map(b => {
                const [tagClass, tagLabel] = statusTag[b.status] || ["tag-gray", b.status];
                return (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 500 }}>{b.profiles?.display_name}</td>
                    <td>{b.activities?.name}</td>
                    <td style={{ color: "var(--warning)" }}>🪙 {b.coin_held}</td>
                    <td><span className={`tag ${tagClass}`}>{tagLabel}</span></td>
                    <td>
                      {b.status === "pending" && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="btn btn-sm" style={{ background: "rgba(74,158,42,.15)", color: "var(--accent2)", border: "1px solid rgba(74,158,42,.3)" }} onClick={() => review(b.id, "confirmed", b.player_id, b.coin_held)}>✓ Conferma</button>
                          <button className="btn btn-danger btn-sm" onClick={() => review(b.id, "rejected", b.player_id, b.coin_held)}>✗ Rifiuta</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {bookings.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", padding: 32, color: "var(--text3)" }}>Nessuna prenotazione</td></tr>}
            </tbody>
          </table>
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
    async function load() {
      const { data } = await sb.from("daily_qr").select("*").eq("date", today).single();
      setQr(data);
      setLoading(false);
    }
    load();
  }, [today]);

  async function generateQr() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const validFrom = new Date(); validFrom.setHours(8, 0, 0, 0);
    const validUntil = new Date(); validUntil.setHours(12, 0, 0, 0);
    const { data } = await sb.from("daily_qr").upsert({ date: today, code, valid_from: validFrom.toISOString(), valid_until: validUntil.toISOString() }).select().single();
    setQr(data);
  }

  return (
    <div className="card" style={{ maxWidth: 400, margin: "0 auto" }}>
      <div className="qr-wrap">
        <div style={{ fontSize: 14, color: "var(--text2)", marginBottom: 8 }}>QR Check-in giornaliero</div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 20 }}>{today}</div>
        {loading ? <div className="loading">Caricamento…</div> : qr ? (
          <>
            <div style={{ background: "var(--surface3)", borderRadius: 16, padding: "20px 28px", marginBottom: 16 }}>
              <div className="qr-code">{qr.code}</div>
            </div>
            <div className="qr-date">Valido dalle {new Date(qr.valid_from).getHours()}:00 alle {new Date(qr.valid_until).getHours()}:00</div>
            <button className="btn btn-ghost" style={{ marginTop: 16, width: "100%" }} onClick={generateQr}>Rigenera codice</button>
          </>
        ) : (
          <>
            <div style={{ color: "var(--text3)", fontSize: 13, marginBottom: 20 }}>Nessun codice generato per oggi</div>
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={generateQr}>Genera QR di oggi</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── PLAYER VIEW ──────────────────────────────────────────

function PlayerDashboard({ profile, onLogout }) {
  const [tab, setTab] = useState("profilo");
  const [fullProfile, setFullProfile] = useState(null);
  const [badges, setBadges] = useState([]);
  const [activities, setActivities] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [qrInput, setQrInput] = useState("");
  const [qrMsg, setQrMsg] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [{ data: p }, { data: b }, { data: a }, { data: bk }, { data: n }] = await Promise.all([
        sb.from("profiles").select("*, squads(name)").eq("id", profile.id).single(),
        sb.from("player_badges").select("*, badges(*)").eq("player_id", profile.id).order("assigned_at", { ascending: false }),
        sb.from("activities").select("*").eq("is_active", true).order("created_at", { ascending: false }),
        sb.from("bookings").select("*, activities(name)").eq("player_id", profile.id).order("created_at", { ascending: false }),
        sb.from("notifications").select("*").eq("user_id", profile.id).order("created_at", { ascending: false }).limit(20),
      ]);
      setFullProfile(p); setBadges(b || []); setActivities(a || []); setBookings(bk || []); setNotifications(n || []);
      setLoading(false);
    }
    load();
  }, [profile.id]);

  async function doCheckin() {
    const today = new Date().toISOString().split("T")[0];
    const { data: qr } = await sb.from("daily_qr").select("*").eq("date", today).single();
    if (!qr) { setQrMsg("Nessun QR attivo oggi."); return; }
    if (qrInput.toUpperCase() !== qr.code) { setQrMsg("Codice non valido. Riprova."); return; }
    const now = new Date();
    if (now < new Date(qr.valid_from) || now > new Date(qr.valid_until)) { setQrMsg("Il codice non è più valido per questa fascia oraria."); return; }
    const { error } = await sb.from("attendances").insert({ player_id: profile.id, date: today, check_type: "daily", status: "full", xp_awarded: 10, coin_awarded: 5, qr_verified: true });
    if (error?.code === "23505") { setQrMsg("Hai già fatto il check-in oggi!"); return; }
    await sb.from("profiles").update({ xp: (fullProfile?.xp || 0) + 10, coin: (fullProfile?.coin || 0) + 5 }).eq("id", profile.id);
    setQrMsg("✓ Check-in effettuato! +10 XP, +5 Coin");
    setFullProfile(prev => ({ ...prev, xp: (prev?.xp || 0) + 10, coin: (prev?.coin || 0) + 5 }));
  }

  async function bookActivity(actId, cost) {
    if ((fullProfile?.coin || 0) < cost) { alert("Coin insufficienti!"); return; }
    await sb.from("bookings").insert({ player_id: profile.id, activity_id: actId, coin_held: cost });
    await sb.from("profiles").update({ coin: (fullProfile?.coin || 0) - cost }).eq("id", profile.id);
    setFullProfile(prev => ({ ...prev, coin: (prev?.coin || 0) - cost }));
    alert("Prenotazione inviata! Attendi la conferma dell'educatore.");
  }

  const lv = getLevel(fullProfile?.xp || 0);
  const nextLv = LEVELS.find(l => l.xp > (fullProfile?.xp || 0));
  const unread = notifications.filter(n => !n.read_at).length;
  const tabs = [["profilo","👤","Profilo"],["checkin","📍","Check-in"],["attivita","⚡","Attività"],["badge","🎖️","Badge"],["notifiche","🔔",`Notifiche${unread > 0 ? " ●" : ""}`]];

  if (loading) return <div className="loading" style={{ minHeight: "100vh" }}>Caricamento…</div>;

  return (
    <div style={{ maxWidth: 500, margin: "0 auto", padding: "16px", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>🌿 PUG Scoreboard</div>
        <button className="btn btn-ghost btn-sm" onClick={onLogout}>Esci</button>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, overflow: "auto", paddingBottom: 4 }}>
        {tabs.map(([id, icon, label]) => (
          <button key={id} className={`chip ${tab === id ? "active" : ""}`} onClick={() => setTab(id)} style={{ flexShrink: 0 }}>{icon} {label}</button>
        ))}
      </div>

      {tab === "profilo" && fullProfile && (
        <>
          <div className="profile-hero">
            <div className="profile-avatar"><Avatar url={fullProfile.avatar_url} emoji={lv.emoji} size={88} /></div>
            <div className="profile-name">{fullProfile.display_name}</div>
            <div className="profile-level">{lv.emoji} {lv.name}</div>
            {fullProfile.squads?.name && <SquadPill name={fullProfile.squads.name} />}
            <div style={{ marginTop: 16 }}><XpBar xp={fullProfile.xp} /></div>
            <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 16 }}>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 600, color: "var(--accent2)" }}>{fullProfile.xp}</div><div style={{ fontSize: 11, color: "var(--text3)" }}>XP totali</div></div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 600, color: "var(--warning)" }}>🪙 {fullProfile.coin}</div><div style={{ fontSize: 11, color: "var(--text3)" }}>Coin</div></div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>{badges.length}</div><div style={{ fontSize: 11, color: "var(--text3)" }}>Badge</div></div>
            </div>
          </div>
          <div className="section-label">Le mie prenotazioni</div>
          {bookings.slice(0, 5).map(b => {
            const s = { pending: ["tag-amber","In attesa"], confirmed: ["tag-green","Confermata"], rejected: ["tag-red","Rifiutata"] };
            const [cls, label] = s[b.status] || ["tag-gray", b.status];
            return <div key={b.id} className="card-sm" style={{ marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 13 }}>{b.activities?.name}</span><span className={`tag ${cls}`}>{label}</span></div>;
          })}
        </>
      )}

      {tab === "checkin" && (
        <div className="card">
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📍</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>Check-in giornaliero</div>
            <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 24 }}>Inserisci il codice mostrato in loco</div>
            <input className="form-input" value={qrInput} onChange={e => setQrInput(e.target.value.toUpperCase())} placeholder="es. ABC123" style={{ textAlign: "center", fontSize: 24, fontFamily: "DM Mono", letterSpacing: 6, marginBottom: 12 }} maxLength={6} />
            <button className="btn btn-primary" style={{ width: "100%", marginTop: 8 }} onClick={doCheckin}>Conferma presenza</button>
            {qrMsg && <div style={{ marginTop: 14, fontSize: 13, color: qrMsg.startsWith("✓") ? "var(--accent2)" : "var(--danger)" }}>{qrMsg}</div>}
          </div>
        </div>
      )}

      {tab === "attivita" && (
        <div>
          {activities.map(a => (
            <div key={a.id} className="act-card" style={{ marginBottom: 10 }}>
              <div className="act-title">{a.name}</div>
              <div className="act-meta">{a.description} · {a.duration_days} giorni</div>
              <div className="act-rewards">
                <span className="reward-tag xp-tag">Fino a {a.xp_completed} XP</span>
                <span className="reward-tag coin-tag">🪙 {a.coin_cost} per prenotare</span>
              </div>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 10, width: "100%" }} onClick={() => bookActivity(a.id, a.coin_cost)}>
                Prenota {a.coin_cost > (fullProfile?.coin || 0) ? "(coin insufficienti)" : ""}
              </button>
            </div>
          ))}
          {activities.length === 0 && <div className="empty">Nessuna attività disponibile al momento.</div>}
        </div>
      )}

      {tab === "badge" && (
        <div>
          {badges.length === 0 ? <div className="empty">Nessun badge ancora. Partecipa alle attività!</div> : (
            <div className="badge-grid">
              {badges.map(pb => (
                <div key={pb.id} className="badge-card">
                  {pb.badges?.image_url ? <img className="badge-img" src={pb.badges.image_url} alt={pb.badges?.name} /> : <span className="badge-emoji">🎖️</span>}
                  <div className="badge-name">{pb.badges?.name}</div>
                  <div className="badge-pts">+{pb.xp_awarded} XP · 🪙{pb.coin_awarded}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "notifiche" && (
        <div>
          {notifications.length === 0 ? <div className="empty">Nessuna notifica.</div> : notifications.map(n => {
            const icons = { badge_assigned: "🎖️", booking_confirmed: "✅", booking_rejected: "❌", new_activity: "⚡", level_up: "🆙", week_bonus: "🏆", new_message: "💬" };
            return (
              <div key={n.id} className="notif-item">
                <div className="notif-icon">{icons[n.type] || "🔔"}</div>
                <div>
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
  );
}

// ─── EDUCATOR SHELL ───────────────────────────────────────

const EDUCATOR_TABS = [
  ["giocatori", "👤", "Giocatori"],
  ["classifica", "🏆", "Classifica"],
  ["squadre", "🛡️", "Squadre"],
  ["presenze", "✅", "Presenze"],
  ["attivita", "⚡", "Attività"],
  ["badge", "🎖️", "Badge"],
  ["prenotazioni", "📋", "Prenotazioni"],
  ["messaggi", "💬", "Messaggi"],
  ["qr", "📍", "QR Check-in"],
];

function EducatorShell({ profile, onLogout }) {
  const [tab, setTab] = useState("giocatori");
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url);
  const cur = EDUCATOR_TABS.find(t => t[0] === tab);
  const lv = getLevel(profile.xp || 0);

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-title"><span>🌿</span><span>PUG</span></div>
          <div className="sidebar-logo-sub">Pannello educatore</div>
        </div>
        <nav className="nav">
          {EDUCATOR_TABS.map(([id, icon, label]) => (
            <div key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <span className="nav-icon">{icon}</span>
              <span>{label}</span>
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, cursor: "pointer" }} onClick={() => setShowAvatarModal(true)} title="Cambia avatar">
            <div style={{ width: 32, height: 32, borderRadius: "50%", overflow: "hidden", border: "2px solid var(--border2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>
              <Avatar url={avatarUrl} emoji={lv.emoji} size={32} />
            </div>
            <div>
              <div className="sidebar-user-name">{profile.display_name}</div>
              <div className="sidebar-user-role">{profile.role}</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ width: "100%" }} onClick={onLogout}>Esci</button>
        </div>
      </div>

      {showAvatarModal && (
        <div className="modal-bg" onClick={() => setShowAvatarModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Il tuo avatar</div>
            <AvatarUpload
              playerId={profile.id}
              currentUrl={avatarUrl}
              onUploaded={url => setAvatarUrl(url)}
            />
            <button className="btn btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => setShowAvatarModal(false)}>Chiudi</button>
          </div>
        </div>
      )}
      <div className="main">
        <div className="topbar">
          <h2>{cur?.[2]}</h2>
        </div>
        <div className="content">
          {tab === "giocatori"    && <PlayersView profile={profile} />}
          {tab === "classifica"   && <LeaderboardView />}
          {tab === "squadre"      && <SquadsView />}
          {tab === "presenze"     && <AttendanceView />}
          {tab === "attivita"     && <ActivitiesView />}
          {tab === "badge"        && <BadgesView />}
          {tab === "prenotazioni" && <BookingsView />}
          {tab === "messaggi"     && <MessagesView profile={profile} />}
          {tab === "qr"           && <QrView />}
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────

export default function App() {
  const [profile, setProfile] = useState(null);
  const [checking, setChecking] = useState(true);

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
  }

  if (checking) return <div className="loading" style={{ minHeight: "100vh" }}>🌿 Caricamento…</div>;

  return (
    <>
      <style>{css}</style>
      {!profile
        ? <Login onLogin={setProfile} />
        : profile.role === "player"
          ? <PlayerDashboard profile={profile} onLogout={onLogout} />
          : <EducatorShell profile={profile} onLogout={onLogout} />
      }
    </>
  );
}

      {!profile
        ? <Login onLogin={setProfile} />
        : profile.role === "player"
          ? <PlayerDashboard profile={profile} onLogout={onLogout} />
          : <EducatorShell profile={profile} onLogout={onLogout} />
      }
    </>
  );
}
