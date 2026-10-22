// Renders the built viewer in headless Chromium and saves screenshots.
//
//   npm run build && npx vite preview --port 4173 &
//   node tools/screenshot.mjs [outDir] [view ...]
//
// Headless WebGL uses SwiftShader (software), so frame rates here mean nothing;
// this is for checking that the scene renders and looks right.

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const outDir = process.argv[2] ?? 'screenshots'
const views = process.argv.slice(3).length ? process.argv.slice(3) : ['overview', 'downtown', 'neighborhood', 'street', 'mountains']
const base = process.env.VIEWER_URL ?? 'http://localhost:4173/'
const time = process.env.VIEW_TIME ?? '2026-10-22T19:30:00Z' // 1:30 pm MDT
const extra = process.env.VIEW_PARAMS ?? ''
mkdirSync(outDir, { recursive: true })

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  proxy,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text().slice(0, 300)}`)
})
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))

for (const view of views) {
  const url = `${base}?view=${view}&t=${encodeURIComponent(time)}&debug=1${extra}`
  const t0 = Date.now()
  await page.goto(url)
  try {
    await page.waitForFunction(() => window.__nampa?.ready, null, { timeout: 240000, polling: 1000 })
  } catch {
    console.log(`${view}: not idle after 240 s, capturing anyway`)
  }
  await page.waitForTimeout(1500)
  const path = `${outDir}/${view}.png`
  await page.screenshot({ path })
  console.log(`${view}: ${path} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
}
await browser.close()
