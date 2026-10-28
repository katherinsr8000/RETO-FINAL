import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ErrorModelo } from './adapter.js';
import type { AdaptadorLLM, Mensaje, DefinicionHerramienta, RespuestaModelo } from './adapter.js';

const llamadaNativa = z.object({
    name: z.string(), args: z.record(z.string(), z.unknown()).optional(),
    id: z.string().optional(),
}).passthrough();
const parteSchema = z.object({
    text: z.string().optional(), thought: z.boolean().optional(),
    functionCall: llamadaNativa.optional(),
}).passthrough();
const contenidoSchema = z.object({
    role: z.enum(['user', 'model']), parts: z.array(parteSchema),
}).passthrough();
type Contenido = z.infer<typeof contenidoSchema>;
const respuestaSchema = z.object({
    candidates: z.array(z.object({
        content: contenidoSchema.optional(), finishReason: z.string().optional(),
    })).optional(),
    usageMetadata: z.object({ totalTokenCount: z.number().nonnegative() }).optional(),
});

// Conserva las partes originales, incluidas thoughtSignature y functionCall.id.
// Solo se guardan en memoria del backend, nunca se devuelven al navegador.
function convertirHistorial(mensajes: Mensaje[]): Contenido[] {
    const contenidos: Contenido[] = [];
    const llamadas = new Map<string, { nombre: string; id?: string }>();
    for (const mensaje of mensajes) {
        if (mensaje.role === 'system') continue;
        let contenido: Contenido;
        if (mensaje.role === 'assistant') {
            const original = contenidoSchema.safeParse(mensaje.geminiContent);
            if (original.success) {
                contenido = original.data;
                let indice = 0;
                for (const parte of contenido.parts) {
                    if (parte.functionCall) {
                        const llamada = mensaje.tool_calls?.[indice++];
                        if (llamada) llamadas.set(llamada.id, {
                            nombre: parte.functionCall.name, id: parte.functionCall.id,
                        });
                    }
                }
            } else {
                contenido = { role: 'model', parts: [] };
                if (mensaje.content) contenido.parts.push({ text: mensaje.content });
                for (const llamada of mensaje.tool_calls ?? []) {
                    llamadas.set(llamada.id, { nombre: llamada.function.name });
                    contenido.parts.push({ functionCall: {
                        name: llamada.function.name,
                        args: JSON.parse(llamada.function.arguments) as Record<string, unknown>,
                    } });
                }
            }
        } else if (mensaje.role === 'tool') {
            const llamada = llamadas.get(mensaje.tool_call_id ?? '');
            if (!llamada) throw new ErrorModelo('El historial de herramientas está incompleto; inicia una sesión nueva.');
            contenido = { role: 'user', parts: [{ functionResponse: {
                name: llamada.nombre,
                ...(llamada.id ? { id: llamada.id } : {}),
                response: JSON.parse(mensaje.content ?? '{}') as unknown,
            } }] };
        } else {
            contenido = { role: 'user', parts: [{ text: mensaje.content ?? '' }] };
        }
        if (!contenido.parts.length) continue;
        const anterior = contenidos.at(-1);
        if (anterior?.role === contenido.role) anterior.parts.push(...contenido.parts);
        else contenidos.push(contenido);
    }
    return contenidos;
}

export class AdaptadorGemini implements AdaptadorLLM {
    // Inyectable para probar HTTP, firmas y reintentos sin clave ni conexión real.
    constructor(private transporte: typeof fetch = globalThis.fetch) {}

    async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], maxTokens: number): Promise<RespuestaModelo> {
        const clave = process.env.GEMINI_API_KEY?.trim();
        const modelo = process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
        if (!clave) throw new ErrorModelo('Configura GEMINI_API_KEY únicamente en el backend.');
        if (!/^[a-zA-Z0-9._-]+$/.test(modelo)) throw new ErrorModelo('GEMINI_MODEL debe contener solo el identificador del modelo.');
        const limite = Math.max(256, Math.min(4096, Math.floor(maxTokens)));
        const sistema = mensajes.filter(m => m.role === 'system').map(m => m.content ?? '').join('\n\n');
        const body = JSON.stringify({
            contents: convertirHistorial(mensajes),
            ...(sistema ? { systemInstruction: { parts: [{ text: sistema }] } } : {}),
            ...(herramientas.length ? { tools: [{ functionDeclarations: herramientas.map(t => ({
                name: t.function.name, description: t.function.description,
                parametersJsonSchema: t.function.parameters,
            })) }] } : {}),
            generationConfig: { maxOutputTokens: limite },
        });
        try {
            for (let intento = 0; intento < 2; intento++) {
                const respuesta = await this.transporte(
                    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave },
                        body, signal: AbortSignal.timeout(30000) },
                );
                if (respuesta.status === 503 && intento === 0) {
                    await respuesta.body?.cancel();
                    await new Promise<void>(resolve => setTimeout(resolve, 1200));
                    continue;
                }
                if (!respuesta.ok) {
                    const mensajesError: Record<number, string> = {
                        400: 'Revisa el formato del historial o las herramientas.',
                        401: 'Revisa la autenticación del backend.', 403: 'Revisa permisos y disponibilidad regional.',
                        404: 'El modelo o la ruta no están disponibles.',
                        429: 'Se alcanzó un límite de solicitudes o cuota; no se reintentó automáticamente.',
                        503: 'El servicio sigue temporalmente no disponible tras un reintento.',
                    };
                    // No se lee ni se registra el error crudo del proveedor.
                    await respuesta.body?.cancel();
                    throw new ErrorModelo(`HTTP ${respuesta.status}: ${mensajesError[respuesta.status] ?? 'El proveedor rechazó la petición.'}`);
                }
                const datos = respuestaSchema.parse(await respuesta.json());
                const candidato = datos.candidates?.[0];
                if (!candidato?.content) throw new ErrorModelo('Gemini no devolvió contenido utilizable. Puedes iniciar otra sesión.');
                if (candidato.finishReason === 'MAX_TOKENS') throw new ErrorModelo('Gemini alcanzó el límite de salida; no se ejecutaron llamadas incompletas.');
                const contenido = candidato.content;
                const llamadas = contenido.parts.flatMap(parte => parte.functionCall ? [{
                    id: parte.functionCall.id ?? randomUUID(), type: 'function' as const,
                    function: { name: parte.functionCall.name, arguments: JSON.stringify(parte.functionCall.args ?? {}) },
                }] : []);
                const texto = contenido.parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
                if (!texto && !llamadas.length) throw new ErrorModelo('Gemini respondió sin texto ni herramientas utilizables.');
                return { mensaje: { role: 'assistant', content: texto || null,
                    ...(llamadas.length ? { tool_calls: llamadas } : {}), geminiContent: contenido },
                    tokens: datos.usageMetadata?.totalTokenCount ?? 0 };
            }
            throw new ErrorModelo('No se pudo completar la consulta.');
        } catch (error: unknown) {
            if (error instanceof ErrorModelo) throw error;
            if (error instanceof z.ZodError) throw new ErrorModelo('La respuesta de Gemini tiene una estructura no reconocida.');
            if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new ErrorModelo('Gemini superó los 30 segundos de espera.');
            throw new ErrorModelo('No se pudo completar la conexión con Gemini.');
        }
    }
}
