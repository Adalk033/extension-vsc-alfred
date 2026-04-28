// Tools de filesystem sandboxeadas al workspace activo. Cualquier path se
// normaliza y se rechaza si escapa del root. No hay acceso a rutas absolutas
// ni a ".." que salga del workspace.

import * as vscode from "vscode";
import * as path from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import type { ToolCall, ToolResult, ToolSpec } from "./types";

const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 200;

const WRITE_TOOLS = new Set<string>([
  "write_file",
  "edit_file",
  "create_file",
]);

const LOCAL_TOOLS = new Set<string>([
  "read_file",
  "list_dir",
  "find_files",
  "search_text",
  "write_file",
  "edit_file",
]);

export interface WorkspaceFsOptions {
  /** Tamanio maximo en bytes que se devuelve al modelo en read_file. */
  maxReadBytes?: number;
}

export class WorkspaceFs {
  private readonly maxReadBytes: number;

  constructor(private readonly root: vscode.Uri, opts: WorkspaceFsOptions = {}) {
    this.maxReadBytes = opts.maxReadBytes ?? MAX_READ_BYTES;
  }

  static isWriteTool(name: string): boolean {
    return WRITE_TOOLS.has(name);
  }

  hasTool(name: string): boolean {
    return LOCAL_TOOLS.has(name);
  }

  rootUri(): vscode.Uri {
    return this.root;
  }

  getTools(): ToolSpec[] {
    return [
      {
        name: "read_file",
        description:
          "Lee el contenido de un archivo del workspace. Devuelve UTF-8. Truncado si excede el limite.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta relativa al workspace." },
          },
          required: ["path"],
        },
      },
      {
        name: "list_dir",
        description: "Lista entradas (archivos y directorios) de un directorio del workspace.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta relativa. Vacio = raiz del workspace." },
          },
          required: [],
        },
      },
      {
        name: "find_files",
        description:
          "Busca archivos por glob (relativo al workspace). Ej: 'src/**/*.ts'. Excluye node_modules, .git, dist, build.",
        input_schema: {
          type: "object",
          properties: {
            glob: { type: "string", description: "Patron glob. Default '**/*'." },
            max_results: { type: "number", description: "Default 200." },
          },
          required: [],
        },
      },
      {
        name: "search_text",
        description:
          "Busca un patron (string literal o regex) en archivos del workspace. Devuelve hasta 200 coincidencias con linea y contexto.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string" },
            is_regex: { type: "boolean", description: "Default false." },
            glob: { type: "string", description: "Glob para filtrar archivos. Default '**/*'." },
          },
          required: ["query"],
        },
      },
      {
        name: "write_file",
        description:
          "Escribe (crea o sobrescribe) un archivo del workspace con el contenido dado. Requiere aprobacion del usuario.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description:
          "Reemplaza una unica ocurrencia exacta de `old_string` por `new_string` en un archivo. Falla si `old_string` no es unico.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    ];
  }

  // -------------------------------------------------------------- Ejecucion
  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      const args = call.arguments ?? {};
      switch (call.name) {
        case "read_file":
          return this.ok(call, await this.readFile(stringArg(args, "path")));
        case "list_dir":
          return this.ok(call, await this.listDir(optionalStringArg(args, "path") ?? ""));
        case "find_files":
          return this.ok(
            call,
            await this.findFiles(
              optionalStringArg(args, "glob") ?? "**/*",
              numberArg(args, "max_results", MAX_SEARCH_RESULTS),
            ),
          );
        case "search_text":
          return this.ok(
            call,
            await this.searchText(
              stringArg(args, "query"),
              boolArg(args, "is_regex", false),
              optionalStringArg(args, "glob") ?? "**/*",
            ),
          );
        case "write_file":
          return this.ok(
            call,
            await this.writeFile(stringArg(args, "path"), stringArg(args, "content")),
          );
        case "edit_file":
          return this.ok(
            call,
            await this.editFile(
              stringArg(args, "path"),
              stringArg(args, "old_string"),
              stringArg(args, "new_string"),
            ),
          );
        default:
          return this.err(call, `Tool desconocida: ${call.name}`);
      }
    } catch (err) {
      return this.err(call, err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------- Lecturas
  async readFile(rel: string): Promise<string> {
    const uri = this.resolve(rel);
    const data = await vscode.workspace.fs.readFile(uri);
    const truncated = data.byteLength > this.maxReadBytes;
    const slice = truncated ? data.slice(0, this.maxReadBytes) : data;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    if (truncated) {
      return `${text}\n\n[... truncado: archivo de ${data.byteLength} bytes, mostrando primeros ${this.maxReadBytes}]`;
    }
    return text;
  }

  async listDir(rel: string): Promise<string> {
    const uri = rel ? this.resolve(rel) : this.root;
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const sorted = entries.slice(0, MAX_LIST_ENTRIES).sort((a, b) => a[0].localeCompare(b[0]));
    const lines: string[] = [];
    for (const [name, kind] of sorted) {
      const tag =
        kind === vscode.FileType.Directory
          ? "dir"
          : kind === vscode.FileType.SymbolicLink
          ? "link"
          : "file";
      lines.push(`${tag}\t${name}`);
    }
    if (entries.length > MAX_LIST_ENTRIES) {
      lines.push(`[... ${entries.length - MAX_LIST_ENTRIES} entradas mas omitidas]`);
    }
    return lines.length === 0 ? "(directorio vacio)" : lines.join("\n");
  }

  async findFiles(glob: string, maxResults: number): Promise<string> {
    const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**}";
    const uris = await vscode.workspace.findFiles(
      this.relGlob(glob),
      exclude,
      Math.max(1, Math.min(maxResults, MAX_SEARCH_RESULTS)),
    );
    if (uris.length === 0) return "(sin resultados)";
    return uris
      .map((u) => this.toRel(u))
      .filter((p) => p !== null)
      .join("\n");
  }

  async searchText(query: string, isRegex: boolean, glob: string): Promise<string> {
    const re = isRegex
      ? new RegExp(query)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**}";
    const files = await vscode.workspace.findFiles(this.relGlob(glob), exclude, 2000);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const hits: string[] = [];
    for (const uri of files) {
      if (hits.length >= MAX_SEARCH_RESULTS) break;
      let buf: Uint8Array;
      try {
        buf = await vscode.workspace.fs.readFile(uri);
      } catch {
        continue;
      }
      // Saltar binarios obvios (NUL en primeros 4KB).
      const head = buf.slice(0, 4096);
      if (head.includes(0)) continue;
      const text = decoder.decode(buf);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (re.test(line)) {
          const rel = this.toRel(uri) ?? uri.fsPath;
          hits.push(`${rel}:${i + 1}: ${line.slice(0, 240)}`);
          if (hits.length >= MAX_SEARCH_RESULTS) break;
        }
      }
    }
    return hits.length === 0 ? "(sin coincidencias)" : hits.join("\n");
  }

  // -------------------------------------------------------------- Escrituras
  async writeFile(rel: string, content: string): Promise<string> {
    const uri = this.resolve(rel);
    await this.ensureParentDir(uri);
    const bytes = new TextEncoder().encode(content);
    await vscode.workspace.fs.writeFile(uri, bytes);
    return `Archivo escrito: ${rel} (${bytes.byteLength} bytes)`;
  }

  async editFile(rel: string, oldString: string, newString: string): Promise<string> {
    if (oldString === newString) {
      throw new Error("old_string y new_string son identicos.");
    }
    const uri = this.resolve(rel);
    const existing = new TextDecoder("utf-8", { fatal: false }).decode(
      await vscode.workspace.fs.readFile(uri),
    );
    const first = existing.indexOf(oldString);
    if (first === -1) {
      throw new Error("old_string no encontrado en el archivo.");
    }
    const second = existing.indexOf(oldString, first + 1);
    if (second !== -1) {
      throw new Error("old_string aparece mas de una vez. Da mas contexto para que sea unico.");
    }
    const updated = existing.slice(0, first) + newString + existing.slice(first + oldString.length);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
    return `Archivo editado: ${rel}`;
  }

  // -------------------------------------------------------------- Diff preview
  async previewWriteFile(rel: string, content: string): Promise<{ before: string; after: string }> {
    const uri = this.resolve(rel);
    let before = "";
    try {
      before = new TextDecoder("utf-8", { fatal: false }).decode(
        await vscode.workspace.fs.readFile(uri),
      );
    } catch {
      before = "";
    }
    return { before, after: content };
  }

  async previewEditFile(
    rel: string,
    oldString: string,
    newString: string,
  ): Promise<{ before: string; after: string }> {
    const uri = this.resolve(rel);
    const before = new TextDecoder("utf-8", { fatal: false }).decode(
      await vscode.workspace.fs.readFile(uri),
    );
    const first = before.indexOf(oldString);
    if (first === -1) throw new Error("old_string no encontrado en el archivo.");
    const second = before.indexOf(oldString, first + 1);
    if (second !== -1) throw new Error("old_string aparece mas de una vez.");
    const after = before.slice(0, first) + newString + before.slice(first + oldString.length);
    return { before, after };
  }

  // -------------------------------------------------------------- Sandboxing
  private resolve(rel: string): vscode.Uri {
    if (typeof rel !== "string" || rel.length === 0) {
      throw new Error("Path vacio.");
    }
    const cleaned = rel.replace(/\\/g, "/");
    if (path.isAbsolute(cleaned) || /^[a-zA-Z]:[\\/]/.test(cleaned)) {
      throw new Error("Path absoluto no permitido. Usa rutas relativas al workspace.");
    }
    const norm = path.posix.normalize(cleaned);
    if (norm.startsWith("../") || norm === ".." || norm.startsWith("/")) {
      throw new Error("Path fuera del workspace.");
    }
    const segs = norm.split("/").filter((s) => s !== "" && s !== ".");
    const result = vscode.Uri.joinPath(this.root, ...segs);
    // Defensa final: el resultado debe seguir bajo root.
    const rootFs = path.normalize(this.root.fsPath).toLowerCase();
    const targetFs = path.normalize(result.fsPath).toLowerCase();
    if (!targetFs.startsWith(rootFs)) {
      throw new Error("Path resuelve fuera del workspace.");
    }
    return result;
  }

  private toRel(uri: vscode.Uri): string | null {
    const r = path.relative(this.root.fsPath, uri.fsPath);
    if (!r || r.startsWith("..")) return null;
    return r.replace(/\\/g, "/");
  }

  private relGlob(glob: string): vscode.RelativePattern {
    return new vscode.RelativePattern(this.root, glob || "**/*");
  }

  private async ensureParentDir(uri: vscode.Uri): Promise<void> {
    const parent = vscode.Uri.joinPath(uri, "..");
    try {
      await vscode.workspace.fs.createDirectory(parent);
    } catch {
      /* ignore: ya existe */
    }
  }

  private ok(call: ToolCall, content: string): ToolResult {
    return { id: call.id, content };
  }

  private err(call: ToolCall, msg: string): ToolResult {
    return { id: call.id, content: msg, is_error: true };
  }
}

// --------------------------------------------------------- Helpers de args
function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Argumento '${key}' debe ser string.`);
  return v;
}
function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`Argumento '${key}' debe ser string.`);
  return v;
}
function numberArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  const v = args[key];
  if (v === undefined || v === null) return defaultValue;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`Argumento '${key}' debe ser number.`);
  }
  return v;
}
function boolArg(args: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return defaultValue;
  if (typeof v !== "boolean") throw new Error(`Argumento '${key}' debe ser boolean.`);
  return v;
}
