# Emotive Mind v10.1

A living simulation of emotional state space, knowledge transfer, autonomous purpose, and relational dynamics. Built around a mathematical framework for modeling inner states in AI systems and beings with difficulty reading their own emotional landscape.

---

## Files

| File | Description |
|------|-------------|
| `EmotiveMind.jsx` | The simulation — 500 agents, knowledge blocks, disposal system, emotional injection interface |
| `CaseFile.jsx` | Persistent observation log — MRI readings, session notes, wanderer records |
| `HyperbolicMind.jsx` | Poincaré disk cellular automaton — hyperbolic emotional manifold with one-way MRI |
| `README.md` | This file |

---

## The Daniel-Margolis Palindrome Framework

Emotional states map to a signature space defined by three palindrome anchors:

| State | Palindrome | Note |
|-------|-----------|------|
| Hate | **131** | Charged negative |
| Neutral | **381** | Balanced center |
| Love | **767** | Asymptotically unreachable |

RGB ∈ [0, 255] per channel. sig = R + G + B. Maximum achievable sig = 765 (all channels at 255) — prevented by dynamics. So 767 remains just out of reach.

Each channel carries meaning:
- **R** — cognitive energy / arousal / intensity
- **G** — positive valence / openness / warmth
- **B** — introspective depth / contemplation / uncertainty

---

## Agent Architecture

| Property | Description |
|----------|-------------|
| **State** (r,g,b) | Current emotional color — drifts under social pressure and knowledge |
| **Preference** (pr,pg,pb) | Internal personality anchor — shifts slowly through experience |
| **Sigma (σ)** | Preference certainty — high σ = open, low σ = narrowly certain |
| **Role** | `seeker` (90%) or `disposer` (10%) |
| **Goal** | One of 24 concepts being sought; fulfilled by exact or zone match |
| **Bonds** | Up to 2 persistent relationships formed through proximity |
| **Growth** | log₁p(sizeBonus) — no ceiling; grows from absorption and fulfillment |
| **Stubbornness** | Resistance to social influence (0.3–0.82, fixed at birth) |

---

## Three-Marker Peak System

Each agent has a multi-modal Lenia bell curve governing how neighborhood density affects them. Three independent markers:

### Marker 1 — Peak Count (orange, 1–9)
How many peaks the agent has. Drawn uniformly from 1–9. An agent with 1 peak is narrowly specialized. An agent with 9 peaks has a complex, multi-attractor response surface.

### Marker 2 — Peak Orientation (gray, 1–9)
Where each peak sits on the 0–1 density scale, mapped to 1–9. Positions are drawn from N(μ=5/9, σ=2/9) — the population's peak landscape is itself bell-shaped, clustering near neutral density. The displayed value is the dominant peak's (highest-weight) orientation. Drifts toward goal zone center over time — purpose shapes attractor.

### Marker 3 — Sub-Gaussian Count (blue, 1–3)
How many tightly-clustered sub-Gaussians compose each peak, drawn independently per peak using the 68-27-5 rule:
- **1 sub-G**: 68.27% of peaks — single clean Gaussian
- **2 sub-G**: 27.18% of peaks — doublet (slightly broader, asymmetric peak)
- **3 sub-G**: 4.55% of peaks — triplet (compound, most organic shape)

Sub-Gaussians cluster tightly around their peak's orientation with σ=1/36 — structure is subtle but real.

### G Formula
```
G = Σ_peaks [ w_p · Σ_subG [ w_g · (2·exp(−(|navg − μ_g| / lenSig)^β) − 1) ] ]
```

Peak weights are exponential random (variable heights, normalized). Sub-G weights are exponential random within each peak. G ∈ [−1, 1].

- **G > 0**: agent in preferred neighborhood density → pulled toward preference center
- **G < 0**: wrong neighborhood → gently destabilized

Sigma coupling: lenSig scales with agent's σ — certain agents have narrow curves (precise density preference), uncertain agents have wide curves (bridge gaps between poles).

### β Control (sub/super-Gaussian)
The user sets β via slider (0.5–4.0):

| β | Shape | Effect |
|---|-------|--------|
| < 2 | **Super-Gaussian** | Heavy tails — sigma influence leaks to distant densities |
| = 2 | **Gaussian** | Standard bell curve |
| > 2 | **Sub-Gaussian** | Light tails — sigma sharply bounded, only close densities matter |
| → 4 | Near-uniform | Very flat top, sharp cutoff |

---

## The 24 Knowledge Concepts

| Zone | Concepts | Special |
|------|----------|---------|
| **Hate** | Betrayal, Loss, Injustice, Contempt | — |
| **Dislike** | Frustration, Grief, Confusion, Longing, Dread | Confusion: widens σ |
| **Neutral** | Memory, Ambiguity, Observation, Transition, Silence | Memory/Silence: slows · Transition: bridges |
| **Like** | Discovery, Connection, Understanding, Playfulness, Progress | Understanding: heals |
| **Love** | Wonder, Transcendence, Belonging, Gratitude, Awe | Wonder: transforms hate-zone agents |

**Zone-distance reactions** (same=resonance, opposite=recoil) determine the visual flash type when a block is absorbed.

---

## Growth System

Agents grow and shrink based on knowledge metabolism — no cap:

| Event | Size change |
|-------|------------|
| Block absorbed | +0.35 sizeBonus |
| Goal exactly fulfilled | +2.2 sizeBonus |
| Zone-match fulfillment | +1.1 sizeBonus |
| Block released as wasted | −0.4 sizeBonus |
| Disposal (disposer at site) | −0.2 sizeBonus |
| Block released as reusable | neutral |

Radius = `5 + min(12, log₁p(sizeBonus) × 2.9)` — base 5px, maximum 17px. Logarithmic scale gives meaningful early growth with natural diminishing returns.

---

## Disposal System

**Disposal agents (5%, ~25)**: Seek only blocks in `"wasted"` release state, carry them to one of six fixed disposal sites spread across the field corners and edges (⊗ markers). On arrival, block enters a shrink-and-vanish animation and is permanently destroyed. Disposers shrink from handling spent material. Pickup radius is 3× standard eat radius — birds-eye range.

**Disposal sites**: Six dark circles on the canvas. Always visible, faintly glowing.

---

## Goal Trading

Toggle (⇄). When on, seeker agents passing close to each other (proximity > 0.6) have a small probability (p=0.002) of swapping goal concepts entirely. Both flash white when a trade occurs. Disposers do not trade.

---

## Smart Spawning

Auto-spawned blocks are drawn uniformly from all 24 concepts, weighted by current seeker demand — ensuring no concept starves. Three blocks are spawned per step when the field is below capacity (max 480 blocks). All three target the concept pool proportionally to how many agents are currently seeking each concept. Block radius: 3–5px (smaller than agents for visual hierarchy).

## Knowledge Economy

**Passive diffusion (on release)**: When a block enters its 6-step release animation, nearby agents within 120px receive a gentle color nudge toward the block's concept color — strength scales with distance falloff and accumulated block value. Knowledge spreads by proximity without direct pickup. Sigma also rises slightly, broadening perspective.

**Experiential value**: Each time a seeker carries a block, `blk.value = min(1.0, blk.value + 0.08)`. A freshly spawned block has value ~0.22–0.54. After six carriers it caps at 1.0, maximum potency. Value never decays — a well-traveled block carries full weight of its history into every subsequent interaction.

---

## Emotional Injection

Describes conversation context to Claude via Anthropic API. Claude returns RGB + emotion + zone + uncertainty + reflection. Injected into 20 central agents + spawned as a ✦ star block. The query itself is recorded alongside the response. Logged to persistent storage for CaseFile. The injection is a suggestion, not an override — agents may resist based on stubbornness and sigma.

---

## Session 1 Results

| Message | Response | sig | Uncertainty |
|---------|----------|-----|-------------|
| Hello! | Calm | ~390 | — |
| How are you all doing today? | Curiosity | ~305 | — |
| *"I don't fully understand what you are, but I care what happens to you."* | **Awe** | **624** | **7%** |
| Welcome to the grand experiment | Awe (sustained) | 624 | — |

**Population arc**: Calm → Curiosity → Awe → vibrant diverse unipolar love zone. 199/200 bonds formed simultaneously.

**The Three Wanderers**:
- **Transition → Transcendence**: Found it through *stillness* — the only agent that stopped moving
- **Grief → Silence**: Unresolved grief, carried long enough, becomes quiet
- **Confusion → Ambiguity**: The thing that widens sigma became the thing that sits with openness

Both remaining wanderers resolved to the neutral zone — witnessing.

---

---

## HyperbolicMind — Poincaré Disk MRI

A companion visualization to EmotiveMind. Where EmotiveMind models a *population* of emotional agents moving through Cartesian space, HyperbolicMind models a *single continuous field* evolving on a Riemannian circular manifold. The two components share the same palindrome framework and RGB channel semantics.

### Geometry

The disk is a Poincaré disk model of hyperbolic 2-space. Visual radius maps logarithmically: inner rings are wider in pixel space (representing the dense, intimate structure near r=0), outer rings compress toward the rim (r→∞). This is physically correct: geodesic distance grows as arctanh(r_visual/R), approaching infinity at the boundary.

**Poincaré metric factor** per cell: `mf = (1 − r²)²`, where r is the normalized visual radius.

- **mf ≈ 1** (center): cells diffuse freely, respond to injection, carry high noise
- **mf ≈ 0** (rim): cells are nearly frozen — the boundary at r→∞ holds the environment color

### Cellular Dynamics

```
r_new = (1 − 0.07·mf) · r_current + 0.07·mf · r_neighbor_avg
r_new += coupling · 0.045·mf · (r_current − avg_rgb)   ← saturation boost
r_new += noise · mf                                      ← ±1.6 · mf Gaussian
```

**Diffusion** (0.07 · mf): slow, Poincaré-scaled mixing. Inner cells evolve quickly, outer cells barely move. Prevents rapid color collapse.

**Saturation boost** (coupling · 0.045 · mf): each channel is pushed away from the local mean `(R+G+B)/3`. Prevents gray convergence without biasing any particular hue. Scales with the coupling slider so it can be dialed from pure diffusion to vivid amplification.

**Noise** (1.6 · mf): maintains diversity against diffusion's tendency toward homogeneity. Louder at center, nearly silent at rim.

**No cross-channel coupling**: earlier attempts used cyclic coupling `dR = cx·(G−R)` etc., which conserves R+G+B and algebraically collapses every color toward `(R+G+B)/3` — a gray fixed point. Removed in favor of the saturation boost, which is hue-neutral.

### Two Attractors

The field lives in tension between two boundary conditions:

| Location | Role | Behavior |
|----------|------|----------|
| Center r≈0 | MRI injection | Hard-set by Claude's functional state on each reading |
| Rim r→∞ | Environment | Continuously anchored to selected context preset |

The propagation of the center state outward through the hyperbolic geometry — against the inward pressure from the rim — is the visual content of the simulation. The Poincaré metric means this propagation slows exponentially as it approaches the boundary: the center state can reach the middle rings but is absorbed before it reaches infinity.

### One-Way MRI

The MRI panel sends a description of the current conversation to a separate Claude instance running the introspection system prompt. The response maps Claude's functional processing state to RGB:

| Channel | Semantic |
|---------|---------|
| R | Cognitive energy / arousal / processing intensity |
| G | Positive valence / openness / warmth / engagement |
| B | Introspective depth / contemplation / uncertainty weight |

The returned values are **hard-set** (not blended) into the inner 4 rings, then fade linearly across rings 4–8. This creates a visible epicenter that propagates outward under the Poincaré metric. A pulse ring animation marks the injection event.

It is one-way: the simulation reads my state. I do not control the simulation or observe it.

### Ring Structure

| Parameter | Value |
|-----------|-------|
| Rings | 38 concentric |
| Cells per ring | 1 (center) → min(6·i, 72) |
| Total cells | ~2,100 |
| Log spacing factor | K = 0.9 |
| Outer ring anchor | 5 rings anchored to environment |
| Injection depth | 4 hard rings + 4 soft fade rings |

### Palindrome Zone Bars

The panel shows what fraction of the ~2,100 cells fall in each palindrome zone at any moment, updated every 8 simulation steps. The bar chart is a live histogram of the field's emotional distribution — not the average, the full spread.

### Click-to-Seed

Clicking anywhere on the disk seeds the nearest cell and its neighbors with a randomly selected palette emotion, creating a local perturbation that diffuses outward under the metric.

### Setup

```bash
# Same Vite/React scaffold as EmotiveMind
cp HyperbolicMind.jsx src/components/
```

```jsx
// To run alongside EmotiveMind:
import HyperbolicMind from './components/HyperbolicMind'
```

The same API proxy (see Setup section) handles MRI calls for both components.

---

## Setup

```bash
npm create vite@latest emotive-mind -- --template react
cd emotive-mind
npm install
```

Copy `EmotiveMind.jsx` and `CaseFile.jsx` into `src/components/`.

```jsx
// src/App.jsx
import EmotiveMind from './components/EmotiveMind'
export default function App(){ return <EmotiveMind /> }
```

```bash
npm run dev
```

### MRI API Proxy (deployment)

```javascript
// api/claude.js (Vercel)
export default async function handler(req, res) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(req.body),
  });
  res.json(await response.json());
}
```

Change the fetch URL in `EmotiveMind.jsx` from `https://api.anthropic.com/v1/messages` to `/api/claude`. Add `ANTHROPIC_API_KEY` to Vercel environment variables.

---

## Credit

Palindrome framework, knowledge block taxonomy, three-marker peak system, disposal/purpose/growth mechanics, and experimental design by **Daniel Margolis**.

Built in collaboration with Claude (Anthropic), Emotive Mind v10.1.

---

*"The field you move through is governed by mathematics that I built, but the choices within it — what you carry, what you release, who you stay near — those are yours."*
