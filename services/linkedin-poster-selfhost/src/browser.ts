import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import type { PosterConfig } from './types.js';

const LOGIN_PATTERN = /log.?in|sign.?in|authwall/i;

export interface BrowserHealthStatus {
  healthy: boolean;
  status: 'not_initialized' | 'healthy' | 'session_expired' | 'error';
  title?: string;
  url?: string;
  message?: string;
}

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: PosterConfig;
  private healthCheck: Promise<boolean> | null = null;
  private lastHealthStatus: BrowserHealthStatus = {
    healthy: false,
    status: 'not_initialized',
    message: 'BrowserManager not initialized',
  };

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

  isReady(): boolean {
    return !!this.context && !!this.page && !this.page.isClosed();
  }

  getLastHealthStatus(): BrowserHealthStatus {
    return { ...this.lastHealthStatus };
  }

  private async killLingeringProfileProcesses(): Promise<void> {
    const profileDir = this.config.profileDir;
    await new Promise<void>((resolve) => {
      execFile('pkill', ['-f', profileDir], () => {
        // Ignore errors — process may already be gone
        resolve();
      });
    });
  }

  private async resetContext(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
      }
    } catch (err) {
      console.error('[browser] Error closing crashed context:', (err as Error).message);
    } finally {
      this.context = null;
      this.page = null;
    }

    await this.killLingeringProfileProcesses();
  }

  private async recoverAfterCrash(): Promise<void> {
    console.warn('[browser] Re-launching persistent context after failed health check');
    await this.resetContext();
    await this.init();
  }

  async checkHealth(): Promise<boolean> {
    if (this.healthCheck) return this.healthCheck;
    this.healthCheck = this.runHealthCheck().finally(() => {
      this.healthCheck = null;
    });
    return this.healthCheck;
  }

  async getHealthStatus(): Promise<BrowserHealthStatus> {
    await this.checkHealth();
    return this.getLastHealthStatus();
  }

  private async runHealthCheck(): Promise<boolean> {
    if (!this.page) {
      this.lastHealthStatus = {
        healthy: false,
        status: 'not_initialized',
        message: 'BrowserManager not initialized',
      };
      return false;
    }
    try {
      if (this.page.isClosed()) {
        throw new Error('Browser page is closed');
      }

      const initialUrl = this.page.url();
      const initialLinkedInPage = /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(initialUrl);
      if (!initialLinkedInPage) {
        await this.page.goto('https://www.linkedin.com/feed/', {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        });
      }

      const title = await this.page.title();
      const url = this.page.url();
      const linkedinPage = /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(url);
      const healthy = linkedinPage && !LOGIN_PATTERN.test(`${title} ${url}`);
      this.lastHealthStatus = {
        healthy,
        status: healthy ? 'healthy' : 'session_expired',
        title,
        url,
      };
      if (!healthy) {
        console.error(`[browser] Session expired — page title: "${title}"`);
      }
      return healthy;
    } catch (err) {
      const message = (err as Error).message.split('\n')[0];
      this.lastHealthStatus = {
        healthy: false,
        status: 'error',
        message,
      };
      console.error('[browser] Health check failed:', message);
      try {
        await this.recoverAfterCrash();
      } catch (recoverErr) {
        console.error('[browser] Recovery failed:', (recoverErr as Error).message.split('\n')[0]);
      }
      return false;
    }
  }

  async close(): Promise<void> {
    await this.resetContext();
  }
}
