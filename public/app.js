/* =========================================================
   Sakura Dash — cyber-anime edition
   Vanilla canvas runner + leaderboard wiring (no frameworks)

   NOTE: localStorage keys, API endpoints, and the
   save/fetch/render leaderboard functions are UNCHANGED
   from the original game so existing saved scores and the
   backend API keep working exactly as before.
   ========================================================= */

(() => {
  "use strict";

  /* ---------- config ---------- */
  const API_BASE = window.SAKURA_API_BASE || "/api";
  const LOCAL_BEST_KEY = "sakuraDash.best";
  const LOCAL_RUNS_KEY = "sakuraDash.myRuns";
  const MAX_LOCAL_RUNS = 10;

  const GROUND_Y = 320;
  const GRAVITY = 0.0026;
  const JUMP_VELOCITY = -1.05;
  const HOLD_GRAVITY_SCALE = 0.55;

  const BASE_SPEED = 0.32;
  const MAX_SPEED = 1.30;
  const SPEED_RAMP = 0.000012;

  // challenge-mode multipliers (client-side difficulty only)
  const CHALLENGE_RAMP = { normal: 1, hard: 1.6, insane: 2.4 };
  const CHALLENGE_MAXSPEED = { normal: 1.30, hard: 1.55, insane: 1.85 };
  let challengeMode = "normal";

  const LEVEL_STEP = 250; // level up every 250 points
  const NEAR_MISS_DIST = 26; // px window counted as a "near miss" for combo

  /* ---------- DOM refs ---------- */
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const sky = document.getElementById("sky");
  const gameWrap = document.getElementById("gameWrap");

  const hudScoreEl = document.getElementById("hudScore");
  const hudBestEl = document.getElementById("hudBest");
  const hudLevelEl = document.getElementById("hudLevel");
  const hudLevelCard = document.getElementById("hudLevelCard");
  const hudComboEl = document.getElementById("hudCombo");
  const hudComboCard = document.getElementById("hudComboCard");

  const fxLayer = document.getElementById("fxLayer");
  const noticeStack = document.getElementById("noticeStack");

  const startOverlay = document.getElementById("startOverlay");
  const startBtn = document.getElementById("startBtn");

  const pauseOverlay = document.getElementById("pauseOverlay");
  const pauseBtn = document.getElementById("pauseBtn");
  const resumeBtn = document.getElementById("resumeBtn");

  const soundBtn = document.getElementById("soundBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const closeSettings = document.getElementById("closeSettings");
  const soundToggle = document.getElementById("soundToggle");
  const challengeSelect = document.getElementById("challengeSelect");

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

  /* ---------- logical canvas size ---------- */
  const VW = canvas.width;
  const VH = canvas.height;

  /* ---------- state ---------- */
  let running = false;
  let paused = false;
  let soundOn = true;
  let lastTs = 0;
  let elapsedMs = 0;
  let score = 0;
  let best = Number(localStorage.getItem(LOCAL_BEST_KEY) || 0);
  let speed = BASE_SPEED;
  let obstacles = [];
  let petals = [];
  let nextObstacleAt = 0;
  let groundScrollX = 0;
  let dayPhase = 0;
  let trailHistory = [];

  // gameplay-feel additions
  let level = 1;
  let combo = 0;
  let comboTimer = 0; // ms left before combo resets
  let lastNearMissObstacleId = null;
  let obstacleIdCounter = 0;
  let achievementsHit = new Set();

  hudBestEl.textContent = String(best);

  const player = {
    x: 110, y: GROUND_Y, w: 46, h: 58,
    vy: 0, onGround: true, holding: false,
    runFrame: 0, squashT: 0,
  };

  /* ---------- input ---------- */
  function pressJump() {
    if (!running || paused) return;
    if (player.onGround) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      player.squashT = 1;
    }
    player.holding = true;
  }
  function releaseJump() { player.holding = false; }

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") {
      e.preventDefault();
      if (!running && !startOverlay.classList.contains("overlay--hidden")) {
        startGame();
      } else {
        pressJump();
      }
    }
    if (e.code === "Escape" && running) togglePause();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") releaseJump();
  });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!running) return;
    pressJump();
  });
  canvas.addEventListener("pointerup", SafeRelease);
  canvas.addEventListener("pointercancel", SafeRelease);
  canvas.addEventListener("pointerleave", SafeRelease);

  function SafeRelease(e) {
    if (e) e.preventDefault();
    releaseJump();
  }

  startBtn.addEventListener("click", startGame);
  retryBtn.addEventListener("click", () => {
    overOverlay.classList.add("overlay--hidden");
    startGame();
  });

  /* ---------- pause / settings / sound (UI/UX only) ---------- */
  function togglePause() {
    if (!running) return;
    paused = !paused;
    if (paused) {
      pauseOverlay.classList.remove("overlay--hidden");
      pauseBtn.textContent = "►";
    } else {
      pauseOverlay.classList.add("overlay--hidden");
      pauseBtn.textContent = "❙❙";
      lastTs = performance.now();
      requestAnimationFrame(loop);
    }
  }
  pauseBtn.addEventListener("click", togglePause);
  resumeBtn.addEventListener("click", togglePause);

  function setSound(on) {
    soundOn = on;
    soundBtn.textContent = on ? "🔊" : "🔈";
    soundToggle.setAttribute("aria-pressed", String(on));
  }
  soundBtn.addEventListener("click", () => setSound(!soundOn));
  soundToggle.addEventListener("click", () => setSound(!soundOn));

  settingsBtn.addEventListener("click", () => {
    settingsPanel.classList.remove("panel--hidden");
    if (running && !paused) togglePause();
  });
  closeSettings.addEventListener("click", () => {
    settingsPanel.classList.add("panel--hidden");
  });
  challengeSelect.addEventListener("change", (e) => {
    challengeMode = e.target.value;
  });

  /* ---------- floating fx / notifications ---------- */
  function spawnScorePop(text, xRatio, yRatio, color) {
    const el = document.createElement("div");
    el.className = "fx-pop";
    el.textContent = text;
    el.style.left = `${xRatio * 100}%`;
    el.style.top = `${yRatio * 100}%`;
    if (color) el.style.color = color;
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  function showNotice(text, type) {
    const el = document.createElement("div");
    el.className = "notice" + (type === "achievement" ? " notice--achievement" : "");
    el.textContent = text;
    noticeStack.appendChild(el);
    setTimeout(() => el.remove(), 2300);
  }

  function triggerShake() {
    gameWrap.classList.remove("is-shaking");
    // restart animation
    void gameWrap.offsetWidth;
    gameWrap.classList.add("is-shaking");
  }

  function bumpCombo() {
    combo += 1;
    comboTimer = 2200;
    hudComboCard.hidden = false;
    hudComboEl.textContent = `x${Math.min(9, 1 + Math.floor(combo / 2))}`;
    hudComboCard.classList.remove("combo-pop");
    void hudComboCard.offsetWidth;
    hudComboCard.classList.add("combo-pop");
    if (combo === 3 || combo === 6 || combo === 10) {
      const key = "combo-" + combo;
      if (!achievementsHit.has(key)) {
        achievementsHit.add(key);
        showNotice(`⚡ ${combo}-combo streak!`, "achievement");
      }
    }
  }

  function resetCombo() {
    combo = 0;
    comboTimer = 0;
    hudComboCard.hidden = true;
  }

  /* ---------- game lifecycle ---------- */
  function resetState() {
    score = 0;
    elapsedMs = 0;
    speed = BASE_SPEED;
    obstacles = [];
    trailHistory = [];
    nextObstacleAt = 900;
    player.y = GROUND_Y;
    player.vy = 0;
    player.onGround = true;
    player.holding = false;
    dayPhase = 0;
    level = 1;
    achievementsHit.clear();
    resetCombo();
    updateSkyClass();
    hudScoreEl.textContent = "0";
    hudLevelEl.textContent = "1";
    hudScoreEl.parentElement.classList.remove("score-milestone");
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
    pauseOverlay.classList.add("overlay--hidden");
    settingsPanel.classList.add("panel--hidden");
    paused = false;
    pauseBtn.textContent = "❙❙";
    running = true;
    lastTs = performance.now();
    requestAnimationFrame(loop);
  }

  function endGame() {
    running = false;
    triggerShake();
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
    if (!running || paused) return;
    const dt = Math.min(40, ts - lastTs);
    lastTs = ts;
    elapsedMs += dt;

    update(dt);
    draw();

    requestAnimationFrame(loop);
  }

  function update(dt) {
    // difficulty ramp (scaled by challenge mode)
    const ramp = SPEED_RAMP * (CHALLENGE_RAMP[challengeMode] || 1);
    const maxSpeed = CHALLENGE_MAXSPEED[challengeMode] || MAX_SPEED;
    speed = Math.min(maxSpeed, BASE_SPEED + elapsedMs * ramp);

    // score = distance survived, boosted slightly by combo multiplier
    const comboMult = 1 + Math.min(0.8, combo * 0.08);
    const oldScore = Math.floor(score);
    score += dt * speed * 0.06 * comboMult;
    const currentFloorScore = Math.floor(score);
    hudScoreEl.textContent = String(currentFloorScore);

    // combo timer decay
    if (comboTimer > 0) {
      comboTimer -= dt;
      if (comboTimer <= 0) resetCombo();
    }

    // milestone pop every 100 + level-up every LEVEL_STEP
    if (currentFloorScore > oldScore) {
      if (currentFloorScore % 100 === 0) {
        const parentScore = hudScoreEl.parentElement;
        parentScore.classList.add("score-milestone");
        setTimeout(() => parentScore.classList.remove("score-milestone"), 400);
        spawnScorePop(`+${currentFloorScore - (currentFloorScore % 100 === 0 ? 0 : 0)}`, 0.1, 0.12, "var(--cyan)");
      }
      const newLevel = Math.floor(currentFloorScore / LEVEL_STEP) + 1;
      if (newLevel > level) {
        level = newLevel;
        hudLevelEl.textContent = String(level);
        hudLevelCard.classList.add("score-milestone");
        setTimeout(() => hudLevelCard.classList.remove("score-milestone"), 400);
        showNotice(`🚀 Level ${level}!`, "achievement");
      }
      if (currentFloorScore === 500 || currentFloorScore === 1000 || currentFloorScore === 2000) {
        showNotice(`🏆 ${currentFloorScore} points reached!`, "achievement");
      }
    }

    // day -> dusk -> night loop
    dayPhase = (currentFloorScore % 2200) / 2200;
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

    trailHistory.push({ y: player.y, squash: player.squashT, run: player.runFrame, ground: player.onGround });
    if (trailHistory.length > 4) trailHistory.shift();

    // obstacles distance tracking
    nextObstacleAt -= dt * speed;
    if (nextObstacleAt <= 0) {
      spawnObstacle();
      const dynamicGapScaler = Math.max(0.65, 1.0 - (speed - BASE_SPEED) * 0.4);
      const gap = (260 + Math.random() * 220 - speed * 90) * dynamicGapScaler;
      nextObstacleAt = Math.max(145, gap);
    }
    for (const o of obstacles) o.x -= dt * speed;
    obstacles = obstacles.filter((o) => o.x + o.w > -40);

    // collision (slightly forgiving hitbox) + near-miss combo detection
    const px1 = player.x + 10, px2 = player.x + player.w - 10;
    const py1 = player.y - player.h + 10, py2 = player.y - 4;
    for (const o of obstacles) {
      const ox1 = o.x + 5, ox2 = o.x + o.w - 5;
      const oy1 = o.y - o.h, oy2 = o.y;
      const hit = px1 < ox2 && px2 > ox1 && py1 < oy2 && py2 > oy1;
      if (hit) {
        endGame();
        return;
      }
      // near-miss: obstacle just passed the player closely while airborne
      if (!o._scored && o.x + o.w < player.x) {
        o._scored = true;
        if (!player.onGround && Math.abs((o.x + o.w) - player.x) < NEAR_MISS_DIST + 40) {
          bumpCombo();
          spawnScorePop("Nice!", (player.x / VW), (player.y - player.h) / VH - 0.05, "var(--purple)");
        }
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
    obstacleIdCounter += 1;
    const isHighCrane = score > 350 && Math.random() < 0.28;

    if (isHighCrane) {
      obstacles.push({
        id: obstacleIdCounter,
        x: VW + 10, y: GROUND_Y - 72, w: 32, h: 24,
        isCrane: true, glow: Math.random() * Math.PI * 2,
      });
    } else {
      const tall = Math.random() < 0.35;
      obstacles.push({
        id: obstacleIdCounter,
        x: VW + 10, y: GROUND_Y,
        w: tall ? 30 : 26, h: tall ? 64 : 44,
        tall, isCrane: false, glow: Math.random() * Math.PI * 2,
      });
    }
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

    if (speed > BASE_SPEED * 1.25) {
      for (let i = 0; i < trailHistory.length; i++) {
        const alpha = (i + 1) / trailHistory.length * 0.22;
        ctx.save();
        ctx.globalAlpha = alpha;
        const trailXOffset = (trailHistory.length - i) * -16 * (speed / MAX_SPEED);
        drawPlayerSkeleton(player.x + trailXOffset, trailHistory[i].y, trailHistory[i].squash, trailHistory[i].run, trailHistory[i].ground, true);
        ctx.restore();
      }
    }

    drawPlayerSkeleton(player.x, player.y, player.squashT, player.runFrame, player.onGround, false);
  }

  function drawPetals() {
    ctx.save();
    for (const p of petals) {
      ctx.fillStyle = "rgba(34, 211, 238, 0.45)";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r, p.r * 0.7, p.sway, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawGround() {
    ctx.fillStyle = "#0B1424";
    ctx.fillRect(0, GROUND_Y, VW, VH - GROUND_Y);

    ctx.strokeStyle = "rgba(34, 211, 238, 0.35)";
    ctx.lineWidth = 4;
    ctx.setLineDash([18, 22]);
    ctx.lineDashOffset = groundScrollX;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y + 14);
    ctx.lineTo(VW, GROUND_Y + 14);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#22D3EE";
    ctx.fillRect(0, GROUND_Y, VW, 3);
  }

  function drawObstacles() {
    for (const o of obstacles) {
      if (o.isCrane) drawCrane(o);
      else drawLantern(o);
    }
  }

  function drawCrane(o) {
    const x = o.x, y = o.y, w = o.w, h = o.h;
    const hoverBob = Math.sin(elapsedMs * 0.007 + x * 0.05) * 4;

    ctx.save();
    ctx.fillStyle = "rgba(139, 92, 246, 0.30)";
    ctx.beginPath();
    ctx.arc(x + w / 2, y - h / 2 + hoverBob, w, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1E293B";
    ctx.strokeStyle = "#8B5CF6";
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.moveTo(x, y - h / 2 + hoverBob);
    ctx.lineTo(x + w * 0.35, y - h + hoverBob);
    ctx.lineTo(x + w * 0.5, y - h * 0.2 + hoverBob);
    ctx.lineTo(x + w, y - h * 0.75 + hoverBob);
    ctx.lineTo(x + w * 0.65, y + hoverBob);
    ctx.lineTo(x + w * 0.3, y + hoverBob);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + w * 0.5, y - h * 0.2 + hoverBob);
    ctx.lineTo(x + w * 0.2, y - h * 0.8 + hoverBob);
    ctx.lineTo(x + w * 0.35, y - h + hoverBob);
    ctx.stroke();
    ctx.restore();
  }

  function drawLantern(o) {
    const x = o.x, baseY = o.y, w = o.w, h = o.h;
    const topY = baseY - h;
    const glow = 0.55 + 0.25 * Math.sin(o.glow + elapsedMs * 0.004);

    ctx.strokeStyle = "rgba(148,163,184,0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, 0);
    ctx.lineTo(x + w / 2, topY);
    ctx.stroke();

    const grad = ctx.createLinearGradient(x, topY, x, baseY);
    grad.addColorStop(0, "#3B82F6");
    grad.addColorStop(1, "#22D3EE");
    ctx.fillStyle = grad;
    roundRect(x, topY, w, h, w * 0.4);
    ctx.fill();

    ctx.fillStyle = `rgba(34, 211, 238, ${glow * 0.5})`;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, topY + h / 2, w * 1.1, h * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#0F172A";
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

  function playerColor(standardColor, isTrail) {
    return isTrail ? "rgba(34, 211, 238, 0.35)" : standardColor;
  }

  function drawPlayerSkeleton(x, y, squash, runFrame, onGround, isTrail) {
    const w = player.w;
    const h = player.h * (1 - squash * 0.18);
    const bob = onGround ? Math.sin(runFrame) * 3 : 0;

    ctx.save();
    ctx.translate(x + w / 2, y);

    if (!isTrail) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(0, 6, w * 0.45, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.translate(0, -h + bob * 0.2);

    // legs
    const legSwing = onGround ? Math.sin(runFrame) : 0.4;
    ctx.fillStyle = playerColor("#1E293B", isTrail);
    ctx.fillRect(-w * 0.18 + legSwing * 6, h * 0.62, w * 0.16, h * 0.32);
    ctx.fillRect(w * 0.02 - legSwing * 6, h * 0.62, w * 0.16, h * 0.32);

    // jacket / torso bottom
    ctx.fillStyle = playerColor("#3B82F6", isTrail);
    roundRect(-w * 0.32, h * 0.42, w * 0.64, h * 0.26, 6);
    ctx.fill();

    // torso / top
    ctx.fillStyle = playerColor("#F8FAFC", isTrail);
    roundRect(-w * 0.26, h * 0.16, w * 0.52, h * 0.32, 8);
    ctx.fill();

    // arms
    const armSwing = onGround ? Math.sin(runFrame + Math.PI) * 8 : -6;
    ctx.strokeStyle = playerColor("#22D3EE", isTrail);
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
    ctx.fillStyle = playerColor("#E7ECF3", isTrail);
    ctx.beginPath();
    ctx.arc(0, h * 0.05, w * 0.26, 0, Math.PI * 2);
    ctx.fill();

    // hair
    ctx.fillStyle = playerColor("#8B5CF6", isTrail);
    ctx.beginPath();
    ctx.arc(0, h * 0.02, w * 0.29, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-w * 0.22, h * -0.02);
    ctx.quadraticCurveTo(0, h * 0.08, w * 0.22, h * -0.02);
    ctx.quadraticCurveTo(0, h * -0.16, -w * 0.22, h * -0.02);
    ctx.fill();
    const tailSwing = Math.sin(runFrame * 0.8) * 4;
    ctx.beginPath();
    ctx.ellipse(-w * 0.32, h * 0.02 + tailSwing, 6, 14, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(w * 0.32, h * 0.02 - tailSwing, 6, 14, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // face
    if (!isTrail) {
      ctx.strokeStyle = "#1E293B";
      ctx.fillStyle = "#1E293B";
      ctx.lineWidth = 2;
      if (onGround) {
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
      // cheek glow accents (instead of pink blush)
      ctx.fillStyle = "rgba(34,211,238,0.5)";
      ctx.beginPath();
      ctx.arc(-w * 0.18, h * 0.08, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(w * 0.18, h * 0.08, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /* =========================================================
     ---------- LOCAL RUN HISTORY (unchanged logic) ----------
     ========================================================= */
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

  /* =========================================================
     ------- GLOBAL LEADERBOARD VIA BACKEND (unchanged) -------
     ========================================================= */
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
      leaderboardList.innerHTML = `<li class="leaderboard__empty">Couldn't reach the leaderboard. Showing local scores only.</li>`;
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
      apiStatusEl.textContent = "leaderboard synced ✓";
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
      saveStatus.textContent = "Saved to the leaderboard! ⚡";
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
