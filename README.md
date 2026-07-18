# wetware

A party game that plays out entirely inside a group text. Each of you texts the machine a prompt; then each of you is handed *someone else's* prompt and has to reply to it convincingly enough to pass as software. Every prompt's line-up is one human reply - the *wetware* - shuffled in among replies written by Claude. The group votes, prompt by prompt, on which reply still has a pulse.

Everybody types at once, so nobody just watches. Dressed as an **iMessage thread** - blue and gray bubbles, typing dots, tap-to-vote tapbacks, delivered receipts - it plays like a phone-friendly party game: start a conversation, share the link, play across the room. Light and dark modes follow your device.

## A game

1. **Prompts (everyone at once).** Every player texts one prompt to the machine. With a small group every prompt gets played; a big group caps how many go to a vote (`max prompts voted per game`, default 8).
2. **Replies (everyone at once).** Each player is handed one prompt that *isn't theirs* and replies as if they were the AI. Behind the scenes, Claude writes decoy replies for every prompt. Every reply - human and machine - is held to **at most 3 sentences** so length can't give the human away.
3. **The vote (one prompt at a time).** For each prompt, the shuffled line-up of replies goes up as chat bubbles and the whole group - except the person who wrote the human reply - taps the one they think a human wrote.
4. **The reveal.** The human reply is unmasked and the votes are tallied. **Scoring, imposter-Jackbox style:** every detective who catches the human banks a flat **+100**; the human banks up to **+100** scaled by the share of voters they slipped past - full marks if nobody spots them, nothing if everyone does.
5. **Final board.** After the last prompt, the leaderboard crowns whoever fooled and caught the most. Play again to reset.

3+ players. Conversations expire after 24h idle.

## The machine

With an `ANTHROPIC_API_KEY` set, the decoy replies are written live by Claude (`claude-opus-4-8` by default) from each prompt, capped at 3 sentences each. Without a key, the game falls back to a canned pool of generic AI-sounding lines so it still runs offline (they won't match the prompt, so it's easier - handy for local testing).

## Run

```
docker build -t wetware .
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... wetware
```

Open http://localhost:3000. (Omit the key to run in offline/fallback mode.)

Locally without Docker:

```
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

This needs a Redis on `127.0.0.1:6379` (the Docker image bundles one; `start.sh` boots it automatically).

## Config

| env | default | what |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `ANTHROPIC_API_KEY` | _(unset)_ | Anthropic key. Unset → offline fallback pool. |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Model that writes the decoy answers. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string. If unset or pointing at localhost, an in-container Redis is started; otherwise the bundled one stays off. |
| `TEST_PIN` | `GHOST` | Pin that opens a hidden solo test table (see below). Set to `""` to disable. |

## Deploy (HA)

Point `REDIS_URL` at a shared Redis (any non-localhost host) and run as many replicas as you like - Socket.IO uses the Redis adapter so conversations and events are shared across instances.

## Setup (host settings)

- **machine replies per prompt** (2-6, default 4). The human's reply is shuffled in among these, so 3-7 replies go up for each vote.
- **max prompts voted per game** (1-12, default 8). Everyone always writes a prompt and a reply; with a big group only this many prompts go to a vote so a game doesn't drag.

## Test games (solo)

There's a hidden back room for trying the app out alone. It's not shown anywhere in the lobby - to open it, type the **test pin** into the `To:` conversation-code box (with a name filled in) and tap *Join conversation*. The pin lives on the server (`TEST_PIN`, default `GHOST`), never in the client bundle, so a normal player sees no sign the mode exists. A wrong guess just falls through to an ordinary join.

Test conversations:

- get a `TEST-XXXX` code and live in their own Redis namespace (`testroom:*`), so they never collide with or show up alongside real conversations.
- let the host seat **auto-playing bots** ("Add bots" in the lobby). Bots write canned prompts, reply to their assigned prompt with a canned line, and vote at random - so one person can run a whole game start to finish (the host still taps through the reveals), no second device needed.

Set `TEST_PIN` to change the pin, or `TEST_PIN=""` to disable test conversations entirely.
