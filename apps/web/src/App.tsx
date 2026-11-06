import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertCircle, ArrowUpRight, CalendarClock, Check, Clock3, LayoutDashboard, LoaderCircle,
  LogOut, Mail, Menu, Plus, Search, Send, Settings, ShieldCheck, Trash2, Users, X,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingTable, OfflineBanner } from './components/AppStates';
import { ComposeEditor, type LocalAttachment } from './components/ComposeEditor';

type View = 'emailDetails' | 'scheduled' | 'sent' | 'search' | 'senders' | 'settings' | 'compose';
const viewPaths: Record<View, string> = { emailDetails: '/email-details', scheduled: '/scheduled', sent: '/sent', search: '/search', senders: '/senders', settings: '/settings', compose: '/compose' };
function viewFromPath(path: string): View | null { if (path === '/') return 'scheduled'; return (Object.entries(viewPaths).find(([, route]) => route === path)?.[0] as View | undefined) || null; }
type User = { id: string; email: string; name: string; avatarUrl?: string | null };
type Sender = { id: string; email: string; name: string; hourlyLimit: number; status: 'ACTIVE' | 'DISCONNECTED' | 'PAUSED'; createdAt: string };
type Campaign = {
  id: string; subject: string; senderId: string; sender: Sender; scheduledAt: string;
  status: string; totalRecipients: number; sentCount: number; failedCount: number;
  delayBetweenSeconds: number; createdAt: string; _count?: { jobs: number };
};
type EmailItem = {
  id: string; campaignId?: string; recipientEmail: string; senderEmail: string; senderName: string; subject: string;
  bodyText: string; status: typeof emailStatuses[number]; scheduledAt: string; sentAt?: string | null;
  errorMessage?: string | null; etherealPreviewUrl?: string | null; deferredReason?: string | null;
};
type CampaignDetail = Campaign & { body: string; jobs: EmailItem[] };
type ApiEnvelope<T> = { success: boolean; data?: T; error?: { code: string; message: string } };
const emailStatuses = ['SCHEDULED', 'QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'DEFERRED', 'UNKNOWN', 'CANCELLED'] as const;

function parseRecipients(raw: string) {
  const tokens = raw.split(/[\r\n,;]+/).map((entry) => entry.trim()).filter(Boolean);
  const validEmails: string[] = [];
  const invalidEntries: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const cleaned = token.replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
      if (!seen.has(cleaned)) { seen.add(cleaned); validEmails.push(cleaned); }
    } else invalidEntries.push(token);
  }
  return { validEmails, invalidEntries };
}

function parseCsvRecipientText(raw: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"' && quoted && raw[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && raw[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return '';
  const headerIndex = rows[0].findIndex((value) => /^(email|e-mail|recipient|recipient email|email address)$/i.test(value.trim()));
  if (headerIndex >= 0) return rows.slice(1).map((values) => values[headerIndex] || '').filter(Boolean).join('\n');
  return rows.flat().filter(Boolean).join('\n');
}

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    signal: init.signal ?? AbortSignal.timeout(15_000),
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || !payload.success) {
    if (response.status === 401 && url !== '/api/auth/session') window.dispatchEvent(new Event('reachinbox:session-expired'));
    throw new ApiError(payload.error?.message || `Request failed (${response.status}).`, response.status, payload.error?.code);
  }
  return payload.data as T;
}

const statusStyle: Record<string, string> = {
  SCHEDULED: 'bg-blue-50 text-blue-700 ring-blue-600/10',
  QUEUED: 'bg-blue-50 text-blue-700 ring-blue-600/10',
  PROCESSING: 'bg-amber-50 text-amber-700 ring-amber-600/10',
  SENT: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
  FAILED: 'bg-rose-50 text-rose-700 ring-rose-600/10',
  DEFERRED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
  UNKNOWN: 'bg-slate-100 text-slate-700 ring-slate-500/10',
  DISCONNECTED: 'bg-slate-100 text-slate-500 ring-slate-500/10',
  CANCELLED: 'bg-slate-100 text-slate-600 ring-slate-500/10',
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
};

function StatusPill({ status }: { status: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusStyle[status] || statusStyle.UNKNOWN}`}>{status.toLowerCase().replace(/_/g, ' ')}</span>;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function deferredReasonLabel(reason?: string | null) {
  if (reason === 'HOURLY_LIMIT') return 'The hourly limit was reached. Sending will resume in the next window.';
  if (reason === 'MINIMUM_DELAY') return 'Waiting for the configured sender delay.';
  if (reason === 'SCHEDULED_START') return 'Waiting for the scheduled start time.';
  return 'Waiting to retry.';
}

function localDateTimeValue(offsetMinutes = 15) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function localDateTimeInput(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return localDateTimeValue();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'R';
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<User | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname) || 'scheduled');
  const routeIsKnown = viewFromPath(location.pathname) !== null;
  const [senders, setSenders] = useState<Sender[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignDetail, setCampaignDetail] = useState<CampaignDetail | null>(null);
  const [slackConnections, setSlackConnections] = useState<{ id: string; teamName: string; channel?: string | null }[]>([]);
  const [slackLoading, setSlackLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [connectionRestored, setConnectionRestored] = useState(false);

  const loadWorkspace = useCallback(async () => {
    const [senderRows, campaignRows] = await Promise.all([
      api<Sender[]>('/api/senders'),
      api<Campaign[]>('/api/campaigns'),
    ]);
    setSenders(senderRows);
    setCampaigns(campaignRows);
  }, []);

  useEffect(() => {
    const route = viewFromPath(location.pathname);
    if (route) setView(route);
  }, [location.pathname]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    api<{ authenticated: boolean; user: User | null }>('/api/auth/session')
      .then((session) => {
        setUser(session.authenticated ? session.user : null);
        const params = new URLSearchParams(window.location.search);
        if (session.authenticated && params.get('signedIn') === '1') {
          setNotice('Signed in with Google successfully.');
          params.delete('signedIn');
          window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
        }
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not check your sign-in session.'))
      .finally(() => setSessionLoading(false));
  }, []);

  useEffect(() => {
    const onExpired = () => { setUser(null); setSenders([]); setCampaigns([]); setError('Your session has expired. Please sign in again to continue.'); };
    const onOffline = () => { setOnline(false); setConnectionRestored(false); };
    const onOnline = () => { setOnline(true); setConnectionRestored(true); window.setTimeout(() => setConnectionRestored(false), 4000); };
    window.addEventListener('reachinbox:session-expired', onExpired);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('reachinbox:session-expired', onExpired);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const refresh = async () => {
      try {
        const [senderRows, campaignRows] = await Promise.all([api<Sender[]>('/api/senders'), api<Campaign[]>('/api/campaigns')]);
        if (alive) { setSenders(senderRows); setCampaigns(campaignRows); setWorkspaceError(''); setWorkspaceLoading(false); }
      } catch (reason) {
        if (alive && !(reason instanceof ApiError && reason.status === 401)) {
          const message = reason instanceof Error ? reason.message : 'Could not load your workspace.';
          setWorkspaceError(message); setWorkspaceLoading(false);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 12_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [user]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slackResult = params.get('slack');
    if (slackResult === 'connected') setNotice('Slack workspace connected.');
    if (slackResult === 'cancelled') setNotice('Slack connection was cancelled.');
    if (slackResult === 'error' || slackResult === 'not-configured') setError('Slack could not be connected. Check the Slack app settings and try again.');
    if (slackResult) {
      params.delete('slack');
      window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
    }
  }, []);

  useEffect(() => {
    if (!user || view !== 'settings') return;
    let alive = true;
    setSlackLoading(true);
    api<{ id: string; teamName: string; channel?: string | null }[]>('/api/integrations/slack')
      .then((connections) => { if (alive) setSlackConnections(connections); })
      .catch((reason: unknown) => {
        if (alive && !(reason instanceof ApiError && reason.status === 401)) {
          setError(reason instanceof Error ? reason.message : 'Could not load Slack settings.');
        }
      })
      .finally(() => { if (alive) setSlackLoading(false); });
    return () => { alive = false; };
  }, [user, view]);

  const activeSenders = useMemo(() => senders.filter((sender) => sender.status === 'ACTIVE'), [senders]);
  async function openView(next: View) {
    setError(''); setNotice(''); setCampaignDetail(null); setView(next); setMobileNavOpen(false); navigate(viewPaths[next]);
  }

  async function showCampaign(id: string) {
    setLoading(true); setError('');
    try { setCampaignDetail(await api<CampaignDetail>(`/api/campaigns/${id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load email details.'); }
    finally { setLoading(false); }
  }

  async function logout() {
    setLoading(true);
    try { await api('/api/auth/logout', { method: 'POST' }); setUser(null); setSenders([]); setCampaigns([]); setView('scheduled'); navigate('/'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not sign out.'); }
    finally { setLoading(false); }
  }

  async function retryWorkspace() {
    setWorkspaceLoading(true); setWorkspaceError(''); setError('');
    try { await loadWorkspace(); }
    catch (reason) { const message = reason instanceof Error ? reason.message : 'Could not load your workspace.'; setWorkspaceError(message); }
    finally { setWorkspaceLoading(false); }
  }

  async function startGoogleLogin() {
    setError(''); setLoading(true);
    try {
      const response = await fetch('/api/auth/google', { credentials: 'include', redirect: 'manual' });
      if (response.status === 503) {
        const result = await response.json() as ApiEnvelope<unknown>;
        throw new Error(result.error?.message || 'Google sign-in is not configured.');
      }
      window.location.assign('/api/auth/google');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start Google sign-in.'); }
    finally { setLoading(false); }
  }

  if (sessionLoading) return <div className="flex min-h-screen items-center justify-center bg-[#f7f8fc] text-slate-500"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" /> Loading ReachInbox</div>;
  if (!user) return <SignInScreen error={error} onSignIn={() => void startGoogleLogin()} busy={loading} />;
  if (!routeIsKnown) return <NotFoundPage onHome={() => void openView('scheduled')} />;

  const navigation: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'scheduled', label: 'Scheduled Emails', icon: Clock3 },
    { id: 'sent', label: 'Sent Emails', icon: Send },
  ];
  const toolsNavigation: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'senders', label: 'Sender Management', icon: Users },
    { id: 'search', label: 'Email Search', icon: Search },
    { id: 'settings', label: 'Integrations & Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-[#f7f8fc] text-slate-900">
      {mobileNavOpen && <button className="fixed inset-0 z-30 bg-slate-950/30 lg:hidden" onClick={() => setMobileNavOpen(false)} aria-label="Close menu" />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[252px] flex-col border-r border-slate-200 bg-white transition-transform lg:translate-x-0 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[76px] items-center gap-3 border-b border-slate-100 px-6">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-200"><Mail size={18} /></div>
            <div className="text-[17px] font-bold tracking-tight">ReachInbox</div>
          <button className="ml-auto lg:hidden" onClick={() => setMobileNavOpen(false)} aria-label="Close menu"><X size={18} /></button>
        </div>
        <div className="px-4 pt-6"><button onClick={() => void openView('compose')} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-800"><Plus size={17} /> Compose New Email</button></div>
        <div className="px-4 pt-7"><div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[.17em] text-slate-400">Email</div>
          <nav className="space-y-1">
            {navigation.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => void openView(id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium transition ${view === id ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}><Icon size={17} strokeWidth={1.8} />{label}</button>)}
          </nav>
        </div>
        <div className="mt-auto border-t border-slate-100 p-4"><div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[.17em] text-slate-400">Workspace tools</div>
          <nav className="space-y-1">{toolsNavigation.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => void openView(id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[12px] font-medium transition ${view === id ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}><Icon size={16} strokeWidth={1.8} />{label}{id === 'senders' && <span className="ml-auto rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{activeSenders.length}</span>}</button>)}</nav>
        </div>
      </aside>

      <div className="min-h-screen lg:pl-[252px]">
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur sm:px-8">
          <div className="flex min-w-0 items-center gap-3"><button className="lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open menu"><Menu size={19} /></button></div>
          <div className="flex items-center gap-2 sm:gap-4"><div className="flex min-w-0 items-center gap-2"><div className="shrink-0">{user.avatarUrl ? <img src={user.avatarUrl} className="h-8 w-8 rounded-full object-cover sm:h-9 sm:w-9" alt={`${user.name} profile`} /> : <div className="grid h-8 w-8 place-items-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-800 sm:h-9 sm:w-9" aria-hidden="true">{initials(user.name)}</div>}</div><div className="max-w-[110px] sm:max-w-[190px]"><div className="truncate text-[10px] font-semibold text-slate-800 sm:text-xs">{user.name}</div><div className="truncate text-[9px] text-slate-500 sm:text-[10px]">{user.email}</div></div></div><button onClick={() => void logout()} className="rounded-lg border border-slate-200 px-2 py-2 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 sm:px-3 sm:text-xs" title="Sign out" aria-label="Log out"><LogOut size={15} /><span className="ml-1">Log out</span></button></div>
        </header>

        <main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-8 sm:py-9">
          <OfflineBanner online={online} restored={connectionRestored} />
          {(error || notice) && <div role={error ? 'alert' : 'status'} className={`mb-6 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}><span className="mt-0.5">{error ? <AlertCircle size={16} /> : <Check size={16} />}</span><span className="flex-1">{error || notice}</span>{notice.startsWith('Email scheduled') && <button onClick={() => void openView('scheduled')} className="shrink-0 font-semibold underline">View scheduled emails</button>}<button onClick={() => { setError(''); setNotice(''); }} aria-label="Dismiss"><X size={16} /></button></div>}
          {workspaceError && <div className="mb-6"><ErrorState message={`Could not load workspace data: ${workspaceError}`} onRetry={() => void retryWorkspace()} /></div>}
          {view === 'emailDetails' && <EmailDetailsPage campaigns={campaigns} detail={campaignDetail} loading={workspaceLoading || loading} onCampaign={(id) => void showCampaign(id)} />}
          {(view === 'scheduled' || view === 'sent') && <EmailListPage view={view} onCampaign={(id) => { void openView('emailDetails'); void showCampaign(id); }} onCompose={() => void openView('compose')} />}
          {view === 'search' && <SearchPage />}
          {view === 'senders' && (workspaceLoading ? <LoadingTable label="Loading sender management" /> : <SendersPage senders={senders} onChanged={loadWorkspace} />)}
          {view === 'settings' && <SettingsPage user={user} slackConnections={slackConnections} slackLoading={slackLoading} onSlackDisconnected={async () => { await api('/api/integrations/slack', { method: 'DELETE' }); setSlackConnections([]); setNotice('Slack workspace disconnected.'); }} />}
          {view === 'compose' && <ComposePage senders={activeSenders} onCancel={() => void openView('scheduled')} onScheduled={async (message) => { setNotice(message); setView('scheduled'); setCampaignDetail(null); navigate(viewPaths.scheduled); try { await loadWorkspace(); setWorkspaceError(''); } catch { setWorkspaceError('The email was scheduled successfully, but this page could not refresh. Retry the workspace load to see it.'); } }} />}
        </main>
      </div>
    </div>
  );
}

function NotFoundPage({ onHome }: { onHome: () => void }) {
  return <main className="grid min-h-screen place-items-center bg-[#f7f8fc] px-5 text-center"><section className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><div className="text-xs font-bold uppercase tracking-[.16em] text-slate-500">Page not found</div><h1 className="mt-3 text-2xl font-bold text-slate-900">That page isn’t here</h1><p className="mt-2 text-sm leading-6 text-slate-500">The link may be outdated. Return to your email workspace.</p><button onClick={onHome} className="mt-6 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700">Go to scheduled emails</button></section></main>;
}

function SignInScreen({ error, onSignIn, busy }: { error: string; onSignIn: () => void; busy: boolean }) {
  const oauthFailed = new URLSearchParams(window.location.search).get('error') === 'oauth';
  const visibleError = error || (oauthFailed ? 'Google sign-in did not complete. Try again.' : '');
  return <div className="relative flex min-h-screen items-center justify-center bg-[#f7f8fc] px-4 py-12">
    <div className="relative w-full max-w-[430px] rounded-3xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/60 sm:p-10">
      <div className="mb-9 flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-600 text-white"><Mail size={21} /></div><div className="text-xl font-bold tracking-tight">ReachInbox</div></div>
      <h1 className="mb-3 text-3xl font-bold tracking-tight text-slate-900">Sign in to ReachInbox</h1><p className="mb-8 text-sm leading-6 text-slate-500">Use your Google account to continue.</p>
      {visibleError && <div className="mb-5 flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{visibleError}</div>}
      <button onClick={onSignIn} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60">{busy ? <LoaderCircle size={17} className="animate-spin" /> : <GoogleMark />} Continue with Google</button>
    </div>
  </div>;
}

function GoogleMark() { return <svg viewBox="0 0 48 48" className="h-[17px] w-[17px]" aria-hidden="true"><path fill="#FFC107" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.9 6.1-15Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z"/><path fill="#4A90E2" d="M12.6 27.6a12 12 0 0 1 0-7.2v-5.3H5.8a20 20 0 0 0 0 17.8l6.8-5.3Z"/><path fill="#EA4335" d="M24 12c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 6 29.5 4 24 4A20 20 0 0 0 5.8 15.1l6.8 5.3C14.2 15.6 18.7 12 24 12Z"/></svg>; }

function PageHeading({ title }: { title: string }) {
  return <div className="mb-6"><h1 className="text-2xl font-bold tracking-tight sm:text-[27px]">{title}</h1></div>;
}

function EmailDetailsPage({ campaigns, detail, loading, onCampaign }: { campaigns: Campaign[]; detail: CampaignDetail | null; loading: boolean; onCampaign: (id: string) => void }) {
  return <>
    <PageHeading title="Email details" />
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-100/80"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="text-sm font-semibold">Email groups</h2></div><Mail size={18} className="text-slate-400" /></div>
      {loading && !campaigns.length ? <LoadingTable label="Loading email groups" /> : campaigns.length ? <div className="overflow-x-auto"><table className="w-full min-w-[730px] text-left"><thead className="bg-slate-50/80 text-[10px] uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3 font-semibold">Email group</th><th className="px-4 py-3 font-semibold">Sender</th><th className="px-4 py-3 font-semibold">Recipients</th><th className="px-4 py-3 font-semibold">Progress</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-5 py-3 font-semibold">Scheduled</th></tr></thead><tbody className="divide-y divide-slate-100">{campaigns.map((item) => <tr key={item.id} onClick={() => onCampaign(item.id)} className="cursor-pointer transition hover:bg-emerald-50/40"><td className="max-w-[250px] px-5 py-4"><div className="truncate text-xs font-semibold">{item.subject}</div><div className="mt-1 font-mono text-[9px] text-slate-400">{item.id.slice(0, 8)}</div></td><td className="px-4 py-4"><div className="text-xs">{item.sender.name}</div><div className="mt-1 text-[10px] text-slate-400">{item.sender.email}</div></td><td className="px-4 py-4 text-xs">{item.totalRecipients}</td><td className="px-4 py-4 text-xs"><span className="font-semibold text-emerald-700">{item.sentCount} sent</span><span className="text-slate-300"> / </span><span className="text-rose-600">{item.failedCount} failed</span></td><td className="px-4 py-4"><StatusPill status={item.status} /></td><td className="px-5 py-4 text-[11px] text-slate-500">{dateLabel(item.scheduledAt)}</td></tr>)}</tbody></table></div> : <EmptyState icon={Mail} title="No emails found" description="Create an email to see it tracked here." />}
    </div>
    {loading && <div className="mt-5 flex items-center gap-2 text-xs text-slate-500"><LoaderCircle size={15} className="animate-spin" />Loading email details</div>}
    {detail && <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col justify-between gap-3 border-b border-slate-100 p-5 sm:flex-row sm:items-center"><div><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">{detail.subject}</h2><StatusPill status={detail.status} /></div><div className="mt-1.5 text-[11px] text-slate-500">{detail.sender.name} &lt;{detail.sender.email}&gt; · starts {dateLabel(detail.scheduledAt)}</div></div><div className="text-[11px] text-slate-500">{detail.jobs.length} recipient records</div></div><div className="max-h-[500px] overflow-auto"><table className="w-full min-w-[600px] text-left"><thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3 font-semibold">Recipient</th><th className="px-4 py-3 font-semibold">Next attempt</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-5 py-3 font-semibold">Details</th></tr></thead><tbody className="divide-y divide-slate-100">{detail.jobs.map((job) => <tr key={job.id}><td className="px-5 py-3 text-xs font-medium">{job.recipientEmail}</td><td className="px-4 py-3 text-[11px] text-slate-500"><div>{dateLabel(job.scheduledAt)}</div>{job.status === 'DEFERRED' && <div className="mt-1 text-[10px] leading-4 text-amber-700">{deferredReasonLabel(job.deferredReason)}</div>}</td><td className="px-4 py-3"><StatusPill status={job.status} /></td><td className="max-w-[280px] px-5 py-3 text-[11px] text-slate-500">{job.errorMessage || (job.etherealPreviewUrl ? <a href={job.etherealPreviewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline">Open Ethereal preview <ArrowUpRight size={12} /></a> : job.sentAt ? `Accepted ${dateLabel(job.sentAt)}` : 'Waiting for delivery')}</td></tr>)}</tbody></table></div></section>}
  </>;
}

function EmailListPage({ view, onCampaign, onCompose }: { view: 'scheduled' | 'sent'; onCampaign: (id: string) => void; onCompose: () => void }) {
  const [rows, setRows] = useState<EmailItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedTime, setEditedTime] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const title = view === 'scheduled' ? 'Scheduled Emails' : 'Sent Emails';
  const emptyCopy = view === 'scheduled'
    ? ['No scheduled emails yet', 'Your scheduled emails will appear here.']
    : ['No sent emails yet', 'Sent or failed email attempts will appear here.'];
  async function load() {
    setBusy(true); setError('');
    try { setRows(await api<EmailItem[]>(`/api/emails?view=${view}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load emails.'); }
    finally { setBusy(false); }
  }

  function startEditing(row: EmailItem) {
    setError(''); setNotice(''); setEditingId(row.id); setEditedTime(localDateTimeInput(row.scheduledAt));
  }

  async function saveSchedule(event: FormEvent, row: EmailItem) {
    event.preventDefault();
    setActionId(row.id); setError(''); setNotice('');
    try {
      const scheduledAt = new Date(editedTime);
      await api(`/api/emails/${row.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduledAt: scheduledAt.toISOString() }),
      });
      setEditingId(null);
      setNotice(`Schedule updated for ${row.recipientEmail}.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not change the scheduled time.');
    } finally { setActionId(null); }
  }

  async function cancelScheduled(row: EmailItem) {
    const confirmed = window.confirm(`Cancel the scheduled email to ${row.recipientEmail}? It will be removed from Scheduled Emails.`);
    if (!confirmed) return;
    setActionId(row.id); setError(''); setNotice('');
    try {
      await api(`/api/emails/${row.id}`, { method: 'DELETE' });
      setEditingId(null);
      setNotice(`Scheduled email to ${row.recipientEmail} cancelled.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not cancel this scheduled email.');
    } finally { setActionId(null); }
  }

  useEffect(() => { void load(); }, [view]);
  return <>
    <PageHeading title={title} />
    {notice && <div role="status" className="mb-4 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800">{notice}</div>}
    {error && <div className="mb-4"><ErrorState message={error} onRetry={() => void load()} /></div>}
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {busy ? <LoadingTable label={`Loading ${title.toLowerCase()}`} /> : rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3 font-semibold">Email</th><th className="px-4 py-3 font-semibold">Subject</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3 font-semibold">{view === 'sent' ? 'Sent time' : 'Scheduled / next attempt'}</th><th className="px-5 py-3 font-semibold">Details</th>{view === 'scheduled' && <th className="px-5 py-3 font-semibold">Actions</th>}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row) => {
        const canManage = view === 'scheduled' && ['SCHEDULED', 'QUEUED', 'DEFERRED'].includes(row.status);
        const deferredLabel = row.status === 'DEFERRED' ? deferredReasonLabel(row.deferredReason) : '';
        return <tr key={row.id} className="hover:bg-slate-50"><td className="max-w-[240px] truncate px-5 py-4 text-xs">{row.recipientEmail}</td><td className="max-w-[260px] px-4 py-4"><div className="truncate text-xs font-semibold">{row.subject}</div><div className="mt-1 text-[10px] text-slate-500">From: {row.senderName}</div></td><td className="px-4 py-4"><StatusPill status={row.status} /></td><td className="px-4 py-4 text-[11px] text-slate-500"><div>{dateLabel(view === 'sent' && row.sentAt ? row.sentAt : row.scheduledAt)}</div>{view === 'scheduled' && deferredLabel && <div className="mt-1 max-w-[230px] text-[10px] leading-4 text-amber-700">{deferredLabel}</div>}</td><td className="px-5 py-4 text-[11px]">{row.errorMessage ? <span className="text-rose-700">{row.errorMessage}</span> : row.etherealPreviewUrl ? <a href={row.etherealPreviewUrl} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline">Open test preview</a> : row.campaignId ? <button onClick={() => onCampaign(row.campaignId!)} className="font-medium text-emerald-700 underline">Email details</button> : '—'}</td>{view === 'scheduled' && <td className="px-5 py-4 text-[11px]">{canManage ? <div className="flex flex-col items-start gap-2">{editingId === row.id ? <form onSubmit={(event) => void saveSchedule(event, row)} className="flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor={`reschedule-${row.id}`}>New send time for {row.recipientEmail}</label><input id={`reschedule-${row.id}`} type="datetime-local" required min={localDateTimeValue(1)} value={editedTime} onChange={(event) => setEditedTime(event.target.value)} className="form-input max-w-[210px] px-2 py-1.5 text-[11px]" /><button disabled={actionId === row.id} className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1.5 font-semibold text-white disabled:opacity-50"><Check size={12} /> Save</button><button type="button" disabled={actionId === row.id} onClick={() => setEditingId(null)} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-slate-600 disabled:opacity-50"><X size={12} /> Close</button></form> : <button disabled={actionId === row.id} onClick={() => startEditing(row)} className="inline-flex items-center gap-1.5 font-medium text-slate-700 hover:text-emerald-700 disabled:opacity-50"><CalendarClock size={13} /> Change time</button>}<button disabled={actionId === row.id} onClick={() => void cancelScheduled(row)} className="inline-flex items-center gap-1.5 font-medium text-rose-700 hover:text-rose-800 disabled:opacity-50"><Trash2 size={13} /> Cancel email</button></div> : <span className="text-slate-400">Processing or finished</span>}</td>}</tr>;
      })}</tbody></table></div> : !error ? <EmptyState icon={view === 'sent' ? Send : Clock3} title={emptyCopy[0]} description={emptyCopy[1]} action={view === 'scheduled' ? onCompose : undefined} actionLabel={view === 'scheduled' ? 'Compose email' : undefined} /> : null}
    </section>
  </>;
}

function SearchPage() {
  const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [results, setResults] = useState<EmailItem[]>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [searched, setSearched] = useState(false);
  async function search(event: FormEvent) { event.preventDefault(); if (!query.trim()) return; setBusy(true); setMessage(''); setSearched(true); try { const params = new URLSearchParams({ q: query.trim() }); if (status) params.set('status', status); const data = await api<{ results: EmailItem[]; count: number }>(`/api/search?${params}`); setResults(data.results); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Search is unavailable.'); setResults([]); } finally { setBusy(false); } }
  const noResultsTitle = status ? `No emails with “${status.toLowerCase()}” status` : 'No matching email';
  const noResultsDescription = status ? 'Try a different status or clear the filter.' : 'Try a different search.';
  return <><PageHeading title="Email Search" />
    <form onSubmit={(event) => void search(event)} className="mb-5 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row"><label className="flex flex-1 items-center gap-2 rounded-xl border border-slate-200 px-3.5 focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-100"><Search size={17} className="text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="h-11 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-slate-400" placeholder="Search email address, subject, or phrase…" maxLength={200} /></label><select value={status} onChange={(event) => setStatus(event.target.value)} className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-600"><option value="">All statuses</option>{emailStatuses.map((value) => <option key={value} value={value}>{value.toLowerCase()}</option>)}</select><button disabled={busy || !query.trim()} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50">{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Search size={15} />} Search</button></form>
    {message && <div role="alert" className="mb-4 rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{message}</div>}
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">{results.length ? <div className="divide-y divide-slate-100">{results.map((item) => <article key={item.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><Mail size={16} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-xs font-semibold">{item.subject}</h3><StatusPill status={item.status} /></div><div className="mt-1.5 text-[11px] text-slate-500">To: {item.recipientEmail} <span className="mx-1 text-slate-300">·</span> From: {item.senderName} &lt;{item.senderEmail}&gt;</div><p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-slate-600">{item.bodyText}</p>{item.errorMessage && <p className="mt-2 text-[11px] text-rose-600">{item.errorMessage}</p>}</div><div className="shrink-0 text-[10px] text-slate-400">{dateLabel(item.scheduledAt)}</div></article>)}</div> : busy ? <LoadingTable label="Searching emails" /> : searched && !message ? <EmptyState icon={Search} title={noResultsTitle} description={noResultsDescription} /> : !searched ? <EmptyState icon={Search} title="Search your email" description="Enter a recipient, sender, or subject above." /> : null}</div>
  </>;
}

function SendersPage({ senders, onChanged }: { senders: Sender[]; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [hourlyLimit, setHourlyLimit] = useState('50'); const [busy, setBusy] = useState(false); const [disconnectingId, setDisconnectingId] = useState(''); const [deletingSenderId, setDeletingSenderId] = useState(''); const [batchBusyId, setBatchBusyId] = useState(''); const [batchAction, setBatchAction] = useState<'reschedule' | 'cancel' | 'history' | null>(null); const [expandedSenderId, setExpandedSenderId] = useState(''); const [batchTime, setBatchTime] = useState(localDateTimeValue(15)); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  async function addSender(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); setNotice(''); try { await api('/api/senders', { method: 'POST', body: JSON.stringify({ name, email, hourlyLimit: Number(hourlyLimit) }) }); setName(''); setEmail(''); setNotice('Sender profile saved.'); await onChanged(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save sender profile.'); } finally { setBusy(false); } }
  async function disconnect(sender: Sender) {
    if (!window.confirm(`Disconnect ${sender.name} (${sender.email})? Already scheduled emails will remain in the queue.`)) return;
    setDisconnectingId(sender.id); setError(''); setNotice('');
    try { await api(`/api/senders/${sender.id}/disconnect`, { method: 'PATCH' }); setNotice(`${sender.name} was disconnected.`); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not disconnect sender.'); }
    finally { setDisconnectingId(''); }
  }
  async function deleteSender(sender: Sender) {
    if (!window.confirm(`Permanently delete ${sender.name} (${sender.email}) and all of its scheduled emails and history? This cannot be undone. Emails already being sent must finish first.`)) return;
    setDeletingSenderId(sender.id); setError(''); setNotice('');
    try {
      await api(`/api/senders/${sender.id}`, { method: 'DELETE' });
      setNotice(`${sender.name} and its email history were permanently deleted.`);
      setExpandedSenderId('');
      try {
        await onChanged();
      } catch {
        setError('Sender was deleted, but the list could not refresh. Reload the page to see the latest data.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete sender.');
      try { await onChanged(); } catch { setError('Could not delete sender or refresh the sender list. Reload the page to see the latest data.'); }
    } finally { setDeletingSenderId(''); }
  }
  async function rescheduleAll(event: FormEvent, sender: Sender) {
    event.preventDefault();
    if (batchBusyId) return;
    const newTime = new Date(batchTime);
    if (Number.isNaN(newTime.getTime()) || newTime.getTime() <= Date.now() + 1000) {
      setError('Choose a future time for these emails.');
      return;
    }
    setBatchBusyId(sender.id); setBatchAction('reschedule'); setError(''); setNotice('');
    try {
      const result = await api<{ updatedCount: number }>(`/api/senders/${sender.id}/scheduled/reschedule`, {
        method: 'POST',
        body: JSON.stringify({ scheduledAt: newTime.toISOString() }),
      });
      setNotice(result.updatedCount
        ? `Rescheduled ${result.updatedCount} email${result.updatedCount === 1 ? '' : 's'} for ${sender.name}.`
        : `There were no pending emails to reschedule for ${sender.name}.`);
      setExpandedSenderId('');
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reschedule these emails.');
    } finally { setBatchBusyId(''); setBatchAction(null); }
  }
  async function cancelAll(sender: Sender) {
    if (batchBusyId) return;
    if (!window.confirm(`Cancel all pending emails for ${sender.name}? Emails that have already started sending will not be changed.`)) return;
    setBatchBusyId(sender.id); setBatchAction('cancel'); setError(''); setNotice('');
    try {
      const result = await api<{ cancelledCount: number }>(`/api/senders/${sender.id}/scheduled`, { method: 'DELETE' });
      setNotice(result.cancelledCount
        ? `Cancelled ${result.cancelledCount} pending email${result.cancelledCount === 1 ? '' : 's'} for ${sender.name}.`
        : `There were no pending emails to cancel for ${sender.name}.`);
      setExpandedSenderId('');
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not cancel these emails.');
    } finally { setBatchBusyId(''); setBatchAction(null); }
  }
  async function clearHistory(sender: Sender) {
    if (batchBusyId) return;
    if (!window.confirm(`Permanently clear completed email history for ${sender.name}? This removes sent, failed, cancelled, and unknown records with their delivery attempts. Scheduled and processing emails will remain.`)) return;
    setBatchBusyId(sender.id); setBatchAction('history'); setError(''); setNotice('');
    try {
      const result = await api<{ clearedCount: number; skippedActiveCount: number }>(`/api/senders/${sender.id}/history`, { method: 'DELETE' });
      const clearedMessage = result.clearedCount
        ? `Cleared ${result.clearedCount} completed email record${result.clearedCount === 1 ? '' : 's'} for ${sender.name}.`
        : `There was no completed email history to clear for ${sender.name}.`;
      const skippedMessage = result.skippedActiveCount
        ? ` ${result.skippedActiveCount} active record${result.skippedActiveCount === 1 ? ' was' : 's were'} kept.`
        : '';
      setNotice(`${clearedMessage}${skippedMessage}`);
      setExpandedSenderId('');
      try {
        await onChanged();
      } catch {
        setError('History was cleared, but the sender list could not refresh. Reload the page to see the latest data.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not clear sender history.');
    } finally { setBatchBusyId(''); setBatchAction(null); }
  }
  return <><PageHeading title="Sender Management" />
    <div className="grid gap-5 xl:grid-cols-[1.35fr_.85fr]">
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 px-5 py-4"><h2 className="text-sm font-semibold">Sender profiles</h2></div>{error && <div role="alert" className="mx-5 mt-4 rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{error}</div>}{notice && <div role="status" className="mx-5 mt-4 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700">{notice}</div>}
        {senders.length ? <div className="divide-y divide-slate-100">{senders.map((sender) => <div key={sender.id} className="px-5 py-4"><div className="flex items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-sm font-semibold text-slate-700">{initials(sender.name)}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{sender.name}</div><div className="mt-1 truncate text-xs text-slate-500">{sender.email} · {sender.hourlyLimit} {sender.hourlyLimit === 1 ? 'email' : 'emails'} per hour</div></div><StatusPill status={sender.status} />{sender.status === 'ACTIVE' && <button disabled={busy || Boolean(disconnectingId) || Boolean(deletingSenderId) || Boolean(batchBusyId)} onClick={() => void disconnect(sender)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-rose-200 hover:text-rose-600 disabled:opacity-50">{disconnectingId === sender.id ? 'Disconnecting…' : 'Disconnect'}</button>}</div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 pl-[52px]"><button type="button" aria-expanded={expandedSenderId === sender.id} onClick={() => { setExpandedSenderId(expandedSenderId === sender.id ? '' : sender.id); setError(''); setNotice(''); }} className="text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900">Manage scheduled emails</button><button type="button" disabled={busy || Boolean(disconnectingId) || Boolean(deletingSenderId) || Boolean(batchBusyId)} onClick={() => void deleteSender(sender)} className="inline-flex items-center gap-1 text-xs font-medium text-rose-600 hover:text-rose-800 disabled:opacity-50">{deletingSenderId === sender.id ? <><LoaderCircle size={13} className="animate-spin" /> Deleting…</> : <><Trash2 size={13} /> Delete sender</>}</button>
            {expandedSenderId === sender.id && <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="mb-3 text-xs text-slate-600">Scheduled and processing emails are not affected by clearing history.</p><form onSubmit={(event) => void rescheduleAll(event, sender)} className="flex flex-col items-start gap-2 sm:flex-row sm:items-end"><Field label="Set new time for all"><input required type="datetime-local" min={localDateTimeValue(1)} value={batchTime} onChange={(event) => setBatchTime(event.target.value)} className="form-input" /></Field><button disabled={Boolean(batchBusyId)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-slate-900 px-3.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50">{batchBusyId === sender.id && batchAction === 'reschedule' ? <><LoaderCircle size={14} className="animate-spin" /> Rescheduling…</> : <><CalendarClock size={14} /> Reschedule all</>}</button></form><button type="button" disabled={Boolean(batchBusyId)} onClick={() => void cancelAll(sender)} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-white px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">{batchBusyId === sender.id && batchAction === 'cancel' ? <><LoaderCircle size={14} className="animate-spin" /> Cancelling…</> : <><Trash2 size={14} /> Cancel all pending emails</>}</button><div className="mt-4 border-t border-slate-200 pt-3"><button type="button" disabled={Boolean(batchBusyId)} onClick={() => void clearHistory(sender)} className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-white px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">{batchBusyId === sender.id && batchAction === 'history' ? <><LoaderCircle size={14} className="animate-spin" /> Clearing history…</> : <><Trash2 size={14} /> Clear sender history</>}</button><p className="mt-2 text-[11px] leading-4 text-slate-500">Removes sent, failed, cancelled, and unknown emails for this sender.</p></div></div>}
          </div></div>)}</div> : <EmptyState icon={Users} title="No sender profiles" description="Add one to get started." />}
      </section>
      <form onSubmit={(event) => void addSender(event)} className="h-fit rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-5 flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><Plus size={17} /></div><h2 className="text-sm font-semibold">Add a sender profile</h2></div><div className="space-y-4"><Field label="Display name"><input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex Morgan" className="form-input" /></Field><Field label="Email address"><input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="alex@example.com" className="form-input" /></Field><Field label="Set Hourly Limit"><input required type="number" min={1} max={5000} value={hourlyLimit} onChange={(event) => setHourlyLimit(event.target.value)} className="form-input" /></Field><button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">{busy ? <><LoaderCircle size={15} className="animate-spin" /> Saving…</> : <><Plus size={15} /> Save sender profile</>}</button></div>
      </form>
    </div>
  </>;
}

function ComposePage({ senders, onCancel, onScheduled }: { senders: Sender[]; onCancel: () => void; onScheduled: (message: string) => Promise<void> }) {
  const [senderId, setSenderId] = useState(senders[0]?.id || ''); const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [recipientsRaw, setRecipientsRaw] = useState(''); const [ccRaw, setCcRaw] = useState(''); const [bccRaw, setBccRaw] = useState(''); const [attachments, setAttachments] = useState<LocalAttachment[]>([]); const [recipientFile, setRecipientFile] = useState(''); const [scheduledAt, setScheduledAt] = useState(localDateTimeValue()); const [delay, setDelay] = useState('2'); const [hourlyLimit, setHourlyLimit] = useState('50'); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [minimized, setMinimized] = useState(false); const [expanded, setExpanded] = useState(false);
  const idempotencyKeys = useRef(new Map<string, string>());
  const parsedRecipients = useMemo(() => parseRecipients(recipientsRaw), [recipientsRaw]);
  const parsedCc = useMemo(() => parseRecipients(ccRaw), [ccRaw]);
  const parsedBcc = useMemo(() => parseRecipients(bccRaw), [bccRaw]);
  const signature = senders.find((sender) => sender.id === senderId)?.name || '';
  function closeCompose() {
    const hasDraft = subject.trim() || body.replace(/<[^>]*>/g, '').trim() || recipientsRaw.trim() || ccRaw.trim() || bccRaw.trim() || attachments.length;
    if (hasDraft && !window.confirm('Discard this unscheduled message?')) return;
    onCancel();
  }
  async function importRecipientFile(file?: File) {
    if (!file) return;
    setError('');
    if (!/\.(csv|txt)$/i.test(file.name)) { setError('Choose a CSV or TXT recipient file.'); return; }
    try {
      const contents = await file.text();
      const imported = file.name.toLowerCase().endsWith('.csv') ? parseCsvRecipientText(contents) : contents;
      setRecipientsRaw((current) => [current.trim(), imported.trim()].filter(Boolean).join('\n'));
      setRecipientFile(file.name);
    } catch {
      setError('Could not read this file. Try saving it as UTF-8 CSV or TXT and upload again.');
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!parsedRecipients.validEmails.length) { setError('Enter at least one valid recipient email address.'); return; }
    if (parsedRecipients.invalidEntries.length || parsedCc.invalidEntries.length || parsedBcc.invalidEntries.length) { setError('Fix or remove the invalid recipient addresses before scheduling.'); return; }
    if (!body.replace(/<[^>]*>/g, '').trim()) { setError('Write your message before scheduling.'); return; }
    if (!senderId) { setError('Add a sender in Sender Management before scheduling an email.'); return; }
    const date = new Date(scheduledAt);
    if (date.getTime() < Date.now() - 60_000) { setError('Choose a start time in the future.'); return; }
    const requestBody = JSON.stringify({ senderId, subject, body, recipients: parsedRecipients.validEmails, ccRecipients: parsedCc.validEmails, bccRecipients: parsedBcc.validEmails, attachments, scheduledAt: date.toISOString(), delayBetweenSeconds: Number(delay), hourlyLimit: Number(hourlyLimit) });
    setBusy(true);
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestBody));
      const requestSignature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      let idempotencyKey = idempotencyKeys.current.get(requestSignature);
      if (!idempotencyKey) {
        idempotencyKey = crypto.randomUUID();
        idempotencyKeys.current.set(requestSignature, idempotencyKey);
      }
      const result = await api<{ campaignId: string; recipientCount: number; queuedCount: number; queueState: string; replayed?: boolean }>('/api/campaigns', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: requestBody });
      if (result.replayed) {
        await onScheduled(`This request was already scheduled for ${result.recipientCount} recipients. No duplicate emails were created.`);
        return;
      }
      const suffix = result.queueState === 'queued' ? 'Delivery jobs are queued.' : 'The worker will recover pending jobs automatically.';
      await onScheduled(`Email scheduled for ${result.recipientCount} recipients, starting ${dateLabel(date.toISOString())}. ${suffix}`);
    } catch (reason) {
      if (reason instanceof TypeError || (reason instanceof DOMException && (reason.name === 'TimeoutError' || reason.name === 'AbortError'))) setError('The connection was interrupted. Retry this same request safely; if the server accepted it, no duplicate emails will be created.');
      else setError(reason instanceof Error ? reason.message : 'Could not schedule email.');
    }
    finally { setBusy(false); }
  }
  return <><PageHeading title="Compose New Email" />
    {error && <div className="mb-5 flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800"><AlertCircle size={15} />{error}</div>}
    {!senders.length && <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900"><AlertCircle size={16} className="mt-0.5 shrink-0" /><span>You need an active sender profile first. Open <strong>Sender Management</strong> to add one; it is used as the display identity for Ethereal test mail.</span></div>}
    <form onSubmit={(event) => void submit(event)} className={`grid items-start gap-5 ${expanded ? 'xl:grid-cols-1' : 'xl:grid-cols-[1.6fr_.8fr]'}`}>
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <Field label="From sender profile"><select required value={senderId} onChange={(event) => setSenderId(event.target.value)} className="form-input"><option value="">Select sender</option>{senders.map((sender) => <option key={sender.id} value={sender.id}>{sender.name} &lt;{sender.email}&gt;</option>)}</select></Field>
          <div className="mt-4"><Field label="To"><textarea required value={recipientsRaw} onChange={(event) => setRecipientsRaw(event.target.value)} rows={2} placeholder="recipient@example.com, another@example.com" className="form-input min-h-[64px] resize-y font-mono text-xs leading-5" /></Field>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]"><span className={`rounded-full px-2 py-1 font-medium ${parsedRecipients.validEmails.length ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{parsedRecipients.validEmails.length ? `${parsedRecipients.validEmails.length} recipient${parsedRecipients.validEmails.length === 1 ? '' : 's'} added` : 'No recipients added'}</span>{parsedRecipients.invalidEntries.length > 0 && <span className="rounded-full bg-rose-50 px-2 py-1 font-medium text-rose-700">{parsedRecipients.invalidEntries.length} invalid</span>}<label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-emerald-700 hover:bg-emerald-50"><Users size={14} />Upload CSV or TXT<input className="sr-only" type="file" accept=".csv,.txt,text/csv,text/plain" aria-label="Upload CSV or TXT recipient list" onChange={(event) => { void importRecipientFile(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>{recipientFile && <span className="text-slate-500">Added {recipientFile}</span>}</div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Cc"><input value={ccRaw} onChange={(event) => setCcRaw(event.target.value)} placeholder="Optional Cc recipients" className="form-input" /></Field><Field label="Bcc"><input value={bccRaw} onChange={(event) => setBccRaw(event.target.value)} placeholder="Optional Bcc recipients" className="form-input" /></Field></div>
          {(parsedRecipients.invalidEntries.length + parsedCc.invalidEntries.length + parsedBcc.invalidEntries.length) > 0 && <p className="mt-2 text-[10px] text-rose-700">Some recipient addresses need correction before scheduling.</p>}
          <div className="mt-4"><Field label="Subject"><input required maxLength={255} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" className="form-input" /></Field></div>
        </div>
        <ComposeEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} signature={signature} onError={setError} minimized={minimized} onMinimizeChange={setMinimized} expanded={expanded} onExpandedChange={setExpanded} onClose={closeCompose} />
        <div className="flex flex-wrap items-center justify-between gap-3"><button disabled={busy || !senders.length} className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-5 py-3 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">{busy ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={15} />} Schedule send · {parsedRecipients.validEmails.length} recipients</button><button type="button" onClick={closeCompose} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-100"><Trash2 size={15} />Discard message</button></div>
      </div>
      <div className="space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-4 flex items-center gap-2"><Clock3 size={16} className="text-emerald-600" /><h2 className="text-sm font-semibold">Schedule and limits</h2></div><div className="space-y-4"><Field label="Start date and time"><input required type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} className="form-input" /></Field><Field label="Delay between recipients"><div className="relative"><input required type="number" min={0} max={3600} value={delay} onChange={(event) => setDelay(event.target.value)} className="form-input pr-16" /><span className="absolute right-3 top-3 text-[10px] text-slate-400">seconds</span></div></Field><Field label="Set Hourly Limit"><input required type="number" min={1} max={5000} value={hourlyLimit} onChange={(event) => setHourlyLimit(event.target.value)} className="form-input" /></Field></div></section>
      </div>
    </form>
  </>;
}

function SettingsPage({ user, slackConnections, slackLoading, onSlackDisconnected }: { user: User; slackConnections: { id: string; teamName: string; channel?: string | null }[]; slackLoading: boolean; onSlackDisconnected: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function disconnect() { setBusy(true); setError(''); try { await onSlackDisconnected(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not disconnect Slack.'); } finally { setBusy(false); } }
  return <><PageHeading title="Settings" />
    <div className="grid max-w-4xl gap-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-4 flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-50 text-blue-700"><ShieldCheck size={17} /></div><h2 className="text-sm font-semibold">Account</h2></div><div className="grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-2"><div><div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Name</div><div className="mt-1 text-xs font-medium">{user.name}</div></div><div><div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Email</div><div className="mt-1 text-xs font-medium">{user.email}</div></div></div></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-700"><MessageSquareIcon /></div><div><h2 className="text-sm font-semibold">Slack notifications</h2><p className="mt-0.5 text-xs text-slate-500">Get notified when a sender reaches its hourly limit.</p></div></div>{slackConnections.length ? <button disabled={busy} onClick={() => void disconnect()} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-semibold text-slate-600 hover:border-rose-200 hover:text-rose-600 disabled:opacity-50">Disconnect Slack</button> : <a href="/api/integrations/slack/connect" className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2.5 text-[11px] font-semibold text-white hover:bg-slate-700"><ArrowUpRight size={14} /> Connect Slack</a>}</div>
        {error && <div role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{error}</div>}{slackLoading ? <div role="status" className="mt-4 flex items-center gap-2 text-xs text-slate-500"><LoaderCircle size={14} className="animate-spin" />Loading Slack connection</div> : slackConnections.length ? <div className="mt-4 space-y-2">{slackConnections.map((connection) => <div key={connection.id} className="flex items-center justify-between rounded-xl bg-emerald-50 px-4 py-3"><div><div className="text-xs font-semibold text-emerald-900">{connection.teamName}</div><div className="mt-1 text-[10px] text-emerald-700">{connection.channel || 'Workspace notifications enabled'}</div></div><StatusPill status="ACTIVE" /></div>)}</div> : <div className="mt-4 rounded-xl border border-dashed border-slate-200 p-4 text-[11px] leading-5 text-slate-500">No Slack workspace connected. This integration needs Slack app credentials in the server environment before authorization can begin.</div>}
      </section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-3 flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-700"><ShieldCheck size={17} /></div><div><h2 className="text-sm font-semibold">Test delivery mode</h2><p className="text-[11px] text-slate-400">SMTP is configured for Ethereal test mail.</p></div></div><p className="rounded-xl bg-amber-50 p-4 text-[11px] leading-5 text-amber-900">Ethereal accepts test messages and provides a preview link. It does not deliver to recipient inboxes. The app will only show “sent” when the SMTP server accepts a message.</p></section>
    </div>
  </>;
}

function MessageSquareIcon() { return <span className="text-sm font-black tracking-tight">#</span>; }

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block text-[11px] font-semibold text-slate-700">{label}<div className="mt-1.5">{children}</div></label>; }
