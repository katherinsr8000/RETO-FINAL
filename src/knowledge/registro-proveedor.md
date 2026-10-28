# Conocimiento del registro de proveedores

## Datos oficiales

Los archivos de fixtures/reto-01 son de solo lectura.
Contienen datos ficticios para la evaluación.

El glosario relaciona etiquetas con rutas del maestro.
Un campo sin valor disponible se reporta como faltante.

## Identificación tributaria

- Colombia: NIT.
- Ecuador, Perú y Panamá: RUC.
- Honduras: RTN.

El maestro solo contiene NIT colombiano.
Para clientes extranjeros se utiliza ese NIT y se marca
requiere_confirmacion con la nota "identificador extranjero".

Las etiquetas tributarias ambiguas también requieren confirmación.

El país del proveedor proviene del maestro.
El país del cliente proviene de la solicitud.

## Soportes y revisión

Un soporte exigido ausente o vencido bloquea listo_para_firma.
La vigencia se compara con la fecha de ejecución en Colombia.

Un campo faltante se informa, pero no bloquea según RN3.
Las confirmaciones pendientes deben quedar visibles para revisión.

## Datos bancarios

Solo se incluyen en campos solicitados expresamente.
Nunca se incorporan al borrador de correo.

## Formatos

Excel respeta las hojas y coordenadas de la plantilla JSON.
PDF reproduce los campos en el orden de la plantilla JSON.
Los archivos originales de Excel y PDF no fueron suministrados.

El portal no se automatiza: se preparan valores para copiar.
Las credenciales y el envío corresponden al humano.