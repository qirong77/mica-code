// This helper exists only in the design preview, outside the editing model.
;(() => {
  const token = decodeURIComponent(location.hash.slice(1))
  let queued = false
  let lastSignature = ''
  let active = ''
  let entries = []
  const send = (payload) =>
    parent.postMessage({ channel: 'mica-notebook-design', token, ...payload }, '*')
  const editable = () => document.querySelector('.editor > [data-lexical-editor="true"]')
  const outline = () => {
    queued = false
    const root = editable()
    if (!root) return
    entries = Array.from(root.querySelectorAll('h1,h2,h3'))
      .filter((node) => !node.closest('td,th'))
      .map((node, index) => {
        node.dataset.previewHeading = String(index)
        return {
          id: String(index),
          text: node.textContent.trim(),
          level: Number(node.tagName.slice(1)),
          node
        }
      })
    const items = entries.map(({ node, ...item }) => item)
    const blocks = {
      table: !!root.querySelector('table'),
      code: !!root.querySelector('code[data-language]:not([data-language="mermaid"])'),
      mermaid: !!root.querySelector('code[data-language="mermaid"]'),
      image: !!root.querySelector('.editor-image')
    }
    const signature = JSON.stringify({ items, blocks })
    if (signature !== lastSignature) {
      lastSignature = signature
      send({ type: 'outline', items, blocks })
    }
    updatePosition()
  }
  function updatePosition() {
    const current =
      entries.filter(({ node }) => node.getBoundingClientRect().top < 180).at(-1) || entries[0]
    const id = current?.id || ''
    if (id !== active) {
      active = id
      send({ type: 'position', id })
    }
  }
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(outline)
  }
  new MutationObserver(schedule).observe(document.getElementById('root'), {
    childList: true,
    subtree: true,
    characterData: true
  })
  window.addEventListener('scroll', updatePosition, true)
  window.addEventListener('pointerdown', () => send({ type: 'interact' }), true)
  window.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !document.querySelector('.arco-modal, .dropdown, .link-editor input')
    )
      send({ type: 'escape' })
  })
  window.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== parent || data?.channel !== 'mica-notebook-design' || data.token !== token)
      return
    if (data.type === 'design' && ['a', 'b', 'c', 'd', 'e'].includes(data.design)) {
      document.documentElement.dataset.previewDesign = data.design
      document.documentElement.dataset.previewFocus = String(!!data.focus)
    } else if (data.type === 'jump') {
      const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
      if (data.block === 'top') {
        window.scrollTo({ top: 0, behavior })
        return
      }
      let target
      if (typeof data.heading === 'string')
        target = entries.find((item) => item.id === data.heading)?.node
      else {
        const selectors = {
          table: 'table',
          code: 'code[data-language]:not([data-language="mermaid"])',
          mermaid: '.mermaid-preview',
          image: '.editor-image',
          equation: '.editor-equation',
          tasks: '[role="checkbox"]',
          top: 'h1'
        }
        const selector = selectors[data.block]
        if (selector)
          target = editable()?.querySelector(selector) || document.querySelector(selector)
      }
      if (target) {
        const toolbar = document.querySelector('.toolbar')
        const top =
          target.getBoundingClientRect().top +
          window.scrollY -
          (toolbar?.getBoundingClientRect().height || 44) -
          28
        window.scrollTo({ top: Math.max(0, top), behavior })
      }
    } else if (data.type === 'measure') {
      send({
        type: 'measurement',
        width: innerWidth,
        contentWidth: document.documentElement.scrollWidth,
        height: innerHeight,
        headings: entries.length,
        tables: editable()?.querySelectorAll('table').length || 0,
        diagrams: document.querySelectorAll('.mermaid-preview').length,
        renderedDiagrams: document.querySelectorAll('.mermaid-preview svg').length
      })
    }
  })
  send({ type: 'ready' })
})()
