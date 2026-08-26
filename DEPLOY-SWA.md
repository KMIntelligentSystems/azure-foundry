# Deploy to Azure Static Web Apps

The SWA CLI has Windows compatibility issues. Use GitHub Actions instead:

## 1. Push to GitHub

```bash
cd c:/repos/azure-foundry
git remote add origin https://github.com/<your-username>/azure-foundry.git
git push -u origin main
```

## 2. Link SWA to GitHub

```bash
az staticwebapp update \
  --name foundry-orchestrator-ui \
  --resource-group nowcasting \
  --source https://github.com/<your-username>/azure-foundry \
  --branch main \
  --login-with-github
```

This creates a GitHub Actions workflow that auto-deploys on push.

## 3. Configure the workflow

Azure creates `.github/workflows/azure-static-web-apps-*.yml`. Edit it to:

```yaml
app_location: "src/react-app"
api_location: "src/api"
output_location: "dist"
```

## 3a. host.json timeouts (the 500 trap)

`src/api/host.json` carries `functionTimeout: "00:08:00"`. **Do not delete** —
the orchestrator's ADL/statistician loop takes 30–60s+; without it the SWA
Function dies at Azure's default 30s window and the browser sees 500.

## 4. Set secrets

In GitHub repo → Settings → Secrets:
- `AZURE_STATIC_WEB_APPS_API_TOKEN` — from `az staticwebapp secrets list`

## 5. Push to deploy

```bash
git add .
git commit -m "Deploy"
git push
```

The workflow builds and deploys automatically.

## Alternative: Manual upload via Portal

1. Zip the built files:
   ```bash
   cd src/react-app/dist && zip -r ../../swa-dist.zip .
   cd ../../src/api && zip -r ../swa-api.zip .
   ```

2. Azure Portal → foundry-orchestrator-ui → Deployment → Upload
   - Upload `swa-dist.zip` as the frontend
   - Upload `swa-api.zip` as the API

## Current status

- SWA resource: `foundry-orchestrator-ui` ✅
- URL: https://victorious-plant-0c13ce10f.7.azurestaticapps.net
- React build: ✅ (dist/ ready)
- API build: ✅ (dist/ ready)
- Deployment: ✅ via GitHub Actions on push to `azure-foundary`.
  2026-08-24 fix: the Azure-generated workflow defaulted to
  `app_location: "/"` → Oryx found no index.html at repo root
  ("Oryx was unable to determine the build steps"). Corrected to the
  §3 config above (`src/react-app` + `src/api`, output `dist`).
