// Herramientas del agente de pedidos. Todas reciben el cliente de PedidAI del usuario (su token),
// así que solo operan sobre los datos de su empresa. El agente NO puede enviar pedidos:
// los deja pendientes y el usuario los envía con un clic desde la aplicación.

/** Fecha en el formato que espera el filtro de pedidos de PedidAI (yyyy-MM-dd HH:mm:ss). */
function pedidaiDate(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export async function search_suppliers(client, { query = '' } = {}) {
  const suppliers = await client.getSuppliers({ searchText: query });
  return suppliers.filter(s => s.isActive).map(s => ({ uuid: s.uuid, name: s.name, has_email: !!s.email }));
}

export async function get_supplier_products(client, { supplier_uuid } = {}) {
  const products = await client.getProducts({ supplierUuid: supplier_uuid });
  return products.filter(p => p.isActive).map(p => ({
    uuid: p.uuid, name: p.name, generic_name: p.canonicalName, price: p.price, unit: p.unit,
  }));
}

/** Precio vigente del producto en cada proveedor (según los últimos albaranes), del más barato al más caro. */
export async function compare_prices(client, { product_name } = {}) {
  const groups = await client.comparePrices(product_name);
  return groups.slice(0, 5).map(g => ({
    product: g.name,
    unit: g.unit,
    offers: g.offers.map(o => ({
      supplier: o.supplierName,
      supplier_uuid: o.supplierUuid,
      supplier_has_email: o.supplierHasEmail,
      product_uuid: o.productUuid,
      product_name: o.productName,
      price: o.latestPrice,
      price_date: o.latestDate,
      cheapest: o.cheapest,
    })),
  }));
}

export async function check_duplicate_order(client, { supplier_uuid, hours_window = 24 } = {}) {
  const since = pedidaiDate(new Date(Date.now() - hours_window * 3600 * 1000));
  const orders = await client.getOrders({ supplierUuid: supplier_uuid, createdAfter: since, status: 'PENDING' });
  return {
    has_pending_order: orders.length > 0,
    pending_orders: orders.map(o => ({ uuid: o.uuid, name: o.name, total: o.totalAmount, created_at: o.createdAt })),
  };
}

export async function create_order(client, { supplier_uuid, name, items, notes = '' } = {}) {
  const order = await client.createOrder({
    supplierUuid: supplier_uuid,
    name: name || 'Pedido',
    items: (items || []).map(i => ({ productUuid: i.productUuid, quantity: i.quantity })),
    notes,
  });
  return {
    uuid: order.uuid,
    name: order.name,
    status: order.status,
    supplier_name: order.supplierName,
    total: order.totalAmount,
    items: order.items.map(i => ({ product: i.productName, quantity: i.quantity, unit_price: i.unitPrice, subtotal: i.subtotal })),
  };
}

/**
 * Sugerencias de reposición (sin IA): productos pedidos con frecuencia, con el proveedor
 * más barato según el historial de precios.
 */
export async function suggest_orders(client, { min_order_count = 2 } = {}) {
  const consumption = await client.consumptionAnalysis(180);
  const candidates = (consumption.topProducts || []).filter(c => c.orderCount >= min_order_count).slice(0, 15);

  const since = pedidaiDate(new Date(Date.now() - 48 * 3600 * 1000));
  const recentlyOrdered = new Set();
  try {
    for (const o of await client.getOrders({ createdAfter: since, size: 200 })) {
      for (const item of o.items || []) if (item.productName) recentlyOrdered.add(item.productName.toLowerCase());
    }
  } catch { /* sin pedidos recientes */ }

  const suggestions = [];
  for (const c of candidates) {
    let cheapest = null;
    try {
      const groups = await client.comparePrices(c.productName);
      cheapest = groups[0]?.offers?.[0] ?? null;
    } catch { /* sin comparativa */ }

    const current = c.currentPrice ?? cheapest?.latestPrice ?? null;
    const isRecent = recentlyOrdered.has(c.productName.toLowerCase());
    const urgency = isRecent ? 'low' : c.orderCount >= 5 ? 'high' : c.orderCount >= 3 ? 'medium' : 'low';
    const savings = cheapest && current && cheapest.latestPrice < current
      ? Math.round(((current - cheapest.latestPrice) / current) * 100) : 0;

    suggestions.push({
      urgency,
      ...(isRecent && { recentlyOrdered: true }),
      product: c.productName,
      product_uuid: cheapest?.productUuid || c.productUuid,
      supplier: cheapest?.supplierName || c.supplierName || null,
      supplier_uuid: cheapest?.supplierUuid || null,
      quantity: c.avgQuantityPerOrder,
      unit: cheapest?.unit || c.unit,
      estimated_savings_percent: savings,
      price: cheapest?.latestPrice || current,
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return suggestions.sort((a, b) => rank[a.urgency] - rank[b.urgency]);
}

export const CHAT_TOOLS = { search_suppliers, get_supplier_products, compare_prices, check_duplicate_order, create_order };

export const CHAT_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'compare_prices',
      description: 'Devuelve los proveedores del usuario que tienen un producto y su precio vigente según los últimos albaranes, del más barato al más caro. Busca por nombre genérico en castellano y singular (ej: "tomate", "agua mineral").',
      parameters: {
        type: 'object',
        properties: { product_name: { type: 'string', description: 'Nombre genérico del producto en castellano' } },
        required: ['product_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_suppliers',
      description: 'Busca proveedores del usuario por nombre. Úsalo solo si el usuario menciona un proveedor concreto.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_supplier_products',
      description: 'Lista los productos de un proveedor con su precio y unidad.',
      parameters: {
        type: 'object',
        properties: { supplier_uuid: { type: 'string' } },
        required: ['supplier_uuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_duplicate_order',
      description: 'Indica si ya hay un pedido PENDIENTE reciente a ese proveedor.',
      parameters: {
        type: 'object',
        properties: { supplier_uuid: { type: 'string' }, hours_window: { type: 'number', default: 24 } },
        required: ['supplier_uuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: 'Crea un pedido PENDIENTE (no se envía) a un proveedor. Todos los productos deben ser de ese proveedor.',
      parameters: {
        type: 'object',
        properties: {
          supplier_uuid: { type: 'string' },
          name: { type: 'string', description: 'Nombre corto del pedido, en el idioma del usuario' },
          notes: { type: 'string', description: 'Notas para el proveedor, solo si el usuario las pide' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                productUuid: { type: 'string' },
                quantity: { type: 'number' },
              },
              required: ['productUuid', 'quantity'],
            },
          },
        },
        required: ['supplier_uuid', 'items'],
      },
    },
  },
];
