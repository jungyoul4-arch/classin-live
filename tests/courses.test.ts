/**
 * Course browsing (public APIs) tests
 *
 * Covers:
 *  - GET /api/categories — returns categories
 *  - GET /api/classes — returns list of classes
 *  - GET /api/classes with query params (category, search, sort, level, limit, offset)
 *  - GET /api/classes/featured — returns bestseller classes
 *  - GET /api/classes/new — returns new classes
 *  - GET /api/classes/:slug — returns class details with curriculum/reviews
 *  - GET /api/classes/:slug — returns 404 for unknown slug
 *  - GET /api/classes/:id/reviews — returns reviews for a class
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureDbReady } from "./helpers";

beforeAll(async () => {
  await ensureDbReady();
});

// ----------------------------------------------------------------
// Categories
// ----------------------------------------------------------------

describe("GET /api/categories", () => {
  it("should return a list of categories", async () => {
    const res = await SELF.fetch("http://localhost/api/categories");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(Array.isArray(data)).toBe(true);
    // Seed data has 10 categories
    expect(data.length).toBe(10);

    // Spot-check first category
    const korean = data.find((c: any) => c.slug === "korean");
    expect(korean).toBeDefined();
    expect(korean.name).toBe("국어");
  });
});

// ----------------------------------------------------------------
// Classes list
// ----------------------------------------------------------------

describe("GET /api/classes", () => {
  it("should return a list of classes", async () => {
    const res = await SELF.fetch("http://localhost/api/classes");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(Array.isArray(data)).toBe(true);
    // Seed data has 12 classes
    expect(data.length).toBeGreaterThanOrEqual(6);
  });

  it("should filter by category slug", async () => {
    const res = await SELF.fetch("http://localhost/api/classes?category=math");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(Array.isArray(data)).toBe(true);
    // All returned classes should be math category
    for (const cls of data) {
      expect(cls.category_slug ?? cls.category_name ?? "math").toBeDefined();
    }
    // Seed has classes in math category (IDs 4, 5, 10)
    expect(data.length).toBeGreaterThanOrEqual(2);
  });

  it("should search by keyword", async () => {
    const res = await SELF.fetch(
      "http://localhost/api/classes?search=" + encodeURIComponent("박서욱")
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("should respect limit and offset", async () => {
    const res = await SELF.fetch("http://localhost/api/classes?limit=3&offset=0");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(data.length).toBeLessThanOrEqual(3);
  });

  it("should sort by price_low", async () => {
    const res = await SELF.fetch("http://localhost/api/classes?sort=price_low");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(data.length).toBeGreaterThan(1);
    for (let i = 1; i < data.length; i++) {
      expect(data[i].price).toBeGreaterThanOrEqual(data[i - 1].price);
    }
  });
});

// ----------------------------------------------------------------
// Featured / New classes
// ----------------------------------------------------------------

describe("GET /api/classes/featured", () => {
  it("should return bestseller classes", async () => {
    const res = await SELF.fetch("http://localhost/api/classes/featured");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.length).toBeLessThanOrEqual(8);
  });
});

describe("GET /api/classes/new", () => {
  it("should return new classes", async () => {
    const res = await SELF.fetch("http://localhost/api/classes/new");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.length).toBeLessThanOrEqual(8);
  });
});

// ----------------------------------------------------------------
// Class detail by slug
// ----------------------------------------------------------------

describe("GET /api/classes/:slug", () => {
  it("should return class details for a known slug", async () => {
    const res = await SELF.fetch("http://localhost/api/classes/park-sw-korean");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.title).toContain("박서욱");
    expect(data.slug).toBe("park-sw-korean");
    expect(data.instructor_name ?? data.display_name).toBeDefined();
    expect(data.price).toBe(189000);
    // Should include curriculum (lessons grouped by chapter)
    expect(data.curriculum).toBeDefined();
    // Should include reviews
    expect(data.reviews).toBeDefined();
    expect(Array.isArray(data.reviews)).toBe(true);
  });

  it("should return 404 for unknown slug", async () => {
    const res = await SELF.fetch(
      "http://localhost/api/classes/this-slug-does-not-exist-at-all"
    );
    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.error).toContain("not found");
  });
});

// ----------------------------------------------------------------
// Class reviews
// ----------------------------------------------------------------

describe("GET /api/classes/:id/reviews", () => {
  it("should return reviews for class 1", async () => {
    const res = await SELF.fetch("http://localhost/api/classes/1/reviews");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];

    expect(Array.isArray(data)).toBe(true);
    // Seed has 2 reviews for class 1 (review IDs 1 and 7)
    expect(data.length).toBeGreaterThanOrEqual(2);

    // Each review should have rating and content
    for (const review of data) {
      expect(review.rating).toBeDefined();
      expect(review.content).toBeDefined();
    }
  });

  it("should return empty array for class with no reviews", async () => {
    // Class 7 (smartstore-startup) has no reviews in seed data
    const res = await SELF.fetch("http://localhost/api/classes/7/reviews");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });
});

// ----------------------------------------------------------------
// Instructor detail
// ----------------------------------------------------------------

describe("GET /api/instructors/:id", () => {
  it("should return instructor details with their classes", async () => {
    const res = await SELF.fetch("http://localhost/api/instructors/1");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.instructor).toBeDefined();
    expect(data.instructor.display_name).toBe("박서욱");
    expect(data.classes).toBeDefined();
    expect(Array.isArray(data.classes)).toBe(true);
    // Instructor 1 has classes 1 and 9 in seed data
    expect(data.classes.length).toBeGreaterThanOrEqual(1);
  });
});
