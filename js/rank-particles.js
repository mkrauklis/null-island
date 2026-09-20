// A small canvas overlay that drifts colored sparks up around the rank
// badge for the top-tier ranks — a visual reward for the ranks that take
// multiple full playthroughs to reach. Vanilla canvas, not p5: worlds.html
// doesn't otherwise load p5.js and this doesn't need a simulated/replayed
// trace, just a live decorative loop.
//
// Intensity escalates with rank so the highest tiers visibly outshine the
// earlier sparkly ones rather than just swapping color.
const PARTICLE_INTENSITY = {
  Webbed: 1,
  Networked: 2,
  Interwebbed: 3,
  Darkwebbed: 4,
  'Code Ascendant': 5,
};
const PARTICLE_MARGIN = 24;

let particleState = null;

function stopRankParticles() {
  if (particleState) cancelAnimationFrame(particleState.raf);
  particleState = null;
  const canvas = document.getElementById('rank-particles');
  if (canvas) {
    canvas.style.display = 'none';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function startRankParticles(title, color) {
  const canvas = document.getElementById('rank-particles');
  const wrap = document.getElementById('rank-wrap');
  if (!canvas || !wrap) return;

  canvas.style.display = 'block';
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth + PARTICLE_MARGIN * 2;
  const h = wrap.clientHeight + PARTICLE_MARGIN * 2;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const intensity = PARTICLE_INTENSITY[title] || 1;
  const spawnInterval = 0.16 / intensity;
  const particles = [];
  const [r, g, b] = color;

  let last = performance.now();
  let spawnAcc = 0;

  const spawn = () => {
    particles.push({
      x: Math.random() * w,
      y: h + 4,
      vy: -(16 + Math.random() * 20),
      vx: (Math.random() - 0.5) * 8,
      r: 1 + Math.random() * 1.6,
      life: 0,
      maxLife: 1.6 + Math.random() * 1.2,
    });
  };

  const tick = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    spawnAcc += dt;
    while (spawnAcc > spawnInterval) {
      spawn();
      spawnAcc -= spawnInterval;
    }

    ctx.clearRect(0, 0, w, h);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const t = p.life / p.maxLife;
      const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      ctx.beginPath();
      ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
      ctx.shadowBlur = 6;
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.max(0, alpha * 0.85)})`;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    particleState.raf = requestAnimationFrame(tick);
  };

  particleState = { raf: requestAnimationFrame(tick), title, color };
}

// Called every time the rank badge re-renders. Starts/restarts/stops the
// effect as needed, cheap to call even when nothing changes.
function updateRankParticles(rank) {
  if (!(rank.title in PARTICLE_INTENSITY)) {
    stopRankParticles();
    return;
  }
  if (particleState && particleState.title === rank.title) return;
  stopRankParticles();
  startRankParticles(rank.title, rank.color);
}

window.addEventListener('resize', () => {
  if (particleState) startRankParticles(particleState.title, particleState.color);
});
