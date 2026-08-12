import { Page } from 'playwright';
import * as cheerio from 'cheerio';
import { SrmErrorCode } from '../types/srm.types';

export interface LoginResult {
  success: boolean;
  errorCode?: SrmErrorCode;
  errorMessage?: string;
}

export async function submitLogin(
  page: Page,
  netId: string,
  password: string,
  captcha: string
): Promise<LoginResult> {
  try {
    console.log("[SRM AUTH] Preparing login form submission inputs...");
    
    // Ensure the selectors are visible on the login form
    await page.waitForSelector('#username', { state: 'visible', timeout: 5000 });
    
    // Clean the NetID (strip email suffix if user entered their full email address)
    const cleanNetId = netId.includes('@') ? netId.split('@')[0] : netId;

    // Fill the inputs directly and reliably (prevents character drops on CPU-throttled containers)
    console.log("[SRM AUTH] Filling login form credentials...");
    await page.fill('#username', cleanNetId.trim());
    await page.fill('#password', password);
    await page.fill('#captcha', captcha);

    // Inject a telemetry spoofer in the page context to bypass the secure2.js bot-detection script
    console.log("[SRM AUTH] Injecting human telemetry spoofer...");
    await page.evaluate(() => {
      // 1. Satisty the guardlogin.js interactCount
      (window as any).interactCount = 85;
      
      // 2. Overwrite getTelemetryPayload from secure2.js to return a perfectly realistic human footprint
      if (typeof (window as any).getTelemetryPayload === 'function') {
        const originalGet = (window as any).getTelemetryPayload;
        (window as any).getTelemetryPayload = function() {
          const mockData = {
            E: window.location.hostname || "sp.srmist.edu.in",
            D: new Date().getTimezoneOffset(),
            C: window.screen.colorDepth || 24,
            B: window.screen.pixelDepth || 24,
            "1o": window.devicePixelRatio || 1.25,
            "1n": 1, 
            "1m": "Win32", 
            "1l": navigator.userAgent,
            "1k": "en-US", 
            "1j": 8, 
            "1i": 8, 
            "2h": false, 
            v: false, // webdriver: false (hides Playwright!)
            z: 3 + Math.floor(Math.random() * 4), // clicks
            y: 150 + Math.floor(Math.random() * 100), // mouseMovements
            x: 25 + Math.floor(Math.random() * 15), // keystrokeCount
            w: 5000 + Math.floor(Math.random() * 3000), // timeOnPageMs
            u: "f60f2f2" // canvas fingerprint
          };
          
          try {
            const str = JSON.stringify(mockData);
            return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => {
              return String.fromCharCode(parseInt(p1, 16));
            }));
          } catch (e) {
            return originalGet();
          }
        };
        console.log("[TELEMETRY SPOOFER] Overwrote getTelemetryPayload successfully.");
      }
    });

    await page.waitForTimeout(500);

    // Set up listeners for submission telemetry inspection
    let navigationOccurred = false;
    let requestFailed = false;
    let jsError = false;
    let lastRequestUrl = '';
    let lastRequestMethod = '';
    let lastResponseStatus = 0;

    const onRequest = (req: any) => {
      // Intercept POST request to LoginServlet
      if (req.url().includes('LoginServlet')) {
        lastRequestUrl = req.url();
        lastRequestMethod = req.method();
      }
    };

    const onRequestFailed = (req: any) => {
      if (req.url().includes('LoginServlet')) {
        requestFailed = true;
      }
    };

    const onResponse = (res: any) => {
      if (res.url().includes('LoginServlet')) {
        lastResponseStatus = res.status();
      }
    };

    const onPageError = (err: any) => {
      jsError = true;
    };

    const onFrameNavigated = (frame: any) => {
      if (frame === page.mainFrame()) {
        navigationOccurred = true;
      }
    };

    // Attach event handlers
    page.on('request', onRequest);
    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);
    page.on('pageerror', onPageError);
    page.on('framenavigated', onFrameNavigated);

    console.log(`[SRM AUTH]`);
    console.log(`Login submitted`);

    // Hover over the login button to trigger any hover listeners, then click it
    console.log("[SRM AUTH] Clicking the login button...");
    await page.hover('#btnLogin');
    await page.click('#btnLogin', { delay: 120 });

    // Wait for the navigation cycle to process
    console.log("[SRM AUTH] Waiting for redirect actions and network requests to settle...");
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
      console.log("[SRM AUTH] Network idle load state reached maximum timeout.");
    });

    // Remove event handlers to prevent leak
    page.off('request', onRequest);
    page.off('requestfailed', onRequestFailed);
    page.off('response', onResponse);
    page.off('pageerror', onPageError);
    page.off('framenavigated', onFrameNavigated);

    // Active polling block for up to 5 seconds to inspect redirect completion
    let attempts = 0;
    let finalUrl = page.url();
    let html = await page.content();
    let $ = cheerio.load(html);
    
    let dashboardDetected = false;
    let logoutDetected = false;
    let loginErrorDetected = false;
    let errorText = "";
    let stillOnLoginPage = false;

    while (attempts < 10) {
      finalUrl = page.url();
      html = await page.content();
      $ = cheerio.load(html);

      // Check if we are still on the login form (failed login renders the inputs again)
      const hasLoginInputs = html.includes('id="username"') || 
                             html.includes('id="password"') || 
                             html.includes('id="captcha"') ||
                             html.includes('name="username"');
      
      stillOnLoginPage = hasLoginInputs || finalUrl.includes('youLogin') || finalUrl.includes('loginManager');
      dashboardDetected = !stillOnLoginPage;
      logoutDetected = $("a[href*='logout' i], a[href*='Logout' i], a:contains('Logout'), a:contains('Sign Out')").length > 0;
      
      // Error detection — use specific selectors only
      loginErrorDetected = $(".alert-danger, .alert-warning, .validation-summary-errors, [class*='error-message'], [class*='errorMessage'], .login-error, #loginError").length > 0;
      
      if (loginErrorDetected) {
        $(".alert-danger, .alert-warning, .validation-summary-errors, [class*='error-message'], [class*='errorMessage'], .login-error, #loginError").each((_, el) => {
          const text = $(el).text().trim().replace(/\s+/g, ' ');
          if (text.length > 2 && !text.toLowerCase().includes('javascript')) {
            errorText = text;
          }
        });
      }

      if (dashboardDetected || logoutDetected || loginErrorDetected) {
        break;
      }

      await page.waitForTimeout(500);
      attempts++;
    }

    const captchaErrorDetected = errorText.toLowerCase().includes('captcha') || 
                                 html.toLowerCase().includes('invalid captcha') ||
                                 html.toLowerCase().includes('captcha is incorrect');

    // If still on login page and no specific error detected, check for inline HTML error texts    
    if (stillOnLoginPage && !loginErrorDetected && !errorText) {
      // Try to grab any visible text that looks like an error from the page
      const bodyText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      const captchaMatch = bodyText.match(/invalid captcha|captcha (is )?incorrect|wrong captcha/i);
      const credMatch = bodyText.match(/invalid (username|password|credentials|netid)|username (or|and) password (is )?incorrect|login failed/i);
      if (captchaMatch) errorText = captchaMatch[0];
      else if (credMatch) errorText = credMatch[0];
      else errorText = errorText || 'Login failed — still on login page after submission.';
      loginErrorDetected = true;
    }
    
    // ── Primary success signal: Form inputs are gone ────────
    const isSuccess = !stillOnLoginPage || dashboardDetected || logoutDetected;
    const authResultStatus = isSuccess ? 'SUCCESS' : 'FAILED';

    // Print safe development logging block requested by the user
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Login button clicked`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Request URL: ${lastRequestUrl || 'N/A'}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Request method: ${lastRequestMethod || 'N/A'}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Response status: ${lastResponseStatus || 'N/A'}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Final URL: ${finalUrl}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Page title: ${await page.title()}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Navigation occurred: ${navigationOccurred}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Request failed: ${requestFailed}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`JavaScript error: ${jsError}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Dashboard detected: ${dashboardDetected}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Logout detected: ${logoutDetected}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Login error detected: ${loginErrorDetected}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Captcha error detected: ${captchaErrorDetected}`);
    console.log(`[SRM LOGIN DEBUG]`);
    console.log(`Authentication result: ${authResultStatus}`);

    if (isSuccess) {
      return { success: true };
    }

    // Determine specific errors
    let errorCode: SrmErrorCode = 'INVALID_CREDENTIALS';
    if (captchaErrorDetected) {
      errorCode = 'INVALID_CAPTCHA';
    } else if (!loginErrorDetected) {
      errorCode = 'INTERNAL_ERROR';
    }

    return {
      success: false,
      errorCode,
      errorMessage: errorText || "Authentication failed. Please verify credentials and captcha."
    };

  } catch (err) {
    console.error("Login submission critical error:", err);
    return {
      success: false,
      errorCode: 'SRM_UNAVAILABLE',
      errorMessage: "SRM Student Portal is currently unresponsive. Please try again later."
    };
  }
}

export async function checkSessionAlive(page: Page): Promise<boolean> {
  try {
    const html = await page.content();
    const $ = cheerio.load(html);
    const hasLogout = $("a[href*='logout' i], a[href*='Logout' i], a:contains('Logout')").length > 0;
    const isLoginPage = page.url().includes('youLogin.jsp') || html.includes('id="btnLogin"');
    return hasLogout && !isLoginPage;
  } catch {
    return false;
  }
}