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

// --- Layout ---
const Layout: FC<{ title: string; children: unknown }> = ({ title, children }) => (
  <html lang="ja">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title} - LINE Attend Agent</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes score-fill { from { width: 0%; } to { width: var(--score-width); } }
        @keyframes slide-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes glow { 0%, 100% { box-shadow: 0 0 5px rgba(99,102,241,0.3); } 50% { box-shadow: 0 0 20px rgba(99,102,241,0.6); } }
        .pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
        .gradient-hero { background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #6366f1 100%); }
        .gradient-card { background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); }
        .gradient-score { background: linear-gradient(90deg, var(--score-from), var(--score-to)); }
        .line-bubble-user { background: #fff; border: 1px solid #e5e7eb; border-radius: 0 18px 18px 18px; }
        .line-bubble-bot { background: #e0f2fe; border-radius: 18px 0 18px 18px; }
        .line-bubble-staff { background: #fef3c7; border-radius: 18px 0 18px 18px; }
        .chat-container::-webkit-scrollbar { width: 6px; }
        .chat-container::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        .health-bar { transition: width 0.5s ease; }
        .score-bar { animation: score-fill 0.8s ease-out forwards; width: var(--score-width); }
        .slide-in { animation: slide-in 0.3s ease-out; }
        .mission-glow { animation: glow 2s ease-in-out infinite; }
        .dropoff-bar { transition: width 0.6s ease; }
        .suggestion-card { border-left: 3px solid #6366f1; }
      `}} />
    </head>
    <body class="bg-slate-50 min-h-screen">
      <nav class="gradient-hero text-white px-6 py-3 flex items-center justify-between shadow-lg">
        <a href="/admin/" class="text-lg font-bold tracking-tight flex items-center gap-2">
          <span class="bg-white/20 px-2 py-0.5 rounded text-sm">LA</span>
          LINE Attend Agent
        </a>
        <div class="flex gap-5 items-center text-sm">
          <a href="/admin/" class="hover:text-white/80 transition">ダッシュボード</a>
          <a href="/admin/system" class="hover:text-white/80 transition">システム</a>
          <form method="post" action="/admin/logout" class="inline">
            <button type="submit" class="bg-white/10 px-3 py-1 rounded hover:bg-white/20 transition">ログアウト</button>
          </form>
        </div>
      </nav>
      <main class="max-w-7xl mx-auto px-6 py-8">{children}</main>
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
      </head>
      <body class="bg-gray-50 min-h-screen flex items-center justify-center">
        <div class="bg-white p-8 rounded-lg shadow-md w-96">
          <h1 class="text-2xl font-bold mb-6 text-center">管理ログイン</h1>
          {error && <p class="text-red-500 mb-4 text-sm">認証キーが正しくありません</p>}
          <form method="post" action="/admin/login">
            <label class="block mb-2 text-sm font-medium">管理キー</label>
            <input type="password" name="key" class="w-full border rounded px-3 py-2 mb-4" required />
            <button type="submit" class="w-full bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700">
              ログイン
            </button>
          </form>
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

  return c.html(
    <Layout title="ダッシュボード">
      <div class="flex justify-between items-center mb-8">
        <div>
          <h1 class="text-3xl font-bold text-slate-800">ダッシュボード</h1>
          <p class="text-slate-500 text-sm mt-1">全テナント横断サマリー</p>
        </div>
        <a href="/admin/tenants/new" class="gradient-hero text-white px-5 py-2.5 rounded-lg hover:opacity-90 transition shadow-md text-sm font-medium">
          + 新規テナント
        </a>
      </div>

      {/* TODAY'S MISSION - The killer morning briefing */}
      {totalMissionItems > 0 && (
        <div class="mb-8 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 rounded-2xl p-6 text-white shadow-xl mission-glow slide-in">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="text-lg font-bold">今日のミッション</h2>
              <p class="text-white/70 text-sm">優先度の高い{totalMissionItems}件のアクションがあります</p>
            </div>
            <div class="bg-white/20 rounded-full px-4 py-1 text-sm font-bold">{totalMissionItems}</div>
          </div>
          <div class="grid grid-cols-4 gap-4">
            {totalConsultationsToday > 0 && (
              <div class="bg-white/15 rounded-xl p-4 backdrop-blur-sm">
                <div class="flex items-center gap-2 mb-2">
                  <span class="w-2 h-2 rounded-full bg-red-400 pulse-dot"></span>
                  <span class="text-xs font-bold text-red-200 uppercase">CRITICAL</span>
                </div>
                <p class="text-2xl font-bold">{totalConsultationsToday}</p>
                <p class="text-white/80 text-xs mt-1">本日の相談会</p>
              </div>
            )}
            {totalHotLeads > 0 && (
              <div class="bg-white/15 rounded-xl p-4 backdrop-blur-sm">
                <div class="flex items-center gap-2 mb-2">
                  <span class="w-2 h-2 rounded-full bg-orange-400 pulse-dot"></span>
                  <span class="text-xs font-bold text-orange-200 uppercase">HOT</span>
                </div>
                <p class="text-2xl font-bold">{totalHotLeads}</p>
                <p class="text-white/80 text-xs mt-1">反応ありリード</p>
              </div>
            )}
            {totalNoShows > 0 && (
              <div class="bg-white/15 rounded-xl p-4 backdrop-blur-sm">
                <div class="flex items-center gap-2 mb-2">
                  <span class="w-2 h-2 rounded-full bg-amber-400"></span>
                  <span class="text-xs font-bold text-amber-200 uppercase">RECOVERY</span>
                </div>
                <p class="text-2xl font-bold">{totalNoShows}</p>
                <p class="text-white/80 text-xs mt-1">ノーショー回復</p>
              </div>
            )}
            {totalNeedsManual > 0 && (
              <div class="bg-white/15 rounded-xl p-4 backdrop-blur-sm">
                <div class="flex items-center gap-2 mb-2">
                  <span class="w-2 h-2 rounded-full bg-yellow-400"></span>
                  <span class="text-xs font-bold text-yellow-200 uppercase">MANUAL</span>
                </div>
                <p class="text-2xl font-bold">{totalNeedsManual}</p>
                <p class="text-white/80 text-xs mt-1">手動対応必要</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* KPI Cards */}
      {metrics.length > 0 && (
        <div class="grid grid-cols-4 gap-5 mb-8">
          <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
            <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">総ユーザー</p>
            <p class="text-3xl font-bold text-slate-800 mt-1">{totalUsers}</p>
            <div class="mt-2 flex items-center gap-1">
              <div class="w-full bg-slate-100 rounded-full h-1.5">
                <div class="bg-blue-500 h-1.5 rounded-full health-bar" style={`width: ${totalUsers > 0 ? 100 : 0}%`}></div>
              </div>
            </div>
          </div>
          <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
            <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">予約済み</p>
            <p class="text-3xl font-bold text-amber-600 mt-1">{totalBooked}</p>
            <p class="text-xs text-slate-400 mt-2">{totalUsers > 0 ? Math.round(totalBooked / totalUsers * 100) : 0}% of total</p>
          </div>
          <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
            <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">相談済み</p>
            <p class="text-3xl font-bold text-emerald-600 mt-1">{totalConsulted}</p>
            <p class="text-xs text-slate-400 mt-2">{totalBooked > 0 ? Math.round(totalConsulted / totalBooked * 100) : 0}% 着座率</p>
          </div>
          <div class="gradient-hero p-5 rounded-xl shadow-md text-white">
            <p class="text-xs font-medium text-white/70 uppercase tracking-wider">入会済み</p>
            <p class="text-3xl font-bold mt-1">{totalEnrolled}</p>
            <p class="text-xs text-white/70 mt-2">全体CVR: {totalUsers > 0 ? Math.round(totalEnrolled / totalUsers * 100) : 0}%</p>
          </div>
        </div>
      )}

      <div class="grid grid-cols-3 gap-6 mb-8">
        {/* Tenant list */}
        <div class="col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div class="px-5 py-4 border-b border-slate-100 flex justify-between items-center">
            <h2 class="font-bold text-slate-700">テナント</h2>
            <span class="text-xs text-slate-400">{(tenants || []).length}件</span>
          </div>
          <table class="w-full">
            <thead>
              <tr class="text-xs text-slate-400 uppercase tracking-wider">
                <th class="text-left px-5 py-3 font-medium">名前</th>
                <th class="text-left px-5 py-3 font-medium">状態</th>
                <th class="text-right px-5 py-3 font-medium">ユーザー</th>
                <th class="text-right px-5 py-3 font-medium">着座率</th>
                <th class="text-center px-5 py-3 font-medium">ミッション</th>
                <th class="text-right px-5 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {(tenants || []).map((t) => {
                const m = metrics.find((met) => met.tenant_id === t.id);
                const mission = missions[t.id];
                const missionCount = mission ? mission.priority_actions.reduce((s, a) => s + a.count, 0) : 0;
                return (
                  <tr class="border-t border-slate-50 hover:bg-slate-50/50 transition">
                    <td class="px-5 py-3">
                      <a href={`/admin/tenants/${t.id}`} class="font-medium text-slate-700 hover:text-indigo-600 transition">{t.name}</a>
                    </td>
                    <td class="px-5 py-3">
                      {t.is_active ? (
                        <span class="flex items-center gap-1.5 text-xs text-emerald-600">
                          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 pulse-dot"></span>稼働中
                        </span>
                      ) : (
                        <span class="text-xs text-slate-400">停止</span>
                      )}
                    </td>
                    <td class="px-5 py-3 text-right font-medium text-slate-600">{m?.total_users ?? 0}</td>
                    <td class="px-5 py-3 text-right">
                      {m?.attendance_rate != null ? (
                        <span class={`font-bold text-sm ${(m.attendance_rate || 0) >= 60 ? 'text-emerald-600' : (m.attendance_rate || 0) >= 40 ? 'text-amber-600' : 'text-red-500'}`}>
                          {m.attendance_rate}%
                        </span>
                      ) : <span class="text-slate-300">-</span>}
                    </td>
                    <td class="px-5 py-3 text-center">
                      {missionCount > 0 ? (
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-bold">
                          <span class="w-1.5 h-1.5 rounded-full bg-red-500 pulse-dot"></span>{missionCount}
                        </span>
                      ) : <span class="text-xs text-slate-300">-</span>}
                    </td>
                    <td class="px-5 py-3 text-right">
                      <div class="flex gap-2 justify-end">
                        <a href={`/admin/tenants/${t.id}/users`} class="text-xs text-slate-400 hover:text-indigo-600 transition">ユーザー</a>
                        <a href={`/admin/tenants/${t.id}/analytics`} class="text-xs text-slate-400 hover:text-indigo-600 transition">分析</a>
                        <a href={`/admin/tenants/${t.id}/bookings`} class="text-xs text-slate-400 hover:text-indigo-600 transition">予約</a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(!tenants || tenants.length === 0) && (
            <div class="p-8 text-center">
              <p class="text-slate-400 mb-3">テナントがまだありません</p>
              <a href="/admin/tenants/new" class="text-indigo-600 hover:underline text-sm">最初のテナントを作成</a>
            </div>
          )}
        </div>

        {/* Activity Feed */}
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div class="px-5 py-4 border-b border-slate-100">
            <h2 class="font-bold text-slate-700">直近のアクティビティ</h2>
          </div>
          <div class="divide-y divide-slate-50 max-h-[400px] overflow-y-auto">
            {activity.length > 0 ? activity.map((evt) => (
              <div class="px-5 py-3 hover:bg-slate-50/50 transition">
                <div class="flex items-start gap-3">
                  <span class={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${activityDotColor(evt.type)}`}></span>
                  <div class="min-w-0">
                    <p class="text-sm text-slate-700 truncate">
                      <span class="font-medium">{evt.user_name || '新規ユーザー'}</span>
                      <span class="text-slate-400 mx-1">{activityVerb(evt.type)}</span>
                    </p>
                    <p class="text-xs text-slate-400 mt-0.5">{evt.tenant_name} / {timeAgo(evt.timestamp)}</p>
                  </div>
                </div>
              </div>
            )) : (
              <p class="p-5 text-sm text-slate-400 text-center">まだアクティビティがありません</p>
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
      <h1 class="text-2xl font-bold mb-6">新規テナント作成</h1>
      <div class="bg-green-50 border border-green-200 rounded p-4 mb-6">
        <p class="text-sm text-green-700">推奨設定がプリセットされています。LINE Channel情報とスクール情報を入力するだけで始められます。</p>
      </div>
      <form method="post" action="/admin/tenants/new" class="bg-white p-6 rounded shadow max-w-2xl space-y-4">
        <div class="border-b pb-4">
          <h2 class="text-lg font-bold mb-3">基本情報</h2>
          <div class="space-y-3">
            <div>
              <label class="block text-sm font-medium mb-1">スクール名 *</label>
              <input type="text" name="name" required class="w-full border rounded px-3 py-2" placeholder="例: ABCプログラミングスクール" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">LINE Channel ID *</label>
              <input type="text" name="line_channel_id" required class="w-full border rounded px-3 py-2" placeholder="LINE Developers Console から取得" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">LINE Channel Secret *</label>
              <input type="text" name="line_channel_secret" required class="w-full border rounded px-3 py-2" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">LINE Channel Access Token *</label>
              <textarea name="line_channel_access_token" required rows={2} class="w-full border rounded px-3 py-2"></textarea>
            </div>
          </div>
        </div>

        <div class="border-b pb-4">
          <h2 class="text-lg font-bold mb-3">スクール情報（重要）</h2>
          <p class="text-xs text-gray-500 mb-2">AIがユーザーと会話する際のコンテキストになります。できるだけ詳しく記載してください。</p>
          <textarea name="school_context" rows={5} class="w-full border rounded px-3 py-2" placeholder="例: ABCプログラミングスクールは、未経験からWebエンジニア転職を目指す方向けのオンラインスクールです。&#10;&#10;特徴:&#10;- 3ヶ月の集中カリキュラム&#10;- 現役エンジニアによる1on1メンタリング&#10;- 転職保証付き&#10;&#10;無料相談会では、受講生の転職実績やカリキュラムの詳細をご紹介します。"></textarea>
        </div>

        <div class="border-b pb-4">
          <h2 class="text-lg font-bold mb-3">会話フロー設定</h2>
          <p class="text-xs text-gray-500 mb-2">推奨設定がプリセット済み。カスタマイズも可能です。</p>
          <div>
            <label class="block text-sm font-medium mb-1">シナリオ設定 (JSON)</label>
            <textarea name="scenario_config" rows={8} class="w-full border rounded px-3 py-2 font-mono text-xs">{JSON.stringify(defaults.scenario_config, null, 2)}</textarea>
          </div>
        </div>

        {/* Hearing Config - Structured Form */}
        <div class="border-b pb-4">
          <h2 class="text-lg font-bold mb-3">ヒアリング項目</h2>
          <p class="text-xs text-gray-500 mb-2">ユーザーに聞きたい質問を設定します。</p>
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

        {/* Reminder Config - Structured Form */}
        <div class="border-b pb-4">
          <h2 class="text-lg font-bold mb-3">リマインド設定</h2>
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

        {/* Tone Config - Structured Form */}
        <div class="border-b pb-4">
          <h2 class="text-lg font-bold mb-3">トーン設定</h2>
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

        {/* Guardrail Config - Structured Form */}
        <div class="border-b pb-4">
          <h2 class="text-lg font-bold mb-3">ガードレール設定</h2>
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

        {/* Notification Config - Structured Form */}
        <div class="border-b pb-4">
          <h2 class="text-lg font-bold mb-3">スタッフ通知設定</h2>
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

        <button type="submit" class="w-full bg-indigo-600 text-white px-6 py-3 rounded hover:bg-indigo-700 text-lg font-bold">テナントを作成</button>
      </form>
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

  return c.html(
    <Layout title={tenant.name}>
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{tenant.name}</h1>
        <div class="space-x-2 flex flex-wrap gap-1">
          <a href={`/admin/tenants/${id}/users`} class="bg-gray-100 px-4 py-2 rounded hover:bg-gray-200 text-sm">ユーザー一覧</a>
          <a href={`/admin/tenants/${id}/bookings`} class="bg-gray-100 px-4 py-2 rounded hover:bg-gray-200 text-sm">予約管理</a>
          <a href={`/admin/tenants/${id}/analytics`} class="bg-gray-100 px-4 py-2 rounded hover:bg-gray-200 text-sm">分析</a>
          <a href={`/admin/tenants/${id}/slots`} class="bg-gray-100 px-4 py-2 rounded hover:bg-gray-200 text-sm">予約枠</a>
          <a href={`/admin/tenants/${id}/actions`} class="bg-gray-100 px-4 py-2 rounded hover:bg-gray-200 text-sm">アクション</a>
        </div>
      </div>

      <div class="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
        <p class="text-sm font-medium text-blue-700 mb-1">Webhook URL（LINE Developersに設定）</p>
        <code class="text-sm break-all">{webhookUrl}</code>
      </div>

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

      <form method="post" action={`/admin/tenants/${id}/edit`} class="bg-white p-6 rounded shadow space-y-4">
        <div>
          <label class="block text-sm font-medium mb-1">スクール名</label>
          <input type="text" name="name" value={tenant.name} class="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">LINE Channel ID</label>
          <input type="text" name="line_channel_id" value={tenant.line_channel_id} class="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">LINE Channel Secret</label>
          <input type="text" name="line_channel_secret" value={tenant.line_channel_secret} class="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">LINE Channel Access Token</label>
          <textarea name="line_channel_access_token" rows={2} class="w-full border rounded px-3 py-2">{tenant.line_channel_access_token}</textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">スクール情報</label>
          <textarea name="school_context" rows={3} class="w-full border rounded px-3 py-2">{tenant.school_context}</textarea>
        </div>

        {/* Scenario - JSON maintained with flow preview above */}
        <div>
          <label class="block text-sm font-medium mb-1">シナリオ設定 (JSON)</label>
          <textarea name="scenario_config" rows={8} class="w-full border rounded px-3 py-2 font-mono text-sm">{JSON.stringify(tenant.scenario_config, null, 2)}</textarea>
        </div>

        {/* Hearing - Structured Form */}
        <div class="border-t pt-4">
          <h3 class="text-sm font-bold mb-2">ヒアリング項目</h3>
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

        {/* Reminder - Structured Form */}
        <div class="border-t pt-4">
          <h3 class="text-sm font-bold mb-2">リマインド設定</h3>
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

        {/* Tone - Structured Form */}
        <div class="border-t pt-4">
          <h3 class="text-sm font-bold mb-2">トーン設定</h3>
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

        {/* Guardrail - Structured Form */}
        <div class="border-t pt-4">
          <h3 class="text-sm font-bold mb-2">ガードレール設定</h3>
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

        {/* Notification - Structured Form */}
        <div class="border-t pt-4">
          <h3 class="text-sm font-bold mb-2">スタッフ通知設定</h3>
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

        <div class="flex gap-2 items-center border-t pt-4">
          <button type="submit" class="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700">更新</button>
          <span class={`px-3 py-2 rounded text-sm ${tenant.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
            {tenant.is_active ? '有効' : '無効'}
          </span>
        </div>
        </form>
        <form method="post" action={`/admin/tenants/${id}/toggle`} class="mt-4">
          <button type="submit" class={`px-4 py-2 rounded text-sm ${tenant.is_active ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}>
            {tenant.is_active ? 'テナントを無効化' : 'テナントを有効化'}
          </button>
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
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{tenant?.name} - ユーザー一覧</h1>
        <a href={`/admin/tenants/${id}`} class="text-indigo-600 hover:underline text-sm">テナント詳細に戻る</a>
      </div>

      {/* Status filter */}
      <div class="mb-4 flex gap-2 flex-wrap">
        <a href={`/admin/tenants/${id}/users`} class={`px-3 py-1 rounded text-sm ${!statusFilter ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>全て</a>
        {['active', 'booked', 'consulted', 'enrolled', 'stalled', 'dropped'].map((s) => (
          <a href={`/admin/tenants/${id}/users?status=${s}`} class={`px-3 py-1 rounded text-sm ${statusFilter === s ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>{statusLabel(s)}</a>
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
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{user.display_name || '(名前なし)'}</h1>
        <a href={`/admin/tenants/${tenantId}/users`} class="text-indigo-600 hover:underline text-sm">一覧に戻る</a>
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
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{tenant?.name} - 詳細分析</h1>
        <a href={`/admin/tenants/${id}`} class="text-indigo-600 hover:underline text-sm">テナント詳細に戻る</a>
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
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{tenant?.name} - 予約管理</h1>
        <a href={`/admin/tenants/${id}`} class="text-indigo-600 hover:underline text-sm">テナント詳細に戻る</a>
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
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{tenant?.name} - アクション管理</h1>
        <a href={`/admin/tenants/${id}`} class="text-indigo-600 hover:underline text-sm">テナント詳細に戻る</a>
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
      <h1 class="text-2xl font-bold mb-6">システム状態</h1>

      <div class={`p-4 rounded mb-6 ${systemOk ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
        <p class={`text-lg font-bold ${systemOk ? 'text-green-700' : 'text-red-700'}`}>
          {systemOk ? '正常稼働中' : '要確認'}
        </p>
        <p class="text-sm text-gray-600 mt-1">最終確認: {formatDateTimeJST(now.toISOString())}</p>
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
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{tenant?.name} - 予約枠管理</h1>
        <a href={`/admin/tenants/${id}`} class="text-indigo-600 hover:underline text-sm">テナント詳細に戻る</a>
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
  <div class={`p-4 rounded shadow ${highlight ? 'bg-indigo-600 text-white' : 'bg-white'}`}>
    <p class={`text-sm ${highlight ? 'text-indigo-200' : 'text-gray-500'}`}>{label}</p>
    <p class="text-2xl font-bold">{String(value)}</p>
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

export default dashboard;
