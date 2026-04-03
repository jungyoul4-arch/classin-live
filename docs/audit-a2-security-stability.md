# Security & Stability Audit Report

**Project:** ClassIn Live  
**File:** `src/index.tsx` (~14,508 lines)  
**Date:** 2026-04-03  
**Auditor:** Claude Opus 4.6 (automated)  
**Scope:** READ-ONLY analysis of authentication, authorization, injection, XSS, CSRF, data exposure, input validation, CORS, error handling, race conditions, null safety, and async error handling.

---

## SECURITY FINDINGS

---

### S-01. Unsigned JWT Tokens (alg: "none") — CRITICAL

**Lines:** 1828-1831, 1854-1857, 7230-7234, 10184-10188

The application generates JWT tokens with `alg: "none"` and an empty signature:

```typescript
const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
const payload = btoa(JSON.stringify({ sub: user.id, email: user.email, role: user.role || 'user', exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }))
const token = `${header}.${payload}.`
```

**Impact:** Any user can forge a valid token by base64-encoding any payload with any `sub` (user ID) and `role` (including `"admin"` or `"instructor"`). There is zero cryptographic verification. This completely bypasses all user-level authorization.

**Affected endpoints:** Every endpoint that reads the Bearer token (lines 3831-3844, 10178-10188, etc.) trusts the self-declared claims without verification.

---

### S-02. No Password Verification on Login — CRITICAL

**Lines:** 1823-1833

The login endpoint fetches the user by email but **never compares the provided password** against the stored `password_hash`:

```typescript
app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  const user = await c.env.DB.prepare('SELECT id, email, name, ... FROM users WHERE email = ?').bind(email).first()
  if (!user) return c.json({ error: '...' }, 401)
  // password is NEVER checked
  const token = `${header}.${payload}.`
  return c.json({ user, token })
})
```

**Impact:** Anyone who knows a user's email can log in as that user. Combined with S-01 (unsigned JWT), even knowing the email is optional since tokens can be forged.

---

### S-03. Plaintext Password Storage — CRITICAL

**Line:** 1850

User passwords are stored as `hash_${password}` (literal string prefix, no actual hashing):

```typescript
'INSERT INTO users ... VALUES (?, ?, ?, ?, ?)').bind(email, `hash_${password}`, name, ...)
```

**Impact:** If the database is compromised, all user passwords are immediately readable.

---

### S-04. Weak Admin Password Hashing — HIGH

**Lines:** 10599-10607

The `simpleHash` function used for admin password storage is a trivial DJB-style hash with ~32 bits of entropy:

```typescript
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(16)
}
```

**Impact:** Admin passwords can be brute-forced trivially. The same hash function is used in `generateSafeKey` fallback (line 562-567).

---

### S-05. Admin API Endpoints Without Authentication — CRITICAL

The following `/api/admin/*` endpoints have **NO authentication check** (no `checkAdminSession`, no `adminKey`, nothing):

| Lines | Endpoint | Action |
|-------|----------|--------|
| 3036 | `POST /api/admin/debug/classin-course` | Creates ClassIn courses |
| 3057 | `POST /api/admin/debug/classin-session` | Creates ClassIn sessions |
| 3171 | `POST /api/admin/debug/lms-classroom` | Creates LMS classrooms |
| 3216 | `POST /api/admin/debug/webcast-url` | Gets webcast URLs |
| 3242 | `POST /api/admin/debug/login-linked` | Gets login URLs |
| 3276 | `POST /api/admin/stream/upload-url` | Gets Stream upload URLs |
| 3304 | `POST /api/admin/stream/tus-upload-url` | Gets TUS upload URLs |
| 3361 | `POST /api/admin/stream/init-chunked-upload` | Inits chunked uploads |
| 3384 | `POST /api/admin/stream/upload-chunk` | Uploads video chunks |
| 3427 | `POST /api/admin/stream/complete-chunked-upload` | Completes uploads |
| 3566 | `POST /api/admin/classes/:classId/create-recorded-lesson` | Creates lessons |
| 3656 | `POST /api/admin/stream/fix-video/:videoUid` | Modifies videos |
| 3700 | `GET /api/admin/stream/info/:videoUid` | Gets video info |
| 3967 | `POST /api/admin/classes/:classId/create-session` | Creates sessions |
| 4102 | `POST /api/admin/classes/:classId/create-sessions` | Bulk creates sessions |
| 4318 | `GET /api/admin/classes/:classId/lessons` | Lists lessons |
| 4377 | `PATCH /api/admin/lessons/:lessonId` | Updates lessons |
| 4403 | `DELETE /api/admin/lessons/:lessonId` | Deletes lessons |
| 4519 | `GET /api/admin/classes` | Lists all classes |
| 4537 | `POST /api/admin/classes` | Creates classes |
| 4572 | `PUT /api/admin/classes/:id` | Updates classes |
| 4615 | `DELETE /api/admin/classes/:id` | Deletes classes |
| 4651 | `GET /api/admin/homepage/sections` | Gets homepage config |
| 4693 | `PUT /api/admin/classes/:id/homepage-flags` | Updates homepage |
| 4718 | `PUT /api/admin/homepage/reorder` | Reorders homepage |
| 4735 | `GET /api/admin/categories` | Lists categories |
| 4741 | `GET /api/admin/classes/:classId/session` | Gets session info |
| 4785 | `POST /api/admin/instructors/register-classin` | Registers instructors |
| 4840 | `POST /api/admin/instructors/re-register-classin` | Re-registers instructors |
| 4970 | `GET /api/admin/instructors` | Lists all instructors |
| 4982 | `POST /api/admin/instructors` | Creates instructors |
| 5048 | `PUT /api/admin/instructors/:id` | Updates instructors |
| 5115 | `DELETE /api/admin/instructors/:id` | Deletes instructors |
| 5162 | `GET /api/admin/users` | Lists all users |
| 5217 | `GET /api/admin/users/:id` | Gets user details |
| 5232 | `PUT /api/admin/users/:id` | Updates users |
| 5255 | `DELETE /api/admin/users/:id` | Deletes users + all data |
| 5283 | `GET /api/admin/classes/:classId/enrollments` | Lists enrollments |
| 5298 | `GET /api/admin/enrollments` | Lists all enrollments |
| 5333 | `PUT /api/admin/enrollments/:id/status` | Updates enrollment status |
| 5359 | `DELETE /api/admin/enrollments/:id` | Deletes enrollments |
| 2883 | `GET /api/admin/test-codes` | Lists test codes |

**Impact:** Anyone on the internet can create/delete classes, users, instructors, enrollments, upload videos, and fully administer the platform. Only a few admin endpoints use the `adminKey` check or session check (lines 6640, 6660, 6788, 10772, 10812, 10887).

---

### S-06. Hardcoded Admin Key — HIGH

**Lines:** 2864, 2895, 2923, 2958

Some admin endpoints use a hardcoded `adminKey`:

```typescript
if (adminKey !== 'classin-admin-2024') {
  return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
}
```

**Impact:** This key is embedded in the source code and provides no real security. It's also inconsistent -- most admin endpoints don't check it at all (see S-05).

---

### S-07. Insecure Session Token Generation — MEDIUM

**Lines:** 10611-10617

Session tokens are generated using `Math.random()`, which is not cryptographically secure:

```typescript
function generateSessionToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return token
}
```

**Impact:** Session tokens are predictable in theory. Should use `crypto.getRandomValues()`.

---

### S-08. Missing `Secure` Flag on Admin Session Cookie — MEDIUM

**Line:** 10748

```typescript
'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
```

The cookie lacks the `Secure` flag. If the site is ever accessed over HTTP, the session cookie will be transmitted in cleartext.

---

### S-09. XSS in Payment Result Page — HIGH

**Lines:** 6516-6524

Payment result parameters from Hecto PG are injected directly into HTML without escaping:

```typescript
<p>${decryptedParams.outRsltMsg || ''}</p>
<p>주문번호: ${decryptedParams.mchtTrdNo || ''}</p>
```

And critically, the full decrypted params object is embedded as JavaScript:

```typescript
var _PAY_RESULT = ${JSON.stringify(decryptedParams)};
```

**Impact:** If the PG returns a crafted `outRsltMsg` containing `</script><script>...`, it would execute arbitrary JavaScript. The `postMessage` with `'*'` origin (line 6527) further enables cross-origin data leakage.

---

### S-10. XSS via innerHTML in Client-Side JavaScript — MEDIUM

**Lines:** 7243, 7253, 7337, 7415-7469, 7746, 7873 (and many more)

The application extensively uses `.innerHTML` with template literals that include user-controlled data:

```javascript
container.innerHTML = items.map(item => `
  <div class="..."><p class="...">${item.title}</p>...
```

User-supplied values like `item.title`, `currentUser.name`, etc. are inserted without HTML escaping.

**Impact:** Stored XSS if any class title, user name, or instructor name contains HTML/script tags.

---

### S-11. No CSRF Protection — HIGH

There is no CSRF token mechanism anywhere in the application. The admin panel uses `SameSite=Strict` cookies (line 10748), which provides some protection for the admin session. However:

- All user-facing POST endpoints (`/api/payment/process`, `/api/reviews`, `/api/cart`, `/api/wishlist`, `/api/subscription/create`, etc.) accept plain JSON with no CSRF verification.
- The unsigned JWT (S-01) is stored in `localStorage` and sent as a Bearer header, which is immune to CSRF by default -- but the token itself is forgeable.

**Impact:** State-changing operations on user accounts can be triggered by malicious third-party sites.

---

### S-12. CORS Wildcard on All API Routes — HIGH

**Line:** 52

```typescript
app.use('/api/*', cors())
```

The default `cors()` middleware with no configuration allows requests from **any origin** with credentials.

**Impact:** Any website can make authenticated API calls to the backend if the user has a valid session/token.

---

### S-13. Sensitive Data Exposure in Test Hash Endpoint — MEDIUM

**Lines:** 6306-6354

The `/api/payment/hecto/test-hash` endpoint (publicly accessible, no auth) exposes:
- The merchant ID (`MID`)
- A partial license key and AES key
- Internal hash computation details

```typescript
key: config.AES_KEY.slice(0, 8) + '...'
licenseKey: config.LICENSE_KEY.slice(0, 8) + '...'
```

While truncated, this leaks information about payment credentials to anyone.

---

### S-14. Fallback PG Credentials in Source — MEDIUM

**Lines:** 6308-6310

Hardcoded fallback values for PG credentials:

```typescript
MID: c.env.HECTO_MID || 'nxca_jt_il',
LICENSE_KEY: c.env.HECTO_LICENSE_KEY || 'ST1009281328226982205',
AES_KEY: c.env.HECTO_AES_KEY || 'pgSettle30y739r82jtd709yOfZ2yK5K'
```

**Impact:** These appear to be test credentials but are embedded in source code and could be misused.

---

### S-15. IDOR on User Endpoints — HIGH

**Lines:** 1889, 1934, 1976, 2038, 2323, 2354, 2556, 5524, 5544, 6157, 6172

All user-specific endpoints accept `userId` as a URL parameter with no verification that the authenticated user matches:

```typescript
app.get('/api/user/:userId/enrollments', async (c) => {
  const userId = c.req.param('userId')
  // No auth check - anyone can view any user's enrollments
```

Similarly: `/api/user/:userId/cart`, `/api/user/:userId/wishlist`, `/api/user/:userId/orders`, `/api/user/:userId/classin-account`, `/api/user/:userId/classin-sessions`, `/api/user/:userId/subscriptions`.

**Impact:** Any user can view/modify any other user's enrollments, orders, cart, wishlist, and ClassIn account details.

---

### S-16. Instructor Endpoints Trust Client-Supplied userId — HIGH

**Lines:** 2106, 4461

```typescript
app.post('/api/instructor/classes/:classId/create-sessions', async (c) => {
  const { lessons, userId } = await c.req.json()
  // userId comes from the request body, not from a verified token
```

The instructor role check relies on the client-supplied `userId` from the request body, not from a verified auth token.

**Impact:** Combined with S-01 (unsigned JWT), any user can impersonate any instructor.

---

### S-17. Payment Processing Without Proper Amount Validation — HIGH

**Lines:** 2385-2395

The `/api/payment/process` endpoint accepts `amount` from the client and creates an order without verifying it matches the actual class/lesson price:

```typescript
const { userId, classId, lessonId, paymentMethod, cardNumber, ..., amount, ... } = await c.req.json()
// amount is used directly, never verified against the class price
```

**Impact:** Users can pay 0 or any amount and still get enrolled.

---

### S-18. Hardcoded Test Code in Source — LOW

**Line:** 1841

```typescript
const VALID_TEST_CODE = 'CLASSIN-TEST-2024'
```

**Impact:** Anyone reading the source (or this audit) can use the test code to get 30 days of free access.

---

### S-19. SQL Injection Risk in Dynamic Query Construction — LOW

**Line:** 4396

```typescript
await c.env.DB.prepare(`UPDATE class_lessons SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run()
```

The column names come from internal logic (not user input directly), so this is LOW risk. However, the pattern of building SQL strings dynamically is error-prone. All other queries properly use parameterized bindings.

---

### S-20. postMessage with Wildcard Origin — MEDIUM

**Line:** 6527

```typescript
window.opener.postMessage({ type: 'HECTO_PAYMENT_RESULT', data: _PAY_RESULT }, '*');
```

**Impact:** Payment result data (including transaction details) is broadcast to any listening window regardless of origin.

---

## STABILITY FINDINGS

---

### T-01. Race Condition on current_students Counter — MEDIUM

**Lines:** 2498, 2800, 6132, 6617, 6712

```typescript
await c.env.DB.prepare('UPDATE classes SET current_students = current_students + 1 WHERE id = ?').bind(classId).run()
```

Multiple concurrent enrollments can lead to incorrect student counts. D1 provides serialized writes per database, so this is partially mitigated, but concurrent requests across Workers instances could still race.

---

### T-02. Missing Error Handling on Multiple Sequential DB Operations — MEDIUM

**Lines:** 5263-5273 (user deletion), 2907-2910 (enrollment end), 6093-6131 (subscription creation)

Multiple `await db.prepare(...).run()` calls execute sequentially without a transaction. If one fails midway, the data is left in an inconsistent state.

Example (user deletion):
```typescript
await c.env.DB.prepare('DELETE FROM instructors WHERE user_id = ?').bind(userId).run()
await c.env.DB.prepare('DELETE FROM enrollments WHERE user_id = ?').bind(userId).run()
// If this fails, instructors are deleted but enrollments remain
await c.env.DB.prepare('DELETE FROM wishlist WHERE user_id = ?').bind(userId).run()
```

---

### T-03. Unhandled NaN from parseInt — LOW

**Lines:** 2105, 2892, 3567, 3830, 4378, 4405, 4460, 4573, 4616, 4694, 4742, 5049, 5256, 5284, etc.

`parseInt(c.req.param('...'))` can return `NaN` if the parameter is not a number. NaN is then bound to D1 queries, which may produce unexpected results rather than errors.

---

### T-04. Missing Null Checks on DB Results — MEDIUM

**Lines:** 2403-2405, 6082, 6285-6289

```typescript
const lessonInfo = await c.env.DB.prepare('SELECT * FROM class_lessons WHERE id = ?').bind(lessonId).first() as any
const userName = user?.name || 'Student'  // user could be null but lessonInfo is used without check below
```

At line 6285, reviews are inserted and then the class rating is updated, but there's no check that the class exists. At line 6082 in subscription creation, `cardNumber` could be null leading to a `.replace()` on undefined.

---

### T-05. Raw Error Messages Exposed to Users — MEDIUM

**Lines:** 2878, 3335, 3695, 3721, 3753, 4454, 4965

Multiple endpoints return `e.message` directly in API responses:

```typescript
return c.json({ error: '코드 생성 실패: ' + e.message }, 500)
return c.json({ error: e.message }, 500)
```

**Impact:** Internal error details (including SQL errors, stack traces) may be leaked to end users, aiding attackers.

---

### T-06. No Request Size Limits — LOW

There are no explicit request body size limits configured. The chunked upload endpoint (line 3384) accepts arbitrary chunks. Cloudflare Workers has built-in limits (100MB for paid plans), but application-level validation is absent.

---

### T-07. No Rate Limiting — MEDIUM

There is no rate limiting on any endpoint. Critical endpoints vulnerable to abuse:
- `POST /api/auth/login` (brute force)
- `POST /api/auth/register` (mass account creation)
- `POST /api/payment/process` (payment abuse)
- `POST /api/reviews` (spam)
- All admin endpoints (already unprotected, see S-05)

---

### T-08. Sequential DB Operations in Loops — LOW

**Lines:** 2935-2943 (processing expired enrollments)

```typescript
for (const enrollment of expiredEnrollments) {
  const result = await returnVirtualAccountFromEnrollment(c.env.DB, enrollment.id)
  await c.env.DB.prepare(`UPDATE enrollments SET status = 'expired' ...`).bind(enrollment.id).run()
}
```

Processing many expired enrollments sequentially could hit Worker CPU time limits. Consider D1 batch operations.

---

## SUMMARY TABLE

| ID | Severity | Category | Summary |
|----|----------|----------|---------|
| S-01 | CRITICAL | Auth | JWT with alg:"none" -- tokens are forgeable |
| S-02 | CRITICAL | Auth | Login never verifies password |
| S-03 | CRITICAL | Auth | Passwords stored as plaintext with "hash_" prefix |
| S-05 | CRITICAL | AuthZ | 35+ admin API endpoints have zero auth checks |
| S-04 | HIGH | Auth | Admin password uses trivial 32-bit hash |
| S-06 | HIGH | Auth | Hardcoded admin key in source code |
| S-09 | HIGH | XSS | Unescaped PG response params injected into HTML |
| S-11 | HIGH | CSRF | No CSRF protection on any endpoint |
| S-12 | HIGH | CORS | Wildcard CORS on all /api/* routes |
| S-15 | HIGH | AuthZ | IDOR -- any user can access any user's data |
| S-16 | HIGH | AuthZ | Instructor userId from request body, not verified token |
| S-17 | HIGH | Payment | Payment amount accepted from client without verification |
| S-07 | MEDIUM | Auth | Session tokens use Math.random() |
| S-08 | MEDIUM | Auth | Missing Secure flag on admin cookie |
| S-10 | MEDIUM | XSS | Extensive innerHTML with unescaped user data |
| S-13 | MEDIUM | DataExp | Test hash endpoint leaks partial PG credentials |
| S-14 | MEDIUM | DataExp | Fallback PG credentials hardcoded in source |
| S-20 | MEDIUM | DataExp | postMessage with wildcard origin leaks payment data |
| S-18 | LOW | Auth | Test access code hardcoded in source |
| S-19 | LOW | SQLi | Dynamic SQL column construction (low actual risk) |
| T-01 | MEDIUM | Race | current_students counter race condition |
| T-02 | MEDIUM | Stability | Multi-step DB ops without transactions |
| T-05 | MEDIUM | Stability | Raw error messages exposed to users |
| T-07 | MEDIUM | Stability | No rate limiting on any endpoint |
| T-04 | MEDIUM | Stability | Missing null checks on DB query results |
| T-03 | LOW | Stability | Unhandled NaN from parseInt |
| T-06 | LOW | Stability | No request body size validation |
| T-08 | LOW | Stability | Sequential DB ops in loops risk timeout |

---

## PRIORITY REMEDIATION ORDER

1. **Implement real JWT signing** (S-01) -- Use HS256 with a secret or RS256. This is the single most impactful fix.
2. **Add password verification to login** (S-02) -- Compare password hash on login.
3. **Hash passwords properly** (S-03) -- Use bcrypt or Argon2 (via a library compatible with Workers).
4. **Add admin auth middleware** (S-05) -- Create a middleware for `/api/admin/*` routes that checks `checkAdminSession()`.
5. **Fix CORS** (S-12) -- Restrict to known origins.
6. **Verify user identity on user endpoints** (S-15, S-16) -- Extract userId from the verified JWT, not from URL params or request body.
7. **Server-side payment amount validation** (S-17) -- Verify amount matches class/lesson price.
8. **Escape HTML output** (S-09, S-10) -- Use a proper HTML escaping utility.
9. **Add CSRF protection** (S-11) -- Use SameSite cookies or CSRF tokens.
10. **Add rate limiting** (T-07) -- Use Cloudflare's built-in rate limiting or implement in-app.
