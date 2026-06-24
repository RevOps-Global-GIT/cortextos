/**
 * LinkedIn action implementations — ported from platform/scripts/linkedin-poster/src/poster.cjs.
 * Uses Playwright Page instead of agent-browser CLI. Business logic preserved verbatim.
 */

import { readFileSync, existsSync } from 'fs';
import type { Page } from 'playwright';
import type { ActionResult } from './types.js';

export interface DiscoveredPost {
  url: string;
  authorName: string;
  authorUrl: string | null;
  text: string;
  keyword: string;
}

const LOGIN_PATTERN = /log.?in|sign.?in|authwall/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkSession(page: Page): Promise<void> {
  const title = await page.title();
  if (LOGIN_PATTERN.test(title)) {
    throw new Error('Not logged into LinkedIn. Run: cortextos bus poster-selfhost login --user <name>');
  }
}

async function gotoLinkedInPage(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await checkSession(page);
  await page.waitForSelector('body', { state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(1500);
}

/** Get button text inventory for debugging when expected button is missing. */
async function buttonInventory(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .map(b => b.getAttribute('aria-label') || b.textContent?.trim() || '')
      .filter(Boolean)
      .slice(0, 30)
      .join(' | ')
  );
}

async function clickFirstAvailable(
  page: Page,
  candidates: Array<{ role: 'button' | 'menuitem'; name: RegExp }>,
  timeout = 3000,
): Promise<string | null> {
  for (const candidate of candidates) {
    const locator = page.getByRole(candidate.role, { name: candidate.name }).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    try {
      await locator.click({ timeout });
      return `${candidate.role}:${candidate.name}`;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function commentNeedles(commentText: string): string[] {
  const normalized = normalizeText(commentText);
  return [
    normalized.slice(0, 140),
    normalizeText(commentText.split('\n\n')[1] ?? '').slice(0, 140),
    normalized.slice(0, 90),
  ].filter((needle, index, values) => needle.length >= 30 && values.indexOf(needle) === index);
}

async function setCommentsSortToRecent(page: Page): Promise<void> {
  const sort = page.getByRole('button', { name: /sort order|most relevant|most recent/i }).first();
  if ((await sort.count().catch(() => 0)) === 0) return;

  try {
    await sort.click({ timeout: 2500 });
    await page.waitForTimeout(500);
    const recent = page.getByRole('menuitem', { name: /most recent|recent/i }).first();
    if ((await recent.count().catch(() => 0)) > 0) {
      await recent.click({ timeout: 2500 });
      await page.waitForTimeout(1000);
    }
  } catch {
    // Sorting is a best-effort read-back assist. The direct DOM check below is authoritative.
  }
}

async function expandCommentThread(page: Page): Promise<void> {
  await setCommentsSortToRecent(page);

  for (let i = 0; i < 4; i++) {
    for (const name of [/show more/i, /see more/i, /load more/i, /more comments?/i, /previous comments?/i]) {
      const control = page.getByRole('button', { name }).first();
      if ((await control.count().catch(() => 0)) > 0) {
        await control.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }
    await page.mouse.wheel(0, 450).catch(() => {});
    await page.waitForTimeout(350);
  }
}

async function findRenderedComment(page: Page, commentText: string): Promise<{ permalink?: string; matchedSnippet: string } | null> {
  const needles = commentNeedles(commentText);
  for (const needle of needles) {
    const found = await page.evaluate((text: string) => {
      const norm = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const contentEditable = (el: Element): boolean =>
        el.matches('[contenteditable="true"]') ||
        !!el.closest('[contenteditable="true"]') ||
        !!el.querySelector('[contenteditable="true"]');

      const elements = Array.from(document.querySelectorAll('article, .comments-comment-item, [data-id], div, span, p'));
      for (const element of elements) {
        if (contentEditable(element)) continue;
        const body = norm(element.textContent ?? '');
        if (!body.includes(text)) continue;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const permalink =
          (element.closest('a') as HTMLAnchorElement | null)?.href ||
          (element.querySelector('a[href*="comment"]') as HTMLAnchorElement | null)?.href ||
          (element.closest('[data-id]')?.querySelector('a[href*="comment"]') as HTMLAnchorElement | null)?.href ||
          undefined;
        return { permalink };
      }
      return null;
    }, needle);
    if (found) return { permalink: found.permalink, matchedSnippet: needle };
  }
  return null;
}

async function waitForCommentReadback(page: Page, commentText: string): Promise<{ permalink?: string; matchedSnippet: string }> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const found = await findRenderedComment(page, commentText);
    if (found) return found;
    await expandCommentThread(page);
  }

  const editorText = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .map(el => el.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
  );
  throw new Error(`Comment read-back failed — posted text did not render in live comment list. editorText="${editorText}"`);
}

async function readLikeState(page: Page): Promise<'active' | 'inactive' | 'missing'> {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const likeButton = buttons.find((button) => {
      const text = button.textContent?.trim() ?? '';
      const label = button.getAttribute('aria-label') ?? '';
      if (/comment|reply|send|share|repost/i.test(label) || /comment|reply|send|share|repost/i.test(text)) return false;
      return /^Like$/i.test(text) || /^Like\b/i.test(label) || /\bReact Like\b/i.test(label) || /\bUnreact\b/i.test(label);
    });
    if (!likeButton) return 'missing';
    const label = likeButton.getAttribute('aria-label') ?? '';
    const active = likeButton.getAttribute('aria-pressed') === 'true' || /\bUnlike\b|\bUnreact\b/i.test(label);
    return active ? 'active' : 'inactive';
  });
}

// ---------------------------------------------------------------------------
// postLinkedInComment
// ---------------------------------------------------------------------------
export async function postLinkedInComment(
  page: Page,
  postUrl: string,
  commentText: string,
): Promise<ActionResult> {
  console.log(`[actions] Opening post: ${postUrl}`);
  await gotoLinkedInPage(page, postUrl);

  // Focus or expand the comment editor without clicking the placeholder span.
  console.log('[actions] Expanding comment box…');
  const expandResult = await page.evaluate(() => {
    const existing = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
    if (existing) {
      existing.focus();
      existing.click();
      return 'focused-existing-editor';
    }

    const placeholder = Array.from(document.querySelectorAll('span,div,p')).find(el =>
      /Add a comment/i.test(el.textContent ?? '')
    ) as HTMLElement | undefined;
    const clickable = placeholder?.closest('[contenteditable="true"],button,[role="button"],.comments-comment-box,form,div') as HTMLElement | null;
    if (clickable) {
      clickable.focus();
      clickable.click();
      return 'clicked-comment-container';
    }
    return 'no-comment-container';
  });
  console.log(`[actions] Comment editor expand result: ${expandResult}`);
  await page.waitForTimeout(1500);

  // Inject text via shadow DOM eval (same approach as Mac poster)
  const safeText = JSON.stringify(commentText);
  const injectResult = await page.evaluate(`
    (function() {
      // Try direct contenteditable first
      const editor = document.querySelector('[contenteditable="true"]');
      if (editor) {
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${safeText});
        return 'ok:' + editor.textContent.length;
      }
      // Try interop-outlet shadow DOM (newer LinkedIn)
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet && outlet.shadowRoot;
      if (shadow) {
        const shadowEditor = shadow.querySelector('[contenteditable="true"]');
        if (shadowEditor) {
          shadowEditor.focus();
          document.execCommand('insertText', false, ${safeText});
          return 'shadow-ok:' + shadowEditor.textContent.length;
        }
      }
      return 'no-editor';
    })()`
  ) as string;

  console.log(`[actions] Text injection result: ${injectResult}`);
  if (injectResult.startsWith('no-')) {
    throw new Error(`Could not find TipTap comment editor: ${injectResult}`);
  }

  await page.waitForTimeout(800);

  // Verify content
  const actualText = await page.evaluate(`
    (function() {
      const editor = document.querySelector('[contenteditable="true"]');
      if (editor) return editor.textContent;
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet && outlet.shadowRoot;
      if (shadow) {
        const e = shadow.querySelector('[contenteditable="true"]');
        if (e) return e.textContent;
      }
      return '';
    })()`
  ) as string;

  const preview = commentText.substring(0, 30);
  if (!actualText.includes(preview)) {
    throw new Error(`Comment verification failed. Expected "${preview}" but got: "${actualText.substring(0, 60)}"`);
  }
  console.log('[actions] Comment verified in editor.');

  // Click the "Comment" submit button (inline TipTap button, not hidden Submit)
  const commentBtnFound = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const commentBtn = btns.find(b => {
      const text = b.textContent?.trim() ?? '';
      const label = b.getAttribute('aria-label') ?? '';
      return (text === 'Comment' || label === 'Comment') && !/add a comment/i.test(text);
    });
    if (commentBtn) { commentBtn.click(); return true; }
    return false;
  });

  if (!commentBtnFound) {
    console.log('[actions] Comment button not found, using Meta+Return');
    await page.keyboard.press('Meta+Return');
  }

  await page.waitForTimeout(2500);
  const readback = await waitForCommentReadback(page, commentText);
  console.log(`[actions] Comment posted and read-back verified: ${readback.matchedSnippet.slice(0, 60)}`);
  return {
    success: true,
    note: 'comment_readback_verified',
    comment_permalink: readback.permalink ?? page.url(),
  };
}

// ---------------------------------------------------------------------------
// likeLinkedInPost
// ---------------------------------------------------------------------------
export async function likeLinkedInPost(
  page: Page,
  postUrl: string,
): Promise<ActionResult> {
  console.log(`[actions] Opening post to like: ${postUrl}`);
  await gotoLinkedInPage(page, postUrl);

  const likeResult = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const likeButton = buttons.find((button) => {
      const text = button.textContent?.trim() ?? '';
      const label = button.getAttribute('aria-label') ?? '';
      if (/comment|reply|send|share|repost/i.test(label) || /comment|reply|send|share|repost/i.test(text)) return false;
      return /^Like$/i.test(text) || /^Like\b/i.test(label) || /\bReact Like\b/i.test(label);
    });

    if (!likeButton) {
      return 'no-like-button';
    }
    const pressed = likeButton.getAttribute('aria-pressed') === 'true' ||
      /\bUnlike\b/i.test(likeButton.getAttribute('aria-label') ?? '');
    if (pressed) {
      return 'already-liked';
    }

    likeButton.scrollIntoView({ block: 'center', inline: 'center' });
    likeButton.click();
    return 'liked';
  });

  console.log(`[actions] Like result: ${likeResult}`);
  if (likeResult === 'already-liked') {
    return { success: true, skipped: true, reason: 'already_liked' };
  }
  if (likeResult !== 'liked') {
    throw new Error(`Could not like post: ${likeResult}; buttons=${await buttonInventory(page)}`);
  }

  await page.waitForTimeout(1500);
  const readback = await readLikeState(page);
  if (readback !== 'active') {
    throw new Error(`Like read-back failed — expected active reaction state, got ${readback}; buttons=${await buttonInventory(page)}`);
  }
  console.log('[actions] Like read-back verified.');
  return { success: true };
}

// ---------------------------------------------------------------------------
// sendConnectionRequest
// ---------------------------------------------------------------------------
export async function sendConnectionRequest(
  page: Page,
  profileUrl: string,
  noteText?: string,
): Promise<ActionResult> {
  console.log(`[actions] Opening profile: ${profileUrl}`);
  await gotoLinkedInPage(page, profileUrl);
  await page.waitForSelector('button,main', { state: 'attached', timeout: 20_000 });

  // PRE-CHECK: if "Message" button is visible, we're already connected — skip
  const hasMessage = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some(b =>
      /^Message$/.test(b.textContent?.trim() ?? '') ||
      /^Message$/.test(b.getAttribute('aria-label') ?? '')
    )
  );
  if (hasMessage) {
    console.log('[actions] Already connected (Message button found). Skipping connect.');
    return { success: true, skipped: true, reason: 'already_connected' };
  }

  // Click the profile-header Connect control. Avoid global More menus from
  // nav, posts, recommendations, and sidebars.
  const profileClick = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(el as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textOf = (el: Element): string =>
      `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim();

    const h1 = document.querySelector('h1');
    const section = h1?.closest('section') ?? h1?.closest('main') ?? document.querySelector('main');
    if (!section) return 'no-profile-section';

    const buttons = Array.from(section.querySelectorAll('button')).filter(isVisible);
    const connect = buttons.find((button) => /\bConnect\b/i.test(textOf(button)));
    if (connect) {
      (connect as HTMLElement).click();
      return 'profile-connect';
    }

    const more = buttons.find((button) => /\bMore\b/i.test(textOf(button)));
    if (more) {
      (more as HTMLElement).click();
      return 'profile-more';
    }

    return `no-profile-connect:${buttons.map(textOf).filter(Boolean).slice(0, 12).join(' | ')}`;
  }) as string;

  let connectClick: string | null = null;
  if (profileClick === 'profile-connect') {
    connectClick = profileClick;
  } else if (profileClick === 'profile-more') {
    await page.waitForTimeout(800);
    connectClick = await clickFirstAvailable(page, [
      { role: 'menuitem', name: /\bConnect\b/i },
      { role: 'button', name: /^Connect$/i },
    ], 5000);
  } else {
    console.log(`[actions] No profile Connect control found: ${profileClick}`);
    return { success: true, skipped: true, reason: 'no_profile_connect_control' };
  }

  if (!connectClick) {
    console.log(`[actions] Profile More opened but no Connect item found. buttons=${await buttonInventory(page)}`);
    return { success: true, skipped: true, reason: 'no_connect_menu_item' };
  }
  console.log(`[actions] Connect click result: ${connectClick}`);
  await page.waitForTimeout(1000);

  // Modal opens — click "Add a note" if available
  const addNoteClicked = !!(await clickFirstAvailable(page, [
    { role: 'button', name: /Add a note/i },
  ], 2500));

  if (!addNoteClicked) {
    // No note option — send/connect from the modal if a submit button is shown.
    const submitClicked = await clickFirstAvailable(page, [
      { role: 'button', name: /^Send$/i },
      { role: 'button', name: /^Send now$/i },
      { role: 'button', name: /^Send invitation$/i },
      { role: 'button', name: /^Connect$/i },
    ], 3000);
    if (submitClicked) {
      await page.waitForTimeout(1500);
      console.log(`[actions] Connection request sent without note via ${submitClicked}.`);
      return { success: true, note: 'Sent without note (Add a note not available)' };
    }

    const textarea = page.locator('textarea').first();
    if ((await textarea.count().catch(() => 0)) === 0) {
      console.log(`[actions] Connect click did not open a sendable modal. buttons=${await buttonInventory(page)}`);
      return { success: true, skipped: true, reason: 'connect_modal_not_sendable' };
    }
  }

  await page.waitForTimeout(800);

  // Fill note textarea (plain textarea, not TipTap)
  const note = (noteText ?? '').substring(0, 300);
  const textareaFilled = await page.evaluate((text: string) => {
    const textarea = document.querySelector('textarea');
    if (!textarea) return false;
    textarea.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    nativeInputValueSetter?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, note);

  if (!textareaFilled) {
    throw new Error('Could not find note textarea in connection modal.');
  }
  await page.waitForTimeout(500);

  // Verify note
  const noteActual = await page.evaluate(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? '');
  if (!noteActual.includes(note.substring(0, 20))) {
    throw new Error('Note text verification failed — not sending.');
  }

  // Click Send
  const sendClicked = await clickFirstAvailable(page, [
    { role: 'button', name: /^Send$/i },
    { role: 'button', name: /^Send now$/i },
    { role: 'button', name: /^Send invitation$/i },
    { role: 'button', name: /^Connect$/i },
  ], 5000);
  if (!sendClicked) throw new Error(`Could not find Send button in connection modal. buttons=${await buttonInventory(page)}`);

  await page.waitForTimeout(2000);
  console.log(`[actions] Connection request sent via ${sendClicked}.`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// sendDM
// ---------------------------------------------------------------------------
export async function sendDM(
  page: Page,
  profileUrl: string,
  messageText: string,
): Promise<ActionResult> {
  console.log(`[actions] Opening profile for DM: ${profileUrl}`);
  await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await checkSession(page);

  // Find and click Message button
  const msgClicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b =>
      /^Message$/.test(b.textContent?.trim() ?? '') || /^Message$/.test(b.getAttribute('aria-label') ?? '')
    );
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!msgClicked) {
    throw new Error('Could not find Message button. You may not be connected to this person yet.');
  }

  await page.waitForTimeout(1500);

  // Find TipTap editor in messaging overlay
  const injectResult = await page.evaluate((text: string) => {
    const editor = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
    if (!editor) return 'no-editor';
    editor.focus();
    document.execCommand('insertText', false, text);
    return 'ok:' + editor.textContent?.length;
  }, messageText) as string;

  if (injectResult.startsWith('no-')) {
    throw new Error('Could not find DM editor in messaging overlay.');
  }

  await page.waitForTimeout(600);

  // Verify
  const actual = await page.evaluate(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    return (editor as HTMLElement | null)?.textContent ?? '';
  });
  if (!actual.includes(messageText.substring(0, 20))) {
    throw new Error('DM text verification failed — not sending.');
  }

  // Send with Enter
  await page.keyboard.press('Return');
  await page.waitForTimeout(2000);
  console.log('[actions] DM sent.');
  return { success: true };
}

// ---------------------------------------------------------------------------
// publishLinkedInPost
// ---------------------------------------------------------------------------
export async function publishLinkedInPost(
  page: Page,
  postText: string,
  imagePaths: string[] = [],
): Promise<ActionResult> {
  if (imagePaths.length > 20) {
    throw new Error(`Too many images: ${imagePaths.length} (LinkedIn caps at 20)`);
  }

  // Navigate to feed and wait for actual readiness (not just DOMContentLoaded).
  // LinkedIn's React app does client-side navigations after DOMContentLoaded which
  // can destroy the JS execution context mid-evaluate. Use waitForSelector as the
  // readiness gate — it retries internally and survives client-side redirects.
  const navigateAndReady = async (): Promise<void> => {
    console.log('[actions] Opening LinkedIn feed to publish post…');
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for at least one interactive element — proves React has hydrated
    await page.waitForSelector('div[role="button"]', { state: 'visible', timeout: 15_000 });
    await checkSession(page);
  };
  await navigateAndReady();

  // Click "Start a post". LinkedIn 2026 renders this as div[role="button"], not <button>.
  // Use Playwright's locator.click() (real mouse events) rather than element.click() inside
  // evaluate — programmatic clicks can be treated differently by LinkedIn's React event handlers.
  // Wrap in try/catch: retry with re-navigation if execution context is destroyed.
  const clickStartPost = async (): Promise<string> => {
    // Try Playwright locator first (sends real pointer events, most reliable)
    const locator = page.locator('div[role="button"]').filter({ hasText: /^Start a post$/i }).first();
    const locatorCount = await locator.count().catch(() => 0);
    if (locatorCount > 0) {
      await locator.click({ timeout: 5_000 });
      return 'locator-click';
    }
    // Fallback: <button> locator
    const btnLocator = page.getByRole('button', { name: /Start a post/i }).first();
    const btnCount = await btnLocator.count().catch(() => 0);
    if (btnCount > 0) {
      await btnLocator.click({ timeout: 5_000 });
      return 'button-locator';
    }
    // Last resort: evaluate-based click (handles shadow DOM)
    return page.evaluate(() => {
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet?.shadowRoot;
      if (shadow) {
        const shadowBtns = Array.from(shadow.querySelectorAll('button, div[role="button"]'));
        const shadowStart = shadowBtns.find(b =>
          /Start a post/i.test((b as HTMLElement).textContent?.trim() ?? '') ||
          /Start a post/i.test(b.getAttribute('aria-label') ?? '')
        );
        if (shadowStart) { (shadowStart as HTMLElement).click(); return 'shadow-dom'; }
      }
      return 'not-found';
    });
  };

  let startPostClicked: string;
  try {
    startPostClicked = await clickStartPost();
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('Execution context was destroyed') || msg.includes('Target closed')) {
      console.warn('[actions] Execution context lost on first attempt — re-navigating and retrying');
      await navigateAndReady();
      startPostClicked = await clickStartPost();
    } else {
      throw err;
    }
  }

  if (startPostClicked === 'not-found') {
    const pageTitle = await page.title();
    throw new Error(`Could not find 'Start a post' button. Page title: "${pageTitle}"`);
  }
  console.log(`[actions] Start a post clicked via ${startPostClicked}`);

  // Wait for the post composer editor to actually appear — shadow DOM or regular DOM.
  // Linux/Xvfb renders slower than Mac — fixed 1500ms is insufficient.
  try {
    await page.waitForFunction(() => {
      // Primary: shadow DOM under #interop-outlet (LinkedIn SDUI)
      const outlet = document.querySelector('#interop-outlet');
      const shadow = (outlet as Element & { shadowRoot: ShadowRoot | null })?.shadowRoot;
      if (shadow?.querySelector('[contenteditable="true"]')) return true;
      // Fallback: regular DOM contenteditable (older LinkedIn layout or different session state)
      return document.querySelectorAll('[contenteditable="true"]').length > 0;
    }, { timeout: 12_000 });
    console.log('[actions] Composer editor ready');
  } catch {
    const pageTitle = await page.title();
    throw new Error(`Composer editor did not appear within 12s. Page title: "${pageTitle}"`);
  }

  // Inject text via shadow DOM (same approach as Mac poster — proven pattern)
  const safeText = JSON.stringify(postText);
  const injectResult = await page.evaluate(`
    (function() {
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet && outlet.shadowRoot;
      if (!shadow) return 'no-shadow';
      const editor = shadow.querySelector('[contenteditable="true"]');
      if (!editor) return 'no-editor';
      editor.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${safeText});
      return 'ok:' + editor.textContent.length;
    })()`
  ) as string;

  console.log(`[actions] Text injection result: ${injectResult}`);
  if (injectResult.startsWith('no-')) {
    throw new Error(`Could not inject text into composer: ${injectResult}`);
  }
  await page.waitForTimeout(800);

  // Attach images if provided
  if (imagePaths.length > 0) {
    const imgs = imagePaths.map((p, i) => {
      if (!existsSync(p)) throw new Error(`Image not found at ${p}`);
      const bytes = readFileSync(p);
      return { name: `post-image-${i + 1}.png`, base64: bytes.toString('base64'), size: bytes.length };
    });
    const totalBytes = imgs.reduce((sum, i) => sum + i.size, 0);
    console.log(`[actions] Attaching ${imgs.length} image(s) (${totalBytes} bytes total)`);

    // Click Add media button in shadow DOM
    const mediaClickResult = await page.evaluate(() => {
      const outlet = document.querySelector('#interop-outlet');
      const shadow = outlet?.shadowRoot;
      if (!shadow) return 'no-shadow';
      const buttons = Array.from(shadow.querySelectorAll('button'));
      const mediaBtn = buttons.find(b => {
        const label = (b.getAttribute('aria-label') ?? '').toLowerCase();
        return label.includes('add media') || label === 'photo' || label.includes('add a photo');
      });
      if (!mediaBtn) {
        const inventory = buttons.map(b => b.getAttribute('aria-label') || b.textContent?.trim().slice(0, 30)).filter(Boolean).join(' | ');
        return 'no-media-btn::' + inventory.slice(0, 800);
      }
      mediaBtn.click();
      return 'media-btn-clicked';
    });
    console.log(`[actions] Media button click: ${mediaClickResult}`);
    if (mediaClickResult.startsWith('no-')) {
      throw new Error(`Could not find Add Media button: ${mediaClickResult}`);
    }

    await page.waitForTimeout(1200);

    // Upload images via DataTransfer on file input
    const imgsPayload = JSON.stringify(imgs.map(i => ({ name: i.name, base64: i.base64 })));
    const uploadResult = await page.evaluate(`
      (function() {
        function findFileInput(root) {
          if (!root) return null;
          const direct = root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : [];
          if (direct.length) return direct[0];
          const children = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const el of children) {
            if (el.shadowRoot) {
              const inner = findFileInput(el.shadowRoot);
              if (inner) return inner;
            }
          }
          return null;
        }
        const outlet = document.querySelector('#interop-outlet');
        const shadow = outlet && outlet.shadowRoot;
        const input = findFileInput(shadow) || findFileInput(document);
        if (!input) return 'no-file-input';
        const items = ${imgsPayload};
        const dt = new DataTransfer();
        for (const img of items) {
          const bytes = Uint8Array.from(atob(img.base64), c => c.charCodeAt(0));
          dt.items.add(new File([bytes], img.name, { type: 'image/png' }));
        }
        Object.defineProperty(input, 'files', { value: dt.files, writable: false });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'uploaded:' + items.length;
      })()`
    ) as string;
    console.log(`[actions] Upload result: ${uploadResult}`);
    if (uploadResult.startsWith('no-')) {
      throw new Error(`File input not found: ${uploadResult}`);
    }
    await page.waitForTimeout(3000);
  }

  // Intercept LinkedIn's share-creation API response to capture the post URN.
  // LinkedIn POSTs to /voyager/api/contentcreation/normShares (or similar) when
  // the Post button is clicked; the response JSON contains the share URN.
  let capturedUrn: string | undefined;
  const urnListener = async (response: import('playwright').Response) => {
    if (capturedUrn) return;
    try {
      const url = response.url();
      if (!url.includes('linkedin.com')) return;
      if (response.status() < 200 || response.status() >= 300) return;
      // Scan ALL LinkedIn API responses (not just known endpoints) for the share URN.
      // We log the URL when we find a URN so we can narrow the filter later.
      const body = await response.text().catch(() => '');
      const match = body.match(/urn:li:share:\d+/);
      if (match) {
        capturedUrn = match[0];
        console.log(`[actions] Captured share URN from network: ${capturedUrn} (endpoint: ${url.split('?')[0]})`);
      }
    } catch { /* non-fatal */ }
  };
  page.on('response', urnListener);

  // Click Post button in shadow DOM
  const postClicked = await page.evaluate(() => {
    const outlet = document.querySelector('#interop-outlet');
    const shadow = outlet?.shadowRoot;
    if (shadow) {
      const btns = Array.from(shadow.querySelectorAll('button'));
      const postBtn = btns.find(b => /^Post$/.test(b.textContent?.trim() ?? ''));
      if (postBtn) { postBtn.click(); return 'shadow-post'; }
    }
    // Fallback: light DOM
    const lightBtn = Array.from(document.querySelectorAll('button')).find(b => /^Post$/.test(b.textContent?.trim() ?? ''));
    if (lightBtn) { lightBtn.click(); return 'light-post'; }
    return 'no-post-btn';
  });
  if (postClicked === 'no-post-btn') {
    throw new Error("Could not find 'Post' button in composer.");
  }
  console.log(`[actions] Post submitted via ${postClicked}`);

  // Give LinkedIn time to complete the API call and return the URN
  await page.waitForTimeout(6000);
  page.off('response', urnListener);

  // Build permalink from URN if captured
  const linkedin_post_id = capturedUrn
    ? `https://www.linkedin.com/feed/update/${capturedUrn}`
    : undefined;

  if (linkedin_post_id) {
    console.log(`[actions] Permalink: ${linkedin_post_id}`);
  } else {
    console.warn('[actions] Share URN not captured from network — post published but permalink unknown');
  }

  return { success: true, ...(linkedin_post_id ? { linkedin_post_id } : {}) };
}

// ---------------------------------------------------------------------------
// discoverLinkedInPosts
// ---------------------------------------------------------------------------

/**
 * Discover LinkedIn posts for the given keywords.
 *
 * Requires headed browser mode (DISPLAY env var set, Xvfb running). LinkedIn's
 * SDUI does not render feed content in headless Chrome, so DOM extraction only
 * works when the browser is visible to an X11 display.
 *
 * Flow:
 *  1. For hashtag keywords (#revops), navigate the hashtag feed — it carries
 *     more person posts with interceptable activity URNs than content search.
 *  2. For plain keywords, use LinkedIn content search sorted by recency.
 *  3. Intercept XHR/fetch responses to capture activity URNs before DOM scrape.
 *  4. Scroll aggressively (10 passes) to trigger lazy-loaded XHR calls.
 *  5. Enrich DOM-extracted posts with orphan URNs that have no matching card.
 *  6. Accept both person (/in/) and company (/company/) authors — target is
 *     8-12 combined posts per batch; downstream engagement engine decides who
 *     to engage with.
 */
export async function discoverLinkedInPosts(
  page: Page,
  keywords: string[],
  limit: number = 15,
): Promise<DiscoveredPost[]> {
  const all: DiscoveredPost[] = [];
  const seenUrn = new Set<string>();
  const headed = !!process.env['DISPLAY'];
  console.log(`[discover] Mode: ${headed ? 'headed (Xvfb)' : 'headless'}`);

  for (const keyword of keywords.slice(0, 8)) {
    if (all.length >= limit) break;

    // Hashtag feed (#revops) renders a live post feed with more person posts
    // and better activity URN coverage than keyword content search.
    const isHashtag = keyword.startsWith('#');
    const hashtagSlug = isHashtag ? keyword.slice(1).toLowerCase().replace(/\s+/g, '') : '';
    const searchUrl = isHashtag
      ? `https://www.linkedin.com/feed/hashtag/${hashtagSlug}/`
      : `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&sortBy=date_posted`;
    console.log(`[discover] Searching: "${keyword}" → ${isHashtag ? 'hashtag feed' : 'content search'}`);

    // Intercept XHR/fetch responses to capture activity URNs before DOM scrape.
    // LinkedIn's voyager API returns these in JSON; capturing them gives us real
    // /feed/update/ permalinks even when the DOM card omits an anchor link.
    const capturedUrns = new Map<string, string>(); // urn → placeholder
    const responseHandler = async (response: import('playwright').Response) => {
      const responseUrl = response.url();
      if (!responseUrl.includes('linkedin.com')) return;
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json') && !ct.includes('javascript')) return;
      try {
        const text = await response.text().catch(() => '');
        const urnMatches = text.matchAll(/urn:li:activity:(\d{10,})/g);
        for (const m of urnMatches) {
          const urn = `urn:li:activity:${m[1]}`;
          if (!capturedUrns.has(urn)) capturedUrns.set(urn, '');
        }
      } catch { /* ignore */ }
    };
    page.on('response', responseHandler);

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await checkSession(page);

      // Give SDUI time to render the initial post cards
      await page.waitForTimeout(4000);

      // Scroll aggressively to trigger lazy-loaded XHR calls that carry activity URNs.
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 600));
        await page.waitForTimeout(1200);
      }
      // Pause to let final batch of XHR responses arrive
      await page.waitForTimeout(2000);

      // Extract post cards from DOM.
      // LinkedIn renders "Feed post" heading (H2) as the first text in each post card.
      // We find the smallest div whose text starts with "Feed post" to isolate each card,
      // then extract author, URL, and post body from its children.
      type RawExtracted = {
        url: string;
        authorName: string;
        authorUrl: string | null;
        text: string;
      };
      const extracted: RawExtracted[] = await page.evaluate(() => {
        const results: RawExtracted[] = [];
        const seenUrls = new Set<string>();

        // Find post card containers: divs whose text starts with "Feed post" where
        // the parent div does NOT also start with "Feed post" (gives us the card root).
        const allDivs = Array.from(document.querySelectorAll('div'));
        const feedCards = allDivs.filter(el => {
          const text = el.textContent?.trim() ?? '';
          if (!text.startsWith('Feed post')) return false;
          const parentText = el.parentElement?.textContent?.trim() ?? '';
          return !parentText.startsWith('Feed post');
        });

        for (const el of feedCards.slice(0, 20)) {
          // Post URL: try anchor links first, then data-urn on card elements.
          // LinkedIn SDUI uses /feed/update/urn:li:activity:XXX/ for timestamps and
          // /posts/slug/ for public permalinks. Newer SDUI builds may omit anchor links
          // from search cards, so check data-urn attributes as a fallback.
          const updateLink = (
            el.querySelector('a[href*="/feed/update/"]') ??
            el.querySelector('a[href*="/posts/"]') ??
            Array.from(el.querySelectorAll('a[href]')).find(
              (a) => /linkedin\.com\/(feed\/update|posts)\//i.test((a as HTMLAnchorElement).href)
            )
          ) as HTMLAnchorElement | null;
          let url = updateLink?.href?.split('?')[0] ?? '';
          if (!url) {
            const urnEl = el.querySelector('[data-urn]') ??
              el.closest('[data-urn]') ??
              (el.getAttribute('data-urn') ? el : null);
            const urn = urnEl?.getAttribute('data-urn') ?? '';
            if (/urn:li:activity:/.test(urn)) {
              url = `https://www.linkedin.com/feed/update/${urn}/`;
            }
          }

          // Author: first /in/ or /company/ link in the card
          const authorLink = el.querySelector('a[href*="/in/"], a[href*="/company/"]') as HTMLAnchorElement | null;
          const authorUrl = authorLink?.href?.split('?')[0] ?? null;

          // Author name: first short paragraph (name, not job title, not degree marker)
          const allPs = Array.from(el.querySelectorAll('p'));
          const nameP = allPs.find(p => {
            const t = p.textContent?.trim() ?? '';
            return t.length >= 2 && t.length <= 80 && !t.startsWith('•') && !/^\d/.test(t) && !/^Follow$/.test(t);
          });
          const authorName = nameP?.textContent?.trim() ?? '';

          // Post text: find the Follow button, then take the first long paragraph after it.
          // Fallback: longest paragraph > 60 chars that isn't author name or job title.
          const followBtn = Array.from(el.querySelectorAll('button')).find(b =>
            /^Follow$/i.test(b.textContent?.trim() ?? '')
          );
          let postText = '';
          if (followBtn) {
            const psAfter = allPs.filter(p =>
              followBtn.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING
            );
            postText = psAfter
              .map(p => p.textContent?.trim() ?? '')
              .filter(t => t.length > 60 && t !== authorName && !/^\d+[mhdw]/.test(t))
              .sort((a, b) => b.length - a.length)[0] ?? '';
          }
          if (!postText) {
            postText = allPs
              .map(p => p.textContent?.trim() ?? '')
              .filter(t => t.length > 80 && t !== authorName && !/^\d+[mhdw]/.test(t) && !t.startsWith('•'))
              .sort((a, b) => b.length - a.length)[0] ?? '';
          }

          if (authorName.length >= 2 && postText.length > 0) {
            const key = url || authorName + postText.substring(0, 20);
            if (seenUrls.has(key)) continue;
            seenUrls.add(key);
            results.push({ url, authorName, authorUrl, text: postText.substring(0, 500) });
          }
        }

        return results;
      });

      page.off('response', responseHandler);

      // Assign network-captured URNs to posts that lack real /feed/update/ permalinks.
      // Company feed pages (/company/*/posts/) are not specific-post links —
      // treat them the same as missing URLs and prefer a captured URN.
      const isSpecificPostUrl = (u: string) => /\/feed\/update\//i.test(u);
      const orphanUrns = [...capturedUrns.keys()].filter(
        urn => !extracted.some(p => isSpecificPostUrl(p.url) && p.url.includes(urn))
      );
      let urnIdx = 0;
      const enriched = extracted.map(p => {
        if (isSpecificPostUrl(p.url)) return p;
        if (urnIdx < orphanUrns.length) {
          return { ...p, url: `https://www.linkedin.com/feed/update/${orphanUrns[urnIdx++]}/` };
        }
        return p;
      });

      // Accept both person (/in/) and company (/company/) authors — target is 8-12
      // combined posts per batch. The engagement engine handles author-level filtering.
      const withUrls = enriched.filter(p => isSpecificPostUrl(p.url));
      console.log(
        `[discover] "${keyword}": ${extracted.length} DOM posts, ${capturedUrns.size} network URNs → ` +
        `${withUrls.length} with real permalinks (${enriched.length - withUrls.length} dropped, no URL)`
      );

      // Topic relevance gate: drop posts that are off-topic for RevOps/GTM/sales leadership.
      const OFF_TOPIC_SIGNALS = [
        /#interviewquestions/i, /#interview\b/i,
        /\bjava\b/i, /\bpython\b/i, /\breact\.?js\b/i, /\bnode\.?js\b/i,
        /\bangular\b/i, /\bvue\.?js\b/i, /\bdotnet\b/i, /\bc#\b/i, /\bc\+\+/i,
        /#coding\b/i, /#developer\b/i, /#programmer\b/i, /#softwaredevelopment\b/i,
        /#machinelearning\b/i, /#deeplearning\b/i, /#datascience\b/i, /#mlops\b/i,
        /\bcloud engineer\b/i, /\bazure\b.*\bengineer\b/i,
        /\bw2\s+only\b/i, /\bc2c\b/i, /\bhot(list|beds?)\b/i,
        /immediate\s+opening/i, /\bstaffing\b/i, /\brecruiter\b/i, /\bplacement\b/i,
        /graduation\b/i, /\bcongratulations?\b.*\bgraduate/i, /\bcolleg(e|iate)\b.*\bgrad/i,
        /\bremote.{0,20}usd\b/i, /remote jobs?.*\/hour/i,
        /get me on your next podcast/i,
      ];

      for (const p of withUrls) {
        if (all.length >= limit) break;
        const key = p.url;
        if (seenUrn.has(key)) continue;
        const combined = `${p.authorName} ${p.text}`;
        if (OFF_TOPIC_SIGNALS.some(sig => sig.test(combined))) {
          console.log(`[discover] SKIP off-topic: ${p.authorName}: ${p.text.slice(0, 60)}`);
          continue;
        }
        seenUrn.add(key);
        all.push({
          url: p.url,
          authorName: p.authorName,
          authorUrl: p.authorUrl,
          text: p.text,
          // Strip '#' so hashtag keywords match sender topic_keywords
          keyword: keyword.startsWith('#') ? keyword.slice(1) : keyword,
        });
      }
    } catch (err) {
      page.off('response', responseHandler);
      console.error(`[discover] Error for "${keyword}": ${(err as Error).message}`);
    }
  }

  console.log(`[discover] Total: ${all.length} posts discovered`);
  return all;
}
