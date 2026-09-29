import 'dotenv/config';

const BASE_URL = process.env.PEDIDAI_API_URL;

/**
 * Cliente de la API de PedidAI que actúa en nombre del usuario que hace la petición:
 * reutiliza su token, así que solo puede ver y tocar los datos de su propia empresa.
 */
export function createClient(token, lang = 'es') {
  async function request(method, path, body) {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Accept-Language': lang,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const r = await fetch(`${BASE_URL}${path}`, opts);
    if (!r.ok) {
      let message = `PedidAI ${method} ${path} → ${r.status}`;
      try { message = (await r.json()).message || message; } catch { /* sin cuerpo JSON */ }
      const err = new Error(message);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  return {
    request,

    async getMe() {
      return (await request('GET', '/users/me')).data;
    },

    async getSuppliers({ searchText = '', page = 0, size = 100 } = {}) {
      const path = searchText
        ? `/suppliers/search?searchText=${encodeURIComponent(searchText)}&page=${page}&size=${size}`
        : `/suppliers?page=${page}&size=${size}`;
      return (await request('GET', path)).data.content;
    },

    async getProducts({ supplierUuid, name, page = 0, size = 200 } = {}) {
      const params = new URLSearchParams({ page, size });
      if (supplierUuid) params.set('supplierUuid', supplierUuid);
      if (name) params.set('name', name);
      return (await request('GET', `/products/filter?${params}`)).data.content;
    },

    async getOrders({ supplierUuid, status, createdAfter, page = 0, size = 100 } = {}) {
      const params = new URLSearchParams({ page, size });
      if (supplierUuid) params.set('supplierUuid', supplierUuid);
      if (status) params.set('status', status);
      if (createdAfter) params.set('createdAtFrom', createdAfter);
      return (await request('GET', `/orders/filter?${params}`)).data.content;
    },

    async createOrder({ supplierUuid, name, items, notes = '' }) {
      return (await request('POST', '/orders/create', { supplierUuid, name, items, notes })).data;
    },

    async comparePrices(productName, days = 365) {
      return (await request('GET', `/products/compare-prices?productName=${encodeURIComponent(productName)}&days=${days}`)).data;
    },

    async consumptionAnalysis(days = 180) {
      return (await request('GET', `/orders/consumption-analysis?days=${days}`)).data;
    },
  };
}
