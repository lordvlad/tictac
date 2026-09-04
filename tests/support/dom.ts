/**
 * The minimum DOM the renderer's canvas textures and HUD panels need under `bun test`.
 */
export function installCanvasStub(): void {
  const ctx = {
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    arcTo: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    rect: () => {},
    clip: () => {},
    fill: () => {},
    stroke: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    measureText: () => ({ width: 10 }),
    fillText: () => {},
    strokeText: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    setLineDash: () => {},
    set fillStyle(_v: unknown) {},
    set strokeStyle(_v: unknown) {},
    set lineWidth(_v: unknown) {},
    set font(_v: unknown) {},
    set textAlign(_v: unknown) {},
    set textBaseline(_v: unknown) {},
    set lineJoin(_v: unknown) {},
  }

  const canvas = { width: 0, height: 0, getContext: () => ctx, style: { width: '', height: '' } }

  const makeElement = (tag: string): unknown => {
    if (tag === 'canvas') return canvas
    const children: unknown[] = []
    const elementListeners = new Map<string, Set<EventListener>>()

    const element = {
      tagName: tag.toUpperCase(),
      className: '',
      style: { display: '' },
      appendChild: (child: unknown) => {
        children.push(child)
        return child
      },
      removeChild: (child: unknown) => {
        const idx = children.indexOf(child)
        if (idx !== -1) children.splice(idx, 1)
        return child
      },
      remove: () => {},
      addEventListener: (type: string, listener: EventListener) => {
        let set = elementListeners.get(type)
        if (!set) {
          set = new Set()
          elementListeners.set(type, set)
        }
        set.add(listener)
      },
      removeEventListener: (type: string, listener: EventListener) => {
        elementListeners.get(type)?.delete(listener)
      },
      getAttribute: (attr: string) => {
        if (attr === 'data-view') return (element as unknown as { _dataView?: string })._dataView ?? null
        return null
      },
      setAttribute: (attr: string, val: string) => {
        if (attr === 'data-view') (element as unknown as { _dataView?: string })._dataView = val
      },
      click: () => {
        const evt = new (globalThis.MouseEvent ?? globalThis.Event)('click')
        Object.defineProperty(evt, 'target', { value: element, configurable: true })
        element.dispatchEvent(evt)
      },
      dispatchEvent: (evt: Event) => {
        if (!evt.target) Object.defineProperty(evt, 'target', { value: element, configurable: true })
        Object.defineProperty(evt, 'currentTarget', { value: element, configurable: true })
        const set = elementListeners.get(evt.type)
        if (set) {
          for (const fn of set) fn.call(element, evt)
        }
        return true
      },
      querySelector: (sel: string) => element.querySelectorAll(sel)[0] ?? null,
      querySelectorAll: (sel: string) => {
        const out: unknown[] = []
        for (const c of children) {
          if (c && typeof c === 'object') {
            if ('className' in c && typeof c.className === 'string') {
              const parts = sel.split('[')
              const classPart = parts[0]!.replace('.', '')
              const hasClass = c.className.split(' ').includes(classPart)
              let matchesAttr = true
              if (parts[1]) {
                const attrMatch = parts[1].match(/([a-z-]+)="([^"]+)"/)
                if (attrMatch) {
                  const [, name, val] = attrMatch
                  const elemGet = (c as unknown as { getAttribute?: (a: string) => string | null }).getAttribute
                  matchesAttr = !!elemGet && elemGet.call(c, name!) === val
                }
              }
              if (hasClass && matchesAttr) out.push(c)
            }
            if ('querySelectorAll' in c && typeof c.querySelectorAll === 'function') {
              out.push(...(c.querySelectorAll as (s: string) => unknown[])(sel))
            }
          }
        }
        return out
      },
      _innerHTML: '',
      get innerHTML() {
        return (element as unknown as { _innerHTML: string })._innerHTML
      },
      set innerHTML(html: string) {
        (element as unknown as { _innerHTML: string })._innerHTML = html
        children.length = 0
        const matches = html.matchAll(/<([a-z0-9-]+)([^>]*)>(.*?)<\/\1>/gis)
        for (const m of matches) {
          const tag = m[1]!
          const attrs = m[2]!
          const inner = m[3]!
          const child = makeElement(tag) as Record<string, unknown>
          const classMatch = attrs.match(/class="([^"]+)"/)
          if (classMatch) child.className = classMatch[1]!
          const viewMatch = attrs.match(/data-view="([^"]+)"/)
          if (viewMatch) child._dataView = viewMatch[1]!
          child.innerHTML = inner
          child.textContent = inner.replace(/<[^>]+>/g, '')
          children.push(child)
        }
      },
      _textContent: '',
      get textContent() {
        if (children.length === 0) return (element as unknown as { _textContent: string })._textContent
        return children.map((c) => (c && typeof c === 'object' && 'textContent' in c ? String(c.textContent) : '')).join(' ')
      },
      set textContent(txt: string) {
        (element as unknown as { _textContent: string })._textContent = txt
      },
    }
    return element
  }

  const globalListeners = new Map<string, Set<EventListener>>()

  const originalAdd = globalThis.addEventListener
  const originalRemove = globalThis.removeEventListener
  const originalDispatch = globalThis.dispatchEvent

  globalThis.addEventListener = ((type: string, fn: EventListener) => {
    let set = globalListeners.get(type)
    if (!set) {
      set = new Set()
      globalListeners.set(type, set)
    }
    set.add(fn)
    if (typeof originalAdd === 'function') originalAdd.call(globalThis, type, fn)
  }) as unknown as typeof addEventListener

  globalThis.removeEventListener = ((type: string, fn: EventListener) => {
    globalListeners.get(type)?.delete(fn)
    if (typeof originalRemove === 'function') originalRemove.call(globalThis, type, fn)
  }) as unknown as typeof removeEventListener

  globalThis.dispatchEvent = ((evt: Event) => {
    const set = globalListeners.get(evt.type)
    if (set) {
      for (const fn of set) fn(evt)
    }
    if (typeof originalDispatch === 'function') {
      try { originalDispatch.call(globalThis, evt) } catch {}
    }
    return true
  }) as unknown as typeof dispatchEvent

  const documentListeners = new Map<string, Set<EventListener>>()

  const docAdd = (type: string, fn: EventListener) => {
    let set = documentListeners.get(type)
    if (!set) {
      set = new Set()
      documentListeners.set(type, set)
    }
    set.add(fn)
  }

  const docRemove = (type: string, fn: EventListener) => {
    documentListeners.get(type)?.delete(fn)
  }

  const docDispatch = (evt: Event) => {
    const set = documentListeners.get(evt.type)
    if (set) {
      for (const fn of set) fn(evt)
    }
    return true
  }

  const existing = globalThis.document as Document | undefined

  if (existing === undefined) {
    globalThis.document = {
      createElement: makeElement,
      body: makeElement('body'),
      addEventListener: docAdd,
      removeEventListener: docRemove,
      dispatchEvent: docDispatch,
    } as unknown as Document
  } else {
    Object.defineProperty(existing, 'createElement', {
      value: (tag: string) => makeElement(tag),
      configurable: true,
    })
    if (typeof (existing as unknown as { addEventListener?: unknown }).addEventListener !== 'function') {
      Object.defineProperty(existing, 'addEventListener', { value: docAdd, configurable: true })
      Object.defineProperty(existing, 'removeEventListener', { value: docRemove, configurable: true })
      Object.defineProperty(existing, 'dispatchEvent', { value: docDispatch, configurable: true })
    }
    const bodyObj = (existing as unknown as { body?: unknown }).body
    if (!bodyObj || typeof (bodyObj as { appendChild?: unknown }).appendChild !== 'function') {
      Object.defineProperty(existing, 'body', {
        value: makeElement('body'),
        configurable: true,
      })
    }
  }

  const BaseEvent = globalThis.Event ?? Object

  class KeyboardEventStub extends BaseEvent {
    key: string
    constructor(type: string, opts?: { key?: string; bubbles?: boolean }) {
      super(type, opts)
      this.key = opts?.key ?? ''
    }
  }
  globalThis.KeyboardEvent = KeyboardEventStub as unknown as typeof KeyboardEvent

  class MouseEventStub extends BaseEvent {
    constructor(type: string, opts?: { bubbles?: boolean }) {
      super(type, opts)
    }
  }
  globalThis.MouseEvent = MouseEventStub as unknown as typeof MouseEvent

  class Path2DStub {
    moveTo(): void {}
    lineTo(): void {}
    quadraticCurveTo(): void {}
    bezierCurveTo(): void {}
    arc(): void {}
    arcTo(): void {}
    closePath(): void {}
    rect(): void {}
  }
  globalThis.Path2D = Path2DStub as unknown as typeof Path2D

  globalThis.window = globalThis as unknown as Window & typeof globalThis
}
