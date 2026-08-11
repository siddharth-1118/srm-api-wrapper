import { Page } from 'playwright';

export async function getCaptchaScreenshot(page: Page): Promise<string> {
  // Wait for the captcha image to be present and visible
  const captchaElement = await page.waitForSelector('#secure_captcha', { state: 'visible', timeout: 10000 });
  
  // Wait a short duration (500ms) to ensure the JavaScript fetches and draws the Blob URL content
  await page.waitForTimeout(500);
  
  const buffer = await captchaElement.screenshot();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

export async function refreshCaptcha(page: Page): Promise<string> {
  // Check if refresh button is visible
  const refreshBtn = await page.waitForSelector('#btnRefresh', { state: 'visible', timeout: 5000 });
  await refreshBtn.click();
  
  // Allow time for the new CAPTCHA blob request to resolve
  await page.waitForTimeout(1000);
  
  return getCaptchaScreenshot(page);
}
