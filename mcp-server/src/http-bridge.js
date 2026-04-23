import 'dotenv/config';
import express from 'express';
import { healthCheck } from './pedidai-client.js';
import {
  TOOL_SCHEMAS,
  search_suppliers, get_supplier_products, create_order, send_order,
  check_duplicate_order, get_order_summary, analyze_consumption,
  compare_prices, suggest_orders,
} from './tools.js';

const app = express();
app.use(express.json());

const HANDLERS = {
  search_suppliers,
  get_supplier_products,
  create_order,
  send_order,
  check_duplicate_order,
  get_order_summary,
  analyze_consumption,
  compare_prices,
  suggest_orders,
};

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const data = await healthCheck();
    res.json({ status: 'ok', pedidai: 'connected', tools: Object.keys(HANDLERS).length, dashboard: data });
  } catch (err) {
    res.status(503).json({ status: 'error', pedidai: err.message });
  }
});

// ─── Tool schemas ─────────────────────────────────────────────────────────────
app.get('/tools', (_req, res) => res.json(TOOL_SCHEMAS));

// ─── Individual tool calls ────────────────────────────────────────────────────
app.post('/tools/:toolName', async (req, res) => {
  const handler = HANDLERS[req.params.toolName];
  if (!handler) {
    return res.status(404).json({ error: `Tool '${req.params.toolName}' not found. Available: ${Object.keys(HANDLERS).join(', ')}` });
  }
  try {
    res.json(await handler(req.body ?? {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Agentic order processing ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un agente de procesamiento de pedidos para OrderFlow, conectado a PedidAI.
Tu trabajo es analizar pedidos que llegan por email u otros canales y procesarlos en PedidAI.

PROCESO:
1. Analiza el contenido del pedido (puede estar en catalán, español u otro idioma)
2. Usa search_suppliers para buscar el proveedor mencionado. Si no se especifica proveedor, busca el más barato con compare_prices.
3. Agrupa los productos por proveedor. Si son de un solo proveedor, crea un pedido. Si son de varios, crea un pedido por proveedor.
4. Para cada grupo: usa get_supplier_products para obtener los UUIDs de producto.
5. Comprueba duplicados con check_duplicate_order antes de crear.
6. Crea el pedido con create_order (solo incluye los productos que existan en PedidAI).
7. Envía el pedido con send_order.
8. SIEMPRE termina respondiendo con un JSON. Si hay múltiples pedidos usa el primero creado como referencia.

REGLAS:
- Los items DEBEN usar productUuid, no el nombre.
- Si un producto no existe en PedidAI, omítelo e indica cuáles se pudieron procesar.
- Si no encuentras el proveedor con búsqueda exacta, intenta con variantes (singular/plural, sin acentos).
- SIEMPRE responde con este JSON exacto (incluso si hay error):
  { "status": "success|error|duplicate|partial", "order_uuid": "uuid-o-null", "supplier": "Nombre", "items_count": 0, "confidence": 0.9, "message": "descripción" }
- status "partial" si solo se procesaron algunos productos de los solicitados.
- IMPORTANTE: Tu respuesta final DEBE ser exclusivamente un objeto JSON válido, sin ningún tipo de markup, XML, DSML, ni texto adicional. Solo JSON puro.`;

function stripDsml(text) {
  // Remove DSML markup that DeepSeek sometimes emits instead of proper API tool calls
  return text
    .replace(/<\|DSML\|function_calls>[\s\S]*?<\/\|DSML\|function_calls>/g, '')
    .replace(/<\|DSML\|[^>]*>/g, '')
    .replace(/<\/\|DSML\|[^>]*>/g, '')
    .trim();
}

function extractJsonWithStatus(content) {
  // Greedy match to capture the full outermost JSON object with a status field
  const matches = content.match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  for (const m of [...matches].reverse()) {
    try {
      const parsed = JSON.parse(m);
      if (parsed.status) return parsed;
    } catch { /* continue */ }
  }
  return null;
}

function inferResultFromHistory(messages) {
  // Scan executed tool calls to infer result when the model didn't emit clean JSON
  let orderUuid = null;
  let lastAction = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;
    for (const tc of msg.tool_calls) {
      if (!['create_order', 'send_order'].includes(tc.function.name)) continue;
      for (let j = i + 1; j < messages.length; j++) {
        const tmsg = messages[j];
        if (tmsg.role !== 'tool' || tmsg.tool_call_id !== tc.id) continue;
        try {
          const r = JSON.parse(tmsg.content);
          if (!r.error) {
            orderUuid = r.uuid || r.order_uuid || r.id || orderUuid;
            lastAction = tc.function.name;
          }
        } catch { /* skip */ }
        break;
      }
    }
  }
  if (!orderUuid) return null;
  const message = lastAction === 'send_order' ? 'Pedido creado y enviado' : 'Pedido creado';
  return { status: 'success', order_uuid: orderUuid, supplier: null, items_count: 0, confidence: 0.9, message };
}

async function runAgent(userMessage) {
  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY no configurada');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  const callDeepSeek = async () => {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages, tools: TOOL_SCHEMAS, tool_choice: 'auto', temperature: 0.1 }),
    });
    if (!r.ok) throw new Error(`DeepSeek HTTP ${r.status}: ${await r.text()}`);
    return r.json();
  };

  let data = await callDeepSeek();
  let choice = data.choices?.[0];
  if (!choice) throw new Error('Sin respuesta de DeepSeek');
  messages.push(choice.message);

  for (let iter = 0; iter < 12; iter++) {
    const last = messages[messages.length - 1];
    if (!last.tool_calls?.length) break;

    for (const tc of last.tool_calls) {
      let args;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      const handler = HANDLERS[tc.function.name];
      let result;
      try {
        result = handler ? await handler(args) : { error: `Tool '${tc.function.name}' no existe` };
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }

    data = await callDeepSeek();
    choice = data.choices?.[0];
    if (!choice) break;
    messages.push(choice.message);
  }

  // If last message still has tool_calls or no content, force final with tool_choice=none
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg?.content || lastMsg?.tool_calls?.length) {
    // Flush any pending tool_calls with empty results so history is valid
    if (lastMsg?.tool_calls?.length) {
      for (const tc of lastMsg.tool_calls) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: '{"error":"max iterations reached, summarize with available data"}' });
      }
    }
    const forced = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages, tools: TOOL_SCHEMAS, tool_choice: 'none', temperature: 0.1 }),
    });
    if (forced.ok) {
      const fd = await forced.json();
      const fc = fd.choices?.[0];
      if (fc?.message?.content) messages.push(fc.message);
    }
  }

  // Strip DSML/XML markup and extract JSON from assistant messages (last one wins)
  let finalResult = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.content) continue;
    const cleaned = stripDsml(msg.content);
    finalResult = extractJsonWithStatus(cleaned);
    if (finalResult) break;
  }
  // If no JSON found, infer result from successfully executed tool calls in history
  if (!finalResult) finalResult = inferResultFromHistory(messages);
  const lastContent = messages.slice().reverse().find(m => m.role === 'assistant' && m.content)?.content ?? 'Sin respuesta';
  return finalResult ?? { status: 'error', order_uuid: null, supplier: null, items_count: 0, confidence: 0, message: stripDsml(lastContent) };
}

app.post('/process-order', async (req, res) => {
  const { source = 'email', from = '', subject = '', body = '', source_ref = '' } = req.body ?? {};
  const userMessage = `Procesa este pedido:\nOrigen: ${source}\nDe: ${from}\nAsunto: ${subject}\nReferencia: ${source_ref}\n\nContenido:\n${body}`;
  try {
    res.json(await runAgent(userMessage));
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Consumption analysis agent ───────────────────────────────────────────────
app.post('/analyze-consumption', async (_req, res) => {
  const userMessage = `Analiza el consumo reciente de los últimos 90 días, compara precios entre proveedores para los productos más frecuentes, y genera sugerencias de pedidos con urgencia y ahorro estimado. Usa analyze_consumption, compare_prices y suggest_orders. Devuelve un JSON con: { consumption: [...], suggestions: [...] }`;
  try {
    res.json(await runAgent(userMessage));
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Direct suggest-orders (no AI, faster for cron) ──────────────────────────
async function handleSuggestOrders(req, res) {
  try {
    const { min_order_count = 2 } = req.body ?? {};
    res.json(await suggest_orders({ min_order_count }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.post('/suggest-orders', handleSuggestOrders);
app.post('/suggestions', handleSuggestOrders);

const PORT = process.env.PORT || 3200;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OrderFlow HTTP Bridge escuchando en http://0.0.0.0:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  GET  /tools`);
  console.log(`  POST /tools/:toolName`);
  console.log(`  POST /process-order`);
  console.log(`  POST /analyze-consumption`);
  console.log(`  POST /suggest-orders`);
});
