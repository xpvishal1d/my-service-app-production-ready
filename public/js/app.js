/* global Uint8Array */

const CELL = 14;
const BUFFER = 4;

/** @type {Uint8Array | null} */
let bytes = null;
let cols = 0;
let rows = 0;
/** @type {boolean} */
let readOnly = true;
/** True while user must wait after hitting toggle rate limit (checkboxes disabled). */
let interactionLocked = false;

/** @type {ReturnType<typeof setInterval> | null} */
let cooldownInterval = null;

/** @type {WebSocket | null} */
let ws = null;

const viewport = document.getElementById("viewport");
const canvas = document.getElementById("canvas");
const authStatus = document.getElementById("auth-status");
const loginLink = document.getElementById("login-link");
const logoutBtn = document.getElementById("logout-btn");
const gridSizeEl = document.getElementById("grid-size");
const wsStatusEl = document.getElementById("ws-status");
const connCountEl = document.getElementById("conn-count");
const rateBanner = document.getElementById("rate-limit-banner");

function getBit(arr, i) {
  return (arr[i >> 3] >> (i & 7)) & 1;
}

function setBit(arr, i, v) {
  const bi = i >> 3;
  const mask = 1 << (i & 7);
  if (v) arr[bi] |= mask;
  else arr[bi] &= ~mask;
}

function decodeBase64State(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function updateCheckboxDom(index, checked) {
  const el = canvas.querySelector(`input[data-index="${index}"]`);
  if (el) el.checked = checked;
}

function clearCooldownTimers() {
  if (cooldownInterval != null) {
    clearInterval(cooldownInterval);
    cooldownInterval = null;
  }
}

function updateBannerText(secondsLeft) {
  if (!rateBanner) return;
  rateBanner.textContent =
    secondsLeft <= 0
      ? ""
      : `You reached the toggle limit. Please wait ${secondsLeft}s — checking and unchecking is disabled until then.`;
}

/**
 * Locks toggling and shows a countdown; clears server-sent retryAfterSec (fallback 60s).
 */
function startToggleCooldown(retryAfterSec) {
  const total = Math.max(1, Math.floor(Number(retryAfterSec) || 60));
  clearCooldownTimers();
  interactionLocked = true;
  if (rateBanner) {
    rateBanner.classList.remove("hidden");
  }
  if (viewport) {
    viewport.classList.add("interaction-locked");
  }

  let left = total;
  updateBannerText(left);

  cooldownInterval = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearCooldownTimers();
      interactionLocked = false;
      if (rateBanner) {
        rateBanner.classList.add("hidden");
      }
      if (viewport) {
        viewport.classList.remove("interaction-locked");
      }
      scheduleRender();
      return;
    }
    updateBannerText(left);
  }, 1000);

  // Re-sync visible checkboxes from server state (revert the click that was rejected).
  scheduleRender();
}

/** @type {number | null} */
let raf = null;

function scheduleRender() {
  if (raf != null) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    raf = null;
    renderVisible();
  });
}

function inputsDisabled() {
  return readOnly || interactionLocked;
}

function renderVisible() {
  if (!bytes || !viewport || !canvas) return;

  const sl = viewport.scrollLeft;
  const st = viewport.scrollTop;
  const cw = viewport.clientWidth;
  const ch = viewport.clientHeight;

  const c1 = Math.max(0, Math.floor(sl / CELL) - BUFFER);
  const c2 = Math.min(cols - 1, Math.floor((sl + cw) / CELL) + BUFFER);
  const r1 = Math.max(0, Math.floor(st / CELL) - BUFFER);
  const r2 = Math.min(rows - 1, Math.floor((st + ch) / CELL) + BUFFER);

  canvas.style.width = `${cols * CELL}px`;
  canvas.style.height = `${rows * CELL}px`;

  canvas.replaceChildren();

  const frag = document.createDocumentFragment();
  const disabled = inputsDisabled();

  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const idx = r * cols + c;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.index = String(idx);
      input.className = "cell-cb";
      input.style.position = "absolute";
      input.style.left = `${c * CELL}px`;
      input.style.top = `${r * CELL}px`;
      input.style.width = `${CELL - 2}px`;
      input.style.height = `${CELL - 2}px`;
      input.checked = getBit(bytes, idx) === 1;
      input.disabled = disabled;
      input.addEventListener("change", onCheckboxChange);
      frag.appendChild(input);
    }
  }

  canvas.appendChild(frag);
}

function onCheckboxChange(ev) {
  const target = ev.target;
  if (!(target instanceof HTMLInputElement)) return;
  const idx = Number(target.dataset.index);
  if (!ws || ws.readyState !== WebSocket.OPEN || readOnly || interactionLocked) {
    if (bytes) {
      const should = getBit(bytes, idx) === 1;
      target.checked = should;
    }
    return;
  }
  ws.send(JSON.stringify({ type: "toggle", index: idx }));
}

function setAuthUi(sess) {
  if (!authStatus || !loginLink || !logoutBtn) return;
  if (sess.authenticated) {
    authStatus.textContent = sess.user?.name ?? sess.user?.email ?? "Signed in";
    loginLink.classList.add("hidden");
    loginLink.hidden = true;
    logoutBtn.classList.remove("hidden");
    logoutBtn.hidden = false;
  } else {
    authStatus.textContent = "Anonymous (read-only)";
    loginLink.classList.remove("hidden");
    loginLink.hidden = false;
    logoutBtn.classList.add("hidden");
    logoutBtn.hidden = true;
  }
}

async function loadSession() {
  const res = await fetch("/api/session", { credentials: "include" });
  const sess = await res.json();
  readOnly = Boolean(sess.readOnly);
  setAuthUi(sess);
  return sess;
}

async function loadGrid() {
  const metaRes = await fetch("/api/grid/meta", { credentials: "include" });
  const meta = await metaRes.json();
  cols = meta.cols;
  rows = meta.rows;
  if (gridSizeEl) gridSizeEl.textContent = String(meta.total);

  const stateRes = await fetch("/api/grid/state", { credentials: "include" });
  const state = await stateRes.json();
  bytes = decodeBase64State(state.data);

  scheduleRender();
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;

  socket.addEventListener("open", () => {
    if (wsStatusEl) wsStatusEl.textContent = "Connected";
  });

  socket.addEventListener("close", () => {
    if (wsStatusEl) wsStatusEl.textContent = "Reconnecting…";
    setTimeout(connectWs, 1200);
  });

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "welcome") {
      readOnly = Boolean(msg.readOnly);
      if (connCountEl) connCountEl.textContent = String(msg.connectionsOnServer ?? "—");
      scheduleRender();
      return;
    }

    if (msg.type === "update" && bytes && typeof msg.index === "number") {
      const v = msg.value === 1 ? 1 : 0;
      setBit(bytes, msg.index, v);
      updateCheckboxDom(msg.index, v === 1);
      return;
    }

    if (msg.type === "error" && msg.code === "rate_limited") {
      startToggleCooldown(msg.retryAfterSec);
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await fetch("/logout", { method: "POST", credentials: "include" });
    location.reload();
  });
}

if (viewport) {
  viewport.addEventListener("scroll", scheduleRender, { passive: true });
}

window.addEventListener("resize", scheduleRender);

(async function init() {
  await loadSession();
  await loadGrid();
  connectWs();
})();
