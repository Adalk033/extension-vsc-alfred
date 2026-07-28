# Alfred - Extension VSCode

Chat lateral conectado al backend local de Alfred (`REST :8000` + SSE), con
modo `Agent` para bucle de tools y aprobacion humana.

La version 0.6 usa automaticamente la conexion segura publicada por Alfred en
`%LOCALAPPDATA%\Alfred\api-connection.json`, incluida la cabecera de sesion
`X-Alfred-Token`.

## Que incluye

- Vista lateral en la activity bar (icono Alfred) con chat en streaming.
- Toggle `Chat / Agent` en el panel.
- Modo `Agent` con loop sobre `/query/agent/stream`.
- Tools locales de workspace (`read_file`, `list_dir`, `find_files`, `search_text`, `write_file`, `edit_file`).
- Aprobacion obligatoria para escrituras locales, con diff para `write_file`/`edit_file`.
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
| `alfred.connectionFile` | vacio | Ruta alternativa a `api-connection.json`; vacio usa `%LOCALAPPDATA%\Alfred\api-connection.json`. |
| `alfred.agent.maxIterations` | `10` | Iteraciones maximas del loop agente. |
| `alfred.agent.toolTimeoutMs` | `30000` | Timeout por tool del agente. |
| `alfred.agent.autoApprove` | `read_file,list_dir,find_files,search_text` | Tools autoaprobadas sin modal. |

## Notas tecnicas

- El webview usa `postMessage` y renderer markdown seguro sin framework.
- El estado del backend se refleja en la status bar (`alfred.checkBackend`).
- Las escrituras locales requieren confirmacion explicita y muestran un diff antes de ejecutarse.
