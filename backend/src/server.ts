import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { sessionStore, generateSessionId } from './store/sessionStore';
import { createBrowserSession, closeGlobalBrowser } from './services/srmBrowser';
import { getCaptchaScreenshot, refreshCaptcha } from './services/captcha';
import { submitLogin, checkSessionAlive } from './services/srmAuth';
import {
  extractProfileData,
  extractDashboardData,
  extractGradesData,
  extractExamTimetableData,
  extractHostelData,
  extractAttendanceData,
} from './services/srmExtractor';

import { SrmErrorCode } from './types/srm.types';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// Set session timeout from env if provided
if (process.env.SESSION_TIMEOUT_MINUTES) {
  const mins = parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10);
  if (!isNaN(mins)) {
    sessionStore.setTimeoutMinutes(mins);
  }
}

// --------------------------------------------------------------------
// AUTH MIDDLEWARES
// --------------------------------------------------------------------

interface AuthenticatedRequest extends Request {
  srmSession?: ReturnType<typeof sessionStore.getSession> & { page: any; browserContext: any };
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const sessionId = req.headers['x-session-id'] as string;
  const session = sessionId ? sessionStore.getSession(sessionId) : null;
  const sessionExists = !!session;
  const sessionAuthenticated = session ? session.state === 'AUTHENTICATED' : false;

  console.log(`[AUTH DEBUG]`);
  console.log(`Request: ${req.method} ${req.path}`);
  console.log(`X-Session-ID present: ${!!sessionId}`);
  console.log(`Session exists: ${sessionExists}`);
  console.log(`Session authenticated: ${sessionAuthenticated}`);

  if (!sessionId) {
    return res.status(401).json({
      success: false,
      error: { code: 'SESSION_EXPIRED', message: 'No session ID provided. Please log in.' }
    });
  }

  if (!session) {
    return res.status(401).json({
      success: false,
      error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Please log in again.' }
    });
  }

  // Verify Playwright session is still healthy and not crashed
  try {
    if (session.page.isClosed()) {
      await sessionStore.destroySession(sessionId);
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_EXPIRED', message: 'Browser context was closed. Please log in again.' }
      });
    }
  } catch {
    await sessionStore.destroySession(sessionId);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to verify browser context health.' }
    });
  }

  // If this endpoint requires authenticated state
  if (req.path.startsWith('/api/student') && session.state !== 'AUTHENTICATED') {
    return res.status(403).json({
      success: false,
      error: { code: 'SESSION_EXPIRED', message: 'Session is not authenticated.' }
    });
  }

  req.srmSession = session as any;
  next();
}

// --------------------------------------------------------------------
// AUTH ROUTES
// --------------------------------------------------------------------

app.post('/api/auth/start', async (req: Request, res: Response) => {
  try {
    console.log("Initializing new browser context for auth start...");
    const { context, page } = await createBrowserSession();
    const sessionId = generateSessionId();

    const loginUrl = process.env.SRM_LOGIN_URL || 'https://sp.srmist.edu.in/srmiststudentportal/students/loginManager/youLogin.jsp';
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 20000 });

    const captchaBase64 = await getCaptchaScreenshot(page);
    sessionStore.createSession(sessionId, context, page);

    console.log(`Session initialized successfully: ${sessionId}`);
    return res.json({
      success: true,
      sessionId,
      captcha: captchaBase64
    });
  } catch (err) {
    console.error("Error starting login session:", err);
    return res.status(503).json({
      success: false,
      error: {
        code: 'SRM_UNAVAILABLE',
        message: 'Unable to reach the SRMIST student portal login page. Please check your connection.'
      }
    });
  }
});

app.post('/api/auth/captcha/refresh', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const session = req.srmSession!;
  try {
    console.log(`Refreshing captcha for session: ${session.sessionId}`);
    const captchaBase64 = await refreshCaptcha(session.page);
    return res.json({
      success: true,
      captcha: captchaBase64
    });
  } catch (err) {
    console.error("Error refreshing captcha:", err);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to reload Captcha image from portal.'
      }
    });
  }
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { sessionId: bodySessionId, netId, password, captcha } = req.body;
  const sessionId = bodySessionId || (req.headers['x-session-id'] as string);

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: { code: 'SESSION_EXPIRED', message: 'Session ID is required.' }
    });
  }

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return res.status(401).json({
      success: false,
      error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Please refresh and try again.' }
    });
  }

  if (!netId || !password || !captcha) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'NetID, Password, and Captcha are all required.' }
    });
  }

  try {
    const result = await submitLogin(session.page, netId.trim(), password, captcha.trim());
    
    if (result.success) {
      session.state = 'AUTHENTICATED';
      session.authenticated = true;
      return res.json({
        success: true,
        authenticated: true,
        sessionId: session.sessionId,
        message: 'Login successful'
      });
    } else {
      session.authenticated = false;
      if (result.errorCode === 'INVALID_CAPTCHA') {
        session.state = 'CAPTCHA_REQUIRED';
        return res.json({
          success: false,
          authenticated: false,
          error: {
            code: 'INVALID_CAPTCHA',
            message: result.errorMessage || 'CAPTCHA is incorrect or expired.'
          }
        });
      } else if (result.errorCode === 'INVALID_CREDENTIALS') {
        session.state = 'AUTH_FAILED';
        return res.json({
          success: false,
          authenticated: false,
          error: {
            code: 'INVALID_CREDENTIALS',
            message: result.errorMessage || 'Invalid NetID or password.'
          }
        });
      } else {
        session.state = 'AUTH_FAILED';
        return res.json({
          success: false,
          authenticated: false,
          error: {
            code: 'AUTHENTICATION_UNKNOWN',
            message: result.errorMessage || 'Unable to determine the SRM authentication result.'
          }
        });
      }
    }
  } catch (err) {
    console.error("Error during login authentication:", err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal error during login process.' }
    });
  }
});

app.post('/api/auth/logout', async (req: Request, res: Response) => {
  const sessionId = req.body.sessionId || (req.headers['x-session-id'] as string);
  if (sessionId) {
    await sessionStore.destroySession(sessionId);
  }
  return res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

app.get('/api/auth/status', async (req: Request, res: Response) => {
  const sessionId = req.headers['x-session-id'] as string;
  if (!sessionId) {
    return res.json({
      sessionExists: false,
      authenticated: false,
      state: 'EXPIRED'
    });
  }

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return res.json({
      sessionExists: false,
      authenticated: false,
      state: 'EXPIRED'
    });
  }

  let currentUrl = '';
  let pageTitle = '';
  try {
    if (!session.page.isClosed()) {
      currentUrl = session.page.url();
      pageTitle = await session.page.title().catch(() => '');
    }
  } catch {}

  return res.json({
    sessionExists: true,
    authenticated: session.authenticated,
    state: session.state,
    lastActivityAt: new Date(session.lastActivityAt).toISOString(),
    currentUrl,
    pageTitle
  });
});

app.get('/api/auth/debug', async (req: Request, res: Response) => {
  let context = null;
  let page = null;
  try {
    console.log("[DEBUG ENDPOINT] Launching fresh session for debug...");
    const sessionObj = await createBrowserSession();
    context = sessionObj.context;
    page = sessionObj.page;

    const loginUrl = process.env.SRM_LOGIN_URL || 'https://sp.srmist.edu.in/srmiststudentportal/students/loginManager/youLogin.jsp';
    console.log(`[DEBUG ENDPOINT] Navigating to ${loginUrl}...`);
    
    let navError = null;
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 20000 }).catch(err => {
      navError = err.message || err;
    });

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => 'unknown');
    const html = await page.content().catch(() => '');
    
    let screenshotBase64 = null;
    try {
      const buffer = await page.screenshot({ timeout: 5000 });
      screenshotBase64 = `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (ssErr: any) {
      console.error("[DEBUG ENDPOINT] Screenshot failed:", ssErr);
    }

    await context.close().catch(() => {});

    return res.json({
      success: true,
      navError,
      currentUrl,
      pageTitle,
      htmlSnippet: html.substring(0, 3000),
      htmlLength: html.length,
      screenshot: screenshotBase64
    });
  } catch (err: any) {
    console.error("[DEBUG ENDPOINT] Critical error:", err);
    if (context) {
      await context.close().catch(() => {});
    }
    return res.status(500).json({
      success: false,
      error: err.message || err,
      stack: err.stack
    });
  }
});

// --------------------------------------------------------------------
// STUDENT DATA ROUTES
// --------------------------------------------------------------------

app.get('/api/student/dashboard', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const session = req.srmSession!;
  try {
    const data = await extractDashboardData(session.page);
    return res.json({ success: true, data });
  } catch (err) {
    return handleExtractionError(err, res);
  }
});

app.get('/api/student/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const session = req.srmSession!;
  try {
    const data = await extractProfileData(session.page);
    return res.json({ success: true, data });
  } catch (err) {
    return handleExtractionError(err, res);
  }
});

app.get(['/api/student/grades', '/api/student/marks'], requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const session = req.srmSession!;
  try {
    const data = await extractGradesData(session.page);
    return res.json({ success: true, data });
  } catch (err) {
    return handleExtractionError(err, res);
  }
});

app.get('/api/student/exams', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const session = req.srmSession!;
  try {
    const data = await extractExamTimetableData(session.page);
    return res.json({ success: true, data });
  } catch (err) {
    return handleExtractionError(err, res);
  }
});

app.get('/api/student/hostel', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const session = req.srmSession!;
  try {
    const data = await extractHostelData(session.page);
    return res.json({ success: true, data });
  } catch (err) {
    return handleExtractionError(err, res);
  }
});

app.get('/api/student/attendance', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const session = req.srmSession!;
  try {
    const data = await extractAttendanceData(session.page);
    return res.json({ success: true, data });
  } catch (err) {
    return handleExtractionError(err, res);
  }
});

// Generic stub for truly unmapped endpoints
const unmappedEndpoints = [
  '/api/student/personal-details',
  '/api/student/course-registration',
  '/api/student/timetable',
  '/api/student/academic-calendar',
  '/api/student/exam-results',
  '/api/student/revaluation-results',
  '/api/student/fees',
  '/api/student/internal-marks',
  '/api/student/courses',
];

unmappedEndpoints.forEach(path => {
  app.get(path, requireAuth, (req: AuthenticatedRequest, res: Response) => {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: `The section '${path.split('/').pop()}' extraction is not yet implemented. Check /api/student/dashboard for navigation links.`
      }
    });
  });
});

function handleExtractionError(err: any, res: Response) {
  console.error("Extraction error:", err?.message || err);

  const code = err?.code || (err instanceof Error ? err.message : 'INTERNAL_ERROR');

  if (code === 'SRM_SESSION_EXPIRED' || code === 'SESSION_EXPIRED') {
    return res.status(401).json({
      success: false,
      error: { code: 'SESSION_EXPIRED', message: 'Your SRM session has expired. Please log in again.' }
    });
  }
  if (code === 'SRM_NAVIGATION_FAILED') {
    return res.status(422).json({
      success: false,
      error: {
        code: 'SRM_NAVIGATION_FAILED',
        message: err?.details || 'Could not navigate to this section from the SRM dashboard.',
        hint: 'Check /api/student/dashboard for discovered navigation links.'
      }
    });
  }
  if (code === 'PARSER_NO_DATA') {
    return res.status(200).json({
      success: false,
      error: {
        code: 'PARSER_NO_DATA',
        message: err?.details || 'The SRM page loaded but the parser found no structured data.',
        hint: 'Check backend/debug/ for the saved HTML to inspect the real page structure.'
      }
    });
  }
  if (code === 'NOT_AVAILABLE') {
    return res.status(200).json({
      success: false,
      error: {
        code: 'NOT_AVAILABLE',
        message: err?.details || 'This section is not available or has no data for your account.'
      }
    });
  }
  if (code === 'ATTENDANCE_PAGE_EMPTY') {
    return res.status(200).json({
      success: false,
      error: {
        code: 'ATTENDANCE_PAGE_EMPTY',
        message: err?.details || 'The attendance page loaded but contained no attendance data. This account may not have attendance records for the current semester.',
        hint: 'Check backend/debug/attendance.html to inspect what SRM returned.'
      }
    });
  }
  if (code === 'ATTENDANCE_PARSER_ERROR') {
    return res.status(200).json({
      success: false,
      error: {
        code: 'ATTENDANCE_PARSER_ERROR',
        message: err?.details || 'The attendance page loaded and contains attendance text, but the structure could not be parsed.',
        hint: 'Check backend/debug/attendance.html — the table structure may differ from expected. Please report the HTML structure so the parser can be updated.'
      }
    });
  }
  if (code === 'SRM_PAGE_EMPTY') {
    return res.status(200).json({
      success: false,
      error: { code: 'SRM_PAGE_EMPTY', message: err?.details || 'The SRM page was empty.' }
    });
  }

  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: `Extraction failed: ${err?.message || err}` }
  });
}

// --------------------------------------------------------------------
// SERVER START AND SHUTDOWN
// --------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`SRM API Wrapper backend running on http://localhost:${PORT}`);
});

async function shutdown() {
  console.log("\nShutting down backend server...");
  server.close();
  await sessionStore.destroyAll();
  await closeGlobalBrowser();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
