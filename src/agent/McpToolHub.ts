import * as vscode from "vscode";
import type { ToolCall, ToolResult, ToolSpec } from "./types";

const CONFIG_SECTION = "alfred";
const DEFAULT_TIMEOUT_MS = 30_000;

interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  enabled: boolean;
}

interface RegisteredTool {
  prefixedName: string;
  toolName: string;
  server: McpServerConfig;
}

interface McpStdioServerParameters {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpClientLike {
  connect(
    transport: McpTransportLike,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<void>;
  close(): Promise<void>;
  listTools(
    params?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ tools?: unknown[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown>;
}

interface McpTransportLike {
  close(): Promise<void>;
}

interface McpClientCtor {
  new (
    clientInfo: { name: string; version: string },
    options: { capabilities: Record<string, unknown> },
  ): McpClientLike;
}

interface McpStdioTransportCtor {
  new (server: McpStdioServerParameters): McpTransportLike;
}

const DEFAULT_MCP_SERVERS: readonly McpServerConfig[] = [
  {
    name: "alfred",
    command: "npx",
    args: ["-y", "alfred-mcp"],
    enabled: true,
    env: {},
  },
  {
    name: "git",
    command: "uvx",
    args: ["mcp-server-git"],
    enabled: true,
    env: {},
  },
];

export class McpToolHub implements vscode.Disposable {
  private readonly toolByName = new Map<string, RegisteredTool>();
  private readonly warnedServers = new Set<string>();

  constructor(private readonly workspaceRoot: vscode.Uri) {}

  async listTools(signal: AbortSignal): Promise<ToolSpec[]> {
    this.toolByName.clear();

    const servers = this.readEnabledServers();
    if (servers.length === 0) {
      return [];
    }

    const out: ToolSpec[] = [];
    for (const server of servers) {
      if (signal.aborted) {
        throw abortError();
      }

      const tools = await this.tryListServerTools(server, signal);
      if (tools.length > 0) {
        this.warnedServers.delete(server.name);
      }

      for (const tool of tools) {
        if (!tool || typeof tool !== "object") {
          continue;
        }

        const toolName = stringOrEmpty((tool as { name?: unknown }).name);
        if (!toolName) {
          continue;
        }

        // Evita recursion directa del propio agente sobre Alfred.
        if (server.name === "alfred" && (toolName === "ask_alfred" || toolName === "ask_alfred_stream")) {
          continue;
        }

        const prefixedName = makePrefixedName(server.name, toolName);
        const description = stringOrEmpty((tool as { description?: unknown }).description);
        const inputSchemaRaw = (tool as { inputSchema?: unknown }).inputSchema;

        out.push({
          name: prefixedName,
          description: description
            ? `[${server.name}] ${description}`
            : `[${server.name}] ${toolName}`,
          input_schema: asObjectSchema(inputSchemaRaw),
        });

        this.toolByName.set(prefixedName, {
          prefixedName,
          toolName,
          server,
        });
      }
    }

    return out;
  }

  canHandle(toolName: string): boolean {
    return this.toolByName.has(toolName);
  }

  async callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const resolved = this.toolByName.get(call.name);
    if (!resolved) {
      return {
        id: call.id,
        content: `Tool MCP no registrada: ${call.name}`,
        is_error: true,
      };
    }

    try {
      const response = await this.withClient(
        resolved.server,
        signal,
        async (client, timeoutMs) =>
          client.callTool(
            {
              name: resolved.toolName,
              arguments: call.arguments ?? {},
            },
            undefined,
            {
              signal,
              timeout: timeoutMs,
            },
          ),
      );

      return {
        id: call.id,
        content: mcpResultToText(response),
        is_error: Boolean((response as { isError?: unknown }).isError),
      };
    } catch (err) {
      if (!isAbort(err, signal)) {
        this.reportServerIssue(
          resolved.server.name,
          err instanceof Error ? err.message : String(err),
        );
      }
      return {
        id: call.id,
        content: err instanceof Error ? err.message : String(err),
        is_error: true,
      };
    }
  }

  dispose(): void {
    this.toolByName.clear();
    this.warnedServers.clear();
  }

  private async tryListServerTools(
    server: McpServerConfig,
    signal: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const listed = await this.withClient(server, signal, async (client, timeoutMs) => {
        const result = await client.listTools(undefined, {
          signal,
          timeout: timeoutMs,
        });
        return Array.isArray(result.tools)
          ? (result.tools as Array<Record<string, unknown>>)
          : [];
      });
      return listed;
    } catch (err) {
      if (isAbort(err, signal)) {
        throw err;
      }
      this.reportServerIssue(server.name, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  private async withClient<T>(
    server: McpServerConfig,
    signal: AbortSignal,
    action: (client: McpClientLike, timeoutMs: number) => Promise<T>,
  ): Promise<T> {
    const { ClientCtor, StdioTransportCtor } = loadMcpSdk();
    const timeoutMs = this.readTimeoutMs();
    const transport = new StdioTransportCtor(this.toServerParams(server));
    const client = new ClientCtor(
      {
        name: "alfred-vsc",
        version: "0.1.0",
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport, {
        signal,
        timeout: timeoutMs,
      });

      return await action(client, timeoutMs);
    } finally {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
    }
  }

  private readEnabledServers(): McpServerConfig[] {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const configured = cfg.get<unknown[]>("agent.mcpServers", DEFAULT_MCP_SERVERS as unknown as unknown[]);
    const source = Array.isArray(configured) && configured.length > 0
      ? configured
      : [...DEFAULT_MCP_SERVERS];

    const parsed: McpServerConfig[] = [];
    for (let i = 0; i < source.length; i++) {
      const item = parseServerConfig(source[i]);
      if (!item || !item.enabled) {
        continue;
      }
      parsed.push(item);
    }
    return parsed;
  }

  private toServerParams(server: McpServerConfig): McpStdioServerParameters {
    const env = Object.keys(server.env).length > 0
      ? Object.fromEntries(
          Object.entries(server.env).map(([k, v]) => [k, this.expandValue(v)]),
        )
      : undefined;

    return {
      command: this.expandValue(server.command),
      args: server.args.map((a) => this.expandValue(a)),
      cwd: server.cwd ? this.expandValue(server.cwd) : undefined,
      env,
    };
  }

  private expandValue(value: string): string {
    return expandTemplate(value, this.workspaceRoot.fsPath);
  }

  private readTimeoutMs(): number {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const value = cfg.get<number>("agent.toolTimeoutMs", DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(value)) {
      return DEFAULT_TIMEOUT_MS;
    }
    const n = Math.floor(value);
    if (n < 1_000) {
      return 1_000;
    }
    if (n > 10 * 60_000) {
      return 10 * 60_000;
    }
    return n;
  }

  private reportServerIssue(serverName: string, message: string): void {
    if (this.warnedServers.has(serverName)) {
      return;
    }
    this.warnedServers.add(serverName);
    void vscode.window.showWarningMessage(
      `[MCP:${serverName}] ${message}`,
    );
  }
}

function parseServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const name = stringOrEmpty(obj.name).trim();
  const command = stringOrEmpty(obj.command).trim();
  if (!name || !command) {
    return null;
  }

  const argsRaw = obj.args;
  const args = Array.isArray(argsRaw)
    ? argsRaw
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    : [];

  const envRaw = obj.env;
  const env: Record<string, string> = {};
  if (envRaw && typeof envRaw === "object" && !Array.isArray(envRaw)) {
    for (const [k, v] of Object.entries(envRaw)) {
      if (typeof v === "string" && k.trim().length > 0) {
        env[k] = v;
      }
    }
  }

  const cwd = stringOrEmpty(obj.cwd).trim() || undefined;
  const enabled = obj.enabled === undefined ? true : Boolean(obj.enabled);

  return {
    name,
    command,
    args,
    cwd,
    env,
    enabled,
  };
}

function loadMcpSdk(): {
  ClientCtor: McpClientCtor;
  StdioTransportCtor: McpStdioTransportCtor;
} {
  // moduleResolution=node no resuelve bien los tipos via exports map de este
  // paquete ESM/CJS, por eso cargamos runtime con require tipado.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clientMod = require("@modelcontextprotocol/sdk/client") as {
    Client: McpClientCtor;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stdioMod = require("@modelcontextprotocol/sdk/client/stdio") as {
    StdioClientTransport: McpStdioTransportCtor;
  };

  return {
    ClientCtor: clientMod.Client,
    StdioTransportCtor: stdioMod.StdioClientTransport,
  };
}

function makePrefixedName(serverName: string, toolName: string): string {
  const safeServer = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeServer}__${toolName}`;
}

function asObjectSchema(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {
    type: "object",
    properties: {},
  };
}

function mcpResultToText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }

  const obj = result as { content?: unknown; toolResult?: unknown };
  if (Array.isArray(obj.content)) {
    const lines: string[] = [];
    for (const block of obj.content) {
      if (block && typeof block === "object") {
        const typed = block as {
          type?: unknown;
          text?: unknown;
          resource?: { text?: unknown };
        };

        if (typed.type === "text" && typeof typed.text === "string") {
          lines.push(typed.text);
          continue;
        }

        if (typed.type === "resource" && typed.resource && typeof typed.resource.text === "string") {
          lines.push(typed.resource.text);
          continue;
        }
      }

      lines.push(safeStringify(block));
    }

    return lines.join("\n").trim() || "(sin contenido)";
  }

  if ("toolResult" in obj) {
    return safeStringify(obj.toolResult);
  }

  return safeStringify(result);
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function expandTemplate(input: string, workspaceFolder: string): string {
  return input
    .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
    .replace(/\$\{env:([^}]+)\}/g, (_m: string, key: string) => process.env[key] ?? "")
    .replace(/%([^%]+)%/g, (_m: string, key: string) => process.env[key] ?? "");
}

function abortError(): Error {
  const err = new Error("Operacion cancelada.");
  err.name = "AbortError";
  return err;
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof Error && (err.name === "AbortError" || /abort|cancel/i.test(err.message)))
  );
}