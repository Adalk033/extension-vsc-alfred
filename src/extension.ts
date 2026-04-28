// Punto de entrada de la extension. Registra la vista del chat, los comandos y
// el monitor de salud del backend.

import * as vscode from "vscode";
import { ProposedContentProvider } from "./agent/proposedContentProvider";
import { AlfredClient } from "./api/AlfredClient";
import { HealthMonitor } from "./api/health";
import { ChatViewProvider } from "./chat/ChatViewProvider";
import { ConversationStore } from "./conversations/ConversationStore";
import { registerEditorCommands } from "./commands/editorCommands";

const CONFIG_SECTION = "alfred";

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const baseUrl = cfg.get<string>("backendUrl", "http://127.0.0.1:8000");
  const requestTimeoutMs = cfg.get<number>("requestTimeoutMs", 120000);
  const healthInterval = cfg.get<number>("healthCheckIntervalMs", 15000);

  const client = new AlfredClient({ baseUrl, timeoutMs: requestTimeoutMs });
  const health = new HealthMonitor(client, healthInterval);
  const store = new ConversationStore(context.globalState);
  const proposedProvider = new ProposedContentProvider();
  const chat = new ChatViewProvider(context, client, health, store, proposedProvider);

  context.subscriptions.push(
    chat,
    health,
    proposedProvider,
    vscode.workspace.registerTextDocumentContentProvider(
      ProposedContentProvider.scheme,
      proposedProvider,
    ),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("alfred.focusChat", () => chat.focus()),
    vscode.commands.registerCommand("alfred.newConversation", () => chat.newConversation()),
    vscode.commands.registerCommand("alfred.cancel", () => chat.cancelCurrent()),
    vscode.commands.registerCommand("alfred.toggleAgentMode", () => chat.toggleMode()),
    vscode.commands.registerCommand("alfred.checkBackend", async () => {
      const ok = await health.checkOnce();
      if (ok) {
        void vscode.window.showInformationMessage("Alfred backend OK");
      } else {
        void vscode.window.showErrorMessage(
          "Alfred backend no responde. Asegurate de que la app de Alfred este abierta.",
        );
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return;
      const next = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const newBase = next.get<string>("backendUrl", "http://127.0.0.1:8000");
      const newInterval = next.get<number>("healthCheckIntervalMs", 15000);
      const newTimeout = next.get<number>("requestTimeoutMs", 120000);
      client.setBaseUrl(newBase);
      client.timeoutMs = newTimeout;
      health.setIntervalMs(newInterval);
      void health.checkOnce();
    }),
  );

  registerEditorCommands(context, chat);
  health.start();
}

export function deactivate(): void {
  /* no-op: los disposables del context limpian solos */
}
