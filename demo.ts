import { readdir, rm } from "node:fs/promises";
import { z } from "zod";
import {
    leer_solicitud,
    mapear_campos,
    generar_formulario,
    armar_paquete,
    simular_envio,
} from "./src/tools/proveedor.js";

const ctx = {
    directory: process.cwd(),
    sessionId: "demo-sin-modelo",
};

await rm("out", { recursive: true, force: true });
const carpetas = await readdir("fixtures/reto-01/casos", { withFileTypes: true });
for (const caso of carpetas.filter(c => c.isDirectory()).map(c => c.name).sort()) {
    try {
    const lectura = z.object({
        ok: z.boolean(),
        data: z.object({
            campos: mapear_campos.args.campos,
        }).optional(),
    }).parse(
        JSON.parse(
            await leer_solicitud.execute({ caso }, ctx),
        ),
    );

    if (!lectura.ok || !lectura.data) {
        console.log(caso, "No se pudo leer la solicitud");
        continue;
    }

    const mapeo = z.object({
        ok: z.boolean(),
        data: generar_formulario.args.mapeo.optional(),
    }).parse(
        JSON.parse(
            await mapear_campos.execute(
                { caso, campos: lectura.data.campos },
                ctx,
            ),
        ),
    );

    if (!mapeo.ok || !mapeo.data) {
        console.log(caso, "No se pudo mapear");
        continue;
    }

    const resultado = await generar_formulario.execute(
        { caso, mapeo: mapeo.data },
        ctx,
    );

    console.log(`\nCASO: ${caso}`);
    console.log("FORMULARIO:");
    console.log(JSON.stringify(JSON.parse(resultado), null, 2));

    const paquete = await armar_paquete.execute(
        { caso },
        ctx,
    );

    console.log("PAQUETE:");
    console.log(JSON.stringify(JSON.parse(paquete), null, 2));
    } catch {
        console.log(caso, "Caso no procesable; se continúa con el siguiente.");
    }
}

// Esta prueba debe rechazar la simulación.
console.log("\nPRUEBA SIN CONFIRMACIÓN:");

const simulacion = await simular_envio.execute(
    {
        caso: "co-industrias-delta",
        confirmado: false,
    },
    ctx,
);

console.log(JSON.stringify(JSON.parse(simulacion), null, 2));