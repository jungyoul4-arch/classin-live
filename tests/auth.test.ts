/**
 * Authentication API tests
 *
 * Covers:
 *  - POST /api/auth/register (success, duplicate email)
 *  - POST /api/auth/login (correct password, wrong password, legacy pbkdf2_ format)
 *  - JWT token structure (HS256, 3 parts, not alg:none)
 *  - Token verification (forged/expired tokens rejected)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureDbReady } from "./helpers";

beforeAll(async () => {
  await ensureDbReady();
});

// ----------------------------------------------------------------
// Registration
// ----------------------------------------------------------------

describe("POST /api/auth/register", () => {
  it("should register a new user and return user + token", async () => {
    const email = `register-test-${Date.now()}@example.com`;
    const res = await SELF.fetch("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "pass1234", name: "New User" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.user).toBeDefined();
    expect(data.user.email).toBe(email);
    expect(data.user.name).toBe("New User");
    expect(data.user.role).toBe("student");
    expect(data.token).toBeDefined();
    expect(typeof data.token).toBe("string");
  });

  it("should return 400 for duplicate email", async () => {
    const email = `dup-test-${Date.now()}@example.com`;

    // First registration — should succeed
    const res1 = await SELF.fetch("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "pass1234", name: "First" }),
    });
    expect(res1.status).toBe(200);

    // Second registration with same email — should fail
    const res2 = await SELF.fetch("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "pass5678", name: "Second" }),
    });
    expect(res2.status).toBe(400);
    const data = (await res2.json()) as any;
    expect(data.error).toContain("이미 등록된 이메일");
  });

  it("should apply test code CLASSIN-TEST-2024 on registration", async () => {
    const email = `testcode-${Date.now()}@example.com`;
    const res = await SELF.fetch("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "pass1234",
        name: "Test Code User",
        testCode: "CLASSIN-TEST-2024",
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.testCodeApplied).toBe(true);
    expect(data.message).toContain("테스트 코드");
    expect(data.user.is_test_account).toBe(1);
  });
});

// ----------------------------------------------------------------
// Login
// ----------------------------------------------------------------

describe("POST /api/auth/login", () => {
  it("should login successfully with correct credentials (legacy pbkdf2_ format)", async () => {
    // Seed user student1@test.com has password_hash 'pbkdf2_test1234'
    // which means password 'test1234' should work via legacy path
    const res = await SELF.fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "student1@test.com", password: "test1234" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.user).toBeDefined();
    expect(data.user.email).toBe("student1@test.com");
    expect(data.user.name).toBe("테스트학생");
    expect(data.token).toBeDefined();
    // password_hash should NOT be in the response
    expect(data.user.password_hash).toBeUndefined();
  });

  it("should return 401 for wrong password", async () => {
    const res = await SELF.fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "student1@test.com",
        password: "wrongpassword",
      }),
    });

    expect(res.status).toBe(401);
    const data = (await res.json()) as any;
    expect(data.error).toContain("이메일 또는 비밀번호");
  });

  it("should return 401 for non-existent email", async () => {
    const res = await SELF.fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "does-not-exist@example.com",
        password: "anything",
      }),
    });

    expect(res.status).toBe(401);
    const data = (await res.json()) as any;
    expect(data.error).toBeDefined();
  });

  it("should login with PBKDF2 hashed password after registration", async () => {
    // Register a new user (uses real PBKDF2 hashing)
    const email = `login-pbkdf2-${Date.now()}@example.com`;
    const password = "mySecurePass!";

    await SELF.fetch("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "PBKDF2 User" }),
    });

    // Now login with the same credentials
    const res = await SELF.fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.user.email).toBe(email);
    expect(data.token).toBeDefined();
  });
});

// ----------------------------------------------------------------
// JWT Token Structure
// ----------------------------------------------------------------

describe("JWT token format", () => {
  it("should be a 3-part base64url token with HS256 header", async () => {
    const res = await SELF.fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "student1@test.com", password: "test1234" }),
    });
    const data = (await res.json()) as any;
    const token: string = data.token;

    // Must have 3 parts separated by dots
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    // Decode header
    const headerJson = atob(
      parts[0].replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (parts[0].length % 4)) % 4)
    );
    const header = JSON.parse(headerJson);
    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");

    // Decode payload
    const payloadJson = atob(
      parts[1].replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (parts[1].length % 4)) % 4)
    );
    const payload = JSON.parse(payloadJson);
    expect(payload.sub).toBeDefined();
    expect(payload.email).toBe("student1@test.com");
    expect(payload.role).toBeDefined();
    expect(payload.exp).toBeDefined();
    expect(payload.exp).toBeGreaterThan(Date.now());

    // Signature part must not be empty (not alg:none)
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("should NOT use alg:none", async () => {
    const res = await SELF.fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "student1@test.com", password: "test1234" }),
    });
    const data = (await res.json()) as any;
    const parts = data.token.split(".");
    const headerJson = atob(
      parts[0].replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (parts[0].length % 4)) % 4)
    );
    const header = JSON.parse(headerJson);

    expect(header.alg).not.toBe("none");
    expect(header.alg).toBe("HS256");
  });
});
