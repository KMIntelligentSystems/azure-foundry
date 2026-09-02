# ACA synchronous orchestrator gateway

The interactive flow stays synchronous, but no longer traverses the Static Web
Apps managed Function. The React app holds one WebSocket open to an Azure
Container Apps gateway for the complete turn.

```text
React SWA --wss--> ACA gateway /ws/agent
                         |
                         +-- iterative planner
                         +-- hosted-agent agents + behavioral skills
                         +-- async execute_python(stage_indicator_panel)
                         +-- fixed runtime safety limits
                         +-- coder + Playwright
                         `-- final result on the same socket
```

This is not a background-job design: no job id, polling, or later retrieval is
introduced. Progress events and the final result travel over the same socket.

## Runtime contract

- Image: `Dockerfile.gateway`
- Port: `8080`
- Health/readiness: `GET /health`, `GET /readiness`
- WebSocket: `/ws/agent`
- Client message:

```json
{
  "type": "prompt",
  "conversation_id": "conv-...",
  "promptText": "...",
  "user_id": "admin"
}
```

- Server messages: `ready`, repeated `heartbeat`/`agent_event`, then exactly one
  `result` or `error`. Step events carry model-call count, tool-execution count,
  and termination reason. Ping + JSON heartbeat frames keep long turns live;
  CPU-heavy Python must use an asynchronous child process so Node can emit them.
  The browser retries transient handshake failures up to three times, but only
  before `ready` and prompt submission; post-submit disconnects are never retried.
  Gateway logs record upgrade rejection, connection origin, and close code.
- Configure `ALLOWED_ORIGINS` in ACA as a comma-separated exact list containing
  the production SWA origin.
- Configure `ACA_GATEWAY_CLIENT_ID` and `ENTRA_TENANT_ID`; the first prompt
  message must carry an Entra access token whose signature, expiration,
  issuer, tenant, and audience are verified by the gateway. `ADMIN_OBJECT_IDS`
  maps selected Entra object IDs to the existing `admin` catalog identity.
  The React client acquires the token with MSAL using
  `VITE_ENTRA_TENANT_ID`, `VITE_ENTRA_CLIENT_ID`, and `VITE_GATEWAY_SCOPE`.
  `ALLOW_INSECURE_USER_ID=true` exists only for local development.
- Configure the React build variable `VITE_AGENT_WS_URL` to the ACA ingress URL,
  e.g. `wss://<gateway>.<region>.azurecontainerapps.io/ws/agent`.

## Local run

```powershell
npm run start:gateway
cd src/react-app
npm run dev
```

Vite connects to `ws://localhost:8080/ws/agent` by default in development.

## Deploy outline

1. Build and push `Dockerfile.gateway` to ACR.
2. Deploy/update an external-ingress ACA app with target port 8080, WebSocket
   support, managed identity, and `minReplicas=1`, `maxReplicas=1` initially.
3. Supply the Foundry project/model, artifact-service, origin, and identity
   environment configuration already used by the hosted-agent runtime. Optional
   `PYTHON_TIMEOUT_MS` and `PYTHON_CPU_SECS` override scientific-run limits.
4. Set `VITE_AGENT_WS_URL` in the SWA build and redeploy the frontend. The
   canonical production SWA is `react_app` at
   `https://icy-forest-04e89460f.7.azurestaticapps.net`; the separately created
   `foundry-orchestrator-ui` resource is an empty Azure placeholder, not this app.
5. Smoke a prompt-reference turn and verify a reader discovery round is
   followed by planner re-entry before statistician execution.

The browser persists the active `conversation_id` across reloads. Terminal
artifact collection uploads pending files to artifact-service storage without
publishing them into the catalog; the returned URLs are rendered through the
in-app authenticated viewer. Generic failures still return a terminal partial
result. If the user intentionally starts a new conversation, `import_run_file`
can recover an explicitly named same-user prior-run file.
