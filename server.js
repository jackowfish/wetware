import express from "express";
import http from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PORT = Number(process.env.PORT || 3000);

// the model that writes the decoy answers. an imposter tries to blend in with
// these, so keep it the strongest available - a lazy model is easy to spot.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// the hidden back room. a test table only opens for whoever types this pin
// into the table-code box - it lives on the server, never in the client
// bundle, so the lobby gives no sign the mode exists. set TEST_PIN="" to turn
// the whole thing off.
const TEST_PIN = process.env.TEST_PIN ?? "GHOST";

// the Anthropic client is optional. with a key set, decoy answers are written
// live from the operator's prompt; without one, we fall back to a canned pool
// so the game is still playable (and testable) offline - just less pointed.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ maxRetries: 1 })
  : null;

const redisOpts = { maxRetriesPerRequest: null, enableReadyCheck: true };
const redis = new Redis(REDIS_URL, redisOpts);
const pubClient = new Redis(REDIS_URL, redisOpts);
const subClient = pubClient.duplicate();

for (const [name, client] of [["redis", redis], ["pub", pubClient], ["sub", subClient]]) {
  client.on("error", (err) => console.error(`[${name}] redis error:`, err.message));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
io.adapter(createAdapter(pubClient, subClient));

app.use(express.json());
app.get("/health", (_req, res) => res.type("text/plain").send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const rid = (n = 4) =>
  Array.from({ length: n }, () =>
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]
  ).join("");

const tok = () => crypto.randomBytes(16).toString("hex");

// slot labels for the line-up of answers (A, B, C, ...)
const LABELS = "ABCDEFGH".split("");

// ---------------------------------------------------------------------------
// the machine's voice. when a key is present we ask the model for N distinct
// answers to the operator's prompt; the imposter's single answer is shuffled
// in among them. these instructions try to keep the machine answers natural
// and varied so the human has cover to hide behind.
// ---------------------------------------------------------------------------

const systemPrompt = (n) =>
  `You are generating candidate answers for a party game called WETWARE. ` +
  `Players are shown several answers to a single prompt and must guess which one ` +
  `was secretly written by a human pretending to be an AI. ` +
  `Write exactly ${n} DISTINCT answers to the user's prompt. ` +
  `Each answer should read like a natural, helpful AI assistant reply - plausible, ` +
  `clear, and genuinely responsive to the prompt. Vary the phrasing and angle ` +
  `across the ${n} answers so they don't feel templated. ` +
  `HARD LIMIT: each answer is AT MOST 3 sentences and under 55 words - shorter is ` +
  `better, and one or two sentences is ideal. Never exceed 3 sentences. ` +
  `Do not number them, quote them, or add any labels. ` +
  `Return JSON of the form {"answers": ["...", "..."]}.`;

const ANSWERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { answers: { type: "array", items: { type: "string" } } },
  required: ["answers"],
};

// generic, prompt-agnostic decoys for when there's no API key (or the call
// fails). they read like an assistant hedging, so the game still works offline.
const FALLBACK_ANSWERS = [
  "That's a great question! There are a few different angles to consider, and the right one really depends on your specific situation.",
  "Broadly speaking, the answer comes down to a trade-off between speed and reliability - most people lean toward reliability.",
  "It's worth noting that there isn't a single correct answer here; context matters a lot, so I'd start by clarifying your goals.",
  "In most cases, the simplest approach that meets your needs is the best one. Complexity should be added only when it earns its keep.",
  "Here's a concise take: start small, measure the results, and iterate from there. That loop tends to beat over-planning up front.",
  "A helpful way to think about this is to break it into smaller parts and tackle each one in order of impact.",
  "Great topic. The short version is that it depends on a handful of factors, but a reasonable default works well for most people.",
  "I'd recommend weighing the pros and cons carefully. Both options are viable; the better choice depends on what you value most.",
  "From what I understand, the consensus is that consistency matters more than intensity over the long run.",
  "One thing to keep in mind is that small, steady improvements usually compound into much larger results than occasional big pushes.",
  "The most common recommendation is to focus on fundamentals first, then optimize the details once the basics are solid.",
  "There are several schools of thought on this. A practical middle ground is usually a safe and effective place to begin.",
  "To keep it simple: define what success looks like, then work backward from there to figure out the steps.",
  "Honestly, the best answer depends on your constraints - time, budget, and how much risk you're comfortable with.",
  "A good rule of thumb is to prioritize the option that's easiest to reverse if it turns out to be wrong.",
  "That's something a lot of people wonder about. The evidence generally points toward moderation and consistency.",
  "It can help to consider both the short-term and long-term effects before committing to a single approach.",
  "The key is to match the solution to the actual problem rather than reaching for whatever is most popular.",
  "I'd suggest experimenting with a small version first, seeing how it feels, and scaling up only if it works for you.",
  "Ultimately it comes down to your priorities. If you tell me a bit more about your goals, I can give a sharper recommendation.",
  "A balanced approach usually wins here - too far in either direction tends to create problems of its own.",
  "Most experts agree that clarity and consistency beat cleverness almost every time.",
  "The straightforward answer is yes, with a caveat: it works best when you tailor it to your particular circumstances.",
  "Think of it as a starting point rather than a final answer - adjust as you learn what works for you.",
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const cleanText = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 600);

// hold every answer to the same shape - at most 3 sentences - so length can't
// give the human away and a chatty model can't run long.
function capSentences(s, maxSentences = 3, maxChars = 320) {
  let t = cleanText(s);
  const parts = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (parts && parts.length > maxSentences) t = parts.slice(0, maxSentences).join("").trim();
  if (t.length > maxChars) t = t.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
  return t;
}

// take whatever the model returned (or nothing) and make it exactly n distinct,
// non-empty answers - padding from the canned pool if the model came up short.
function normalizeAnswers(raw, n) {
  const seen = new Set();
  const out = [];
  const push = (t) => {
    const c = capSentences(t);
    const key = c.toLowerCase();
    if (c && !seen.has(key)) { seen.add(key); out.push(c); }
  };
  if (Array.isArray(raw)) for (const t of raw) { push(t); if (out.length >= n) break; }
  if (out.length < n) for (const t of shuffle(FALLBACK_ANSWERS)) { push(t); if (out.length >= n) break; }
  return out.slice(0, n);
}

// ask the model for n decoy answers to the prompt. returns an array of strings,
// or null on any failure (the caller pads/falls back from the canned pool).
async function generateAiResponses(prompt, n) {
  if (!anthropic) return null;
  try {
    const resp = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt(n),
        messages: [{ role: "user", content: cleanText(prompt) || "Say hello." }],
        output_config: { format: { type: "json_schema", schema: ANSWERS_SCHEMA }, effort: "low" },
      },
      { timeout: 45000 }
    );
    const text = (resp.content || []).find((b) => b.type === "text")?.text || "";
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.answers) ? parsed.answers : null;
  } catch (e) {
    console.error("ai generation failed:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// rooms - one operator (host), everyone else joins with a code. same room /
// socket / redis plumbing as the deck app this grew out of.
// ---------------------------------------------------------------------------

const defaultSettings = () => ({ aiCount: 4 });
const aiCountOf = (s) => Math.max(2, Math.min(6, Math.floor(Number(s?.aiCount)) || 4));
const MIN_PLAYERS = 3; // one operator, one imposter, and at least one voter

const isTestRoom = (r) => typeof r === "string" && r.startsWith("TEST-");
const nsFor = (r) => (isTestRoom(r) ? "testroom" : "room");

const keys = {
  meta: (r) => `${nsFor(r)}:${r}:meta`,
  members: (r) => `${nsFor(r)}:${r}:members`,
  game: (r) => `${nsFor(r)}:${r}:game`,
  bots: (r) => `${nsFor(r)}:${r}:bots`,
};

const TTL = 60 * 60 * 24;

async function touch(roomId) {
  await Promise.all([
    redis.expire(keys.meta(roomId), TTL),
    redis.expire(keys.members(roomId), TTL),
    redis.expire(keys.game(roomId), TTL),
    redis.expire(keys.bots(roomId), TTL),
  ]);
}

async function loadRoom(roomId) {
  const meta = await redis.hgetall(keys.meta(roomId));
  if (!meta || !meta.hostToken) return null;
  const members = await redis.hgetall(keys.members(roomId));
  const raw = await redis.get(keys.game(roomId));
  const game = raw ? JSON.parse(raw) : null;
  if (game) {
    game.votes ??= {};
    game.scores ??= {};
    game.aiPending ??= false;
    game.aiResponses ??= null;
    game.slots ??= null;
    game.reveal ??= null;
  }
  const settings = meta.settings ? JSON.parse(meta.settings) : defaultSettings();
  const bots = new Set(await redis.smembers(keys.bots(roomId)));
  return { meta, members, game, settings, bots, isTest: isTestRoom(roomId) };
}

async function saveGame(roomId, game) {
  await redis.set(keys.game(roomId), JSON.stringify(game), "EX", TTL);
}

// every mutating action does load -> change -> save; serialize per room so the
// cycle is atomic (across instances too, since the lock lives in redis).
const RELEASE_LOCK =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function withLock(roomId, fn) {
  const lockKey = `${nsFor(roomId)}:${roomId}:lock`;
  const token = crypto.randomBytes(8).toString("hex");
  const deadline = Date.now() + 5000;
  while (!(await redis.set(lockKey, token, "PX", 5000, "NX"))) {
    if (Date.now() > deadline) throw new Error("lock timeout");
    await new Promise((res) => setTimeout(res, 15));
  }
  try {
    return await fn();
  } finally {
    redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// the round. phases: prompt -> answering -> voting -> reveal. one operator
// writes a prompt; a secret imposter writes one answer; the machine writes the
// rest; everyone votes on which answer has a pulse.
// ---------------------------------------------------------------------------

function pickRoles(memberIds, prev) {
  const ids = shuffle(memberIds);
  // rotate the operator off the previous one when we can
  let promptMasterId = ids.find((id) => id !== prev?.promptMasterId) ?? ids[0];
  // the imposter is anyone but the operator; avoid a repeat when possible
  const pool = memberIds.filter((id) => id !== promptMasterId);
  let imposterId =
    shuffle(pool).find((id) => id !== prev?.imposterId) ?? shuffle(pool)[0];
  return { promptMasterId, imposterId };
}

function newRound(memberIds, prev) {
  const { promptMasterId, imposterId } = pickRoles(memberIds, prev);
  return {
    round: prev ? prev.round + 1 : 1,
    phase: "prompt", // prompt -> answering -> voting -> reveal
    players: [...memberIds], // snapshot: who's dealt into this round
    promptMasterId,
    imposterId,
    prompt: null,
    aiPending: false,
    aiResponses: null,
    imposterAnswer: null,
    slots: null, // [{ id, text, isHuman, authorId }] once the line-up is set
    votes: {}, // memberId -> slotId
    reveal: null,
    scores: prev?.scores ? { ...prev.scores } : {}, // carry the running tally
  };
}

const votersOf = (g) => g.players.filter((id) => id !== g.imposterId);

// build the shuffled line-up once both the imposter and the machine are in
function maybeBuildSlots(g) {
  if (g.phase !== "answering") return false;
  if (g.imposterAnswer == null || g.aiPending || !Array.isArray(g.aiResponses)) return false;
  const entries = shuffle([
    { text: capSentences(g.imposterAnswer), isHuman: true, authorId: g.imposterId },
    ...g.aiResponses.map((t) => ({ text: t, isHuman: false, authorId: null })),
  ]);
  g.slots = entries.map((e, i) => ({ id: LABELS[i], ...e }));
  g.votes = {};
  g.phase = "voting";
  return true;
}

// close the vote: tally, reveal the pulse, and score. detectives who fingered
// the human earn a point each; the imposter earns one for every voter fooled.
function closeVoting(g) {
  const human = g.slots.find((s) => s.isHuman);
  const tally = Object.fromEntries(g.slots.map((s) => [s.id, 0]));
  for (const v of Object.values(g.votes)) if (tally[v] !== undefined) tally[v] += 1;

  let caught = 0;
  let fooled = 0;
  for (const voter of votersOf(g)) {
    const v = g.votes[voter];
    if (v === undefined) continue;
    if (v === human.id) {
      caught += 1;
      g.scores[voter] = (g.scores[voter] || 0) + 1;
    } else {
      fooled += 1;
    }
  }
  g.scores[g.imposterId] = (g.scores[g.imposterId] || 0) + fooled;

  g.reveal = {
    humanSlotId: human.id,
    imposterId: g.imposterId,
    tally,
    votes: { ...g.votes },
    caught,
    fooled,
  };
  g.phase = "reveal";
}

function recheckVoting(g) {
  if (g.phase !== "voting") return false;
  const voters = votersOf(g);
  if (voters.length && voters.every((id) => g.votes[id] !== undefined)) {
    closeVoting(g);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// live decoy generation. kicking the model is async, so it happens outside the
// per-room lock; the result is written back under the lock once it lands. a
// per-round in-flight guard keeps a single request from firing twice.
// ---------------------------------------------------------------------------

const aiInFlight = new Set();

function ensureAiKicked(roomId, g, aiCount) {
  if (!g || g.phase !== "answering" || !g.aiPending || g.prompt == null) return;
  const key = `${roomId}:${g.round}`;
  if (aiInFlight.has(key)) return;
  aiInFlight.add(key);
  generateAndStore(roomId, g.round, g.prompt, aiCount).finally(() => aiInFlight.delete(key));
}

async function generateAndStore(roomId, round, prompt, aiCount) {
  const raw = await generateAiResponses(prompt, aiCount);
  const answers = normalizeAnswers(raw, aiCount);
  await withLock(roomId, async () => {
    const r = await loadRoom(roomId);
    if (!r || !r.game) return;
    const g = r.game;
    if (g.round !== round || g.phase !== "answering" || !g.aiPending) return; // stale
    g.aiResponses = answers;
    g.aiPending = false;
    progress(r); // may build the line-up and let bot voters weigh in
    await saveGame(roomId, g);
  });
  broadcast(roomId);
}

// ---------------------------------------------------------------------------
// test players (bots): only ever seated in a TEST- room, so one person can run
// a whole game solo. a bot operator writes a canned prompt, a bot imposter
// writes a canned answer, and bot voters guess at random.
// ---------------------------------------------------------------------------

const BOT_PROMPTS = [
  "What's the best way to make new friends as an adult?",
  "Explain why the sky is blue in one sentence.",
  "Give me a tip for staying focused while working from home.",
  "What's a good icebreaker question for a party?",
  "How do I keep a houseplant alive?",
  "Suggest a fun weekend activity that costs nothing.",
  "What's the secret to a good cup of coffee?",
  "How can I get better at remembering people's names?",
];
const BOT_ANSWERS = [
  "Honestly the easiest win is to just show up regularly to the same places - familiarity does a lot of the work for you.",
  "It comes down to how sunlight scatters, and shorter blue wavelengths scatter the most, so that's what fills the sky.",
  "Try working in focused blocks with a clear start and stop time, and put your phone in another room.",
  "Ask people what they've been unreasonably excited about lately - it beats 'what do you do' every time.",
  "Give it bright indirect light and only water it when the top inch of soil is dry to the touch.",
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// run every pending bot action for the current phase, looping because closing
// one phase can open the next (a submitted prompt lands in answering, a built
// line-up lands in voting).
function driveBots(g, bots) {
  if (!g || !bots || bots.size === 0) return;
  for (let guard = 0; guard < 50; guard++) {
    let acted = false;
    if (g.phase === "prompt") {
      if (bots.has(g.promptMasterId) && g.prompt == null) {
        g.prompt = pick(BOT_PROMPTS);
        g.phase = "answering";
        g.aiPending = true;
        g.aiResponses = null;
        acted = true;
      }
    } else if (g.phase === "answering") {
      if (bots.has(g.imposterId) && g.imposterAnswer == null) {
        g.imposterAnswer = pick(BOT_ANSWERS);
        acted = true;
      }
      if (maybeBuildSlots(g)) acted = true;
    } else if (g.phase === "voting") {
      for (const id of votersOf(g)) {
        if (!bots.has(id) || g.votes[id] !== undefined) continue;
        g.votes[id] = pick(g.slots).id;
        acted = true;
      }
      if (recheckVoting(g)) acted = true;
    }
    if (!acted) break;
  }
}

// settle whatever the last mutation opened up: let bots act, build the line-up
// if it's ready, and close the vote if everyone living is in.
function progress(r) {
  const g = r.game;
  if (!g) return;
  driveBots(g, r.bots);
  maybeBuildSlots(g);
  driveBots(g, r.bots);
  recheckVoting(g);
}

// ---------------------------------------------------------------------------
// pull somebody out of a running round (they left or were dropped)
// ---------------------------------------------------------------------------

function removeFromRound(g, memberId) {
  if (!g || !g.players.includes(memberId)) return;
  g.players = g.players.filter((id) => id !== memberId);
  delete g.votes[memberId];
  delete g.scores[memberId];
  // if the operator or the imposter walks before their turn, the round can't
  // finish - flag it so the operator can deal a fresh one.
  if (g.phase !== "reveal") {
    if (memberId === g.promptMasterId && g.prompt == null) g.stalled = true;
    if (memberId === g.imposterId && g.slots == null) g.stalled = true;
  }
}

// ---------------------------------------------------------------------------
// state fan-out: one public payload for the room, one private payload per
// player (their role, their answer, their vote - never the imposter's identity
// until the reveal).
// ---------------------------------------------------------------------------

function actedThisPhase(g, id) {
  if (g.phase !== "voting") return true; // only the vote shows a per-player status
  if (id === g.imposterId) return true; // the imposter never votes - blend them in
  if (!g.players.includes(id)) return true; // spectators aren't voting
  return g.votes[id] !== undefined;
}

function publicState(roomId, r) {
  const { meta, members, game: g, settings } = r;
  const n = aiCountOf(settings);
  const memberIds = Object.keys(members);
  const scores = g?.scores || {};
  const out = {
    roomId,
    isTest: !!r.isTest,
    hasAi: !!anthropic,
    aiCount: n,
    slotCount: n + 1,
    minPlayers: MIN_PLAYERS,
    phase: g ? g.phase : "lobby",
    round: g ? g.round : 0,
    members: memberIds.map((id) => ({
      id,
      name: members[id],
      isHost: id === meta.hostId,
      isBot: r.bots ? r.bots.has(id) : false,
      inRound: g ? g.players.includes(id) : false,
      acted: g ? actedThisPhase(g, id) : false,
      score: scores[id] || 0,
    })),
  };
  if (!g) return out;

  out.promptMasterId = g.promptMasterId; // the operator is public knowledge
  out.stalled = !!g.stalled;
  out.scoreboard = memberIds
    .map((id) => ({ id, name: members[id], score: scores[id] || 0 }))
    .sort((a, b) => b.score - a.score);

  if (["answering", "voting", "reveal"].includes(g.phase)) out.prompt = g.prompt;
  if (g.phase === "answering") out.aiPending = g.aiPending;
  if (g.phase === "voting") {
    out.slots = g.slots.map((s) => ({ id: s.id, text: s.text }));
    out.votesIn = Object.keys(g.votes).length;
    out.votersTotal = votersOf(g).length;
  }
  if (g.phase === "reveal" && g.reveal) {
    out.slots = g.slots.map((s) => ({ id: s.id, text: s.text, isHuman: s.isHuman }));
    out.reveal = {
      humanSlotId: g.reveal.humanSlotId,
      imposterId: g.reveal.imposterId,
      tally: g.reveal.tally,
      votes: g.reveal.votes,
      caught: g.reveal.caught,
      fooled: g.reveal.fooled,
      votersTotal: votersOf(g).length,
    };
  }
  return out;
}

function privateState(r, id) {
  const g = r.game;
  if (!g || !g.players.includes(id)) return { role: "spectator" };
  const out = {};
  out.isPromptMaster = g.promptMasterId === id;
  out.isImposter = g.imposterId === id;
  out.role = out.isPromptMaster ? "operator" : out.isImposter ? "imposter" : "voter";
  if (out.isImposter && g.imposterAnswer != null) out.myAnswer = g.imposterAnswer;
  if (g.votes[id] !== undefined) out.myVote = g.votes[id];
  return out;
}

async function broadcast(roomId) {
  try {
    const r = await loadRoom(roomId);
    if (!r) return;
    io.to(roomId).emit("state", publicState(roomId, r));
    for (const id of Object.keys(r.members)) {
      io.to(`${roomId}:m:${id}`).emit("private", privateState(r, id));
    }
    touch(roomId).catch(() => {});
  } catch (e) {
    console.error(`broadcast failed for room ${roomId}:`, e);
  }
}

// ---------------------------------------------------------------------------
// http + sockets
// ---------------------------------------------------------------------------

app.post("/api/rooms", async (req, res) => {
  const name = (req.body?.name || "Host").toString().slice(0, 40);
  const test = !!req.body?.test;
  if (test) {
    const pin = String(req.body?.pin ?? "").trim();
    if (!TEST_PIN || pin.toUpperCase() !== TEST_PIN.toUpperCase()) {
      return res.status(403).json({ error: "no such table" });
    }
  }
  let roomId;
  for (let i = 0; i < 5; i++) {
    roomId = test ? `TEST-${rid()}` : rid();
    const exists = await redis.exists(keys.meta(roomId));
    if (!exists) break;
  }
  const hostId = crypto.randomUUID();
  const hostToken = tok();
  await redis.hset(keys.meta(roomId), {
    hostId,
    hostToken,
    settings: JSON.stringify(defaultSettings()),
    createdAt: Date.now().toString(),
  });
  await redis.hset(keys.members(roomId), hostId, name);
  await touch(roomId);
  res.json({ roomId, hostId, hostToken });
});

io.on("connection", (socket) => {
  let joined = null; // { roomId, memberId, isHost }

  socket.on("hi", (_payload, ack) => ack?.({ ok: true }));

  const withRoom = (handler, { hostOnly = false } = {}) => async (payload, ack) => {
    try {
      if (!joined) return ack?.({ error: "not joined" });
      if (hostOnly && !joined.isHost) return ack?.({ error: "host only" });
      const err = await withLock(joined.roomId, async () => {
        const r = await loadRoom(joined.roomId);
        if (!r) return "room not found";
        return await handler(r, payload || {});
      });
      if (err) return ack?.({ error: err });
      ack?.({ ok: true });
      broadcast(joined.roomId);
    } catch (e) {
      console.error("handler error:", e);
      ack?.({ error: "something went wrong" });
    }
  };

  socket.on("join", async ({ roomId, name, memberId, hostToken }, ack) => {
    roomId = (roomId || "").toUpperCase().trim();
    const r = await loadRoom(roomId);
    if (!r) return ack?.({ error: "room not found" });

    let id = memberId;
    let isHost = false;

    if (hostToken && hostToken === r.meta.hostToken) {
      id = r.meta.hostId;
      isHost = true;
    } else if (id && r.members[id]) {
      // returning member
    } else {
      const wanted = (name || "").trim().toLowerCase();
      const seat = wanted && Object.entries(r.members).find(
        ([mid, n]) => mid !== r.meta.hostId && n.trim().toLowerCase() === wanted
      );
      id = seat ? seat[0] : crypto.randomUUID();
    }

    const displayName = (name || r.members[id] || "Stranger").toString().slice(0, 40);
    await redis.hset(keys.members(roomId), id, displayName);

    joined = { roomId, memberId: id, isHost };
    socket.join(roomId);
    socket.join(`${roomId}:m:${id}`);
    ack?.({ memberId: id, isHost });
    broadcast(roomId);
  });

  // operator deals a fresh round: new operator, new secret imposter. works from
  // the lobby, after a reveal, or to reset a stalled round.
  socket.on("startRound", withRoom(async (r) => {
    const memberIds = Object.keys(r.members);
    if (memberIds.length < MIN_PLAYERS) return `need at least ${MIN_PLAYERS} at the table`;
    const g = newRound(memberIds, r.game);
    r.game = g;
    progress(r); // a bot operator writes the prompt immediately
    await saveGame(joined.roomId, g);
    ensureAiKicked(joined.roomId, g, aiCountOf(r.settings));
  }, { hostOnly: true }));

  // the operator sends in their prompt; the machine starts writing decoys and
  // the imposter starts writing their answer.
  socket.on("submitPrompt", withRoom(async (r, { prompt }) => {
    const g = r.game;
    if (!g || g.phase !== "prompt") return "not the moment for a prompt";
    if (joined.memberId !== g.promptMasterId) return "only the operator writes the prompt";
    const p = cleanText(prompt);
    if (p.length < 3) return "give me a real prompt";
    g.prompt = p;
    g.phase = "answering";
    g.aiPending = true;
    g.aiResponses = null;
    progress(r); // a bot imposter answers right away
    await saveGame(joined.roomId, g);
    ensureAiKicked(joined.roomId, g, aiCountOf(r.settings));
  }));

  // the imposter slips their answer in among the machine's
  socket.on("submitAnswer", withRoom(async (r, { answer }) => {
    const g = r.game;
    if (!g || g.phase !== "answering") return "not the moment for an answer";
    if (joined.memberId !== g.imposterId) return "you're not the imposter this round";
    const a = cleanText(answer);
    if (a.length < 3) return "write a real answer";
    g.imposterAnswer = a;
    progress(r);
    await saveGame(joined.roomId, g);
  }));

  socket.on("vote", withRoom(async (r, { slotId }) => {
    const g = r.game;
    if (!g || g.phase !== "voting") return "the vote isn't open";
    const me = joined.memberId;
    if (!g.players.includes(me)) return "you're not in this round";
    if (me === g.imposterId) return "the imposter doesn't vote";
    if (!g.slots.some((s) => s.id === slotId)) return "pick one of the answers";
    g.votes[me] = slotId;
    progress(r);
    await saveGame(joined.roomId, g);
  }));

  // operator closes the vote early - whoever hasn't voted simply doesn't count
  socket.on("closeVoting", withRoom(async (r) => {
    const g = r.game;
    if (!g || g.phase !== "voting") return "the vote isn't open";
    if (Object.keys(g.votes).length === 0) return "nobody has voted yet";
    closeVoting(g);
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  socket.on("addBots", withRoom(async (r, { count }) => {
    if (!r.isTest) return "test players are only for test tables";
    const n = Math.max(1, Math.min(12, Math.floor(Number(count)) || 1));
    const seated = Object.keys(r.members).length;
    if (seated + n > 20) return "the table is full (max 20)";
    const from = r.bots.size;
    const writes = {};
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = crypto.randomUUID();
      writes[id] = `Bot ${from + i + 1}`;
      ids.push(id);
    }
    await redis.hset(keys.members(joined.roomId), writes);
    await redis.sadd(keys.bots(joined.roomId), ...ids);
  }, { hostOnly: true }));

  socket.on("leave", withRoom(async (r) => {
    const me = joined.memberId;
    if (me === r.meta.hostId) return "the operator can't leave their own table";
    if (r.game) removeFromRound(r.game, me);
    await redis.hdel(keys.members(joined.roomId), me);
    if (r.game) {
      progress(r);
      await saveGame(joined.roomId, r.game);
    }
  }));

  socket.on("dropMember", withRoom(async (r, { memberId }) => {
    if (memberId === r.meta.hostId) return "you can't drop yourself";
    if (!r.members[memberId]) return "no such player";
    if (r.game) removeFromRound(r.game, memberId);
    await redis.hdel(keys.members(joined.roomId), memberId);
    await redis.srem(keys.bots(joined.roomId), memberId);
    if (r.game) {
      progress(r);
      await saveGame(joined.roomId, r.game);
    }
    io.to(`${joined.roomId}:m:${memberId}`).emit("kicked");
  }, { hostOnly: true }));

  socket.on("settings", withRoom(async (r, { settings }) => {
    const clean = {};
    if (settings?.aiCount !== undefined) clean.aiCount = aiCountOf(settings);
    const merged = { ...r.settings, ...clean };
    await redis.hset(keys.meta(joined.roomId), "settings", JSON.stringify(merged));
  }, { hostOnly: true }));

  socket.on("disconnect", () => {
    // keep membership so refreshes work; rooms expire via TTL
  });
});

server.listen(PORT, () => {
  console.log(`wetware listening on :${PORT}, redis=${REDIS_URL}, ai=${anthropic ? MODEL : "off (fallback pool)"}`);
});
