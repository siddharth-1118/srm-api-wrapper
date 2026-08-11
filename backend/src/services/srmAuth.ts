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
    
    // Clear fields first using playwright
    await page.fill('#username', '');
    await page.fill('#password', '');
    await page.fill('#captcha', '');

    // Simulate natural mouse movements across the screen to trigger telemetry listeners
    console.log("[SRM AUTH] Simulating human-like mouse movements...");
    await page.mouse.move(100, 100);
    await page.mouse.move(250, 180, { steps: 5 });
    await page.mouse.move(500, 320, { steps: 8 });
    
    // Click on the body once to generate a click event
    await page.mouse.click(50, 50, { delay: 50 });

    // Focus and type NetID character-by-character
    console.log("[SRM AUTH] Typing username...");
    await page.mouse.move(400, 200, { steps: 5 });
    await page.click('#username', { delay: 100 });
    await page.type('#username', netId, { delay: 75 });

    // Move to and type Password character-by-character
    console.log("[SRM AUTH] Typing password...");
    await page.mouse.move(400, 280, { steps: 5 });
    await page.click('#password', { delay: 100 });
    await page.type('#password', password, { delay: 75 });

    // Move to and type CAPTCHA character-by-character
    console.log("[SRM AUTH] Typing captcha...");
    await page.mouse.move(400, 360, { steps: 5 });
    await page.click('#captcha', { delay: 100 });
    await page.type('#captcha', captcha, { delay: 75 });

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

    while (attempts < 10) {
      finalUrl = page.url();
      html = await page.content();
      $ = cheerio.load(html);

      dashboardDetected = finalUrl.toLowerCase().includes('dashboard') || 
                           finalUrl.toLowerCase().includes('home') || 
                           html.includes('id="dashboard"') || 
                           html.includes('dashboard-title');
      
      logoutDetected = $("a[href*='logout' i], a[href*='Logout' i], a:contains('Logout'), a:contains('Sign Out')").length > 0;
      
      loginErrorDetected = $(".alert-danger, .validation-summary-errors, [id*='Error' i], [class*='error-message' i]").length > 0;
      
      if (loginErrorDetected) {
        $(".alert-danger, .validation-summary-errors, [id*='Error' i], [class*='error-message' i]").each((_, el) => {
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
                                 html.toLowerCase().includes('invalid captcha');
    
    const isSuccess = dashboardDetected || logoutDetected;
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