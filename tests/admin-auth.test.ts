/**
 * Admin API authentication tests
 *
 * Covers:
 *  - Admin middleware blocks unauthenticated requests (403)
 *  - POST /api/admin/login is accessible without auth
 *  - Admin login creates session cookie (302 redirect)
 *  - Admin endpoints work WITH valid session cookie
 *  - Invalid admin credentials are rejected
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureDbReady, getAdminSessionCookie, adminCookieHeader } from "./helpers";

beforeAll(async () => {
  await ensureDbReady();
});

// ----------------------------------------------------------------
// Middleware — blocks unauthenticated requests
// ----------------------------------------------------------------

describe("Admin middleware blocks unauthenticated requests", () => {
  it("GET /api/admin/classes returns 403 without session cookie", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/classes");
    expect(res.status).toBe(403);
    const data = (await res.json()) as any;
    expect(data.error).toContain("관리자 권한");
  });

  it("GET /api/admin/users returns 403 without session cookie", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/users");
    expect(res.status).toBe(403);
    const data = (await res.json()) as any;
    expect(data.error).toContain("관리자 권한");
  });

  it("GET /api/admin/test-codes returns 403 without session cookie", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/test-codes");
    expect(res.status).toBe(403);
  });

  it("returns 403 with an invalid/expired session cookie", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/classes", {
      headers: { Cookie: "admin_session=totally-fake-token-12345" },
    });
    expect(res.status).toBe(403);
  });
});

// ----------------------------------------------------------------
// Admin login
// ----------------------------------------------------------------

describe("POST /api/admin/login", () => {
  it("is accessible without auth (not blocked by middleware)", async () => {
    // Even without a session cookie, the login endpoint should not return 403
    const res = await SELF.fetch("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "wrong",
        password: "wrong",
      }).toString(),
      redirect: "manual",
    });
    // It should redirect (302) to login page with error, NOT return 403
    expect(res.status).not.toBe(403);
    // Invalid credentials should redirect to /admin/login?error=invalid
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("/admin/login");
    expect(location).toContain("error=invalid");
  });

  it("creates session cookie with valid credentials", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "admin",
        password: "jungyoul1234",
      }).toString(),
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toBe("/admin");

    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("rejects invalid username", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "notadmin",
        password: "jungyoul1234",
      }).toString(),
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("error=invalid");
  });

  it("rejects invalid password", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "admin",
        password: "wrongpassword",
      }).toString(),
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("error=invalid");
  });
});

// ----------------------------------------------------------------
// Admin endpoints WITH valid session cookie
// ----------------------------------------------------------------

describe("Admin endpoints with valid session", () => {
  let sessionToken: string;

  beforeAll(async () => {
    sessionToken = await getAdminSessionCookie();
  });

  it("GET /api/admin/classes succeeds with session cookie", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/classes", {
      headers: { Cookie: adminCookieHeader(sessionToken) },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    // Admin classes endpoint returns { classes: [...] }
    expect(data.classes).toBeDefined();
    expect(Array.isArray(data.classes)).toBe(true);
    expect(data.classes.length).toBeGreaterThan(0);
  });

  it("GET /api/admin/users succeeds with session cookie", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/users", {
      headers: { Cookie: adminCookieHeader(sessionToken) },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    // Admin users endpoint returns { users: [...], total, stats }
    expect(data.users).toBeDefined();
    expect(Array.isArray(data.users)).toBe(true);
    // Seed data has at least 10 users
    expect(data.users.length).toBeGreaterThanOrEqual(10);
    expect(data.total).toBeGreaterThanOrEqual(10);
    expect(data.stats).toBeDefined();
  });

  it("GET /api/admin/test-codes succeeds with session cookie", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/test-codes", {
      headers: { Cookie: adminCookieHeader(sessionToken) },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(Array.isArray(data)).toBe(true);
  });
});
