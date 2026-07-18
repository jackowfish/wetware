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
// live from each player's prompt; without one, we fall back to a canned pool
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

// scoring, imposter-jackbox style. a detective who fingers the human banks a
// flat catch bonus; the human (imposter for that prompt) banks up to MAX_FOOL,
// scaled by the share of voters they slipped past - full marks if nobody spots
// them, nothing if everyone does.
const CATCH_POINTS = 100;
const MAX_FOOL = 100;

// ---------------------------------------------------------------------------
// the machine's voice. when a key is present we ask the model for N distinct
// answers to a player's prompt; that prompt's human answer is shuffled in among
// them. these instructions try to keep the machine answers natural and varied
// so the human has cover to hide behind.
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
// `avoid` holds text already spoken for (e.g. the human's answer) so a decoy
// can't accidentally duplicate it.
function normalizeAnswers(raw, n, avoid = []) {
  const seen = new Set(avoid.map((t) => capSentences(t).toLowerCase()));
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
// rooms - a host opens a channel, everyone else joins with a code. same room /
// socket / redis plumbing as the deck app this grew out of.
// ---------------------------------------------------------------------------

const defaultSettings = () => ({ aiCount: 4, maxRounds: 8 });
const aiCountOf = (s) => Math.max(2, Math.min(6, Math.floor(Number(s?.aiCount)) || 4));
// how many prompts actually go up for a vote. with a small table everyone's
// prompt gets played; a big table caps the number of voting rounds so a game
// doesn't drag. everyone still writes a prompt and an answer either way.
const maxRoundsOf = (s) => Math.max(1, Math.min(12, Math.floor(Number(s?.maxRounds)) || 8));
const MIN_PLAYERS = 3; // enough that every prompt has an answerer plus a voter

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
    game.prompts ??= {};
    game.items ??= [];
    game.scores ??= {};
    game.currentItem ??= 0;
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
// the game. one game is a full round-trip:
//
//   prompt     - EVERYONE writes one prompt at the same time
//   answering  - EVERYONE is handed someone else's prompt and answers it as if
//                they were the machine, all at once; the model writes decoys
//                for every prompt in parallel
//   voting     - the table votes on the answers to one prompt at a time
//   reveal     - who was human, who got fooled, points; host advances
//   ...voting/reveal repeat for each prompt that's in play...
//   gameover   - final leaderboard
//
// there's no per-round operator anymore: everybody types, every round.
// ---------------------------------------------------------------------------

function newGame(memberIds) {
  const scores = Object.fromEntries(memberIds.map((id) => [id, 0]));
  return {
    gameRound: 1,
    phase: "prompt", // prompt -> answering -> voting <-> reveal -> gameover
    players: [...memberIds], // snapshot: who's dealt into this game
    prompts: {}, // playerId -> prompt text
    items: [], // one per prompt in play (built when answering opens)
    currentItem: 0,
    scores,
  };
}

const activePlayers = (g, members) => g.players.filter((id) => members[id]);

// who may vote on a given item: everyone in the game except the person who
// wrote that item's human answer (they'd know their own).
const eligibleVoters = (g, item) => g.players.filter((id) => id !== item.answererId);

// hand each prompt in play to exactly one answerer who didn't write it, keeping
// the load even across the table so - with a small group - everyone answers
// once. greedy min-load with a few reshuffles lands a near-derangement.
function assignAnswerers(items, playerIds) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const load = Object.fromEntries(playerIds.map((id) => [id, 0]));
    for (const it of items) it.answererId = null;
    let ok = true;
    for (const it of shuffle(items)) {
      const cands = shuffle(playerIds.filter((id) => id !== it.authorId));
      if (!cands.length) { ok = false; break; }
      const min = Math.min(...cands.map((id) => load[id]));
      const pickId = shuffle(cands.filter((id) => load[id] === min))[0];
      it.answererId = pickId;
      load[pickId] += 1;
    }
    const loads = playerIds.map((id) => load[id]);
    const spread = Math.max(...loads) - Math.min(...loads);
    if (ok && spread <= 1 && items.every((it) => it.answererId && it.answererId !== it.authorId)) return;
  }
  // last-resort fill so nothing is left unassigned
  for (const it of items) {
    if (!it.answererId || it.answererId === it.authorId) {
      it.answererId = shuffle(playerIds.filter((id) => id !== it.authorId))[0] || playerIds[0];
    }
  }
}

// close the prompt phase: turn the submitted prompts into playable items,
// capped at maxRounds, and hand out answering assignments.
function startAnswering(r) {
  const g = r.game;
  const cap = maxRoundsOf(r.settings);
  let authors = shuffle(g.players.filter((id) => g.prompts[id] != null));
  if (authors.length > cap) authors = authors.slice(0, cap);
  g.items = authors.map((aid, i) => ({
    id: `I${i + 1}`,
    promptText: g.prompts[aid],
    authorId: aid,
    answererId: null,
    humanAnswer: null,
    aiResponses: null,
    aiPending: true,
    slots: null,
    votes: {},
    reveal: null,
  }));
  assignAnswerers(g.items, g.players);
  g.phase = "answering";
}

// build the shuffled line-up for one item once its human answer and the
// machine's decoys are both in.
function buildSlots(item) {
  if (item.slots) return;
  const entries = shuffle([
    { text: capSentences(item.humanAnswer), isHuman: true, authorId: item.answererId },
    ...item.aiResponses.map((t) => ({ text: t, isHuman: false, authorId: null })),
  ]);
  item.slots = entries.map((e, i) => ({ id: LABELS[i], ...e }));
}

const itemReady = (it) =>
  it.humanAnswer != null && Array.isArray(it.aiResponses) && !it.aiPending;

// close the vote on one item: tally, reveal the pulse, and score. detectives
// who fingered the human bank a flat catch bonus; the human banks a share of
// MAX_FOOL for every voter they slipped past.
function closeItemVoting(g, item) {
  const human = item.slots.find((s) => s.isHuman);
  const tally = Object.fromEntries(item.slots.map((s) => [s.id, 0]));
  for (const v of Object.values(item.votes)) if (tally[v] !== undefined) tally[v] += 1;

  const voters = eligibleVoters(g, item);
  const points = {};
  let caught = 0;
  let voted = 0;
  for (const voter of voters) {
    const v = item.votes[voter];
    if (v === undefined) continue;
    voted += 1;
    if (v === human.id) {
      caught += 1;
      points[voter] = (points[voter] || 0) + CATCH_POINTS;
    }
  }
  const fooled = voted - caught;
  const impPts = voted ? Math.round((MAX_FOOL * fooled) / voted) : 0;
  if (impPts) points[item.answererId] = (points[item.answererId] || 0) + impPts;

  for (const [id, d] of Object.entries(points)) g.scores[id] = (g.scores[id] || 0) + d;

  item.reveal = {
    humanSlotId: human.id,
    answererId: item.answererId,
    authorId: item.authorId,
    tally,
    votes: { ...item.votes },
    caught,
    fooled,
    voted,
    votersTotal: voters.length,
    impPts,
    points,
  };
  g.phase = "reveal";
}

// ---------------------------------------------------------------------------
// live decoy generation. kicking the model is async, so it happens outside the
// per-room lock; results are written back under the lock once they land. one
// request per item, guarded so it can't fire twice.
// ---------------------------------------------------------------------------

const aiInFlight = new Set();

function ensureAiKicked(roomId, g, aiCount) {
  if (!g || g.phase !== "answering") return;
  for (const it of g.items) {
    if (!it.aiPending || Array.isArray(it.aiResponses)) continue;
    const key = `${roomId}:${g.gameRound}:${it.id}`;
    if (aiInFlight.has(key)) continue;
    aiInFlight.add(key);
    generateAndStore(roomId, g.gameRound, it.id, it.promptText, it.humanAnswer, aiCount)
      .finally(() => aiInFlight.delete(key));
  }
}

async function generateAndStore(roomId, round, itemId, prompt, humanAnswer, aiCount) {
  const raw = await generateAiResponses(prompt, aiCount);
  const answers = normalizeAnswers(raw, aiCount, humanAnswer ? [humanAnswer] : []);
  await withLock(roomId, async () => {
    const r = await loadRoom(roomId);
    if (!r || !r.game) return;
    const g = r.game;
    if (g.gameRound !== round || g.phase !== "answering") return; // stale
    const it = g.items.find((x) => x.id === itemId);
    if (!it || Array.isArray(it.aiResponses)) return;
    it.aiResponses = answers;
    it.aiPending = false;
    settle(r); // may open the vote once every item is ready
    await saveGame(roomId, g);
  });
  broadcast(roomId);
}

// ---------------------------------------------------------------------------
// test players (bots): only ever seated in a TEST- room, so one person can run
// a whole game solo. bots write a canned prompt, answer their assignment with a
// canned line, and vote at random. the human host still drives the reveals.
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
  "What's an underrated life skill everyone should learn?",
  "How do you politely end a conversation you're stuck in?",
  "What's a simple way to eat a bit healthier?",
  "Recommend a way to unwind after a long day.",
];
const BOT_ANSWERS = [
  "Honestly the easiest win is to just show up regularly to the same places - familiarity does a lot of the work for you.",
  "It comes down to how sunlight scatters, and shorter blue wavelengths scatter the most, so that's what fills the sky.",
  "Try working in focused blocks with a clear start and stop time, and put your phone in another room.",
  "Ask people what they've been unreasonably excited about lately - it beats 'what do you do' every time.",
  "Give it bright indirect light and only water it when the top inch of soil is dry to the touch.",
  "Start with something small and low-stakes, then build on it once it feels like a habit rather than a chore.",
  "A good rule of thumb is to keep it simple and consistent - the fundamentals matter more than any clever trick.",
  "The short answer is that it depends on your goals, but a sensible default works well for most people.",
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// run every pending bot action for the current phase; returns whether anything
// changed so the settle loop knows to check for phase transitions again.
function driveBots(r) {
  const g = r.game;
  const bots = r.bots;
  if (!g || !bots || bots.size === 0) return false;
  let acted = false;
  if (g.phase === "prompt") {
    for (const id of g.players) {
      if (bots.has(id) && g.prompts[id] == null) { g.prompts[id] = pick(BOT_PROMPTS); acted = true; }
    }
  } else if (g.phase === "answering") {
    for (const it of g.items) {
      if (bots.has(it.answererId) && it.humanAnswer == null) { it.humanAnswer = pick(BOT_ANSWERS); acted = true; }
    }
  } else if (g.phase === "voting") {
    const it = g.items[g.currentItem];
    if (it && it.slots) {
      for (const id of eligibleVoters(g, it)) {
        if (bots.has(id) && it.votes[id] === undefined) { it.votes[id] = pick(it.slots).id; acted = true; }
      }
    }
  }
  return acted;
}

// phase transitions that fire on their own once the table has caught up.
function maybeStartAnswering(r) {
  const g = r.game;
  if (!g || g.phase !== "prompt") return false;
  const active = activePlayers(g, r.members);
  if (!active.length || !active.every((id) => g.prompts[id] != null)) return false;
  startAnswering(r);
  return true;
}

function maybeStartVoting(r) {
  const g = r.game;
  if (!g || g.phase !== "answering" || !g.items.length) return false;
  if (!g.items.every(itemReady)) return false;
  for (const it of g.items) buildSlots(it);
  g.currentItem = 0;
  g.phase = "voting";
  return true;
}

function maybeCloseItem(r) {
  const g = r.game;
  if (!g || g.phase !== "voting") return false;
  const it = g.items[g.currentItem];
  if (!it || !it.slots) return false;
  const voters = eligibleVoters(g, it).filter((id) => r.members[id]);
  if (!voters.length || !voters.every((id) => it.votes[id] !== undefined)) return false;
  closeItemVoting(g, it);
  return true;
}

// settle whatever the last mutation opened up: let bots act, advance any phase
// whose gate is satisfied, and loop until nothing else moves.
function settle(r) {
  if (!r.game) return;
  for (let guard = 0; guard < 80; guard++) {
    let changed = false;
    if (driveBots(r)) changed = true;
    if (maybeStartAnswering(r)) changed = true;
    if (maybeStartVoting(r)) changed = true;
    if (maybeCloseItem(r)) changed = true;
    if (!changed) break;
  }
}

// host advances from a reveal to the next item, or to the final board.
function advanceItem(g) {
  if (g.currentItem >= g.items.length - 1) {
    g.phase = "gameover";
  } else {
    g.currentItem += 1;
    g.phase = "voting";
  }
}

// ---------------------------------------------------------------------------
// pull somebody out of a running game (they left or were dropped)
// ---------------------------------------------------------------------------

function removeFromRound(g, memberId) {
  if (!g || !g.players.includes(memberId)) return;
  g.players = g.players.filter((id) => id !== memberId);
  delete g.prompts[memberId];
  delete g.scores[memberId];
  for (const it of g.items || []) {
    delete it.votes[memberId];
    // if they were on the hook to answer a prompt and hadn't yet, hand it off
    if (it.answererId === memberId && !it.slots && it.humanAnswer == null) {
      const cands = g.players.filter((id) => id !== it.authorId);
      it.answererId = cands.length ? shuffle(cands)[0] : null;
    }
  }
  // before the vote opens, drop any item that no longer has a way to be answered
  if (g.phase === "prompt" || g.phase === "answering") {
    g.items = (g.items || []).filter((it) => it.answererId || it.humanAnswer != null);
  }
}

// ---------------------------------------------------------------------------
// state fan-out: one public payload for the room, one private payload per
// player (their assignment, their answer, their vote - never who the human
// behind an answer is until that item's reveal).
// ---------------------------------------------------------------------------

// has this player done what the current phase asks of them?
function acted(r, id) {
  const g = r.game;
  if (!g || !g.players.includes(id)) return true;
  if (g.phase === "prompt") return g.prompts[id] != null;
  if (g.phase === "answering") {
    const mine = g.items.filter((it) => it.answererId === id);
    return mine.every((it) => it.humanAnswer != null);
  }
  if (g.phase === "voting") {
    const it = g.items[g.currentItem];
    if (!it) return true;
    if (it.answererId === id) return true; // the answerer sits this vote out
    return it.votes[id] !== undefined;
  }
  return true;
}

function scoreboardOf(g, members) {
  return g.players
    .filter((id) => members[id])
    .map((id) => ({ id, name: members[id], score: g.scores[id] || 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
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
    maxRounds: maxRoundsOf(settings),
    minPlayers: MIN_PLAYERS,
    phase: g ? g.phase : "lobby",
    gameRound: g ? g.gameRound : 0,
    members: memberIds.map((id) => ({
      id,
      name: members[id],
      isHost: id === meta.hostId,
      isBot: r.bots ? r.bots.has(id) : false,
      inGame: g ? g.players.includes(id) : false,
      acted: g ? acted(r, id) : false,
      score: scores[id] || 0,
    })),
  };
  if (!g) return out;

  out.scoreboard = scoreboardOf(g, members);

  if (g.phase === "prompt") {
    const active = activePlayers(g, members);
    out.promptsIn = active.filter((id) => g.prompts[id] != null).length;
    out.playersTotal = active.length;
  } else if (g.phase === "answering") {
    out.itemsTotal = g.items.length;
    out.answersIn = g.items.filter((it) => it.humanAnswer != null).length;
    out.aiReady = g.items.filter((it) => Array.isArray(it.aiResponses) && !it.aiPending).length;
  } else if (g.phase === "voting" || g.phase === "reveal") {
    const it = g.items[g.currentItem];
    out.itemIndex = g.currentItem;
    out.itemsTotal = g.items.length;
    if (it) {
      out.prompt = it.promptText;
      if (g.phase === "voting") {
        out.slots = it.slots.map((s) => ({ id: s.id, text: s.text }));
        const voters = eligibleVoters(g, it).filter((id) => members[id]);
        out.votesIn = voters.filter((id) => it.votes[id] !== undefined).length;
        out.votersTotal = voters.length;
      } else {
        const rev = it.reveal;
        out.slots = it.slots.map((s) => ({ id: s.id, text: s.text, isHuman: s.isHuman }));
        out.isLastItem = g.currentItem >= g.items.length - 1;
        out.reveal = {
          humanSlotId: rev.humanSlotId,
          answererId: rev.answererId,
          answererName: members[rev.answererId] || "someone",
          authorId: rev.authorId,
          authorName: members[rev.authorId] || "someone",
          tally: rev.tally,
          votes: rev.votes,
          caught: rev.caught,
          fooled: rev.fooled,
          voted: rev.voted,
          votersTotal: rev.votersTotal,
          impPts: rev.impPts,
          points: rev.points,
        };
      }
    }
  } else if (g.phase === "gameover") {
    out.finalBoard = out.scoreboard;
    out.winner = out.scoreboard[0] || null;
  }
  return out;
}

function privateState(r, id) {
  const g = r.game;
  if (!g || !g.players.includes(id)) return { role: "spectator", inGame: false };
  const out = { role: "player", inGame: true };
  if (g.phase === "prompt") {
    out.hasPrompt = g.prompts[id] != null;
    if (out.hasPrompt) out.myPrompt = g.prompts[id];
  } else if (g.phase === "answering") {
    out.assignments = g.items
      .filter((it) => it.answererId === id)
      .map((it) => ({
        itemId: it.id,
        promptText: it.promptText,
        answered: it.humanAnswer != null,
        myAnswer: it.humanAnswer || null,
      }));
  } else if (g.phase === "voting" || g.phase === "reveal") {
    const it = g.items[g.currentItem];
    if (it) {
      out.amAnswerer = it.answererId === id;
      out.wasAuthor = it.authorId === id;
      if (it.votes[id] !== undefined) out.myVote = it.votes[id];
    }
  }
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

  // host starts a fresh game: everyone is dealt in, everyone writes a prompt.
  // works from the lobby or after a game is over.
  socket.on("startGame", withRoom(async (r) => {
    const memberIds = Object.keys(r.members);
    if (memberIds.length < MIN_PLAYERS) return `need at least ${MIN_PLAYERS} on the channel`;
    const g = newGame(memberIds);
    r.game = g;
    settle(r); // bots write their prompts immediately
    await saveGame(joined.roomId, g);
    ensureAiKicked(joined.roomId, r.game, aiCountOf(r.settings));
  }, { hostOnly: true }));

  // any player submits their prompt for this game
  socket.on("submitPrompt", withRoom(async (r, { prompt }) => {
    const g = r.game;
    if (!g || g.phase !== "prompt") return "not the moment for a prompt";
    if (!g.players.includes(joined.memberId)) return "you're not in this game";
    const p = cleanText(prompt);
    if (p.length < 3) return "give me a real prompt";
    g.prompts[joined.memberId] = p;
    settle(r); // last prompt in? open the answering phase
    await saveGame(joined.roomId, g);
    ensureAiKicked(joined.roomId, r.game, aiCountOf(r.settings));
  }));

  // any player submits the answer to the prompt they were handed
  socket.on("submitAnswer", withRoom(async (r, { itemId, answer }) => {
    const g = r.game;
    if (!g || g.phase !== "answering") return "not the moment for an answer";
    const mine = g.items.filter((it) => it.answererId === joined.memberId && it.humanAnswer == null);
    if (!mine.length) return "nothing left for you to answer";
    const it = itemId ? mine.find((x) => x.id === itemId) : mine[0];
    if (!it) return "that prompt isn't yours to answer";
    const a = cleanText(answer);
    if (a.length < 3) return "write a real answer";
    it.humanAnswer = a;
    settle(r);
    await saveGame(joined.roomId, g);
  }));

  socket.on("vote", withRoom(async (r, { slotId }) => {
    const g = r.game;
    if (!g || g.phase !== "voting") return "the vote isn't open";
    const it = g.items[g.currentItem];
    if (!it || !it.slots) return "the vote isn't open";
    const me = joined.memberId;
    if (!g.players.includes(me)) return "you're not in this game";
    if (me === it.answererId) return "you wrote this answer - you can't vote on it";
    if (!it.slots.some((s) => s.id === slotId)) return "pick one of the answers";
    it.votes[me] = slotId;
    settle(r);
    await saveGame(joined.roomId, g);
  }));

  // host force-advances the current phase (skip stragglers / move on):
  //   prompt    -> close prompts early and deal answers
  //   answering -> open the vote with whatever's ready
  //   voting    -> close this vote now
  //   reveal    -> move to the next prompt (or the final board)
  socket.on("advance", withRoom(async (r) => {
    const g = r.game;
    if (!g) return "no game running";
    if (g.phase === "prompt") {
      if (!Object.keys(g.prompts).length) return "nobody has written a prompt yet";
      startAnswering(r);
      settle(r);
      await saveGame(joined.roomId, g);
      ensureAiKicked(joined.roomId, r.game, aiCountOf(r.settings));
      return;
    }
    if (g.phase === "answering") {
      const ready = g.items.filter(itemReady);
      if (!ready.length) return "no prompts are ready yet - give it a moment";
      g.items = ready;
      for (const it of g.items) buildSlots(it);
      g.currentItem = 0;
      g.phase = "voting";
      settle(r);
      await saveGame(joined.roomId, g);
      return;
    }
    if (g.phase === "voting") {
      const it = g.items[g.currentItem];
      if (!it || !it.slots) return "the vote isn't open";
      if (!Object.keys(it.votes).length) return "nobody has voted yet";
      closeItemVoting(g, it);
      await saveGame(joined.roomId, g);
      return;
    }
    if (g.phase === "reveal") {
      advanceItem(g);
      settle(r);
      await saveGame(joined.roomId, g);
      return;
    }
    return "nothing to advance";
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
    if (me === r.meta.hostId) return "the host can't leave their own channel";
    if (r.game) removeFromRound(r.game, me);
    await redis.hdel(keys.members(joined.roomId), me);
    if (r.game) {
      settle(r);
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
      settle(r);
      await saveGame(joined.roomId, r.game);
    }
    io.to(`${joined.roomId}:m:${memberId}`).emit("kicked");
  }, { hostOnly: true }));

  socket.on("settings", withRoom(async (r, { settings }) => {
    const clean = {};
    if (settings?.aiCount !== undefined) clean.aiCount = aiCountOf(settings);
    if (settings?.maxRounds !== undefined) clean.maxRounds = maxRoundsOf(settings);
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
