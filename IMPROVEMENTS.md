# Plan de trabajo — Mejoras y optimizaciones

Inventario priorizado de mejoras técnicas para `alfred-vsc` (v0.5.0). **No incluye features nuevas**: solo optimizaciones, robustez, DX, calidad y limpieza de lo que ya existe.

Leyenda: **P0** crítico · **P1** alto · **P2** medio · **P3** bajo. **Esfuerzo**: S (≤2h), M (≤1d), L (varios días).

---

## 1. Build, bundling y arranque

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 1.1 | Sustituir `tsc → dist` por **esbuild** con `--bundle --minify --platform=node --external:vscode`. Reduce tamaño y tiempo de carga del entry. | P1 | M |
| 1.2 | Revisar `activationEvents: ["onStartupFinished"]` en [package.json:21](package.json#L21). Si no se necesita activar al arrancar VSCode, cambiar a `onView:alfred.chatView` + `onCommand:alfred.*` para arrancar perezoso. | P1 | S |
| 1.3 | Generar **sourcemaps solo en dev**. En `tsconfig.json` actualmente siempre se emiten; con esbuild distinguir `build:dev` y `build:prod`. | P2 | S |
| 1.4 | Añadir script `package` con `@vscode/vsce package` y `publish` con `vsce publish`, en lugar de generar `.vsix` a mano. | P1 | S |
| 1.5 | Revisar `tsconfig.json` (target/lib). Subir `target` a `ES2022` si runtime de VSCode lo soporta (Node ≥18) para reducir downleveling. | P2 | S |

## 2. Repositorio y packaging

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 2.1 | **Eliminar los 5 `.vsix` del repo** (`alfred-vsc-0.1.0.vsix` … `0.5.0.vsix`, ~13 MB). Añadir `*.vsix` a [.gitignore](.gitignore) y a [.vscodeignore](.vscodeignore). Migrar a Releases de GitHub para distribución. | P0 | S |
| 2.2 | Auditar [.vscodeignore](.vscodeignore): asegurar que excluye `src/`, `*.map`, `tsconfig.json`, `.vscode/`, `node_modules/` (cuando se bundle), `IMPROVEMENTS.md`, `*.vsix`, screenshots, etc. | P1 | S |
| 2.3 | Añadir `CHANGELOG.md` siguiendo *Keep a Changelog* (5 versiones ya publicadas sin historial). | P2 | S |
| 2.4 | Añadir `CONTRIBUTING.md` mínimo (cómo correr F5, cómo empaquetar, convenciones de commits). | P3 | S |
| 2.5 | Actualizar tipos: `@types/node ^20.14` y `@types/vscode ^1.90` están atrás respecto a las últimas LTS. | P3 | S |

## 3. Calidad de código y tipos

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 3.1 | Extraer las dos rutinas SSE casi idénticas `openSseStream` y `openAgentSseStream` de [src/api/AlfredClient.ts](src/api/AlfredClient.ts) a un helper genérico `parseSseEvents<T>()`. | P1 | M |
| 3.2 | Centralizar lectura de configuración: hoy se invoca `vscode.workspace.getConfiguration("alfred")` en `extension.ts`, `AgentSession.ts`, `McpToolHub.ts`, `Approval.ts`. Crear `ConfigService` inyectable. | P1 | M |
| 3.3 | Eliminar magic numbers: `4000` ms en [src/api/health.ts](src/api/health.ts), `MAX_TOOL_RESULT_CHARS = 4000` en `media/webview/main.js`, `DEFAULT_TIMEOUT_MS` repetido en agent. Mover a un módulo `constants.ts` y/o exponer como config. | P2 | S |
| 3.4 | Reemplazar `@ts-expect-error` + `require()` para cargar el SDK MCP en [src/agent/McpToolHub.ts](src/agent/McpToolHub.ts) por `await import()` dinámico tipado. | P2 | M |
| 3.5 | Reemplazar casts inseguros tipo `payload.answer as string` en [src/chat/ChatViewProvider.ts](src/chat/ChatViewProvider.ts) por `type guards` o `zod`/validación manual ligera. | P2 | M |
| 3.6 | `ChatViewProvider` (~673 líneas) es un *God Class*: separar en `ChatHandler`, `AgentHandler`, `ModelManager`, `WebviewBridge`. | P1 | L |
| 3.7 | Revisar `catch { /* ignore */ }` silenciosos en todo `src/`: o registrar al output channel o convertir a `catch (e) { void e; }` con razón documentada. | P2 | M |

## 4. Performance

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 4.1 | El webview re-renderiza markdown completo en cada token (`renderMarkdown` + `innerHTML` en `media/webview/main.js`). Implementar render incremental: solo el último bloque, o usar `requestAnimationFrame` + diff. | P1 | M |
| 4.2 | Persistir conversación por **batch** (debounce ~250ms) en lugar de en cada chunk en [src/chat/ChatViewProvider.ts](src/chat/ChatViewProvider.ts). | P1 | S |
| 4.3 | Debounce del `input` del textarea (autoresize) en `main.js`: hoy recalcula en cada tecla. | P3 | S |
| 4.4 | Health check: el polling (15 s) con timeout interno (4 s) puede colapsar si el backend está lento. Implementar **backoff exponencial** ante fallos consecutivos. | P2 | S |
| 4.5 | Buffer SSE en memoria: para respuestas largas no acumular `fullText` completo. Mantener solo lo necesario para persistir y dejar que el webview maneje el render. | P3 | M |
| 4.6 | Conexiones MCP: actualmente `withClient` crea cliente+transport por cada tool call. **Pool / cache** por servidor mientras la sesión está viva. | P1 | M |

## 5. Robustez y manejo de errores

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 5.1 | Añadir **timeout por chunk** en streams SSE (no solo timeout global): si el backend cuelga sin enviar nada, abortar a los N segundos. | P1 | M |
| 5.2 | Race condition: si el usuario envía un mensaje mientras hay generación activa, garantizar que `currentStream.abort()` resuelve antes de iniciar el nuevo (await del cleanup). Ver [src/chat/ChatViewProvider.ts](src/chat/ChatViewProvider.ts). | P1 | S |
| 5.3 | `formatStreamError` solo cubre `AlfredApiError`; envolver el resto con mensajes accionables ("backend caído", "timeout", "URL inválida"). | P2 | S |
| 5.4 | Validar workspace root vivo en `WorkspaceFs` y `McpToolHub` antes de cada operación (`vscode.workspace.workspaceFolders` puede mutar). | P2 | S |
| 5.5 | Limitar tamaño de `ConversationStore` en `globalState`: hoy puede crecer sin límite. Truncar por nº de mensajes o bytes. | P2 | S |
| 5.6 | Validar runtime de la config MCP (`alfred.agent.mcpServers`): si el usuario mete basura, hoy revienta tarde. Validar al cargar y mostrar mensaje claro. | P2 | M |

## 6. Webview

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 6.1 | Validar estrictamente los `postMessage` entrantes (`window.addEventListener("message")` en `main.js`): hoy solo chequea `typeof === "object"`. Usar union discriminada por `type`. | P2 | M |
| 6.2 | Limpiar listeners antes de `model-select.innerHTML = ""` para evitar fugas. | P3 | S |
| 6.3 | Mover `media/webview/main.js` a TypeScript compilado aparte (esbuild target=browser) para tipado fuerte y mismo build pipeline. | P2 | M |
| 6.4 | Revisar uso de `innerHTML` tras `renderMarkdown`: aunque escapa, considerar un sanitizer dedicado (`DOMPurify` mini-build) por defensa en profundidad. | P3 | M |

## 7. Seguridad

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 7.1 | Validar `cwd`/`command` de servidores MCP contra una whitelist o al menos avisar si `command` no es uno conocido (`npx`, `uvx`, `python`, `node`, `bun`, ruta absoluta). | P2 | S |
| 7.2 | Sanitizar `${env:VAR}` en [src/agent/McpToolHub.ts](src/agent/McpToolHub.ts): rechazar nombres con caracteres raros. | P3 | S |
| 7.3 | Documentar el modelo de confianza en README (qué hace `autoApprove`, riesgos de añadir tools de escritura). | P3 | S |

## 8. Logging y observabilidad

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 8.1 | Crear un **OutputChannel** único `Alfred` con niveles (`debug`/`info`/`warn`/`error`) y setting `alfred.logLevel`. | P1 | S |
| 8.2 | Reemplazar todos los `console.error` y `catch silencioso` por el logger anterior. | P1 | M |
| 8.3 | Añadir comando `Alfred: Show logs` que abra el OutputChannel. | P3 | S |

## 9. Tests

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 9.1 | Configurar **Vitest** o `node --test` para unit tests de módulos puros: `parseSse`, `ConversationStore`, `Approval`, `expandTemplate`, `renderMarkdown`. | P1 | M |
| 9.2 | Configurar `@vscode/test-cli` + `@vscode/test-electron` para tests de integración del provider de webview. | P2 | L |
| 9.3 | Añadir fixtures de SSE (texto plano grabado) para regresiones del parser. | P2 | M |
| 9.4 | Smoke test del MCP hub con un servidor `echo` mínimo en `tests/fixtures/`. | P3 | M |

## 10. Tooling y DX

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 10.1 | Añadir **ESLint** (`@typescript-eslint`, `eslint-plugin-import`, regla `no-floating-promises`). | P1 | S |
| 10.2 | Añadir **Prettier** y `eslint-config-prettier`. | P2 | S |
| 10.3 | Scripts: `lint`, `lint:fix`, `format`, `test`, `test:watch`, `package`, `publish`. | P1 | S |
| 10.4 | `husky` + `lint-staged` para pre-commit (lint + typecheck en archivos staged). | P3 | S |
| 10.5 | GitHub Actions: workflow `ci.yml` (typecheck + lint + test en PRs) y `release.yml` (vsce package + adjuntar a release en tag `v*`). | P1 | M |
| 10.6 | Renovate/Dependabot para deps. | P3 | S |

## 11. Configuración (settings)

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 11.1 | Añadir `markdownDescription` a las propiedades en `package.json` (mejor formato en UI de settings). | P3 | S |
| 11.2 | Validación runtime con type guards de cada setting al leerla; defaults seguros si llegan inválidas. | P2 | S |
| 11.3 | Exponer `alfred.healthCheckTimeoutMs` (hoy hardcodeado en `health.ts`). | P2 | S |
| 11.4 | Exponer `alfred.maxConversationMessages` para el cap del store. | P3 | S |

## 12. Internacionalización

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 12.1 | Externalizar strings hardcodeadas en español (`package.json`, `extension.ts`, `main.js`) usando `vscode.l10n` (API ≥1.89). Crear `package.nls.json` y `package.nls.es.json`. | P2 | M |
| 12.2 | Strings del webview: bundle separado de mensajes traducidos enviado al webview en el init message. | P3 | M |

## 13. Versionado y release

| # | Mejora | Prio | Esfuerzo |
|---|--------|------|----------|
| 13.1 | Adoptar **semver** estricto + commits convencionales (`feat:`, `fix:`, `chore:` ya se usan parcialmente). | P3 | S |
| 13.2 | Tags `vX.Y.Z` que disparen el workflow `release.yml`. | P2 | S |
| 13.3 | `package.json` → añadir `engines.node`, `keywords`, `bugs`, `homepage`. | P3 | S |

---

## Quick wins recomendados (≤1 día en total)

1. Borrar `.vsix` del repo + actualizar `.gitignore` / `.vscodeignore` (#2.1, #2.2).
2. Añadir ESLint + Prettier + scripts npm (#10.1, #10.2, #10.3).
3. Crear OutputChannel y reemplazar `console.error` (#8.1, #8.2 parcial).
4. Extraer helper SSE compartido (#3.1).
5. Persistencia con debounce (#4.2).
6. Cambiar `activationEvents` a perezoso (#1.2).

## Inversiones de mediano plazo (1–2 semanas)

1. Migrar build a esbuild + script `package`/`publish` (#1.1, #1.4).
2. Refactor de `ChatViewProvider` en módulos (#3.6).
3. Suite de tests con Vitest + fixtures SSE (#9.1, #9.3).
4. CI/CD con GitHub Actions (#10.5).
5. Connection pool MCP + render incremental webview (#4.6, #4.1).
