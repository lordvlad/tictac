import type { ReactNode } from 'react'
import type { LobbyRoom, LobbySeat, LobbyView } from '../../game/Lobby'
import { MENU_COLOURS, MenuButton, MenuGroup } from './controls'

/**
 * The rooms on a match server, as `ServerPanel` lists them.
 *
 * Split by the one thing a visitor can do with a room: a room `waiting` has a
 * free seat and is joined, a room `deploying` or `playing` has none and is
 * watched. The phase itself is detail inside the row, not a third section —
 * nobody can do anything with "deploying" that they cannot with "playing".
 *
 * Pure markup over a `LobbyView`: polling, the takeover and every way into a
 * match belong to the panel, so this cannot start a connection on its own.
 */

/** How old a room is, in the coarse words a lobby needs: who has waited longest. */
function age(createdAt: string, now: number): string {
  const seconds = Math.floor((now - Date.parse(createdAt)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ago`
}

/**
 * A seat's name, and whether its player is gone for now. The marker is
 * dimmed because the match is not over: a signed-in player's seat is held
 * for them while they come back, and the room stays listed meanwhile.
 */
function SeatName({ seat }: { seat: LobbySeat }) {
  return (
    <>
      {seat.name ?? 'Anonymous'}
      {!seat.connected && <span style={{ color: MENU_COLOURS.muted }}> (reconnecting…)</span>}
    </>
  )
}

/**
 * One room: who is in it on the first line, what state it is in on the
 * second, and the one thing to do about it at the end. A player's own room
 * carries no button — joining or watching it would only supersede the
 * window that is already in it.
 */
function RoomRow({
  room,
  title,
  detail,
  action,
}: {
  room: LobbyRoom
  title: ReactNode
  detail: string
  action: ReactNode
}) {
  return (
    <div data-room-id={room.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            color: MENU_COLOURS.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 11, color: MENU_COLOURS.muted }}>{detail}</div>
      </div>
      {action}
    </div>
  )
}

const YOURS = <span style={{ fontSize: 11, color: MENU_COLOURS.signedIn }}>yours</span>

export function LobbyList({
  view,
  now,
  busy,
  onJoin,
  onWatch,
}: {
  view: LobbyView
  /** When `view` arrived, so every age in it is measured from the same moment. */
  now: number
  /** A connection is in flight; starting another would race it. */
  busy: boolean
  onJoin: (roomId: string) => void
  onWatch: (roomId: string) => void
}) {
  const own = view.you?.roomId ?? null
  const waiting = view.rooms.filter((room) => room.phase === 'waiting')
  const playing = view.rooms.filter((room) => room.phase !== 'waiting')

  return (
    <div
      id="lobby"
      // Scrolls rather than grows: a busy server would otherwise push the
      // card's foot off the bottom of the screen.
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        marginTop: 16,
        maxHeight: 240,
        overflowY: 'auto',
        paddingRight: 4,
      }}
    >
      <MenuGroup
        id="lobby-waiting"
        title="Waiting for an opponent"
        caption="Join one to take its Red seat."
        tone="server"
      >
        {waiting.length === 0 ? (
          <p style={{ margin: 0, fontSize: 11, color: MENU_COLOURS.muted }}>
            Nobody is waiting. Open a match and share this page.
          </p>
        ) : (
          waiting.map((room) => (
            <RoomRow
              key={room.id}
              room={room}
              title={<SeatName seat={room.blue} />}
              detail={`opened ${age(room.createdAt, now)}`}
              action={
                room.id === own ? (
                  YOURS
                ) : (
                  <MenuButton
                    id={`btn-join-${room.id}`}
                    tone="serverDeep"
                    size="sm"
                    disabled={busy}
                    onClick={() => onJoin(room.id)}
                  >
                    Join
                  </MenuButton>
                )
              }
            />
          ))
        )}
      </MenuGroup>

      <MenuGroup
        id="lobby-playing"
        title="In progress"
        caption="Watch one: you see the whole board and control nothing."
        tone="server"
      >
        {playing.length === 0 ? (
          <p style={{ margin: 0, fontSize: 11, color: MENU_COLOURS.muted }}>
            Nothing is being played right now.
          </p>
        ) : (
          playing.map((room) => (
            <RoomRow
              key={room.id}
              room={room}
              title={
                <>
                  <SeatName seat={room.blue} /> vs{' '}
                  {room.red ? <SeatName seat={room.red} /> : 'Anonymous'}
                </>
              }
              detail={[
                room.phase === 'playing' ? (room.turn === null ? 'playing' : `turn ${room.turn}`) : 'deploying',
                `${room.spectators} watching`,
              ].join(' · ')}
              action={
                room.id === own ? (
                  YOURS
                ) : (
                  <MenuButton
                    id={`btn-watch-${room.id}`}
                    tone="neutralDark"
                    size="sm"
                    disabled={busy}
                    onClick={() => onWatch(room.id)}
                  >
                    Watch
                  </MenuButton>
                )
              }
            />
          ))
        )}
      </MenuGroup>
    </div>
  )
}
