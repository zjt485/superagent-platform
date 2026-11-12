/**
 * Visual QA helper: drive a local Chrome through CDP, log in with the dev
 * account, and capture the console pages into docs/screenshots.
 *
 * Usage: node scripts/ui-screenshots.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '')
const OUT = path.resolve('docs/screenshots')
const DEBUG_PORT = 9333
const profile = path.join(tmpdir(), `superagent-chrome-${Date.now()}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await mkdir(OUT, { recursive: true })

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function waitForDevtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error('Chrome DevTools endpoint did not start')
}

try {
  await waitForDevtools()
  const target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then((response) => response.json())
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  const listeners = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? {})})`))
      else resolve(message.result)
      return
    }
    for (const handler of listeners.get(message.method) ?? []) handler(message.params)
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  const waitEvent = (method, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const handlers = listeners.get(method) ?? []
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout)
      const handler = (params) => {
        clearTimeout(timer)
        listeners.set(
          method,
          (listeners.get(method) ?? []).filter((item) => item !== handler),
        )
        resolve(params)
      }
      handlers.push(handler)
      listeners.set(method, handlers)
    })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false })

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
    return result.result.value
  }

  const navigate = async (url) => {
    const loaded = waitEvent('Page.loadEventFired')
    await send('Page.navigate', { url })
    await loaded
    await sleep(900)
  }

  const shot = async (name, fullPage = false) => {
    const result = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: fullPage,
    })
    await writeFile(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
    process.stdout.write(`captured ${name}\n`)
  }

  await navigate(`${BASE}/login`)
  await shot('01-login')

  const loginStatus = await evaluate(
    `fetch('/v1/auth/dev-login', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-superagent-csrf': '1' }, body: JSON.stringify({ name: 'Alice' }) }).then((response) => response.status)`,
  )
  if (loginStatus !== 200) throw new Error(`dev login failed: ${loginStatus}`)

  await navigate(`${BASE}/`)
  await shot('02-projects')

  const projects = await evaluate(`fetch('/v1/projects', { credentials: 'include' }).then((response) => response.json())`)
  const projectId = projects.items?.[0]?.id
  if (!projectId) throw new Error('no demo project found')
  await navigate(`${BASE}/projects/${projectId}`)
  await shot('03-project-overview')

  await navigate(`${BASE}/projects/${projectId}?tab=session`)
  await shot('03b-main-session')

  await navigate(`${BASE}/projects/${projectId}?tab=tickets`)
  await shot('04-tickets')

  const tickets = await evaluate(`fetch('/v1/projects/${projectId}/tickets', { credentials: 'include' }).then((response) => response.json())`)
  const ticketId = tickets.items?.[0]?.id
  if (ticketId) {
    await navigate(`${BASE}/projects/${projectId}/tickets/${ticketId}`)
    await shot('05-ticket')
  }

  await navigate(`${BASE}/projects/${projectId}?tab=invites`)
  await shot('06-invites')
  await evaluate(
    `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('生成邀请')); if (button) { button.click(); return true } return false })()`,
  )
  await sleep(1200)
  await shot('06b-invite-qr')

  await navigate(`${BASE}/projects/${projectId}?tab=members`)
  await shot('07-members')

  await navigate(`${BASE}/projects/${projectId}?tab=repo`)
  await shot('07b-repo')

  await navigate(`${BASE}/projects/${projectId}?tab=channel`)
  await shot('07g-channel')

  await navigate(`${BASE}/projects/${projectId}?tab=audit`)
  await shot('07c-audit')

  await navigate(`${BASE}/projects/${projectId}?tab=settings`)
  await shot('07d-settings')

  // Invitation → group entry flow (the demo channel has a QR + join link).
  const invite = await evaluate(
    `fetch('/v1/projects/${projectId}/invites', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-superagent-csrf': '1' }, body: JSON.stringify({ role: 'member', maxUses: 5, expiresInHours: 24 }) }).then((response) => response.json())`,
  )
  if (invite?.token) {
    await navigate(`${BASE}/invite/${invite.token}`)
    await shot('07e-invite')
    await evaluate(
      `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('接受邀请并加入')); if (button) { button.click(); return true } return false })()`,
    )
    await sleep(1600)
    await shot('07f-invite-group')
  }

  await evaluate(`localStorage.setItem('sa-theme', 'dark')`)
  await navigate(`${BASE}/projects/${projectId}`)
  await shot('08-project-dark')

  await navigate(`${BASE}/projects/${projectId}/tickets/${ticketId ?? ''}`)
  await shot('09-ticket-dark')

  // Narrow viewport: verify the console does not overflow horizontally.
  await send('Emulation.setDeviceMetricsOverride', { width: 860, height: 980, deviceScaleFactor: 1, mobile: false })
  await navigate(`${BASE}/projects/${projectId}`)
  await shot('10-project-narrow')

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await navigate(`${BASE}/`)
  await shot('11-projects-mobile')

  socket.close()
} finally {
  chrome.kill()
  await sleep(300)
}
