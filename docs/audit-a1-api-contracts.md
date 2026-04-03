# API Endpoint Contracts Audit

**Project:** ClassIn Live  
**File:** `src/index.tsx` (~14,508 lines)  
**Audit Date:** 2026-04-03  
**Total Endpoints:** 119 (API: 103, HTML pages: 16)

---

## Table of Contents

1. [Middleware](#1-middleware)
2. [Auth](#2-auth)
3. [Courses / Classes (Public)](#3-courses--classes-public)
4. [Student User Data](#4-student-user-data)
5. [Wishlist / Cart](#5-wishlist--cart)
6. [Payments (Demo)](#6-payments-demo)
7. [Payments (HectoFinancial PG)](#7-payments-hectofinancial-pg)
8. [Subscriptions](#8-subscriptions)
9. [Test Accounts](#9-test-accounts)
10. [ClassIn Integration (EEO.cn)](#10-classin-integration-eeocn)
11. [Virtual Accounts](#11-virtual-accounts)
12. [Cloudflare Stream](#12-cloudflare-stream)
13. [Admin - Auth & Utility](#13-admin---auth--utility)
14. [Admin - Classes CRUD](#14-admin---classes-crud)
15. [Admin - Lessons / Sessions](#15-admin---lessons--sessions)
16. [Admin - Homepage Management](#16-admin---homepage-management)
17. [Admin - Instructors](#17-admin---instructors)
18. [Admin - Users](#18-admin---users)
19. [Admin - Enrollments](#19-admin---enrollments)
20. [Admin - Orders](#20-admin---orders)
21. [Admin - Debug](#21-admin---debug)
22. [Reviews](#22-reviews)
23. [Webhooks](#23-webhooks)
24. [File Upload / Serve](#24-file-upload--serve)
25. [HTML Pages (Student-facing)](#25-html-pages-student-facing)
26. [HTML Pages (Admin)](#26-html-pages-admin)

---

## Authentication Schemes

| Scheme | Mechanism | Details |
|--------|-----------|---------|
| **None** | Public access | No auth required |
| **Student JWT** | `Authorization: Bearer <token>` header | Base64-encoded JWT with `{ sub, email, role, exp }` (alg: none) |
| **Admin Session** | `admin_session` cookie | Cookie-based session checked via `admin_sessions` DB table |
| **Admin Key** | `adminKey` in JSON body | Hardcoded value `classin-admin-2024` |
| **userId in body/param** | User ID passed directly | No server-side auth validation (client-trusted) |

---

## 1. Middleware

| # | Line | Route | Description |
|---|------|-------|-------------|
| 1 | 39 | `app.use('*', ...)` | Branding middleware: replaces "ClassIn Live" in all HTML responses with env-configured names |
| 2 | 52 | `app.use('/api/*', cors())` | CORS enabled for all API routes |

---

## 2. Auth

### `POST /api/auth/login`
- **Line:** 1823
- **Auth:** None
- **Body:** `{ email: string, password: string }`
- **Response 200:** `{ user: { id, email, name, avatar, role, subscription_plan, subscription_expires_at, is_test_account, test_expires_at }, token: string }`
- **Response 401:** `{ error: "이메일 또는 비밀번호가 올바르지 않습니다." }`
- **DB reads:** `users`
- **DB writes:** None
- **Notes:** Password is NOT verified against stored hash -- only checks if email exists. JWT uses `alg: none`.

### `POST /api/auth/register`
- **Line:** 1837
- **Auth:** None
- **Body:** `{ email: string, password: string, name: string, testCode?: string }`
- **Response 200:** `{ user, token, testCodeApplied?: boolean, message?: string }`
- **Response 400:** `{ error: "이미 등록된 이메일입니다." }`
- **Response 500:** `{ error: "회원가입에 실패했습니다." }`
- **DB reads:** None
- **DB writes:** `users` (INSERT)
- **Notes:** Valid test code `CLASSIN-TEST-2024` grants 30-day free access. Password stored as `hash_${password}` (not real hashing).

---

## 3. Courses / Classes (Public)

### `GET /api/categories`
- **Line:** 1690
- **Auth:** None
- **Response 200:** `Category[]`
- **DB reads:** `categories`

### `GET /api/classes`
- **Line:** 1696
- **Auth:** None
- **Query params:**
  - `category` (optional) -- category slug filter
  - `search` (optional) -- LIKE search on title/description/tags
  - `sort` (optional, default `popular`) -- `popular|rating|newest|price_low|price_high`
  - `level` (optional) -- filters by level unless `all`
  - `limit` (optional, default 20)
  - `offset` (optional, default 0)
- **Response 200:** `ClassWithInstructor[]`
- **DB reads:** `classes`, `instructors`, `categories`

### `GET /api/classes/featured`
- **Line:** 1738
- **Auth:** None
- **Response 200:** `ClassWithInstructor[]` (up to 8, where `is_bestseller = 1`, ordered by rating)
- **DB reads:** `classes`, `instructors`, `categories`

### `GET /api/classes/new`
- **Line:** 1751
- **Auth:** None
- **Response 200:** `ClassWithInstructor[]` (up to 8, where `is_new = 1`, ordered by created_at)
- **DB reads:** `classes`, `instructors`, `categories`

### `GET /api/classes/:slug`
- **Line:** 1764
- **Auth:** None
- **Params:** `slug` -- class slug
- **Response 200:** `{ ...class, curriculum: Record<string, Lesson[]>, reviews: Review[], next_lesson, total_class_lessons, completed_class_lessons }`
- **Response 404:** `{ error: "Class not found" }`
- **DB reads:** `classes`, `instructors`, `categories`, `lessons`, `reviews`, `users`, `class_lessons`

### `GET /api/classes/:id/reviews`
- **Line:** 1812
- **Auth:** None
- **Params:** `id` -- class ID
- **Response 200:** `ReviewWithUser[]`
- **DB reads:** `reviews`, `users`

### `GET /api/instructors/:id`
- **Line:** 2568
- **Auth:** None
- **Params:** `id` -- instructor ID
- **Response 200:** `{ instructor, classes }`
- **DB reads:** `instructors`, `users`, `classes`, `categories`

---

## 4. Student User Data

### `GET /api/enrollments/check`
- **Line:** 1872
- **Auth:** None (userId in query)
- **Query params:** `userId` (required), `classId` (required)
- **Response 200:** `{ enrolled: boolean }`
- **Response 400:** `{ error: "userId and classId required" }`
- **DB reads:** `enrollments`

### `GET /api/user/:userId/enrollments`
- **Line:** 1889
- **Auth:** None (userId in path)
- **Response 200:** `EnrollmentWithNextLesson[]`
- **DB reads:** `enrollments`, `classes`, `instructors`, `class_lessons`, `classin_sessions`

### `GET /api/user/:userId/instructor-classes`
- **Line:** 1934
- **Auth:** None (userId in path)
- **Response 200:** `InstructorClassWithLesson[]` or `[]` if not instructor
- **DB reads:** `instructors`, `users`, `classes`, `categories`, `enrollments`, `class_lessons`

### `GET /api/user/:userId/enrollments-with-lessons`
- **Line:** 1976
- **Auth:** None (userId in path)
- **Response 200:** `EnrollmentWithAllLessons[]`
- **DB reads:** `enrollments`, `classes`, `instructors`, `subscriptions`, `class_lessons`, `classin_sessions`, `lesson_enrollments`
- **DB writes:** `class_lessons` (updates `replay_url` on ended lessons)

### `GET /api/user/:userId/instructor-classes-with-lessons`
- **Line:** 2038
- **Auth:** None (userId in path)
- **Response 200:** `CourseWithLessons[]` or `[]`
- **DB reads:** `instructors`, `users`, `classes`, `categories`, `enrollments`, `class_lessons`
- **DB writes:** `class_lessons` (updates `replay_url` on ended lessons)

### `GET /api/user/:userId/orders`
- **Line:** 2556
- **Auth:** None (userId in path)
- **Response 200:** `OrderWithClass[]`
- **DB reads:** `orders`, `classes`

### `GET /api/user/:userId/test-status`
- **Line:** 2618
- **Auth:** None (userId in path)
- **Response 200:** `{ isTestAccount: boolean, expiresAt: string|null }`
- **Response 404:** `{ error: "User not found" }`
- **DB reads:** `users`

### `GET /api/user/:userId/subscriptions`
- **Line:** 6157
- **Auth:** None (userId in path)
- **Response 200:** `SubscriptionWithClass[]`
- **DB reads:** `subscriptions`, `classes`, `instructors`

### `GET /api/user/:userId/classin-account`
- **Line:** 5524
- **Auth:** None (userId in path)
- **Response 200:** `{ hasAccount: boolean, account?: VirtualAccount }`
- **DB reads:** `classin_virtual_accounts`, `users`

### `GET /api/user/:userId/classin-sessions`
- **Line:** 5544
- **Auth:** None (userId in path)
- **Response 200:** `ClassInSessionWithClass[]`
- **DB reads:** `classin_sessions`, `classes`, `instructors`, `enrollments`
- **DB writes:** `classin_sessions` (updates `classin_join_url`, `classin_live_url`, `status`)

---

## 5. Wishlist / Cart

### `GET /api/user/:userId/wishlist`
- **Line:** 2323
- **Auth:** None (userId in path)
- **Response 200:** `WishlistItemWithClass[]`
- **DB reads:** `wishlist`, `classes`, `instructors`

### `POST /api/wishlist`
- **Line:** 2336
- **Auth:** None
- **Body:** `{ userId: number, classId: number }`
- **Response 200:** `{ success: true }`
- **Response 500:** `{ error: "Failed" }`
- **DB writes:** `wishlist` (INSERT OR IGNORE)

### `DELETE /api/wishlist`
- **Line:** 2347
- **Auth:** None
- **Body:** `{ userId: number, classId: number }`
- **Response 200:** `{ success: true }`
- **DB writes:** `wishlist` (DELETE)

### `GET /api/user/:userId/cart`
- **Line:** 2354
- **Auth:** None (userId in path)
- **Response 200:** `CartItemWithClass[]`
- **DB reads:** `cart`, `classes`, `instructors`

### `POST /api/cart`
- **Line:** 2367
- **Auth:** None
- **Body:** `{ userId: number, classId: number }`
- **Response 200:** `{ success: true }`
- **Response 500:** `{ error: "Failed" }`
- **DB writes:** `cart` (INSERT OR IGNORE)

### `DELETE /api/cart`
- **Line:** 2378
- **Auth:** None
- **Body:** `{ userId: number, classId: number }`
- **Response 200:** `{ success: true }`
- **DB writes:** `cart` (DELETE)

---

## 6. Payments (Demo)

### `POST /api/payment/process`
- **Line:** 2385
- **Auth:** None
- **Body:** `{ userId, classId?, lessonId?, paymentMethod?, cardNumber?, cardExpiry?, cardCvc?, amount, orderType?, subscriptionPlan? }`
- **Response 200:** `{ success: true, orderId, transactionId, message, virtualAccount?, classinSession? }`
- **DB reads:** `classes`, `users`, `enrollments`, `class_lessons`
- **DB writes:** `orders` (INSERT), `enrollments` (INSERT/UPDATE), `lesson_enrollments` (INSERT), `cart` (DELETE), `classes` (UPDATE student count), `users` (UPDATE subscription), `classin_virtual_accounts`, `classin_sessions`
- **Notes:** Demo payment -- always succeeds. Creates enrollment, assigns virtual account, creates ClassIn session.

---

## 7. Payments (HectoFinancial PG)

### `GET /api/payment/hecto/status`
- **Line:** 6296
- **Auth:** None
- **Response 200:** `{ configured: boolean, mode: string, mid: string }`

### `GET /api/payment/hecto/test-hash`
- **Line:** 6306
- **Auth:** None
- **Response 200:** `{ aesTest, test: { plain, expectedHash, calculatedHash, match }, current }`
- **Notes:** Debug endpoint for verifying hash generation.

### `POST /api/payment/hecto/prepare`
- **Line:** 6358
- **Auth:** None
- **Body:** `{ classId?, lessonId?, userId, amount, productName?, customerName?, customerPhone?, customerEmail?, orderType? }`
- **Response 200:** `{ success: true, orderId, hashDebug, paymentParams: { ...all Hecto params } }`
- **Response 500:** `{ error: "헥토파이낸셜 PG 설정이 완료되지 않았습니다." }`
- **DB writes:** `orders` (INSERT with status `pending`)

### `POST /api/payment/hecto/result`
- **Line:** 6480
- **Auth:** None (called by HectoFinancial redirect)
- **Body:** Form-urlencoded from PG
- **Response:** HTML page (shows success/fail, posts message to parent window)
- **DB reads:** None (decrypts params only)

### `POST /api/payment/hecto/noti`
- **Line:** 6543
- **Auth:** None (server-to-server from HectoFinancial)
- **Body:** Form-urlencoded notification params
- **Response:** `"OK"` or `"FAIL"` (plain text)
- **DB reads:** `orders`
- **DB writes:** `orders` (UPDATE), `lesson_enrollments` (INSERT), `enrollments` (INSERT/UPDATE), `classes` (UPDATE student count), `cart` (DELETE)
- **Notes:** Verifies `pktHash`. Processes `outStatCd 0021` (success) and `0051` (pending deposit).

### `POST /api/payment/hecto/complete`
- **Line:** 6678
- **Auth:** None
- **Body:** `{ orderId, userId, classId?, lessonId?, orderType?, trdNo?, mchtTrdNo? }`
- **Response 200:** `{ success: true }` or `{ success: false, error }`
- **Response 500:** `{ success: false, error }`
- **DB reads:** `orders`
- **DB writes:** `orders` (UPDATE), `lesson_enrollments`, `enrollments`, `classes`, `cart`

### `POST /api/payment/hecto/cancel`
- **Line:** 6727
- **Auth:** None
- **Body:** `{ orderId: number, reason?: string }`
- **Response 200:** `{ success: true, message }` or `{ success: false, error }`
- **Response 404:** `{ error: "주문을 찾을 수 없습니다." }`
- **Response 400:** `{ error: "취소할 수 없는 주문 상태입니다." }`
- **Response 500:** `{ error }` or `{ success: false, error }`
- **DB reads:** `orders`
- **DB writes:** `orders` (UPDATE), `enrollments` (UPDATE), `classes` (UPDATE)

---

## 8. Subscriptions

### `POST /api/subscription/create`
- **Line:** 6070
- **Auth:** None
- **Body:** `{ userId, planType, classId?, amount, paymentMethod?, cardNumber?, cardExpiry?, cardCvc? }`
- **Response 200:** `{ success: true, subscriptionId, transactionId, billingDay, nextBillingDate, periodEnd, message, classinSession? }`
- **Response 400:** `{ error }` (missing fields or duplicate subscription)
- **DB writes:** `subscriptions`, `subscription_payments`, `orders`, `users`, `enrollments`, `cart`, `classes`, `classin_sessions`

### `GET /api/subscription/:subId/payments`
- **Line:** 6172
- **Auth:** None
- **Response 200:** `SubscriptionPayment[]`
- **DB reads:** `subscription_payments`

### `POST /api/subscription/:subId/cancel`
- **Line:** 6181
- **Auth:** None
- **Body:** `{ userId: number }`
- **Response 200:** `{ success: true, message, activeUntil }`
- **Response 404:** `{ error: "구독을 찾을 수 없습니다." }`
- **Response 400:** `{ error: "이미 해지된 구독입니다." }`
- **DB reads:** `subscriptions`
- **DB writes:** `subscriptions` (UPDATE)

### `POST /api/subscription/:subId/reactivate`
- **Line:** 6202
- **Auth:** None
- **Body:** `{ userId: number }`
- **Response 200:** `{ success: true, message }`
- **Response 404/400:** `{ error }`
- **DB reads:** `subscriptions`
- **DB writes:** `subscriptions` (UPDATE)

### `POST /api/subscription/process-renewals`
- **Line:** 6218
- **Auth:** None (designed for Cloudflare Cron Trigger)
- **Response 200:** `{ processed: number, results: RenewalResult[] }`
- **DB reads:** `subscriptions`, `users`
- **DB writes:** `subscription_payments`, `subscriptions`, `orders`, `users`
- **Notes:** Demo mode -- renewal always succeeds.

---

## 9. Test Accounts

### `POST /api/test-account/activate`
- **Line:** 2582
- **Auth:** None
- **Body:** `{ userId: number, accessCode: string }`
- **Response 200:** `{ success: true, message, expiresAt }`
- **Response 400:** `{ error }` (missing params or invalid code)
- **DB reads:** `test_access_codes`
- **DB writes:** `users` (UPDATE), `test_access_codes` (UPDATE used_count)

### `POST /api/lesson-enroll/test`
- **Line:** 2638
- **Auth:** None (checks test account status)
- **Body:** `{ userId: number, lessonId: number }`
- **Response 200:** `{ success: true, message, lessonId }`
- **Response 400/403/404:** `{ error }`
- **DB reads:** `users`, `class_lessons`
- **DB writes:** `lesson_enrollments`, `enrollments`

### `POST /api/test-account/enroll`
- **Line:** 2691
- **Auth:** None (checks test account status)
- **Body:** `{ userId: number, classId: number }`
- **Response 200:** `{ success: true, message, transactionId?, virtualAccount?, classinSession? }`
- **Response 400/403/500:** `{ error }`
- **DB reads:** `users`, `classes`, `enrollments`, `classin_sessions`
- **DB writes:** `enrollments`, `orders`, `cart` (DELETE), `classes`, `classin_virtual_accounts`, `classin_sessions`

---

## 10. ClassIn Integration (EEO.cn)

### `GET /api/classin/status`
- **Line:** 6272
- **Auth:** None
- **Response 200:** `{ configured: boolean, mode: string, message: string }`

### `GET /api/classin-session/:sessionId`
- **Line:** 5610
- **Auth:** None
- **Response 200:** Full session detail with class/instructor info
- **Response 404:** `{ error: "Session not found" }`
- **DB reads:** `classin_sessions`, `classes`, `instructors`
- **DB writes:** `classin_sessions` (updates replay URL if ended)

### `GET /api/enrollment/:enrollmentId/classin-session`
- **Line:** 5656
- **Auth:** None
- **Response 200:** Session with class info
- **Response 404:** `{ error: "No ClassIn session found" }`
- **DB reads:** `classin_sessions`, `classes`, `instructors`

### `GET /api/classin/enter/:sessionId`
- **Line:** 5674
- **Auth:** None
- **Query params:** `redirect` (optional, `true` for HTTP redirect)
- **Response 200:** `{ success: true, url }` or HTTP 302 redirect
- **Response 400/404:** `{ error }`
- **DB reads:** `classin_sessions`, `enrollments`, `users`, `classin_virtual_accounts`
- **DB writes:** `classin_sessions` (updates join URL)
- **External API:** ClassIn `addSchoolStudent`, `addStudentToCourse`, `getLoginLinked`

### `GET /api/classin/lesson-enter/:lessonId`
- **Line:** 5748
- **Auth:** None
- **Query params:** `redirect` (optional), `userId` (required)
- **Response 200:** `{ success: true, url }` or HTTP 302 redirect, or HTML error page
- **Response 400/403/404:** `{ error }` or HTML
- **DB reads:** `class_lessons`, `classes`, `enrollments`, `users`, `classin_virtual_accounts`
- **DB writes:** `classin_virtual_accounts`, `enrollments`
- **External API:** ClassIn `addSchoolStudent`, `addStudentToCourse`, `getLoginLinked`

### `GET /api/classin/instructor-enter/:lessonId`
- **Line:** 5889
- **Auth:** None
- **Query params:** `redirect` (optional), `mode` (optional, default `instructor`, also `observer`)
- **Response 200:** `{ success: true, url, requiresManualLogin? }` or HTTP redirect or HTML
- **Response 400/404:** `{ error }` or HTML
- **DB reads:** `class_lessons`, `classes`, `instructors`, `users`, `classin_virtual_accounts`
- **DB writes:** `instructors`, `classin_virtual_accounts`, `class_lessons`, `classes`
- **External API:** ClassIn register, `addTeacher`, `addTeacherToCourse`, `addSchoolStudent`, `getLoginLinked`

### `POST /api/instructor/classes/:classId/create-sessions`
- **Line:** 2104
- **Auth:** None (checks instructor role via userId in body)
- **Body:** `{ lessons: Array<{ scheduledAt, durationMinutes?, title? }>, userId: number }`
- **Response 200:** `{ success: true, message, courseId, createdLessons, errors? }`
- **Response 400/403/500:** `{ error }`
- **DB reads:** `instructors`, `users`, `classes`, `class_lessons`, `classin_virtual_accounts`
- **DB writes:** `class_lessons`, `classes`, `instructors`, `classin_virtual_accounts`
- **External API:** ClassIn course/lesson creation, `getLoginLinked`

---

## 11. Virtual Accounts

### `POST /api/virtual-accounts/assign`
- **Line:** 5394
- **Auth:** None
- **Body:** `{ userId: number, userName: string }`
- **Response 200:** `{ success: true, accountUid, password, isRegistered, message }`
- **Response 404:** `{ error: "사용 가능한 가상 계정이 없습니다." }`
- **DB reads:** `users`, `classin_virtual_accounts`
- **DB writes:** `classin_virtual_accounts`, `users`

### `POST /api/virtual-accounts/register`
- **Line:** 5469
- **Auth:** None
- **Body:** `{ accountId: number }`
- **Response 200:** `{ success: true/false, message?, classInUid?, error? }`
- **Response 404:** `{ error: "계정을 찾을 수 없습니다." }`
- **DB reads:** `classin_virtual_accounts`
- **DB writes:** `classin_virtual_accounts`, `users`

---

## 12. Cloudflare Stream

### `POST /api/admin/stream/upload-url`
- **Line:** 3276
- **Auth:** None (no admin check!)
- **Body:** `{ maxDurationSeconds?: number }` (optional, default 7200)
- **Response 200:** `{ uploadURL, uid }`
- **Response 500:** `{ error }`

### `POST /api/admin/stream/tus-upload-url`
- **Line:** 3304
- **Auth:** None
- **Body:** `{ uploadLength: number, filename: string }`
- **Response 200:** `{ uploadURL, uid }`
- **Response 400/500:** `{ error }`

### `POST /api/admin/stream/init-chunked-upload`
- **Line:** 3361
- **Auth:** None
- **Body:** `{ filename: string, totalSize: number, totalChunks: number }`
- **Response 200:** `{ uploadId, chunkSize }`
- **DB writes:** `chunked_uploads` (INSERT)

### `POST /api/admin/stream/upload-chunk`
- **Line:** 3384
- **Auth:** None
- **Body:** FormData with `uploadId`, `chunkIndex`, `chunk` (File)
- **Response 200:** `{ success: true, chunkIndex, chunkKey }`
- **Response 400/404:** `{ error }`
- **DB reads:** `chunked_uploads`
- **DB writes:** `chunked_uploads` (UPDATE), R2 `IMAGES` bucket
- **Storage:** R2 `chunks/{uploadId}/{index}`

### `POST /api/admin/stream/complete-chunked-upload`
- **Line:** 3427
- **Auth:** None
- **Body:** `{ uploadId: string }`
- **Response 200:** `{ success: true, streamUid, message }`
- **Response 400/404/500:** `{ error }`
- **DB reads:** `chunked_uploads`
- **DB writes:** `chunked_uploads` (UPDATE)
- **Storage:** R2 read + delete, Cloudflare Stream API upload

### `GET /api/admin/stream/chunked-upload-status/:uploadId`
- **Line:** 3542
- **Auth:** None
- **Response 200:** `{ uploadId, filename, totalSize, totalChunks, uploadedChunks, status, streamUid, progress }`
- **Response 404:** `{ error }`
- **DB reads:** `chunked_uploads`

### `POST /api/admin/classes/:classId/create-recorded-lesson`
- **Line:** 3566
- **Auth:** None
- **Body:** `{ title?, streamUid: string, description?, curriculumItems?, materials? }`
- **Response 200:** `{ success: true, message, isProcessing, lessonId, lessonNumber, lessonTitle, durationMinutes, streamUid, thumbnail }`
- **Response 400/404/500:** `{ error }`
- **DB reads:** `classes`, `class_lessons`
- **DB writes:** `class_lessons` (INSERT), `classes` (UPDATE)

### `POST /api/admin/stream/fix-video/:videoUid`
- **Line:** 3656
- **Auth:** None
- **Response 200:** `{ success: true, message, video }` or `{ error, details }`
- **External API:** Cloudflare Stream API (POST to update settings)

### `GET /api/admin/stream/info/:videoUid`
- **Line:** 3700
- **Auth:** None
- **Response 200:** Raw Cloudflare Stream API response
- **External API:** Cloudflare Stream API (GET video info)

### `POST /api/lessons/:lessonId/check-status`
- **Line:** 3758
- **Auth:** None
- **Response 200:** `{ status: "ready"|"processing"|"error", message, durationMinutes? }`
- **Response 400/404/500:** `{ error }`
- **DB reads:** `class_lessons`
- **DB writes:** `class_lessons` (UPDATE when ready)

### `GET /api/lessons/:lessonId/stream-url`
- **Line:** 3829
- **Auth:** Student JWT (Bearer token)
- **Headers:** `Authorization: Bearer <jwt>`
- **Response 200:** `{ hlsUrl, thumbnail, duration, title }`
- **Response 202:** `{ error, processing: true, status?, pctComplete? }` (video still processing)
- **Response 401:** `{ error }` (no/invalid token)
- **Response 403:** `{ error, requirePayment: true, coursePrice }` (not enrolled)
- **Response 400/404/500:** `{ error }`
- **DB reads:** `class_lessons`, `classes`, `instructors`, `enrollments`
- **Notes:** Admins, instructors (course owner), and free-course users bypass payment check.

---

## 13. Admin - Auth & Utility

### `GET /admin/login`
- **Line:** 10640
- **Auth:** None (redirects to `/admin` if already logged in)
- **Query params:** `error` (optional, `invalid` or `required`)
- **Response:** HTML login page

### `POST /api/admin/login`
- **Line:** 10704
- **Auth:** None (form-based login)
- **Body:** Form-urlencoded `{ username, password }`
- **Response 302:** Redirect to `/admin` with `Set-Cookie: admin_session`
- **Response 302:** Redirect to `/admin/login?error=invalid` on failure
- **DB reads:** `admin_settings` (username + password)
- **DB writes:** `admin_sessions` (INSERT), `admin_sessions` (DELETE expired)

### `GET /admin/logout`
- **Line:** 10754
- **Auth:** None
- **Response 302:** Redirect to `/admin/login`, clears cookie
- **DB writes:** `admin_sessions` (DELETE)

### `POST /api/admin/change-password`
- **Line:** 10771
- **Auth:** Admin Session (cookie)
- **Body:** `{ currentPassword: string, newPassword: string }`
- **Response 200:** `{ success: true, message }`
- **Response 400/401:** `{ error }`
- **DB reads:** `admin_settings`
- **DB writes:** `admin_settings` (UPDATE)

---

## 14. Admin - Classes CRUD

### `GET /api/admin/classes`
- **Line:** 4519
- **Auth:** None (no admin check!)
- **Response 200:** `{ classes: ClassWithInstructorAndStatus[] }`
- **DB reads:** `classes`, `instructors`, `categories`, `class_lessons`

### `POST /api/admin/classes`
- **Line:** 4537
- **Auth:** None
- **Body:** `{ title: string, description?, instructorId: number, categoryId: number, price?, scheduleStart?, durationMinutes?, thumbnail?, level?, classType? }`
- **Response 200:** `{ success: true, classId, slug }`
- **Response 400:** `{ error }` (missing required fields)
- **DB writes:** `classes` (INSERT)

### `PUT /api/admin/classes/:id`
- **Line:** 4572
- **Auth:** None
- **Body:** `{ title?, description?, instructorId?, categoryId?, price?, scheduleStart?, durationMinutes?, thumbnail?, level?, classType?, status? }`
- **Response 200:** `{ success: true, message }`
- **Response 404:** `{ error }`
- **DB reads:** `classes`
- **DB writes:** `classes` (UPDATE)

### `DELETE /api/admin/classes/:id`
- **Line:** 4615
- **Auth:** None
- **Response 200:** `{ success: true, message }`
- **Response 400:** `{ error }` (has active enrollments)
- **Response 404:** `{ error }`
- **DB reads:** `classes`, `enrollments`
- **DB writes:** `classin_sessions`, `enrollments`, `orders`, `lessons`, `reviews`, `wishlist`, `cart`, `subscriptions`, `class_lessons`, `classes` (all DELETE)

### `GET /api/admin/categories`
- **Line:** 4735
- **Auth:** None
- **Response 200:** `{ categories: Category[] }`
- **DB reads:** `categories`

### `GET /api/admin/classes/:classId/session`
- **Line:** 4741
- **Auth:** None
- **Response 200:** `{ class, enrollmentCount, hasClassInSession }`
- **Response 404:** `{ error }`
- **DB reads:** `classes`, `instructors`, `enrollments`

---

## 15. Admin - Lessons / Sessions

### `POST /api/admin/classes/:classId/create-session`
- **Line:** 3967
- **Auth:** None
- **Body:** `{ scheduledAt: string }` (ISO 8601)
- **Response 200:** `{ success: true, message, courseId, classId, lessonId, lessonTitle, instructorUrl, scheduledAt, isNewCourse }` or `{ success: true, alreadyExists: true, ... }`
- **Response 400/404/500:** `{ error }`
- **DB reads:** `classes`, `instructors`, `class_lessons`
- **DB writes:** `class_lessons` (INSERT), `classes` (UPDATE)
- **External API:** ClassIn course/lesson creation, `getLoginLinked`

### `POST /api/admin/classes/:classId/create-sessions`
- **Line:** 4102
- **Auth:** None
- **Body:** `{ lessons: Array<{ title?, scheduledAt: string, durationMinutes?, description?, curriculumItems?, materials? }> }`
- **Response 200:** `{ success: true, message, courseId, createdLessons, errors? }`
- **Response 400/404/500:** `{ error }`
- **DB reads:** `classes`, `instructors`, `users`, `class_lessons`, `classin_virtual_accounts`
- **DB writes:** `class_lessons`, `classes`, `instructors`, `classin_virtual_accounts`
- **External API:** ClassIn course/lesson creation, `registerVirtualAccount`, `addTeacher`, `getLoginLinked`

### `GET /api/admin/classes/:classId/lessons`
- **Line:** 4318
- **Auth:** None
- **Response 200:** `{ lessons: ClassLesson[], courseInfo }`
- **DB reads:** `class_lessons`, `classes`, `instructors`
- **DB writes:** `class_lessons` (updates `status` and `replay_url` for ended lessons)

### `PATCH /api/admin/lessons/:lessonId`
- **Line:** 4377
- **Auth:** None
- **Body:** `{ status?: string, replayUrl?: string }`
- **Response 200:** `{ success: true }`
- **DB writes:** `class_lessons` (UPDATE)

### `DELETE /api/admin/lessons/:lessonId`
- **Line:** 4403
- **Auth:** None
- **Response 200:** `{ success: true, message }`
- **Response 404/400/500:** `{ error }`
- **DB reads:** `class_lessons`
- **DB writes:** `class_lessons` (DELETE), `lesson_enrollments` (DELETE), `classes` (UPDATE lesson_count)
- **External API:** ClassIn `deleteClassInLesson` (for non-recorded lessons)

### `DELETE /api/instructor/lessons/:lessonId`
- **Line:** 4459
- **Auth:** None (checks instructor role via userId in body)
- **Body:** `{ userId: number }`
- **Response 200:** `{ success: true, message }`
- **Response 403/404/400:** `{ error }`
- **DB reads:** `instructors`, `users`, `class_lessons`, `classes`
- **DB writes:** `class_lessons` (DELETE), `lesson_enrollments` (DELETE), `classes` (UPDATE)

---

## 16. Admin - Homepage Management

### `GET /api/admin/homepage/sections`
- **Line:** 4651
- **Auth:** None
- **Response 200:** `{ bestseller, newCourses, liveCourses, allActive }`
- **DB reads:** `classes`, `instructors`

### `PUT /api/admin/classes/:id/homepage-flags`
- **Line:** 4693
- **Auth:** None
- **Body:** `{ isBestseller?: number, isNew?: number, homepageSortOrder?: number }`
- **Response 200:** `{ success: true }`
- **Response 404:** `{ error }`
- **DB reads:** `classes`
- **DB writes:** `classes` (UPDATE)

### `PUT /api/admin/homepage/reorder`
- **Line:** 4718
- **Auth:** None
- **Body:** `{ items: Array<{ id: number, sortOrder: number }> }`
- **Response 200:** `{ success: true }`
- **Response 400:** `{ error }`
- **DB writes:** `classes` (batch UPDATE)

---

## 17. Admin - Instructors

### `GET /api/admin/instructors`
- **Line:** 4970
- **Auth:** None
- **Response 200:** `{ instructors: InstructorWithUser[] }`
- **DB reads:** `instructors`, `users`

### `POST /api/admin/instructors`
- **Line:** 4982
- **Auth:** None
- **Body:** `{ name: string, email: string, phone: string, classInMethod?: string, profileImage?: string }`
- **Response 200:** `{ success: true, instructor, classInError? }`
- **Response 400:** `{ error }` (missing fields or duplicate email)
- **DB reads:** `users`
- **DB writes:** `users` (INSERT), `instructors` (INSERT)
- **External API:** ClassIn registration (if configured)

### `PUT /api/admin/instructors/:id`
- **Line:** 5048
- **Auth:** None
- **Body:** `{ name?, email?, phone: string (required), profileImage?, classInMethod? }`
- **Response 200:** `{ success: true, message }`
- **Response 400/404:** `{ error }`
- **DB reads:** `instructors`, `users`
- **DB writes:** `instructors` (UPDATE), `users` (UPDATE)

### `DELETE /api/admin/instructors/:id`
- **Line:** 5115
- **Auth:** None
- **Response 200:** `{ success: true, message }`
- **Response 400:** `{ error }` (has classes)
- **Response 404:** `{ error }`
- **DB reads:** `instructors`, `users`, `classes`
- **DB writes:** `classin_virtual_accounts` (UPDATE if had virtual account), `instructors` (DELETE), `users` (DELETE)

### `POST /api/admin/instructors/register-classin`
- **Line:** 4785
- **Auth:** None
- **Body:** `{ instructorId: number, phoneNumber: string }` (phone or email)
- **Response 200:** `{ success: true, message, classInUid?, instructor }`
- **Response 400/404/500:** `{ error }`
- **DB reads:** `instructors`, `users`
- **DB writes:** `instructors` (UPDATE)
- **External API:** ClassIn registration

### `POST /api/admin/instructors/re-register-classin`
- **Line:** 4840
- **Auth:** None
- **Body:** `{ instructorId: number, classInUid: string, phoneNumber: string }`
- **Response 200:** `{ success: true, message, classInUid }`
- **Response 400/404/500:** `{ error }`
- **DB reads:** `instructors`, `users`
- **DB writes:** `instructors` (UPDATE), `users` (UPDATE phone)
- **External API:** ClassIn `register`, `addTeacher`

---

## 18. Admin - Users

### `GET /api/admin/users`
- **Line:** 5162
- **Auth:** None
- **Query params:** `search` (optional), `limit` (default 50), `offset` (default 0)
- **Response 200:** `{ users, total, stats: { total, students, instructors, admins, testAccounts } }`
- **DB reads:** `users`

### `GET /api/admin/users/:id`
- **Line:** 5217
- **Auth:** None
- **Response 200:** `{ user }`
- **Response 404:** `{ error }`
- **DB reads:** `users`

### `PUT /api/admin/users/:id`
- **Line:** 5232
- **Auth:** None
- **Body:** `{ name?, phone?, role?, is_test_account? }`
- **Response 200:** `{ success: true, message }`
- **Response 404:** `{ error }`
- **DB reads:** `users`
- **DB writes:** `users` (UPDATE)

### `DELETE /api/admin/users/:id`
- **Line:** 5255
- **Auth:** None
- **Response 200:** `{ success: true, message }`
- **Response 404:** `{ error }`
- **DB reads:** `users`
- **DB writes:** `instructors` (DELETE if instructor), `enrollments`, `wishlist`, `cart`, `orders`, `users` (all DELETE)

---

## 19. Admin - Enrollments

### `GET /api/admin/classes/:classId/enrollments`
- **Line:** 5283
- **Auth:** None
- **Response 200:** `{ enrollments: EnrollmentWithUser[] }`
- **DB reads:** `enrollments`, `users`

### `GET /api/admin/enrollments`
- **Line:** 5298
- **Auth:** None
- **Query params:** `classId` (optional), `status` (optional), `limit` (default 50), `offset` (default 0)
- **Response 200:** `{ enrollments: EnrollmentWithUserAndClass[] }`
- **DB reads:** `enrollments`, `users`, `classes`

### `PUT /api/admin/enrollments/:id/status`
- **Line:** 5333
- **Auth:** None
- **Body:** `{ status: "active"|"ended"|"expired" }`
- **Response 200:** `{ success: true, message }`
- **Response 400/404:** `{ error }`
- **DB reads:** `enrollments`
- **DB writes:** `enrollments` (UPDATE), `classin_virtual_accounts` (returns account on end)

### `DELETE /api/admin/enrollments/:id`
- **Line:** 5359
- **Auth:** None
- **Response 200:** `{ success: true, message }`
- **Response 404:** `{ error }`
- **DB reads:** `enrollments`
- **DB writes:** `enrollments` (DELETE), `classin_virtual_accounts`, `classes` (UPDATE), `classin_sessions` (UPDATE)

### `POST /api/admin/enrollments/:enrollmentId/end`
- **Line:** 2891
- **Auth:** Admin Key (`adminKey` in body)
- **Body:** `{ adminKey: string }`
- **Response 200:** `{ success: true, message, virtualAccountReturned }`
- **Response 403/404:** `{ error }`
- **DB reads:** `enrollments`
- **DB writes:** `enrollments` (UPDATE), `classin_virtual_accounts`

### `POST /api/admin/enrollments/process-expired`
- **Line:** 2920
- **Auth:** Admin Key
- **Body:** `{ adminKey: string }`
- **Response 200:** `{ success: true, message, processedCount, returnedCount }`
- **DB reads:** `enrollments`
- **DB writes:** `enrollments` (UPDATE), `classin_virtual_accounts`

---

## 20. Admin - Orders

### `GET /api/admin/orders`
- **Line:** 6639
- **Auth:** Admin Session (cookie)
- **Response 200:** `{ orders: OrderWithUserAndClass[] }`
- **Response 403:** `{ error }`
- **DB reads:** `orders`, `users`, `classes`

### `POST /api/admin/orders/:orderId/update`
- **Line:** 6659
- **Auth:** Admin Session (cookie)
- **Body:** `{ status: string, trdNo?: string }`
- **Response 200:** `{ success: true }`
- **Response 403:** `{ error }`
- **DB writes:** `orders` (UPDATE)

### `POST /api/admin/orders/:orderId/cancel`
- **Line:** 6787
- **Auth:** Admin Session (cookie)
- **Body:** `{ reason?: string }`
- **Response 200:** `{ success: true, message, pgError? }`
- **Response 403/404:** `{ error }`
- **DB reads:** `orders`
- **DB writes:** `orders` (UPDATE), `enrollments` (UPDATE), `classes` (UPDATE), `lesson_enrollments` (DELETE)
- **External API:** HectoFinancial cancel API (if applicable)

---

## 21. Admin - Debug

### `POST /api/admin/debug/classin-course`
- **Line:** 3036
- **Auth:** None
- **Body:** `{ courseName?: string, teacherUid: string }`
- **Response 200:** `{ config, courseName, teacherUid, result }`
- **External API:** ClassIn `createCourse`

### `POST /api/admin/debug/classin-session`
- **Line:** 3057
- **Auth:** None
- **Body:** `{ classId, userId, enrollmentId, runSession?: boolean }`
- **Response 200:** Debug info with optional session creation result
- **DB reads:** `classes`, `instructors`, `enrollments`

### `POST /api/admin/debug/lms-classroom`
- **Line:** 3171
- **Auth:** None
- **Body:** `{ courseId, name, teacherUid, startTime, endTime, recordState?, liveState? }`
- **Response 200/400/500:** LMS API call result
- **External API:** ClassIn LMS `createClass`

### `POST /api/admin/debug/webcast-url`
- **Line:** 3216
- **Auth:** None
- **Body:** `{ courseId: number, classId?: number }`
- **Response 200/400/500:** Webcast URL result
- **External API:** ClassIn `getWebcastUrl`

### `POST /api/admin/debug/login-linked`
- **Line:** 3242
- **Auth:** None
- **Body:** `{ uid, courseId, classId, deviceType? }`
- **Response 200/400/500:** Login URL result with debug info
- **External API:** ClassIn `addCourseTeacher`, `getLoginLinked`

---

## 22. Reviews

### `POST /api/reviews`
- **Line:** 6284
- **Auth:** None
- **Body:** `{ classId: number, userId: number, rating: number, content: string }`
- **Response 200:** `{ success: true }`
- **DB writes:** `reviews` (INSERT), `classes` (UPDATE rating/review_count)
- **DB reads:** `reviews`

---

## 23. Webhooks

### `POST /api/webhooks/cloudflare-stream`
- **Line:** 3726
- **Auth:** None
- **Body:** Cloudflare Stream webhook event JSON
- **Response 200:** `{ received: true }`
- **Response 500:** `{ error }`
- **DB writes:** `class_lessons` (UPDATE duration/status on `video.ready`)

---

## 24. File Upload / Serve

### `POST /api/admin/upload-image`
- **Line:** 10812
- **Auth:** Admin Session (cookie)
- **Body:** FormData with `image` (File)
- **Response 200:** `{ success: true, url, filename }`
- **Response 400:** `{ error }` (missing file, invalid type, too large)
- **Response 401:** `{ error: "로그인이 필요합니다." }`
- **Storage:** R2 `IMAGES` bucket (`thumbnails/` prefix)

### `GET /api/images/*`
- **Line:** 10864
- **Auth:** None
- **Response 200:** Image binary with `Content-Type` and `Cache-Control: public, max-age=31536000`
- **Response 404:** `{ error: "Image not found" }`
- **Storage:** R2 `IMAGES` bucket

### `POST /api/admin/upload-material`
- **Line:** 10886
- **Auth:** Admin Session (cookie)
- **Body:** FormData with `file` (File)
- **Response 200:** `{ success: true, url, filename }`
- **Response 400:** `{ error }` (missing file, invalid type, >50MB)
- **Response 401:** `{ error }`
- **Storage:** R2 `IMAGES` bucket (`materials/` prefix)

### `GET /api/materials/*`
- **Line:** 10932
- **Auth:** None
- **Response 200:** File binary with `Content-Type` and `Cache-Control`
- **Response 404:** `{ error: "File not found" }`
- **Storage:** R2 `IMAGES` bucket

---

## 25. HTML Pages (Student-facing)

### `GET /api/admin/test-codes/create` and `GET /api/admin/test-codes`
- **Lines:** 2861, 2883
- **Auth:** Admin Key (body `adminKey`) for create; None for list
- **See Section 9 for test code details**

### Admin Test Codes

#### `POST /api/admin/test-codes/create`
- **Line:** 2861
- **Auth:** Admin Key
- **Body:** `{ code?, description?, maxUses?, expiresAt?, adminKey: string }`
- **Response 200:** `{ success: true, code }`
- **DB writes:** `test_access_codes` (INSERT)

#### `GET /api/admin/test-codes`
- **Line:** 2883
- **Auth:** None
- **Response 200:** `TestAccessCode[]`
- **DB reads:** `test_access_codes`

### Admin Virtual Accounts

#### `POST /api/admin/virtual-accounts/init`
- **Line:** 2954
- **Auth:** Admin Key
- **Body:** `{ startUid, endUid, sid, expiresAt?, adminKey }`
- **Response 200:** `{ success: true, message, total, inserted, skipped }`
- **DB writes:** `classin_virtual_accounts` (batch INSERT)

#### `GET /api/admin/virtual-accounts`
- **Line:** 3003
- **Auth:** None
- **Query params:** `status` (optional), `limit` (default 50), `offset` (default 0)
- **Response 200:** `{ accounts, stats: { total, available, assigned, expired, registered } }`
- **DB reads:** `classin_virtual_accounts`

---

### Student-Facing HTML Pages

| Route | Line | Auth | Description |
|-------|------|------|-------------|
| `GET /` | 8430 | None | Homepage with featured/new/live courses |
| `GET /categories` | 8697 | None | Category listing page |
| `GET /class/:slug` | 8838 | None | Course detail page |
| `GET /mypage` | 9649 | None | Student my-page (enrollments, orders) |
| `GET /instructor/mypage` | 9775 | None | Instructor dashboard page |
| `GET /watch/:lessonId` | 10066 | None | Recorded lesson player page |
| `GET /classroom/:sessionId` | 10273 | None | Live classroom entry page |

---

## 26. HTML Pages (Admin)

| Route | Line | Auth | Description |
|-------|------|------|-------------|
| `GET /admin/login` | 10640 | None | Admin login form |
| `GET /admin/logout` | 10754 | None | Clears session, redirects to login |
| `GET /admin` | 10960 | Admin Session | Main admin dashboard (virtual account management) |
| `GET /admin/orders` | 13340 | Admin Session | Order management page |
| `GET /admin/users` | 13506 | Admin Session | User management page |
| `GET /admin/enrollments` | 13741 | Admin Session | Enrollment management page |
| `GET /admin/homepage` | 14101 | Admin Session | Homepage section management |

---

## DB Tables Referenced

| Table | Read by | Written by |
|-------|---------|------------|
| `users` | Auth, User data, Admin, Enrollments, Reviews, Payments | Auth register, Admin users, Payments, Virtual accounts, Test accounts |
| `classes` | Public, Admin, Payments, Enrollments | Admin CRUD, Payments (student count), Lessons |
| `categories` | Public, Admin | - |
| `instructors` | Public, Admin, Lessons, ClassIn | Admin instructors, Virtual accounts |
| `enrollments` | User data, Admin, Payments, ClassIn | Payments, Test enroll, Admin enrollments |
| `class_lessons` | User data, Admin, Stream, ClassIn | Admin lessons, Instructor lessons, Stream webhook |
| `lesson_enrollments` | User data | Payments, Test enroll, Admin cancel |
| `lessons` | Class detail | Admin delete class (cascade) |
| `reviews` | Public, Class detail | Reviews POST |
| `orders` | User data, Admin, Payments | Payments (all types), Admin cancel |
| `cart` | User data | Cart CRUD, Payments (DELETE on purchase) |
| `wishlist` | User data | Wishlist CRUD |
| `classin_sessions` | User data, ClassIn entry | Payments, Test enroll, ClassIn enter |
| `classin_virtual_accounts` | ClassIn, Virtual accounts, Admin | Virtual accounts, Enrollments, Instructor registration |
| `subscriptions` | User data | Subscription create/cancel/reactivate/renew |
| `subscription_payments` | Subscription payments | Subscription create/renew |
| `test_access_codes` | Test account activate | Test account activate, Admin create |
| `admin_settings` | Admin login, Change password | Change password |
| `admin_sessions` | All admin session checks | Admin login/logout |
| `chunked_uploads` | Stream chunked upload | Stream chunked upload |

---

## Security Observations

1. **No password verification on login** (line 1823): The login endpoint checks if the email exists but never compares the password hash.
2. **JWT with `alg: none`** (lines 1829, 1855): Tokens are base64-encoded with no signature, making them trivially forgeable.
3. **Most admin API endpoints lack authentication**: Endpoints under `/api/admin/classes`, `/api/admin/instructors`, `/api/admin/users`, `/api/admin/enrollments`, `/api/admin/virtual-accounts`, `/api/admin/stream`, and `/api/admin/debug` do NOT check admin session. Only `/api/admin/orders`, `/api/admin/orders/:id/update`, `/api/admin/orders/:id/cancel`, `/api/admin/upload-image`, `/api/admin/upload-material`, and `/api/admin/change-password` check the admin session cookie.
4. **Some admin endpoints use `adminKey`** (hardcoded `classin-admin-2024`): `/api/admin/enrollments/:id/end`, `/api/admin/enrollments/process-expired`, `/api/admin/virtual-accounts/init`, `/api/admin/test-codes/create`.
5. **All user data endpoints trust userId from client**: No server-side verification that the requesting user matches the userId parameter.
6. **Stream upload endpoints have no auth**: `/api/admin/stream/*` endpoints are publicly accessible despite the `/admin/` path prefix.

---

## External API Dependencies

| Service | Base URL | Used By |
|---------|----------|---------|
| **ClassIn (EEO.cn)** | `https://api.eeo.cn` | Course/lesson creation, student/teacher registration, login URL generation, webcast replay |
| **HectoFinancial PG** | Configured via `HECTO_PAYMENT_SERVER` / `HECTO_CANCEL_SERVER` | Card payment processing and cancellation |
| **Cloudflare Stream** | `https://api.cloudflare.com/client/v4/accounts/{id}/stream` | Video upload, status check, signed URL generation |

---

*End of audit. This document covers all 119 endpoints found in `src/index.tsx`.*
