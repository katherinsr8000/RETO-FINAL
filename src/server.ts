import "dotenv/config";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { AgenteProveedor } from "./agente.js";
import { AdaptadorGemini } from "./llm/gemini.js";

const directorio = process.cwd();

const agente = new AgenteProveedor(
    new AdaptadorGemini(),
    directorio,
);

const chatSchema = z.object({
    sessionId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(4000),
});

const solicitudes = new Map<
    string,
    { cantidad: number; vence: number }
>();

function responder(
    res: ServerResponse,
    estado: number,
    datos: unknown,
): void {
    res.writeHead(estado, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });

    res.end(JSON.stringify(datos));
}

const servidor = createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (req.method === "GET" && url.pathname === "/api/health") {
            responder(res, 200, {
                ok: true,
                provider: "gemini",
                model: process.env.GEMINI_MODEL?.trim() ?? null,
                configured: Boolean(process.env.GEMINI_API_KEY),
            });
            return;
        }

        if (
            req.method === "GET" &&
            url.pathname.startsWith("/api/sessions/")
        ) {
            const id = z.string().uuid().safeParse(
                url.pathname.slice("/api/sessions/".length),
            );

            if (!id.success) {
                responder(res, 400, {
                    error: "Identificador de sesión inválido.",
                });
                return;
            }

            const historial = agente.obtenerHistorial(id.data);

            responder(
                res,
                historial ? 200 : 404,
                historial
                    ? { sessionId: id.data, history: historial }
                    : { error: "Sesión no encontrada." },
            );
            return;
        }

        if (req.method === "GET" && url.pathname === "/") {
            let contenido: string;

            try {
                contenido = await readFile(
                    path.join(directorio, "web/index.html"),
                    "utf8",
                );
            } catch {
                contenido =
                    "<!doctype html><html lang='es'>" +
                    "<meta charset='utf-8'>" +
                    "<title>Registro de proveedores</title>" +
                    "<h1>Backend iniciado correctamente</h1>" +
                    "<p>La interfaz de chat se agregará en el siguiente paso.</p>" +
                    "</html>";
            }

            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy":
                    "default-src 'self'; " +
                    "script-src 'self' 'unsafe-inline'; " +
                    "style-src 'self' 'unsafe-inline'; " +
                    "connect-src 'self'; frame-ancestors 'none'",
            });

            res.end(contenido);
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/file") {
            const ruta = url.searchParams.get("path") ?? "";

            const permitida =
                /^out\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:paquete\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/
                    .test(ruta);

            if (!permitida || ruta.endsWith(".jsonl")) {
                responder(res, 400, {
                    error: "Ruta de descarga no permitida.",
                });
                return;
            }

            const archivo = path.resolve(directorio, ruta);
            const baseSalida = path.join(directorio, "out") + path.sep;

            if (!archivo.startsWith(baseSalida)) {
                responder(res, 400, {
                    error: "Archivo fuera de la carpeta de salida.",
                });
                return;
            }

            const contenido = await readFile(archivo);

            res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Content-Disposition":
                    `attachment; filename="${path.basename(archivo)}"`,
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-store",
            });

            res.end(contenido);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/chat") {
            if (
                req.headers.origin &&
                new URL(req.headers.origin).host !== req.headers.host
            ) {
                responder(res, 403, {
                    error: "Origen no permitido.",
                });
                return;
            }

            const ahora = Date.now();

            for (const [ip, registro] of solicitudes) {
                if (registro.vence <= ahora) {
                    solicitudes.delete(ip);
                }
            }

            const ip = req.socket.remoteAddress ?? "desconocida";

            const registro = solicitudes.get(ip) ?? {
                cantidad: 0,
                vence: ahora + 60000,
            };

            registro.cantidad++;
            solicitudes.set(ip, registro);

            if (registro.cantidad > 15) {
                responder(res, 429, {
                    error: "Demasiadas solicitudes. Espera un minuto.",
                });
                return;
            }

            let cuerpo = "";
            let bytes = 0;

            for await (const fragmento of req) {
                const buffer = Buffer.isBuffer(fragmento)
                    ? fragmento
                    : Buffer.from(fragmento);

                bytes += buffer.length;

                if (bytes > 16000) {
                    responder(res, 413, {
                        error: "El mensaje supera el tamaño permitido.",
                    });
                    return;
                }

                cuerpo += buffer.toString("utf8");
            }

            const datos = chatSchema.parse(JSON.parse(cuerpo));
            const sessionId = datos.sessionId ?? randomUUID();

            const resultado = await agente.conversar(
                sessionId,
                datos.message,
            );

            responder(res, 200, {
                sessionId,
                ...resultado,
            });
            return;
        }

        responder(res, 404, {
            error: "Recurso no encontrado.",
        });
    } catch {
        if (!res.headersSent) {
            responder(res, 400, {
                error:
                    "No se pudo procesar la solicitud. " +
                    "Revisa los datos o el archivo solicitado.",
            });
        } else {
            res.end();
        }
    }
});

const puerto = Number(process.env.PORT) || 3000;

servidor.listen(puerto, "0.0.0.0", () => {
    console.log(`Aplicación iniciada en http://localhost:${puerto}`);
});