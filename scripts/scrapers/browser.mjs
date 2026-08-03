import { existsSync } from "node:fs";

let browserPromise;

async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  const configured = process.env.PLAYWRIGHT_CHROME_PATH;
  const candidates = [
    configured,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);

  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (channelError) {
    const executablePath = candidates.find((candidate) => existsSync(candidate));
    if (!executablePath) throw channelError;
    return chromium.launch({ executablePath, headless: true });
  }
}

async function getBrowser() {
  browserPromise ||= launchBrowser();
  return browserPromise;
}

export async function withBrowserPage(callback) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      process.env.TYSONS_SCRAPER_USER_AGENT ||
      "TysonsTimesResearchBot/0.1 (+https://tysonstimes.org/; research collection)",
    locale: "en-US",
  });
  const page = await context.newPage();
  try {
    return await callback(page);
  } finally {
    await context.close();
  }
}

export async function renderHtml(url, options = {}) {
  return withBrowserPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs || 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    if (options.waitFor) {
      await page.locator(options.waitFor).first().waitFor({ timeout: 12_000 }).catch(() => {});
    }
    return {
      html: await page.content(),
      url: page.url(),
      title: await page.title(),
    };
  });
}

export async function renderedPdfLinks(url, year) {
  return withBrowserPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    let links = await page.locator('a[href*="/files/"][href$=".pdf"], a[href*="/files/"][href*=".pdf?"]').evaluateAll(
      (anchors) =>
        anchors.map((anchor) => ({
          url: anchor.href,
          title: (anchor.textContent || "").trim(),
          context: (anchor.closest("li, article, .document, .file, .folder")?.textContent || "").trim(),
        })),
    );

    if (!links.length && year) {
      const yearControl = page.getByText(String(year), { exact: true }).first();
      if (await yearControl.count()) {
        await yearControl.click().catch(() => {});
        await page.waitForTimeout(1_500);
        links = await page.locator('a[href*="/files/"][href*=".pdf"]').evaluateAll((anchors) =>
          anchors.map((anchor) => ({
            url: anchor.href,
            title: (anchor.textContent || "").trim(),
            context: (anchor.closest("li, article, .document, .file, .folder")?.textContent || "").trim(),
          })),
        );
      }
    }
    return links;
  });
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise;
  await browser.close();
  browserPromise = null;
}
