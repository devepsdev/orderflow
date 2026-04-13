# OrderFlow

Plataforma de automatización inteligente de pedidos que combina n8n, un servidor MCP propio y la IA de DeepSeek para procesar pedidos de proveedores de forma autónoma a partir de correos electrónicos o texto libre.

---

## Tabla de contenidos

- [Descripción general](#descripción-general)
- [Arquitectura](#arquitectura)
- [Requisitos previos](#requisitos-previos)
- [Configuración](#configuración)
- [Puesta en marcha](#puesta-en-marcha)
- [API Reference](#api-reference)
- [Herramientas disponibles](#herramientas-disponibles)
- [Flujos de trabajo n8n](#flujos-de-trabajo-n8n)
- [Estructura del proyecto](#estructura-del-proyecto)

---

## Descripción general

OrderFlow automatiza el ciclo de vida de los pedidos a proveedores:

1. **Recibe** el texto de un pedido (email, webhook, formulario).
2. **Interpreta** el contenido con DeepSeek AI (español, catalán, inglés).
3. **Busca** el proveedor y los productos correctos en Pedidoo.
4. **Crea y envía** el pedido automáticamente.
5. **Analiza** el historial de consumo para sugerir pedidos óptimos.
6. **Compara** precios entre proveedores.
7. **Detecta duplicados** dentro de una ventana de tiempo configurable.

---

## Arquitectura

```text
┌─────────────────────────────────────────────────────────────┐
│  n8n (puerto 5678)                                          │
│  Webhooks · Flujos de trabajo · Interfaz de usuario         │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP
┌────────────────────────▼────────────────────────────────────┐
│  MCP HTTP Bridge  (puerto 3201)                             │
│  Express.js · Bucle agéntico con DeepSeek                   │
│  9 herramientas de gestión de pedidos y proveedores         │
└────────────────────────┬────────────────────────────────────┘
                         │ REST / JWT
┌────────────────────────▼────────────────────────────────────┐
│  Pedidoo API  (PEDIDOO_API_URL)                             │
│  Proveedores · Productos · Pedidos · Dashboard              │
└─────────────────────────────────────────────────────────────┘
```

| Componente | Tecnología | Puerto |
| --- | --- | --- |
| Automatización de flujos | n8n (Docker) | 5678 |
| Servidor MCP / puente HTTP | Node.js 20 + Express 5 | 3201 |
| IA | DeepSeek `deepseek-chat` | — |
| Plataforma de aprovisionamiento | Pedidoo API | configurable |

---

## Requisitos previos

- [Docker](https://docs.docker.com/get-docker/) y Docker Compose
- Acceso a la API de Pedidoo (URL, email y contraseña)
- API Key de [DeepSeek](https://platform.deepseek.com/)

---

## Configuración

### 1. Variables de entorno raíz (`.env`)

Copia el ejemplo y rellena los valores:

```env
POSTGRES_DB=orderflow
POSTGRES_USER=orderflow
POSTGRES_PASSWORD=tu_contraseña_segura
```

### 2. Variables del servidor MCP (`mcp-server/.env`)

```env
# URL base de la API de Pedidoo
PEDIDOO_API_URL=http://localhost:8085/api

# Credenciales de Pedidoo
PEDIDOO_EMAIL=usuario@ejemplo.com
PEDIDOO_PASSWORD=tu_contraseña

# Clave de API de DeepSeek
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

> Las credenciales se autentican automáticamente con renovación de token JWT cada hora.

---

## Puesta en marcha

```bash
# Levantar todos los servicios
docker compose up -d

# Verificar que están corriendo
docker compose ps

# Ver logs del servidor MCP
docker compose logs -f mcp-bridge

# Ver logs de n8n
docker compose logs -f n8n
```

| Servicio | URL |
| --- | --- |
| n8n (interfaz) | <http://localhost:5678> |
| MCP Bridge (health) | <http://localhost:3201/health> |

Para detener los servicios:

```bash
docker compose down
```

---

## API Reference

### `GET /health`

Comprueba el estado del servicio y la conexión con Pedidoo.

**Respuesta:**

```json
{
  "status": "ok",
  "pedidoo": "connected"
}
```

---

### `GET /tools`

Lista todos los esquemas de herramientas disponibles para integración con IA.

---

### `POST /tools/:toolName`

Ejecuta una herramienta específica directamente.

**Ejemplo:**

```bash
curl -X POST http://localhost:3201/tools/search_suppliers \
  -H "Content-Type: application/json" \
  -d '{"query": "frutas"}'
```

---

### `POST /process-order`

Procesa un pedido en texto libre usando el bucle agéntico de DeepSeek.

**Body:**

```json
{
  "source": "email",
  "from": "proveedor@ejemplo.com",
  "subject": "Pedido semanal",
  "body": "Necesito 10 kg de tomates y 5 kg de pimientos de Verduras García",
  "source_ref": "email-id-123"
}
```

**Respuesta:**

```json
{
  "success": true,
  "result": "Pedido creado y enviado correctamente. Order #4521 — Verduras García.",
  "iterations": 4
}
```

---

### `POST /analyze-consumption`

Lanza un análisis de consumo de los últimos 90 días con IA.

**Respuesta:**

```json
{
  "success": true,
  "result": "Análisis completado. Se han identificado 8 productos con consumo recurrente..."
}
```

---

### `POST /suggest-orders`

Genera sugerencias de pedidos basadas en el historial de consumo.

**Body:**

```json
{
  "min_order_count": 2
}
```

---

## Herramientas disponibles

El servidor expone 9 herramientas que la IA puede invocar de forma autónoma:

| Herramienta | Descripción |
| --- | --- |
| `search_suppliers` | Busca proveedores por nombre o categoría |
| `get_supplier_products` | Lista productos de un proveedor con precios |
| `create_order` | Crea un pedido con sus líneas de producto |
| `send_order` | Envía un pedido al proveedor |
| `check_duplicate_order` | Detecta pedidos duplicados en una ventana temporal |
| `get_order_summary` | Obtiene métricas del dashboard (gasto, pedidos pendientes…) |
| `analyze_consumption` | Analiza patrones de consumo en los últimos 90-180 días |
| `compare_prices` | Compara precios de un producto entre proveedores |
| `suggest_orders` | Sugiere pedidos óptimos según el histórico |

---

## Flujos de trabajo n8n

El directorio `n8n-workflows/` contiene los flujos exportados:

| Archivo | Descripción |
| --- | --- |
| `process-order.json` | Recibe un webhook con un email, llama a `/process-order` y devuelve el resultado |

Para importarlos en n8n:

1. Abre <http://localhost:5678>
2. Ve a **Workflows → Import from file**
3. Selecciona el archivo `.json` correspondiente

---

## Estructura del proyecto

```text
orderflow/
├── mcp-server/                  # Servidor backend principal
│   ├── src/
│   │   ├── http-bridge.js       # API Express + bucle agéntico con DeepSeek
│   │   ├── tools.js             # Implementación de las 9 herramientas
│   │   └── pedidoo-client.js    # Cliente REST para la API de Pedidoo (JWT)
│   ├── Dockerfile               # Imagen Node 20 Alpine
│   ├── package.json
│   └── .env                     # Credenciales del servidor (no incluido en git)
├── n8n-workflows/
│   └── process-order.json       # Flujo de procesamiento de pedidos por email
├── data/
│   └── n8n/                     # Volumen persistente de n8n (SQLite + nodos)
├── docker-compose.yml           # Orquestación de servicios
├── .env                         # Variables de entorno raíz (no incluido en git)
└── .gitignore
```

---

## Licencia

Uso privado. Todos los derechos reservados.
