import { readFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { ErrorModelo } from "./llm/adapter.js";
import type { AdaptadorLLM, Mensaje } from "./llm/adapter.js";

import {
    definicionesHerramientas,
    ejecutarHerramienta,
} from "./tools/registro.js";

interface EventoHerramienta {
    name: string;
    args: unknown;
    result: unknown;
}

interface Turno {
    message: string;
    reply: string;
    toolCalls: EventoHerramienta[];
    needsConfirmation: boolean;
}

interface Sesion {
    mensajes: Mensaje[];
    historial: Turno[];
    tokensReservados: number;
    casoPendiente?: string;
    ocupada: boolean;
}

function limite(
    nombre: string,
    predeterminado: number,
    maximo: number,
): number {
    const valor = Number(process.env[nombre]);

    return Number.isFinite(valor) && valor > 0
        ? Math.min(Math.floor(valor), maximo)
        : predeterminado;
}

function ocultarClave(texto: string): string {
    const clave = process.env.GEMINI_API_KEY;

    return clave
        ? texto.split(clave).join("[CLAVE OCULTA]")
        : texto;
}

const resultadoSchema = z.object({
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
});

const campoResumenSchema = z.object({
    etiqueta: z.string(), ruta: z.string().optional(), nota: z.string().optional(),
});
const mapeoResumenSchema = z.object({
    llenos: z.array(campoResumenSchema), faltantes: z.array(campoResumenSchema),
    requiere_confirmacion: z.array(campoResumenSchema),
});
const paqueteResumenSchema = z.object({
    ruta: z.string(), listo_para_firma: z.boolean(),
    checklist: z.array(z.object({tipo: z.string(), estado: z.string()})),
});
function resumirResultados(eventos: EventoHerramienta[]): string {
    const obtener = (nombre: string): unknown => {
        const evento = [...eventos].reverse().find(e => e.name === nombre && resultadoSchema.safeParse(e.result).data?.ok);
        return evento ? resultadoSchema.parse(evento.result).data : undefined;
    };
    const mapeo = mapeoResumenSchema.safeParse(obtener("proveedor_mapear_campos"));
    const paquete = paqueteResumenSchema.safeParse(obtener("proveedor_armar_paquete"));
    const formulario = z.object({ruta:z.string(), aviso:z.string().nullable().optional()})
        .safeParse(obtener("proveedor_generar_formulario"));
    if (!mapeo.success || !paquete.success) return "Revisa los resultados de las herramientas; no se pudo construir el resumen completo.";
    return [
        "Paquete preparado para revisión humana.",
        formulario.success && formulario.data.aviso ? formulario.data.aviso : "",
        `Formulario: ${formulario.success ? formulario.data.ruta : "revisa la herramienta"}`,
        `Paquete: ${paquete.data.ruta}`,
        `Listo para firma: ${paquete.data.listo_para_firma ? "Sí" : "No"}.`,
        "", `Campos llenos (${mapeo.data.llenos.length}) y fuentes:`,
        ...mapeo.data.llenos.map(c => `- ${c.etiqueta}: ${c.ruta}`),
        "", "Campos faltantes:",
        ...(mapeo.data.faltantes.length ? mapeo.data.faltantes.map(c=>`- ${c.etiqueta}`) : ["Ninguno."]),
        "", "Requiere confirmación:",
        ...(mapeo.data.requiere_confirmacion.length ? mapeo.data.requiere_confirmacion.map(c=>`- ${c.etiqueta}: ${c.nota}`) : ["Ninguna."]),
        "", "Soportes:", ...paquete.data.checklist.map(c=>`- ${c.tipo}: ${c.estado}`),
        "", "Actualiza los soportes vencidos y consigue los ausentes antes de la firma. No se realizó ningún envío.",
    ].filter((linea): linea is string => typeof linea === "string").join("\n");
}

export class AgenteProveedor {
    private sesiones = new Map<string, Sesion>();
    private tokensGlobales = 0;

    constructor(
        private adaptador: AdaptadorLLM,
        private directorio: string,
    ) { }

    obtenerHistorial(sessionId: string): Turno[] | null {
        return this.sesiones.get(sessionId)?.historial ?? null;
    }

    async conversar(
        sessionId: string,
        mensajeUsuario: string,
    ): Promise<Omit<Turno, "message">> {
        let sesion = this.sesiones.get(sessionId);

        if (!sesion) {
            if (this.sesiones.size >= limite("MAX_SESSIONS", 30, 100)) {
                return {
                    reply: "Se alcanzó el límite de sesiones disponibles.",
                    toolCalls: [],
                    needsConfirmation: false,
                };
            }

            sesion = {
                mensajes: [],
                historial: [],
                tokensReservados: 0,
                ocupada: false,
            };

            this.sesiones.set(sessionId, sesion);
        }

        if (sesion.ocupada) {
            return {
                reply: "Espera a que termine el mensaje anterior.",
                toolCalls: [],
                needsConfirmation: false,
            };
        }

        sesion.ocupada = true;

        const mensaje = ocultarClave(mensajeUsuario);
        const eventos: EventoHerramienta[] = [];
        const formulariosGenerados = new Set<string>();
        const orden = [
            "proveedor_leer_solicitud", "proveedor_mapear_campos",
            "proveedor_generar_formulario", "proveedor_armar_paquete",
        ];
        let paso = 0;
        let casoActual: string | undefined;
        let respuesta = "";

        const casoAnterior = sesion.casoPendiente;
        sesion.casoPendiente = undefined;

        // Solo autoriza la respuesta humana inmediatamente posterior
        // a la pregunta de confirmación de este caso.
        const confirma =
            Boolean(casoAnterior) &&
            /^(confirmo|sí|si|envía|envia|confirmar envío simulado)[.! ]*$/i
                .test(mensaje.trim());

        const contexto = {
            directory: this.directorio,
            sessionId,
        };

        const registrarEvento = async (
            nombre: string,
            argumentos: unknown,
            resultado: unknown,
        ): Promise<void> => {
            const evento = JSON.parse(
                ocultarClave(
                    JSON.stringify({
                        name: nombre,
                        args: argumentos,
                        result: resultado,
                    }),
                ),
            ) as EventoHerramienta;

            eventos.push(evento);

            const salida = path.join(this.directorio, "out");
            await mkdir(salida, { recursive: true });

            const validacion = resultadoSchema.safeParse(resultado);

            // La auditoría no almacena claves ni argumentos completos.
            await appendFile(
                path.join(salida, "log.jsonl"),
                JSON.stringify({
                    ts: new Date().toISOString(),
                    herramienta: nombre,
                    ok: validacion.success && validacion.data.ok,
                    resumen: "Llamada registrada en el historial del chat",
                }) + "\n",
            );
        };

        try {
            if (sesion.mensajes.length === 0) {
                const prompt = await readFile(
                    path.join(this.directorio, "agent/prompt.md"),
                    "utf8",
                );

                const conocimiento = await readFile(
                    path.join(
                        this.directorio,
                        "src/knowledge/registro-proveedor.md",
                    ),
                    "utf8",
                );

                sesion.mensajes.push({
                    role: "system",
                    content: `${prompt}\n\n${conocimiento}`,
                });
            }

            sesion.mensajes.push({
                role: "user",
                content: mensaje,
            });

            if (confirma && casoAnterior) {
                const argumentos = {
                    caso: casoAnterior,
                    confirmado: true,
                };

                const resultado = resultadoSchema.parse(
                    JSON.parse(
                        await ejecutarHerramienta(
                            "proveedor_simular_envio",
                            argumentos,
                            contexto,
                            { caso: casoAnterior },
                        ),
                    ),
                );

                await registrarEvento(
                    "proveedor_simular_envio",
                    argumentos,
                    resultado,
                );

                respuesta = resultado.ok
                    ? "Envío simulado registrado. No se enviaron correos, " +
                    "no se firmó ni se cargó información a portales."
                    : resultado.error ??
                    "No se pudo registrar la simulación.";
            } else {
                const maxIteraciones = limite(
                    "MAX_ITERATIONS",
                    10,
                    25,
                );

                for (let i = 0; i < maxIteraciones; i++) {
                    const maxSalida = 4096;

                    // Reserva preventiva por petición.
                    // Se conserva incluso si el proveedor falla.
                    const reserva = 2 * (
                        Buffer.byteLength(
                            JSON.stringify(sesion.mensajes) +
                            JSON.stringify(definicionesHerramientas),
                            "utf8",
                        ) +
                        maxSalida +
                        4096
                    );

                    if (
                        sesion.tokensReservados + reserva >
                        limite(
                            "MAX_SESSION_TOKENS",
                            150000,
                            500000,
                        ) ||
                        this.tokensGlobales + reserva >
                        limite(
                            "MAX_GLOBAL_TOKENS",
                            500000,
                            2000000,
                        )
                    ) {
                        respuesta =
                            "Se alcanzó el límite preventivo de consumo. " +
                            "Revisa los resultados disponibles.";
                        break;
                    }

                    sesion.tokensReservados += reserva;
                    this.tokensGlobales += reserva;

                    // Exponer solo el siguiente paso reduce saltos y llamadas repetidas.
                    const disponibles = definicionesHerramientas.filter(
                        herramienta => herramienta.function.name === orden[paso],
                    );
                    const salidaModelo = await this.adaptador.enviar(
                        sesion.mensajes,
                        disponibles,
                        maxSalida,
                    );

                    const salida = salidaModelo.mensaje;
                    sesion.mensajes.push(salida);

                    if (!salida.tool_calls?.length) {
                        respuesta =
                            salida.content ??
                            "El modelo no devolvió texto. " +
                            "Revisa las herramientas ejecutadas.";
                        break;
                    }

                    for (const llamada of salida.tool_calls) {
                        let argumentos: unknown = {};
                        let resultado: z.infer<typeof resultadoSchema>;

                        try {
                            argumentos = JSON.parse(
                                llamada.function.arguments,
                            ) as unknown;

                            const entradaCaso = z.object({
                                caso: z.string(),
                            }).safeParse(argumentos);

                            const intentaArmarSinGenerar =
                                llamada.function.name ===
                                "proveedor_armar_paquete" &&
                                (
                                    !entradaCaso.success ||
                                    !formulariosGenerados.has(
                                        entradaCaso.data.caso,
                                    )
                                );

                            if (
                                llamada.function.name !== orden[paso] ||
                                (casoActual && entradaCaso.success && entradaCaso.data.caso !== casoActual)
                            ) {
                                resultado = { ok: false, error: `Ejecuta ${orden[paso]} para el caso actual antes de continuar.` };
                            } else if (intentaArmarSinGenerar) {
                                resultado = {
                                    ok: false,
                                    error:
                                        "Primero ejecuta " +
                                        "proveedor_generar_formulario " +
                                        "para este caso en el turno actual. " +
                                        "No reutilices archivos de " +
                                        "ejecuciones anteriores.",
                                };
                            } else {
                                resultado = resultadoSchema.parse(
                                    JSON.parse(
                                        await ejecutarHerramienta(
                                            llamada.function.name,
                                            argumentos,
                                            contexto,
                                        ),
                                    ),
                                );

                                if (resultado.ok && entradaCaso.success) {
                                    casoActual = entradaCaso.data.caso;
                                    paso++;
                                }

                                if (
                                    llamada.function.name ===
                                    "proveedor_generar_formulario" &&
                                    resultado.ok &&
                                    entradaCaso.success
                                ) {
                                    formulariosGenerados.add(
                                        entradaCaso.data.caso,
                                    );
                                }
                            }
                        } catch {
                            resultado = {
                                ok: false,
                                error:
                                    "No se pudo interpretar " +
                                    "la llamada a herramienta.",
                            };
                        }

                        await registrarEvento(
                            llamada.function.name,
                            argumentos,
                            resultado,
                        );

                        sesion.mensajes.push({
                            role: "tool",
                            tool_call_id: llamada.id,
                            content: ocultarClave(
                                JSON.stringify(resultado),
                            ),
                        });

                        if (
                            llamada.function.name ===
                            "proveedor_armar_paquete" &&
                            resultado.ok
                        ) {
                            const entrada = z.object({
                                caso: z.string(),
                            }).safeParse(argumentos);

                            if (entrada.success) {
                                sesion.casoPendiente = entrada.data.caso;
                            }
                        }
                    }

                    if (paso === orden.length) {
                        respuesta = resumirResultados(eventos);
                        break;
                    }

                    if (i === maxIteraciones - 1) {
                        respuesta =
                            "Se alcanzó el límite de iteraciones. " +
                            "Revisa las herramientas y archivos generados.";
                    }
                }
            }
        } catch (error: unknown) {
            respuesta =
                error instanceof ErrorModelo
                    ? error.message
                    : "No se pudo completar el turno por un error interno. " +
                    "Los resultados ya generados siguen disponibles.";
        } finally {
            sesion.ocupada = false;
        }

        if (paso > 0 && paso < orden.length) {
            respuesta += "\n\nEl proceso quedó parcial. No hay un paquete nuevo completo listo para confirmar.";
        }
        const needsConfirmation = Boolean(sesion.casoPendiente);

        if (needsConfirmation) {
            respuesta +=
                "\n\n¿Confirmas registrar únicamente el envío simulado " +
                "del paquete preparado, con sus observaciones pendientes? " +
                "Responde «confirmo» o «no».";
        }

        const turno: Turno = {
            message: mensaje,
            reply: ocultarClave(respuesta),
            toolCalls: eventos,
            needsConfirmation,
        };

        sesion.historial.push(turno);

        const ultimo = sesion.mensajes.at(-1);
        if (ultimo?.role !== "assistant" || ultimo.tool_calls?.length) {
            sesion.mensajes.push({ role: "assistant", content: turno.reply });
        }

        return {
            reply: turno.reply,
            toolCalls: turno.toolCalls,
            needsConfirmation: turno.needsConfirmation,
        };
    }
}