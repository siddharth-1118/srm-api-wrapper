import React, { useState, useEffect } from 'react';
import { 
  User, 
  Lock, 
  RefreshCw, 
  AlertCircle, 
  LogOut, 
  BookOpen, 
  Calendar, 
  Home, 
  Info,
  Compass,
  CheckCircle,
  ShieldAlert
} from 'lucide-react';


type Tab = 'profile' | 'dashboard' | 'grades' | 'exams' | 'hostel' | 'attendance';

interface ErrorType {
  code: string;
  message: string;
}

export default function App() {
  // Session / Auth State
  const [sessionId, setSessionId] = useState<string | null>(() => sessionStorage.getItem('sessionId'));
  const [authenticated, setAuthenticated] = useState<boolean>(() => sessionStorage.getItem('authenticated') === 'true');
  const [loading, setLoading] = useState<boolean>(false);
  const [globalError, setGlobalError] = useState<ErrorType | null>(null);

  // Login Form State
  const [netId, setNetId] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [captchaImg, setCaptchaImg] = useState<string | null>(null);
  const [captchaCode, setCaptchaCode] = useState<string>('');
  const [loginLoading, setLoginLoading] = useState<boolean>(false);

  // App Data State
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [profile, setProfile] = useState<any>(null);
  const [dashboard, setDashboard] = useState<any>(null);
  const [grades, setGrades] = useState<any>(null);
  const [exams, setExams] = useState<any>(null);
  const [hostel, setHostel] = useState<any>(null);
  const [attendance, setAttendance] = useState<any>(null);

  // Sub-navigation states
  const [selectedSemIdx, setSelectedSemIdx] = useState<number>(0);
  const [activeHostelSub, setActiveHostelSub] = useState<'booking' | 'details' | 'willingness'>('details');

  // Per-tab load & error states
  const [tabLoading, setTabLoading] = useState<Record<Tab, boolean>>({
    profile: false,
    dashboard: false,
    grades: false,
    exams: false,
    hostel: false,
    attendance: false,
  });
  const [tabErrors, setTabErrors] = useState<Record<Tab, ErrorType | null>>({
    profile: null,
    dashboard: null,
    grades: null,
    exams: null,
    hostel: null,
    attendance: null,
  });

  // 1. Initial Load: Start SRM Session and Fetch CAPTCHA
  useEffect(() => {
    if (!authenticated) {
      startSession();
    } else if (sessionId) {
      // Fetch initial data if authenticated
      fetchTabData('dashboard');
      fetchTabData('profile');
    }
  }, [authenticated]);

  const startSession = async (): Promise<string | null> => {
    setLoading(true);
    setGlobalError(null);
    setCaptchaImg(null);
    setCaptchaCode('');
    try {
      const resp = await fetch('/api/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await resp.json();
      if (data.success && data.sessionId) {
        setSessionId(data.sessionId);
        setCaptchaImg(data.captcha);
        sessionStorage.setItem('sessionId', data.sessionId);
        return data.sessionId;
      } else {
        setGlobalError(data.error || { code: 'SRM_UNAVAILABLE', message: 'Failed to initialize SRM portal.' });
        return null;
      }
    } catch (err) {
      setGlobalError({
        code: 'SRM_UNAVAILABLE',
        message: 'Could not connect to local backend wrapper. Verify the server is running.'
      });
      return null;
    } finally {
      setLoading(false);
    }
  };

  // 2. CAPTCHA Refresh — if session expired, restart a new session entirely
  const handleRefreshCaptcha = async (currentSessionId?: string) => {
    const sid = currentSessionId ?? sessionId;
    if (!sid) {
      await startSession();
      return;
    }
    setGlobalError(null);
    try {
      const resp = await fetch('/api/auth/captcha/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sid
        }
      });
      const data = await resp.json();
      if (data.success) {
        setCaptchaImg(data.captcha);
        setCaptchaCode('');
      } else {
        // Session expired or dead — restart a fresh session entirely
        await startSession();
      }
    } catch (err) {
      setGlobalError({ code: 'INTERNAL_ERROR', message: 'Failed to communicate with API server.' });
    }
  };

  // 3. Form Login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionId || !netId || !password || !captchaCode) return;

    setLoginLoading(true);
    setGlobalError(null);

    // Capture current sessionId at submit time to avoid state-update races
    const currentSessionId = sessionId;

    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': currentSessionId
        },
        body: JSON.stringify({
          sessionId: currentSessionId,
          netId: netId.trim(),
          password,
          captcha: captchaCode.trim()
        })
      });

      const data = await resp.json();

      if (data.success && data.authenticated === true) {
        // Preserve sessionId from the response (same session, confirmed by backend)
        const confirmedSessionId = data.sessionId || currentSessionId;
        setSessionId(confirmedSessionId);
        sessionStorage.setItem('sessionId', confirmedSessionId);
        setAuthenticated(true);
        sessionStorage.setItem('authenticated', 'true');
        fetchTabData('dashboard');
        fetchTabData('profile');
      } else {
        const errorCode = data.error?.code;
        setGlobalError(data.error || { code: 'AUTHENTICATION_UNKNOWN', message: 'Login failed. Please try again.' });
        // Only refresh captcha for captcha/credential errors, not session errors
        // For session errors, restart a completely fresh session
        if (errorCode === 'SESSION_EXPIRED') {
          await startSession();
        } else {
          // For INVALID_CAPTCHA or INVALID_CREDENTIALS, just get a new captcha
          await handleRefreshCaptcha(currentSessionId);
        }
      }
    } catch (err) {
      setGlobalError({ code: 'INTERNAL_ERROR', message: 'Login failed due to connection error.' });
    } finally {
      setLoginLoading(false);
    }
  };

  // 4. Logout
  const handleLogout = async () => {
    if (sessionId) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify({ sessionId })
      }).catch(() => {});
    }
    handleLocalLogout();
  };

  const handleLocalLogout = () => {
    setAuthenticated(false);
    setSessionId(null);
    setProfile(null);
    setDashboard(null);
    setGrades(null);
    setExams(null);
    setHostel(null);
    setAttendance(null);
    setSelectedSemIdx(0);
    setActiveHostelSub('details');
    sessionStorage.clear();
    startSession();
  };

  // 5. Unified Data Fetch per Tab
  const fetchTabData = async (tab: Tab) => {
    if (!sessionId) return;
    setTabLoading(prev => ({ ...prev, [tab]: true }));
    setTabErrors(prev => ({ ...prev, [tab]: null }));

    try {
      const resp = await fetch(`/api/student/${tab}`, {
        headers: {
          'X-Session-ID': sessionId
        }
      });
      const data = await resp.json();

      if (data.success) {
        if (tab === 'profile') setProfile(data.data);
        if (tab === 'dashboard') setDashboard(data.data);
        if (tab === 'grades') {
          setGrades(data.data);
          setSelectedSemIdx(0);
        }
        if (tab === 'exams') setExams(data.data);
        if (tab === 'hostel') setHostel(data.data);
        if (tab === 'attendance') setAttendance(data.data);
      } else {
        if (data.error?.code === 'SESSION_EXPIRED') {
          handleLocalLogout();
        } else {
          setTabErrors(prev => ({ ...prev, [tab]: data.error }));
        }
      }
    } catch (err) {
      setTabErrors(prev => ({
        ...prev,
        [tab]: { code: 'INTERNAL_ERROR', message: 'Failed to communicate with API server.' }
      }));
    } finally {
      setTabLoading(prev => ({ ...prev, [tab]: false }));
    }
  };

  // Switch tab and load data if needed
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    // Refresh data if not loaded or failed
    if (tab === 'dashboard' && !dashboard) fetchTabData('dashboard');
    if (tab === 'profile' && !profile) fetchTabData('profile');
    if (tab === 'grades' && !grades) fetchTabData('grades');
    if (tab === 'exams' && !exams) fetchTabData('exams');
    if (tab === 'hostel' && !hostel) fetchTabData('hostel');
    if (tab === 'attendance' && !attendance) fetchTabData('attendance');
  };

  // --------------------------------------------------------------------
  // RENDER LOGIN SCREEN
  // --------------------------------------------------------------------
  if (!authenticated) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', flex: 1 }}>
        {/* Left Informational Panel */}
        <div style={styles.loginLeftPanel}>
          <div style={styles.glassCard}>
            <span style={styles.tag}>Portal Portal Gateway</span>
            <h1 style={styles.portalTitle}>SRMIST Student Portal</h1>
            <p style={styles.portalDesc}>
              A secure, client-side, local-only API wrapper designed for real-time access to student academic transcripts, attendance figures, grade sheets, and hostel allotments.
            </p>
            
            <div style={styles.featureList}>
              <div style={styles.featureItem}>
                <Compass size={20} color="var(--accent-secondary)" />
                <div>
                  <h4 style={styles.featureHeading}>Zero Permanent Storage</h4>
                  <p style={styles.featureText}>Passwords and credentials are stored strictly in volatile Playwright process memory and are destroyed immediately upon logging out or after inactivity.</p>
                </div>
              </div>
              <div style={styles.featureItem}>
                <CheckCircle size={20} color="var(--accent-secondary)" />
                <div>
                  <h4 style={styles.featureHeading}>Manual CAPTCHA Entry</h4>
                  <p style={styles.featureText}>Ensures strict compliance by rendering the live portal CAPTCHA and verifying it using your own browser session context.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Form Card */}
        <div style={styles.loginRightPanel}>
          <div style={styles.loginFormCard}>
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <h2 style={{ fontSize: '24px', fontWeight: 600, color: 'var(--text-primary)' }}>Sign In to Portal</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>Access your real-time student companion dashboard</p>
            </div>

            {globalError && (
              <div style={styles.alertBox}>
                <AlertCircle size={20} style={{ flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14px' }}>
                    {globalError.code === 'INVALID_CAPTCHA' ? 'Incorrect CAPTCHA' : 
                     globalError.code === 'INVALID_CREDENTIALS' ? 'Access Denied' : 'System Notice'}
                  </div>
                  <div style={{ fontSize: '13px', opacity: 0.9, marginTop: '2px' }}>{globalError.message}</div>
                </div>
              </div>
            )}

            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={styles.fieldLabel}>NetID (Email username prefix)</label>
                <div style={styles.inputContainer}>
                  <User size={18} style={styles.inputIcon} />
                  <input 
                    type="text" 
                    placeholder="e.g. sv3824"
                    value={netId}
                    onChange={(e) => setNetId(e.target.value)}
                    required
                    style={styles.inputField}
                    disabled={loading || loginLoading}
                  />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <label style={{ ...styles.fieldLabel, marginBottom: 0 }}>Portal Password</label>
                  <a href="https://sp.srmist.edu.in/srmiststudentportal/students/loginManager/forgotPassword.jsp" target="_blank" rel="noopener noreferrer" style={styles.forgotLink}>Forgot password?</a>
                </div>
                <div style={styles.inputContainer}>
                  <Lock size={18} style={styles.inputIcon} />
                  <input 
                    type="password" 
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    style={styles.inputField}
                    disabled={loading || loginLoading}
                  />
                </div>
              </div>

              <div>
                <label style={styles.fieldLabel}>CAPTCHA Challenge</label>
                <div style={styles.captchaRow}>
                  <div style={styles.captchaBox}>
                    {captchaImg ? (
                      <img src={captchaImg} alt="CAPTCHA" style={styles.captchaImage} />
                    ) : (
                      <div style={styles.captchaLoader}>
                        <RefreshCw size={18} className="animate-spin" />
                      </div>
                    )}
                  </div>
                  <button 
                    type="button" 
                    onClick={() => handleRefreshCaptcha()} 
                    disabled={loading || loginLoading || !captchaImg}
                    style={styles.refreshButton}
                    title="Reload Captcha Image"
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </div>

              <div>
                <label style={styles.fieldLabel}>Verify CAPTCHA</label>
                <input 
                  type="text" 
                  placeholder="Enter CAPTCHA value"
                  value={captchaCode}
                  onChange={(e) => setCaptchaCode(e.target.value)}
                  required
                  style={styles.captchaInput}
                  disabled={loading || loginLoading || !captchaImg}
                  autoComplete="off"
                />
              </div>

              <button 
                type="submit" 
                disabled={loading || loginLoading || !captchaImg}
                style={styles.loginSubmitButton}
              >
                {loginLoading ? (
                  <>
                    <RefreshCw size={18} className="animate-spin" style={{ marginRight: '8px' }} />
                    Authenticating via Playwright...
                  </>
                ) : (
                  'Login to SRM Portal'
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------
  // RENDER MAIN AUTHENTICATED DASHBOARD
  // --------------------------------------------------------------------
  return (
    <div style={styles.dashboardContainer}>
      {/* Header Bar */}
      <header style={styles.dashboardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={styles.logoBadge}>SRM</div>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 600 }}>SRMIST Portal Companion</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              <span style={styles.activeDot}></span>
              <span>Active Session Context ID: {sessionId?.substring(0, 12)}...</span>
            </div>
          </div>
        </div>

        <button onClick={handleLogout} style={styles.logoutButton}>
          <LogOut size={16} />
          <span>Exit Session</span>
        </button>
      </header>

      {/* Main Inner Dashboard Layout */}
      <div style={styles.dashboardLayout}>
        {/* Navigation Sidebar */}
        <aside style={styles.sidebar}>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button 
              onClick={() => handleTabChange('dashboard')} 
              style={activeTab === 'dashboard' ? styles.sidebarBtnActive : styles.sidebarBtn}
            >
              <Compass size={18} />
              <span>Overview</span>
            </button>
            <button 
              onClick={() => handleTabChange('profile')} 
              style={activeTab === 'profile' ? styles.sidebarBtnActive : styles.sidebarBtn}
            >
              <User size={18} />
              <span>Personal Profile</span>
            </button>
            <button 
              onClick={() => handleTabChange('grades')} 
              style={activeTab === 'grades' ? styles.sidebarBtnActive : styles.sidebarBtn}
            >
              <BookOpen size={18} />
              <span>Grades & Credits</span>
            </button>
            <button 
              onClick={() => handleTabChange('exams')} 
              style={activeTab === 'exams' ? styles.sidebarBtnActive : styles.sidebarBtn}
            >
              <Calendar size={18} />
              <span>Exam Timetable</span>
            </button>
            <button 
              onClick={() => handleTabChange('hostel')} 
              style={activeTab === 'hostel' ? styles.sidebarBtnActive : styles.sidebarBtn}
            >
              <Home size={18} />
              <span>Hostel Allotment</span>
            </button>
            <button 
              onClick={() => handleTabChange('attendance')} 
              style={activeTab === 'attendance' ? styles.sidebarBtnActive : styles.sidebarBtn}
            >
              <CheckCircle size={18} />
              <span>Attendance</span>
            </button>
          </nav>

          <div style={styles.sidebarFooter}>
            <Info size={16} />
            <div>
              <div style={{ fontWeight: 500 }}>Local Wrapper Mode</div>
              <div style={{ fontSize: '10px', opacity: 0.8, marginTop: '2px' }}>Running on Express + Playwright</div>
            </div>
          </div>
        </aside>

        {/* Content Viewer Panel */}
        <main style={styles.contentPanel} className="animate-fade-in">
          {tabLoading[activeTab] ? (
            <div style={styles.tabCenterLoader}>
              <RefreshCw size={36} className="animate-spin" color="var(--accent-primary)" />
              <p style={{ marginTop: '16px', color: 'var(--text-secondary)', fontSize: '14px' }}>Extracting details from live portal...</p>
            </div>
          ) : tabErrors[activeTab] ? (
            <div style={styles.notAvailableCard}>
              {tabErrors[activeTab]?.code === 'NOT_AVAILABLE' ? (
                <>
                  <ShieldAlert size={48} color="var(--warning)" style={{ marginBottom: '16px' }} />
                  <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>No Data Available</h3>
                  <p style={{ color: 'var(--text-secondary)', marginTop: '8px', maxWidth: '420px', lineHeight: 1.6 }}>
                    {tabErrors[activeTab]?.message || 'This section has no data for your account on the SRM portal.'}
                  </p>
                </>
              ) : tabErrors[activeTab]?.code === 'SRM_NAVIGATION_FAILED' ? (
                <>
                  <ShieldAlert size={48} color="var(--warning)" style={{ marginBottom: '16px' }} />
                  <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>Navigation Not Found</h3>
                  <p style={{ color: 'var(--text-secondary)', marginTop: '8px', maxWidth: '420px', lineHeight: 1.6 }}>
                    Could not find the link for this section in your SRM dashboard. Check Dashboard tab for available navigation links.
                  </p>
                  <button onClick={() => fetchTabData(activeTab)} style={styles.tabRetryButton}>
                    <RefreshCw size={14} style={{ marginRight: '6px' }} />
                    Retry
                  </button>
                </>
              ) : tabErrors[activeTab]?.code === 'PARSER_NO_DATA' ? (
                <>
                  <AlertCircle size={48} color="var(--warning)" style={{ marginBottom: '16px' }} />
                  <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>Parser Found No Data</h3>
                  <p style={{ color: 'var(--text-secondary)', marginTop: '8px', maxWidth: '420px', lineHeight: 1.6 }}>
                    {tabErrors[activeTab]?.message || 'The page was loaded from SRM but no structured data was found in it.'}
                  </p>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '6px' }}>
                    Check <code style={{ background: 'rgba(255,255,255,0.1)', padding: '1px 4px', borderRadius: '3px' }}>backend/debug/</code> for the saved HTML snapshot.
                  </p>
                  <button onClick={() => fetchTabData(activeTab)} style={styles.tabRetryButton}>
                    <RefreshCw size={14} style={{ marginRight: '6px' }} />
                    Retry
                  </button>
                </>
              ) : tabErrors[activeTab]?.code === 'SESSION_EXPIRED' ? (
                <>
                  <AlertCircle size={48} color="var(--danger)" style={{ marginBottom: '16px' }} />
                  <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>Session Expired</h3>
                  <p style={{ color: 'var(--text-secondary)', marginTop: '8px', maxWidth: '400px', lineHeight: 1.6 }}>
                    Your SRM session has expired. Please sign in again.
                  </p>
                </>
              ) : (
                <>
                  <AlertCircle size={48} color="var(--danger)" style={{ marginBottom: '16px' }} />
                  <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>Extraction Failed</h3>
                  <p style={{ color: 'var(--text-secondary)', marginTop: '8px', maxWidth: '400px', lineHeight: 1.6 }}>
                    <strong style={{ color: 'var(--accent-secondary)', fontSize: '12px' }}>[{tabErrors[activeTab]?.code}]</strong>{' '}
                    {tabErrors[activeTab]?.message || 'Failed to extract portal data.'}
                  </p>
                  <button onClick={() => fetchTabData(activeTab)} style={styles.tabRetryButton}>
                    <RefreshCw size={14} style={{ marginRight: '6px' }} />
                    Retry Sync
                  </button>
                </>
              )}
            </div>

          ) : (
            // Render active tab contents
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: '22px', fontWeight: 600 }}>
                  {activeTab === 'dashboard' && 'Dashboard Overview'}
                  {activeTab === 'profile' && 'Student Profile'}
                  {activeTab === 'grades' && 'Academic Transcript'}
                  {activeTab === 'exams' && 'Provisional Exam Timetable'}
                  {activeTab === 'hostel' && 'Hostel Details'}
                  {activeTab === 'attendance' && 'Attendance Details'}
                </h2>
                <button onClick={() => fetchTabData(activeTab)} style={styles.syncBtn}>
                  <RefreshCw size={14} />
                  <span>Sync Portal</span>
                </button>
              </div>

              {/* OVERVIEW / DASHBOARD TAB */}
              {activeTab === 'dashboard' && dashboard && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                  {/* Discovery summary cards */}
                  <div style={styles.statGrid}>
                    <div style={styles.statCard}>
                      <div style={styles.statLabel}>SRM Page</div>
                      <div style={{ fontSize: '13px', color: 'var(--text-primary)', wordBreak: 'break-all', marginTop: '4px' }}>
                        {dashboard.pageTitle || 'Dashboard'}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Page title</div>
                    </div>
                    <div style={styles.statCard}>
                      <div style={styles.statLabel}>Nav Links</div>
                      <div style={styles.statValue}>{dashboard.rawSummary?.linksFound ?? dashboard.links?.length ?? '–'}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Discovered on page</div>
                    </div>
                    <div style={styles.statCard}>
                      <div style={styles.statLabel}>Data Tables</div>
                      <div style={styles.statValue}>{dashboard.rawSummary?.tablesFound ?? '–'}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Found on page</div>
                    </div>
                  </div>

                  {/* Discovered Navigation links */}
                  {dashboard.links && dashboard.links.length > 0 && (
                    <div style={styles.contentBlock}>
                      <h3 style={styles.blockTitle}>Discovered Navigation Links</h3>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {dashboard.links.map((link: any, idx: number) => (
                          <div key={idx} style={{ ...styles.noticeRow, display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                            <span style={{ fontSize: '11px', color: 'var(--accent-secondary)', minWidth: '20px' }}>{idx + 1}.</span>
                            <span style={styles.noticeText}>{link.text}</span>
                            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', wordBreak: 'break-all', flex: 1 }}>{link.href}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Raw label-value pairs extracted from page */}
                  {dashboard.labelValues && Object.keys(dashboard.labelValues).length > 0 && (
                    <div style={styles.contentBlock}>
                      <h3 style={styles.blockTitle}>Extracted Page Data</h3>
                      <table style={styles.table}>
                        <tbody>
                          {Object.entries(dashboard.labelValues).map(([label, value]: any, idx: number) => (
                            <tr key={idx}>
                              <td style={styles.tableLabel}>{label}</td>
                              <td style={styles.tableValue}>{value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Announcements */}
                  {dashboard.announcements && dashboard.announcements.length > 0 && (
                    <div style={styles.contentBlock}>
                      <h3 style={styles.blockTitle}>Announcements</h3>
                      {dashboard.announcements.map((msg: string, idx: number) => (
                        <div key={idx} style={{ ...styles.noticeRow, marginBottom: '6px' }}>
                          <div style={styles.noticeText}>{msg}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Raw tables discovered */}
                  {dashboard.tables && dashboard.tables.map((table: any, tableIdx: number) => (
                    table.rows.length > 0 && (
                      <div key={tableIdx} style={styles.contentBlock}>
                        <h3 style={styles.blockTitle}>Table {tableIdx + 1} — {table.rows.length} row(s)</h3>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={styles.table}>
                            <thead>
                              <tr>
                                {table.headers.map((h: string, i: number) => (
                                  <th key={i} style={styles.th}>{h || `Col ${i + 1}`}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {table.rows.slice(0, 20).map((row: any, rowIdx: number) => (
                                <tr key={rowIdx}>
                                  {table.headers.map((h: string, colIdx: number) => (
                                    <td key={colIdx} style={styles.tableValue}>{row[h] ?? '–'}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              )}

              {/* PROFILE TAB */}
              {activeTab === 'profile' && profile && (
                <div style={styles.contentBlock}>
                  <h3 style={styles.blockTitle}>Personal Profile Details</h3>
                  <table style={styles.table}>
                    <tbody>
                      {/* Normalized mapped fields first */}
                      {[
                        ['Full Name', profile.name],
                        ['Register Number', profile.registerNumber],
                        ['Student ID / NetID', profile.studentId],
                        ['Email ID', profile.email],
                        ['Institution', profile.institution],
                        ['Degree Program', profile.program],
                        ['Department', profile.department],
                        [`Semester / Section`, profile.semester && profile.section ? `Sem ${profile.semester} / ${profile.section}` : profile.semester ? `Sem ${profile.semester}` : profile.section],
                        ['Campus', profile.campus],
                        ['Admission Batch', profile.batch],
                        ['Faculty Advisor', profile.facultyAdvisor],
                      ].filter(([, v]) => v).map(([label, value], idx) => (
                        <tr key={`mapped-${idx}`}>
                          <td style={styles.tableLabel}>{label}</td>
                          <td style={styles.tableValue}>{value}</td>
                        </tr>
                      ))}
                      {/* Raw label-value pairs as fallback / supplement */}
                      {profile._rawLabelValues && Object.entries(profile._rawLabelValues).map(([label, value]: any, idx: number) => (
                        <tr key={`raw-${idx}`}>
                          <td style={{ ...styles.tableLabel, color: 'var(--text-secondary)' }}>{label}</td>
                          <td style={styles.tableValue}>{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Raw profile tables */}
                  {profile._tables && profile._tables.map((table: any, tableIdx: number) => (
                    table.rows.length > 0 && (
                      <div key={tableIdx} style={{ marginTop: '20px' }}>
                        <h4 style={{ ...styles.blockTitle, fontSize: '14px' }}>Table {tableIdx + 1}</h4>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={styles.table}>
                            <thead>
                              <tr>{table.headers.map((h: string, i: number) => <th key={i} style={styles.th}>{h || `Col ${i + 1}`}</th>)}</tr>
                            </thead>
                            <tbody>
                              {table.rows.map((row: any, rowIdx: number) => (
                                <tr key={rowIdx}>
                                  {table.headers.map((h: string, colIdx: number) => (
                                    <td key={colIdx} style={styles.tableValue}>{row[h] ?? '–'}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              )}

              {/* GRADES TAB */}
              {activeTab === 'grades' && grades && (() => {
                const sems = grades.semesters || [];
                if (sems.length === 0) {
                  return <div style={styles.emptyMsg}>No grades data loaded from SRM.</div>;
                }
                const activeSem = sems[selectedSemIdx] || sems[0];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {/* Semester selector dropdown */}
                    <div style={styles.contentBlock}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                        <h3 style={{ ...styles.blockTitle, marginBottom: 0 }}>Grades & Transcripts</h3>
                        {sems.length > 1 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Select Semester:</label>
                            <select
                              value={selectedSemIdx}
                              onChange={(e) => setSelectedSemIdx(Number(e.target.value))}
                              style={{
                                background: '#1e293b',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '6px',
                                color: '#fff',
                                padding: '6px 12px',
                                fontSize: '13px',
                                outline: 'none'
                              }}
                            >
                              {sems.map((s: any, idx: number) => (
                                <option key={idx} value={idx}>
                                  {s.semester} {s.academicYear ? `(${s.academicYear})` : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Summary statistics */}
                    {activeSem.summary && (
                      <div style={styles.statGrid}>
                        <div style={styles.statCard}>
                          <div style={styles.statLabel}>SGPA</div>
                          <div style={{ ...styles.statValue, color: 'var(--accent-secondary)' }}>
                            {activeSem.summary.sgpa ?? activeSem.summary.gpa ?? 'N/A'}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Semester Grade Point Average</div>
                        </div>
                        <div style={styles.statCard}>
                          <div style={styles.statLabel}>CGPA</div>
                          <div style={{ ...styles.statValue, color: 'var(--accent-secondary)' }}>
                            {activeSem.summary.cgpa ?? 'N/A'}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Cumulative Grade Point Average</div>
                        </div>
                        <div style={styles.statCard}>
                          <div style={styles.statLabel}>Credits Earned</div>
                          <div style={styles.statValue}>{activeSem.summary.totalCredits ?? '–'}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Credits completed</div>
                        </div>
                      </div>
                    )}

                    {/* Courses table */}
                    {activeSem.courses && activeSem.courses.length > 0 ? (
                      <div style={styles.contentBlock}>
                        <h4 style={styles.blockTitle}>{activeSem.semester} Course Grades</h4>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={styles.table}>
                            <thead>
                              <tr>
                                {/* Dynamic headers from course objects */}
                                {Object.keys(activeSem.courses[0]).filter(k => k !== '_raw').map((header, i) => (
                                  <th key={i} style={styles.th}>
                                    {header === 'code'           ? 'Course Code'
                                    : header === 'name'          ? 'Course Title'
                                    : header === 'internalMarks' ? 'Internal'
                                    : header === 'externalMarks' ? 'External'
                                    : header === 'totalMarks'    ? 'Total Marks'
                                    : header === 'grade'         ? 'Grade'
                                    : header === 'gradePoint'    ? 'Grade Point'
                                    : header === 'credits'       ? 'Credits'
                                    : header === 'status'        ? 'Status'
                                    : header === 'courseType'    ? 'Type'
                                    : header}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {activeSem.courses.map((c: any, rowIdx: number) => (
                                <tr key={rowIdx}>
                                  {Object.keys(c).filter(k => k !== '_raw').map((key, colIdx) => {
                                    const val = c[key];
                                    if (key === 'grade' && val) {
                                      const isPass = val !== 'F' && val !== 'W' && val !== 'Ab';
                                      return (
                                        <td key={colIdx} style={{ ...styles.tableValue, textAlign: 'center' }}>
                                          <span style={isPass ? styles.gradePillO : styles.gradePillF}>
                                            {val}
                                          </span>
                                        </td>
                                      );
                                    }
                                    if (key === 'status' && val) {
                                      const isPass = (val as string).toLowerCase().includes('pass') || (val as string).toLowerCase().includes('eligible');
                                      return (
                                        <td key={colIdx} style={{ ...styles.tableValue, textAlign: 'center' }}>
                                          <span style={isPass ? styles.statusPill : { ...styles.statusPill, background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                                            {val}
                                          </span>
                                        </td>
                                      );
                                    }
                                    return (
                                      <td key={colIdx} style={styles.tableValue}>{val ?? '–'}</td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : (
                      <div style={styles.emptyMsg}>No courses registered for this semester.</div>
                    )}
                  </div>
                );
              })()}

              {/* EXAMS TAB */}
              {activeTab === 'exams' && exams && (
                <div style={styles.contentBlock}>
                  <h3 style={styles.blockTitle}>Exam Timetable</h3>
                  {exams.headers && exams.timetable && exams.timetable.length > 0 ? (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            {exams.headers.map((h: string, i: number) => (
                              <th key={i} style={styles.th}>{h || `Col ${i + 1}`}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {exams.timetable.map((row: any, rowIdx: number) => (
                            <tr key={rowIdx}>
                              {exams.headers.map((h: string, colIdx: number) => (
                                <td key={colIdx} style={styles.tableValue}>{row[h] ?? '–'}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={styles.emptyMsg}>No upcoming exams registered on the portal.</div>
                  )}
                </div>
              )}

              {/* HOSTEL TAB */}
              {activeTab === 'hostel' && hostel && (() => {
                const sub = hostel[activeHostelSub] || { success: false, error: { message: 'Data not loaded.' } };
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {/* Hostel Sub-navigation Tabs */}
                    <div style={styles.contentBlock}>
                      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        {(['details', 'booking', 'willingness'] as const).map((subTab) => (
                          <button
                            key={subTab}
                            onClick={() => setActiveHostelSub(subTab)}
                            style={{
                              ...(activeHostelSub === subTab ? styles.sidebarBtnActive : styles.sidebarBtn),
                              padding: '8px 16px',
                              borderRadius: '6px',
                              flex: 1,
                              textAlign: 'center',
                              justifyContent: 'center',
                              margin: 0
                            }}
                          >
                            {subTab === 'booking' && 'Hostel Booking'}
                            {subTab === 'details' && 'Hostel Details'}
                            {subTab === 'willingness' && 'Hostel Willingness'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Subsection content */}
                    {sub.success !== false ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                        {/* Status / Alert text from portal */}
                        {sub.data?.statusText && (
                          <div style={{
                            padding: '12px 16px',
                            background: 'rgba(59, 130, 246, 0.15)',
                            border: '1px solid rgba(59, 130, 246, 0.3)',
                            borderRadius: '8px',
                            color: '#60a5fa',
                            fontSize: '13px',
                            lineHeight: 1.5
                          }}>
                            <strong>Portal Message:</strong> {sub.data.statusText}
                          </div>
                        )}

                        {/* Label value pairs */}
                        {sub.data?.labelValues && Object.keys(sub.data.labelValues).length > 0 && (
                          <div style={styles.contentBlock}>
                            <h4 style={styles.blockTitle}>Information Details</h4>
                            <table style={styles.table}>
                              <tbody>
                                {Object.entries(sub.data.labelValues).map(([label, value]: any, idx: number) => (
                                  <tr key={idx}>
                                    <td style={styles.tableLabel}>{label}</td>
                                    <td style={styles.tableValue}>{value}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* Tables */}
                        {sub.data?.tables && sub.data.tables.map((table: any, tableIdx: number) => (
                          table.rows.length > 0 && (
                            <div key={tableIdx} style={styles.contentBlock}>
                              <h4 style={styles.blockTitle}>
                                {table.headers.join(' | ').toLowerCase().includes('payment') ? 'Payment History' : `Allotment Table ${tableIdx + 1}`}
                              </h4>
                              <div style={{ overflowX: 'auto' }}>
                                <table style={styles.table}>
                                  <thead>
                                    <tr>
                                      {table.headers.map((h: string, i: number) => (
                                        <th key={i} style={styles.th}>{h || `Col ${i + 1}`}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {table.rows.map((row: any, rowIdx: number) => (
                                      <tr key={rowIdx}>
                                        {table.headers.map((h: string, colIdx: number) => (
                                          <td key={colIdx} style={styles.tableValue}>{row[h] ?? '–'}</td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )
                        ))}

                        {/* If nothing is in the successful subpage */}
                        {(!sub.data?.labelValues || Object.keys(sub.data.labelValues).length === 0) &&
                         (!sub.data?.tables || sub.data.tables.length === 0) && (
                          <div style={styles.emptyMsg}>No structured details found on this subpage.</div>
                        )}

                      </div>
                    ) : (
                      <div style={{
                        ...styles.notAvailableCard,
                        margin: 0,
                        padding: '30px',
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px dashed rgba(255,255,255,0.1)'
                      }}>
                        <h4 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>Section Not Available</h4>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '6px', maxWidth: '380px', lineHeight: 1.5 }}>
                          {sub.error?.message || 'This section is not configured or not accessible for your portal profile.'}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ATTENDANCE TAB */}
              {activeTab === 'attendance' && attendance && (() => {
                const subs: any[] = attendance.courseWiseAttendance || [];
                const charts: any[] = attendance.courseWiseChart || [];
                const hours = attendance.attendanceHours || {};
                const cumulative: any[] = attendance.cumulativeAttendance || [];
                
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                    {/* Summary cards */}
                    <div style={styles.statGrid}>
                      <div style={styles.statCard}>
                        <div style={styles.statLabel}>Overall Attendance</div>
                        <div style={{
                          ...styles.statValue,
                          color: attendance.overallPercentage >= 75
                            ? '#22c55e'
                            : attendance.overallPercentage >= 65
                              ? '#f59e0b'
                              : '#ef4444'
                        }}>
                          {attendance.overallPercentage != null
                            ? `${attendance.overallPercentage}%`
                            : '–'}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Calculated overall</div>
                      </div>
                      <div style={styles.statCard}>
                        <div style={styles.statLabel}>Hours Present</div>
                        <div style={{ ...styles.statValue, color: '#22c55e' }}>{hours.presentHours ?? '–'}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Total attended hours</div>
                      </div>
                      <div style={styles.statCard}>
                        <div style={styles.statLabel}>Hours Absent</div>
                        <div style={{ ...styles.statValue, color: hours.absentHours > 0 ? '#ef4444' : 'var(--text-secondary)' }}>{hours.absentHours ?? '–'}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Total missed hours</div>
                      </div>
                      <div style={styles.statCard}>
                        <div style={styles.statLabel}>Subjects</div>
                        <div style={styles.statValue}>{subs.length || charts.length}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Registered courses</div>
                      </div>
                    </div>

                    {/* Metadata & Period Alert */}
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                      padding: '16px',
                      background: 'rgba(255,255,255,0.03)',
                      borderRadius: '10px',
                      border: '1px solid rgba(255,255,255,0.07)',
                      fontSize: '13px',
                    }}>
                      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                        {attendance.semester && (
                          <span><span style={{ color: 'var(--text-secondary)' }}>Semester: </span><strong>{attendance.semester}</strong></span>
                        )}
                        {attendance.academicYear && (
                          <span><span style={{ color: 'var(--text-secondary)' }}>Academic Year: </span><strong>{attendance.academicYear}</strong></span>
                        )}
                        {attendance.section && (
                          <span><span style={{ color: 'var(--text-secondary)' }}>Section: </span><strong>{attendance.section}</strong></span>
                        )}
                      </div>
                      {(attendance.metadata?.periodStart || attendance.metadata?.periodEnd) && (
                        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px', color: 'var(--accent-secondary)' }}>
                          <strong>Attendance Period:</strong> {attendance.metadata.periodStart || '–'} To {attendance.metadata.periodEnd || '–'}
                        </div>
                      )}
                    </div>

                    {/* Visual Progress Chart Panels */}
                    {charts.length > 0 && (
                      <div style={styles.contentBlock}>
                        <h3 style={styles.blockTitle}>Course-wise Attendance Chart</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
                          {charts.map((c: any, i: number) => {
                            const pct = c.percentage ?? 0;
                            const color = pct >= 75 ? '#22c55e' : pct >= 65 ? '#f59e0b' : '#ef4444';
                            return (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                                <div style={{ width: '90px', fontWeight: 600, fontSize: '13px' }}>{c.courseCode}</div>
                                <div style={{ flex: 1, height: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '4px', transition: 'width 0.5s ease' }}></div>
                                </div>
                                <div style={{ width: '45px', textAlign: 'right', fontWeight: 700, fontSize: '13px', color }}>{pct}%</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Subject-wise table */}
                    {subs.length > 0 ? (
                      <div style={styles.contentBlock}>
                        <h3 style={styles.blockTitle}>Course Wise Attendance Table</h3>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={styles.table}>
                            <thead>
                              <tr>
                                {Object.keys(subs[0]).filter(k => k !== 'additionalFields').map((header, i) => (
                                  <th key={i} style={styles.th}>
                                    {header === 'code'            ? 'Code'
                                    : header === 'description'     ? 'Description'
                                    : header === 'maxHours'        ? 'Max. Hours'
                                    : header === 'attendanceHours' ? 'Att. Hours'
                                    : header === 'absentHours'     ? 'Absent Hours'
                                    : header === 'totalPercentage' ? 'Total Percentage'
                                    : header}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {subs.map((sub: any, rowIdx: number) => (
                                <tr key={rowIdx}>
                                  {Object.keys(sub).filter(k => k !== 'additionalFields').map((key, colIdx) => {
                                    const val = sub[key];
                                    if (key === 'totalPercentage' && val != null) {
                                      const pct = Number(val);
                                      const color = pct >= 75 ? '#22c55e' : pct >= 65 ? '#f59e0b' : '#ef4444';
                                      return (
                                        <td key={colIdx} style={{ ...styles.tableValue, textAlign: 'center' }}>
                                          <span style={{
                                            background: `${color}22`,
                                            color,
                                            border: `1px solid ${color}44`,
                                            borderRadius: '20px',
                                            padding: '2px 10px',
                                            fontWeight: 700,
                                            fontSize: '13px',
                                          }}>
                                            {pct}%
                                          </span>
                                        </td>
                                      );
                                    }
                                    return (
                                      <td key={colIdx} style={styles.tableValue}>{val ?? '–'}</td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : (
                      <div style={styles.emptyMsg}>No subject rows returned from SRM.</div>
                    )}

                    {/* Cumulative Attendance Table */}
                    {cumulative.length > 0 && (
                      <div style={styles.contentBlock}>
                        <h3 style={styles.blockTitle}>Cumulative Attendance (In Hours)</h3>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={styles.table}>
                            <thead>
                              <tr>
                                <th style={styles.th}>Month / Year</th>
                                <th style={styles.th}>Present</th>
                                <th style={styles.th}>Absent</th>
                              </tr>
                            </thead>
                            <tbody>
                              {cumulative.map((row: any, idx: number) => (
                                <tr key={idx}>
                                  <td style={styles.tableValue}><strong>{row.monthYear}</strong></td>
                                  <td style={{ ...styles.tableValue, color: '#22c55e', fontWeight: 600 }}>{row.present ?? '–'}</td>
                                  <td style={{ ...styles.tableValue, color: row.absent > 0 ? '#ef4444' : 'var(--text-secondary)' }}>{row.absent ?? '–'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Debug info during dev */}
                    {attendance._debug && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '8px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <strong>Debug:</strong> URL: {attendance._debug.url} &nbsp;|&nbsp;
                        Tables found: {attendance._debug.tablesFound} &nbsp;|&nbsp;
                        Rows found: {attendance._debug.rowsFound} &nbsp;|&nbsp;
                        Headers: {attendance._debug.rawHeaders?.join(' | ')}
                      </div>
                    )}

                  </div>
                );
              })()}

            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// RAW INLINE VANILLA STYLING FOR MAXIMUM PORTABILITY
// --------------------------------------------------------------------
const styles = {
  // Login Panel Split Layout
  loginLeftPanel: {
    flex: 1.2,
    background: 'radial-gradient(circle at 10% 20%, #1e3a8a 0%, #0f172a 90%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '40px',
  },
  loginRightPanel: {
    flex: 1,
    backgroundColor: '#0b0f19',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '40px',
  },
  glassCard: {
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '16px',
    padding: '40px',
    maxWidth: '520px',
    backdropFilter: 'blur(12px)',
  },
  tag: {
    display: 'inline-block',
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    color: '#60a5fa',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    padding: '4px 10px',
    borderRadius: '20px',
    marginBottom: '16px',
  },
  portalTitle: {
    fontSize: '32px',
    fontWeight: 700,
    color: '#fff',
    lineHeight: 1.2,
    marginBottom: '12px',
  },
  portalDesc: {
    color: '#9ca3af',
    fontSize: '15px',
    lineHeight: 1.6,
    marginBottom: '32px',
  },
  featureList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '20px',
  },
  featureItem: {
    display: 'flex',
    gap: '14px',
    alignItems: 'flex-start',
  },
  featureHeading: {
    color: '#f3f4f6',
    fontWeight: 600,
    fontSize: '14px',
    marginBottom: '2px',
  },
  featureText: {
    color: '#9ca3af',
    fontSize: '12px',
    lineHeight: 1.5,
  },

  // Login Form Right panel Card
  loginFormCard: {
    width: '100%',
    maxWidth: '400px',
    backgroundColor: '#131a2d',
    border: '1px solid var(--border)',
    borderRadius: '16px',
    padding: '32px',
    boxShadow: 'var(--shadow-lg)',
  },
  alertBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.25)',
    color: '#fca5a5',
    padding: '12px 16px',
    borderRadius: '8px',
    marginBottom: '20px',
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-start',
  },
  fieldLabel: {
    display: 'block',
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    marginBottom: '6px',
  },
  inputContainer: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
  },
  inputIcon: {
    position: 'absolute' as const,
    left: '12px',
    color: 'var(--text-muted)',
  },
  inputField: {
    width: '100%',
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    padding: '10px 12px 10px 38px',
    color: '#fff',
    fontSize: '14px',
    outline: 'none',
  },
  forgotLink: {
    fontSize: '12px',
    color: 'var(--accent-secondary)',
    textDecoration: 'none',
  },
  captchaRow: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
  },
  captchaBox: {
    flex: 1,
    height: '46px',
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captchaImage: {
    maxHeight: '100%',
    width: 'auto',
    objectFit: 'contain' as const,
  },
  captchaLoader: {
    color: 'var(--text-muted)',
  },
  refreshButton: {
    height: '46px',
    width: '46px',
    backgroundColor: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captchaInput: {
    width: '100%',
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    padding: '10px 12px',
    color: '#fff',
    fontSize: '14px',
    outline: 'none',
  },
  loginSubmitButton: {
    backgroundColor: '#3b82f6',
    border: 'none',
    color: '#fff',
    fontWeight: 600,
    fontSize: '14px',
    padding: '12px',
    borderRadius: '8px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: '10px',
  },

  // Authenticated Dashboard Layout
  dashboardContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: '100vh',
    backgroundColor: 'var(--bg-primary)',
  },
  dashboardHeader: {
    height: '70px',
    backgroundColor: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0 24px',
  },
  logoBadge: {
    backgroundColor: 'var(--accent-primary)',
    color: '#fff',
    fontWeight: 700,
    fontSize: '14px',
    padding: '6px 10px',
    borderRadius: '6px',
  },
  activeDot: {
    width: '8px',
    height: '8px',
    backgroundColor: '#10b981',
    borderRadius: '50%',
  },
  logoutButton: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.25)',
    color: '#ef4444',
    fontSize: '13px',
    fontWeight: 500,
    padding: '8px 14px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
  },
  dashboardLayout: {
    display: 'flex',
    flex: 1,
  },
  sidebar: {
    width: '260px',
    backgroundColor: 'var(--bg-secondary)',
    borderRight: '1px solid var(--border)',
    padding: '24px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between',
  },
  sidebarBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    padding: '10px 12px',
    borderRadius: '8px',
    fontSize: '14px',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  sidebarBtnActive: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    backgroundColor: 'var(--bg-tertiary)',
    border: 'none',
    color: 'var(--accent-secondary)',
    padding: '10px 12px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  sidebarFooter: {
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    fontSize: '11px',
    color: 'var(--text-muted)',
    borderTop: '1px solid var(--border)',
    paddingTop: '16px',
  },
  contentPanel: {
    flex: 1,
    padding: '30px',
    overflowY: 'auto' as const,
  },
  tabCenterLoader: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '260px',
  },
  notAvailableCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '16px',
    padding: '40px',
    textAlign: 'center' as const,
    minHeight: '280px',
  },
  tabRetryButton: {
    marginTop: '20px',
    backgroundColor: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    padding: '8px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  syncBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    padding: '6px 12px',
    borderRadius: '6px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  statGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '16px',
  },
  statCard: {
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '12px',
    padding: '20px',
  },
  statLabel: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
  },
  statValue: {
    fontSize: '28px',
    fontWeight: 700,
    color: 'var(--accent-secondary)',
    marginTop: '6px',
  },
  contentBlock: {
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '16px',
    padding: '24px',
  },
  blockTitle: {
    fontSize: '16px',
    fontWeight: 600,
    marginBottom: '16px',
    color: 'var(--text-primary)',
  },
  noticeRow: {
    padding: '12px',
    borderBottom: '1px solid var(--border)',
    backgroundColor: 'rgba(255, 255, 255, 0.01)',
  },
  noticeDate: {
    fontSize: '11px',
    color: 'var(--accent-secondary)',
    fontWeight: 500,
  },
  noticeType: {
    fontSize: '10px',
    backgroundColor: 'var(--bg-tertiary)',
    padding: '2px 6px',
    borderRadius: '4px',
    color: 'var(--text-secondary)',
  },
  noticeText: {
    marginTop: '6px',
    fontSize: '13px',
    lineHeight: 1.4,
  },
  emptyMsg: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    textAlign: 'center' as const,
    padding: '20px 0',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  },
  tableLabel: {
    padding: '12px 16px',
    width: '30%',
    color: 'var(--text-secondary)',
    fontSize: '14px',
    borderBottom: '1px solid var(--border)',
    fontWeight: 500,
  },
  tableValue: {
    padding: '12px 16px',
    color: '#fff',
    fontSize: '14px',
    borderBottom: '1px solid var(--border)',
  },
  th: {
    padding: '12px 16px',
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderBottom: '1px solid var(--border)',
    textAlign: 'left' as const,
    color: 'var(--text-secondary)',
    fontWeight: 600,
    fontSize: '13px',
  },
  statusPill: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    color: '#10b981',
    border: '1px solid rgba(16, 185, 129, 0.3)',
    fontSize: '12px',
    fontWeight: 500,
    padding: '2px 8px',
    borderRadius: '4px',
  },
  gradePillO: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    color: '#60a5fa',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    fontSize: '12px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '4px',
  },
  gradePillF: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    color: '#fca5a5',
    border: '1px solid rgba(239, 68, 68, 0.2)',
    fontSize: '12px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '4px',
  }
};
