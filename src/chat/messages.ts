// Tipos compartidos host <-> webview. Mismos shapes en ambos lados.

import type { ToolCall, ToolResult } from "../agent/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  pending?: boolean;
}

export type ChatMode = "chat" | "agent";

export interface ModelInfo {
  name: string;
  path: string;
  size_bytes: number;
  size_gb: number;
}

// host -> webview
export type ToWebviewMessage =
  | { type: "init"; conversationId: string | null; messages: ChatMessage[]; models: ModelInfo[]; activeModel: string | null; backendOk: boolean; mode: ChatMode }
  | { type: "set-mode"; mode: ChatMode }
  | { type: "models"; models: ModelInfo[]; activeModel: string | null }
  | { type: "backend-status"; ok: boolean; reason?: string }
  | { type: "message-append"; message: ChatMessage }
  | { type: "stream-start"; messageId: string }
  | { type: "stream-token"; messageId: string; text: string }
  | { type: "stream-done"; messageId: string }
  | { type: "stream-error"; messageId: string; message: string }
  | { type: "agent-iteration"; iteration: number; phase: "start" | "end"; finishReason?: string }
  | { type: "agent-tool-call"; iteration: number; call: ToolCall }
  | { type: "agent-tool-result"; iteration: number; call: ToolCall; result: ToolResult }
  | { type: "history-cleared" };

// webview -> host
export type FromWebviewMessage =
  | { type: "ready" }
  | { type: "set-mode"; mode: ChatMode }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "new-conversation" }
  | { type: "change-model"; modelName: string }
  | { type: "refresh-models" }
  | { type: "open-settings" };
