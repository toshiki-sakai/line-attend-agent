import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { FC } from 'hono/jsx';
import type { Env } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { invalidateTenantCache } from '../config/tenant-config';
import { getAllFunnelMetrics, getFunnelMetrics } from '../services/analytics';
import { formatDateTimeJST } from '../utils/datetime';
import { hashSessionToken, verifySessionToken } from '../middleware/security';

const dashboard = new Hono<{ Bindings: Env }>();

// --- Layout ---
const Layout: FC<{ title: string; children: unknown }> = ({ title, children }) => (
  <html lang="ja">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title} - LINE Attend Agent</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50 min-h-screen">
      <nav class="bg-indigo-600 text-white px-6 py-3 flex items-center justify-between">
        <a href="/admin/" class="text-lg font-bold">LINE Attend Agent</a>
        <div class="flex gap-4 items-center">
          <a href="/admin/" class="hover:underline">ダッシュボード</a>
          <a href="/admin/system" class="hover:underline">システム状態</a>
          <form method="post" action="/admin/logout" class="inline">
            <button type="submit" class="hover:underline">ログアウト</button>
          </form>
        </div>
      </nav>
      <main class="max-w-6xl mx-auto p-6">{children}</main>
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

  const metrics = await getAllFunnelMetrics(c.env);

  return c.html(
    <Layout title="ダッシュボード">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">テナント一覧</h1>
        <a href="/admin/tenants/new" class="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700">
          + 新規テナント
        </a>
      </div>

      {/* Overview metrics */}
      {metrics.length > 0 && (
        <div class="grid grid-cols-4 gap-4 mb-6">
          <div class="bg-white p-4 rounded shadow">
            <p class="text-sm text-gray-500">総ユーザー数</p>
            <p class="text-2xl font-bold">{metrics.reduce((s, m) => s + (m.total_users || 0), 0)}</p>
          </div>
          <div class="bg-white p-4 rounded shadow">
            <p class="text-sm text-gray-500">予約済み</p>
            <p class="text-2xl font-bold">{metrics.reduce((s, m) => s + (m.booked_users || 0), 0)}</p>
          </div>
          <div class="bg-white p-4 rounded shadow">
            <p class="text-sm text-gray-500">相談済み</p>
            <p class="text-2xl font-bold">{metrics.reduce((s, m) => s + (m.consulted_users || 0), 0)}</p>
          </div>
          <div class="bg-white p-4 rounded shadow">
            <p class="text-sm text-gray-500">入会済み</p>
            <p class="text-2xl font-bold">{metrics.reduce((s, m) => s + (m.enrolled_users || 0), 0)}</p>
          </div>
        </div>
      )}

      {/* Tenant list */}
      <div class="bg-white rounded shadow overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">名前</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ステータス</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ユーザー数</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">着座率</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">操作</th>
            </tr>
          </thead>
          <tbody>
            {(tenants || []).map((t) => {
              const m = metrics.find((m) => m.tenant_id === t.id);
              return (
                <tr class="border-t hover:bg-gray-50">
                  <td class="px-4 py-3 font-medium">{t.name}</td>
                  <td class="px-4 py-3">
                    <span class={`px-2 py-1 rounded text-xs ${t.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {t.is_active ? '有効' : '無効'}
                    </span>
                  </td>
                  <td class="px-4 py-3">{m?.total_users ?? 0}</td>
                  <td class="px-4 py-3">{m?.attendance_rate != null ? `${m.attendance_rate}%` : '-'}</td>
                  <td class="px-4 py-3 space-x-2">
                    <a href={`/admin/tenants/${t.id}`} class="text-indigo-600 hover:underline text-sm">詳細</a>
                    <a href={`/admin/tenants/${t.id}/users`} class="text-indigo-600 hover:underline text-sm">ユーザー</a>
                    <a href={`/admin/tenants/${t.id}/bookings`} class="text-indigo-600 hover:underline text-sm">予約</a>
                    <a href={`/admin/tenants/${t.id}/analytics`} class="text-indigo-600 hover:underline text-sm">分析</a>
                    <a href={`/admin/tenants/${t.id}/slots`} class="text-indigo-600 hover:underline text-sm">予約枠</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(!tenants || tenants.length === 0) && (
          <p class="p-4 text-gray-500 text-center">テナントがまだありません</p>
        )}
      </div>
    </Layout>
  );
});

// --- Create Tenant Form ---
dashboard.get('/admin/tenants/new', (c) => {
  return c.html(
    <Layout title="テナント作成">
      <h1 class="text-2xl font-bold mb-6">新規テナント作成</h1>
      <form method="post" action="/admin/tenants/new" class="bg-white p-6 rounded shadow max-w-2xl space-y-4">
        <div>
          <label class="block text-sm font-medium mb-1">スクール名 *</label>
          <input type="text" name="name" required class="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">LINE Channel ID *</label>
          <input type="text" name="line_channel_id" required class="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">LINE Channel Secret *</label>
          <input type="text" name="line_channel_secret" required class="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">LINE Channel Access Token *</label>
          <textarea name="line_channel_access_token" required rows={2} class="w-full border rounded px-3 py-2"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">スクール情報（AIへのコンテキスト）</label>
          <textarea name="school_context" rows={3} class="w-full border rounded px-3 py-2" placeholder="スクールの特徴、コース内容など"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">シナリオ設定 (JSON)</label>
          <textarea name="scenario_config" rows={6} class="w-full border rounded px-3 py-2 font-mono text-sm" placeholder='{"steps": []}'></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">ヒアリング設定 (JSON)</label>
          <textarea name="hearing_config" rows={4} class="w-full border rounded px-3 py-2 font-mono text-sm" placeholder='{"items": []}'></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">リマインダー設定 (JSON)</label>
          <textarea name="reminder_config" rows={4} class="w-full border rounded px-3 py-2 font-mono text-sm" placeholder="{}"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">トーン設定 (JSON)</label>
          <textarea name="tone_config" rows={3} class="w-full border rounded px-3 py-2 font-mono text-sm" placeholder="{}"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">ガードレール設定 (JSON)</label>
          <textarea name="guardrail_config" rows={3} class="w-full border rounded px-3 py-2 font-mono text-sm" placeholder="{}"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">通知設定 (JSON)</label>
          <textarea name="notification_config" rows={3} class="w-full border rounded px-3 py-2 font-mono text-sm" placeholder="{}"></textarea>
        </div>
        <button type="submit" class="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700">作成</button>
      </form>
    </Layout>
  );
});

dashboard.post('/admin/tenants/new', async (c) => {
  const body = await c.req.parseBody();
  const payload = {
    name: body['name'],
    line_channel_id: body['line_channel_id'],
    line_channel_secret: body['line_channel_secret'],
    line_channel_access_token: body['line_channel_access_token'],
    school_context: body['school_context'] || '',
    scenario_config: safeParseJSON(body['scenario_config'] as string, {}),
    hearing_config: safeParseJSON(body['hearing_config'] as string, {}),
    reminder_config: safeParseJSON(body['reminder_config'] as string, {}),
    tone_config: safeParseJSON(body['tone_config'] as string, {}),
    guardrail_config: safeParseJSON(body['guardrail_config'] as string, {}),
    notification_config: safeParseJSON(body['notification_config'] as string, {}),
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
        <div>
          <label class="block text-sm font-medium mb-1">シナリオ設定 (JSON)</label>
          <textarea name="scenario_config" rows={8} class="w-full border rounded px-3 py-2 font-mono text-sm">{JSON.stringify(tenant.scenario_config, null, 2)}</textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">ヒアリング設定 (JSON)</label>
          <textarea name="hearing_config" rows={6} class="w-full border rounded px-3 py-2 font-mono text-sm">{JSON.stringify(tenant.hearing_config, null, 2)}</textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">リマインダー設定 (JSON)</label>
          <textarea name="reminder_config" rows={6} class="w-full border rounded px-3 py-2 font-mono text-sm">{JSON.stringify(tenant.reminder_config, null, 2)}</textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">トーン設定 (JSON)</label>
          <textarea name="tone_config" rows={4} class="w-full border rounded px-3 py-2 font-mono text-sm">{JSON.stringify(tenant.tone_config, null, 2)}</textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">ガードレール設定 (JSON)</label>
          <textarea name="guardrail_config" rows={4} class="w-full border rounded px-3 py-2 font-mono text-sm">{JSON.stringify(tenant.guardrail_config, null, 2)}</textarea>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">通知設定 (JSON)</label>
          <textarea name="notification_config" rows={4} class="w-full border rounded px-3 py-2 font-mono text-sm">{JSON.stringify(tenant.notification_config, null, 2)}</textarea>
        </div>
        <div class="flex gap-2 items-center">
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
  const body = await c.req.parseBody();
  const payload = {
    name: body['name'],
    line_channel_id: body['line_channel_id'],
    line_channel_secret: body['line_channel_secret'],
    line_channel_access_token: body['line_channel_access_token'],
    school_context: body['school_context'] || '',
    scenario_config: safeParseJSON(body['scenario_config'] as string, {}),
    hearing_config: safeParseJSON(body['hearing_config'] as string, {}),
    reminder_config: safeParseJSON(body['reminder_config'] as string, {}),
    tone_config: safeParseJSON(body['tone_config'] as string, {}),
    guardrail_config: safeParseJSON(body['guardrail_config'] as string, {}),
    notification_config: safeParseJSON(body['notification_config'] as string, {}),
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

  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', id).single();
  const { data: users } = await supabase
    .from('end_users')
    .select('*')
    .eq('tenant_id', id)
    .order('updated_at', { ascending: false })
    .limit(100);

  return c.html(
    <Layout title="ユーザー一覧">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{tenant?.name} - ユーザー一覧</h1>
        <a href={`/admin/tenants/${id}`} class="text-indigo-600 hover:underline text-sm">テナント詳細に戻る</a>
      </div>
      <div class="bg-white rounded shadow overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">名前</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ステータス</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">ステップ</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">追客回数</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">最終返信</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-500">操作</th>
            </tr>
          </thead>
          <tbody>
            {(users || []).map((u) => (
              <tr class="border-t hover:bg-gray-50">
                <td class="px-4 py-3">{u.display_name || '(名前なし)'}</td>
                <td class="px-4 py-3">
                  <span class={`px-2 py-1 rounded text-xs ${statusColor(u.status)}`}>{u.status}</span>
                </td>
                <td class="px-4 py-3 text-sm text-gray-600">{u.current_step}</td>
                <td class="px-4 py-3">{u.follow_up_count}</td>
                <td class="px-4 py-3 text-sm text-gray-600">
                  {u.last_response_at ? formatDateTimeJST(u.last_response_at) : '-'}
                </td>
                <td class="px-4 py-3">
                  <a href={`/admin/tenants/${id}/users/${u.id}`} class="text-indigo-600 hover:underline text-sm">会話</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!users || users.length === 0) && (
          <p class="p-4 text-gray-500 text-center">ユーザーがまだいません</p>
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

  const { data: user } = await supabase.from('end_users').select('*').eq('id', userId).single();
  const { data: conversations } = await supabase
    .from('conversations')
    .select('*')
    .eq('end_user_id', userId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (!user) return c.html(<Layout title="Not Found"><p>ユーザーが見つかりません</p></Layout>);

  return c.html(
    <Layout title={user.display_name || 'ユーザー詳細'}>
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{user.display_name || '(名前なし)'}</h1>
        <a href={`/admin/tenants/${tenantId}/users`} class="text-indigo-600 hover:underline text-sm">一覧に戻る</a>
      </div>

      {/* User info */}
      <div class="bg-white p-4 rounded shadow mb-6 grid grid-cols-3 gap-4">
        <div>
          <span class="text-sm text-gray-500">ステータス</span>
          <p class="font-medium">{user.status}</p>
          <form method="post" action={`/admin/tenants/${tenantId}/users/${userId}/status`} class="mt-1 flex gap-1">
            <select name="status" class="text-xs border rounded px-1 py-0.5">
              {['active', 'booked', 'consulted', 'enrolled', 'dropped', 'stalled'].map((s) => (
                <option value={s} selected={s === user.status}>{s}</option>
              ))}
            </select>
            <button type="submit" class="text-xs bg-gray-100 px-2 py-0.5 rounded hover:bg-gray-200">変更</button>
          </form>
        </div>
        <div><span class="text-sm text-gray-500">ステップ</span><p class="font-medium">{user.current_step}</p></div>
        <div><span class="text-sm text-gray-500">追客回数</span><p class="font-medium">{user.follow_up_count}</p></div>
        <div class="col-span-3">
          <span class="text-sm text-gray-500">ヒアリングデータ</span>
          <pre class="text-sm bg-gray-50 p-2 rounded mt-1">{JSON.stringify(user.hearing_data, null, 2)}</pre>
        </div>
        {user.insight_summary && (
          <div class="col-span-3">
            <span class="text-sm text-gray-500">インサイト</span>
            <p class="text-sm mt-1">{user.insight_summary}</p>
          </div>
        )}
      </div>

      {/* Conversation thread */}
      <h2 class="text-lg font-bold mb-3">会話ログ</h2>
      <div class="space-y-2 max-h-[600px] overflow-y-auto bg-gray-100 p-4 rounded">
        {(conversations || []).map((msg) => (
          <div class={`flex ${msg.role === 'user' ? 'justify-start' : 'justify-end'}`}>
            <div class={`max-w-[70%] px-4 py-2 rounded-lg text-sm ${
              msg.role === 'user' ? 'bg-white border' : 'bg-indigo-100 text-indigo-900'
            }`}>
              <p class="whitespace-pre-wrap">{msg.content}</p>
              <p class="text-xs text-gray-400 mt-1">{formatDateTimeJST(msg.created_at)}</p>
            </div>
          </div>
        ))}
        {(!conversations || conversations.length === 0) && (
          <p class="text-gray-500 text-center">会話がまだありません</p>
        )}
      </div>
    </Layout>
  );
});

// --- Analytics ---
dashboard.get('/admin/tenants/:id/analytics', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', id).single();
  const metrics = await getFunnelMetrics(id, c.env);

  return c.html(
    <Layout title="分析">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">{tenant?.name} - ファネル分析</h1>
        <a href={`/admin/tenants/${id}`} class="text-indigo-600 hover:underline text-sm">テナント詳細に戻る</a>
      </div>

      {metrics ? (
        <div>
          <div class="grid grid-cols-5 gap-4 mb-8">
            <MetricCard label="総ユーザー" value={metrics.total_users} />
            <MetricCard label="予約済み" value={metrics.booked_users} />
            <MetricCard label="相談済み" value={metrics.consulted_users} />
            <MetricCard label="入会済み" value={metrics.enrolled_users} />
            <MetricCard label="着座率" value={metrics.attendance_rate != null ? `${metrics.attendance_rate}%` : '-'} highlight />
          </div>

          {/* Funnel bar chart */}
          <div class="bg-white p-6 rounded shadow">
            <h2 class="text-lg font-bold mb-4">ファネル</h2>
            <div class="space-y-3">
              <FunnelBar label="友だち追加" value={metrics.total_users} max={metrics.total_users} color="bg-blue-500" />
              <FunnelBar label="予約" value={metrics.booked_users} max={metrics.total_users} color="bg-yellow-500" />
              <FunnelBar label="相談実施" value={metrics.consulted_users} max={metrics.total_users} color="bg-green-500" />
              <FunnelBar label="入会" value={metrics.enrolled_users} max={metrics.total_users} color="bg-indigo-500" />
            </div>
          </div>
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

// --- Utilities ---
function safeParseJSON(str: string | undefined, fallback: unknown): unknown {
  if (!str || str.trim() === '') return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
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
