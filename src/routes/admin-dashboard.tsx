import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { FC } from 'hono/jsx';
import type { Env, ScenarioStep } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { invalidateTenantCache } from '../config/tenant-config';
import { getAllFunnelMetrics, getDetailedAnalytics, generateRecommendations, BENCHMARKS, getHotLeads, getRecentActivity, getUserSmartLabel, getTodaysMission } from '../services/analytics';
import type { HotLead, ActivityEvent, TodaysMission, StepDropoff, AIPerformanceMetrics } from '../services/analytics';
import { calculateLeadScore, getLeadScores, generateStaffSuggestions, getScoreColor, getScoreBadgeColor } from '../services/lead-scoring';
import type { LeadScore } from '../services/lead-scoring';
import { formatDateTimeJST } from '../utils/datetime';
import { hashSessionToken, verifySessionToken } from '../middleware/security';
import { getDefaultConfigs } from '../config/default-scenarios';
import { parseHearingForm, parseToneForm, parseGuardrailForm, parseNotificationForm, parseReminderForm } from '../utils/form-parsers';
import { pushMessage } from '../services/line';

const dashboard = new Hono<{ Bindings: Env }>();

// --- Design System ---
const DESIGN_CSS = `
  /* === Animations === */
  @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  @keyframes score-fill { from { width: 0%; } to { width: var(--score-width); } }
  @keyframes slide-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes slide-in-right { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes glow { 0%, 100% { box-shadow: 0 0 5px rgba(99,102,241,0.3); } 50% { box-shadow: 0 0 20px rgba(99,102,241,0.6); } }
  @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-4px); } }
  @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
  @keyframes confetti { 0% { transform: translateY(0) rotate(0deg); opacity: 1; } 100% { transform: translateY(-40px) rotate(360deg); opacity: 0; } }
  @keyframes count-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes typing-dot { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }

  /* === Utility Classes === */
  .pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
  .slide-in { animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
  .slide-in-right { animation: slide-in-right 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
  .fade-in { animation: fade-in 0.5s ease; }
  .mission-glow { animation: glow 2s ease-in-out infinite; }
  .float-gentle { animation: float 3s ease-in-out infinite; }
  .count-up { animation: count-up 0.6s cubic-bezier(0.16, 1, 0.3, 1); }

  /* === Gradients === */
  .gradient-hero { background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #6366f1 100%); }
  .gradient-warm { background: linear-gradient(135deg, #f97316 0%, #f59e0b 100%); }
  .gradient-success { background: linear-gradient(135deg, #059669 0%, #10b981 100%); }
  .gradient-card { background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); }
  .gradient-score { background: linear-gradient(90deg, var(--score-from), var(--score-to)); }
  .gradient-glass { background: rgba(255,255,255,0.7); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
  .gradient-dark { background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%); }

  /* === Chat Bubbles === */
  .line-bubble-user { background: #fff; border: 1px solid #e5e7eb; border-radius: 0 18px 18px 18px; }
  .line-bubble-bot { background: linear-gradient(135deg, #dbeafe, #e0f2fe); border-radius: 18px 0 18px 18px; }
  .line-bubble-staff { background: linear-gradient(135deg, #fef3c7, #fde68a); border-radius: 18px 0 18px 18px; }

  /* === Scrollbar === */
  .custom-scrollbar::-webkit-scrollbar { width: 5px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 9999px; }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }

  /* === Progress & Bars === */
  .health-bar { transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1); }
  .score-bar { animation: score-fill 1s cubic-bezier(0.16, 1, 0.3, 1) forwards; width: var(--score-width); }
  .dropoff-bar { transition: width 0.6s ease; }
  .suggestion-card { border-left: 3px solid #6366f1; }

  /* === Skeleton Loading === */
  .skeleton {
    background: linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s ease-in-out infinite;
    border-radius: 8px;
  }

  /* === Cards & Surfaces === */
  .card {
    background: white;
    border-radius: 16px;
    border: 1px solid #f1f5f9;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02);
    transition: box-shadow 0.2s, transform 0.2s;
  }
  .card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04); }
  .card-interactive:hover { transform: translateY(-1px); }

  /* === Typing indicator === */
  .typing-dot { animation: typing-dot 1.4s ease-in-out infinite; }
  .typing-dot:nth-child(2) { animation-delay: 0.2s; }
  .typing-dot:nth-child(3) { animation-delay: 0.4s; }

  /* === Sidebar === */
  .sidebar-link {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-radius: 10px;
    font-size: 14px; color: #64748b;
    transition: all 0.15s ease;
    text-decoration: none;
  }
  .sidebar-link:hover { background: #f1f5f9; color: #334155; }
  .sidebar-link.active { background: #eef2ff; color: #4f46e5; font-weight: 600; }

  /* === Empty State === */
  .empty-state {
    display: flex; flex-direction: column; align-items: center;
    padding: 48px 24px; text-align: center;
  }

  /* === Responsive === */
  @media (max-width: 768px) {
    .sidebar-desktop { display: none; }
    .main-with-sidebar { margin-left: 0 !important; }
  }
  @media (min-width: 769px) {
    .mobile-nav { display: none !important; }
  }

  /* === Badge animations === */
  .badge-pulse {
    position: relative;
  }
  .badge-pulse::after {
    content: '';
    position: absolute; top: -2px; right: -2px;
    width: 8px; height: 8px;
    background: #ef4444; border-radius: 50%;
    animation: pulse-dot 2s ease-in-out infinite;
  }

  /* === Focus styles for accessibility === */
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid #6366f1;
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* === Print === */
  @media print {
    nav, .sidebar-desktop, .mobile-nav { display: none !important; }
    .main-with-sidebar { margin-left: 0 !important; }
  }
`;

// --- Layout ---
const Layout: FC<{ title: string; children: unknown }> = ({ title, children }) => (
  <html lang="ja">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title} - LINE Attend Agent</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <script dangerouslySetInnerHTML={{__html: `
        tailwind.config = {
          theme: {
            extend: {
              fontFamily: {
                sans: ['Inter', 'Noto Sans JP', 'system-ui', 'sans-serif'],
              },
            }
          }
        }
      `}} />
      <style dangerouslySetInnerHTML={{__html: DESIGN_CSS}} />
    </head>
    <body class="bg-slate-50 min-h-screen font-sans text-slate-700 antialiased">
      {/* Mobile Top Nav */}
      <nav class="mobile-nav fixed top-0 left-0 right-0 z-50 gradient-glass border-b border-slate-200/50 px-4 py-3 flex items-center justify-between">
        <a href="/admin/" class="flex items-center gap-2">
          <span class="w-8 h-8 gradient-hero rounded-lg flex items-center justify-center text-white text-xs font-bold shadow-sm">AI</span>
          <span class="font-bold text-slate-800 text-sm">Attend Agent</span>
        </a>
        <div class="flex items-center gap-2">
          <a href="/admin/system" class="text-slate-400 hover:text-slate-600 p-2 rounded-lg hover:bg-slate-100 transition">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          </a>
          <form method="post" action="/admin/logout" class="inline">
            <button type="submit" class="text-slate-400 hover:text-slate-600 p-2 rounded-lg hover:bg-slate-100 transition">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </form>
        </div>
      </nav>

      {/* Desktop Sidebar */}
      <aside class="sidebar-desktop fixed top-0 left-0 bottom-0 w-[220px] bg-white border-r border-slate-100 z-40 flex flex-col">
        {/* Logo */}
        <div class="px-5 py-5 flex items-center gap-3">
          <span class="w-9 h-9 gradient-hero rounded-xl flex items-center justify-center text-white text-xs font-bold shadow-md float-gentle">AI</span>
          <div>
            <p class="font-bold text-slate-800 text-sm leading-tight">Attend Agent</p>
            <p class="text-[10px] text-slate-400 leading-tight">AIコンシェルジュ</p>
          </div>
        </div>

        {/* Navigation */}
        <nav class="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
          <p class="px-3 pt-3 pb-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">メイン</p>
          <a href="/admin/" class="sidebar-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            ホーム
          </a>

          <p class="px-3 pt-5 pb-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">運用</p>
          <a href="/admin/system" class="sidebar-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            システム状態
          </a>

          <p class="px-3 pt-5 pb-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">ヘルプ</p>
          <a href="/admin/guide" class="sidebar-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            使い方ガイド
          </a>
        </nav>

        {/* Footer */}
        <div class="p-4 border-t border-slate-100">
          <form method="post" action="/admin/logout">
            <button type="submit" class="sidebar-link w-full text-slate-400 hover:text-red-500 hover:bg-red-50">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              ログアウト
            </button>
          </form>
        </div>
      </aside>

      {/* Main Content */}
      <main class="main-with-sidebar ml-[220px] min-h-screen pt-0 md:pt-0" style="padding-top: 0">
        <div class="max-w-6xl mx-auto px-6 py-8 md:px-8">
          <div class="slide-in">
            {children}
          </div>
        </div>
      </main>

      {/* Mobile bottom spacer */}
      <div class="mobile-nav h-14"></div>
    </body>
  </html>
);

// --- Auth middleware for dashboard ---
dashboard.use('/admin/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/admin/login') return next();
  const cookie = getCookie(c, 'admin_session');
  if (!cookie || !verifySessionToken(cookie, c.env.ADMIN_API_KEY)) return c.redirect('/admin/login');
  return next();
});

// --- Login ---
dashboard.get('/admin/login', (c) => {
  const error = c.req.query('error');
  return c.html(
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ログイン - LINE Attend Agent</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{__html: `tailwind.config={theme:{extend:{fontFamily:{sans:['Inter','Noto Sans JP','system-ui','sans-serif']}}}}`}} />
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-6px); } }
          @keyframes fade-up { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
          .float-gentle { animation: float 3s ease-in-out infinite; }
          .fade-up { animation: fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1); }
          .fade-up-delay { animation: fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both; }
        `}} />
      </head>
      <body class="min-h-screen font-sans antialiased flex items-center justify-center relative overflow-hidden" style="background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 40%, #312e81 70%, #4f46e5 100%)">
        {/* Background decoration */}
        <div class="absolute inset-0 overflow-hidden pointer-events-none">
          <div class="absolute top-1/4 -left-20 w-72 h-72 bg-indigo-500/10 rounded-full blur-3xl"></div>
          <div class="absolute bottom-1/4 -right-20 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl"></div>
          <div class="absolute top-10 right-1/4 w-48 h-48 bg-blue-500/5 rounded-full blur-2xl"></div>
        </div>

        <div class="relative z-10 w-full max-w-sm mx-4">
          {/* Logo */}
          <div class="text-center mb-8 fade-up">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-2xl shadow-indigo-500/30 mb-4 float-gentle">
              <span class="text-white text-xl font-extrabold">AI</span>
            </div>
            <h1 class="text-2xl font-bold text-white">Attend Agent</h1>
            <p class="text-indigo-300/70 text-sm mt-1">AIコンシェルジュ管理画面</p>
          </div>

          {/* Login Card */}
          <div class="fade-up-delay bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl">
            {error && (
              <div class="mb-4 px-4 py-3 rounded-xl bg-red-500/15 border border-red-400/20">
                <p class="text-red-300 text-sm flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                  認証キーが正しくありません
                </p>
              </div>
            )}
            <form method="post" action="/admin/login">
              <label class="block mb-2 text-sm font-medium text-indigo-200">管理キー</label>
              <input
                type="password"
                name="key"
                required
                autofocus
                placeholder="管理キーを入力..."
                class="w-full bg-white/10 border border-white/15 rounded-xl px-4 py-3 text-white placeholder-indigo-300/40 focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:border-transparent transition mb-5"
              />
              <button type="submit" class="w-full bg-gradient-to-r from-indigo-500 to-purple-600 text-white py-3 rounded-xl font-semibold hover:from-indigo-400 hover:to-purple-500 transition-all shadow-lg shadow-indigo-500/25 active:scale-[0.98]">
                ログイン
              </button>
            </form>
          </div>

          <p class="text-center text-indigo-400/40 text-xs mt-6">LINE Attend Agent v2.0</p>
        </div>
      </body>
    </html>
  );
});

dashboard.post('/admin/login', async (c) => {
  const body = await c.req.parseBody();
  const key = body['key'] as string;
  if (key !== c.env.ADMIN_API_KEY) return c.redirect('/admin/login?error=1');
  setCookie(c, 'admin_session', hashSessionToken(key), {
    path: '/admin',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: 60 * 60 * 24,
  });
  return c.redirect('/admin/');
});

dashboard.post('/admin/logout', (c) => {
  deleteCookie(c, 'admin_session', { path: '/admin' });
  return c.redirect('/admin/login');
});

// --- Dashboard Home ---
dashboard.get('/admin/', async (c) => {
  const supabase = getSupabaseClient(c.env);
  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, name, is_active, created_at')
    .order('created_at', { ascending: false });

  const [metrics, activity] = await Promise.all([
    getAllFunnelMetrics(c.env),
    getRecentActivity(c.env, 15),
  ]);

  // Get mission data for each active tenant
  const activeTenantIds = (tenants || []).filter(t => t.is_active).map(t => t.id);
  const missions: Record<string, TodaysMission> = {};
  for (const tid of activeTenantIds.slice(0, 5)) {
    missions[tid] = await getTodaysMission(tid, c.env);
  }

  const totalUsers = metrics.reduce((s, m) => s + (m.total_users || 0), 0);
  const totalBooked = metrics.reduce((s, m) => s + (m.booked_users || 0), 0);
  const totalConsulted = metrics.reduce((s, m) => s + (m.consulted_users || 0), 0);
  const totalEnrolled = metrics.reduce((s, m) => s + (m.enrolled_users || 0), 0);

  // Aggregate missions
  const totalHotLeads = Object.values(missions).reduce((s, m) => s + m.hot_leads, 0);
  const totalNeedsManual = Object.values(missions).reduce((s, m) => s + m.needs_manual, 0);
  const totalConsultationsToday = Object.values(missions).reduce((s, m) => s + m.scheduled_consultations_today, 0);
  const totalNoShows = Object.values(missions).reduce((s, m) => s + m.no_shows_to_recover, 0);
  const totalMissionItems = totalHotLeads + totalNeedsManual + totalConsultationsToday + totalNoShows;

  const greeting = new Date().getHours() < 12 ? 'おはようございます' : new Date().getHours() < 18 ? 'こんにちは' : 'お疲れ様です';

  return c.html(
    <Layout title="ダッシュボード">
      {/* Header with greeting */}
      <div class="flex justify-between items-start mb-8">
        <div>
          <p class="text-slate-400 text-sm mb-1">{greeting}</p>
          <h1 class="text-2xl font-bold text-slate-800">ダッシュボード</h1>
        </div>
        <a href="/admin/tenants/new" class="inline-flex items-center gap-2 gradient-hero text-white px-5 py-2.5 rounded-xl hover:opacity-90 transition shadow-lg shadow-indigo-500/20 text-sm font-semibold">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新規テナント
        </a>
      </div>

      {/* TODAY'S MISSION */}
      {totalMissionItems > 0 && (
        <div class="mb-8 gradient-dark rounded-2xl p-6 text-white shadow-xl slide-in overflow-hidden relative">
          <div class="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 pointer-events-none"></div>
          <div class="relative">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              </div>
              <div>
                <h2 class="font-bold text-base">今日のミッション</h2>
                <p class="text-white/50 text-xs">{totalMissionItems}件のアクション</p>
              </div>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              {totalConsultationsToday > 0 && (
                <div class="bg-white/[0.08] rounded-xl p-4 border border-white/[0.06] hover:bg-white/[0.12] transition">
                  <div class="flex items-center gap-2 mb-3">
                    <span class="w-2 h-2 rounded-full bg-red-400 pulse-dot"></span>
                    <span class="text-[10px] font-bold text-red-300 uppercase tracking-wider">CRITICAL</span>
                  </div>
                  <p class="text-3xl font-extrabold tracking-tight">{totalConsultationsToday}</p>
                  <p class="text-white/50 text-xs mt-1.5">本日の相談会</p>
                </div>
              )}
              {totalHotLeads > 0 && (
                <div class="bg-white/[0.08] rounded-xl p-4 border border-white/[0.06] hover:bg-white/[0.12] transition">
                  <div class="flex items-center gap-2 mb-3">
                    <span class="w-2 h-2 rounded-full bg-orange-400 pulse-dot"></span>
                    <span class="text-[10px] font-bold text-orange-300 uppercase tracking-wider">HOT</span>
                  </div>
                  <p class="text-3xl font-extrabold tracking-tight">{totalHotLeads}</p>
                  <p class="text-white/50 text-xs mt-1.5">反応ありリード</p>
                </div>
              )}
              {totalNoShows > 0 && (
                <div class="bg-white/[0.08] rounded-xl p-4 border border-white/[0.06] hover:bg-white/[0.12] transition">
                  <div class="flex items-center gap-2 mb-3">
                    <span class="w-2 h-2 rounded-full bg-amber-400"></span>
                    <span class="text-[10px] font-bold text-amber-300 uppercase tracking-wider">RECOVERY</span>
                  </div>
                  <p class="text-3xl font-extrabold tracking-tight">{totalNoShows}</p>
                  <p class="text-white/50 text-xs mt-1.5">ノーショー回復</p>
                </div>
              )}
              {totalNeedsManual > 0 && (
                <div class="bg-white/[0.08] rounded-xl p-4 border border-white/[0.06] hover:bg-white/[0.12] transition">
                  <div class="flex items-center gap-2 mb-3">
                    <span class="w-2 h-2 rounded-full bg-yellow-400"></span>
                    <span class="text-[10px] font-bold text-yellow-300 uppercase tracking-wider">MANUAL</span>
                  </div>
                  <p class="text-3xl font-extrabold tracking-tight">{totalNeedsManual}</p>
                  <p class="text-white/50 text-xs mt-1.5">手動対応必要</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      {metrics.length > 0 && (
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div class="card p-5">
            <div class="flex items-center gap-2 mb-3">
              <div class="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
              </div>
              <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">総ユーザー</p>
            </div>
            <p class="text-3xl font-extrabold text-slate-800 count-up">{totalUsers}</p>
          </div>
          <div class="card p-5">
            <div class="flex items-center gap-2 mb-3">
              <div class="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </div>
              <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">予約済み</p>
            </div>
            <p class="text-3xl font-extrabold text-amber-600 count-up">{totalBooked}</p>
            <p class="text-xs text-slate-400 mt-1">{totalUsers > 0 ? Math.round(totalBooked / totalUsers * 100) : 0}%</p>
          </div>
          <div class="card p-5">
            <div class="flex items-center gap-2 mb-3">
              <div class="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
              <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">相談済み</p>
            </div>
            <p class="text-3xl font-extrabold text-emerald-600 count-up">{totalConsulted}</p>
            <p class="text-xs text-slate-400 mt-1">{totalBooked > 0 ? Math.round(totalConsulted / totalBooked * 100) : 0}% 着座率</p>
          </div>
          <div class="gradient-hero p-5 rounded-2xl shadow-lg shadow-indigo-500/15 text-white">
            <div class="flex items-center gap-2 mb-3">
              <div class="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
              </div>
              <p class="text-xs font-medium text-white/60 uppercase tracking-wider">成約</p>
            </div>
            <p class="text-3xl font-extrabold count-up">{totalEnrolled}</p>
            <p class="text-xs text-white/60 mt-1">CVR {totalUsers > 0 ? Math.round(totalEnrolled / totalUsers * 100) : 0}%</p>
          </div>
        </div>
      )}

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Tenant list */}
        <div class="lg:col-span-2 card overflow-hidden">
          <div class="px-5 py-4 border-b border-slate-100 flex justify-between items-center">
            <div class="flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
              <h2 class="font-bold text-slate-700">テナント</h2>
            </div>
            <span class="text-xs text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full">{(tenants || []).length}件</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr class="text-[10px] text-slate-400 uppercase tracking-widest bg-slate-50/50">
                  <th class="text-left px-5 py-2.5 font-semibold">名前</th>
                  <th class="text-left px-5 py-2.5 font-semibold">状態</th>
                  <th class="text-right px-5 py-2.5 font-semibold">ユーザー</th>
                  <th class="text-right px-5 py-2.5 font-semibold">着座率</th>
                  <th class="text-center px-5 py-2.5 font-semibold">ミッション</th>
                  <th class="text-right px-5 py-2.5 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {(tenants || []).map((t) => {
                  const m = metrics.find((met) => met.tenant_id === t.id);
                  const mission = missions[t.id];
                  const missionCount = mission ? mission.priority_actions.reduce((s, a) => s + a.count, 0) : 0;
                  return (
                    <tr class="border-t border-slate-50 hover:bg-slate-50/50 transition group">
                      <td class="px-5 py-3.5">
                        <a href={`/admin/tenants/${t.id}`} class="font-semibold text-slate-700 hover:text-indigo-600 transition">{t.name}</a>
                      </td>
                      <td class="px-5 py-3.5">
                        {t.is_active ? (
                          <span class="inline-flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 pulse-dot"></span>稼働中
                          </span>
                        ) : (
                          <span class="text-xs text-slate-400">停止</span>
                        )}
                      </td>
                      <td class="px-5 py-3.5 text-right font-semibold text-slate-600 tabular-nums">{m?.total_users ?? 0}</td>
                      <td class="px-5 py-3.5 text-right">
                        {m?.attendance_rate != null ? (
                          <span class={`font-bold text-sm tabular-nums ${(m.attendance_rate || 0) >= 60 ? 'text-emerald-600' : (m.attendance_rate || 0) >= 40 ? 'text-amber-600' : 'text-red-500'}`}>
                            {m.attendance_rate}%
                          </span>
                        ) : <span class="text-slate-300">-</span>}
                      </td>
                      <td class="px-5 py-3.5 text-center">
                        {missionCount > 0 ? (
                          <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-red-50 text-red-600 text-xs font-bold border border-red-100">
                            <span class="w-1.5 h-1.5 rounded-full bg-red-500 pulse-dot"></span>{missionCount}
                          </span>
                        ) : <span class="text-xs text-slate-300">-</span>}
                      </td>
                      <td class="px-5 py-3.5 text-right">
                        <div class="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition">
                          <a href={`/admin/tenants/${t.id}/users`} class="px-2.5 py-1 rounded-lg text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition">ユーザー</a>
                          <a href={`/admin/tenants/${t.id}/analytics`} class="px-2.5 py-1 rounded-lg text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition">分析</a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(!tenants || tenants.length === 0) && (
            <div class="empty-state">
              <div class="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
              </div>
              <p class="text-slate-500 font-medium mb-1">テナントがまだありません</p>
              <p class="text-slate-400 text-sm mb-4">最初のテナントを作成してAIエージェントを始めましょう</p>
              <a href="/admin/tenants/new" class="inline-flex items-center gap-1.5 text-indigo-600 hover:text-indigo-700 text-sm font-semibold transition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                テナントを作成
              </a>
            </div>
          )}
        </div>

        {/* Activity Feed */}
        <div class="card overflow-hidden flex flex-col">
          <div class="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            <h2 class="font-bold text-slate-700">アクティビティ</h2>
          </div>
          <div class="divide-y divide-slate-50 flex-1 max-h-[420px] overflow-y-auto custom-scrollbar">
            {activity.length > 0 ? activity.map((evt) => (
              <div class="px-5 py-3.5 hover:bg-slate-50/50 transition">
                <div class="flex items-start gap-3">
                  <span class={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${activityDotColor(evt.type)}`}></span>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm text-slate-700">
                      <span class="font-semibold">{evt.user_name || '新規ユーザー'}</span>
                      <span class="text-slate-400 mx-1.5">{activityVerb(evt.type)}</span>
                    </p>
                    <p class="text-xs text-slate-400 mt-0.5">{evt.tenant_name} ・ {timeAgo(evt.timestamp)}</p>
                  </div>
                </div>
              </div>
            )) : (
              <div class="empty-state py-12">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="1.5" class="mb-3"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                <p class="text-sm text-slate-400">アクティビティがまだありません</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
});

// --- Create Tenant Form ---
dashboard.get('/admin/tenants/new', (c) => {
  const defaults = getDefaultConfigs();
  return c.html(
    <Layout title="テナント作成">
      <div class="max-w-2xl mx-auto">
        <div class="mb-8">
          <a href="/admin/" class="text-sm text-slate-400 hover:text-slate-600 transition flex items-center gap-1 mb-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            ダッシュボード
          </a>
          <h1 class="text-2xl font-bold text-slate-800">新しいテナントを作成</h1>
          <p class="text-slate-500 text-sm mt-1">スクールやビジネスの情報を入力してAIエージェントを始めましょう</p>
        </div>

        {/* Quick start tip */}
        <div class="card p-4 mb-6 flex items-start gap-3 border-l-4 border-l-emerald-400">
          <div class="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0 mt-0.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div>
            <p class="text-sm font-medium text-slate-700">推奨設定がプリセット済み</p>
            <p class="text-xs text-slate-400 mt-0.5">スクール名とスクール情報を入力するだけですぐに始められます。細かい設定はあとから変更できます。</p>
          </div>
        </div>

        <form method="post" action="/admin/tenants/new" class="space-y-6">
          {/* 基本情報 */}
          <div class="card p-6">
            <div class="flex items-center gap-2 mb-5">
              <div class="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
              </div>
              <h2 class="font-bold text-slate-800">基本情報</h2>
            </div>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1.5">スクール名 <span class="text-red-400">*</span></label>
                <input type="text" name="name" required class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition" placeholder="例: ABCプログラミングスクール" />
              </div>
              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1.5">
                  スクール情報 <span class="text-red-400">*</span>
                  <span class="text-slate-400 font-normal ml-1">(AIの会話の土台になります)</span>
                </label>
                <textarea name="school_context" rows={5} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition" placeholder={"例: ABCプログラミングスクールは、未経験からWebエンジニア転職を目指す方向けのオンラインスクールです。\n\n特徴:\n- 3ヶ月の集中カリキュラム\n- 現役エンジニアによる1on1メンタリング\n- 転職保証付き\n\n無料相談会では、受講生の転職実績やカリキュラムの詳細をご紹介します。"}></textarea>
                <p class="text-xs text-slate-400 mt-1.5">詳しく書くほどAIが的確な会話をします</p>
              </div>
            </div>
          </div>

          {/* LINE接続（オプショナル） */}
          <details class="card overflow-hidden group">
            <summary class="p-6 cursor-pointer hover:bg-slate-50/50 transition flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-lg bg-green-50 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
                </div>
                <div>
                  <h2 class="font-bold text-slate-800 text-sm">LINE直接接続</h2>
                  <p class="text-xs text-slate-400">Lステップを使わない場合のみ必要</p>
                </div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" class="group-open:rotate-180 transition-transform"><polyline points="6 9 12 15 18 9"/></svg>
            </summary>
            <div class="px-6 pb-6 space-y-3 border-t border-slate-100 pt-4">
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">LINE Channel ID</label>
                <input type="text" name="line_channel_id" class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition" placeholder="LINE Developers Consoleから取得" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">LINE Channel Secret</label>
                <input type="text" name="line_channel_secret" class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">LINE Channel Access Token</label>
                <textarea name="line_channel_access_token" rows={2} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition"></textarea>
              </div>
            </div>
          </details>

          {/* 会話フロー設定（折りたたみ） */}
          <details class="card overflow-hidden group">
            <summary class="p-6 cursor-pointer hover:bg-slate-50/50 transition flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-lg bg-purple-50 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                </div>
                <div>
                  <h2 class="font-bold text-slate-800 text-sm">詳細設定</h2>
                  <p class="text-xs text-slate-400">推奨設定がプリセット済み・あとから変更可</p>
                </div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" class="group-open:rotate-180 transition-transform"><polyline points="6 9 12 15 18 9"/></svg>
            </summary>
            <div class="px-6 pb-6 space-y-4 border-t border-slate-100 pt-4">
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">シナリオ設定 (JSON)</label>
                <textarea name="scenario_config" rows={6} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition">{JSON.stringify(defaults.scenario_config, null, 2)}</textarea>
              </div>

        {/* Hearing Config */}
        <div class="pb-4">
          <h3 class="text-sm font-bold text-slate-700 mb-2">ヒアリング項目</h3>
          <p class="text-xs text-slate-400 mb-2">ユーザーに聞きたい質問を設定します。</p>
          <div id="hearing-items">
            {(defaults.hearing_config as { items: Array<{ id: string; question_hint: string; required: boolean; priority: number }> }).items.map((item, i) => (
              <HearingItemRow item={item} index={i} />
            ))}
          </div>
          <script dangerouslySetInnerHTML={{__html: `
            document.getElementById('add-hearing-btn')?.addEventListener('click', function() {
              var container = document.getElementById('hearing-items');
              var idx = container.querySelectorAll('.hearing-row').length;
              var row = document.createElement('div');
              row.className = 'hearing-row flex gap-2 items-start mb-2';
              row.innerHTML = '<input type="hidden" name="hearing_id" value="item_'+(idx+1)+'">'
                + '<input type="text" name="hearing_hint" placeholder="質問のヒント" class="flex-1 border rounded px-2 py-1 text-sm">'
                + '<label class="flex items-center gap-1 text-sm"><input type="checkbox" name="hearing_required" value="on" checked>必須</label>'
                + '<input type="number" name="hearing_priority" value="'+(idx+1)+'" min="1" class="w-16 border rounded px-2 py-1 text-sm">'
                + '<button type="button" onclick="this.parentElement.remove()" class="text-red-500 text-sm px-1">x</button>';
              container.appendChild(row);
            });
          `}} />
          <button type="button" id="add-hearing-btn" class="mt-2 text-sm text-indigo-600 hover:underline">+ 項目を追加</button>
        </div>

        {/* Reminder Config */}
        <div class="pb-4">
          <h3 class="text-sm font-bold text-slate-700 mb-2">リマインド設定</h3>
          <div id="reminder-items">
            {(defaults.reminder_config as { pre_consultation: Array<{ timing: string; type: string; content?: string; purpose?: string }> }).pre_consultation.map((r, i) => (
              <ReminderItemRow reminder={r} index={i} />
            ))}
          </div>
          <script dangerouslySetInnerHTML={{__html: `
            document.getElementById('add-reminder-btn')?.addEventListener('click', function() {
              var container = document.getElementById('reminder-items');
              var row = document.createElement('div');
              row.className = 'reminder-row border rounded p-3 mb-2 bg-gray-50';
              row.innerHTML = '<div class="flex gap-2 mb-1">'
                + '<input type="text" name="reminder_timing" placeholder="例: 1_day_before" class="flex-1 border rounded px-2 py-1 text-sm">'
                + '<select name="reminder_type" class="border rounded px-2 py-1 text-sm"><option value="template">テンプレート</option><option value="ai">AI生成</option></select>'
                + '<button type="button" onclick="this.closest(\\'.reminder-row\\').remove()" class="text-red-500 text-sm px-1">x</button>'
                + '</div>'
                + '<input type="text" name="reminder_content" placeholder="テンプレート内容" class="w-full border rounded px-2 py-1 text-sm mb-1">'
                + '<input type="text" name="reminder_purpose" placeholder="AI目的" class="w-full border rounded px-2 py-1 text-sm">';
              container.appendChild(row);
            });
          `}} />
          <button type="button" id="add-reminder-btn" class="mt-2 text-sm text-indigo-600 hover:underline">+ リマインドを追加</button>

          <h3 class="text-sm font-bold mt-4 mb-2">追客設定</h3>
          <div class="space-y-2">
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" name="followup_enabled" value="on" checked />
              無応答時の自動追客を有効にする
            </label>
            <div class="flex gap-4">
              <label class="flex items-center gap-1 text-sm">
                <input type="radio" name="followup_strategy" value="fixed" checked /> 固定間隔
              </label>
              <label class="flex items-center gap-1 text-sm">
                <input type="radio" name="followup_strategy" value="ai_decided" /> AI判断
              </label>
            </div>
            <div class="flex gap-4">
              <div>
                <label class="block text-xs text-gray-500">最大回数</label>
                <input type="number" name="followup_max_attempts" value="4" min="1" max="10" class="w-20 border rounded px-2 py-1 text-sm" />
              </div>
              <div>
                <label class="block text-xs text-gray-500">最小間隔(時間)</label>
                <input type="number" name="followup_min_interval" value="24" min="1" class="w-20 border rounded px-2 py-1 text-sm" />
              </div>
              <div>
                <label class="block text-xs text-gray-500">最大間隔(時間)</label>
                <input type="number" name="followup_max_interval" value="72" min="1" class="w-20 border rounded px-2 py-1 text-sm" />
              </div>
            </div>
            <div>
              <label class="block text-xs text-gray-500">エスカレーションメッセージ</label>
              <input type="text" name="followup_escalation_message" value={(defaults.reminder_config as { no_response_follow_up: { escalation_message: string } }).no_response_follow_up.escalation_message} class="w-full border rounded px-2 py-1 text-sm" />
            </div>
          </div>
        </div>

        {/* Tone Config */}
        <div class="pb-4">
          <h3 class="text-sm font-bold text-slate-700 mb-2">トーン設定</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm font-medium mb-1">パーソナリティ</label>
              <select name="tone_personality" class="w-full border rounded px-3 py-2">
                {['friendly', 'professional', 'casual', 'warm', 'energetic'].map((p) => (
                  <option value={p} selected={p === (defaults.tone_config as { personality: string }).personality}>{toneLabel('personality', p)}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">絵文字の使用</label>
              <select name="tone_emoji" class="w-full border rounded px-3 py-2">
                {['none', 'minimal', 'moderate', 'frequent'].map((e) => (
                  <option value={e} selected={e === (defaults.tone_config as { emoji_usage: string }).emoji_usage}>{toneLabel('emoji', e)}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">文体</label>
              <select name="tone_style" class="w-full border rounded px-3 py-2">
                {['polite', 'casual', 'formal', 'friendly-polite'].map((s) => (
                  <option value={s} selected={s === (defaults.tone_config as { language_style: string }).language_style}>{toneLabel('style', s)}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">カスタム指示</label>
              <textarea name="tone_custom" rows={2} class="w-full border rounded px-3 py-2 text-sm" placeholder="追加の指示があれば入力">{(defaults.tone_config as { custom_instructions: string }).custom_instructions}</textarea>
            </div>
          </div>
        </div>

        {/* Guardrail Config */}
        <div class="pb-4">
          <h3 class="text-sm font-bold text-slate-700 mb-2">ガードレール設定</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm font-medium mb-1">禁止トピック</label>
              <p class="text-xs text-gray-500 mb-1">カンマ区切りで入力</p>
              <input type="text" name="guardrail_topics" value={(defaults.guardrail_config as { forbidden_topics: string[] }).forbidden_topics.join(', ')} class="w-full border rounded px-3 py-2 text-sm" placeholder="例: 他社批判, 政治, 宗教" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">禁止表現</label>
              <p class="text-xs text-gray-500 mb-1">カンマ区切りで入力</p>
              <input type="text" name="guardrail_expressions" value={(defaults.guardrail_config as { forbidden_expressions: string[] }).forbidden_expressions.join(', ')} class="w-full border rounded px-3 py-2 text-sm" placeholder="例: 絶対, 確実, 保証" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">回答範囲</label>
              <textarea name="guardrail_scope" rows={2} class="w-full border rounded px-3 py-2 text-sm">{(defaults.guardrail_config as { answer_scope: string }).answer_scope}</textarea>
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">人間エスカレーション条件</label>
              <input type="text" name="guardrail_handoff" value={(defaults.guardrail_config as { human_handoff_trigger: string }).human_handoff_trigger} class="w-full border rounded px-3 py-2 text-sm" />
            </div>
          </div>
        </div>

        {/* Notification Config */}
        <div class="pb-4">
          <h3 class="text-sm font-bold text-slate-700 mb-2">スタッフ通知設定</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm font-medium mb-1">通知方法</label>
              <div class="flex gap-4">
                <label class="flex items-center gap-1 text-sm">
                  <input type="radio" name="notification_method" value="line" checked /> LINE
                </label>
                <label class="flex items-center gap-1 text-sm">
                  <input type="radio" name="notification_method" value="email" /> メール
                </label>
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">通知先スタッフ LINE User ID</label>
              <p class="text-xs text-gray-500 mb-1">カンマ区切りで入力</p>
              <input type="text" name="notification_staff_ids" class="w-full border rounded px-3 py-2 text-sm" placeholder="Uxxxxxx, Uyyyyyy" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">通知タイミング</label>
              <div class="flex flex-wrap gap-3">
                {['human_handoff', 'no_show', 'stalled', 'error'].map((evt) => (
                  <label class="flex items-center gap-1 text-sm">
                    <input type="checkbox" name="notification_on" value={evt} checked />
                    {notifyEventLabel(evt)}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

            </div>
          </details>

          {/* Submit */}
          <button type="submit" class="w-full gradient-hero text-white px-6 py-3.5 rounded-xl hover:opacity-90 transition text-base font-bold shadow-lg shadow-indigo-500/20 active:scale-[0.98]">
            テナントを作成
          </button>
        </form>
      </div>
    </Layout>
  );
});

dashboard.post('/admin/tenants/new', async (c) => {
  const body = await c.req.parseBody() as Record<string, string | string[]>;
  const payload = {
    name: body['name'],
    line_channel_id: body['line_channel_id'],
    line_channel_secret: body['line_channel_secret'],
    line_channel_access_token: body['line_channel_access_token'],
    school_context: body['school_context'] || '',
    scenario_config: safeParseJSON(body['scenario_config'] as string, {}),
    hearing_config: parseHearingForm(body),
    reminder_config: parseReminderForm(body),
    tone_config: parseToneForm(body),
    guardrail_config: parseGuardrailForm(body),
    notification_config: parseNotificationForm(body),
  };

  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase.from('tenants').insert(payload).select().single();

  if (error) {
    return c.html(
      <Layout title="エラー">
        <p class="text-red-500">作成に失敗しました: {error.message}</p>
        <a href="/admin/tenants/new" class="text-indigo-600 hover:underline">戻る</a>
      </Layout>
    );
  }
  return c.redirect(`/admin/tenants/${data.id}`);
});

// --- Tenant Detail / Edit ---
dashboard.get('/admin/tenants/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', id).single();
  if (!tenant) return c.html(<Layout title="Not Found"><p>テナントが見つかりません</p></Layout>);

  const webhookUrl = `https://line-attend-agent.toshiki7124.workers.dev/webhook/${tenant.id}`;
  const hearingItems = tenant.hearing_config?.items || [];
  const toneConfig = tenant.tone_config || { personality: 'friendly', emoji_usage: 'moderate', language_style: 'polite', custom_instructions: '' };
  const guardrailConfig = tenant.guardrail_config || { forbidden_topics: [], forbidden_expressions: [], answer_scope: '', human_handoff_trigger: '' };
  const notifConfig = tenant.notification_config || { method: 'line', staff_line_user_ids: [], notify_on: [] };
  const reminderConfig = tenant.reminder_config || { pre_consultation: [], no_response_follow_up: { enabled: true, strategy: 'fixed', max_attempts: 4, min_interval_hours: 24, max_interval_hours: 72, escalation_message: '' } };
  const scenarioSteps: ScenarioStep[] = tenant.scenario_config?.steps || [];

  // Fetch AI impact metrics for the hero banner
  const analytics = await getDetailedAnalytics(id, c.env);
  const aiPerf = analytics?.ai_performance;
  const funnel = analytics?.funnel;

  return c.html(
    <Layout title={tenant.name}>
      {/* Header */}
      <div class="mb-6">
        <a href="/admin/" class="text-sm text-slate-400 hover:text-slate-600 transition flex items-center gap-1 mb-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          ダッシュボード
        </a>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl gradient-hero flex items-center justify-center text-white font-bold text-sm shadow-md">
              {tenant.name[0]}
            </div>
            <div>
              <h1 class="text-xl font-bold text-slate-800">{tenant.name}</h1>
              <span class={`inline-flex items-center gap-1 text-xs font-medium ${tenant.is_active ? 'text-emerald-600' : 'text-slate-400'}`}>
                {tenant.is_active && <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 pulse-dot"></span>}
                {tenant.is_active ? '稼働中' : '停止中'}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <a href={`/admin/tenants/${id}/simulator`} class="inline-flex items-center gap-1.5 gradient-hero text-white px-4 py-2 rounded-xl hover:opacity-90 transition text-sm font-semibold shadow-md shadow-indigo-500/20">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              AIシミュレーター
            </a>
          </div>
        </div>
      </div>

      {/* Quick nav tabs */}
      <div class="flex gap-1 mb-6 overflow-x-auto pb-1 -mx-2 px-2">
        {[
          { href: `/admin/tenants/${id}/users`, label: 'ユーザー', icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>' },
          { href: `/admin/tenants/${id}/analytics`, label: '分析', icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' },
          { href: `/admin/tenants/${id}/bookings`, label: '予約', icon: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>' },
          { href: `/admin/tenants/${id}/sessions`, label: 'AIセッション', icon: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>' },
          { href: `/admin/tenants/${id}/actions`, label: 'アクション', icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
          { href: `/admin/tenants/${id}/live`, label: 'ライブ会話', icon: '<path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>' },
        ].map((tab) => (
          <a href={tab.href} class="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition whitespace-nowrap">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" dangerouslySetInnerHTML={{__html: tab.icon}}></svg>
            {tab.label}
          </a>
        ))}
      </div>

      {/* API Integration Card */}
      <div class="card p-5 mb-6">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>
            </div>
            <h2 class="font-bold text-slate-700 text-sm">API連携</h2>
          </div>
          <form method="post" action={`/admin/api/tenants/${tenant.id}/api-key`}>
            <button type="submit" class="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-3 py-1.5 rounded-lg hover:bg-emerald-100 transition font-medium">
              {tenant.api_key_prefix ? 'APIキーを再生成' : 'APIキーを生成'}
            </button>
          </form>
        </div>
        <div class="flex items-center gap-4 text-xs">
          {tenant.api_key_prefix ? (
            <span class="inline-flex items-center gap-1.5 text-emerald-600">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              APIキー設定済み（{tenant.api_key_prefix}...）
            </span>
          ) : (
            <span class="text-slate-400">APIキーが未設定です</span>
          )}
          <span class="text-slate-300">|</span>
          <code class="text-slate-400 text-[11px]">Base: https://line-attend-agent.toshiki7124.workers.dev/api/v1/</code>
        </div>
      </div>

      {/* AI Performance Summary */}
      {aiPerf && funnel && (
        <div class="gradient-dark rounded-2xl p-6 mb-6 text-white shadow-xl overflow-hidden relative">
          <div class="absolute top-0 right-0 w-48 h-48 bg-indigo-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4 pointer-events-none"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                </div>
                <h2 class="font-bold text-sm">AIパフォーマンス</h2>
                <span class="text-white/30 text-xs">直近7日間</span>
              </div>
              <a href={`/admin/tenants/${id}/analytics`} class="text-xs text-indigo-300 hover:text-white transition flex items-center gap-1">
                詳細
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
              </a>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="bg-white/[0.07] rounded-xl p-3.5 text-center border border-white/[0.05]">
                <p class="text-2xl font-extrabold tracking-tight">{aiPerf.auto_resolution_rate}%</p>
                <p class="text-[10px] text-white/40 mt-0.5">AI自動対応率</p>
              </div>
              <div class="bg-white/[0.07] rounded-xl p-3.5 text-center border border-white/[0.05]">
                <p class="text-2xl font-extrabold tracking-tight text-emerald-400">{aiPerf.estimated_hours_saved}h</p>
                <p class="text-[10px] text-white/40 mt-0.5">削減時間</p>
              </div>
              <div class="bg-white/[0.07] rounded-xl p-3.5 text-center border border-white/[0.05]">
                <p class="text-2xl font-extrabold tracking-tight text-amber-400">&yen;{aiPerf.estimated_cost_saved.toLocaleString()}</p>
                <p class="text-[10px] text-white/40 mt-0.5">コスト削減</p>
              </div>
              <div class="bg-white/[0.07] rounded-xl p-3.5 text-center border border-white/[0.05]">
                <p class="text-2xl font-extrabold tracking-tight">{funnel.attendance_rate ?? '--'}%</p>
                <p class="text-[10px] text-white/40 mt-0.5">着座率</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Phase 5: Flow Visualization */}
      {scenarioSteps.length > 0 && (
        <div class="bg-white p-6 rounded shadow mb-6">
          <h2 class="text-lg font-bold mb-4">シナリオフロー</h2>
          <div class="flex flex-col items-center">
            {scenarioSteps.map((step, i) => (
              <div class="flex flex-col items-center">
                <div class={`w-80 border-2 rounded-lg p-3 text-sm ${step.type === 'template' ? 'border-blue-300 bg-blue-50' : 'border-purple-300 bg-purple-50'}`}>
                  <div class="flex justify-between items-center mb-1">
                    <span class="font-mono text-xs text-gray-500">{step.id}</span>
                    <span class={`px-2 py-0.5 rounded text-xs ${step.type === 'template' ? 'bg-blue-200 text-blue-700' : 'bg-purple-200 text-purple-700'}`}>
                      {step.type === 'template' ? 'テンプレート' : 'AI'}
                    </span>
                  </div>
                  <div class="text-xs text-gray-500 mb-1">
                    トリガー: {step.trigger} {step.delay_minutes > 0 ? `/ ${step.delay_minutes}分後` : ''}
                  </div>
                  {step.message && (
                    <p class="text-xs truncate text-gray-700">{step.message.content.slice(0, 60)}...</p>
                  )}
                  {step.ai_config && (
                    <p class="text-xs text-gray-700">目的: {step.ai_config.purpose} / 最大{step.ai_config.max_turns}ターン</p>
                  )}
                </div>
                {i < scenarioSteps.length - 1 && (
                  <div class="flex flex-col items-center my-1">
                    <div class="w-0.5 h-4 bg-gray-300"></div>
                    <div class="text-gray-400 text-xs">↓</div>
                    <div class="w-0.5 h-4 bg-gray-300"></div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <form method="post" action={`/admin/tenants/${id}/edit`} class="space-y-6">
        {/* Basic Info Card */}
        <div class="card p-6">
          <h2 class="font-bold text-slate-800 text-sm mb-4 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
            基本情報
          </h2>
          <div class="space-y-4">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1.5">スクール名</label>
              <input type="text" name="name" value={tenant.name} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition" />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1.5">スクール情報</label>
              <textarea name="school_context" rows={3} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition">{tenant.school_context}</textarea>
            </div>
          </div>
        </div>

        {/* LINE Settings (collapsible) */}
        <details class="card overflow-hidden group">
          <summary class="p-5 cursor-pointer hover:bg-slate-50/50 transition flex items-center justify-between">
            <div class="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
              <h2 class="font-bold text-slate-800 text-sm">LINE直接接続設定</h2>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" class="group-open:rotate-180 transition-transform"><polyline points="6 9 12 15 18 9"/></svg>
          </summary>
          <div class="px-5 pb-5 space-y-3 border-t border-slate-100 pt-4">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">LINE Channel ID</label>
              <input type="text" name="line_channel_id" value={tenant.line_channel_id} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition" />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">LINE Channel Secret</label>
              <input type="text" name="line_channel_secret" value={tenant.line_channel_secret} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition" />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">LINE Channel Access Token</label>
              <textarea name="line_channel_access_token" rows={2} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition">{tenant.line_channel_access_token}</textarea>
            </div>
            <p class="text-xs text-slate-400">Webhook URL: <code class="text-indigo-500">{webhookUrl}</code></p>
          </div>
        </details>

        {/* Scenario JSON (collapsible) */}
        <details class="card overflow-hidden group">
          <summary class="p-5 cursor-pointer hover:bg-slate-50/50 transition flex items-center justify-between">
            <div class="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              <h2 class="font-bold text-slate-800 text-sm">シナリオ設定 (JSON)</h2>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" class="group-open:rotate-180 transition-transform"><polyline points="6 9 12 15 18 9"/></svg>
          </summary>
          <div class="px-5 pb-5 border-t border-slate-100 pt-4">
            <textarea name="scenario_config" rows={8} class="w-full border border-slate-200 rounded-xl px-4 py-2.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition">{JSON.stringify(tenant.scenario_config, null, 2)}</textarea>
          </div>
        </details>

        {/* Hearing */}
        <div class="card p-6">
          <h2 class="font-bold text-slate-800 text-sm mb-3 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            ヒアリング項目
          </h2>
          <div id="hearing-items">
            {hearingItems.map((item: { id: string; question_hint: string; required: boolean; priority: number }, i: number) => (
              <HearingItemRow item={item} index={i} />
            ))}
          </div>
          <script dangerouslySetInnerHTML={{__html: `
            document.getElementById('add-hearing-btn')?.addEventListener('click', function() {
              var container = document.getElementById('hearing-items');
              var idx = container.querySelectorAll('.hearing-row').length;
              var row = document.createElement('div');
              row.className = 'hearing-row flex gap-2 items-start mb-2';
              row.innerHTML = '<input type="hidden" name="hearing_id" value="item_'+(idx+1)+'">'
                + '<input type="text" name="hearing_hint" placeholder="質問のヒント" class="flex-1 border rounded px-2 py-1 text-sm">'
                + '<label class="flex items-center gap-1 text-sm"><input type="checkbox" name="hearing_required" value="on" checked>必須</label>'
                + '<input type="number" name="hearing_priority" value="'+(idx+1)+'" min="1" class="w-16 border rounded px-2 py-1 text-sm">'
                + '<button type="button" onclick="this.parentElement.remove()" class="text-red-500 text-sm px-1">x</button>';
              container.appendChild(row);
            });
          `}} />
          <button type="button" id="add-hearing-btn" class="mt-2 text-sm text-indigo-600 hover:underline">+ 項目を追加</button>
        </div>

        {/* Reminder */}
        <details class="card overflow-hidden group" open>
          <summary class="p-5 cursor-pointer hover:bg-slate-50/50 transition flex items-center justify-between">
            <h2 class="font-bold text-slate-800 text-sm flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
              リマインド設定
            </h2>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" class="group-open:rotate-180 transition-transform"><polyline points="6 9 12 15 18 9"/></svg>
          </summary>
          <div class="px-5 pb-5 border-t border-slate-100 pt-3">
          <h3 class="text-xs font-bold text-slate-500 mb-2">リマインドスケジュール</h3>
          <div id="reminder-items">
            {(reminderConfig.pre_consultation || []).map((r: { timing: string; type: string; content?: string; purpose?: string }, i: number) => (
              <ReminderItemRow reminder={r} index={i} />
            ))}
          </div>
          <script dangerouslySetInnerHTML={{__html: `
            document.getElementById('add-reminder-btn')?.addEventListener('click', function() {
              var container = document.getElementById('reminder-items');
              var row = document.createElement('div');
              row.className = 'reminder-row border rounded p-3 mb-2 bg-gray-50';
              row.innerHTML = '<div class="flex gap-2 mb-1">'
                + '<input type="text" name="reminder_timing" placeholder="例: 1_day_before" class="flex-1 border rounded px-2 py-1 text-sm">'
                + '<select name="reminder_type" class="border rounded px-2 py-1 text-sm"><option value="template">テンプレート</option><option value="ai">AI生成</option></select>'
                + '<button type="button" onclick="this.closest(\\'.reminder-row\\').remove()" class="text-red-500 text-sm px-1">x</button>'
                + '</div>'
                + '<input type="text" name="reminder_content" placeholder="テンプレート内容" class="w-full border rounded px-2 py-1 text-sm mb-1">'
                + '<input type="text" name="reminder_purpose" placeholder="AI目的" class="w-full border rounded px-2 py-1 text-sm">';
              container.appendChild(row);
            });
          `}} />
          <button type="button" id="add-reminder-btn" class="mt-2 text-sm text-indigo-600 hover:underline">+ リマインドを追加</button>

          <h4 class="text-xs font-bold mt-3 mb-1">追客設定</h4>
          <div class="space-y-2">
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" name="followup_enabled" value="on" checked={reminderConfig.no_response_follow_up?.enabled !== false} />
              自動追客を有効にする
            </label>
            <div class="flex gap-4">
              <label class="flex items-center gap-1 text-sm">
                <input type="radio" name="followup_strategy" value="fixed" checked={reminderConfig.no_response_follow_up?.strategy !== 'ai_decided'} /> 固定間隔
              </label>
              <label class="flex items-center gap-1 text-sm">
                <input type="radio" name="followup_strategy" value="ai_decided" checked={reminderConfig.no_response_follow_up?.strategy === 'ai_decided'} /> AI判断
              </label>
            </div>
            <div class="flex gap-4">
              <div>
                <label class="block text-xs text-gray-500">最大回数</label>
                <input type="number" name="followup_max_attempts" value={String(reminderConfig.no_response_follow_up?.max_attempts || 4)} min="1" max="10" class="w-20 border rounded px-2 py-1 text-sm" />
              </div>
              <div>
                <label class="block text-xs text-gray-500">最小間隔(時間)</label>
                <input type="number" name="followup_min_interval" value={String(reminderConfig.no_response_follow_up?.min_interval_hours || 24)} min="1" class="w-20 border rounded px-2 py-1 text-sm" />
              </div>
              <div>
                <label class="block text-xs text-gray-500">最大間隔(時間)</label>
                <input type="number" name="followup_max_interval" value={String(reminderConfig.no_response_follow_up?.max_interval_hours || 72)} min="1" class="w-20 border rounded px-2 py-1 text-sm" />
              </div>
            </div>
            <div>
              <label class="block text-xs text-gray-500">エスカレーションメッセージ</label>
              <input type="text" name="followup_escalation_message" value={reminderConfig.no_response_follow_up?.escalation_message || ''} class="w-full border rounded px-2 py-1 text-sm" />
            </div>
          </div>
          </div>
        </details>

        {/* Tone */}
        <div class="card p-6">
          <h2 class="font-bold text-slate-800 text-sm mb-3 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
            トーン設定
          </h2>
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">パーソナリティ</label>
              <select name="tone_personality" class="w-full border rounded px-2 py-1 text-sm">
                {['friendly', 'professional', 'casual', 'warm', 'energetic'].map((p) => (
                  <option value={p} selected={p === toneConfig.personality}>{toneLabel('personality', p)}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">絵文字</label>
              <select name="tone_emoji" class="w-full border rounded px-2 py-1 text-sm">
                {['none', 'minimal', 'moderate', 'frequent'].map((e) => (
                  <option value={e} selected={e === toneConfig.emoji_usage}>{toneLabel('emoji', e)}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">文体</label>
              <select name="tone_style" class="w-full border rounded px-2 py-1 text-sm">
                {['polite', 'casual', 'formal', 'friendly-polite'].map((s) => (
                  <option value={s} selected={s === toneConfig.language_style}>{toneLabel('style', s)}</option>
                ))}
              </select>
            </div>
          </div>
          <div class="mt-2">
            <label class="block text-xs text-gray-500 mb-1">カスタム指示</label>
            <textarea name="tone_custom" rows={2} class="w-full border rounded px-2 py-1 text-sm">{toneConfig.custom_instructions}</textarea>
          </div>
        </div>

        {/* Guardrail */}
        <div class="card p-6">
          <h2 class="font-bold text-slate-800 text-sm mb-3 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            ガードレール設定
          </h2>
          <div class="space-y-2">
            <div>
              <label class="block text-xs text-gray-500 mb-1">禁止トピック（カンマ区切り）</label>
              <input type="text" name="guardrail_topics" value={guardrailConfig.forbidden_topics.join(', ')} class="w-full border rounded px-2 py-1 text-sm" />
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">禁止表現（カンマ区切り）</label>
              <input type="text" name="guardrail_expressions" value={guardrailConfig.forbidden_expressions.join(', ')} class="w-full border rounded px-2 py-1 text-sm" />
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">回答範囲</label>
              <textarea name="guardrail_scope" rows={2} class="w-full border rounded px-2 py-1 text-sm">{guardrailConfig.answer_scope}</textarea>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">人間エスカレーション条件</label>
              <input type="text" name="guardrail_handoff" value={guardrailConfig.human_handoff_trigger} class="w-full border rounded px-2 py-1 text-sm" />
            </div>
          </div>
        </div>

        {/* Notification */}
        <details class="card overflow-hidden group">
          <summary class="p-5 cursor-pointer hover:bg-slate-50/50 transition flex items-center justify-between">
            <h2 class="font-bold text-slate-800 text-sm flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
              スタッフ通知設定
            </h2>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" class="group-open:rotate-180 transition-transform"><polyline points="6 9 12 15 18 9"/></svg>
          </summary>
          <div class="px-5 pb-5 border-t border-slate-100 pt-3">
          <div class="space-y-2">
            <div class="flex gap-4">
              <label class="flex items-center gap-1 text-sm">
                <input type="radio" name="notification_method" value="line" checked={notifConfig.method !== 'email'} /> LINE
              </label>
              <label class="flex items-center gap-1 text-sm">
                <input type="radio" name="notification_method" value="email" checked={notifConfig.method === 'email'} /> メール
              </label>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">通知先 LINE User ID（カンマ区切り）</label>
              <input type="text" name="notification_staff_ids" value={notifConfig.staff_line_user_ids.join(', ')} class="w-full border rounded px-2 py-1 text-sm" />
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">通知タイミング</label>
              <div class="flex flex-wrap gap-3">
                {['human_handoff', 'no_show', 'stalled', 'error'].map((evt) => (
                  <label class="flex items-center gap-1 text-sm">
                    <input type="checkbox" name="notification_on" value={evt} checked={notifConfig.notify_on.includes(evt)} />
                    {notifyEventLabel(evt)}
                  </label>
                ))}
              </div>
            </div>
          </div>
          </div>
        </details>

        {/* Submit */}
        <div class="flex items-center gap-3">
          <button type="submit" class="gradient-hero text-white px-8 py-3 rounded-xl hover:opacity-90 transition text-sm font-bold shadow-lg shadow-indigo-500/20 active:scale-[0.98]">
            設定を保存
          </button>
          <form method="post" action={`/admin/tenants/${id}/toggle`}>
            <button type="submit" class={`px-5 py-3 rounded-xl text-sm font-medium transition ${tenant.is_active ? 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100' : 'bg-emerald-50 text-emerald-600 border border-emerald-200 hover:bg-emerald-100'}`}>
              {tenant.is_active ? 'テナントを無効化' : 'テナントを有効化'}
            </button>
          </form>
        </div>
      </form>
    </Layout>
  );
});

dashboard.post('/admin/tenants/:id/edit', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.parseBody() as Record<string, string | string[]>;
  const payload = {
    name: body['name'],
    line_channel_id: body['line_channel_id'],
    line_channel_secret: body['line_channel_secret'],
    line_channel_access_token: body['line_channel_access_token'],
    school_context: body['school_context'] || '',
    scenario_config: safeParseJSON(body['scenario_config'] as string, {}),
    hearing_config: parseHearingForm(body),
    reminder_config: parseReminderForm(body),
    tone_config: parseToneForm(body),
    guardrail_config: parseGuardrailForm(body),
    notification_config: parseNotificationForm(body),
    updated_at: new Date().toISOString(),
  };

  const supabase = getSupabaseClient(c.env);
  await supabase.from('tenants').update(payload).eq('id', id);
  await invalidateTenantCache(id, c.env);
  return c.redirect(`/admin/tenants/${id}`);
});

// --- Users List ---
dashboard.get('/admin/tenants/:id/users', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const statusFilter = c.req.query('status') || '';

  const { data: tenant } = await supabase.from('tenants').select('name, hearing_config').eq('id', id).single();
  let q = supabase
    .from('end_users')
    .select('*')
    .eq('tenant_id', id)
    .order('updated_at', { ascending: false })
    .limit(100);

  if (statusFilter) q = q.eq('status', statusFilter);
  const { data: users } = await q;

  // Calculate lead scores for all users
  const leadScores = await getLeadScores(id, c.env);

  // Sort by lead score when no filter (show most promising first)
  const sortedUsers = (users || []).slice().sort((a, b) => {
    const scoreA = leadScores.get(a.id)?.score || 0;
    const scoreB = leadScores.get(b.id)?.score || 0;
    return scoreB - scoreA;
  });

  return c.html(
    <Layout title="ユーザー一覧">
      <div class="mb-6">
        <a href={`/admin/tenants/${id}`} class="text-sm text-slate-400 hover:text-slate-600 transition flex items-center gap-1 mb-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          {tenant?.name}
        </a>
        <div class="flex items-center justify-between">
          <h1 class="text-xl font-bold text-slate-800">ユーザー一覧</h1>
          <span class="text-xs text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full">{(users || []).length}件</span>
        </div>
      </div>

      {/* Status filter */}
      <div class="mb-5 flex gap-1.5 flex-wrap">
        <a href={`/admin/tenants/${id}/users`} class={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${!statusFilter ? 'gradient-hero text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>全て</a>
        {['active', 'booked', 'consulted', 'enrolled', 'stalled', 'dropped'].map((s) => (
          <a href={`/admin/tenants/${id}/users?status=${s}`} class={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${statusFilter === s ? 'gradient-hero text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>{statusLabel(s)}</a>
        ))}
      </div>

      <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="text-xs text-slate-400 uppercase tracking-wider border-b border-slate-100">
              <th class="text-left px-5 py-3 font-medium">ユーザー</th>
              <th class="text-center px-5 py-3 font-medium">スコア</th>
              <th class="text-left px-5 py-3 font-medium">ステータス</th>
              <th class="text-center px-5 py-3 font-medium">成約確率</th>
              <th class="text-center px-5 py-3 font-medium">ヒアリング</th>
              <th class="text-left px-5 py-3 font-medium">推奨アクション</th>
              <th class="text-right px-5 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((u) => {
              const smartLabel = getUserSmartLabel(u);
              const score = leadScores.get(u.id);
              const hearingKeys = Object.keys(u.hearing_data || {});
              return (
                <tr class="border-t border-slate-50 hover:bg-slate-50/50 transition slide-in">
                  <td class="px-5 py-3">
                    <div class="flex items-center gap-2">
                      <div class={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${statusColor(u.status)}`}>
                        {(u.display_name || '?')[0]}
                      </div>
                      <div>
                        <p class="font-medium text-sm text-slate-700">{u.display_name || '(名前なし)'}</p>
                        {smartLabel && (
                          <span class={`px-1.5 py-0.5 rounded text-[10px] font-bold ${smartLabel.color}`}>{smartLabel.label}</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td class="px-5 py-3 text-center">
                    {score && (
                      <div class="flex flex-col items-center">
                        <span class={`inline-block px-2 py-0.5 rounded-full text-xs font-bold border ${getScoreBadgeColor(score.grade)}`}>
                          {score.grade}
                        </span>
                        <div class="w-12 bg-slate-100 rounded-full h-1 mt-1">
                          <div class={`h-1 rounded-full bg-gradient-to-r ${getScoreColor(score.grade)}`} style={`width: ${score.score}%`}></div>
                        </div>
                      </div>
                    )}
                  </td>
                  <td class="px-5 py-3">
                    <span class={`px-2 py-1 rounded text-xs font-medium ${statusColor(u.status)}`}>{statusLabel(u.status)}</span>
                  </td>
                  <td class="px-5 py-3 text-center">
                    {score && (
                      <span class={`text-sm font-bold ${score.conversion_probability >= 50 ? 'text-emerald-600' : score.conversion_probability >= 25 ? 'text-amber-600' : 'text-slate-400'}`}>
                        {score.conversion_probability}%
                      </span>
                    )}
                  </td>
                  <td class="px-5 py-3 text-center">
                    {hearingKeys.length > 0 ? (
                      <span class="text-xs font-medium text-emerald-600">{hearingKeys.length}項目</span>
                    ) : (
                      <span class="text-xs text-slate-300">-</span>
                    )}
                  </td>
                  <td class="px-5 py-3">
                    {score && (
                      <p class="text-xs text-slate-500 truncate max-w-[200px]">{score.recommended_action}</p>
                    )}
                  </td>
                  <td class="px-5 py-3 text-right">
                    <a href={`/admin/tenants/${id}/users/${u.id}`} class="text-indigo-600 hover:text-indigo-800 text-sm font-medium transition">詳細 &rarr;</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(!users || users.length === 0) && (
          <div class="p-8 text-center">
            <p class="text-slate-400">ユーザーがまだいません</p>
          </div>
        )}
      </div>
    </Layout>
  );
});

// --- User Detail + Conversation ---
dashboard.get('/admin/tenants/:id/users/:userId', async (c) => {
  const tenantId = c.req.param('id');
  const userId = c.req.param('userId');
  const supabase = getSupabaseClient(c.env);

  const [
    { data: user },
    { data: conversations },
    { data: pendingActions },
    { data: tenant },
  ] = await Promise.all([
    supabase.from('end_users').select('*').eq('id', userId).single(),
    supabase.from('conversations').select('*').eq('end_user_id', userId).eq('tenant_id', tenantId).order('created_at', { ascending: true }).limit(200),
    supabase.from('scheduled_actions').select('*').eq('end_user_id', userId).eq('status', 'pending').order('execute_at', { ascending: true }).limit(10),
    supabase.from('tenants').select('hearing_config').eq('id', tenantId).single(),
  ]);

  if (!user) return c.html(<Layout title="Not Found"><p>ユーザーが見つかりません</p></Layout>);

  // Calculate lead score
  const userMsgCount = (conversations || []).filter(m => m.role === 'user').length;
  const hearingItemsTotal = tenant?.hearing_config?.items?.length || 6;
  const leadScore = calculateLeadScore(user as unknown as import('../types').EndUser, userMsgCount, hearingItemsTotal);

  // Generate AI staff suggestions
  const recentMsgs = (conversations || []).slice(-10).map(m => ({ role: m.role, content: m.content }));
  const suggestions = generateStaffSuggestions(user as unknown as import('../types').EndUser, leadScore, recentMsgs);

  return c.html(
    <Layout title={user.display_name || 'ユーザー詳細'}>
      <div class="mb-6">
        <a href={`/admin/tenants/${tenantId}/users`} class="text-sm text-slate-400 hover:text-slate-600 transition flex items-center gap-1 mb-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          ユーザー一覧
        </a>
        <h1 class="text-xl font-bold text-slate-800">{user.display_name || '(名前なし)'}</h1>
      </div>

      <div class="grid grid-cols-3 gap-6">
        {/* Left column: User profile + Lead Score + controls */}
        <div class="space-y-4">
          {/* LEAD SCORE CARD - The killer feature */}
          <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div class={`p-4 bg-gradient-to-r ${getScoreColor(leadScore.grade)} text-white`}>
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-white/80 text-xs font-medium uppercase tracking-wider">リードスコア</p>
                  <div class="flex items-baseline gap-2 mt-1">
                    <span class="text-4xl font-black">{leadScore.score}</span>
                    <span class="text-lg font-bold bg-white/20 px-2 rounded">{leadScore.grade}</span>
                  </div>
                </div>
                <div class="text-right">
                  <p class="text-white/80 text-xs">成約確率</p>
                  <p class="text-3xl font-black">{leadScore.conversion_probability}%</p>
                </div>
              </div>
            </div>
            <div class="p-4">
              <p class="text-xs text-slate-500 mb-3 font-medium uppercase tracking-wider">スコア内訳</p>
              <div class="space-y-2">
                {leadScore.factors.map((f) => (
                  <div>
                    <div class="flex justify-between text-xs mb-0.5">
                      <span class="text-slate-600">{f.name}</span>
                      <span class="font-medium text-slate-700">{f.points}/{f.max_points}</span>
                    </div>
                    <div class="w-full bg-slate-100 rounded-full h-1.5">
                      <div class={`h-1.5 rounded-full bg-gradient-to-r ${getScoreColor(leadScore.grade)} score-bar`} style={`--score-width: ${f.max_points > 0 ? Math.round((f.points / f.max_points) * 100) : 0}%`}></div>
                    </div>
                    <p class="text-[10px] text-slate-400 mt-0.5">{f.description}</p>
                  </div>
                ))}
              </div>
              <div class="mt-3 pt-3 border-t border-slate-100">
                <p class="text-xs font-bold text-indigo-600">{leadScore.recommended_action}</p>
              </div>
            </div>
          </div>

          {/* User profile card */}
          <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div class="gradient-hero p-4 text-white">
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-lg font-bold">
                  {(user.display_name || '?')[0]}
                </div>
                <div>
                  <p class="font-bold">{user.display_name || '(名前なし)'}</p>
                  <span class={`inline-block px-2 py-0.5 rounded text-xs mt-0.5 ${
                    user.status === 'enrolled' ? 'bg-white/30' :
                    user.status === 'consulted' ? 'bg-emerald-400/30' :
                    user.status === 'booked' ? 'bg-amber-400/30' :
                    user.status === 'stalled' ? 'bg-red-400/30' :
                    'bg-white/20'
                  }`}>{statusLabel(user.status)}</span>
                </div>
              </div>
            </div>
            <div class="p-4 space-y-3">
              <div class="flex justify-between text-sm">
                <span class="text-slate-400">ステップ</span>
                <span class="font-medium text-slate-700">{user.current_step}</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-slate-400">追客回数</span>
                <span class={`font-medium ${user.follow_up_count >= 3 ? 'text-red-500' : 'text-slate-700'}`}>{user.follow_up_count}</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-slate-400">最終返信</span>
                <span class="font-medium text-slate-700">{user.last_response_at ? timeAgo(user.last_response_at) : '未返信'}</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-slate-400">登録日</span>
                <span class="font-medium text-slate-700">{timeAgo(user.created_at)}</span>
              </div>
              <form method="post" action={`/admin/tenants/${tenantId}/users/${userId}/status`} class="flex gap-1 pt-2 border-t border-slate-100">
                <select name="status" class="text-xs border rounded px-2 py-1 flex-1">
                  {['active', 'booked', 'consulted', 'enrolled', 'dropped', 'stalled'].map((s) => (
                    <option value={s} selected={s === user.status}>{statusLabel(s)}</option>
                  ))}
                </select>
                <button type="submit" class="text-xs bg-slate-100 px-3 py-1 rounded hover:bg-slate-200 transition">変更</button>
              </form>
            </div>
          </div>

          {/* Takeover toggle */}
          <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-bold text-sm text-slate-700">対応モード</h3>
              {user.is_staff_takeover && <span class="w-2 h-2 rounded-full bg-orange-500 pulse-dot"></span>}
            </div>
            <form method="post" action={`/admin/tenants/${tenantId}/users/${userId}/takeover`}>
              <input type="hidden" name="takeover" value={user.is_staff_takeover ? 'off' : 'on'} />
              <button type="submit" class={`w-full py-2 rounded-lg text-sm font-bold transition ${
                user.is_staff_takeover
                  ? 'bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100'
                  : 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
              }`}>
                {user.is_staff_takeover ? 'スタッフ対応中 → AIに戻す' : 'AI対応中 → スタッフに切替'}
              </button>
            </form>
          </div>

          {/* Hearing data */}
          {Object.keys(user.hearing_data || {}).length > 0 && (
            <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
              <h3 class="font-bold text-sm text-slate-700 mb-3">ヒアリング回答</h3>
              <div class="space-y-2">
                {Object.entries(user.hearing_data || {}).map(([key, val]) => (
                  <div class="text-sm">
                    <p class="text-xs text-slate-400">{key}</p>
                    <p class="text-slate-700 font-medium">{val as string}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Insight */}
          {user.insight_summary && (
            <div class="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl border border-indigo-100 p-4">
              <h3 class="font-bold text-sm text-indigo-700 mb-2">AI インサイト</h3>
              <p class="text-sm text-indigo-900">{user.insight_summary}</p>
            </div>
          )}

          {/* Pending actions */}
          {pendingActions && pendingActions.length > 0 && (
            <div class="bg-amber-50 rounded-xl border border-amber-200 p-4">
              <h3 class="font-bold text-sm text-amber-700 mb-2">次のアクション</h3>
              <div class="space-y-2">
                {pendingActions.map((a) => (
                  <div class="flex justify-between items-center text-xs">
                    <span class="flex items-center gap-2">
                      <span class="px-1.5 py-0.5 rounded bg-amber-100 font-medium">{actionTypeLabel(a.action_type)}</span>
                      <span class="text-amber-700">{timeAgo(a.execute_at)}</span>
                    </span>
                    <form method="post" action={`/admin/tenants/${tenantId}/actions/${a.id}/cancel`} class="inline">
                      <button type="submit" class="text-red-400 hover:text-red-600 transition">取消</button>
                    </form>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column: Chat + AI suggestions + send */}
        <div class="col-span-2 flex flex-col">
          {/* Journey timeline */}
          <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4 mb-4">
            <div class="flex items-center gap-1 overflow-x-auto">
              {['友だち追加', 'ヒアリング', '予約案内', '予約', '相談', '入会'].map((step, i) => {
                const stepStatuses = ['active', 'active', 'active', 'booked', 'consulted', 'enrolled'];
                const stepIndex = stepStatuses.indexOf(user.status);
                const isCompleted = i <= stepIndex;
                const isCurrent = i === stepIndex;
                return (
                  <div class="flex items-center flex-shrink-0">
                    <div class={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                      isCurrent ? 'gradient-hero text-white shadow-md' :
                      isCompleted ? 'bg-emerald-100 text-emerald-700' :
                      'bg-slate-100 text-slate-400'
                    }`}>
                      {step}
                    </div>
                    {i < 5 && (
                      <div class={`w-6 h-0.5 ${isCompleted ? 'bg-emerald-300' : 'bg-slate-200'}`}></div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* AI STAFF SUGGESTIONS - Lステップにはできない機能 */}
          {suggestions.length > 0 && (
            <div class="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200 p-4 mb-4 slide-in">
              <div class="flex items-center gap-2 mb-3">
                <div class="w-6 h-6 rounded-full gradient-hero flex items-center justify-center">
                  <span class="text-white text-xs font-bold">AI</span>
                </div>
                <h3 class="font-bold text-sm text-indigo-800">AIからの提案</h3>
                <span class="text-xs text-indigo-400 ml-auto">スコア{leadScore.grade}ランク・成約確率{leadScore.conversion_probability}%の分析に基づく</span>
              </div>
              <div class="space-y-2">
                {suggestions.map((s, i) => (
                  <div class="suggestion-card bg-white rounded-lg px-3 py-2 text-sm text-slate-700">
                    <span class="text-indigo-400 font-bold mr-1">{i + 1}.</span> {s}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Chat area */}
          <div class="bg-white rounded-xl shadow-sm border border-slate-100 flex-1 flex flex-col overflow-hidden">
            <div class="px-5 py-3 border-b border-slate-100 flex justify-between items-center">
              <h2 class="font-bold text-slate-700">会話</h2>
              <span class="text-xs text-slate-400">{(conversations || []).length}件のメッセージ</span>
            </div>

            {/* LINE-style messages */}
            <div class="flex-1 max-h-[500px] overflow-y-auto p-5 space-y-3 bg-[#7494C0]/10 chat-container">
              {(conversations || []).map((msg) => (
                <div class={`flex ${msg.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                  <div class={`max-w-[75%] px-4 py-2.5 text-sm ${
                    msg.role === 'user' ? 'line-bubble-user' :
                    msg.ai_metadata?.staff_sent ? 'line-bubble-staff' :
                    'line-bubble-bot'
                  }`}>
                    {msg.ai_metadata?.staff_sent && (
                      <p class="text-[10px] font-bold text-orange-600 mb-1 flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-orange-500"></span>スタッフ
                      </p>
                    )}
                    {msg.ai_metadata?.detected_intent && msg.ai_metadata.detected_intent !== 'none' && (
                      <span class="inline-block px-1.5 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700 mb-1">
                        {intentLabel(msg.ai_metadata.detected_intent as string)}
                      </span>
                    )}
                    <p class="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                    <p class="text-[10px] text-slate-400 mt-1.5 text-right">{formatDateTimeJST(msg.created_at)}</p>
                  </div>
                </div>
              ))}
              {(!conversations || conversations.length === 0) && (
                <div class="text-center py-12">
                  <p class="text-slate-400">会話がまだありません</p>
                </div>
              )}
            </div>

            {/* Send form */}
            <div class="border-t border-slate-100 p-4 bg-white">
              <form method="post" action={`/admin/tenants/${tenantId}/users/${userId}/send`} class="flex gap-2">
                <input type="text" name="message" required placeholder="スタッフとしてメッセージを送信..." class="flex-1 border border-slate-200 rounded-full px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition" />
                <button type="submit" class="gradient-hero text-white px-5 py-2.5 rounded-full hover:opacity-90 transition text-sm font-medium shadow-md">送信</button>
              </form>
              {/* Quick reply templates */}
              <div class="flex gap-2 mt-2 flex-wrap">
                {getQuickReplies(user.status).map((qr) => (
                  <button type="button" onclick={`document.querySelector('input[name=message]').value='${qr.text.replace(/'/g, "\\'")}'`} class="text-xs px-3 py-1.5 rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition cursor-pointer">
                    {qr.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
});

// --- Analytics ---
dashboard.get('/admin/tenants/:id/analytics', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', id).single();
  const analytics = await getDetailedAnalytics(id, c.env);
  const recommendations = analytics ? generateRecommendations(analytics) : [];
  const mission = await getTodaysMission(id, c.env);

  const stepLabelMap: Record<string, string> = {
    welcome: '初回挨拶', hearing_start: 'ヒアリング', pre_booking_nudge: '予約前ナッジ',
    booking_invite: '予約案内', booked: '予約済み', consulted: '相談実施',
  };

  return c.html(
    <Layout title="分析">
      <div class="mb-6">
        <a href={`/admin/tenants/${id}`} class="text-sm text-slate-400 hover:text-slate-600 transition flex items-center gap-1 mb-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          {tenant?.name}
        </a>
        <h1 class="text-xl font-bold text-slate-800">詳細分析</h1>
      </div>

      {analytics ? (
        <div>
          {/* TODAY'S MISSION for this tenant */}
          {mission.priority_actions.length > 0 && (
            <div class="mb-6 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 rounded-xl p-5 text-white shadow-lg slide-in">
              <h2 class="text-sm font-bold text-white/80 uppercase tracking-wider mb-3">今日のミッション</h2>
              <div class="flex gap-4 flex-wrap">
                {mission.priority_actions.map((action) => (
                  <a href={action.link} class="bg-white/15 rounded-lg px-4 py-3 backdrop-blur-sm hover:bg-white/25 transition flex items-center gap-3">
                    <span class={`w-2 h-2 rounded-full ${action.urgency === 'critical' ? 'bg-red-400 pulse-dot' : action.urgency === 'high' ? 'bg-orange-400' : 'bg-yellow-400'}`}></span>
                    <div>
                      <p class="text-white font-bold text-lg">{action.count}</p>
                      <p class="text-white/70 text-xs">{action.label}</p>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* AI PERFORMANCE - The "prove it's worth it" section */}
          <div class="mb-6 bg-gradient-to-br from-slate-900 to-indigo-900 rounded-xl p-6 text-white shadow-xl">
            <h2 class="text-sm font-bold text-white/70 uppercase tracking-wider mb-4">AI稼働実績</h2>
            <div class="grid grid-cols-4 gap-4 mb-4">
              <div class="text-center">
                <p class="text-3xl font-black">{analytics.ai_performance.auto_resolution_rate}%</p>
                <p class="text-white/60 text-xs mt-1">AI自動対応率</p>
                <p class="text-[10px] text-emerald-400 mt-0.5">スタッフ介入なしで処理</p>
              </div>
              <div class="text-center">
                <p class="text-3xl font-black">{analytics.ai_performance.ai_handled}</p>
                <p class="text-white/60 text-xs mt-1">AI処理メッセージ</p>
                <p class="text-[10px] text-white/40 mt-0.5">vs スタッフ {analytics.ai_performance.staff_handled}</p>
              </div>
              <div class="text-center">
                <p class="text-3xl font-black text-emerald-400">{analytics.ai_performance.estimated_hours_saved}h</p>
                <p class="text-white/60 text-xs mt-1">推定削減工数</p>
                <p class="text-[10px] text-white/40 mt-0.5">1メッセージ = 3分の作業</p>
              </div>
              <div class="text-center">
                <p class="text-3xl font-black text-amber-400">&yen;{analytics.ai_performance.estimated_cost_saved.toLocaleString()}</p>
                <p class="text-white/60 text-xs mt-1">推定コスト削減</p>
                <p class="text-[10px] text-white/40 mt-0.5">時給&yen;2,000換算</p>
              </div>
            </div>
            {analytics.ai_performance.avg_messages_to_booking && (
              <div class="bg-white/10 rounded-lg px-4 py-2 text-sm">
                予約までの平均メッセージ数: <span class="font-bold">{analytics.ai_performance.avg_messages_to_booking}通</span>
                <span class="text-white/50 ml-2">Lステップでは不可能なAIパーソナライズ対話</span>
              </div>
            )}
          </div>

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <div class="mb-6 space-y-2">
              <h2 class="text-lg font-bold">改善アドバイス</h2>
              {recommendations.map((rec) => (
                <div class={`p-3 rounded-lg border text-sm ${
                  rec.severity === 'critical' ? 'bg-red-50 border-red-200 text-red-800'
                  : rec.severity === 'warning' ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
                  : 'bg-green-50 border-green-200 text-green-800'
                }`}>
                  <span class="font-bold mr-1">{rec.severity === 'critical' ? '!!' : rec.severity === 'warning' ? '!' : 'OK'}</span>
                  {rec.message}
                </div>
              ))}
            </div>
          )}

          {/* KPI Summary */}
          <div class="grid grid-cols-5 gap-4 mb-6">
            <MetricCard label="総ユーザー" value={analytics.funnel.total_users} />
            <MetricCard label="予約済み" value={analytics.funnel.booked_users} />
            <MetricCard label="相談済み" value={analytics.funnel.consulted_users} />
            <MetricCard label="入会済み" value={analytics.funnel.enrolled_users} />
            <MetricCard label="着座率" value={analytics.funnel.attendance_rate != null ? `${analytics.funnel.attendance_rate}%` : '-'} highlight />
          </div>

          {/* Conversion Rates with Benchmarks */}
          <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-100 mb-6">
            <h2 class="text-lg font-bold mb-4">コンバージョン率</h2>
            <div class="grid grid-cols-4 gap-4">
              <ConversionCard label="友だち→予約" value={analytics.conversion_rates.friend_to_booking} benchmark={BENCHMARKS.friend_to_booking} color="blue" />
              <ConversionCard label="予約→着座" value={analytics.conversion_rates.booking_to_attendance} benchmark={BENCHMARKS.booking_to_attendance} color="yellow" />
              <ConversionCard label="着座→入会" value={analytics.conversion_rates.attendance_to_enrollment} benchmark={BENCHMARKS.attendance_to_enrollment} color="green" />
              <div class="text-center p-3 bg-indigo-50 rounded-lg">
                <p class="text-sm text-gray-600">全体CVR</p>
                <p class="text-2xl font-bold text-indigo-600">{analytics.conversion_rates.overall ?? '-'}%</p>
              </div>
            </div>
          </div>

          {/* STEP DROP-OFF ANALYSIS - Where exactly do users stop? */}
          {analytics.step_dropoff.length > 0 && (
            <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-100 mb-6">
              <h2 class="text-lg font-bold mb-1">ステップ別離脱分析</h2>
              <p class="text-xs text-slate-400 mb-4">どのステップでユーザーが離脱しているかを可視化。離脱率が高いステップの改善が最優先。</p>
              <div class="space-y-4">
                {analytics.step_dropoff.map((d) => {
                  const label = stepLabelMap[d.step] || d.step;
                  const isHighDropoff = d.dropoff_rate > 50;
                  const isMedDropoff = d.dropoff_rate > 30;
                  return (
                    <div>
                      <div class="flex justify-between items-center mb-1">
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-medium text-slate-700">{label}</span>
                          <span class="text-xs text-slate-400">{d.users_entered}人 → {d.users_progressed}人</span>
                        </div>
                        <span class={`text-sm font-bold ${isHighDropoff ? 'text-red-600' : isMedDropoff ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {isHighDropoff ? '!!' : isMedDropoff ? '!' : ''} 離脱 {d.dropoff_rate}%
                        </span>
                      </div>
                      <div class="flex h-6 rounded-full overflow-hidden bg-slate-100">
                        <div class="bg-emerald-500 dropoff-bar rounded-l-full flex items-center justify-end pr-1" style={`width: ${100 - d.dropoff_rate}%`}>
                          {d.users_progressed > 0 && <span class="text-[10px] text-white font-bold">{d.users_progressed}</span>}
                        </div>
                        <div class={`${isHighDropoff ? 'bg-red-400' : isMedDropoff ? 'bg-amber-400' : 'bg-slate-300'} dropoff-bar flex items-center pl-1`} style={`width: ${d.dropoff_rate}%`}>
                          {d.dropoff_rate > 10 && <span class="text-[10px] text-white font-bold">-{d.users_entered - d.users_progressed}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Funnel visualization */}
          <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-100 mb-6">
            <h2 class="text-lg font-bold mb-4">ファネル</h2>
            <div class="space-y-3">
              <FunnelBar label="友だち追加" value={analytics.funnel.total_users} max={analytics.funnel.total_users} color="bg-blue-500" />
              <FunnelBar label="予約" value={analytics.funnel.booked_users} max={analytics.funnel.total_users} color="bg-yellow-500" />
              <FunnelBar label="相談実施" value={analytics.funnel.consulted_users} max={analytics.funnel.total_users} color="bg-green-500" />
              <FunnelBar label="入会" value={analytics.funnel.enrolled_users} max={analytics.funnel.total_users} color="bg-indigo-500" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-6 mb-6">
            {/* Engagement */}
            <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
              <h2 class="text-lg font-bold mb-4">エンゲージメント</h2>
              <div class="space-y-3">
                <div class="flex justify-between"><span class="text-gray-600">平均メッセージ数/ユーザー</span><span class="font-bold">{analytics.engagement.avg_messages_per_user}</span></div>
                <div class="flex justify-between">
                  <span class="text-gray-600">ヒアリング回答率</span>
                  <span class="font-bold">{analytics.engagement.avg_hearing_completion_rate}%
                    <span class="text-xs text-gray-400 ml-1">(業界平均: {BENCHMARKS.hearing_completion.min}-{BENCHMARKS.hearing_completion.max}%)</span>
                  </span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">停滞ユーザー</span>
                  <a href={`/admin/tenants/${id}/users?status=stalled`} class="font-bold text-red-600 hover:underline">{analytics.engagement.stalled_users}</a>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">離脱ユーザー</span>
                  <a href={`/admin/tenants/${id}/users?status=dropped`} class="font-bold hover:underline">{analytics.engagement.dropped_users}</a>
                </div>
                <div class="flex justify-between"><span class="text-gray-600">ブロック</span><span class="font-bold">{analytics.engagement.blocked_users}</span></div>
              </div>
            </div>

            {/* Bookings */}
            <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
              <h2 class="text-lg font-bold mb-4">予約状況</h2>
              <div class="space-y-3">
                <div class="flex justify-between"><span class="text-gray-600">総予約数</span><span class="font-bold">{analytics.bookings.total}</span></div>
                <div class="flex justify-between">
                  <span class="text-gray-600">確定中</span>
                  <a href={`/admin/tenants/${id}/bookings?status=confirmed`} class="font-bold text-blue-600 hover:underline">{analytics.bookings.confirmed}</a>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">ノーショー</span>
                  <a href={`/admin/tenants/${id}/bookings?status=no_show`} class="font-bold text-red-600 hover:underline">{analytics.bookings.no_show}</a>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">ノーショー率</span>
                  <span class={`font-bold ${(analytics.bookings.no_show_rate || 0) > 20 ? 'text-red-600' : 'text-green-600'}`}>
                    {analytics.bookings.no_show_rate ?? '-'}%
                    <span class="text-xs text-gray-400 ml-1">(業界平均: {BENCHMARKS.no_show_rate.min}-{BENCHMARKS.no_show_rate.max}%)</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Trends comparison */}
          <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-100 mb-6">
            <h2 class="text-lg font-bold mb-4">直近7日間 vs 前週</h2>
            <div class="grid grid-cols-3 gap-4">
              {[
                { label: '新規ユーザー', current: analytics.recent_activity.new_users_7d, prev: analytics.trends.new_users_prev_7d },
                { label: '予約', current: analytics.recent_activity.bookings_7d, prev: analytics.trends.bookings_prev_7d },
                { label: '相談実施', current: analytics.recent_activity.consultations_7d, prev: analytics.trends.consultations_prev_7d },
              ].map((item) => {
                const diff = item.current - item.prev;
                const pctChange = item.prev > 0 ? Math.round((diff / item.prev) * 100) : (item.current > 0 ? 100 : 0);
                return (
                  <div class="text-center p-4 bg-slate-50 rounded-lg">
                    <p class="text-sm text-gray-600">{item.label}</p>
                    <p class="text-2xl font-bold text-slate-800">{item.current}</p>
                    <p class={`text-sm font-medium mt-1 ${diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                      {diff > 0 ? '+' : ''}{diff} ({pctChange > 0 ? '+' : ''}{pctChange}%)
                    </p>
                    <p class="text-[10px] text-slate-400">前週: {item.prev}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Velocity */}
          {analytics.velocity.avg_hours_to_booking && (
            <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-100 mb-6">
              <h2 class="text-lg font-bold mb-4">コンバージョン速度</h2>
              <div class="grid grid-cols-2 gap-4">
                <div class="p-4 bg-blue-50 rounded-lg text-center">
                  <p class="text-sm text-blue-600">友だち追加→予約</p>
                  <p class="text-2xl font-bold text-blue-700">{analytics.velocity.avg_hours_to_booking}時間</p>
                  <p class="text-xs text-blue-400">平均所要時間</p>
                </div>
                <div class="p-4 bg-emerald-50 rounded-lg text-center">
                  <p class="text-sm text-emerald-600">AI応答速度</p>
                  <p class="text-2xl font-bold text-emerald-700">3秒</p>
                  <p class="text-xs text-emerald-400">業界平均4時間 → 4,800倍高速</p>
                </div>
              </div>
            </div>
          )}

          {/* Action health */}
          {(analytics.actions.failed_24h > 0 || analytics.actions.pending > 10) && (
            <div class="bg-yellow-50 border border-yellow-200 p-4 rounded-lg">
              <h3 class="font-bold text-yellow-700 mb-2">アクション状態</h3>
              <p class="text-sm">待機: {analytics.actions.pending} / 完了(24h): {analytics.actions.completed_24h} / 失敗(24h): <span class="text-red-600 font-bold">{analytics.actions.failed_24h}</span></p>
            </div>
          )}
        </div>
      ) : (
        <p class="text-gray-500">データがまだありません</p>
      )}
    </Layout>
  );
});

// --- Bookings Management ---
dashboard.get('/admin/tenants/:id/bookings', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', id).single();
  const statusFilter = c.req.query('status') || '';

  let q = supabase
    .from('bookings')
    .select('*, end_users!inner(display_name, line_user_id)')
    .eq('tenant_id', id)
    .order('scheduled_at', { ascending: false })
    .limit(100);

  if (statusFilter) q = q.eq('status', statusFilter);
  const { data: bookings } = await q;

  return c.html(
    <Layout title="予約管理">
      <div class="mb-6">
        <a href={`/admin/tenants/${id}`} class="text-sm text-slate-400 hover:text-slate-600 transition flex items-center gap-1 mb-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          {tenant?.name}
        </a>
        <h1 class="text-xl font-bold text-slate-800">予約管理</h1>
      </div>

      {/* Status filter */}
      <div class="mb-4 flex gap-2">
        <a href={`/admin/tenants/${id}/bookings`} class={`px-3 py-1 rounded text-sm ${!statusFilter ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>全て</a>
        <a href={`/admin/tenants/${id}/bookings?status=confirmed`} class={`px-3 py-1 rounded text-sm ${statusFilter === 'confirmed' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>確定</a>
        <a href={`/admin/tenants/${id}/bookings?status=no_show`} class={`px-3 py-1 rounded text-sm ${statusFilter === 'no_show' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>ノーショー</a>
      </div>

      <div class="bg-white rounded shadow overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ユーザー</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">予約日時</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ステータス</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">リマインド回数</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">操作</th>
            </tr>
          </thead>
          <tbody>
            {(bookings || []).map((b: Record<string, unknown>) => {
              const eu = b.end_users as Record<string, string>;
              return (
                <tr class="border-t hover:bg-gray-50">
                  <td class="px-4 py-3">{eu?.display_name || '(名前なし)'}</td>
                  <td class="px-4 py-3">{formatDateTimeJST(b.scheduled_at as string)}</td>
                  <td class="px-4 py-3">
                    <span class={`px-2 py-1 rounded text-xs ${bookingStatusColor(b.status as string)}`}>{bookingStatusLabel(b.status as string)}</span>
                  </td>
                  <td class="px-4 py-3">{String(b.reminder_count)}</td>
                  <td class="px-4 py-3 space-x-1">
                    {b.status === 'confirmed' && (
                      <form method="post" action={`/admin/tenants/${id}/bookings/${b.id}/status`} class="inline">
                        <input type="hidden" name="status" value="consulted" />
                        <button type="submit" class="text-green-600 hover:underline text-sm">相談済み</button>
                      </form>
                    )}
                    {b.status === 'confirmed' && (
                      <form method="post" action={`/admin/tenants/${id}/bookings/${b.id}/status`} class="inline">
                        <input type="hidden" name="status" value="no_show" />
                        <button type="submit" class="text-red-600 hover:underline text-sm">ノーショー</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(!bookings || bookings.length === 0) && (
          <p class="p-4 text-gray-500 text-center">予約がまだありません</p>
        )}
      </div>
    </Layout>
  );
});

dashboard.post('/admin/tenants/:id/bookings/:bookingId/status', async (c) => {
  const id = c.req.param('id');
  const bookingId = c.req.param('bookingId');
  const body = await c.req.parseBody();
  const status = body['status'] as string;

  const supabase = getSupabaseClient(c.env);
  const { data: booking } = await supabase
    .from('bookings')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', bookingId)
    .eq('tenant_id', id)
    .select()
    .single();

  if (booking && status === 'consulted') {
    await supabase
      .from('end_users')
      .update({ status: 'consulted', updated_at: new Date().toISOString() })
      .eq('id', booking.end_user_id);
  }

  return c.redirect(`/admin/tenants/${id}/bookings`);
});

// --- User status update ---
dashboard.post('/admin/tenants/:id/users/:userId/status', async (c) => {
  const id = c.req.param('id');
  const userId = c.req.param('userId');
  const body = await c.req.parseBody();
  const status = body['status'] as string;

  const supabase = getSupabaseClient(c.env);
  await supabase
    .from('end_users')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .eq('tenant_id', id);

  return c.redirect(`/admin/tenants/${id}/users/${userId}`);
});

// --- Staff Takeover Toggle ---
dashboard.post('/admin/tenants/:id/users/:userId/takeover', async (c) => {
  const id = c.req.param('id');
  const userId = c.req.param('userId');
  const body = await c.req.parseBody();
  const takeover = body['takeover'] === 'on';

  const supabase = getSupabaseClient(c.env);
  await supabase
    .from('end_users')
    .update({ is_staff_takeover: takeover, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .eq('tenant_id', id);

  return c.redirect(`/admin/tenants/${id}/users/${userId}`);
});

// --- Staff Send Message ---
dashboard.post('/admin/tenants/:id/users/:userId/send', async (c) => {
  const tenantId = c.req.param('id');
  const userId = c.req.param('userId');
  const body = await c.req.parseBody();
  const message = (body['message'] as string || '').trim();
  if (!message) return c.redirect(`/admin/tenants/${tenantId}/users/${userId}`);

  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
  const { data: user } = await supabase.from('end_users').select('*').eq('id', userId).single();

  if (tenant && user) {
    await pushMessage(tenant, user.line_user_id, message);
    await supabase.from('conversations').insert({
      end_user_id: userId,
      tenant_id: tenantId,
      role: 'assistant',
      content: message,
      step_at_time: user.current_step,
      ai_metadata: { staff_sent: true },
    });
    await supabase
      .from('end_users')
      .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', userId);
  }

  return c.redirect(`/admin/tenants/${tenantId}/users/${userId}`);
});

// --- Scheduled Actions View ---
dashboard.get('/admin/tenants/:id/actions', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', id).single();
  const statusFilter = c.req.query('status') || '';

  let q = supabase
    .from('scheduled_actions')
    .select('*, end_users!inner(display_name)')
    .eq('tenant_id', id)
    .order('execute_at', { ascending: false })
    .limit(100);

  if (statusFilter) q = q.eq('status', statusFilter);
  const { data: actions } = await q;

  return c.html(
    <Layout title="スケジュール済みアクション">
      <div class="mb-6">
        <a href={`/admin/tenants/${id}`} class="text-sm text-slate-400 hover:text-slate-600 transition flex items-center gap-1 mb-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          {tenant?.name}
        </a>
        <h1 class="text-xl font-bold text-slate-800">アクション管理</h1>
      </div>

      <div class="mb-4 flex gap-2">
        <a href={`/admin/tenants/${id}/actions`} class={`px-3 py-1 rounded text-sm ${!statusFilter ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>全て</a>
        <a href={`/admin/tenants/${id}/actions?status=pending`} class={`px-3 py-1 rounded text-sm ${statusFilter === 'pending' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>待機中</a>
        <a href={`/admin/tenants/${id}/actions?status=failed`} class={`px-3 py-1 rounded text-sm ${statusFilter === 'failed' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>失敗</a>
        <a href={`/admin/tenants/${id}/actions?status=completed`} class={`px-3 py-1 rounded text-sm ${statusFilter === 'completed' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>完了</a>
      </div>

      <div class="bg-white rounded shadow overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ユーザー</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">種別</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">実行予定</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ステータス</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">試行回数</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">操作</th>
            </tr>
          </thead>
          <tbody>
            {(actions || []).map((a: Record<string, unknown>) => {
              const eu = a.end_users as Record<string, string>;
              return (
                <tr class="border-t hover:bg-gray-50">
                  <td class="px-4 py-3 text-sm">{eu?.display_name || '(名前なし)'}</td>
                  <td class="px-4 py-3">
                    <span class="px-2 py-1 rounded text-xs bg-gray-100">{actionTypeLabel(a.action_type as string)}</span>
                  </td>
                  <td class="px-4 py-3 text-sm">{formatDateTimeJST(a.execute_at as string)}</td>
                  <td class="px-4 py-3">
                    <span class={`px-2 py-1 rounded text-xs ${actionStatusColor(a.status as string)}`}>{a.status as string}</span>
                  </td>
                  <td class="px-4 py-3 text-sm">{String(a.attempts)} / {String(a.max_attempts)}</td>
                  <td class="px-4 py-3">
                    {(a.status === 'pending' || a.status === 'processing') && (
                      <form method="post" action={`/admin/tenants/${id}/actions/${a.id}/cancel`} class="inline">
                        <button type="submit" class="text-red-600 hover:underline text-sm">キャンセル</button>
                      </form>
                    )}
                    {a.last_error && (
                      <span class="text-red-500 text-xs ml-2" title={a.last_error as string}>エラーあり</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(!actions || actions.length === 0) && (
          <p class="p-4 text-gray-500 text-center">アクションがありません</p>
        )}
      </div>
    </Layout>
  );
});

dashboard.post('/admin/tenants/:id/actions/:actionId/cancel', async (c) => {
  const id = c.req.param('id');
  const actionId = c.req.param('actionId');
  const supabase = getSupabaseClient(c.env);
  await supabase
    .from('scheduled_actions')
    .update({ status: 'cancelled' })
    .eq('id', actionId)
    .eq('tenant_id', id)
    .in('status', ['pending', 'processing']);
  return c.redirect(`/admin/tenants/${id}/actions`);
});

// --- Getting Started Guide ---
dashboard.get('/admin/guide', (c) => {
  return c.html(
    <Layout title="使い方ガイド">
      <div class="max-w-3xl mx-auto">
        <div class="mb-8">
          <h1 class="text-2xl font-bold text-slate-800">使い方ガイド</h1>
          <p class="text-slate-500 text-sm mt-1">LINE Attend Agentを使い始めるためのステップバイステップガイドです</p>
        </div>

        {/* Step-by-step guide */}
        <div class="space-y-6">
          {/* Step 1 */}
          <div class="card p-6 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-1 h-full bg-indigo-500 rounded-r"></div>
            <div class="flex items-start gap-4 pl-4">
              <div class="w-10 h-10 rounded-xl gradient-hero flex items-center justify-center text-white font-bold text-sm flex-shrink-0 shadow-md">1</div>
              <div class="flex-1">
                <h3 class="font-bold text-slate-800 text-lg">テナントを作成する</h3>
                <p class="text-slate-500 text-sm mt-1 leading-relaxed">
                  テナントはあなたのスクールやビジネスの設定単位です。スクール名とAIの基本設定を登録しましょう。
                </p>
                <a href="/admin/tenants/new" class="inline-flex items-center gap-1.5 text-indigo-600 hover:text-indigo-700 text-sm font-semibold mt-3 transition">
                  テナントを作成する
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                </a>
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div class="card p-6 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-1 h-full bg-emerald-500 rounded-r"></div>
            <div class="flex items-start gap-4 pl-4">
              <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0 shadow-md">2</div>
              <div class="flex-1">
                <h3 class="font-bold text-slate-800 text-lg">APIキーを発行する</h3>
                <p class="text-slate-500 text-sm mt-1 leading-relaxed">
                  テナント詳細画面で「APIキーを生成」ボタンを押します。生成されたキーはLステップの設定に使います。
                </p>
                <div class="mt-3 bg-amber-50 border border-amber-100 rounded-lg px-4 py-2.5">
                  <p class="text-amber-700 text-xs flex items-start gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="flex-shrink-0 mt-0.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    APIキーは一度しか表示されません。安全な場所に保管してください。
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div class="card p-6 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-1 h-full bg-purple-500 rounded-r"></div>
            <div class="flex items-start gap-4 pl-4">
              <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0 shadow-md">3</div>
              <div class="flex-1">
                <h3 class="font-bold text-slate-800 text-lg">Lステップと接続する</h3>
                <p class="text-slate-500 text-sm mt-1 leading-relaxed">
                  LステップのWebhookアクションに以下のURLを設定してAIエンジンと接続します。
                </p>
                <div class="mt-3 bg-slate-50 rounded-lg p-4 space-y-3">
                  <div>
                    <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">ヒアリング開始</p>
                    <code class="text-xs text-indigo-600 bg-indigo-50 px-2 py-1 rounded break-all">POST /api/v1/hearing/start</code>
                  </div>
                  <div>
                    <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">ユーザー返信処理</p>
                    <code class="text-xs text-indigo-600 bg-indigo-50 px-2 py-1 rounded break-all">POST /api/v1/hearing/respond</code>
                  </div>
                  <div>
                    <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">AIメッセージ生成</p>
                    <code class="text-xs text-indigo-600 bg-indigo-50 px-2 py-1 rounded break-all">POST /api/v1/message/generate</code>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Step 4 */}
          <div class="card p-6 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-1 h-full bg-amber-500 rounded-r"></div>
            <div class="flex items-start gap-4 pl-4">
              <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0 shadow-md">4</div>
              <div class="flex-1">
                <h3 class="font-bold text-slate-800 text-lg">AIシミュレーターでテスト</h3>
                <p class="text-slate-500 text-sm mt-1 leading-relaxed">
                  テナント詳細画面の「AIシミュレーター」でAIの応答をテストできます。実際のメッセージは送信されないので安心です。
                </p>
              </div>
            </div>
          </div>

          {/* Step 5 */}
          <div class="card p-6 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-1 h-full bg-blue-500 rounded-r"></div>
            <div class="flex items-start gap-4 pl-4">
              <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0 shadow-md">5</div>
              <div class="flex-1">
                <h3 class="font-bold text-slate-800 text-lg">運用開始 & 分析</h3>
                <p class="text-slate-500 text-sm mt-1 leading-relaxed">
                  Lステップから本番接続したら、ダッシュボードでAIの性能・着座率・リードスコアをリアルタイムに確認できます。
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* API Reference Quick Guide */}
        <div class="mt-10 card p-6">
          <h2 class="font-bold text-slate-800 text-lg mb-4 flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>
            APIエンドポイント一覧
          </h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-100">
                  <th class="text-left py-2.5 font-semibold">エンドポイント</th>
                  <th class="text-left py-2.5 font-semibold">説明</th>
                  <th class="text-left py-2.5 font-semibold">用途</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-50">
                <tr><td class="py-2.5"><code class="text-xs text-indigo-600">POST /hearing/start</code></td><td class="py-2.5 text-slate-600">ヒアリング開始</td><td class="py-2.5 text-slate-400">友だち追加後に呼出</td></tr>
                <tr><td class="py-2.5"><code class="text-xs text-indigo-600">POST /hearing/respond</code></td><td class="py-2.5 text-slate-600">ヒアリング応答</td><td class="py-2.5 text-slate-400">ユーザー返信ごとに呼出</td></tr>
                <tr><td class="py-2.5"><code class="text-xs text-indigo-600">POST /message/generate</code></td><td class="py-2.5 text-slate-600">AI メッセージ生成</td><td class="py-2.5 text-slate-400">ナーチャー・フォローなど</td></tr>
                <tr><td class="py-2.5"><code class="text-xs text-indigo-600">POST /intent/detect</code></td><td class="py-2.5 text-slate-600">意図検知</td><td class="py-2.5 text-slate-400">条件分岐で使用</td></tr>
                <tr><td class="py-2.5"><code class="text-xs text-indigo-600">POST /risk/no-show</code></td><td class="py-2.5 text-slate-600">ノーショーリスク</td><td class="py-2.5 text-slate-400">リスク予測</td></tr>
                <tr><td class="py-2.5"><code class="text-xs text-indigo-600">POST /score/lead</code></td><td class="py-2.5 text-slate-600">リードスコア</td><td class="py-2.5 text-slate-400">成約確率算出</td></tr>
                <tr><td class="py-2.5"><code class="text-xs text-indigo-600">GET /user/:id/profile</code></td><td class="py-2.5 text-slate-600">ユーザー情報</td><td class="py-2.5 text-slate-400">AI enriched情報</td></tr>
              </tbody>
            </table>
          </div>
          <p class="text-xs text-slate-400 mt-4">全リクエストに <code class="bg-slate-100 px-1 rounded">Authorization: Bearer &lt;api_key&gt;</code> ヘッダーが必要です</p>
        </div>
      </div>
    </Layout>
  );
});

// --- System Health Dashboard ---
dashboard.get('/admin/system', async (c) => {
  const supabase = getSupabaseClient(c.env);
  const now = new Date();

  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: pendingCount },
    { count: failedCount },
    { count: processingCount },
    { count: overdueCount },
    { count: activeTenants },
    { count: activeUsers },
    { count: completedToday },
  ] = await Promise.all([
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', oneDayAgo),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'processing'),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'pending').lt('execute_at', now.toISOString()),
    supabase.from('tenants').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('is_blocked', false),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'completed').gte('completed_at', oneDayAgo),
  ]);

  // Recent failures
  const { data: recentFailures } = await supabase
    .from('scheduled_actions')
    .select('*, end_users!inner(display_name)')
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(10);

  const systemOk = (failedCount || 0) < 10 && (overdueCount || 0) < 50;

  return c.html(
    <Layout title="システム状態">
      <div class="mb-8">
        <h1 class="text-xl font-bold text-slate-800 mb-4">システム状態</h1>
        <div class={`card p-5 flex items-center gap-4 ${systemOk ? 'border-l-4 border-l-emerald-400' : 'border-l-4 border-l-red-400'}`}>
          <div class={`w-10 h-10 rounded-xl flex items-center justify-center ${systemOk ? 'bg-emerald-50' : 'bg-red-50'}`}>
            {systemOk ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            )}
          </div>
          <div>
            <p class={`font-bold ${systemOk ? 'text-emerald-700' : 'text-red-700'}`}>
              {systemOk ? '正常稼働中' : '要確認'}
            </p>
            <p class="text-xs text-slate-400">最終確認: {formatDateTimeJST(now.toISOString())}</p>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-4 gap-4 mb-6">
        <MetricCard label="アクティブテナント" value={activeTenants || 0} />
        <MetricCard label="アクティブユーザー" value={activeUsers || 0} />
        <MetricCard label="24h完了アクション" value={completedToday || 0} />
        <MetricCard label="待機中アクション" value={pendingCount || 0} />
      </div>

      <div class="grid grid-cols-3 gap-4 mb-6">
        <div class={`p-4 rounded shadow ${(overdueCount || 0) > 0 ? 'bg-yellow-50' : 'bg-white'}`}>
          <p class="text-sm text-gray-500">期限超過</p>
          <p class="text-2xl font-bold">{overdueCount || 0}</p>
        </div>
        <div class={`p-4 rounded shadow ${(processingCount || 0) > 5 ? 'bg-yellow-50' : 'bg-white'}`}>
          <p class="text-sm text-gray-500">処理中</p>
          <p class="text-2xl font-bold">{processingCount || 0}</p>
        </div>
        <div class={`p-4 rounded shadow ${(failedCount || 0) > 0 ? 'bg-red-50' : 'bg-white'}`}>
          <p class="text-sm text-gray-500">24h失敗</p>
          <p class="text-2xl font-bold text-red-600">{failedCount || 0}</p>
        </div>
      </div>

      {recentFailures && recentFailures.length > 0 && (
        <div class="bg-white rounded shadow overflow-hidden">
          <h2 class="text-lg font-bold p-4 border-b">最近の失敗アクション</h2>
          <table class="w-full">
            <thead class="bg-gray-50">
              <tr>
                <th class="text-left px-4 py-2 text-sm font-medium text-gray-500">ユーザー</th>
                <th class="text-left px-4 py-2 text-sm font-medium text-gray-500">種別</th>
                <th class="text-left px-4 py-2 text-sm font-medium text-gray-500">エラー</th>
                <th class="text-left px-4 py-2 text-sm font-medium text-gray-500">日時</th>
              </tr>
            </thead>
            <tbody>
              {recentFailures.map((f: Record<string, unknown>) => {
                const eu = f.end_users as Record<string, string>;
                return (
                  <tr class="border-t">
                    <td class="px-4 py-2 text-sm">{eu?.display_name || '-'}</td>
                    <td class="px-4 py-2 text-sm">{actionTypeLabel(f.action_type as string)}</td>
                    <td class="px-4 py-2 text-sm text-red-600 truncate max-w-xs">{(f.last_error as string)?.slice(0, 80)}</td>
                    <td class="px-4 py-2 text-sm">{formatDateTimeJST(f.created_at as string)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
});

// --- Tenant activation toggle from dashboard ---
dashboard.post('/admin/tenants/:id/toggle', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('is_active').eq('id', id).single();
  if (!tenant) return c.redirect('/admin/');

  await supabase.from('tenants').update({ is_active: !tenant.is_active, updated_at: new Date().toISOString() }).eq('id', id);
  await invalidateTenantCache(id, c.env);
  return c.redirect(`/admin/tenants/${id}`);
});

// --- Slots Management ---
dashboard.get('/admin/tenants/:id/slots', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', id).single();
  const { data: slots } = await supabase
    .from('available_slots')
    .select('*')
    .eq('tenant_id', id)
    .order('start_at', { ascending: true });

  return c.html(
    <Layout title="予約枠管理">
      <div class="mb-6">
        <a href={`/admin/tenants/${id}`} class="text-sm text-slate-400 hover:text-slate-600 transition flex items-center gap-1 mb-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          {tenant?.name}
        </a>
        <h1 class="text-xl font-bold text-slate-800">予約枠管理</h1>
      </div>

      {/* Add slot form */}
      <form method="post" action={`/admin/tenants/${id}/slots/add`} class="bg-white p-4 rounded shadow mb-6 flex gap-4 items-end">
        <div>
          <label class="block text-sm font-medium mb-1">開始日時</label>
          <input type="datetime-local" name="start_at" required class="border rounded px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">終了日時</label>
          <input type="datetime-local" name="end_at" required class="border rounded px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">定員</label>
          <input type="number" name="max_bookings" value="3" min="1" class="border rounded px-3 py-2 w-20" />
        </div>
        <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700">追加</button>
      </form>

      {/* Slots table */}
      <div class="bg-white rounded shadow overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">日時</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">予約状況</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ステータス</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">操作</th>
            </tr>
          </thead>
          <tbody>
            {(slots || []).map((slot) => (
              <tr class="border-t hover:bg-gray-50">
                <td class="px-4 py-3">
                  {formatDateTimeJST(slot.start_at)} 〜 {formatDateTimeJST(slot.end_at).split(' ')[1]}
                </td>
                <td class="px-4 py-3">{slot.current_bookings} / {slot.max_bookings}</td>
                <td class="px-4 py-3">
                  <span class={`px-2 py-1 rounded text-xs ${slot.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {slot.is_active ? '有効' : '無効'}
                  </span>
                </td>
                <td class="px-4 py-3">
                  {slot.is_active && (
                    <form method="post" action={`/admin/tenants/${id}/slots/${slot.id}/delete`} class="inline">
                      <button type="submit" class="text-red-600 hover:underline text-sm">無効化</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!slots || slots.length === 0) && (
          <p class="p-4 text-gray-500 text-center">予約枠がまだありません</p>
        )}
      </div>
    </Layout>
  );
});

dashboard.post('/admin/tenants/:id/slots/add', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.parseBody();
  const startAt = new Date(body['start_at'] as string).toISOString();
  const endAt = new Date(body['end_at'] as string).toISOString();
  const maxBookings = parseInt(body['max_bookings'] as string) || 3;

  const supabase = getSupabaseClient(c.env);
  await supabase.from('available_slots').insert({
    tenant_id: id,
    start_at: startAt,
    end_at: endAt,
    max_bookings: maxBookings,
  });
  return c.redirect(`/admin/tenants/${id}/slots`);
});

dashboard.post('/admin/tenants/:id/slots/:slotId/delete', async (c) => {
  const id = c.req.param('id');
  const slotId = c.req.param('slotId');
  const supabase = getSupabaseClient(c.env);
  await supabase.from('available_slots').update({ is_active: false }).eq('id', slotId).eq('tenant_id', id);
  return c.redirect(`/admin/tenants/${id}/slots`);
});

// --- Helper components ---
const MetricCard: FC<{ label: string; value: unknown; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div class={`card p-4 ${highlight ? 'gradient-hero text-white shadow-lg shadow-indigo-500/15' : ''}`}>
    <p class={`text-xs font-medium uppercase tracking-wider ${highlight ? 'text-white/60' : 'text-slate-400'}`}>{label}</p>
    <p class="text-2xl font-extrabold mt-1">{String(value)}</p>
  </div>
);

const FunnelBar: FC<{ label: string; value: number; max: number; color: string }> = ({ label, value, max, color }) => {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div class="flex items-center gap-3">
      <span class="w-24 text-sm text-gray-600">{label}</span>
      <div class="flex-1 bg-gray-200 rounded-full h-6 relative">
        <div class={`${color} h-6 rounded-full`} style={`width: ${pct}%`}></div>
      </div>
      <span class="w-16 text-sm text-right">{value} ({pct}%)</span>
    </div>
  );
};

// --- Form sub-components ---
const HearingItemRow: FC<{ item: { id: string; question_hint: string; required: boolean; priority: number }; index: number }> = ({ item, index }) => (
  <div class="hearing-row flex gap-2 items-start mb-2">
    <input type="hidden" name="hearing_id" value={item.id} />
    <input type="text" name="hearing_hint" value={item.question_hint} placeholder="質問のヒント" class="flex-1 border rounded px-2 py-1 text-sm" />
    <label class="flex items-center gap-1 text-sm">
      <input type="checkbox" name="hearing_required" value="on" checked={item.required} />必須
    </label>
    <input type="number" name="hearing_priority" value={String(item.priority)} min="1" class="w-16 border rounded px-2 py-1 text-sm" />
    <button type="button" onclick="this.parentElement.remove()" class="text-red-500 text-sm px-1">x</button>
  </div>
);

const ReminderItemRow: FC<{ reminder: { timing: string; type: string; content?: string; purpose?: string }; index: number }> = ({ reminder }) => (
  <div class="reminder-row border rounded p-3 mb-2 bg-gray-50">
    <div class="flex gap-2 mb-1">
      <input type="text" name="reminder_timing" value={reminder.timing} placeholder="例: 1_day_before" class="flex-1 border rounded px-2 py-1 text-sm" />
      <select name="reminder_type" class="border rounded px-2 py-1 text-sm">
        <option value="template" selected={reminder.type === 'template'}>テンプレート</option>
        <option value="ai" selected={reminder.type === 'ai'}>AI生成</option>
      </select>
      <button type="button" onclick="this.closest('.reminder-row').remove()" class="text-red-500 text-sm px-1">x</button>
    </div>
    <input type="text" name="reminder_content" value={reminder.content || ''} placeholder="テンプレート内容" class="w-full border rounded px-2 py-1 text-sm mb-1" />
    <input type="text" name="reminder_purpose" value={reminder.purpose || ''} placeholder="AI目的" class="w-full border rounded px-2 py-1 text-sm" />
  </div>
);

const ConversionCard: FC<{ label: string; value: number | null; benchmark: { min: number; max: number }; color: string }> = ({ label, value, benchmark, color }) => {
  const isGood = value !== null && value >= benchmark.min;
  const isBad = value !== null && value < benchmark.min;
  return (
    <div class={`text-center p-3 bg-${color}-50 rounded`}>
      <p class="text-sm text-gray-600">{label}</p>
      <p class={`text-2xl font-bold text-${color}-600`}>{value ?? '-'}%</p>
      <p class={`text-xs mt-1 ${isGood ? 'text-green-600' : isBad ? 'text-red-600' : 'text-gray-400'}`}>
        業界平均: {benchmark.min}-{benchmark.max}%
      </p>
    </div>
  );
};

// --- Utilities ---
function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'たった今';
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  return `${Math.floor(days / 30)}ヶ月前`;
}

function activityDotColor(type: string): string {
  switch (type) {
    case 'new_user': return 'bg-green-400';
    case 'booking': return 'bg-blue-400';
    case 'consultation': return 'bg-indigo-400';
    case 'enrollment': return 'bg-purple-400';
    case 'no_show': return 'bg-red-400';
    case 'stalled': return 'bg-orange-400';
    default: return 'bg-slate-400';
  }
}

function activityVerb(type: string): string {
  switch (type) {
    case 'new_user': return '友だち追加';
    case 'booking': return '予約';
    case 'consultation': return '相談完了';
    case 'enrollment': return '成約';
    case 'no_show': return 'ノーショー';
    case 'stalled': return '停滞';
    default: return type;
  }
}

function intentLabel(intent: string): string {
  switch (intent) {
    case 'defer': return '先延ばし';
    case 'hesitant': return '迷い中';
    case 'price_question': return '料金質問';
    case 'cancel': return 'キャンセル意向';
    case 'human_request': return 'スタッフ希望';
    case 'schedule_change': return '日程変更';
    default: return intent;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'active': return 'アクティブ';
    case 'booked': return '予約済み';
    case 'consulted': return '相談済み';
    case 'enrolled': return '成約';
    case 'stalled': return '停滞';
    case 'dropped': return '離脱';
    default: return status;
  }
}

function getQuickReplies(status: string): Array<{ label: string; text: string }> {
  const common = [
    { label: '挨拶', text: 'こんにちは！何かお手伝いできることはありますか？' },
  ];
  switch (status) {
    case 'active':
      return [...common,
        { label: '相談会案内', text: '無料相談会のご案内です。30分ほどお時間いただければ、具体的なアドバイスができますよ！' },
        { label: '様子伺い', text: 'その後いかがですか？何か気になることがあれば、いつでもお気軽にどうぞ😊' },
      ];
    case 'booked':
      return [...common,
        { label: '予約確認', text: 'ご予約ありがとうございます！当日お会いできるのを楽しみにしています。' },
        { label: '日程変更', text: '日程の変更をご希望でしたら、お気軽にお申し付けください。' },
      ];
    case 'stalled':
      return [...common,
        { label: '再アプローチ', text: 'お久しぶりです！その後いかがお過ごしですか？' },
        { label: 'クロージング', text: '何かお力になれることがあれば、いつでもメッセージくださいね。' },
      ];
    default:
      return common;
  }
}

function safeParseJSON(str: string | undefined, fallback: unknown): unknown {
  if (!str || str.trim() === '') return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function toneLabel(type: string, value: string): string {
  const labels: Record<string, Record<string, string>> = {
    personality: { friendly: '親しみやすい', professional: 'プロフェッショナル', casual: 'カジュアル', warm: '温かい', energetic: 'エネルギッシュ' },
    emoji: { none: '使わない', minimal: '少なめ', moderate: '普通', frequent: '多め' },
    style: { polite: '丁寧語', casual: 'タメ口', formal: '敬語', 'friendly-polite': '親しみのある丁寧語' },
  };
  return labels[type]?.[value] || value;
}

function notifyEventLabel(evt: string): string {
  switch (evt) {
    case 'human_handoff': return 'エスカレーション';
    case 'no_show': return 'ノーショー';
    case 'stalled': return '停滞';
    case 'error': return 'エラー';
    default: return evt;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-blue-100 text-blue-700';
    case 'booked': return 'bg-yellow-100 text-yellow-700';
    case 'consulted': return 'bg-green-100 text-green-700';
    case 'enrolled': return 'bg-indigo-100 text-indigo-700';
    case 'stalled': return 'bg-red-100 text-red-700';
    case 'dropped': return 'bg-gray-100 text-gray-500';
    default: return 'bg-gray-100 text-gray-500';
  }
}

function bookingStatusColor(status: string): string {
  switch (status) {
    case 'confirmed': return 'bg-blue-100 text-blue-700';
    case 'consulted': return 'bg-green-100 text-green-700';
    case 'no_show': return 'bg-red-100 text-red-700';
    case 'cancelled': return 'bg-gray-100 text-gray-500';
    default: return 'bg-gray-100 text-gray-500';
  }
}

function bookingStatusLabel(status: string): string {
  switch (status) {
    case 'confirmed': return '確定';
    case 'consulted': return '相談済み';
    case 'no_show': return 'ノーショー';
    case 'cancelled': return 'キャンセル';
    default: return status;
  }
}

function actionTypeLabel(type: string): string {
  switch (type) {
    case 'scenario_step': return 'シナリオ';
    case 'reminder': return 'リマインド';
    case 'follow_up': return '追客';
    case 'post_consultation': return '相談後';
    default: return type;
  }
}

function actionStatusColor(status: string): string {
  switch (status) {
    case 'pending': return 'bg-yellow-100 text-yellow-700';
    case 'processing': return 'bg-blue-100 text-blue-700';
    case 'completed': return 'bg-green-100 text-green-700';
    case 'failed': return 'bg-red-100 text-red-700';
    case 'cancelled': return 'bg-gray-100 text-gray-500';
    default: return 'bg-gray-100 text-gray-500';
  }
}

// ========================
// AI Conversation Simulator
// ========================

dashboard.get('/admin/tenants/:id/simulator', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('name, hearing_config, scenario_config, tone_config').eq('id', id).single();
  if (!tenant) return c.redirect('/admin/');

  const hearingItems = (tenant.hearing_config as Record<string, unknown>)?.items as Array<{ id: string; question_hint: string }> || [];
  const steps = ((tenant.scenario_config as Record<string, unknown>)?.steps as Array<{ id: string; type: string }>) || [];
  const aiSteps = steps.filter(s => s.type === 'ai');

  return c.html(
    <Layout title={`AIシミュレーター - ${tenant.name}`}>
      <div class="max-w-3xl mx-auto">
        <div class="flex items-center justify-between mb-6">
          <div>
            <a href={`/admin/tenants/${id}`} class="text-sm text-gray-500 hover:text-gray-700">&larr; {tenant.name}</a>
            <h1 class="text-2xl font-bold mt-1">AIシミュレーター</h1>
            <p class="text-sm text-gray-500 mt-1">テストユーザーとしてAIと会話してみましょう。実際のLINEメッセージは送信されません。</p>
          </div>
        </div>

        {/* Simulator Config */}
        <div class="bg-white rounded-lg shadow-sm border p-4 mb-4">
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">テストユーザー名</label>
              <input id="sim-name" type="text" value="テストユーザー" class="w-full border rounded px-3 py-1.5 text-sm" />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">ステップ</label>
              <select id="sim-step" class="w-full border rounded px-3 py-1.5 text-sm">
                {aiSteps.map(s => <option value={s.id}>{s.id}</option>)}
                <option value="booking_invite">booking_invite</option>
                <option value="booked">booked（予約後）</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">ステータス</label>
              <select id="sim-status" class="w-full border rounded px-3 py-1.5 text-sm">
                <option value="active">active</option>
                <option value="booked">booked</option>
                <option value="consulted">consulted</option>
              </select>
            </div>
          </div>
        </div>

        {/* Chat Area */}
        <div class="bg-white rounded-lg shadow-sm border overflow-hidden" style="height: 520px; display: flex; flex-direction: column;">
          <div class="bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-3 flex justify-between items-center">
            <span class="font-medium text-sm">AI会話プレビュー</span>
            <button id="sim-reset" class="text-xs bg-white/20 hover:bg-white/30 px-3 py-1 rounded transition">リセット</button>
          </div>

          <div id="sim-messages" class="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50" style="scroll-behavior: smooth;">
            <div class="text-center text-xs text-gray-400 py-8">メッセージを入力してAIの応答を確認してください</div>
          </div>

          <div class="border-t p-3 bg-white">
            <div class="flex gap-2">
              <input id="sim-input" type="text" placeholder="メッセージを入力..." class="flex-1 border rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />
              <button id="sim-send" class="bg-indigo-600 text-white px-5 py-2 rounded-full text-sm font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed">送信</button>
            </div>
            <div id="sim-meta" class="mt-2 hidden">
              <div class="text-xs text-gray-400 space-y-0.5">
                <div id="sim-extracted" class="hidden"></div>
                <div id="sim-insight" class="hidden"></div>
                <div id="sim-intent" class="hidden"></div>
              </div>
            </div>
          </div>
        </div>

        {/* Quick test scenarios */}
        <div class="mt-4 bg-white rounded-lg shadow-sm border p-4">
          <p class="text-xs font-medium text-gray-600 mb-2">クイックテスト（クリックで送信）</p>
          <div class="flex flex-wrap gap-2">
            {[
              'プログラミングに興味があります',
              '転職を考えています',
              '迷ってるんですけど...',
              'いくらかかりますか？',
              'また今度にします',
              'やっぱりやめます',
              '人と話したい',
              '日程を変更したいです',
            ].map(msg => (
              <button class="sim-quick text-xs bg-gray-100 hover:bg-indigo-50 hover:text-indigo-600 px-3 py-1.5 rounded-full transition border border-transparent hover:border-indigo-200" data-msg={msg}>{msg}</button>
            ))}
          </div>
        </div>
      </div>

      <script dangerouslySetInnerHTML={{__html: `
(function() {
  const tenantId = '${id}';
  let history = [];
  let hearingData = {};
  const messagesEl = document.getElementById('sim-messages');
  const inputEl = document.getElementById('sim-input');
  const sendBtn = document.getElementById('sim-send');
  const metaEl = document.getElementById('sim-meta');
  let sending = false;

  function addBubble(text, isUser) {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex ' + (isUser ? 'justify-end' : 'justify-start');
    const bubble = document.createElement('div');
    bubble.className = isUser
      ? 'max-w-[75%] bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm'
      : 'max-w-[75%] bg-white border rounded-2xl rounded-tl-sm px-4 py-2 text-sm shadow-sm';
    bubble.textContent = text;
    wrapper.appendChild(bubble);
    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addTyping() {
    const wrapper = document.createElement('div');
    wrapper.id = 'typing';
    wrapper.className = 'flex justify-start';
    wrapper.innerHTML = '<div class="bg-white border rounded-2xl rounded-tl-sm px-4 py-2 text-sm shadow-sm text-gray-400">入力中...</div>';
    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeTyping() {
    const el = document.getElementById('typing');
    if (el) el.remove();
  }

  async function send(msg) {
    if (sending || !msg.trim()) return;
    sending = true;
    sendBtn.disabled = true;
    inputEl.value = '';

    addBubble(msg, true);
    history.push({ role: 'user', content: msg });
    addTyping();

    try {
      const res = await fetch('/admin/api/tenants/' + tenantId + '/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          history: history,
          config: {
            user_name: document.getElementById('sim-name').value,
            current_step: document.getElementById('sim-step').value,
            status: document.getElementById('sim-status').value,
            hearing_data: hearingData,
          }
        })
      });
      const data = await res.json();
      removeTyping();

      if (data.error) {
        addBubble('(エラー: ' + data.error + ')', false);
      } else {
        addBubble(data.reply, false);
        history.push({ role: 'assistant', content: data.reply });

        if (data.updated_hearing_data) hearingData = data.updated_hearing_data;

        // Show metadata
        metaEl.classList.remove('hidden');
        const extEl = document.getElementById('sim-extracted');
        const insEl = document.getElementById('sim-insight');
        const intEl = document.getElementById('sim-intent');

        if (data.extracted_data && Object.keys(data.extracted_data).length > 0) {
          extEl.classList.remove('hidden');
          extEl.textContent = '抽出データ: ' + JSON.stringify(data.extracted_data);
        }
        if (data.insight) {
          insEl.classList.remove('hidden');
          insEl.textContent = 'インサイト: ' + data.insight;
        }
        if (data.detected_intent && data.detected_intent !== 'none') {
          intEl.classList.remove('hidden');
          intEl.textContent = '検知意図: ' + data.detected_intent;
        }
        if (data.is_hearing_complete) {
          addBubble('--- ヒアリング完了 ---', false);
        }
        if (data.escalate_to_human) {
          addBubble('--- 人間エスカレーション発生 ---', false);
        }
      }
    } catch (e) {
      removeTyping();
      addBubble('(通信エラー)', false);
    }
    sending = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  sendBtn.addEventListener('click', () => send(inputEl.value));
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(inputEl.value); });
  document.getElementById('sim-reset').addEventListener('click', () => {
    history = [];
    hearingData = {};
    messagesEl.innerHTML = '<div class="text-center text-xs text-gray-400 py-8">メッセージを入力してAIの応答を確認してください</div>';
    metaEl.classList.add('hidden');
  });
  document.querySelectorAll('.sim-quick').forEach(btn => {
    btn.addEventListener('click', () => send(btn.dataset.msg));
  });
})();
      `}} />
    </Layout>
  );
});

// ========================
// Live Conversation Feed
// ========================

dashboard.get('/admin/tenants/:id/live', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', id).single();
  if (!tenant) return c.redirect('/admin/');

  // Get recent conversations grouped by user
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: messages } = await supabase
    .from('conversations')
    .select('*, end_users!inner(id, display_name, line_user_id, status, current_step, is_staff_takeover)')
    .eq('tenant_id', id)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200);

  // Group by user
  const userMap = new Map<string, { user: Record<string, unknown>; messages: Array<Record<string, unknown>> }>();
  for (const msg of messages || []) {
    const eu = msg.end_users as Record<string, unknown>;
    const uid = eu.id as string;
    if (!userMap.has(uid)) {
      userMap.set(uid, { user: eu, messages: [] });
    }
    userMap.get(uid)!.messages.push(msg);
  }

  // Sort by most recent message
  const sortedUsers = Array.from(userMap.values()).sort((a, b) => {
    const aTime = new Date(a.messages[0].created_at as string).getTime();
    const bTime = new Date(b.messages[0].created_at as string).getTime();
    return bTime - aTime;
  });

  return c.html(
    <Layout title={`ライブ会話 - ${tenant.name}`}>
      <div class="max-w-6xl mx-auto">
        <div class="flex items-center justify-between mb-6">
          <div>
            <a href={`/admin/tenants/${id}`} class="text-sm text-gray-500 hover:text-gray-700">&larr; {tenant.name}</a>
            <h1 class="text-2xl font-bold mt-1 flex items-center gap-2">
              ライブ会話モニター
              <span class="inline-block w-2 h-2 bg-emerald-500 rounded-full" style="animation: pulse-dot 2s infinite"></span>
            </h1>
            <p class="text-sm text-gray-500 mt-1">直近24時間のAI会話をリアルタイムで監視。問題があればワンクリックで介入できます。</p>
          </div>
          <a href={`/admin/tenants/${id}/simulator`} class="bg-indigo-600 text-white px-4 py-2 rounded text-sm hover:bg-indigo-700 transition">AIシミュレーター</a>
        </div>

        {sortedUsers.length === 0 ? (
          <div class="text-center py-16 text-gray-400">
            <p class="text-lg mb-2">直近24時間の会話はありません</p>
            <p class="text-sm">新しい会話が始まるとここに表示されます</p>
          </div>
        ) : (
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {sortedUsers.map(({ user, messages: msgs }) => {
              const userName = (user.display_name as string) || '匿名';
              const userStatus = user.status as string;
              const isTakeover = user.is_staff_takeover as boolean;
              const userId = user.id as string;
              const reversedMsgs = [...msgs].reverse().slice(-8); // Show last 8 messages

              return (
                <div class={`bg-white rounded-lg shadow-sm border overflow-hidden ${isTakeover ? 'ring-2 ring-amber-400' : ''}`}>
                  {/* Header */}
                  <div class="bg-gradient-to-r from-slate-700 to-slate-800 text-white px-4 py-3 flex justify-between items-center">
                    <div class="flex items-center gap-2">
                      <span class="font-medium text-sm">{userName}</span>
                      <span class={`text-[10px] px-1.5 py-0.5 rounded ${statusBadgeColor(userStatus)}`}>{statusLabel(userStatus)}</span>
                      {isTakeover && <span class="text-[10px] bg-amber-500 text-white px-1.5 py-0.5 rounded">スタッフ対応中</span>}
                    </div>
                    <div class="flex gap-1">
                      <a href={`/admin/tenants/${id}/users/${userId}`} class="text-xs bg-white/20 hover:bg-white/30 px-2 py-1 rounded transition">詳細</a>
                    </div>
                  </div>

                  {/* Messages */}
                  <div class="p-3 space-y-2 bg-slate-50 max-h-64 overflow-y-auto">
                    {reversedMsgs.map(m => {
                      const isUser = m.role === 'user';
                      return (
                        <div class={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                          <div class={`max-w-[80%] px-3 py-1.5 text-xs rounded-xl ${isUser ? 'bg-indigo-100 text-indigo-900 rounded-tr-sm' : 'bg-white border rounded-tl-sm shadow-sm'}`}>
                            {m.content as string}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Quick actions */}
                  <div class="border-t px-3 py-2 bg-white flex items-center gap-2">
                    <span class="text-[10px] text-gray-400">{timeAgo(msgs[0].created_at as string)}</span>
                    <div class="flex-1"></div>
                    <a href={`/admin/tenants/${id}/users/${userId}`} class="text-xs text-indigo-600 hover:text-indigo-800 font-medium">会話を見る &rarr;</a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
});

// ========================
// AI Sessions Dashboard
// ========================

dashboard.get('/admin/tenants/:id/sessions', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', id).single();
  if (!tenant) return c.html(<Layout title="Not Found"><p>テナントが見つかりません</p></Layout>);

  const status = c.req.query('status') || '';

  let q = supabase
    .from('ai_sessions')
    .select('*, end_users!inner(display_name, line_user_id)', { count: 'exact' })
    .eq('tenant_id', id)
    .order('started_at', { ascending: false })
    .limit(50);

  if (status) q = q.eq('status', status);

  const { data: sessions, count } = await q;

  // Get session stats
  const [
    { count: activeCount },
    { count: completedCount },
    { count: expiredCount },
    { count: escalatedCount },
  ] = await Promise.all([
    supabase.from('ai_sessions').select('*', { count: 'exact', head: true }).eq('tenant_id', id).eq('status', 'active'),
    supabase.from('ai_sessions').select('*', { count: 'exact', head: true }).eq('tenant_id', id).eq('status', 'completed'),
    supabase.from('ai_sessions').select('*', { count: 'exact', head: true }).eq('tenant_id', id).eq('status', 'expired'),
    supabase.from('ai_sessions').select('*', { count: 'exact', head: true }).eq('tenant_id', id).eq('status', 'escalated'),
  ]);

  // Average turns for completed sessions
  const { data: turnData } = await supabase
    .from('ai_sessions')
    .select('turn_count')
    .eq('tenant_id', id)
    .eq('status', 'completed');

  const avgTurns = turnData && turnData.length > 0
    ? (turnData.reduce((s: number, t: { turn_count: number }) => s + t.turn_count, 0) / turnData.length).toFixed(1)
    : '0';

  const completionRate = (activeCount || 0) + (completedCount || 0) + (expiredCount || 0) + (escalatedCount || 0) > 0
    ? Math.round(((completedCount || 0) / ((activeCount || 0) + (completedCount || 0) + (expiredCount || 0) + (escalatedCount || 0))) * 100)
    : 0;

  const sessionStatusColor = (s: string) => {
    switch(s) {
      case 'active': return 'bg-emerald-100 text-emerald-700';
      case 'completed': return 'bg-blue-100 text-blue-700';
      case 'expired': return 'bg-gray-100 text-gray-600';
      case 'escalated': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  return c.html(
    <Layout title={`AIセッション - ${tenant.name}`}>
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">AIセッション</h1>
        <a href={`/admin/tenants/${id}`} class="text-sm text-indigo-600 hover:text-indigo-800">&larr; テナントに戻る</a>
      </div>

      {/* Stats */}
      <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div class="bg-white p-4 rounded shadow text-center">
          <p class="text-2xl font-bold text-emerald-600">{activeCount || 0}</p>
          <p class="text-xs text-gray-500">アクティブ</p>
        </div>
        <div class="bg-white p-4 rounded shadow text-center">
          <p class="text-2xl font-bold text-blue-600">{completedCount || 0}</p>
          <p class="text-xs text-gray-500">完了</p>
        </div>
        <div class="bg-white p-4 rounded shadow text-center">
          <p class="text-2xl font-bold text-gray-500">{expiredCount || 0}</p>
          <p class="text-xs text-gray-500">期限切れ</p>
        </div>
        <div class="bg-white p-4 rounded shadow text-center">
          <p class="text-2xl font-bold text-red-600">{escalatedCount || 0}</p>
          <p class="text-xs text-gray-500">エスカレ</p>
        </div>
        <div class="bg-white p-4 rounded shadow text-center">
          <p class="text-2xl font-bold">{completionRate}%</p>
          <p class="text-xs text-gray-500">完了率 / 平均{avgTurns}ターン</p>
        </div>
      </div>

      {/* Filter */}
      <div class="flex gap-2 mb-4">
        <a href={`/admin/tenants/${id}/sessions`} class={`px-3 py-1 rounded text-sm ${!status ? 'bg-indigo-600 text-white' : 'bg-gray-100'}`}>全て</a>
        <a href={`/admin/tenants/${id}/sessions?status=active`} class={`px-3 py-1 rounded text-sm ${status === 'active' ? 'bg-emerald-600 text-white' : 'bg-gray-100'}`}>アクティブ</a>
        <a href={`/admin/tenants/${id}/sessions?status=completed`} class={`px-3 py-1 rounded text-sm ${status === 'completed' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>完了</a>
        <a href={`/admin/tenants/${id}/sessions?status=escalated`} class={`px-3 py-1 rounded text-sm ${status === 'escalated' ? 'bg-red-600 text-white' : 'bg-gray-100'}`}>エスカレ</a>
      </div>

      {/* Sessions List */}
      <div class="bg-white rounded shadow overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-left">
            <tr>
              <th class="px-4 py-3 font-medium">ユーザー</th>
              <th class="px-4 py-3 font-medium">タイプ</th>
              <th class="px-4 py-3 font-medium">ステータス</th>
              <th class="px-4 py-3 font-medium">フェーズ</th>
              <th class="px-4 py-3 font-medium">ターン数</th>
              <th class="px-4 py-3 font-medium">開始</th>
            </tr>
          </thead>
          <tbody>
            {(sessions || []).map((s: Record<string, unknown>) => {
              const eu = s.end_users as unknown as { display_name: string | null; line_user_id: string };
              return (
                <tr class="border-t hover:bg-gray-50">
                  <td class="px-4 py-3">
                    <a href={`/admin/tenants/${id}/users/${s.end_user_id}`} class="text-indigo-600 hover:text-indigo-800">
                      {eu?.display_name || eu?.line_user_id || '(不明)'}
                    </a>
                  </td>
                  <td class="px-4 py-3">{s.session_type as string}</td>
                  <td class="px-4 py-3">
                    <span class={`px-2 py-0.5 rounded text-xs ${sessionStatusColor(s.status as string)}`}>
                      {s.status as string}
                    </span>
                  </td>
                  <td class="px-4 py-3 text-gray-500">{(s.phase as string) || '-'}</td>
                  <td class="px-4 py-3">{s.turn_count as number}</td>
                  <td class="px-4 py-3 text-gray-500 text-xs">{formatDateTimeJST(s.started_at as string)}</td>
                </tr>
              );
            })}
            {(!sessions || sessions.length === 0) && (
              <tr><td colspan={6} class="px-4 py-8 text-center text-gray-400">セッションがありません</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p class="text-xs text-gray-400 mt-2">合計: {count || 0}件</p>
    </Layout>
  );
});

function statusBadgeColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-emerald-500/20 text-emerald-300';
    case 'booked': return 'bg-blue-500/20 text-blue-300';
    case 'consulted': return 'bg-purple-500/20 text-purple-300';
    case 'enrolled': return 'bg-amber-500/20 text-amber-300';
    case 'stalled': return 'bg-red-500/20 text-red-300';
    default: return 'bg-gray-500/20 text-gray-300';
  }
}

export default dashboard;
