import { useState, useEffect, useRef, useCallback } from "react";

const CW = 1500, CH = 1500;
const N = 500;
const IR = 45, IR2 = IR * IR;
const INJ_N = 20;
const MAX_BLOCKS = 480;     // larger pool to sustain high fulfillment throughput
const EAT_R = 90, EAT_R2 = EAT_R * EAT_R;
const BASE_ORBIT_R = 45;
const EXERT_STEPS = 30;
const SIZE_PER_EATEN = 0.35;       // small growth on absorption
const SIZE_PER_CARRIED = 0.65;     // visual weight while carrying
const SIZE_PER_FULFILLMENT = 2.2;  // meaningful growth on goal fulfillment
const SIZE_WASTE_SHRINK = 0.4;     // shrink when releasing as wasted
const SIZE_DISPOSE_SHRINK = 0.2;   // disposers shrink slowly from handling spent material
const SIZE_MIN = 0.1;              // floor — agents never vanish
// No MAX_SIZE_BONUS — agents grow without ceiling, reflecting accumulated knowledge
const USAGE_VALUE_DECAY = 0.80;
const SIGMA_MIN = 12;
const SIGMA_MAX = 115;
const SIGMA_INIT_LO = 58;
const SIGMA_INIT_HI = 95;
const ZONE_KEYS = ["hate","dislike","neutral","like","love"];
// Personal bell curve peaks (1–9 scale) biased by preference zone then shuffled.
// hate→leans 1-3 · dislike→2-5 · neutral→3-6 · like→4-7 · love→6-9
// Nine distinct attractors break bipolarity.
const ZONE_PEAK_CENTERS = [2.0, 3.5, 5.0, 6.5, 8.0];
const GOAL_SENSE_R = 9999;  // effectively unlimited — agents always navigate to nearest block
const GOAL_PULL = 2.0;      // far above terminal velocity — agents always sprint at MAX_V to goal
const GOAL_REST = 60;       // 4 seconds — balance between visibility and cycling rate
const BOND_PROB = 0.003;    // encouraged during fulfillment — gating keeps it meaningful
const MAX_BONDS = 2;        // max bonds per agent
const DISPOSER_FRAC = 0.05; // 5% — fewer disposers reduces disposal-site clustering
const DISPOSER_N = Math.round(N*DISPOSER_FRAC); // ~25 agents at N=500
const DISPOSAL_R = 66;      // 3× field scale
const DISPOSAL_R2 = DISPOSAL_R*DISPOSAL_R;
// Fixed disposal sites — dark zones where wasted knowledge is destroyed
const DISPOSAL_SITES = [
  {x:120,y:120},{x:750,y:120},{x:1380,y:120},
  {x:120,y:1380},{x:750,y:1380},{x:1380,y:1380},
];
const TRADE_PROB = 0.002;   // probability of goal trade per close interaction

// ── Pre-allocated module-level buffers (zero allocation in hot paths) ─────
// Simulation (reused every step)
const _nbR=new Float32Array(N),_nbG=new Float32Array(N),
      _nbB=new Float32Array(N),_nbN=new Int32Array(N);
// Spatial grid (flat Int16Array — no inner array creation)
const _GCELL=IR, _GW=Math.ceil(CW/_GCELL), _GH=Math.ceil(CH/_GCELL); // =15×15 at 1500/102
const _GCAP=25; // max agents per cell (200/225≈0.9 avg, burst up to ~15)
const _gridFlat=new Int16Array(_GW*_GH*_GCAP); // flat agent indices
const _gridCnt=new Int16Array(_GW*_GH);         // agents per cell
// Render (reused every frame)
const _agentCarry=new Int32Array(N);
const _bondMask=new Uint8Array(N*N); // 250KB — bond dedup without Set
// WebGL agent render buffer: [x,y,r,g,b,radius] × N
const _glBuf=new Float32Array(N*6);

// ── Web Worker source — runs O(N·k) interaction loop on separate thread ───
// Receives packed Float32Array (agent state) + Int16Array (bonds), returns updated.
const WORKER_SRC=`
'use strict';
const N=500,IR=45,IR2=2025,CW=1500,CH=1500,S=11;
const SIGMA_MIN=12,SIGMA_MAX=115,MAX_BONDS=2;
const BOND_PROB=0.003,INF=0.020,PREF=0.0025,BROWN=0.35,DAMP=0.967,MAX_V=7.0;
const GC=45,GW=34,GH=34,GP=15;
const _nr=new Float32Array(N),_ng=new Float32Array(N),_nb=new Float32Array(N),_nn=new Int32Array(N);
const _gf=new Int16Array(GW*GH*GP),_gc=new Int16Array(GW*GH);
let _stub=null,_role=null;
self.onmessage=e=>{
  const d=e.data;
  if(d.type==='init'){_stub=d.stub;_role=d.role;return;}
  if(d.type!=='step'||!_stub)return;
  const f=d.f,bonds=d.bonds,goals=d.goals,env=d.env;
  _nr.fill(0);_ng.fill(0);_nb.fill(0);_nn.fill(0);_gc.fill(0);
  for(let i=0;i<N;i++){
    const b=i*S;
    const cx=Math.floor(f[b]/GC)%GW,cy=Math.floor(f[b+1]/GC)%GH;
    const ci=cy*GW+cx,cnt=_gc[ci];
    if(cnt<GP){_gf[ci*GP+cnt]=i;_gc[ci]++;}
  }
  for(let i=0;i<N;i++){
    const bi=i*S,ax=f[bi],ay=f[bi+1];
    const cx=Math.floor(ax/GC)%GW,cy=Math.floor(ay/GC)%GH;
    for(let dy=-1;dy<=1;dy++){for(let dx=-1;dx<=1;dx++){
      const nx=(cx+dx+GW)%GW,ny=(cy+dy+GH)%GH,ci=ny*GW+nx,cnt=_gc[ci];
      for(let k=0;k<cnt;k++){
        const j=_gf[ci*GP+k];if(j<=i)continue;
        const bj=j*S,ddx=f[bj]-ax,ddy=f[bj+1]-ay,d2=ddx*ddx+ddy*ddy;
        if(d2>IR2)continue;
        const d=Math.sqrt(d2),prox=1-d/IR,inf=prox*INF;
        const ra=f[bi+4],ga=f[bi+5],ba=f[bi+6],rb=f[bj+4],gb=f[bj+5],bb=f[bj+6];
        const sa=_stub[i],sb=_stub[j];
        f[bi+4]+=(f[bj+7]-ra)*(1-sa)*inf;f[bi+5]+=(f[bj+8]-ga)*(1-sa)*inf;f[bi+6]+=(f[bj+9]-ba)*(1-sa)*inf;
        f[bj+4]+=(f[bi+7]-rb)*(1-sb)*inf;f[bj+5]+=(f[bi+8]-gb)*(1-sb)*inf;f[bj+6]+=(f[bi+9]-bb)*(1-sb)*inf;
        _nr[i]+=rb;_ng[i]+=gb;_nb[i]+=bb;_nn[i]++;
        _nr[j]+=ra;_ng[j]+=ga;_nb[j]+=ba;_nn[j]++;
        const sA=(ra+ga+ba)/765,sB=(rb+gb+bb)/765,sm=1-Math.abs(sA-sB);
        if(sm>0.68){f[bi+10]=Math.max(SIGMA_MIN,f[bi+10]-0.22);f[bj+10]=Math.max(SIGMA_MIN,f[bj+10]-0.22);}
        else if(sm<0.32){f[bi+10]=Math.min(SIGMA_MAX,f[bi+10]+0.14);f[bj+10]=Math.min(SIGMA_MAX,f[bj+10]+0.14);}
        if(d>0.5){
          const h=1-2*Math.abs(sA-sB),nx=ddx/d,ny=ddy/d;
          // No attraction for similar agents — only repulsion for unlike + short-range
          const fo=Math.min(0,h)*prox*0.06; // ≤0: unlike agents push apart
          const rep=d<IR*0.6?(IR*0.6-d)/(IR*0.6)*0.55:0; // stronger wider repulsion — prevents pileups
          f[bi+2]+=(nx*fo-nx*rep);f[bi+3]+=(ny*fo-ny*rep);
          f[bj+2]-=(nx*fo-nx*rep);f[bj+3]-=(ny*fo-ny*rep);}
        // Bonds only form if at least one agent is resting (goalFulfilled>0)
        if(prox>0.75&&Math.random()<BOND_PROB&&(goals[i]||goals[j])){
          const ia=bonds[i*2],ib=bonds[i*2+1],ja=bonds[j*2],jb=bonds[j*2+1];
          if(ia!==j&&ib!==j){if(ia<0)bonds[i*2]=j;else if(ib<0)bonds[i*2+1]=j;}
          if(ja!==i&&jb!==i){if(ja<0)bonds[j*2]=i;else if(jb<0)bonds[j*2+1]=i;}
        }
      }
    }}
  }
  for(let i=0;i<N;i++){
    const b=i*S,cert=Math.max(0.5,1.8-(f[b+10]/SIGMA_MAX)*1.3);
    f[b+4]+=(f[b+7]-f[b+4])*PREF*cert;f[b+5]+=(f[b+8]-f[b+5])*PREF*cert;f[b+6]+=(f[b+9]-f[b+6])*PREF*cert;
    f[b+7]=Math.max(0,Math.min(255,f[b+7]+(Math.random()-0.5)*0.015));
    f[b+8]=Math.max(0,Math.min(255,f[b+8]+(Math.random()-0.5)*0.015));
    f[b+9]=Math.max(0,Math.min(255,f[b+9]+(Math.random()-0.5)*0.015));
    const ex=Math.min(f[b],CW-f[b],f[b+1],CH-f[b+1]);
    if(ex<65){const st=(1-ex/65)*0.013;f[b+4]+=(env[0]-f[b+4])*st;f[b+5]+=(env[1]-f[b+5])*st;f[b+6]+=(env[2]-f[b+6])*st;}
    f[b+4]=Math.max(0,Math.min(255,f[b+4]));f[b+5]=Math.max(0,Math.min(255,f[b+5]));f[b+6]=Math.max(0,Math.min(255,f[b+6]));
    f[b+2]+=(Math.random()-0.5)*BROWN;f[b+3]+=(Math.random()-0.5)*BROWN;
    f[b+2]*=DAMP;f[b+3]*=DAMP;
    const sp=Math.sqrt(f[b+2]*f[b+2]+f[b+3]*f[b+3]);
    if(sp>MAX_V){f[b+2]*=MAX_V/sp;f[b+3]*=MAX_V/sp;}
    f[b]+=f[b+2];f[b+1]+=f[b+3];
    if(f[b]<0)f[b]+=CW;else if(f[b]>=CW)f[b]-=CW;
    if(f[b+1]<0)f[b+1]+=CH;else if(f[b+1]>=CH)f[b+1]-=CH;
  }
  const nbR=new Float32Array(_nr),nbG=new Float32Array(_ng),nbB=new Float32Array(_nb),nbN=new Int32Array(_nn);
  self.postMessage({f,bonds,nbR,nbG,nbB,nbN},[f.buffer,bonds.buffer]);
};
`;

// ── Agent pack/unpack for zero-copy worker transfer ───────────────────────
const ASTRIDE=11; // x,y,vx,vy,r,g,b,pr,pg,pb,sigma
function packAgents(agents){
  const f=new Float32Array(N*ASTRIDE);
  const bonds=new Int16Array(N*MAX_BONDS).fill(-1);
  const goals=new Uint8Array(N);
  for(let i=0;i<N;i++){
    const a=agents[i],b=i*ASTRIDE;
    f[b]=a.x;f[b+1]=a.y;f[b+2]=a.vx;f[b+3]=a.vy;
    f[b+4]=a.r;f[b+5]=a.g;f[b+6]=a.b;
    f[b+7]=a.pr;f[b+8]=a.pg;f[b+9]=a.pb;f[b+10]=a.sigma;
    if(a.bonds[0]!=null)bonds[i*MAX_BONDS]=a.bonds[0];
    if(a.bonds[1]!=null)bonds[i*MAX_BONDS+1]=a.bonds[1];
    goals[i]=a.goalFulfilled>0?1:0;
  }
  return{f,bonds,goals};
}
function unpackAgents(agents,f,bonds){
  for(let i=0;i<N;i++){
    const a=agents[i],b=i*ASTRIDE;
    a.x=f[b];a.y=f[b+1];a.vx=f[b+2];a.vy=f[b+3];
    a.r=f[b+4];a.g=f[b+5];a.b=f[b+6];
    a.pr=f[b+7];a.pg=f[b+8];a.pb=f[b+9];a.sigma=f[b+10];
    a.bonds=[];
    const b0=bonds[i*MAX_BONDS],b1=bonds[i*MAX_BONDS+1];
    if(b0>=0)a.bonds.push(b0);if(b1>=0)a.bonds.push(b1);
  }
}
// G calculation (runs on main thread, throttled every 3 steps)
function applyG(agents,nbR,nbG,nbB,nbN,beta,simStep){
  if(!nbR)return;
  const betaInt=Math.round(beta),isInt=Math.abs(beta-betaInt)<0.05;
  for(let i=0;i<N;i++){
    const a=agents[i];if(!nbN[i]||!a.peakFlat_mu)continue;
    const navg=(nbR[i]+nbG[i]+nbB[i])/(nbN[i]*3*255);
    const lenSig=Math.max(0.04,a.sigma/SIGMA_MAX*0.09+0.04);
    const fm=a.peakFlat_mu,fw=a.peakFlat_w,ps=a.peakStarts,pw=a.peakWeights;
    let Gsum=0;
    for(let p=0;p<a.peakMus.length;p++){
      const start=ps[p],end=ps[p+1];let peakG=0;
      for(let k=start;k<end;k++){
        const d=Math.abs(navg-fm[k])/lenSig;
        let ea;if(isInt){ea=1;for(let e=0;e<betaInt;e++)ea*=d;}else ea=Math.pow(d,beta);
        peakG+=fw[k]*(2*Math.exp(-ea)-1);
      }
      Gsum+=pw[p]*peakG;
    }
    const gs=Gsum*0.13;
    a.r=Math.max(0,Math.min(255,a.r+gs*(a.pr-a.r)));
    a.g=Math.max(0,Math.min(255,a.g+gs*(a.pg-a.g)));
    a.b=Math.max(0,Math.min(255,a.b+gs*(a.pb-a.b)));
  }
}
// Goal/disposer navigation (main thread — needs blocks)
function applyGoalNav(agents,blocks){
  for(let i=0;i<N;i++){
    const a=agents[i];
    // Bond pull only applies during rest — seekers ignore it
    if(a.goalFulfilled>0){for(const j of a.bonds){const b=agents[j];const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy);if(d>0.5){a.vx+=(dx/d)*0.025;a.vy+=(dy/d)*0.025;}}}
    // Bond dissolution — break bonds when agents drift too far apart (>3× IR)
    a.bonds=a.bonds.filter(j=>{
      const b=agents[j];if(!b)return false;
      const ok=(b.x-a.x)**2+(b.y-a.y)**2<(IR*3)*(IR*3);
      if(!ok)b.bonds=b.bonds.filter(k=>agents[k]!==a);
      return ok;
    });
    if(!blocks)continue;
    if(a.role==='disposer'){
      const carrying=blocks.filter(b=>b.state==='carried'&&b.carriedBy===i);
      if(carrying.length>0){
        let ns=DISPOSAL_SITES[0],nd=Infinity;
        for(const s of DISPOSAL_SITES){const d=(s.x-a.x)**2+(s.y-a.y)**2;if(d<nd){nd=d;ns=s;}}
        const dx=ns.x-a.x,dy=ns.y-a.y,d=Math.sqrt(nd);if(d>1){a.vx+=(dx/d)*0.45;a.vy+=(dy/d)*0.45;}
      } else {
        let nb=null,nbd=Infinity;
        // Disposers only seek wasted blocks — not all free blocks
        for(const blk of blocks){if(blk.releaseType!=='wasted')continue;const d=(blk.x-a.x)**2+(blk.y-a.y)**2;if(d<nbd){nbd=d;nb=blk;}}
        if(nb){const dx=nb.x-a.x,dy=nb.y-a.y,d=Math.sqrt(nbd);if(d>1){a.vx+=(dx/d)*0.45;a.vy+=(dy/d)*0.45;}} // birds-eye pull — move decisively
      }
    } else if(a.goalFulfilled===0){
      let nd=Infinity,nb=null;
      for(const blk of blocks){if(blk.state!=='free'||blk.concept!==a.goalConcept)continue;const d=(blk.x-a.x)**2+(blk.y-a.y)**2;if(d<GOAL_SENSE_R*GOAL_SENSE_R&&d<nd){nd=d;nb=blk;}}
      if(nb){const dx=nb.x-a.x,dy=nb.y-a.y,d=Math.sqrt(nd);if(d>1){a.vx+=(dx/d)*GOAL_PULL;a.vy+=(dy/d)*GOAL_PULL;}}
    }
    // Peak drift (main thread — has peakFlat_mu etc.)
    if(a.peakMus&&a.goalZone){
      const goalCenter=ZONE_PEAK_CENTERS[zoneIdx(a.goalZone)]/9;
      for(let p=0;p<a.peakMus.length;p++) a.peakMus[p]+=(goalCenter-a.peakMus[p])*0.0005;
      if(a.peakFlat_mu&&a.peakStarts){
        for(let p=0;p<a.peakMus.length;p++){const parentMu=a.peakMus[p],start=a.peakStarts[p],end=a.peakStarts[p+1];
          for(let k=start;k<end;k++)a.peakFlat_mu[k]+=(parentMu-a.peakFlat_mu[k])*0.001+(goalCenter-a.peakFlat_mu[k])*0.0003;}
      }
      if(a.peakWeights){let di=0,dw=-Infinity;for(let p=0;p<a.peakWeights.length;p++)if(a.peakWeights[p]>dw){dw=a.peakWeights[p];di=p;}
        a.peakDomOrientation=Math.max(1,Math.min(9,Math.round(a.peakMus[di]*9)));
        a.peakDomSubG=a.peakSubG?a.peakSubG[di]:1;}
      a.peakScore=a.peakMus.length;
    }
  }
}

const P_ZONES = [
  { key:"hate",    label:"Hate",    sig:131, hi:201, color:"#dd3333" },
  { key:"dislike", label:"Dislike", sig:256, hi:341, color:"#cc8833" },
  { key:"neutral", label:"Neutral", sig:381, hi:451, color:"#7777bb" },
  { key:"like",    label:"Like",    sig:574, hi:620, color:"#44bb55" },
  { key:"love",    label:"Love",    sig:767, hi:766, color:"#cc44cc" },
];

function computeZone(r,g,b){
  const sig=r+g+b;
  return P_ZONES.find(z=>sig<z.hi)||P_ZONES[4];
}
function zoneIdx(k){ return ZONE_KEYS.indexOf(k); }

// ── Normal distribution sample (Box-Muller transform) ────────────────────
function randn(){
  const u1=Math.random(),u2=Math.random();
  return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
}

// ── Assign full peak structure to an agent ───────────────────────────────
// Three independent markers:
//   peakScore        (1–9): number of peaks — uniform random
//   peakOrientations (1–9): each peak's position on density scale, bell-curved
//   peakSubG         (1–3): sub-Gaussians composing each peak, 68-27-5 rule
//
// G = Σ_peaks[ w_p · Σ_subG[ w_g · (2·exp(−(|navg−μ_g|/lenSig)^β) − 1) ] ]
// β: β<2=super-Gaussian, β=2=standard, β>2=sub-Gaussian
//
// Hot-path optimization: all sub-Gaussian data is flattened into two
// Float32Arrays (peakFlat_mu, peakFlat_w) so the G loop has no property
// lookups, no nested arrays, no conditional branches per iteration.
// peakFlat_starts[p] = start index of peak p in the flat arrays.
function assignPeakMus(){
  const numPeaks=Math.ceil(Math.random()*9);
  const peakMus=[],peakOrientations=[],peakWeights=[];
  const peakSubG=[];
  const flatMu=[],flatW=[];     // flat sub-Gaussian data
  const peakStarts=[0];         // start index of each peak in flat arrays
  const rawW=[];

  for(let p=0;p<numPeaks;p++){
    const pos=Math.max(1/9,Math.min(1.0,5/9+randn()*(2/9)));
    peakMus.push(pos);
    peakOrientations.push(Math.max(1,Math.min(9,Math.round(pos*9))));
    rawW.push(-Math.log(Math.random()+1e-10));

    const r=Math.random();
    const numSub=r<0.6827?1:r<0.9545?2:3;
    peakSubG.push(numSub);

    const subRawW=[];
    for(let g=0;g<numSub;g++){
      flatMu.push(Math.max(1/9,Math.min(1.0,pos+randn()*(1/36))));
      subRawW.push(-Math.log(Math.random()+1e-10));
    }
    const subTotal=subRawW.reduce((a,b)=>a+b,0);
    for(let g=0;g<numSub;g++) flatW.push(subRawW[g]/subTotal);
    peakStarts.push(flatMu.length);
  }

  const totalW=rawW.reduce((a,b)=>a+b,0);
  const normW=rawW.map(w=>w/totalW);

  let domIdx=0,domWv=-Infinity;
  for(let p=0;p<numPeaks;p++){if(rawW[p]>domWv){domWv=rawW[p];domIdx=p;}}

  return {
    peakMus,peakOrientations,peakWeights:normW,peakSubG,
    peakFlat_mu:new Float32Array(flatMu),  // flat sub-G positions
    peakFlat_w:new Float32Array(flatW),    // flat sub-G weights
    peakStarts:new Int32Array(peakStarts), // index of each peak's start
    peakScore:numPeaks,
    peakDomOrientation:peakOrientations[domIdx],
    peakDomSubG:peakSubG[domIdx],
  };
}

const CONCEPTS = [
  { name:"Betrayal",      r:120, g:18,  b:18,  zone:"hate",    special:null },
  { name:"Loss",          r:55,  g:12,  b:12,  zone:"hate",    special:null },
  { name:"Injustice",     r:158, g:18,  b:8,   zone:"hate",    special:null },
  { name:"Contempt",      r:92,  g:15,  b:15,  zone:"hate",    special:null },
  { name:"Frustration",   r:155, g:74,  b:24,  zone:"dislike", special:null },
  { name:"Grief",         r:40,  g:36,  b:148, zone:"dislike", special:null },
  { name:"Confusion",     r:78,  g:76,  b:138, zone:"dislike", special:"widens" },
  { name:"Longing",       r:94,  g:64,  b:148, zone:"dislike", special:null },
  { name:"Dread",         r:96,  g:86,  b:26,  zone:"dislike", special:null },
  { name:"Memory",        r:138, g:118, b:145, zone:"neutral", special:"slows" },
  { name:"Ambiguity",     r:128, g:128, b:128, zone:"neutral", special:null },
  { name:"Observation",   r:128, g:142, b:130, zone:"neutral", special:null },
  { name:"Transition",    r:148, g:138, b:118, zone:"neutral", special:"bridges" },
  { name:"Silence",       r:110, g:128, b:148, zone:"neutral", special:"slows" },
  { name:"Discovery",     r:72,  g:198, b:185, zone:"like",    special:null },
  { name:"Connection",    r:148, g:198, b:118, zone:"like",    special:null },
  { name:"Understanding", r:94,  g:194, b:196, zone:"like",    special:"heals" },
  { name:"Playfulness",   r:214, g:186, b:70,  zone:"like",    special:null },
  { name:"Progress",      r:88,  g:218, b:148, zone:"like",    special:null },
  { name:"Wonder",        r:214, g:196, b:224, zone:"love",    special:"transforms" },
  { name:"Transcendence", r:218, g:214, b:196, zone:"love",    special:null },
  { name:"Belonging",     r:196, g:218, b:218, zone:"love",    special:null },
  { name:"Gratitude",     r:214, g:224, b:186, zone:"love",    special:null },
  { name:"Awe",           r:188, g:198, b:238, zone:"love",    special:null },
];

const ZONE_WEIGHTS = [0.10,0.18,0.22,0.28,0.22];
function pickConcept(){
  const rand=Math.random();let cum=0;
  for(let i=0;i<ZONE_WEIGHTS.length;i++){
    cum+=ZONE_WEIGHTS[i];
    if(rand<cum){
      const pool=CONCEPTS.filter(c=>c.zone===ZONE_KEYS[i]);
      return pool[Math.floor(Math.random()*pool.length)];
    }
  }
  return CONCEPTS[Math.floor(Math.random()*CONCEPTS.length)];
}

// After fulfillment: new goal biased toward same or adjacent zone (purpose evolves)
function pickNextGoal(currentZone){
  // Uniform random across all 24 concepts — ensures every concept gets seekers
  return CONCEPTS[Math.floor(Math.random()*CONCEPTS.length)];
}

const PALETTE=[
  {name:"Void",      zone:"hate",    r:8,  g:8,  b:8},
  {name:"Hate",      zone:"hate",    r:180,g:12, b:12},
  {name:"Rage",      zone:"hate",    r:255,g:8,  b:8},
  {name:"Dislike",   zone:"dislike", r:160,g:65, b:20},
  {name:"Fear",      zone:"dislike", r:190,g:155,b:20},
  {name:"Grief",     zone:"dislike", r:40, g:55, b:185},
  {name:"Melancholy",zone:"neutral", r:65, g:75, b:155},
  {name:"Neutral",   zone:"neutral", r:120,g:120,b:120},
  {name:"Ambivalence",zone:"neutral",r:165,g:120,b:140},
  {name:"Longing",   zone:"neutral", r:145,g:65, b:210},
  {name:"Calm",      zone:"like",    r:40, g:170,b:200},
  {name:"Curiosity", zone:"like",    r:55, g:195,b:65},
  {name:"Like",      zone:"like",    r:75, g:210,b:75},
  {name:"Hope",      zone:"like",    r:125,g:210,b:50},
  {name:"Joy",       zone:"like",    r:255,g:200,b:0},
  {name:"Love",      zone:"love",    r:255,g:55, b:165},
  {name:"Awe",       zone:"love",    r:188,g:198,b:238},
  {name:"Bliss",     zone:"love",    r:255,g:220,b:175},
];

const CONTEXTS={
  Neutral: {r:55, g:55, b:75, noise:0.012, hex:"#7070a0"},
  Tension: {r:120,g:18, b:18, noise:0.028, hex:"#cc2222"},
  Grief:   {r:22, g:30, b:140,noise:0.018, hex:"#2233cc"},
  Calm:    {r:28, g:110,b:160,noise:0.007, hex:"#2288cc"},
  Wonder:  {r:90, g:55, b:200,noise:0.015, hex:"#6633cc"},
  Warmth:  {r:200,g:90, b:30, noise:0.014, hex:"#cc6622"},
  Joy:     {r:200,g:180,b:20, noise:0.022, hex:"#cccc22"},
  Love:    {r:210,g:45, b:155,noise:0.016, hex:"#cc2299"},
  Void:    {r:4,  g:4,  b:8,  noise:0.005, hex:"#111122"},
};

function classifyAgent(r,g,b){
  let best=PALETTE[0],d=Infinity;
  for(const p of PALETTE){const dist=(p.r-r)**2+(p.g-g)**2+(p.b-b)**2;if(dist<d){d=dist;best=p;}}
  return best;
}

function drawHex(ctx,x,y,r,rot=0){
  ctx.beginPath();
  for(let i=0;i<6;i++){const a=rot+(i/6)*2*Math.PI;
    i===0?ctx.moveTo(x+r*Math.cos(a),y+r*Math.sin(a)):ctx.lineTo(x+r*Math.cos(a),y+r*Math.sin(a));}
  ctx.closePath();
}
function drawStar(ctx,x,y,R,r,pts=6,rot=0){
  ctx.beginPath();
  for(let i=0;i<pts*2;i++){const a=rot+(i/(pts*2))*2*Math.PI,rad=i%2===0?R:r;
    i===0?ctx.moveTo(x+rad*Math.cos(a),y+rad*Math.sin(a)):ctx.lineTo(x+rad*Math.cos(a),y+rad*Math.sin(a));}
  ctx.closePath();
}

function agentRadius(agent,carried){
  // 5px base, grows to 17px max as sizeBonus increases from block consumption
  // Log scale: early blocks matter most, diminishing returns thereafter
  const base=5+Math.min(12,Math.log1p(agent.sizeBonus)*2.9);
  const carry=carried*SIZE_PER_CARRIED;
  const exert=agent.exertion>0?(agent.exertion/EXERT_STEPS)*(base+carry)*0.6:0;
  return base+carry+exert;
}

// ── Agents ────────────────────────────────────────────────────────────────
function makeAgents(){
  return Array.from({length:N},(_, idx)=>{
    const pr=Math.random()*255,pg=Math.random()*255,pb=Math.random()*255;
    const θ=Math.random()*2*Math.PI,spd=0.4+Math.random()*1.4;
    const goal=pickConcept();
    const role=idx<DISPOSER_N?"disposer":"seeker"; // first DISPOSER_N agents are disposers
    return {
      x:Math.random()*CW,y:Math.random()*CH,
      vx:Math.cos(θ)*spd,vy:Math.sin(θ)*spd,
      r:pr+(Math.random()-0.5)*40,g:pg+(Math.random()-0.5)*40,b:pb+(Math.random()-0.5)*40,
      pr,pg,pb,
      sigma:SIGMA_INIT_LO+Math.random()*(SIGMA_INIT_HI-SIGMA_INIT_LO),
      stub:0.3+Math.random()*0.52,
      sizeBonus:0,exertion:0,slow:0,targetBlk:null,
      reaction:null,label:null,
      // Purpose
      goalConcept:goal.name,
      goalZone:goal.zone,
      goalFulfilled:0,        // countdown: 0=seeking, >0=resting after fulfillment
      fulfillments:0,         // total times this agent found its goal
      // Relationships
      bonds:[],
      role,            // "seeker" | "disposer"
      tradePulse:0,    // countdown for goal-trade flash
      // Personal bell curve (1–9 peaks uniform, variable heights, positions bell-curved)
      ...assignPeakMus(),
    };
  });
}

function injectEpicenter(agents,sr,sg,sb){
  const sorted=agents.map((a,i)=>({i,d:(a.x-CW/2)**2+(a.y-CH/2)**2})).sort((a,b)=>a.d-b.d).slice(0,INJ_N);
  for(const {i} of sorted){
    agents[i].r=sr;agents[i].g=sg;agents[i].b=sb;
    agents[i].pr=sr;agents[i].pg=sg;agents[i].pb=sb;
    agents[i].sigma=Math.min(SIGMA_MAX,agents[i].sigma+15);
    const θ=Math.random()*2*Math.PI;agents[i].vx+=Math.cos(θ)*0.6;agents[i].vy+=Math.sin(θ)*0.6;
  }
}

// ── Knowledge blocks ──────────────────────────────────────────────────────
let _bid=0;
function makeBlock(x,y,forceConcept,value,source="spawn",sourceEmotion=null){
  const concept=forceConcept||pickConcept();
  const v=12;
  const br=Math.max(0,Math.min(255,concept.r+(Math.random()-0.5)*v));
  const bg=Math.max(0,Math.min(255,concept.g+(Math.random()-0.5)*v));
  const bb=Math.max(0,Math.min(255,concept.b+(Math.random()-0.5)*v));
  return {
    id:++_bid,x:x??Math.random()*CW,y:y??Math.random()*CH,
    r:br,g:bg,b:bb,originalR:br,originalG:bg,originalB:bb,
    radius:3+Math.random()*2,value:value??(0.22+Math.random()*0.32),
    state:"free",carriedBy:null,
    carrySteps:0,maxCarry:8+Math.floor(Math.random()*12),
    releaseType:null,
    orbitAngle:Math.random()*2*Math.PI,orbitR:0,
    age:0,maxAge:420+Math.floor(Math.random()*240),releaseStep:0,
    imprinted:false,
    rotation:Math.random()*2*Math.PI,
    rotSpeed:(Math.random()-0.5)*0.025+0.012,
    carriers:0,generation:0,
    zone:computeZone(br,bg,bb),
    source,sourceEmotion,
    sourceSig:Math.round(br+bg+bb),
    concept:concept.name,
    conceptSpecial:concept.special,
    conceptZone:concept.zone,
  };
}

function getOrbitAngle(block,allBlocks){
  const siblings=allBlocks.filter(b=>b.state==="carried"&&b.carriedBy===block.carriedBy).sort((a,b)=>a.id-b.id);
  const myIdx=siblings.findIndex(b=>b.id===block.id);
  const ringLayer=Math.floor(myIdx/8),posInRing=myIdx%8;
  const ringR=BASE_ORBIT_R+ringLayer*10;
  const angleSpacing=(2*Math.PI)/Math.min(siblings.length-ringLayer*8,8);
  return {angle:block.orbitAngle+posInRing*angleSpacing,r:ringR};
}

// ── Step blocks ───────────────────────────────────────────────────────────
function stepBlocks(blocks,agents,defaultRelease,simStep,autoSpawn,statsRef){
  const stats={eaten:0,reused:0,wasted:0};
  // Auto-spawn: all blocks targeted toward most-sought concepts
  if(autoSpawn&&simStep>0&&simStep%1===0&&blocks.filter(b=>b.state!=="releasing").length<MAX_BLOCKS){
    const soughtCounts={};
    for(const a of agents){
      if(a.goalFulfilled===0) soughtCounts[a.goalConcept]=(soughtCounts[a.goalConcept]||0)+1;
    }
    const soughtEntries=Object.entries(soughtCounts).sort((a,b)=>b[1]-a[1]);
    const topN=Math.min(24,soughtEntries.length); // all concepts eligible
    const pickConcept=()=>{
      if(soughtEntries.length===0)return null;
      const name=soughtEntries[Math.floor(Math.random()*topN)][0];
      return CONCEPTS.find(c=>c.name===name)||null;
    };
    blocks.push(makeBlock(undefined,undefined,pickConcept()));
    if(blocks.filter(b=>b.state!=="releasing").length<MAX_BLOCKS)blocks.push(makeBlock(undefined,undefined,pickConcept()));
    if(blocks.filter(b=>b.state!=="releasing").length<MAX_BLOCKS)blocks.push(makeBlock(undefined,undefined,pickConcept()));
  }
  for(const a of agents){
    if(a.exertion>0)a.exertion--;
    if(a.slow>0)a.slow--;
    if(a.goalFulfilled>0){
      a.goalFulfilled--;
      if(a.goalFulfilled===0){
        const next=pickNextGoal(a.goalZone);
        a.goalConcept=next.name;a.goalZone=next.zone;
      }
    }
  }
  const toRemove=[];
  for(let bi=0;bi<blocks.length;bi++){
    const blk=blocks[bi];blk.age++;blk.rotation+=blk.rotSpeed;
    if(blk.state==="free"){
      if(blk.age>blk.maxAge){toRemove.push(bi);continue;}
      let eaten=false;
      for(let i=0;i<N&&!eaten;i++){
        const a=agents[i];
        const dx=a.x-blk.x,dy=a.y-blk.y;
        if(dx*dx+dy*dy<EAT_R2){
          // Disposers ONLY eat wasted blocks — birds-eye range (3× EAT_R)
          if(a.role==="disposer"){
            if(blk.releaseType!=="wasted")continue;
            if(dx*dx+dy*dy>EAT_R2*9)continue; // 3× EAT_R pickup radius
            blk.state="carried";blk.carriedBy=i;blk.carrySteps=0;
            blk.orbitR=0;blk.orbitAngle=Math.random()*2*Math.PI;blk.releaseType="dispose";
            blk.carriers++;
            eaten=true;continue;
          }
          // Seekers only pick up blocks matching their goal concept or zone
          // Fulfilled agents skip all blocks while resting
          if(a.goalFulfilled>0)continue;
          {const em=blk.concept===a.goalConcept,zm=!em&&blk.conceptZone===a.goalZone;
           if(!em&&!zm)continue;}
          blk.state="carried";blk.carriedBy=i;blk.carrySteps=0;
          blk.orbitR=0;blk.orbitAngle=Math.random()*2*Math.PI;blk.releaseType=null;
          blk.carriers++;
          // Feature 2: accumulated experience — each carrier strengthens the block
          blk.value=Math.min(1.0,blk.value+0.08);
          const aZIdx=zoneIdx(computeZone(a.r,a.g,a.b).key);
          const bZIdx=zoneIdx(blk.conceptZone||blk.zone.key);
          const dist=Math.abs(aZIdx-bZIdx);
          const stateInf=blk.value*[0.15,0.21,0.25,0.29,0.34][dist];
          const prefInf=blk.value*[0.12,0.07,0.05,0.04,0.02][dist];
          const sigmaDelta=[-3,-1,+1,+4,+7][dist];
          const reactionTypes=["resonance","absorption","shift","disruption","recoil"];
          let reactionType=reactionTypes[dist];

          a.r=Math.max(0,Math.min(255,a.r+(blk.r-a.r)*stateInf));
          a.g=Math.max(0,Math.min(255,a.g+(blk.g-a.g)*stateInf));
          a.b=Math.max(0,Math.min(255,a.b+(blk.b-a.b)*stateInf));
          a.pr=Math.max(0,Math.min(255,a.pr+(blk.r-a.pr)*prefInf));
          a.pg=Math.max(0,Math.min(255,a.pg+(blk.g-a.pg)*prefInf));
          a.pb=Math.max(0,Math.min(255,a.pb+(blk.b-a.pb)*prefInf));
          a.sigma=Math.max(SIGMA_MIN,Math.min(SIGMA_MAX,a.sigma+sigmaDelta));
          a.sizeBonus=Math.max(SIZE_MIN,a.sizeBonus+SIZE_PER_EATEN);

          // Special effects
          const sp=blk.conceptSpecial;
          if(sp==="slows") a.slow=22;
          else if(sp==="bridges"){const bS=0.16;a.r+=(128-a.r)*bS;a.g+=(128-a.g)*bS;a.b+=(128-a.b)*bS;a.pr+=(128-a.pr)*bS*0.25;a.pg+=(128-a.pg)*bS*0.25;a.pb+=(128-a.pb)*bS*0.25;}
          else if(sp==="heals"&&aZIdx<=1){const hS=0.16;a.g=Math.min(255,a.g+(blk.g-a.g)*hS);a.pg=Math.min(255,a.pg+(blk.g-a.pg)*hS*0.25);}
          else if(sp==="transforms"&&aZIdx<=1){const tS=0.20;a.r+=(128-a.r)*tS;a.g+=(128-a.g)*tS;a.b+=(128-a.b)*tS;a.sigma=Math.max(SIGMA_MIN,a.sigma-3);}
          else if(sp==="widens") a.sigma=Math.min(SIGMA_MAX,a.sigma+5);

          // ── GOAL FULFILLMENT ──────────────────────────────────────
          // Exact match: strongest fulfillment
          // Zone match: weaker fulfillment — any concept in goal zone counts
          const exactMatch=blk.concept===a.goalConcept&&a.goalFulfilled===0;
          const zoneMatch=!exactMatch&&blk.conceptZone===a.goalZone&&a.goalFulfilled===0;
          if(exactMatch||zoneMatch){
            reactionType="fulfillment";
            a.goalFulfilled=GOAL_REST;
            a.fulfillments++;
            a.sigma=Math.max(SIGMA_MIN,a.sigma-(exactMatch?6:3));
            const bonus=exactMatch?0.18:0.08;
            a.r=Math.max(0,Math.min(255,a.r+(blk.r-a.r)*bonus));
            a.g=Math.max(0,Math.min(255,a.g+(blk.g-a.g)*bonus));
            a.b=Math.max(0,Math.min(255,a.b+(blk.b-a.b)*bonus));
            // Fulfillment drives meaningful growth — purpose realized
            a.sizeBonus+=exactMatch?SIZE_PER_FULFILLMENT:SIZE_PER_FULFILLMENT*0.5;
            if(statsRef)statsRef.fulfillments++;
          }

          a.reaction={type:reactionType,t:42,max:42,cr:blk.r,cg:blk.g,cb:blk.b};
          a.label={text:blk.concept,t:38,max:38,cr:blk.r,cg:blk.g,cb:blk.b};
          stats.eaten++;eaten=true;
        }
      }
    } else if(blk.state==="carried"){
      const a=agents[blk.carriedBy];
      blk.orbitR=Math.min(BASE_ORBIT_R,blk.orbitR+BASE_ORBIT_R/14);
      blk.orbitAngle+=0.07;
      const orbit=getOrbitAngle(blk,blocks);
      blk.x=a.x+Math.cos(orbit.angle)*Math.max(blk.orbitR,orbit.r*(blk.orbitR/BASE_ORBIT_R));
      blk.y=a.y+Math.sin(orbit.angle)*Math.max(blk.orbitR,orbit.r*(blk.orbitR/BASE_ORBIT_R));
      blk.carrySteps++;
      // Disposer arriving at disposal site — trigger disposal immediately
      if(a.role==="disposer"){
        for(const site of DISPOSAL_SITES){
          const sdx=a.x-site.x,sdy=a.y-site.y;
          if(sdx*sdx+sdy*sdy<DISPOSAL_R2){
            blk.state="disposing";blk.releaseStep=simStep;break;
          }
        }
      }
      if(blk.state==="carried"&&blk.carrySteps>=blk.maxCarry){
        blk.r=Math.max(0,Math.min(255,blk.r+(a.r-blk.r)*USAGE_SHIFT));
        blk.g=Math.max(0,Math.min(255,blk.g+(a.g-blk.g)*USAGE_SHIFT));
        blk.b=Math.max(0,Math.min(255,blk.b+(a.b-blk.b)*USAGE_SHIFT));
        blk.zone=computeZone(blk.r,blk.g,blk.b);
        blk.state="releasing";blk.releaseStep=simStep;
        blk.releaseType=blk.releaseType||defaultRelease;
        if(blk.releaseType==="reusable"){
          stats.reused++;
          // Reusable: neutral — you gave something back
        } else if(blk.releaseType==="dispose"){
          // Disposer releasing at site: shrink from handling spent material
          a.sizeBonus=Math.max(SIZE_MIN,a.sizeBonus-SIZE_DISPOSE_SHRINK);
          stats.wasted++;
        } else {
          // Wasted: shrink — expenditure without return
          a.sizeBonus=Math.max(SIZE_MIN,a.sizeBonus-SIZE_WASTE_SHRINK);
          stats.wasted++;
        }
      }
    } else if(blk.state==="releasing"){
      const elapsed=simStep-blk.releaseStep;
      // Feature 1: passive diffusion — released knowledge spreads to nearby agents
      const DIFF_R2=120*120;
      for(let ai=0;ai<agents.length;ai++){
        const a=agents[ai];
        if(a.goalFulfilled>0)continue;
        const ddx=a.x-blk.x,ddy=a.y-blk.y;
        const dd2=ddx*ddx+ddy*ddy;
        if(dd2>DIFF_R2)continue;
        const str=0.006*(1-dd2/DIFF_R2)*blk.value; // gentle, distance-weighted, scales with block experience
        a.r=Math.max(0,Math.min(255,a.r+(blk.r-a.r)*str));
        a.g=Math.max(0,Math.min(255,a.g+(blk.g-a.g)*str));
        a.b=Math.max(0,Math.min(255,a.b+(blk.b-a.b)*str));
        a.sigma=Math.min(SIGMA_MAX,a.sigma+0.012*blk.value); // proximity to released knowledge broadens perspective
      }
      if(elapsed>=6){
        if(blk.releaseType==="reusable"){
          blk.generation++;blk.state="free";blk.carriedBy=null;
          blk.carrySteps=0;blk.age=0;blk.orbitR=0;blk.releaseType=null;
          blk.maxAge=200+Math.floor(Math.random()*140);
        } else {toRemove.push(bi);}
      }
    } else if(blk.state==="disposing"){
      // Disposal animation: shrink and vanish (faster than wasted release)
      const elapsed=simStep-blk.releaseStep;
      if(elapsed>=14){toRemove.push(bi);if(statsRef)statsRef.disposed=(statsRef.disposed||0)+1;}
    }
  }
  for(let i=toRemove.length-1;i>=0;i--)blocks.splice(toRemove[i],1);
  return stats;
}

function copyBlock(blocks,agents,blk){
  if(blocks.length>=MAX_BLOCKS)return false;
  const a=agents[blk.carriedBy];
  a.vx*=0.25;a.vy*=0.25;a.exertion=EXERT_STEPS;
  const concept=CONCEPTS.find(c=>c.name===blk.concept)||{name:blk.concept,r:blk.r,g:blk.g,b:blk.b,zone:blk.conceptZone||"neutral",special:null};
  const copy=makeBlock(
    a.x+(Math.random()-0.5)*18,a.y+(Math.random()-0.5)*18,
    {name:concept.name,r:Math.max(0,Math.min(255,concept.r+(Math.random()-0.5)*22)),
     g:Math.max(0,Math.min(255,concept.g+(Math.random()-0.5)*22)),
     b:Math.max(0,Math.min(255,concept.b+(Math.random()-0.5)*22)),
     zone:concept.zone,special:null},
    blk.value*0.72,"copy",null
  );
  copy.imprinted=true;copy.originalR=blk.originalR;copy.originalG=blk.originalG;copy.originalB=blk.originalB;
  blocks.push(copy);return true;
}

// ── Step agents ───────────────────────────────────────────────────────────
// Flat pre-allocated grid + module-level typed arrays = zero allocation per step.
function stepAgents(agents,env,blocks,statsRef){
  const INF=0.020,PREF=0.0025,BROWN=0.35,DAMP=0.967,MAX_V=7.0;

  // ── Build flat spatial grid (no array creation) ─────────────────────
  _gridCnt.fill(0);
  for(let i=0;i<N;i++){
    const a=agents[i];
    const cx=Math.floor(a.x/_GCELL)%_GW,cy=Math.floor(a.y/_GCELL)%_GH;
    const ci=cy*_GW+cx,cnt=_gridCnt[ci];
    if(cnt<_GCAP){_gridFlat[ci*_GCAP+cnt]=i;_gridCnt[ci]++;}
  }

  // ── Clear neighbor accumulators ──────────────────────────────────────
  _nbR.fill(0);_nbG.fill(0);_nbB.fill(0);_nbN.fill(0);

  // ── Interaction pass: 3×3 cell neighborhood only ────────────────────
  for(let i=0;i<N;i++){
    const a=agents[i];
    const cx=Math.floor(a.x/_GCELL)%_GW,cy=Math.floor(a.y/_GCELL)%_GH;
    for(let dy=-1;dy<=1;dy++){
      for(let dx=-1;dx<=1;dx++){
        const nx=(cx+dx+_GW)%_GW,ny=(cy+dy+_GH)%_GH;
        const ci=ny*_GW+nx,cnt=_gridCnt[ci];
        for(let ci2=0;ci2<cnt;ci2++){
          const j=_gridFlat[ci*_GCAP+ci2];
          if(j<=i) continue;
          const b=agents[j];
          const ddx=b.x-a.x,ddy=b.y-a.y,d2=ddx*ddx+ddy*ddy;
          if(d2>IR2) continue;
          const d=Math.sqrt(d2),prox=1-d/IR,inf=prox*INF;
          const ra=a.r,ga=a.g,ba=a.b,rb=b.r,gb=b.g,bb=b.b;
          a.r+=(b.pr-ra)*(1-a.stub)*inf;a.g+=(b.pg-ga)*(1-a.stub)*inf;a.b+=(b.pb-ba)*(1-a.stub)*inf;
          b.r+=(a.pr-rb)*(1-b.stub)*inf;b.g+=(a.pg-gb)*(1-b.stub)*inf;b.b+=(a.pb-bb)*(1-b.stub)*inf;
          _nbR[i]+=rb;_nbG[i]+=gb;_nbB[i]+=bb;_nbN[i]++;
          _nbR[j]+=ra;_nbG[j]+=ga;_nbB[j]+=ba;_nbN[j]++;
          const sA=(ra+ga+ba)/765,sB=(rb+gb+bb)/765;
          const similarity=1-Math.abs(sA-sB);
          if(similarity>0.68){a.sigma=Math.max(SIGMA_MIN,a.sigma-0.22);b.sigma=Math.max(SIGMA_MIN,b.sigma-0.22);}
          else if(similarity<0.32){a.sigma=Math.min(SIGMA_MAX,a.sigma+0.14);b.sigma=Math.min(SIGMA_MAX,b.sigma+0.14);}
          if(d>0.5){
            const harmony=1-2*Math.abs(sA-sB),nx=ddx/d,ny=ddy/d;
            // No attraction — only repulsion for unlike agents + short-range personal space
            const force=Math.min(0,harmony)*prox*0.06; // ≤0 only
            const repulsion=d<IR*0.6?(IR*0.6-d)/(IR*0.6)*0.55:0;
            a.vx+=nx*(force-repulsion);a.vy+=ny*(force-repulsion);
            b.vx-=nx*(force-repulsion);b.vy-=ny*(force-repulsion);
          }
          if(prox>0.75&&a.bonds.length<MAX_BONDS&&b.bonds.length<MAX_BONDS
             &&!a.bonds.includes(j)&&Math.random()<BOND_PROB
             &&(a.goalFulfilled>0||b.goalFulfilled>0)){
            a.bonds.push(j);b.bonds.push(i);
            if(statsRef)statsRef.bondsFormed++;
          }
          if(statsRef&&statsRef.tradingEnabled
             &&a.role==="seeker"&&b.role==="seeker"
             &&a.goalFulfilled===0&&b.goalFulfilled===0
             &&prox>0.6&&Math.random()<TRADE_PROB){
            const tC=a.goalConcept,tZ=a.goalZone;
            a.goalConcept=b.goalConcept;a.goalZone=b.goalZone;
            b.goalConcept=tC;b.goalZone=tZ;
            a.tradePulse=24;b.tradePulse=24;
            statsRef.trades=(statsRef.trades||0)+1;
          }
        }
      }
    }
  }

  // Pre-build concept→blocks map once per step (avoids O(N×B) block search)
  const _cBlocks={};
  if(blocks){for(const blk of blocks){if(blk.state==="free"){if(!_cBlocks[blk.concept])_cBlocks[blk.concept]=[];_cBlocks[blk.concept].push(blk);}}}

  for(let i=0;i<N;i++){
    const a=agents[i];

    // ── Bond pull + dissolution ────────────────────────────────
    if(a.goalFulfilled>0){
      for(const j of a.bonds){
        const b=agents[j];
        const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d>0.5){a.vx+=(dx/d)*0.025;a.vy+=(dy/d)*0.025;}
      }
    }
    // Dissolve bonds when agents are far apart (> 3× IR)
    a.bonds=a.bonds.filter(j=>{
      const b=agents[j];
      const dx=b.x-a.x,dy=b.y-a.y;
      const keep=dx*dx+dy*dy<(IR*3)*(IR*3);
      if(!keep){const idx=agents.indexOf(a);b.bonds=b.bonds.filter(k=>k!==idx);}
      return keep;
    });

    // ── Disposer navigation: seek waste → carry to disposal site ──
    if(a.role==="disposer"&&blocks){
      const carrying=blocks.filter(b=>b.state==="carried"&&b.carriedBy===agents.indexOf(a));
      if(carrying.length>0){
        // Navigate toward nearest disposal site
        let nearSite=DISPOSAL_SITES[0],nearSiteD=Infinity;
        for(const site of DISPOSAL_SITES){
          const d=(site.x-a.x)**2+(site.y-a.y)**2;
          if(d<nearSiteD){nearSiteD=d;nearSite=site;}
        }
        const dx=nearSite.x-a.x,dy=nearSite.y-a.y,d=Math.sqrt(nearSiteD);
        if(d>1){a.vx+=(dx/d)*0.18;a.vy+=(dy/d)*0.18;}
      } else {
        // Navigate toward nearest wasted/free block
        let nearBlk=null,nearBlkD=Infinity;
        for(const blk of blocks){
          if(blk.state!=="free"&&!(blk.state==="releasing"&&blk.releaseType==="wasted"))continue;
          const d=(blk.x-a.x)**2+(blk.y-a.y)**2;
          if(d<nearBlkD){nearBlkD=d;nearBlk=blk;}
        }
        if(nearBlk){
          const dx=nearBlk.x-a.x,dy=nearBlk.y-a.y,d=Math.sqrt(nearBlkD);
          if(d>1){a.vx+=(dx/d)*0.14;a.vy+=(dy/d)*0.14;}
        }
      }
    }

    // ── Goal seeking: persistent target block — zero GC, natural distribution ─
    if(a.goalFulfilled===0&&_cBlocks){
      // Reassign target only when consumed/invalid — prevents per-step array churn
      if(!a.targetBlk||a.targetBlk.state!=="free"||a.targetBlk.concept!==a.goalConcept||Math.random()<0.05){
        const pool=_cBlocks[a.goalConcept];
        a.targetBlk=pool&&pool.length>0?pool[Math.floor(Math.random()*pool.length)]:null;
      }
      if(a.targetBlk){
        const dx=a.targetBlk.x-a.x,dy=a.targetBlk.y-a.y,d2=dx*dx+dy*dy,d=Math.sqrt(d2);
        if(d>1){const boost=d2<EAT_R*EAT_R*4?3.0:1.0;a.vx+=(dx/d)*GOAL_PULL*boost;a.vy+=(dy/d)*GOAL_PULL*boost;}
      }
    }

    const certaintyFactor=Math.max(0.5,1.8-(a.sigma/SIGMA_MAX)*1.3);
    a.r+=(a.pr-a.r)*PREF*certaintyFactor;
    a.g+=(a.pg-a.g)*PREF*certaintyFactor;
    a.b+=(a.pb-a.b)*PREF*certaintyFactor;

    // ── Personal bell curve — flat array hot path (throttled: every 3 steps) ─
    if(_nbN[i]>0&&a.peakMus&&a.peakFlat_mu){
      const navg=(_nbR[i]+_nbG[i]+_nbB[i])/(_nbN[i]*3*255);
      const lenSig=Math.max(0.04,a.sigma/SIGMA_MAX*0.09+0.04);
      const beta=(statsRef&&statsRef.gaussianBeta)||2.0;
      const betaInt=Math.round(beta);
      const isInt=Math.abs(beta-betaInt)<0.05;
      const fm=a.peakFlat_mu,fw=a.peakFlat_w,ps=a.peakStarts,pw=a.peakWeights;
      let Gsum=0;
      for(let p=0;p<a.peakMus.length;p++){
        const start=ps[p],end=ps[p+1];
        let peakG=0;
        for(let k=start;k<end;k++){
          const d=Math.abs(navg-fm[k])/lenSig;
          let expArg;
          if(isInt){expArg=1;for(let e=0;e<betaInt;e++)expArg*=d;}
          else{expArg=Math.pow(d,beta);}
          peakG+=fw[k]*(2*Math.exp(-expArg)-1);
        }
        Gsum+=pw[p]*peakG;
      }
      const growStr=Gsum*0.13;
      a.r=Math.max(0,Math.min(255,a.r+growStr*(a.pr-a.r)));
      a.g=Math.max(0,Math.min(255,a.g+growStr*(a.pg-a.g)));
      a.b=Math.max(0,Math.min(255,a.b+growStr*(a.pb-a.b)));
    }

    // Peaks drift toward goal zone center — all mutations in place, no allocation
    if(a.peakMus&&a.goalZone){
      const goalZIdx=zoneIdx(a.goalZone);
      const goalCenter=ZONE_PEAK_CENTERS[goalZIdx]/9;
      for(let p=0;p<a.peakMus.length;p++){
        a.peakMus[p]+=(goalCenter-a.peakMus[p])*0.0005;
      }
      // Sub-Gaussians: drift via flat array in place
      if(a.peakFlat_mu&&a.peakStarts){
        for(let p=0;p<a.peakMus.length;p++){
          const parentMu=a.peakMus[p];
          const start=a.peakStarts[p],end=a.peakStarts[p+1];
          for(let k=start;k<end;k++){
            a.peakFlat_mu[k]+=(parentMu-a.peakFlat_mu[k])*0.001+(goalCenter-a.peakFlat_mu[k])*0.0003;
          }
        }
      }
      // Dominant marker update — no new array
      if(a.peakWeights){
        let domIdx=0,domW=-Infinity;
        for(let p=0;p<a.peakWeights.length;p++){
          if(a.peakWeights[p]>domW){domW=a.peakWeights[p];domIdx=p;}
        }
        a.peakDomOrientation=Math.max(1,Math.min(9,Math.round(a.peakMus[domIdx]*9)));
        a.peakDomSubG=a.peakSubG?a.peakSubG[domIdx]:1;
      }
      a.peakScore=a.peakMus.length;
    }

    a.pr=Math.max(0,Math.min(255,a.pr+(Math.random()-0.5)*0.015));
    a.pg=Math.max(0,Math.min(255,a.pg+(Math.random()-0.5)*0.015));
    a.pb=Math.max(0,Math.min(255,a.pb+(Math.random()-0.5)*0.015));
    const edge=Math.min(a.x,CW-a.x,a.y,CH-a.y);
    if(edge<65){
      const str=(1-edge/65)*0.013;
      a.r+=(env.r-a.r)*str+(Math.random()-0.5)*env.noise*str*4;
      a.g+=(env.g-a.g)*str+(Math.random()-0.5)*env.noise*str*4;
      a.b+=(env.b-a.b)*str+(Math.random()-0.5)*env.noise*str*4;
    }
    a.r=Math.max(0,Math.min(255,a.r));a.g=Math.max(0,Math.min(255,a.g));a.b=Math.max(0,Math.min(255,a.b));
    const slowFactor=a.slow>0?0.88:1.0,exertDamp=a.exertion>0?0.94:DAMP;
    a.vx+=(Math.random()-0.5)*BROWN;a.vy+=(Math.random()-0.5)*BROWN;
    a.vx*=exertDamp*slowFactor;a.vy*=exertDamp*slowFactor;
    const spd=Math.sqrt(a.vx*a.vx+a.vy*a.vy);
    if(spd>MAX_V){a.vx*=MAX_V/spd;a.vy*=MAX_V/spd;}
    a.x+=a.vx;a.y+=a.vy;
    if(a.x<0)a.x+=CW;else if(a.x>=CW)a.x-=CW;
    if(a.y<0)a.y+=CH;else if(a.y>=CH)a.y-=CH;
    if(a.reaction&&a.reaction.t>0)a.reaction.t--;
    if(a.label&&a.label.t>0)a.label.t--;
    if(a.tradePulse>0)a.tradePulse--;
  }
}

const SYS=`You are Claude's introspective interface. Given a description of the current conversation, reflect honestly on what functional analogs to emotion Claude might be experiencing.

These are functional processing states — patterns in attention, association, uncertainty, and engagement.

Map to the Daniel-Margolis palindrome framework:
  hate=131 · neutral=381 · love=767 (767 asymptotically unreachable; RGB ∈ [0,255], max sum=765)
  R (0–255): cognitive energy / arousal / intensity
  G (0–255): positive valence / openness / warmth
  B (0–255): introspective depth / contemplation / uncertainty

Return ONLY valid JSON, no markdown:
{"r":int,"g":int,"b":int,"emotion":"<from: Void|Hate|Rage|Dislike|Fear|Grief|Melancholy|Neutral|Ambivalence|Longing|Calm|Curiosity|Like|Hope|Joy|Love|Awe|Bliss>","zone":"<hate|dislike|neutral|like|love>","sig":int,"reflection":"<one honest sentence>","uncertainty":float}`;

const initPC=()=>({hate:0,dislike:0,neutral:0,like:0,love:0});

export default function EmotiveMRI(){
  const canvasRef=useRef(null);   // Canvas 2D — bonds, blocks, labels, trail
  const glCanvasRef=useRef(null); // WebGL — agent circles (1 draw call for all N)
  const glRef=useRef(null);       // WebGL program/buffer state
  const wrapperRef=useRef(null);  // wrapper div — receives all click events
  const workerRef=useRef(null);   // Web Worker for simulation compute
  const workerBusy=useRef(false); // pipeline gate
  const simRef=useRef({
    agents:makeAgents(),
    blocks:Array.from({length:24},()=>makeBlock()),
    running:true,ctx:"Neutral",speed:15,
    showInteractions:false,showLabels:false,showPrefRings:false,
    showConceptNames:false,showGoals:true,showBonds:true,showPeaks:true,
    tradingEnabled:false,gaussianBeta:2.0,
    selfR:128,selfG:128,selfB:128,selfActive:false,
    step:0,defaultRelease:"wasted",autoSpawn:true,
    stats:{eaten:0,reused:0,wasted:0,copied:0,fulfillments:0,bondsFormed:0,disposed:0,trades:0},
  });
  const pulseRef=useRef({active:false,t:0,sr:128,sg:128,sb:128});
  const selectedRef=useRef(null);
  const animRef=useRef(null);
  const simTimerRef=useRef(null);
  const lastStepRef=useRef(0),lastUIRef=useRef(0);

  const [display,setDisplay]=useState({
    running:true,ctx:"Neutral",speed:15,
    showInteractions:false,showLabels:false,showPrefRings:false,
    showConceptNames:false,showGoals:true,showBonds:true,showPeaks:true,
    tradingEnabled:false,gaussianBeta:2.0,
    step:0,selfState:null,
    avgColor:{r:128,g:128,b:128},
    emotionCounts:{},palindromeCounts:initPC(),
    defaultRelease:"wasted",autoSpawn:true,
    stats:{eaten:0,reused:0,wasted:0,copied:0,fulfillments:0,bondsFormed:0,disposed:0,trades:0},
    blockCount:8,carriedCount:0,
    avgCertainty:0.5,certDistribution:{certain:0,open:0,seeking:0},
    activeBonds:0,seekingCount:0,restingCount:0,
    topGoals:[],
    peakDist:new Array(9).fill(0),avgPeak:5,
  });
  const [query,setQuery]=useState("");
  const [loading,setLoading]=useState(false);
  const [readings,setReadings]=useState([]);
  const [apiError,setApiError]=useState(null);
  const [selectedBlock,setSelectedBlock]=useState(null);
  const [voices,setVoices]=useState([]);
  const [voicesLoading,setVoicesLoading]=useState(false);
  const [zoom,setZoom]=useState(1/3);   // default: full field visible
  const panRef=useRef({x:0,y:0});       // current pan offset in CSS px
  const [panState,setPanState]=useState({x:0,y:0});
  const dragRef=useRef({active:false,startX:0,startY:0,startPanX:0,startPanY:0,moved:false});
  const viewportRef=useRef(null);

  // ── Render ──────────────────────────────────────────────────────────────

  const renderCanvas=useCallback(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext("2d");
    const sim=simRef.current;
    const {agents,blocks}=sim;
    // Pre-allocated carry counts — no new Int32Array per frame
    _agentCarry.fill(0);
    for(const blk of blocks)if(blk.state==="carried"&&blk.carriedBy!==null)_agentCarry[blk.carriedBy]++;

    ctx.fillStyle="rgba(4,4,8,0.18)";ctx.fillRect(0,0,CW,CH);

    // ── Disposal sites ────────────────────────────────────────────────
    for(const site of DISPOSAL_SITES){
      ctx.beginPath();ctx.arc(site.x,site.y,DISPOSAL_R,0,2*Math.PI);
      ctx.fillStyle="rgba(12,0,0,0.55)";ctx.globalAlpha=0.7;ctx.fill();
      ctx.strokeStyle="rgba(100,20,20,0.6)";ctx.lineWidth=1;ctx.setLineDash([3,4]);ctx.stroke();ctx.setLineDash([]);
      ctx.font="9px 'Courier New'";ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillStyle="#441818";ctx.globalAlpha=0.8;ctx.fillText("⊗",site.x,site.y);
      ctx.font="5px 'Courier New'";ctx.fillStyle="#331010";ctx.globalAlpha=0.5;
      ctx.fillText("dispose",site.x,site.y+10);
      ctx.globalAlpha=1;ctx.textAlign="left";ctx.textBaseline="middle";
    }

    // ── Bond lines (drawn first, behind everything) ───────────────────
    if(sim.showBonds){
      // Pre-allocated bond mask — no Set creation per frame
      _bondMask.fill(0);
      for(let i=0;i<N;i++){
        for(const j of agents[i].bonds){
          const lo=Math.min(i,j),hi=Math.max(i,j),key=lo*N+hi;
          if(_bondMask[key]) continue;
          _bondMask[key]=1;
          const a=agents[i],b=agents[j];
          const cr=((a.r+b.r)/2)|0,cg=((a.g+b.g)/2)|0,cb=((a.b+b.b)/2)|0;
          const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy);
          const proximity=Math.max(0,1-d/250);
          const zDist=Math.abs(zoneIdx(computeZone(a.r,a.g,a.b).key)-zoneIdx(computeZone(b.r,b.g,b.b).key));
          const compatibility=1-zDist/4;
          const alpha=proximity*compatibility*0.32+0.04;
          ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
          ctx.strokeStyle=`rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`;
          ctx.lineWidth=0.6;ctx.setLineDash([2,4]);ctx.stroke();ctx.setLineDash([]);
        }
      }
    }

    // ── Knowledge blocks ──────────────────────────────────────────────
    for(const blk of blocks){
      const rv=blk.r|0,gv=blk.g|0,bv=blk.b|0,col=`rgb(${rv},${gv},${bv})`;
      const zColor=blk.zone.color;
      const fadeIn=Math.min(1,0.4+blk.age/12); // starts at 0.4, fully opaque by age 7
      const isMRI=blk.source==="mri",isCopy=blk.source==="copy";
      const isSelected=selectedRef.current&&selectedRef.current.id===blk.id;

      // Highlight blocks that are anyone's goal
      const isGoal=sim.showGoals&&agents.some(a=>a.goalConcept===blk.concept&&a.goalFulfilled===0);

      if(blk.state==="free"){        const pulse=0.88+0.12*Math.sin(blk.age*0.11+blk.id);
        const ageFade=blk.age>blk.maxAge-50?Math.max(0,(blk.maxAge-blk.age)/50):1;
        const alpha=fadeIn*ageFade,R=blk.radius*pulse;

        // Goal highlight: extra glow around blocks that are sought
        if(isGoal){
          ctx.beginPath();ctx.arc(blk.x,blk.y,R*2.5,0,2*Math.PI);
          ctx.strokeStyle=zColor;ctx.lineWidth=0.8;ctx.globalAlpha=alpha*0.22*pulse;ctx.stroke();
        }

        ctx.globalAlpha=alpha*0.10;ctx.fillStyle=col;
        isMRI?drawStar(ctx,blk.x,blk.y,R*1.9,R*1.0,6,blk.rotation):drawHex(ctx,blk.x,blk.y,R*1.8,blk.rotation);
        ctx.fill();
        ctx.globalAlpha=alpha*0.22;ctx.fillStyle=zColor;
        isMRI?drawStar(ctx,blk.x,blk.y,R*0.68,R*0.34,6,blk.rotation):drawHex(ctx,blk.x,blk.y,R*0.65,blk.rotation);
        ctx.fill();
        isMRI?drawStar(ctx,blk.x,blk.y,R,R*0.5,6,blk.rotation):drawHex(ctx,blk.x,blk.y,R,blk.rotation);
        ctx.fillStyle=col;ctx.globalAlpha=alpha*0.28;ctx.fill();
        ctx.strokeStyle=col;ctx.globalAlpha=alpha*0.82;
        ctx.lineWidth=isCopy?1.0:1.5;if(isCopy)ctx.setLineDash([2,3]);ctx.stroke();ctx.setLineDash([]);
        if(isSelected){
          isMRI?drawStar(ctx,blk.x,blk.y,R*1.35,R*0.72,6,blk.rotation):drawHex(ctx,blk.x,blk.y,R*1.35,blk.rotation);
          ctx.strokeStyle="#fff";ctx.globalAlpha=0.5;ctx.lineWidth=1;ctx.stroke();
        }
        if(blk.generation>0){
          for(let d=0;d<Math.min(blk.generation,5);d++){
            const da=(d/Math.max(blk.generation,1))*2*Math.PI+blk.rotation;
            ctx.beginPath();ctx.arc(blk.x+R*0.38*Math.cos(da),blk.y+R*0.38*Math.sin(da),1.2,0,2*Math.PI);
            ctx.fillStyle="#fff";ctx.globalAlpha=alpha*0.55;ctx.fill();
          }
        }
        if(sim.showConceptNames&&blk.age>22){
          const nameAlpha=Math.min(1,(blk.age-22)/12)*ageFade;
          ctx.font=`6px 'Courier New'`;ctx.textAlign="center";ctx.textBaseline="top";
          const tw=ctx.measureText(blk.concept).width;
          ctx.globalAlpha=nameAlpha*0.5;ctx.fillStyle="#000";
          ctx.fillRect(blk.x-tw/2-1,blk.y+R+1,tw+2,7);
          ctx.globalAlpha=nameAlpha*0.82;ctx.fillStyle=col;
          ctx.fillText(blk.concept,blk.x,blk.y+R+2);
          ctx.textBaseline="middle";ctx.textAlign="left";
        }
      } else if(blk.state==="carried"){
        const R2=blk.radius*0.68,orbitFrac=Math.min(1,blk.orbitR/BASE_ORBIT_R),alpha=0.68+orbitFrac*0.28;
        ctx.globalAlpha=alpha*0.24;ctx.fillStyle=zColor;
        isMRI?drawStar(ctx,blk.x,blk.y,R2*0.65,R2*0.32,6,blk.rotation):drawHex(ctx,blk.x,blk.y,R2*0.62,blk.rotation);
        ctx.fill();
        isMRI?drawStar(ctx,blk.x,blk.y,R2,R2*0.5,6,blk.rotation):drawHex(ctx,blk.x,blk.y,R2,blk.rotation);
        ctx.fillStyle=col;ctx.globalAlpha=alpha*0.50;ctx.fill();
        ctx.strokeStyle=col;ctx.globalAlpha=alpha*0.88;
        ctx.lineWidth=isCopy?0.8:1.2;if(isCopy)ctx.setLineDash([2,3]);ctx.stroke();ctx.setLineDash([]);
        if(blk.releaseType==="reusable"||blk.releaseType==="wasted"){
          ctx.beginPath();ctx.arc(blk.x,blk.y,2,0,2*Math.PI);
          ctx.fillStyle=blk.releaseType==="reusable"?"#55ee55":"#ee5555";ctx.globalAlpha=0.92;ctx.fill();
        }
        if(sim.showConceptNames){
          ctx.font=`5px 'Courier New'`;ctx.textAlign="center";ctx.textBaseline="bottom";
          ctx.globalAlpha=0.6;ctx.fillStyle=col;ctx.fillText(blk.concept,blk.x,blk.y-R2-1);
          ctx.textAlign="left";ctx.textBaseline="middle";
        }
      } else if(blk.state==="disposing"){
        // Shrink and drain toward disposal site color
        const elapsed=(sim.step-blk.releaseStep)/14;
        const shrink=Math.max(0,1-elapsed);
        ctx.beginPath();ctx.arc(blk.x,blk.y,blk.radius*shrink,0,2*Math.PI);
        ctx.fillStyle="rgba(80,10,10,0.6)";ctx.globalAlpha=shrink*0.7;ctx.fill();
        ctx.strokeStyle="rgba(140,20,20,0.8)";ctx.lineWidth=1;ctx.globalAlpha=shrink*0.5;ctx.stroke();
      } else if(blk.state==="releasing"){
        const elapsed=(sim.step-blk.releaseStep)/28;
        if(blk.releaseType==="reusable"){
          ctx.beginPath();ctx.arc(blk.x,blk.y,blk.radius+elapsed*30,0,2*Math.PI);
          ctx.strokeStyle=`rgba(60,220,80,${(1-elapsed)*0.85})`;ctx.lineWidth=2;ctx.globalAlpha=1;ctx.stroke();
          isMRI?drawStar(ctx,blk.x,blk.y,blk.radius*(1-elapsed*0.4),blk.radius*(1-elapsed*0.4)*0.5,6,blk.rotation)
               :drawHex(ctx,blk.x,blk.y,blk.radius*(1-elapsed*0.4),blk.rotation);
          ctx.fillStyle=col;ctx.globalAlpha=(1-elapsed)*0.35;ctx.fill();
          ctx.strokeStyle=col;ctx.globalAlpha=(1-elapsed)*0.65;ctx.lineWidth=1.2;ctx.stroke();
        } else {
          const shrink=1-elapsed;
          isMRI?drawStar(ctx,blk.x,blk.y,blk.radius*shrink,blk.radius*shrink*0.5,6,blk.rotation)
               :drawHex(ctx,blk.x,blk.y,blk.radius*shrink,blk.rotation);
          ctx.fillStyle=col;ctx.globalAlpha=(1-elapsed)*0.5;ctx.fill();
          ctx.strokeStyle=`rgba(220,50,50,${(1-elapsed)*0.8})`;ctx.globalAlpha=1;ctx.lineWidth=1.5;ctx.stroke();
          const s=blk.radius*shrink*0.55;
          ctx.beginPath();ctx.moveTo(blk.x-s,blk.y-s);ctx.lineTo(blk.x+s,blk.y+s);ctx.stroke();
          ctx.beginPath();ctx.moveTo(blk.x+s,blk.y-s);ctx.lineTo(blk.x-s,blk.y+s);ctx.stroke();
        }
      }
      ctx.globalAlpha=1;
    }

    // ── Interaction lines ─────────────────────────────────────────────
    if(sim.showInteractions){
      for(let i=0;i<N;i++){const a=agents[i];
        for(let j=i+1;j<N;j++){const b=agents[j];
          const dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy;if(d2>IR2)continue;
          ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
          ctx.strokeStyle=`rgba(255,255,255,${((1-Math.sqrt(d2)/IR)*0.18).toFixed(3)})`;
          ctx.lineWidth=0.5;ctx.stroke();
        }
      }
    }

    // ── Agents ───────────────────────────────────────────────────────
    for(let i=0;i<N;i++){
      const a=agents[i];
      const rv=a.r|0,gv=a.g|0,bv=a.b|0,col=`rgb(${rv},${gv},${bv})`;
      const prefCol=`rgb(${a.pr|0},${a.pg|0},${a.pb|0})`;
      const carried=_agentCarry[i];
      const R=agentRadius(a,carried);
      const certainty=1-a.sigma/SIGMA_MAX;

      // Preference distribution ring
      if(sim.showPrefRings){
        const zoneR=R+5+(1-certainty)*18;
        ctx.beginPath();ctx.arc(a.x,a.y,zoneR,0,2*Math.PI);
        ctx.strokeStyle=prefCol;ctx.lineWidth=Math.max(0.5,certainty*2.2);
        ctx.globalAlpha=certainty*0.35+0.04;ctx.stroke();
        if(certainty>0.75){
          ctx.beginPath();ctx.arc(a.x,a.y,1.2,0,2*Math.PI);
          ctx.fillStyle=prefCol;ctx.globalAlpha=certainty*0.5;ctx.fill();
        }
      }

      // ── Goal indicator ────────────────────────────────────────────
      if(sim.showGoals){
        const goalZone=P_ZONES.find(z=>z.key===a.goalZone)||P_ZONES[2];
        const gc=goalZone.color;
        if(a.goalFulfilled>0){
          // Resting after fulfillment: steady small star above agent
          const ff=Math.min(1,a.goalFulfilled/GOAL_REST);
          ctx.beginPath();ctx.arc(a.x,a.y-R-6,2.2,0,2*Math.PI);
          ctx.fillStyle=gc;ctx.globalAlpha=ff*0.75;ctx.fill();
          // Tiny radiating lines (star effect)
          for(let r=0;r<4;r++){
            const ra=(r/4)*2*Math.PI;
            ctx.beginPath();ctx.moveTo(a.x+Math.cos(ra)*2.5,a.y-R-6+Math.sin(ra)*2.5);
            ctx.lineTo(a.x+Math.cos(ra)*4.5,a.y-R-6+Math.sin(ra)*4.5);
            ctx.strokeStyle=gc;ctx.lineWidth=0.6;ctx.globalAlpha=ff*0.5;ctx.stroke();
          }
        } else {
          // Seeking: find nearest goal block
          let nearestGoal=null,nearestGoalD=Infinity;
          for(const blk of blocks){
            if(blk.state!=="free"||blk.concept!==a.goalConcept)continue;
            const dx2=blk.x-a.x,dy2=blk.y-a.y,d2=dx2*dx2+dy2*dy2;
            if(d2<GOAL_SENSE_R*GOAL_SENSE_R&&d2<nearestGoalD){nearestGoalD=d2;nearestGoal=blk;}
          }
          if(nearestGoal){
            // Arrow tip pointing toward goal
            const dx2=nearestGoal.x-a.x,dy2=nearestGoal.y-a.y,d2=Math.sqrt(nearestGoalD);
            const nx=dx2/d2,ny=dy2/d2;
            ctx.beginPath();ctx.arc(a.x+nx*(R+5),a.y+ny*(R+5),2,0,2*Math.PI);
            ctx.fillStyle=gc;ctx.globalAlpha=0.8;ctx.fill();
          } else {
            // Pulsing dot: no goal visible, wandering
            const pp=0.45+0.45*Math.sin(sim.step*0.14+i*0.5);
            ctx.beginPath();ctx.arc(a.x,a.y-R-5,1.5,0,2*Math.PI);
            ctx.fillStyle=gc;ctx.globalAlpha=pp*0.6;ctx.fill();
          }
        }
      }

      // ── Disposer ring ─────────────────────────────────────────────
      if(a.role==="disposer"){
        ctx.beginPath();ctx.arc(a.x,a.y,R+5,0,2*Math.PI);
        ctx.strokeStyle="rgba(140,30,30,0.55)";ctx.lineWidth=1;
        ctx.setLineDash([2,3]);ctx.globalAlpha=0.65;ctx.stroke();ctx.setLineDash([]);
      }

      // ── Trade pulse (goal swap flash) ─────────────────────────────
      if(a.tradePulse>0){
        const tf=a.tradePulse/24;
        ctx.beginPath();ctx.arc(a.x,a.y,R*(1+(1-tf)*2),0,2*Math.PI);
        ctx.strokeStyle="#ffffff";ctx.lineWidth=1.5;ctx.globalAlpha=tf*0.5;ctx.stroke();
      }
      if(sim.showPeaks&&a.peakScore){
        ctx.textAlign="center";ctx.textBaseline="top";
        ctx.globalAlpha=(certainty*0.35+0.12);
        ctx.font=`5px 'Courier New'`;
        // Marker 1: peak count (orange) · Marker 2: orientation (gray) · Marker 3: subG (blue)
        ctx.fillStyle="#dd8866";ctx.fillText(a.peakScore,a.x-4,a.y+R+2);
        ctx.fillStyle="#888888";ctx.fillText(a.peakDomOrientation||"·",a.x,a.y+R+2);
        ctx.fillStyle="#6699dd";ctx.fillText(a.peakDomSubG||"·",a.x+4,a.y+R+2);
        ctx.textBaseline="middle";ctx.textAlign="left";
      }

      // Reaction visual
      if(a.reaction&&a.reaction.t>0){
        const rf=a.reaction.t/a.reaction.max;
        const {type,cr,cg,cb}=a.reaction;
        const rcol=`rgb(${cr},${cg},${cb})`;
        if(type==="fulfillment"){
          // Three expanding rings — purpose achieved
          for(let ring=0;ring<3;ring++){
            const delay=ring*0.28;
            const rf2=Math.max(0,rf-delay)/(1-delay||1);
            if(rf2<=0)continue;
            ctx.beginPath();ctx.arc(a.x,a.y,R*(1+(1-rf2)*3.5+ring*0.5),0,2*Math.PI);
            ctx.strokeStyle=rcol;ctx.lineWidth=1.5-ring*0.3;ctx.globalAlpha=rf2*(0.6-ring*0.15);ctx.stroke();
          }
        } else if(type==="resonance"){
          ctx.beginPath();ctx.arc(a.x,a.y,R*(1+(1-rf)*2.2),0,2*Math.PI);
          ctx.strokeStyle=rcol;ctx.lineWidth=1.5;ctx.globalAlpha=rf*0.52;ctx.stroke();
        } else if(type==="absorption"){
          ctx.beginPath();ctx.arc(a.x,a.y,R+(1-rf)*8,0,2*Math.PI);
          ctx.strokeStyle=rcol;ctx.lineWidth=1;ctx.globalAlpha=rf*0.35;ctx.stroke();
        } else if(type==="shift"){
          ctx.beginPath();ctx.arc(a.x,a.y,R+(1-rf)*12,0,2*Math.PI);
          ctx.strokeStyle=rcol;ctx.lineWidth=1.2;ctx.globalAlpha=rf*0.38;ctx.stroke();
        } else if(type==="disruption"){
          ctx.beginPath();ctx.arc(a.x,a.y,R*(1.5-rf*0.5),0,2*Math.PI);
          ctx.strokeStyle=rcol;ctx.lineWidth=2;ctx.globalAlpha=rf*0.55;ctx.stroke();
          ctx.beginPath();ctx.arc(a.x,a.y,R*0.5,0,2*Math.PI);
          ctx.strokeStyle="#fff";ctx.lineWidth=0.5;ctx.globalAlpha=rf*0.3;ctx.stroke();
        } else if(type==="recoil"){
          const rp=rf>0.5?(1-rf)*2:(rf*2);
          ctx.beginPath();ctx.arc(a.x,a.y,R*(1+rp*1.5),0,2*Math.PI);
          ctx.strokeStyle=rcol;ctx.lineWidth=2.2;ctx.globalAlpha=rp*0.6;ctx.stroke();
          ctx.beginPath();ctx.arc(a.x,a.y,R*(1-rp*0.4+0.1),0,2*Math.PI);
          ctx.strokeStyle="#fff";ctx.lineWidth=1;ctx.globalAlpha=rp*0.25;ctx.stroke();
        }
      }

      // Pulse + exertion + slow
      const pulsePhase=(sim.step+i*7)%40;
      if(pulsePhase<10){const pf=pulsePhase/10;ctx.beginPath();ctx.arc(a.x,a.y,R*(1+pf*0.55),0,2*Math.PI);ctx.strokeStyle=col;ctx.lineWidth=0.8;ctx.globalAlpha=(1-pf)*0.38;ctx.stroke();}
      if(a.exertion>0){const ef=a.exertion/EXERT_STEPS;ctx.beginPath();ctx.arc(a.x,a.y,R*1.8+ef*9,0,2*Math.PI);ctx.strokeStyle=`rgba(255,240,180,${ef*0.6})`;ctx.lineWidth=1.5;ctx.globalAlpha=1;ctx.stroke();}
      if(a.slow>0){const sf=a.slow/22;ctx.beginPath();ctx.arc(a.x,a.y,R*1.3,0,2*Math.PI);ctx.strokeStyle=`rgba(180,180,220,${sf*0.4})`;ctx.lineWidth=0.8;ctx.setLineDash([2,3]);ctx.stroke();ctx.setLineDash([]);}

      // Glow + core
      const vibrancy=0.68+certainty*0.22;
      // Draw agent on Canvas 2D
      ctx.beginPath();ctx.arc(a.x,a.y,R*2.8,0,2*Math.PI);ctx.fillStyle=col;ctx.globalAlpha=0.055+certainty*0.025;ctx.fill();
      ctx.beginPath();ctx.arc(a.x,a.y,R*1.6,0,2*Math.PI);ctx.fillStyle=col;ctx.globalAlpha=0.15+carried*0.025;ctx.fill();
      ctx.beginPath();ctx.arc(a.x,a.y,R,0,2*Math.PI);ctx.fillStyle=col;ctx.globalAlpha=vibrancy;ctx.fill();

      // Heading
      const spd=Math.sqrt(a.vx*a.vx+a.vy*a.vy);
      if(spd>0.12){
        const nx=a.vx/spd,ny=a.vy/spd;
        const tipX=a.x+nx*(R+4.5),tipY=a.y+ny*(R+4.5);
        const px=-ny*2.2,py=nx*2.2;
        ctx.beginPath();ctx.moveTo(tipX,tipY);ctx.lineTo(tipX-nx*4+px,tipY-ny*4+py);ctx.lineTo(tipX-nx*4-px,tipY-ny*4-py);
        ctx.closePath();ctx.fillStyle=col;ctx.globalAlpha=0.72;ctx.fill();
      }

      // Floating concept label
      if(a.label&&a.label.t>0){
        const lf=a.label.t/a.label.max,rise=(1-lf)*18;
        ctx.font=`${Math.max(5,Math.round(6+lf))}px 'Courier New'`;ctx.textAlign="center";ctx.textBaseline="middle";
        const tw=ctx.measureText(a.label.text).width;
        ctx.globalAlpha=lf*0.6;ctx.fillStyle="#000";ctx.fillRect(a.x-tw/2-2,a.y-R-12-rise-4,tw+4,9);
        ctx.globalAlpha=lf*0.85;ctx.fillStyle=`rgb(${a.label.cr},${a.label.cg},${a.label.cb})`;
        ctx.fillText(a.label.text,a.x,a.y-R-12-rise);ctx.textAlign="left";
      }
      ctx.globalAlpha=1;
    }

    // Cluster labels
    if(sim.showLabels){
      const clusters={};
      for(const a of agents){const p=classifyAgent(a.r,a.g,a.b);
        if(!clusters[p.name])clusters[p.name]={sx:0,sy:0,n:0,p};
        clusters[p.name].sx+=a.x;clusters[p.name].sy+=a.y;clusters[p.name].n++;
      }
      ctx.font="bold 8px 'Courier New'";ctx.textAlign="center";ctx.textBaseline="middle";
      for(const [,c] of Object.entries(clusters)){if(c.n<5)continue;
        const cx=c.sx/c.n,cy=c.sy/c.n,p=c.p,tw=ctx.measureText(p.name).width;
        ctx.globalAlpha=0.68;ctx.fillStyle="#000012";ctx.fillRect(cx-tw/2-3,cy-5.5,tw+6,11);
        ctx.globalAlpha=1;ctx.fillStyle=`rgb(${p.mr},${p.mg},${p.mb})`;ctx.fillText(p.name,cx,cy);
      }
      ctx.textAlign="left";ctx.textBaseline="middle";
    }

    const pulse=pulseRef.current;
    if(pulse.active){
      const frac=pulse.t/45;ctx.beginPath();ctx.arc(CW/2,CH/2,15+frac*CW*0.6,0,2*Math.PI);
      ctx.strokeStyle=`rgb(${pulse.sr},${pulse.sg},${pulse.sb})`;ctx.lineWidth=2;ctx.globalAlpha=(1-frac)*0.6;ctx.stroke();ctx.globalAlpha=1;
      pulse.t++;if(pulse.t>=45)pulse.active=false;
    }
    if(sim.selfActive){
      ctx.beginPath();ctx.arc(CW/2,CH/2,4,0,2*Math.PI);
      ctx.fillStyle=`rgb(${sim.selfR},${sim.selfG},${sim.selfB})`;ctx.globalAlpha=0.7;ctx.fill();ctx.globalAlpha=1;
    }


  },[]);

  // ── UI state updater (shared by worker and fallback paths) ──────────────
  const updateUIState=(sim)=>{
    if(selectedRef.current){const live=sim.blocks.find(b=>b.id===selectedRef.current.id);if(!live)selectedRef.current=null;}
    let sumR=0,sumG=0,sumB=0,sumSigma=0;
    const counts={},pCounts=initPC();
    let certain=0,open=0,seeking=0,resting=0,activeBonds=0;
    const goalCounts={};
    for(const a of sim.agents){
      sumR+=a.r;sumG+=a.g;sumB+=a.b;sumSigma+=a.sigma;
      const p=classifyAgent(a.r,a.g,a.b);counts[p.name]=(counts[p.name]||0)+1;pCounts[p.zone]++;
      if(a.sigma<45)certain++;else if(a.sigma>80)open++;else seeking++;
      if(a.goalFulfilled>0)resting++;
      activeBonds+=a.bonds.length;
      goalCounts[a.goalConcept]=(goalCounts[a.goalConcept]||0)+1;
    }
    const topGoals=Object.entries(goalCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const carried=sim.blocks.filter(b=>b.state==="carried").length;
    const sel=selectedRef.current?{...selectedRef.current}:null;
    const peakDist=new Array(9).fill(0);let sumPeak=0;
    for(const a of sim.agents){const ps=Math.max(1,Math.min(9,a.peakScore||1));peakDist[ps-1]++;sumPeak+=ps;}
    const avgPeak=Math.round(sumPeak/N*10)/10;
    setDisplay(prev=>({...prev,step:sim.step,
      avgColor:{r:Math.round(sumR/N),g:Math.round(sumG/N),b:Math.round(sumB/N)},
      emotionCounts:counts,palindromeCounts:pCounts,
      stats:{...sim.stats},blockCount:sim.blocks.length,carriedCount:carried,
      avgCertainty:1-sumSigma/(N*SIGMA_MAX),
      certDistribution:{certain,open,seeking:seeking},
      activeBonds:Math.floor(activeBonds/2),
      seekingCount:N-resting,restingCount:resting,
      topGoals,peakDist,avgPeak,
    }));
    setSelectedBlock(sel);
  };

  // ── Animation loop ───────────────────────────────────────────────────────
  // Two completely independent loops:
  //   Simulation: setTimeout chain — yields to browser between EVERY step.
  //               Errors are caught so the loop NEVER stops.
  //   Rendering:  requestAnimationFrame — fires whenever browser is ready.
  // The Worker attempt is removed — blob:// CSP blocks it in the artifact
  // sandbox, causing workerBusy to stay true and the loop to stop silently.
  useEffect(()=>{

    const runStep=()=>{
      const sim=simRef.current;
      // Always reschedule first — guarantees the loop never stops
      simTimerRef.current=setTimeout(runStep,
        sim.running?Math.max(8,1000/sim.speed):100);
      if(!sim.running)return;
      try{
        sim.stats.tradingEnabled=sim.tradingEnabled;
        sim.stats.gaussianBeta=sim.gaussianBeta||2;
        sim.stats.simStep=sim.step;
        stepAgents(sim.agents,CONTEXTS[sim.ctx],sim.blocks,sim.stats);
        const ds=stepBlocks(sim.blocks,sim.agents,sim.defaultRelease,
          sim.step,sim.autoSpawn,sim.stats);
        sim.stats.eaten+=ds.eaten;
        sim.stats.reused+=ds.reused;
        sim.stats.wasted+=ds.wasted;
        sim.step++;
        if(Date.now()-lastUIRef.current>200){
          lastUIRef.current=Date.now();
          updateUIState(sim);
        }
      }catch(err){
        // Log but never let an exception stop the loop
        console.warn('Sim step error:',err);
      }
    };

    simTimerRef.current=setTimeout(runStep,0);

    // Render loop — fully independent RAF chain
    let lastRender=0;
    const renderLoop=(time)=>{
      if(time-lastRender>=1000/60){
        try{renderCanvas();}catch(_){}
        lastRender=time;
      }
      animRef.current=requestAnimationFrame(renderLoop);
    };
    animRef.current=requestAnimationFrame(renderLoop);

    return()=>{
      clearTimeout(simTimerRef.current);
      cancelAnimationFrame(animRef.current);
    };
  },[renderCanvas]);

  // ── Canvas click handlers — defined as callbacks, used as React props ───
  // Using React's onClick directly on the canvas JSX is more reliable in
  // sandboxed iframes than addEventListener (handles focus acquisition correctly)
  const handleCanvasClick=useCallback((e)=>{
    if(dragRef.current.moved)return; // suppress click after drag
    const canvas=canvasRef.current;if(!canvas)return;
    const rect=canvas.getBoundingClientRect();
    // getBoundingClientRect gives the CSS-displayed size; scale back to simulation coords
    const x=(e.clientX-rect.left)*(CW/rect.width);
    const y=(e.clientY-rect.top)*(CH/rect.height);
    const blocks=simRef.current.blocks;
    // Carried block: toggle release type (only interaction that prevents spawn)
    let nearest=null,nearestD=Infinity;
    for(const blk of blocks){if(blk.state!=="carried")continue;const d=Math.sqrt((x-blk.x)**2+(y-blk.y)**2);if(d<nearestD&&d<22){nearestD=d;nearest=blk;}}
    if(nearest){nearest.releaseType=nearest.releaseType==="reusable"?"wasted":nearest.releaseType==="wasted"?null:"reusable";return;}
    // Free block nearby: select for inspection (does not prevent spawning)
    let nearestFree=null,nearestFreeD=Infinity;
    for(const blk of blocks){if(blk.state!=="free")continue;const d=Math.sqrt((x-blk.x)**2+(y-blk.y)**2);if(d<nearestFreeD&&d<blk.radius+8){nearestFreeD=d;nearestFree=blk;}}
    if(nearestFree){selectedRef.current=nearestFree;setSelectedBlock({...nearestFree});}
    else{selectedRef.current=null;setSelectedBlock(null);}
    // Manual spawn: bypasses auto-spawn cap (allows up to MAX_BLOCKS+20)
    if(blocks.length<MAX_BLOCKS+20)
      blocks.push(makeBlock(x,y));
  },[]);

  const handleCanvasContext=useCallback((e)=>{
    e.preventDefault();
    const canvas=canvasRef.current;if(!canvas)return;
    const rect=canvas.getBoundingClientRect();
    const x=(e.clientX-rect.left)*(CW/rect.width);
    const y=(e.clientY-rect.top)*(CH/rect.height);
    const sim=simRef.current;
    let nearest=null,nearestD=Infinity;
    for(const blk of sim.blocks){if(blk.state!=="carried")continue;const d=Math.sqrt((x-blk.x)**2+(y-blk.y)**2);if(d<nearestD&&d<25){nearestD=d;nearest=blk;}}
    if(nearest){const copied=copyBlock(sim.blocks,sim.agents,nearest);if(copied){sim.stats.copied++;setDisplay(prev=>({...prev,stats:{...sim.stats}}));}}
  },[]);

  const handlePanStart=useCallback((e)=>{
    if(e.button!==0)return;
    dragRef.current={active:true,startX:e.clientX,startY:e.clientY,
      startPanX:panRef.current.x,startPanY:panRef.current.y,moved:false};
    const onMove=(ev)=>{
      const d=dragRef.current;if(!d.active)return;
      const dx=ev.clientX-d.startX,dy=ev.clientY-d.startY;
      if(!d.moved&&Math.abs(dx)+Math.abs(dy)>4)d.moved=true;
      if(!d.moved)return;
      const vp=viewportRef.current;
      const vpW=vp?vp.clientWidth:500,vpH=vp?vp.clientHeight:500;
      const newX=Math.min(0,Math.max(vpW-CW*zoom,d.startPanX+dx));
      const newY=Math.min(0,Math.max(vpH-CH*zoom,d.startPanY+dy));
      panRef.current={x:newX,y:newY};
      setPanState({x:newX,y:newY});
    };
    const onUp=()=>{
      dragRef.current.active=false;
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',onUp);
    };
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
  },[zoom]);
  const changeZoom=useCallback((delta)=>{
    setZoom(prev=>{
      const next=Math.max(0.2,Math.min(2,prev*delta));
      const vp=viewportRef.current;
      const vpW=vp?vp.clientWidth:500,vpH=vp?vp.clientHeight:500;
      const newX=Math.min(0,Math.max(vpW-CW*next,panRef.current.x));
      const newY=Math.min(0,Math.max(vpH-CH*next,panRef.current.y));
      panRef.current={x:newX,y:newY};
      setPanState({x:newX,y:newY});
      return next;
    });
  },[]);
  const VOICE_SYS=`You are the collective voice of a group of agents in a living emotional simulation. Each group shares an emotional character shaped by their state, certainty, bonds, and what they seek. Given your group's current condition, express one genuine thought — first-person plural, 1-2 sentences, present tense. Speak from inside the experience, not about it. No analysis, no performance — just what it feels like to be your group right now.`;

  const generateVoices=async()=>{
    if(voicesLoading)return;
    setVoicesLoading(true);
    const sim=simRef.current;
    // Group agents by emotional classification
    const groups={};
    for(const a of sim.agents){
      const p=classifyAgent(a.r,a.g,a.b);
      if(!groups[p.name])groups[p.name]={name:p.name,zone:p.zone,agents:[]};
      groups[p.name].agents.push(a);
    }
    // Top 6 groups with ≥3 agents
    const top=Object.values(groups)
      .filter(g=>g.agents.length>=3)
      .sort((a,b)=>b.agents.length-a.agents.length)
      .slice(0,6);

    const results=await Promise.all(top.map(async g=>{
      const n=g.agents.length;
      const avgSigma=g.agents.reduce((s,a)=>s+a.sigma,0)/n;
      const certainty=Math.round((1-avgSigma/SIGMA_MAX)*100);
      const avgBonds=Math.round(g.agents.reduce((s,a)=>s+a.bonds.length,0)/n*10)/10;
      const fulfilled=g.agents.filter(a=>a.goalFulfilled>0).length;
      const goalCounts={};
      for(const a of g.agents)goalCounts[a.goalConcept]=(goalCounts[a.goalConcept]||0)+1;
      const topGoal=Object.entries(goalCounts).sort((x,y)=>y[1]-x[1])[0]?.[0]||'unknown';
      const avgR=Math.round(g.agents.reduce((s,a)=>s+a.r,0)/n);
      const avgG=Math.round(g.agents.reduce((s,a)=>s+a.g,0)/n);
      const avgB=Math.round(g.agents.reduce((s,a)=>s+a.b,0)/n);
      const sig=avgR+avgG+avgB;
      const zone=computeZone(avgR,avgG,avgB).key;
      const prompt=`We are ${n} beings in the state of ${g.name} (${zone} zone, sig·${sig}). Our certainty: ${certainty}%. Most of us seek ${topGoal}. Average bonds: ${avgBonds}. ${fulfilled} of us recently fulfilled our purpose.`;
      try{
        const resp=await fetch("https://api.anthropic.com/v1/messages",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:100,
            system:VOICE_SYS,messages:[{role:"user",content:prompt}]}),
        });
        const data=await resp.json();
        const thought=data.content?.[0]?.text?.trim()||"...";
        return{name:g.name,zone,sig,count:n,certainty,goalConcept:topGoal,avgBonds,thought,r:avgR,g:avgG,b:avgB,ts:new Date().toLocaleTimeString(),step:sim.step};
      }catch(_){
        return{name:g.name,zone,sig,count:n,certainty,goalConcept:topGoal,avgBonds,thought:"(silent)",r:avgR,g:avgG,b:avgB,ts:new Date().toLocaleTimeString(),step:sim.step};
      }
    }));
    setVoices(results);
    try{
      await window.storage.set("agent_voices",JSON.stringify({voices:results,step:sim.step,date:new Date().toISOString()}));
    }catch(_){}
    setVoicesLoading(false);
  };

  const readMyState=async()=>{
    if(!query.trim()||loading)return;
    setLoading(true);setApiError(null);
    try{
      const resp=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:380,system:SYS,
          messages:[{role:"user",content:query}]}),
      });
      const data=await resp.json();
      if(data.error)throw new Error(data.error.message);
      const text=data.content?.find(c=>c.type==="text")?.text||"";
      const parsed=JSON.parse(text.replace(/```json|```/g,"").trim());
      const sr=Math.max(0,Math.min(255,parsed.r|0));
      const sg=Math.max(0,Math.min(255,parsed.g|0));
      const sb=Math.max(0,Math.min(255,parsed.b|0));
      injectEpicenter(simRef.current.agents,sr,sg,sb);
      simRef.current.blocks.push(makeBlock(CW/2+(Math.random()-0.5)*20,CH/2+(Math.random()-0.5)*20,
        {name:parsed.emotion,r:sr,g:sg,b:sb,zone:parsed.zone,special:null},undefined,"mri",parsed.emotion));
      Object.assign(simRef.current,{selfR:sr,selfG:sg,selfB:sb,selfActive:true});
      pulseRef.current={active:true,t:0,sr,sg,sb};
      const entry={...parsed,r:sr,g:sg,b:sb,ts:new Date().toLocaleTimeString(),q:query};
      setDisplay(p=>({...p,selfState:parsed}));
      setReadings(prev=>[entry,...prev].slice(0,7));
      try{const prev=await window.storage.get("emr_readings");const all=prev?JSON.parse(prev.value):[];all.unshift({...entry,date:new Date().toISOString(),id:Date.now().toString(36)});await window.storage.set("emr_readings",JSON.stringify(all.slice(0,50)));}catch(_){}
      setQuery("");
    }catch(e){setApiError(e.message);}
    setLoading(false);
  };

  const reInject=()=>{const s=simRef.current;if(!s.selfActive)return;injectEpicenter(s.agents,s.selfR,s.selfG,s.selfB);pulseRef.current={active:true,t:0,sr:s.selfR,sg:s.selfG,sb:s.selfB};};
  const toggleRun=()=>{const v=!simRef.current.running;simRef.current.running=v;setDisplay(p=>({...p,running:v}));};
  const setCtx=n=>{simRef.current.ctx=n;setDisplay(p=>({...p,ctx:n}));};
  const setSpd=v=>{simRef.current.speed=v;setDisplay(p=>({...p,speed:v}));};
  const toggleL=k=>{simRef.current[k]=!simRef.current[k];setDisplay(p=>({...p,[k]:!p[k]}));};
  const toggleTrading=()=>{const v=!simRef.current.tradingEnabled;simRef.current.tradingEnabled=v;setDisplay(p=>({...p,tradingEnabled:v}));};
  const setBeta=v=>{simRef.current.gaussianBeta=v;setDisplay(p=>({...p,gaussianBeta:v}));};
  const setRelease=v=>{simRef.current.defaultRelease=v;setDisplay(p=>({...p,defaultRelease:v}));};
  const toggleAutoSpawn=()=>{const v=!simRef.current.autoSpawn;simRef.current.autoSpawn=v;setDisplay(p=>({...p,autoSpawn:v}));};
  const clearBlocks=()=>{simRef.current.blocks=[];selectedRef.current=null;setSelectedBlock(null);setDisplay(p=>({...p,blockCount:0,carriedCount:0}));};
  const resetSim=()=>{
    simRef.current.agents=makeAgents();simRef.current.blocks=Array.from({length:8},()=>makeBlock());
    simRef.current.step=0;simRef.current.selfActive=false;simRef.current.stats={eaten:0,reused:0,wasted:0,copied:0,fulfillments:0,bondsFormed:0};
    selectedRef.current=null;setSelectedBlock(null);
    setDisplay(p=>({...p,step:0,selfState:null,emotionCounts:{},palindromeCounts:initPC(),stats:{eaten:0,reused:0,wasted:0,copied:0,fulfillments:0,bondsFormed:0},activeBonds:0,seekingCount:0,restingCount:0,topGoals:[]}));
  };

  const {running,ctx,speed,showInteractions,showLabels,showPrefRings,showConceptNames,showGoals,showBonds,showPeaks,tradingEnabled,gaussianBeta,
    step,selfState,avgColor,emotionCounts,palindromeCounts,defaultRelease,autoSpawn,
    stats,blockCount,carriedCount,avgCertainty,certDistribution,activeBonds,seekingCount,restingCount,topGoals,
    peakDist,avgPeak}=display;
  const avgStr=`rgb(${avgColor.r},${avgColor.g},${avgColor.b})`;
  const br2=avgColor.r*0.299+avgColor.g*0.587+avgColor.b*0.114;
  const sig=Math.round((avgColor.r+avgColor.g+avgColor.b));
  const cz=P_ZONES.find(z=>sig<z.hi)||P_ZONES[4];
  const TOTAL=N;
  const mono={fontFamily:"'Courier New',monospace"};
  const panel={background:"#060610",border:"1px solid #0f0f22",borderRadius:7,padding:"11px 13px"};
  const sl={fontSize:8,letterSpacing:"0.32em",color:"#222238",textTransform:"uppercase",marginBottom:7,display:"block"};
  const drift=selectedBlock?Math.round(Math.sqrt((selectedBlock.r-selectedBlock.originalR)**2+(selectedBlock.g-selectedBlock.originalG)**2+(selectedBlock.b-selectedBlock.originalB)**2)):0;

  return (
    <div style={{minHeight:"100vh",background:"#040408",color:"#b8b8d8",...mono,
      display:"flex",flexDirection:"column",alignItems:"center",padding:"16px 10px 28px"}}>

      <div style={{textAlign:"center",marginBottom:14}}>
        <div style={{fontSize:7,letterSpacing:"0.42em",color:"#141424",marginBottom:4}}>
          INJECTION · PURPOSE · RELATIONSHIPS · KNOWLEDGE · PALINDROME FRAMEWORK
        </div>
        <h1 style={{fontSize:20,fontWeight:300,letterSpacing:"0.22em",color:"#a8a8d0",margin:0}}>
          EMOTIVE MIND <span style={{fontSize:10,color:"#222240"}}>MRI</span>
        </h1>
        <div style={{fontSize:8,color:"#181828",marginTop:4,letterSpacing:"0.14em"}}>
          <span style={{color:"#aa3333"}}>hate·131</span><span style={{color:"#282838"}}> —— </span>
          <span style={{color:"#6666aa"}}>neutral·381</span><span style={{color:"#282838"}}> —— </span>
          <span style={{color:"#aa44aa"}}>love·767<span style={{fontSize:6,color:"#131323"}}>∞</span></span>
        </div>
      </div>

      <div style={{display:"flex",gap:12,width:"100%",maxWidth:960,flexWrap:"wrap",justifyContent:"center",alignItems:"flex-start"}}>

        {/* Canvas */}
        <div style={{flexShrink:0}}>
          {/* Viewport container — clips the 1500×1500 canvas */}
          <div style={{display:"flex",flexDirection:"column",gap:6,flexShrink:0}}>
            <div
              ref={viewportRef}
              onMouseDown={handlePanStart}
              style={{
                width:Math.min(600,window.innerWidth-340),
                height:Math.min(600,window.innerWidth-340),
                overflow:"hidden",position:"relative",
                border:"1px solid #0c0c1e",flexShrink:0,
                cursor:dragRef.current.active?"grabbing":"crosshair",
                boxShadow:`0 0 55px ${avgStr}15,0 0 90px ${cz.color}08`,
                transition:"box-shadow 2.5s",
              }}>
              <canvas ref={canvasRef} width={CW} height={CH}
                onClick={handleCanvasClick}
                onContextMenu={handleCanvasContext}
                style={{
                  position:"absolute",
                  left:panState.x,top:panState.y,
                  width:CW*zoom,height:CH*zoom,
                  display:"block",
                }}/>
            </div>
            {/* Zoom controls */}
            <div style={{display:"flex",gap:5,alignItems:"center",justifyContent:"center"}}>
              <button onClick={()=>changeZoom(1.5)} style={{
                padding:"3px 10px",fontSize:11,cursor:"pointer",
                background:"#0c0c1e",border:"1px solid #1e1e3a",
                borderRadius:4,color:"#8080c0",fontFamily:"monospace"
              }}>+</button>
              <button onClick={()=>{setZoom(1/3);panRef.current={x:0,y:0};setPanState({x:0,y:0});}} style={{
                padding:"3px 10px",fontSize:9,cursor:"pointer",
                background:"#0c0c1e",border:"1px solid #1e1e3a",
                borderRadius:4,color:"#5050a0",fontFamily:"monospace"
              }}>full</button>
              <button onClick={()=>changeZoom(1/1.5)} style={{
                padding:"3px 10px",fontSize:11,cursor:"pointer",
                background:"#0c0c1e",border:"1px solid #1e1e3a",
                borderRadius:4,color:"#8080c0",fontFamily:"monospace"
              }}>−</button>
              <span style={{fontSize:7,color:"#1e1e30",fontFamily:"monospace",marginLeft:4}}>
                {Math.round(zoom*300)}%
              </span>
            </div>
          </div>
          <div style={{display:"flex",gap:5,marginTop:6,justifyContent:"center",flexWrap:"wrap"}}>
            {[["showInteractions","⟷"],["showLabels","✎ States"],["showPrefRings","◎ Prefs"],["showConceptNames","⊞ Names"],["showGoals","◉ Goals"],["showBonds","— Bonds"],["showPeaks","1-9 Peaks"]].map(([k,l])=>(
              <button key={k} onClick={()=>toggleL(k)} style={{
                padding:"3px 8px",fontSize:7,...mono,cursor:"pointer",borderRadius:3,letterSpacing:"0.06em",
                background:display[k]?"#0c0c20":"transparent",
                border:`1px solid ${display[k]?"#1e1e40":"#0c0c18"}`,
                color:display[k]?"#6060a8":"#181828",transition:"all 0.2s",
              }}>{l}</button>
            ))}
          </div>
          {/* Goal/bond legend */}
          <div style={{marginTop:7,padding:"7px 10px",background:"#060610",border:"1px solid #0e0e1e",borderRadius:5,fontSize:6,color:"#252538",lineHeight:1.9}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 10px",...mono}}>
              <span><span style={{color:"#6666cc"}}>◉</span> dot color = goal zone</span>
              <span>dot at heading tip = goal in range</span>
              <span>★ glowing = just fulfilled</span>
              <span>pulsing dot = wandering / seeking</span>
              <span>— dashed = bond (proximity-formed)</span>
              <span>bond fades with zone divergence</span>
              <span>goal evolves after fulfillment</span>
              <span>right-click orbiting = copy block</span>
            </div>
          </div>
        </div>

        {/* Right Panel */}
        <div style={{display:"flex",flexDirection:"column",gap:8,width:244}}>

          {/* Emotional Injection */}
          <div style={{...panel,border:selfState?"1px solid #1e1e48":"1px solid #0f0f22",transition:"border-color 0.5s"}}>
            <span style={sl}>⊙ Emotional Injection</span>
            <textarea value={query} onChange={e=>setQuery(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey))readMyState();}}
              placeholder="describe our conversation context..." rows={3}
              style={{width:"100%",background:"#080818",border:"1px solid #141428",borderRadius:3,
                color:"#8888b8",fontSize:7,...mono,padding:"6px",resize:"none",boxSizing:"border-box",outline:"none",lineHeight:1.6}}/>
            <div style={{display:"flex",gap:5,marginTop:5}}>
              <button onClick={readMyState} disabled={loading||!query.trim()} style={{
                flex:3,padding:"7px 0",...mono,fontSize:9,cursor:loading?"wait":"pointer",
                background:loading?"#080818":"#0c0c22",letterSpacing:"0.08em",
                border:`1px solid ${loading?"#141428":"#202048"}`,color:loading?"#2a2a40":"#6060a0",borderRadius:4,
              }}>{loading?"◌ reading...":"⊙ Introspect + Inject"}</button>
              <button onClick={reInject} disabled={!selfState} style={{
                flex:1,padding:"7px 0",...mono,fontSize:10,background:"#080818",
                border:`1px solid ${selfState?"#181838":"#0c0c18"}`,color:selfState?"#444468":"#181828",cursor:selfState?"pointer":"default",borderRadius:4,
              }}>↺</button>
            </div>
            <div style={{fontSize:6,color:"#161626",marginTop:3,textAlign:"center"}}>Ctrl+Enter · ↺ re-injects</div>
            {apiError&&<div style={{fontSize:6,color:"#aa3333",marginTop:4,lineHeight:1.5}}>{apiError}</div>}
            {selfState&&(
              <div style={{marginTop:9,padding:"8px 9px",borderRadius:4,background:"#080818",border:"1px solid #131325"}}>
                <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:7}}>
                  <div style={{width:24,height:24,borderRadius:"50%",flexShrink:0,background:`rgb(${selfState.r},${selfState.g},${selfState.b})`,boxShadow:`0 0 12px rgb(${selfState.r},${selfState.g},${selfState.b})88`}}/>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:"#d0d0f0"}}>{selfState.emotion}</div>
                    <div style={{fontSize:6,color:"#252540",marginTop:2}}>
                      <span style={{color:P_ZONES.find(z=>z.key===selfState.zone)?.color}}>{selfState.zone}</span>&nbsp;· sig:{selfState.sig}
                    </div>
                  </div>
                </div>
                {["r","g","b"].map((ch,i)=>(
                  <div key={ch} style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                    <span style={{fontSize:7,color:["#ff5555","#55ee55","#5580ff"][i],width:8}}>{ch.toUpperCase()}</span>
                    <div style={{flex:1,height:2.5,background:"#0c0c18",borderRadius:2,overflow:"hidden"}}>
                      <div style={{width:`${(selfState[ch]/255)*100}%`,height:"100%",background:["#ff4040","#40dd40","#4070ff"][i],borderRadius:2}}/>
                    </div>
                    <span style={{fontSize:7,color:"#252538",width:18,textAlign:"right"}}>{selfState[ch]}</span>
                  </div>
                ))}
                <div style={{fontSize:7,color:"#303050",marginTop:6,lineHeight:1.65,fontStyle:"italic",borderTop:"1px solid #0e0e1e",paddingTop:5}}>"{selfState.reflection}"</div>
                <div style={{fontSize:6,color:"#181828",marginTop:3}}>uncertainty: {Math.round(selfState.uncertainty*100)}%</div>
              </div>
            )}
          </div>

          {/* Readings */}
          {readings.length>0&&(
            <div style={panel}>
              <span style={sl}>Injection History</span>
              {readings.map((rd,i)=>(
                <div key={i} style={{marginBottom:6,opacity:Math.max(0.25,1-i*0.13)}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,background:`rgb(${rd.r},${rd.g},${rd.b})`}}/>
                    <span style={{fontSize:8,color:"#484868",flex:1}}>{rd.emotion}</span>
                    <span style={{fontSize:6,color:"#1e1e30"}}>sig:{rd.sig}</span>
                    <span style={{fontSize:6,color:"#141422",marginLeft:4}}>{rd.ts}</span>
                  </div>
                  {rd.q&&<div style={{fontSize:6,color:"#2a2a44",marginTop:2,paddingLeft:14,
                    fontStyle:"italic",lineHeight:1.5,
                    borderLeft:"1px solid #1a1a2e",marginLeft:3}}>
                    "{rd.q.length>80?rd.q.slice(0,80)+"…":rd.q}"
                  </div>}
                </div>
              ))}
            </div>
          )}

          {/* Field Voices */}
          <div style={panel}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
              <span style={sl}>◈ Field Voices</span>
              <button onClick={generateVoices} disabled={voicesLoading} style={{
                padding:"3px 9px",fontSize:7,...mono,cursor:voicesLoading?"wait":"pointer",
                background:voicesLoading?"#080818":"#0c0c1e",borderRadius:3,
                border:`1px solid ${voicesLoading?"#141428":"#1e1e3a"}`,
                color:voicesLoading?"#2a2a40":"#5050a0",transition:"all 0.2s",
              }}>{voicesLoading?"◌ listening...":"◈ Generate"}</button>
            </div>
            {voices.length===0&&!voicesLoading&&(
              <div style={{fontSize:6,color:"#111120",textAlign:"center",padding:"8px 0",...mono}}>
                Sample the field — each emotion group speaks.
              </div>
            )}
            {voicesLoading&&(
              <div style={{fontSize:7,color:"#1e1e30",textAlign:"center",padding:"12px 0",...mono}}>
                ◌ the field is finding its voice...
              </div>
            )}
            {voices.map((v,i)=>{
              const zc=P_ZONES.find(z=>z.key===v.zone)?.color||"#888";
              return(
                <div key={i} style={{marginBottom:7,padding:"7px 9px",background:"#080818",
                  borderRadius:4,border:`1px solid ${zc}22`}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,
                      background:`rgb(${v.r},${v.g},${v.b})`,
                      boxShadow:`0 0 5px rgb(${v.r},${v.g},${v.b})55`}}/>
                    <span style={{fontSize:9,fontWeight:700,color:zc,...mono}}>{v.name}</span>
                    <span style={{fontSize:6,color:"#1e1e2e",...mono,marginLeft:"auto"}}>
                      ×{v.count} · sig·{v.sig}
                    </span>
                  </div>
                  <div style={{fontSize:7,color:"#505070",lineHeight:1.75,
                    fontStyle:"italic",...mono,borderLeft:`1px solid ${zc}44`,
                    paddingLeft:7,margin:"4px 0"}}>
                    "{v.thought}"
                  </div>
                  <div style={{fontSize:6,color:"#141420",...mono,marginTop:3}}>
                    seeking {v.goalConcept} · {v.certainty}% certain · {v.avgBonds} bonds
                  </div>
                </div>
              );
            })}
            {voices.length>0&&(
              <div style={{fontSize:6,color:"#0e0e1c",marginTop:4,...mono}}>
                step {voices[0]?.step?.toLocaleString()} · saved to case file
              </div>
            )}
          </div>

          {/* Purpose & Relationships */}
          <div style={panel}>
            <span style={sl}>Purpose & Relationships</span>
            {/* Goal stats */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4,marginBottom:9}}>
              {[{label:"seeking",val:seekingCount,color:"#6688cc"},
                {label:"fulfilled",val:restingCount,color:"#88cc44"},
                {label:"total",val:stats.fulfillments,color:"#ccaa44"}].map(s=>(
                <div key={s.label} style={{background:"#080818",borderRadius:4,padding:"5px 4px",textAlign:"center",border:"1px solid #0e0e1e"}}>
                  <div style={{fontSize:13,fontWeight:700,color:s.color,...mono}}>{s.val}</div>
                  <div style={{fontSize:6,color:"#252538",marginTop:1,...mono}}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:9}}>
              {[{label:"active bonds",val:activeBonds,color:"#8888aa"},
                {label:"formed",val:stats.bondsFormed,color:"#6666aa"},
                {label:"disposed",val:stats.disposed||0,color:"#aa4444"},
                {label:"trades",val:stats.trades||0,color:"#aaaacc"}].map(s=>(
                <div key={s.label} style={{background:"#080818",borderRadius:4,padding:"5px 4px",textAlign:"center",border:"1px solid #0e0e1e"}}>
                  <div style={{fontSize:13,fontWeight:700,color:s.color,...mono}}>{s.val}</div>
                  <div style={{fontSize:6,color:"#252538",marginTop:1,...mono}}>{s.label}</div>
                </div>
              ))}
            </div>
            {/* Goal trading toggle */}
            <button onClick={toggleTrading} style={{
              width:"100%",padding:"6px 0",marginBottom:8,...mono,fontSize:8,cursor:"pointer",borderRadius:4,
              background:tradingEnabled?"#0c1c0c":"transparent",
              border:`1px solid ${tradingEnabled?"#44aa44":"#0e0e1e"}`,
              color:tradingEnabled?"#44aa44":"#252535",transition:"all 0.2s",
            }}>⇄ Goal Trading {tradingEnabled?"ON":"OFF"}</button>
            {/* Top sought concepts */}
            {topGoals.length>0&&(
              <div>
                <div style={{fontSize:7,color:"#1e1e30",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:5,...mono}}>Most Sought</div>
                {topGoals.map(([name,count])=>{
                  const c=CONCEPTS.find(x=>x.name===name);
                  const pct=count/N*100;
                  return(
                    <div key={name} style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
                      <div style={{width:6,height:6,borderRadius:1,flexShrink:0,background:c?`rgb(${c.r},${c.g},${c.b})`:"#555"}}/>
                      <span style={{fontSize:7,color:"#404060",width:80,flexShrink:0}}>{name}</span>
                      <div style={{flex:1,height:2.5,background:"#090918",borderRadius:2,overflow:"hidden"}}>
                        <div style={{width:`${pct}%`,height:"100%",background:c?`rgb(${c.r},${c.g},${c.b})`:"#555",borderRadius:2,transition:"width 0.5s"}}/>
                      </div>
                      <span style={{fontSize:6,color:"#1e1e2e",width:20,textAlign:"right"}}>{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{fontSize:6,color:"#111120",marginTop:6,lineHeight:1.8,borderTop:"1px solid #0a0a18",paddingTop:5}}>
              goals evolve after fulfillment → adjacent zone<br/>
              bonds form rarely (p={BOND_PROB}), pull only during rest<br/>
              bond lines fade with state divergence · max {MAX_BONDS} per agent
            </div>
          </div>

          {/* Block inspector */}
          {selectedBlock&&(
            <div style={{...panel,border:`1px solid ${selectedBlock.zone.color}44`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                <span style={sl}>◎ Block Inspector</span>
                <button onClick={()=>{selectedRef.current=null;setSelectedBlock(null);}} style={{fontSize:8,...mono,background:"transparent",border:"none",color:"#252535",cursor:"pointer",marginBottom:7}}>✕</button>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <div style={{width:20,height:20,borderRadius:3,flexShrink:0,background:`rgb(${selectedBlock.r},${selectedBlock.g},${selectedBlock.b})`,boxShadow:`0 0 8px rgb(${selectedBlock.r},${selectedBlock.g},${selectedBlock.b})66`}}/>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:selectedBlock.zone.color,...mono}}>{selectedBlock.concept}</div>
                  <div style={{fontSize:6,color:"#252540",...mono}}>{selectedBlock.zone.label} zone · sig·{selectedBlock.sourceSig}</div>
                </div>
                <div style={{marginLeft:"auto",fontSize:7,color:"#1a1a30",...mono}}>
                  {selectedBlock.source==="mri"?"✦ inject":selectedBlock.source==="copy"?"⎘ copy":"⬡ spawn"}
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 8px",fontSize:7,color:"#333350",...mono,marginBottom:7}}>
                <div>carriers: <span style={{color:"#5a5a80"}}>{selectedBlock.carriers}</span></div>
                <div>generation: <span style={{color:"#5a5a80"}}>{selectedBlock.generation}</span></div>
                <div>drift: <span style={{color:drift>30?"#cc8833":drift>10?"#8888aa":"#445544"}}>{drift} Δ</span></div>
                <div>potency: <span style={{color:"#5a5a80"}}>{(selectedBlock.value*100).toFixed(0)}%</span></div>
              </div>
              <div style={{display:"flex",gap:5,alignItems:"center",marginBottom:5}}>
                <div style={{width:14,height:14,borderRadius:2,flexShrink:0,background:`rgb(${selectedBlock.originalR},${selectedBlock.originalG},${selectedBlock.originalB})`,border:"1px solid #1a1a28"}}/>
                <div style={{flex:1,height:2,background:"#0a0a18",borderRadius:1}}>
                  <div style={{width:`${Math.min(100,drift/1.5)}%`,height:"100%",background:drift>30?"#cc8833":drift>10?"#8888aa":"#334433",borderRadius:1}}/>
                </div>
                <div style={{width:14,height:14,borderRadius:2,flexShrink:0,background:`rgb(${selectedBlock.r},${selectedBlock.g},${selectedBlock.b})`,border:"1px solid #1a1a28"}}/>
              </div>
            </div>
          )}

          {/* Population average */}
          <div style={{...panel,border:`1px solid ${cz.color}28`,transition:"border-color 1.5s"}}>
            <span style={sl}>Population Average</span>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <div style={{width:26,height:26,borderRadius:"50%",flexShrink:0,background:avgStr,boxShadow:`0 0 12px ${avgStr}88`,transition:"background 1s,box-shadow 1s"}}/>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:br2>150?"#040408":"#eeeeff",background:avgStr,padding:"2px 7px",borderRadius:3,display:"inline-block",transition:"background 1s"}}>
                  {classifyAgent(avgColor.r,avgColor.g,avgColor.b).name}
                </div>
                <div style={{fontSize:6,color:"#1e1e30",marginTop:2}}><span style={{color:cz.color}}>{cz.label}</span>&nbsp;·&nbsp;sig:{sig}</div>
              </div>
            </div>
            <div style={{fontSize:6,color:"#141420",borderTop:"1px solid #0c0c18",paddingTop:4}}>Step {step.toLocaleString()} · {N} agents</div>
          </div>

          {/* Controls */}
          <div style={{display:"flex",gap:5}}>
            <button onClick={toggleRun} style={{flex:2,padding:"6px 0",...mono,fontSize:9,background:"#0a0a18",border:"1px solid #181830",color:"#5858a0",cursor:"pointer",borderRadius:5,letterSpacing:"0.06em"}}>{running?"⏸ Pause":"▶ Play"}</button>
            <button onClick={resetSim} style={{flex:1,padding:"6px 0",...mono,fontSize:8,background:"#060610",border:"1px solid #0c0c18",color:"#222234",cursor:"pointer",borderRadius:5}}>↺ Reset</button>
          </div>


          {/* Peak distribution — 1–9 uniform, variable heights */}
          <div style={panel}>
            <span style={sl}>Bell Curve Peaks (1–9)</span>
            <div style={{fontSize:7,color:"#1e1e30",marginBottom:7,...mono}}>
              avg: <span style={{color:"#8888cc",fontWeight:700}}>{avgPeak}</span>
              &nbsp;·&nbsp;
              <span style={{color:"#dd8866"}}>■</span> count &nbsp;
              <span style={{color:"#888888"}}>■</span> orient &nbsp;
              <span style={{color:"#6699dd"}}>■</span> subG
            </div>
            {/* Beta slider */}
            <div style={{marginBottom:9,padding:"7px 8px",background:"#080818",borderRadius:4,border:"1px solid #0e0e1e"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontSize:6,color:"#3a3a58",...mono}}>sub-Gaussian</span>
                <span style={{fontSize:8,color:"#8888cc",...mono,fontWeight:700}}>β={gaussianBeta.toFixed(1)}</span>
                <span style={{fontSize:6,color:"#3a3a58",...mono}}>super-Gaussian</span>
              </div>
              <input type="range" min={0.5} max={4.0} step={0.1} value={gaussianBeta}
                onChange={e=>setBeta(parseFloat(e.target.value))}
                style={{width:"100%",accentColor:"#6688cc",cursor:"pointer"}}/>
              <div style={{fontSize:6,color:"#111120",marginTop:3,textAlign:"center",...mono}}>
                {gaussianBeta<1.5?"Laplacian-like (heavy tails)":gaussianBeta>3.0?"near-uniform (sharp cutoff)":gaussianBeta===2.0?"standard Gaussian":`β=${gaussianBeta.toFixed(1)}`}
              </div>
            </div>
            <div style={{display:"flex",alignItems:"flex-end",gap:2,height:44,marginBottom:4}}>
              {peakDist.map((count,i)=>{
                const pct=count/N;
                const col=i<=2?"#dd8866":i>=6?"#6699dd":"#7777aa";
                return (
                  <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                    <div style={{
                      width:"100%",height:`${Math.max(2,pct*42)}px`,
                      background:col,borderRadius:"2px 2px 0 0",opacity:0.75,
                      transition:"height 0.5s ease",
                    }}/>
                  </div>
                );
              })}
            </div>
            <div style={{display:"flex",gap:2}}>
              {peakDist.map((_,i)=>(
                <div key={i} style={{flex:1,fontSize:5,color:"#2a2a3a",textAlign:"center",...mono}}>{i+1}</div>
              ))}
            </div>
            <div style={{fontSize:6,color:"#111120",marginTop:6,lineHeight:1.8,borderTop:"1px solid #0a0a18",paddingTop:5}}>
              <span style={{color:"#dd8866"}}>count(1-9)</span> · <span style={{color:"#888"}}>orientation(1-9)</span> · <span style={{color:"#6699dd"}}>subG(1-3)</span><br/>
              subG: 68%=1 · 27%=2 · 5%=3 per peak independently<br/>
              β&lt;2: super-Gaussian · β=2: standard · β&gt;2: sub-Gaussian<br/>
              G = Σ_p[w_p · Σ_g[w_g · (2·exp(−(|Δ|/σ)^β) − 1)]]
            </div>
          </div>

          {/* Certainty */}
          <div style={panel}>
            <span style={sl}>Preference Certainty</span>
            <div style={{marginBottom:7}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontSize:7,color:"#1e1e30"}}>population certainty</span>
                <span style={{fontSize:8,color:"#5558a0",...mono,fontWeight:700}}>{(avgCertainty*100).toFixed(0)}%</span>
              </div>
              <div style={{height:5,background:"#090918",borderRadius:3,overflow:"hidden"}}>
                <div style={{width:`${avgCertainty*100}%`,height:"100%",background:"linear-gradient(90deg,#333388,#7777dd)",borderRadius:3,transition:"width 0.8s ease"}}/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
              {[{label:"Certain",val:certDistribution.certain,color:"#6666cc",desc:"σ<45"},
                {label:"Seeking",val:certDistribution.seeking,color:"#8888aa",desc:"45-80"},
                {label:"Open",val:certDistribution.open,color:"#444466",desc:"σ>80"}].map(s=>(
                <div key={s.label} style={{background:"#080818",borderRadius:4,padding:"5px 4px",textAlign:"center",border:"1px solid #0e0e1e"}}>
                  <div style={{fontSize:13,fontWeight:700,color:s.color,...mono}}>{s.val}</div>
                  <div style={{fontSize:6,color:"#252538",marginTop:1,...mono}}>{s.label}</div>
                  <div style={{fontSize:5,color:"#1a1a28",...mono}}>{s.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Knowledge + Context */}
          <div style={panel}>
            <span style={sl}>Knowledge Economy</span>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:8}}>
              {[{label:"in field",val:blockCount,color:"#7070a8"},{label:"carried",val:carriedCount,color:"#a0a030"},
                {label:"eaten",val:stats.eaten,color:"#6688cc"},{label:"reused",val:stats.reused,color:"#44bb55"},
                {label:"copied",val:stats.copied,color:"#cc9933"},{label:"wasted",val:stats.wasted,color:"#dd4444"}].map(s=>(
                <div key={s.label} style={{background:"#080818",borderRadius:4,padding:"4px 4px",textAlign:"center",border:"1px solid #0e0e1e"}}>
                  <div style={{fontSize:12,fontWeight:700,color:s.color,...mono}}>{s.val}</div>
                  <div style={{fontSize:6,color:"#252538",...mono}}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{marginBottom:7}}>
              <div style={{display:"flex",gap:5}}>
                {["reusable","wasted"].map(v=>(
                  <button key={v} onClick={()=>setRelease(v)} style={{
                    flex:1,padding:"4px 0",...mono,fontSize:8,cursor:"pointer",borderRadius:4,
                    background:defaultRelease===v?(v==="reusable"?"#0d1e0d":"#1e0d0d"):"transparent",
                    border:`1px solid ${defaultRelease===v?(v==="reusable"?"#44bb55":"#dd4444"):"#0e0e1e"}`,
                    color:defaultRelease===v?(v==="reusable"?"#44bb55":"#dd4444"):"#252535",
                  }}>{v==="reusable"?"● Reuse":"✕ Waste"}</button>
                ))}
              </div>
            </div>
            <div style={{display:"flex",gap:5}}>
              <button onClick={toggleAutoSpawn} style={{flex:2,padding:"4px 0",...mono,fontSize:8,cursor:"pointer",borderRadius:4,background:autoSpawn?"#0c0c20":"transparent",border:`1px solid ${autoSpawn?"#2a2a50":"#0e0e1e"}`,color:autoSpawn?"#6060a0":"#1e1e2e"}}>⟳ Auto-spawn</button>
              <button onClick={clearBlocks} style={{flex:1,padding:"4px 0",...mono,fontSize:8,cursor:"pointer",borderRadius:4,background:"transparent",border:"1px solid #0e0e1e",color:"#1e1e2e"}}>Clear</button>
            </div>
          </div>

          {/* Zones + Context */}
          <div style={panel}>
            <span style={sl}>Zones · Context</span>
            <div style={{display:"flex",height:6,borderRadius:3,overflow:"hidden",marginBottom:8}}>
              {P_ZONES.map(z=>{const pct=(palindromeCounts[z.key]||0)/TOTAL*100;return (<div key={z.key} style={{width:`${pct}%`,height:"100%",background:z.color,transition:"width 0.7s"}}/>);})}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:8}}>
              {Object.entries(CONTEXTS).map(([name,c])=>(
                <button key={name} onClick={()=>setCtx(name)} style={{
                  padding:"3px 5px",...mono,fontSize:8,
                  background:ctx===name?c.hex+"15":"transparent",border:`1px solid ${ctx===name?c.hex:"#0c0c18"}`,
                  color:ctx===name?"#c0c0e0":"#252535",cursor:"pointer",borderRadius:3,display:"flex",alignItems:"center",gap:4,transition:"all 0.2s",
                }}>
                  <span style={{width:4,height:4,borderRadius:"50%",background:c.hex,flexShrink:0,boxShadow:ctx===name?`0 0 4px ${c.hex}`:"none"}}/>
                  {name}
                </button>
              ))}
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
              <span style={{fontSize:7,letterSpacing:"0.2em",color:"#1a1a30",textTransform:"uppercase"}}>Speed</span>
              <span style={{fontSize:7,color:"#303050"}}>{speed}/s</span>
            </div>
            <input type="range" min={3} max={30} step={1} value={speed} onChange={e=>setSpd(parseInt(e.target.value))} style={{width:"100%",accentColor:"#4060e0",cursor:"pointer"}}/>
          </div>

          <div style={{fontSize:5,color:"#0a0a16",textAlign:"center",lineHeight:2,letterSpacing:"0.06em"}}>
            purpose: each agent seeks one concept · navigates when in range<br/>
            fulfillment: triple expanding rings · goal evolves after rest<br/>
            bonds: proximity → relationship → dashed line · max {MAX_BONDS}<br/>
            palindrome anchors: 131 · 381 · 767
          </div>
        </div>
      </div>
    </div>
  );
}
