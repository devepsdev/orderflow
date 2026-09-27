# OrderFlow

Servicios de apoyo de [PedidAI](https://pedidai.es) desplegados con Docker:

- **Asistente de pedidos por chat** (`mcp-server`): interpreta frases como «10 kg de tomates y 5 garrafas de agua» con DeepSeek y prepara los pedidos al proveedor más barato a través de la API de PedidAI.
- **n8n**: automatizaciones internas del equipo de PedidAI (alertas por email de registros nuevos y resumen diario).

---

## Tabla de contenidos

- [Arquitectura](#arquitectura)
- [Asistente de pedidos](#asistente-de-pedidos)
- [API del asistente](#api-del-asistente)
- [Flujos de n8n](#flujos-de-n8n)
- [Configuración](#configuración)
- [Puesta en marcha](#puesta-en-marcha)
- [Despliegue en producción](#despliegue-en-producción)
- [Estructura del proyecto](#estructura-del-proyecto)

---

## Arquitectura

```text
Navegador (app de PedidAI)
        │  https://pedidai.es/ai/…  (con el token JWT del usuario)
        ▼
      nginx ───────────────► mcp-bridge  127.0.0.1:3201 ──► DeepSeek
                                  │
                                  │ REST con el mismo token
                                  ▼
                         API de PedidAI  127.0.0.1:8085
                                  ▲            │
             GET /api/internal/…  │            │ webhook tras cada registro
                                  │            ▼
                              n8n  127.0.0.1:5678 ──► SMTP (Gmail) ──► email al equipo
```

| Servicio | Tecnología | Puerto | Red |
| --- | --- | --- | --- |
| `mcp-bridge` | Node.js 20 + Express 5 | 3201 | `host`, escucha solo en `127.0.0.1` |
| `n8n` | n8n 2.x (SQLite) | 5678 | `host`, escucha solo en `127.0.0.1` |

Ninguno de los dos puertos se expone a Internet: nginx publica el asistente en `/ai/` y el editor de n8n en `/n8n/` (los webhooks de n8n quedan bloqueados desde fuera).

> **Nota sobre el nombre `mcp-server`:** el asistente sigue la idea de MCP (una IA con una lista de herramientas que actúan sobre una aplicación), pero es un servidor Express que usa el *function calling* de DeepSeek; no implementa el protocolo MCP ni usa su SDK.

---

## Asistente de pedidos

Principios de diseño:

- **Actúa con la sesión del usuario.** Cada petición trae el token JWT de quien usa la app; el asistente lo valida contra `GET /api/users/me` y hace todas las llamadas a la API con ese mismo token. No existe ninguna cuenta fija: la IA solo ve y crea datos de la empresa del usuario, con sus mismos permisos.
- **Nunca envía pedidos.** Solo crea pedidos en estado `PENDING`; el usuario los revisa y los envía desde la app.
- **Los pedidos devueltos son los reales.** La respuesta incluye los pedidos tal como los ha creado la API, no el texto que genera la IA.
- **Bilingüe.** Responde en castellano o catalán según el idioma del usuario (`Accept-Language` y su perfil).
- **Límites de uso** por usuario para controlar el coste de la IA: 30 mensajes por hora y 150 por día en el chat; 60 peticiones de sugerencias por hora.

Herramientas que puede usar la IA (`src/tools.js`):

| Herramienta | Qué hace |
| --- | --- |
| `compare_prices` | Proveedores que tienen un producto y su precio vigente según los albaranes, del más barato al más caro |
| `search_suppliers` | Busca proveedores del usuario por nombre |
| `get_supplier_products` | Productos de un proveedor con precio y unidad |
| `check_duplicate_order` | Indica si ya hay un pedido pendiente reciente a ese proveedor |
| `create_order` | Crea un pedido **pendiente** a un proveedor |

Las sugerencias de reposición (`suggest_orders`) no usan IA: combinan el análisis de consumo de la API con la comparativa de precios.

---

## API del asistente

Todas las rutas, salvo `/health`, exigen `Authorization: Bearer <token de PedidAI>`. En producción se accede como `https://pedidai.es/ai/<ruta>`.

### `GET /health`

```json
{ "status": "ok" }
```

### `POST /process-order`

Interpreta un mensaje del chat y crea los pedidos pendientes.

```json
{ "text": "10 kg de tomates y 5 garrafas de agua" }
```

```json
{
  "status": "success",
  "message": "He preparado el pedido con Frutas Martínez, el más barato.",
  "unmatched": [],
  "orders": [
    {
      "uuid": "…",
      "name": "Verdura y agua",
      "status": "PENDING",
      "supplier_name": "Frutas Martínez",
      "total": 20.4,
      "items": [{ "product": "Tomate pera", "quantity": 10, "unit_price": 1.55, "subtotal": 15.5 }]
    }
  ]
}
```

Errores: `400` (mensaje vacío), `401` (token ausente o no válido), `429` (límite de uso), `502` (IA no disponible).

### `POST /suggest-orders`

Sugerencias de reposición según el consumo de los últimos 180 días (alias: `/suggestions`).

```json
{ "min_order_count": 2 }
```

Devuelve una lista ordenada por urgencia (`high`, `medium`, `low`) con producto, proveedor más barato, cantidad habitual, precio y porcentaje de ahorro estimado.

---

## Flujos de n8n

Los flujos están en `n8n-workflows/`. Se importan con la cuenta de envío de la plataforma como remitente y destinatario (sustituyendo `__ALERT_EMAIL__`):

| Archivo | Disparador | Qué hace |
| --- | --- | --- |
| `pedidai-nuevo-registro.json` | Webhook `POST /webhook/pedidai-nuevo-registro`, llamado por la API de PedidAI tras cada registro | Envía por email la ficha del negocio: nombre, ciudad, contacto, email, teléfono, idioma y fin de la prueba |
| `pedidai-resumen-diario.json` | Cada día a las 8:00 (Europe/Madrid) | Pide `GET http://127.0.0.1:8085/api/internal/daily-summary` y envía registros nuevos, pruebas que acaban en ≤ 3 días, pruebas vencidas, datos que se borrarán en < 7 días y actividad del día |
| `process-order.json` | — | **Obsoleto.** Ejemplo inicial que llamaba a herramientas en `127.0.0.1:3200/tools`, que ya no existen. No se importa. |

Detalles:

- Los nombres introducidos por los clientes se escapan antes de montar el HTML del email.
- Las ejecuciones correctas no se guardan (`saveDataSuccessExecution: none`) para no acumular datos personales en n8n; las fallidas sí, para poder revisarlas.
- El endpoint interno de la API solo responde a peticiones locales que no pasan por nginx, y nginx además bloquea `/api/internal/`.

Importación en el servidor:

```bash
M=<cuenta de envío>   # la de MAIL_USER_PEDIDAI de la API
for w in pedidai-nuevo-registro pedidai-resumen-diario; do
  sed "s/__ALERT_EMAIL__/$M/g" n8n-workflows/$w.json > /tmp/$w.json
  sudo docker cp /tmp/$w.json orderflow-n8n-1:/tmp/$w.json
  sudo docker exec -u node orderflow-n8n-1 n8n import:workflow --input=/tmp/$w.json
done
```

Después, en el editor de n8n: crear una credencial **SMTP** (Gmail: `smtp.gmail.com`, puerto 465, SSL/TLS, contraseña de aplicación), asignarla al nodo *Enviar email* de cada flujo y pulsar **Publish**.

En la API de PedidAI, el aviso de registro se activa con la variable `N8N_NEW_COMPANY_WEBHOOK=http://127.0.0.1:5678/webhook/pedidai-nuevo-registro` (vacía = desactivado).

---

## Configuración

### `.env` (raíz, para `docker-compose.yml`)

Ver `.env.example`. Solo contiene URLs públicas de n8n:

```env
N8N_HOST=pedidai.es
N8N_EDITOR_BASE_URL=https://pedidai.es/n8n/
WEBHOOK_URL=https://pedidai.es/n8n/
```

### `mcp-server/.env`

Ver `mcp-server/.env.example`:

```env
PEDIDAI_API_URL=http://localhost:8085/api   # API vista desde el servidor, sin barra final
DEEPSEEK_API_KEY=                           # clave de DeepSeek
# DEEPSEEK_MODEL=deepseek-v4-flash
# HOST=127.0.0.1
# PORT=3201
```

Ninguno de los dos `.env` se versiona.

---

## Puesta en marcha

En local (sin Docker), con la API de PedidAI en marcha:

```bash
cd mcp-server
cp .env.example .env      # y rellena PEDIDAI_API_URL y DEEPSEEK_API_KEY
npm install
npm start                 # http://127.0.0.1:3201/health
```

La app de Angular redirige `/ai` a `127.0.0.1:3201` mediante `proxy.conf.json`.

Con Docker:

```bash
docker compose up -d                  # asistente y n8n
docker compose ps
docker compose logs -f mcp-bridge
docker compose logs -f n8n
```

---

## Despliegue en producción

En el VPS el repositorio está en `/opt/apps/orderflow` (rama local `master`, sin seguimiento):

```bash
cd /opt/apps/orderflow
git fetch && git merge --ff-only origin/main
sudo docker compose up -d --build mcp-bridge   # si cambia el asistente
sudo docker compose up -d n8n                  # si cambia la configuración de n8n
curl -s http://127.0.0.1:3201/health           # {"status":"ok"}
curl -s http://127.0.0.1:5678/healthz          # {"status":"ok"}
```

Los datos de n8n (flujos, credenciales cifradas e historial) viven en `data/n8n/`; conviene copiarlos antes de actualizar.

---

## Estructura del proyecto

```text
orderflow/
├── mcp-server/
│   ├── src/
│   │   ├── http-bridge.js       # Express: autenticación, límites de uso, agente con DeepSeek, rutas
│   │   ├── tools.js             # Herramientas de la IA y sugerencias de reposición
│   │   └── pedidai-client.js    # Cliente REST de la API de PedidAI (token e idioma del usuario)
│   ├── Dockerfile               # Node 20 Alpine
│   ├── package.json
│   └── .env.example
├── n8n-workflows/
│   ├── pedidai-nuevo-registro.json
│   ├── pedidai-resumen-diario.json
│   └── process-order.json       # obsoleto
├── data/n8n/                    # volumen de n8n (no versionado)
├── docker-compose.yml
└── .env.example
```

---

## Licencia

Uso privado. Todos los derechos reservados.
