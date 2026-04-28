// Tipos del bucle agentico. Alineados con el contrato C++ (`tool_protocol.h`)
// y con lo que espera /query/agent/stream del backend.

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  is_error?: boolean;
}

export interface AgentDonePayload {
  answer?: string;
  cancelled?: boolean;
  time_ms?: number;
  tool_calls?: ToolCall[];
  finish_reason?: string;
  conversation_id?: string;
}

export type AgentLoopEvent =
  | { type: "iteration-start"; iteration: number }
  | { type: "request-started"; iteration: number; requestId: number }
  | { type: "token"; iteration: number; text: string }
  | { type: "tool-call"; iteration: number; call: ToolCall }
  | { type: "tool-result"; iteration: number; call: ToolCall; result: ToolResult }
  | { type: "iteration-end"; iteration: number; finishReason: string }
  | { type: "max-iterations"; iteration: number }
  | { type: "error"; message: string }
  | { type: "cancelled" }
  | { type: "finished"; answer: string; finishReason: string };
