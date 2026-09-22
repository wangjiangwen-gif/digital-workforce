import test from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { Workforce } from '../src/workforce/domain.ts';
import { createWeb, saveAccessToken } from '../src/workforce/web.ts';
const admin = { id: 'admin', role: 'admin' } as const;
test('HTTP后端认证、草稿发布和越权检查真实生效，不接受跨站写入', async () => {
  const w = new Workforce(':memory:');
  saveAccessToken(w, admin, 'a'.repeat(48));
  saveAccessToken(w, { id: 'reader', role: 'viewer' }, 'v'.repeat(48));
  const { server, url } = await createWeb(w, { port: 0 });
  const api = (path: string, method = 'GET', body?: unknown, token = 'a'.repeat(48), origin?: string) =>
    fetch(url + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await fetch(url + '/api/state')).status, 401);
    assert.equal((await api('/api/access', 'POST', { id: 'new-reader', role: 'viewer' })).status, 404);
    assert.equal((await api('/api/employees', 'POST', { name: '越权' }, 'v'.repeat(48))).status, 403);
    assert.equal(
      (await api('/api/employees', 'POST', { name: '跨站' }, 'a'.repeat(48), 'https://evil.test')).status,
      403,
    );
    const response = await api('/api/employees', 'POST', { name: '策划助理' });
    assert.equal(response.status, 201);
    const e = await response.json();
    assert.equal((await api(`/api/employees/${e.id}/publish`, 'POST', { revision: 1 })).status, 200);
    const state = await (await api('/api/state')).json();
    assert.equal(state.employees[0].name, '策划助理');
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(48) }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    w.close();
  }
});

test('显式 HTTPS 域名支持同源代理请求，拒绝伪造域名、来源和转发头', async () => {
  const w = new Workforce(':memory:');
  const { server, url } = await createWeb(w, { port: 0, publicOrigin: 'https://workspace.example.test' });
  try {
    for (const [headers, status] of [
      [{ Host: 'workspace.example.test', Origin: 'https://workspace.example.test' }, 200],
      [{ Host: 'workspace.example.test', Origin: 'https://evil.test' }, 403],
      [{ Host: 'evil.test', 'X-Forwarded-Host': 'workspace.example.test' }, 403],
      [{ Host: 'workspace.example.test', Origin: 'http://workspace.example.test' }, 403],
    ] as const)
      assert.equal(
        await new Promise<number>((resolve, reject) => {
          const req = httpRequest(url + '/', { headers }, (res) => {
            res.resume();
            resolve(res.statusCode!);
          });
          req.on('error', reject);
          req.end();
        }),
        status,
      );
    assert.equal((await fetch(url + '/')).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    w.close();
  }
});

for (const publicOrigin of [
  'http://workspace.example.test',
  'https://user:pass@workspace.example.test',
  'https://workspace.example.test/path',
  'https://workspace.example.test?token=x',
])
  test(`拒绝无效公网 Origin ${publicOrigin}`, async () => {
    const w = new Workforce(':memory:');
    try {
      await assert.rejects(createWeb(w, { port: 0, publicOrigin }), /HTTPS Origin/);
    } finally {
      w.close();
    }
  });
