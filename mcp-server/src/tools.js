import {
  getSuppliers, getProducts, getOrders,
  createOrder, sendOrder, getDashboard, request,
} from './pedidoo-client.js';

// ─── search_suppliers ─────────────────────────────────────────────────────────
export async function search_suppliers({ query = '', category, active_only = true } = {}) {
  const suppliers = await getSuppliers({ searchText: query });
  let results = active_only ? suppliers.filter(s => s.isActive) : suppliers;
  if (category) results = results.filter(s => s.notes?.toLowerCase().includes(category.toLowerCase()));
  return results.map(s => ({
    uuid: s.uuid,
    name: s.name,
    contactName: s.contactName,
    email: s.email,
    phone: s.phone,
  }));
}

// ─── get_supplier_products ────────────────────────────────────────────────────
export async function get_supplier_products({ supplier_uuid, active_only = true } = {}) {
  const products = await getProducts({ supplierUuid: supplier_uuid });
  let results = active_only ? products.filter(p => p.isActive) : products;
  return results.map(p => ({
    uuid: p.uuid,
    name: p.name,
    price: p.price,
    unit: p.unit,
    category: p.category,
    description: p.description,
  }));
}

// ─── create_order ─────────────────────────────────────────────────────────────
export async function create_order({ supplier_uuid, name, items, notes = '' } = {}) {
  // items: [{productUuid, productName, quantity}]
  const orderItems = items.map(i => ({
    productUuid: i.productUuid,
    quantity: i.quantity,
  }));
  const order = await createOrder({
    supplierUuid: supplier_uuid,
    name: name || 'Pedido automático',
    items: orderItems,
    notes,
  });
  return {
    uuid: order.uuid,
    name: order.name,
    status: order.status,
    totalAmount: order.totalAmount,
    items: order.items,
  };
}

// ─── send_order ───────────────────────────────────────────────────────────────
export async function send_order({ order_uuid } = {}) {
  const result = await sendOrder(order_uuid);
  return { success: true, order_uuid, result };
}

// ─── check_duplicate_order ────────────────────────────────────────────────────
export async function check_duplicate_order({ supplier_uuid, source_ref, hours_window = 24 } = {}) {
  const since = new Date(Date.now() - hours_window * 3600 * 1000).toISOString();
  const orders = await getOrders({ supplierUuid: supplier_uuid, createdAfter: since });
  const active = orders.filter(o => !['CANCELLED', 'ERROR'].includes(o.status));

  // Check by source_ref in order name if provided
  const matching = source_ref
    ? active.filter(o => o.name?.includes(source_ref))
    : active;

  return {
    is_duplicate: matching.length > 0,
    existing_orders: matching.map(o => ({
      uuid: o.uuid,
      name: o.name,
      status: o.status,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
    })),
  };
}

// ─── get_order_summary ────────────────────────────────────────────────────────
export async function get_order_summary({ days = 7, status } = {}) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const orders = await getOrders({ status, createdAfter: since, size: 500 });
  const dashboard = await getDashboard();

  const byStatus = {};
  const bySupplier = {};
  let totalAmount = 0;

  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    bySupplier[o.supplierUuid] = (bySupplier[o.supplierUuid] || 0) + 1;
    totalAmount += o.totalAmount || 0;
  }

  return {
    total_orders: orders.length,
    total_amount: Math.round(totalAmount * 100) / 100,
    by_status: byStatus,
    by_supplier_count: Object.keys(bySupplier).length,
    dashboard: {
      totalOrders: dashboard.totalComandes,
      totalExpense: dashboard.despesaComandes,
      pendingOrders: dashboard.comandesPendents,
    },
  };
}

// ─── analyze_consumption ──────────────────────────────────────────────────────
export async function analyze_consumption({ days = 90 } = {}) {
  const r = await request('GET', `/orders/consumption-analysis?days=${days}`);
  return r.data;
}

// ─── compare_prices ───────────────────────────────────────────────────────────
export async function compare_prices({ product_name, days = 90 } = {}) {
  const r = await request('GET', `/products/compare-prices?productName=${encodeURIComponent(product_name)}&days=${days}`);
  return r.data;
}

// ─── suggest_orders ───────────────────────────────────────────────────────────
export async function suggest_orders({ min_order_count = 2 } = {}) {
  const consumption = await analyze_consumption({ days: 180 });
  const candidates = (consumption.topProducts || []).filter(
    c => c.orderCount >= min_order_count
  );

  // Pedidos activos de las últimas 48h: descuenta del déficit de urgencia
  const cutoff48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const recentlyOrderedProducts = new Set();
  try {
    const recentOrders = await getOrders({ createdAfter: cutoff48h, size: 200 });
    for (const o of recentOrders) {
      if (['CANCELLED', 'DELETED'].includes(o.status)) continue;
      for (const item of (o.items || [])) {
        if (item.productName) recentlyOrderedProducts.add(item.productName.toLowerCase());
      }
    }
  } catch (_) {}

  const suggestions = [];
  for (const c of candidates) {
    let alternatives = [];
    try {
      alternatives = await compare_prices({ product_name: c.productName });
    } catch (_) {}

    const cheapest = alternatives[0] || null;
    const currentPrice = c.currentPrice ?? (cheapest?.currentPrice ?? null);

    const isRecentlyOrdered = recentlyOrderedProducts.has(c.productName.toLowerCase());

    let urgency = 'low';
    if (!isRecentlyOrdered) {
      if (c.orderCount >= 5) urgency = 'high';
      else if (c.orderCount >= 3) urgency = 'medium';
    }

    const savings = (cheapest && currentPrice && cheapest.currentPrice < currentPrice)
      ? Math.round(((currentPrice - cheapest.currentPrice) / currentPrice) * 100)
      : 0;

    suggestions.push({
      urgency,
      ...(isRecentlyOrdered && { recentlyOrdered: true }),
      product: c.productName,
      product_uuid: cheapest?.productUuid || c.productUuid,
      supplier: cheapest?.supplierName || null,
      supplier_uuid: cheapest?.supplierUuid || null,
      quantity: c.avgQuantityPerOrder,
      unit: cheapest?.unit || c.unit,
      estimated_savings_percent: savings,
      price: cheapest?.currentPrice || currentPrice,
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return suggestions.sort((a, b) => order[a.urgency] - order[b.urgency]);
}

// ─── TOOL_SCHEMAS ─────────────────────────────────────────────────────────────
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search_suppliers',
      description: 'Busca proveedores de Pedidoo por nombre o texto libre',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string',  description: 'Texto a buscar en el nombre del proveedor' },
          active_only: { type: 'boolean', description: 'Solo proveedores activos', default: true },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_supplier_products',
      description: 'Lista los productos activos de un proveedor con precio y unidad',
      parameters: {
        type: 'object',
        properties: {
          supplier_uuid: { type: 'string',  description: 'UUID del proveedor' },
          active_only:   { type: 'boolean', description: 'Solo productos activos', default: true },
        },
        required: ['supplier_uuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: 'Crea un nuevo pedido en Pedidoo con sus líneas de detalle',
      parameters: {
        type: 'object',
        properties: {
          supplier_uuid: { type: 'string', description: 'UUID del proveedor' },
          name:          { type: 'string', description: 'Nombre del pedido (ej: "Pedido semanal frutas")' },
          notes:         { type: 'string', description: 'Notas opcionales para el proveedor' },
          items: {
            type: 'array',
            description: 'Líneas del pedido',
            items: {
              type: 'object',
              properties: {
                productUuid: { type: 'string', description: 'UUID del producto en Pedidoo' },
                quantity:    { type: 'number', description: 'Cantidad a pedir' },
              },
              required: ['productUuid', 'quantity'],
            },
          },
        },
        required: ['supplier_uuid', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_order',
      description: 'Envía un pedido al proveedor (Pedidoo manda el email automáticamente)',
      parameters: {
        type: 'object',
        properties: {
          order_uuid: { type: 'string', description: 'UUID del pedido a enviar' },
        },
        required: ['order_uuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_duplicate_order',
      description: 'Comprueba si existe un pedido reciente al mismo proveedor',
      parameters: {
        type: 'object',
        properties: {
          supplier_uuid: { type: 'string', description: 'UUID del proveedor' },
          source_ref:    { type: 'string', description: 'Referencia externa a comparar' },
          hours_window:  { type: 'number', description: 'Ventana de horas a comprobar (default 24)', default: 24 },
        },
        required: ['supplier_uuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_summary',
      description: 'Resumen de pedidos recientes y métricas del dashboard',
      parameters: {
        type: 'object',
        properties: {
          days:   { type: 'number', description: 'Días hacia atrás (default 7)', default: 7 },
          status: { type: 'string', enum: ['PENDING', 'SENT', 'COMPLETED', 'CANCELLED'], description: 'Filtrar por estado' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_consumption',
      description: 'Analiza el consumo de los últimos N días: qué se pide, con qué frecuencia y en qué cantidad',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Días hacia atrás a analizar (default 90)', default: 90 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_prices',
      description: 'Compara precios del mismo producto entre todos los proveedores disponibles',
      parameters: {
        type: 'object',
        properties: {
          product_name: { type: 'string', description: 'Nombre del producto a comparar' },
        },
        required: ['product_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_orders',
      description: 'Genera sugerencias de pedidos basadas en el consumo histórico y comparativa de precios',
      parameters: {
        type: 'object',
        properties: {
          min_order_count: { type: 'number', description: 'Mínimo de pedidos previos para sugerir (default 2)', default: 2 },
        },
      },
    },
  },
];
