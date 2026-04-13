import 'dotenv/config';

const BASE_URL = process.env.PEDIDOO_API_URL;
const EMAIL    = process.env.PEDIDOO_EMAIL;
const PASSWORD = process.env.PEDIDOO_PASSWORD;

let _token = null;
let _tokenExp = 0;

async function login() {
  const r = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`Abasta login failed: ${r.status}`);
  const d = await r.json();
  _token = d.data.token;
  // JWT exp is 1h, refresh at 50min
  _tokenExp = Date.now() + 50 * 60 * 1000;
  return _token;
}

async function getToken() {
  if (!_token || Date.now() >= _tokenExp) await login();
  return _token;
}

export async function request(method, path, body) {
  const token = await getToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let r = await fetch(`${BASE_URL}${path}`, opts);

  if (r.status === 401) {
    // Re-login and retry once
    await login();
    opts.headers['Authorization'] = `Bearer ${_token}`;
    r = await fetch(`${BASE_URL}${path}`, opts);
  }

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Abasta ${method} ${path} → ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

export async function healthCheck() {
  const r = await request('GET', '/reports/dashboard');
  return r.data;
}

export async function getSuppliers({ searchText = '', page = 0, size = 100 } = {}) {
  if (searchText) {
    const r = await request('GET', `/suppliers/search?searchText=${encodeURIComponent(searchText)}&page=${page}&size=${size}`);
    return r.data.content;
  }
  const r = await request('GET', `/suppliers?page=${page}&size=${size}`);
  return r.data.content;
}

export async function getProducts({ supplierUuid, name, page = 0, size = 100 } = {}) {
  const params = new URLSearchParams({ page, size });
  if (supplierUuid) params.set('supplierUuid', supplierUuid);
  if (name) params.set('name', name);
  const r = await request('GET', `/products/filter?${params}`);
  return r.data.content;
}

export async function getAllProducts({ page = 0, size = 200 } = {}) {
  const r = await request('GET', `/products?page=${page}&size=${size}`);
  return r.data.content;
}

export async function getOrders({ supplierUuid, status, createdAfter, page = 0, size = 100 } = {}) {
  const params = new URLSearchParams({ page, size });
  if (supplierUuid) params.set('supplierUuid', supplierUuid);
  if (status) params.set('status', status);
  if (createdAfter) params.set('createdAfter', createdAfter);
  const r = await request('GET', `/orders/filter?${params}`);
  return r.data.content;
}

export async function createOrder({ supplierUuid, name, items, notes = '' }) {
  const r = await request('POST', '/orders/create', { supplierUuid, name, items, notes });
  return r.data;
}

export async function sendOrder(uuid) {
  const r = await request('POST', `/orders/${uuid}/send`);
  return r.data;
}

export async function getDashboard() {
  const r = await request('GET', '/reports/dashboard');
  return r.data;
}
