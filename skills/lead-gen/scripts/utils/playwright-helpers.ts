import { chromium, Browser, Page, BrowserContext } from 'playwright';

let browser: Browser | null = null;
let context: BrowserContext | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function getContext(): Promise<BrowserContext> {
  if (!context) {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
  }
  return context;
}

export async function newPage(): Promise<Page> {
  const ctx = await getContext();
  return ctx.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (context) { await context.close(); context = null; }
  if (browser) { await browser.close(); browser = null; }
}

export async function safeGoto(page: Page, url: string, timeout = 30000): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    return true;
  } catch (error) {
    console.error(`Failed to load ${url}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

export async function extractText(page: Page, selector: string): Promise<string | null> {
  try {
    const element = await page.$(selector);
    if (element) return await element.textContent();
    return null;
  } catch { return null; }
}

export async function extractAllText(page: Page, selector: string): Promise<string[]> {
  try {
    const elements = await page.$$(selector);
    const texts: string[] = [];
    for (const el of elements) {
      const text = await el.textContent();
      if (text) texts.push(text.trim());
    }
    return texts;
  } catch { return []; }
}

export async function extractLinks(page: Page, selector: string = 'a'): Promise<{ href: string; text: string }[]> {
  try {
    return await page.evaluate(`(() => {
      const anchors = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      return anchors.map(a => ({ href: a.getAttribute('href') || '', text: (a.textContent || '').trim() })).filter(link => link.href);
    })()`);
  } catch { return []; }
}

export async function waitForContent(page: Page, timeout = 5000): Promise<void> {
  try { await page.waitForLoadState('networkidle', { timeout }); } catch { }
}

export async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    var distance = 300;
    while (document.scrollingElement) {
      var scrollHeight = document.scrollingElement.scrollHeight;
      var clientHeight = document.scrollingElement.clientHeight;
      var scrollTop = document.scrollingElement.scrollTop;
      if (scrollTop + clientHeight >= scrollHeight - 10) break;
      document.scrollingElement.scrollBy(0, distance);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })()`);
}

export async function getPageContent(page: Page): Promise<string> {
  return await page.content();
}

export async function getPageText(page: Page): Promise<string> {
  return await page.evaluate(`document.body.innerText`);
}
