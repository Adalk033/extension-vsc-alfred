// Health monitor: poll periodico al backend para reflejar el estado en la UI.

import * as vscode from "vscode";
import { AlfredClient } from "./AlfredClient";

export type HealthListener = (ok: boolean, reason?: string) => void;

export class HealthMonitor implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private lastOk: boolean | null = null;
  private listeners = new Set<HealthListener>();
  private statusBar: vscode.StatusBarItem;
  private inFlight: AbortController | null = null;
  private intervalMs: number;

  constructor(private client: AlfredClient, intervalMs: number) {
    this.intervalMs = intervalMs;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.command = "alfred.checkBackend";
    this.statusBar.show();
    this.render(null, "Comprobando...");
  }

  onChange(listener: HealthListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  start(): void {
    this.stop();
    void this.checkOnce();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => void this.checkOnce(), this.intervalMs);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }
  }

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (ms > 0) {
      this.timer = setInterval(() => void this.checkOnce(), ms);
    }
  }

  async checkOnce(): Promise<boolean> {
    if (this.inFlight) {
      this.inFlight.abort();
    }
    const ac = new AbortController();
    this.inFlight = ac;
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
      await this.client.health(ac.signal);
      this.update(true);
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.update(false, reason);
      return false;
    } finally {
      clearTimeout(timer);
      if (this.inFlight === ac) this.inFlight = null;
    }
  }

  private update(ok: boolean, reason?: string): void {
    const changed = this.lastOk !== ok;
    this.lastOk = ok;
    this.render(ok, reason);
    if (changed) {
      for (const l of this.listeners) {
        try {
          l(ok, reason);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private render(ok: boolean | null, reason?: string): void {
    if (ok === null) {
      this.statusBar.text = "$(sync~spin) Alfred";
      this.statusBar.tooltip = "Comprobando backend Alfred...";
      this.statusBar.backgroundColor = undefined;
      return;
    }
    if (ok) {
      this.statusBar.text = "$(check) Alfred";
      this.statusBar.tooltip = "Backend Alfred OK";
      this.statusBar.backgroundColor = undefined;
    } else {
      this.statusBar.text = "$(error) Alfred";
      this.statusBar.tooltip = `Alfred no responde${reason ? `: ${reason}` : ""}. Abre la app de Alfred.`;
      this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
  }

  dispose(): void {
    this.stop();
    this.statusBar.dispose();
    this.listeners.clear();
  }
}
