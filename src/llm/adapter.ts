export interface LlamadaHerramienta {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
    [clave: string]: unknown;
}

export interface Mensaje {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: LlamadaHerramienta[];
    tool_call_id?: string;
    [clave: string]: unknown;
}

export interface DefinicionHerramienta {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: unknown;
    };
}

export interface RespuestaModelo {
    mensaje: Mensaje;
    tokens: number;
}

export interface AdaptadorLLM {
    enviar(
        mensajes: Mensaje[],
        herramientas: DefinicionHerramienta[],
        maxTokens: number,
    ): Promise<RespuestaModelo>;
}

export class ErrorModelo extends Error {
    constructor(mensajeSeguro: string) {
        super(mensajeSeguro);
        this.name = "ErrorModelo";
    }
}