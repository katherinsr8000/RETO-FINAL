import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

interface CampoSalida {
  etiqueta: string;
  valor?: string | number | boolean;
  estado: string;
  nota?: string;
}

export async function generarPdf(
  salida: string,
  campos: CampoSalida[],
): Promise<void> {
  const documento = await PDFDocument.create();

  const fecha = new Date("2026-01-01T00:00:00Z");
  documento.setCreationDate(fecha);
  documento.setModificationDate(fecha);

  const fuente = await documento.embedFont(
    StandardFonts.Helvetica,
  );

  let pagina = documento.addPage([595, 842]);
  let y = 795;

  function escribir(texto: string, tamano = 10): void {
    const palabras = texto.split(/\s+/);
    let linea = "";

    function dibujar(): void {
      if (y < 55) {
        pagina = documento.addPage([595, 842]);
        y = 795;
      }

      pagina.drawText(linea, {
        x: 45,
        y,
        size: tamano,
        font: fuente,
      });

      y -= tamano + 6;
    }

    for (const palabra of palabras) {
      const propuesta = linea
        ? `${linea} ${palabra}`
        : palabra;

      if (
        linea &&
        fuente.widthOfTextAtSize(propuesta, tamano) > 505
      ) {
        dibujar();
        linea = palabra;
      } else {
        linea = propuesta;
      }
    }

    if (linea) dibujar();
  }

  escribir("Registro como proveedor", 18);
  escribir("Documento preparado para revisión humana.");
  y -= 12;

  for (const campo of campos) {
    escribir(
      `${campo.etiqueta}: ${campo.valor ?? "[FALTANTE]"}`,
    );

    if (campo.estado !== "lleno") {
      escribir(
        `Revisión: ${campo.nota ?? campo.estado}`,
        9,
      );
    }

    y -= 10;
  }

  escribir("Sin firma y sin envío.", 9);

  await writeFile(
    path.join(salida, "formulario.pdf"),
    await documento.save(),
  );
}

export async function generarValoresPortal(
  salida: string,
  campos: CampoSalida[],
): Promise<void> {
  const contenido = [
    "# Formato no soportado: portal web",
    "",
    "Valores preparados para copiar manualmente.",
    "El humano ingresa las credenciales y realiza el envío.",
    "",
    ...campos.map(
      (campo) =>
        `- **${campo.etiqueta}**: ` +
        `${campo.valor ?? "[FALTANTE]"}` +
        (campo.nota ? ` — ${campo.nota}` : ""),
    ),
  ].join("\n");

  await writeFile(
    path.join(salida, "valores-portal.md"),
    contenido,
  );
}