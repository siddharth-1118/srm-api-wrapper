import { chromium, Browser, BrowserContext, Page } from 'playwright';

let browser: Browser | null = null;

async function getBrowserInstance(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    console.log("Launching new shared Playwright Chromium instance...");
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return browser;
}

export async function createBrowserSession(): Promise<{ context: BrowserContext; page: Page }> {
  const browserInstance = await getBrowserInstance();
  
  const context = await browserInstance.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  
  const page = await context.newPage();

  // Hide automation footprint to bypass telemetry bot blocking
  await page.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
  
  // Set default timeouts to prevent long hanging requests on portal issues
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(20000);

  return { context, page };
}

export async function closeGlobalBrowser(): Promise<void> {
  if (browser) {
    console.log("Closing shared Playwright Chromium instance...");
    await browser.close().catch(() => {});
    browser = null;
  }
}
