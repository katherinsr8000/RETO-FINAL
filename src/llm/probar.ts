import 'dotenv/config';
import { AdaptadorGemini } from './gemini.js';
import { ErrorModelo } from './adapter.js';
try {
    const respuesta = await new AdaptadorGemini().enviar([
        { role: 'user', content: 'Responde únicamente: OK' },
    ], [], 1024);
    console.log('Adaptador nativo: conexión correcta.');
    console.log('Contiene texto:', Boolean(respuesta.mensaje.content));
    console.log('Tokens reportados:', respuesta.tokens);
} catch (error: unknown) {
    console.error(error instanceof ErrorModelo ? error.message : 'La prueba no pudo completarse.');
    process.exitCode = 1;
}
