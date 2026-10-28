import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';

const ignorados = new Set(['node_modules', 'out', '.git']);
const problemas: string[] = [];
let archivos = 0;
let secretosLocales: string[] = [];
try {
    const entorno = parse(await readFile('.env'));
    secretosLocales = Object.entries(entorno)
        .filter(([nombre, valor]) => /KEY|SECRET|TOKEN|PASSWORD/i.test(nombre) && valor.length > 12)
        .map(([, valor]) => valor);
} catch { /* El análisis no requiere .env ni una clave. */ }
const patrones = [
    new RegExp('AI' + 'za[0-9A-Za-z_-]{35}'),
    new RegExp('s' + 'k-(?:proj-)?[a-zA-Z0-9_-]{20,}'),
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
async function revisar(directorio: string): Promise<void> {
    for (const entrada of await readdir(directorio, { withFileTypes: true })) {
        if (ignorados.has(entrada.name) || entrada.isSymbolicLink()) continue;
        const archivo = path.join(directorio, entrada.name);
        if (entrada.isDirectory()) { await revisar(archivo); continue; }
        if (/^\.env(?:\.|$)/.test(entrada.name) && entrada.name !== '.env.example') continue;
        if (/\.(?:zip|png|jpg|pdf|xlsx)$/i.test(archivo)) continue;
        const texto = await readFile(archivo, 'utf8');
        archivos++;
        if (patrones.some(p => p.test(texto)) || secretosLocales.some(secreto => texto.includes(secreto))) {
            problemas.push(archivo);
        }
        if (entrada.name === '.env.example') {
            if (Object.values(parse(texto)).some(valor => valor !== '')) problemas.push(archivo + ' (ejemplo con valores)');
        }
    }
}
await revisar('.');
if (problemas.length) {
    console.error('Posibles secretos detectados. No se imprime su contenido. Revisa estos archivos:');
    for (const archivo of [...new Set(problemas)]) console.error(archivo);
    process.exitCode = 1;
} else {
    console.log(`Revisión local completada: ${archivos} archivos, sin coincidencias de los patrones ni de secretos del .env local.`);
    console.log('Este análisis no garantiza ausencia de todo secreto ni revisa el historial de Git.');
}
