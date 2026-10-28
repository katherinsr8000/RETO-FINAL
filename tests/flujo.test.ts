import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { AgenteProveedor } from '../src/agente.js';
import { ErrorModelo } from '../src/llm/adapter.js';
import type { AdaptadorLLM, Mensaje, DefinicionHerramienta, RespuestaModelo } from '../src/llm/adapter.js';
import { AdaptadorGemini } from '../src/llm/gemini.js';
import * as proveedor from '../src/tools/proveedor.js';
import { ejecutarHerramienta } from '../src/tools/registro.js';

async function proyectoTemporal() {
    const dir = await mkdtemp(path.join(tmpdir(), 'registro-prueba-'));
    for (const nombre of ['fixtures', 'agent', 'src/knowledge']) {
        await cp(path.resolve(nombre), path.join(dir, nombre), { recursive: true });
    }
    return dir;
}
const resultSchema = z.object({ok:z.boolean(),data:z.unknown().optional(),error:z.string().optional()});
const decodificar = (s:string) => resultSchema.parse(JSON.parse(s));
async function procesar(caso:string, directory:string) {
    const ctx={directory,sessionId:'prueba'};
    const lectura=decodificar(await proveedor.leer_solicitud.execute({caso},ctx));
    assert.equal(lectura.ok,true);
    const campos=proveedor.mapear_campos.args.campos.parse((lectura.data as {campos:unknown}).campos);
    const mapeo=decodificar(await proveedor.mapear_campos.execute({caso,campos},ctx));
    assert.equal(mapeo.ok,true);
    const datos=proveedor.generar_formulario.args.mapeo.parse(mapeo.data);
    const form=decodificar(await proveedor.generar_formulario.execute({caso,mapeo:datos},ctx));
    assert.equal(form.ok,true);
    const paquete=decodificar(await proveedor.armar_paquete.execute({caso},ctx));
    assert.equal(paquete.ok,true);
    return {datos,paquete,ctx};
}

test('cuatro fixtures: celdas exactas, PDF, portal, faltantes, vigencias y banco fuera del correo', async()=>{
    const dir=await proyectoTemporal();
    try {
        for(const [caso,llenos,faltantes,confirmaciones] of [
            ['co-industrias-delta',17,0,0],['ec-corp-andina',13,1,1],
            ['hn-agroexport-sula',9,1,1],['pa-logistica-istmo',8,0,1],
        ] as const) {
            const {datos,paquete}=await procesar(caso,dir);
            assert.equal(datos.llenos.length,llenos);assert.equal(datos.faltantes.length,faltantes);
            assert.equal(datos.requiere_confirmacion.length,confirmaciones);
            if(confirmaciones) assert.equal(datos.requiere_confirmacion[0].ruta,'nit');
            const data=paquete.data as {checklist:{tipo:string;estado:string}[]};
            if(caso==='ec-corp-andina')assert.ok(data.checklist.some(c=>c.tipo==='certificado_cumplimiento_tributario'&&c.estado==='ausente'));
            const correo=await readFile(path.join(dir,'out',caso,'paquete/borrador-correo.md'),'utf8');
            assert.ok(!correo.includes('03100012345'));assert.ok(!correo.includes('COLOCOBM'));
            await access(path.join(dir,'out',caso,'faltantes.md'));
        }
        const libro=new ExcelJS.Workbook();await libro.xlsx.readFile(path.join(dir,'out/co-industrias-delta/formulario.xlsx'));
        const plantilla=JSON.parse(await readFile(path.join(dir,'fixtures/reto-01/casos/co-industrias-delta/plantilla-celdas.json'),'utf8')) as {hoja:string;celda_etiqueta:string;etiqueta:string;celda_valor:string}[];
        for(const campo of plantilla) assert.equal(libro.getWorksheet(campo.hoja)?.getCell(campo.celda_etiqueta).value,campo.etiqueta);
        assert.equal(libro.getWorksheet('Datos Bancarios')?.getCell('C5').value,'03100012345');
        const hn=new ExcelJS.Workbook();await hn.xlsx.readFile(path.join(dir,'out/hn-agroexport-sula/formulario.xlsx'));
        assert.ok(hn.getWorksheet('Registro')?.getCell('B3').note);
        assert.ok([null, ''].includes(hn.getWorksheet('Registro')?.getCell('B12').value as null|string));
        const pdf=await PDFDocument.load(await readFile(path.join(dir,'out/ec-corp-andina/formulario.pdf')));
        assert.ok(pdf.getPageCount()>=1);
        const portal=await readFile(path.join(dir,'out/pa-logistica-istmo/valores-portal.md'),'utf8');
        assert.match(portal,/Formato no soportado/);assert.match(portal,/identificador extranjero/);
        // La regla RN3 permite faltantes cuando todos los soportes sí están vigentes.
        const indice=path.join(dir,'fixtures/reto-01/repositorio/soportes/index.json');
        const soportes=JSON.parse(await readFile(indice,'utf8')) as {vigencia_hasta:string|null}[];
        for(const soporte of soportes)if(soporte.vigencia_hasta)soporte.vigencia_hasta='2099-12-31';
        await writeFile(indice,JSON.stringify(soportes));
        const {paquete}=await procesar('hn-agroexport-sula',dir);
        assert.equal((paquete.data as {listo_para_firma:boolean}).listo_para_firma,true);
        const ecuador=await procesar('ec-corp-andina',dir);
        assert.equal((ecuador.paquete.data as {listo_para_firma:boolean}).listo_para_firma,false);
    }finally{await rm(dir,{recursive:true,force:true});}
});

test('errores seguros, rutas restringidas y confirmación falsificada por el modelo',async()=>{
    const dir=await proyectoTemporal();const ctx={directory:dir,sessionId:'prueba'};
    try{
        assert.equal(decodificar(await proveedor.leer_solicitud.execute({caso:'../otro'},ctx)).ok,false);
        assert.equal(decodificar(await proveedor.leer_solicitud.execute({caso:'inexistente'},ctx)).ok,false);
        assert.equal(decodificar(await ejecutarHerramienta('proveedor_simular_envio',{caso:'co-industrias-delta',confirmado:true},ctx)).error,'requiere confirmación explícita');
        const {datos}=await procesar('co-industrias-delta',dir);
        datos.llenos[0].valor='Inventado';
        assert.equal(decodificar(await proveedor.generar_formulario.execute({caso:'co-industrias-delta',mapeo:datos},ctx)).ok,false);
        await writeFile(path.join(dir,'fixtures/reto-01/casos/co-industrias-delta/plantilla-celdas.json'),'{corrupto');
        assert.equal(decodificar(await proveedor.leer_solicitud.execute({caso:'co-industrias-delta'},ctx)).ok,false);
        assert.equal(decodificar(await proveedor.leer_solicitud.execute({caso:'ec-corp-andina'},ctx)).ok,true);
    }finally{await rm(dir,{recursive:true,force:true});}
});

// Simula decisiones del modelo: las herramientas y los archivos son los reales.
class ModeloDePrueba implements AdaptadorLLM {
    constructor(private caso='ec-corp-andina'){}
    async enviar(mensajes:Mensaje[],herramientas:DefinicionHerramienta[]):Promise<RespuestaModelo>{
        const nombre=herramientas[0].function.name;
        const ultimos=mensajes.filter(m=>m.role==='tool');
        const ultimo=ultimos.at(-1)?.content;
        const data=ultimo?decodificar(ultimo).data:undefined;
        const args:Record<string,unknown>={caso:this.caso};
        if(nombre==='proveedor_mapear_campos')args.campos=(data as {campos:unknown}).campos;
        if(nombre==='proveedor_generar_formulario')args.mapeo=data;
        return {mensaje:{role:'assistant',content:null,tool_calls:[{
            id:`call-${ultimos.length}`,type:'function',function:{name:nombre,arguments:JSON.stringify(args)},
        }]},tokens:100};
    }
}

test('agente completo, resumen desde herramientas y confirmación humana de un solo uso',async()=>{
    const dir=await proyectoTemporal();
    try{
        const agente=new AgenteProveedor(new ModeloDePrueba(),dir);
        const turno=await agente.conversar('sesion','Procesa ec-corp-andina. No envíes nada todavía.');
        assert.deepEqual(turno.toolCalls.map(e=>e.name),[
            'proveedor_leer_solicitud','proveedor_mapear_campos','proveedor_generar_formulario','proveedor_armar_paquete',
        ]);
        assert.ok(turno.toolCalls.every(e=>resultSchema.parse(e.result).ok));
        assert.equal(turno.needsConfirmation,true);assert.match(turno.reply,/Número de contribuyente especial/);
        assert.match(turno.reply,/Listo para firma: No/);
        await assert.rejects(access(path.join(dir,'out/ec-corp-andina/ENVIO-SIMULADO.md')));
        const confirmado=await agente.conversar('sesion','confirmo');
        assert.equal(confirmado.needsConfirmation,false);
        assert.equal(confirmado.toolCalls[0].name,'proveedor_simular_envio');
        await access(path.join(dir,'out/ec-corp-andina/ENVIO-SIMULADO.md'));
        const sinPermiso=await agente.conversar('otra-sesion','confirmo');
        assert.ok(!sinPermiso.toolCalls.some(e=>e.name==='proveedor_simular_envio'));
    }finally{await rm(dir,{recursive:true,force:true});}
});

test('un 503 parcial no produce paquete ni confirmación',async()=>{
    const dir=await proyectoTemporal();let llamadas=0;
    const base=new ModeloDePrueba();
    const modelo:AdaptadorLLM={async enviar(m,t,max){if(llamadas++>0)throw new ErrorModelo('HTTP 503: servicio no disponible');return base.enviar(m,t);}};
    try{
        const agente=new AgenteProveedor(modelo,dir);
        const turno=await agente.conversar('fallo','Procesa Ecuador');
        assert.equal(turno.toolCalls.length,1);assert.equal(turno.needsConfirmation,false);
        assert.match(turno.reply,/HTTP 503/);
        await assert.rejects(access(path.join(dir,'out/ec-corp-andina/paquete/checklist.md')));
    }finally{await rm(dir,{recursive:true,force:true});}
});

test('adaptador nativo conserva firmas, envía functionResponse y no expone la clave',async()=>{
    const anterior=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='credencial-ficticia-prueba';
    let contador=0;
    const transporte:typeof fetch=async(url,init)=>{
        assert.ok(String(url).includes(':generateContent'));assert.ok(!String(url).includes('credencial-ficticia-prueba'));
        const body=JSON.parse(String(init?.body)) as {contents:{parts:Record<string,unknown>[]}[]};
        assert.ok(!String(init?.body).includes('credencial-ficticia-prueba'));
        if(contador++===0)return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{
            thoughtSignature:'firma-opaca-prueba',functionCall:{id:'nativa-1',name:'proveedor_leer_solicitud',args:{caso:'ec-corp-andina'}},
        }]},finishReason:'STOP'}],usageMetadata:{totalTokenCount:12}}),{status:200});
        assert.equal(body.contents[1].parts[0].thoughtSignature,'firma-opaca-prueba');
        const respuesta=body.contents[2].parts[0].functionResponse as {id:string;name:string};
        assert.equal(respuesta.id,'nativa-1');assert.equal(respuesta.name,'proveedor_leer_solicitud');
        return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'OK'}]}}]}),{status:200});
    };
    try{
        const adaptador=new AdaptadorGemini(transporte);const mensajes:Mensaje[]=[{role:'user',content:'Procesa Ecuador'}];
        const respuesta=await adaptador.enviar(mensajes,[],1024);assert.equal(respuesta.mensaje.tool_calls?.length,1);
        mensajes.push(respuesta.mensaje,{role:'tool',tool_call_id:'nativa-1',content:'{"ok":true,"data":{}}'});
        assert.equal((await adaptador.enviar(mensajes,[],1024)).mensaje.content,'OK');
    }finally{if(anterior===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=anterior;}
});

test('503 reintenta solo una vez; 429 no reintenta y nunca filtra el cuerpo del error',async()=>{
    const anterior=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='credencial-ficticia-prueba';
    try{
        let n=0;
        const transporte:typeof fetch=async()=>{n++;return new Response('cuerpo privado',{status:503});};
        await assert.rejects(new AdaptadorGemini(transporte).enviar([{role:'user',content:'Hola'}],[],1024),/HTTP 503/);
        assert.equal(n,2);n=0;
        const cuota:typeof fetch=async()=>{n++;return new Response('cuerpo privado',{status:429});};
        await assert.rejects(new AdaptadorGemini(cuota).enviar([{role:'user',content:'Hola'}],[],1024),/HTTP 429/);
        assert.equal(n,1);
    }finally{if(anterior===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=anterior;}
});
