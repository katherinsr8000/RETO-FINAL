import { z } from "zod";
import {
    leer_solicitud,
    mapear_campos,
    generar_formulario,
    armar_paquete,
    simular_envio,
} from "./proveedor.js";

import type {
    DefinicionHerramienta,
} from "../llm/adapter.js";

interface Contexto {
    directory: string;
    sessionId: string;
}

interface PermisoEnvio {
    caso: string;
}

function registrarHerramienta<T extends z.ZodRawShape>(
    nombre: string,
    herramienta: {
        description: string;
        args: T;
        execute: (
            args: z.infer<z.ZodObject<T>>,
            ctx: Contexto,
        ) => Promise<string>;
    },
) {
    const esquema = z.object(herramienta.args);

    const definicion: DefinicionHerramienta = {
        type: "function",
        function: {
            name: nombre,
            description: herramienta.description,
            parameters: z.toJSONSchema(esquema),
        },
    };

    return {
        definicion,

        async ejecutar(
            entrada: unknown,
            ctx: Contexto,
        ): Promise<string> {
            const validacion = esquema.safeParse(entrada);

            if (!validacion.success) {
                return JSON.stringify({
                    ok: false,
                    error:
                        "Argumentos inválidos para " + nombre,
                });
            }

            try {
                return await herramienta.execute(
                    validacion.data,
                    ctx,
                );
            } catch {
                return JSON.stringify({
                    ok: false,
                    error:
                        "No se pudo ejecutar " + nombre,
                });
            }
        },
    };
}

const registro = {
    proveedor_leer_solicitud: registrarHerramienta(
        "proveedor_leer_solicitud",
        leer_solicitud,
    ),

    proveedor_mapear_campos: registrarHerramienta(
        "proveedor_mapear_campos",
        mapear_campos,
    ),

    proveedor_generar_formulario: registrarHerramienta(
        "proveedor_generar_formulario",
        generar_formulario,
    ),

    proveedor_armar_paquete: registrarHerramienta(
        "proveedor_armar_paquete",
        armar_paquete,
    ),

    proveedor_simular_envio: registrarHerramienta(
        "proveedor_simular_envio",
        simular_envio,
    ),
};

type NombreHerramienta = keyof typeof registro;

function existeHerramienta(
    nombre: string,
): nombre is NombreHerramienta {
    return Object.hasOwn(registro, nombre);
}

export const definicionesHerramientas =
    Object.values(registro).map(
        (herramienta) => herramienta.definicion,
    );

export async function ejecutarHerramienta(
    nombre: string,
    entrada: unknown,
    ctx: Contexto,
    permisoEnvio?: PermisoEnvio,
): Promise<string> {
    if (!existeHerramienta(nombre)) {
        return JSON.stringify({
            ok: false,
            error: "Herramienta no reconocida.",
        });
    }

    if (nombre === "proveedor_simular_envio") {
        const validacion = z.object(
            simular_envio.args,
        ).safeParse(entrada);

        if (!validacion.success) {
            return JSON.stringify({
                ok: false,
                error: "Argumentos de simulación inválidos.",
            });
        }

        // El permiso proviene del backend, nunca del modelo.
        const autorizado =
            permisoEnvio?.caso === validacion.data.caso;

        return registro[nombre].ejecutar(
            {
                caso: validacion.data.caso,
                confirmado: autorizado,
            },
            ctx,
        );
    }

    return registro[nombre].ejecutar(entrada, ctx);
}