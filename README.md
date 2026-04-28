# Alfred - Extension VSCode (Fase 2 + Fase 4)

Chat lateral conectado al backend local de Alfred (`REST :8000` + SSE), con
modo `Agent` para bucle de tools y aprobacion humana.

## Que incluye

- Vista lateral en la activity bar (icono Alfred) con chat en streaming.
- Toggle `Chat / Agent` en el panel.
- Modo `Agent` con loop sobre `/query/agent/stream`.
- Tools locales de workspace (`read_file`, `list_dir`, `find_files`, `search_text`, `write_file`, `edit_file`).
- Integracion MCP por stdio en modo agente para tools externas (por ejemplo `alfred-mcp`, `mcp-server-git`).
- Aprobacion obligatoria para escrituras locales y tools MCP remotas, con diff para `write_file`/`edit_file`.
- Selector de modelo (`/models`, `/models/status`, `/models/change`).
- Boton `+` para nueva conversacion y `Cancelar` (`POST /query/cancel`).
- Status bar con health check periodico (`/health`).
- Comandos de editor:
  - `Alfred: Explain selection`
  - `Alfred: Refactor selection`
  - `Alfred: Generate tests for selection`
  - `Alfred: Edit selection with Agent` (`Ctrl+I`)
- Persistencia de conversacion activa y mensajes en `globalState`.

## Estructura

```
extension-vsc/
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts
│   ├── api/
│   │   ├── AlfredClient.ts
│   │   └── health.ts
│   ├── agent/
│   │   ├── AgentSession.ts
│   │   ├── WorkspaceFs.ts
│   │   ├── Approval.ts
│   │   ├── McpToolHub.ts
│   │   └── proposedContentProvider.ts
│   ├── chat/
│   │   ├── ChatViewProvider.ts
│   │   └── messages.ts
│   ├── conversations/
│   │   └── ConversationStore.ts
│   └── commands/
│       └── editorCommands.ts
└── media/
    ├── alfred.svg
    └── webview/
        ├── styles.css
        └── main.js
```

## Requisitos

- VSCode `>= 1.90`
- Node `>= 18`
- Backend Alfred activo en `http://127.0.0.1:8000`

Opcional para modo agente completo con MCP:

- `npx -y alfred-mcp`
- `uvx mcp-server-git`

## Desarrollo

```bash
cd extension-vsc
npm install
npm run build
```

Luego abre `extension-vsc/` en VSCode y ejecuta `F5`.

## Configuracion

| Setting | Default | Uso |
|---|---|---|
| `alfred.backendUrl` | `http://127.0.0.1:8000` | URL base del backend. |
| `alfred.requestTimeoutMs` | `120000` | Timeout para llamadas no streaming. |
| `alfred.healthCheckIntervalMs` | `15000` | Poll automatico de salud (`0` desactiva). |
| `alfred.agent.maxIterations` | `10` | Iteraciones maximas del loop agente. |
| `alfred.agent.toolTimeoutMs` | `30000` | Timeout por tool del agente. |
| `alfred.agent.autoApprove` | `read_file,list_dir,find_files,search_text` | Tools autoaprobadas sin modal. |
| `alfred.agent.mcpServers` | `alfred + git` | Servidores MCP stdio usados en modo agente. |

## Notas tecnicas

- El webview usa `postMessage` y renderer markdown seguro sin framework.
- El estado del backend se refleja en la status bar (`alfred.checkBackend`).
- En modo `Agent`, las tools MCP se exponen con prefijo `server__tool` para evitar colisiones.
- Las tools remotas y las escrituras locales requieren confirmacion explicita, salvo si estan en `autoApprove`.
