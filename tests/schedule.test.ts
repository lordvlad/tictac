import { describe, expect, test } from 'bun:test'
import { MAX_SLEEP_MS, Schedule, type ScheduleHost } from '../src/server/Schedule'

class TestHost implements ScheduleHost {
  armed: (number | null)[] = []
  currentTime = 1000

  now(): number {
    return this.currentTime
  }

  arm(at: number | null): void {
    this.armed.push(at)
  }
}

describe('Schedule error isolation', () => {
  test('a failing handler does not permanently reject this.firing or prevent subsequent alarms', async () => {
    const host = new TestHost()
    const logs: string[] = []
    const schedule = new Schedule(host, (msg) => logs.push(msg))

    let shouldThrow = true
    schedule.handle('faulty', async (_id, _at) => {
      if (shouldThrow) {
        throw new Error('boom')
      }
    })

    let healthyRan = false
    schedule.handle('healthy', async (_id, _at) => {
      healthyRan = true
    })

    // Set two due items: one faulty, one healthy later
    schedule.set('faulty', 'item-1', 1000)
    schedule.set('healthy', 'item-2', 2000)

    expect(host.armed.at(-1)).toBe(1000)

    // First fire: faulty item runs and throws
    await schedule.fire()

    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('faulty')
    expect(logs[0]).toContain('boom')

    // Alarm must be re-armed for item-2 even though item-1 failed
    expect(host.armed.at(-1)).toBe(2000)

    // Advance clock and fire again: healthy item must execute
    host.currentTime = 2000
    await schedule.fire()

    expect(healthyRan).toBe(true)
    // No more items due, alarm should be disarmed (null)
    expect(host.armed.at(-1)).toBeNull()
  })

  test('fire() runs subsequent due items in the same fire tick even if an earlier one throws', async () => {
    const host = new TestHost()
    const logs: string[] = []
    const schedule = new Schedule(host, (msg) => logs.push(msg))

    schedule.handle('faulty', async () => {
      throw new Error('faulty failed')
    })

    const executed: string[] = []
    schedule.handle('healthy', async (id) => {
      executed.push(id)
    })

    schedule.set('faulty', 'f1', 1000)
    schedule.set('healthy', 'h1', 1000)

    await schedule.fire()

    expect(executed).toEqual(['h1'])
    expect(logs.length).toBe(1)
    expect(host.armed.at(-1)).toBeNull()
  })
})
