import { useEffect, useRef, useState } from 'react'
import type { EncounterEntry } from '../wire/Encounter'
import type { CombatRecording } from '../wire/Recording'
import { feedLine, unseenCount } from './EncounterView'
import type { EncounterFeedPort } from './ServerPorts'

/**
 * "While you were away" (`ITEM-048`, the return feed): what found the squad
 * on the road, newest first, and how each fight ended, with the fight itself
 * to watch back.
 *
 * Shown in the map's panel, which is where a player who has been away goes
 * first. It is read from the server (`encounter/feed`) when it opens, when
 * the socket comes back (what happened meanwhile was pushed to nobody), and
 * when the squad or an encounter is pushed — which is also when an arrival
 * or a fresh fight may have added a line.
 */

export function EncounterFeed({
  port,
  onWatch,
}: {
  port: EncounterFeedPort
  /** Play a fight back; the map closing for it is the caller's business. */
  onWatch: (recording: CombatRecording) => void
}) {
  const [entries, setEntries] = useState<EncounterEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [now, setNow] = useState(() => port.now())
  /** The match being fetched, and the one whose recording could not be played, with why. */
  const [fetching, setFetching] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ id: string; text: string } | null>(null)
  /** Where this window last looked at the feed, per server: what is newer than that is new. */
  const seenKey = `tictac:encounters-seen:${port.url}`
  const [seenAt] = useState(() => Number(localStorage.getItem(seenKey) ?? 0))
  const newest = useRef(0)

  useEffect(() => {
    let gone = false
    const fetchFeed = () =>
      port.feed().then(
        (read) => {
          if (gone) return
          newest.current = read.reduce((latest, entry) => Math.max(latest, entry.at), newest.current)
          setEntries(read)
          setNow(port.now())
          setProblem(null)
        },
        (error: unknown) => {
          if (!gone) setProblem(error instanceof Error ? error.message : 'The feed could not be read.')
        },
      )
    void fetchFeed()
    const stopStale = port.onStale(() => void fetchFeed())
    const timer = window.setInterval(() => setNow(port.now()), 30_000)
    return () => {
      gone = true
      stopStale()
      window.clearInterval(timer)
      // Looked at: whatever was in it is no longer new.
      if (newest.current > 0) localStorage.setItem(seenKey, String(newest.current))
    }
  }, [port, seenKey])

  const watch = async (entry: EncounterEntry) => {
    if (entry.matchId === null) return
    setFetching(entry.id)
    setRefused(null)
    try {
      // Read as a file is, so a build that cannot play this version says so on
      // the line rather than failing silently.
      onWatch(await port.recording(entry.matchId))
    } catch (error) {
      setRefused({
        id: entry.id,
        text: error instanceof Error && error.message.length > 0 ? error.message : 'That fight could not be played back.',
      })
    } finally {
      setFetching(null)
    }
  }

  const fresh = entries ? unseenCount(entries, seenAt) : 0
  return (
    <div className="map-feed">
      <div className="map-feed-title">
        While you were away
        {fresh > 0 && (
          <span className="map-badge" title="Since you last looked">
            {fresh} new
          </span>
        )}
      </div>
      {problem && <div className="map-problem">{problem}</div>}
      {entries?.length === 0 && <div className="map-hint">Nothing has found your squad.</div>}
      {entries && entries.length > 0 && (
        <ul className="map-feed-list">
          {entries.map((entry) => {
            const line = feedLine(entry, now)
            return (
              <li key={entry.id} className={`map-feed-row ${line.tone}`}>
                <div>
                  <b>{line.result}</b> · {line.opponent}
                  {entry.at > seenAt && <span className="map-badge">new</span>}
                </div>
                <div className="map-hint">
                  {[line.when, line.where, line.played].filter((part) => part !== null).join(' · ')}
                </div>
                {line.matchId !== null && (
                  <button type="button" disabled={fetching !== null} onClick={() => void watch(entry)}>
                    Watch
                  </button>
                )}
                {refused?.id === entry.id && <div className="map-problem">{refused.text}</div>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
