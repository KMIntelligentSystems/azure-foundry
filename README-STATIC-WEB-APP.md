# Azure Static Web App Setup

## Structure

```
azure-foundry/
├── src/
│   ├── react-app/          # React frontend (Vite)
│   │   ├── src/
│   │   │   ├── App.tsx     # Trimmed from http_proxy — prompt/response/artifacts
│   │   │   └── App.css     # Dark theme styles from http_proxy
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── api/                # Azure Functions backend
│       ├── invoke/
│       │   ├── index.ts    # POST /api/invoke → Foundry hosted agent
│       │   └── function.json
│       ├── host.json
│       └── package.json
└── staticwebapp.config.json # SWA routing config
```

## What was trimmed from http_proxy React

**Removed:**
- Login/auth flow (anonymous for now)
- ModelSelector (planner decides deployments)
- SchedulerPanel (daemon machinery, not orchestrator)
- LookupPanel (http_proxy-specific UI)
- CatalogTree (artifact management — can add back later)
- DocumentViewer (artifact preview — can add back later)
- WS event handling (pi harness uses WS; Foundry React uses HTTP)

**Kept:**
- Dark theme CSS (App.css)
- Prompt input + submit
- Response display (plan, steps, artifacts)
- Conversation tracking (conversation_id)

## Local dev

```bash
# Terminal 1: React dev server
cd src/react-app
npm install
npm run dev          # http://localhost:5173

# Terminal 2: Azure Functions
cd src/api
npm install
npm run build
func start           # http://localhost:7071
```

The Vite dev server proxies `/api/*` to `localhost:7071`.

## Deploy to Azure Static Web Apps

```bash
# 1. Create the SWA resource
az staticwebapp create \
  --name foundry-orchestrator-ui \
  --resource-group nowcasting \
  --location eastus2 \
  --sku Free

# 2. Build the React app
cd src/react-app
npm run build        # outputs to dist/

# 3. Deploy (SWA CLI or GitHub Actions)
# Option A: SWA CLI
npm install -g @azure/static-web-apps-cli
swa deploy ./src/react-app/dist \
  --api-location ./src/api \
  --app-name foundry-orchestrator-ui \
  --resource-group nowcasting

# Option B: GitHub Actions (recommended for CI/CD)
# Push to GitHub, link the SWA to the repo, and Azure auto-generates the workflow.
```

## Environment variables (set in Azure Portal → SWA → Configuration)

- `AZURE_AI_PROJECT_ENDPOINT` — Foundry project endpoint
- `AGENT_NAME` — hosted agent name (default: `orchestrator`)

The Function uses `DefaultAzureCredential` → managed identity in Azure (assign it
to the SWA's managed identity + grant Foundry User role), or `az login` locally.

## What the Function does

1. Receives `POST /api/invoke { conversation_id, promptText }` from React
2. Gets an Entra token (cached)
3. Creates a hosted agent session
4. Calls `POST …/agents/orchestrator/endpoint/protocols/invocations` with the prompt
5. Returns the orchestrator's JSON (plan, steps, artifacts, response)
6. Deletes the session

The React app displays the plan, steps, artifacts, and final response.
