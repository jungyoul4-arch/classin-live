/**
 * Database Schema Integrity Tests
 *
 * Validates that all 20 migrations apply cleanly, tables and columns
 * match expectations, constraints are enforced, seed data loads
 * correctly, and indexes exist.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  applyAllMigrations,
  applySeedData,
  EXPECTED_TABLES,
  EXPECTED_INDEXES,
  MIGRATION_FILES,
} from "./db-helpers";

// ─── Helpers ───────────────────────────────────────────────────────
type Row = Record<string, unknown>;

const db = env.DB as D1Database;

/** Query helper that returns typed rows */
async function query<T extends Row = Row>(sql: string): Promise<T[]> {
  const result = await db.prepare(sql).all<T>();
  return result.results ?? [];
}

/** Get a single value */
async function scalar<T = unknown>(sql: string): Promise<T> {
  const result = await db.prepare(sql).first<Record<string, T>>();
  return Object.values(result!)[0];
}

/** Get column info for a table via PRAGMA */
async function tableInfo(
  table: string
): Promise<
  { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]
> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return result.results as any[];
}

/** Get all table names from sqlite_master */
async function allTableNames(): Promise<string[]> {
  const rows = await query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name"
  );
  return rows.map((r) => r.name);
}

/** Get all index names from sqlite_master */
async function allIndexNames(): Promise<string[]> {
  const rows = await query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return rows.map((r) => r.name);
}

/** Check if a column exists in a table */
function hasColumn(
  info: { name: string }[],
  colName: string
): boolean {
  return info.some((c) => c.name === colName);
}

/** Get column details */
function getColumn(
  info: { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[],
  colName: string
) {
  return info.find((c) => c.name === colName);
}

// ─── File-level setup: apply migrations + seed data once ──────────
let _migrationResults: { file: string; success: boolean; error?: string }[];
let _seedResult: { success: boolean; error?: string };

beforeAll(async () => {
  _migrationResults = await applyAllMigrations(db);
  _seedResult = await applySeedData(db);
});

// ═══════════════════════════════════════════════════════════════════
// 1. MIGRATION APPLICATION TESTS
// ═══════════════════════════════════════════════════════════════════
describe("Migration Application", () => {
  it("should have run all 20 migration files", () => {
    expect(_migrationResults).toHaveLength(20);
  });

  it.each(MIGRATION_FILES.map((f, i) => [f, i]))(
    "migration %s should apply without errors",
    (file, index) => {
      const result = _migrationResults[index as number];
      expect(result.success, `${file} failed: ${result.error}`).toBe(true);
    }
  );
});

// ═══════════════════════════════════════════════════════════════════
// 2. TABLE EXISTENCE TESTS
// ═══════════════════════════════════════════════════════════════════
describe("Table Existence", () => {
  it("all expected tables exist", async () => {
    const tables = await allTableNames();
    for (const expected of EXPECTED_TABLES) {
      expect(tables, `Missing table: ${expected}`).toContain(expected);
    }
  });

  it("has exactly the expected number of application tables", async () => {
    const tables = await allTableNames();
    expect(tables.length).toBe(EXPECTED_TABLES.length);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. TABLE COLUMN TESTS
// ═══════════════════════════════════════════════════════════════════
describe("Table Columns", () => {
  describe("users table", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("users");
    });

    it("has core columns", () => {
      const expected = [
        "id", "email", "password_hash", "name", "avatar", "phone",
        "role", "subscription_plan", "subscription_expires_at",
        "created_at", "updated_at",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: users.${col}`).toBe(true);
      }
    });

    it("has columns from migration 0004 (virtual accounts)", () => {
      expect(hasColumn(info, "classin_account_uid")).toBe(true);
      expect(hasColumn(info, "classin_registered")).toBe(true);
    });

    it("has columns from migration 0005 (test accounts)", () => {
      expect(hasColumn(info, "is_test_account")).toBe(true);
      expect(hasColumn(info, "test_expires_at")).toBe(true);
    });

    it("email is NOT NULL", () => {
      const col = getColumn(info, "email");
      expect(col?.notnull).toBe(1);
    });

    it("password_hash is NOT NULL", () => {
      const col = getColumn(info, "password_hash");
      expect(col?.notnull).toBe(1);
    });

    it("name is NOT NULL", () => {
      const col = getColumn(info, "name");
      expect(col?.notnull).toBe(1);
    });

    it("role defaults to student", () => {
      const col = getColumn(info, "role");
      expect(col?.dflt_value).toContain("student");
    });

    it("id is primary key", () => {
      const col = getColumn(info, "id");
      expect(col?.pk).toBe(1);
    });
  });

  describe("instructors table", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("instructors");
    });

    it("has core columns", () => {
      const expected = [
        "id", "user_id", "display_name", "bio", "profile_image",
        "specialty", "total_students", "total_classes", "rating", "verified", "created_at",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: instructors.${col}`).toBe(true);
      }
    });

    it("has migration 0007 columns (classin_uid)", () => {
      expect(hasColumn(info, "classin_uid")).toBe(true);
      expect(hasColumn(info, "classin_registered_at")).toBe(true);
    });

    it("has migration 0017 column (classin_virtual_account)", () => {
      expect(hasColumn(info, "classin_virtual_account")).toBe(true);
    });

    it("has migration 0019 column (classin_registered_account)", () => {
      expect(hasColumn(info, "classin_registered_account")).toBe(true);
    });

    it("user_id is NOT NULL", () => {
      const col = getColumn(info, "user_id");
      expect(col?.notnull).toBe(1);
    });

    it("display_name is NOT NULL", () => {
      const col = getColumn(info, "display_name");
      expect(col?.notnull).toBe(1);
    });

    it("rating defaults to 0.0", () => {
      const col = getColumn(info, "rating");
      expect(col?.dflt_value).toBe("0.0");
    });
  });

  describe("classes table", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("classes");
    });

    it("has core columns from migration 0001", () => {
      const expected = [
        "id", "title", "slug", "subtitle", "description", "thumbnail",
        "instructor_id", "category_id", "level", "class_type", "price",
        "original_price", "discount_percent", "currency", "duration_minutes",
        "total_lessons", "max_students", "current_students", "rating",
        "review_count", "is_bestseller", "is_new", "is_subscription",
        "status", "schedule_start", "schedule_end", "tags",
        "what_you_learn", "requirements", "created_at", "updated_at",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: classes.${col}`).toBe(true);
      }
    });

    it("has migration 0008 columns (classin IDs)", () => {
      expect(hasColumn(info, "classin_course_id")).toBe(true);
      expect(hasColumn(info, "classin_class_id")).toBe(true);
      expect(hasColumn(info, "classin_created_at")).toBe(true);
    });

    it("has migration 0009 columns (instructor URL)", () => {
      expect(hasColumn(info, "classin_instructor_url")).toBe(true);
      expect(hasColumn(info, "classin_status")).toBe(true);
      expect(hasColumn(info, "classin_scheduled_at")).toBe(true);
    });

    it("has migration 0012 column (lesson_count)", () => {
      expect(hasColumn(info, "lesson_count")).toBe(true);
    });

    it("has migration 0020 column (homepage_sort_order)", () => {
      expect(hasColumn(info, "homepage_sort_order")).toBe(true);
    });

    it("title is NOT NULL", () => {
      const col = getColumn(info, "title");
      expect(col?.notnull).toBe(1);
    });

    it("description is NOT NULL", () => {
      const col = getColumn(info, "description");
      expect(col?.notnull).toBe(1);
    });

    it("instructor_id is NOT NULL", () => {
      const col = getColumn(info, "instructor_id");
      expect(col?.notnull).toBe(1);
    });

    it("price defaults to 0", () => {
      const col = getColumn(info, "price");
      expect(col?.dflt_value).toBe("0");
    });

    it("status defaults to active", () => {
      const col = getColumn(info, "status");
      expect(col?.dflt_value).toContain("active");
    });
  });

  describe("categories table", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("categories");
    });

    it("has expected columns", () => {
      const expected = ["id", "name", "slug", "icon", "description", "parent_id", "sort_order"];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: categories.${col}`).toBe(true);
      }
    });

    it("name is NOT NULL", () => {
      const col = getColumn(info, "name");
      expect(col?.notnull).toBe(1);
    });

    it("slug is NOT NULL", () => {
      const col = getColumn(info, "slug");
      expect(col?.notnull).toBe(1);
    });
  });

  describe("enrollments table", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("enrollments");
    });

    it("has core columns", () => {
      const expected = ["id", "user_id", "class_id", "progress", "enrolled_at", "completed_at"];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: enrollments.${col}`).toBe(true);
      }
    });

    it("has migration 0002 columns (classin integration)", () => {
      expect(hasColumn(info, "classin_join_url")).toBe(true);
      expect(hasColumn(info, "classin_session_id")).toBe(true);
    });

    it("has migration 0006 columns (virtual account)", () => {
      expect(hasColumn(info, "status")).toBe(true);
      expect(hasColumn(info, "expires_at")).toBe(true);
      expect(hasColumn(info, "classin_account_uid")).toBe(true);
      expect(hasColumn(info, "classin_account_password")).toBe(true);
      expect(hasColumn(info, "classin_assigned_at")).toBe(true);
      expect(hasColumn(info, "classin_returned_at")).toBe(true);
    });

    it("has migration 0011 column (subscription_id)", () => {
      expect(hasColumn(info, "subscription_id")).toBe(true);
    });

    it("user_id is NOT NULL", () => {
      const col = getColumn(info, "user_id");
      expect(col?.notnull).toBe(1);
    });

    it("class_id is NOT NULL", () => {
      const col = getColumn(info, "class_id");
      expect(col?.notnull).toBe(1);
    });
  });

  describe("orders table", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("orders");
    });

    it("has expected columns", () => {
      const expected = [
        "id", "user_id", "order_type", "class_id", "subscription_plan",
        "amount", "currency", "payment_method", "payment_status",
        "card_last4", "transaction_id", "created_at",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: orders.${col}`).toBe(true);
      }
    });

    it("amount is NOT NULL", () => {
      const col = getColumn(info, "amount");
      expect(col?.notnull).toBe(1);
    });

    it("payment_status defaults to pending", () => {
      const col = getColumn(info, "payment_status");
      expect(col?.dflt_value).toContain("pending");
    });
  });

  describe("class_lessons table (migration 0012)", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("class_lessons");
    });

    it("has core columns", () => {
      const expected = [
        "id", "class_id", "lesson_number", "lesson_title",
        "classin_course_id", "classin_class_id", "classin_instructor_url",
        "scheduled_at", "duration_minutes", "status", "replay_url",
        "created_at", "updated_at",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: class_lessons.${col}`).toBe(true);
      }
    });

    it("has migration 0015 columns (recorded lessons)", () => {
      expect(hasColumn(info, "lesson_type")).toBe(true);
      expect(hasColumn(info, "stream_uid")).toBe(true);
      expect(hasColumn(info, "stream_url")).toBe(true);
      expect(hasColumn(info, "stream_thumbnail")).toBe(true);
      expect(hasColumn(info, "price")).toBe(true);
    });

    it("has migration 0016 columns (curriculum)", () => {
      expect(hasColumn(info, "description")).toBe(true);
      expect(hasColumn(info, "curriculum_items")).toBe(true);
      expect(hasColumn(info, "materials")).toBe(true);
    });
  });

  describe("lesson_enrollments table (migration 0014)", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("lesson_enrollments");
    });

    it("has expected columns", () => {
      const expected = [
        "id", "user_id", "class_lesson_id", "payment_id",
        "enrolled_at", "status",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: lesson_enrollments.${col}`).toBe(true);
      }
    });

    it("user_id is NOT NULL", () => {
      const col = getColumn(info, "user_id");
      expect(col?.notnull).toBe(1);
    });

    it("class_lesson_id is NOT NULL", () => {
      const col = getColumn(info, "class_lesson_id");
      expect(col?.notnull).toBe(1);
    });
  });

  describe("chunked_uploads table (migration 0018)", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("chunked_uploads");
    });

    it("has expected columns", () => {
      const expected = [
        "id", "upload_id", "filename", "total_size", "total_chunks",
        "uploaded_chunks", "status", "stream_uid", "created_at", "updated_at",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: chunked_uploads.${col}`).toBe(true);
      }
    });

    it("upload_id is NOT NULL", () => {
      const col = getColumn(info, "upload_id");
      expect(col?.notnull).toBe(1);
    });

    it("filename is NOT NULL", () => {
      const col = getColumn(info, "filename");
      expect(col?.notnull).toBe(1);
    });
  });

  describe("subscriptions table (migration 0003)", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("subscriptions");
    });

    it("has expected columns", () => {
      const expected = [
        "id", "user_id", "plan_type", "class_id", "amount",
        "payment_method", "card_last4", "billing_day", "status",
        "started_at", "current_period_start", "current_period_end",
        "next_billing_date", "cancelled_at", "failed_attempts",
        "last_payment_error", "created_at", "updated_at",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: subscriptions.${col}`).toBe(true);
      }
    });

    it("status defaults to active", () => {
      const col = getColumn(info, "status");
      expect(col?.dflt_value).toContain("active");
    });
  });

  describe("classin_virtual_accounts table (migration 0004)", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("classin_virtual_accounts");
    });

    it("has expected columns", () => {
      const expected = [
        "id", "account_uid", "account_password", "sid", "is_registered",
        "registered_at", "user_id", "assigned_at", "assigned_name",
        "status", "expires_at", "error_message", "created_at", "updated_at",
      ];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: classin_virtual_accounts.${col}`).toBe(true);
      }
    });

    it("account_uid is NOT NULL", () => {
      const col = getColumn(info, "account_uid");
      expect(col?.notnull).toBe(1);
    });

    it("sid is NOT NULL", () => {
      const col = getColumn(info, "sid");
      expect(col?.notnull).toBe(1);
    });
  });

  describe("admin_settings table (migration 0010)", () => {
    let info: any[];
    beforeAll(async () => {
      info = await tableInfo("admin_settings");
    });

    it("has expected columns", () => {
      const expected = ["id", "setting_key", "setting_value", "updated_at"];
      for (const col of expected) {
        expect(hasColumn(info, col), `Missing column: admin_settings.${col}`).toBe(true);
      }
    });

    it("setting_key is NOT NULL", () => {
      const col = getColumn(info, "setting_key");
      expect(col?.notnull).toBe(1);
    });

    it("setting_value is NOT NULL", () => {
      const col = getColumn(info, "setting_value");
      expect(col?.notnull).toBe(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. CONSTRAINT TESTS
// ═══════════════════════════════════════════════════════════════════
describe("Constraints", () => {
  describe("UNIQUE constraints", () => {
    it("users.email must be unique", async () => {
      await db.exec(
        "INSERT INTO users (email, password_hash, name) VALUES ('unique_test@test.com', 'hash123', 'Test')"
      );
      await expect(
        db.exec(
          "INSERT INTO users (email, password_hash, name) VALUES ('unique_test@test.com', 'hash456', 'Test2')"
        )
      ).rejects.toThrow();
    });

    it("categories.slug must be unique", async () => {
      await db.exec(
        "INSERT INTO categories (name, slug) VALUES ('Test Cat', 'test-unique-slug')"
      );
      await expect(
        db.exec(
          "INSERT INTO categories (name, slug) VALUES ('Test Cat 2', 'test-unique-slug')"
        )
      ).rejects.toThrow();
    });

    it("classes.slug must be unique", async () => {
      // Need a valid instructor and category first
      await db.exec(
        "INSERT OR IGNORE INTO users (id, email, password_hash, name) VALUES (9990, 'instr_uniq@test.com', 'h', 'Instr')"
      );
      await db.exec(
        "INSERT OR IGNORE INTO instructors (id, user_id, display_name) VALUES (9990, 9990, 'Instr')"
      );
      await db.exec(
        "INSERT OR IGNORE INTO categories (id, name, slug) VALUES (9990, 'TC', 'tc-unique-9990')"
      );
      await db.exec(
        "INSERT INTO classes (title, slug, description, instructor_id, category_id) VALUES ('C1', 'unique-slug-test', 'D', 9990, 9990)"
      );
      await expect(
        db.exec(
          "INSERT INTO classes (title, slug, description, instructor_id, category_id) VALUES ('C2', 'unique-slug-test', 'D2', 9990, 9990)"
        )
      ).rejects.toThrow();
    });

    it("enrollments (user_id, class_id) must be unique", async () => {
      await db.exec(
        "INSERT OR IGNORE INTO users (id, email, password_hash, name) VALUES (9991, 'enroll_uniq@test.com', 'h', 'Student')"
      );
      const classIdResult = await db.prepare(
        "SELECT id FROM classes LIMIT 1"
      ).first<{ id: number }>();
      if (classIdResult) {
        await db.exec(
          `INSERT INTO enrollments (user_id, class_id) VALUES (9991, ${classIdResult.id})`
        );
        await expect(
          db.exec(
            `INSERT INTO enrollments (user_id, class_id) VALUES (9991, ${classIdResult.id})`
          )
        ).rejects.toThrow();
      }
    });

    it("instructors.user_id must be unique", async () => {
      await db.exec(
        "INSERT OR IGNORE INTO users (id, email, password_hash, name) VALUES (9992, 'instr_uniq2@test.com', 'h', 'Instr2')"
      );
      await db.exec(
        "INSERT INTO instructors (user_id, display_name) VALUES (9992, 'Instr A')"
      );
      await expect(
        db.exec(
          "INSERT INTO instructors (user_id, display_name) VALUES (9992, 'Instr B')"
        )
      ).rejects.toThrow();
    });

    it("classin_virtual_accounts.account_uid must be unique", async () => {
      await db.exec(
        "INSERT INTO classin_virtual_accounts (account_uid, sid) VALUES ('test-uid-001', '67411940')"
      );
      await expect(
        db.exec(
          "INSERT INTO classin_virtual_accounts (account_uid, sid) VALUES ('test-uid-001', '67411940')"
        )
      ).rejects.toThrow();
    });

    it("admin_settings.setting_key must be unique", async () => {
      // Already has admin_username from migration 0010
      await expect(
        db.exec(
          "INSERT INTO admin_settings (setting_key, setting_value) VALUES ('admin_username', 'other')"
        )
      ).rejects.toThrow();
    });
  });

  describe("NOT NULL constraints", () => {
    it("users.email cannot be NULL", async () => {
      await expect(
        db.exec("INSERT INTO users (password_hash, name) VALUES ('hash', 'NoEmail')")
      ).rejects.toThrow();
    });

    it("users.password_hash cannot be NULL", async () => {
      await expect(
        db.exec("INSERT INTO users (email, name) VALUES ('nopass@test.com', 'NoPass')")
      ).rejects.toThrow();
    });

    it("classes.description cannot be NULL", async () => {
      await expect(
        db.exec(
          "INSERT INTO classes (title, slug, instructor_id, category_id) VALUES ('T', 'slug-nn-test', 9990, 9990)"
        )
      ).rejects.toThrow();
    });

    it("orders.amount cannot be NULL", async () => {
      await expect(
        db.exec(
          "INSERT INTO orders (user_id, order_type) VALUES (9990, 'class')"
        )
      ).rejects.toThrow();
    });

    it("reviews.rating cannot be NULL", async () => {
      await expect(
        db.exec(
          "INSERT INTO reviews (class_id, user_id, content) VALUES (1, 1, 'No rating')"
        )
      ).rejects.toThrow();
    });
  });

  describe("CHECK constraints", () => {
    it("users.role must be student, instructor, or admin", async () => {
      await expect(
        db.exec(
          "INSERT INTO users (email, password_hash, name, role) VALUES ('check1@test.com', 'h', 'T', 'superadmin')"
        )
      ).rejects.toThrow();
    });

    it("classes.level must be beginner, intermediate, advanced, or all", async () => {
      await expect(
        db.exec(
          "INSERT INTO classes (title, slug, description, instructor_id, category_id, level) VALUES ('T', 'check-level', 'D', 9990, 9990, 'expert')"
        )
      ).rejects.toThrow();
    });

    it("classes.status must be draft, active, or archived", async () => {
      await expect(
        db.exec(
          "INSERT INTO classes (title, slug, description, instructor_id, category_id, status) VALUES ('T', 'check-status', 'D', 9990, 9990, 'deleted')"
        )
      ).rejects.toThrow();
    });

    it("orders.order_type must be class or subscription", async () => {
      await expect(
        db.exec(
          "INSERT INTO orders (user_id, order_type, amount) VALUES (9990, 'gift', 1000)"
        )
      ).rejects.toThrow();
    });

    it("orders.payment_status must be valid enum", async () => {
      await expect(
        db.exec(
          "INSERT INTO orders (user_id, order_type, amount, payment_status) VALUES (9990, 'class', 1000, 'void')"
        )
      ).rejects.toThrow();
    });

    it("reviews.rating must be between 1 and 5", async () => {
      await expect(
        db.exec(
          "INSERT INTO reviews (class_id, user_id, rating) VALUES (1, 1, 6)"
        )
      ).rejects.toThrow();
    });

    it("reviews.rating cannot be 0", async () => {
      await expect(
        db.exec(
          "INSERT INTO reviews (class_id, user_id, rating) VALUES (1, 1, 0)"
        )
      ).rejects.toThrow();
    });
  });

  describe("DEFAULT values", () => {
    it("users.role defaults to student", async () => {
      await db.exec(
        "INSERT INTO users (email, password_hash, name) VALUES ('default_role@test.com', 'hash', 'DefaultRole')"
      );
      const user = await db
        .prepare("SELECT role FROM users WHERE email = 'default_role@test.com'")
        .first<{ role: string }>();
      expect(user?.role).toBe("student");
    });

    it("users.created_at gets a default timestamp", async () => {
      await db.exec(
        "INSERT INTO users (email, password_hash, name) VALUES ('default_ts@test.com', 'hash', 'TS Test')"
      );
      const user = await db
        .prepare("SELECT created_at FROM users WHERE email = 'default_ts@test.com'")
        .first<{ created_at: string }>();
      expect(user?.created_at).toBeTruthy();
    });

    it("classes.is_subscription defaults to 1", async () => {
      const col = (await tableInfo("classes")).find((c: any) => c.name === "is_subscription");
      expect(col?.dflt_value).toBe("1");
    });

    it("classes.currency defaults to KRW", async () => {
      const col = (await tableInfo("classes")).find((c: any) => c.name === "currency");
      expect(col?.dflt_value).toContain("KRW");
    });

    it("instructors.verified defaults to 0", async () => {
      const col = (await tableInfo("instructors")).find((c: any) => c.name === "verified");
      expect(col?.dflt_value).toBe("0");
    });

    it("enrollments.progress defaults to 0", async () => {
      const col = (await tableInfo("enrollments")).find((c: any) => c.name === "progress");
      expect(col?.dflt_value).toBe("0");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. INDEX EXISTENCE TESTS
// ═══════════════════════════════════════════════════════════════════
describe("Index Existence", () => {
  let indexNames: string[];

  beforeAll(async () => {
    indexNames = await allIndexNames();
  });

  it.each(EXPECTED_INDEXES.map((idx) => [idx]))(
    "index %s should exist",
    (indexName) => {
      expect(
        indexNames,
        `Missing index: ${indexName}`
      ).toContain(indexName);
    }
  );

  it("should have at least the expected number of custom indexes", () => {
    // Filter out auto-created indexes (sqlite_autoindex_*)
    const customIndexes = indexNames.filter(
      (n) => !n.startsWith("sqlite_autoindex_")
    );
    expect(customIndexes.length).toBeGreaterThanOrEqual(EXPECTED_INDEXES.length);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. SEED DATA TESTS
// ═══════════════════════════════════════════════════════════════════
describe("Seed Data", () => {
  describe("seed execution", () => {
    it("seed SQL executes without errors", async () => {
      expect(_seedResult.success, `Seed failed: ${_seedResult.error}`).toBe(true);
      const userCount = await scalar<number>("SELECT COUNT(*) FROM users");
      expect(userCount).toBeGreaterThan(0);
    });
  });

  describe("seed user data", () => {
    it("has 10 seed users", async () => {
      // Seed inserts users with ids 1-10; we also inserted test users in constraint tests.
      // Count only seed users (id <= 10).
      const count = await scalar<number>(
        "SELECT COUNT(*) FROM users WHERE id <= 10"
      );
      expect(count).toBe(10);
    });

    it("has admin user", async () => {
      const admin = await db
        .prepare("SELECT email, role FROM users WHERE id = 1")
        .first<{ email: string; role: string }>();
      expect(admin?.email).toBe("admin@classin.kr");
      expect(admin?.role).toBe("admin");
    });

    it("has test student", async () => {
      const student = await db
        .prepare("SELECT email, role FROM users WHERE id = 8")
        .first<{ email: string; role: string }>();
      expect(student?.email).toBe("student1@test.com");
      expect(student?.role).toBe("student");
    });

    it("instructor users have instructor role", async () => {
      const instructorUsers = await query<{ role: string }>(
        "SELECT role FROM users WHERE id IN (2,3,4,5,6,7,9,10)"
      );
      for (const u of instructorUsers) {
        expect(u.role).toBe("instructor");
      }
    });

    it("password hashes have expected format", async () => {
      const users = await query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id <= 10"
      );
      for (const u of users) {
        expect(u.password_hash).toBe("pbkdf2_test1234");
      }
    });
  });

  describe("seed instructor data", () => {
    it("has 8 seed instructors", async () => {
      const count = await scalar<number>(
        "SELECT COUNT(*) FROM instructors WHERE id <= 8"
      );
      expect(count).toBe(8);
    });

    it("instructor user_id references valid users", async () => {
      const orphans = await query(
        "SELECT i.id, i.user_id FROM instructors i LEFT JOIN users u ON i.user_id = u.id WHERE u.id IS NULL AND i.id <= 8"
      );
      expect(orphans).toHaveLength(0);
    });

    it("all seed instructors are verified", async () => {
      const unverified = await query(
        "SELECT id FROM instructors WHERE id <= 8 AND verified != 1"
      );
      expect(unverified).toHaveLength(0);
    });

    it("instructor ratings are valid", async () => {
      const instructors = await query<{ rating: number }>(
        "SELECT rating FROM instructors WHERE id <= 8"
      );
      for (const i of instructors) {
        expect(i.rating).toBeGreaterThanOrEqual(4.0);
        expect(i.rating).toBeLessThanOrEqual(5.0);
      }
    });
  });

  describe("seed category data", () => {
    it("has 10 categories", async () => {
      const count = await scalar<number>("SELECT COUNT(*) FROM categories WHERE id <= 10");
      expect(count).toBe(10);
    });

    it("categories have unique slugs", async () => {
      const slugs = await query<{ slug: string }>(
        "SELECT slug FROM categories WHERE id <= 10"
      );
      const slugSet = new Set(slugs.map((s) => s.slug));
      expect(slugSet.size).toBe(10);
    });

    it("first category is korean", async () => {
      const cat = await db
        .prepare("SELECT name, slug FROM categories WHERE id = 1")
        .first<{ name: string; slug: string }>();
      expect(cat?.slug).toBe("korean");
    });
  });

  describe("seed class data", () => {
    it("has 12 seed classes", async () => {
      const count = await scalar<number>("SELECT COUNT(*) FROM classes WHERE id <= 12");
      expect(count).toBe(12);
    });

    it("class instructor_id references valid instructors", async () => {
      const orphans = await query(
        "SELECT c.id, c.instructor_id FROM classes c LEFT JOIN instructors i ON c.instructor_id = i.id WHERE i.id IS NULL AND c.id <= 12"
      );
      expect(orphans).toHaveLength(0);
    });

    it("class category_id references valid categories", async () => {
      const orphans = await query(
        "SELECT c.id, c.category_id FROM classes c LEFT JOIN categories cat ON c.category_id = cat.id WHERE cat.id IS NULL AND c.id <= 12"
      );
      expect(orphans).toHaveLength(0);
    });

    it("6 classes are marked as bestsellers", async () => {
      const count = await scalar<number>(
        "SELECT COUNT(*) FROM classes WHERE id <= 12 AND is_bestseller = 1"
      );
      expect(count).toBe(6);
    });

    it("all seed classes are subscription-based", async () => {
      const nonSub = await query(
        "SELECT id FROM classes WHERE id <= 12 AND is_subscription != 1"
      );
      expect(nonSub).toHaveLength(0);
    });

    it("prices are positive", async () => {
      const classes = await query<{ price: number }>(
        "SELECT price FROM classes WHERE id <= 12"
      );
      for (const c of classes) {
        expect(c.price).toBeGreaterThan(0);
      }
    });
  });

  describe("seed lesson data", () => {
    it("has 25 seed lessons in lessons table", async () => {
      const count = await scalar<number>("SELECT COUNT(*) FROM lessons WHERE id <= 25");
      expect(count).toBe(25);
    });

    it("lesson class_id references valid classes", async () => {
      const orphans = await query(
        "SELECT l.id, l.class_id FROM lessons l LEFT JOIN classes c ON l.class_id = c.id WHERE c.id IS NULL AND l.id <= 25"
      );
      expect(orphans).toHaveLength(0);
    });

    it("class 1 has 8 lessons", async () => {
      const count = await scalar<number>(
        "SELECT COUNT(*) FROM lessons WHERE class_id = 1"
      );
      expect(count).toBe(8);
    });

    it("class 4 has 9 lessons", async () => {
      const count = await scalar<number>(
        "SELECT COUNT(*) FROM lessons WHERE class_id = 4"
      );
      expect(count).toBe(9);
    });

    it("class 5 has 8 lessons", async () => {
      const count = await scalar<number>(
        "SELECT COUNT(*) FROM lessons WHERE class_id = 5"
      );
      expect(count).toBe(8);
    });
  });

  describe("seed review data", () => {
    it("has 8 reviews", async () => {
      const count = await scalar<number>("SELECT COUNT(*) FROM reviews WHERE id <= 8");
      expect(count).toBe(8);
    });

    it("all reviews are from user 8 (test student)", async () => {
      const reviews = await query<{ user_id: number }>(
        "SELECT user_id FROM reviews WHERE id <= 8"
      );
      for (const r of reviews) {
        expect(r.user_id).toBe(8);
      }
    });

    it("review ratings are 4 or 5", async () => {
      const reviews = await query<{ rating: number }>(
        "SELECT rating FROM reviews WHERE id <= 8"
      );
      for (const r of reviews) {
        expect(r.rating).toBeGreaterThanOrEqual(4);
        expect(r.rating).toBeLessThanOrEqual(5);
      }
    });

    it("review class_id references valid classes", async () => {
      const orphans = await query(
        "SELECT r.id, r.class_id FROM reviews r LEFT JOIN classes c ON r.class_id = c.id WHERE c.id IS NULL AND r.id <= 8"
      );
      expect(orphans).toHaveLength(0);
    });
  });

  describe("seed admin data (from migration 0010)", () => {
    it("admin_username setting exists", async () => {
      const setting = await db
        .prepare("SELECT setting_value FROM admin_settings WHERE setting_key = 'admin_username'")
        .first<{ setting_value: string }>();
      expect(setting?.setting_value).toBe("admin");
    });

    it("admin_password_hash setting exists", async () => {
      const setting = await db
        .prepare("SELECT setting_value FROM admin_settings WHERE setting_key = 'admin_password_hash'")
        .first<{ setting_value: string }>();
      expect(setting?.setting_value).toBe("jungyoul1234");
    });
  });

  describe("seed test access code (from migration 0005)", () => {
    it("default test access code exists", async () => {
      const code = await db
        .prepare("SELECT code, is_active FROM test_access_codes WHERE code = 'CLASSIN-TEST-2024'")
        .first<{ code: string; is_active: number }>();
      expect(code?.code).toBe("CLASSIN-TEST-2024");
      expect(code?.is_active).toBe(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. DATA INTEGRITY TESTS
// ═══════════════════════════════════════════════════════════════════
describe("Data Integrity", () => {
  describe("foreign key relationships in seed data", () => {
    it("every instructor has a corresponding user", async () => {
      const orphans = await query(
        "SELECT i.id FROM instructors i LEFT JOIN users u ON i.user_id = u.id WHERE u.id IS NULL"
      );
      expect(orphans).toHaveLength(0);
    });

    it("every class references a valid instructor", async () => {
      const orphans = await query(
        "SELECT c.id FROM classes c LEFT JOIN instructors i ON c.instructor_id = i.id WHERE i.id IS NULL"
      );
      expect(orphans).toHaveLength(0);
    });

    it("every class references a valid category", async () => {
      const orphans = await query(
        "SELECT c.id FROM classes c LEFT JOIN categories cat ON c.category_id = cat.id WHERE cat.id IS NULL"
      );
      expect(orphans).toHaveLength(0);
    });

    it("every review references a valid user", async () => {
      const orphans = await query(
        "SELECT r.id FROM reviews r LEFT JOIN users u ON r.user_id = u.id WHERE u.id IS NULL"
      );
      expect(orphans).toHaveLength(0);
    });

    it("every review references a valid class", async () => {
      const orphans = await query(
        "SELECT r.id FROM reviews r LEFT JOIN classes c ON r.class_id = c.id WHERE c.id IS NULL"
      );
      expect(orphans).toHaveLength(0);
    });

    it("every lesson references a valid class", async () => {
      const orphans = await query(
        "SELECT l.id FROM lessons l LEFT JOIN classes c ON l.class_id = c.id WHERE c.id IS NULL"
      );
      expect(orphans).toHaveLength(0);
    });
  });

  describe("timestamp defaults", () => {
    it("inserting a user sets created_at automatically", async () => {
      await db.exec(
        "INSERT INTO users (email, password_hash, name) VALUES ('ts_test@test.com', 'hash', 'TS Test')"
      );
      const user = await db
        .prepare("SELECT created_at FROM users WHERE email = 'ts_test@test.com'")
        .first<{ created_at: string }>();
      expect(user?.created_at).toBeTruthy();
      // Should be a valid date string
      expect(new Date(user!.created_at).getTime()).not.toBeNaN();
    });

    it("inserting an order sets created_at automatically", async () => {
      await db.exec(
        "INSERT INTO orders (user_id, order_type, amount) VALUES (1, 'class', 100000)"
      );
      const order = await db
        .prepare("SELECT created_at FROM orders ORDER BY id DESC LIMIT 1")
        .first<{ created_at: string }>();
      expect(order?.created_at).toBeTruthy();
    });
  });

  describe("data format validation", () => {
    it("seed user emails contain @", async () => {
      const users = await query<{ email: string }>(
        "SELECT email FROM users WHERE id <= 10"
      );
      for (const u of users) {
        expect(u.email).toContain("@");
      }
    });

    it("class slugs are URL-safe", async () => {
      const classes = await query<{ slug: string }>(
        "SELECT slug FROM classes WHERE id <= 12"
      );
      for (const c of classes) {
        expect(c.slug).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it("category slugs are URL-safe", async () => {
      const cats = await query<{ slug: string }>(
        "SELECT slug FROM categories WHERE id <= 10"
      );
      for (const c of cats) {
        expect(c.slug).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it("discount_percent is between 0 and 100 for seed classes", async () => {
      const classes = await query<{ discount_percent: number }>(
        "SELECT discount_percent FROM classes WHERE id <= 12"
      );
      for (const c of classes) {
        expect(c.discount_percent).toBeGreaterThanOrEqual(0);
        expect(c.discount_percent).toBeLessThanOrEqual(100);
      }
    });
  });
});
