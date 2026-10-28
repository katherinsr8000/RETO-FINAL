import { readFile, writeFile, mkdir, appendFile, copyFile, access, } from "node:fs/promises";
import ExcelJS from "exceljs";
import path from "node:path";
import { z } from "zod";
import { generarPdf, generarValoresPortal, } from "./formatos.js";

interface Contexto {
    directory: string;
    sessionId: string;
}

const casoSchema = z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .describe("Nombre de la carpeta del caso, sin rutas");

const solicitudSchema = z.object({
    pais: z.enum(["CO", "EC", "PE", "PA", "HN"]),
    cliente: z.string(),
    formato: z.enum(["xlsx", "pdf", "portal"]),
});

const campoSchema = z.object({
    etiqueta: z.string(),
    obligatorio: z.boolean().optional(),
    hoja: z.string().optional(),
    celda_etiqueta: z.string().optional(),
    celda_valor: z.string().optional(),
});

async function leerJson(archivo: string): Promise<unknown> {
    const contenido = await readFile(archivo, "utf8");
    return JSON.parse(contenido) as unknown;
}

async function registrar(
    ctx: Contexto,
    caso: string,
    ok: boolean,
    herramienta = "proveedor_leer_solicitud",
): Promise<void> {
    const salida = path.resolve(ctx.directory, "out");
    const carpetaCaso = path.join(salida, caso);

    await mkdir(carpetaCaso, { recursive: true });

    const registro =
        JSON.stringify({
            ts: new Date().toISOString(),
            herramienta,
            ok,
            resumen: ok
                ? "Operación completada"
                : "No se pudo completar la operación",
        }) + "\n";

    await appendFile(path.join(carpetaCaso, "log.jsonl"), registro);
    await appendFile(path.join(salida, "log.jsonl"), registro);
}

export const leer_solicitud = {
    description:
        "Lee el país, cliente, formato, campos y soportes exigidos de un caso.",

    args: {
        caso: casoSchema,
    },

    async execute(
        args: { caso: string },
        ctx: Contexto,
    ): Promise<string> {
        const validacion = casoSchema.safeParse(args.caso);

        if (!validacion.success) {
            return JSON.stringify({
                ok: false,
                error: "Nombre de caso inválido. Usa el nombre de su carpeta.",
            });
        }

        const caso = validacion.data;

        try {
            const carpeta = path.resolve(
                ctx.directory,
                "fixtures",
                "reto-01",
                "casos",
                caso,
            );

            const solicitud = solicitudSchema.parse(
                await leerJson(path.join(carpeta, "solicitud.json")),
            );

            const plantilla =
                solicitud.formato === "xlsx"
                    ? "plantilla-celdas.json"
                    : "plantilla-campos.json";

            const campos = z.array(campoSchema).parse(
                await leerJson(path.join(carpeta, plantilla)),
            );

            const soportes = z.array(z.string()).parse(
                await leerJson(path.join(carpeta, "soportes-exigidos.json")),
            );

            const identificador =
                solicitud.pais === "CO"
                    ? "NIT"
                    : solicitud.pais === "HN"
                        ? "RTN"
                        : "RUC";

            const requiere_confirmacion = campos
                .filter((campo) =>
                    /^(Identificación tributaria|Número de identificación fiscal)$/i
                        .test(campo.etiqueta),
                )
                .map((campo) => ({
                    etiqueta: campo.etiqueta,
                    propuesta: identificador,
                    motivo: "Etiqueta tributaria ambigua",
                }));

            await registrar(ctx, caso, true);

            return JSON.stringify({
                ok: true,
                data: {
                    ...solicitud,
                    campos,
                    soportes,
                    requiere_confirmacion,
                    aviso:
                        solicitud.formato === "portal"
                            ? "formato no soportado; se prepararán valores para copiar"
                            : null,
                },
            });
        } catch {
            try {
                await registrar(ctx, caso, false);
            } catch {
                // Un fallo de auditoría tampoco debe lanzar hacia el agente.
            }

            return JSON.stringify({
                ok: false,
                error:
                    "No se pudo leer la solicitud. Verifica que el caso exista, " +
                    "sus JSON sean válidos y la carpeta out permita escritura.",
            });
        }
    },
};

const valorSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
]);

const campoMapeadoSchema = z.object({
    etiqueta: z.string(),
    estado: z.enum([
        "lleno",
        "faltante",
        "requiere_confirmacion",
    ]),
    ruta: z.string().optional(),
    valor: valorSchema.optional(),
    confianza: z.number(),
    nota: z.string().optional(),
});

const mapeoSchema = z.object({
    llenos: z.array(campoMapeadoSchema),
    faltantes: z.array(campoMapeadoSchema),
    requiere_confirmacion: z.array(campoMapeadoSchema),
});

type CampoMapeado = z.infer<typeof campoMapeadoSchema>;
type Mapeo = z.infer<typeof mapeoSchema>;

function normalizar(texto: string): string {
    return texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();
}

function obtenerValor(
    objeto: unknown,
    ruta: string,
): unknown {
    return ruta.split(".").reduce<unknown>((actual, clave) => {
        if (
            typeof actual !== "object" ||
            actual === null ||
            !Object.hasOwn(actual, clave)
        ) {
            return undefined;
        }

        return (actual as Record<string, unknown>)[clave];
    }, objeto);
}

export const mapear_campos = {
    description:
        "Relaciona los campos oficiales con el maestro y reporta fuentes, faltantes y confirmaciones.",

    args: {
        caso: casoSchema,
        campos: z
            .array(campoSchema)
            .describe("Campos obtenidos de leer_solicitud"),
    },

    async execute(
        args: {
            caso: string;
            campos: z.infer<typeof campoSchema>[];
        },
        ctx: Contexto,
    ): Promise<string> {
        const validacion = z.object(this.args).safeParse(args);

        if (!validacion.success) {
            return JSON.stringify({
                ok: false,
                error: "Caso o campos inválidos para realizar el mapeo.",
            });
        }

        const { caso, campos } = validacion.data;

        try {
            const base = path.resolve(
                ctx.directory,
                "fixtures",
                "reto-01",
            );

            const carpeta = path.join(base, "casos", caso);

            const solicitud = solicitudSchema.parse(
                await leerJson(path.join(carpeta, "solicitud.json")),
            );

            const plantilla =
                solicitud.formato === "xlsx"
                    ? "plantilla-celdas.json"
                    : "plantilla-campos.json";

            const oficiales = z.array(campoSchema).parse(
                await leerJson(path.join(carpeta, plantilla)),
            );

            // El modelo no puede agregar campos ajenos a la plantilla.
            if (
                JSON.stringify(campos) !== JSON.stringify(oficiales)
            ) {
                return JSON.stringify({
                    ok: false,
                    error:
                        "Los campos no coinciden con la plantilla oficial. " +
                        "Vuelve a ejecutar leer_solicitud.",
                });
            }

            const maestro = await leerJson(
                path.join(base, "repositorio", "maestro.json"),
            );

            const glosario = z.record(z.string(), z.string()).parse(
                await leerJson(path.join(base, "glosario-campos.json")),
            );

            const equivalencias = new Map(
                Object.entries(glosario).map(([etiqueta, ruta]) => [
                    normalizar(etiqueta),
                    ruta,
                ]),
            );

            const mapeo: Mapeo = {
                llenos: [],
                faltantes: [],
                requiere_confirmacion: [],
            };

            for (const campo of oficiales) {
                const ruta = equivalencias.get(
                    normalizar(campo.etiqueta),
                );

                const valor = valorSchema.safeParse(
                    ruta ? obtenerValor(maestro, ruta) : undefined,
                );

                if (!valor.success || valor.data === "") {
                    mapeo.faltantes.push({
                        etiqueta: campo.etiqueta,
                        estado: "faltante",
                        confianza: 0,
                        nota: "No existe un valor disponible en el maestro.",
                    });

                    continue;
                }

                const extranjero =
                    ruta === "nit" && solicitud.pais !== "CO";

                const ambiguo =
                    ruta === "nit" &&
                    !["nit", "ruc", "rtn"].includes(
                        normalizar(campo.etiqueta),
                    );

                const requiereConfirmacion = extranjero || ambiguo;

                const resultado: CampoMapeado = {
                    etiqueta: campo.etiqueta,
                    estado: requiereConfirmacion
                        ? "requiere_confirmacion"
                        : "lleno",
                    ruta,
                    valor: valor.data,
                    confianza: 1,
                };

                if (extranjero) {
                    resultado.nota =
                        "identificador extranjero: se utiliza el NIT " +
                        "colombiano; requiere revisión humana.";
                } else if (ambiguo) {
                    resultado.nota =
                        "Etiqueta tributaria ambigua: se propone NIT.";
                }

                if (requiereConfirmacion) {
                    mapeo.requiere_confirmacion.push(resultado);
                } else {
                    mapeo.llenos.push(resultado);
                }
            }

            await registrar(
                ctx,
                caso,
                true,
                "proveedor_mapear_campos",
            );

            return JSON.stringify({
                ok: true,
                data: mapeo,
            });
        } catch {
            try {
                await registrar(
                    ctx,
                    caso,
                    false,
                    "proveedor_mapear_campos",
                );
            } catch {
                // No propagar un fallo del registro.
            }

            return JSON.stringify({
                ok: false,
                error:
                    "No se pudieron mapear los campos. " +
                    "Revisa el caso, el glosario y el maestro.",
            });
        }
    },
};
export const generar_formulario = {
    description:
        "Genera el formulario del caso usando la plantilla oficial y valores verificados del maestro.",

    args: {
        caso: casoSchema,
        mapeo: mapeoSchema.describe(
            "Resultado obtenido de mapear_campos",
        ),
    },

    async execute(
        args: { caso: string; mapeo: Mapeo },
        ctx: Contexto,
    ): Promise<string> {
        const validacion = z.object(this.args).safeParse(args);

        if (!validacion.success) {
            return JSON.stringify({
                ok: false,
                error: "Caso o mapeo inválido.",
            });
        }

        const { caso, mapeo } = validacion.data;

        try {
            const carpeta = path.resolve(
                ctx.directory,
                "fixtures",
                "reto-01",
                "casos",
                caso,
            );

            const solicitud = solicitudSchema.parse(
                await leerJson(path.join(carpeta, "solicitud.json")),
            );

            const plantilla = solicitud.formato === "xlsx" ? "plantilla-celdas.json" : "plantilla-campos.json";
            const campos = z.array(campoSchema).parse(
                await leerJson(path.join(carpeta, plantilla)),
            );

            // Recalcular impide escribir valores inventados por el modelo.
            const verificacion = z.object({
                ok: z.boolean(),
                data: mapeoSchema.optional(),
            }).parse(
                JSON.parse(
                    await mapear_campos.execute({ caso, campos }, ctx),
                ),
            );

            if (
                !verificacion.ok ||
                !verificacion.data ||
                JSON.stringify(mapeo) !==
                JSON.stringify(verificacion.data)
            ) {
                return JSON.stringify({
                    ok: false,
                    error:
                        "El mapeo no coincide con el maestro. " +
                        "Ejecuta nuevamente mapear_campos.",
                });
            }

            const valores = new Map(
                [
                    ...verificacion.data.llenos,
                    ...verificacion.data.faltantes,
                    ...verificacion.data.requiere_confirmacion,
                ].map((campo) => [campo.etiqueta, campo]),
            );

            if (solicitud.formato !== "xlsx") {
                const salida = path.resolve(ctx.directory, "out", caso);
                await mkdir(salida, { recursive: true });

                const camposOrdenados = campos.map((campo) => {
                    const dato = valores.get(campo.etiqueta);

                    if (!dato) {
                        throw new Error("Campo sin mapeo");
                    }

                    return dato;
                });

                if (solicitud.formato === "pdf") {
                    await generarPdf(salida, camposOrdenados);
                } else {
                    await generarValoresPortal(salida, camposOrdenados);
                }

                await writeFile(path.join(salida, "mapeo.json"), JSON.stringify(verificacion.data, null, 2),
                );

                await registrar(
                    ctx,
                    caso,
                    true,
                    "proveedor_generar_formulario",
                );

                return JSON.stringify({
                    ok: true,
                    data: {
                        ruta: solicitud.formato === "pdf" ? `out/${caso}/formulario.pdf` : `out/${caso}/valores-portal.md`,
                        formato: solicitud.formato,
                        aviso: solicitud.formato === "portal" ? "formato no soportado" : null,
                    },
                });
            }

            const libro = new ExcelJS.Workbook();
            libro.created = new Date("2026-01-01T00:00:00Z");
            libro.modified = new Date("2026-01-01T00:00:00Z");

            for (const campo of campos) {
                const coordenada = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;

                if (
                    !campo.hoja ||
                    campo.hoja.length > 31 ||
                    /[\\/*?:[\]]/.test(campo.hoja) ||
                    !coordenada.test(campo.celda_etiqueta ?? "") ||
                    !coordenada.test(campo.celda_valor ?? "")
                ) {
                    throw new Error("Coordenadas inválidas");
                }

                const hoja =
                    libro.getWorksheet(campo.hoja) ??
                    libro.addWorksheet(campo.hoja);

                const dato = valores.get(campo.etiqueta);

                if (!dato) {
                    throw new Error("Campo sin mapeo");
                }

                const etiqueta = hoja.getCell(campo.celda_etiqueta!);
                const celda = hoja.getCell(campo.celda_valor!);

                etiqueta.value = campo.etiqueta;
                etiqueta.font = { bold: true };

                // Conserva números como números e identificadores como texto.
                celda.value = dato.valor ?? "";
                celda.alignment = { wrapText: true };

                if (dato.estado !== "lleno") {
                    celda.note = dato.nota ?? dato.estado;
                    celda.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FFFFE6A3" },
                    };
                }

                hoja.getColumn(etiqueta.col).width = 36;
                hoja.getColumn(celda.col).width = 75;
            }

            const salida = path.resolve(ctx.directory, "out", caso);
            await mkdir(salida, { recursive: true });

            await libro.xlsx.writeFile(
                path.join(salida, "formulario.xlsx"),
            );

            await writeFile(
                path.join(salida, "mapeo.json"),
                JSON.stringify(verificacion.data, null, 2),
            );

            await registrar(
                ctx,
                caso,
                true,
                "proveedor_generar_formulario",
            );

            return JSON.stringify({
                ok: true,
                data: {
                    ruta: `out/${caso}/formulario.xlsx`,
                    formato: "xlsx",
                },
            });
        } catch {
            try {
                await registrar(
                    ctx,
                    caso,
                    false,
                    "proveedor_generar_formulario",
                );
            } catch {
                // No propagar errores del registro.
            }

            return JSON.stringify({
                ok: false,
                error:
                    "No se pudo generar el formulario. Revisa la plantilla, " +
                    "los permisos y que el archivo de salida esté cerrado.",
            });
        }
    },
};
const soporteSchema = z.object({
    tipo: z.string(),
    archivo: z
        .string()
        .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/),
    vigencia_hasta: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
    pais_emisor: z.string(),
});

interface ItemChecklist {
    tipo: string;
    estado: "presente" | "ausente" | "vencido";
    vigencia_hasta: string | null;
}

export const armar_paquete = {
    description:
        "Prepara el formulario, soportes, checklist de vigencias y borrador de correo sin enviar nada.",

    args: {
        caso: casoSchema,
    },

    async execute(
        args: { caso: string },
        ctx: Contexto,
    ): Promise<string> {
        const validacion = casoSchema.safeParse(args.caso);

        if (!validacion.success) {
            return JSON.stringify({
                ok: false,
                error: "Nombre de caso inválido.",
            });
        }

        const caso = validacion.data;

        try {
            const base = path.resolve(
                ctx.directory,
                "fixtures",
                "reto-01",
            );

            const carpetaCaso = path.join(base, "casos", caso);

            const solicitud = solicitudSchema.parse(
                await leerJson(
                    path.join(carpetaCaso, "solicitud.json"),
                ),
            );

            const exigidos = z.array(z.string()).parse(
                await leerJson(
                    path.join(carpetaCaso, "soportes-exigidos.json"),
                ),
            );

            const carpetaSoportes = path.join(
                base,
                "repositorio",
                "soportes",
            );

            const soportes = z.array(soporteSchema).parse(
                await leerJson(
                    path.join(carpetaSoportes, "index.json"),
                ),
            );

            const salida = path.resolve(ctx.directory, "out", caso);

            // Se usa el mapeo generado previamente por la herramienta.
            const mapeo = mapeoSchema.parse(
                await leerJson(path.join(salida, "mapeo.json")),
            );

            const nombreFormulario =
                solicitud.formato === "portal"
                    ? "valores-portal.md"
                    : `formulario.${solicitud.formato}`;

            const formulario = path.join(
                salida,
                nombreFormulario,
            );

            await access(formulario);

            const paquete = path.join(salida, "paquete");
            await mkdir(paquete, { recursive: true });

            await copyFile(
                formulario,
                path.join(paquete, nombreFormulario),
            );

            // Fecha de ejecución en Colombia, en formato YYYY-MM-DD.
            const partes = new Intl.DateTimeFormat("en-US", {
                timeZone: "America/Bogota",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            }).formatToParts(new Date());

            const parte = (tipo: string): string =>
                partes.find((item) => item.type === tipo)?.value ?? "";

            const hoy =
                `${parte("year")}-${parte("month")}-${parte("day")}`;

            const checklist: ItemChecklist[] = [];

            for (const tipo of exigidos) {
                const soporte = soportes.find(
                    (item) => item.tipo === tipo,
                );

                let existe = false;

                if (soporte) {
                    try {
                        await access(
                            path.join(carpetaSoportes, soporte.archivo),
                        );
                        existe = true;
                    } catch {
                        existe = false;
                    }
                }

                let estado: ItemChecklist["estado"] = "ausente";

                if (existe && soporte) {
                    estado =
                        soporte.vigencia_hasta &&
                            soporte.vigencia_hasta < hoy
                            ? "vencido"
                            : "presente";

                    await copyFile(
                        path.join(carpetaSoportes, soporte.archivo),
                        path.join(paquete, soporte.archivo),
                    );
                }

                checklist.push({
                    tipo,
                    estado,
                    vigencia_hasta: soporte?.vigencia_hasta ?? null,
                });
            }

            const listo_para_firma =
                solicitud.formato !== "portal" &&
                checklist.every(
                    (item) => item.estado === "presente",
                );

            const faltantes = mapeo.faltantes.map(
                (campo) => `- ${campo.etiqueta}`,
            );

            const confirmaciones = mapeo.requiere_confirmacion.map(
                (campo) => `- ${campo.etiqueta}: ${campo.nota}`,
            );

            const contenidoChecklist = [
                "# Checklist para revisión humana",
                "",
                `Fecha de ejecución: ${hoy}`,
                `Listo para firma: ${listo_para_firma ? "sí" : "no"}`,
                "",
                "## Soportes",
                ...checklist.map(
                    (item) =>
                        `- ${item.tipo}: **${item.estado}**. ` +
                        `Vigencia: ${item.vigencia_hasta ?? "sin vencimiento registrado"}`,
                ),
                "",
                "## Campos faltantes",
                ...(faltantes.length ? faltantes : ["Ninguno."]),
                "",
                "Los campos faltantes no bloquean según RN3.",
                "",
                "## Confirmaciones pendientes",
                ...(confirmaciones.length
                    ? confirmaciones
                    : ["Ninguna."]),
                "",
                "La revisión y firma corresponden al humano.",
            ].join("\n");

            await writeFile(
                path.join(paquete, "checklist.md"),
                contenidoChecklist,
            );

            const reporteFaltantes = [
                "# Reporte de campos faltantes",
                "",
                ...(faltantes.length ? faltantes : ["Ninguno."]),
                "",
                "## Requiere confirmación",
                ...(confirmaciones.length
                    ? confirmaciones
                    : ["Ninguna."]),
            ].join("\n");

            await writeFile(
                path.join(salida, "faltantes.md"),
                reporteFaltantes,
            );

            // Texto fijo: no incorpora datos bancarios del maestro.
            const borrador = [
                "# Borrador de correo — no enviado",
                "",
                "Asunto: Registro como proveedor — revisión documental",
                "",
                "Estimados:",
                "",
                "Se ha preparado el formulario de registro y los soportes",
                "disponibles para revisión del representante legal.",
                "",
                "Antes de firmar o enviar, deben revisarse el checklist,",
                "los soportes pendientes y las observaciones del formulario.",
                "",
                "Este borrador no acredita firma ni envío.",
            ].join("\n");

            await writeFile(
                path.join(paquete, "borrador-correo.md"),
                borrador,
            );

            await registrar(
                ctx,
                caso,
                true,
                "proveedor_armar_paquete",
            );

            return JSON.stringify({
                ok: true,
                data: {
                    ruta: `out/${caso}/paquete`,
                    listo_para_firma,
                    checklist,
                    faltantes: mapeo.faltantes,
                    requiere_confirmacion: mapeo.requiere_confirmacion,
                },
            });
        } catch {
            try {
                await registrar(
                    ctx,
                    caso,
                    false,
                    "proveedor_armar_paquete",
                );
            } catch {
                // No propagar errores del registro.
            }

            return JSON.stringify({
                ok: false,
                error:
                    "No se pudo armar el paquete. Genera primero el " +
                    "formulario y revisa los archivos y permisos de salida.",
            });
        }
    },
};
export const simular_envio = {
    description:
        "Registra un envío simulado del paquete únicamente con confirmación humana validada por el backend.",

    args: {
        caso: casoSchema,
        confirmado: z
            .boolean()
            .describe("Confirmación humana validada por el backend"),
    },

    async execute(
        args: { caso: string; confirmado: boolean },
        ctx: Contexto,
    ): Promise<string> {
        const validacion = z.object(this.args).safeParse(args);

        if (!validacion.success) {
            return JSON.stringify({
                ok: false,
                error: "Caso o confirmación inválidos.",
            });
        }

        const { caso, confirmado } = validacion.data;

        try {
            if (!confirmado) {
                await registrar(
                    ctx,
                    caso,
                    false,
                    "proveedor_simular_envio",
                );

                return JSON.stringify({
                    ok: false,
                    error: "requiere confirmación explícita",
                });
            }

            const salida = path.resolve(ctx.directory, "out", caso);

            await access(
                path.join(salida, "paquete", "checklist.md"),
            );

            await writeFile(
                path.join(salida, "ENVIO-SIMULADO.md"),
                [
                    "# Envío simulado",
                    "",
                    "Simulación autorizada mediante confirmación humana.",
                    "",
                    "No se enviaron correos, no se firmaron documentos",
                    "y no se cargó información a ningún portal.",
                    "",
                    "Esta simulación no resuelve las observaciones",
                    "del checklist ni acredita estar listo para firma.",
                ].join("\n"),
            );

            await registrar(
                ctx,
                caso,
                true,
                "proveedor_simular_envio",
            );

            return JSON.stringify({
                ok: true,
                data: {
                    ruta: `out/${caso}/ENVIO-SIMULADO.md`,
                },
            });
        } catch {
            try {
                await registrar(
                    ctx,
                    caso,
                    false,
                    "proveedor_simular_envio",
                );
            } catch {
                // No propagar errores del registro.
            }

            return JSON.stringify({
                ok: false,
                error:
                    "No se pudo registrar la simulación. " +
                    "Prepara primero el paquete y revisa los permisos.",
            });
        }
    },
};