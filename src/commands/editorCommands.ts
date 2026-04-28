// Comandos del editor que construyen un prompt a partir de la seleccion y lo
// envian al chat de Alfred.

import * as vscode from "vscode";
import type { ChatViewProvider } from "../chat/ChatViewProvider";

interface SelectionContext {
  language: string;
  selection: string;
  filename: string;
}

function getSelection(): SelectionContext | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Abre un archivo y selecciona codigo primero.");
    return null;
  }
  let text = editor.document.getText(editor.selection);
  if (!text.trim()) {
    text = editor.document.getText();
    if (!text.trim()) {
      void vscode.window.showWarningMessage("El archivo esta vacio.");
      return null;
    }
  }
  return {
    language: editor.document.languageId,
    selection: text,
    filename: editor.document.fileName.split(/[\\/]/).pop() || "selection",
  };
}

function buildPrompt(ctx: SelectionContext, instruction: string): string {
  const fence = "```";
  return `${instruction}\n\nArchivo: ${ctx.filename}\n\n${fence}${ctx.language}\n${ctx.selection}\n${fence}`;
}

export function registerEditorCommands(
  context: vscode.ExtensionContext,
  chat: ChatViewProvider,
): void {
  const send = async (
    instruction: string,
    opts?: {
      forceMode?: "chat" | "agent";
    },
  ) => {
    const ctx = getSelection();
    if (!ctx) return;
    await chat.focus();
    await chat.sendUserPrompt(buildPrompt(ctx, instruction), opts);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("alfred.explainSelection", () =>
      send("Explica que hace este codigo, paso a paso, en espanol."),
    ),
    vscode.commands.registerCommand("alfred.refactorSelection", () =>
      send(
        "Propon un refactor de este codigo manteniendo el mismo comportamiento. Justifica brevemente cada cambio.",
      ),
    ),
    vscode.commands.registerCommand("alfred.generateTests", () =>
      send(
        "Genera tests unitarios para este codigo. Indica el framework recomendado segun el lenguaje y cubre los casos limite.",
      ),
    ),
    vscode.commands.registerCommand("alfred.editWithAlfred", async () => {
      const instruction = await vscode.window.showInputBox({
        title: "Alfred Agent Edit",
        prompt: "Indica el cambio a aplicar sobre la seleccion.",
        placeHolder: "Ej: Refactoriza para mejorar legibilidad sin cambiar comportamiento.",
        ignoreFocusOut: true,
      });
      if (!instruction || !instruction.trim()) {
        return;
      }
      await send(instruction.trim(), { forceMode: "agent" });
    }),
  );
}
