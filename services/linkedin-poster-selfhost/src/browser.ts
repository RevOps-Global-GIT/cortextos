import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import type { PosterConfig } from './types.js';

const LOGIN_PATTERN = /log.?in|sign.?in|authwall/i;

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: PosterConfig;

  constructor(config: PosterConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (!existsSync(this.config.profileDir)) {
      console.log(`[browser] Profile dir not found — creating: ${this.config.profileDir}`);
      mkdirSync(this.config.profileDir, { recursive: true });
      chmodSync(this.config.profileDir, 0o700);
      console.log('[browser] WARNING: Profile not seeded yet. Run: cortextos bus poster-selfhost login --user <name>');
    }

    const proxyServer = process.env['SOCKS_PROXY'] ?? process.env['HTTPS_PROXY'] ?? null;
    if (proxyServer) {
      console.log(`[browser] Using upstream proxy: ${proxyServer}`);
    }
    console.log(`[browser] Launching persistent context: ${this.config.profileDir}`);
    // Use headed mode when a virtual display is available (Xvfb :99).
    // LinkedIn detects and degrades headless Chrome, returning no feed content.
    // With DISPLAY=:99 + Xvfb, headed mode is invisible to the user but
    // appears as a real browser to LinkedIn.
    const headless = !process.env['DISPLAY'];
    if (!headless) {
      console.log(`[browser] Headed mode enabled (DISPLAY=${process.env['DISPLAY']})`);
    }
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
      viewport: { width: 1280, height: 900 },
      ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    });

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    console.log('[browser] Persistent context ready');
  }

  getPage(): Page {
    if (!this.page) throw new Error('BrowserManager not initialized — call init() first');
    return this.page;
  }

  async checkHealth(): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
      const title = await this.page.title();
      const healthy = !LOGIN_PATTERN.test(title);
      if (!healthy) {
        console.error(`[browser] Session expired — page title: "${title}"`);
      }
      return healthy;
    } catch (err) {
      console.error('[browser] Health check failed:', (err as Error).message.split('\n')[0]);
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
        this.context = null;
        this.page = null;
      }
    } catch (err) {
      console.error('[browser] Error closing context:', (err as Error).message);
    }

    // Kill any lingering Chromium processes that had this profile open
    const profileDir = this.config.profileDir;
    execFile('pkill', ['-f', profileDir], () => {
      // Ignore errors — process may already be gone
    });
  }
}
