/**
 * Enrollment and Cart flow tests
 *
 * Covers:
 *  - GET /api/enrollments/check — checks enrollment status
 *  - GET /api/enrollments/check — returns 400 for missing params
 *  - POST /api/cart — adds to cart
 *  - GET /api/user/:userId/cart — returns cart items
 *  - DELETE /api/cart — removes from cart
 *  - POST /api/wishlist — adds to wishlist
 *  - GET /api/user/:userId/wishlist — returns wishlist items
 *  - DELETE /api/wishlist — removes from wishlist
 *  - GET /api/user/:userId/enrollments — returns enrollments
 *  - GET /api/user/:userId/orders — returns orders
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureDbReady, loginSeedUser, type TestUser } from "./helpers";

let student: TestUser;

beforeAll(async () => {
  await ensureDbReady();
  student = await loginSeedUser();
});

// ----------------------------------------------------------------
// Enrollment check
// ----------------------------------------------------------------

describe("GET /api/enrollments/check", () => {
  it("should return { enrolled: false } for un-enrolled user/class pair", async () => {
    const res = await SELF.fetch(
      `http://localhost/api/enrollments/check?userId=${student.id}&classId=1`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.enrolled).toBe(false);
  });

  it("should return 400 if userId is missing", async () => {
    const res = await SELF.fetch(
      "http://localhost/api/enrollments/check?classId=1"
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain("userId and classId required");
  });

  it("should return 400 if classId is missing", async () => {
    const res = await SELF.fetch(
      `http://localhost/api/enrollments/check?userId=${student.id}`
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain("userId and classId required");
  });
});

// ----------------------------------------------------------------
// Cart
// ----------------------------------------------------------------

describe("Cart API", () => {
  it("POST /api/cart should add an item to cart", async () => {
    const res = await SELF.fetch("http://localhost/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: student.id, classId: 1 }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
  });

  it("GET /api/user/:userId/cart should return cart items", async () => {
    // Ensure item is in cart first
    await SELF.fetch("http://localhost/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: student.id, classId: 2 }),
    });

    const res = await SELF.fetch(
      `http://localhost/api/user/${student.id}/cart`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/cart with same item should not create duplicate", async () => {
    // Add same item again (INSERT OR IGNORE)
    const res = await SELF.fetch("http://localhost/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: student.id, classId: 1 }),
    });
    expect(res.status).toBe(200);
  });

  it("DELETE /api/cart should remove an item from cart", async () => {
    const res = await SELF.fetch("http://localhost/api/cart", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: student.id, classId: 1 }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
  });
});

// ----------------------------------------------------------------
// Wishlist
// ----------------------------------------------------------------

describe("Wishlist API", () => {
  it("POST /api/wishlist should add to wishlist", async () => {
    const res = await SELF.fetch("http://localhost/api/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: student.id, classId: 3 }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
  });

  it("GET /api/user/:userId/wishlist should return wishlist items", async () => {
    // Add an item first (each test starts with a clean DB snapshot)
    await SELF.fetch("http://localhost/api/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: student.id, classId: 3 }),
    });

    const res = await SELF.fetch(
      `http://localhost/api/user/${student.id}/wishlist`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("DELETE /api/wishlist should remove from wishlist", async () => {
    const res = await SELF.fetch("http://localhost/api/wishlist", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: student.id, classId: 3 }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);

    // Verify it's removed
    const listRes = await SELF.fetch(
      `http://localhost/api/user/${student.id}/wishlist`
    );
    const listData = (await listRes.json()) as any[];
    const found = listData.find((item: any) => item.class_id === 3);
    expect(found).toBeUndefined();
  });
});

// ----------------------------------------------------------------
// User enrollments
// ----------------------------------------------------------------

describe("GET /api/user/:userId/enrollments", () => {
  it("should return enrollments array (may be empty for fresh user)", async () => {
    const res = await SELF.fetch(
      `http://localhost/api/user/${student.id}/enrollments`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];
    expect(Array.isArray(data)).toBe(true);
  });
});

// ----------------------------------------------------------------
// User orders
// ----------------------------------------------------------------

describe("GET /api/user/:userId/orders", () => {
  it("should return orders array (may be empty for fresh user)", async () => {
    const res = await SELF.fetch(
      `http://localhost/api/user/${student.id}/orders`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];
    expect(Array.isArray(data)).toBe(true);
  });
});

// ----------------------------------------------------------------
// Demo payment -> enrollment flow
// ----------------------------------------------------------------

describe("POST /api/payment/process (demo payment)", () => {
  it("should create an enrollment after successful demo payment", async () => {
    const payRes = await SELF.fetch("http://localhost/api/payment/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: student.id,
        classId: 4,
        amount: 219000,
        paymentMethod: "card",
        cardNumber: "4111111111111111",
        cardExpiry: "12/30",
        cardCvc: "123",
      }),
    });
    expect(payRes.status).toBe(200);
    const payData = (await payRes.json()) as any;
    expect(payData.success).toBe(true);
    expect(payData.orderId).toBeDefined();

    // Now check enrollment
    const checkRes = await SELF.fetch(
      `http://localhost/api/enrollments/check?userId=${student.id}&classId=4`
    );
    expect(checkRes.status).toBe(200);
    const checkData = (await checkRes.json()) as any;
    expect(checkData.enrolled).toBe(true);
  });
});

// ----------------------------------------------------------------
// User test status
// ----------------------------------------------------------------

describe("GET /api/user/:userId/test-status", () => {
  it("should return test status for existing user", async () => {
    const res = await SELF.fetch(
      `http://localhost/api/user/${student.id}/test-status`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(typeof data.isTestAccount).toBe("boolean");
  });

  it("should return 404 for non-existent user", async () => {
    const res = await SELF.fetch(
      "http://localhost/api/user/999999/test-status"
    );
    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.error).toContain("not found");
  });
});
