import { Page } from 'playwright';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

// Debug output directory - local development only
const DEBUG_DIR = path.join(__dirname, '..', '..', 'debug');

function ensureDebugDir() {
  if (!fs.existsSync(DEBUG_DIR)) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  }
}

// -----------------------------------------------------------------------
// PHASE 1: Discover the authenticated session state
// -----------------------------------------------------------------------
export async function discoverAuthenticatedSession(page: Page): Promise<{
  currentUrl: string;
  title: string;
  links: { text: string; href: string }[];
  frames: string[];
  iframes: string[];
}> {
  const currentUrl = page.url();
  const title = await page.title().catch(() => '');
  const html = await page.content();
  const $ = cheerio.load(html);

  const links: { text: string; href: string }[] = [];
  $('a[href]').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    const href = $(el).attr('href') || '';
    if (text && href && !href.startsWith('#') && !href.startsWith('javascript:void')) {
      links.push({ text, href });
    }
  });

  const frames = page.frames().map(f => f.url());
  const iframes: string[] = [];
  $('iframe').each((_, el) => {
    iframes.push($(el).attr('src') || '');
  });

  console.log(`[SRM DASHBOARD] Authenticated: true`);
  console.log(`[SRM DASHBOARD] Current URL: ${currentUrl}`);
  console.log(`[SRM DASHBOARD] Title: ${title}`);
  console.log(`[SRM DASHBOARD] Links found: ${links.length}`);
  links.forEach(l => console.log(`[SRM DASHBOARD]   → ${l.text}: ${l.href}`));
  console.log(`[SRM DASHBOARD] Frames found: ${frames.length}`);
  frames.forEach(f => console.log(`[SRM DASHBOARD]   frame: ${f}`));
  console.log(`[SRM DASHBOARD] iFrames found: ${iframes.length}`);

  return { currentUrl, title, links, frames, iframes };
}

// -----------------------------------------------------------------------
// PHASE 2: Save debug HTML and screenshot
// -----------------------------------------------------------------------
export async function saveDebugSnapshot(page: Page, name: string): Promise<void> {
  try {
    ensureDebugDir();
    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, `${name}.html`), html, 'utf8');
    await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage: true });
    console.log(`[SRM DEBUG] Saved snapshot: debug/${name}.html + debug/${name}.png`);
  } catch (err) {
    console.error(`[SRM DEBUG] Failed to save snapshot for ${name}:`, err);
  }
}

// -----------------------------------------------------------------------
// PHASE 3: Navigate to a page using the authenticated context.
//          Discovers the real URL from on-page links if direct navigation fails.
// -----------------------------------------------------------------------
export async function navigateTo(
  page: Page,
  linkTextPatterns: string[],
  fallbackUrl?: string
): Promise<{ html: string; url: string } | null> {
  const html = await page.content();
  const $ = cheerio.load(html);

  // Find a matching link by text pattern
  let foundHref: string | null = null;
  for (const pattern of linkTextPatterns) {
    const regex = new RegExp(pattern, 'i');
    $('a').each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (regex.test(text) && href && !href.startsWith('javascript:void')) {
        foundHref = href;
        return false; // break
      }
    });
    if (foundHref) break;
  }

  const targetUrl = foundHref
    ? ((foundHref as string).startsWith('http') ? foundHref : `https://sp.srmist.edu.in${foundHref}`)
    : fallbackUrl || null;

  if (!targetUrl) {
    console.log(`[SRM NAV] Could not find link for patterns: ${linkTextPatterns.join(', ')}`);
    return null;
  }

  try {
    console.log(`[SRM NAV] Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 20000 });

    const finalUrl = page.url();
    // Session expired check
    if (finalUrl.includes('youLogin.jsp')) {
      console.log(`[SRM NAV] Portal redirected to login! Session may have expired.`);
      throw new Error('SRM_SESSION_EXPIRED');
    }

    const pageHtml = await page.content();
    console.log(`[SRM NAV] Final URL: ${finalUrl}, HTML length: ${pageHtml.length}`);
    return { html: pageHtml, url: finalUrl };
  } catch (err: any) {
    if (err.message === 'SRM_SESSION_EXPIRED') throw err;
    console.error(`[SRM NAV] Navigation failed to ${targetUrl}:`, err.message);
    return null;
  }
}

// -----------------------------------------------------------------------
// PHASE 4: Generic table extractor — works on any table
// -----------------------------------------------------------------------
export function extractAllTables($: cheerio.CheerioAPI): Array<{
  headers: string[];
  rows: Record<string, string>[];
}> {
  const tables: Array<{ headers: string[]; rows: Record<string, string>[] }> = [];

  $('table').each((_, tableEl) => {
    const headers: string[] = [];
    const rows: Record<string, string>[] = [];

    // Get headers from thead or first tr
    const headerRow = $(tableEl).find('thead tr').first();
    if (headerRow.length) {
      headerRow.find('th, td').each((_, th) => {
        headers.push($(th).text().trim().replace(/\s+/g, ' '));
      });
    } else {
      // Use first row as headers
      $(tableEl).find('tr').first().find('th, td').each((_, th) => {
        headers.push($(th).text().trim().replace(/\s+/g, ' '));
      });
    }

    // Get data rows
    $(tableEl).find('tbody tr, tr').each((rowIdx, rowEl) => {
      if (rowIdx === 0 && !$(tableEl).find('thead').length) return; // skip header row
      const cells = $(rowEl).find('td');
      if (cells.length === 0) return;
      const row: Record<string, string> = {};
      cells.each((cellIdx, cellEl) => {
        const key = headers[cellIdx] || `col_${cellIdx}`;
        row[key] = $(cellEl).text().trim().replace(/\s+/g, ' ');
      });
      if (Object.values(row).some(v => v.length > 0)) {
        rows.push(row);
      }
    });

    if (headers.length > 0 || rows.length > 0) {
      tables.push({ headers, rows });
    }
  });

  return tables;
}

// -----------------------------------------------------------------------
// PHASE 5: Extract label-value pairs (e.g. Profile page)
// -----------------------------------------------------------------------
export function extractLabelValuePairs($: cheerio.CheerioAPI): Record<string, string> {
  const data: Record<string, string> = {};

  // Pattern 1: dt/dd pairs
  $('dl').each((_, dl) => {
    const dts = $(dl).find('dt');
    const dds = $(dl).find('dd');
    dts.each((i, dt) => {
      const label = $(dt).text().trim().replace(/\s+/g, ' ').replace(/:$/, '');
      const value = $(dds.eq(i)).text().trim().replace(/\s+/g, ' ');
      if (label) data[label] = value;
    });
  });

  // Pattern 2: label + adjacent span/input/div
  $('label').each((_, labelEl) => {
    const labelText = $(labelEl).text().trim().replace(/\s+/g, ' ').replace(/:$/, '');
    if (!labelText) return;
    const forAttr = $(labelEl).attr('for');
    let value = '';
    if (forAttr) {
      value = $(`#${forAttr}`).val() as string || $(`#${forAttr}`).text().trim();
    }
    if (!value) {
      value = $(labelEl).next().text().trim().replace(/\s+/g, ' ');
    }
    if (labelText && value) data[labelText] = value;
  });

  // Pattern 3: td:contains label + next td value
  $('tr').each((_, trEl) => {
    const tds = $(trEl).find('td');
    if (tds.length >= 2) {
      const label = tds.eq(0).text().trim().replace(/\s+/g, ' ').replace(/:$/, '');
      const value = tds.eq(1).text().trim().replace(/\s+/g, ' ');
      if (label && value && label.length < 60) {
        data[label] = value;
      }
    }
  });

  // Pattern 4: div with class containing 'label'/'value', 'key'/'val' etc
  $('[class*="label"], [class*="key"], [class*="title"]').each((_, el) => {
    const label = $(el).text().trim().replace(/\s+/g, ' ').replace(/:$/, '');
    const value = $(el).next('[class*="value"], [class*="val"], [class*="data"]').text().trim().replace(/\s+/g, ' ');
    if (label && value && label.length < 60) {
      data[label] = value;
    }
  });

  return data;
}

// -----------------------------------------------------------------------
// PHASE 6: Wait for content and get HTML, with iframe fallback
// -----------------------------------------------------------------------
export async function getPageHtmlWithFrameFallback(page: Page): Promise<string> {
  // Check if there are meaningful iframes
  const frames = page.frames();
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    try {
      const frameHtml = await frame.content();
      const $ = cheerio.load(frameHtml);
      // If the iframe has tables or meaningful content, use it
      if ($('table').length > 0 || $('form').length > 0) {
        console.log(`[SRM FRAME] Found content in iframe: ${frame.url()}, length: ${frameHtml.length}`);
        return frameHtml;
      }
    } catch (e) {
      // iframe cross-origin or not accessible
    }
  }
  return page.content();
}
