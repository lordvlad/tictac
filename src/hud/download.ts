/**
 * Hand the browser a file to save.
 *
 * A blob and a synthetic anchor click, because that is the only way a page can
 * offer a download without a server to serve it from. The object URL is
 * released on the next macrotask rather than immediately: revoking it in the
 * same tick as the click races the browser's own fetch of it in Safari, and the
 * download silently produces an empty file.
 */
export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
