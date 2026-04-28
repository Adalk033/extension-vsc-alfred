import * as vscode from "vscode";
import { AlfredApiError, AlfredClient, type AgentQueryBody } from "../api/AlfredClient";
import { ApprovalGate } from "./Approval";
import { McpToolHub } from "./McpToolHub";
import { WorkspaceFs } from "./WorkspaceFs";
import type { AgentDonePayload, AgentLoopEvent, ToolCall, ToolResult } from "./types";

const CONFIG_SECTION = "alfred";
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface AgentSessionRunOptions {
  question: string;
  conversationId: string | null;
  signal: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
}

export interface AgentSessionResult {
  answer: string;
  finishReason: string;
  conversationId: string | null;
  requestId: number;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
}

export class AgentSession {
  constructor(
    private readonly client: AlfredClient,
    private readonly fs: WorkspaceFs,
    private readonly approval: ApprovalGate,
    private readonly mcp: McpToolHub | null,
  ) {}

  async run(opts: AgentSessionRunOptions): Promise<AgentSessionResult> {
    const maxIterations = this.getMaxIterations();
    const toolTimeoutMs = this.getToolTimeoutMs();

    const allCalls: ToolCall[] = [];
    const allResults: ToolResult[] = [];
    const tools = [
      ...this.fs.getTools(),
      ...(this.mcp ? await this.mcp.listTools(opts.signal) : []),
    ];

    let nextQuestion = opts.question;
    let toolResultsForNext: ToolResult[] | undefined;

    let conversationId = opts.conversationId;
    let finalAnswer = "";
    let finishReason = "stop";
    let lastRequestId = 0;

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        throwIfAborted(opts.signal);
        this.emit(opts.onEvent, { type: "iteration-start", iteration });

        let streamedAnswer = "";
        let donePayload: AgentDonePayload | null = null;
        const pendingCalls: ToolCall[] = [];

        const body: AgentQueryBody = {
          question: nextQuestion,
          conversation_id: conversationId,
          tools,
        };
        if (toolResultsForNext && toolResultsForNext.length > 0) {
          body.tool_results = toolResultsForNext;
        }

        for await (const evt of this.client.streamAgentQuery(body, opts.signal)) {
          if (evt.type === "start") {
            lastRequestId = evt.request_id;
            this.emit(opts.onEvent, {
              type: "request-started",
              iteration,
              requestId: evt.request_id,
            });
          } else if (evt.type === "token") {
            streamedAnswer += evt.text;
            this.emit(opts.onEvent, {
              type: "token",
              iteration,
              text: evt.text,
            });
          } else if (evt.type === "tool_call") {
            pendingCalls.push(evt.call);
            this.emit(opts.onEvent, {
              type: "tool-call",
              iteration,
              call: evt.call,
            });
          } else if (evt.type === "done") {
            donePayload = evt.payload;
          } else if (evt.type === "error") {
            throw new Error(evt.message);
          }
        }

        if (donePayload?.conversation_id) {
          conversationId = donePayload.conversation_id;
        }
        if (typeof donePayload?.answer === "string" && donePayload.answer.length > 0) {
          finalAnswer = donePayload.answer;
        } else if (streamedAnswer.length > 0) {
          finalAnswer = streamedAnswer;
        }

        if (pendingCalls.length === 0 && donePayload?.tool_calls?.length) {
          for (const call of donePayload.tool_calls) {
            pendingCalls.push(call);
            this.emit(opts.onEvent, {
              type: "tool-call",
              iteration,
              call,
            });
          }
        }

        allCalls.push(...pendingCalls);

        finishReason =
          donePayload?.finish_reason ??
          (donePayload?.cancelled ? "cancelled" : pendingCalls.length > 0 ? "tool_calls" : "stop");

        if (donePayload?.cancelled) {
          finishReason = "cancelled";
          this.emit(opts.onEvent, {
            type: "iteration-end",
            iteration,
            finishReason,
          });
          this.emit(opts.onEvent, { type: "cancelled" });
          break;
        }

        if (pendingCalls.length === 0) {
          this.emit(opts.onEvent, {
            type: "iteration-end",
            iteration,
            finishReason,
          });
          break;
        }

        const nextResults: ToolResult[] = [];
        for (const call of pendingCalls) {
          throwIfAborted(opts.signal);
          const decision = await this.approval.check(call, opts.signal);
          let result: ToolResult;
          if (!decision.approved) {
            result = {
              id: call.id,
              content: decision.reason ?? "Tool denegada por el usuario.",
              is_error: true,
            };
          } else {
            result = await this.executeToolWithTimeout(call, toolTimeoutMs, opts.signal);
          }
          nextResults.push(result);
          allResults.push(result);
          this.emit(opts.onEvent, {
            type: "tool-result",
            iteration,
            call,
            result,
          });
        }

        toolResultsForNext = nextResults;
        nextQuestion = "";

        this.emit(opts.onEvent, {
          type: "iteration-end",
          iteration,
          finishReason: "tool_calls",
        });

        if (iteration === maxIterations - 1) {
          finishReason = "max_iterations";
          this.emit(opts.onEvent, { type: "max-iterations", iteration });
        }
      }
    } catch (err) {
      if (isAbortError(err, opts.signal)) {
        finishReason = "cancelled";
        this.emit(opts.onEvent, { type: "cancelled" });
      } else {
        const message =
          err instanceof AlfredApiError
            ? err.message
            : err instanceof Error
            ? err.message
            : String(err);
        this.emit(opts.onEvent, { type: "error", message });
        throw err;
      }
    }

    this.emit(opts.onEvent, {
      type: "finished",
      answer: finalAnswer,
      finishReason,
    });

    return {
      answer: finalAnswer,
      finishReason,
      conversationId,
      requestId: lastRequestId,
      toolCalls: allCalls,
      toolResults: allResults,
    };
  }

  private emit(onEvent: ((event: AgentLoopEvent) => void) | undefined, evt: AgentLoopEvent): void {
    if (!onEvent) return;
    try {
      onEvent(evt);
    } catch {
      // Ignorar errores del renderer de eventos para no cortar el loop.
    }
  }

  private getMaxIterations(): number {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const value = cfg.get<number>("agent.maxIterations", DEFAULT_MAX_ITERATIONS);
    return clampInt(value, 1, 100);
  }

  private getToolTimeoutMs(): number {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const value = cfg.get<number>("agent.toolTimeoutMs", DEFAULT_TOOL_TIMEOUT_MS);
    return clampInt(value, 1_000, 10 * 60_000);
  }

  private async executeToolWithTimeout(
    call: ToolCall,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfAborted(signal);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race<ToolResult>([
        this.executeTool(call, signal),
        new Promise<ToolResult>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              id: call.id,
              content: `Timeout tras ${timeoutMs} ms.`,
              is_error: true,
            });
          }, timeoutMs);
        }),
      ]);
      throwIfAborted(signal);
      return result;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async executeTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (this.fs.hasTool(call.name)) {
      return this.fs.execute(call);
    }

    if (this.mcp?.canHandle(call.name)) {
      return this.mcp.callTool(call, signal);
    }

    return {
      id: call.id,
      content: `Tool no registrada: ${call.name}`,
      is_error: true,
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error("Operacion cancelada.");
    err.name = "AbortError";
    throw err;
  }
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof Error && (err.name === "AbortError" || /abort|cancel/i.test(err.message)))
  );
}

function clampInt(value: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.floor(value as number);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
