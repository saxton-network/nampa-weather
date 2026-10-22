// On-screen controls, the debug panel and data credits.

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v)
  }
  e.append(...children)
  return e
}

export class UI {
  constructor({ presets, legend, onMode, onPreset, onTouchMove, onFaceNorth, onLabels, onCameras }) {
    this.errors = []
    this.root = el('div', { class: 'ui' })

    this.modeButtons = {
      drone: el('button', { onclick: () => onMode('drone') }, 'Drone'),
      walk: el('button', { onclick: () => onMode('walk') }, 'Walk')
    }
    const presetSelect = el(
      'select',
      { 'aria-label': 'Jump to view', onchange: (e) => e.target.value && onPreset(e.target.value) },
      el('option', { value: '' }, 'Jump to…'),
      ...Object.entries(presets).map(([k, p]) => el('option', { value: k }, p.label))
    )
    presetSelect.addEventListener('change', () => (presetSelect.value = ''))
    this.debugToggle = el('button', { class: 'small', onclick: () => this.toggleDebug() }, 'Debug')
    this.labelsBox = el('input', { type: 'checkbox', checked: '', onchange: (e) => onLabels(e.target.checked) })
    this.onLabels = onLabels
    this.camerasBox = el('input', { type: 'checkbox', checked: '', onchange: (e) => onCameras(e.target.checked) })
    this.cameraCount = el('span', { class: 'count' })
    const legendRow = el(
      'div',
      { class: 'legend' },
      ...legend.map((b) => el('span', {}, el('i', { style: `background:${b.color}` }), b.label))
    )
    this.panel = el(
      'div',
      { class: 'panel' },
      el('div', { class: 'title' }, 'Nampa, Idaho'),
      el('div', { class: 'row seg' }, this.modeButtons.drone, this.modeButtons.walk),
      el('div', { class: 'row' }, presetSelect, this.debugToggle),
      el('label', { class: 'row check' }, this.labelsBox, 'Street names (L)'),
      el('label', { class: 'row check' }, this.camerasBox, 'Plate-reader cameras (C)', this.cameraCount),
      legendRow
    )

    this.cardTitle = el('div', { class: 'card-title' })
    this.cardRows = el('dl')
    this.cardActions = el('div', { class: 'card-actions' })
    this.card = el(
      'div',
      { class: 'card', hidden: '' },
      el('button', { class: 'card-close', 'aria-label': 'Close', onclick: () => this.onCardClose?.() }, '×'),
      this.cardTitle,
      this.cardRows,
      this.cardActions,
      el('div', { class: 'card-note' }, 'Crowd-sourced from OpenStreetMap via DeFlock. It may be incomplete or out of date.')
    )

    // Compass: the rose turns so N points north; the notch marks the view direction.
    const svgNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('viewBox', '-50 -50 100 100')
    svg.setAttribute('aria-hidden', 'true')
    svg.innerHTML = `
      <circle r="46" class="c-ring"/>
      <path d="M0 -50 L6 -40 L-6 -40 Z" class="c-notch"/>
      <g class="c-rose">
        ${Array.from({ length: 24 }, (_, k) => {
          const a = (k * 15 * Math.PI) / 180
          const r0 = k % 6 === 0 ? 38 : k % 2 === 0 ? 40 : 42
          return `<line x1="${(Math.sin(a) * r0).toFixed(2)}" y1="${(-Math.cos(a) * r0).toFixed(2)}" x2="${(Math.sin(a) * 43).toFixed(2)}" y2="${(-Math.cos(a) * 43).toFixed(2)}" class="c-tick"/>`
        }).join('')}
        <path d="M0 -19 L5 0 L0 -3 L-5 0 Z" class="c-north"/>
        <path d="M0 19 L5 0 L0 3 L-5 0 Z" class="c-south"/>
        ${[['N', 0], ['E', 90], ['S', 180], ['W', 270]]
          .map(([t, d]) => {
            const a = (d * Math.PI) / 180
            return `<text x="${(Math.sin(a) * 29).toFixed(2)}" y="${(-Math.cos(a) * 29).toFixed(2)}" class="c-letter${t === 'N' ? ' n' : ''}" data-angle="${d}">${t}</text>`
          })
          .join('')}
      </g>`
    this.rose = svg.querySelector('.c-rose')
    this.letters = [...svg.querySelectorAll('.c-letter')]
    this.headingText = el('div', { class: 'heading' })
    this.compass = el(
      'button',
      { class: 'compass', title: 'Face north (N)', 'aria-label': 'Compass. Click to face north.', onclick: onFaceNorth },
      svg,
      this.headingText
    )
    this.here = el('div', { class: 'here', hidden: '' })

    this.help = el('div', { class: 'help' })
    this.credits = el('div', { class: 'credits' })
    this.debug = el('pre', { class: 'debug', hidden: '' })

    const hold = (dir) => ({
      onpointerdown: (e) => {
        e.preventDefault()
        onTouchMove(dir)
      },
      onpointerup: () => onTouchMove(0),
      onpointerleave: () => onTouchMove(0),
      onpointercancel: () => onTouchMove(0)
    })
    this.touchPad = el(
      'div',
      { class: 'touchpad', hidden: '' },
      el('button', { 'aria-label': 'Walk forward', ...hold(1) }, '▲'),
      el('button', { 'aria-label': 'Walk back', ...hold(-1) }, '▼')
    )

    this.root.append(this.panel, this.here, this.compass, this.card, this.help, this.credits, this.debug, this.touchPad)
    document.body.append(this.root)

    window.addEventListener('error', (e) => this.error(e.message))
    window.addEventListener('unhandledrejection', (e) => this.error(String(e.reason?.message ?? e.reason)))
    document.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input,select,textarea')) return
      if (e.key === '`') this.toggleDebug()
      if (e.code === 'KeyN') onFaceNorth()
      if (e.code === 'KeyC') {
        this.camerasBox.checked = !this.camerasBox.checked
        onCameras(this.camerasBox.checked)
      }
      if (e.code === 'Escape') this.onCardClose?.()
      if (e.code === 'KeyL') {
        this.labelsBox.checked = !this.labelsBox.checked
        onLabels(this.labelsBox.checked)
      }
    })
    if (new URLSearchParams(location.search).has('debug')) this.toggleDebug()
  }

  toggleDebug() {
    this.debug.hidden = !this.debug.hidden
    this.debugToggle.classList.toggle('on', !this.debug.hidden)
  }

  error(msg) {
    if (!msg) return
    this.errors.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
    if (this.errors.length > 6) this.errors.shift()
  }

  setMode(mode) {
    for (const [k, b] of Object.entries(this.modeButtons)) b.classList.toggle('on', k === mode)
    const coarse = matchMedia('(pointer: coarse)').matches
    this.touchPad.hidden = !(mode === 'walk' && coarse)
    this.help.textContent =
      mode === 'walk'
        ? coarse
          ? 'Drag to look · hold ▲ ▼ to walk'
          : 'Click to look around (Esc releases) · WASD / arrows to walk · Shift to run'
        : coarse
          ? 'Drag to pan · two fingers to rotate and zoom'
          : 'Drag to pan · right-drag to rotate · scroll to zoom'
  }

  setCredits(lines) {
    this.credits.textContent = lines.filter(Boolean).join(' · ')
  }

  setDebug(lines) {
    if (this.debug.hidden) return
    this.debug.textContent = [...lines, ...(this.errors.length ? ['', 'errors:', ...this.errors] : [])].join('\n')
  }
}
