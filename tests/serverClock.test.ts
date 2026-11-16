import { expect, test } from 'bun:test'
import { Glob } from 'bun'

/**
 * Every server module reads time from the clock its host built
 * (`src/server/Clock.ts`), so a handover's expiry, a squad's route and a
 * session's lifetime can all be turned by hand. The wall clock is read in
 * exactly one place: the factory.
 */
test('Date.now and new Date() appear only in the wall-clock factory', async () => {
  const offenders: string[] = []
  for (const pattern of ['src/server/**/*.ts', 'workers/**/*.ts']) {
    for await (const path of new Glob(pattern).scan('.')) {
      if (path === 'src/server/Clock.ts') continue
      const lines = (await Bun.file(path).text()).split('\n')
      lines.forEach((line, index) => {
        if (/\bDate\.now\b|new Date\(\)/.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`)
      })
    }
  }
  expect(offenders).toEqual([])
})
