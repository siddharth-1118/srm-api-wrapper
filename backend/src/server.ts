import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { sessionStore, generateSessionId, backendInstanceId, processStartedAt } from './store/sessionStore';
import { createBrowserSession, closeGlobalBrowser } from './services/srmBrowser';
import { getCaptchaScreenshot, refreshCaptcha } from './services/captcha';
import { submitLogin, checkSessionAlive } from './services/srmAuth';
import { supabase } from './lib/supabase';
import {
  extractProfileData,
  extractDashboardData,
  extractGradesData,
  extractExamTimetableData,
  extractHostelData,
  extractAttendanceData,
  extractInternalMarksData,
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
  let session = sessionId ? sessionStore.getSession(sessionId) : null;
  const sessionExists = !!session;
  const sessionAuthenticated = session ? session.state === 'AUTHENTICATED' : false;

  console.log(`[AUTH DEBUG] Request: ${req.method} ${req.path}, Session Exists: ${sessionExists}`);

  if (!sessionId) {
    return res.status(401).json({
      success: false,
      error: { code: 'SESSION_EXPIRED', message: 'No session ID provided. Please log in.' }
    });
  }

  if (!session) {
    // Check Supabase to see if this was a valid active session that was lost (restart detection)
    try {
      const { data: dbSession } = await supabase
        .from('application_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();
      
      if (dbSession) {
        const inactiveStates = ['EXPIRED', 'LOGGED_OUT', 'SESSION_LOST'];
        if (!inactiveStates.includes(dbSession.status)) {
          console.log(`[SESSION LIFECYCLE] Session ${sessionId} found active in DB (backend_instance_id=${dbSession.backend_instance_id}) but missing in memory. Marking SESSION_LOST.`);
          try {
            await supabase
              .from('application_sessions')
              .update({ status: 'SESSION_LOST', authenticated: false })
              .eq('id', sessionId);
          } catch {}
          
          return res.status(401).json({
            success: false,
            error: { code: 'SESSION_LOST', message: 'The SRM browser session was lost due to server restart. Please sign in again.' }
          });
        }
      }
    } catch (e) {
      console.error("[AUTH MIDDLEWARE] Error checking DB for session restart detection:", e);
    }

    return res.status(401).json({
      success: false,
      error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Please log in again.' }
    });
  }

  // Verify Playwright session is still healthy and not crashed
  try {
    if (session.page.isClosed()) {
      try {
        await supabase
          .from('application_sessions')
          .update({ status: 'SESSION_LOST', authenticated: false })
          .eq('id', sessionId);
      } catch {}
      await sessionStore.destroySession(sessionId);
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_LOST', message: 'Browser session closed or crashed. Please log in again.' }
      });
    }
  } catch {
    try {
      await supabase
        .from('application_sessions')
        .update({ status: 'SESSION_LOST', authenticated: false })
        .eq('id', sessionId);
    } catch {}
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

  // Update last activity at in Supabase with throttling (max once every 30 seconds)
  const now = Date.now();
  const lastUpdate = session.lastActivityAt;
  if (now - lastUpdate > 30 * 1000) {
    session.lastActivityAt = now;
    
    const authMinutes = process.env.SESSION_TIMEOUT_MINUTES 
      ? parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) 
      : 20;
    const expiresAt = new Date(now + authMinutes * 60 * 1000).toISOString();

    try {
      await supabase.from('application_sessions').update({
        last_activity_at: new Date(now).toISOString(),
        expires_at: expiresAt
      }).eq('id', sessionId);
    } catch {}
  }

  req.srmSession = session as any;
  next();
}

// --------------------------------------------------------------------
// AUTH ROUTES
// --------------------------------------------------------------------

app.post('/api/auth/start', async (req: Request, res: Response) => {
  try {
    const oldSessionId = req.headers['x-session-id'] as string;
    const frontendInstanceId = req.headers['x-frontend-instance-id'] as string || 'unknown';
    const requestId = generateSessionId();

    console.log(`[AUTH START REQUEST]`);
    console.log(`requestId=${requestId}`);
    console.log(`timestamp=${new Date().toISOString()}`);
    console.log(`existingSessionId=${oldSessionId || 'none'}`);
    console.log(`frontendInstanceId=${frontendInstanceId}`);

    if (oldSessionId) {
      const oldSession = sessionStore.getSession(oldSessionId);
      // Ownership check: only sweep if it belongs to current unauthenticated context
      if (oldSession && !oldSession.authenticated && !oldSession.loginInProgress) {
        console.log(`[AUTH START] Safely destroying previous unauthenticated session: ${oldSessionId}`);
        await sessionStore.destroySession(oldSessionId).catch(() => {});
      }
    }

    console.log(`[AUTH START] Initializing new browser context (backendInstanceId=${backendInstanceId})...`);
    const { context, page } = await createBrowserSession();
    const sessionId = generateSessionId();

    const loginUrl = process.env.SRM_LOGIN_URL || 'https://sp.srmist.edu.in/srmiststudentportal/students/loginManager/youLogin.jsp';
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 20000 });

    const captchaBase64 = await getCaptchaScreenshot(page);
    const session = sessionStore.createSession(sessionId, context, page);
    session.captchaGeneratedAt = Date.now();

    // Create session in Supabase metadata tracking
    const unauthMinutes = process.env.UNAUTHENTICATED_SESSION_TIMEOUT_MINUTES 
      ? parseInt(process.env.UNAUTHENTICATED_SESSION_TIMEOUT_MINUTES, 10) 
      : 5;
    const expiresAt = new Date(Date.now() + unauthMinutes * 60 * 1000).toISOString();

    try {
      await supabase.from('application_sessions').insert({
        id: sessionId,
        user_id: 'pending',
        status: 'CAPTCHA_REQUIRED',
        created_at: new Date(session.createdAt).toISOString(),
        last_activity_at: new Date(session.lastActivityAt).toISOString(),
        expires_at: expiresAt,
        authenticated: false,
        backend_instance_id: backendInstanceId
      });
    } catch (err) {
      console.error(`[SUPABASE ERROR] Failed to create session record:`, err);
    }

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
    const triggerReason = req.body.reason || 'manual';
    const triggerSource = req.body.source || 'user';
    console.log(`[CAPTCHA REFRESH TRIGGER]`);
    console.log(`reason=${triggerReason}`);
    console.log(`source=${triggerSource}`);
    console.log(`sessionId=${session.sessionId}`);
    console.log(`timestamp=${new Date().toISOString()}`);

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

  const requestId = generateSessionId();
  console.log(`[AUTH LOGIN REQUEST] requestId=${requestId} sessionId=${sessionId} timestamp=${new Date().toISOString()}`);

  console.log(`[CAPTCHA BINDING]`);
  console.log(`captchaSession = ${sessionId}`);
  console.log(`loginSession = ${sessionId}`);
  console.log(`captchaContext = ${session.browserContext ? 'present' : 'missing'}`);
  console.log(`loginContext = ${session.browserContext ? 'present' : 'missing'}`);
  console.log(`captchaPage = ${session.page ? 'present' : 'missing'}`);
  console.log(`loginPage = ${session.page ? 'present' : 'missing'}`);

  if (session.loginInProgress) {
    return res.status(409).json({
      success: false,
      error: { code: 'AUTHENTICATION_IN_PROGRESS', message: 'Authentication is already in progress for this session.' }
    });
  }

  if (!netId || !password || !captcha) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'NetID, Password, and Captcha are all required.' }
    });
  }

  session.loginInProgress = true;
  session.state = 'AUTHENTICATION_IN_PROGRESS';

  try {
    const captchaAgeMs = Date.now() - (session.captchaGeneratedAt || session.createdAt);
    session.captchaAgeMs = captchaAgeMs;
    console.log(`[AUTH LOGIN] Session: ${sessionId}, Captcha Age: ${Math.round(captchaAgeMs / 1000)}s`);

    const result = await submitLogin(session.page, netId.trim(), password, captcha.trim());
    
    if (result.success) {
      session.state = 'AUTHENTICATED';
      session.authenticated = true;

      const authMinutes = process.env.SESSION_TIMEOUT_MINUTES 
        ? parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) 
        : 20;
      const expiresAt = new Date(Date.now() + authMinutes * 60 * 1000).toISOString();

      try {
        await supabase.from('application_sessions').update({
          user_id: netId.trim().split('@')[0],
          status: 'AUTHENTICATED',
          authenticated: true,
          expires_at: expiresAt,
          last_activity_at: new Date().toISOString()
        }).eq('id', sessionId);
      } catch (err) {
        console.error(`[SUPABASE ERROR] Failed to update login success status:`, err);
      }

      return res.json({
        success: true,
        authenticated: true,
        sessionId: session.sessionId,
        message: 'Login successful'
      });
    } else {
      session.authenticated = false;
      session.state = result.errorCode === 'INVALID_CAPTCHA' || (result.errorCode as any) === 'CAPTCHA_EXPIRED'
        ? 'CAPTCHA_REQUIRED'
        : 'AUTH_FAILED';

      try {
        await supabase.from('application_sessions').update({
          status: result.errorCode || 'AUTH_FAILED',
          last_activity_at: new Date().toISOString()
        }).eq('id', sessionId);
      } catch (err) {
        console.error(`[SUPABASE ERROR] Failed to update login failure status:`, err);
      }

      return res.json({
        success: false,
        authenticated: false,
        error: {
          code: result.errorCode || 'AUTHENTICATION_UNKNOWN',
          message: result.errorMessage || 'Authentication failed.'
        }
      });
    }
  } catch (err) {
    console.error("Error during login authentication:", err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal error during login process.' }
    });
  } finally {
    session.loginInProgress = false;
  }
});

app.post('/api/auth/logout', async (req: Request, res: Response) => {
  const sessionId = req.body.sessionId || (req.headers['x-session-id'] as string);
  if (sessionId) {
    try {
      await supabase
        .from('application_sessions')
        .update({ status: 'LOGGED_OUT', authenticated: false })
        .eq('id', sessionId);
    } catch (e) {
      console.error("[LOGOUT] Failed to update Supabase status to LOGGED_OUT:", e);
    }
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
      success: true,
      sessionExists: false,
      authenticated: false,
      state: 'EXPIRED',
      sessionStatus: 'EXPIRED'
    });
  }

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    // Check Supabase status
    try {
      const { data: dbSession } = await supabase
        .from('application_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();
      
      if (dbSession) {
        return res.json({
          success: true,
          sessionExists: true,
          authenticated: false,
          state: dbSession.status,
          browserConnected: false,
          pageOpen: false,
          createdAt: dbSession.created_at,
          lastActivityAt: dbSession.last_activity_at,
          sessionStatus: dbSession.status
        });
      }
    } catch {}

    return res.json({
      success: true,
      sessionExists: false,
      authenticated: false,
      state: 'EXPIRED',
      sessionStatus: 'EXPIRED'
    });
  }

  let currentUrl = '';
  let pageTitle = '';
  let browserConnected = false;
  let pageOpen = false;

  try {
    if (!session.page.isClosed()) {
      currentUrl = session.page.url();
      pageTitle = await session.page.title().catch(() => '');
      pageOpen = true;
      browserConnected = true;
    }
  } catch {}

  return res.json({
    success: true,
    sessionExists: true,
    authenticated: session.authenticated,
    state: session.state,
    browserConnected,
    pageOpen,
    currentUrl,
    pageTitle,
    createdAt: new Date(session.createdAt).toISOString(),
    lastActivityAt: new Date(session.lastActivityAt).toISOString(),
    sessionStatus: session.authenticated ? 'ACTIVE' : 'INCOMPLETE'
  });
});

app.get('/health', (req: Request, res: Response) => {
  return res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    startedAt: processStartedAt,
    processId: process.pid,
    backendInstanceId: backendInstanceId
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

// Full login debug — performs actual login and returns the post-login page state
app.post('/api/auth/debug-login', async (req: Request, res: Response) => {
  const { netId, password, captcha, sessionId: bodySessionId } = req.body;
  const sessionId = bodySessionId || (req.headers['x-session-id'] as string);
  let context = null;
  let usedExistingSession = false;

  try {
    let page: any;

    if (sessionId) {
      const session = sessionStore.getSession(sessionId);
      if (session && !session.page.isClosed()) {
        page = session.page;
        usedExistingSession = true;
        console.log(`[DEBUG LOGIN] Using existing session: ${sessionId}`);
      }
    }

    if (!page) {
      const sessionObj = await createBrowserSession();
      context = sessionObj.context;
      page = sessionObj.page;
      const loginUrl = process.env.SRM_LOGIN_URL || 'https://sp.srmist.edu.in/srmiststudentportal/students/loginManager/youLogin.jsp';
      await page.goto(loginUrl, { waitUntil: 'load', timeout: 20000 });
      console.log(`[DEBUG LOGIN] Fresh session created, on login page`);
    }

    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => '');

    // Fill and submit login if credentials provided
    let loginResult = null;
    if (netId && password && captcha) {
      try {
        loginResult = await submitLogin(page, netId.trim(), password, captcha.trim());
      } catch (fillErr: any) {
        console.error('[DEBUG LOGIN] Login error:', fillErr.message);
      }
    }

    const afterUrl = page.url();
    const afterTitle = await page.title().catch(() => '');
    const html = await page.content().catch(() => '');

    let screenshotBase64 = null;
    try {
      const buf = await page.screenshot({ timeout: 8000, fullPage: false });
      screenshotBase64 = `data:image/png;base64,${buf.toString('base64')}`;
    } catch {}

    // Check all meaningful patterns
    const isOnLoginPage = afterUrl.includes('youLogin') || afterUrl.includes('loginManager');
    const hasLogout = html.includes('logout') || html.includes('Logout');
    const hasStudentUrl = afterUrl.includes('student');
    const hasError = html.toLowerCase().includes('invalid') || html.toLowerCase().includes('error');

    if (context) await context.close().catch(() => {});

    return res.json({
      success: true,
      usedExistingSession,
      loginResult,
      before: { url: beforeUrl, title: beforeTitle },
      after: { url: afterUrl, title: afterTitle },
      analysis: { isOnLoginPage, hasLogout, hasStudentUrl, hasError },
      htmlSnippet: html.substring(0, 5000),
      htmlLength: html.length,
      screenshot: screenshotBase64
    });
  } catch (err: any) {
    console.error("[DEBUG LOGIN] Critical error:", err);
    if (context) await context.close().catch(() => {});
    return res.status(500).json({ success: false, error: err.message, stack: err.stack });
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

app.get('/api/student/internal-marks', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const session = req.srmSession!;
  try {
    const data = await extractInternalMarksData(session.page);
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
