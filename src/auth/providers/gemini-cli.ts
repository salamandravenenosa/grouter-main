import type { OAuthAdapter, NormalizedTokens } from "../types.ts";

// Public OAuth credentials from the official Gemini CLI (google-gemini/gemini-cli).
// Google classifies these as "installed application" credentials — shipping the
// client secret in binaries is expected for this OAuth flow type.
const CONFIG = {
  clientId: "REMOVED_BY_USER",
  clientSecret: "REMOVED_BY_USER",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
  codeChallengeMethod: "S256",
};
const SETUP_TIMEOUT_MS = 12_000;

function parseJwtClaims(token: string): Record<string, unknown> {
  try {
    const base64 = token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "";
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readNumberField(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function toExpiresInSeconds(obj: Record<string, unknown>): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const explicit = readNumberField(obj, ["expires_in", "expiresIn"]);
  if (explicit && explicit > 0) return Math.floor(explicit);

  const expiryRaw = readNumberField(obj, ["expiry_date", "expiryDate", "expires_at", "expiresAt"]);
  if (expiryRaw) {
    const expirySec = expiryRaw > 1e12 ? Math.floor(expiryRaw / 1000) : Math.floor(expiryRaw);
    const diff = expirySec - nowSec;
    if (diff > 0) return diff;
  }

  const expiryIso = readStringField(obj, ["expiry_date", "expiryDate", "expires_at", "expiresAt"]);
  if (expiryIso) {
    const ms = Date.parse(expiryIso);
    if (Number.isFinite(ms)) {
      const diff = Math.floor(ms / 1000) - nowSec;
      if (diff > 0) return diff;
    }
  }

  return 3600;
}

function parseGeminiImportInput(rawInput: string): Record<string, unknown> {
  const input = rawInput.trim();
  if (!input) throw new Error("Empty input. Paste Gemini auth.json content or a token.");

  if (!input.startsWith("{")) {
    return {
      access_token: input,
      expires_in: 3600,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input) as Record<string, unknown>;
  } catch {
    throw new Error("auth.json parse failed. Ensure you pasted valid JSON.");
  }

  const candidates: Record<string, unknown>[] = [parsed];
  for (const key of ["tokens", "credential", "credentials", "auth"]) {
    const value = parsed[key];
    if (value && typeof value === "object") candidates.push(value as Record<string, unknown>);
  }

  const tokenLike = candidates.find((c) =>
    !!readStringField(c, ["access_token", "accessToken", "refresh_token", "refreshToken", "id_token", "idToken"]),
  ) ?? parsed;

  const accessToken = readStringField(tokenLike, ["access_token", "accessToken"]);
  const refreshToken = readStringField(tokenLike, ["refresh_token", "refreshToken"]);
  const idToken = readStringField(tokenLike, ["id_token", "idToken"]);
  const scope = readStringField(tokenLike, ["scope"]);

  if (!accessToken && !refreshToken) {
    throw new Error("auth.json is missing access_token/refresh_token.");
  }

  const normalized: Record<string, unknown> = {};
  if (accessToken) normalized.access_token = accessToken;
  if (refreshToken) normalized.refresh_token = refreshToken;
  if (idToken) normalized.id_token = idToken;
  if (scope) normalized.scope = scope;
  if (accessToken) normalized.expires_in = toExpiresInSeconds(tokenLike);
  return normalized;
}

function normalize(tokens: Record<string, unknown>): NormalizedTokens {
  const expiresIn = (tokens.expires_in as number | undefined) ?? 3600;
  let email: string | null = null;
  let displayName: string | null = null;

  if (typeof tokens.id_token === "string") {
    const claims = parseJwtClaims(tokens.id_token);
    email = typeof claims.email === "string" ? claims.email : null;
    displayName = typeof claims.name === "string" ? claims.name : email;
  }

  return {
    accessToken: tokens.access_token as string,
    refreshToken: (tokens.refresh_token as string | undefined) ?? null,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    email,
    displayName,
    providerData: {
      scope: (tokens.scope as string | undefined) ?? null,
      idToken: (tokens.id_token as string | undefined) ?? null,
    },
  };
}

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com/v1internal";
const RESOURCE_MGR_BASE = "https://cloudresourcemanager.googleapis.com/v1";
const SERVICE_USAGE_BASE = "https://serviceusage.googleapis.com/v1";
const CODE_ASSIST_SERVICE = "cloudaicompanion.googleapis.com";
const FREE_TIER_ID = "free-tier";
const CORE_METADATA = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Find an existing active GCP project or create one.
// Uses the `cloud-platform` scope already granted at OAuth time.
async function findOrCreateProject(accessToken: string): Promise<{ projectId: string; created: boolean }> {
  const h = authHeader(accessToken);
  // 1. List existing projects
  const listResp = await fetch(`${RESOURCE_MGR_BASE}/projects?filter=lifecycleState:ACTIVE`, { headers: h });
  if (listResp.ok) {
    const data = await listResp.json() as { projects?: { projectId: string; lifecycleState?: string }[] };
    const active = (data.projects ?? []).find((p) => (p.lifecycleState ?? "ACTIVE") === "ACTIVE");
    if (active) return { projectId: active.projectId, created: false };
  }

  // 2. Create one. projectId must be 6–30 chars, lowercase letters/digits/hyphens.
  const newId = `grouter-gemini-${Date.now().toString(36)}`.slice(0, 30);
  const createResp = await fetch(`${RESOURCE_MGR_BASE}/projects`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ projectId: newId, name: "grouter Gemini" }),
  });
  if (!createResp.ok) {
    throw new Error(`Failed to create GCP project: ${createResp.status} ${await createResp.text()}`);
  }
  let op = await createResp.json() as Record<string, unknown>;

  // Poll project-creation LRO (~15s typical).
  const deadline = Date.now() + 45_000;
  while (op.done !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const name = op.name as string | undefined;
    if (!name) break;
    op = await (await fetch(`${RESOURCE_MGR_BASE}/${name}`, { headers: h })).json() as Record<string, unknown>;
  }
  return { projectId: newId, created: true };
}

// Enable cloudaicompanion.googleapis.com on a project. Idempotent.
async function enableCodeAssistService(accessToken: string, projectId: string): Promise<void> {
  const h = authHeader(accessToken);
  const resp = await fetch(
    `${SERVICE_USAGE_BASE}/projects/${projectId}/services/${CODE_ASSIST_SERVICE}:enable`,
    { method: "POST", headers: h, body: "{}" },
  );
  if (!resp.ok && resp.status !== 409) {
    throw new Error(`Failed to enable Code Assist API: ${resp.status} ${await resp.text()}`);
  }
  let op = await resp.json() as Record<string, unknown>;
  const deadline = Date.now() + 30_000;
  while (op.done !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const name = op.name as string | undefined;
    if (!name) break;
    op = await (await fetch(`${SERVICE_USAGE_BASE}/${name}`, { headers: h })).json() as Record<string, unknown>;
  }
}

// First-time Code Assist bootstrap: eligibility check + project provisioning
// (if needed) + onboarding. For free-tier users Google manages the project;
// for standard-tier we pick an existing project or create one automatically
// using the cloud-platform scope. Failures record the error in providerData
// so the runtime can surface it instead of blocking `grouter add`.
async function setupCodeAssist(accessToken: string): Promise<{
  onboarded: boolean;
  cloudProject: string | null;
  tier: string | null;
  error?: string;
}> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID ?? null;
  const h = authHeader(accessToken);

  const loadResp = await fetch(`${CODE_ASSIST_BASE}:loadCodeAssist`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      cloudaicompanionProject: envProject,
      metadata: { ...CORE_METADATA, ...(envProject ? { duetProject: envProject } : {}) },
    }),
  });
  if (!loadResp.ok) {
    return { onboarded: false, cloudProject: envProject, tier: null, error: `loadCodeAssist ${loadResp.status}: ${await loadResp.text()}` };
  }
  const load = await loadResp.json() as Record<string, unknown>;
  const tiers = (load.allowedTiers as { id: string; isDefault?: boolean; userDefinedCloudaicompanionProject?: boolean }[] | undefined) ?? [];
  const currentTier = load.currentTier as { id: string; userDefinedCloudaicompanionProject?: boolean } | undefined;
  const returnedProject = (load.cloudaicompanionProject as string | undefined) ?? null;

  const pickedTier = currentTier ?? tiers.find((t) => t.isDefault) ?? tiers[0];
  const tierId = pickedTier?.id ?? FREE_TIER_ID;
  const needsProject = pickedTier?.userDefinedCloudaicompanionProject === true;

  // Free-tier (or any tier Google manages the project for): no action needed
  // beyond onboarding if not yet onboarded.
  let cloudProject: string | null = envProject ?? returnedProject;

  if (needsProject && !cloudProject) {
    try {
      const { projectId } = await findOrCreateProject(accessToken);
      await enableCodeAssistService(accessToken, projectId);
      cloudProject = projectId;
    } catch (e) {
      return {
        onboarded: false,
        cloudProject: null,
        tier: tierId,
        error: `Auto-project setup failed: ${(e as Error).message}. Set GOOGLE_CLOUD_PROJECT and retry.`,
      };
    }
  }

  // Already onboarded AND we already know the project it's attached to → done.
  if (currentTier && (!needsProject || cloudProject)) {
    return { onboarded: true, cloudProject, tier: tierId };
  }

  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: { ...CORE_METADATA, ...(cloudProject ? { duetProject: cloudProject } : {}) },
  };
  if (tierId === FREE_TIER_ID) {
    // Free tier: Google manages the project. Explicitly omit the field.
  } else if (cloudProject) {
    onboardBody.cloudaicompanionProject = cloudProject;
  }

  let op = await (await fetch(`${CODE_ASSIST_BASE}:onboardUser`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(onboardBody),
  })).json() as Record<string, unknown>;

  const deadline = Date.now() + 30_000;
  while (op.done !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const name = op.name as string | undefined;
    if (!name) break;
    op = await (await fetch(`${CODE_ASSIST_BASE}/${name}`, { headers: h })).json() as Record<string, unknown>;
  }

  return { onboarded: op.done === true, cloudProject, tier: tierId };
}

async function setupCodeAssistWithTimeout(accessToken: string): Promise<{
  onboarded: boolean;
  cloudProject: string | null;
  tier: string | null;
  error?: string;
}> {
  return await Promise.race([
    setupCodeAssist(accessToken),
    Bun.sleep(SETUP_TIMEOUT_MS).then(() => ({
      onboarded: false,
      cloudProject: null,
      tier: null,
      error: `Code Assist setup timeout after ${SETUP_TIMEOUT_MS / 1000}s`,
    })),
  ]);
}

export const geminiCliAdapter: OAuthAdapter = {
  id: "gemini-cli",
  flow: "authorization_code_pkce",

  buildAuthUrl({ redirectUri, state, codeChallenge }) {
    if (!codeChallenge) throw new Error("codeChallenge required for Gemini CLI");
    const params = new URLSearchParams({
      client_id: CONFIG.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: CONFIG.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CONFIG.codeChallengeMethod,
      access_type: "offline",
      prompt: "consent",
    });
    return `${CONFIG.authorizeUrl}?${params}`;
  },

  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const resp = await fetch(CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier ?? "",
      }),
    });
    if (!resp.ok) throw new Error(`Gemini CLI token exchange failed: ${await resp.text()}`);
    const data = await resp.json() as Record<string, unknown>;
    const normalized = normalize(data);

    // Code Assist requires a one-time onboarding before any generateContent call
    // will succeed. Best-effort: failures are recorded in providerData so the
    // runtime can surface them, but don't block saving the account.
    try {
      const setup = await setupCodeAssistWithTimeout(normalized.accessToken);
      normalized.providerData = {
        ...(normalized.providerData ?? {}),
        onboarded: setup.onboarded,
        cloudProject: setup.cloudProject,
        tier: setup.tier,
        ...(setup.error ? { onboardError: setup.error } : {}),
      };
    } catch (e) {
      normalized.providerData = {
        ...(normalized.providerData ?? {}),
        onboarded: false,
        onboardError: (e as Error).message,
      };
    }

    return normalized;
  },

  async refresh({ refreshToken }) {
    if (!refreshToken) return null;
    const resp = await fetch(CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
        refresh_token: refreshToken,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;
    if (!data.access_token) return null;
    return normalize(data);
  },

  async importToken(rawInput) {
    const imported = parseGeminiImportInput(rawInput);
    let merged = imported;

    if (!merged.access_token && typeof merged.refresh_token === "string") {
      const resp = await fetch(CONFIG.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CONFIG.clientId,
          client_secret: CONFIG.clientSecret,
          refresh_token: merged.refresh_token,
        }),
      });
      if (!resp.ok) {
        throw new Error(`Gemini CLI refresh from auth.json failed: ${await resp.text()}`);
      }
      const refreshed = await resp.json() as Record<string, unknown>;
      merged = {
        ...merged,
        ...refreshed,
        refresh_token: (refreshed.refresh_token as string | undefined) ?? (merged.refresh_token as string | undefined),
      };
    }

    if (typeof merged.access_token !== "string" || !merged.access_token) {
      throw new Error("auth.json import failed: no usable access_token.");
    }
    if (typeof merged.expires_in !== "number") {
      merged.expires_in = toExpiresInSeconds(merged);
    }

    const normalized = normalize(merged);

    try {
      const setup = await setupCodeAssistWithTimeout(normalized.accessToken);
      normalized.providerData = {
        ...(normalized.providerData ?? {}),
        onboarded: setup.onboarded,
        cloudProject: setup.cloudProject,
        tier: setup.tier,
        importedAuthJson: true,
        ...(setup.error ? { onboardError: setup.error } : {}),
      };
    } catch (e) {
      normalized.providerData = {
        ...(normalized.providerData ?? {}),
        onboarded: false,
        importedAuthJson: true,
        onboardError: (e as Error).message,
      };
    }

    return normalized;
  },
};
