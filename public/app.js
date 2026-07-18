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
let renderedItem = null;
let answerTargetItem = null; // the item id the answer compose box submits to

const CATCH_POINTS = 100; // matches the server's flat bonus for catching a human

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
  prompt: "write a prompt",
  answering: "answer up",
  voting: "the vote",
  reveal: "the reveal",
  gameover: "game over",
};

// ── render ─────────────────────────────────────────────────────────────────

const STAGES = [
  "stageLobby", "stagePrompt", "stageAnswering", "stageVoting", "stageReveal", "stageGameover",
];

function render() {
  if (!latest) return;
  const s = latest;
  const phase = s.phase;

  // clear compose fields when the game, phase, or voted item turns over
  if (phase !== renderedPhase || s.gameRound !== renderedRound || s.itemIndex !== renderedItem) {
    renderedPhase = phase;
    renderedRound = s.gameRound;
    renderedItem = s.itemIndex;
    $("promptInput").value = "";
    $("answerInput").value = "";
    $("promptCount").textContent = "0";
    $("answerCount").textContent = "0";
    $("promptSend").disabled = false;
    $("answerSend").disabled = false;
  }

  // phase banner
  $("phaseLabel").textContent = PHASE_LABELS[phase] || phase;
  $("phaseLabel").dataset.phase = phase;
  const waitBits = [];
  if (s.gameRound > 0 && phase !== "gameover") waitBits.push(`game ${s.gameRound}`);
  if (phase === "prompt") waitBits.push(`${s.promptsIn}/${s.playersTotal} prompts in`);
  if (phase === "answering") waitBits.push(`${s.answersIn}/${s.itemsTotal} answers in`);
  if (phase === "voting") waitBits.push(`prompt ${s.itemIndex + 1}/${s.itemsTotal} · ${s.votesIn}/${s.votersTotal} votes`);
  if (phase === "reveal") waitBits.push(`prompt ${s.itemIndex + 1}/${s.itemsTotal}`);
  $("waitLabel").textContent = waitBits.join(" · ");

  // settings
  $("setAiCount").value = s.aiCount;
  $("setSlotHint").textContent = s.slotCount;
  if (s.maxRounds !== undefined) $("setMaxRounds").value = s.maxRounds;
  $("aiModeNote").textContent = s.hasAi
    ? "live mode: decoy answers are written by the machine from each prompt."
    : "offline mode: no API key set, so decoy answers come from a canned pool (they won't match the prompt).";

  // lobby-only controls
  $("renameBtn").classList.toggle("hidden", phase !== "lobby");
  $("settingsBtn").classList.toggle("hidden", !(me.isHost && phase === "lobby"));
  if (phase !== "lobby" && !$("settingsModal").classList.contains("hidden")) closeSettings();

  // role banner
  renderRoleNote(s);

  // stages
  for (const id of STAGES) hide($(id));
  const stage = {
    lobby: "stageLobby",
    prompt: "stagePrompt",
    answering: "stageAnswering",
    voting: "stageVoting",
    reveal: "stageReveal",
    gameover: "stageGameover",
  }[phase];
  if (stage) show($(stage));

  if (phase === "lobby") renderLobbyStage(s);
  if (phase === "prompt") renderPrompt(s);
  if (phase === "answering") renderAnswering(s);
  if (phase === "voting") renderVoting(s);
  if (phase === "reveal") renderReveal(s);
  if (phase === "gameover") renderGameover(s);

  renderMembers(s, phase);
}

function renderRoleNote(s) {
  const el = $("roleNote");
  const p = s.phase;
  if (p === "lobby" || p === "reveal" || p === "gameover") { hide(el); return; }
  let note = "";
  let role = "player";
  if (priv?.role === "spectator") {
    note = "👁 you joined mid-game — you're watching this one. you'll be dealt in next game.";
    role = "spectator";
  } else if (p === "prompt") {
    note = priv?.hasPrompt
      ? "✓ prompt in. sit tight while the rest of the channel writes theirs."
      : "✍ write a prompt for the machine. someone else will have to fake an answer to it.";
  } else if (p === "answering") {
    const list = priv?.assignments || [];
    const done = list.length > 0 && list.every((a) => a.answered);
    note = done
      ? "🎭 answer planted. now you're just another face in the line-up."
      : "🎭 you're the imposter for the prompt below — answer it like the machine would.";
  } else if (p === "voting") {
    note = priv?.amAnswerer
      ? "🎭 your fake answer is in this line-up. sit tight and hope they miss it."
      : "🔍 one of these answers has a pulse. read them and vote for the human.";
    role = priv?.amAnswerer ? "imposter" : "voter";
  }
  el.textContent = note;
  el.dataset.role = role;
  show(el);
}

function renderLobbyStage(s) {
  const n = s.members.length;
  let hint;
  if (n < s.minPlayers) {
    hint = `${n} on the channel — need at least ${s.minPlayers} to play. share the link.`;
  } else if (s.isTest) {
    hint = `${n} on the channel. boot the game, then run it solo — the bots write, answer, and vote themselves.`;
  } else {
    hint = `${n} on the channel. everyone writes a prompt, everyone fakes an answer to someone else's, then the table votes to unmask the humans.`;
  }
  $("lobbyHint").textContent = hint;
  $("botRow").classList.toggle("hidden", !(s.isTest && me.isHost));
  $("startRow").classList.toggle("hidden", !me.isHost);
  $("startBtn").disabled = n < s.minPlayers;
  $("startBtn").textContent = n < s.minPlayers ? `need ${s.minPlayers}+ players` : "▶ boot the game";
}

function renderPrompt(s) {
  const submitted = !!priv?.hasPrompt;
  const spectator = priv?.role === "spectator";
  $("promptCompose").classList.toggle("hidden", submitted || spectator);
  $("promptDone").classList.toggle("hidden", !submitted || spectator);
  const waiting = s.promptsIn < s.playersTotal;
  $("promptProgress").classList.toggle("hidden", !waiting);
  $("promptProgressText").textContent = `${s.promptsIn}/${s.playersTotal} prompts transmitted…`;
  $("promptSkipRow").classList.toggle("hidden", !(me.isHost && s.promptsIn > 0));
}

function renderAnswering(s) {
  const assignments = priv?.assignments || [];
  const spectator = priv?.role === "spectator";

  const box = $("assignmentBox");
  box.innerHTML = "";
  let pending = null;
  for (const a of assignments) {
    const el = document.createElement("div");
    el.className = "assignment" + (a.answered ? " answered" : "");
    el.innerHTML = `
      <div class="assignment-tag">${a.answered ? "✓ your answer" : "🎭 fake an answer to this"}</div>
      <div class="prompt-quote">${escapeHtml(a.promptText)}</div>
      ${a.answered ? `<div class="assignment-answer">&ldquo;${escapeHtml(a.myAnswer)}&rdquo;</div>` : ""}
    `;
    box.appendChild(el);
    if (!a.answered && !pending) pending = a;
  }
  answerTargetItem = pending?.itemId || null;

  const composing = !!pending && !spectator;
  $("answerCompose").classList.toggle("hidden", !composing);
  const allDone = assignments.length > 0 && assignments.every((a) => a.answered);
  $("answerDone").classList.toggle("hidden", !(allDone && !composing));

  const waiting = !composing;
  $("answeringSpinner").classList.toggle("hidden", !waiting);
  const aiLeft = (s.itemsTotal || 0) - (s.aiReady || 0);
  $("answeringSpinnerText").textContent = aiLeft > 0
    ? `the machine is composing decoys (${s.aiReady}/${s.itemsTotal})…`
    : `waiting on the last answers (${s.answersIn}/${s.itemsTotal})…`;

  $("answeringHead").textContent = composing
    ? "answer as the machine"
    : allDone ? "answer planted" : "answers incoming";
  $("answeringLead").classList.toggle("hidden", !composing && !spectator);
  if (spectator) {
    $("answeringLead").textContent = "the table is faking answers to each other's prompts. you're in next game.";
  } else if (composing) {
    $("answeringLead").textContent = "you've been handed someone else's prompt. answer it so convincingly nobody guesses a human wrote it.";
  }

  $("answerSkipRow").classList.toggle("hidden", !(me.isHost && (s.aiReady || 0) > 0 && (s.answersIn || 0) > 0));
}

function renderVoting(s) {
  $("votingChip").textContent = `prompt ${s.itemIndex + 1} of ${s.itemsTotal}`;
  $("votingPrompt").textContent = s.prompt || "";
  const amAnswerer = !!priv?.amAnswerer;
  const spectator = priv?.role === "spectator";
  const canVote = !amAnswerer && !spectator;
  const voted = priv?.myVote !== undefined;

  $("votingLead").textContent = amAnswerer
    ? "this is your prompt — your fake answer is in the line-up. sit tight."
    : spectator
      ? "you're watching this game — no vote."
      : voted
        ? "vote locked. see if the rest of the table can spot the human too."
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
  $("revealChip").textContent = `prompt ${s.itemIndex + 1} of ${s.itemsTotal}`;
  $("revealPrompt").textContent = s.prompt || "";
  if (!rv) return;

  const iWasAnswerer = rv.answererId === me.memberId;
  const myVote = priv?.myVote;
  const gotIt = myVote === rv.humanSlotId;

  $("revealHead").textContent = "the human was " + rv.humanSlotId;
  let lead = `${escapeHtml(rv.answererName)} faked the answer to ${escapeHtml(rv.authorName)}'s prompt. `;
  lead += `${rv.caught} of ${rv.votersTotal} spotted it; ${rv.fooled} got fooled.`;
  if (iWasAnswerer) {
    lead += rv.impPts > 0 ? ` you fooled ${rv.fooled} — +${rv.impPts} to you.` : " everyone caught you. no points.";
  } else if (priv?.role !== "spectator" && myVote !== undefined) {
    const got = rv.points?.[me.memberId] || CATCH_POINTS;
    lead += gotIt ? ` you nailed it — +${got}.` : " you got fooled.";
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

  renderScoreboard(s.scoreboard, "scoreboard");
  $("nextBtn").textContent = s.isLastItem ? "▶ final results" : "▶ next prompt";
  $("nextRow").classList.toggle("hidden", !me.isHost);
}

function renderGameover(s) {
  const w = s.winner;
  $("gameoverLead").textContent = w && w.score > 0
    ? `${w.name} wins with ${w.score} point${w.score === 1 ? "" : "s"}.`
    : "a dead heat — nobody scored. brutal.";
  renderScoreboard(s.finalBoard, "finalBoard");
  $("againRow").classList.toggle("hidden", !me.isHost);
}

function renderScoreboard(board, targetId) {
  const box = $(targetId);
  box.innerHTML = `<h3 class="score-head">scores</h3>`;
  const list = document.createElement("div");
  list.className = "score-list";
  const rows = board || [];
  const top = rows[0]?.score || 0;
  for (const row of rows) {
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
  const live = phase !== "lobby" && phase !== "gameover";
  for (const m of s.members) {
    const li = document.createElement("li");
    const spectating = !m.inGame && live;
    if (spectating) li.classList.add("spectating");
    if (live && m.acted && m.inGame) li.classList.add("acted");
    const tags = [];
    if (m.id === me.memberId) tags.push(`<span class="you-tag">you</span>`);
    if (m.isHost) tags.push(`<span class="host-tag">🛰 host</span>`);
    if (m.isBot) tags.push(`<span class="bot-tag">🤖</span>`);

    let status = "";
    if (spectating) status = "watching";
    else if (phase === "prompt") status = m.acted ? "prompt in ✓" : "writing…";
    else if (phase === "answering") status = m.acted ? "answer in ✓" : "faking…";
    else if (phase === "voting") status = m.acted ? "voted ✓" : "deciding…";

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
$("startBtn").addEventListener("click", () => emitSimple("startGame")());
$("againBtn").addEventListener("click", () => emitSimple("startGame")());
$("nextBtn").addEventListener("click", () => emitSimple("advance")());
$("closeVoteBtn").addEventListener("click", () => emitSimple("advance")());
$("promptSkipBtn").addEventListener("click", () => emitSimple("advance")());
$("answerSkipBtn").addEventListener("click", () => emitSimple("advance")());

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
  socket.emit("submitAnswer", { itemId: answerTargetItem, answer }, (r) => {
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
$("setMaxRounds").addEventListener("change", () => {
  const maxRounds = Math.max(1, Math.min(12, parseInt($("setMaxRounds").value, 10) || 8));
  $("setMaxRounds").value = maxRounds;
  socket.emit("settings", { settings: { maxRounds } });
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
