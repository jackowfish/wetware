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
let composeMode = null;      // "prompt" | "answer" | null
let threadEntered = false;   // force-scroll on first paint of the thread
let renderedKeys = new Set();

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
  if (!res.ok) { $("lobbyErr").textContent = "couldn't start a conversation"; return; }
  const { roomId, hostId, hostToken } = await res.json();
  store.set(roomId, { memberId: hostId, hostToken, name });
  location.hash = roomId;
  enterRoom(roomId, name, { hostToken });
}

async function joinRoom(codeOverride) {
  const raw = (codeOverride || $("joinCode").value).trim();
  const code = raw.toUpperCase();
  const name = $("name").value.trim() || (store.get(code)?.name || "");
  if (!code) { $("lobbyErr").textContent = "enter a conversation code"; return; }
  if (!name) { $("lobbyErr").textContent = "enter your name"; return; }

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
  renderedKeys = new Set();
  threadEntered = false;
  me = { roomId: null, memberId: null, isHost: false, name: me.name };
  hide($("room"));
  closeSheet($("settingsModal"));
  closeSheet($("detailsSheet"));
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
    exitToLobby("the host removed you from the conversation.");
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
          threadEntered = true;
          $("roomName").textContent = roomId;
          $("detailCode").textContent = roomId;
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

// a stable initials + color index for a name, iMessage-avatar style
function avatarInfo(name) {
  const s = String(name || "?");
  const parts = s.trim().split(/[\s_.\-]+/).filter(Boolean);
  let initials;
  if (parts.length >= 2) initials = parts[0][0] + parts[1][0];
  else initials = (s.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2) || s.slice(0, 2) || "?");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return { initials: initials.toUpperCase(), idx: h % 10 };
}

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

// ── message builders (each returns a spec pushed into the thread list) ──────

const MACHINE = "WETWARE";

// an incoming/outgoing chat bubble; returns { el, side, isBubble, bubble, avatar }
function bubbleRow({ key, side, name, html, sms, votable, onVote, picked, humanPick,
                    badgeHtml, metaHtml, tapbackHtml }) {
  const row = el("div", "row " + (side === "out" ? "out" : "in"));
  row.dataset.key = key;

  let avatar = null;
  if (side === "in") {
    if (name === MACHINE) {
      avatar = el("span", "row-avatar av-machine", "W");
    } else {
      const a = avatarInfo(name);
      avatar = el("span", `row-avatar av-${a.idx}`, escapeHtml(a.initials));
    }
    row.appendChild(avatar);
  }

  const stack = el("div", "stack");
  if (badgeHtml) stack.appendChild(el("div", "reveal-badge " + (humanPick ? "human" : "machine"), badgeHtml));

  const bubble = el("div", "bubble " + (side === "out" ? "out" : "in") + (sms ? " sms" : ""));
  bubble.innerHTML = html;
  if (picked) bubble.classList.add("picked");
  if (humanPick) bubble.classList.add("human-answer");
  if (tapbackHtml) bubble.appendChild(el("span", "tapback", tapbackHtml));
  stack.appendChild(bubble);

  if (metaHtml) stack.appendChild(el("div", "slot-meta", metaHtml));
  row.appendChild(stack);

  if (votable && onVote) {
    row.classList.add("votable");
    row.addEventListener("click", onVote);
  }
  return { el: row, side, isBubble: true, bubble, avatar, key };
}

function sysLine(key, html) {
  const n = el("div", "sys", html);
  n.dataset.key = key;
  return { el: n, isBubble: false, key };
}
function sysTime(key, html) {
  const n = el("div", "sys-time", html);
  n.dataset.key = key;
  return { el: n, isBubble: false, key };
}
function receiptRow(key, label, cls) {
  const n = el("div", "receipt " + (cls || ""), label);
  n.dataset.key = key;
  return { el: n, isBubble: false, key };
}
function typingRow(key, name) {
  const row = el("div", "typing-row");
  row.dataset.key = key;
  const a = name === MACHINE ? el("span", "row-avatar av-machine", "W")
    : (() => { const i = avatarInfo(name); return el("span", `row-avatar av-${i.idx}`, escapeHtml(i.initials)); })();
  row.appendChild(a);
  row.appendChild(el("div", "typing", "<i></i><i></i><i></i>"));
  return { el: row, isBubble: false, key };
}

// ── render ─────────────────────────────────────────────────────────────────

function render() {
  if (!latest) return;
  const s = latest;
  const phase = s.phase;

  // clear compose field when the game, phase, or voted item turns over
  if (phase !== renderedPhase || s.gameRound !== renderedRound || s.itemIndex !== renderedItem) {
    renderedPhase = phase;
    renderedRound = s.gameRound;
    renderedItem = s.itemIndex;
    resetCompose();
  }

  // nav bar
  $("roomName").textContent = s.roomId;
  $("detailCode").textContent = s.roomId;
  $("roomSub").innerHTML = navSub(s) + ' <span class="chev">›</span>';

  // lobby-only controls / setup availability
  $("settingsBtn").classList.toggle("hidden", !(me.isHost && phase === "lobby"));
  if (phase !== "lobby") closeSheet($("settingsModal"));

  // setup sheet values
  $("setAiCount").value = s.aiCount;
  $("setSlotHint").textContent = s.slotCount;
  if (s.maxRounds !== undefined) $("setMaxRounds").value = s.maxRounds;
  $("aiModeNote").textContent = s.hasAi
    ? "Live mode: the machine's decoy replies are written by AI from each prompt."
    : "Offline mode: no API key set, so decoy replies come from a canned pool (they won't match the prompt).";

  // build the conversation
  const msgs = buildThread(s);
  paintThread(msgs);

  // dock (composer + host actions)
  setDock(s);

  // details sheet
  renderMembers(s, phase);
  $("detailCount").textContent = s.members.length;
}

function navSub(s) {
  const n = s.members.length;
  switch (s.phase) {
    case "lobby": return `${n} ${n === 1 ? "person" : "people"}`;
    case "prompt": return "writing prompts";
    case "answering": return "faking replies";
    case "voting": return `prompt ${s.itemIndex + 1} of ${s.itemsTotal}`;
    case "reveal": return `prompt ${s.itemIndex + 1} of ${s.itemsTotal}`;
    case "gameover": return "game over";
    default: return `${n} people`;
  }
}

function buildThread(s) {
  const phase = s.phase;
  const msgs = [];
  const spectator = priv?.role === "spectator";

  if (phase === "lobby") {
    msgs.push(sysTime("t-start", `Conversation <b>${escapeHtml(s.roomId)}</b>`));
    if (s.members.length < s.minPlayers) {
      msgs.push(bubbleRow({ key: "welcome", side: "in", name: MACHINE,
        html: `Welcome. This is a group text where one reply always has a pulse — a human hiding among my machine replies.` }));
      msgs.push(sysLine("need", `${s.members.length} here — need at least <b>${s.minPlayers}</b> to play. Tap the name up top to grab the invite link.`));
    } else {
      msgs.push(bubbleRow({ key: "welcome", side: "in", name: MACHINE,
        html: `Everyone texts me a prompt, then each of you secretly answers <i>someone else's</i> prompt as if you were me. The group votes to unmask the human each round.` }));
      msgs.push(sysLine("ready", s.isTest
        ? `<b>${s.members.length}</b> here. Add some bots, then run it solo — they write, answer, and vote themselves.`
        : `<b>${s.members.length}</b> here. ${me.isHost ? "Start when everyone's in." : "Waiting on the host to start…"}`));
      if (!me.isHost) msgs.push(typingRow("lobby-wait", MACHINE));
    }
  }

  else if (phase === "prompt") {
    msgs.push(sysTime("t-prompt", `Round ${s.gameRound}`));
    if (spectator) {
      msgs.push(bubbleRow({ key: "spec", side: "in", name: MACHINE,
        html: `You joined mid-game — sit this one out and watch. You're dealt in next round.` }));
    } else {
      msgs.push(bubbleRow({ key: "prompt-ask", side: "in", name: MACHINE,
        html: `Text me a prompt — anything you'd ask a machine. Someone else will secretly answer it pretending to be me.` }));
      if (priv?.hasPrompt && priv?.myPrompt) {
        msgs.push(bubbleRow({ key: "my-prompt", side: "out", html: escapeHtml(priv.myPrompt) }));
        msgs.push(receiptRow("my-prompt-r", "Delivered", "read"));
      }
    }
    const waiting = s.promptsIn < s.playersTotal;
    if (waiting) {
      msgs.push(typingRow("prompt-typing", MACHINE));
      msgs.push(sysLine("prompt-count", `${s.promptsIn} of ${s.playersTotal} have texted their prompt…`));
    } else {
      msgs.push(sysLine("prompt-count", `All prompts in. Dealing them out…`));
    }
  }

  else if (phase === "answering") {
    msgs.push(sysTime("t-ans", `Round ${s.gameRound}`));
    const assignments = priv?.assignments || [];
    if (spectator) {
      msgs.push(bubbleRow({ key: "spec", side: "in", name: MACHINE,
        html: `The group is faking replies to each other's prompts. You're in next round.` }));
    } else {
      msgs.push(bubbleRow({ key: "ans-intro", side: "in", name: MACHINE,
        html: `Here's someone's prompt. Reply as if <i>you</i> were the machine — convincing enough that nobody guesses a human wrote it. Keep it to 3 sentences.` }));
      for (const a of assignments) {
        msgs.push(bubbleRow({ key: "ans-prompt-" + a.itemId, side: "in", name: MACHINE,
          html: `<span class="quote">${escapeHtml(a.promptText)}</span>` }));
        if (a.answered && a.myAnswer) {
          msgs.push(bubbleRow({ key: "ans-my-" + a.itemId, side: "out", html: escapeHtml(a.myAnswer) }));
          msgs.push(receiptRow("ans-my-r-" + a.itemId, "Delivered", "read"));
        }
      }
    }
    const aiLeft = (s.itemsTotal || 0) - (s.aiReady || 0);
    msgs.push(typingRow("ans-typing", MACHINE));
    msgs.push(sysLine("ans-count", aiLeft > 0
      ? `The machine is writing decoys (${s.aiReady}/${s.itemsTotal})…`
      : `Waiting on the last replies (${s.answersIn}/${s.itemsTotal})…`));
  }

  else if (phase === "voting") {
    msgs.push(sysTime("t-vote", `Prompt ${s.itemIndex + 1} of ${s.itemsTotal}`));
    msgs.push(bubbleRow({ key: "vote-prompt-" + s.itemIndex, side: "in", name: MACHINE,
      html: `Someone asked me:<span class="quote">${escapeHtml(s.prompt || "")}</span>` }));

    const amAnswerer = !!priv?.amAnswerer;
    const canVote = !amAnswerer && !spectator;
    const voted = priv?.myVote !== undefined;

    if (amAnswerer) {
      msgs.push(bubbleRow({ key: "vote-mine", side: "in", name: MACHINE,
        html: `This is your prompt — your fake reply is hiding in the line-up below. Sit tight and hope they miss it.` }));
    } else if (spectator) {
      msgs.push(bubbleRow({ key: "vote-spec", side: "in", name: MACHINE,
        html: `You're watching this game — no vote this round.` }));
    } else {
      msgs.push(bubbleRow({ key: "vote-instr-" + s.itemIndex, side: "in", name: MACHINE,
        html: `One of these replies was written by a human pretending to be me. <b>Tap the impostor.</b>` }));
    }

    for (const slot of s.slots || []) {
      const mine = priv?.myVote === slot.id;
      msgs.push(bubbleRow({
        key: "vote-slot-" + s.itemIndex + "-" + slot.id,
        side: "in", name: MACHINE,
        html: `<span class="tag">${escapeHtml(slot.id)}</span>${escapeHtml(slot.text)}`,
        picked: mine,
        tapbackHtml: mine ? "✋" : null,
        votable: canVote && !voted,
        onVote: canVote && !voted
          ? () => socket.emit("vote", { slotId: slot.id }, (r) => { if (r?.error) alert(r.error); })
          : null,
      }));
    }

    if (canVote) {
      msgs.push(voted
        ? sysLine("vote-locked", `Vote locked — <b>${s.votesIn}/${s.votersTotal}</b> in.`)
        : sysLine("vote-count", `${s.votesIn} of ${s.votersTotal} have voted…`));
    } else {
      msgs.push(sysLine("vote-count", `${s.votesIn} of ${s.votersTotal} have voted…`));
    }
  }

  else if (phase === "reveal") {
    const rv = s.reveal;
    msgs.push(sysTime("t-reveal", `Prompt ${s.itemIndex + 1} of ${s.itemsTotal}`));
    msgs.push(bubbleRow({ key: "rev-prompt-" + s.itemIndex, side: "in", name: MACHINE,
      html: `Someone asked me:<span class="quote">${escapeHtml(s.prompt || "")}</span>` }));

    if (rv) {
      const votersBySlot = {};
      for (const [voter, slotId] of Object.entries(rv.votes || {})) {
        (votersBySlot[slotId] = votersBySlot[slotId] || []).push(voter);
      }
      for (const slot of s.slots || []) {
        const count = rv.tally[slot.id] || 0;
        const voters = (votersBySlot[slot.id] || []).map((v) => escapeHtml(nameOf(v))).join(", ");
        msgs.push(bubbleRow({
          key: "rev-slot-" + s.itemIndex + "-" + slot.id,
          side: "in", name: MACHINE,
          html: `<span class="tag">${escapeHtml(slot.id)}</span>${escapeHtml(slot.text)}`,
          humanPick: slot.isHuman,
          picked: priv?.myVote === slot.id && !slot.isHuman,
          badgeHtml: slot.isHuman ? "🎭 the human" : "🤖 machine",
          tapbackHtml: count > 0 ? `✋ ${count}` : null,
          metaHtml: voters ? `<span class="voters">picked by ${voters}</span>` : null,
        }));
      }

      const iWasAnswerer = rv.answererId === me.memberId;
      const myVote = priv?.myVote;
      const gotIt = myVote === rv.humanSlotId;
      let summary = `<b>${escapeHtml(rv.answererName)}</b> faked the reply to <b>${escapeHtml(rv.authorName)}</b>'s prompt. `;
      summary += `${rv.caught} of ${rv.votersTotal} caught it; ${rv.fooled} got fooled.`;
      if (iWasAnswerer) {
        summary += rv.impPts > 0 ? ` You fooled ${rv.fooled} — <b>+${rv.impPts}</b> to you.` : " Everyone caught you. No points.";
      } else if (!spectator && myVote !== undefined) {
        const got = rv.points?.[me.memberId] || CATCH_POINTS;
        summary += gotIt ? ` You nailed it — <b>+${got}</b>.` : " You got fooled.";
      }
      msgs.push(bubbleRow({ key: "rev-summary-" + s.itemIndex, side: "in", name: MACHINE, html: summary }));
      msgs.push(scoreCardSpec("rev-score-" + s.itemIndex, s.scoreboard, "Scores", null, false));
    }
  }

  else if (phase === "gameover") {
    const w = s.winner;
    msgs.push(sysTime("t-over", "Game over"));
    msgs.push(bubbleRow({ key: "over-msg", side: "in", name: MACHINE,
      html: w && w.score > 0
        ? `That's a wrap. <b>${escapeHtml(w.name)}</b> fooled and caught the most.`
        : `That's a wrap — a dead heat, nobody scored. Brutal.` }));
    msgs.push(scoreCardSpec("final-score", s.finalBoard, "Final scores",
      w && w.score > 0 ? `${escapeHtml(w.name)} wins with ${w.score} point${w.score === 1 ? "" : "s"}` : "nobody scored", true));
    if (me.isHost) msgs.push(sysLine("over-again", "Tap Play again to reset the board."));
  }

  return msgs;
}

function scoreCardSpec(key, board, title, sub, final) {
  const card = el("div", "score-card" + (final ? " final" : ""));
  card.dataset.key = key;
  let html = `<div class="score-title">${title}</div>`;
  if (sub) html += `<div class="score-sub">${sub}</div>`;
  html += `<div class="score-list">`;
  const rows = board || [];
  const top = rows[0]?.score || 0;
  rows.forEach((row, i) => {
    const a = avatarInfo(row.name);
    const leader = row.score > 0 && row.score === top;
    html += `<div class="score-row${leader ? " leader" : ""}">
      <span class="score-rank">${leader ? "🏆" : i + 1}</span>
      <span class="score-av av-${a.idx}">${escapeHtml(a.initials)}</span>
      <span class="score-name">${escapeHtml(row.name)}${row.id === me.memberId ? '<span class="you-chip">You</span>' : ""}</span>
      <span class="score-val">${row.score}</span>
    </div>`;
  });
  html += `</div>`;
  card.innerHTML = html;
  return { el: card, isBubble: false, key };
}

// paint: rebuild the thread, group consecutive bubbles, animate only new keys
function paintThread(msgs) {
  const thread = $("thread");
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;

  const prev = renderedKeys;
  const next = new Set();
  thread.innerHTML = "";

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!prev.has(m.key)) m.el.classList.add("fresh");
    next.add(m.key);
    thread.appendChild(m.el);
  }

  // group tails: a run of same-side bubbles reads as one message group
  const bubbles = msgs.filter((m) => m.isBubble);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m.isBubble) continue;
    const prevM = i > 0 ? msgs[i - 1] : null;
    const nextM = i < msgs.length - 1 ? msgs[i + 1] : null;
    const startsGroup = !prevM || !prevM.isBubble || prevM.side !== m.side;
    const endsGroup = !nextM || !nextM.isBubble || nextM.side !== m.side;
    m.el.classList.add(startsGroup && endsGroup ? "grp-solo"
      : startsGroup ? "grp-start" : endsGroup ? "grp-end" : "grp-mid");
    if (endsGroup) m.el.classList.add("tail");
    if (m.side === "in" && m.avatar && !endsGroup) m.avatar.classList.add("ghost");
  }

  renderedKeys = next;
  if (nearBottom || threadEntered) {
    threadEntered = false;
    requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
  }
}

// ── dock: composer + host action buttons ─────────────────────────────────────

function setDock(s) {
  const phase = s.phase;
  const spectator = priv?.role === "spectator";
  const bar = $("actionBar");
  bar.innerHTML = "";
  const actions = [];

  // decide compose mode
  let mode = null;
  if (phase === "prompt" && !spectator && !priv?.hasPrompt) mode = "prompt";
  else if (phase === "answering" && !spectator) {
    const pending = (priv?.assignments || []).find((a) => !a.answered);
    if (pending) { mode = "answer"; answerTargetItem = pending.itemId; }
  }
  setComposer(mode);

  // host action buttons
  if (me.isHost) {
    if (phase === "lobby") {
      const enough = s.members.length >= s.minPlayers;
      actions.push(actBtn(enough ? "Start game" : `Need ${s.minPlayers}+ people`, "act-primary",
        () => emitSimple("startGame")(), !enough));
      if (s.isTest) {
        const wrap = el("div", "bot-inline");
        const inp = el("input"); inp.type = "number"; inp.min = 1; inp.max = 12; inp.value = 4;
        inp.inputMode = "numeric"; inp.id = "botCount";
        const btn = actBtn("Add bots", "act-ghost", () => {
          const count = Math.max(1, Math.min(12, parseInt(inp.value, 10) || 1));
          emitSimple("addBots")({ count });
        });
        btn.style.width = "auto"; btn.style.padding = "0.5em 1em";
        wrap.append("Test players:", inp, btn);
        actions.push(wrap);
      }
    } else if (phase === "prompt" && s.promptsIn > 0) {
      actions.push(actBtn("Skip stragglers → deal replies", "act-ghost", () => emitSimple("advance")()));
    } else if (phase === "answering" && (s.aiReady || 0) > 0 && (s.answersIn || 0) > 0) {
      actions.push(actBtn("Skip stragglers → open the vote", "act-ghost", () => emitSimple("advance")()));
    } else if (phase === "voting" && s.votesIn > 0) {
      actions.push(actBtn("Close the vote", "act-green", () => emitSimple("advance")()));
    } else if (phase === "reveal") {
      actions.push(actBtn(s.isLastItem ? "Final results" : "Next prompt", "act-primary", () => emitSimple("advance")()));
    } else if (phase === "gameover") {
      actions.push(actBtn("Play again", "act-primary", () => emitSimple("startGame")()));
    }
  }

  for (const a of actions) bar.appendChild(a);
  bar.classList.toggle("hidden", actions.length === 0);
}

function actBtn(label, cls, onClick, disabled) {
  const b = el("button", "act-btn " + cls, escapeHtml(label));
  b.disabled = !!disabled;
  b.addEventListener("click", onClick);
  return b;
}

function setComposer(mode) {
  const composer = $("composer");
  const input = $("composeInput");
  if (!mode) { composer.classList.add("hidden"); composeMode = null; return; }
  composer.classList.remove("hidden");
  if (mode !== composeMode) {
    composeMode = mode;
    if (mode === "prompt") {
      input.maxLength = 240;
      input.placeholder = "Text the machine a prompt…";
      $("composeHint").textContent = "Someone else will answer this as the machine.";
    } else {
      input.maxLength = 200;
      input.placeholder = "Reply as the machine…";
      $("composeHint").textContent = "Max 3 sentences — blend in with the decoys.";
    }
    updateCount();
  }
}

function resetCompose() {
  const input = $("composeInput");
  input.value = "";
  input.style.height = "auto";
  composeMode = null;
  updateCount();
  $("composeSend").disabled = true;
}

function updateCount() {
  const input = $("composeInput");
  const n = input.value.length;
  $("composeCount").textContent = n ? `${n}/${input.maxLength}` : "";
  $("composeSend").disabled = input.value.trim().length < 1;
}

function sendCompose() {
  const input = $("composeInput");
  const text = input.value.trim();
  if (composeMode === "prompt") {
    if (text.length < 3) { alert("give me a real prompt"); return; }
    $("composeSend").disabled = true;
    socket.emit("submitPrompt", { prompt: text }, (r) => {
      if (r?.error) { alert(r.error); updateCount(); }
    });
  } else if (composeMode === "answer") {
    if (text.length < 3) { alert("write a real reply"); return; }
    $("composeSend").disabled = true;
    socket.emit("submitAnswer", { itemId: answerTargetItem, answer: text }, (r) => {
      if (r?.error) { alert(r.error); updateCount(); }
    });
  }
}

// ── members / details ────────────────────────────────────────────────────────

function renderMembers(s, phase) {
  const ul = $("members");
  ul.innerHTML = "";
  const live = phase !== "lobby" && phase !== "gameover";
  for (const m of s.members) {
    const li = el("li");
    const spectating = !m.inGame && live;
    if (spectating) li.classList.add("spectating");

    const a = avatarInfo(m.name);
    li.appendChild(el("span", `m-av av-${a.idx}`, escapeHtml(a.initials)));

    const tags = [];
    if (m.id === me.memberId) tags.push(`<span class="m-tag you">You</span>`);
    if (m.isHost) tags.push(`<span class="m-tag host">Host</span>`);
    if (m.isBot) tags.push(`<span class="m-tag bot">Bot</span>`);

    let status = "";
    if (spectating) status = "watching";
    else if (phase === "prompt") status = m.acted ? "prompt sent" : "typing…";
    else if (phase === "answering") status = m.acted ? "reply sent" : "faking…";
    else if (phase === "voting") status = m.acted ? "voted" : "deciding…";
    else if (phase === "lobby") status = m.isHost ? "host" : "ready";

    const main = el("div", "m-main");
    main.appendChild(el("span", "m-name", `${escapeHtml(m.name)} <span class="m-tags">${tags.join("")}</span>`));
    if (status) main.appendChild(el("span", "m-status", status));
    li.appendChild(main);

    if (m.score) li.appendChild(el("span", "m-score", String(m.score)));

    // rename yourself (lobby only), or host drop others
    if (m.id === me.memberId && phase === "lobby") {
      const edit = el("button", "drop-btn", "Edit");
      edit.style.color = "var(--imsg-blue-tint)";
      edit.addEventListener("click", doRename);
      li.appendChild(edit);
    } else if (me.isHost && !m.isHost && phase === "lobby") {
      const x = el("button", "drop-btn", "Remove");
      x.addEventListener("click", () => {
        if (confirm(`remove ${m.name}?`)) emitSimple("dropMember")({ memberId: m.id });
      });
      li.appendChild(x);
    }
    ul.appendChild(li);
  }
}

function doRename() {
  const n = (prompt("Your name", me.name) || "").trim().slice(0, 40);
  if (!n || n === me.name) return;
  me.name = n;
  store.set(me.roomId, { ...(store.get(me.roomId) || {}), name: n });
  rejoin?.();
}

// ── sheets ───────────────────────────────────────────────────────────────────

function openSheet(sheet) {
  sheet.classList.remove("hidden");
  sheet.setAttribute("aria-hidden", "false");
}
function closeSheet(sheet) {
  sheet.classList.add("hidden");
  sheet.setAttribute("aria-hidden", "true");
}

// ── wire up ────────────────────────────────────────────────────────────────

$("create").addEventListener("click", createRoom);
$("join").addEventListener("click", () => joinRoom());
function syncCreate() {
  const joining = $("joinCode").value.trim().length > 0;
  $("create").disabled = joining;
  $("create").textContent = joining ? "Clear the code to start new" : "Start a new conversation";
}
$("joinCode").addEventListener("input", syncCreate);
window.addEventListener("pageshow", syncCreate);
window.addEventListener("hashchange", applyHashMode);
$("name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("joinCode").value.trim() ? joinRoom() : createRoom(); } });
$("joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); joinRoom(); } });

$("leaveBtn").addEventListener("click", () => {
  if (!me.roomId) return;
  const midGame = latest && latest.phase !== "lobby" && !me.isHost;
  if (midGame && !confirm("Leave the conversation mid-round?")) return;
  if (!me.isHost) {
    socket?.emit("leave", {}, () => {});
    store.set(me.roomId, { name: (store.get(me.roomId) || {}).name });
  }
  exitToLobby();
});

const emitSimple = (event) => (payload = {}) =>
  socket.emit(event, payload, (r) => { if (r?.error) alert(r.error); });

// composer
const composeInput = $("composeInput");
composeInput.addEventListener("input", () => {
  composeInput.style.height = "auto";
  composeInput.style.height = Math.min(composeInput.scrollHeight, 120) + "px";
  updateCount();
});
composeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    if (composeInput.value.trim()) sendCompose();
  }
});
$("composeSend").addEventListener("click", sendCompose);

// details + setup sheets
$("navTitle").addEventListener("click", () => openSheet($("detailsSheet")));
$("settingsBtn").addEventListener("click", () => openSheet($("settingsModal")));
for (const sheet of [$("detailsSheet"), $("settingsModal")]) {
  sheet.addEventListener("click", (e) => { if (e.target.matches("[data-close]")) closeSheet(sheet); });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeSheet($("detailsSheet")); closeSheet($("settingsModal")); }
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
    $("copyLink").textContent = "Copied!";
    setTimeout(() => ($("copyLink").textContent = "Copy link"), 1500);
  } catch {}
});

applyHashMode();
syncCreate();
