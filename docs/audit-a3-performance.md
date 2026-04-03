# Performance Audit Report: ClassIn Live

**Date:** 2026-04-03  
**Auditor:** Claude Opus 4.6  
**Scope:** `/src/index.tsx` (~14,508 lines), `/migrations/` (0001-0020)  
**Status:** READ-ONLY analysis -- no code modifications made

---

## Executive Summary

The application has several significant performance bottlenecks, primarily related to N+1 query patterns in loops that make sequential external API calls, a branding middleware that re-reads every HTML response body, and multiple endpoints returning unbounded result sets. The most critical issues are in the ClassIn API integration where loops make sequential external `fetch()` calls per item, which can easily exceed Workers CPU time and subrequest limits.

**Critical findings:** 7 HIGH, 9 MEDIUM, 8 LOW

---

## 1. Database Performance

### 1.1 N+1 Query Patterns

**[HIGH] N+1 + External API calls in `/api/user/:userId/enrollments-with-lessons` (lines 1976-2035)**

This endpoint fetches enrollments, then for EACH enrollment runs a separate query to get lessons. Worse, for each ended lesson without a `replay_url`, it makes an external API call to `getClassInWebcastUrl` AND writes back to the database:

```
enrollments.map(async (enrollment) => {
  // Query per enrollment
  const { results: lessons } = await c.env.DB.prepare(...)
  
  for (const lesson of lessons) {
    // External API call per ended lesson
    const webcastResult = await getClassInWebcastUrl(...)
    // DB write per lesson
    await c.env.DB.prepare('UPDATE class_lessons ...').run()
  }
})
```

- **Impact:** If a user has 5 enrollments with 10 lessons each, that is 5 DB queries + up to 50 external API calls + 50 DB writes in a single request.
- **Estimated improvement:** 10-50x reduction in DB queries by using a single JOIN query. External API calls should be batched or cached.

**[HIGH] N+1 + External API calls in `/api/user/:userId/instructor-classes-with-lessons` (lines 2038-2099)**

Identical pattern to above but for instructor view. Each course triggers a separate lessons query, and each ended lesson triggers an external API call.

**[HIGH] N+1 + External API calls in `/api/user/:userId/classin-sessions` (lines 5544-5607)**

Fetches all sessions, then iterates through each one:
- Line 5565: DB query per session to get enrollment info
- Line 5572: External API call (`getClassInLoginUrl`) per session for URL regeneration
- Line 5579: DB write per session to update URL
- Line 5591: External API call (`getClassInWebcastUrl`) per ended session
- Line 5593: DB write per ended session

**[HIGH] N+1 in `/api/admin/classes/:classId/lessons` (lines 4317-4374)**

Iterates through all lessons and for each ended lesson:
- Line 4341: DB UPDATE per lesson to set status to 'ended'
- Line 4350: External API call per lesson for replay URL
- Line 4352: DB UPDATE per lesson to store replay URL

**[MEDIUM] N+1 in `processExpiredEnrollments` (lines 14055-14098)**

For each expired enrollment:
- Line 14067: DB query to check active subscriptions
- Line 14072: DB query to check other active enrollments
- Line 14078: DB update for the enrollment
- Line 14087: DB update for virtual account

With many expired enrollments, this could be very expensive. Since this runs on a cron trigger, it may have more lenient limits, but is still inefficient.

**[MEDIUM] N+1 in `/api/admin/enrollments/process-expired` (lines 2920-2951)**

```typescript
for (const enrollment of expiredEnrollments) {
  const result = await returnVirtualAccountFromEnrollment(c.env.DB, enrollment.id)
  await c.env.DB.prepare('UPDATE enrollments SET ...').bind(enrollment.id).run()
}
```

**[MEDIUM] N+1 in `/api/subscription/process-renewals` (lines 6217-6269)**

For each due subscription: 4 sequential DB writes (payment record, subscription update, order record, user update). With D1 batch API available (used on line 4729), these could be batched.

**[LOW] Sequential DB writes in `/api/admin/virtual-accounts/init` (lines 2954-3000)**

Individual INSERT per virtual account in a loop (line 2983). Could use D1 batch API.

### 1.2 Missing Indexes

Based on WHERE/ORDER BY clauses found in the code vs. existing indexes in migrations:

**[MEDIUM] `classes.slug` -- used in WHERE clause (lines 1771, 8842)**
- Already has UNIQUE constraint which creates an implicit index. OK.

**[MEDIUM] `classes.is_bestseller` -- used in WHERE clause (lines 8435, 4656)**
- No index exists. Used in homepage queries that run on every page load.
- Recommend: `CREATE INDEX idx_classes_is_bestseller ON classes(is_bestseller)`

**[LOW] `classes.is_new` -- used in WHERE clause (lines 8440, 4664)**
- No index exists. Used in homepage queries.
- Recommend: `CREATE INDEX idx_classes_is_new ON classes(is_new)`

**[LOW] `classes.class_type` -- used in WHERE clause (line 8444, 4672)**
- No index exists. Combined with `status = 'active'`.
- Recommend: Composite index `CREATE INDEX idx_classes_status_type ON classes(status, class_type)`

**[LOW] `orders.class_id` -- used in JOIN (line 6647)**
- No index exists on `orders.class_id`.
- Recommend: `CREATE INDEX idx_orders_class ON orders(class_id)`

**[LOW] `lesson_enrollments.payment_id` -- used in DELETE WHERE (line 6823)**
- No index exists.

### 1.3 Redundant Queries

**[MEDIUM] Homepage (/) makes 4 sequential DB queries (lines 8431-8446)**

The main page handler runs 4 separate queries: categories, featured/bestseller, new classes, live classes. These are all independent and could be batched using `c.env.DB.batch()` (which is already used elsewhere at line 4729).

**[MEDIUM] Homepage sections API (`/api/admin/homepage/sections`) runs 4 queries (lines 4651-4682)**

Four sequential queries for bestseller, new, live, and all active courses. Could be batched.

**[LOW] Class detail API runs 4-5 separate queries (lines 1764-1808)**

Fetches class, lessons, reviews, next lesson, and lesson stats in 5 separate queries. The class and lesson stats queries could be combined into one.

### 1.4 Large/Unbounded Result Sets

**[MEDIUM] `/api/classes/:id/reviews` (line 1812-1819)** -- No LIMIT clause. Could return thousands of reviews.

**[MEDIUM] `/api/user/:userId/orders` (line 2556-2565)** -- No LIMIT. A user with many orders gets all of them.

**[LOW] `/api/user/:userId/enrollments` (line 1888-1930)** -- No LIMIT. Returns all non-cancelled enrollments.

**[LOW] `/api/user/:userId/classin-sessions` (line 5544-5555)** -- No LIMIT. Returns all sessions for a user.

**[LOW] `/api/admin/test-codes` (line 2883-2885)** -- No LIMIT. `SELECT * FROM test_access_codes ORDER BY created_at DESC`

**[LOW] `/api/user/:userId/subscriptions` (line 6157-6168)** -- No LIMIT.

### 1.5 SELECT * Overuse

**[LOW] Widespread `SELECT *` usage** -- Found approximately 35+ instances of `SELECT *` across the codebase. While SQLite/D1 is somewhat tolerant of this, it transfers unnecessary data. Notable examples:
- Line 2701: `SELECT * FROM users WHERE id = ?` when only `id, name, is_test_account, test_expires_at` are needed
- Line 2899: `SELECT * FROM enrollments WHERE id = ?` when only `id, classin_account_uid` is needed
- Line 6735/6797: `SELECT * FROM orders WHERE id = ?` for cancel operations

---

## 2. Rendering Performance

### 2.1 Branding Middleware Re-reads Every HTML Response

**[HIGH] `applyBranding` middleware on ALL requests (lines 39-50)**

Every HTML response is:
1. Fully read into memory via `c.res.text()` (line 43)
2. String-replaced 3 times via `.replaceAll()` (lines 31-33)
3. Re-constructed as a new Response (lines 45-48)

This doubles the memory usage for every HTML page and adds CPU overhead. The largest pages (admin pages with inline JS) can be 50-100KB of HTML.

**Estimated improvement:** Apply branding at render time using template variables instead of post-processing. This eliminates the full body buffer + replacement + re-creation cycle.

### 2.2 Massive Inline HTML/JS Pages

**[MEDIUM] Server-rendered HTML pages with enormous inline JavaScript**

The main page (`/`, starting at line 8430) includes:
- `headHTML` (~40 lines of CSS/config)
- `navHTML` (~50 lines)
- `footerHTML` (~50 lines)
- `modalsHTML` (~170 lines of HTML for auth/payment modals)
- `globalScripts` (estimated ~1000+ lines of inline JavaScript)

Each page response is a massive single HTML string that must be:
1. Assembled via string concatenation
2. Run through `applyBranding` middleware
3. Sent as a single response

Similar for `/categories` (line 8697), `/class/:slug` (line 8838), and all admin pages.

**Impact:** Each page render likely produces 80-150KB of HTML. No streaming, no code splitting.

### 2.3 No Pagination on List Endpoints

**[MEDIUM] Category browse page loads all classes client-side**

The `/categories` page (line 8697) renders an empty grid and loads classes via client-side fetch to `/api/classes` with a PAGE_SIZE of 12. This part is actually paginated. However, the category list itself has no pagination.

---

## 3. Network/IO Performance

### 3.1 Sequential External API Calls (ClassIn)

**[HIGH] Sequential ClassIn API calls in lesson creation loop (lines 2239-2310)**

When creating multiple lessons, each lesson requires:
1. `createClassInLesson()` -- external fetch
2. `getClassInLoginUrl()` -- external fetch
3. DB INSERT

These run sequentially in a `for` loop. Creating 5 lessons = 10 sequential external API calls + 5 DB writes.

```typescript
for (let i = 0; i < lessons.length; i++) {
  const lessonResult = await createClassInLesson(...)  // fetch
  const instructorUrlResult = await getClassInLoginUrl(...)  // fetch
  const result = await c.env.DB.prepare(...).run()  // DB write
}
```

**Estimated improvement:** Parallelize with `Promise.all` where possible, or at minimum batch the DB writes.

**[HIGH] Sequential ClassIn API calls in instructor-enter (lines 5889-6064)**

A single instructor entering a class triggers up to 6 sequential external API calls:
1. `registerVirtualAccount()` (line 5966)
2. DB queries to check existing account
3. `addTeacherToCourse()` (line 5995)
4. `addSchoolStudent()` (line 5999)
5. `getClassInLoginUrl()` (line 6017)

Each is a separate `fetch()` to `api.eeo.cn`.

**[HIGH] Sequential ClassIn API calls in lesson-enter (lines 5748-5885)**

Student entering a class triggers 3 sequential external API calls:
1. `addSchoolStudent()` (line 5861)
2. `addStudentToCourse()` (line 5864)
3. `getClassInLoginUrl()` (line 5868)

Steps 1 and 2 are independent and could run in parallel.

**[MEDIUM] Sequential API calls in create-sessions (lines 2104-2320)**

Before the lesson creation loop, there are already 2-3 sequential external calls for virtual account registration and teacher setup.

### 3.2 Missing Caching

**[MEDIUM] Categories fetched on every page load**

`SELECT * FROM categories ORDER BY sort_order` is executed on:
- Every API call to `/api/categories` (line 1691)
- Every homepage render (line 8431)
- Every category page render (line 8698)
- Admin category list (line 4736)

Categories rarely change. This should be cached (e.g., using Cloudflare Cache API or a simple in-memory TTL cache).

**[MEDIUM] ClassIn config re-created on every request**

The ClassIn config object is recreated from environment variables on nearly every handler that needs it (appears 20+ times). While cheap, a module-level initialization would be cleaner and avoid repeated null checks.

**[LOW] Class detail fetched without caching**

Class pages are relatively static but re-queried from DB on every request. Could benefit from Cache API with short TTL (30-60 seconds).

### 3.3 Large Payload Sizes

**[LOW] `/api/admin/classes` returns all classes with correlated subquery (lines 4519-4533)**

No pagination on admin class list. Returns ALL classes with a correlated subquery for `latest_lesson_id`. With many classes, this grows unbounded.

---

## 4. Cloudflare Workers Specific

### 4.1 CPU Time Limits

**[HIGH] Chunk merge operation loads ALL chunks into memory (lines 3484-3497)**

```typescript
const chunks: ArrayBuffer[] = []
for (let i = 0; i < session.total_chunks; i++) {
  const chunkObj = await c.env.IMAGES.get(chunkKey)
  chunks.push(await chunkObj.arrayBuffer())
}
const mergedBlob = new Blob(chunks)
```

For a 500MB video with 25MB chunks = 20 chunks all loaded into memory simultaneously. Workers have a 128MB memory limit. This will crash for videos larger than ~100MB.

**Impact:** Complete failure for large file uploads. Comment on line 3484 says "메모리 효율적으로 처리" (memory-efficient handling) but the implementation is the opposite.

### 4.2 Subrequest Limits

**[HIGH] Multiple handlers can exceed 50 subrequest limit (Workers free plan) or 1000 (paid)**

The worst case is `/api/user/:userId/classin-sessions` which:
- For N sessions, makes up to 2 external API calls each (URL regen + webcast URL)
- Plus N DB queries for enrollment lookup
- Plus N DB writes for URL updates

A user with 30 sessions could trigger 60+ external API calls + 60 DB operations.

Similarly, `create-sessions` with many lessons and `process-renewals` with many subscriptions.

### 4.3 Memory Usage

**[MEDIUM] Large HTML strings assembled in memory**

Each HTML page is assembled as a single string with all templates concatenated. The homepage HTML is approximately 80-100KB. The branding middleware then creates a second copy. Admin pages with inline JavaScript are even larger.

**[LOW] `applyBranding` creates duplicate response body (lines 39-50)**

`c.res.text()` buffers the entire response, then `applyBranding()` creates a new string, then `new Response()` creates a third copy. For a 100KB page, this is ~300KB of temporary memory.

---

## 5. Additional Findings

### 5.1 Authentication Concerns (Performance-adjacent)

**[MEDIUM] Admin auth check is a DB query per request (lines 6640-6643)**

`checkAdminSession` queries the `admin_sessions` table on every authenticated admin API call. This is expected but could benefit from a short-lived in-memory cache.

### 5.2 Correlated Subqueries in Complex Queries

**[MEDIUM] Enrollment query uses 5 correlated subqueries (lines 1895-1929)**

The `/api/user/:userId/enrollments` query includes correlated subqueries for:
1. `next_lesson_session_id`
2. `next_lesson_join_url`
3. `total_lesson_count`
4. `completed_lesson_count`

Plus a correlated subquery in the LEFT JOIN for `next_lesson`. While SQLite handles these reasonably well, with many enrollments this becomes expensive.

### 5.3 No Connection Pooling / Request Coalescing

**[LOW] No use of D1 batch for sequential writes in the same handler**

Several handlers perform 3-10 sequential `await c.env.DB.prepare(...).run()` calls that could be batched. Examples:
- Class deletion (lines 4632-4643): 9 sequential DELETE statements
- User deletion (lines 5269-5273): 5 sequential DELETE statements
- Payment completion (lines 6693-6715): 3-4 sequential statements

D1 `batch()` is already used on line 4729 for reordering, showing the team is aware of it.

---

## Priority Remediation Roadmap

### Phase 1 -- Critical (Immediate)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 1 | N+1 + external API loops in enrollment/lesson endpoints | HIGH | Medium |
| 2 | Chunk merge memory explosion | HIGH | Low |
| 3 | Sequential ClassIn API calls (parallelize with Promise.all) | HIGH | Low |
| 4 | applyBranding middleware buffering | HIGH | Low |

### Phase 2 -- Important (Next Sprint)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 5 | Batch D1 queries on homepage/admin endpoints | MEDIUM | Low |
| 6 | Add LIMIT to unbounded queries | MEDIUM | Low |
| 7 | Cache categories and class detail with short TTL | MEDIUM | Medium |
| 8 | Add missing indexes (is_bestseller, is_new, class_type) | MEDIUM | Low |
| 9 | Batch sequential D1 writes in delete/payment handlers | MEDIUM | Low |

### Phase 3 -- Optimization (Backlog)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 10 | Replace SELECT * with specific columns | LOW | Medium |
| 11 | Simplify correlated subqueries in enrollment query | LOW | Medium |
| 12 | Extract static HTML templates to reduce runtime assembly | LOW | High |

---

## Appendix: Existing Index Coverage

Indexes defined across migrations 0001-0020:

| Table | Indexed Columns | Migration |
|-------|----------------|-----------|
| classes | category_id, instructor_id, status | 0001 |
| classes | classin_course_id | 0008 |
| reviews | class_id | 0001 |
| enrollments | user_id, class_id (composite UNIQUE), status, expires_at, subscription_id, classin_account_uid | 0001, 0006, 0011 |
| orders | user_id | 0001 |
| wishlist | user_id | 0001 |
| classin_sessions | class_id, user_id, enrollment_id | 0002 |
| subscriptions | user_id, status, next_billing_date | 0003 |
| subscription_payments | subscription_id | 0003 |
| classin_virtual_accounts | status, user_id, account_uid | 0004 |
| users | classin_account_uid | 0004 |
| instructors | classin_uid | 0007 |
| admin_sessions | session_token, expires_at | 0010 |
| class_lessons | class_id, status, scheduled_at, lesson_type, stream_uid | 0012, 0015 |
| lesson_enrollments | user_id, class_lesson_id | 0014 |
| chunked_uploads | upload_id, status | 0018 |

**Missing indexes identified:**
- `classes(is_bestseller)` -- used in homepage bestseller queries
- `classes(is_new)` -- used in homepage new courses queries
- `classes(status, class_type)` -- composite for live course filtering
- `orders(class_id)` -- used in admin order listing JOIN
- `classes(homepage_sort_order)` -- used in ORDER BY for homepage sections
