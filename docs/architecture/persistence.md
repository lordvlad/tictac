---
title: "Persistence: Database Port, Migrations, Accounts & Rosters"
id: "ARCH-PERSISTENCE"
type: "architecture"
status: "active"
lastReviewed: "2026-10-07"
appliesTo:
  - "src/server/**"
  - "scripts/serve-match.ts"
  - "src/game/Account.ts"
  - "src/game/Base64Url.ts"
  - "src/game/MatchEnd.ts"
  - "src/game/Recording.ts"
  - "src/core/Characters.ts"
  - "src/hud/RosterScreen.ts"
  - "src/config.ts"
relatedDocs:
  - "docs/design/rfc/0001-referee-and-transports.md"
  - "docs/architecture/networking.md"
  - "docs/backlog/active-backlog.md"
tags: ["persistence", "database", "sqlite", "postgres", "webauthn", "passkeys", "roster"]
---

# Persistence: Database Port, Migrations, Accounts & Rosters

What the match server keeps, and why it is kept the way it is. Local and
peer-to-peer play are untouched by everything in this document: they roll a
fresh squad per match and write nothing anywhere.

---

## 1. One Database, One Port

Where the database will finally live is open — a Durable Object per match, or
one central Postgres — so nothing above `src/server/db/Db.ts` knows which engine
it is speaking to. `Bun.SQL` already speaks SQLite and Postgres through one
tagged-template interface, so the port is thin: no ORM, no driver, no
dependency.

```
openPersistence(url, party)
  └── openDb(url) ── dialectOf(url) → 'sqlite' | 'postgres'
        └── migrate(db, MIGRATIONS)
              ├── MatchStore   — matches, events
              ├── RoomStore    — rooms
              ├── Accounts     — players, credentials, sessions, auth_challenges
              └── Rosters      — roster, match_results
```

`Persistence` is the only thing that opens a database. Every store is handed
one, which is what lets the referee, the HTTP API and the tests share one
transaction-capable connection instead of three that can disagree.

### Portability rules

Stated in `Db.ts` and obeyed by every query in `src/server/`:

- Values are TEXT or INTEGER. A timestamp is an ISO string written from JS,
  never `CURRENT_TIMESTAMP`. Binary data is base64url TEXT.
- A count is `CAST(COUNT(*) AS INTEGER)`; Postgres returns `bigint` as a string.
- camelCase aliases are double-quoted (`AS "createdAt"`), or Postgres folds them.
- No generated columns, no JSON operators in SQL, no `rowid`, no `WITHOUT ROWID`.
- `RETURNING`, partial indexes, `INSERT … VALUES (…, (subselect))` and
  `INSERT … ON CONFLICT (…) DO UPDATE SET … = excluded.…` are fair game: both
  engines have them.

The claim is kept honest by running the suite against both engines:

```sh
docker run --rm -d --name tictac-pg -p 55432:5432 -e POSTGRES_PASSWORD=tictac postgres:17
TICTAC_TEST_POSTGRES_URL=postgres://postgres:tictac@localhost:55432/postgres bun test
```

`tests/support/db.ts` adds the Postgres url to `DATABASE_URLS` when that
variable is set, and every persistence test is a `describe.each` over it.

---

## 2. Forward-Only Migrations

`src/server/db/migrate.ts` and `migrations.ts`. There is no `down`: a rollback is
a second description of the same change, written when it is least likely to be
tested and run when it is least likely to be understood. A schema that has gone
somewhere wrong goes somewhere else *next*.

Every process that opens the database migrates it on the way in, which is safe
because `migrate` is idempotent, and it means there is no deploy step to forget.
Before it applies anything it refuses three things by name:

| Refusal | Why |
|---|---|
| ids not `1..n` in order | a gap or a reorder applies the wrong statements under the right number |
| a name that disagrees with the database's | a migration is identified by number *and* name, so an edited one is a deliberate break |
| an applied id past the end of this build's list | **the dangerous direction**: an older build reading a newer schema writes rows the newer build will not recognise |

Each migration runs in one transaction with the `schema_migrations` row that
records it, so a half-applied schema is not reachable. A statement may be a
plain string or `{ sqlite, postgres }` — used once so far, for the append-only
trigger, with both halves the *same number of statements* so a database's
statement count does not depend on where it lives.

Migrations are append-only and never edited once shipped:

1. **`match log`** — `matches`, `events`, and the append-only triggers.
2. **`accounts`** — `players`, `credentials`, `sessions`, `auth_challenges`.
3. **`rosters`** — `roster`, `match_results`.
4. **`lasting wounds`** — `roster.hp`, `roster.deeds` (`ITEM-038`).
5. **`fatigue and medical bay`** — `roster.fatigue`, `roster.downtime` (`ITEM-039`).
6. **`rooms`** — `rooms`, the lobby's live rooms (§3).

> This is the *database* schema. The **recorded command and component
> shapes** are a separate guard — `bun run schema:catalog`, see
> [ARCH-NETWORKING §7](./networking.md#7-schema-drift-guard-item-028).

---

## 3. The Intent Log

`MatchStore` is unchanged in meaning and now asynchronous, on `Db`. A match is
its event log; nothing resolved is stored, because a stored outcome is a second
copy of something derivable and a second copy can disagree. `seq` is chosen
inside the insert (`COALESCE(MAX(seq) + 1, 0)`), so there is no window between
reading the end of a log and writing to it.

Append-only is a property of the database, not a courtesy of the class: a
trigger refuses `UPDATE` and `DELETE` on `events` on both engines. A log that
can be rewritten is not evidence.

`created_at` and `seed_label` are copied out of the header at write time rather
than derived in SQL — a generated column is SQLite's alone.

### Rooms, so a restart loses none

`RoomStore` keeps one row per room that is not over, with exactly what a
restarted server needs to hold it again (`Lobby.restore`,
[ARCH-NETWORKING §8](./networking.md)):

| Column | What it is |
|---|---|
| `id` | the room's id, which is also its match's id in `matches` |
| `build`, `protocol` | what the room was opened under; only a page on that build takes a seat back |
| `phase` | `waiting`, `deploying` or `playing`. A room whose match `matches` holds is playing whatever this says: the match is written first, and a restart can fall between the two writes |
| `created_at` | ISO string; restore order, and so listing order |
| `judged` | 1, or 0 once a room of another build stopped being judged |
| `sides` | JSON: the squads the referee verified against the rosters, which is who a settlement credits |
| `blue_player_id`, `blue_name`, `blue_key_hash` | the Blue seat: its player (null for an anonymous one) and the SHA-256 of its key |
| `red_player_id`, `red_name`, `red_key_hash` | the same for Red, all null while the room waits |

A seat's key is never stored, only its hash — the same reason `sessions` keeps
no token. There are no foreign keys: an anonymous seat names nobody, and nothing
reads a player through a room.

Each row is rewritten whole (`save`, an upsert) at every transition the room
makes — opened, joined, started, squads verified, a seat's key replaced by a new
window, judging stopped — on the room's own write chain (§6), so the row is
always one state the room was really in. A room that settles or aborts deletes
its row (`end`) behind everything else it had to write; what remains of it is
its match log. The table therefore holds live rooms only and does not grow.
`live()` reads them back oldest first.

---

## 4. Accounts: Passkeys, and Nothing Else

`src/server/Accounts.ts`, with the pure parts in `src/server/WebAuthn.ts`. No
password to leak, no email to verify, no third party. A player is a name they
chose and a public key their device holds.

The security of a passkey is not the signature alone but *what* is signed:
`authenticatorData ‖ sha256(clientDataJSON)`, where the client data names the
ceremony, the challenge and the origin. Every check is against a value the
server chose:

- the challenge row is **deleted as it is read** (`DELETE … RETURNING`), so it is
  worth exactly one answer;
- `type` must match the ceremony, `challenge` must match the one issued, and
  `origin` must be in the configured list — the last is what makes a passkey
  unphishable;
- `rpIdHash` must be `sha256(party.id)` and the user-present flag must be set;
- the signature counter must move: `(stored > 0 || next > 0) && next <= stored`
  is a copied authenticator.

Only ES256 (-7) and RS256 (-257) are accepted. Ed25519 is left out until Bun's
WebCrypto support for it is confirmed; accepting an algorithm the server cannot
verify would register a passkey nobody could ever sign in with.

**Sessions** are a 32-byte token returned once; only its SHA-256 hex is stored,
so a stolen database is not a drawer full of working sessions. **Socket
tickets** are in memory, single-use and worth 60 seconds: a browser cannot put
an `Authorization` header on a WebSocket, and a session token in a url is a
session token in somebody's logs. A ticket redeems to the whole `Player`
(`{ id, name }`), because the lobby seats and names players by it.

### HTTP surface (`src/server/Api.ts`)

| Route | Body | Answer |
|---|---|---|
| `POST /api/auth/register/options` | `{ name }` | `{ challengeId, publicKey }` |
| `POST /api/auth/register/verify` | attestation, base64url | `{ token, player }` |
| `POST /api/auth/login/options` | `{}` | `{ challengeId, publicKey }` |
| `POST /api/auth/login/verify` | assertion, base64url | `{ token, player }` |
| `POST /api/auth/logout` | bearer | `204` |
| `GET /api/me` | bearer | `{ player }` |
| `GET /api/roster` | bearer | `{ roster }` |
| `POST /api/roster/recruit` | bearer | `{ member }` — `400` if the roster is already full |
| `POST /api/ticket` | bearer | `{ ticket }` |
| `GET /api/lobby` | bearer optional | `LobbyView` (`src/game/Lobby.ts`): open rooms newest first, and `you` — the asker's seat, null without a valid token (never a `401`) |

CORS is granted only to the configured origins — the same list the ceremony is
checked against, because they are the same question: which pages is this server
part of? Every error body is `{ error }`, and anything unexpected is a 500 that
says only `the server failed`.

---

## 5. Rosters, and What a Match Does to Them

A roster lives on the server because a squad a client could rewrite is a squad
that never dies. Registration deals `ROSTER.size` (6) characters, server-rolled
from system randomness — a bench, not a squad: `SQUAD_SIZE` (4) of them deploy
to any one match, and a signed-in player picks which (`[ITEM-042]`).

**Before the match.** `Room.verifyRosters` runs once the header arrives.
For each signed-in side: the deployed squad must be **1 to `SQUAD_SIZE`**
units, and every one of them must *name* a character — `Deployment.characterId`
— that is this player's, is presently active (not dead, not a duplicate within
the same squad) and repeats none of that player's other deployed characters.
Naming is what makes picking a subset possible at all: the referee looks each
stated id up in the active roster rather than comparing position for position,
so a squad can be any 1–4 of the six, in any order, not only the first four
slots. A name that resolves to a member still in the medical bay
(`downtime > 0`) is refused outright (`[ITEM-039]`) — the roster screen is not
trusted to have kept them off the list any more than a client is trusted with
anything else. Once a name clears both checks, the things a client cannot be
trusted to state honestly are checked against the roster row it names: the
deployed sheet (`sanitizeSheet` both ways, compared as JSON), `state.hp` and
`state.fatigue`, exactly — fatigue the same strict way HP is, present and
matching, never defaulted when absent. Anything else aborts the match — a
match played with somebody else's people, somebody else's wounds, somebody
else's rest, a dead character, a repeated one, or a fifth, must not settle. A
signed-in side whose deployment omits `state.hp` is refused the same way a
wrong one is: absence would let a client always deploy at full health
regardless of what the roster says. One player on both sides is refused for
the same reason as the sheet check, and so is a signed-in player with nobody
left on their roster. An anonymous side is skipped, not refused: an
unregistered opponent is a perfectly good opponent who simply has nothing to
keep.

**A short roster deploys short-handed** (`ITEM-041`). The squad is the active
roster in slot order with any empty slot closed up, and `Squads` fields exactly
as many units as the header states deployments for — never topped up to
`SQUAD_SIZE` with somebody nobody enlisted. `ready.squad` and
`RecordingHeader.squads` carry one `Deployment` per deployed unit, one to
`SQUAD_SIZE` of them. The sweep prices it: `bun run balance -- --blueSize=3`
takes Blue from 55 wins in 100 to 34.

A starting HP has to be something both peers and the referee agree on
*before the first digest*, so it cannot be injected by the referee after the
fact — it travels on the wire, on the same `Deployment` its sheet does
(`[ITEM-043]`; before it, as a separate `startingHp` array matched to `sheets`
by position only): a client fetches its own roster's HP from `GET
/api/roster`, folds it into `state.hp` on its own `ready.squad`, and the
match's host does the same for both sides before sending `matchHeader`.
`Squads`/`Soldier` then deploy each unit at that HP instead of full — the one
behaviour change `ITEM-038` makes to a live match, and the reason
`PROTOCOL_VERSION` and `RECORDING_VERSION` both moved for it (and moved again
for `ITEM-043` and `ITEM-041`, each for its own reshaping of the same header).

**After the match.** `settlement()` in `src/game/MatchEnd.ts` is pure and reads
the referee's own world the moment a side has nobody left on the field — wiped
out, or withdrawn by a retreat (`ITEM-051`). Every fate carries the unit's HP at
that moment and this match's own `Deeds` (the service record `ITEM-004` already
computes for growth), regardless of who won:

- the winner's living units are `survived`, with `grown(sheet, growth)` from
  `debrief`;
- the winner's dead are `died`;
- on a losing side that was wiped out, the `carriedOut` unit is `carried` and
  everyone else is `died`. Losers learn nothing — that is what permadeath is for;
- on a losing side that retreated, those who got away are `survived`, grown
  from their own deeds (`escaped`), and those left behind are `died`. Nobody is
  carried out. `Rosters` needed no new branch: a leaver's fate is the same shape
  as any survivor's, and settles the same way (HP, healing, fatigue, downtime).

`Rosters.settle` writes it in one transaction, keyed by `match_results.match_id`
so a referee asked twice writes the growth once. A dead character is **marked,
never deleted**: the row is the history of somebody who was, kept with the HP
and the combat log they had at the end — and `roster_active_slot` is a partial
unique index so every previous occupant of a slot sits beside the living one.

**Healing, as a stated rule, not an implicit reset.** A survivor's stored HP
moves by `HEALING.perMatch` (0.5) of missing HP, scaled by their sheet's own
`healBonus` — the Health attribute's documented second job (GDD §1: "dictates
the speed of natural healing... in the meta-layer"). The carried-out unit is
written at exactly `HEALING.carriedOutHp` (1), and then heals the same way
next time they are settled. Every ceiling this clamps against is
`maxHpOf(sheet)` (`src/core/Characters.ts`) — the attribute band **plus a
character's own traits**, not `derive(sheet).maxHp` alone: a Juggernaut's +25
is not gear, it does not reset next match, and a roster using the bare band
would enlist that character already short of their real ceiling and clamp
their healing below it forever after. `deeds` accumulates the same way: each
settled match's record is added onto the roster's cumulative one, field by
field (`mergeDeeds`), never replacing it — the combat log GDD §5 calls a
"scar."

**Refilling a slot.** `Rosters.recruit` (`POST /api/roster/recruit`) rolls one
fresh `CharacterSheet` — `characterSheet`, seeded from system randomness the
same way `enlist` deals the first squad — and writes it through
`roster_active_slot` into the lowest slot `0..SQUAD_SIZE-1` this player's
*active* roster does not already hold. Free: no economy prices one yet, and
wiring a cost or a pool this early would settle that design question by
accident. A dead row is never touched by it — it already stopped being the
active occupant of its slot the moment `record` marked it — so the history a
player is building stays exactly where it was, one row per past occupant of
the slot. Refused with `400` if every slot is already held: there is nothing
to fill.

**The bench rests.** `Rosters.settle` heals every *other* active roster
member too — everyone not named in `characterIds` for that side — by the same
survivor formula (`HEALING.perMatch` of missing HP, scaled by `healBonus`,
clamped to `maxHpOf`), without touching `matches` or `deeds`. Resting is not a
match: nobody sits banked at whatever HP their last deployment left them at
while their squadmates keep fighting, and nobody stuck at full stays clamped
there by anything but the same ceiling a deployed survivor is.

**Fatigue and the medical bay** (`[ITEM-039]`). Every settled match moves both
numbers on `roster`: a deployed member's `fatigue` rises by one, capped at
`FATIGUE.max` (4); a benched one's falls by two and `downtime` by one, both
floored at zero — fatigue recovers twice as fast as it accrues, so a
six-character rotation resting one match in three never carries a step
forward. A carried-out survivor's `downtime` is set to `MEDICAL_BAY.carriedOut`
(2) and one who ended at or below `WOUNDS.concussed` of their ceiling to
`MEDICAL_BAY.concussed` (1) — both in `Rosters.record`, alongside the healing
and growth it already writes. The stored level only costs something at
deployment: `Soldier` takes a starting fatigue the way it takes a starting HP,
and `max(0, fatigue − 1)` steps — the first back-to-back match is free — each
cost `FATIGUE.apPerStep` off max AP (one more term in `refreshTraits`' `maxAp`
sum) and `FATIGUE.moralePerStep` off starting morale. The per-step numbers are
calibrated against `bun run balance -- --blueSize=3` (a man down, `[ITEM-041]`:
Blue 55 → 34), not copied from the design sketch: a flat `-1` AP a step
measured level 2 at a 14-point cost against a target of "at most 5", because
`effectiveMaxAp`'s `Math.round` erases anything under half a point from a
whole-number ceiling. `FATIGUE.apPerStep = 0.5` measures level 2 at 0 (one
step is invisible on its own) and level 4 at 20 (two steps land as a whole
point) — both inside their bands, and a live demonstration that this clamp
applies to a stored ceiling exactly as it already did to a status effect's.

**Picking who deploys.** `src/hud/RosterScreen.ts` is a DOM-only overlay shown
ahead of `LoadoutScreen` to a signed-in player: every active roster member,
identified by slot number rather than callsign (`FACTION_INFO.squadNames[index]`
is assigned by *deployed* position, so a name here would promise a character a
callsign it may not keep once picked alongside others), toggled up to
`SQUAD_SIZE`, defaulting to the first four *deployable* in slot order. A
member with `downtime > 0` is greyed with the matches left instead of their
attributes and cannot be toggled — the client-side mirror of the referee's own
refusal, not a substitute for it. An empty slot renders a **Recruit** button
in its place, calling `POST /api/roster/recruit` and splicing the answer
straight into the list. The pick becomes the `characterId` the client states
on each `Deployment` it sends; `main.ts` mints the connection ticket only
*after* the pick, not before it, so lingering on the roster screen cannot burn
the ticket's 60-second window before ever connecting. `Account.roster()`
mirrors `RosterMember` client-side as `RosterEntry` (`src/game/Account.ts`)
rather than importing the server's type — `src/game`/`src/hud` never import
`src/server/`, even for a type.

> **A live match's header is not what was handed to `Squads`.** `main.ts`
> builds the `matchHeader` a referee judges from `Squads.deploymentsOf`,
> reading back the `Soldier`s a match already deployed — not from the
> `Deployment[]` array a client passed to `Squads`'s constructor. Anything a
> kept roster needs stated has to survive that round trip on the `Soldier`
> itself (`characterId`, `fatigue`) or it is silently absent from every real
> match, however correct the code that built the original `Deployment[]` was.
> `[ITEM-044]` is exactly this: `deploymentsOf` carried sheet, kit and HP back
> but not `characterId` or `state.fatigue`, so every live signed-in match
> since `[ITEM-042]` shipped would have named nobody and been aborted by a
> real referee — caught only once `[ITEM-039]`'s own regression test built a
> `Squads` and read `deploymentsOf` back, which no earlier test had done.

---

## 6. The Server and the Client

`startGameServer` (`src/server/GameServer.ts`) is one `Bun.serve` with three
jobs, in order: a WebSocket upgrade carrying an optional `?ticket=`, the HTTP
API, and the status document. `scripts/serve-match.ts` is a thin CLI over it:

```sh
bun run serve:match -- --db=sqlite://matches.sqlite --rp-id=localhost --origins=http://localhost:5173
```

`--db` defaults to `TICTAC_DB` and then `:memory:`; `--rp-id` and `--origins`
default to `localhost` and `http://localhost:5173`. For a GitHub Pages
deployment the server runs with `--rp-id=lordvlad.github.io
--origins=https://lordvlad.github.io` behind HTTPS/WSS. The server restores
every live room from the database before it opens its port, so a server
restarted over a file or a Postgres keeps its matches; one on `:memory:` has
nothing to restore.

Each room's referee writes through **one queue** (`Room.enqueue`; `Room.idle`, and
`Lobby.idle` across every room).
`MatchHost` is synchronous and the database is not, so frames are judged
synchronously in arrival order and every write is appended to one chain that
drains in that order. A write that fails ends the match: a referee that could
not write down what it saw has no evidence.

On the client, `src/game/Account.ts` holds a session per server url in
`localStorage` and does the two ceremonies through `navigator.credentials`. When
a token is present the menu's match-server panel fetches the roster and a ticket
before connecting, and `equipThenStart` deploys that roster instead of a fresh
roll; without one, nothing changes.
