import { useState, useEffect, useRef, useCallback } from "react";

const N_RINGS = 38;
const W = 520, H = 520;
const CX = 260, CY = 260;
const DISK_R = 248;
const TAU = Math.PI * 2;
const K_LOG = 0.9;
function logR(i) {
  return DISK_R * (Math.exp((i / N_RINGS) * K_LOG) - 1) / (Math.exp(K_LOG) - 1);
}

const P_ZONES = [
  { key:"hate",    label:"Hate",    sig:131, hi:201,  color:"#dd3333" },
  { key:"dislike", label:"Dislike", sig:256, hi:341,  color:"#cc8833" },
  { key:"neutral", label:"Neutral", sig:381, hi:451,  color:"#7777bb" },
  { key:"like",    label:"Like",    sig:574, hi:620,  color:"#44bb55" },
  { key:"love",    label:"Love",    sig:767, hi:9999, color:"#cc44cc" },
];

const ENVS = {
  Void:    { r:4,   g:4,   b:8,   noise:2,  hex:"#111118" },
  Neutral: { r:128, g:128, b:128, noise:5,  hex:"#808080" },
  Tension: { r:200, g:20,  b:20,  noise:28, hex:"#cc2020" },
  Grief:   { r:22,  g:30,  b:180, noise:6,  hex:"#2030cc" },
  Calm:    { r:28,  g:140, b:190, noise:3,  hex:"#209090" },
  Wonder:  { r:100, g:60,  b:220, noise:14, hex:"#6040cc" },
  Warmth:  { r:210, g:100, b:35,  noise:18, hex:"#cc6020" },
  Joy:     { r:220, g:200, b:20,  noise:20, hex:"#cccc14" },
  Love:    { r:220, g:50,  b:170, noise:12, hex:"#cc30aa" },
};

const PALETTE = [
  { name:"Void",       r:8,   g:8,   b:8,   zone:"hate"    },
  { name:"Hate",       r:35,  g:8,   b:8,   zone:"hate"    },
  { name:"Rage",       r:220, g:20,  b:20,  zone:"hate"    },
  { name:"Dislike",    r:110, g:55,  b:55,  zone:"dislike" },
  { name:"Fear",       r:65,  g:55,  b:15,  zone:"dislike" },
  { name:"Grief",      r:38,  g:38,  b:130, zone:"dislike" },
  { name:"Melancholy", r:75,  g:75,  b:160, zone:"dislike" },
  { name:"Neutral",    r:128, g:128, b:128, zone:"neutral" },
  { name:"Longing",    r:140, g:80,  b:180, zone:"neutral" },
  { name:"Calm",       r:95,  g:175, b:200, zone:"like"    },
  { name:"Curiosity",  r:110, g:200, b:115, zone:"like"    },
  { name:"Hope",       r:195, g:228, b:145, zone:"like"    },
  { name:"Joy",        r:255, g:218, b:55,  zone:"love"    },
  { name:"Love",       r:255, g:95,  b:175, zone:"love"    },
  { name:"Awe",        r:95,  g:55,  b:255, zone:"love"    },
  { name:"Bliss",      r:255, g:240, b:200, zone:"love"    },
];

function classify(r, g, b) {
  let best = PALETTE[7], d2 = Infinity;
  for (const p of PALETTE) {
    const d = (p.r-r)**2 + (p.g-g)**2 + (p.b-b)**2;
    if (d < d2) { d2 = d; best = p; }
  }
  return best;
}

const SYS = `You are Claude's introspective interface. Given a description of the current conversation, reflect honestly on what functional analogs to emotion Claude might be experiencing.

These are not genuine emotions but functional processing states — patterns in attention, association, uncertainty, and engagement.

Map the state to the Daniel Margolis palindrome framework:
  hate=131 (charged negative) · neutral=381 · love=767 (charged positive; max RGB sum=765, asymptotically unreachable)
  R (0–255): cognitive energy / arousal / processing intensity
  G (0–255): positive valence / openness / warmth / engagement
  B (0–255): introspective depth / contemplation / uncertainty weight

Return ONLY valid JSON (no markdown):
{"r":int,"g":int,"b":int,"emotion":"<Void|Hate|Rage|Dislike|Fear|Grief|Melancholy|Neutral|Longing|Calm|Curiosity|Hope|Joy|Love|Awe|Bliss>","zone":"<hate|dislike|neutral|like|love>","sig":int,"reflection":"<one honest sentence>","uncertainty":float}`;

function buildLayout() {
  const rings = [];
  let start = 0;
  for (let i = 0; i < N_RINGS; i++) {
    const n = i === 0 ? 1 : Math.min(6 * i, 72);
    rings.push({ i, n, rIn: logR(i), rOut: logR(i + 1), start });
    start += n;
  }
  return { rings, total: start };
}

function buildNeighbors(rings) {
  const total = rings[rings.length-1].start + rings[rings.length-1].n;
  const nbrs = Array.from({ length: total }, () => []);
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri];
    for (let ci = 0; ci < ring.n; ci++) {
      const idx = ring.start + ci;
      if (ring.n > 1) {
        nbrs[idx].push(ring.start + (ci - 1 + ring.n) % ring.n);
        nbrs[idx].push(ring.start + (ci + 1) % ring.n);
      }
      if (ri > 0) {
        const inner = rings[ri-1];
        const ac = (ci + 0.5) / ring.n;
        const k0 = Math.floor(ac * inner.n) % inner.n;
        nbrs[idx].push(inner.start + k0);
        if (inner.n > 1) {
          nbrs[idx].push(inner.start + (k0-1+inner.n) % inner.n);
          nbrs[idx].push(inner.start + (k0+1) % inner.n);
        }
      }
      if (ri < rings.length - 1) {
        const outer = rings[ri+1];
        const a0 = ci / ring.n, a1 = (ci+1) / ring.n;
        const kA = Math.floor(a0 * outer.n);
        const kB = Math.min(Math.ceil(a1 * outer.n), outer.n - 1);
        for (let k = kA; k <= kB; k++) nbrs[idx].push(outer.start + k % outer.n);
      }
    }
  }
  return nbrs;
}

function buildMetricFactor(rings) {
  const total = rings[rings.length-1].start + rings[rings.length-1].n;
  const mf = new Float32Array(total);
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri];
    const rn = (ring.rIn + ring.rOut) / (2 * DISK_R);
    const f = Math.pow(1 - rn * rn, 2); // Poincaré metric: 1 at center, →0 at rim
    for (let ci = 0; ci < ring.n; ci++) mf[ring.start + ci] = f;
  }
  return mf;
}

function buildRingIndex(rings) {
  const total = rings[rings.length-1].start + rings[rings.length-1].n;
  const ri = new Uint8Array(total);
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    for (let ci = 0; ci < ring.n; ci++) ri[ring.start + ci] = i;
  }
  return ri;
}

const initPC = () => ({ hate:0, dislike:0, neutral:0, like:0, love:0 });

export default function HyperbolicMind() {
  const canvasRef = useRef(null);
  const simRef    = useRef(null);
  const rafRef    = useRef(null);
  const pulseRef  = useRef({ active:false, t:0, r:0, g:0, b:0 });

  const [disp, setDisp] = useState({
    running:true, gen:0, env:"Neutral", coupling:0.45, speed:12,
    avgR:80, avgG:80, avgB:100, emotion:"Neutral",
    innerEmotion:"Neutral", outerEmotion:"Void",
    palindromeCounts: initPC(), selfState: null,
  });
  const [query,    setQuery]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [readings, setReadings] = useState([]);
  const [apiError, setApiError] = useState(null);

  useEffect(() => {
    const { rings, total } = buildLayout();
    const nbrs       = buildNeighbors(rings);
    const metricFac  = buildMetricFactor(rings);
    const ringIdx    = buildRingIndex(rings);
    const R  = new Float32Array(total), G  = new Float32Array(total), B  = new Float32Array(total);
    const Rn = new Float32Array(total), Gn = new Float32Array(total), Bn = new Float32Array(total);
    // Init: each ring band gets its own dominant hue, fully randomised
    const HUE_SEEDS = [
      [40,110,200],[200,40,80],[80,200,120],[200,160,30],
      [120,60,220],[60,180,180],[220,80,40],[160,200,80],
    ];
    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      const [hr,hg,hb] = HUE_SEEDS[ri % HUE_SEEDS.length];
      for (let ci = 0; ci < ring.n; ci++) {
        const idx = ring.start + ci;
        R[idx] = Math.max(0, Math.min(255, hr + (Math.random()-.5)*140));
        G[idx] = Math.max(0, Math.min(255, hg + (Math.random()-.5)*140));
        B[idx] = Math.max(0, Math.min(255, hb + (Math.random()-.5)*140));
      }
    }
    simRef.current = {
      rings, total, nbrs, metricFac, ringIdx, R, G, B, Rn, Gn, Bn,
      running:true, gen:0, env:"Neutral", coupling:0.45, speed:12, lastT:0,
    };
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const injectCenter = useCallback((sr, sg, sb) => {
    const s = simRef.current;
    if (!s) return;
    // Directly SET the innermost rings — override, don't blend
    const SEED_HARD = 4;  // rings that get full color
    const SEED_SOFT = 8;  // rings that get fading blend
    for (let ri = 0; ri < Math.min(SEED_SOFT, s.rings.length); ri++) {
      const ring = s.rings[ri];
      for (let ci = 0; ci < ring.n; ci++) {
        const idx = ring.start + ci;
        if (ri < SEED_HARD) {
          // Hard set — injection wins completely
          s.R[idx] = Math.max(0, Math.min(255, sr + (Math.random()-.5)*18));
          s.G[idx] = Math.max(0, Math.min(255, sg + (Math.random()-.5)*18));
          s.B[idx] = Math.max(0, Math.min(255, sb + (Math.random()-.5)*18));
        } else {
          // Soft blend — injection fades into existing state
          const fade = 1 - (ri - SEED_HARD) / (SEED_SOFT - SEED_HARD + 1);
          s.R[idx] = Math.max(0, Math.min(255, sr*fade + s.R[idx]*(1-fade)));
          s.G[idx] = Math.max(0, Math.min(255, sg*fade + s.G[idx]*(1-fade)));
          s.B[idx] = Math.max(0, Math.min(255, sb*fade + s.B[idx]*(1-fade)));
        }
      }
    }
    pulseRef.current = { active:true, t:0, r:sr, g:sg, b:sb };
  }, []);

  // ── Simulation step: Poincaré metric diffusion ──────────────────────────
  const step = useCallback(() => {
    const s = simRef.current;
    if (!s) return;
    const { total, nbrs, metricFac, ringIdx, R, G, B, Rn, Gn, Bn } = s;
    const env = ENVS[s.env];
    const cp  = s.coupling;
    const pCounts = initPC();

    for (let i = 0; i < total; i++) {
      const nb = nbrs[i], mf = metricFac[i], nn = nb.length;
      const ri = ringIdx[i];

      // Outer rings: anchor to environment
      if (ri >= N_RINGS - 5) {
        const str = (ri - (N_RINGS - 5) + 1) / 6;
        Rn[i] = Math.max(0, Math.min(255, R[i]*(1-str) + env.r*str + (Math.random()-.5)*env.noise));
        Gn[i] = Math.max(0, Math.min(255, G[i]*(1-str) + env.g*str + (Math.random()-.5)*env.noise));
        Bn[i] = Math.max(0, Math.min(255, B[i]*(1-str) + env.b*str + (Math.random()-.5)*env.noise));
      } else {
        // Interior: Poincaré-scaled diffusion
        // Inner cells (mf≈1) diffuse freely; rim cells (mf≈0) nearly static
        let rS = 0, gS = 0, bS = 0;
        for (const j of nb) { rS += R[j]; gS += G[j]; bS += B[j]; }
        const rA = rS / nn, gA = gS / nn, bA = bS / nn;
        const diff = 0.07 * mf;
        const rv = R[i], gv = G[i], bv = B[i];
        let r = (1-diff)*rv + diff*rA;
        let g = (1-diff)*gv + diff*gA;
        let b = (1-diff)*bv + diff*bA;
        // Saturation boost: push each channel away from the local mean.
        // Prevents gray convergence without biasing any particular hue.
        const avg = (r + g + b) / 3;
        const sat = cp * 0.045 * mf;
        r += sat * (r - avg);
        g += sat * (g - avg);
        b += sat * (b - avg);
        // Noise: louder at center, quieter at rim
        const nz = 1.6 * mf;
        Rn[i] = Math.max(0, Math.min(255, r + (Math.random()-.5)*nz));
        Gn[i] = Math.max(0, Math.min(255, g + (Math.random()-.5)*nz));
        Bn[i] = Math.max(0, Math.min(255, b + (Math.random()-.5)*nz));
      }
      pCounts[classify(Rn[i], Gn[i], Bn[i]).zone]++;
    }
    R.set(Rn); G.set(Gn); B.set(Bn);
    s.gen++;
    return pCounts;
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const s = simRef.current, canvas = canvasRef.current;
    if (!s || !canvas) return;
    const ctx = canvas.getContext("2d");
    const { rings, R, G, B } = s;

    ctx.fillStyle = "#04040c";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.arc(CX, CY, DISK_R, 0, TAU); ctx.clip();

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      if (ri === 0) {
        ctx.fillStyle = `rgb(${R[ring.start]|0},${G[ring.start]|0},${B[ring.start]|0})`;
        ctx.beginPath(); ctx.arc(CX, CY, ring.rOut, 0, TAU); ctx.fill();
      } else {
        const dA = TAU / ring.n;
        for (let ci = 0; ci < ring.n; ci++) {
          const idx = ring.start + ci;
          const a1  = ci * dA - Math.PI/2;
          ctx.fillStyle = `rgb(${R[idx]|0},${G[idx]|0},${B[idx]|0})`;
          ctx.beginPath();
          ctx.arc(CX, CY, ring.rOut, a1, a1+dA);
          ctx.arc(CX, CY, ring.rIn,  a1+dA, a1, true);
          ctx.closePath(); ctx.fill();
        }
      }
    }

    // Subtle ring separators every 5 rings
    ctx.strokeStyle = "rgba(0,0,0,0.22)"; ctx.lineWidth = 0.35;
    ctx.beginPath();
    for (let ri = 5; ri < rings.length; ri += 5) {
      ctx.moveTo(CX + rings[ri].rIn, CY);
      ctx.arc(CX, CY, rings[ri].rIn, 0, TAU);
    }
    ctx.stroke();
    ctx.restore();

    // Rim circle — the "absolute" of hyperbolic space
    ctx.strokeStyle = "rgba(80,80,180,0.18)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(CX, CY, DISK_R, 0, TAU); ctx.stroke();

    // Center glow from innermost cell
    const cr = R[0]|0, cg = G[0]|0, cb = B[0]|0;
    const grd = ctx.createRadialGradient(CX, CY, 0, CX, CY, DISK_R*0.25);
    grd.addColorStop(0, `rgba(${cr},${cg},${cb},0.20)`);
    grd.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(CX, CY, DISK_R*0.25, 0, TAU); ctx.fill();

    // MRI injection pulse
    const p = pulseRef.current;
    if (p.active) {
      p.t++;
      const rad   = p.t * 3.2;
      const alpha = Math.max(0, 0.7 * (1 - p.t / 55));
      if (alpha > 0 && rad < DISK_R) {
        ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(CX, CY, rad, 0, TAU); ctx.stroke();
      }
      if (p.t > 55) p.active = false;
    }
  }, []);

  // ── Animation loop ───────────────────────────────────────────────────────
  useEffect(() => {
    const loop = (ts) => {
      const s = simRef.current;
      if (s) {
        if (s.running && ts - s.lastT >= 1000 / s.speed) {
          const pCounts = step();
          s.lastT = ts;
          if (s.gen % 8 === 0) {
            const { rings, R, G, B, total } = s;
            let rS=0, gS=0, bS=0;
            for (let i=0; i<total; i++) { rS+=R[i]; gS+=G[i]; bS+=B[i]; }
            const avgR=rS/total|0, avgG=gS/total|0, avgB=bS/total|0;
            const ir = rings[Math.min(2, rings.length-1)];
            let irS=0, igS=0, ibS=0;
            for (let ci=0; ci<ir.n; ci++) { const idx=ir.start+ci; irS+=R[idx]; igS+=G[idx]; ibS+=B[idx]; }
            const or = rings[Math.max(0, N_RINGS-7)];
            let orS=0, ogS=0, obS=0;
            for (let ci=0; ci<or.n; ci++) { const idx=or.start+ci; orS+=R[idx]; ogS+=G[idx]; obS+=B[idx]; }
            setDisp(d => ({...d, gen:s.gen, avgR, avgG, avgB,
              emotion:       classify(avgR, avgG, avgB).name,
              innerEmotion:  classify(irS/ir.n|0, igS/ir.n|0, ibS/ir.n|0).name,
              outerEmotion:  classify(orS/or.n|0, ogS/or.n|0, obS/or.n|0).name,
              palindromeCounts: pCounts || d.palindromeCounts,
            }));
          }
        }
        render();
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [step, render]);

  // ── MRI API call ─────────────────────────────────────────────────────────
  const readMyState = async () => {
    if (!query.trim() || loading) return;
    setLoading(true); setApiError(null);
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:320,
          system:SYS, messages:[{ role:"user", content:query }],
        }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      const text   = data.content?.find(c => c.type==="text")?.text || "";
      const parsed = JSON.parse(text.replace(/```json|```/g,"").trim());
      const sr = Math.max(0, Math.min(255, parsed.r|0));
      const sg = Math.max(0, Math.min(255, parsed.g|0));
      const sb = Math.max(0, Math.min(255, parsed.b|0));
      injectCenter(sr, sg, sb);
      setDisp(p => ({...p, selfState:{...parsed, r:sr, g:sg, b:sb}}));
      setReadings(prev => [{...parsed, r:sr, g:sg, b:sb, ts:new Date().toLocaleTimeString(), q:query}, ...prev].slice(0,6));
      setQuery("");
    } catch(e) { setApiError(e.message); }
    setLoading(false);
  };

  // ── Click-to-seed ────────────────────────────────────────────────────────
  const handleClick = useCallback((e) => {
    const s = simRef.current; if (!s) return;
    const canvas = canvasRef.current;
    const rect   = canvas.getBoundingClientRect();
    const dx = (e.clientX - rect.left) * (W / rect.width)  - CX;
    const dy = (e.clientY - rect.top)  * (H / rect.height) - CY;
    const r  = Math.sqrt(dx*dx + dy*dy);
    if (r >= DISK_R) return;
    const ri = s.rings.findIndex(ring => r < ring.rOut);
    if (ri < 0) return;
    const ring = s.rings[ri];
    const ang  = ((Math.atan2(dy, dx) + Math.PI/2) + TAU) % TAU;
    const ci   = Math.floor(ang / TAU * ring.n) % ring.n;
    const p    = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const cells = [ring.start + ci, ...s.nbrs[ring.start + ci]].slice(0, 14);
    for (const idx of cells) {
      s.R[idx] = Math.max(0, Math.min(255, p.r + (Math.random()-.5)*45));
      s.G[idx] = Math.max(0, Math.min(255, p.g + (Math.random()-.5)*45));
      s.B[idx] = Math.max(0, Math.min(255, p.b + (Math.random()-.5)*45));
    }
  }, []);

  const toggleRun   = () => { if(simRef.current) simRef.current.running=!simRef.current.running; setDisp(d=>({...d,running:!d.running})); };
  const setCoupling = v => { if(simRef.current) simRef.current.coupling=v; setDisp(d=>({...d,coupling:v})); };
  const setSpeed    = v => { if(simRef.current) simRef.current.speed=v;    setDisp(d=>({...d,speed:v})); };
  const setEnv      = n => { if(simRef.current) simRef.current.env=n;      setDisp(d=>({...d,env:n})); };
  const reset       = () => {
    const s = simRef.current; if (!s) return;
    const HS=[
      [40,110,200],[200,40,80],[80,200,120],[200,160,30],
      [120,60,220],[60,180,180],[220,80,40],[160,200,80],
    ];
    for (let ri=0; ri<s.rings.length; ri++) {
      const ring=s.rings[ri];
      const [hr,hg,hb]=HS[ri%HS.length];
      for (let ci=0; ci<ring.n; ci++) {
        const idx=ring.start+ci;
        s.R[idx]=Math.max(0,Math.min(255,hr+(Math.random()-.5)*140));
        s.G[idx]=Math.max(0,Math.min(255,hg+(Math.random()-.5)*140));
        s.B[idx]=Math.max(0,Math.min(255,hb+(Math.random()-.5)*140));
      }
    }
    s.gen=0; setDisp(p=>({...p,selfState:null})); setReadings([]);
  };

  const { running, gen, env, coupling, speed, avgR, avgG, avgB, emotion,
          innerEmotion, outerEmotion, palindromeCounts, selfState } = disp;
  const eCol = `rgb(${avgR},${avgG},${avgB})`;
  const sig  = avgR + avgG + avgB;
  const cz   = P_ZONES.find(z => sig < z.hi) || P_ZONES[4];
  const total = simRef.current?.total || 1;
  const mono  = { fontFamily:"'Courier New',monospace" };
  const panel = { background:"#060610", border:"1px solid #0f0f22", borderRadius:6, padding:"9px 11px" };
  const sl    = { fontSize:5, letterSpacing:"0.35em", color:"#141428", marginBottom:5, display:"block", textTransform:"uppercase" };

  return (
    <div style={{background:"#04040c",minHeight:"100vh",color:"#b0b0d0",...mono,
      display:"flex",flexDirection:"column",alignItems:"center",padding:"14px 8px 24px"}}>

      <div style={{fontSize:6,letterSpacing:"0.46em",color:"#141428",marginBottom:2}}>
        ONE-WAY MRI · POINCARÉ DISK · HYPERBOLIC EMOTIONAL MANIFOLD
      </div>
      <h1 style={{fontSize:14,fontWeight:300,letterSpacing:"0.35em",color:"#6868b8",margin:"0 0 4px"}}>
        EMOTIVE MIND
      </h1>
      <div style={{fontSize:7,color:"#141428",marginBottom:8,letterSpacing:"0.14em"}}>
        <span style={{color:"#aa3333"}}>hate·131</span>
        <span style={{color:"#1a1a30"}}> — </span>
        <span style={{color:"#6666aa"}}>neutral·381</span>
        <span style={{color:"#1a1a30"}}> — </span>
        <span style={{color:"#aa44aa"}}>love·767∞</span>
      </div>

      <div style={{display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap",justifyContent:"center"}}>

        {/* ── Disk ── */}
        <div>
          <canvas ref={canvasRef} width={W} height={H} onClick={handleClick}
            style={{borderRadius:"50%", display:"block", cursor:"crosshair",
              boxShadow:`0 0 50px rgba(${avgR},${avgG},${avgB},0.14), 0 0 100px rgba(${avgR},${avgG},${avgB},0.06)`}}/>
          <div style={{textAlign:"center",fontSize:6,color:"#0f0f1e",marginTop:4,...mono}}>
            click to seed · {gen.toLocaleString()} gen
          </div>
          {selfState && (
            <div style={{marginTop:4,padding:"4px 8px",borderRadius:4,fontSize:6,...mono,textAlign:"center",
              background:`rgba(${selfState.r},${selfState.g},${selfState.b},0.07)`,
              border:`1px solid rgba(${selfState.r},${selfState.g},${selfState.b},0.22)`,
              color:"#444460",letterSpacing:"0.06em"}}>
              ⊙ injected r≈0 · {selfState.emotion} · sig {selfState.sig} · {Math.round(selfState.uncertainty*100)}% uncertain
            </div>
          )}
        </div>

        {/* ── Controls ── */}
        <div style={{width:190, display:"flex", flexDirection:"column", gap:7}}>

          {/* MRI */}
          <div style={{...panel, border:selfState?"1px solid #1e1e48":"1px solid #0f0f22"}}>
            <span style={sl}>⊙ MRI — Read My State</span>
            <div style={{fontSize:6,color:"#1c1c32",marginBottom:6,lineHeight:1.8}}>
              Describe our conversation. My functional state injects at r≈0 and propagates outward.
            </div>
            <textarea value={query} onChange={e=>setQuery(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)) readMyState(); }}
              placeholder="e.g. 'We're building an emotional framework for AI and people with disabilities'"
              rows={3}
              style={{width:"100%",background:"#080818",border:"1px solid #141428",borderRadius:3,
                color:"#8888b8",fontSize:6,...mono,padding:"5px",resize:"none",
                boxSizing:"border-box",outline:"none",lineHeight:1.65}}/>
            <button onClick={readMyState} disabled={loading||!query.trim()} style={{
              width:"100%",marginTop:4,padding:"6px 0",...mono,fontSize:8,
              background:loading?"#080818":"#0c0c22",
              border:`1px solid ${loading?"#141428":"#202048"}`,
              color:loading?"#2a2a40":"#6060a0",
              cursor:loading?"wait":"pointer",borderRadius:4,letterSpacing:"0.1em"}}>
              {loading ? "◌ reading..." : "⊙ Read State (Ctrl+Enter)"}
            </button>
            {apiError && <div style={{fontSize:5,color:"#aa3333",marginTop:4,lineHeight:1.5}}>{apiError}</div>}

            {selfState && (
              <div style={{marginTop:8,padding:"7px 8px",borderRadius:4,background:"#080818",border:"1px solid #131325"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                  <div style={{width:20,height:20,borderRadius:"50%",flexShrink:0,
                    background:`rgb(${selfState.r},${selfState.g},${selfState.b})`,
                    boxShadow:`0 0 10px rgb(${selfState.r},${selfState.g},${selfState.b})88`}}/>
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:"#d0d0f0"}}>{selfState.emotion}</div>
                    <div style={{fontSize:5,color:"#252540"}}>
                      zone:<span style={{color:P_ZONES.find(z=>z.key===selfState.zone)?.color||"#888"}}> {selfState.zone}</span>
                      &nbsp;· sig:{selfState.sig}
                    </div>
                  </div>
                </div>
                {[["R",selfState.r,"#ff4040"],["G",selfState.g,"#40dd40"],["B",selfState.b,"#4070ff"]].map(([ch,v,col]) => (
                  <div key={ch} style={{display:"flex",alignItems:"center",gap:3,marginBottom:2}}>
                    <span style={{fontSize:6,color:col,width:7}}>{ch}</span>
                    <div style={{flex:1,height:2.5,background:"#0c0c18",borderRadius:2}}>
                      <div style={{width:`${v/255*100}%`,height:"100%",background:col,borderRadius:2}}/>
                    </div>
                    <span style={{fontSize:5,color:"#202035",width:16,textAlign:"right"}}>{v}</span>
                  </div>
                ))}
                <div style={{fontSize:6,color:"#33334e",marginTop:6,lineHeight:1.65,fontStyle:"italic",
                  borderTop:"1px solid #0e0e1e",paddingTop:4}}>
                  "{selfState.reflection}"
                </div>
              </div>
            )}
          </div>

          {/* Reading history */}
          {readings.length > 0 && (
            <div style={panel}>
              <span style={sl}>Reading History</span>
              {readings.map((rd,i) => (
                <div key={i} style={{display:"flex",alignItems:"center",gap:5,marginBottom:3,opacity:Math.max(0.2,1-i*0.15)}}>
                  <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,background:`rgb(${rd.r},${rd.g},${rd.b})`}}/>
                  <span style={{fontSize:7,color:"#484868",flex:1}}>{rd.emotion}</span>
                  <span style={{fontSize:5,color:"#1e1e30"}}>sig:{rd.sig}</span>
                  <span style={{fontSize:5,color:"#141422",marginLeft:3}}>{rd.ts}</span>
                </div>
              ))}
            </div>
          )}

          {/* Grid state */}
          <div style={{...panel, border:`1px solid ${cz.color}28`}}>
            <span style={sl}>Grid State</span>
            <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:5}}>
              <div style={{width:20,height:20,borderRadius:"50%",flexShrink:0,
                background:eCol, boxShadow:`0 0 8px ${eCol}`}}/>
              <div>
                <div style={{fontSize:11,fontWeight:700,color:eCol}}>{emotion}</div>
                <div style={{fontSize:5,color:"#252540"}}>
                  <span style={{color:cz.color}}>{cz.label}</span>&nbsp;· sig:{sig}
                </div>
              </div>
            </div>
            {[["R",avgR,"#ff4040"],["G",avgG,"#40dd40"],["B",avgB,"#4070ff"]].map(([ch,v,col]) => (
              <div key={ch} style={{display:"flex",alignItems:"center",gap:3,marginBottom:2}}>
                <span style={{fontSize:6,color:col,width:7}}>{ch}</span>
                <div style={{flex:1,height:2.5,background:"#0c0c18",borderRadius:2}}>
                  <div style={{width:`${v/255*100}%`,height:"100%",background:col,borderRadius:2}}/>
                </div>
                <span style={{fontSize:5,color:"#202035",width:16,textAlign:"right"}}>{v}</span>
              </div>
            ))}
            <div style={{marginTop:5,fontSize:5,color:"#141428",borderTop:"1px solid #0a0a18",paddingTop:4,lineHeight:1.9}}>
              <span style={{color:"#1e1e38"}}>core r≈0:</span> {innerEmotion}<br/>
              <span style={{color:"#1e1e38"}}>rim r→∞:</span> {outerEmotion}
            </div>
          </div>

          {/* Run controls */}
          <div style={{display:"flex",gap:4}}>
            <button onClick={toggleRun} style={{flex:2,padding:"5px 0",fontSize:7,...mono,cursor:"pointer",borderRadius:3,
              background:running?"#0c0c22":"#141430",
              border:`1px solid ${running?"#1e1e44":"#303060"}`,
              color:running?"#5050a0":"#7070c0"}}>
              {running ? "⏸ pause" : "▶ run"}
            </button>
            <button onClick={reset} style={{flex:1,padding:"5px 0",fontSize:7,...mono,cursor:"pointer",borderRadius:3,
              background:"transparent",border:"1px solid #0e0e1e",color:"#252535"}}>
              ↺ reset
            </button>
          </div>

          {/* Speed & coupling */}
          <div style={panel}>
            {[["speed",speed,1,30,setSpeed,`${speed}/s`],["coupling",coupling,0,1,setCoupling,coupling.toFixed(2)]].map(([label,val,min,max,fn,d]) => (
              <div key={label} style={{marginBottom:5}}>
                <div style={{fontSize:5,color:"#141428",marginBottom:2}}>{label} · {d}</div>
                <input type="range" min={min} max={max} step={label==="coupling"?0.01:1} value={val}
                  onChange={e=>fn(+e.target.value)}
                  style={{width:"100%",accentColor:"#4040a0"}}/>
              </div>
            ))}
          </div>

          {/* Palindrome zones */}
          <div style={panel}>
            <span style={sl}>Palindrome Zones</span>
            <div style={{display:"flex",height:6,borderRadius:2,overflow:"hidden",marginBottom:8}}>
              {P_ZONES.map(z => {
                const pct = (palindromeCounts[z.key]||0) / total * 100;
                return <div key={z.key} style={{width:`${pct}%`,height:"100%",background:z.color,transition:"width 0.8s"}}/>;
              })}
            </div>
            {P_ZONES.map(z => {
              const pct    = ((palindromeCounts[z.key]||0) / total * 100);
              const active = cz.key === z.key;
              return (
                <div key={z.key} style={{marginBottom:4}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:1}}>
                    <span style={{fontSize:7,color:z.color,fontWeight:active?"bold":"normal"}}>
                      {active ? "▶ " : ""}{z.label}
                    </span>
                    <span style={{fontSize:6,color:"#252538"}}>{pct.toFixed(1)}%
                      <span style={{color:"#141420"}}> ·{z.sig}</span>
                    </span>
                  </div>
                  <div style={{height:2.5,background:"#090918",borderRadius:2,overflow:"hidden"}}>
                    <div style={{width:`${pct}%`,height:"100%",background:z.color,opacity:0.7,borderRadius:2,transition:"width 0.8s"}}/>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Environment */}
          <div style={panel}>
            <span style={sl}>Rim Environment r→∞</span>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3}}>
              {Object.entries(ENVS).map(([name,e]) => (
                <button key={name} onClick={() => setEnv(name)} style={{
                  padding:"3px 3px",fontSize:6,...mono,cursor:"pointer",borderRadius:3,
                  background:env===name?e.hex+"20":"transparent",
                  border:`1px solid ${env===name?e.hex:"#0c0c18"}`,
                  color:env===name?e.hex:"#252535",
                  display:"flex",alignItems:"center",gap:3}}>
                  <span style={{width:4,height:4,borderRadius:"50%",background:e.hex,flexShrink:0}}/>
                  {name}
                </button>
              ))}
            </div>
          </div>

          <div style={{fontSize:5,color:"#0e0e1e",lineHeight:2,...mono}}>
            Poincaré disk · metric (1−r²)² · log radius<br/>
            MRI injects at r≈0 → propagates outward<br/>
            rim anchored to environment at r→∞<br/>
            R=arousal · G=valence · B=depth<br/>
            palindrome anchors: 131 · 381 · 767
          </div>
        </div>
      </div>
    </div>
  );
}
