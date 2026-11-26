import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Database } from '../../db/client.js'
import { artifacts } from '../../db/schema.js'
import { newId } from '../../domain/ids.js'

export interface BrowserToolEvent {
  type: string
  message?: string
  payload?: unknown
}

export interface BrowserRunnerOptions {
  db?: Database
  rootDir: string
  projectId: string
  ticketId?: string | null
  turnId?: string | null
  botId?: string | null
  botHomeDir?: string
  fetchImpl?: typeof fetch
  preferPlaywright?: boolean
  now?: () => Date
  onEvent?: (event: BrowserToolEvent) => void | Promise<void>
}

interface PlaywrightPageLike {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  title(): Promise<string>
  url(): string
  click(selector: string, opts?: { timeout?: number }): Promise<void>
  fill(selector: string, text: string, opts?: { timeout?: number }): Promise<void>
  innerText(selector: string, opts?: { timeout?: number }): Promise<string>
  screenshot(opts?: { fullPage?: boolean; type?: 'png' | 'jpeg' }): Promise<Buffer>
}

interface PlaywrightContextLike {
  pages(): PlaywrightPageLike[]
  newPage(): Promise<PlaywrightPageLike>
  close(): Promise<void>
}

function assertHttpUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`invalid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme: ${parsed.protocol}`)
  }
  return parsed
}

function stripHtmlToText(html: string): { title: string; text: string; links: Array<{ text: string; href: string }> } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
  const links: Array<{ text: string; href: string }> = []
  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null && links.length < 40) {
    const href = m[1]?.trim() ?? ''
    const label = (m[2] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (href) links.push({ text: label || href, href })
  }
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
  return { title, text: cleaned, links }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function renderFallbackSvg(input: { url: string; title: string; snippet: string; capturedAt: string }): Buffer {
  const lines: string[] = []
  const snippet = input.snippet.slice(0, 720)
  for (let i = 0; i < snippet.length && lines.length < 10; i += 72) {
    lines.push(snippet.slice(i, i + 72))
  }
  const bodyLines = lines
    .map(
      (line, idx) =>
        `<text x="36" y="${156 + idx * 28}" fill="#e2e8f0" font-size="15" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${escapeXml(line)}</text>`,
    )
    .join('\n')

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="520" viewBox="0 0 960 520">
  <rect width="960" height="520" rx="12" fill="#0f172a"/>
  <rect x="0" y="0" width="960" height="54" rx="12" fill="#1e293b"/>
  <circle cx="26" cy="27" r="7" fill="#ef4444"/>
  <circle cx="48" cy="27" r="7" fill="#f59e0b"/>
  <circle cx="70" cy="27" r="7" fill="#22c55e"/>
  <rect x="100" y="13" width="760" height="28" rx="6" fill="#0f172a"/>
  <text x="114" y="32" fill="#94a3b8" font-size="13" font-family="ui-monospace, monospace">${escapeXml(input.url.slice(0, 88))}</text>
  <text x="36" y="96" fill="#f8fafc" font-size="22" font-weight="700" font-family="system-ui, -apple-system, sans-serif">${escapeXml((input.title || 'Browser Capture').slice(0, 64))}</text>
  <text x="36" y="122" fill="#64748b" font-size="12" font-family="system-ui, sans-serif">Captured at ${escapeXml(input.capturedAt)}</text>
  ${bodyLines}
</svg>`
  return Buffer.from(svg, 'utf8')
}

/**
 * Browser tool runner attached to a Bot turn.
 * Uses Playwright with a persistent per-Bot profile when installed, and
 * degrades cleanly to HTTP fetch + HTML text extraction + SVG visual snapshot
 * in minimal dev/CI environments without Chromium binaries.
 */
export class BrowserToolRunner {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private context: PlaywrightContextLike | null = null
  private page: PlaywrightPageLike | null = null
  private playwrightUnavailable = false

  private currentUrl = 'about:blank'
  private currentTitle = ''
  private currentHtml = ''
  private currentText = ''
  private currentLinks: Array<{ text: string; href: string }> = []
  private typedValues = new Map<string, string>()

  constructor(private readonly options: BrowserRunnerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    if (options.preferPlaywright === false) this.playwrightUnavailable = true
  }

  private async ensurePlaywrightPage(): Promise<PlaywrightPageLike | null> {
    if (this.playwrightUnavailable) return null
    if (this.page) return this.page
    try {
      const moduleName = 'playwright'
      const pw = (await import(moduleName)) as {
        chromium?: {
          launchPersistentContext(
            userDataDir: string,
            options?: Record<string, unknown>,
          ): Promise<PlaywrightContextLike>
        }
      }
      if (!pw?.chromium?.launchPersistentContext) {
        this.playwrightUnavailable = true
        return null
      }
      const profileDir = path.resolve(
        this.options.botHomeDir ?? path.join(this.options.rootDir, 'browser-profiles', this.options.botId ?? 'default'),
        '.browser-profile',
      )
      await mkdir(profileDir, { recursive: true })
      this.context = await pw.chromium.launchPersistentContext(profileDir, {
        headless: true,
        viewport: { width: 1280, height: 800 },
      })
      const existing = this.context.pages()
      this.page = existing[0] ?? (await this.context.newPage())
      return this.page
    } catch {
      this.playwrightUnavailable = true
      return null
    }
  }

  async open(url: string): Promise<{ url: string; title: string; engine: 'playwright' | 'http'; excerpt: string; linksCount: number }> {
    const parsed = assertHttpUrl(url)
    const page = await this.ensurePlaywrightPage()
    if (page) {
      await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 })
      this.currentUrl = page.url()
      this.currentTitle = await page.title().catch(() => '')
      this.currentText = await page.innerText('body', { timeout: 5_000 }).catch(() => '')
      return {
        url: this.currentUrl,
        title: this.currentTitle,
        engine: 'playwright',
        excerpt: this.currentText.slice(0, 1200),
        linksCount: 0,
      }
    }

    const res = await this.fetchImpl(parsed.toString(), {
      headers: { 'user-agent': 'Superagent-Bot-Browser/1.0' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${parsed.toString()}`)
    const html = await res.text()
    const extracted = stripHtmlToText(html)
    this.currentUrl = res.url || parsed.toString()
    this.currentTitle = extracted.title
    this.currentHtml = html
    this.currentText = extracted.text
    this.currentLinks = extracted.links
    return {
      url: this.currentUrl,
      title: this.currentTitle,
      engine: 'http',
      excerpt: this.currentText.slice(0, 1200),
      linksCount: this.currentLinks.length,
    }
  }

  async click(selector: string): Promise<{ ok: boolean; url: string; title: string; note?: string }> {
    const trimmed = selector.trim()
    if (!trimmed) throw new Error('selector is required')
    const page = await this.ensurePlaywrightPage()
    if (page) {
      await page.click(trimmed, { timeout: 10_000 })
      this.currentUrl = page.url()
      this.currentTitle = await page.title().catch(() => this.currentTitle)
      return { ok: true, url: this.currentUrl, title: this.currentTitle }
    }

    const matchedLink = this.currentLinks.find(
      (link) => link.text.toLowerCase().includes(trimmed.toLowerCase()) || link.href.includes(trimmed),
    )
    if (matchedLink && this.currentUrl !== 'about:blank') {
      const nextUrl = new URL(matchedLink.href, this.currentUrl).toString()
      const opened = await this.open(nextUrl)
      return { ok: true, url: opened.url, title: opened.title, note: `followed link ${matchedLink.href}` }
    }
    return {
      ok: true,
      url: this.currentUrl,
      title: this.currentTitle,
      note: 'http fallback mode recorded click without headless DOM',
    }
  }

  async type(selector: string, text: string): Promise<{ ok: boolean; selector: string; length: number }> {
    const trimmed = selector.trim()
    if (!trimmed) throw new Error('selector is required')
    const page = await this.ensurePlaywrightPage()
    if (page) {
      await page.fill(trimmed, text, { timeout: 10_000 })
      return { ok: true, selector: trimmed, length: text.length }
    }
    this.typedValues.set(trimmed, text)
    return { ok: true, selector: trimmed, length: text.length }
  }

  async extract(selector?: string, maxChars = 6000): Promise<{ url: string; title: string; text: string; links: Array<{ text: string; href: string }> }> {
    const limit = Math.min(Math.max(maxChars, 200), 20_000)
    const page = await this.ensurePlaywrightPage()
    if (page) {
      const target = selector?.trim() || 'body'
      const text = await page.innerText(target, { timeout: 8_000 }).catch(() => '')
      this.currentText = text
      return { url: page.url(), title: await page.title().catch(() => ''), text: text.slice(0, limit), links: [] }
    }
    let text = this.currentText
    if (selector?.trim() && this.currentHtml) {
      const tag = selector.trim().replace(/[^a-zA-Z0-9]/g, '')
      if (tag) {
        const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
        const parts: string[] = []
        let m: RegExpExecArray | null
        while ((m = re.exec(this.currentHtml)) !== null && parts.length < 20) {
          parts.push((m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
        }
        if (parts.length > 0) text = parts.join('\n')
      }
    }
    return {
      url: this.currentUrl,
      title: this.currentTitle,
      text: text.slice(0, limit),
      links: this.currentLinks.slice(0, 20),
    }
  }

  async screenshot(input: { title?: string; fullPage?: boolean } = {}): Promise<{
    artifactId: string
    screenshotUrl: string
    mimeType: string
    sizeBytes: number
    pageUrl: string
    title: string
  }> {
    const at = this.now()
    const artifactId = newId()
    const page = await this.ensurePlaywrightPage()
    let data: Buffer
    let mimeType: string
    let ext: string

    if (page) {
      data = await page.screenshot({ fullPage: Boolean(input.fullPage), type: 'png' })
      mimeType = 'image/png'
      ext = 'png'
    } else {
      data = renderFallbackSvg({
        url: this.currentUrl,
        title: input.title || this.currentTitle || 'Browser Snapshot',
        snippet: this.currentText || 'No page content loaded yet.',
        capturedAt: at.toISOString(),
      })
      mimeType = 'image/svg+xml'
      ext = 'svg'
    }

    const dir = path.resolve(this.options.rootDir, 'artifacts', this.options.projectId)
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${artifactId}.${ext}`)
    await writeFile(filePath, data)

    const title = (input.title || this.currentTitle || `截图 ${this.currentUrl}`).slice(0, 200)
    if (this.options.db) {
      await this.options.db.insert(artifacts).values({
        id: artifactId,
        projectId: this.options.projectId,
        ticketId: this.options.ticketId ?? null,
        turnId: this.options.turnId ?? null,
        botId: this.options.botId ?? null,
        kind: 'browser_screenshot',
        title,
        mimeType,
        storagePath: filePath,
        sizeBytes: data.byteLength,
        createdAt: at,
      })
    }

    const screenshotUrl = `/v1/projects/${this.options.projectId}/artifacts/${artifactId}`
    await this.options.onEvent?.({
      type: 'browser_screenshot',
      message: title,
      payload: {
        artifactId,
        screenshotUrl,
        pageUrl: this.currentUrl,
        title,
        mimeType,
        sizeBytes: data.byteLength,
      },
    })
    return {
      artifactId,
      screenshotUrl,
      mimeType,
      sizeBytes: data.byteLength,
      pageUrl: this.currentUrl,
      title,
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {})
      this.context = null
      this.page = null
    }
  }
}
