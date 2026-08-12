import crypto from 'crypto';
import { SRMSession } from '../types/srm.types';
import { BrowserContext, Page } from 'playwright';
import { supabase } from '../lib/supabase';

export const backendInstanceId = crypto.randomUUID();
export const processStartedAt = new Date().toISOString();

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
      captchaGeneratedAt: Date.now()
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
      
      const unauthTimeoutMs = (process.env.UNAUTHENTICATED_SESSION_TIMEOUT_MINUTES 
        ? parseInt(process.env.UNAUTHENTICATED_SESSION_TIMEOUT_MINUTES, 10) 
        : 5) * 60 * 1000;
      
      const authTimeoutMs = (process.env.SESSION_TIMEOUT_MINUTES 
        ? parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) 
        : 20) * 60 * 1000;

      for (const [id, session] of this.sessions.entries()) {
        const currentTimeout = session.authenticated ? authTimeoutMs : unauthTimeoutMs;
        if (now - session.lastActivityAt > currentTimeout) {
          console.log(`Session ${id} expired due to inactivity (${session.authenticated ? 'authenticated' : 'unauthenticated'}). sweeping...`);
          
          try {
            await supabase
              .from('application_sessions')
              .update({ status: 'EXPIRED', authenticated: false })
              .eq('id', id);
          } catch (e) {
            console.error(`Failed to update session ${id} status to EXPIRED in Supabase:`, e);
          }

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
