import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface ApiConnectionFile {
  base_url?: unknown;
  token?: unknown;
}

export function defaultConnectionFilePath(): string {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Alfred", "api-connection.json");
}

export async function readSessionToken(
  connectionFilePath: string,
  requestedBaseUrl: string,
): Promise<string | null> {
  try {
    const raw = await readFile(connectionFilePath, "utf8");
    const data = JSON.parse(raw) as ApiConnectionFile;
    if (
      typeof data.base_url !== "string" ||
      typeof data.token !== "string" ||
      !data.token.trim()
    ) {
      return null;
    }

    // Nunca enviar el secreto a un backend distinto del que lo publico.
    if (normalizeBaseUrl(data.base_url) !== normalizeBaseUrl(requestedBaseUrl)) {
      return null;
    }
    return data.token;
  } catch {
    // Alfred cerrado, version anterior o archivo momentaneamente reemplazado.
    return null;
  }
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}
