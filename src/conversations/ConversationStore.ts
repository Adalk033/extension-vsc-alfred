// Persistencia ligera del conv_id activo + cache local de mensajes.
// La fuente de verdad sigue siendo el backend (DB). Esto solo evita perder
// el contexto al cerrar/abrir VSCode.

import * as vscode from "vscode";
import type { ChatMessage } from "../chat/messages";

const KEY_CONV_ID = "alfred.activeConversationId";
const KEY_MESSAGES_PREFIX = "alfred.messages."; // + convId

export class ConversationStore {
  constructor(private readonly state: vscode.Memento) {}

  getActiveId(): string | null {
    return this.state.get<string | null>(KEY_CONV_ID, null);
  }

  async setActiveId(id: string | null): Promise<void> {
    await this.state.update(KEY_CONV_ID, id);
  }

  getMessages(convId: string): ChatMessage[] {
    return this.state.get<ChatMessage[]>(KEY_MESSAGES_PREFIX + convId, []);
  }

  async setMessages(convId: string, messages: ChatMessage[]): Promise<void> {
    await this.state.update(KEY_MESSAGES_PREFIX + convId, messages);
  }

  async clearMessages(convId: string): Promise<void> {
    await this.state.update(KEY_MESSAGES_PREFIX + convId, undefined);
  }
}
