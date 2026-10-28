# Registro como proveedor — Reto 01

Agente conversacional en TypeScript para preparar formularios Excel/PDF y soportes de registro de proveedores. Nunca firma, envía correos ni carga datos a portales. El envío disponible es una simulación en un archivo local.

**Repositorio:** https://github.com/katherinsr8000/RETO-FINAL

**Enlace público de prueba:** pendiente de despliegue. Sustituir esta línea por la URL real antes de entregar. El arranque local no equivale a un despliegue público.

## Arranque local

Requiere Node.js 20.19+ y npm. Desde la raíz del proyecto:

```powershell
npm ci
Copy-Item .env.example .env
```

Editar `.env` localmente (nunca compartirlo ni subirlo):

```dotenv
GEMINI_API_KEY=TU_CLAVE_CONFIGURADA_SOLO_EN_TU_EQUIPO
GEMINI_MODEL=gemini-3.1-flash-lite
```

El ejemplo anterior es un marcador, no una credencial. La aplicación carga `.env` únicamente desde el backend.

Una vez instaladas las dependencias y configurado el entorno, un comando levanta front y backend:

```powershell
npm run dev
```

Abrir http://localhost:3000. Comprobar http://localhost:3000/api/health. `configured: true` solo indica que existe una clave; no prueba conectividad ni cuota.

Alternativa con Docker, con el `.env` local ya configurado:

```bash
docker compose up --build
```

## Verificación

```bash
npm run check
npm test
npm run demo
npm run security
```

Los XLSX mantienen el mismo contenido entre ejecuciones; sus timestamps internos del contenedor ZIP pueden cambiar.

`npm run demo` limpia `out/` al comenzar y procesa todas las carpetas de casos sin modelo ni credenciales. No ejecutarlo al mismo tiempo que el servidor: elimina la salida compartida.

`npm test` usa archivos temporales, herramientas reales y transporte/modelo simulado. No acredita disponibilidad de Google ni consume la clave real.

Prueba de conectividad del adaptador real, opcional y con consumo de cuota:

```bash
npm run test:llm
```

El análisis de seguridad no imprime valores de secretos. Busca patrones conocidos y coincidencias con secretos del `.env` local; no garantiza detectar todo secreto ni revisa el historial de Git.

## Variables de entorno

`.env.example` contiene nombres sin valores.

| Variable | Uso / predeterminado |
| --- | --- |
| GEMINI_API_KEY | Obligatoria para el chat real; solo backend |
| GEMINI_MODEL | `gemini-3.1-flash-lite`; puede cambiarse por un modelo disponible en la cuenta |
| PORT | `3000` |
| MAX_ITERATIONS | `10`, máximo `25` por turno |
| MAX_SESSION_TOKENS | `150000`, máximo `500000`: presupuesto conservador de reserva, no facturación real |
| MAX_GLOBAL_TOKENS | `500000`, máximo `2000000`: reserva acumulada del proceso |
| MAX_SESSIONS | `30`, máximo `100` |

Cada consulta reserva por adelantado entrada/salida y hasta dos intentos HTTP. Las reservas no se liberan al fallar. Solo HTTP 503 se reintenta una vez; 429 se devuelve sin reintento. Timeout de 30 segundos por intento.

Sesiones y presupuestos están en memoria: se reinician al reiniciar el servidor. No hay autenticación ni datos reales; la URL de descarga sirve únicamente rutas restringidas dentro de `out/` y rechaza logs. No desplegar este diseño tal cual con datos personales reales.

## API

| Método | Ruta | Contrato |
| --- | --- | --- |
| GET | `/api/health` | `{ok, provider, model, configured}`; nunca devuelve la clave |
| POST | `/api/chat` | `{sessionId?, message}` → `{sessionId, reply, toolCalls, needsConfirmation}` |
| GET | `/api/sessions/:id` | Historial visible de la sesión; no incluye el prompt ni contenido nativo interno |
| GET | `/api/file?path=out/...` | Descarga de un archivo generado; rutas restringidas, sin logs |

El chat acepta mensajes de hasta 4000 caracteres y cuerpos de hasta 16000 bytes; limita 15 solicitudes por minuto por dirección de conexión y rechaza orígenes web distintos al host. Tras un proxy, varios usuarios pueden compartir ese límite.

## Casos oficiales

| Caso | Resultado |
| --- | --- |
| co-industrias-delta | Excel, 17 campos llenos |
| ec-corp-andina | PDF, 13 llenos, 1 faltante, RUC pendiente de revisión |
| hn-agroexport-sula | Excel, 9 llenos, 1 faltante, RTN pendiente de revisión |
| pa-logistica-istmo | Formato no soportado; genera `valores-portal.md` |

A fecha 2026-10-28, Cámara de Comercio y parafiscales están vencidos. Ecuador exige un certificado de cumplimiento tributario ausente. Por ello `listo_para_firma: false` es el resultado correcto, no un error.

## Prueba manual del agente

1. Nueva sesión → Ecuador → Enviar.
2. Verificar las llamadas de lectura, mapeo, generación y paquete.
3. Revisar fuentes, faltantes, vencimientos, PDF y checklist descargables.
4. La confirmación debe aparecer solo al completar un paquete nuevo.
5. Responder `confirmo`: se crea únicamente `ENVIO-SIMULADO.md`.
6. En otra sesión, escribir `confirmo` sin preparación: no debe producir simulación.

El backend impone el orden de las herramientas; el modelo elige las llamadas y sus argumentos, que se validan con Zod. Al terminar el paquete, el resumen se construye desde resultados de herramientas sin una consulta adicional al modelo.

## Despliegue

Se incluyen `Dockerfile`, `compose.yaml` y `render.yaml`. Este paquete NO contiene un despliegue ya realizado.

Para un servicio Node conectado al repositorio:

- Build: `npm ci`.
- Start: `npm start`.
- Health check: `/api/health`.
- Configurar `GEMINI_API_KEY` como secreto del backend en el panel del alojamiento.
- Configurar `GEMINI_MODEL=gemini-3.1-flash-lite` y los límites deseados.
- No subir `.env` al proveedor como archivo del repositorio.
- Confirmar cuota del modelo y costo/condiciones del alojamiento antes de crear el servicio.
- Probar un caso desde la URL publicada y actualizar el enlace de este README.

El alojamiento debe permitir escritura temporal de `out/`. Al reiniciar o redesplegar puede perderse esa salida; conservar el servicio activo durante la defensa.

## Entrega sin secretos

Antes del commit:

```bash
npm run security
git check-ignore -v .env
git ls-files -- .env
git status --short
```

El último comando de consulta de `.env` no debe mostrar archivos. Verificar el contenido preparado para el commit antes de publicarlo. Excluir `.env`, `node_modules/`, `out/`, ZIP y logs. Si alguna clave se publicó previamente, retirarla del último commit no basta: revocarla y sanear el historial.
