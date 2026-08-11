import crypto from 'crypto';
import { SRMSession } from '../types/srm.types';
import { BrowserContext, Page } from 'playwright';

class SessionStore {
  private sessions = new Map<string, SRMSession>();
  private sweeperInterval: NodeJS.Timeout | null = null;
  private timeoutMs = 20 * 60 * 1000; // 20 minutes default

  constructor() {
    this.startSweeper();
  }

  public setTimeoutMinutes(minutes: number) {
    this.timeoutMs = minutes * 60 * 1000;
  }

  public createSession(sessionId: string, browserContext: BrowserContext, page: Page): SRMSession {
    const session: SRMSession = {
      sessionId,
      browserContext,
      page,
      state: 'CAPTCHA_REQUIRED',
      authenticated: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  public getSession(sessionId: string): SRMSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastActivityAt = Date.now();
    return session;
  }

  public async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    console.log(`Destroying session: ${sessionId}`);

    try {
      if (!session.page.isClosed()) {
        await session.page.close().catch(() => {});
      }
      await session.browserContext.close().catch(() => {});
    } catch (err) {
      console.error(`Error closing session resources for ${sessionId}:`, err);
    }
  }

  private startSweeper() {
    if (this.sweeperInterval) return;
    this.sweeperInterval = setInterval(async () => {
      const now = Date.now();
      for (const [id, session] of this.sessions.entries()) {
        if (now - session.lastActivityAt > this.timeoutMs) {
          console.log(`Session ${id} expired due to inactivity. sweeping...`);
          await this.destroySession(id);
        }
      }
    }, 30 * 1000); // Check every 30 seconds
    
    if (this.sweeperInterval && typeof this.sweeperInterval.unref === 'function') {
      this.sweeperInterval.unref();
    }
  }

  public async destroyAll(): Promise<void> {
    if (this.sweeperInterval) {
      clearInterval(this.sweeperInterval);
      this.sweeperInterval = null;
    }
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.destroySession(id);
    }
  }
}

export const sessionStore = new SessionStore();
export function generateSessionId(): string {
  // Generate cryptographically secure random session ID
  return crypto.randomBytes(32).toString('hex');
}
