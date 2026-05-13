import { useState, useEffect } from "react";
import { sb } from "./supabase.js";

// ─── SUPER ADMIN ─────────────────────────────────────────

function AdminShell({ profile, onLogout }) {
  const [educators, setEducators] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ display_name:"", email:"", password:"", avatar_url:"" });
  const [msg, setMsg]   = useState("");
  const [err, setErr]   = useState("");

  async function load() {
    setLoading(true);
    const { data } = await sb.from("profiles")
      .select("id,display_name,avatar_url,created_at")
      .eq("role","educator").order("display_name");
    setEducators(data||[]); setLoading(false);
  }
  useEffect(()=>{ load(); },[]);

  const [creating, setCreating] = useState(false);

  async function createEducator() {
    setErr(""); setMsg("");
    if (!form.email.trim() || !form.password.trim() || !form.display_name.trim()) {
      setErr("Nome, email e password sono obbligatori."); return;
    }
    if (form.password.length < 6) { setErr("Password minimo 6 caratteri."); return; }
    setCreating(true);
    try {
      const adminId = profile.id;
      const { data: authData, error: authErr } = await sb.auth.signUp({
        email: form.email.trim(),
        password: form.password.trim(),
      });
      if (authErr) { setErr("❌ Errore: " + authErr.message); setCreating(false); return; }
      const uid = authData.user?.id;
      if (!uid) {
        setErr("❌ Account non creato: email già esistente, oppure vai su Supabase → Authentication → Sign In/Providers → Email → disattiva Confirm email.");
        setCreating(false); return;
      }
      const { error: profErr } = await sb.from("profiles").insert({
        id: uid, display_name: form.display_name.trim(),
        role: "educator", avatar_url: form.avatar_url.trim() || null, pin: "1234",
      });
      if (profErr) { setErr("Account creato ma profilo fallito: " + profErr.message); setCreating(false); return; }
      const ok = `✅ "${form.display_name}" creato!
Email: ${form.email}
Password: ${form.password}`;
      setMsg(ok); setForm({ display_name:"", email:"", password:"", avatar_url:"" }); setShowCreate(false); load();
      // Se signUp ha cambiato sessione, torna al login admin
      const { data: { session } } = await sb.auth.getSession();
      if (session && session.user.id !== adminId) {
        alert(ok + " — Devi riaccedere come admin."); await sb.auth.signOut(); window.location.reload();
      }
    } catch(e) { setErr("Errore: " + (e?.message || String(e))); }
    setCreating(false);
  }

  async function deleteEducator(id, name) {
    if (!confirm(`Eliminare il giardiniere "${name}"? Non si può annullare.`)) return;
    await sb.from("profiles").delete().eq("id", id);
    load();
  }

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(160deg,#0a0530,#1a3590)",padding:"20px 16px"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
        <div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:32,fontWeight:900,textTransform:"uppercase",color:"#ffcc00",letterSpacing:".05em"}}>⚙️ Super Admin</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,.4)"}}>Gestione giardinieri · {profile.display_name}</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onLogout}>Esci</button>
      </div>

      {msg && <div style={{background:"rgba(0,255,136,.1)",border:"1px solid rgba(0,255,136,.3)",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:13,fontWeight:700,color:"var(--neon-green)"}}>{msg}</div>}
      {err && <div style={{background:"rgba(255,34,68,.1)",border:"1px solid rgba(255,34,68,.3)",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:13,fontWeight:700,color:"var(--danger)"}}>{err}</div>}

      {/* Educators list */}
      <div style={{background:"rgba(255,255,255,.06)",borderRadius:16,border:"1px solid rgba(255,255,255,.15)",overflow:"hidden",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",borderBottom:"1px solid rgba(255,255,255,.06)"}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:900,color:"#fff"}}>🌱 Giardinieri ({educators.length})</div>
          <button className="btn btn-primary btn-sm" onClick={()=>{setShowCreate(true);setErr("");setMsg("");}}>+ Nuovo</button>
        </div>
        {loading ? <div style={{padding:20,textAlign:"center",color:"var(--text3)"}}>⏳ Caricamento…</div> : (
          <div>
            {educators.length===0 && <div style={{padding:"20px",textAlign:"center",color:"var(--text3)"}}>Nessun giardiniere</div>}
            {educators.map(e=>(
              <div key={e.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 18px",borderBottom:"1px solid rgba(255,255,255,.04)"}}>
                <div style={{width:40,height:40,borderRadius:"50%",overflow:"hidden",border:"2px solid rgba(255,204,0,.3)",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>
                  {e.avatar_url ? <img src={e.avatar_url} style={{width:"100%",height:"100%",objectFit:"cover"}} alt=""/> : "🌱"}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>{e.display_name}</div>
                  <div style={{fontSize:11,color:"var(--text3)"}}>Creato: {new Date(e.created_at).toLocaleDateString("it-IT")}</div>
                </div>
                <button className="btn btn-danger btn-xs" onClick={()=>deleteEducator(e.id, e.display_name)}>🗑️</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={{background:"rgba(255,255,255,.06)",borderRadius:16,border:"1px solid rgba(255,204,0,.35)",padding:"20px",marginTop:12}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:900,color:"#ffcc00",marginBottom:16}}>🌱 Nuovo giardiniere</div>
          {[["display_name","Nome visualizzato *","text","es. Massi"],["email","Email *","email","giardiniere@pug.it"],["password","Password temporanea *","text","min 6 caratteri"],["avatar_url","Avatar URL (opzionale)","text","/avatars/massi.webp"]].map(([k,l,t,ph])=>(
            <div key={k} style={{marginBottom:12}}>
              <label style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,.5)",textTransform:"uppercase",letterSpacing:".1em",display:"block",marginBottom:5}}>{l}</label>
              <input type={t} value={form[k]} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} placeholder={ph}
                style={{width:"100%",padding:"12px 14px",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.2)",borderRadius:10,color:"#fff",fontSize:15,outline:"none"}}/>
            </div>
          ))}
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button className="btn btn-primary" style={{flex:1}} onClick={createEducator} disabled={creating}>{creating?"⏳ Creazione…":"Crea giardiniere"}</button>
            <button className="btn btn-ghost btn-sm" onClick={()=>setShowCreate(false)}>Annulla</button>
          </div>
          <div style={{fontSize:11,color:"var(--text3)",marginTop:10}}>
            💡 Il giardiniere riceve email+password da te. Al primo accesso cambierà il PIN. Puoi eliminare il profilo in qualsiasi momento da qui.
          </div>
        </div>
      )}

      {/* Info box */}
      <div style={{marginTop:16,background:"rgba(0,212,255,.05)",border:"1px solid rgba(0,212,255,.15)",borderRadius:12,padding:"12px 16px",fontSize:12,color:"rgba(255,255,255,.45)"}}>
        <strong style={{color:"var(--azzurro)"}}>Nota:</strong> dopo aver creato un giardiniere, comunicagli email e password temporanea. Accedendo all'app per la prima volta vedrà la dashboard educatore normalmente. Puoi cambiare il suo avatar dal pannello Giocatori.
      </div>
    </div>
  );
}

export default AdminShell;
