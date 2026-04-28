import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

export interface ProposedDocumentInput {
  relPath: string;
  role: "before" | "after";
  content: string;
}

export class ProposedContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  static readonly scheme = "alfred-proposed";

  private readonly docs = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.onDidChangeEmitter.event;

  createDocument(input: ProposedDocumentInput): vscode.Uri {
    const uri = this.buildUri(input.relPath, input.role);
    this.docs.set(uri.toString(), input.content);
    this.onDidChangeEmitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.docs.clear();
    this.onDidChangeEmitter.dispose();
  }

  private buildUri(relPath: string, role: "before" | "after"): vscode.Uri {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    const rawParts = normalized.length > 0 ? normalized.split("/") : ["untitled.txt"];
    const safeParts = rawParts.map((p) => sanitizeSegment(p));

    const fileName = safeParts.pop() ?? "untitled.txt";
    const ext = path.posix.extname(fileName);
    const stem = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
    const virtualName = `${stem}.${role}${ext || ".txt"}`;

    safeParts.push(virtualName);
    const virtualPath = `/${safeParts.join("/")}`;

    return vscode.Uri.from({
      scheme: ProposedContentProvider.scheme,
      path: virtualPath,
      query: `id=${encodeURIComponent(randomUUID())}`,
    });
  }
}

function sanitizeSegment(part: string): string {
  const trimmed = part.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return "_";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}
