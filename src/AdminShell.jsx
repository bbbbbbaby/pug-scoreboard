import { useState, useEffect } from "react";
import { sb } from "./supabase.js";

export default function AdminShell({ profile, onLogout }) {
  const [educators, setEducators] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ display_name:"", email:"", password:"" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    sb.from("profiles").select("id,display_name,created_at")
      .eq("role","educator").order("display_name")
      .then(({ data }) => setEducators(data || []))
      .catch(console.error);
  }, []);

  async function create() {
    if (!form.display_name || !form.email || !form.password) { setErr("Tutti i campi obbligatori"); return; }
    setCreating(true); setErr(""); setMsg("");
    const adminId = profile.id;
    const { data: a, error: ae } = await sb.auth.signUp({ email: form.email, password: form.password });
    if (ae) { setErr(ae.message); setCreating(false); return; }
    const uid = a?.user?.id;
    if (!uid) { setErr("Creazione fallita - email già esistente?"); setCreating(false); return; }
    const { error: pe } = await sb.from("profiles").insert({ id: uid, display_name: form.display_name, role: "educator", pin: "1234" });
    if (pe) { setErr("Profilo: " + pe.message); setCreating(false); return; }
    setMsg("✅ Creato: " + form.email + " / " + form.password);
    setForm({ display_name:"", email:"", password:"" });
    setShowCreate(false);
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user?.id !== adminId) { await sb.auth.signOut(); window.location.reload(); }
    sb.from("profiles").select("id,display_name,created_at").eq("role","educator").order("display_name").then(({ data }) => setEducators(data || []));
    setCreating(false);
  }

  return (
    <div style={{ minHeight:"100vh", background:"#0a0530", padding:20, color:"#fff", fontFamily:"sans-serif" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
        <div>
          <h1 style={{ color:"#ffcc00", margin:0, fontSize:28 }}>⚙️ Super Admin</h1>
          <p style={{ color:"rgba(255,255,255,.5)", margin:"4px 0 0", fontSize:13 }}>{profile?.display_name}</p>
        </div>
        <button onClick={onLogout} style={{ padding:"8px 16px", background:"rgba(255,255,255,.1)", border:"1px solid rgba(255,255,255,.2)", borderRadius:8, color:"#fff", cursor:"pointer", fontSize:14 }}>Esci</button>
      </div>

      {msg && <div style={{ background:"#00ff8822", border:"1px solid #00ff88", borderRadius:8, padding:"10px 14px", marginBottom:12, color:"#00ff88" }}>{msg}</div>}
      {err && <div style={{ background:"#ff224422", border:"1px solid #ff2244", borderRadius:8, padding:"10px 14px", marginBottom:12, color:"#ff6688" }}>{err}</div>}

      <div style={{ background:"rgba(255,255,255,.08)", borderRadius:12, border:"1px solid rgba(255,255,255,.15)", marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 18px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>
          <span style={{ fontSize:18, fontWeight:700 }}>🌱 Giardinieri ({educators.length})</span>
          <button onClick={() => { setShowCreate(true); setErr(""); setMsg(""); }}
            style={{ padding:"8px 16px", background:"#ffcc00", border:"none", borderRadius:8, color:"#111", fontWeight:700, cursor:"pointer", fontSize:14 }}>
            + Nuovo
          </button>
        </div>
        {educators.length === 0 
          ? <p style={{ padding:"20px", textAlign:"center", color:"rgba(255,255,255,.4)" }}>Nessun giardiniere</p>
          : educators.map(e => (
            <div key={e.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 18px", borderBottom:"1px solid rgba(255,255,255,.06)" }}>
              <span style={{ fontSize:24 }}>🌱</span>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700 }}>{e.display_name}</div>
                <div style={{ fontSize:11, color:"rgba(255,255,255,.4)" }}>{new Date(e.created_at).toLocaleDateString("it-IT")}</div>
              </div>
            </div>
          ))}
      </div>

      {showCreate && (
        <div style={{ background:"rgba(255,255,255,.06)", borderRadius:12, border:"1px solid rgba(255,204,0,.3)", padding:20 }}>
          <h3 style={{ color:"#ffcc00", margin:"0 0 16px" }}>Nuovo giardiniere</h3>
          {[["display_name","Nome *","text"],["email","Email *","email"],["password","Password * (min 6)","text"]].map(([k,l,t]) => (
            <div key={k} style={{ marginBottom:12 }}>
              <label style={{ display:"block", fontSize:11, color:"rgba(255,255,255,.5)", marginBottom:5, textTransform:"uppercase", letterSpacing:".08em" }}>{l}</label>
              <input type={t} value={form[k]} onChange={e => setForm(f => ({...f, [k]:e.target.value}))}
                style={{ width:"100%", padding:"11px 13px", background:"rgba(255,255,255,.12)", border:"1px solid rgba(255,255,255,.25)", borderRadius:8, color:"#fff", fontSize:15, boxSizing:"border-box", outline:"none" }} />
            </div>
          ))}
          <div style={{ display:"flex", gap:10, marginTop:16 }}>
            <button onClick={create} disabled={creating}
              style={{ flex:1, padding:"12px", background: creating ? "#555":"#0066cc", border:"none", borderRadius:8, color:"#fff", fontWeight:700, fontSize:15, cursor:"pointer" }}>
              {creating ? "⏳ Creazione…" : "Crea giardiniere"}
            </button>
            <button onClick={() => setShowCreate(false)}
              style={{ padding:"12px 20px", background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.2)", borderRadius:8, color:"#fff", cursor:"pointer" }}>
              Annulla
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
