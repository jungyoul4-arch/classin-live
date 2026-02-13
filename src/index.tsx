import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ==================== API Routes ====================

// Get all categories
app.get('/api/categories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM categories ORDER BY sort_order').all()
  return c.json(results)
})

// Get all classes with filters
app.get('/api/classes', async (c) => {
  const category = c.req.query('category')
  const search = c.req.query('search')
  const sort = c.req.query('sort') || 'popular'
  const level = c.req.query('level')
  const limit = parseInt(c.req.query('limit') || '20')
  const offset = parseInt(c.req.query('offset') || '0')

  let query = `SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name, cat.slug as category_slug
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    JOIN categories cat ON c.category_id = cat.id
    WHERE c.status = 'active'`
  const params: any[] = []

  if (category) {
    query += ` AND cat.slug = ?`
    params.push(category)
  }
  if (search) {
    query += ` AND (c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ?)`
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  if (level && level !== 'all') {
    query += ` AND c.level = ?`
    params.push(level)
  }

  if (sort === 'popular') query += ` ORDER BY c.current_students DESC`
  else if (sort === 'rating') query += ` ORDER BY c.rating DESC`
  else if (sort === 'newest') query += ` ORDER BY c.created_at DESC`
  else if (sort === 'price_low') query += ` ORDER BY c.price ASC`
  else if (sort === 'price_high') query += ` ORDER BY c.price DESC`

  query += ` LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const { results } = await c.env.DB.prepare(query).bind(...params).all()
  return c.json(results)
})

// Get featured/bestseller classes
app.get('/api/classes/featured', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name, cat.slug as category_slug
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    JOIN categories cat ON c.category_id = cat.id
    WHERE c.status = 'active' AND c.is_bestseller = 1
    ORDER BY c.rating DESC LIMIT 8
  `).all()
  return c.json(results)
})

// Get new classes
app.get('/api/classes/new', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name, cat.slug as category_slug
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    JOIN categories cat ON c.category_id = cat.id
    WHERE c.status = 'active' AND c.is_new = 1
    ORDER BY c.created_at DESC LIMIT 8
  `).all()
  return c.json(results)
})

// Get single class detail
app.get('/api/classes/:slug', async (c) => {
  const slug = c.req.param('slug')
  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.bio as instructor_bio, i.specialty as instructor_specialty, i.total_students as instructor_total_students, i.total_classes as instructor_total_classes, i.rating as instructor_rating, i.verified as instructor_verified, cat.name as category_name, cat.slug as category_slug
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    JOIN categories cat ON c.category_id = cat.id
    WHERE c.slug = ?
  `).bind(slug).first()
  if (!cls) return c.json({ error: 'Class not found' }, 404)

  const { results: lessons } = await c.env.DB.prepare(`SELECT * FROM lessons WHERE class_id = ? ORDER BY sort_order`).bind(cls.id).all()
  const { results: reviews } = await c.env.DB.prepare(`
    SELECT r.*, u.name as user_name, u.avatar as user_avatar
    FROM reviews r JOIN users u ON r.user_id = u.id
    WHERE r.class_id = ? ORDER BY r.created_at DESC LIMIT 10
  `).bind(cls.id).all()
  
  // Group lessons by chapter
  const chapters: Record<string, any[]> = {}
  for (const lesson of lessons) {
    const ch = (lesson as any).chapter_title || '기타'
    if (!chapters[ch]) chapters[ch] = []
    chapters[ch].push(lesson)
  }

  return c.json({ ...cls, curriculum: chapters, reviews })
})

// Get reviews for a class
app.get('/api/classes/:id/reviews', async (c) => {
  const id = c.req.param('id')
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, u.name as user_name, u.avatar as user_avatar
    FROM reviews r JOIN users u ON r.user_id = u.id
    WHERE r.class_id = ? ORDER BY r.created_at DESC
  `).bind(id).all()
  return c.json(results)
})

// Simple auth - login
app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  const user = await c.env.DB.prepare('SELECT id, email, name, avatar, role, subscription_plan, subscription_expires_at FROM users WHERE email = ?').bind(email).first()
  if (!user) return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401)
  // Simple password check for demo (in production, use proper hashing)
  return c.json({ user, token: `demo_token_${(user as any).id}` })
})

// Simple auth - register
app.post('/api/auth/register', async (c) => {
  const { email, password, name } = await c.req.json()
  try {
    const result = await c.env.DB.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').bind(email, `hash_${password}`, name).run()
    const user = await c.env.DB.prepare('SELECT id, email, name, avatar, role FROM users WHERE id = ?').bind(result.meta.last_row_id).first()
    return c.json({ user, token: `demo_token_${(user as any).id}` })
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: '이미 등록된 이메일입니다.' }, 400)
    return c.json({ error: '회원가입에 실패했습니다.' }, 500)
  }
})

// Get user enrollments
app.get('/api/user/:userId/enrollments', async (c) => {
  const userId = c.req.param('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT e.*, c.title, c.slug, c.thumbnail, c.total_lessons, i.display_name as instructor_name
    FROM enrollments e
    JOIN classes c ON e.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE e.user_id = ? ORDER BY e.enrolled_at DESC
  `).bind(userId).all()
  return c.json(results)
})

// Get user wishlist
app.get('/api/user/:userId/wishlist', async (c) => {
  const userId = c.req.param('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT w.*, c.title, c.slug, c.thumbnail, c.price, c.original_price, c.discount_percent, c.rating, c.review_count, i.display_name as instructor_name
    FROM wishlist w
    JOIN classes c ON w.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE w.user_id = ? ORDER BY w.created_at DESC
  `).bind(userId).all()
  return c.json(results)
})

// Add to wishlist
app.post('/api/wishlist', async (c) => {
  const { userId, classId } = await c.req.json()
  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO wishlist (user_id, class_id) VALUES (?, ?)').bind(userId, classId).run()
    return c.json({ success: true })
  } catch (e) {
    return c.json({ error: 'Failed' }, 500)
  }
})

// Remove from wishlist
app.delete('/api/wishlist', async (c) => {
  const { userId, classId } = await c.req.json()
  await c.env.DB.prepare('DELETE FROM wishlist WHERE user_id = ? AND class_id = ?').bind(userId, classId).run()
  return c.json({ success: true })
})

// Get cart
app.get('/api/user/:userId/cart', async (c) => {
  const userId = c.req.param('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT ct.*, c.title, c.slug, c.thumbnail, c.price, c.original_price, c.discount_percent, i.display_name as instructor_name
    FROM cart ct
    JOIN classes c ON ct.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE ct.user_id = ? ORDER BY ct.created_at DESC
  `).bind(userId).all()
  return c.json(results)
})

// Add to cart
app.post('/api/cart', async (c) => {
  const { userId, classId } = await c.req.json()
  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO cart (user_id, class_id) VALUES (?, ?)').bind(userId, classId).run()
    return c.json({ success: true })
  } catch (e) {
    return c.json({ error: 'Failed' }, 500)
  }
})

// Remove from cart
app.delete('/api/cart', async (c) => {
  const { userId, classId } = await c.req.json()
  await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ? AND class_id = ?').bind(userId, classId).run()
  return c.json({ success: true })
})

// Process payment (demo)
app.post('/api/payment/process', async (c) => {
  const { userId, classId, paymentMethod, cardNumber, cardExpiry, cardCvc, amount, orderType, subscriptionPlan } = await c.req.json()
  
  const last4 = cardNumber ? cardNumber.slice(-4) : '0000'
  const txId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  
  // Create order
  const orderResult = await c.env.DB.prepare(`
    INSERT INTO orders (user_id, order_type, class_id, subscription_plan, amount, payment_method, payment_status, card_last4, transaction_id)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
  `).bind(userId, orderType || 'class', classId || null, subscriptionPlan || null, amount, paymentMethod || 'card', last4, txId).run()

  // If class purchase, create enrollment
  if (classId) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO enrollments (user_id, class_id) VALUES (?, ?)').bind(userId, classId).run()
    // Remove from cart
    await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ? AND class_id = ?').bind(userId, classId).run()
    // Update student count
    await c.env.DB.prepare('UPDATE classes SET current_students = current_students + 1 WHERE id = ?').bind(classId).run()
  }

  // If subscription purchase
  if (orderType === 'subscription' && subscriptionPlan) {
    const months = subscriptionPlan === 'annual' ? 12 : 1
    await c.env.DB.prepare(`UPDATE users SET subscription_plan = ?, subscription_expires_at = datetime('now', '+' || ? || ' months') WHERE id = ?`).bind(subscriptionPlan, months, userId).run()
  }

  return c.json({ 
    success: true, 
    orderId: orderResult.meta.last_row_id,
    transactionId: txId,
    message: '결제가 완료되었습니다!'
  })
})

// Get user orders
app.get('/api/user/:userId/orders', async (c) => {
  const userId = c.req.param('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT o.*, c.title as class_title, c.thumbnail as class_thumbnail
    FROM orders o
    LEFT JOIN classes c ON o.class_id = c.id
    WHERE o.user_id = ? ORDER BY o.created_at DESC
  `).bind(userId).all()
  return c.json(results)
})

// Get instructor details
app.get('/api/instructors/:id', async (c) => {
  const id = c.req.param('id')
  const instructor = await c.env.DB.prepare(`
    SELECT i.*, u.email FROM instructors i JOIN users u ON i.user_id = u.id WHERE i.id = ?
  `).bind(id).all()
  const { results: classes } = await c.env.DB.prepare(`
    SELECT c.*, cat.name as category_name FROM classes c JOIN categories cat ON c.category_id = cat.id WHERE c.instructor_id = ? AND c.status = 'active'
  `).bind(id).all()
  return c.json({ instructor, classes })
})

// Post a review
app.post('/api/reviews', async (c) => {
  const { classId, userId, rating, content } = await c.req.json()
  await c.env.DB.prepare('INSERT INTO reviews (class_id, user_id, rating, content) VALUES (?, ?, ?, ?)').bind(classId, userId, rating, content).run()
  // Update class rating
  const stats = await c.env.DB.prepare('SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM reviews WHERE class_id = ?').bind(classId).first() as any
  await c.env.DB.prepare('UPDATE classes SET rating = ?, review_count = ? WHERE id = ?').bind(stats.avg_rating, stats.count, classId).run()
  return c.json({ success: true })
})

// ==================== HTML Pages ====================

const headHTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClassIn Live - 라이브 클래스 플랫폼</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            primary: { 50:'#fff1f2',100:'#ffe4e6',200:'#fecdd3',300:'#fda4af',400:'#fb7185',500:'#f43f5e',600:'#e11d48',700:'#be123c',800:'#9f1239',900:'#881337' },
            dark: { 50:'#f8fafc',100:'#f1f5f9',200:'#e2e8f0',300:'#cbd5e1',400:'#94a3b8',500:'#64748b',600:'#475569',700:'#334155',800:'#1e293b',900:'#0f172a' }
          }
        }
      }
    }
  </script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700;800&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
    .line-clamp-1 { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
    .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .scrollbar-hide::-webkit-scrollbar { display: none; }
    .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
    .hero-gradient { background: linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1a1a2e 100%); }
    .card-hover { transition: all 0.3s ease; }
    .card-hover:hover { transform: translateY(-4px); box-shadow: 0 12px 40px rgba(0,0,0,0.12); }
    .badge-live { animation: pulse-live 2s infinite; }
    @keyframes pulse-live { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
    .fade-in { animation: fadeIn 0.3s ease-in; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .modal-overlay { backdrop-filter: blur(4px); }
    .skeleton { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    input:focus, select:focus { outline: none; border-color: #f43f5e; box-shadow: 0 0 0 3px rgba(244,63,94,0.1); }
  </style>
</head>`

// Helper: navigation bar
const navHTML = `
<nav class="sticky top-0 z-50 bg-white border-b border-gray-100 shadow-sm">
  <div class="max-w-7xl mx-auto px-4 sm:px-6">
    <div class="flex items-center justify-between h-16">
      <!-- Logo -->
      <a href="/" class="flex items-center gap-2 cursor-pointer">
        <div class="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center">
          <i class="fas fa-play text-white text-sm"></i>
        </div>
        <span class="text-xl font-extrabold text-dark-900">Class<span class="text-primary-500">In</span></span>
        <span class="text-[10px] font-bold text-primary-500 bg-primary-50 px-1.5 py-0.5 rounded-full -ml-1">LIVE</span>
      </a>
      
      <!-- Search -->
      <div class="hidden md:flex flex-1 max-w-xl mx-8">
        <div class="relative w-full">
          <input type="text" id="searchInput" placeholder="배우고 싶은 것을 검색해보세요" 
            class="w-full h-10 pl-10 pr-4 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white transition-all">
          <i class="fas fa-search absolute left-3.5 top-3 text-gray-400 text-sm"></i>
        </div>
      </div>
      
      <!-- Nav Links -->
      <div class="flex items-center gap-1 sm:gap-2">
        <a href="/categories" class="hidden sm:flex items-center gap-1 px-3 py-2 text-sm font-medium text-dark-600 hover:text-primary-500 rounded-lg hover:bg-gray-50 transition-all">
          <i class="fas fa-th-large text-xs"></i>
          <span>카테고리</span>
        </a>
        <button onclick="toggleWishlist()" class="relative p-2 text-dark-500 hover:text-primary-500 rounded-lg hover:bg-gray-50 transition-all">
          <i class="far fa-heart text-lg"></i>
        </button>
        <button onclick="openCart()" class="relative p-2 text-dark-500 hover:text-primary-500 rounded-lg hover:bg-gray-50 transition-all">
          <i class="fas fa-shopping-cart text-lg"></i>
          <span id="cartBadge" class="hidden absolute -top-0.5 -right-0.5 w-4.5 h-4.5 bg-primary-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center min-w-[18px] h-[18px]">0</span>
        </button>
        <div id="authArea" class="flex items-center gap-2 ml-1">
          <button onclick="openAuthModal('login')" class="px-3.5 py-2 text-sm font-medium text-dark-600 hover:text-dark-900 rounded-lg hover:bg-gray-50 transition-all">로그인</button>
          <button onclick="openAuthModal('register')" class="px-4 py-2 text-sm font-semibold text-white bg-primary-500 hover:bg-primary-600 rounded-xl transition-all shadow-sm">회원가입</button>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Mobile Search -->
  <div class="md:hidden px-4 pb-3">
    <div class="relative">
      <input type="text" id="searchInputMobile" placeholder="검색" class="w-full h-9 pl-9 pr-4 bg-gray-50 border border-gray-200 rounded-lg text-sm">
      <i class="fas fa-search absolute left-3 top-2.5 text-gray-400 text-sm"></i>
    </div>
  </div>
</nav>`

const footerHTML = `
<footer class="bg-dark-900 text-gray-400 mt-20">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 py-12">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
      <div>
        <h3 class="text-white font-bold mb-4">ClassIn Live</h3>
        <ul class="space-y-2 text-sm">
          <li><a href="#" class="hover:text-white transition-colors">소개</a></li>
          <li><a href="#" class="hover:text-white transition-colors">채용</a></li>
          <li><a href="#" class="hover:text-white transition-colors">블로그</a></li>
          <li><a href="#" class="hover:text-white transition-colors">제휴 문의</a></li>
        </ul>
      </div>
      <div>
        <h3 class="text-white font-bold mb-4">고객센터</h3>
        <ul class="space-y-2 text-sm">
          <li><a href="#" class="hover:text-white transition-colors">자주 묻는 질문</a></li>
          <li><a href="#" class="hover:text-white transition-colors">1:1 문의</a></li>
          <li><a href="#" class="hover:text-white transition-colors">환불 안내</a></li>
          <li><a href="#" class="hover:text-white transition-colors">이용약관</a></li>
        </ul>
      </div>
      <div>
        <h3 class="text-white font-bold mb-4">크리에이터</h3>
        <ul class="space-y-2 text-sm">
          <li><a href="#" class="hover:text-white transition-colors">크리에이터 센터</a></li>
          <li><a href="#" class="hover:text-white transition-colors">클래스 개설</a></li>
          <li><a href="#" class="hover:text-white transition-colors">정산 안내</a></li>
          <li><a href="#" class="hover:text-white transition-colors">크리에이터 가이드</a></li>
        </ul>
      </div>
      <div>
        <h3 class="text-white font-bold mb-4">팔로우</h3>
        <div class="flex gap-3 mb-4">
          <a href="#" class="w-9 h-9 bg-dark-700 rounded-full flex items-center justify-center hover:bg-primary-500 transition-all"><i class="fab fa-instagram"></i></a>
          <a href="#" class="w-9 h-9 bg-dark-700 rounded-full flex items-center justify-center hover:bg-primary-500 transition-all"><i class="fab fa-youtube"></i></a>
          <a href="#" class="w-9 h-9 bg-dark-700 rounded-full flex items-center justify-center hover:bg-primary-500 transition-all"><i class="fab fa-twitter"></i></a>
        </div>
        <p class="text-xs text-gray-500">앱 다운로드</p>
        <div class="flex gap-2 mt-2">
          <div class="px-3 py-1.5 bg-dark-700 rounded-lg text-xs text-gray-300"><i class="fab fa-apple mr-1"></i>App Store</div>
          <div class="px-3 py-1.5 bg-dark-700 rounded-lg text-xs text-gray-300"><i class="fab fa-google-play mr-1"></i>Google Play</div>
        </div>
      </div>
    </div>
    <div class="border-t border-dark-700 pt-6 flex flex-col md:flex-row justify-between items-center gap-4">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 bg-primary-500 rounded flex items-center justify-center"><i class="fas fa-play text-white text-[8px]"></i></div>
        <span class="text-sm font-bold text-gray-300">ClassIn Live</span>
      </div>
      <p class="text-xs text-gray-500 text-center">&copy; 2026 ClassIn Live. All rights reserved. | 사업자등록번호: 000-00-00000 | 통신판매업 신고번호: 제2026-서울강남-0000호</p>
    </div>
  </div>
</footer>`

// Modals HTML
const modalsHTML = `
<!-- Auth Modal -->
<div id="authModal" class="fixed inset-0 z-[100] hidden">
  <div class="absolute inset-0 bg-black/50 modal-overlay" onclick="closeAuthModal()"></div>
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-2xl shadow-2xl p-8 fade-in">
    <button onclick="closeAuthModal()" class="absolute top-4 right-4 text-gray-400 hover:text-gray-600"><i class="fas fa-times text-xl"></i></button>
    <div id="loginForm">
      <div class="text-center mb-6">
        <div class="w-12 h-12 bg-primary-500 rounded-xl flex items-center justify-center mx-auto mb-3"><i class="fas fa-play text-white"></i></div>
        <h2 class="text-2xl font-bold text-dark-900">로그인</h2>
        <p class="text-sm text-gray-500 mt-1">ClassIn Live에 오신 것을 환영합니다</p>
      </div>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-dark-700 mb-1">이메일</label>
          <input type="email" id="loginEmail" placeholder="example@email.com" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-dark-700 mb-1">비밀번호</label>
          <input type="password" id="loginPassword" placeholder="비밀번호 입력" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm">
        </div>
        <button onclick="handleLogin()" class="w-full h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all">로그인</button>
        <div class="relative my-4"><div class="absolute inset-0 flex items-center"><div class="w-full border-t border-gray-200"></div></div><div class="relative flex justify-center text-xs"><span class="bg-white px-2 text-gray-400">또는</span></div></div>
        <div class="grid grid-cols-3 gap-3">
          <button class="h-11 border border-gray-200 rounded-xl flex items-center justify-center hover:bg-gray-50 transition-all"><img src="https://www.google.com/favicon.ico" class="w-5 h-5"></button>
          <button class="h-11 border border-gray-200 rounded-xl flex items-center justify-center hover:bg-gray-50 transition-all bg-[#FEE500]"><span class="font-bold text-[#3C1E1E] text-sm">K</span></button>
          <button class="h-11 border border-gray-200 rounded-xl flex items-center justify-center hover:bg-gray-50 transition-all bg-[#03C75A]"><span class="font-bold text-white text-sm">N</span></button>
        </div>
        <p class="text-center text-sm text-gray-500">계정이 없으신가요? <button onclick="switchAuth('register')" class="text-primary-500 font-semibold hover:underline">회원가입</button></p>
      </div>
      <p id="loginError" class="text-red-500 text-sm text-center mt-3 hidden"></p>
    </div>
    <div id="registerForm" class="hidden">
      <div class="text-center mb-6">
        <div class="w-12 h-12 bg-primary-500 rounded-xl flex items-center justify-center mx-auto mb-3"><i class="fas fa-play text-white"></i></div>
        <h2 class="text-2xl font-bold text-dark-900">회원가입</h2>
        <p class="text-sm text-gray-500 mt-1">지금 가입하고 무료 클래스를 체험하세요</p>
      </div>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-dark-700 mb-1">이름</label>
          <input type="text" id="regName" placeholder="이름 입력" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-dark-700 mb-1">이메일</label>
          <input type="email" id="regEmail" placeholder="example@email.com" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-dark-700 mb-1">비밀번호</label>
          <input type="password" id="regPassword" placeholder="8자 이상 입력" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm">
        </div>
        <label class="flex items-start gap-2 text-xs text-gray-500"><input type="checkbox" id="agreeTerms" class="mt-0.5 accent-primary-500"> <span>이용약관 및 개인정보처리방침에 동의합니다</span></label>
        <button onclick="handleRegister()" class="w-full h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all">가입하기</button>
        <p class="text-center text-sm text-gray-500">이미 계정이 있으신가요? <button onclick="switchAuth('login')" class="text-primary-500 font-semibold hover:underline">로그인</button></p>
      </div>
      <p id="regError" class="text-red-500 text-sm text-center mt-3 hidden"></p>
    </div>
  </div>
</div>

<!-- Payment Modal -->
<div id="paymentModal" class="fixed inset-0 z-[100] hidden">
  <div class="absolute inset-0 bg-black/50 modal-overlay" onclick="closePaymentModal()"></div>
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-white rounded-2xl shadow-2xl fade-in max-h-[90vh] overflow-y-auto">
    <div class="p-6 border-b border-gray-100">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-bold text-dark-900">결제하기</h2>
        <button onclick="closePaymentModal()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times text-xl"></i></button>
      </div>
    </div>
    <div class="p-6">
      <!-- Order Summary -->
      <div id="paymentOrderSummary" class="bg-gray-50 rounded-xl p-4 mb-6"></div>
      
      <!-- Payment Method -->
      <div class="mb-6">
        <h3 class="text-sm font-bold text-dark-800 mb-3">결제 수단</h3>
        <div class="grid grid-cols-3 gap-2 mb-4">
          <button onclick="selectPaymentMethod('card')" class="payment-method-btn active-payment h-11 border-2 border-primary-500 bg-primary-50 text-primary-600 rounded-xl text-sm font-medium transition-all" data-method="card">
            <i class="far fa-credit-card mr-1"></i>카드
          </button>
          <button onclick="selectPaymentMethod('kakao')" class="payment-method-btn h-11 border-2 border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:border-gray-300 transition-all" data-method="kakao">
            <span class="font-bold">K</span> 카카오페이
          </button>
          <button onclick="selectPaymentMethod('naver')" class="payment-method-btn h-11 border-2 border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:border-gray-300 transition-all" data-method="naver">
            <span class="font-bold text-green-500">N</span> 네이버
          </button>
        </div>
        
        <!-- Card Input -->
        <div id="cardInputArea" class="space-y-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">카드번호</label>
            <input type="text" id="cardNumber" placeholder="0000 0000 0000 0000" maxlength="19" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm" oninput="formatCardNumber(this)">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">유효기간</label>
              <input type="text" id="cardExpiry" placeholder="MM / YY" maxlength="7" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm" oninput="formatExpiry(this)">
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">CVC</label>
              <input type="password" id="cardCvc" placeholder="000" maxlength="3" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm">
            </div>
          </div>
        </div>
      </div>

      <!-- Coupon -->
      <div class="mb-6">
        <h3 class="text-sm font-bold text-dark-800 mb-3">쿠폰 / 할인코드</h3>
        <div class="flex gap-2">
          <input type="text" id="couponCode" placeholder="쿠폰 코드 입력" class="flex-1 h-10 px-4 border border-gray-200 rounded-xl text-sm">
          <button class="px-4 h-10 bg-gray-100 text-gray-600 text-sm font-medium rounded-xl hover:bg-gray-200 transition-all">적용</button>
        </div>
      </div>
      
      <!-- Price Summary -->
      <div id="priceSummary" class="border-t border-gray-100 pt-4 mb-6 space-y-2"></div>
      
      <!-- Agreement -->
      <label class="flex items-start gap-2 text-xs text-gray-500 mb-4">
        <input type="checkbox" id="paymentAgree" class="mt-0.5 accent-primary-500">
        <span>결제 진행에 동의합니다. 구매 조건 및 환불 규정을 확인했습니다.</span>
      </label>
      
      <!-- Pay Button -->
      <button id="payButton" onclick="processPayment()" class="w-full h-12 bg-primary-500 hover:bg-primary-600 disabled:bg-gray-300 text-white font-bold rounded-xl transition-all text-base">
        결제하기
      </button>
      <p id="paymentError" class="text-red-500 text-sm text-center mt-3 hidden"></p>
    </div>
  </div>
</div>

<!-- Payment Success Modal -->
<div id="successModal" class="fixed inset-0 z-[110] hidden">
  <div class="absolute inset-0 bg-black/50 modal-overlay"></div>
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm bg-white rounded-2xl shadow-2xl p-8 text-center fade-in">
    <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
      <i class="fas fa-check text-green-500 text-2xl"></i>
    </div>
    <h3 class="text-xl font-bold text-dark-900 mb-2">결제 완료!</h3>
    <p id="successMessage" class="text-sm text-gray-600 mb-6">결제가 성공적으로 완료되었습니다.</p>
    <button onclick="closeSuccessModal()" class="w-full h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all">확인</button>
  </div>
</div>

<!-- Cart Sidebar -->
<div id="cartSidebar" class="fixed inset-0 z-[90] hidden">
  <div class="absolute inset-0 bg-black/50 modal-overlay" onclick="closeCart()"></div>
  <div class="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl fade-in flex flex-col">
    <div class="p-5 border-b border-gray-100 flex items-center justify-between">
      <h2 class="text-lg font-bold text-dark-900"><i class="fas fa-shopping-cart mr-2 text-primary-500"></i>장바구니</h2>
      <button onclick="closeCart()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times text-xl"></i></button>
    </div>
    <div id="cartItems" class="flex-1 overflow-y-auto p-5"></div>
    <div id="cartFooter" class="border-t border-gray-100 p-5"></div>
  </div>
</div>

<!-- My Page Sidebar -->
<div id="myPageSidebar" class="fixed inset-0 z-[90] hidden">
  <div class="absolute inset-0 bg-black/50 modal-overlay" onclick="closeMyPage()"></div>
  <div class="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl fade-in flex flex-col">
    <div class="p-5 border-b border-gray-100 flex items-center justify-between">
      <h2 class="text-lg font-bold text-dark-900"><i class="fas fa-user mr-2 text-primary-500"></i>마이페이지</h2>
      <button onclick="closeMyPage()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times text-xl"></i></button>
    </div>
    <div id="myPageContent" class="flex-1 overflow-y-auto p-5"></div>
  </div>
</div>
`

const globalScripts = `
<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>
<script>
// ==================== State ====================
let currentUser = JSON.parse(localStorage.getItem('classin_user') || 'null');
let currentToken = localStorage.getItem('classin_token') || null;

// ==================== Auth ====================
function updateAuthUI() {
  const area = document.getElementById('authArea');
  if (!area) return;
  if (currentUser) {
    area.innerHTML = \`
      <button onclick="openMyPage()" class="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-50 transition-all">
        <div class="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
          <span class="text-sm font-bold text-primary-600">\${currentUser.name?.charAt(0) || 'U'}</span>
        </div>
        <span class="text-sm font-medium text-dark-700 hidden sm:block">\${currentUser.name}</span>
      </button>
      <button onclick="handleLogout()" class="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-50 transition-all">로그아웃</button>
    \`;
  } else {
    area.innerHTML = \`
      <button onclick="openAuthModal('login')" class="px-3.5 py-2 text-sm font-medium text-dark-600 hover:text-dark-900 rounded-lg hover:bg-gray-50 transition-all">로그인</button>
      <button onclick="openAuthModal('register')" class="px-4 py-2 text-sm font-semibold text-white bg-primary-500 hover:bg-primary-600 rounded-xl transition-all shadow-sm">회원가입</button>
    \`;
  }
}

function openAuthModal(type) {
  document.getElementById('authModal').classList.remove('hidden');
  switchAuth(type);
}
function closeAuthModal() { document.getElementById('authModal').classList.add('hidden'); }
function switchAuth(type) {
  document.getElementById('loginForm').classList.toggle('hidden', type !== 'login');
  document.getElementById('registerForm').classList.toggle('hidden', type !== 'register');
}

async function handleLogin() {
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) { showError('loginError', '모든 항목을 입력해주세요.'); return; }
  try {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email, password}) });
    const data = await res.json();
    if (!res.ok) { showError('loginError', data.error); return; }
    currentUser = data.user; currentToken = data.token;
    localStorage.setItem('classin_user', JSON.stringify(data.user));
    localStorage.setItem('classin_token', data.token);
    closeAuthModal(); updateAuthUI();
  } catch(e) { showError('loginError', '로그인에 실패했습니다.'); }
}

async function handleRegister() {
  const name = document.getElementById('regName').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPassword').value;
  const agree = document.getElementById('agreeTerms').checked;
  if (!name || !email || !password) { showError('regError', '모든 항목을 입력해주세요.'); return; }
  if (!agree) { showError('regError', '이용약관에 동의해주세요.'); return; }
  try {
    const res = await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email, password, name}) });
    const data = await res.json();
    if (!res.ok) { showError('regError', data.error); return; }
    currentUser = data.user; currentToken = data.token;
    localStorage.setItem('classin_user', JSON.stringify(data.user));
    localStorage.setItem('classin_token', data.token);
    closeAuthModal(); updateAuthUI();
  } catch(e) { showError('regError', '회원가입에 실패했습니다.'); }
}

function handleLogout() {
  currentUser = null; currentToken = null;
  localStorage.removeItem('classin_user'); localStorage.removeItem('classin_token');
  updateAuthUI();
}

function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ==================== Cart ====================
async function openCart() {
  document.getElementById('cartSidebar').classList.remove('hidden');
  if (!currentUser) {
    document.getElementById('cartItems').innerHTML = '<div class="text-center py-12 text-gray-400"><i class="fas fa-shopping-cart text-4xl mb-3"></i><p>로그인이 필요합니다</p></div>';
    document.getElementById('cartFooter').innerHTML = '';
    return;
  }
  await loadCart();
}
function closeCart() { document.getElementById('cartSidebar').classList.add('hidden'); }

async function loadCart() {
  const res = await fetch('/api/user/' + currentUser.id + '/cart');
  const items = await res.json();
  const container = document.getElementById('cartItems');
  if (items.length === 0) {
    container.innerHTML = '<div class="text-center py-12 text-gray-400"><i class="fas fa-shopping-cart text-4xl mb-3"></i><p>장바구니가 비어있습니다</p></div>';
    document.getElementById('cartFooter').innerHTML = '';
    return;
  }
  container.innerHTML = items.map(item => \`
    <div class="flex gap-3 p-3 rounded-xl hover:bg-gray-50 transition-all mb-2">
      <img src="\${item.thumbnail}" class="w-20 h-14 rounded-lg object-cover flex-shrink-0">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-dark-800 line-clamp-1">\${item.title}</p>
        <p class="text-xs text-gray-500">\${item.instructor_name}</p>
        <div class="flex items-center gap-2 mt-1">
          <span class="text-sm font-bold text-primary-600">\${item.price.toLocaleString()}원</span>
          \${item.discount_percent > 0 ? \`<span class="text-xs text-gray-400 line-through">\${item.original_price.toLocaleString()}원</span>\` : ''}
        </div>
      </div>
      <button onclick="removeFromCart(\${item.class_id})" class="text-gray-400 hover:text-red-500 transition-colors self-start"><i class="fas fa-times"></i></button>
    </div>
  \`).join('');
  
  const total = items.reduce((sum, i) => sum + i.price, 0);
  document.getElementById('cartFooter').innerHTML = \`
    <div class="flex justify-between items-center mb-3">
      <span class="text-sm text-gray-600">총 \${items.length}개 클래스</span>
      <span class="text-lg font-bold text-dark-900">\${total.toLocaleString()}원</span>
    </div>
    <button onclick="closeCart(); openBulkPayment()" class="w-full h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all">전체 결제하기</button>
  \`;
  updateCartBadge(items.length);
}

async function addToCart(classId) {
  if (!currentUser) { openAuthModal('login'); return; }
  await fetch('/api/cart', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({userId: currentUser.id, classId}) });
  showToast('장바구니에 담았습니다');
  updateCartBadge();
}

async function removeFromCart(classId) {
  await fetch('/api/cart', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({userId: currentUser.id, classId}) });
  loadCart();
}

function updateCartBadge(count) {
  const badge = document.getElementById('cartBadge');
  if (badge && count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
  else if (badge) { badge.classList.add('hidden'); }
}

// ==================== Wishlist ====================
async function toggleWishlistItem(classId) {
  if (!currentUser) { openAuthModal('login'); return; }
  const btn = document.querySelector('[data-wishlist="'+classId+'"]');
  const isFilled = btn?.querySelector('i')?.classList.contains('fas');
  if (isFilled) {
    await fetch('/api/wishlist', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({userId: currentUser.id, classId}) });
    if (btn) btn.innerHTML = '<i class="far fa-heart"></i>';
    showToast('찜 목록에서 제거했습니다');
  } else {
    await fetch('/api/wishlist', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({userId: currentUser.id, classId}) });
    if (btn) btn.innerHTML = '<i class="fas fa-heart text-primary-500"></i>';
    showToast('찜 목록에 추가했습니다');
  }
}

function toggleWishlist() {
  if (!currentUser) { openAuthModal('login'); return; }
  openMyPage('wishlist');
}

// ==================== Payment ====================
let paymentData = {};
function openPaymentModal(classData) {
  if (!currentUser) { openAuthModal('login'); return; }
  paymentData = classData;
  document.getElementById('paymentModal').classList.remove('hidden');
  document.getElementById('paymentOrderSummary').innerHTML = \`
    <div class="flex gap-3">
      \${classData.thumbnail ? \`<img src="\${classData.thumbnail}" class="w-20 h-14 rounded-lg object-cover">\` : ''}
      <div>
        <p class="text-sm font-semibold text-dark-800">\${classData.title}</p>
        <p class="text-xs text-gray-500 mt-0.5">\${classData.instructor_name || ''}</p>
      </div>
    </div>
  \`;
  const discount = classData.original_price - classData.price;
  document.getElementById('priceSummary').innerHTML = \`
    <div class="flex justify-between text-sm"><span class="text-gray-500">정가</span><span class="text-gray-700">\${(classData.original_price || classData.price).toLocaleString()}원</span></div>
    \${discount > 0 ? \`<div class="flex justify-between text-sm"><span class="text-gray-500">할인</span><span class="text-primary-500 font-medium">-\${discount.toLocaleString()}원</span></div>\` : ''}
    <div class="flex justify-between text-base font-bold pt-2 border-t border-gray-200 mt-2"><span class="text-dark-900">총 결제금액</span><span class="text-primary-600">\${classData.price.toLocaleString()}원</span></div>
  \`;
}

function openBulkPayment() {
  // For cart bulk payment
  openPaymentModal({ title: '장바구니 전체 결제', price: 0, original_price: 0, orderType: 'bulk' });
}

function closePaymentModal() { document.getElementById('paymentModal').classList.add('hidden'); }

function selectPaymentMethod(method) {
  document.querySelectorAll('.payment-method-btn').forEach(b => {
    b.classList.remove('border-primary-500', 'bg-primary-50', 'text-primary-600');
    b.classList.add('border-gray-200', 'text-gray-600');
  });
  const btn = document.querySelector('[data-method="'+method+'"]');
  btn.classList.add('border-primary-500', 'bg-primary-50', 'text-primary-600');
  btn.classList.remove('border-gray-200', 'text-gray-600');
  document.getElementById('cardInputArea').classList.toggle('hidden', method !== 'card');
  paymentData.paymentMethod = method;
}

function formatCardNumber(input) {
  let v = input.value.replace(/\\D/g, '').substring(0, 16);
  input.value = v.replace(/(\\d{4})/g, '$1 ').trim();
}
function formatExpiry(input) {
  let v = input.value.replace(/\\D/g, '').substring(0, 4);
  if (v.length >= 2) v = v.substring(0,2) + ' / ' + v.substring(2);
  input.value = v;
}

async function processPayment() {
  const agree = document.getElementById('paymentAgree').checked;
  if (!agree) { showError('paymentError', '결제 동의에 체크해주세요.'); return; }
  
  const btn = document.getElementById('payButton');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>결제 처리 중...';
  
  try {
    const body = {
      userId: currentUser.id,
      classId: paymentData.id || null,
      paymentMethod: paymentData.paymentMethod || 'card',
      cardNumber: document.getElementById('cardNumber')?.value?.replace(/\\s/g,'') || '',
      cardExpiry: document.getElementById('cardExpiry')?.value || '',
      cardCvc: document.getElementById('cardCvc')?.value || '',
      amount: paymentData.price,
      orderType: paymentData.orderType || 'class',
      subscriptionPlan: paymentData.subscriptionPlan || null
    };
    
    // Simulate processing delay
    await new Promise(r => setTimeout(r, 1500));
    
    const res = await fetch('/api/payment/process', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    
    if (data.success) {
      closePaymentModal();
      document.getElementById('successModal').classList.remove('hidden');
      document.getElementById('successMessage').textContent = data.message + ' (거래번호: ' + data.transactionId + ')';
    } else {
      showError('paymentError', data.error || '결제에 실패했습니다.');
    }
  } catch(e) {
    showError('paymentError', '결제 처리 중 오류가 발생했습니다.');
  }
  
  btn.disabled = false; btn.innerHTML = '결제하기';
}

function closeSuccessModal() {
  document.getElementById('successModal').classList.add('hidden');
  location.reload();
}

// ==================== My Page ====================
async function openMyPage(tab) {
  if (!currentUser) { openAuthModal('login'); return; }
  document.getElementById('myPageSidebar').classList.remove('hidden');
  const content = document.getElementById('myPageContent');
  const activeTab = tab || 'enrollments';
  
  content.innerHTML = \`
    <div class="flex items-center gap-3 mb-6 pb-4 border-b border-gray-100">
      <div class="w-14 h-14 bg-primary-100 rounded-full flex items-center justify-center">
        <span class="text-xl font-bold text-primary-600">\${currentUser.name?.charAt(0) || 'U'}</span>
      </div>
      <div>
        <p class="font-bold text-dark-900">\${currentUser.name}</p>
        <p class="text-sm text-gray-500">\${currentUser.email}</p>
        \${currentUser.subscription_plan ? \`<span class="inline-block mt-1 px-2 py-0.5 bg-primary-100 text-primary-600 text-xs font-semibold rounded-full">\${currentUser.subscription_plan === 'annual' ? '연간' : '월간'} 구독중</span>\` : ''}
      </div>
    </div>
    <div class="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1">
      <button onclick="loadMyPageTab('enrollments')" class="mypage-tab flex-1 py-2 text-sm font-medium rounded-lg transition-all \${activeTab==='enrollments'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}">수강중</button>
      <button onclick="loadMyPageTab('wishlist')" class="mypage-tab flex-1 py-2 text-sm font-medium rounded-lg transition-all \${activeTab==='wishlist'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}">찜</button>
      <button onclick="loadMyPageTab('orders')" class="mypage-tab flex-1 py-2 text-sm font-medium rounded-lg transition-all \${activeTab==='orders'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}">결제내역</button>
    </div>
    <div id="myPageTabContent"></div>
  \`;
  loadMyPageTab(activeTab);
}
function closeMyPage() { document.getElementById('myPageSidebar').classList.add('hidden'); }

async function loadMyPageTab(tab) {
  document.querySelectorAll('.mypage-tab').forEach((b,i) => {
    const tabs = ['enrollments','wishlist','orders'];
    b.classList.toggle('bg-white', tabs[i]===tab);
    b.classList.toggle('text-dark-900', tabs[i]===tab);
    b.classList.toggle('shadow-sm', tabs[i]===tab);
    b.classList.toggle('text-gray-500', tabs[i]!==tab);
  });
  const container = document.getElementById('myPageTabContent');
  
  if (tab === 'enrollments') {
    const res = await fetch('/api/user/'+currentUser.id+'/enrollments');
    const items = await res.json();
    container.innerHTML = items.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-book-open text-3xl mb-2"></i><p>수강 중인 클래스가 없습니다</p></div>'
      : items.map(e => \`
        <a href="/class/\${e.slug}" class="flex gap-3 p-3 rounded-xl hover:bg-gray-50 transition-all mb-2">
          <img src="\${e.thumbnail}" class="w-20 h-14 rounded-lg object-cover">
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-dark-800 line-clamp-1">\${e.title}</p>
            <p class="text-xs text-gray-500">\${e.instructor_name}</p>
            <div class="w-full bg-gray-200 rounded-full h-1.5 mt-2"><div class="bg-primary-500 h-1.5 rounded-full" style="width:\${e.progress}%"></div></div>
          </div>
        </a>
      \`).join('');
  } else if (tab === 'wishlist') {
    const res = await fetch('/api/user/'+currentUser.id+'/wishlist');
    const items = await res.json();
    container.innerHTML = items.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="far fa-heart text-3xl mb-2"></i><p>찜한 클래스가 없습니다</p></div>'
      : items.map(w => \`
        <a href="/class/\${w.slug}" class="flex gap-3 p-3 rounded-xl hover:bg-gray-50 transition-all mb-2">
          <img src="\${w.thumbnail}" class="w-20 h-14 rounded-lg object-cover">
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-dark-800 line-clamp-1">\${w.title}</p>
            <p class="text-xs text-gray-500">\${w.instructor_name}</p>
            <span class="text-sm font-bold text-primary-600">\${w.price.toLocaleString()}원</span>
          </div>
        </a>
      \`).join('');
  } else if (tab === 'orders') {
    const res = await fetch('/api/user/'+currentUser.id+'/orders');
    const items = await res.json();
    container.innerHTML = items.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-receipt text-3xl mb-2"></i><p>결제 내역이 없습니다</p></div>'
      : items.map(o => \`
        <div class="p-3 rounded-xl border border-gray-100 mb-3">
          <div class="flex justify-between items-start">
            <div>
              <p class="text-sm font-medium text-dark-800">\${o.class_title || (o.order_type==='subscription'?'구독 결제':'결제')}</p>
              <p class="text-xs text-gray-500 mt-0.5">\${new Date(o.created_at).toLocaleDateString('ko-KR')}</p>
            </div>
            <span class="text-sm font-bold \${o.payment_status==='completed'?'text-green-600':'text-gray-500'}">\${o.amount.toLocaleString()}원</span>
          </div>
          <div class="flex items-center gap-2 mt-2">
            <span class="px-2 py-0.5 text-xs rounded-full \${o.payment_status==='completed'?'bg-green-100 text-green-700':'bg-gray-100 text-gray-600'}">\${o.payment_status==='completed'?'결제완료':'처리중'}</span>
            <span class="text-xs text-gray-400">\${o.transaction_id}</span>
          </div>
        </div>
      \`).join('');
  }
}

// ==================== Utils ====================
function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 bg-dark-800 text-white text-sm font-medium rounded-xl shadow-lg fade-in';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

function formatPrice(price) { return price?.toLocaleString() + '원'; }

// Class card HTML generator
function classCardHTML(cls) {
  return \`
    <a href="/class/\${cls.slug}" class="block bg-white rounded-2xl overflow-hidden card-hover border border-gray-100">
      <div class="relative aspect-[16/10] overflow-hidden">
        <img src="\${cls.thumbnail}" alt="\${cls.title}" class="w-full h-full object-cover transition-transform duration-500 hover:scale-105" loading="lazy">
        \${cls.is_bestseller ? '<span class="absolute top-2.5 left-2.5 px-2 py-0.5 bg-primary-500 text-white text-[10px] font-bold rounded-md">BEST</span>' : ''}
        \${cls.is_new ? '<span class="absolute top-2.5 left-2.5 px-2 py-0.5 bg-blue-500 text-white text-[10px] font-bold rounded-md">NEW</span>' : ''}
        \${cls.class_type === 'live' ? '<span class="absolute top-2.5 right-2.5 px-2 py-0.5 bg-red-500 text-white text-[10px] font-bold rounded-md badge-live"><i class="fas fa-circle text-[6px] mr-0.5"></i>LIVE</span>' : ''}
        <button onclick="event.preventDefault();event.stopPropagation();toggleWishlistItem(\${cls.id})" data-wishlist="\${cls.id}" class="absolute bottom-2.5 right-2.5 w-8 h-8 bg-white/90 rounded-full flex items-center justify-center hover:bg-white transition-all shadow-sm">
          <i class="far fa-heart text-gray-600 text-sm"></i>
        </button>
      </div>
      <div class="p-4">
        <div class="flex items-center gap-1.5 mb-2">
          <span class="text-xs text-primary-500 font-medium">\${cls.category_name || ''}</span>
          <span class="text-gray-300 text-xs">|</span>
          <span class="text-xs text-gray-400">\${cls.level === 'beginner' ? '입문' : cls.level === 'intermediate' ? '중급' : cls.level === 'advanced' ? '고급' : '전체'}</span>
        </div>
        <h3 class="text-sm font-semibold text-dark-800 line-clamp-2 mb-2 leading-snug">\${cls.title}</h3>
        <div class="flex items-center gap-1.5 mb-3">
          <span class="text-xs text-dark-600 font-medium">\${cls.instructor_name}</span>
          \${cls.instructor_verified ? '<i class="fas fa-check-circle text-blue-500 text-[10px]"></i>' : ''}
        </div>
        <div class="flex items-center gap-1.5 mb-2">
          <div class="flex items-center">
            \${Array.from({length:5},(_, i) => '<i class="' + (i < Math.round(cls.rating) ? 'fas' : 'far') + ' fa-star text-yellow-400 text-[10px]"></i>').join('')}
          </div>
          <span class="text-xs text-gray-500">(\${cls.review_count})</span>
        </div>
        <div class="flex items-center gap-2">
          \${cls.discount_percent > 0 ? \`<span class="text-sm font-bold text-primary-500">\${cls.discount_percent}%</span>\` : ''}
          <span class="text-sm font-bold text-dark-900">\${cls.price.toLocaleString()}원</span>
          \${cls.discount_percent > 0 ? \`<span class="text-xs text-gray-400 line-through">\${cls.original_price.toLocaleString()}원</span>\` : ''}
        </div>
        <div class="flex items-center gap-3 mt-2 pt-2 border-t border-gray-50 text-[11px] text-gray-400">
          <span><i class="far fa-clock mr-0.5"></i>\${cls.duration_minutes}분</span>
          <span><i class="far fa-user mr-0.5"></i>\${cls.current_students}명 수강</span>
        </div>
      </div>
    </a>
  \`;
}

// Search handling
document.addEventListener('DOMContentLoaded', () => {
  updateAuthUI();
  const searchHandler = (e) => { if (e.key === 'Enter') { window.location.href = '/categories?search=' + encodeURIComponent(e.target.value); } };
  document.getElementById('searchInput')?.addEventListener('keydown', searchHandler);
  document.getElementById('searchInputMobile')?.addEventListener('keydown', searchHandler);
});
</script>`

// ==================== Main Page ====================
app.get('/', async (c) => {
  const categories = await c.env.DB.prepare('SELECT * FROM categories ORDER BY sort_order').all()
  const featured = await c.env.DB.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name
    FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id
    WHERE c.status = 'active' AND c.is_bestseller = 1 ORDER BY c.rating DESC LIMIT 8
  `).all()
  const newClasses = await c.env.DB.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name
    FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id
    WHERE c.status = 'active' AND c.is_new = 1 ORDER BY c.created_at DESC LIMIT 8
  `).all()
  const liveClasses = await c.env.DB.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name
    FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id
    WHERE c.status = 'active' AND c.class_type = 'live' ORDER BY c.schedule_start ASC LIMIT 8
  `).all()

  const html = `${headHTML}
<body class="bg-gray-50 min-h-screen">
${navHTML}

<!-- Hero Banner -->
<section class="hero-gradient text-white">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24">
    <div class="grid md:grid-cols-2 gap-10 items-center">
      <div>
        <div class="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm rounded-full px-4 py-1.5 mb-6">
          <span class="w-2 h-2 bg-red-500 rounded-full badge-live"></span>
          <span class="text-sm font-medium">실시간 라이브 클래스</span>
        </div>
        <h1 class="text-3xl md:text-5xl font-extrabold leading-tight mb-4">
          당신의 성장을 위한<br>
          <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 to-pink-400">라이브 클래스</span>가 시작됩니다
        </h1>
        <p class="text-gray-300 text-base md:text-lg mb-8 leading-relaxed">
          검증된 전문가의 실시간 강의로 배우고,<br>
          직접 소통하며 빠르게 성장하세요.
        </p>
        <div class="flex flex-wrap gap-3">
          <a href="/categories" class="px-6 py-3 bg-primary-500 hover:bg-primary-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-primary-500/30">
            <i class="fas fa-play mr-2"></i>클래스 둘러보기
          </a>
          <a href="#subscription" class="px-6 py-3 bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white font-medium rounded-xl transition-all border border-white/20">
            <i class="fas fa-crown mr-2 text-yellow-400"></i>구독 시작하기
          </a>
        </div>
        <div class="flex items-center gap-6 mt-8">
          <div class="text-center"><p class="text-2xl font-bold">6,200+</p><p class="text-xs text-gray-400">전체 클래스</p></div>
          <div class="w-px h-8 bg-white/20"></div>
          <div class="text-center"><p class="text-2xl font-bold">120K+</p><p class="text-xs text-gray-400">수강생</p></div>
          <div class="w-px h-8 bg-white/20"></div>
          <div class="text-center"><p class="text-2xl font-bold">4.8</p><p class="text-xs text-gray-400">평균 평점</p></div>
        </div>
      </div>
      <div class="hidden md:grid grid-cols-2 gap-3">
        <div class="space-y-3">
          <img src="https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=300&h=200&fit=crop" class="w-full rounded-2xl shadow-2xl" alt="">
          <img src="https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=300&h=180&fit=crop" class="w-full rounded-2xl shadow-2xl" alt="">
        </div>
        <div class="space-y-3 mt-6">
          <img src="https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=300&h=180&fit=crop" class="w-full rounded-2xl shadow-2xl" alt="">
          <img src="https://images.unsplash.com/photo-1510915361894-db8b60106cb1?w=300&h=200&fit=crop" class="w-full rounded-2xl shadow-2xl" alt="">
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Categories -->
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-10">
  <div class="flex items-center justify-between mb-6">
    <h2 class="text-xl md:text-2xl font-bold text-dark-900">카테고리</h2>
    <a href="/categories" class="text-sm text-primary-500 font-medium hover:underline">전체보기 <i class="fas fa-chevron-right text-xs ml-0.5"></i></a>
  </div>
  <div class="grid grid-cols-5 md:grid-cols-10 gap-2 md:gap-3">
    ${categories.results.map((cat: any) => `
      <a href="/categories?category=${cat.slug}" class="flex flex-col items-center gap-2 p-3 rounded-2xl hover:bg-white hover:shadow-md transition-all group cursor-pointer">
        <div class="w-12 h-12 bg-primary-50 group-hover:bg-primary-100 rounded-xl flex items-center justify-center transition-all">
          <i class="fas ${cat.icon} text-primary-500 text-lg"></i>
        </div>
        <span class="text-xs font-medium text-dark-600 text-center line-clamp-1">${cat.name}</span>
      </a>
    `).join('')}
  </div>
</section>

<!-- Featured / Bestseller Classes -->
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl md:text-2xl font-bold text-dark-900"><i class="fas fa-fire text-primary-500 mr-2"></i>베스트 클래스</h2>
      <p class="text-sm text-gray-500 mt-1">가장 많은 수강생이 선택한 인기 클래스</p>
    </div>
    <a href="/categories?sort=popular" class="text-sm text-primary-500 font-medium hover:underline">더보기 <i class="fas fa-chevron-right text-xs ml-0.5"></i></a>
  </div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4" id="featuredGrid">
    ${featured.results.map((cls: any) => `<div>${classCardTemplate(cls)}</div>`).join('')}
  </div>
</section>

<!-- Live Schedule Banner -->
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="bg-gradient-to-r from-dark-900 to-dark-800 rounded-3xl p-6 md:p-10">
    <div class="flex items-center justify-between mb-6">
      <div>
        <div class="flex items-center gap-2 mb-2">
          <span class="w-2 h-2 bg-red-500 rounded-full badge-live"></span>
          <span class="text-sm font-medium text-red-400">LIVE</span>
        </div>
        <h2 class="text-xl md:text-2xl font-bold text-white">예정된 라이브 클래스</h2>
        <p class="text-sm text-gray-400 mt-1">실시간으로 강사와 소통하며 배워보세요</p>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      ${liveClasses.results.slice(0, 3).map((cls: any) => `
        <a href="/class/${cls.slug}" class="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-4 hover:bg-white/10 transition-all">
          <div class="flex gap-3">
            <img src="${cls.thumbnail}" class="w-20 h-14 rounded-lg object-cover">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold text-white line-clamp-1">${cls.title}</p>
              <p class="text-xs text-gray-400 mt-0.5">${cls.instructor_name}</p>
              <div class="flex items-center gap-2 mt-2">
                <span class="px-2 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-bold rounded-md"><i class="fas fa-circle text-[5px] mr-0.5"></i>LIVE</span>
                <span class="text-xs text-gray-500">${cls.schedule_start ? new Date(cls.schedule_start).toLocaleDateString('ko-KR', {month: 'long', day: 'numeric'}) : ''}</span>
              </div>
            </div>
          </div>
        </a>
      `).join('')}
    </div>
  </div>
</section>

<!-- New Classes -->
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl md:text-2xl font-bold text-dark-900"><i class="fas fa-sparkles text-blue-500 mr-2"></i>신규 클래스</h2>
      <p class="text-sm text-gray-500 mt-1">새롭게 오픈한 클래스를 만나보세요</p>
    </div>
    <a href="/categories?sort=newest" class="text-sm text-primary-500 font-medium hover:underline">더보기 <i class="fas fa-chevron-right text-xs ml-0.5"></i></a>
  </div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
    ${newClasses.results.map((cls: any) => `<div>${classCardTemplate(cls)}</div>`).join('')}
  </div>
</section>

<!-- Subscription Section -->
<section id="subscription" class="max-w-7xl mx-auto px-4 sm:px-6 py-12">
  <div class="text-center mb-10">
    <h2 class="text-2xl md:text-3xl font-bold text-dark-900 mb-3"><i class="fas fa-crown text-yellow-500 mr-2"></i>구독으로 모든 클래스를 무제한으로</h2>
    <p class="text-gray-500">월간 또는 연간 구독으로 모든 라이브 클래스를 자유롭게 수강하세요</p>
  </div>
  <div class="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
    <!-- Monthly -->
    <div class="bg-white rounded-2xl border-2 border-gray-100 p-6 hover:border-primary-200 transition-all">
      <div class="text-center">
        <span class="text-sm font-semibold text-gray-500 uppercase">월간 플랜</span>
        <div class="mt-3 mb-4">
          <span class="text-4xl font-extrabold text-dark-900">19,900</span>
          <span class="text-gray-500">원/월</span>
        </div>
        <ul class="text-sm text-gray-600 space-y-2 mb-6">
          <li><i class="fas fa-check text-green-500 mr-2"></i>모든 라이브 클래스 무제한 수강</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>녹화 강의 다시보기</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>커뮤니티 참여</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>언제든 해지 가능</li>
        </ul>
        <button onclick="openPaymentModal({title:'월간 구독 플랜', price:19900, original_price:19900, orderType:'subscription', subscriptionPlan:'monthly'})" class="w-full h-11 border-2 border-primary-500 text-primary-500 font-semibold rounded-xl hover:bg-primary-50 transition-all">구독 시작하기</button>
      </div>
    </div>
    <!-- Annual -->
    <div class="bg-white rounded-2xl border-2 border-primary-500 p-6 relative shadow-lg shadow-primary-100">
      <div class="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary-500 text-white text-xs font-bold rounded-full">33% 할인</div>
      <div class="text-center">
        <span class="text-sm font-semibold text-primary-500 uppercase">연간 플랜</span>
        <div class="mt-3 mb-1">
          <span class="text-4xl font-extrabold text-dark-900">159,000</span>
          <span class="text-gray-500">원/년</span>
        </div>
        <p class="text-xs text-gray-400 mb-4">월 13,250원 <span class="line-through">238,800원</span></p>
        <ul class="text-sm text-gray-600 space-y-2 mb-6">
          <li><i class="fas fa-check text-green-500 mr-2"></i>모든 라이브 클래스 무제한 수강</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>녹화 강의 다시보기</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>커뮤니티 참여</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>1:1 멘토링 월 1회</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>수료증 발급</li>
        </ul>
        <button onclick="openPaymentModal({title:'연간 구독 플랜', price:159000, original_price:238800, discount_percent:33, orderType:'subscription', subscriptionPlan:'annual'})" class="w-full h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all shadow-lg shadow-primary-500/30">연간 구독 시작하기</button>
      </div>
    </div>
  </div>
</section>

${footerHTML}
${modalsHTML}
${globalScripts}
</body></html>`
  return c.html(html)
})

// ==================== Categories / Browse Page ====================
app.get('/categories', async (c) => {
  const categories = await c.env.DB.prepare('SELECT * FROM categories ORDER BY sort_order').all()
  
  const html = `${headHTML}
<body class="bg-gray-50 min-h-screen">
${navHTML}

<div class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <!-- Category Tabs -->
  <div class="mb-6">
    <div class="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-2">
      <button onclick="filterByCategory('')" class="cat-tab whitespace-nowrap px-4 py-2 text-sm font-medium rounded-full bg-dark-900 text-white transition-all" data-cat="">전체</button>
      ${categories.results.map((cat: any) => `
        <button onclick="filterByCategory('${cat.slug}')" class="cat-tab whitespace-nowrap px-4 py-2 text-sm font-medium rounded-full bg-white text-dark-600 border border-gray-200 hover:border-primary-300 hover:text-primary-500 transition-all" data-cat="${cat.slug}">
          <i class="fas ${cat.icon} mr-1"></i>${cat.name}
        </button>
      `).join('')}
    </div>
  </div>

  <!-- Filters -->
  <div class="flex flex-wrap items-center gap-3 mb-6">
    <select id="sortSelect" onchange="applyFilters()" class="h-9 px-3 bg-white border border-gray-200 rounded-lg text-sm text-dark-600 cursor-pointer">
      <option value="popular">인기순</option>
      <option value="rating">평점순</option>
      <option value="newest">최신순</option>
      <option value="price_low">가격 낮은순</option>
      <option value="price_high">가격 높은순</option>
    </select>
    <select id="levelSelect" onchange="applyFilters()" class="h-9 px-3 bg-white border border-gray-200 rounded-lg text-sm text-dark-600 cursor-pointer">
      <option value="">전체 수준</option>
      <option value="beginner">입문</option>
      <option value="intermediate">중급</option>
      <option value="advanced">고급</option>
    </select>
    <div id="searchTag" class="hidden items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-600 rounded-full text-sm">
      <span id="searchTagText"></span>
      <button onclick="clearSearch()" class="ml-1 hover:text-primary-800"><i class="fas fa-times text-xs"></i></button>
    </div>
    <span id="resultCount" class="text-sm text-gray-400 ml-auto"></span>
  </div>

  <!-- Results Grid -->
  <div id="classGrid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"></div>
  
  <!-- Load More -->
  <div id="loadMoreArea" class="text-center py-8 hidden">
    <button onclick="loadMore()" class="px-8 py-3 bg-white border border-gray-200 text-dark-600 font-medium rounded-xl hover:bg-gray-50 transition-all">
      더보기 <i class="fas fa-chevron-down ml-1"></i>
    </button>
  </div>
</div>

${footerHTML}
${modalsHTML}
${globalScripts}
<script>
let currentCategory = '';
let currentOffset = 0;
const PAGE_SIZE = 12;

async function loadClasses(append) {
  if (!append) currentOffset = 0;
  const params = new URLSearchParams();
  if (currentCategory) params.set('category', currentCategory);
  const sort = document.getElementById('sortSelect').value;
  const level = document.getElementById('levelSelect').value;
  const urlParams = new URLSearchParams(window.location.search);
  const search = urlParams.get('search') || '';
  
  params.set('sort', sort);
  if (level) params.set('level', level);
  if (search) params.set('search', search);
  params.set('limit', PAGE_SIZE);
  params.set('offset', currentOffset);
  
  const res = await fetch('/api/classes?' + params.toString());
  const classes = await res.json();
  const grid = document.getElementById('classGrid');
  
  if (!append) grid.innerHTML = '';
  if (classes.length === 0 && !append) {
    grid.innerHTML = '<div class="col-span-full text-center py-16 text-gray-400"><i class="fas fa-search text-4xl mb-3"></i><p class="text-lg">검색 결과가 없습니다</p></div>';
  }
  
  classes.forEach(cls => {
    const div = document.createElement('div');
    div.innerHTML = classCardHTML(cls);
    grid.appendChild(div.firstElementChild);
  });
  
  document.getElementById('resultCount').textContent = (currentOffset + classes.length) + '개의 클래스';
  document.getElementById('loadMoreArea').classList.toggle('hidden', classes.length < PAGE_SIZE);
  
  if (search) {
    document.getElementById('searchTag').classList.remove('hidden');
    document.getElementById('searchTag').classList.add('flex');
    document.getElementById('searchTagText').textContent = '"' + search + '"';
  }
}

function filterByCategory(slug) {
  currentCategory = slug;
  document.querySelectorAll('.cat-tab').forEach(b => {
    const isActive = b.dataset.cat === slug;
    b.classList.toggle('bg-dark-900', isActive);
    b.classList.toggle('text-white', isActive);
    b.classList.toggle('bg-white', !isActive);
    b.classList.toggle('text-dark-600', !isActive);
    b.classList.toggle('border', !isActive);
    b.classList.toggle('border-gray-200', !isActive);
  });
  loadClasses(false);
}

function applyFilters() { loadClasses(false); }
function loadMore() { currentOffset += PAGE_SIZE; loadClasses(true); }
function clearSearch() {
  window.history.pushState({}, '', '/categories');
  document.getElementById('searchTag').classList.add('hidden');
  loadClasses(false);
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const cat = urlParams.get('category') || '';
  if (cat) filterByCategory(cat);
  else loadClasses(false);
});
</script>
</body></html>`
  return c.html(html)
})

// ==================== Class Detail Page ====================
app.get('/class/:slug', async (c) => {
  const slug = c.req.param('slug')
  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.id as iid, i.display_name as instructor_name, i.profile_image as instructor_image, i.bio as instructor_bio, i.specialty as instructor_specialty, i.total_students as instructor_total_students, i.total_classes as instructor_total_classes, i.rating as instructor_rating, i.verified as instructor_verified, cat.name as category_name, cat.slug as category_slug
    FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id WHERE c.slug = ?
  `).bind(slug).first() as any
  
  if (!cls) return c.html('<h1>Class not found</h1>', 404)

  const { results: lessons } = await c.env.DB.prepare('SELECT * FROM lessons WHERE class_id = ? ORDER BY sort_order').bind(cls.id).all()
  const { results: reviews } = await c.env.DB.prepare(`
    SELECT r.*, u.name as user_name FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.class_id = ? ORDER BY r.created_at DESC LIMIT 10
  `).bind(cls.id).all()

  // Group lessons by chapter
  const chapters: Record<string, any[]> = {}
  for (const lesson of lessons as any[]) {
    const ch = lesson.chapter_title || '커리큘럼'
    if (!chapters[ch]) chapters[ch] = []
    chapters[ch].push(lesson)
  }
  
  const whatYouLearn = cls.what_you_learn ? cls.what_you_learn.split('|') : []
  const requirements = cls.requirements ? cls.requirements.split('|') : []

  const html = `${headHTML}
<body class="bg-gray-50 min-h-screen">
${navHTML}

<!-- Hero -->
<section class="bg-dark-900">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 py-8 md:py-12">
    <div class="grid md:grid-cols-5 gap-8">
      <div class="md:col-span-3">
        <!-- Breadcrumb -->
        <div class="flex items-center gap-2 text-sm text-gray-400 mb-4">
          <a href="/" class="hover:text-white transition-colors">홈</a>
          <i class="fas fa-chevron-right text-[10px]"></i>
          <a href="/categories?category=${cls.category_slug}" class="hover:text-white transition-colors">${cls.category_name}</a>
          <i class="fas fa-chevron-right text-[10px]"></i>
          <span class="text-gray-300">${cls.title}</span>
        </div>
        
        <div class="flex items-center gap-2 mb-3">
          ${cls.class_type === 'live' ? '<span class="px-2 py-0.5 bg-red-500 text-white text-xs font-bold rounded-md badge-live"><i class="fas fa-circle text-[6px] mr-0.5"></i>LIVE</span>' : ''}
          ${cls.is_bestseller ? '<span class="px-2 py-0.5 bg-primary-500 text-white text-xs font-bold rounded-md">BEST</span>' : ''}
          <span class="text-sm text-gray-400">${cls.category_name}</span>
        </div>
        
        <h1 class="text-2xl md:text-3xl font-bold text-white mb-3 leading-tight">${cls.title}</h1>
        <p class="text-gray-400 mb-4">${cls.subtitle}</p>
        
        <div class="flex flex-wrap items-center gap-4 mb-6">
          <div class="flex items-center gap-1">
            ${Array.from({length:5}, (_, i) => `<i class="${i < Math.round(cls.rating) ? 'fas' : 'far'} fa-star text-yellow-400 text-sm"></i>`).join('')}
            <span class="text-white font-bold ml-1">${cls.rating}</span>
            <span class="text-gray-500">(${cls.review_count}개 리뷰)</span>
          </div>
          <span class="text-gray-600">|</span>
          <span class="text-gray-400"><i class="far fa-user mr-1"></i>${cls.current_students}명 수강중</span>
          <span class="text-gray-600">|</span>
          <span class="text-gray-400"><i class="far fa-clock mr-1"></i>${cls.duration_minutes}분</span>
        </div>

        <!-- Instructor -->
        <div class="flex items-center gap-3 p-4 bg-white/5 rounded-xl">
          <img src="${cls.instructor_image}" class="w-12 h-12 rounded-full bg-gray-700">
          <div>
            <div class="flex items-center gap-1.5">
              <span class="text-white font-semibold">${cls.instructor_name}</span>
              ${cls.instructor_verified ? '<i class="fas fa-check-circle text-blue-400 text-sm"></i>' : ''}
            </div>
            <p class="text-sm text-gray-400">${cls.instructor_specialty}</p>
          </div>
        </div>
      </div>
      
      <!-- Thumbnail & Purchase Card -->
      <div class="md:col-span-2">
        <div class="bg-white rounded-2xl overflow-hidden shadow-2xl sticky top-20">
          <img src="${cls.thumbnail}" class="w-full aspect-video object-cover">
          <div class="p-5">
            <div class="flex items-baseline gap-2 mb-1">
              ${cls.discount_percent > 0 ? `<span class="text-xl font-bold text-primary-500">${cls.discount_percent}%</span>` : ''}
              <span class="text-2xl font-extrabold text-dark-900">${cls.price.toLocaleString()}원</span>
            </div>
            ${cls.discount_percent > 0 ? `<p class="text-sm text-gray-400 line-through mb-3">${cls.original_price.toLocaleString()}원</p>` : '<div class="mb-3"></div>'}
            
            ${cls.schedule_start ? `
            <div class="flex items-center gap-2 px-3 py-2 bg-red-50 rounded-xl mb-3">
              <i class="fas fa-calendar-alt text-red-500"></i>
              <span class="text-sm font-medium text-red-700">라이브 시작: ${new Date(cls.schedule_start).toLocaleDateString('ko-KR', {year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'})}</span>
            </div>
            ` : ''}
            
            <div class="flex items-center gap-2 mb-3">
              <div class="flex-1 bg-gray-100 rounded-full h-2">
                <div class="bg-primary-500 h-2 rounded-full" style="width:${Math.round(cls.current_students / cls.max_students * 100)}%"></div>
              </div>
              <span class="text-xs text-gray-500 whitespace-nowrap">${cls.current_students}/${cls.max_students}명</span>
            </div>
            
            <button onclick='openPaymentModal(${JSON.stringify({id:cls.id, title:cls.title, price:cls.price, original_price:cls.original_price, discount_percent:cls.discount_percent, thumbnail:cls.thumbnail, instructor_name:cls.instructor_name})})' class="w-full h-12 bg-primary-500 hover:bg-primary-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-primary-500/30 mb-2">
              <i class="fas fa-credit-card mr-2"></i>바로 수강하기
            </button>
            <div class="grid grid-cols-2 gap-2">
              <button onclick="addToCart(${cls.id})" class="h-10 border border-gray-200 text-dark-600 font-medium rounded-xl hover:bg-gray-50 transition-all text-sm">
                <i class="fas fa-shopping-cart mr-1"></i>장바구니
              </button>
              <button onclick="toggleWishlistItem(${cls.id})" data-wishlist="${cls.id}" class="h-10 border border-gray-200 text-dark-600 font-medium rounded-xl hover:bg-gray-50 transition-all text-sm">
                <i class="far fa-heart mr-1"></i>찜하기
              </button>
            </div>
            
            <div class="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-gray-100 text-center">
              <div><p class="text-xs text-gray-400">수업 수</p><p class="text-sm font-bold text-dark-800">${cls.total_lessons}강</p></div>
              <div><p class="text-xs text-gray-400">총 시간</p><p class="text-sm font-bold text-dark-800">${cls.duration_minutes}분</p></div>
              <div><p class="text-xs text-gray-400">난이도</p><p class="text-sm font-bold text-dark-800">${cls.level === 'beginner' ? '입문' : cls.level === 'intermediate' ? '중급' : cls.level === 'advanced' ? '고급' : '전체'}</p></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Detail Tabs Content -->
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="grid md:grid-cols-5 gap-8">
    <div class="md:col-span-3 space-y-10">
      
      <!-- What you'll learn -->
      ${whatYouLearn.length > 0 ? `
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-lightbulb text-yellow-500 mr-2"></i>이런 걸 배워요</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${whatYouLearn.map(item => `
            <div class="flex items-start gap-2">
              <i class="fas fa-check-circle text-green-500 mt-0.5"></i>
              <span class="text-sm text-dark-700">${item}</span>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <!-- Description -->
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-info-circle text-blue-500 mr-2"></i>클래스 소개</h2>
        <p class="text-sm text-dark-600 leading-relaxed whitespace-pre-line">${cls.description}</p>
      </div>

      <!-- Curriculum -->
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-list-ol text-purple-500 mr-2"></i>커리큘럼 <span class="text-sm font-normal text-gray-500">(${lessons.length}강)</span></h2>
        <div class="space-y-3">
          ${Object.entries(chapters).map(([chapter, chLessons]: [string, any[]], ci) => `
            <div class="border border-gray-100 rounded-xl overflow-hidden">
              <button onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('i:last-child').classList.toggle('rotate-180')" class="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-all">
                <div class="flex items-center gap-2">
                  <span class="w-6 h-6 bg-primary-100 text-primary-600 text-xs font-bold rounded-full flex items-center justify-center">${ci + 1}</span>
                  <span class="text-sm font-semibold text-dark-800">${chapter}</span>
                  <span class="text-xs text-gray-400">(${chLessons.length}강)</span>
                </div>
                <i class="fas fa-chevron-down text-gray-400 text-xs transition-transform"></i>
              </button>
              <div class="${ci === 0 ? '' : 'hidden'}">
                ${chLessons.map((lesson: any, li: number) => `
                  <div class="flex items-center gap-3 px-4 py-3 border-t border-gray-50 hover:bg-gray-50 transition-all">
                    <span class="text-xs text-gray-400 w-5">${li + 1}</span>
                    <i class="fas ${lesson.lesson_type === 'live' ? 'fa-video text-red-400' : lesson.lesson_type === 'assignment' ? 'fa-pencil-alt text-blue-400' : 'fa-play-circle text-gray-400'} text-sm"></i>
                    <span class="text-sm text-dark-700 flex-1">${lesson.title}</span>
                    ${lesson.is_preview ? '<span class="text-[10px] text-primary-500 font-bold border border-primary-200 px-1.5 py-0.5 rounded">미리보기</span>' : ''}
                    <span class="text-xs text-gray-400">${lesson.duration_minutes}분</span>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Requirements -->
      ${requirements.length > 0 ? `
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-clipboard-list text-orange-500 mr-2"></i>준비물 & 사전 지식</h2>
        <ul class="space-y-2">
          ${requirements.map(req => `
            <li class="flex items-center gap-2 text-sm text-dark-600"><i class="fas fa-chevron-right text-primary-400 text-xs"></i>${req}</li>
          `).join('')}
        </ul>
      </div>
      ` : ''}

      <!-- Instructor Detail -->
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-chalkboard-teacher text-indigo-500 mr-2"></i>크리에이터 소개</h2>
        <div class="flex items-start gap-4">
          <img src="${cls.instructor_image}" class="w-16 h-16 rounded-full bg-gray-200">
          <div class="flex-1">
            <div class="flex items-center gap-1.5 mb-1">
              <span class="text-base font-bold text-dark-900">${cls.instructor_name}</span>
              ${cls.instructor_verified ? '<i class="fas fa-check-circle text-blue-500 text-sm"></i>' : ''}
            </div>
            <p class="text-sm text-gray-500 mb-3">${cls.instructor_specialty}</p>
            <p class="text-sm text-dark-600 leading-relaxed mb-4">${cls.instructor_bio}</p>
            <div class="flex gap-4 text-sm text-gray-500">
              <span><i class="far fa-user mr-1"></i>${cls.instructor_total_students?.toLocaleString()}명 수강생</span>
              <span><i class="far fa-play-circle mr-1"></i>${cls.instructor_total_classes}개 클래스</span>
              <span><i class="fas fa-star text-yellow-400 mr-1"></i>${cls.instructor_rating}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Reviews -->
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-comments text-green-500 mr-2"></i>수강생 후기 <span class="text-sm font-normal text-gray-500">(${cls.review_count}개)</span></h2>
        
        <div class="flex items-center gap-6 mb-6 p-4 bg-gray-50 rounded-xl">
          <div class="text-center">
            <p class="text-3xl font-extrabold text-dark-900">${cls.rating}</p>
            <div class="flex items-center gap-0.5 mt-1">${Array.from({length:5}, (_, i) => `<i class="${i < Math.round(cls.rating) ? 'fas' : 'far'} fa-star text-yellow-400 text-sm"></i>`).join('')}</div>
          </div>
          <div class="flex-1">
            ${[5,4,3,2,1].map(star => {
              const count = reviews.filter((r: any) => r.rating === star).length
              const pct = reviews.length > 0 ? Math.round(count / reviews.length * 100) : 0
              return `<div class="flex items-center gap-2 mb-0.5"><span class="text-xs text-gray-500 w-3">${star}</span><div class="flex-1 bg-gray-200 rounded-full h-1.5"><div class="bg-yellow-400 h-1.5 rounded-full" style="width:${pct}%"></div></div><span class="text-xs text-gray-400 w-6 text-right">${count}</span></div>`
            }).join('')}
          </div>
        </div>
        
        <div class="space-y-4">
          ${reviews.map((r: any) => `
            <div class="pb-4 border-b border-gray-50 last:border-0">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <div class="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-xs font-bold text-gray-500">${(r.user_name || 'U').charAt(0)}</div>
                  <div>
                    <p class="text-sm font-medium text-dark-800">${r.user_name}</p>
                    <div class="flex items-center gap-0.5">${Array.from({length:5}, (_, i) => `<i class="${i < r.rating ? 'fas' : 'far'} fa-star text-yellow-400 text-[10px]"></i>`).join('')}</div>
                  </div>
                </div>
                <span class="text-xs text-gray-400">${new Date(r.created_at).toLocaleDateString('ko-KR')}</span>
              </div>
              <p class="text-sm text-dark-600 leading-relaxed">${r.content}</p>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    
    <!-- Sidebar spacer for sticky card on desktop -->
    <div class="hidden md:block md:col-span-2"></div>
  </div>
</section>

${footerHTML}
${modalsHTML}
${globalScripts}
</body></html>`
  return c.html(html)
})

// Helper function for class card template (server-side)
function classCardTemplate(cls: any): string {
  return `
    <a href="/class/${cls.slug}" class="block bg-white rounded-2xl overflow-hidden card-hover border border-gray-100">
      <div class="relative aspect-[16/10] overflow-hidden">
        <img src="${cls.thumbnail}" alt="${cls.title}" class="w-full h-full object-cover transition-transform duration-500 hover:scale-105" loading="lazy">
        ${cls.is_bestseller ? '<span class="absolute top-2.5 left-2.5 px-2 py-0.5 bg-primary-500 text-white text-[10px] font-bold rounded-md">BEST</span>' : ''}
        ${cls.is_new ? '<span class="absolute top-2.5 left-2.5 px-2 py-0.5 bg-blue-500 text-white text-[10px] font-bold rounded-md">NEW</span>' : ''}
        ${cls.class_type === 'live' ? '<span class="absolute top-2.5 right-2.5 px-2 py-0.5 bg-red-500 text-white text-[10px] font-bold rounded-md badge-live"><i class="fas fa-circle text-[6px] mr-0.5"></i>LIVE</span>' : ''}
      </div>
      <div class="p-4">
        <div class="flex items-center gap-1.5 mb-2">
          <span class="text-xs text-primary-500 font-medium">${cls.category_name || ''}</span>
        </div>
        <h3 class="text-sm font-semibold text-dark-800 line-clamp-2 mb-2 leading-snug">${cls.title}</h3>
        <div class="flex items-center gap-1.5 mb-3">
          <span class="text-xs text-dark-600 font-medium">${cls.instructor_name}</span>
          ${cls.instructor_verified ? '<i class="fas fa-check-circle text-blue-500 text-[10px]"></i>' : ''}
        </div>
        <div class="flex items-center gap-1.5 mb-2">
          <div class="flex">${Array.from({length:5}, (_, i) => `<i class="${i < Math.round(cls.rating) ? 'fas' : 'far'} fa-star text-yellow-400 text-[10px]"></i>`).join('')}</div>
          <span class="text-xs text-gray-500">(${cls.review_count})</span>
        </div>
        <div class="flex items-center gap-2">
          ${cls.discount_percent > 0 ? `<span class="text-sm font-bold text-primary-500">${cls.discount_percent}%</span>` : ''}
          <span class="text-sm font-bold text-dark-900">${cls.price?.toLocaleString()}원</span>
          ${cls.discount_percent > 0 ? `<span class="text-xs text-gray-400 line-through">${cls.original_price?.toLocaleString()}원</span>` : ''}
        </div>
        <div class="flex items-center gap-3 mt-2 pt-2 border-t border-gray-50 text-[11px] text-gray-400">
          <span><i class="far fa-clock mr-0.5"></i>${cls.duration_minutes}분</span>
          <span><i class="far fa-user mr-0.5"></i>${cls.current_students}명</span>
        </div>
      </div>
    </a>
  `
}

export default app
