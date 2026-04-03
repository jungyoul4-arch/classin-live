/**
 * Test helpers for ClassIn Live API integration tests.
 *
 * Provides utilities to:
 *  - Initialize D1 with all migrations + seed data
 *  - Register/login a test user and obtain a JWT token
 *  - Create an admin session and obtain a session cookie
 */
import { env, SELF } from "cloudflare:test";
import { applyAllMigrations, applySeedData } from "./db-helpers";

// ----------------------------------------------------------------
// Database bootstrap
// ----------------------------------------------------------------

let dbInitialized = false;

/**
 * Ensure the D1 database has all migrations and seed data applied.
 * Safe to call multiple times; only runs once per worker lifecycle.
 */
export async function ensureDbReady(): Promise<void> {
  if (dbInitialized) return;

  const migrationResults = await applyAllMigrations(env.DB);
  const failures = migrationResults.filter((r) => !r.success);
  if (failures.length > 0) {
    const msgs = failures.map((f) => `${f.file}: ${f.error}`).join("\n");
    throw new Error(`Migration failures:\n${msgs}`);
  }

  const seedResult = await applySeedData(env.DB);
  if (!seedResult.success) {
    throw new Error(`Seed data failure: ${seedResult.error}`);
  }

  dbInitialized = true;
}

// ----------------------------------------------------------------
// Auth helpers
// ----------------------------------------------------------------

export interface TestUser {
  id: number;
  email: string;
  name: string;
  token: string;
}

/**
 * Register a brand-new user via the API and return the user + JWT token.
 */
export async function registerTestUser(
  overrides: { email?: string; password?: string; name?: string } = {}
): Promise<TestUser> {
  const email = overrides.email ?? `test-${Date.now()}@example.com`;
  const password = overrides.password ?? "testpass123";
  const name = overrides.name ?? "Test User";

  const res = await SELF.fetch("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`registerTestUser failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as any;
  return {
    id: data.user.id,
    email: data.user.email,
    name: data.user.name,
    token: data.token,
  };
}

/**
 * Login with existing seed user credentials and return JWT token.
 * Default credentials use the seed student: student1@test.com / test1234
 */
export async function loginSeedUser(
  email = "student1@test.com",
  password = "test1234"
): Promise<TestUser> {
  const res = await SELF.fetch("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`loginSeedUser failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as any;
  return {
    id: data.user.id,
    email: data.user.email,
    name: data.user.name,
    token: data.token,
  };
}

// ----------------------------------------------------------------
// Admin helpers
// ----------------------------------------------------------------

/**
 * Perform admin login via form POST and extract the session cookie.
 * Default credentials: admin / jungyoul1234 (from seed/migration 0010).
 */
export async function getAdminSessionCookie(
  username = "admin",
  password = "jungyoul1234"
): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: "manual", // Don't follow the 302 redirect
  });

  // The login endpoint returns 302 with a Set-Cookie header on success
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const match = setCookie.match(/admin_session=([^;]+)/);
  if (!match) {
    throw new Error(
      `Admin login failed: no session cookie. Status: ${res.status}, Set-Cookie: ${setCookie}`
    );
  }

  return match[1];
}

/**
 * Build a Cookie header value for admin requests.
 */
export function adminCookieHeader(sessionToken: string): string {
  return `admin_session=${sessionToken}`;
}
