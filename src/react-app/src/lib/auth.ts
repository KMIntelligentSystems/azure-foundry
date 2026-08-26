import { PublicClientApplication, type AccountInfo } from "@azure/msal-browser";

const clientId = (import.meta.env.VITE_ENTRA_CLIENT_ID as string | undefined)?.trim();
const tenantId = (import.meta.env.VITE_ENTRA_TENANT_ID as string | undefined)?.trim();
const scope = (import.meta.env.VITE_GATEWAY_SCOPE as string | undefined)?.trim();

let application: PublicClientApplication | null = null;
let initialized: Promise<void> | null = null;

function msal(): PublicClientApplication {
  if (!clientId || !tenantId || !scope) {
    throw new Error("VITE_ENTRA_CLIENT_ID, VITE_ENTRA_TENANT_ID, and VITE_GATEWAY_SCOPE must be configured");
  }
  if (!application) {
    application = new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri: window.location.origin,
      },
      cache: { cacheLocation: "sessionStorage" },
    });
  }
  return application;
}

async function ready(): Promise<PublicClientApplication> {
  const app = msal();
  initialized ??= app.initialize();
  await initialized;
  return app;
}

function account(app: PublicClientApplication): AccountInfo | null {
  return app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null;
}

export async function signIn(): Promise<{ userId: string }> {
  const app = await ready();
  const result = await app.loginPopup({ scopes: [scope!] });
  app.setActiveAccount(result.account);
  return { userId: (result.account.username || result.account.localAccountId).trim().toLowerCase() };
}

export async function signOut(): Promise<void> {
  const app = await ready();
  const current = account(app);
  if (current) await app.logoutPopup({ account: current, postLogoutRedirectUri: window.location.origin });
}

export async function currentUser(): Promise<string | null> {
  const app = await ready();
  const current = account(app);
  return current ? (current.username || current.localAccountId).trim().toLowerCase() : null;
}

export async function acquireGatewayToken(): Promise<string> {
  const app = await ready();
  const current = account(app);
  if (!current) throw new Error("Sign in with Microsoft before invoking the orchestrator");
  try {
    return (await app.acquireTokenSilent({ account: current, scopes: [scope!] })).accessToken;
  } catch {
    return (await app.acquireTokenPopup({ account: current, scopes: [scope!] })).accessToken;
  }
}
