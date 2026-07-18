# wetware

A party game where everyone takes a turn pretending to be an AI. Each of you writes a prompt for the machine; then each of you is handed *someone else's* prompt and has to answer it convincingly enough to pass as software. Every prompt's line-up is one human answer - the *wetware* - shuffled in among answers written by Claude. The table votes, prompt by prompt, on which answer still has a pulse.

Everybody types at once, so nobody just watches. Dressed up as a possessed 1992 arcade cabinet (heavy CRT, scanlines, red/blue glitch) but plays like a phone-friendly party game: open a channel, share the link, play across the room.

## A game

1. **Prompts (everyone at once).** Every player writes one prompt for the machine. With a small table every prompt gets played; a big table caps how many go to a vote (`max prompts voted per game`, default 8).
2. **Answers (everyone at once).** Each player is handed one prompt that *isn't theirs* and answers it as if they were the AI. Behind the scenes, Claude writes decoy answers for every prompt. Every answer - human and machine - is held to **at most 3 sentences** so length can't give the human away.
3. **The vote (one prompt at a time).** For each prompt, the shuffled line-up goes up and the whole table - except the person who wrote the human answer - votes for the one they think a human wrote.
4. **The reveal.** The human answer is unmasked and the votes are tallied. **Scoring, imposter-Jackbox style:** every detective who catches the human banks a flat **+100**; the human banks up to **+100** scaled by the share of voters they slipped past - full marks if nobody spots them, nothing if everyone does.
5. **Final board.** After the last prompt, the leaderboard crowns whoever fooled and caught the most. Play again to reset.

3+ players. Channels expire after 24h idle.

## The machine

With an `ANTHROPIC_API_KEY` set, the decoy answers are written live by Claude (`claude-opus-4-8` by default) from each prompt, capped at 3 sentences each. Without a key, the game falls back to a canned pool of generic AI-sounding lines so it still runs offline (they won't match the prompt, so it's easier - handy for local testing).

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

Point `REDIS_URL` at a shared Redis (any non-localhost host) and run as many replicas as you like - Socket.IO uses the Redis adapter so channels and events are shared across instances.

## Setup (host settings)

- **machine answers per prompt** (2-6, default 4). The human's answer is shuffled in among these, so 3-7 answers go up for each vote.
- **max prompts voted per game** (1-12, default 8). Everyone always writes a prompt and an answer; with a big table only this many prompts go to a vote so a game doesn't drag.

## Test games (solo)

There's a hidden back room for trying the app out alone. It's not shown anywhere in the lobby - to open it, type the **test pin** into the `CHANNEL CODE` box (with a handle filled in) and hit *jack in*. The pin lives on the server (`TEST_PIN`, default `GHOST`), never in the client bundle, so a normal player sees no sign the mode exists. A wrong guess just falls through to an ordinary join.

Test tables:

- get a `TEST-XXXX` code and live in their own Redis namespace (`testroom:*`), so they never collide with or show up alongside real channels.
- let the host seat **auto-playing bots** ("add bots" in the lobby). Bots write canned prompts, answer their assigned prompt with a canned line, and vote at random - so one person can run a whole game start to finish (the host still clicks through the reveals), no second device needed.

Set `TEST_PIN` to change the pin, or `TEST_PIN=""` to disable test tables entirely.
