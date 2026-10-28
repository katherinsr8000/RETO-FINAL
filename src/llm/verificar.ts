import "dotenv/config";
import { z } from "zod";

const modelosSchema = z.object({
    models: z.array(
        z.object({
            name: z.string(),
            supportedGenerationMethods:
                z.array(z.string()).optional(),
        }),
    ),
});

async function verificar(): Promise<void> {
    const clave = process.env.GEMINI_API_KEY;

    if (!clave) {
        console.log(
            "No se encontró GEMINI_API_KEY. Revisa tu archivo .env.",
        );
        return;
    }

    try {
        const respuesta = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
            {
                headers: {
                    "x-goog-api-key": clave,
                },
                signal: AbortSignal.timeout(30000),
            },
        );

        if (!respuesta.ok) {
            console.log(
                `No se pudo consultar los modelos. Código HTTP: ${respuesta.status}`,
            );
            return;
        }

        const datos = modelosSchema.parse(
            await respuesta.json(),
        );

        const modelos = datos.models.filter(
            (modelo) =>
                modelo.name.includes("flash") &&
                !/image|audio|tts|live/i.test(modelo.name) &&
                modelo.supportedGenerationMethods?.includes(
                    "generateContent",
                ),
        );

        console.log("Conexión correcta. Modelos de texto:");

        for (const modelo of modelos) {
            console.log(
                modelo.name.replace(/^models\//, ""),
            );
        }
    } catch {
        console.log(
            "No se pudo verificar la conexión. Revisa tu conexión a internet e intenta nuevamente.",
        );
    }
}

await verificar();