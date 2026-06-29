/* =========================================================
   Sakura Dash
   Vanilla canvas runner + leaderboard wiring (no frameworks)
   ========================================================= */

(() => {
  "use strict";

  /* ---------- config ---------- */
  // Same-origin by default. If you deploy the API elsewhere, change this.
  const API_BASE = window.SAKURA_API_BASE || "/api";
  const LOCAL_BEST_KEY = "sakuraDash.best";
  const LOCAL_RUNS_KEY = "sakuraDash.myRuns";
  const MAX_LOCAL_RUNS = 10;

  const GROUND_Y = 320;        // y of the ground line, in canvas coords
  const GRAVITY = 0.0026;      // px/ms^2 (canvas units)
  const JUMP_VELOCITY = -1.05; // px/ms initial jump speed
  const HOLD_GRAVITY_SCALE = 0.55; // lighter gravity while holding = higher jump
  const BASE_SPEED = 0.34;     // px/ms world scroll speed at score 0
  const MAX_SPEED = 0.95;
  const SPEED_RAMP = 0.000018; // speed gain per ms survived

  /* ---------- DOM refs ---------- */
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const sky = document.getElementById("sky");

  const hudScoreEl = document.getElementById("hudScore");
  const hudBestEl = document.getElementById("hudBest");

  const startOverlay = document.getElementById("startOverlay");
  const startBtn = document.getElementById("startBtn");

  const overOverlay = document.getElementById("overOverlay");
  const finalScoreEl = document.getElementById("finalScore");
  const newBestBadge = document.getElementById("newBestBadge");
  const retryBtn = document.getElementById("retryBtn");

  const nameForm = document.getElementById("nameForm");
  const nameInput = document.getElementById("nameInput");
  const saveBtn = document.getElementById("saveBtn");
  const saveStatus = document.getElementById("saveStatus");

  const leaderboardList = document.getElementById("leaderboardList");
  const myScoresList = document.getElementById("myScoresList");
  const apiStatusEl = document.getElementById("apiStatus");

  /* ---------- logical canvas size (internal resolution) ---------- */
  const VW = canvas.width;   // 900
  const VH = canvas.height;  // 380

  /* ---------- state ---------- */
  let running = false;
  let lastTs = 0;
  let elapsedMs = 0;
  let score = 0;
  let best = Number(localStorage.getItem(LOCAL_BEST_KEY) || 0);
  let speed = BASE_SPEED;
  let obstacles = [];
  let petals = [];
  let nextObstacleAt = 0;
  let groundScrollX = 0;
  let dayPhase = 0; // 0 = day .. 1 = night, drives sky + colors

  hudBestEl.textContent = String(best);

  const player = {
    x: 110,
    y: GROUND_Y,
    w: 46,
    h: 58,
    vy: 0,
    onGround: true,
    holding: false,
    runFrame: 0,
    squashT: 0,
  };

  /* ---------- input ---------- */
  function pressJump() {
    if (!running) return;
    if (player.onGround) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      player.squashT = 1; // little anticipation squash
    }
    player.holding = true;
  }
  function releaseJump() {
    player.holding = false;
  }

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") {
      e.preventDefault();
      if (!running && !startOverlay.classList.contains("overlay--hidden")) {
        startGame();
      } else {
        pressJump();
      }
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") releaseJump();
  });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!running) return;
    pressJump();
  });
  canvas.addEventListener("pointerup", releaseJump);
  canvas.addEventListener("pointercancel", releaseJump);
  canvas.addEventListener("pointerleave", releaseJump);

  startBtn.addEventListener("click", startGame);
  retryBtn.addEventListener("click", () => {
    overOverlay.classList.add("overlay--hidden");
    startGame();
  });

  /* ---------- game lifecycle ---------- */
  function resetState() {
    score = 0;
    elapsedMs = 0;
    speed = BASE_SPEED;
    obstacles = [];
    nextObstacleAt = 900;
    player.y = GROUND_Y;
    player.vy = 0;
    player.onGround = true;
    player.holding = false;
    dayPhase = 0;
    updateSkyClass();
    hudScoreEl.textContent = "0";
    seedPetals();
  }

  function seedPetals() {
    petals = Array.from({ length: 14 }, () => ({
      x: Math.random() * VW,
      y: Math.random() * (VH * 0.6),
      r: 2 + Math.random() * 3,
      drift: 0.3 + Math.random() * 0.6,
      sway: Math.random() * Math.PI * 2,
    }));
  }

  function startGame() {
    resetState();
    startOverlay.classList.add("overlay--hidden");
    overOverlay.classList.add("overlay--hidden");
    running = true;
    lastTs = performance.now();
    requestAnimationFrame(loop);
  }

  function endGame() {
    running = false;
    const finalScoreVal = Math.floor(score);
    finalScoreEl.textContent = String(finalScoreVal);

    let isNewBest = false;
    if (finalScoreVal > best) {
      best = finalScoreVal;
      localStorage.setItem(LOCAL_BEST_KEY, String(best));
      hudBestEl.textContent = String(best);
      isNewBest = true;
    }
    newBestBadge.hidden = !isNewBest;

    saveStatus.textContent = "";
    saveStatus.className = "name-form__status";
    nameInput.value = localStorage.getItem("sakuraDash.lastName") || "";
    overOverlay.classList.remove("overlay--hidden");

    // Save locally regardless of whether they submit to the global board
    saveLocalRun(finalScoreVal);
    renderMyScores();
  }

  /* ---------- main loop ---------- */
  function loop(ts) {
    if (!running) return;
    const dt = Math.min(40, ts - lastTs); // clamp dt to avoid big jumps on tab-back
    lastTs = ts;
    elapsedMs += dt;

    update(dt);
    draw();

    requestAnimationFrame(loop);
  }

  function update(dt) {
    // difficulty ramp
    speed = Math.min(MAX_SPEED, BASE_SPEED + elapsedMs * SPEED_RAMP);

    // score = distance survived
    score += dt * speed * 0.06;
    hudScoreEl.textContent = String(Math.floor(score));

    // day -> dusk -> night over ~2200 score points, then loop softly
    dayPhase = (Math.floor(score) % 2200) / 2200;
    updateSkyClass();

    // ground scroll
    groundScrollX -= dt * speed;
    if (groundScrollX <= -40) groundScrollX += 40;

    // player physics
    const g = GRAVITY * (player.holding && player.vy < 0 ? HOLD_GRAVITY_SCALE : 1);
    player.vy += g * dt;
    player.y += player.vy * dt;
    if (player.y >= GROUND_Y) {
      player.y = GROUND_Y;
      player.vy = 0;
      if (!player.onGround) player.squashT = 1;
      player.onGround = true;
    }
    if (player.squashT > 0) player.squashT = Math.max(0, player.squashT - dt * 0.006);
    player.runFrame += dt * (player.onGround ? 0.012 : 0);

    // obstacles
    nextObstacleAt -= dt * speed;
    if (nextObstacleAt <= 0) {
      spawnObstacle();
      const gap = 260 + Math.random() * 220 - speed * 90;
      nextObstacleAt = Math.max(140, gap);
    }
    for (const o of obstacles) o.x -= dt * speed;
    obstacles = obstacles.filter((o) => o.x + o.w > -20);

    // collision (slightly forgiving hitbox)
    const px1 = player.x + 10, px2 = player.x + player.w - 10;
    const py1 = player.y - player.h + 10, py2 = player.y - 4;
    for (const o of obstacles) {
      const ox1 = o.x + 6, ox2 = o.x + o.w - 6;
      const oy1 = o.y - o.h, oy2 = o.y;
      const hit = px1 < ox2 && px2 > ox1 && py1 < oy2 && py2 > oy1;
      if (hit) {
        endGame();
        return;
      }
    }

    // petals (ambient)
    for (const p of petals) {
      p.x -= dt * (speed * 0.4 + p.drift);
      p.sway += dt * 0.002;
      p.y += Math.sin(p.sway) * 0.06;
      if (p.x < -10) {
        p.x = VW + Math.random() * 40;
        p.y = Math.random() * (VH * 0.6);
      }
    }
  }

  function spawnObstacle() {
    // lantern (ground) or low-hanging banner (must duck-jump under = here: just a taller lantern requiring earlier jump)
    const tall = Math.random() < 0.35;
    obstacles.push({
      x: VW + 10,
      y: GROUND_Y,
      w: tall ? 30 : 26,
      h: tall ? 64 : 44,
      tall,
      glow: Math.random() * Math.PI * 2,
    });
  }

  function updateSkyClass() {
    sky.classList.remove("is-dusk", "is-night");
    if (dayPhase > 0.66) sky.classList.add("is-night");
    else if (dayPhase > 0.33) sky.classList.add("is-dusk");
  }

  /* ---------- drawing ---------- */
  function draw() {
    ctx.clearRect(0, 0, VW, VH);
    drawPetals();
    drawGround();
    drawObstacles();
    drawPlayer();
  }

  function drawPetals() {
    ctx.save();
    for (const p of petals) {
      ctx.fillStyle = "rgba(255,143,184,0.55)";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r, p.r * 0.7, p.sway, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawGround() {
    // path
    ctx.fillStyle = "#FCE9F1";
    ctx.fillRect(0, GROUND_Y, VW, VH - GROUND_Y);

    // dashed center-ish line for motion feedback
    ctx.strokeStyle = "rgba(232,79,142,0.35)";
    ctx.lineWidth = 4;
    ctx.setLineDash([18, 22]);
    ctx.lineDashOffset = groundScrollX;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y + 14);
    ctx.lineTo(VW, GROUND_Y + 14);
    ctx.stroke();
    ctx.setLineDash([]);

    // ground edge
    ctx.fillStyle = "#E84F8E";
    ctx.fillRect(0, GROUND_Y, VW, 4);
  }

  function drawObstacles() {
    for (const o of obstacles) {
      drawLantern(o);
    }
  }

  function drawLantern(o) {
    const x = o.x, baseY = o.y, w = o.w, h = o.h;
    const topY = baseY - h;
    const glow = 0.55 + 0.25 * Math.sin(o.glow + elapsedMs * 0.004);

    // string
    ctx.strokeStyle = "#C98A4B";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, 0);
    ctx.lineTo(x + w / 2, topY);
    ctx.stroke();

    // lantern body
    const grad = ctx.createLinearGradient(x, topY, x, baseY);
    grad.addColorStop(0, "#FFB37A");
    grad.addColorStop(1, "#FF6FA8");
    ctx.fillStyle = grad;
    roundRect(x, topY, w, h, w * 0.4);
    ctx.fill();

    // glow halo
    ctx.fillStyle = `rgba(255, 211, 120, ${glow * 0.5})`;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, topY + h / 2, w * 1.1, h * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // cap + bottom tassel
    ctx.fillStyle = "#C98A4B";
    ctx.fillRect(x + w * 0.15, topY - 4, w * 0.7, 5);
    ctx.fillRect(x + w * 0.15, baseY - 5, w * 0.7, 5);
    ctx.beginPath();
    ctx.moveTo(x + w / 2, baseY);
    ctx.lineTo(x + w / 2, baseY + 8);
    ctx.stroke();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawPlayer() {
    const squash = player.squashT; // 0..1
    const x = player.x;
    const y = player.y; // feet level
    const w = player.w;
    const h = player.h * (1 - squash * 0.18);
    const bob = player.onGround ? Math.sin(player.runFrame) * 3 : 0;

    ctx.save();
    ctx.translate(x + w / 2, y);

    // shadow
    ctx.fillStyle = "rgba(74,64,99,0.18)";
    ctx.beginPath();
    ctx.ellipse(0, 6, w * 0.45, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(0, -h + bob * 0.2);

    // legs (simple alternating run cycle)
    const legSwing = player.onGround ? Math.sin(player.runFrame) : 0.4;
    ctx.fillStyle = "#4A4063";
    ctx.fillRect(-w * 0.18 + legSwing * 6, h * 0.62, w * 0.16, h * 0.32);
    ctx.fillRect(w * 0.02 - legSwing * 6, h * 0.62, w * 0.16, h * 0.32);

    // skirt
    ctx.fillStyle = "#FF6FA8";
    roundRect(-w * 0.32, h * 0.42, w * 0.64, h * 0.26, 6);
    ctx.fill();

    // torso / top
    ctx.fillStyle = "#FFF8F0";
    roundRect(-w * 0.26, h * 0.16, w * 0.52, h * 0.32, 8);
    ctx.fill();

    // arms
    const armSwing = player.onGround ? Math.sin(player.runFrame + Math.PI) * 8 : -6;
    ctx.strokeStyle = "#FFE3EF";
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-w * 0.22, h * 0.22);
    ctx.lineTo(-w * 0.22 + armSwing * 0.3, h * 0.42 + armSwing);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w * 0.22, h * 0.22);
    ctx.lineTo(w * 0.22 - armSwing * 0.3, h * 0.42 - armSwing);
    ctx.stroke();

    // head
    ctx.fillStyle = "#FFE3D6";
    ctx.beginPath();
    ctx.arc(0, h * 0.05, w * 0.26, 0, Math.PI * 2);
    ctx.fill();

    // hair (twin tails + bangs) — dark plum to match palette
    ctx.fillStyle = "#5B4B8A";
    ctx.beginPath();
    ctx.arc(0, h * 0.02, w * 0.29, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    // bangs
    ctx.beginPath();
    ctx.moveTo(-w * 0.22, h * -0.02);
    ctx.quadraticCurveTo(0, h * 0.08, w * 0.22, h * -0.02);
    ctx.quadraticCurveTo(0, h * -0.16, -w * 0.22, h * -0.02);
    ctx.fill();
    // twin tails
    const tailSwing = Math.sin(player.runFrame * 0.8) * 4;
    ctx.beginPath();
    ctx.ellipse(-w * 0.32, h * 0.02 + tailSwing, 6, 14, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(w * 0.32, h * 0.02 - tailSwing, 6, 14, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // face — closed happy eyes (^_^) while running, open dot eyes while airborne
    ctx.strokeStyle = "#4A4063";
    ctx.fillStyle = "#4A4063";
    ctx.lineWidth = 2;
    if (player.onGround) {
      ctx.beginPath();
      ctx.arc(-w * 0.09, h * 0.03, 3, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(w * 0.09, h * 0.03, 3, Math.PI, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(-w * 0.09, h * 0.04, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(w * 0.09, h * 0.04, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // blush
    ctx.fillStyle = "rgba(255,143,184,0.6)";
    ctx.beginPath();
    ctx.arc(-w * 0.18, h * 0.08, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w * 0.18, h * 0.08, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /* ---------- local run history ---------- */
  function saveLocalRun(value) {
    const runs = JSON.parse(localStorage.getItem(LOCAL_RUNS_KEY) || "[]");
    runs.push({ score: value, at: Date.now() });
    runs.sort((a, b) => b.score - a.score);
    localStorage.setItem(LOCAL_RUNS_KEY, JSON.stringify(runs.slice(0, MAX_LOCAL_RUNS)));
  }

  function renderMyScores() {
    const runs = JSON.parse(localStorage.getItem(LOCAL_RUNS_KEY) || "[]");
    if (runs.length === 0) {
      myScoresList.innerHTML = `<li class="leaderboard__empty">No runs yet — go dash!</li>`;
      return;
    }
    myScoresList.innerHTML = runs
      .map(
        (r, i) => `
      <li class="leaderboard__row">
        <span class="leaderboard__rank">${i + 1}</span>
        <span class="leaderboard__name">${new Date(r.at).toLocaleDateString()}</span>
        <span class="leaderboard__score">${r.score}</span>
      </li>`
      )
      .join("");
  }

  /* ---------- global leaderboard via backend ---------- */
  function medalClass(rank) {
    if (rank === 1) return "leaderboard__row--gold";
    if (rank === 2) return "leaderboard__row--silver";
    if (rank === 3) return "leaderboard__row--bronze";
    return "";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function fetchTopScores() {
    try {
      const res = await fetch(`${API_BASE}/scores?limit=10`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderTopScores(data.scores || []);
      setApiStatus(true);
    } catch (err) {
      console.warn("Could not load leaderboard:", err);
      leaderboardList.innerHTML = `<li class="leaderboard__empty">Couldn't reach the scroll. Showing local scores only.</li>`;
      setApiStatus(false);
    }
  }

  function renderTopScores(scores) {
    if (!scores.length) {
      leaderboardList.innerHTML = `<li class="leaderboard__empty">No runs yet — be the first!</li>`;
      return;
    }
    leaderboardList.innerHTML = scores
      .slice(0, 10)
      .map((s, i) => {
        const rank = i + 1;
        return `
        <li class="leaderboard__row ${medalClass(rank)}">
          <span class="leaderboard__rank">${rank}</span>
          <span class="leaderboard__name">${escapeHtml(s.name)}</span>
          <span class="leaderboard__score">${s.score}</span>
        </li>`;
      })
      .join("");
  }

  function setApiStatus(ok) {
    apiStatusEl.classList.remove("is-ok", "is-error");
    if (ok) {
      apiStatusEl.textContent = "scroll synced ✓";
      apiStatusEl.classList.add("is-ok");
    } else {
      apiStatusEl.textContent = "offline — local scores only";
      apiStatusEl.classList.add("is-error");
    }
  }

  nameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    localStorage.setItem("sakuraDash.lastName", name);

    saveBtn.disabled = true;
    saveStatus.className = "name-form__status";
    saveStatus.textContent = "Saving…";

    try {
      const res = await fetch(`${API_BASE}/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, score: Math.floor(score) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      saveStatus.textContent = "Saved to the Scroll of Fame! 🌸";
      await fetchTopScores();
    } catch (err) {
      console.warn("Save failed:", err);
      saveStatus.textContent = "Couldn't save right now — try again later.";
      saveStatus.classList.add("is-error");
    } finally {
      saveBtn.disabled = false;
    }
  });

  /* ---------- init ---------- */
  resetState();
  draw();
  renderMyScores();
  fetchTopScores();
})();
