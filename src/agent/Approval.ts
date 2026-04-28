import * as vscode from "vscode";
import { WorkspaceFs } from "./WorkspaceFs";
import type { ToolCall } from "./types";
import type { ProposedContentProvider } from "./proposedContentProvider";

const CONFIG_SECTION = "alfred";
const DEFAULT_AUTO_APPROVE = ["read_file", "list_dir", "find_files", "search_text"];

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export class ApprovalGate {
  constructor(
    private readonly fs: WorkspaceFs,
    private readonly proposedProvider: ProposedContentProvider,
  ) {}

  async check(call: ToolCall, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (this.isAutoApproved(call.name)) {
      return { approved: true };
    }

    const isLocalTool = this.fs.hasTool(call.name);
    if (isLocalTool && !WorkspaceFs.isWriteTool(call.name)) {
      return { approved: true };
    }

    if (signal?.aborted) {
      return { approved: false, reason: "Cancelado por el usuario." };
    }

    if (!isLocalTool) {
      return this.confirmRemoteTool(call, signal);
    }

    const relPath = this.extractPath(call);
    let preview: { before: string; after: string };
    try {
      preview = await this.buildPreview(call);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { approved: false, reason: `No se pudo preparar el diff: ${msg}` };
    }

    const beforeUri = this.proposedProvider.createDocument({
      relPath,
      role: "before",
      content: preview.before,
    });
    const afterUri = this.proposedProvider.createDocument({
      relPath,
      role: "after",
      content: preview.after,
    });

    try {
      await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, `Alfred propone cambios: ${relPath}`, {
        preview: true,
        preserveFocus: true,
      });
    } catch {
      // Si falla abrir el diff, igual pedimos confirmacion por modal.
    }

    const picked = await vscode.window.showWarningMessage(
      `Aprobar ${call.name} en ${relPath}?`,
      {
        modal: true,
        detail: "Aprobar ejecuta la escritura. Denegar devuelve error al agente.",
      },
      "Aprobar",
      "Denegar",
    );

    if (signal?.aborted) {
      return { approved: false, reason: "Cancelado por el usuario." };
    }
    if (picked === "Aprobar") {
      return { approved: true };
    }
    return { approved: false, reason: "Tool denegada por el usuario." };
  }

  private async confirmRemoteTool(
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    const args = safeJson(call.arguments ?? {});
    const picked = await vscode.window.showWarningMessage(
      `Aprobar tool MCP ${call.name}?`,
      {
        modal: true,
        detail: `Se ejecutara una tool remota. Argumentos:\n${args}`,
      },
      "Aprobar",
      "Denegar",
    );

    if (signal?.aborted) {
      return { approved: false, reason: "Cancelado por el usuario." };
    }
    if (picked === "Aprobar") {
      return { approved: true };
    }
    return { approved: false, reason: "Tool remota denegada por el usuario." };
  }

  private isAutoApproved(toolName: string): boolean {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const tools = cfg.get<string[]>("agent.autoApprove", DEFAULT_AUTO_APPROVE);
    return tools.includes(toolName);
  }

  private extractPath(call: ToolCall): string {
    const value = call.arguments?.["path"];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    return "(sin-path)";
  }

  private async buildPreview(call: ToolCall): Promise<{ before: string; after: string }> {
    const args = call.arguments ?? {};
    if (call.name === "write_file") {
      const relPath = stringArg(args, "path");
      const content = stringArg(args, "content");
      return this.fs.previewWriteFile(relPath, content);
    }
    if (call.name === "edit_file") {
      const relPath = stringArg(args, "path");
      const oldString = stringArg(args, "old_string");
      const newString = stringArg(args, "new_string");
      return this.fs.previewEditFile(relPath, oldString, newString);
    }
    throw new Error(`Tool no soportada para preview: ${call.name}`);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Argumento '${key}' debe ser string.`);
  }
  return value;
}
