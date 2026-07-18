# wetware

A party game where one of you pretends to be an AI. The **operator** sends a prompt to the machine and gets back a line-up of answers - all but one written by Claude. The odd one out is the **imposter**: a human, the *wetware*, trying to pass as software. Everyone else reads the answers and votes on which one still has a pulse.

Dressed up as a possessed 1992 arcade cabinet (heavy CRT, scanlines, red/blue glitch) but plays like a phone-friendly party game: open a channel, share the link, play across the room.

## A round

1. **Roles.** Each round the app secretly picks one **operator** (public - they write the prompt) and one **imposter** (secret - the human hiding among the machines). Everyone else are **detectives**. Roles rotate every round.
2. **The prompt.** The operator asks the machine a question - ideally one an imposter can't easily fake.
3. **The answers.** The machine (Claude) writes several answers to the prompt. At the same time, the imposter writes one answer of their own, trying to blend in. Every answer - human and machine - is held to **at most 3 sentences** so length can't give the human away. They're shuffled into a lettered line-up.
4. **The vote.** Every detective reads the line-up and votes for the answer they think a human wrote. The imposter sits it out.
5. **The reveal.** The human answer is unmasked, the imposter is named, and the votes are tallied. Detectives who caught the imposter score a point each; the imposter scores a point for everyone they fooled. Running scores carry across rounds.

3+ players. Channels expire after 24h idle.

## The machine

With an `ANTHROPIC_API_KEY` set, the decoy answers are written live by Claude (`claude-opus-4-8` by default) from the operator's prompt, capped at 3 sentences each. Without a key, the game falls back to a canned pool of generic AI-sounding lines so it still runs offline (they won't match the prompt, so it's easier - handy for local testing).

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

- **machine answers per round** (2-6, default 4). The imposter's answer is shuffled in among these, so 3-7 answers go up for the vote.

## Test games (solo)

There's a hidden back room for trying the app out alone. It's not shown anywhere in the lobby - to open it, type the **test pin** into the `CHANNEL CODE` box (with a handle filled in) and hit *jack in*. The pin lives on the server (`TEST_PIN`, default `GHOST`), never in the client bundle, so a normal player sees no sign the mode exists. A wrong guess just falls through to an ordinary join.

Test tables:

- get a `TEST-XXXX` code and live in their own Redis namespace (`testroom:*`), so they never collide with or show up alongside real channels.
- let the host seat **auto-playing bots** ("add bots" in the lobby). A bot operator writes a canned prompt, a bot imposter writes a canned answer, and bot detectives vote at random - so one person can run a whole game start to finish, no second device needed.

Set `TEST_PIN` to change the pin, or `TEST_PIN=""` to disable test tables entirely.
