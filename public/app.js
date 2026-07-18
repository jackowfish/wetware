const $ = (id) => document.getElementById(id);

const store = {
  get(roomId) {
    try {
      return JSON.parse(localStorage.getItem(`wetware:${roomId}`) || "null");
    } catch { return null; }
  },
  set(roomId, data) {
    localStorage.setItem(`wetware:${roomId}`, JSON.stringify(data));
  },
};

let socket = null;
let me = { roomId: null, memberId: null, isHost: false, name: "" };
let latest = null; // public room state
let priv = null;   // my private state (role, my answer, my vote)

let renderedPhase = null;
let renderedRound = null;

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

// ── lobby ──────────────────────────────────────────────────────────────────

async function createRoom() {
  if ($("joinCode").value.trim()) return; // a code in the field means you're joining
  const name = $("name").value.trim() || "Host";
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) { $("lobbyErr").textContent = "couldn't open a channel"; return; }
  const { roomId, hostId, hostToken } = await res.json();
  store.set(roomId, { memberId: hostId, hostToken, name });
  location.hash = roomId;
  enterRoom(roomId, name, { hostToken });
}

async function joinRoom(codeOverride) {
  const raw = (codeOverride || $("joinCode").value).trim();
  const code = raw.toUpperCase();
  const name = $("name").value.trim() || (store.get(code)?.name || "");
  if (!code) { $("lobbyErr").textContent = "enter a channel code"; return; }
  if (!name) { $("lobbyErr").textContent = "enter a handle"; return; }

  // the hidden back room: if what they typed is the pin, the server opens a
  // solo test table instead of joining. a wrong guess just 403s and falls
  // through to an ordinary join - the lobby never hints the mode is there.
  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, test: true, pin: raw }),
    });
    if (res.ok) {
      const { roomId, hostId, hostToken } = await res.json();
      store.set(roomId, { memberId: hostId, hostToken, name });
      location.hash = roomId;
      enterRoom(roomId, name, { hostToken });
      return;
    }
  } catch {}

  location.hash = code;
  enterRoom(code, name, {});
}

function hashCode() {
  return location.hash.length > 1 ? location.hash.slice(1).toUpperCase() : "";
}

function applyHashMode() {
  const code = hashCode();
  if (code) {
    hide($("lobbyTagline"));
    show($("joinBanner"));
    $("joinBannerCode").textContent = code;
    $("joinCode").value = code;
    setTimeout(() => $("name").focus(), 50);
  } else {
    show($("lobbyTagline"));
    hide($("joinBanner"));
  }
  syncCreate();
}

function exitToLobby(msg = "") {
  try { socket?.disconnect(); } catch {}
  socket = null;
  wakeUp = null;
  hide($("connNote"));
  latest = null;
  priv = null;
  renderedPhase = null;
  renderedRound = null;
  me = { roomId: null, memberId: null, isHost: false, name: me.name };
  hide($("room"));
  hide($("settingsBtn"));
  hide($("renameBtn"));
  show($("lobby"));
  $("lobbyErr").textContent = msg;
  $("joinCode").value = "";
  history.replaceState(null, "", location.pathname);
  applyHashMode();
}

function enterRoom(roomId, name, { hostToken } = {}) {
  $("lobbyErr").textContent = "";
  const saved = store.get(roomId) || {};
  hostToken = hostToken || saved.hostToken;
  me = { roomId, memberId: null, isHost: false, name: name || saved.name || "Stranger" };

  let firstJoin = true;

  socket = io({ reconnectionDelayMax: 2000, timeout: 8000 });

  // phones sleep constantly mid-game; the moment one wakes, reconnect instead
  // of waiting out ping timeouts. a socket can also come back a zombie that
  // still claims connected - probe it, and hard-cycle if it doesn't answer.
  wakeUp = () => {
    if (!socket) return;
    if (!socket.connected) {
      show($("connNote"));
      socket.connect();
      return;
    }
    socket.timeout(2500).emit("hi", null, (err) => {
      if (!socket) return;
      if (err) {
        show($("connNote"));
        socket.disconnect();
        socket.connect();
      } else {
        doJoin();
      }
    });
  };

  socket.on("disconnect", () => show($("connNote")));

  socket.on("kicked", () => {
    store.set(roomId, { name: (store.get(roomId) || {}).name });
    exitToLobby("the operator removed you from the channel.");
  });

  const doJoin = () => {
    hide($("connNote"));
    const s2 = store.get(roomId) || {};
    socket.emit(
      "join",
      { roomId, name: me.name, memberId: me.memberId || s2.memberId, hostToken: hostToken || s2.hostToken },
      (resp) => {
        if (resp?.error) {
          if (firstJoin) {
            $("lobbyErr").textContent = resp.error;
            socket.disconnect();
            location.hash = "";
          }
          return;
        }
        me.memberId = resp.memberId;
        me.isHost = !!resp.isHost;
        store.set(roomId, {
          ...(store.get(roomId) || {}),
          memberId: resp.memberId,
          hostToken: hostToken || s2.hostToken,
          name: me.name,
        });

        if (firstJoin) {
          firstJoin = false;
          hide($("lobby"));
          show($("room"));
          $("roomId").textContent = roomId;
          $("youAre").textContent = `you: ${me.name}${me.isHost ? " (host)" : ""}`;
        }
      }
    );
  };

  socket.on("connect", doJoin);
  rejoin = doJoin;

  socket.on("state", (s) => { latest = s; render(); });
  socket.on("private", (p) => { priv = p; render(); });
}

let rejoin = null;
let wakeUp = null;

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) wakeUp?.();
});
for (const ev of ["pageshow", "online", "focus"]) {
  window.addEventListener(ev, () => wakeUp?.());
}

// ── helpers ────────────────────────────────────────────────────────────────

function memberById(id) {
  return latest?.members.find((m) => m.id === id) || null;
}
function nameOf(id) {
  return memberById(id)?.name || "someone";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
const PHASE_LABELS = {
  lobby: "gathering",
  prompt: "the prompt",
  answering: "answers incoming",
  voting: "the vote",
  reveal: "the reveal",
};

// ── render ─────────────────────────────────────────────────────────────────

const STAGES = ["stageLobby", "stagePrompt", "stageAnswering", "stageVoting", "stageReveal"];

function render() {
  if (!latest) return;
  const s = latest;
  const phase = s.phase;

  if (phase !== renderedPhase || s.round !== renderedRound) {
    renderedPhase = phase;
    renderedRound = s.round;
    // clear compose fields when the round or phase turns over
    $("promptInput").value = "";
    $("answerInput").value = "";
    $("promptCount").textContent = "0";
    $("answerCount").textContent = "0";
  }

  // phase banner
  $("phaseLabel").textContent = PHASE_LABELS[phase] || phase;
  $("phaseLabel").dataset.phase = phase;
  const waitBits = [];
  if (s.round > 0) waitBits.push(`round ${s.round}`);
  if (phase === "voting") waitBits.push(`${s.votesIn}/${s.votersTotal} votes in`);
  $("waitLabel").textContent = waitBits.join(" · ");

  // settings
  $("setAiCount").value = s.aiCount;
  $("setSlotHint").textContent = s.slotCount;
  $("aiModeNote").textContent = s.hasAi
    ? "live mode: answers are written by the machine from your prompt."
    : "offline mode: no API key set, so decoy answers come from a canned pool (they won't match the prompt).";

  // lobby-only controls
  $("renameBtn").classList.toggle("hidden", phase !== "lobby");
  $("settingsBtn").classList.toggle("hidden", !(me.isHost && phase === "lobby"));
  if (phase !== "lobby" && !$("settingsModal").classList.contains("hidden")) closeSettings();

  // role banner
  renderRoleNote(s);
  $("stalledNote").classList.toggle("hidden", !s.stalled || !me.isHost);

  // stages
  for (const id of STAGES) hide($(id));
  const stage = {
    lobby: "stageLobby",
    prompt: "stagePrompt",
    answering: "stageAnswering",
    voting: "stageVoting",
    reveal: "stageReveal",
  }[phase];
  if (stage) show($(stage));

  if (phase === "lobby") renderLobbyStage(s);
  if (phase === "prompt") renderPrompt(s);
  if (phase === "answering") renderAnswering(s);
  if (phase === "voting") renderVoting(s);
  if (phase === "reveal") renderReveal(s);

  renderMembers(s, phase);
}

function renderRoleNote(s) {
  const el = $("roleNote");
  if (s.phase === "lobby" || s.phase === "reveal") { hide(el); return; }
  const iAmOperator = s.promptMasterId === me.memberId;
  const iAmImposter = !!priv?.isImposter;
  let note = "";
  if (iAmOperator) {
    note = "🛰 you're the operator. write the prompt — you're on the town's side, so make it one an imposter can't fake.";
  } else if (iAmImposter) {
    note = "🎭 you're the imposter. blend in with the machine. don't get caught.";
  } else if (priv?.role === "spectator") {
    note = "👁 you joined mid-round — you're watching this one. you'll be dealt in next round.";
  } else {
    note = "🔍 you're a detective. read the answers and vote for the one written by a human.";
  }
  el.textContent = note;
  el.dataset.role = iAmOperator ? "operator" : iAmImposter ? "imposter" : priv?.role === "spectator" ? "spectator" : "voter";
  show(el);
}

function renderLobbyStage(s) {
  const n = s.members.length;
  let hint;
  if (n < s.minPlayers) {
    hint = `${n} on the channel — need at least ${s.minPlayers} to play. share the link.`;
  } else if (s.isTest) {
    hint = `${n} on the channel. start the round, then run it solo — the bots write, answer, and vote themselves.`;
  } else {
    hint = `${n} on the channel. each round one of you is the operator, one is the secret imposter, and the rest hunt.`;
  }
  $("lobbyHint").textContent = hint;
  $("botRow").classList.toggle("hidden", !(s.isTest && me.isHost));
  $("startRow").classList.toggle("hidden", !me.isHost);
  $("startBtn").disabled = n < s.minPlayers;
  $("startBtn").textContent = n < s.minPlayers ? `need ${s.minPlayers}+ players` : "start the round";
}

function renderPrompt(s) {
  const iAmOperator = s.promptMasterId === me.memberId;
  $("promptLead").textContent = iAmOperator
    ? "you're the operator. ask the machine a question — the imposter will try to answer it just like the machine does."
    : `${nameOf(s.promptMasterId)} is the operator, composing a prompt for the machine…`;
  $("promptCompose").classList.toggle("hidden", !iAmOperator);
}

function renderAnswering(s) {
  $("answeringPrompt").textContent = s.prompt || "";
  const iAmImposter = !!priv?.isImposter;
  const iAmOperator = s.promptMasterId === me.memberId;
  const planted = priv?.myAnswer != null;

  $("answerCompose").classList.toggle("hidden", !(iAmImposter && !planted));
  $("answerDone").classList.toggle("hidden", !(iAmImposter && planted));

  const stillWaiting = s.aiPending || (iAmImposter ? false : true);
  $("answeringSpinner").classList.toggle("hidden", !stillWaiting || (iAmImposter && !planted));

  if (iAmImposter) {
    $("answeringHead").textContent = planted ? "answer planted" : "your move, ghost";
    $("answeringLead").textContent = planted
      ? "waiting on the machine to finish its answers, then it goes to the vote."
      : "write one answer to the prompt that could pass for the machine's. it gets shuffled in with the real ones.";
    $("answeringSpinnerText").textContent = "the machine is composing the rest…";
  } else {
    $("answeringHead").textContent = "answers incoming";
    $("answeringLead").textContent = iAmOperator
      ? "the machine is writing its answers — and somewhere out there, so is the imposter."
      : "the machine is writing its answers — and one of you is quietly writing a fake.";
    $("answeringSpinnerText").textContent = s.aiPending
      ? "the machine is composing…"
      : "waiting on the last answer…";
  }
}

function renderVoting(s) {
  $("votingPrompt").textContent = s.prompt || "";
  const iAmImposter = !!priv?.isImposter;
  const iAmOperator = s.promptMasterId === me.memberId;
  const canVote = !iAmImposter && priv?.role !== "spectator";
  const voted = priv?.myVote !== undefined;

  $("votingLead").textContent = iAmImposter
    ? "your answer is in the line-up. sit tight and hope they miss it."
    : !canVote
      ? "you're watching this round — no vote."
      : voted
        ? "vote locked. see if the others can spot the human too."
        : "one of these was written by a human pretending to be the machine. tap the impostor.";

  const box = $("slotList");
  box.innerHTML = "";
  for (const slot of s.slots || []) {
    const el = document.createElement("div");
    el.className = "slot";
    const mine = priv?.myVote === slot.id;
    if (mine) el.classList.add("mine");
    el.innerHTML = `
      <div class="slot-head"><span class="slot-tag">${slot.id}</span></div>
      <div class="slot-text">${escapeHtml(slot.text)}</div>
    `;
    if (canVote) {
      const btn = document.createElement("button");
      btn.className = "btn slot-vote" + (mine ? " voted" : "");
      btn.textContent = mine ? "your pick ✓" : "human ✋";
      btn.disabled = voted;
      btn.addEventListener("click", () => {
        socket.emit("vote", { slotId: slot.id }, (r) => { if (r?.error) alert(r.error); });
      });
      el.appendChild(btn);
    }
    box.appendChild(el);
  }
  $("voteDone").classList.toggle("hidden", !(canVote && voted));
  $("closeVoteRow").classList.toggle("hidden", !(me.isHost && s.votesIn > 0));
}

function renderReveal(s) {
  const rv = s.reveal;
  $("revealPrompt").textContent = s.prompt || "";
  if (!rv) return;

  const iWasImposter = rv.imposterId === me.memberId;
  const myVote = priv?.myVote;
  const gotIt = myVote === rv.humanSlotId;

  $("revealHead").textContent = "the human was " + rv.humanSlotId;
  let lead = `${escapeHtml(nameOf(rv.imposterId))} was the imposter. `;
  lead += `${rv.caught} of ${rv.votersTotal} spotted them; ${rv.fooled} got fooled.`;
  if (iWasImposter) {
    lead += rv.fooled > 0 ? ` you fooled ${rv.fooled} — +${rv.fooled} to you.` : " nobody bit. tough crowd.";
  } else if (priv?.role !== "spectator" && myVote !== undefined) {
    lead += gotIt ? " you nailed it — +1." : " you got fooled.";
  }
  $("revealLead").textContent = lead;

  // who voted for each slot
  const votersBySlot = {};
  for (const [voter, slotId] of Object.entries(rv.votes || {})) {
    (votersBySlot[slotId] = votersBySlot[slotId] || []).push(voter);
  }

  const box = $("revealList");
  box.innerHTML = "";
  for (const slot of s.slots || []) {
    const el = document.createElement("div");
    el.className = "slot reveal-slot" + (slot.isHuman ? " human" : "");
    if (priv?.myVote === slot.id) el.classList.add("mine");
    const count = rv.tally[slot.id] || 0;
    const voters = (votersBySlot[slot.id] || []).map((v) => escapeHtml(nameOf(v))).join(", ");
    el.innerHTML = `
      <div class="slot-head">
        <span class="slot-tag">${slot.id}</span>
        ${slot.isHuman ? '<span class="badge human-badge">🎭 human</span>' : '<span class="badge ai-badge">machine</span>'}
        <span class="slot-count">${count} vote${count === 1 ? "" : "s"}</span>
      </div>
      <div class="slot-text">${escapeHtml(slot.text)}</div>
      ${voters ? `<div class="slot-voters">${voters}</div>` : ""}
    `;
    box.appendChild(el);
  }

  renderScoreboard(s);
  $("nextRow").classList.toggle("hidden", !me.isHost);
}

function renderScoreboard(s) {
  const box = $("scoreboard");
  box.innerHTML = `<h3 class="score-head">scores</h3>`;
  const list = document.createElement("div");
  list.className = "score-list";
  const top = (s.scoreboard || [])[0]?.score || 0;
  for (const row of s.scoreboard || []) {
    const el = document.createElement("div");
    el.className = "score-row" + (row.score > 0 && row.score === top ? " leader" : "");
    el.innerHTML = `
      <span class="score-name">${escapeHtml(row.name)}${row.id === me.memberId ? ' <span class="you-tag">you</span>' : ""}</span>
      <span class="score-val">${row.score}</span>
    `;
    list.appendChild(el);
  }
  box.appendChild(list);
}

function renderMembers(s, phase) {
  const ul = $("members");
  ul.innerHTML = "";
  const showVoteStatus = phase === "voting";
  for (const m of s.members) {
    const li = document.createElement("li");
    const spectating = !m.inRound && phase !== "lobby";
    if (spectating) li.classList.add("spectating");
    if (showVoteStatus && m.acted && m.inRound && m.id !== s.promptMasterId) li.classList.add("acted");
    const tags = [];
    if (m.id === me.memberId) tags.push(`<span class="you-tag">you</span>`);
    if (m.isHost) tags.push(`<span class="host-tag">🛰 host</span>`);
    if (m.isBot) tags.push(`<span class="bot-tag">🤖</span>`);
    // the operator is public; the imposter never is
    if (phase !== "lobby" && m.id === s.promptMasterId) tags.push(`<span class="op-tag">operator</span>`);

    let status = "";
    if (phase === "lobby") status = "";
    else if (spectating) status = "watching";
    else if (m.id === s.promptMasterId && phase === "prompt") status = "writing…";
    else if (showVoteStatus && m.id !== s.promptMasterId && m.inRound) {
      // don't out the imposter: everyone still shows a normal voting status
      status = m.acted ? "voted ✓" : "deciding…";
    }

    li.innerHTML = `
      <div class="m-main">
        <span class="m-name">${escapeHtml(m.name)} ${tags.join(" ")}</span>
        <span class="m-status">${status}</span>
      </div>
      <span class="m-score" title="score">${m.score}</span>
    `;
    if (me.isHost && !m.isHost && phase === "lobby") {
      const x = document.createElement("button");
      x.className = "drop-btn";
      x.title = `drop ${m.name}`;
      x.setAttribute("aria-label", `drop ${m.name}`);
      x.textContent = "✕";
      x.addEventListener("click", () => {
        if (confirm(`remove ${m.name}?`)) {
          emitSimple("dropMember")({ memberId: m.id });
        }
      });
      li.appendChild(x);
    }
    ul.appendChild(li);
  }
}

// ── wire up ────────────────────────────────────────────────────────────────

$("create").addEventListener("click", createRoom);
$("join").addEventListener("click", () => joinRoom());
function syncCreate() {
  const joining = $("joinCode").value.trim().length > 0;
  $("create").disabled = joining;
  $("create").textContent = joining ? "clear the code to host" : "open a channel";
}
$("joinCode").addEventListener("input", syncCreate);
window.addEventListener("pageshow", syncCreate);
syncCreate();
window.addEventListener("hashchange", applyHashMode);

$("leaveBtn").addEventListener("click", () => {
  if (!me.roomId) return;
  const midGame = latest && latest.phase !== "lobby" && !me.isHost;
  if (midGame && !confirm("leave mid-round?")) return;
  if (!me.isHost) {
    socket?.emit("leave", {}, () => {});
    store.set(me.roomId, { name: (store.get(me.roomId) || {}).name });
  }
  exitToLobby();
});

$("renameBtn").addEventListener("click", () => {
  const n = (prompt("your handle", me.name) || "").trim().slice(0, 40);
  if (!n || n === me.name) return;
  me.name = n;
  store.set(me.roomId, { ...(store.get(me.roomId) || {}), name: n });
  $("youAre").textContent = `you: ${n}${me.isHost ? " (host)" : ""}`;
  rejoin?.();
});

const emitSimple = (event) => (payload = {}) =>
  socket.emit(event, payload, (r) => { if (r?.error) alert(r.error); });

$("addBotsBtn").addEventListener("click", () => {
  const count = Math.max(1, Math.min(12, parseInt($("botCount").value, 10) || 1));
  emitSimple("addBots")({ count });
});
$("startBtn").addEventListener("click", () => emitSimple("startRound")());
$("nextBtn").addEventListener("click", () => emitSimple("startRound")());
$("closeVoteBtn").addEventListener("click", () => emitSimple("closeVoting")());

// prompt compose
$("promptInput").addEventListener("input", () => {
  $("promptCount").textContent = String($("promptInput").value.length);
});
$("promptSend").addEventListener("click", () => {
  const prompt = $("promptInput").value.trim();
  if (prompt.length < 3) { alert("give me a real prompt"); return; }
  $("promptSend").disabled = true;
  socket.emit("submitPrompt", { prompt }, (r) => {
    $("promptSend").disabled = false;
    if (r?.error) alert(r.error);
  });
});

// answer compose
$("answerInput").addEventListener("input", () => {
  $("answerCount").textContent = String($("answerInput").value.length);
});
$("answerSend").addEventListener("click", () => {
  const answer = $("answerInput").value.trim();
  if (answer.length < 3) { alert("write a real answer"); return; }
  $("answerSend").disabled = true;
  socket.emit("submitAnswer", { answer }, (r) => {
    $("answerSend").disabled = false;
    if (r?.error) alert(r.error);
  });
});

// settings modal
function openSettings() {
  $("settingsModal").classList.remove("hidden");
  $("settingsModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function closeSettings() {
  $("settingsModal").classList.add("hidden");
  $("settingsModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}
$("settingsBtn").addEventListener("click", openSettings);
$("settingsModal").addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settingsModal").classList.contains("hidden")) closeSettings();
});
$("setAiCount").addEventListener("change", () => {
  const aiCount = Math.max(2, Math.min(6, parseInt($("setAiCount").value, 10) || 4));
  $("setAiCount").value = aiCount;
  $("setSlotHint").textContent = aiCount + 1;
  socket.emit("settings", { settings: { aiCount } });
});

$("copyLink").addEventListener("click", async () => {
  const url = `${location.origin}/#${me.roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    $("copyLink").textContent = "copied";
    setTimeout(() => ($("copyLink").textContent = "copy link"), 1500);
  } catch {}
});

applyHashMode();

// power-on self test: run the BIOS boot once per visit, skipped on plain
// refreshes and for reduced motion - same pattern as raising a curtain.
(function bootBios() {
  const el = $("bios");
  if (!el) return;
  let seen = false;
  try {
    seen = !!sessionStorage.getItem("wetware:bios");
    sessionStorage.setItem("wetware:bios", "1");
  } catch {}
  if (seen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.remove();
    return;
  }
  document.body.classList.add("booting");

  // tick the memory count up while the log prints
  const mem = document.getElementById("biosMem");
  if (mem && window.requestAnimationFrame) {
    const target = 640, dur = 900;
    let start = null;
    const tick = (now) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / dur);
      mem.textContent = String(Math.floor(t * target)).padStart(6, "0");
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(() => el.classList.add("run"));
  setTimeout(() => el.classList.add("off"), 2700);
  setTimeout(() => {
    el.remove();
    document.body.classList.remove("booting");
  }, 3300);
})();
