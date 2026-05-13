import { useState, useEffect } from "react";
import { sb } from "./supabase.js";

const S = {
  page: { minHeight:"100vh", background:"linear-gradient(160deg,#0a0530,#1a3590)", padding:"20px 16px", fontFamily:"sans-serif", color:"#fff" },
  header: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:24 },
  title: { fontSize:28, fontWeight:900, color:"#ffcc00", textTransform:"uppercase" },
  sub: { fontSize:12, color:"rgba(255,255,255,.5)", marginTop:2 },
  card: { background:"rgba(255,255,255,.08)", borderRadius:14, border:"1px solid rgba(255,255,255,.15)", overflow:"hidden", marginBottom:16 },
  cardHead: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 18px", borderBottom:"1px solid rgba(255,255,255,.1)" },
  cardTitle: { fontSize:20, fontWeight:700, color:"#fff" },
  row: { display:"flex", alignItems:"center", gap:12, padding:"12px 18px", borderBottom:"1px solid rgba(255,255,255,.06)" },
  av: { width:40, height:40, borderRadius:"50%", background:"rgba(255,204,0,.2)", border:"2px solid rgba(255,204,0,.4)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 },
  empty: { padding:"20px", textAlign:"center", color:"rgba(255,255,255,.4)", fontSize:14 },
  label: { fontSize:11, fontWeight:700, color:"rgba(255,255,255,.5)", textTransform:"uppercase", letterSpacing:".1em", display:"block", marginBottom:5 },
  input: { width:"100%", padding:"11px 13px", background:"rgba(255,255,255,.12)", border:"1px solid rgba(255,255,255,.25)", borderRadius:9, color:"#fff", fontSize:15, outline:"none", boxSizing:"border-box" },
  formBox: { background:"rgba(255,255,255,.06)", borderRadius:14, border:"1px solid rgba(255,204,0,.3)", padding:"20px", marginBottom:16 },
  msgGreen: { background:"rgba(0,255,136,.1)", border:"1px solid rgba(0,255,136,.3)", borderRadius:10, padding:"12px 14px", marginBottom:12, fontSize:13, fontWeight:700, color:"#00ff88" },
  msgRed: { background:"rgba(255,34,68,.1)", border:"1px solid rgba(255,34,68,.3)", borderRadius:10, padding:"12px 14px", marginBottom:12, fontSize:13, fontWeight:700, color:"#ff4466" },
  info: { background:"rgba(0,212,255,.06)", border:"1px solid rgba(0,212,255,.15)", borderRadius:10, padding:"12px 14px", marginTop:12, fontSize:12, color:"rgba(255,255,255,.5)" },
  btnPrimary: { background:"#0066cc", color:"#fff", border:"none", borderRadius:10, padding:"12px 20px", fontSize:15, fontWeight:700, cursor:"pointer", flex:1 },
  btnDanger: { background:"rgba(255,34,68,.2)", color:"#ff4466", border:"1px solid rgba(255,34,68,.4)", borderRadius:8, padding:"6px 12px", fontSize:12, fontWeight:700, cursor:"pointer" },
  btnGhost: { background:"rgba(255,255,255,.08)", color:"rgba(255,255,255,.7)", border:"1px solid rgba(255,255,255,.15)", borderRadius:10, padding:"10px 18px", fontSize:13, fontWeight:700, cursor:"pointer" },
  btnNew: { background:"#ffcc00", color:"#111", border:"none", borderRadius:8, padding:"8px 16px", fontSize:13, fontWeight:900, cursor:"pointer" },
};

export default function AdminShell({ profile, onLogout }) {
  const [educators, setEducators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ display_name:"", email:"", password:"", avatar_url:"" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    setLoading(true);
    try {
      const { data } = await sb.from("profiles")
        .select("id,display_name,avatar_url,created_at")
        .eq("role","educator").order("display_name");
      setEducators(data || []);
    } catch(e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function createEducator() {
    setErr(""); setMsg("");
    if (!form.display_name.trim() || !form.email.trim() || !form.password.trim()) {
      setErr("Nome, email e password obbligatori."); return;
    }
    if (form.password.length < 6) { setErr("Password minimo 6 caratteri."); return; }
    setCreating(true);
    try {
      const adminId = profile.id;
      const { data: authData, error: authErr } = await sb.auth.signUp({
        email: form.email.trim(), password: form.password.trim(),
      });
      if (authErr) { setErr("Errore: " + authErr.message); setCreating(false); return; }
      const uid = authData.user?.id;
      if (!uid) { setErr("Account non creato — email già esistente?"); setCreating(false); return; }
      const { error: pe } = await sb.from("profiles").insert({
        id: uid, display_name: form.display_name.trim(),
        role: "educator", avatar_url: form.avatar_url.trim() || null, pin: "1234",
      });
      if (pe) { setErr("Profilo non creato: " + pe.message); setCreating(false); return; }
      setMsg(`✅ Creato! Email: ${form.email} — Password: ${form.password}`);
      setForm({ display_name:"", email:"", password:"", avatar_url:"" });
      setShowCreate(false); load();
      const { data: { session } } = await sb.auth.getSession();
      if (session && session.user.id !== adminId) {
        alert("Giardiniere creato. Devi riaccedere come admin."); await sb.auth.signOut(); window.location.reload();
      }
    } catch(e) { setErr("Errore: " + (e?.message || String(e))); }
    setCreating(false);
  }

  async function deleteEducator(id, name) {
    if (!confirm(`Eliminare "${name}"?`)) return;
    await sb.from("profiles").delete().eq("id", id); load();
  }

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <div style={S.title}>⚙️ Super Admin</div>
          <div style={S.sub}>Gestione giardinieri · {profile.display_name}</div>
        </div>
        <button style={S.btnGhost} onClick={onLogout}>Esci</button>
      </div>

      {msg && <div style={S.msgGreen}>{msg}</div>}
      {err && <div style={S.msgRed}>{err}</div>}

      <div style={S.card}>
        <div style={S.cardHead}>
          <div style={S.cardTitle}>🌱 Giardinieri ({educators.length})</div>
          <button style={S.btnNew} onClick={() => { setShowCreate(true); setErr(""); setMsg(""); }}>+ Nuovo</button>
        </div>
        {loading ? <div style={S.empty}>⏳ Caricamento…</div> : (
          <div>
            {educators.length === 0 && <div style={S.empty}>Nessun giardiniere ancora.</div>}
            {educators.map(e => (
              <div key={e.id} style={S.row}>
                <div style={S.av}>{e.avatar_url ? <img src={e.avatar_url} style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"50%"}} alt=""/> : "🌱"}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:14, fontWeight:700}}>{e.display_name}</div>
                  <div style={{fontSize:11, color:"rgba(255,255,255,.4)"}}>Creato: {new Date(e.created_at).toLocaleDateString("it-IT")}</div>
                </div>
                <button style={S.btnDanger} onClick={() => deleteEducator(e.id, e.display_name)}>🗑️ Elimina</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <div style={S.formBox}>
          <div style={{fontSize:20, fontWeight:900, color:"#ffcc00", marginBottom:16}}>🌱 Nuovo giardiniere</div>
          {[["display_name","Nome visualizzato *","text","es. Massi"],
            ["email","Email *","email","giardiniere@email.com"],
            ["password","Password temporanea *","text","minimo 6 caratteri"],
            ["avatar_url","Avatar URL (opzionale)","text","/avatars/nome.webp"]
          ].map(([k,l,t,ph]) => (
            <div key={k} style={{marginBottom:12}}>
              <label style={S.label}>{l}</label>
              <input type={t} value={form[k]} onChange={e => setForm(f => ({...f, [k]: e.target.value}))}
                placeholder={ph} style={S.input} />
            </div>
          ))}
          <div style={{display:"flex", gap:10, marginTop:16}}>
            <button style={{...S.btnPrimary, opacity: creating ? 0.6 : 1}} onClick={createEducator} disabled={creating}>
              {creating ? "⏳ Creazione…" : "Crea giardiniere"}
            </button>
            <button style={S.btnGhost} onClick={() => setShowCreate(false)}>Annulla</button>
          </div>
          <div style={{fontSize:11, color:"rgba(255,255,255,.35)", marginTop:10}}>
            💡 Comunica email e password al giardiniere. Accederà con il tab "Giardiniere" nella schermata di login.
          </div>
        </div>
      )}

      <div style={S.info}>
        <strong style={{color:"#00d4ff"}}>Nota:</strong> dopo aver creato un account, il giardiniere accede con email + password dalla schermata di login (tab Giardiniere).
      </div>
    </div>
  );
}
