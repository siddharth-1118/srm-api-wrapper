import { Page } from 'playwright';
import * as cheerio from 'cheerio';
import {
  discoverAuthenticatedSession,
  saveDebugSnapshot,
  navigateTo,
  extractAllTables,
  extractLabelValuePairs,
  getPageHtmlWithFrameFallback,
} from './srmDiscovery';
import { parseAttendance } from '../parsers/attendanceParser';
import { parseGradePage } from '../parsers/gradeParser';
import { parseHostelPage } from '../parsers/hostelParser';
import { parseHostelBookingPage } from '../parsers/hostelBookingParser';
import { parseHostelDetailsPage, validateHostelDetailsPage } from '../parsers/hostelDetailsParser';
import { parseHostelWillingnessPage } from '../parsers/hostelWillingnessParser';

// -----------------------------------------------------------------------
// HELPER: Return to the main dashboard (portal home after login)
// -----------------------------------------------------------------------
const DASHBOARD_URL = 'https://sp.srmist.edu.in/srmiststudentportal/students/loginManager/youLogin.jsp';
const HOME_PATTERNS = ['Dashboard', 'Home', 'Student Home', 'Student Portal'];

async function returnToDashboard(page: Page): Promise<void> {
  const current = page.url();
  if (current.includes('youLogin.jsp')) throw new Error('SRM_SESSION_EXPIRED');
  // Just navigate to root portal
  const portalBase = 'https://sp.srmist.edu.in/srmiststudentportal/';
  if (!current.startsWith('https://sp.srmist.edu.in')) {
    await page.goto(portalBase, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  }
}

// -----------------------------------------------------------------------
// PHASE 1 + 2: Dashboard discovery & debug snapshot
// -----------------------------------------------------------------------
export async function extractDashboardData(page: Page) {
  console.log(`[SRM DASHBOARD] Starting dashboard extraction...`);

  // Verify session is alive
  const currentUrl = page.url();
  if (currentUrl.includes('youLogin.jsp')) {
    throw Object.assign(new Error('SESSION_EXPIRED'), { code: 'SRM_SESSION_EXPIRED' });
  }

  // Discover the session state
  const discovery = await discoverAuthenticatedSession(page);
  await saveDebugSnapshot(page, 'dashboard');

  // Extract raw page data
  const html = await getPageHtmlWithFrameFallback(page);
  const $ = cheerio.load(html);

  const tables = extractAllTables($);
  const labelValues = extractLabelValuePairs($);

  console.log(`[DASHBOARD PARSER] URL: ${discovery.currentUrl}`);
  console.log(`[DASHBOARD PARSER] HTML length: ${html.length}`);
  console.log(`[DASHBOARD PARSER] Tables found: ${tables.length}`);
  console.log(`[DASHBOARD PARSER] Label-value pairs found: ${Object.keys(labelValues).length}`);

  // Try to find student name from various locations
  let studentName = '';
  const nameSelectors = [
    '.student-name', '#studentName', '[class*="student"]', 
    'h1', 'h2', 'h3', '.welcome',
  ];
  for (const sel of nameSelectors) {
    const text = $(sel).first().text().trim().replace(/\s+/g, ' ');
    if (text && text.length < 80 && text.length > 2) {
      studentName = text;
      break;
    }
  }

  // Find any announcements/notices
  const announcements: string[] = [];
  $('[class*="notice"], [class*="announcement"], [class*="alert"]:not(.alert-danger)').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text.length > 5 && text.length < 500) announcements.push(text);
  });

  return {
    currentUrl: discovery.currentUrl,
    pageTitle: discovery.title,
    studentName,
    links: discovery.links,
    tables: tables.slice(0, 5), // Return first 5 tables for exploration
    labelValues,
    announcements,
    rawSummary: {
      tablesFound: tables.length,
      labelsFound: Object.keys(labelValues).length,
      linksFound: discovery.links.length,
      framesFound: discovery.frames.length,
    }
  };
}

// -----------------------------------------------------------------------
// PHASE 4: Profile extraction — discover real URL from navigation
// -----------------------------------------------------------------------
export async function extractProfileData(page: Page) {
  console.log(`[PROFILE PARSER] Starting profile extraction...`);

  await returnToDashboard(page).catch(() => {});

  // Try to navigate to personal details via on-page links
  const result = await navigateTo(page,
    ['Personal Details', 'Personal Info', 'Student Details', 'My Profile', 'Profile'],
    undefined
  );

  let html = '';
  let url = page.url();

  if (result) {
    html = result.html;
    url = result.url;
    await saveDebugSnapshot(page, 'profile');
  } else {
    // Couldn't find profile link — use current page
    console.log(`[PROFILE PARSER] No profile link found, using current page`);
    html = await getPageHtmlWithFrameFallback(page);
    await saveDebugSnapshot(page, 'profile-current');
  }

  const $ = cheerio.load(html);
  const tables = extractAllTables($);
  const labelValues = extractLabelValuePairs($);

  console.log(`[PROFILE PARSER] URL: ${url}`);
  console.log(`[PROFILE PARSER] HTML length: ${html.length}`);
  console.log(`[PROFILE PARSER] Tables found: ${tables.length}`);
  console.log(`[PROFILE PARSER] Label-value pairs found: ${Object.keys(labelValues).length}`);

  if (Object.keys(labelValues).length === 0 && tables.length === 0) {
    throw Object.assign(new Error('PARSER_NO_DATA'), {
      code: 'PARSER_NO_DATA',
      details: `Profile page loaded (${html.length} bytes) but no structured data found. URL: ${url}`
    });
  }

  // Try to map common field name variants to normalized keys
  const fieldMap: Record<string, string[]> = {
    name: ['Student Name', 'Name', 'Full Name', 'STUDENT NAME'],
    studentId: ['Student Id', 'Student ID', 'ID', 'USER ID', 'NetID', 'Net ID'],
    registerNumber: ['Register Number', 'Reg No', 'Registration No', 'Reg Number', 'Register No'],
    email: ['Email', 'Email Id', 'Email ID', 'E-mail'],
    program: ['Program', 'Programme', 'Course', 'Degree'],
    department: ['Department', 'Dept', 'Branch'],
    semester: ['Semester', 'Sem', 'Current Semester'],
    batch: ['Batch', 'Year', 'Joining Year'],
    section: ['Section', 'Group'],
    campus: ['Campus', 'Campus Name'],
    institution: ['Institution', 'College', 'University'],
    facultyAdvisor: ['Faculty Advisor', 'Faculty Adviser', 'Advisor', 'Mentor'],
  };

  const profile: Record<string, string | null> = {};

  for (const [normalized, variants] of Object.entries(fieldMap)) {
    let found: string | null = null;
    for (const variant of variants) {
      // Case-insensitive search through label-value pairs
      const match = Object.entries(labelValues).find(([k]) =>
        k.toLowerCase().includes(variant.toLowerCase())
      );
      if (match) {
        found = match[1];
        break;
      }
    }
    profile[normalized] = found;
  }

  // Also surface all raw label-value pairs for discovery
  console.log(`[PROFILE PARSER] Profile fields found: ${Object.values(profile).filter(Boolean).length}`);
  console.log(`[PROFILE PARSER] All label-values:`, labelValues);

  return {
    ...profile,
    _rawLabelValues: labelValues,
    _tables: tables,
    _url: url,
  };
}

// -----------------------------------------------------------------------
// PHASE 6: Attendance extraction — click sidebar item, handle iframes, parse
// -----------------------------------------------------------------------
export async function extractAttendanceData(page: Page) {
  console.log(`[ATTENDANCE] Starting attendance extraction...`);
  console.log(`[ATTENDANCE] Current URL: ${page.url()}`);

  if (page.url().includes('youLogin.jsp')) {
    throw Object.assign(new Error('SRM_SESSION_EXPIRED'), { code: 'SRM_SESSION_EXPIRED' });
  }

  // ── Step 1: Find and click "Attendance Details" in the SRM sidebar ─────
  const CLICK_PATTERNS = [
    'Attendance Details',
    'Attendance',
    'Course Attendance',
    'My Attendance',
  ];

  let clicked = false;
  let linkText = '';
  let linkHref = '';
  let linkOnclick = '';

  for (const pattern of CLICK_PATTERNS) {
    try {
      // Prefer <a> with matching text (covers both href and onclick links)
      const locator = page.locator(`a`).filter({ hasText: pattern }).first();
      const isVis = await locator.isVisible({ timeout: 3000 }).catch(() => false);
      if (!isVis) {
        // Also check non-anchor clickable elements
        const btn = page.locator(`[role="button"], button, li, span`).filter({ hasText: pattern }).first();
        const btnVis = await btn.isVisible({ timeout: 2000 }).catch(() => false);
        if (!btnVis) continue;
      }

      linkText    = pattern;
      linkHref    = await locator.getAttribute('href').catch(() => '') ?? '';
      linkOnclick = await locator.getAttribute('onclick').catch(() => '') ?? '';

      console.log(`[ATTENDANCE DISCOVERY] Link text: ${linkText}`);
      console.log(`[ATTENDANCE DISCOVERY] href: ${linkHref || '(none)'}`);
      console.log(`[ATTENDANCE DISCOVERY] onclick: ${linkOnclick || '(none)'}`);

      // Click and wait for navigation / network settle
      const navPromise = page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await locator.click({ timeout: 5000 }).catch(async () => {
        // Fallback: try direct navigation if href is present
        if (linkHref && !linkHref.startsWith('javascript')) {
          const fullHref = linkHref.startsWith('http')
            ? linkHref
            : `https://sp.srmist.edu.in${linkHref}`;
          await page.goto(fullHref, { waitUntil: 'networkidle', timeout: 15000 });
        }
      });
      await navPromise;

      clicked = true;
      console.log(`[ATTENDANCE DISCOVERY] Navigation: true`);
      console.log(`[ATTENDANCE DISCOVERY] Final URL: ${page.url()}`);
      break;
    } catch (e: any) {
      console.log(`[ATTENDANCE] Could not click "${pattern}": ${e?.message}`);
    }
  }

  // Fallback: use navigateTo (href scan) if click failed
  if (!clicked) {
    console.log(`[ATTENDANCE] Click approach failed, falling back to link-href navigation...`);
    const result = await navigateTo(page, CLICK_PATTERNS, undefined);
    if (result) {
      clicked = true;
      console.log(`[ATTENDANCE DISCOVERY] Navigation: true (href fallback)`);
      console.log(`[ATTENDANCE DISCOVERY] Final URL: ${page.url()}`);
    }
  }

  if (!clicked) {
    throw Object.assign(new Error('SRM_NAVIGATION_FAILED'), {
      code: 'SRM_NAVIGATION_FAILED',
      details: 'Could not find or click "Attendance Details" in the SRM dashboard sidebar. Check backend/debug/dashboard.html for the actual navigation links.'
    });
  }

  // Session expiry check after navigation
  if (page.url().includes('youLogin.jsp')) {
    throw Object.assign(new Error('SRM_SESSION_EXPIRED'), { code: 'SRM_SESSION_EXPIRED' });
  }

  // ── Step 2: Wait for content to settle ────────────────────────────────
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // ── Step 3: Log page state ────────────────────────────────────────────
  const finalUrl   = page.url();
  const pageTitle  = await page.title().catch(() => '');
  const frames     = page.frames();

  console.log(`[ATTENDANCE PAGE] Current URL: ${finalUrl}`);
  console.log(`[ATTENDANCE PAGE] Page title: ${pageTitle}`);
  console.log(`[ATTENDANCE PAGE] Frames: ${frames.length}`);
  frames.forEach(f => {
    if (f !== page.mainFrame()) {
      console.log(`[ATTENDANCE PAGE]   iframe: ${f.url()}`);
    }
  });

  // ── Step 4: Save debug snapshot ───────────────────────────────────────
  await saveDebugSnapshot(page, 'attendance');

  // ── Step 5: Get HTML — main page first, then iframes ─────────────────
  const mainHtml = await page.content();
  console.log(`[ATTENDANCE PAGE] HTML length (main): ${mainHtml.length}`);

  // Try to parse the main page
  let parsed = parseAttendance(mainHtml);
  console.log(`[ATTENDANCE PAGE] Tables found: ${parsed._tablesFound}`);
  console.log(`[ATTENDANCE PAGE] Rows found: ${parsed._rowsFound}`);
  console.log(`[ATTENDANCE PAGE] Attendance rows detected: ${parsed.subjects.length}`);

  // ── Step 6: If no subjects found, try each iframe ─────────────────────
  if (parsed.subjects.length === 0 && frames.length > 1) {
    console.log(`[ATTENDANCE PAGE] No data in main page — checking iframes...`);
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameHtml = await frame.content();
        console.log(`[ATTENDANCE PAGE]   Trying iframe: ${frame.url()} (${frameHtml.length} bytes)`);
        const frameParsed = parseAttendance(frameHtml);
        if (frameParsed.subjects.length > 0) {
          console.log(`[ATTENDANCE PAGE]   Found ${frameParsed.subjects.length} subject(s) in iframe!`);
          parsed = frameParsed;
          break;
        }
      } catch (e: any) {
        console.log(`[ATTENDANCE PAGE]   iframe not accessible: ${e?.message}`);
      }
    }
  }

  console.log(`[ATTENDANCE PAGE] Headers: ${parsed._rawHeaders.join(' | ')}`);
  console.log(`[ATTENDANCE] Parser successful. Subjects extracted: ${parsed.subjects.length}`);

  // ── Step 7: Guard against empty result ───────────────────────────────
  if (parsed.subjects.length === 0) {
    // Check if the page even loaded attendance content at all
    const hasAttendanceText = mainHtml.toLowerCase().includes('attendance');
    const code = hasAttendanceText ? 'ATTENDANCE_PARSER_ERROR' : 'ATTENDANCE_PAGE_EMPTY';
    throw Object.assign(new Error(code), {
      code,
      details: hasAttendanceText
        ? `Attendance page loaded at ${finalUrl} (${mainHtml.length} bytes) and contains attendance text, but the parser could not extract table rows. Check backend/debug/attendance.html to inspect the actual HTML structure.`
        : `Attendance page loaded at ${finalUrl} but contained no attendance content. The page may not have loaded fully, or this account may have no attendance data.`
    });
  }

  // ── Step 8: Return normalized result ─────────────────────────────────
  return {
    // Legacy fields for backwards-compatibility
    semester:          parsed.metadata.semester,
    academicYear:      parsed.metadata.academicYear,
    section:           parsed.metadata.section,
    overallPercentage: parsed.overallPercentage,
    totalHeld:         parsed.totalHeld,
    totalAttended:     parsed.totalAttended,
    subjects:          parsed.subjects.map(s => ({
      courseCode:      s.courseCode,
      courseName:      s.courseName,
      courseType:      s.courseType,
      faculty:         s.faculty,
      classesHeld:     s.classesHeld,
      classesAttended: s.classesAttended,
      percentage:      s.percentage,
      status:          s.status,
    })),

    // Expanded complete structure
    metadata: {
      periodStart:     parsed.metadata.periodStart,
      periodEnd:       parsed.metadata.periodEnd,
      semester:        parsed.metadata.semester,
      academicYear:    parsed.metadata.academicYear,
      section:         parsed.metadata.section,
    },
    courseWiseChart:   parsed.courseWiseChart,
    attendanceHours:   parsed.attendanceHours,
    courseWiseAttendance: parsed.courseWiseAttendance,
    cumulativeAttendance: parsed.cumulativeAttendance,

    _debug: {
      url:            finalUrl,
      rawHeaders:     parsed._rawHeaders,
      tablesFound:    parsed._tablesFound,
      rowsFound:      parsed._rowsFound,
    },
  };
}

export async function extractGradesData(page: Page) {
  console.log(`[GRADES] Starting grades extraction...`);

  if (page.url().includes('youLogin.jsp')) {
    throw Object.assign(new Error('SRM_SESSION_EXPIRED'), { code: 'SRM_SESSION_EXPIRED' });
  }

  // 1. Click sidebar item for Grades / Marks & Credit
  const CLICK_PATTERNS = [
    'Grade / Mark & Credit',
    'Grade/Mark & Credit',
    'Grade / Mark',
    'Grades & Credits',
    'Academic Performance',
    'Marks',
  ];

  let clicked = false;
  let linkHref = '';

  for (const pattern of CLICK_PATTERNS) {
    try {
      const locator = page.locator(`a`).filter({ hasText: pattern }).first();
      const isVis = await locator.isVisible({ timeout: 2500 }).catch(() => false);
      if (!isVis) {
        const btn = page.locator(`button, span`).filter({ hasText: pattern }).first();
        if (!await btn.isVisible({ timeout: 1500 }).catch(() => false)) continue;
      }

      linkHref = await locator.getAttribute('href').catch(() => '') ?? '';
      const navPromise = page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await locator.click({ timeout: 4000 }).catch(async () => {
        if (linkHref && !linkHref.startsWith('javascript')) {
          await page.goto(linkHref.startsWith('http') ? linkHref : `https://sp.srmist.edu.in${linkHref}`, { waitUntil: 'networkidle', timeout: 12000 });
        }
      });
      await navPromise;
      clicked = true;
      break;
    } catch (e: any) {
      console.log(`[GRADES] Failed click on pattern ${pattern}: ${e.message}`);
    }
  }

  if (!clicked) {
    // Fallback navigation via scanned hrefs
    const result = await navigateTo(page, CLICK_PATTERNS, undefined);
    if (result) clicked = true;
  }

  if (!clicked) {
    throw Object.assign(new Error('SRM_NAVIGATION_FAILED'), {
      code: 'SRM_NAVIGATION_FAILED',
      details: 'Could not find or navigate to Grade/Mark page in sidebar.'
    });
  }

  // Expiry check
  if (page.url().includes('youLogin.jsp')) {
    throw Object.assign(new Error('SRM_SESSION_EXPIRED'), { code: 'SRM_SESSION_EXPIRED' });
  }

  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await saveDebugSnapshot(page, 'grades');

  const semesters: any[] = [];
  
  // 2. Discover if there is a semester select dropdown
  const select = await page.$('select');
  if (select) {
    console.log(`[GRADES] Select element discovered. Extracting all semesters...`);
    const options = await page.$$eval('select option', opts =>
      opts.map(o => ({ value: o.value, text: o.textContent?.trim() || '' }))
          .filter(o => o.value && !o.text.toLowerCase().includes('select'))
    );

    console.log(`[GRADES] Found ${options.length} term options in dropdown.`);
    for (const opt of options) {
      try {
        console.log(`[GRADES] Extracting semester option: ${opt.text} (${opt.value})`);
        await page.selectOption('select', opt.value);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000).catch(() => {});

        const html = await getPageHtmlWithFrameFallback(page);
        const termParsed = parseGradePage(html);
        semesters.push({
          semester: opt.text || termParsed.semester,
          academicYear: termParsed.academicYear,
          courses: termParsed.courses,
          summary: termParsed.summary
        });
      } catch (err: any) {
        console.log(`[GRADES] Failed semester select ${opt.value}: ${err.message}`);
      }
    }
  }

  // Fallback if no semesters extracted (e.g. no select elements or only one semester shown by default)
  if (semesters.length === 0) {
    console.log(`[GRADES] No term dropdown processed. Parsing active page structure...`);
    const html = await getPageHtmlWithFrameFallback(page);
    const parsed = parseGradePage(html);
    semesters.push({
      semester: parsed.semester || '1',
      academicYear: parsed.academicYear,
      courses: parsed.courses,
      summary: parsed.summary
    });
  }

  const firstSem = semesters[0] || { courses: [] };
  const headers = firstSem.courses[0] ? Object.keys(firstSem.courses[0]._raw) : [];
  const grades = firstSem.courses.map((c: any) => c._raw);

  return {
    headers,
    grades,
    semesters,
    _url: page.url()
  };
}

// -----------------------------------------------------------------------
// PHASE 8: Exam Timetable extraction
// -----------------------------------------------------------------------
export async function extractExamTimetableData(page: Page) {
  console.log(`[EXAM TIMETABLE PARSER] Starting exam timetable extraction...`);

  await returnToDashboard(page).catch(() => {});

  const result = await navigateTo(page,
    ['Exam Timetable', 'Exam Time Table', 'Examination', 'Exam Schedule', 'Provisional Timetable'],
    undefined
  );

  let html = '';
  let url = page.url();

  if (result) {
    html = result.html;
    url = result.url;
    await saveDebugSnapshot(page, 'exam-timetable');
  } else {
    console.log(`[EXAM TIMETABLE PARSER] No exam timetable link found`);
    throw Object.assign(new Error('SRM_NAVIGATION_FAILED'), {
      code: 'SRM_NAVIGATION_FAILED',
      details: 'Could not find exam timetable link from the dashboard navigation.'
    });
  }

  const $ = cheerio.load(html);
  const tables = extractAllTables($);

  console.log(`[EXAM TIMETABLE PARSER] URL: ${url}`);
  console.log(`[EXAM TIMETABLE PARSER] Tables found: ${tables.length}`);

  if (tables.length === 0 || tables.every(t => t.rows.length === 0)) {
    throw Object.assign(new Error('NOT_AVAILABLE'), {
      code: 'NOT_AVAILABLE',
      details: `Exam timetable page loaded at ${url} but contained no table data — timetable may not be published yet.`
    });
  }

  const timetableTable = tables.sort((a, b) => b.rows.length - a.rows.length)[0];

  return {
    headers: timetableTable.headers,
    timetable: timetableTable.rows,
    _url: url,
    _allTables: tables,
  };
}

export async function extractHostelData(page: Page) {
  console.log(`[HOSTEL] Starting hostel extraction sequentially...`);

  if (page.url().includes('youLogin.jsp')) {
    throw Object.assign(new Error('SRM_SESSION_EXPIRED'), { code: 'SRM_SESSION_EXPIRED' });
  }

  const subpages = [
    { name: 'booking', patterns: ['Hostel Booking'], parser: parseHostelBookingPage, snapshot: 'hostel-booking' },
    { name: 'details', patterns: ['Hostel Details'], parser: parseHostelDetailsPage, snapshot: 'hostel-details' },
    { name: 'willingness', patterns: ['Hostel Willingness'], parser: parseHostelWillingnessPage, snapshot: 'hostel-willingness' }
  ];

  const results: Record<string, any> = {};

  for (const sub of subpages) {
    try {
      console.log(`[HOSTEL] Accessing subpage: ${sub.name}...`);
      await returnToDashboard(page).catch(() => {});
      
      // Expand Hostel Menu accordion if collapsed to make sub-items visible
      try {
        const hostelMenu = page.locator('a').filter({ hasText: /^\s*Hostel\s*$/ }).first();
        const isCollapsed = await hostelMenu.getAttribute('class').then(c => c?.includes('collapsed')).catch(() => false);
        if (isCollapsed) {
          console.log(`[HOSTEL] Sidenav "Hostel" menu is collapsed. Expanding accordion...`);
          await hostelMenu.click().catch(() => {});
          await page.waitForTimeout(500).catch(() => {});
        }
      } catch (e: any) {
        console.log(`[HOSTEL] Sidenav expand warning: ${e.message}`);
      }

      let foundLink = false;
      let linkHref = '';

      for (const pattern of sub.patterns) {
        try {
          const locator = page.locator(`a`).filter({ hasText: pattern }).first();
          const isVis = await locator.isVisible({ timeout: 2500 }).catch(() => false);
          if (!isVis) continue;

          linkHref = await locator.getAttribute('href').catch(() => '') ?? '';
          const navPromise = page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
          await locator.click({ timeout: 4000 }).catch(async () => {
            if (linkHref && !linkHref.startsWith('javascript')) {
              await page.goto(linkHref.startsWith('http') ? linkHref : `https://sp.srmist.edu.in${linkHref}`, { waitUntil: 'networkidle', timeout: 12000 });
            }
          });
          await navPromise;
          foundLink = true;
          break;
        } catch (e: any) {
          // try next pattern
        }
      }

      if (!foundLink) {
        // Fallback navigation
        const result = await navigateTo(page, sub.patterns, undefined);
        if (result) foundLink = true;
      }

      if (!foundLink) {
        results[sub.name] = {
          success: false,
          error: {
            code: 'NOT_AVAILABLE',
            message: `Link for '${sub.name}' was not found in sidebar.`
          }
        };
        continue;
      }

      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await saveDebugSnapshot(page, sub.snapshot);

      const html = await getPageHtmlWithFrameFallback(page);

      // Validate the page to ensure it is not Personal Details / Profile page
      if (sub.name === 'details') {
        const validation = validateHostelDetailsPage(html);
        if (!validation.isValid) {
          console.log(`[HOSTEL] Validation failed: ${validation.message}`);
          throw Object.assign(new Error('WRONG_PAGE'), {
            code: 'WRONG_PAGE',
            message: validation.message
          });
        }
      }

      const parsed = sub.parser(html);

      if (parsed.tables.length === 0 && Object.keys(parsed.labelValues).length === 0 && !parsed.statusText) {
        results[sub.name] = {
          success: false,
          error: {
            code: 'NOT_AVAILABLE',
            message: `Hostel subpage '${sub.name}' contains no structured data.`
          }
        };
      } else {
        results[sub.name] = {
          success: true,
          data: parsed
        };
      }
    } catch (err: any) {
      console.error(`[HOSTEL] Error on subpage ${sub.name}:`, err.message);
      results[sub.name] = {
        success: false,
        error: {
          code: err.code || 'PARSER_ERROR',
          message: err.message || `Failed to extract ${sub.name} page.`
        }
      };
    }
  }

  // Backwards compatibility keys
  const legacyDetails = results.details?.success ? results.details.data : { tables: [], labelValues: {} };

  return {
    tables: legacyDetails.tables,
    labelValues: legacyDetails.labelValues,
    booking: results.booking,
    details: results.details,
    willingness: results.willingness,
    _url: page.url()
  };
}
