import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  IMAGES: R2Bucket
  CLASSIN_SID?: string
  CLASSIN_SECRET?: string
  APP_NAME?: string
  APP_NAME_KO?: string
  APP_BADGE?: string
  // Cloudflare Stream
  CF_ACCOUNT_ID?: string
  CF_STREAM_TOKEN?: string
  CF_STREAM_SIGNING_KEY_ID?: string
  CF_STREAM_SIGNING_KEY_JWK?: string  // JWK 형식의 서명 키
  // 헥토파이낸셜 PG
  HECTO_MID?: string
  HECTO_LICENSE_KEY?: string
  HECTO_AES_KEY?: string
  HECTO_PAYMENT_SERVER?: string
  HECTO_CANCEL_SERVER?: string
  JWT_SECRET: string
}

// Helper: 브랜드명을 환경변수로 치환
function applyBranding(html: string, env: Bindings): string {
  const appName = env.APP_NAME || 'ClassIn Live'
  const appNameKo = env.APP_NAME_KO || '클래신 라이브'
  const appBadge = env.APP_BADGE || 'LIVE'
  return html
    .replaceAll('ClassIn Live', appName)
    .replaceAll('클래신 라이브', appNameKo)
    .replaceAll('{{APP_BADGE}}', appBadge)
}

// 브랜딩 치환이 실제로 필요한지 판단 (기본값과 다를 때만)
function needsBranding(env: Bindings): boolean {
  const appName = env.APP_NAME || 'ClassIn Live'
  const appBadge = env.APP_BADGE || 'LIVE'
  return appName !== 'ClassIn Live' || appBadge !== 'LIVE'
}

const app = new Hono<{ Bindings: Bindings }>()

// 미들웨어: 브랜딩 치환이 필요한 환경에서만 HTML 후처리 적용
// live 환경(기본값)에서는 스킵하여 메모리 2배 사용 방지
app.use('*', async (c, next) => {
  await next()
  if (!needsBranding(c.env)) return
  const contentType = c.res.headers.get('content-type')
  if (contentType?.includes('text/html')) {
    const body = await c.res.text()
    const branded = applyBranding(body, c.env)
    c.res = new Response(branded, {
      status: c.res.status,
      headers: c.res.headers
    })
  }
})

app.use('/api/*', cors())

// ==================== Cloudflare Stream API (src/lib/stream.ts) ====================
import { getStreamUploadUrl, getStreamVideoInfo, updateStreamVideoSettings, getSignedStreamUrl, generateStreamSignedToken } from './lib/stream'
import type { StreamConfig } from './lib/stream'

// ==================== 헥토파이낸셜 PG (src/lib/payment.ts) ====================
import { aes256Encrypt, aes256Decrypt, sha256Hash, encryptHectoPaymentParams, decryptHectoResultParams, verifyHectoNotiHash, cancelHectoPayment } from './lib/payment'
import type { HectoConfig } from './lib/payment'

// ==================== 듀얼 롤 헬퍼 (학생 겸 강사) ====================
function isInstructorUser(user: any): boolean {
  return user.role === 'instructor' || user.is_instructor === 1;
}

// ==================== ClassIn API Integration Module ====================

interface ClassInConfig {
  SID: string
  SECRET: string
  API_BASE: string
}

interface ClassInSessionResult {
  success: boolean
  courseId?: string
  classId?: string
  joinUrl?: string
  liveUrl?: string
  error?: string
  debugInfo?: any
}

// ClassIn API 에러 메시지 한글 번역
function translateClassInError(error: string): string {
  const translations: { [key: string]: string } = {
    '开课时间至少一分钟以后': '강의 시작 시간은 최소 1분 후여야 합니다.',
    '手机号码已注册': '이미 등록된 전화번호입니다.',
    '手机号码不合法': '전화번호 형식이 올바르지 않습니다.',
    '超出机构老师最大启用数量': '기관 교사 최대 수를 초과했습니다. ClassIn 관리자에게 문의하세요.',
    '参数不全或错误': '파라미터가 불완전하거나 잘못되었습니다.',
    '请求数据不合法': '요청 데이터가 유효하지 않습니다.',
    '机构下面没有该老师，请在机构下添加该老师': '기관에 해당 교사가 없습니다. 강사 관리에서 재등록해주세요.',
    '班主任不是本机构的老师': '강사가 이 기관에 등록되지 않았습니다.',
    '课程不存在': '코스가 존재하지 않습니다.',
    '课节不存在': '강의가 존재하지 않습니다.',
    '学生已经在课程中': '학생이 이미 코스에 등록되어 있습니다.',
    '参数错误': '파라미터 오류입니다.',
    '权限不足': '권한이 부족합니다.',
    '签名验证失败': '서명 검증에 실패했습니다.',
    '时间戳过期': '타임스탬프가 만료되었습니다.',
    '用户不存在': '사용자가 존재하지 않습니다.',
    '课程名称不能为空': '코스명을 입력해주세요.',
    '班级下的学生不能添加为老师': '해당 계정은 이미 학생으로 등록되어 있어 교사로 추가할 수 없습니다. 강사용 별도 계정이 필요합니다.',
    '班级下的旁听不能添加为老师': '해당 계정은 청강생으로 등록되어 있어 교사로 추가할 수 없습니다.',
  }

  let result = error
  for (const [cn, kr] of Object.entries(translations)) {
    if (result.includes(cn)) {
      result = result.replace(cn, kr)
    }
  }
  return result
}

// ClassIn API helper - generate safeKey (MD5 of SECRET + timestamp)
async function generateSafeKey(secret: string, timestamp: number): Promise<string> {
  const data = new TextEncoder().encode(secret + timestamp)
  const hashBuffer = await crypto.subtle.digest('MD5', data).catch(() => null)
  if (hashBuffer) {
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  // Fallback: simple hash simulation for environments without MD5
  let hash = 0
  const str = secret + timestamp
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).padStart(32, '0')
}

// ClassIn API: Create Course
async function createClassInCourse(config: ClassInConfig, courseName: string, teacherUid?: string): Promise<{ courseId?: string; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  // 코스명에서 특수문자 제거 (ClassIn API 호환성)
  const cleanCourseName = courseName.replace(/[\[\]]/g, '').trim() || 'Course'

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('courseName', cleanCourseName)
  // mainTeacherUid는 강의(addClass) 생성 시 설정하므로 여기서는 생략

  console.log('createClassInCourse request:', { courseName: cleanCourseName, SID: config.SID })

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=addCourse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const text = await res.text()
    console.log('createClassInCourse response text:', text)

    if (!text) {
      return { error: 'ClassIn API 응답이 비어있습니다.' }
    }

    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { error: 'ClassIn API 응답 파싱 실패: ' + text.substring(0, 200) }
    }

    if (data.error_info?.errno === 1) {
      // API returns: { data: courseId } (number directly)
      return { courseId: data.data?.toString() }
    }
    return { error: translateClassInError(data.error_info?.error || JSON.stringify(data)) }
  } catch (e: any) {
    return { error: e.message || 'Network error' }
  }
}

// LMS API v2 서명 생성 (MD5 방식)
async function generateLmsSignature(params: Record<string, any>, sid: string, secret: string, timestamp: number): Promise<string> {
  // 1. sid와 timeStamp 추가
  const allParams: Record<string, any> = { ...params, sid, timeStamp: timestamp }

  // 2. 배열/객체 제외, 1024바이트 초과 제외
  const filteredParams: Record<string, string> = {}
  for (const [key, value] of Object.entries(allParams)) {
    if (typeof value !== 'object' && String(value).length <= 1024) {
      filteredParams[key] = String(value)
    }
  }

  // 3. ASCII 오름차순 정렬 후 URL 형식으로 연결
  const sortedKeys = Object.keys(filteredParams).sort()
  const queryString = sortedKeys.map(k => `${k}=${filteredParams[k]}`).join('&')

  // 4. &key=secret 추가
  const signString = `${queryString}&key=${secret}`

  // 5. MD5 해시 (32비트 소문자)
  const encoder = new TextEncoder()
  const data = encoder.encode(signString)
  const hashBuffer = await crypto.subtle.digest('MD5', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

  return hashHex
}

// ClassIn API: Create Class (Lesson) via LMS API
async function createClassInLesson(
  config: ClassInConfig,
  courseId: string,
  className: string,
  beginTime: number,
  endTime: number,
  teacherUid: string,
  options?: { live?: number; record?: number; seatNum?: number }
): Promise<ClassInSessionResult> {
  // LMS API 사용 (가상계정 시스템용)
  const timestamp = Math.floor(Date.now() / 1000)

  const bodyParams = {
    courseId: parseInt(courseId),
    name: className,
    teacherUid: parseInt(teacherUid),
    startTime: beginTime,
    endTime: endTime,
    // 녹화/스트리밍 파라미터는 세트로 전달해야 함
    recordState: options?.record ?? 1,  // 1=녹화 활성화
    recordType: 2,                       // 2=클라우드 녹화
    liveState: options?.live ?? 0,       // 0=라이브 스트리밍 비활성화
    openState: 1,                        // 1=웹 다시보기 활성화
    seatNum: options?.seatNum ?? 7,
    isHd: 1,
    cameraHide: 0,       // 0=좌석 영역 표시 (학생 카메라 보임)
    isAutoOnstage: 1     // 1=학생 자동 무대 입장
  }

  const signature = await generateLmsSignature(bodyParams, config.SID, config.SECRET, timestamp)

  try {
    const res = await fetch(`${config.API_BASE}/lms/activity/createClass`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EEO-SIGN': signature,
        'X-EEO-UID': config.SID,
        'X-EEO-TS': timestamp.toString()
      },
      body: JSON.stringify(bodyParams)
    })

    const data = await res.json() as any
    console.log('LMS createClass response:', JSON.stringify(data))

    if (data.code === 1 && data.data) {
      return {
        success: true,
        classId: data.data.classId?.toString(),
        liveUrl: data.data.live_url || '',
        joinUrl: data.data.live_url || `https://www.eeo.cn/client/invoke/index.html?classId=${data.data.classId}&courseId=${courseId}&schoolId=${config.SID}`
      }
    }
    return { success: false, error: translateClassInError(data.msg || 'Failed to create lesson via LMS API') }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// ClassIn API: Delete Class (Lesson) via LMS API
async function deleteClassInLesson(
  config: ClassInConfig,
  courseId: string,
  activityId: string
): Promise<{ success: boolean; notFound?: boolean; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)

  const bodyParams = {
    courseId: parseInt(courseId),
    activityId: parseInt(activityId)
  }

  const signature = await generateLmsSignature(bodyParams, config.SID, config.SECRET, timestamp)

  try {
    const res = await fetch(`${config.API_BASE}/lms/activity/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EEO-SIGN': signature,
        'X-EEO-UID': config.SID,
        'X-EEO-TS': timestamp.toString()
      },
      body: JSON.stringify(bodyParams)
    })

    const data = await res.json() as any
    console.log('LMS deleteActivity response:', JSON.stringify(data))

    if (data.code === 1) {
      return { success: true }
    }
    // 40005: 진행중인 강의 - 삭제 불가
    if (data.code === 40005) {
      return { success: false, error: '진행중인 강의은 삭제할 수 없습니다.' }
    }
    // 40006: 이미 종료된 강의 - 삭제 불가
    if (data.code === 40006) {
      return { success: false, error: '이미 종료된 강의은 삭제할 수 없습니다.' }
    }
    // 활동이 존재하지 않는 경우 (活动不存在) - 로컬에서만 삭제 진행
    if (data.msg && (data.msg.includes('不存在') || data.msg.includes('not exist') || data.msg.includes('not found'))) {
      return { success: true, notFound: true }
    }
    return { success: false, error: data.msg || 'Failed to delete lesson via LMS API' }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// ClassIn API: Get webcast/replay URL for a class
async function getClassInWebcastUrl(
  config: ClassInConfig,
  courseId: string,
  classId?: string
): Promise<{ url?: string; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('courseId', courseId)
  if (classId) formData.set('classId', classId)

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=getWebcastUrl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const data = await res.json() as any
    console.log('getWebcastUrl response:', JSON.stringify(data))

    if (data.error_info?.errno === 1 && data.data) {
      return { url: data.data }
    }
    return { error: translateClassInError(data.error_info?.error || 'Failed to get webcast URL') }
  } catch (e: any) {
    return { error: e.message || 'Network error' }
  }
}

// ClassIn API: Get login linked URL for classroom entry
async function getClassInLoginUrl(
  config: ClassInConfig,
  uid: string,
  courseId: string,
  classId: string,
  deviceType: number = 1,  // 1=PC, 2=iOS, 3=Android
  identity: number = 1  // 1=학생, 2=청강생, 3=강사/조교
): Promise<{ url?: string; error?: string; rawResponse?: string; requiresManualLogin?: boolean }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('uid', uid)
  formData.set('courseId', courseId)
  formData.set('classId', classId)
  formData.set('deviceType', deviceType.toString())
  formData.set('lifeTime', '86400')  // 24 hours
  formData.set('identity', identity.toString())  // 역할 지정

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=getLoginLinked`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const text = await res.text()
    console.log('getLoginLinked raw response:', text)

    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { error: 'Invalid JSON response', rawResponse: text.substring(0, 500) }
    }

    if (data.error_info?.errno === 1 && data.data) {
      let url = data.data
      // Convert classin:// protocol to web URL
      if (url.startsWith('classin://')) {
        // Extract parameters from classin:// URL
        const urlObj = new URL(url.replace('classin://', 'https://'))
        const params = urlObj.searchParams
        const authTicket = params.get('authTicket')
        const telephone = params.get('telephone')
        const classIdParam = params.get('classId')
        const courseIdParam = params.get('courseId')
        const schoolIdParam = params.get('schoolId')

        // authTicket이 있으면 자동 로그인 가능
        if (authTicket && authTicket !== 'null') {
          // Build web URL with authTicket (자동 로그인)
          url = `https://www.eeo.cn/client/invoke/index.html?telephone=${telephone}&password=${encodeURIComponent('ClassIn2024!')}&authTicket=${authTicket}&classId=${classIdParam}&courseId=${courseIdParam}&schoolId=${schoolIdParam}`
          return { url }
        } else {
          // authTicket 없으면 수동 로그인 필요 (2021년 6월 이후 일부 계정)
          console.log('getLoginLinked: authTicket is null or missing, manual login required')
          url = `https://www.eeo.cn/client/invoke/index.html?telephone=${telephone}&password=${encodeURIComponent('ClassIn2024!')}&classId=${classIdParam}&courseId=${courseIdParam}&schoolId=${schoolIdParam}`
          return { url, requiresManualLogin: true }
        }
      }
      return { url }
    }
    return { error: translateClassInError(data.error_info?.error || 'Failed to get login URL'), rawResponse: text.substring(0, 500) }
  } catch (e: any) {
    return { error: e.message || 'Network error' }
  }
}

// DEMO MODE: Generate a simulated ClassIn session when no API keys are configured
function generateDemoClassInSession(classData: any, userId: number): ClassInSessionResult {
  const demoClassId = `DEMO_CLS_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
  const demoCourseId = `DEMO_CRS_${classData.id}`
  const sessionToken = Math.random().toString(36).substr(2, 12)
  
  return {
    success: true,
    courseId: demoCourseId,
    classId: demoClassId,
    joinUrl: `https://www.classin.com/classroom?courseId=${demoCourseId}&classId=${demoClassId}&token=${sessionToken}`,
    liveUrl: `https://live.eeo.cn/live_partner.html?classId=${demoClassId}&uid=${userId}`
  }
}

// Main function: Create ClassIn session after payment
async function createClassInSession(
  db: D1Database,
  classId: number,
  userId: number,
  enrollmentId: number,
  config?: ClassInConfig
): Promise<ClassInSessionResult> {
  // Get class details including instructor_id and existing ClassIn IDs
  const cls = await db.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.user_id as instructor_user_id, i.id as instructor_id, i.classin_uid as instructor_classin_uid,
           c.classin_course_id, c.classin_class_id
    FROM classes c JOIN instructors i ON c.instructor_id = i.id WHERE c.id = ?
  `).bind(classId).first() as any

  if (!cls) return { success: false, error: 'Class not found' }

  // Get student's virtual account UID from enrollment
  const enrollment = await db.prepare(`
    SELECT classin_account_uid FROM enrollments WHERE id = ?
  `).bind(enrollmentId).first() as any
  const studentUid = enrollment?.classin_account_uid || ''

  let result: ClassInSessionResult

  if (config && config.SID && config.SECRET) {
    // PRODUCTION MODE: Use real ClassIn API
    try {
      // Get or register instructor UID
      let teacherUid = cls.instructor_classin_uid || ''
      if (!teacherUid && cls.instructor_id) {
        const instructorResult = await registerInstructorWithClassIn(db, cls.instructor_id, config)
        if (instructorResult.uid) {
          teacherUid = instructorResult.uid
        }
      }

      if (!teacherUid) {
        console.log('No teacher UID available, falling back to DEMO mode')
        result = generateDemoClassInSession(cls, userId)
        result.error = 'No teacher UID available'
        result.debugInfo = { instructorId: cls.instructor_id, studentUid }
        if (studentUid) {
          result.joinUrl = `${result.joinUrl}&uid=${studentUid}`
        }
      } else {
        // 이미 생성된 ClassIn 코스/강의가 있는지 확인
        let courseId = cls.classin_course_id || ''
        let existingClassId = cls.classin_class_id || ''

        // 코스가 없으면 새로 생성
        if (!courseId) {
          const courseResult = await createClassInCourse(config, cls.title, teacherUid)
          console.log('createClassInCourse result:', JSON.stringify(courseResult), 'teacherUid:', teacherUid)
          if (!courseResult.courseId) {
            console.log('ClassIn API failed, falling back to DEMO mode:', courseResult.error)
            result = generateDemoClassInSession(cls, userId)
            result.error = courseResult.error
            result.debugInfo = { teacherUid, studentUid }
            if (studentUid) {
              result.joinUrl = `${result.joinUrl}&uid=${studentUid}`
            }
          } else {
            courseId = courseResult.courseId
          }
        }

        if (courseId) {
          // 학생을 코스에 추가 (이미 추가된 경우 무시됨)
          if (studentUid) {
            const addResult = await addStudentToCourse(config, courseId, studentUid)
            console.log('addStudentToCourse result:', JSON.stringify(addResult), 'studentUid:', studentUid, 'courseId:', courseId)
          }

          // 강의(레슨)이 없으면 새로 생성 (방어: class_lessons에 이미 레슨이 있으면 그것을 사용)
          if (!existingClassId) {
            const existingLesson = await db.prepare(
              'SELECT classin_class_id, classin_course_id FROM class_lessons WHERE class_id = ? AND classin_class_id IS NOT NULL ORDER BY lesson_number ASC LIMIT 1'
            ).bind(classId).first() as any
            if (existingLesson?.classin_class_id) {
              existingClassId = existingLesson.classin_class_id
              if (existingLesson.classin_course_id) courseId = existingLesson.classin_course_id
              await db.prepare('UPDATE classes SET classin_class_id = ?, classin_course_id = ? WHERE id = ?').bind(existingClassId, courseId, classId).run()
            }
          }
          if (!existingClassId) {
            // 강의 시작 시간은 최소 2분 후여야 함 (ClassIn API 요구사항)
            const now = Math.floor(Date.now() / 1000)
            const minStartTime = now + 120
            let beginTime = cls.schedule_start ? Math.floor(new Date(cls.schedule_start).getTime() / 1000) : now + 86400
            if (beginTime < minStartTime) {
              beginTime = minStartTime
            }
            const endTime = beginTime + (cls.duration_minutes || 60) * 60

            result = await createClassInLesson(
              config,
              courseId,
              cls.title,
              beginTime,
              endTime,
              teacherUid,
              { live: 1, record: 1 }
            )
            result.courseId = courseId

            // 생성된 코스/강의 ID를 classes 테이블에 저장
            if (result.classId) {
              const scheduledAtISO = new Date(beginTime * 1000).toISOString()
              await db.prepare(`
                UPDATE classes SET classin_course_id = ?, classin_class_id = ?, classin_scheduled_at = ?, classin_created_at = datetime('now') WHERE id = ?
              `).bind(courseId, result.classId, scheduledAtISO, classId).run()
              existingClassId = result.classId

              // 새 강의 생성 시에도 studentUid를 URL에 포함
              if (studentUid && result.joinUrl) {
                result.joinUrl = result.joinUrl.includes('uid=')
                  ? result.joinUrl
                  : `${result.joinUrl}&uid=${studentUid}`
              } else if (studentUid && !result.joinUrl) {
                result.joinUrl = `https://www.eeo.cn/client/invoke/index.html?classId=${result.classId}&courseId=${courseId}&schoolId=${config.SID}&uid=${studentUid}`
              }
            }
          } else {
            // 기존 강의 사용
            result = {
              success: true,
              courseId: courseId,
              classId: existingClassId,
              joinUrl: '',
              liveUrl: ''
            }
            console.log('Using existing ClassIn course/class:', courseId, existingClassId, 'studentUid:', studentUid)
          }

          // getLoginLinked API로 로그인 토큰 포함된 URL 생성
          if (existingClassId && studentUid) {
            const loginUrlResult = await getClassInLoginUrl(config, studentUid, courseId, existingClassId, 1)
            if (loginUrlResult.url) {
              result.joinUrl = loginUrlResult.url
              console.log('Got loginLinked URL for student:', studentUid)
            } else {
              // fallback URL
              result.joinUrl = `https://www.eeo.cn/client/invoke/index.html?uid=${studentUid}&classId=${existingClassId}&courseId=${courseId}&schoolId=${config.SID}`
              console.log('getLoginLinked failed, using fallback URL:', loginUrlResult.error)
            }
          } else if (existingClassId && !studentUid) {
            // 가상 계정이 없는 경우 - 일반 입장 URL 사용
            result.joinUrl = `https://www.eeo.cn/client/invoke/index.html?classId=${existingClassId}&courseId=${courseId}&schoolId=${config.SID}`
            console.log('No studentUid, using general join URL:', result.joinUrl)
          }

          if (!result.success) {
            const lessonError = result.error
            result = generateDemoClassInSession(cls, userId)
            result.error = 'Lesson creation failed: ' + lessonError
            result.debugInfo = { teacherUid, studentUid, courseId }
            if (studentUid) {
              result.joinUrl = `${result.joinUrl}&uid=${studentUid}`
            }
          }
        }
      }
    } catch (e: any) {
      // Fallback to DEMO mode on any error
      console.log('ClassIn API error, falling back to DEMO mode:', e)
      result = generateDemoClassInSession(cls, userId)
      result.error = 'Exception: ' + (e.message || String(e))
      result.debugInfo = { teacherUid, studentUid, exception: true }
      if (studentUid) {
        result.joinUrl = `${result.joinUrl}&uid=${studentUid}`
      }
    }
  } else {
    // DEMO MODE: Generate simulated session
    result = generateDemoClassInSession(cls, userId)
    if (studentUid) {
      result.joinUrl = `${result.joinUrl}&uid=${studentUid}`
    }
  }

  if (result.success) {
    // Save session to database
    const scheduledAt = cls.schedule_start || new Date(Date.now() + 86400000).toISOString()
    await db.prepare(`
      INSERT INTO classin_sessions (class_id, enrollment_id, user_id, classin_course_id, classin_class_id, classin_join_url, classin_live_url, session_title, instructor_name, scheduled_at, duration_minutes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
    `).bind(
      classId, enrollmentId, userId,
      result.courseId || '', result.classId || '',
      result.joinUrl || '', result.liveUrl || '',
      cls.title, cls.instructor_name || '',
      scheduledAt, cls.duration_minutes || 60
    ).run()

    // Update enrollment with ClassIn join URL
    await db.prepare('UPDATE enrollments SET classin_join_url = ? WHERE id = ?').bind(result.joinUrl || '', enrollmentId).run()

    // class_lessons에도 저장 (마이페이지 다음 강의 표시용)
    if (result.courseId && result.classId) {
      // 이미 해당 강의가 class_lessons에 있는지 확인
      const existingLesson = await db.prepare(
        'SELECT id FROM class_lessons WHERE class_id = ? AND classin_class_id = ?'
      ).bind(classId, result.classId).first()

      if (!existingLesson) {
        // 강의 번호 계산
        const lessonCount = await db.prepare(
          'SELECT COUNT(*) as count FROM class_lessons WHERE class_id = ?'
        ).bind(classId).first() as any
        const lessonNumber = (lessonCount?.count || 0) + 1
        const lessonTitle = `${cls.title} #${lessonNumber}`

        await db.prepare(`
          INSERT INTO class_lessons (class_id, lesson_number, lesson_title, classin_course_id, classin_class_id, scheduled_at, duration_minutes, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')
        `).bind(classId, lessonNumber, lessonTitle, result.courseId, result.classId, scheduledAt, cls.duration_minutes || 60).run()
      }
    }
  }

  return result
}

// ==================== ClassIn Virtual Account Management ====================

interface VirtualAccountResult {
  success: boolean
  uid?: string
  error?: string
}

// ClassIn API: Register user and get UID (사용자 등록 및 UID 획득)
// action=register, telephone로 등록, 응답으로 UID 반환
// 가상계정 형식: 0065-20000531700 (국가코드-전화번호)
async function registerVirtualAccount(
  config: ClassInConfig,
  accountUid: string,  // 가상계정 ID (전화번호 형식: 0065-20000531700)
  studentName: string,
  password: string
): Promise<VirtualAccountResult> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  // 가상계정 ID를 그대로 telephone으로 사용 (형식: 0065-20000531700)
  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('telephone', accountUid)
  formData.set('password', password)
  formData.set('nickname', studentName)  // 학생 이름 설정

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const data = await res.json() as any
    console.log('ClassIn register response:', JSON.stringify(data))

    const errno = data.error_info?.errno
    const classInUid = data.data?.toString() || ''

    // errno 1: 성공, errno 135: 이미 등록됨 (둘 다 UID 반환)
    if (errno === 1 || errno === 135) {
      if (classInUid) {
        console.log('ClassIn register - errno:', errno, 'uid:', classInUid)
        return { success: true, uid: classInUid, alreadyRegistered: errno === 135 }
      }
    }

    // 다른 에러지만 data에 UID가 있으면 반환
    if (classInUid) {
      console.log('ClassIn register error but got UID - errno:', errno, 'uid:', classInUid)
      return { success: true, uid: classInUid }
    }

    return { success: false, error: translateClassInError(data.error_info?.error || 'Failed to register account') }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// ClassIn API: Edit user info (사용자 닉네임 변경)
async function editUserInfo(
  config: ClassInConfig,
  uid: string,
  nickname: string
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('uid', uid)
  formData.set('nickname', nickname)

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=editUserInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const data = await res.json() as any
    console.log('ClassIn editUserInfo response:', JSON.stringify(data))

    if (data.error_info?.errno === 1) {
      return { success: true }
    }
    return { success: false, error: translateClassInError(data.error_info?.error || 'Failed to edit user info') }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// ClassIn API: Add student to school/institution (기관에 학생 추가 - 필수!)
async function addSchoolStudent(
  config: ClassInConfig,
  studentAccount: string,  // 전화번호 형식: 0065-20000531700
  studentName: string
): Promise<{ success: boolean; error?: string; rawResponse?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('studentAccount', studentAccount)
  formData.set('studentName', studentName)

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=addSchoolStudent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const text = await res.text()
    console.log('addSchoolStudent response:', text)
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { success: false, error: 'Invalid JSON', rawResponse: text }
    }
    if (data.error_info?.errno === 1) {
      return { success: true, rawResponse: text }
    }
    return { success: false, error: translateClassInError(data.error_info?.error || 'Failed to add student to school'), rawResponse: text }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// ClassIn API: Add teacher to school (기관에 교사 추가 - 강사용)
// https://docs.eeo.cn/api/en/user/addTeacher.html
async function addTeacher(
  config: ClassInConfig,
  teacherAccount: string,  // 전화번호 또는 이메일
  teacherName: string
): Promise<{ success: boolean; error?: string; rawResponse?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('teacherAccount', teacherAccount)
  formData.set('teacherName', teacherName)

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=addTeacher`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const text = await res.text()
    console.log('addTeacher response:', text)
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { success: false, error: 'Invalid JSON', rawResponse: text }
    }
    // errno 1 = 성공, errno 133 = 이미 교사로 등록됨 (성공으로 처리)
    if (data.error_info?.errno === 1 || data.error_info?.errno === 133) {
      return { success: true, rawResponse: text, alreadyExists: data.error_info?.errno === 133 }
    }
    return { success: false, error: translateClassInError(data.error_info?.error || 'Failed to add teacher to school'), rawResponse: text }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// ClassIn API: Add member to school (기관에 멤버 추가 - authTicket용)
async function addToSchoolMember(
  config: ClassInConfig,
  uid: string,  // ClassIn UID
  memberName: string
): Promise<{ success: boolean; error?: string; rawResponse?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('uid', uid)
  formData.set('memberName', memberName)

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=addToSchoolMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const text = await res.text()
    console.log('addToSchoolMember response:', text)
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { success: false, error: 'Invalid JSON', rawResponse: text }
    }
    if (data.error_info?.errno === 1) {
      return { success: true, rawResponse: text }
    }
    return { success: false, error: translateClassInError(data.error_info?.error || 'Failed to add member to school'), rawResponse: text }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// ClassIn API: Add student to course (수강생을 코스에 추가)
async function addStudentToCourse(
  config: ClassInConfig,
  courseId: string,
  studentUid: string
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('courseId', courseId)
  formData.set('studentUid', studentUid)
  formData.set('identity', '1')  // 1=student, 2=auditor

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=addCourseStudent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const data = await res.json() as any
    console.log('addCourseStudent response:', JSON.stringify(data))
    if (data.error_info?.errno === 1) {
      return { success: true }
    }
    return { success: false, error: translateClassInError(data.error_info?.error || 'Failed to add student to course') }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// ClassIn API: Add teacher to course (강사를 코스에 추가)
// 강사도 addCourseStudent API를 사용하되 identity=3 (조교/강사)으로 설정
async function addTeacherToCourse(
  config: ClassInConfig,
  courseId: string,
  teacherUid: string
): Promise<{ success: boolean; error?: string; rawResponse?: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeKey = await generateSafeKey(config.SECRET, timestamp)

  const formData = new URLSearchParams()
  formData.set('SID', config.SID)
  formData.set('safeKey', safeKey)
  formData.set('timeStamp', timestamp.toString())
  formData.set('courseId', courseId)
  formData.set('studentUid', teacherUid)  // teacher도 동일하게 studentUid 사용
  formData.set('identity', '3')  // 1=학생, 2=청강생, 3=조교(강사)

  try {
    const res = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=addCourseStudent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    })
    const text = await res.text()
    console.log('addCourseStudent (teacher) response:', text)

    if (!text || text.trim() === '') {
      return { success: false, error: 'Empty response from API', rawResponse: text }
    }

    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { success: false, error: 'Invalid JSON response', rawResponse: text.substring(0, 500) }
    }

    if (data.error_info?.errno === 1) {
      return { success: true }
    }
    // 이미 존재하는 경우도 성공으로 처리
    const errno = data.error_info?.errno
    const errorMsg = data.error_info?.error || ''
    // errno 133: 이미 존재
    // errno 332: 이미 강사/조교로 등록되어 있음 (학생으로 추가 불가 = 이미 강사임)
    if (errno === 133 || errno === 332 || errorMsg.includes('已经存在') || errorMsg.includes('already exists')) {
      return { success: true, alreadyTeacher: errno === 332 }
    }
    return { success: false, error: translateClassInError(errorMsg || 'Failed to add teacher to course'), rawResponse: text.substring(0, 500) }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// Generate default password for virtual accounts
// 강사용 표준 비밀번호 (ClassIn에서 authTicket 제거 후 수동 로그인 필요)
const INSTRUCTOR_DEFAULT_PASSWORD = 'ClassIn2024!'

function generateDefaultPassword(): string {
  return INSTRUCTOR_DEFAULT_PASSWORD
}

// 모바일 기기 감지 및 ClassIn deviceType 반환
function detectDeviceType(userAgent: string): number {
  const ua = userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return 2  // iOS
  if (/android/.test(ua)) return 3  // Android
  return 1  // PC
}

function isMobileDevice(userAgent: string): boolean {
  return /iphone|ipad|ipod|android|mobile/i.test(userAgent)
}

// 모바일에서 수동 로그인 필요 시 비밀번호를 보여주는 중간 페이지
function renderMobileLoginPage(classInUrl: string, password: string, telephone?: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClassIn 입장</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-lg p-6 max-w-sm w-full text-center">
    <h2 class="text-xl font-bold mb-2">ClassIn 수업 입장</h2>
    <p class="text-gray-600 text-sm mb-4">ClassIn 로그인 페이지에서 아래 비밀번호를 입력해주세요.</p>

    <div class="bg-gray-100 rounded-xl p-4 mb-4">
      <p class="text-xs text-gray-500 mb-1">비밀번호</p>
      <div class="flex items-center justify-center gap-2">
        <span id="pw" class="text-2xl font-mono font-bold tracking-wider">${password}</span>
        <button onclick="copyPw()" class="bg-green-500 text-white text-xs px-3 py-1.5 rounded-lg active:bg-green-600">복사</button>
      </div>
      <p id="copied" class="text-green-600 text-xs mt-1 hidden">복사됨!</p>
    </div>

    ${telephone ? `<p class="text-xs text-gray-400 mb-4">전화번호: ${telephone}</p>` : ''}

    <a href="${classInUrl}" class="block bg-green-500 text-white font-bold py-3 px-6 rounded-xl text-lg active:bg-green-600">
      ClassIn 입장하기
    </a>
    <p class="text-xs text-gray-400 mt-3">비밀번호를 복사한 후 입장하기를 눌러주세요.</p>
  </div>
  <script>
    function copyPw() {
      navigator.clipboard.writeText('${password}').then(function() {
        document.getElementById('copied').classList.remove('hidden');
        setTimeout(function() { document.getElementById('copied').classList.add('hidden'); }, 2000);
      }).catch(function() {
        var t = document.createElement('textarea');
        t.value = '${password}';
        document.body.appendChild(t);
        t.select();
        document.execCommand('copy');
        document.body.removeChild(t);
        document.getElementById('copied').classList.remove('hidden');
      });
    }
  </script>
</body>
</html>`
}

// 강사 가상계정 동기화 (VA 테이블 + instructors 테이블)
// registerInstructorWithClassIn 내부에서 자동 호출 — 호출자가 신경 쓸 필요 없음
async function syncInstructorVirtualAccount(
  db: D1Database, instructorId: number, accountUid: string, classInUid: string, instructorName: string
) {
  try {
    // 1. VA 테이블: status='assigned' + classin_uid + assigned_name 업데이트
    await db.prepare(`
      UPDATE classin_virtual_accounts
      SET status = 'assigned', classin_uid = ?, assigned_name = ?, assigned_at = datetime('now'), updated_at = datetime('now')
      WHERE account_uid = ? AND (status = 'available' OR classin_uid IS NULL OR classin_uid = '')
    `).bind(classInUid, 'INSTRUCTOR:' + instructorName, accountUid).run()
    // 2. instructors 테이블: classin_virtual_account 저장
    await db.prepare(
      'UPDATE instructors SET classin_virtual_account = ? WHERE id = ? AND (classin_virtual_account IS NULL OR classin_virtual_account = ?)'
    ).bind(accountUid, instructorId, '').run()
    console.log('syncInstructorVirtualAccount OK:', accountUid, '→', classInUid)
  } catch (e: any) {
    // VA 동기화 실패해도 등록 자체는 성공으로 처리 (방어적)
    console.log('syncInstructorVirtualAccount failed (non-fatal):', e.message)
  }
}

// Register instructor with ClassIn and get UID (강사 ClassIn 등록)
async function registerInstructorWithClassIn(
  db: D1Database,
  instructorId: number,
  config: ClassInConfig,
  accountInput?: string  // 전화번호 또는 이메일
): Promise<{ uid?: string; error?: string }> {
  // Get instructor info
  const instructor = await db.prepare(`
    SELECT i.*, u.email, u.name as user_name FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE i.id = ?
  `).bind(instructorId).first() as any

  if (!instructor) {
    return { error: 'Instructor not found' }
  }

  // 이메일인지 전화번호인지 판단
  const account = accountInput || instructor.email
  if (!account) {
    return { error: '이메일 또는 전화번호가 필요합니다.' }
  }
  const isEmail = account.includes('@')
  const accountValue = isEmail ? account : formatKoreanPhoneForClassIn(account)
  const teacherName = instructor.display_name || instructor.user_name || 'Teacher'

  try {
    // Step 1: register API로 UID 조회 + 학교 멤버 등록 (authTicket 필수)
    const timestamp1 = Math.floor(Date.now() / 1000)
    const safeKey1 = await generateSafeKey(config.SECRET, timestamp1)

    const registerForm = new URLSearchParams()
    registerForm.set('SID', config.SID)
    registerForm.set('safeKey', safeKey1)
    registerForm.set('timeStamp', timestamp1.toString())
    if (isEmail) {
      registerForm.set('email', accountValue)
    } else {
      registerForm.set('telephone', accountValue)
    }
    registerForm.set('password', generateDefaultPassword())
    registerForm.set('nickname', teacherName)
    // addToSchoolMember 제거 - addSchoolStudent로 별도 등록 (학생과 동일한 방식으로 authTicket 발급)

    const registerRes = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: registerForm.toString()
    })
    const registerText = await registerRes.text()
    console.log('Instructor register response:', registerText)

    let registerData: any
    try {
      registerData = JSON.parse(registerText)
    } catch {
      return { error: 'register API 응답 파싱 실패' }
    }

    // register 응답에서 UID 추출 (신규 등록 또는 "이미 등록됨" 모두 data에 UID 반환)
    const classInUid = registerData.data?.toString()
    if (!classInUid) {
      const errorMsg = registerData.error_info?.error || JSON.stringify(registerData)
      return { error: translateClassInError(errorMsg) }
    }

    // Step 2: addTeacher API로 기관 교사로 등록 (학생이 아닌 교사로 바로 등록)
    // 주의: addSchoolStudent를 먼저 호출하면 학생으로 등록되어 교사 추가 불가
    const timestamp2 = Math.floor(Date.now() / 1000)
    const safeKey2 = await generateSafeKey(config.SECRET, timestamp2)

    const teacherForm = new URLSearchParams()
    teacherForm.set('SID', config.SID)
    teacherForm.set('safeKey', safeKey2)
    teacherForm.set('timeStamp', timestamp2.toString())
    teacherForm.set('teacherAccount', accountValue)
    teacherForm.set('teacherName', teacherName)

    const teacherRes = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=addTeacher`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: teacherForm.toString()
    })
    const teacherText = await teacherRes.text()
    console.log('addTeacher response:', teacherText)

    let teacherData: any
    try {
      teacherData = JSON.parse(teacherText)
    } catch {
      // addTeacher 실패해도 UID는 있으므로 계속 진행
    }

    const teacherErrno = teacherData?.error_info?.errno
    const teacherError = teacherData?.error_info?.error || ''
    const alreadyExists = teacherError.includes('已经存在')

    // addTeacher 성공 또는 이미 존재하면 성공
    if (teacherErrno === 1 || alreadyExists) {
      await db.prepare(`
        UPDATE instructors SET classin_uid = ?, classin_registered_at = datetime('now') WHERE id = ?
      `).bind(classInUid, instructorId).run()
      // VA 동기화: 전화번호(가상계정)로 등록한 경우 VA 테이블도 업데이트
      if (!isEmail && accountInput) {
        await syncInstructorVirtualAccount(db, instructorId, accountInput, classInUid, teacherName)
      }
      return { uid: classInUid }
    }

    // addTeacher 실패해도 UID는 저장 (나중에 재등록으로 기관 교사 추가 가능)
    await db.prepare(`
      UPDATE instructors SET classin_uid = ?, classin_registered_at = datetime('now') WHERE id = ?
    `).bind(classInUid, instructorId).run()
    // VA 동기화
    if (!isEmail && accountInput) {
      await syncInstructorVirtualAccount(db, instructorId, accountInput, classInUid, teacherName)
    }

    return { uid: classInUid, error: translateClassInError(teacherError) + ' (UID는 저장됨, 재등록 필요)' }
  } catch (e: any) {
    return { error: e.message || 'Network error' }
  }
}

// Assign virtual account to enrollment (수강 신청 시 가상 계정 할당)
// 1인 1계정 원칙: 이미 할당된 계정이 있으면 재사용
async function assignVirtualAccountToEnrollment(
  db: D1Database,
  enrollmentId: number,
  userId: number,
  userName: string,
  classInConfig: ClassInConfig | null
): Promise<{ success: boolean; accountUid?: string; classInUid?: string; password?: string; isRegistered?: boolean; error?: string }> {
  // 1. 먼저 사용자에게 이미 할당된 가상 계정이 있는지 확인
  const existingAccount = await db.prepare(`
    SELECT * FROM classin_virtual_accounts
    WHERE user_id = ? AND status = 'assigned'
    ORDER BY assigned_at DESC LIMIT 1
  `).bind(userId).first() as any

  if (existingAccount) {
    // 이미 할당된 계정이 있으면 재사용 (classin_uid 사용)
    const existingClassInUid = existingAccount.classin_uid || existingAccount.account_uid
    await db.prepare(`
      UPDATE enrollments
      SET classin_account_uid = ?, classin_account_password = ?, classin_assigned_at = datetime('now')
      WHERE id = ?
    `).bind(existingClassInUid, existingAccount.account_password, enrollmentId).run()

    console.log('Reusing existing account, ClassIn UID:', existingClassInUid)
    return {
      success: true,
      accountUid: existingAccount.account_uid,
      classInUid: existingClassInUid,
      password: existingAccount.account_password,
      isRegistered: existingAccount.is_registered === 1
    }
  }

  // 2. 할당된 계정이 없으면 새 계정 할당
  const availableAccount = await db.prepare(`
    SELECT * FROM classin_virtual_accounts
    WHERE status = 'available' AND (is_registered = 0 OR is_registered IS NULL) AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY id LIMIT 1
  `).first() as any

  if (!availableAccount) {
    return { success: false, error: '사용 가능한 가상 계정이 없습니다.' }
  }

  const password = availableAccount.account_password || generateDefaultPassword()
  let isRegistered = availableAccount.is_registered === 1
  // 기존에 저장된 classin_uid가 있으면 사용, 없으면 account_uid로 초기화
  let classInUid = availableAccount.classin_uid || availableAccount.account_uid

  // Register or update nickname with ClassIn API if configured
  if (classInConfig) {
    // 항상 registerVirtualAccount 호출 시도
    const regResult = await registerVirtualAccount(classInConfig, availableAccount.account_uid, userName, password)
    if (regResult.success && regResult.uid) {
      classInUid = regResult.uid
      isRegistered = true
      console.log('Got ClassIn UID from register:', classInUid, 'for account:', availableAccount.account_uid)
    } else if (availableAccount.classin_uid) {
      // register 실패했지만 기존 classin_uid가 있으면 사용
      classInUid = availableAccount.classin_uid
      console.log('Register failed, using existing ClassIn UID:', classInUid)
    } else {
      console.log('Register failed and no existing ClassIn UID:', regResult.error)
    }

    // 기관(school)에 학생 추가 (필수! 이것이 없으면 강의 배정 불가)
    const schoolResult = await addSchoolStudent(classInConfig, availableAccount.account_uid, userName)
    console.log('addSchoolStudent result:', JSON.stringify(schoolResult))

    // 이미 등록된 계정은 닉네임 업데이트 (register는 첫 등록 시에만 닉네임 적용)
    if (isRegistered && classInUid) {
      const editResult = await editUserInfo(classInConfig, classInUid, userName)
      if (editResult.success) {
        console.log('Updated nickname for account:', classInUid, '->', userName)
      } else {
        console.log('Failed to update nickname:', editResult.error)
      }
    }
  }

  // Update virtual account status (classin_uid도 저장)
  await db.prepare(`
    UPDATE classin_virtual_accounts
    SET user_id = ?, assigned_at = datetime('now'), assigned_name = ?,
        account_password = ?, is_registered = ?, classin_uid = ?, status = 'assigned', updated_at = datetime('now')
    WHERE id = ?
  `).bind(userId, userName, password, isRegistered ? 1 : 0, classInUid, availableAccount.id).run()

  // Update enrollment with ClassIn UID (실제 ClassIn UID 사용)
  await db.prepare(`
    UPDATE enrollments
    SET classin_account_uid = ?, classin_account_password = ?, classin_assigned_at = datetime('now')
    WHERE id = ?
  `).bind(classInUid, password, enrollmentId).run()

  console.log('Saved ClassIn UID to enrollment:', classInUid, 'for enrollmentId:', enrollmentId)

  return {
    success: true,
    accountUid: availableAccount.account_uid,
    classInUid,
    password,
    isRegistered
  }
}

// Return virtual account from enrollment (수강 종료 시 가상 계정 반납)
// 사용자의 다른 활성 수강권이나 구독이 있으면 반납하지 않음
async function returnVirtualAccountFromEnrollment(
  db: D1Database,
  enrollmentId: number
): Promise<{ success: boolean; error?: string; keptForOtherEnrollments?: boolean }> {
  // Get enrollment with user info
  const enrollment = await db.prepare(`
    SELECT e.user_id, e.classin_account_uid, e.subscription_id
    FROM enrollments e
    WHERE e.id = ? AND e.classin_account_uid != ''
  `).bind(enrollmentId).first() as any

  if (!enrollment || !enrollment.classin_account_uid) {
    return { success: false, error: '해당 수강에 할당된 가상 계정이 없습니다.' }
  }

  // Clear this enrollment's virtual account info first
  await db.prepare(`
    UPDATE enrollments
    SET classin_account_uid = '', classin_account_password = '', classin_returned_at = datetime('now')
    WHERE id = ?
  `).bind(enrollmentId).run()

  // Check if user has any other active enrollments using the same account
  const otherActiveEnrollments = await db.prepare(`
    SELECT COUNT(*) as cnt FROM enrollments
    WHERE user_id = ? AND id != ? AND status = 'active' AND classin_account_uid != ''
  `).bind(enrollment.user_id, enrollmentId).first() as any

  if (otherActiveEnrollments && otherActiveEnrollments.cnt > 0) {
    // 다른 활성 수강권이 있으면 계정 유지
    return { success: true, keptForOtherEnrollments: true }
  }

  // Check if user has any active subscriptions
  const activeSubscription = await db.prepare(`
    SELECT COUNT(*) as cnt FROM subscriptions
    WHERE user_id = ? AND status = 'active'
  `).bind(enrollment.user_id).first() as any

  if (activeSubscription && activeSubscription.cnt > 0) {
    // 활성 구독이 있으면 계정 유지
    return { success: true, keptForOtherEnrollments: true }
  }

  // No other active enrollments or subscriptions - return the account
  await db.prepare(`
    UPDATE classin_virtual_accounts
    SET user_id = NULL, assigned_at = NULL, assigned_name = '',
        account_password = '', is_registered = 0, status = 'available', updated_at = datetime('now')
    WHERE account_uid = ?
  `).bind(enrollment.classin_account_uid).run()

  return { success: true }
}

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
  else if (sort === 'newest') query += ` ORDER BY COALESCE((SELECT MAX(scheduled_at) FROM class_lessons WHERE class_id = c.id), c.created_at) DESC`
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
  const slug = decodeURIComponent(c.req.param('slug'))
  const cls: any = await c.env.DB.prepare(`
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

  // 다음 예정 강의 정보 (class_lessons 기준)
  const nextLesson = await c.env.DB.prepare(`
    SELECT * FROM class_lessons
    WHERE class_id = ? AND datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') > datetime('now')
    ORDER BY scheduled_at ASC LIMIT 1
  `).bind(cls.id).first()

  // 총 강의 수 및 완료된 강의 수
  const lessonStats = await c.env.DB.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'ended' OR datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') < datetime('now') THEN 1 ELSE 0 END) as completed
    FROM class_lessons WHERE class_id = ?
  `).bind(cls.id).first() as any

  cls.next_lesson = nextLesson
  cls.total_class_lessons = lessonStats?.total || 0
  cls.completed_class_lessons = lessonStats?.completed || 0

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
    WHERE r.class_id = ? ORDER BY r.created_at DESC LIMIT 100
  `).bind(id).all()
  return c.json(results)
})

// ===== Q&A 게시판 =====

// 수업 Q&A 목록 조회 (질문 + 답글 트리)
app.get('/api/classes/:id/comments', async (c) => {
  const classId = c.req.param('id')
  const { results } = await c.env.DB.prepare(`
    SELECT cc.*, u.name as user_name, u.avatar as user_avatar
    FROM class_comments cc JOIN users u ON cc.user_id = u.id
    WHERE cc.class_id = ? ORDER BY cc.created_at ASC
  `).bind(classId).all()

  const questions: any[] = []
  const replyMap: Record<number, any[]> = {}
  for (const row of results as any[]) {
    if (!row.parent_id) {
      questions.push({ ...row, replies: [] })
    } else {
      if (!replyMap[row.parent_id]) replyMap[row.parent_id] = []
      replyMap[row.parent_id].push(row)
    }
  }
  for (const q of questions) {
    q.replies = replyMap[q.id] || []
  }
  questions.reverse()
  return c.json(questions)
})

// Q&A 질문/답글 작성
app.post('/api/classes/:id/comments', async (c) => {
  const classId = c.req.param('id')
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: '로그인이 필요합니다.' }, 401)

  let payload: any
  try { payload = await verifyJWT(token, c.env.JWT_SECRET) } catch { return c.json({ error: '인증이 만료되었습니다.' }, 401) }

  const { content, parent_id } = await c.req.json()
  if (!content?.trim()) return c.json({ error: '내용을 입력해주세요.' }, 400)

  // 강사 여부 판별
  const cls = await c.env.DB.prepare('SELECT instructor_id FROM classes WHERE id = ?').bind(classId).first() as any
  if (!cls) return c.json({ error: '수업을 찾을 수 없습니다.' }, 404)
  const instructor = await c.env.DB.prepare('SELECT user_id FROM instructors WHERE id = ?').bind(cls.instructor_id).first() as any
  const isInstructor = instructor && instructor.user_id === payload.sub ? 1 : 0

  const result = await c.env.DB.prepare(
    'INSERT INTO class_comments (class_id, user_id, parent_id, content, is_instructor) VALUES (?, ?, ?, ?, ?)'
  ).bind(classId, payload.sub, parent_id || null, content.trim(), isInstructor).run()

  const user = await c.env.DB.prepare('SELECT name, avatar FROM users WHERE id = ?').bind(payload.sub).first() as any

  return c.json({
    id: result.meta.last_row_id,
    class_id: Number(classId),
    user_id: payload.sub,
    parent_id: parent_id || null,
    content: content.trim(),
    is_instructor: isInstructor,
    user_name: user?.name || '사용자',
    user_avatar: user?.avatar || null,
    created_at: new Date().toISOString(),
    replies: []
  })
})

// Q&A 댓글 삭제 (본인 또는 admin)
app.delete('/api/classes/:id/comments/:commentId', async (c) => {
  const commentId = c.req.param('commentId')
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: '로그인이 필요합니다.' }, 401)

  let payload: any
  try { payload = await verifyJWT(token, c.env.JWT_SECRET) } catch { return c.json({ error: '인증이 만료되었습니다.' }, 401) }

  const comment = await c.env.DB.prepare('SELECT user_id FROM class_comments WHERE id = ?').bind(commentId).first() as any
  if (!comment) return c.json({ error: '댓글을 찾을 수 없습니다.' }, 404)
  if (comment.user_id !== payload.sub && payload.role !== 'admin') return c.json({ error: '삭제 권한이 없습니다.' }, 403)

  await c.env.DB.prepare('DELETE FROM class_comments WHERE id = ? OR parent_id = ?').bind(commentId, commentId).run()
  return c.json({ success: true })
})

// Simple auth - login
app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  const user = await c.env.DB.prepare('SELECT id, email, name, avatar, role, is_instructor, subscription_plan, subscription_expires_at, is_test_account, test_expires_at, password_hash FROM users WHERE email = ?').bind(email).first() as any
  if (!user) return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401)

  const isValid = await verifyPassword(password, user.password_hash)
  if (!isValid) return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401)

  const token = await createJWT({ sub: user.id, email: user.email, role: user.role || 'user', is_instructor: user.is_instructor || 0, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }, c.env.JWT_SECRET)
  delete user.password_hash

  return c.json({ user, token })
})

// Simple auth - register
app.post('/api/auth/register', async (c) => {
  const { email, password, name, testCode } = await c.req.json()

  // 테스트 코드 검증 (CLASSIN-TEST-2024)
  const VALID_TEST_CODE = 'CLASSIN-TEST-2024'
  const isTestAccount = testCode?.toUpperCase() === VALID_TEST_CODE
  const testExpiresAt = isTestAccount
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    : null

  try {
    const passwordHash = await hashPassword(password)
    const result = await c.env.DB.prepare(
      'INSERT INTO users (email, password_hash, name, is_test_account, test_expires_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(email, passwordHash, name, isTestAccount ? 1 : 0, testExpiresAt).run()
    const userId = result.meta.last_row_id
    const user = await c.env.DB.prepare('SELECT id, email, name, avatar, role, is_instructor, is_test_account, test_expires_at FROM users WHERE id = ?').bind(userId).first() as any

    const token = await createJWT({ sub: user.id, email: user.email, role: user.role || 'user', is_instructor: user.is_instructor || 0, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }, c.env.JWT_SECRET)

    return c.json({
      user,
      token,
      testCodeApplied: isTestAccount,
      message: isTestAccount ? '테스트 코드가 적용되었습니다. 30일간 무료 수강 가능합니다!' : undefined
    })
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: '이미 등록된 이메일입니다.' }, 400)
    return c.json({ error: '회원가입에 실패했습니다.' }, 500)
  }
})

// Check if user is enrolled in a course
app.get('/api/enrollments/check', async (c) => {
  const userId = c.req.query('userId')
  const classId = c.req.query('classId')

  if (!userId || !classId) {
    return c.json({ error: 'userId and classId required' }, 400)
  }

  const enrollment = await c.env.DB.prepare(`
    SELECT id FROM enrollments
    WHERE user_id = ? AND class_id = ? AND status = 'active'
  `).bind(userId, classId).first()

  return c.json({ enrolled: !!enrollment })
})

// Get user enrollments (with next lesson info from class_lessons)
app.get('/api/user/:userId/enrollments', async (c) => {
  const userId = c.req.param('userId')
  const now = new Date().toISOString()

  // 수강 목록과 함께 각 코스의 다음 예정 강의, 최근 종료 강의 정보 포함
  // 학생용 입장 URL은 classin_sessions에서 가져옴 (uid 포함된 URL)
  const { results } = await c.env.DB.prepare(`
    SELECT e.*, c.title, c.slug, c.thumbnail, c.total_lessons, i.display_name as instructor_name,
           next_lesson.id as next_lesson_id,
           next_lesson.lesson_title as next_lesson_title,
           next_lesson.scheduled_at as next_lesson_scheduled_at,
           next_lesson.duration_minutes as next_lesson_duration,
           next_lesson.classin_course_id as next_lesson_course_id,
           next_lesson.classin_class_id as next_lesson_class_id,
           next_lesson.status as next_lesson_status,
           -- 학생용 입장: classin_sessions에서 세션 ID 가져오기 (동적 URL 생성용)
           (SELECT id FROM classin_sessions
            WHERE enrollment_id = e.id
              AND classin_course_id = next_lesson.classin_course_id
              AND classin_class_id = next_lesson.classin_class_id
            LIMIT 1) as next_lesson_session_id,
           -- 학생용 입장 URL: classin_sessions에서 해당 학생의 세션 찾기 (fallback용)
           (SELECT classin_join_url FROM classin_sessions
            WHERE enrollment_id = e.id
              AND classin_course_id = next_lesson.classin_course_id
              AND classin_class_id = next_lesson.classin_class_id
            LIMIT 1) as next_lesson_join_url,
           (SELECT COUNT(*) FROM class_lessons WHERE class_id = c.id) as total_lesson_count,
           (SELECT COUNT(*) FROM class_lessons WHERE class_id = c.id AND (status = 'ended' OR datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') < datetime('now'))) as completed_lesson_count
    FROM enrollments e
    JOIN classes c ON e.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    LEFT JOIN class_lessons next_lesson ON next_lesson.id = (
      SELECT id FROM class_lessons
      WHERE class_id = c.id
        AND datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') > datetime('now')
      ORDER BY scheduled_at ASC LIMIT 1
    )
    WHERE e.user_id = ? AND (e.status IS NULL OR e.status != 'cancelled')
    ORDER BY COALESCE(next_lesson.scheduled_at, e.enrolled_at) DESC
  `).bind(userId).all()
  return c.json(results)
})

// Get instructor's classes (강사가 개설한 코스 목록)
app.get('/api/user/:userId/instructor-classes', async (c) => {
  const userId = c.req.param('userId')

  // 사용자가 강사인지 확인하고 instructor_id 가져오기
  const instructor = await c.env.DB.prepare(`
    SELECT i.id FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE u.id = ? AND (u.role = 'instructor' OR u.is_instructor = 1)
  `).bind(userId).first() as any

  if (!instructor) {
    return c.json([])
  }

  // 강사의 코스 목록과 다음 예정 강의 정보
  const { results } = await c.env.DB.prepare(`
    SELECT c.*, cat.name as category_name,
           (SELECT COUNT(*) FROM enrollments WHERE class_id = c.id AND status = 'active') as active_students,
           next_lesson.id as next_lesson_id,
           next_lesson.lesson_title as next_lesson_title,
           next_lesson.scheduled_at as next_lesson_scheduled_at,
           next_lesson.duration_minutes as next_lesson_duration,
           next_lesson.classin_instructor_url as next_lesson_instructor_url,
           next_lesson.status as next_lesson_status,
           (SELECT COUNT(*) FROM class_lessons WHERE class_id = c.id) as total_lesson_count,
           (SELECT COUNT(*) FROM class_lessons WHERE class_id = c.id AND (status = 'ended' OR datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') < datetime('now'))) as completed_lesson_count
    FROM classes c
    LEFT JOIN categories cat ON c.category_id = cat.id
    LEFT JOIN class_lessons next_lesson ON next_lesson.id = (
      SELECT id FROM class_lessons
      WHERE class_id = c.id
        AND datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') > datetime('now')
      ORDER BY scheduled_at ASC LIMIT 1
    )
    WHERE c.instructor_id = ?
    ORDER BY COALESCE(next_lesson.scheduled_at, c.created_at) DESC
  `).bind(instructor.id).all()

  return c.json(results)
})

// Get user enrollments with all lesson details (for mypage)
app.get('/api/user/:userId/enrollments-with-lessons', async (c) => {
  const userId = c.req.param('userId')

  // 수강 목록
  const { results: enrollments } = await c.env.DB.prepare(`
    SELECT e.*, c.id as class_id, c.title, c.slug, c.thumbnail, c.price, i.display_name as instructor_name,
           s.status as subscription_status
    FROM enrollments e
    JOIN classes c ON e.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    LEFT JOIN subscriptions s ON s.user_id = e.user_id AND s.class_id = e.class_id AND s.status = 'active'
    WHERE e.user_id = ? AND e.status = 'active'
    ORDER BY e.enrolled_at DESC
  `).bind(userId).all()

  // 각 수강에 대한 강의 목록과 수강 여부 포함 (종료된 강의은 replay_url 가져오기)
  const now = Date.now()
  const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  const result = await Promise.all((enrollments as any[]).map(async (enrollment) => {
    const { results: lessons } = await c.env.DB.prepare(`
      SELECT cl.*,
             (SELECT id FROM classin_sessions WHERE enrollment_id = ? AND classin_class_id = cl.classin_class_id LIMIT 1) as session_id,
             (SELECT 1 FROM lesson_enrollments WHERE user_id = ? AND class_lesson_id = cl.id AND status = 'active') as is_enrolled
      FROM class_lessons cl
      WHERE cl.class_id = ?
      ORDER BY cl.scheduled_at ASC
    `).bind(enrollment.id, userId, enrollment.class_id).all() as { results: any[] }

    // 종료된 강의의 replay_url 처리
    for (const lesson of lessons) {
      const startTime = lesson.scheduled_at ? new Date(lesson.scheduled_at).getTime() : 0
      const duration = (lesson.duration_minutes || 60) * 60 * 1000
      const isEnded = startTime > 0 && (startTime + duration) < now

      if (isEnded && !lesson.replay_url && lesson.classin_course_id && lesson.classin_class_id && classInConfig) {
        try {
          const webcastResult = await getClassInWebcastUrl(classInConfig, lesson.classin_course_id, lesson.classin_class_id)
          if (webcastResult.url) {
            await c.env.DB.prepare(
              'UPDATE class_lessons SET replay_url = ?, updated_at = datetime("now") WHERE id = ?'
            ).bind(webcastResult.url, lesson.id).run()
            lesson.replay_url = webcastResult.url
          }
        } catch (e) {
          // ClassIn API 호출 실패 시 무시
        }
      }
    }

    return {
      ...enrollment,
      lessons: lessons
    }
  }))

  return c.json(result)
})

// Get instructor's classes with all lesson details (for instructor mypage)
app.get('/api/user/:userId/instructor-classes-with-lessons', async (c) => {
  const userId = c.req.param('userId')

  // 강사 확인
  const instructor = await c.env.DB.prepare(`
    SELECT i.id FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE u.id = ? AND (u.role = 'instructor' OR u.is_instructor = 1)
  `).bind(userId).first() as any

  if (!instructor) {
    return c.json([])
  }

  // 강사의 코스 목록
  const { results: courses } = await c.env.DB.prepare(`
    SELECT c.*, cat.name as category_name,
           (SELECT COUNT(*) FROM enrollments WHERE class_id = c.id AND status = 'active') as active_students
    FROM classes c
    LEFT JOIN categories cat ON c.category_id = cat.id
    WHERE c.instructor_id = ?
    ORDER BY c.created_at DESC
  `).bind(instructor.id).all()

  // 각 코스에 대한 강의 목록 포함 (종료된 강의은 replay_url 가져오기)
  const now = Date.now()
  const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  const result = await Promise.all((courses as any[]).map(async (course) => {
    const { results: lessons } = await c.env.DB.prepare(`
      SELECT * FROM class_lessons WHERE class_id = ? ORDER BY scheduled_at ASC
    `).bind(course.id).all() as { results: any[] }

    // 종료된 강의의 replay_url 처리
    for (const lesson of lessons) {
      const startTime = lesson.scheduled_at ? new Date(lesson.scheduled_at).getTime() : 0
      const duration = (lesson.duration_minutes || 60) * 60 * 1000
      const isEnded = startTime > 0 && (startTime + duration) < now

      if (isEnded && !lesson.replay_url && lesson.classin_course_id && lesson.classin_class_id && classInConfig) {
        try {
          const webcastResult = await getClassInWebcastUrl(classInConfig, lesson.classin_course_id, lesson.classin_class_id)
          if (webcastResult.url) {
            await c.env.DB.prepare(
              'UPDATE class_lessons SET replay_url = ?, updated_at = datetime("now") WHERE id = ?'
            ).bind(webcastResult.url, lesson.id).run()
            lesson.replay_url = webcastResult.url
          }
        } catch (e) {
          // ClassIn API 호출 실패 시 무시
        }
      }
    }

    return {
      ...course,
      lessons: lessons
    }
  }))

  return c.json(result)
})

// Instructor creates lessons for their course
app.post('/api/instructor/classes/:classId/create-sessions', async (c) => {
  const classId = parseInt(c.req.param('classId'))
  const { lessons, userId } = await c.req.json()

  // 강사 확인 (가상계정 포함)
  const instructor = await c.env.DB.prepare(`
    SELECT i.id, i.classin_uid, i.classin_virtual_account, i.display_name FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE u.id = ? AND (u.role = 'instructor' OR u.is_instructor = 1)
  `).bind(userId).first() as any

  if (!instructor) {
    return c.json({ error: '강사 권한이 없습니다.' }, 403)
  }

  // 코스 정보 조회 (classin_course_id 포함)
  const cls = await c.env.DB.prepare(`
    SELECT id, title, classin_course_id, duration_minutes FROM classes WHERE id = ? AND instructor_id = ?
  `).bind(classId, instructor.id).first() as any

  if (!cls) {
    return c.json({ error: '해당 코스에 대한 권한이 없습니다.' }, 403)
  }

  if (!Array.isArray(lessons) || lessons.length === 0) {
    return c.json({ error: '강의 정보가 필요합니다.' }, 400)
  }

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!config) {
    return c.json({ error: 'ClassIn API가 설정되지 않았습니다.' }, 500)
  }

  // 환경에 따라 가상계정 또는 실제 강사 계정 사용
  const useVirtualAccount = c.env.USE_INSTRUCTOR_VIRTUAL_ACCOUNT === 'true'

  let virtualAccount = ''
  let teacherUid = ''

  if (useVirtualAccount) {
    // T(teachers): 가상계정 사용
    virtualAccount = instructor.classin_virtual_account || ''

    if (!virtualAccount) {
      const available = await c.env.DB.prepare(`
        SELECT * FROM classin_virtual_accounts
        WHERE status = 'available' AND (is_registered = 0 OR is_registered IS NULL) AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY id LIMIT 1
      `).first() as any

      if (!available) {
        return c.json({ error: '사용 가능한 가상계정이 없습니다.' }, 400)
      }

      virtualAccount = available.account_uid

      // 강사에게 가상계정 할당
      await c.env.DB.prepare(`UPDATE instructors SET classin_virtual_account = ? WHERE id = ?`)
        .bind(virtualAccount, instructor.id).run()

      // 가상계정 상태 업데이트
      await c.env.DB.prepare(`
        UPDATE classin_virtual_accounts
        SET status = 'assigned', assigned_name = ?, assigned_at = datetime('now')
        WHERE id = ?
      `).bind('INSTRUCTOR:' + instructor.display_name, available.id).run()

      console.log('Assigned virtual account to instructor:', virtualAccount)
    }

    // 가상계정을 ClassIn에 등록하고 UID 획득
    const regResult = await registerVirtualAccount(config, virtualAccount, instructor.display_name || 'Instructor', INSTRUCTOR_DEFAULT_PASSWORD)
    console.log('Virtual account register result:', JSON.stringify(regResult))

    if (regResult.uid) {
      teacherUid = regResult.uid
      // 가상계정 UID 저장
      await c.env.DB.prepare(`
        UPDATE classin_virtual_accounts
        SET is_registered = 1, classin_uid = ?, updated_at = datetime('now')
        WHERE account_uid = ?
      `).bind(teacherUid, virtualAccount).run()
    } else {
      // 이미 등록된 경우 UID 조회
      const existingAccount = await c.env.DB.prepare(
        'SELECT classin_uid FROM classin_virtual_accounts WHERE account_uid = ?'
      ).bind(virtualAccount).first() as any
      teacherUid = existingAccount?.classin_uid || ''
    }

    if (!teacherUid) {
      return c.json({ error: '가상계정 등록 실패' }, 400)
    }

    console.log('Using virtual account as teacher:', virtualAccount, 'UID:', teacherUid)

    // 가상계정을 기관에 교사로 등록
    const addTeacherResult = await addTeacher(config, virtualAccount, instructor.display_name || 'Instructor')
    console.log('addTeacher result:', JSON.stringify(addTeacherResult))
    if (!addTeacherResult.success && !addTeacherResult.alreadyExists) {
      return c.json({ error: '가상계정 교사 등록 실패: ' + addTeacherResult.error }, 400)
    }
  } else {
    // L(live): 실제 강사 계정 사용
    if (!instructor.classin_uid) {
      return c.json({ error: '강사가 ClassIn에 등록되지 않았습니다.' }, 400)
    }
    teacherUid = instructor.classin_uid
    console.log('Using real instructor account, UID:', teacherUid)
  }

  // 1. 코스 - 기존 코스가 있으면 재사용, 없으면 새로 생성
  let courseId = cls.classin_course_id
  if (!courseId) {
    const courseResult = await createClassInCourse(config, cls.title, teacherUid)
    if (!courseResult.courseId) {
      return c.json({ error: '코스 생성 실패: ' + courseResult.error }, 500)
    }
    courseId = courseResult.courseId
    // 코스 ID를 classes 테이블에 저장
    await c.env.DB.prepare('UPDATE classes SET classin_course_id = ? WHERE id = ?').bind(courseId, classId).run()
  }

  // 2. 현재 강의 수 조회
  const lessonCountResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM class_lessons WHERE class_id = ?'
  ).bind(classId).first() as any
  let lessonNumber = (lessonCountResult?.count || 0)

  const createdLessons: any[] = []
  const errors: string[] = []

  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i]
    const scheduledAt = lesson.scheduledAt
    const durationMinutes = lesson.durationMinutes || cls.duration_minutes || 60

    if (!scheduledAt) {
      errors.push(`강의 ${i + 1}: 시작 시간이 필요합니다.`)
      continue
    }

    // 시간 검증: 최소 2분 후여야 함
    const scheduledTime = new Date(scheduledAt).getTime()
    const minTime = Date.now() + 2 * 60 * 1000
    if (scheduledTime < minTime) {
      errors.push(`강의 ${i + 1}: 시작 시간은 현재로부터 최소 2분 후여야 합니다.`)
      continue
    }

    lessonNumber++
    const lessonTitle = lesson.title || `${cls.title} #${lessonNumber}`

    // ClassIn 강의 생성
    const beginTime = Math.floor(scheduledTime / 1000)
    const endTime = beginTime + durationMinutes * 60

    const lessonResult = await createClassInLesson(
      config,
      courseId,
      lessonTitle,
      beginTime,
      endTime,
      teacherUid,
      { live: 1, record: 1 }
    )

    if (!lessonResult.classId) {
      errors.push(`${lessonTitle}: ClassIn 강의 생성 실패 - ${lessonResult.error}`)
      lessonNumber--
      continue
    }

    // 강사 입장 URL 생성
    const instructorUrlResult = await getClassInLoginUrl(config, teacherUid, courseId, lessonResult.classId, 1, 3)
    const instructorUrl = instructorUrlResult.url ||
      `https://www.eeo.cn/client/invoke/index.html?uid=${teacherUid}&classId=${lessonResult.classId}&courseId=${courseId}&schoolId=${config.SID}`

    // DB에 저장
    const result = await c.env.DB.prepare(`
      INSERT INTO class_lessons (class_id, lesson_number, lesson_title, classin_course_id, classin_class_id,
                                 classin_instructor_url, scheduled_at, duration_minutes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
    `).bind(classId, lessonNumber, lessonTitle, courseId, lessonResult.classId, instructorUrl, scheduledAt, durationMinutes).run()

    createdLessons.push({
      id: result.meta.last_row_id,
      lessonNumber,
      lessonTitle,
      classId: lessonResult.classId,
      scheduledAt,
      durationMinutes
    })
  }

  // classes 테이블 업데이트 (최신 강의 정보)
  if (createdLessons.length > 0) {
    const latestLesson = createdLessons[createdLessons.length - 1]
    await c.env.DB.prepare(`
      UPDATE classes
      SET classin_course_id = ?, classin_class_id = ?,
          classin_status = 'scheduled', lesson_count = ?
      WHERE id = ?
    `).bind(courseId, latestLesson.classId, lessonNumber, classId).run()
  }

  return c.json({
    success: true,
    message: `${createdLessons.length}개 강의가 생성되었습니다.`,
    courseId,
    createdLessons,
    errors: errors.length > 0 ? errors : undefined
  })
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

// Process payment (demo) - with ClassIn session auto-creation
app.post('/api/payment/process', async (c) => {
  const { userId, classId, lessonId, paymentMethod, cardNumber, cardExpiry, cardCvc, amount, orderType, subscriptionPlan } = await c.req.json()

  const last4 = cardNumber ? cardNumber.slice(-4) : '0000'
  const txId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

  // Create order
  const orderResult = await c.env.DB.prepare(`
    INSERT INTO orders (user_id, order_type, class_id, subscription_plan, amount, payment_method, payment_status, card_last4, transaction_id)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
  `).bind(userId, orderType || 'class', classId || null, subscriptionPlan || null, amount, paymentMethod || 'card', last4, txId).run()

  let classinSession: ClassInSessionResult | null = null
  let virtualAccountInfo: { accountUid: string; password: string; isRegistered: boolean } | null = null

  // 강의별 결제 처리
  if (orderType === 'lesson' && lessonId) {
    // Get lesson info
    const lessonInfo = await c.env.DB.prepare('SELECT * FROM class_lessons WHERE id = ?').bind(lessonId).first() as any
    const user = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first() as any
    const userName = user?.name || 'Student'

    // Create lesson enrollment
    await c.env.DB.prepare(`
      INSERT INTO lesson_enrollments (user_id, class_lesson_id, payment_id, status)
      VALUES (?, ?, ?, 'active')
      ON CONFLICT(user_id, class_lesson_id) DO UPDATE SET status = 'active'
    `).bind(userId, lessonId, orderResult.meta.last_row_id).run()

    // Also create a course enrollment if not exists (for accessing course info)
    if (lessonInfo?.class_id) {
      await c.env.DB.prepare(`
        INSERT INTO enrollments (user_id, class_id, status)
        VALUES (?, ?, 'active')
        ON CONFLICT(user_id, class_id) DO NOTHING
      `).bind(userId, lessonInfo.class_id).run()

      // Get enrollment ID
      const enrollment = await c.env.DB.prepare('SELECT id FROM enrollments WHERE user_id = ? AND class_id = ?').bind(userId, lessonInfo.class_id).first() as any

      const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
        ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
        : null

      // Assign virtual account
      if (enrollment?.id) {
        const assignResult = await assignVirtualAccountToEnrollment(
          c.env.DB,
          enrollment.id,
          userId,
          userName,
          classInConfig
        )
        if (assignResult.success) {
          virtualAccountInfo = {
            accountUid: assignResult.accountUid!,
            password: assignResult.password!,
            isRegistered: assignResult.isRegistered || false
          }
        }
      }

      // Create ClassIn session for this specific lesson if it has ClassIn info
      if (lessonInfo.classin_class_id && lessonInfo.classin_course_id) {
        classinSession = await createClassInSession(
          c.env.DB,
          lessonInfo.class_id,
          userId,
          enrollment?.id || 0,
          classInConfig || undefined,
          lessonId
        )
      }
    }

    return c.json({
      success: true,
      orderId: orderResult.meta.last_row_id,
      transactionId: txId,
      message: '강의 결제가 완료되었습니다!',
      virtualAccount: virtualAccountInfo,
      classinSession: classinSession ? {
        joinUrl: classinSession.joinUrl,
        classId: classinSession.classId,
        courseId: classinSession.courseId,
        isDemo: !c.env.CLASSIN_SID || classinSession.courseId?.startsWith('DEMO_'),
        error: classinSession.error,
        debugInfo: classinSession.debugInfo
      } : null
    })
  }

  // If class purchase, create enrollment + assign virtual account + ClassIn session
  if (classId) {
    // Get user and class info
    const user = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first() as any
    const userName = user?.name || 'Student'
    const classInfo = await c.env.DB.prepare('SELECT schedule_end FROM classes WHERE id = ?').bind(classId).first() as any

    // Create enrollment with expires_at (based on class end date)
    const expiresAt = classInfo?.schedule_end || null
    await c.env.DB.prepare(`
      INSERT INTO enrollments (user_id, class_id, expires_at, status)
      VALUES (?, ?, ?, 'active')
      ON CONFLICT(user_id, class_id) DO UPDATE SET expires_at = COALESCE(?, expires_at), status = 'active', updated_at = datetime('now')
    `).bind(userId, classId, expiresAt, expiresAt).run()

    // Get enrollment ID
    const enrollment = await c.env.DB.prepare('SELECT id FROM enrollments WHERE user_id = ? AND class_id = ?').bind(userId, classId).first() as any

    // Remove from cart
    await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ? AND class_id = ?').bind(userId, classId).run()
    // Update student count
    await c.env.DB.prepare('UPDATE classes SET current_students = current_students + 1 WHERE id = ?').bind(classId).run()

    const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
      ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
      : null

    // Assign virtual account to this enrollment
    if (enrollment?.id) {
      const assignResult = await assignVirtualAccountToEnrollment(
        c.env.DB,
        enrollment.id,
        userId,
        userName,
        classInConfig
      )
      if (assignResult.success) {
        virtualAccountInfo = {
          accountUid: assignResult.accountUid!,
          password: assignResult.password!,
          isRegistered: assignResult.isRegistered || false
        }
      }
    }

    // Create ClassIn session
    classinSession = await createClassInSession(
      c.env.DB,
      classId,
      userId,
      enrollment?.id || 0,
      classInConfig || undefined
    )
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
    message: '결제가 완료되었습니다!',
    virtualAccount: virtualAccountInfo,
    classinSession: classinSession ? {
      joinUrl: classinSession.joinUrl,
      classId: classinSession.classId,
      courseId: classinSession.courseId,
      isDemo: !c.env.CLASSIN_SID || classinSession.courseId?.startsWith('DEMO_'),
      error: classinSession.error,
      debugInfo: classinSession.debugInfo
    } : null
  })
})

// Get user orders
app.get('/api/user/:userId/orders', async (c) => {
  const userId = c.req.param('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT o.*, c.title as class_title, c.thumbnail as class_thumbnail
    FROM orders o
    LEFT JOIN classes c ON o.class_id = c.id
    WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 200
  `).bind(userId).all()
  return c.json(results)
})

// Get instructor details
app.get('/api/instructors/:id', async (c) => {
  const id = c.req.param('id')
  const instructorRow = await c.env.DB.prepare(`
    SELECT i.*, u.email FROM instructors i JOIN users u ON i.user_id = u.id WHERE i.id = ?
  `).bind(id).first()
  const { results: classes } = await c.env.DB.prepare(`
    SELECT c.*, cat.name as category_name FROM classes c JOIN categories cat ON c.category_id = cat.id WHERE c.instructor_id = ? AND c.status = 'active'
  `).bind(id).all()
  return c.json({ instructor: instructorRow, classes })
})

// ==================== Test Account API Routes ====================

// Activate test account with access code (테스트 계정 활성화)
app.post('/api/test-account/activate', async (c) => {
  const { userId, accessCode } = await c.req.json()

  if (!userId || !accessCode) {
    return c.json({ error: 'userId와 accessCode가 필요합니다.' }, 400)
  }

  // Check if code is valid
  const code = await c.env.DB.prepare(`
    SELECT * FROM test_access_codes
    WHERE code = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))
    AND (max_uses = 0 OR used_count < max_uses)
  `).bind(accessCode).first() as any

  if (!code) {
    return c.json({ error: '유효하지 않거나 만료된 테스트 코드입니다.' }, 400)
  }

  // Update user as test account (valid for 30 days)
  await c.env.DB.prepare(`
    UPDATE users SET is_test_account = 1, test_expires_at = datetime('now', '+30 days') WHERE id = ?
  `).bind(userId).run()

  // Increment code usage
  await c.env.DB.prepare(`
    UPDATE test_access_codes SET used_count = used_count + 1 WHERE id = ?
  `).bind(code.id).run()

  return c.json({
    success: true,
    message: '테스트 계정이 활성화되었습니다. 30일간 결제 없이 모든 기능을 이용할 수 있습니다.',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  })
})

// Check if user is test account
app.get('/api/user/:userId/test-status', async (c) => {
  const userId = c.req.param('userId')
  const user = await c.env.DB.prepare(`
    SELECT is_test_account, test_expires_at FROM users WHERE id = ?
  `).bind(userId).first() as any

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const isActive = user.is_test_account === 1 &&
    (!user.test_expires_at || new Date(user.test_expires_at) > new Date())

  return c.json({
    isTestAccount: isActive,
    expiresAt: user.test_expires_at
  })
})

// Test account lesson enrollment (테스트 계정 강의 등록)
app.post('/api/lesson-enroll/test', async (c) => {
  const { userId, lessonId } = await c.req.json()

  if (!userId || !lessonId) {
    return c.json({ error: 'userId와 lessonId가 필요합니다.' }, 400)
  }

  // Check if user is valid test account
  const user = await c.env.DB.prepare(`
    SELECT id, name, is_test_account, test_expires_at FROM users WHERE id = ?
  `).bind(userId).first() as any

  if (!user) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404)
  }

  const isTestActive = user.is_test_account === 1 &&
    (!user.test_expires_at || new Date(user.test_expires_at) > new Date())

  if (!isTestActive) {
    return c.json({ error: '테스트 계정이 아니거나 만료되었습니다.' }, 403)
  }

  // Get lesson info
  const lessonInfo = await c.env.DB.prepare('SELECT * FROM class_lessons WHERE id = ?').bind(lessonId).first() as any
  if (!lessonInfo) {
    return c.json({ error: '강의을 찾을 수 없습니다.' }, 404)
  }

  // Create lesson enrollment
  await c.env.DB.prepare(`
    INSERT INTO lesson_enrollments (user_id, class_lesson_id, status)
    VALUES (?, ?, 'active')
    ON CONFLICT(user_id, class_lesson_id) DO UPDATE SET status = 'active'
  `).bind(userId, lessonId).run()

  // Also create course enrollment if not exists
  if (lessonInfo.class_id) {
    await c.env.DB.prepare(`
      INSERT INTO enrollments (user_id, class_id, status)
      VALUES (?, ?, 'active')
      ON CONFLICT(user_id, class_id) DO NOTHING
    `).bind(userId, lessonInfo.class_id).run()
  }

  return c.json({
    success: true,
    message: '강의 수강 등록이 완료되었습니다. (테스트 계정)',
    lessonId: lessonId
  })
})

// Test account: Free enrollment (테스트 계정용 무료 수강신청)
app.post('/api/test-account/enroll', async (c) => {
  try {
    const { userId, classId } = await c.req.json()

    if (!userId || !classId) {
      return c.json({ error: 'userId와 classId가 필요합니다.' }, 400)
    }

    // Check if user is test account
    const user = await c.env.DB.prepare(`
      SELECT * FROM users WHERE id = ? AND is_test_account = 1
      AND (test_expires_at IS NULL OR test_expires_at > datetime('now'))
    `).bind(userId).first() as any

    if (!user) {
      return c.json({ error: '테스트 계정이 아니거나 만료되었습니다.' }, 403)
    }

    // Get class info for expires_at
    const classInfo = await c.env.DB.prepare('SELECT schedule_end FROM classes WHERE id = ?').bind(classId).first() as any
    const expiresAt = classInfo?.schedule_end || null

    // Check if already enrolled
    const existingEnrollment = await c.env.DB.prepare(
      'SELECT id, classin_account_uid FROM enrollments WHERE user_id = ? AND class_id = ?'
    ).bind(userId, classId).first() as any

    if (existingEnrollment) {
      // Already enrolled - check if session needs update for new class
      const classLatest = await c.env.DB.prepare(
        'SELECT classin_class_id FROM classes WHERE id = ?'
      ).bind(classId).first() as any

      const classinSession = await c.env.DB.prepare(
        'SELECT * FROM classin_sessions WHERE class_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1'
      ).bind(classId, userId).first() as any

      // 새 강의가 생성되었고 기존 session과 다른 경우 - 새 session 필요
      if (classLatest?.classin_class_id &&
          (!classinSession || classinSession.classin_class_id !== classLatest.classin_class_id)) {
        // 새 강의에 대한 session 생성
        const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
          ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
          : null

        const newSession = await createClassInSession(
          c.env.DB,
          classId,
          userId,
          existingEnrollment.id,
          classInConfig
        )

        return c.json({
          success: true,
          message: '새 강의에 등록되었습니다.',
          classinSession: newSession ? {
            joinUrl: newSession.joinUrl,
            classId: newSession.classId,
            isDemo: !c.env.CLASSIN_SID
          } : null
        })
      }

      // joinUrl이 비어있으면 재생성
      let joinUrl = classinSession?.classin_join_url || ''
      const studentUid = existingEnrollment?.classin_account_uid || ''
      if (!joinUrl && classinSession?.classin_class_id && classinSession?.classin_course_id) {
        const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
          ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
          : null
        if (classInConfig) {
          const baseUrl = `https://www.eeo.cn/client/invoke/index.html?classId=${classinSession.classin_class_id}&courseId=${classinSession.classin_course_id}&schoolId=${classInConfig.SID}`
          joinUrl = studentUid ? `${baseUrl}&uid=${studentUid}` : baseUrl
          // DB 업데이트
          await c.env.DB.prepare('UPDATE classin_sessions SET classin_join_url = ? WHERE id = ?')
            .bind(joinUrl, classinSession.id).run()
        }
      }

      return c.json({
        success: true,
        message: '이미 수강 중인 코스입니다.',
        classinSession: classinSession ? {
          joinUrl: joinUrl,
          classId: classinSession.classin_class_id,
          isDemo: !c.env.CLASSIN_SID
        } : null
      })
    }

    // Create enrollment with expires_at
    await c.env.DB.prepare(`
      INSERT INTO enrollments (user_id, class_id, expires_at, status)
      VALUES (?, ?, ?, 'active')
    `).bind(userId, classId, expiresAt).run()
    const enrollment = await c.env.DB.prepare('SELECT id FROM enrollments WHERE user_id = ? AND class_id = ?').bind(userId, classId).first() as any

    // Create test order (amount = 0)
    const txId = `TEST_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    await c.env.DB.prepare(`
      INSERT INTO orders (user_id, order_type, class_id, amount, payment_method, payment_status, transaction_id)
      VALUES (?, 'class', ?, 0, 'test', 'completed', ?)
    `).bind(userId, classId, txId).run()

    // Remove from cart if exists
    await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ? AND class_id = ?').bind(userId, classId).run()

    // Update student count
    await c.env.DB.prepare('UPDATE classes SET current_students = current_students + 1 WHERE id = ?').bind(classId).run()

    const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
      ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
      : null

    // Assign virtual account to this enrollment
    let virtualAccountInfo: { accountUid: string; password: string; isRegistered: boolean } | null = null
    if (enrollment?.id) {
      try {
        const assignResult = await assignVirtualAccountToEnrollment(
          c.env.DB,
          enrollment.id,
          userId,
          user.name || 'Student',
          classInConfig
        )
        if (assignResult.success) {
          virtualAccountInfo = {
            accountUid: assignResult.accountUid!,
            password: assignResult.password!,
            isRegistered: assignResult.isRegistered || false
          }
        }
      } catch (e) {
        console.error('Virtual account assignment error:', e)
      }
    }

    // Create ClassIn session
    let classinSession = null
    try {
      classinSession = await createClassInSession(
        c.env.DB,
        classId,
        userId,
        enrollment?.id || 0,
        classInConfig || undefined
      )
    } catch (e) {
      console.error('ClassIn session creation error:', e)
    }

    return c.json({
      success: true,
      message: '테스트 수강신청이 완료되었습니다!',
      transactionId: txId,
      virtualAccount: virtualAccountInfo,
      classinSession: classinSession ? {
        joinUrl: classinSession.joinUrl,
        classId: classinSession.classId,
        isDemo: !c.env.CLASSIN_SID
      } : null
    })
  } catch (e: any) {
    console.error('Test enroll error:', e)
    return c.json({ error: e.message || '수강신청 처리 중 오류가 발생했습니다.' }, 500)
  }
})

// Admin API authentication middleware
app.use('/api/admin/*', async (c, next) => {
  if (c.req.path === '/api/admin/login' && c.req.method === 'POST') {
    return next()
  }
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)
  if (!isLoggedIn) {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  }
  return next()
})

// Admin: Create test access code
app.post('/api/admin/test-codes/create', async (c) => {
  const { code, description, maxUses, expiresAt } = await c.req.json()

  const finalCode = code || `TEST-${Date.now().toString(36).toUpperCase()}`

  try {
    await c.env.DB.prepare(`
      INSERT INTO test_access_codes (code, description, max_uses, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind(finalCode, description || '', maxUses || 100, expiresAt || null).run()

    return c.json({ success: true, code: finalCode })
  } catch (e: any) {
    return c.json({ error: '코드 생성 실패: ' + e.message }, 500)
  }
})

// Admin: Get test access codes
app.get('/api/admin/test-codes', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM test_access_codes ORDER BY created_at DESC LIMIT 500').all()
  return c.json(results)
})

// ==================== ClassIn Virtual Account API Routes ====================

// End enrollment and return virtual account (관리자: 수강 종료 및 가상 계정 반납)
app.post('/api/admin/enrollments/:enrollmentId/end', async (c) => {
  const enrollmentId = parseInt(c.req.param('enrollmentId'))

  const enrollment = await c.env.DB.prepare('SELECT * FROM enrollments WHERE id = ?').bind(enrollmentId).first() as any
  if (!enrollment) {
    return c.json({ error: '수강 정보를 찾을 수 없습니다.' }, 404)
  }

  // Return virtual account
  const returnResult = await returnVirtualAccountFromEnrollment(c.env.DB, enrollmentId)

  // Mark enrollment as ended
  await c.env.DB.prepare(`
    UPDATE enrollments SET status = 'ended', updated_at = datetime('now') WHERE id = ?
  `).bind(enrollmentId).run()

  return c.json({
    success: true,
    message: '수강이 종료되고 가상 계정이 반납되었습니다.',
    virtualAccountReturned: returnResult.success
  })
})

// Process expired enrollments and return virtual accounts (만료된 수강권 자동 반납)
app.post('/api/admin/enrollments/process-expired', async (c) => {
  // Find expired enrollments with assigned virtual accounts
  const { results: expiredEnrollments } = await c.env.DB.prepare(`
    SELECT id, classin_account_uid FROM enrollments
    WHERE classin_account_uid != '' AND classin_returned_at IS NULL
    AND expires_at IS NOT NULL AND expires_at < datetime('now')
  `).all() as any

  let returnedCount = 0
  for (const enrollment of expiredEnrollments) {
    const result = await returnVirtualAccountFromEnrollment(c.env.DB, enrollment.id)
    if (result.success) returnedCount++

    // Mark enrollment as expired
    await c.env.DB.prepare(`
      UPDATE enrollments SET status = 'expired', updated_at = datetime('now') WHERE id = ?
    `).bind(enrollment.id).run()
  }

  return c.json({
    success: true,
    message: `${returnedCount}개의 만료된 수강권에서 가상 계정이 반납되었습니다.`,
    processedCount: expiredEnrollments.length,
    returnedCount
  })
})

// Initialize virtual accounts (관리자: 가상 계정 일괄 생성)
app.post('/api/admin/virtual-accounts/init', async (c) => {
  const { startUid, endUid, sid, expiresAt } = await c.req.json()

  if (!startUid || !endUid || !sid) {
    return c.json({ error: 'startUid, endUid, sid가 필요합니다.' }, 400)
  }

  // Parse UIDs: format "0065-20000532100"
  const prefix = startUid.split('-')[0] // "0065"
  const startNum = parseInt(startUid.split('-')[1]) // 20000532100
  const endNum = parseInt(endUid.split('-')[1]) // 20000532599

  if (isNaN(startNum) || isNaN(endNum) || endNum < startNum) {
    return c.json({ error: 'UID 범위가 올바르지 않습니다.' }, 400)
  }

  const count = endNum - startNum + 1
  let inserted = 0
  let skipped = 0

  // Insert in batches
  for (let i = startNum; i <= endNum; i++) {
    const accountUid = `${prefix}-${i}`
    try {
      await c.env.DB.prepare(`
        INSERT OR IGNORE INTO classin_virtual_accounts (account_uid, sid, status, expires_at)
        VALUES (?, ?, 'available', ?)
      `).bind(accountUid, sid, expiresAt || '2028-03-11 00:00:00').run()
      inserted++
    } catch (e) {
      skipped++
    }
  }

  return c.json({
    success: true,
    message: `${inserted}개의 가상 계정이 생성되었습니다.`,
    total: count,
    inserted,
    skipped
  })
})

// Get virtual accounts status (관리자: 가상 계정 현황)
app.get('/api/admin/virtual-accounts', async (c) => {
  const status = c.req.query('status')
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')

  let query = `SELECT * FROM classin_virtual_accounts`
  const params: any[] = []

  if (status) {
    query += ` WHERE status = ?`
    params.push(status)
  }

  query += ` ORDER BY id LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const { results } = await c.env.DB.prepare(query).bind(...params).all()

  // Get stats
  const stats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
      SUM(CASE WHEN is_registered = 1 THEN 1 ELSE 0 END) as registered
    FROM classin_virtual_accounts
  `).first() as any

  return c.json({ accounts: results, stats })
})

// Debug: Test ClassIn course creation API
app.post('/api/admin/debug/classin-course', async (c) => {
  const { courseName, teacherUid } = await c.req.json()

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!config) {
    return c.json({ error: 'ClassIn API not configured' }, 500)
  }

  const result = await createClassInCourse(config, courseName || 'Test Course', teacherUid)
  return c.json({
    config: { SID: config.SID, API_BASE: config.API_BASE },
    courseName: courseName || 'Test Course',
    teacherUid,
    result
  })
})

// Debug: Test createClassInSession flow
app.post('/api/admin/debug/classin-session', async (c) => {
  const { classId, userId, enrollmentId, runSession } = await c.req.json()

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  // Get class with instructor info
  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.user_id as instructor_user_id, i.id as instructor_id, i.classin_uid as instructor_classin_uid
    FROM classes c JOIN instructors i ON c.instructor_id = i.id WHERE c.id = ?
  `).bind(classId).first() as any

  // Get enrollment
  const enrollment = await c.env.DB.prepare(`
    SELECT * FROM enrollments WHERE id = ?
  `).bind(enrollmentId).first() as any

  let sessionResult = null
  if (runSession && config) {
    sessionResult = await createClassInSession(c.env.DB, classId, userId, enrollmentId, config)
  }

  return c.json({
    config: config ? { SID: config.SID, API_BASE: config.API_BASE } : null,
    classId,
    userId,
    enrollmentId,
    classData: cls ? {
      id: cls.id,
      title: cls.title,
      instructor_id: cls.instructor_id,
      instructor_classin_uid: cls.instructor_classin_uid
    } : null,
    enrollmentData: enrollment ? {
      id: enrollment.id,
      classin_account_uid: enrollment.classin_account_uid
    } : null,
    sessionResult
  })
})

// ==================== LMS API (createClassroom) 테스트 ====================

// LMS createClassroom API 호출 (테스트/디버그용)
async function lmsCreateClassroom(
  config: ClassInConfig,
  params: {
    courseId: number
    name: string
    teacherUid: number
    startTime: number
    endTime: number
    recordState?: number  // 0=off, 1=on (녹화)
    liveState?: number    // 0=off, 1=on (라이브 스트리밍)
    seatNum?: number
    isHd?: number
  }
): Promise<{ success: boolean; data?: any; error?: string; rawResponse?: any }> {
  const timestamp = Math.floor(Date.now() / 1000)

  const bodyParams = {
    courseId: params.courseId,
    name: params.name,
    teacherUid: params.teacherUid,
    startTime: params.startTime,
    endTime: params.endTime,
    // 녹화/스트리밍 파라미터는 세트로 전달해야 함
    recordState: params.recordState ?? 1,  // 1=녹화 활성화
    recordType: 2,                          // 2=클라우드 녹화
    liveState: params.liveState ?? 0,       // 0=라이브 스트리밍 비활성화
    openState: 1,                           // 1=웹 다시보기 활성화
    seatNum: params.seatNum ?? 7,
    isHd: params.isHd ?? 1
  }

  const signature = await generateLmsSignature(bodyParams, config.SID, config.SECRET, timestamp)

  try {
    const res = await fetch(`${config.API_BASE}/lms/activity/createClass`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EEO-SIGN': signature,
        'X-EEO-UID': config.SID,
        'X-EEO-TS': timestamp.toString()
      },
      body: JSON.stringify(bodyParams)
    })

    const data = await res.json() as any
    console.log('LMS createClassroom response:', JSON.stringify(data))

    if (data.code === 1) {
      return {
        success: true,
        data: {
          activityId: data.data?.activityId,
          classId: data.data?.classId,
          name: data.data?.name,
          liveUrl: data.data?.live_url,
          liveInfo: data.data?.live_info
        },
        rawResponse: data
      }
    }

    return { success: false, error: data.msg || 'Unknown error', rawResponse: data }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// Debug: LMS createClassroom API 테스트
app.post('/api/admin/debug/lms-classroom', async (c) => {
  const { courseId, name, teacherUid, startTime, endTime, recordState, liveState } = await c.req.json()

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!config) {
    return c.json({ error: 'ClassIn API not configured' }, 500)
  }

  if (!courseId || !name || !teacherUid || !startTime || !endTime) {
    return c.json({
      error: 'Required parameters: courseId, name, teacherUid, startTime, endTime',
      example: {
        courseId: 12345,
        name: '테스트 강의',
        teacherUid: 67890,
        startTime: Math.floor(Date.now() / 1000) + 300,  // 5분 후
        endTime: Math.floor(Date.now() / 1000) + 3900,   // 65분 후
        recordState: 1,  // 녹화 활성화
        liveState: 0     // 라이브 스트리밍 비활성화
      }
    }, 400)
  }

  const result = await lmsCreateClassroom(config, {
    courseId,
    name,
    teacherUid,
    startTime,
    endTime,
    recordState: recordState ?? 1,
    liveState: liveState ?? 0
  })

  return c.json({
    api: 'LMS createClassroom',
    endpoint: '/lms/activity/createClass',
    params: { courseId, name, teacherUid, startTime, endTime, recordState, liveState },
    result
  })
})

// Debug: 녹화 재생 URL 조회 테스트
app.post('/api/admin/debug/webcast-url', async (c) => {
  const { courseId, classId } = await c.req.json()

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!config) {
    return c.json({ error: 'ClassIn API not configured' }, 500)
  }

  if (!courseId) {
    return c.json({ error: 'courseId is required' }, 400)
  }

  const result = await getClassInWebcastUrl(config, courseId, classId)

  return c.json({
    api: 'getWebcastUrl',
    endpoint: '/partner/api/course.api.php?action=getWebcastUrl',
    params: { courseId, classId },
    result
  })
})

// Debug: getLoginLinked API 테스트 (강사/학생 입장 URL)
app.post('/api/admin/debug/login-linked', async (c) => {
  const { uid, courseId, classId, deviceType } = await c.req.json()

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!config) {
    return c.json({ error: 'ClassIn API not configured' }, 500)
  }

  if (!uid || !courseId || !classId) {
    return c.json({ error: 'uid, courseId, classId are required' }, 400)
  }

  // Step 1: addCourseTeacher 호출 (강사인 경우)
  const teacherResult = await addTeacherToCourse(config, courseId, uid)

  // Step 2: getLoginLinked 호출 (identity: 1=학생, 2=청강생, 3=강사)
  const identity = 3  // 강사로 테스트
  const result = await getClassInLoginUrl(config, uid, courseId, classId, deviceType || 1, identity)

  return c.json({
    api: 'getLoginLinked',
    endpoint: '/partner/api/course.api.php?action=getLoginLinked',
    params: { uid, courseId, classId, deviceType: deviceType || 1, identity },
    addCourseTeacherResult: teacherResult,
    getLoginLinkedResult: result
  })
})

// ==================== Cloudflare Stream 강의 관리 API ====================

// 관리자: Stream 업로드 URL 발급
app.post('/api/admin/stream/upload-url', async (c) => {
  const { maxDurationSeconds } = await c.req.json().catch(() => ({}))

  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_STREAM_TOKEN) {
    return c.json({ error: 'Cloudflare Stream이 설정되지 않았습니다. CF_ACCOUNT_ID와 CF_STREAM_TOKEN을 설정해주세요.' }, 500)
  }

  const config: StreamConfig = {
    accountId: c.env.CF_ACCOUNT_ID,
    apiToken: c.env.CF_STREAM_TOKEN
  }

  const result = await getStreamUploadUrl(config, {
    maxDurationSeconds: maxDurationSeconds || 7200,  // 기본 2시간
    requireSignedURLs: false  // 서명 키 미설정 시 false로
  })

  if (result.error) {
    return c.json({ error: result.error }, 500)
  }

  return c.json({
    uploadURL: result.uploadURL,
    uid: result.uid
  })
})

// 관리자: TUS resumable 업로드 URL 발급 (대용량 파일용)
app.post('/api/admin/stream/tus-upload-url', async (c) => {
  const { uploadLength, filename } = await c.req.json()

  if (!uploadLength || !filename) {
    return c.json({ error: 'uploadLength와 filename이 필요합니다.' }, 400)
  }

  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_STREAM_TOKEN) {
    return c.json({ error: 'Cloudflare Stream이 설정되지 않았습니다.' }, 500)
  }

  try {
    // Cloudflare Stream TUS 엔드포인트에 업로드 생성 요청
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/stream?direct_user=true`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.CF_STREAM_TOKEN}`,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': uploadLength.toString(),
          'Upload-Metadata': `name ${btoa(filename)}, requiresignedurls ${btoa('false')}, maxDurationSeconds ${btoa('7200')}`
        }
      }
    )

    console.log('TUS init response status:', response.status)

    if (!response.ok) {
      const errText = await response.text()
      console.error('TUS init failed:', errText)
      return c.json({ error: 'TUS 업로드 생성 실패: ' + response.status }, 500)
    }

    const location = response.headers.get('location')
    const streamMediaId = response.headers.get('stream-media-id')

    console.log('TUS upload URL:', location, 'Media ID:', streamMediaId)

    if (!location) {
      return c.json({ error: 'TUS 업로드 URL을 받지 못했습니다.' }, 500)
    }

    return c.json({
      uploadURL: location,
      uid: streamMediaId
    })
  } catch (error: any) {
    console.error('TUS URL error:', error)
    return c.json({ error: error.message || 'TUS URL 발급 실패' }, 500)
  }
})

// ==================== 청크 업로드 API (레거시 - 사용하지 않음) ====================
const CHUNK_SIZE = 25 * 1024 * 1024 // 25MB (Cloudflare Pages 제한)

// 청크 업로드 초기화
app.post('/api/admin/stream/init-chunked-upload', async (c) => {
  const { filename, totalSize, totalChunks } = await c.req.json()

  if (!filename || !totalSize || !totalChunks) {
    return c.json({ error: 'filename, totalSize, totalChunks가 필요합니다.' }, 400)
  }

  // 고유 uploadId 생성
  const uploadId = crypto.randomUUID()

  // DB에 업로드 세션 저장
  await c.env.DB.prepare(`
    INSERT INTO chunked_uploads (upload_id, filename, total_size, total_chunks, status)
    VALUES (?, ?, ?, ?, 'uploading')
  `).bind(uploadId, filename, totalSize, totalChunks).run()

  return c.json({
    uploadId,
    chunkSize: CHUNK_SIZE
  })
})

// 개별 청크 업로드
app.post('/api/admin/stream/upload-chunk', async (c) => {
  const formData = await c.req.formData()
  const uploadId = formData.get('uploadId') as string
  const chunkIndex = parseInt(formData.get('chunkIndex') as string)
  const chunk = formData.get('chunk') as File

  if (!uploadId || isNaN(chunkIndex) || !chunk) {
    return c.json({ error: 'uploadId, chunkIndex, chunk가 필요합니다.' }, 400)
  }

  // 업로드 세션 확인
  const session = await c.env.DB.prepare(
    'SELECT * FROM chunked_uploads WHERE upload_id = ?'
  ).bind(uploadId).first() as any

  if (!session) {
    return c.json({ error: '업로드 세션을 찾을 수 없습니다.' }, 404)
  }

  if (session.status !== 'uploading') {
    return c.json({ error: '이미 완료되었거나 실패한 업로드입니다.' }, 400)
  }

  // R2에 청크 저장 (chunks/{uploadId}/{00000, 00001, ...})
  const chunkKey = `chunks/${uploadId}/${chunkIndex.toString().padStart(5, '0')}`
  const arrayBuffer = await chunk.arrayBuffer()
  await c.env.IMAGES.put(chunkKey, arrayBuffer)

  // DB 업데이트 (업로드된 청크 수 증가)
  await c.env.DB.prepare(`
    UPDATE chunked_uploads
    SET uploaded_chunks = uploaded_chunks + 1, updated_at = datetime('now')
    WHERE upload_id = ?
  `).bind(uploadId).run()

  return c.json({
    success: true,
    chunkIndex,
    chunkKey
  })
})

// 청크 병합 및 Stream 업로드 완료
app.post('/api/admin/stream/complete-chunked-upload', async (c) => {
  const { uploadId } = await c.req.json()

  if (!uploadId) {
    return c.json({ error: 'uploadId가 필요합니다.' }, 400)
  }

  // 업로드 세션 확인
  const session = await c.env.DB.prepare(
    'SELECT * FROM chunked_uploads WHERE upload_id = ?'
  ).bind(uploadId).first() as any

  if (!session) {
    return c.json({ error: '업로드 세션을 찾을 수 없습니다.' }, 404)
  }

  if (session.uploaded_chunks < session.total_chunks) {
    return c.json({
      error: `모든 청크가 업로드되지 않았습니다. (${session.uploaded_chunks}/${session.total_chunks})`
    }, 400)
  }

  // 상태를 merging으로 변경
  await c.env.DB.prepare(`
    UPDATE chunked_uploads SET status = 'merging', updated_at = datetime('now') WHERE upload_id = ?
  `).bind(uploadId).run()

  try {
    // Stream 설정 확인
    if (!c.env.CF_ACCOUNT_ID || !c.env.CF_STREAM_TOKEN) {
      throw new Error('Cloudflare Stream이 설정되지 않았습니다.')
    }

    // Stream 업로드 URL 발급
    const streamUrlRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/stream/direct_upload`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.CF_STREAM_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          maxDurationSeconds: 7200,
          requireSignedURLs: false
        })
      }
    )
    const streamUrlData = await streamUrlRes.json() as any
    if (!streamUrlData.success || !streamUrlData.result?.uploadURL) {
      throw new Error('Stream 업로드 URL 발급 실패')
    }

    const streamUploadURL = streamUrlData.result.uploadURL
    const streamUid = streamUrlData.result.uid

    // R2에서 청크들을 읽어서 병합 후 Stream에 업로드
    // ReadableStream을 사용하여 메모리 효율적으로 처리
    const chunks: ArrayBuffer[] = []
    for (let i = 0; i < session.total_chunks; i++) {
      const chunkKey = `chunks/${uploadId}/${i.toString().padStart(5, '0')}`
      const chunkObj = await c.env.IMAGES.get(chunkKey)
      if (!chunkObj) {
        throw new Error(`청크 ${i}를 찾을 수 없습니다.`)
      }
      chunks.push(await chunkObj.arrayBuffer())
    }

    // 청크들을 하나의 Blob으로 병합
    const mergedBlob = new Blob(chunks)

    // Stream API에 업로드
    const formData = new FormData()
    formData.append('file', mergedBlob, session.filename)

    const uploadRes = await fetch(streamUploadURL, {
      method: 'POST',
      body: formData
    })

    if (!uploadRes.ok) {
      throw new Error(`Stream 업로드 실패: ${uploadRes.status}`)
    }

    // 임시 청크 파일들 삭제
    for (let i = 0; i < session.total_chunks; i++) {
      const chunkKey = `chunks/${uploadId}/${i.toString().padStart(5, '0')}`
      await c.env.IMAGES.delete(chunkKey)
    }

    // DB 업데이트 (완료)
    await c.env.DB.prepare(`
      UPDATE chunked_uploads
      SET status = 'completed', stream_uid = ?, updated_at = datetime('now')
      WHERE upload_id = ?
    `).bind(streamUid, uploadId).run()

    return c.json({
      success: true,
      streamUid,
      message: '청크 업로드가 완료되었습니다.'
    })

  } catch (error: any) {
    // 실패 시 상태 업데이트
    await c.env.DB.prepare(`
      UPDATE chunked_uploads SET status = 'failed', updated_at = datetime('now') WHERE upload_id = ?
    `).bind(uploadId).run()

    console.error('Chunked upload complete error:', error)
    return c.json({ error: error.message || '청크 병합 중 오류가 발생했습니다.' }, 500)
  }
})

// 청크 업로드 상태 조회
app.get('/api/admin/stream/chunked-upload-status/:uploadId', async (c) => {
  const uploadId = c.req.param('uploadId')

  const session = await c.env.DB.prepare(
    'SELECT * FROM chunked_uploads WHERE upload_id = ?'
  ).bind(uploadId).first() as any

  if (!session) {
    return c.json({ error: '업로드 세션을 찾을 수 없습니다.' }, 404)
  }

  return c.json({
    uploadId: session.upload_id,
    filename: session.filename,
    totalSize: session.total_size,
    totalChunks: session.total_chunks,
    uploadedChunks: session.uploaded_chunks,
    status: session.status,
    streamUid: session.stream_uid,
    progress: Math.round((session.uploaded_chunks / session.total_chunks) * 100)
  })
})

// 관리자: 녹화 강의 생성
app.post('/api/admin/classes/:classId/create-recorded-lesson', async (c) => {
  const classId = parseInt(c.req.param('classId'))
  const { title, streamUid, description, curriculumItems, materials } = await c.req.json()

  if (!streamUid) {
    return c.json({ error: '동영상 UID(streamUid)가 필요합니다.' }, 400)
  }

  // Stream 정보 조회 (duration 등)
  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_STREAM_TOKEN) {
    return c.json({ error: 'Cloudflare Stream이 설정되지 않았습니다.' }, 500)
  }

  const streamConfig: StreamConfig = {
    accountId: c.env.CF_ACCOUNT_ID,
    apiToken: c.env.CF_STREAM_TOKEN
  }

  const videoInfo = await getStreamVideoInfo(streamConfig, streamUid)
  // 동영상 정보 조회 실패해도 일단 생성 허용 (나중에 업데이트)
  const isVideoReady = !videoInfo.error && videoInfo.status === 'ready'
  const isProcessing = !videoInfo.error && videoInfo.status !== 'ready'

  // 코스 정보 조회
  const cls = await c.env.DB.prepare(
    'SELECT * FROM classes WHERE id = ?'
  ).bind(classId).first() as any

  if (!cls) {
    return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)
  }

  // 강의 번호 계산
  const lessonCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM class_lessons WHERE class_id = ?'
  ).bind(classId).first() as any
  const lessonNumber = (lessonCount?.count || 0) + 1
  const lessonTitle = title || `${cls.title} #${lessonNumber}`

  // duration을 분 단위로 변환 (처리 중이면 0)
  const durationMinutes = isVideoReady ? Math.ceil((videoInfo.duration || 0) / 60) : 0
  const lessonStatus = isProcessing ? 'processing' : 'ready'

  // class_lessons에 저장
  const desc = description || ''
  const currItems = JSON.stringify(curriculumItems || [])
  const mats = JSON.stringify(materials || [])

  const result = await c.env.DB.prepare(`
    INSERT INTO class_lessons (
      class_id, lesson_number, lesson_title,
      lesson_type, stream_uid, stream_url, stream_thumbnail,
      duration_minutes, status, scheduled_at,
      description, curriculum_items, materials
    ) VALUES (?, ?, ?, 'recorded', ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
  `).bind(
    classId,
    lessonNumber,
    lessonTitle,
    streamUid,
    isVideoReady ? (videoInfo.playback?.hls || '') : '',
    isVideoReady ? (videoInfo.thumbnail || '') : '',
    durationMinutes,
    lessonStatus,
    desc, currItems, mats
  ).run()

  // classes 테이블 업데이트
  await c.env.DB.prepare(`
    UPDATE classes SET lesson_count = lesson_count + 1, updated_at = datetime('now') WHERE id = ?
  `).bind(classId).run()

  const statusMessage = isProcessing
    ? `녹화 강의 "${lessonTitle}"이 생성되었습니다. (동영상 처리 중 - 잠시 후 자동 업데이트됩니다)`
    : `녹화 강의 "${lessonTitle}"이 생성되었습니다.`

  return c.json({
    success: true,
    message: statusMessage,
    isProcessing,
    lessonId: result.meta?.last_row_id,
    lessonNumber,
    lessonTitle,
    durationMinutes,
    streamUid,
    thumbnail: videoInfo.thumbnail
  })
})

// 관리자: 비디오 설정 수정 (서명 요구 끄기)
app.post('/api/admin/stream/fix-video/:videoUid', async (c) => {
  const videoUid = c.req.param('videoUid')

  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_STREAM_TOKEN) {
    return c.json({ error: 'Cloudflare Stream이 설정되지 않았습니다.' }, 500)
  }

  // Cloudflare Stream API로 비디오 설정 업데이트
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/stream/${videoUid}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.CF_STREAM_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requireSignedURLs: false })
      }
    )

    const data = await response.json() as any
    console.log('Fix video response:', JSON.stringify(data))

    if (data.success) {
      return c.json({
        success: true,
        message: '비디오 설정이 업데이트되었습니다.',
        video: {
          uid: data.result?.uid,
          requireSignedURLs: data.result?.requireSignedURLs
        }
      })
    }
    return c.json({
      error: data.errors?.[0]?.message || 'Failed to update video',
      details: data
    }, 400)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// 관리자: 비디오 정보 조회 (디버그용)
app.get('/api/admin/stream/info/:videoUid', async (c) => {
  const videoUid = c.req.param('videoUid')

  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_STREAM_TOKEN) {
    return c.json({ error: 'Cloudflare Stream이 설정되지 않았습니다.' }, 500)
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/stream/${videoUid}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${c.env.CF_STREAM_TOKEN}`
        }
      }
    )

    const data = await response.json() as any
    return c.json(data)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// Webhook: Cloudflare Stream 이벤트 처리
app.post('/api/webhooks/cloudflare-stream', async (c) => {
  try {
    const event = await c.req.json()
    console.log('Stream webhook event:', JSON.stringify(event))

    // video.ready 이벤트 처리
    if (event.type === 'stream.video.ready' || event.type === 'video.ready') {
      const videoUid = event.uid || event.video?.uid
      const duration = event.duration || event.video?.duration

      if (videoUid && duration) {
        // stream_uid로 강의 찾아서 duration 업데이트
        const durationMinutes = Math.ceil(duration / 60)

        await c.env.DB.prepare(`
          UPDATE class_lessons
          SET duration_minutes = ?, status = 'ready', updated_at = datetime('now')
          WHERE stream_uid = ?
        `).bind(durationMinutes, videoUid).run()

        console.log(`Updated lesson with stream_uid ${videoUid}: duration=${durationMinutes}min`)
      }
    }

    return c.json({ received: true })
  } catch (e: any) {
    console.error('Stream webhook error:', e)
    return c.json({ error: e.message }, 500)
  }
})

// 강의 비디오 상태 확인 및 업데이트 (처리 중인 강의용)
app.post('/api/lessons/:lessonId/check-status', async (c) => {
  const lessonId = parseInt(c.req.param('lessonId'))

  // 강의 정보 조회
  const lesson = await c.env.DB.prepare(`
    SELECT * FROM class_lessons WHERE id = ?
  `).bind(lessonId).first() as any

  if (!lesson) {
    return c.json({ error: '강의를 찾을 수 없습니다.' }, 404)
  }

  if (lesson.lesson_type !== 'recorded' || !lesson.stream_uid) {
    return c.json({ error: '녹화 강의가 아닙니다.' }, 400)
  }

  if (lesson.status === 'ready') {
    return c.json({ status: 'ready', message: '이미 준비 완료된 강의입니다.' })
  }

  // Cloudflare Stream 상태 확인
  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_STREAM_TOKEN) {
    return c.json({ error: 'Stream 설정이 없습니다.' }, 500)
  }

  const streamConfig: StreamConfig = {
    accountId: c.env.CF_ACCOUNT_ID,
    apiToken: c.env.CF_STREAM_TOKEN
  }

  const videoInfo = await getStreamVideoInfo(streamConfig, lesson.stream_uid)

  if (videoInfo.error) {
    return c.json({ status: 'error', error: videoInfo.error })
  }

  if (videoInfo.status === 'ready') {
    // 비디오 설정 업데이트 (서명 요구 끄기)
    await updateStreamVideoSettings(streamConfig, lesson.stream_uid, { requireSignedURLs: false })

    // 준비 완료됨 - DB 업데이트
    const durationMinutes = Math.ceil((videoInfo.duration || 0) / 60)
    await c.env.DB.prepare(`
      UPDATE class_lessons
      SET status = 'ready',
          stream_url = ?,
          stream_thumbnail = ?,
          duration_minutes = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      videoInfo.playback?.hls || '',
      videoInfo.thumbnail || '',
      durationMinutes,
      lessonId
    ).run()

    return c.json({
      status: 'ready',
      message: '비디오 처리가 완료되었습니다!',
      durationMinutes
    })
  }

  return c.json({
    status: videoInfo.status || 'processing',
    message: '아직 처리 중입니다. 잠시 후 다시 확인해주세요.'
  })
})

// 녹화 강의 재생 URL 조회 (강사/관리자/무료/결제자 허용)
app.get('/api/lessons/:lessonId/stream-url', async (c) => {
  const lessonId = parseInt(c.req.param('lessonId'))
  const authHeader = c.req.header('Authorization')

  if (!authHeader) {
    return c.json({ error: '인증이 필요합니다.' }, 401)
  }

  const token = authHeader.replace('Bearer ', '')
  const jwtPayload = await verifyJWT(token, c.env.JWT_SECRET)
  if (!jwtPayload) {
    return c.json({ error: '유효하지 않은 토큰입니다.' }, 401)
  }
  const userId: number = jwtPayload.sub
  const userRole: string = jwtPayload.role || 'user'

  // 강의 정보 조회 (강사 ID 포함)
  const lesson = await c.env.DB.prepare(`
    SELECT cl.*, c.price as course_price, c.instructor_id,
           i.user_id as instructor_user_id
    FROM class_lessons cl
    JOIN classes c ON cl.class_id = c.id
    LEFT JOIN instructors i ON c.instructor_id = i.id
    WHERE cl.id = ?
  `).bind(lessonId).first() as any

  if (!lesson) {
    return c.json({ error: '강의를 찾을 수 없습니다.' }, 404)
  }

  // lesson_type이 'recorded'이거나 stream_uid가 있으면 녹화 강의로 처리
  if (lesson.lesson_type !== 'recorded' && !lesson.stream_uid) {
    return c.json({ error: '녹화 강의가 아닙니다.' }, 400)
  }

  // 관리자 또는 강사(코스 소유자)는 바로 접근 가능
  const isAdmin = userRole === 'admin'
  const isInstructor = userRole === 'instructor' && lesson.instructor_user_id === userId

  // 무료 코스인 경우 결제 확인 생략
  const isFree = !lesson.course_price

  // 관리자/강사/무료 코스는 결제 확인 없이 바로 재생
  if (!isAdmin && !isInstructor && !isFree) {
    // 코스 결제 확인
    const courseEnrollment = await c.env.DB.prepare(`
      SELECT * FROM enrollments
      WHERE user_id = ? AND class_id = ? AND status = 'active'
    `).bind(userId, lesson.class_id).first()

    if (!courseEnrollment) {
      return c.json({
        error: '코스 결제가 필요합니다.',
        requirePayment: true,
        coursePrice: lesson.course_price
      }, 403)
    }
  }

  // 서명된 URL 생성
  if (!c.env.CF_ACCOUNT_ID) {
    return c.json({ error: 'Cloudflare Stream이 설정되지 않았습니다.' }, 500)
  }

  const streamConfig: StreamConfig = {
    accountId: c.env.CF_ACCOUNT_ID,
    apiToken: c.env.CF_STREAM_TOKEN || '',
    signingKeyId: c.env.CF_STREAM_SIGNING_KEY_ID,
    signingKeyJwk: c.env.CF_STREAM_SIGNING_KEY_JWK
  }

  // 비디오 상태 먼저 확인
  try {
    const statusRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${streamConfig.accountId}/stream/${lesson.stream_uid}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${streamConfig.apiToken}` }
      }
    )
    const statusData = await statusRes.json() as any

    if (!statusData.success) {
      return c.json({ error: '비디오 정보를 가져올 수 없습니다.' }, 500)
    }

    const videoStatus = statusData.result?.status?.state
    if (videoStatus === 'pendingupload' || videoStatus === 'downloading' || videoStatus === 'queued' || videoStatus === 'inprogress') {
      return c.json({
        error: '비디오가 아직 처리 중입니다. 잠시 후 다시 시도해주세요.',
        processing: true,
        status: videoStatus,
        pctComplete: statusData.result?.status?.pctComplete
      }, 202)
    }

    if (videoStatus === 'error') {
      return c.json({ error: '비디오 처리 중 오류가 발생했습니다.' }, 500)
    }

    // readyToStream 확인
    if (!statusData.result?.readyToStream) {
      return c.json({
        error: '비디오가 아직 준비 중입니다. 잠시 후 다시 시도해주세요.',
        processing: true
      }, 202)
    }
  } catch (e: any) {
    console.error('Video status check error:', e)
    // 상태 확인 실패해도 URL 생성 시도
  }

  // 서명 키가 없으면 비디오 설정을 업데이트하여 서명 요구 끄기
  if (!streamConfig.signingKeyId || !streamConfig.signingKeyJwk) {
    await updateStreamVideoSettings(streamConfig, lesson.stream_uid, { requireSignedURLs: false })
  }

  const signedUrl = await getSignedStreamUrl(streamConfig, lesson.stream_uid, 3600)

  if (signedUrl.error) {
    return c.json({ error: signedUrl.error }, 500)
  }

  return c.json({
    hlsUrl: signedUrl.hlsUrl,
    thumbnail: lesson.stream_thumbnail,
    duration: lesson.duration_minutes,
    title: lesson.lesson_title
  })
})

// ==================== ClassIn 강의 관리 API ====================

// 관리자: ClassIn 강의 생성 (시간 지정)
app.post('/api/admin/classes/:classId/create-session', async (c) => {
  const classId = parseInt(c.req.param('classId'))
  const { scheduledAt } = await c.req.json()  // ISO 8601 format: "2024-03-20T14:00:00"

  if (!scheduledAt) {
    return c.json({ error: '강의 시간(scheduledAt)이 필요합니다.' }, 400)
  }

  // 시간 검증: 최소 2분 후여야 함
  const scheduledTime = new Date(scheduledAt).getTime()
  const minTime = Date.now() + 2 * 60 * 1000  // 2분 후
  if (scheduledTime < minTime) {
    return c.json({ error: '강의 시작 시간은 현재로부터 최소 2분 후여야 합니다.' }, 400)
  }

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!config) {
    return c.json({ error: 'ClassIn API가 설정되지 않았습니다.' }, 500)
  }

  // 코스 및 강사 정보 조회
  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.classin_uid as instructor_classin_uid, i.display_name as instructor_name
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    WHERE c.id = ?
  `).bind(classId).first() as any

  if (!cls) {
    return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)
  }

  if (!cls.instructor_classin_uid) {
    return c.json({ error: '강사가 ClassIn에 등록되지 않았습니다. 먼저 강사를 등록해주세요.' }, 400)
  }

  // 진행중인 강의가 있는지 확인 (아직 끝나지 않은 강의)
  const activeLesson = await c.env.DB.prepare(`
    SELECT * FROM class_lessons
    WHERE class_id = ? AND status != 'ended'
      AND datetime(scheduled_at, '+' || duration_minutes || ' minutes') > datetime('now')
    ORDER BY scheduled_at DESC LIMIT 1
  `).bind(classId).first() as any

  if (activeLesson) {
    return c.json({
      success: true,
      alreadyExists: true,
      message: `진행중인 강의가 있습니다: ${activeLesson.lesson_title}`,
      courseId: activeLesson.classin_course_id,
      classId: activeLesson.classin_class_id,
      lessonId: activeLesson.id,
      lessonNumber: activeLesson.lesson_number,
      instructorUrl: activeLesson.classin_instructor_url
    })
  }

  const teacherUid = cls.instructor_classin_uid

  // 1. 코스 - 기존 코스가 있으면 재사용, 없으면 새로 생성
  let courseId = cls.classin_course_id
  let isNewCourse = false

  if (!courseId) {
    const courseResult = await createClassInCourse(config, cls.title, teacherUid)
    if (!courseResult.courseId) {
      return c.json({ error: '코스 생성 실패: ' + courseResult.error }, 500)
    }
    courseId = courseResult.courseId
    isNewCourse = true
  }

  // 2. 강의 번호 계산 (기존 강의 수 + 1)
  const lessonCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM class_lessons WHERE class_id = ?'
  ).bind(classId).first() as any
  const lessonNumber = (lessonCount?.count || 0) + 1
  const lessonTitle = `${cls.title} #${lessonNumber}`

  // 3. 강의(레슨) 생성 - 지정된 시간으로
  const beginTime = Math.floor(new Date(scheduledAt).getTime() / 1000)
  const endTime = beginTime + (cls.duration_minutes || 60) * 60

  const lessonResult = await createClassInLesson(
    config,
    courseId,
    lessonTitle,
    beginTime,
    endTime,
    teacherUid,
    { live: 1, record: 1 }
  )

  if (!lessonResult.classId) {
    return c.json({ error: '강의 생성 실패: ' + lessonResult.error }, 500)
  }

  // 4. 강사 입장 URL 생성 (identity=3 강사)
  const instructorUrlResult = await getClassInLoginUrl(config, teacherUid, courseId, lessonResult.classId, 1, 3)
  const instructorUrl = instructorUrlResult.url ||
    `https://www.eeo.cn/client/invoke/index.html?uid=${teacherUid}&classId=${lessonResult.classId}&courseId=${courseId}&schoolId=${config.SID}`

  // 5. class_lessons 테이블에 저장
  await c.env.DB.prepare(`
    INSERT INTO class_lessons (class_id, lesson_number, lesson_title, classin_course_id, classin_class_id,
                               classin_instructor_url, scheduled_at, duration_minutes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
  `).bind(classId, lessonNumber, lessonTitle, courseId, lessonResult.classId, instructorUrl, scheduledAt, cls.duration_minutes || 60).run()

  // 6. classes 테이블 업데이트 (최신 강의 정보 + lesson_count + schedule_start 동기화)
  await c.env.DB.prepare(`
    UPDATE classes
    SET classin_course_id = ?, classin_class_id = ?, classin_instructor_url = ?,
        classin_status = 'scheduled', classin_scheduled_at = ?, classin_created_at = datetime('now'),
        schedule_start = ?, lesson_count = ?
    WHERE id = ?
  `).bind(courseId, lessonResult.classId, instructorUrl, scheduledAt, scheduledAt, lessonNumber, classId).run()

  return c.json({
    success: true,
    message: `강의 "${lessonTitle}"이 생성되었습니다!`,
    courseId,
    classId: lessonResult.classId,
    lessonId: lessonNumber,
    lessonTitle,
    instructorUrl,
    scheduledAt,
    isNewCourse
  })
})

// 관리자: 여러 강의 한 번에 생성
app.post('/api/admin/classes/:classId/create-sessions', async (c) => {
  const classId = parseInt(c.req.param('classId'))
  const { lessons } = await c.req.json() as { lessons: Array<{ title?: string; scheduledAt: string; durationMinutes?: number; description?: string; curriculumItems?: any[]; materials?: any[] }> }

  if (!lessons || !Array.isArray(lessons) || lessons.length === 0) {
    return c.json({ error: '최소 1개의 강의 정보가 필요합니다.' }, 400)
  }

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!config) {
    return c.json({ error: 'ClassIn API가 설정되지 않았습니다.' }, 500)
  }

  // 코스 및 강사 정보 조회 (전화번호/이메일 포함)
  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.classin_uid as instructor_classin_uid, i.display_name as instructor_name,
           i.id as instructor_id, u.email as instructor_email, i.classin_virtual_account as instructor_virtual_account
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    JOIN users u ON i.user_id = u.id
    WHERE c.id = ?
  `).bind(classId).first() as any

  if (!cls) {
    return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)
  }

  // 환경에 따라 가상계정 또는 실제 강사 계정 사용
  const useVirtualAccount = c.env.USE_INSTRUCTOR_VIRTUAL_ACCOUNT === 'true'

  let virtualAccount = ''
  let teacherUid = ''

  if (useVirtualAccount) {
    // T(teachers): 가상계정 사용
    virtualAccount = cls.instructor_virtual_account || ''

    if (!virtualAccount) {
      const available = await c.env.DB.prepare(`
        SELECT * FROM classin_virtual_accounts
        WHERE status = 'available' AND (is_registered = 0 OR is_registered IS NULL) AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY id LIMIT 1
      `).first() as any

      if (!available) {
        return c.json({ error: '사용 가능한 가상계정이 없습니다.' }, 400)
      }

      virtualAccount = available.account_uid

      // 강사에게 가상계정 할당
      await c.env.DB.prepare(`UPDATE instructors SET classin_virtual_account = ? WHERE id = ?`)
        .bind(virtualAccount, cls.instructor_id).run()

      // 가상계정 상태 업데이트
      await c.env.DB.prepare(`
        UPDATE classin_virtual_accounts
        SET status = 'assigned', assigned_name = ?, assigned_at = datetime('now')
        WHERE id = ?
      `).bind('INSTRUCTOR:' + cls.instructor_name, available.id).run()

      console.log('Assigned virtual account to instructor:', virtualAccount)
    }

    // 가상계정을 ClassIn에 등록하고 UID 획득
    const regResult = await registerVirtualAccount(config, virtualAccount, cls.instructor_name || 'Instructor', INSTRUCTOR_DEFAULT_PASSWORD)
    console.log('Virtual account register result:', JSON.stringify(regResult))

    if (regResult.uid) {
      teacherUid = regResult.uid
      // 가상계정 UID 저장
      await c.env.DB.prepare(`
        UPDATE classin_virtual_accounts
        SET is_registered = 1, classin_uid = ?, updated_at = datetime('now')
        WHERE account_uid = ?
      `).bind(teacherUid, virtualAccount).run()
    } else {
      // 이미 등록된 경우 UID 조회
      const existingAccount = await c.env.DB.prepare(
        'SELECT classin_uid FROM classin_virtual_accounts WHERE account_uid = ?'
      ).bind(virtualAccount).first() as any
      teacherUid = existingAccount?.classin_uid || ''
    }

    if (!teacherUid) {
      return c.json({ error: '가상계정 등록 실패' }, 400)
    }

    console.log('Using virtual account as teacher:', virtualAccount, 'UID:', teacherUid)

    // 가상계정을 기관에 교사로 등록
    const addTeacherResult = await addTeacher(config, virtualAccount, cls.instructor_name || 'Instructor')
    console.log('addTeacher result:', JSON.stringify(addTeacherResult))
    if (!addTeacherResult.success && !addTeacherResult.alreadyExists) {
      return c.json({ error: '가상계정 교사 등록 실패: ' + addTeacherResult.error }, 400)
    }
  } else {
    // L(live): 실제 강사 계정 사용
    if (!cls.instructor_classin_uid) {
      return c.json({ error: '강사가 ClassIn에 등록되지 않았습니다. 먼저 강사를 등록해주세요.' }, 400)
    }
    teacherUid = cls.instructor_classin_uid
    console.log('Using real instructor account, UID:', teacherUid)
  }

  // 1. 코스 - 기존 코스가 있으면 재사용, 없으면 새로 생성
  let courseId = cls.classin_course_id
  if (!courseId) {
    const courseResult = await createClassInCourse(config, cls.title, teacherUid)
    if (!courseResult.courseId) {
      return c.json({ error: '코스 생성 실패: ' + courseResult.error }, 500)
    }
    courseId = courseResult.courseId
  }

  // 강사는 createClassInLesson에서 teacherUid로 직접 설정됨
  // addTeacherToCourse는 조교(identity=3)로 추가하므로 사용하지 않음

  // 2. 현재 강의 수 조회
  const lessonCountResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM class_lessons WHERE class_id = ?'
  ).bind(classId).first() as any
  let lessonNumber = (lessonCountResult?.count || 0)

  // 3. 각 강의 생성
  const createdLessons: any[] = []
  const errors: string[] = []

  for (const lesson of lessons) {
    // 시간 검증: 최소 2분 후여야 함
    const scheduledTime = new Date(lesson.scheduledAt).getTime()
    const minTime = Date.now() + 2 * 60 * 1000
    if (scheduledTime < minTime) {
      errors.push(`${lesson.title || '강의'}: 시작 시간은 현재로부터 최소 2분 후여야 합니다.`)
      continue
    }

    lessonNumber++
    const lessonTitle = lesson.title || `${cls.title} #${lessonNumber}`
    const durationMinutes = lesson.durationMinutes || cls.duration_minutes || 60

    // ClassIn 강의 생성
    const beginTime = Math.floor(scheduledTime / 1000)
    const endTime = beginTime + durationMinutes * 60

    const lessonResult = await createClassInLesson(
      config,
      courseId,
      lessonTitle,
      beginTime,
      endTime,
      teacherUid,
      { live: 1, record: 1 }
    )

    if (!lessonResult.classId) {
      errors.push(`${lessonTitle}: ClassIn 강의 생성 실패 - ${lessonResult.error}`)
      lessonNumber-- // 롤백
      continue
    }

    // 강사 입장 URL 생성
    const instructorUrlResult = await getClassInLoginUrl(config, teacherUid, courseId, lessonResult.classId, 1, 3)
    const instructorUrl = instructorUrlResult.url ||
      `https://www.eeo.cn/client/invoke/index.html?uid=${teacherUid}&classId=${lessonResult.classId}&courseId=${courseId}&schoolId=${config.SID}`

    // DB에 저장
    const desc = lesson.description || ''
    const currItems = JSON.stringify(lesson.curriculumItems || [])
    const mats = JSON.stringify(lesson.materials || [])

    await c.env.DB.prepare(`
      INSERT INTO class_lessons (class_id, lesson_number, lesson_title, classin_course_id, classin_class_id,
                                 classin_instructor_url, scheduled_at, duration_minutes, status,
                                 description, curriculum_items, materials)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
    `).bind(classId, lessonNumber, lessonTitle, courseId, lessonResult.classId, instructorUrl, lesson.scheduledAt, durationMinutes, desc, currItems, mats).run()

    createdLessons.push({
      lessonNumber,
      lessonTitle,
      classId: lessonResult.classId,
      scheduledAt: lesson.scheduledAt,
      durationMinutes
    })
  }

  // 4. classes 테이블 업데이트 (최신 강의 정보)
  if (createdLessons.length > 0) {
    const latestLesson = createdLessons[createdLessons.length - 1]
    await c.env.DB.prepare(`
      UPDATE classes
      SET classin_course_id = ?, classin_class_id = ?,
          classin_status = 'scheduled', classin_created_at = datetime('now'),
          lesson_count = ?
      WHERE id = ?
    `).bind(courseId, latestLesson.classId, lessonNumber, classId).run()
  }

  if (createdLessons.length === 0) {
    return c.json({ error: errors.join('\n') || '강의 생성에 실패했습니다.' }, 400)
  }

  return c.json({
    success: true,
    message: `${createdLessons.length}개 강의가 생성되었습니다.` + (errors.length > 0 ? ` (${errors.length}개 실패)` : ''),
    courseId,
    createdLessons,
    errors: errors.length > 0 ? errors : undefined
  })
})

// 관리자: 코스별 강의 이력 조회
app.get('/api/admin/classes/:classId/lessons', async (c) => {
  const classId = parseInt(c.req.param('classId'))

  const { results } = await c.env.DB.prepare(`
    SELECT * FROM class_lessons
    WHERE class_id = ?
    ORDER BY lesson_number DESC
  `).bind(classId).all() as { results: any[] }

  // 종료된 강의 처리 (오류 발생해도 기본 결과는 반환)
  try {
    const now = Date.now()
    const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
      ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
      : null

    for (const lesson of results) {
      const startTime = lesson.scheduled_at ? new Date(lesson.scheduled_at).getTime() : 0
      const duration = (lesson.duration_minutes || 60) * 60 * 1000
      const isEnded = startTime > 0 && (startTime + duration) < now

      // 시간이 지났으면 status를 ended로 업데이트
      if (isEnded && lesson.status !== 'ended') {
        await c.env.DB.prepare(
          'UPDATE class_lessons SET status = ?, updated_at = datetime("now") WHERE id = ?'
        ).bind('ended', lesson.id).run()
        lesson.status = 'ended'
      }

      // 종료된 강의 중 replay_url이 없는 경우 ClassIn API에서 다시보기 URL 가져오기
      if (isEnded && !lesson.replay_url && lesson.classin_course_id && lesson.classin_class_id && classInConfig) {
        try {
          const webcastResult = await getClassInWebcastUrl(classInConfig, lesson.classin_course_id, lesson.classin_class_id)
          if (webcastResult.url) {
            await c.env.DB.prepare(
              'UPDATE class_lessons SET replay_url = ?, updated_at = datetime("now") WHERE id = ?'
            ).bind(webcastResult.url, lesson.id).run()
            lesson.replay_url = webcastResult.url
          }
        } catch (e) {
          // ClassIn API 호출 실패 시 무시
        }
      }
    }
  } catch (e) {
    // 전체 처리 실패 시 무시하고 기본 결과 반환
  }

  // 코스 정보 (강의 추가 버튼용)
  const courseInfo = await c.env.DB.prepare(`
    SELECT c.id, c.title, c.duration_minutes, i.display_name as instructor_name, i.classin_uid as instructor_classin_uid
    FROM classes c LEFT JOIN instructors i ON c.instructor_id = i.id
    WHERE c.id = ?
  `).bind(classId).first() as any

  return c.json({ lessons: results, courseInfo: courseInfo || {} })
})

// 관리자: 강의 상태 업데이트 (ended로 변경 등)
app.patch('/api/admin/lessons/:lessonId', async (c) => {
  const lessonId = parseInt(c.req.param('lessonId'))
  const { status, replayUrl } = await c.req.json()

  const updates: string[] = []
  const values: any[] = []

  if (status) {
    updates.push('status = ?')
    values.push(status)
  }
  if (replayUrl) {
    updates.push('replay_url = ?')
    values.push(replayUrl)
  }
  updates.push('updated_at = datetime("now")')

  if (updates.length > 1) {
    values.push(lessonId)
    await c.env.DB.prepare(`UPDATE class_lessons SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run()
  }

  return c.json({ success: true })
})

// 관리자: 강의 삭제
// 관리자: 강의 수정 (일시, 시간, 제목)
app.put('/api/admin/lessons/:lessonId', async (c) => {
  if (!await requireAdminAPI(c)) return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  const lessonId = parseInt(c.req.param('lessonId'))
  const { scheduledAt, durationMinutes, lessonTitle } = await c.req.json()

  const lesson = await c.env.DB.prepare('SELECT * FROM class_lessons WHERE id = ?').bind(lessonId).first() as any
  if (!lesson) return c.json({ error: '강의를 찾을 수 없습니다.' }, 404)

  await c.env.DB.prepare(`
    UPDATE class_lessons SET
      scheduled_at = COALESCE(?, scheduled_at),
      duration_minutes = COALESCE(?, duration_minutes),
      lesson_title = COALESCE(?, lesson_title)
    WHERE id = ?
  `).bind(scheduledAt || null, durationMinutes || null, lessonTitle || null, lessonId).run()

  return c.json({ success: true })
})

app.delete('/api/admin/lessons/:lessonId', async (c) => {
  try {
    const lessonId = parseInt(c.req.param('lessonId'))

    // 강의 정보 조회
    const lesson = await c.env.DB.prepare(
      'SELECT * FROM class_lessons WHERE id = ?'
    ).bind(lessonId).first() as any

    if (!lesson) {
      return c.json({ error: '강의를 찾을 수 없습니다.' }, 404)
    }

    // 녹화 강의가 아닌 경우에만 ClassIn에서 삭제 시도
    const isRecorded = lesson.lesson_type === 'recorded' || !!lesson.stream_uid
    if (!isRecorded && lesson.classin_course_id && lesson.classin_class_id) {
      const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
        ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
        : null

      if (config) {
        const deleteResult = await deleteClassInLesson(config, lesson.classin_course_id, lesson.classin_class_id)
        if (!deleteResult.success) {
          return c.json({ error: deleteResult.error || 'ClassIn 강의 삭제 실패' }, 400)
        }
      }
    }

    // DB에서 강의 삭제
    await c.env.DB.prepare('DELETE FROM class_lessons WHERE id = ?').bind(lessonId).run()

    // lesson_enrollments에서도 삭제 (테이블이 없을 수 있으므로 try-catch)
    try {
      await c.env.DB.prepare('DELETE FROM lesson_enrollments WHERE class_lesson_id = ?').bind(lessonId).run()
    } catch (e) {
      // lesson_enrollments 테이블이 없을 수 있음 - 무시
    }

    // 코스의 lesson_count 업데이트
    if (lesson.class_id) {
      const countResult = await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM class_lessons WHERE class_id = ?'
      ).bind(lesson.class_id).first() as any
      await c.env.DB.prepare(
        'UPDATE classes SET lesson_count = ? WHERE id = ?'
      ).bind(countResult?.count || 0, lesson.class_id).run()
    }

    return c.json({ success: true, message: '강의가 삭제되었습니다.' })
  } catch (e: any) {
    console.error('Admin lesson delete error:', e)
    return c.json({ error: e.message || '강의 삭제 중 오류가 발생했습니다.' }, 500)
  }
})

// 강사: 강의 삭제
app.delete('/api/instructor/lessons/:lessonId', async (c) => {
  const lessonId = parseInt(c.req.param('lessonId'))
  const { userId } = await c.req.json()

  // 강사 확인
  const instructor = await c.env.DB.prepare(`
    SELECT i.id FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE u.id = ? AND (u.role = 'instructor' OR u.is_instructor = 1)
  `).bind(userId).first() as any

  if (!instructor) {
    return c.json({ error: '강사 권한이 없습니다.' }, 403)
  }

  // 강의 정보 조회 (이 강사의 코스인지 확인)
  const lesson = await c.env.DB.prepare(`
    SELECT cl.*, c.instructor_id
    FROM class_lessons cl
    JOIN classes c ON cl.class_id = c.id
    WHERE cl.id = ? AND c.instructor_id = ?
  `).bind(lessonId, instructor.id).first() as any

  if (!lesson) {
    return c.json({ error: '강의을 찾을 수 없거나 권한이 없습니다.' }, 404)
  }

  // 녹화 강의가 아닌 경우에만 ClassIn에서 삭제 시도
  const isRecorded = lesson.lesson_type === 'recorded' || !!lesson.stream_uid
  if (!isRecorded && lesson.classin_course_id && lesson.classin_class_id) {
    const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
      ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
      : null

    if (config) {
      const deleteResult = await deleteClassInLesson(config, lesson.classin_course_id, lesson.classin_class_id)
      if (!deleteResult.success) {
        return c.json({ error: deleteResult.error || 'ClassIn 강의 삭제 실패' }, 400)
      }
    }
  }

  // DB에서 강의 삭제
  await c.env.DB.prepare('DELETE FROM class_lessons WHERE id = ?').bind(lessonId).run()
  await c.env.DB.prepare('DELETE FROM lesson_enrollments WHERE class_lesson_id = ?').bind(lessonId).run()

  // 코스의 lesson_count 업데이트
  if (lesson.class_id) {
    const countResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM class_lessons WHERE class_id = ?'
    ).bind(lesson.class_id).first() as any
    await c.env.DB.prepare(
      'UPDATE classes SET lesson_count = ? WHERE id = ?'
    ).bind(countResult?.count || 0, lesson.class_id).run()
  }

  return c.json({ success: true, message: '강의가 삭제되었습니다.' })
})

// 관리자: 코스 목록 (ClassIn 상태 포함)
app.get('/api/admin/classes', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT c.*, i.display_name as instructor_name, i.classin_uid as instructor_classin_uid,
           cat.name as category_name,
           (SELECT id FROM class_lessons
            WHERE class_id = c.id
              AND datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') > datetime('now')
            ORDER BY scheduled_at ASC LIMIT 1) as latest_lesson_id
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    JOIN categories cat ON c.category_id = cat.id
    ORDER BY c.id DESC
  `).all()

  return c.json({ classes: results })
})

// 관리자: 코스 생성
app.post('/api/admin/classes', async (c) => {
  const { title, description, instructorId, categoryId, price, scheduleStart, durationMinutes, thumbnail, level, classType } = await c.req.json()

  if (!title || !instructorId || !categoryId) {
    return c.json({ error: '제목, 강사, 카테고리는 필수입니다.' }, 400)
  }

  // slug 생성 (제목 기반 + 타임스탬프)
  const slug = title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now()

  const result = await c.env.DB.prepare(`
    INSERT INTO classes (title, slug, description, instructor_id, category_id, price, schedule_start, duration_minutes, thumbnail, level, class_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).bind(
    title,
    slug,
    description || '',
    instructorId,
    categoryId,
    price || 0,
    scheduleStart || null,
    durationMinutes || 60,
    thumbnail || '',
    level || 'all',
    classType || 'live'
  ).run()

  return c.json({
    success: true,
    classId: result.meta.last_row_id,
    slug
  })
})

// 관리자: 코스 수정
app.put('/api/admin/classes/:id', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const { title, description, instructorId, categoryId, price, scheduleStart, durationMinutes, thumbnail, level, classType, status } = await c.req.json()

  const cls = await c.env.DB.prepare('SELECT id FROM classes WHERE id = ?').bind(classId).first()
  if (!cls) {
    return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)
  }

  await c.env.DB.prepare(`
    UPDATE classes
    SET title = COALESCE(?, title),
        description = COALESCE(?, description),
        instructor_id = COALESCE(?, instructor_id),
        category_id = COALESCE(?, category_id),
        price = COALESCE(?, price),
        schedule_start = COALESCE(?, schedule_start),
        duration_minutes = COALESCE(?, duration_minutes),
        thumbnail = COALESCE(?, thumbnail),
        level = COALESCE(?, level),
        class_type = COALESCE(?, class_type),
        status = COALESCE(?, status),
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    title || null,
    description || null,
    instructorId || null,
    categoryId || null,
    price ?? null,
    scheduleStart || null,
    durationMinutes || null,
    thumbnail || null,
    level || null,
    classType || null,
    status || null,
    classId
  ).run()

  return c.json({ success: true, message: '코스가 수정되었습니다.' })
})

// 관리자: 코스 삭제
app.delete('/api/admin/classes/:id', async (c) => {
  const classId = parseInt(c.req.param('id'))

  const cls = await c.env.DB.prepare('SELECT id, title FROM classes WHERE id = ?').bind(classId).first() as any
  if (!cls) {
    return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)
  }

  // 활성 수강생이 있는지 확인 (종료/만료된 수강은 제외)
  const enrollments = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM enrollments WHERE class_id = ? AND status = 'active'"
  ).bind(classId).first() as any
  if (enrollments?.count > 0) {
    return c.json({ error: `${enrollments.count}명의 활성 수강생이 있습니다. 먼저 수강을 종료해주세요.` }, 400)
  }

  try {
    // lesson_enrollments는 class_lessons의 ID를 참조하므로 먼저 삭제
    const { results: lessonIds } = await c.env.DB.prepare('SELECT id FROM class_lessons WHERE class_id = ?').bind(classId).all()
    if (lessonIds.length > 0) {
      for (const l of lessonIds) {
        await c.env.DB.prepare('DELETE FROM lesson_enrollments WHERE class_lesson_id = ?').bind(l.id).run()
      }
    }

    // class_request_applications의 created_class_id 참조 해제
    await c.env.DB.prepare('UPDATE class_request_applications SET created_class_id = NULL WHERE created_class_id = ?').bind(classId).run()

    // 관련 테이블들 삭제 (FOREIGN KEY 제약 해결)
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM classin_sessions WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM enrollments WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM orders WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM lessons WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM reviews WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM wishlist WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM cart WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM subscriptions WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM class_lessons WHERE class_id = ?').bind(classId),
      c.env.DB.prepare('DELETE FROM classes WHERE id = ?').bind(classId),
    ])
  } catch (e: any) {
    return c.json({ error: '삭제 실패: ' + e.message }, 500)
  }

  return c.json({ success: true, message: '코스가 삭제되었습니다.' })
})

// ==================== 강사 수업 편집 API ====================

// 헬퍼: 강사 본인 수업 확인
async function verifyInstructorOwnership(c: any, classId: number): Promise<{ cls: any; instructor: any; user: any } | null> {
  const user = await getUserFromToken(c)
  if (!user) { c.json({ error: '로그인이 필요합니다.' }, 401); return null }

  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.user_id as instructor_user_id, i.id as instructor_id
    FROM classes c JOIN instructors i ON c.instructor_id = i.id WHERE c.id = ?
  `).bind(classId).first() as any

  if (!cls) { c.json({ error: '수업을 찾을 수 없습니다.' }, 404); return null }
  if (cls.instructor_user_id !== user.id) { c.json({ error: '본인의 수업만 편집할 수 있습니다.' }, 403); return null }

  return { cls, instructor: { id: cls.instructor_id, user_id: cls.instructor_user_id }, user }
}

// 강사: 수업 기본정보 수정
app.put('/api/instructor/classes/:id', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const ownership = await verifyInstructorOwnership(c, classId)
  if (!ownership) return

  const { title, description, whatYouLearn } = await c.req.json()

  await c.env.DB.prepare(`
    UPDATE classes SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      what_you_learn = COALESCE(?, what_you_learn),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(title || null, description || null, whatYouLearn || null, classId).run()

  return c.json({ success: true })
})

// 강사: 썸네일 업로드
app.post('/api/instructor/classes/:id/thumbnail', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const ownership = await verifyInstructorOwnership(c, classId)
  if (!ownership) return

  const formData = await c.req.formData()
  const file = formData.get('file') as File
  if (!file) return c.json({ error: '파일이 없습니다.' }, 400)

  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  if (!allowedTypes.includes(file.type)) return c.json({ error: '지원하지 않는 이미지 형식입니다.' }, 400)
  if (file.size > 5 * 1024 * 1024) return c.json({ error: '파일 크기는 5MB 이하여야 합니다.' }, 400)

  const ext = file.name.split('.').pop() || 'jpg'
  const filename = `thumbnails/class-${classId}-${Date.now()}.${ext}`
  const arrayBuffer = await file.arrayBuffer()

  await c.env.IMAGES.put(filename, arrayBuffer, { httpMetadata: { contentType: file.type } })

  const imageUrl = `/api/images/${filename}`
  await c.env.DB.prepare('UPDATE classes SET thumbnail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(imageUrl, classId).run()

  return c.json({ success: true, url: imageUrl })
})

// 강사: 커리큘럼 조회
app.get('/api/instructor/classes/:id/curriculum', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const ownership = await verifyInstructorOwnership(c, classId)
  if (!ownership) return

  const { results } = await c.env.DB.prepare('SELECT * FROM lessons WHERE class_id = ? ORDER BY sort_order ASC').bind(classId).all()
  return c.json({ lessons: results })
})

// 강사: 커리큘럼 항목 추가
app.post('/api/instructor/classes/:id/curriculum', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const ownership = await verifyInstructorOwnership(c, classId)
  if (!ownership) return

  const { title, description, chapterTitle } = await c.req.json()
  if (!title) return c.json({ error: '제목을 입력해주세요.' }, 400)

  const maxOrder = await c.env.DB.prepare('SELECT MAX(sort_order) as max FROM lessons WHERE class_id = ?').bind(classId).first() as any
  const nextOrder = (maxOrder?.max || 0) + 1

  const result = await c.env.DB.prepare(`
    INSERT INTO lessons (class_id, title, description, chapter_title, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).bind(classId, title, description || '', chapterTitle || '', nextOrder).run()

  // 커리큘럼 수 업데이트
  await c.env.DB.prepare('UPDATE classes SET lesson_count = (SELECT COUNT(*) FROM lessons WHERE class_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(classId, classId).run()

  return c.json({ success: true, id: result.meta.last_row_id })
})

// 강사: 커리큘럼 항목 수정
app.put('/api/instructor/classes/:id/curriculum/:lessonId', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const lessonId = parseInt(c.req.param('lessonId'))
  const ownership = await verifyInstructorOwnership(c, classId)
  if (!ownership) return

  const { title, description, chapterTitle } = await c.req.json()

  await c.env.DB.prepare(`
    UPDATE lessons SET title = COALESCE(?, title), description = COALESCE(?, description), chapter_title = COALESCE(?, chapter_title) WHERE id = ? AND class_id = ?
  `).bind(title || null, description || null, chapterTitle || null, lessonId, classId).run()

  return c.json({ success: true })
})

// 강사: 커리큘럼 항목 삭제
app.delete('/api/instructor/classes/:id/curriculum/:lessonId', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const lessonId = parseInt(c.req.param('lessonId'))
  const ownership = await verifyInstructorOwnership(c, classId)
  if (!ownership) return

  await c.env.DB.prepare('DELETE FROM lessons WHERE id = ? AND class_id = ?').bind(lessonId, classId).run()
  await c.env.DB.prepare('UPDATE classes SET lesson_count = (SELECT COUNT(*) FROM lessons WHERE class_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(classId, classId).run()

  return c.json({ success: true })
})

// 강사: 프로필(소개) 수정
app.put('/api/instructor/profile', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const instructor = await c.env.DB.prepare('SELECT id FROM instructors WHERE user_id = ?').bind(user.id).first() as any
  if (!instructor) return c.json({ error: '강사 정보를 찾을 수 없습니다.' }, 404)

  const { bio, specialty } = await c.req.json()

  await c.env.DB.prepare(`
    UPDATE instructors SET bio = COALESCE(?, bio), specialty = COALESCE(?, specialty) WHERE id = ?
  `).bind(bio ?? null, specialty ?? null, instructor.id).run()

  return c.json({ success: true })
})

// ==================== 홈페이지 관리 API ====================

// 관리자: 홈페이지 3개 섹션 코스 목록 조회
app.get('/api/admin/homepage/sections', async (c) => {
  // DB.batch(): 4개 쿼리를 단일 호출로 묶어 네트워크 왕복 3회 절감
  const [bestseller, newCourses, liveCourses, allActive, specialCourses] = await c.env.DB.batch([
    c.env.DB.prepare(`
      SELECT c.id, c.title, c.slug, c.thumbnail, c.is_bestseller, c.is_new, c.class_type, c.homepage_sort_order, c.price, c.rating, c.status,
             i.display_name as instructor_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id
      WHERE c.status = 'active' AND c.is_bestseller = 1
      ORDER BY c.homepage_sort_order ASC, c.rating DESC
    `),
    c.env.DB.prepare(`
      SELECT c.id, c.title, c.slug, c.thumbnail, c.is_bestseller, c.is_new, c.class_type, c.homepage_sort_order, c.price, c.rating, c.status,
             i.display_name as instructor_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id
      WHERE c.status = 'active' AND c.is_new = 1
      ORDER BY c.homepage_sort_order ASC, c.created_at DESC
    `),
    c.env.DB.prepare(`
      SELECT c.id, c.title, c.slug, c.thumbnail, c.is_bestseller, c.is_new, c.class_type, c.homepage_sort_order, c.price, c.rating, c.status,
             i.display_name as instructor_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id
      WHERE c.status = 'active' AND c.class_type = 'live'
      ORDER BY c.homepage_sort_order ASC, c.schedule_start ASC
    `),
    c.env.DB.prepare(`
      SELECT c.id, c.title, c.slug, c.thumbnail, c.is_bestseller, c.is_new, c.class_type, c.homepage_sort_order, c.price, c.status,
             i.display_name as instructor_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id
      WHERE c.status = 'active'
      ORDER BY c.title ASC
    `),
    c.env.DB.prepare(`
      SELECT c.id, c.title, c.slug, c.thumbnail, c.is_bestseller, c.is_new, c.is_featured_special, c.class_type, c.homepage_sort_order, c.price, c.rating, c.status,
             i.display_name as instructor_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id
      WHERE c.status = 'active' AND c.is_featured_special = 1
      ORDER BY c.homepage_sort_order ASC, c.rating DESC
    `)
  ])

  return c.json({
    bestseller: bestseller.results,
    newCourses: newCourses.results,
    liveCourses: liveCourses.results,
    specialCourses: specialCourses.results,
    allActive: allActive.results
  })
})

// 관리자: 코스 홈페이지 플래그 업데이트 (베스트/신규 토글)
app.put('/api/admin/classes/:id/homepage-flags', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const { isBestseller, isNew, isFeaturedSpecial, homepageSortOrder } = await c.req.json()

  const cls = await c.env.DB.prepare('SELECT id FROM classes WHERE id = ?').bind(classId).first()
  if (!cls) return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)

  await c.env.DB.prepare(`
    UPDATE classes SET
      is_bestseller = COALESCE(?, is_bestseller),
      is_new = COALESCE(?, is_new),
      is_featured_special = COALESCE(?, is_featured_special),
      homepage_sort_order = COALESCE(?, homepage_sort_order),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    isBestseller !== undefined ? isBestseller : null,
    isNew !== undefined ? isNew : null,
    isFeaturedSpecial !== undefined ? isFeaturedSpecial : null,
    homepageSortOrder !== undefined ? homepageSortOrder : null,
    classId
  ).run()

  return c.json({ success: true })
})

// 관리자: 홈페이지 섹션 내 코스 순서 일괄 업데이트
app.put('/api/admin/homepage/reorder', async (c) => {
  const { items } = await c.req.json() as { items: { id: number, sortOrder: number }[] }

  if (!items || !Array.isArray(items)) {
    return c.json({ error: 'items 배열이 필요합니다.' }, 400)
  }

  const stmts = items.map(item =>
    c.env.DB.prepare('UPDATE classes SET homepage_sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(item.sortOrder, item.id)
  )
  await c.env.DB.batch(stmts)

  return c.json({ success: true })
})

// 관리자: 카테고리 목록
app.get('/api/admin/categories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM categories ORDER BY sort_order, name').all()
  return c.json({ categories: results })
})

// 관리자: 특정 코스 ClassIn 정보 조회
app.get('/api/admin/classes/:classId/session', async (c) => {
  const classId = parseInt(c.req.param('classId'))

  const cls = await c.env.DB.prepare(`
    SELECT c.id, c.title, c.classin_course_id, c.classin_class_id, c.classin_instructor_url,
           c.classin_status, c.classin_scheduled_at, c.schedule_start, c.duration_minutes,
           i.display_name as instructor_name, i.classin_uid as instructor_classin_uid
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    WHERE c.id = ?
  `).bind(classId).first() as any

  if (!cls) {
    return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)
  }

  // 해당 강의의 수강생 수
  const enrollmentCount = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM enrollments WHERE class_id = ?
  `).bind(classId).first() as any

  return c.json({
    class: cls,
    enrollmentCount: enrollmentCount?.count || 0,
    hasClassInSession: !!(cls.classin_course_id && cls.classin_class_id)
  })
})

// 한국 전화번호 형식 변환: 010xxxxyyyy 또는 010-xxxx-yyyy → 0082-10xxxxyyyy
function formatKoreanPhoneForClassIn(phone: string): string {
  // 하이픈, 공백 제거
  const cleaned = phone.replace(/[-\s]/g, '')

  // 010으로 시작하면 국제 형식으로 변환
  if (cleaned.startsWith('010') && cleaned.length >= 10) {
    // 010 → 0082-10 (앞의 0을 제거하고 국가코드 추가)
    return '0082-' + cleaned.substring(1)
  }

  // 이미 국제 형식이면 그대로 반환
  return phone
}

// Register instructor with ClassIn using phone number (관리자: 강사 ClassIn 등록)
app.post('/api/admin/instructors/register-classin', async (c) => {
  const { instructorId, phoneNumber: rawInput } = await c.req.json()

  if (!instructorId || !rawInput) {
    return c.json({ error: 'instructorId와 전화번호/이메일이 필요합니다.' }, 400)
  }

  // 이메일인지 전화번호인지 판단
  const isEmail = rawInput.includes('@')
  const accountValue = isEmail ? rawInput.trim() : formatKoreanPhoneForClassIn(rawInput)

  // Get ClassIn config
  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null
  if (!config) {
    return c.json({ error: 'ClassIn API가 설정되지 않았습니다. (SID/SECRET 확인 필요)' }, 500)
  }

  // Check if instructor exists
  const instructor = await c.env.DB.prepare(`
    SELECT i.*, u.name as user_name FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE i.id = ?
  `).bind(instructorId).first() as any

  if (!instructor) {
    return c.json({ error: '강사를 찾을 수 없습니다.' }, 404)
  }

  // If already registered
  if (instructor.classin_uid) {
    return c.json({
      success: true,
      message: '이미 등록된 강사입니다.',
      instructor: { ...instructor, classin_uid: instructor.classin_uid }
    })
  }

  // Register with ClassIn
  const result = await registerInstructorWithClassIn(c.env.DB, instructorId, config, accountValue)

  if (result.error) {
    return c.json({ error: result.error }, 500)
  }

  return c.json({
    success: true,
    message: '강사 등록 완료',
    classInUid: result.uid,
    instructor: { ...instructor, classin_uid: result.uid }
  })
})

// Re-register instructor as school teacher (기존 강사를 기관 교사로 재등록)
app.post('/api/admin/instructors/re-register-classin', async (c) => {
  const { instructorId, classInUid, phoneNumber: rawPhoneNumber } = await c.req.json()

  if (!instructorId || !classInUid || !rawPhoneNumber) {
    return c.json({ error: 'instructorId, classInUid, phoneNumber가 필요합니다.' }, 400)
  }

  // Get ClassIn config
  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null
  if (!config) {
    return c.json({ error: 'ClassIn API가 설정되지 않았습니다.' }, 500)
  }

  // Get instructor info from DB
  const instructor = await c.env.DB.prepare(`
    SELECT i.*, u.phone as user_phone, u.email as user_email
    FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE i.id = ?
  `).bind(instructorId).first() as any

  if (!instructor) {
    return c.json({ error: '강사를 찾을 수 없습니다.' }, 404)
  }

  const teacherName = instructor.display_name || instructor.user_name || 'Teacher'

  // 이메일인지 전화번호인지 판단
  const isEmail = rawPhoneNumber.includes('@')
  const accountValue = isEmail ? rawPhoneNumber.trim() : formatKoreanPhoneForClassIn(rawPhoneNumber)

  try {
    // Step 1: register API로 실제 UID 조회 (이미 등록된 경우에도 UID 반환)
    const timestamp1 = Math.floor(Date.now() / 1000)
    const safeKey1 = await generateSafeKey(config.SECRET, timestamp1)

    const registerForm = new URLSearchParams()
    registerForm.set('SID', config.SID)
    registerForm.set('safeKey', safeKey1)
    registerForm.set('timeStamp', timestamp1.toString())
    // 이메일이면 email, 전화번호면 telephone 파라미터 사용
    if (isEmail) {
      registerForm.set('email', accountValue)
    } else {
      registerForm.set('telephone', accountValue)
    }
    registerForm.set('password', 'Classin123!')
    // addToSchoolMember 제거 - UID 조회 목적으로만 사용

    const registerRes = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: registerForm.toString()
    })
    const registerText = await registerRes.text()
    console.log('register response text:', registerText)

    let registerData: any
    try {
      registerData = JSON.parse(registerText)
    } catch {
      return c.json({ error: 'register API 응답 파싱 실패: ' + registerText.substring(0, 200) }, 500)
    }

    // register 응답에서 UID 추출 (성공 또는 "이미 등록됨" 모두 data에 UID 반환)
    const realUid = registerData.data?.toString()
    console.log('register response - errno:', registerData.error_info?.errno, 'realUid:', realUid)

    if (!realUid) {
      return c.json({ error: translateClassInError(registerData.error_info?.error || JSON.stringify(registerData)) }, 500)
    }

    // Step 2: addTeacher API로 기관 교사로 등록
    const timestamp2 = Math.floor(Date.now() / 1000)
    const safeKey2 = await generateSafeKey(config.SECRET, timestamp2)

    const teacherForm = new URLSearchParams()
    teacherForm.set('SID', config.SID)
    teacherForm.set('safeKey', safeKey2)
    teacherForm.set('timeStamp', timestamp2.toString())
    teacherForm.set('teacherAccount', accountValue)
    teacherForm.set('teacherName', teacherName)

    const teacherRes = await fetch(`${config.API_BASE}/partner/api/course.api.php?action=addTeacher`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: teacherForm.toString()
    })
    const teacherText = await teacherRes.text()
    console.log('addTeacher response text:', teacherText)

    let teacherData: any
    try {
      teacherData = JSON.parse(teacherText)
    } catch {
      return c.json({ error: 'addTeacher API 응답 파싱 실패: ' + teacherText.substring(0, 200) }, 500)
    }

    const teacherErrno = teacherData.error_info?.errno
    const teacherError = teacherData.error_info?.error || ''
    const alreadyExists = teacherError.includes('已经存在')

    // addTeacher 성공 또는 이미 존재
    if (teacherErrno === 1 || alreadyExists) {
      // DB 업데이트 - 실제 UID로 갱신
      await c.env.DB.prepare(`
        UPDATE instructors SET classin_uid = ? WHERE id = ?
      `).bind(realUid, instructorId).run()

      // 이메일 또는 전화번호를 users 테이블의 phone 필드에 저장 (ClassIn 계정 정보로 사용)
      await c.env.DB.prepare(`
        UPDATE users SET phone = ? WHERE id = ?
      `).bind(rawPhoneNumber, instructor.user_id).run()

      return c.json({
        success: true,
        message: `기관 교사로 등록되었습니다. (UID: ${realUid})`,
        classInUid: realUid
      })
    }

    return c.json({ error: translateClassInError(teacherError || JSON.stringify(teacherData)) }, 500)
  } catch (e: any) {
    return c.json({ error: e.message || 'Network error' }, 500)
  }
})

// Get all instructors for admin (관리자: 강사 목록)
app.get('/api/admin/instructors', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT i.*, u.name as user_name, u.email as user_email, u.phone as user_phone
    FROM instructors i
    JOIN users u ON i.user_id = u.id
    ORDER BY i.id
  `).all()

  return c.json({ instructors: results })
})

// Create new instructor (관리자: 강사 등록)
app.post('/api/admin/instructors', async (c) => {
  const { name, email, phone, classInMethod, profileImage } = await c.req.json()

  if (!name || !email || !phone) {
    return c.json({ error: '이름, 이메일, 전화번호는 필수입니다.' }, 400)
  }

  // 이메일 중복 체크
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) {
    return c.json({ error: '이미 등록된 이메일입니다.' }, 400)
  }

  // ClassIn 등록 계정 결정 (방식에 따라 이메일 또는 전화번호 사용)
  const classInAccountValue = classInMethod === 'email' ? email : phone

  // 1. 유저 생성
  const passwordHash = '$2a$10$defaulthash' // 임시 비밀번호
  const userResult = await c.env.DB.prepare(`
    INSERT INTO users (email, password_hash, name, phone, role)
    VALUES (?, ?, ?, ?, 'instructor')
  `).bind(email, passwordHash, name, phone).run()

  const userId = userResult.meta.last_row_id

  // 2. 강사 레코드 생성 (classin_method 저장)
  const instructorResult = await c.env.DB.prepare(`
    INSERT INTO instructors (user_id, display_name, profile_image)
    VALUES (?, ?, ?)
  `).bind(userId, name, profileImage || '').run()

  const instructorId = instructorResult.meta.last_row_id

  // 3. ClassIn 등록 (선택한 방식으로 등록)
  let classInUid = ''
  let classInError = ''
  if (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET) {
    const config: ClassInConfig = {
      SID: c.env.CLASSIN_SID,
      SECRET: c.env.CLASSIN_SECRET,
      API_BASE: 'https://api.eeo.cn'
    }

    const result = await registerInstructorWithClassIn(c.env.DB, instructorId as number, config, classInAccountValue)
    if (result.uid) {
      classInUid = result.uid
    } else if (result.error) {
      classInError = result.error
    }
  }

  return c.json({
    success: true,
    instructor: {
      id: instructorId,
      user_id: userId,
      display_name: name,
      email,
      phone,
      classin_uid: classInUid
    },
    classInError: classInError || undefined
  })
})

// Update instructor (관리자: 강사 수정)
app.put('/api/admin/instructors/:id', async (c) => {
  const instructorId = parseInt(c.req.param('id'))
  const { name, email, phone, profileImage, classInMethod } = await c.req.json()

  if (!phone) {
    return c.json({ error: '전화번호는 필수입니다.' }, 400)
  }

  // 강사 정보 조회
  const instructor = await c.env.DB.prepare(`
    SELECT i.*, u.id as user_id, u.phone as user_phone, u.email as user_email FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE i.id = ?
  `).bind(instructorId).first() as any

  if (!instructor) {
    return c.json({ error: '강사를 찾을 수 없습니다.' }, 404)
  }

  // instructors 테이블 업데이트
  await c.env.DB.prepare(`
    UPDATE instructors SET display_name = COALESCE(?, display_name), profile_image = COALESCE(?, profile_image)
    WHERE id = ?
  `).bind(name || null, profileImage || null, instructorId).run()

  // users 테이블 업데이트
  await c.env.DB.prepare(`
    UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone)
    WHERE id = ?
  `).bind(name || null, email || null, phone || null, instructor.user_id).run()

  // ClassIn 등록 (변경되었거나 UID 없을 때만)
  let classInResult = null
  const phoneChanged = phone && phone !== instructor.user_phone
  const emailChanged = email && email !== instructor.user_email
  const needRegister = phoneChanged || emailChanged || !instructor.classin_uid

  if (needRegister && c.env.CLASSIN_SID && c.env.CLASSIN_SECRET) {
    const config: ClassInConfig = {
      SID: c.env.CLASSIN_SID,
      SECRET: c.env.CLASSIN_SECRET,
      API_BASE: 'https://api.eeo.cn'
    }

    // 전화번호/이메일 변경 시 기존 UID 초기화
    if (phoneChanged || emailChanged) {
      await c.env.DB.prepare(`
        UPDATE instructors SET classin_uid = NULL, classin_registered_at = NULL WHERE id = ?
      `).bind(instructorId).run()
    }

    // 선택한 방식으로 ClassIn 등록
    const classInAccountValue = classInMethod === 'email' ? (email || instructor.user_email) : (phone || instructor.user_phone)
    classInResult = await registerInstructorWithClassIn(c.env.DB, instructorId, config, classInAccountValue)
  }

  return c.json({
    success: true,
    message: classInResult?.uid
      ? `강사 정보가 수정되었습니다. ClassIn UID: ${classInResult.uid}`
      : classInResult?.error
        ? `강사 정보가 수정되었습니다. (ClassIn 등록 실패: ${classInResult.error})`
        : '강사 정보가 수정되었습니다.'
  })
})

// Delete instructor (관리자: 강사 삭제)
app.delete('/api/admin/instructors/:id', async (c) => {
  const instructorId = parseInt(c.req.param('id'))

  // 강사 정보 조회
  const instructor = await c.env.DB.prepare(`
    SELECT i.*, u.id as user_id FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE i.id = ?
  `).bind(instructorId).first() as any

  if (!instructor) {
    return c.json({ error: '강사를 찾을 수 없습니다.' }, 404)
  }

  // 해당 강사의 코스가 있는지 확인
  const hasClasses = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM classes WHERE instructor_id = ?'
  ).bind(instructorId).first() as any

  if (hasClasses?.count > 0) {
    return c.json({ error: `이 강사에게 ${hasClasses.count}개의 코스가 있습니다. 먼저 코스를 삭제해주세요.` }, 400)
  }

  // 가상계정이 있으면 회수
  if (instructor.classin_virtual_account) {
    await c.env.DB.prepare(`
      UPDATE classin_virtual_accounts
      SET status = 'available', user_id = NULL, assigned_at = NULL, assigned_name = NULL,
          is_registered = 0, registered_at = NULL, updated_at = datetime('now')
      WHERE account_uid = ?
    `).bind(instructor.classin_virtual_account).run()
    console.log('Released virtual account:', instructor.classin_virtual_account)
  }

  // 강사 삭제
  await c.env.DB.prepare('DELETE FROM instructors WHERE id = ?').bind(instructorId).run()
  // 유저도 삭제 (강사 역할만 삭제하려면 이 부분 수정)
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(instructor.user_id).run()

  return c.json({ success: true, message: '강사가 삭제되었습니다.' + (instructor.classin_virtual_account ? ' (가상계정 회수됨)' : '') })
})

// ============================================
// 관리자: 회원 관리
// ============================================

// 회원 목록 조회
app.get('/api/admin/users', async (c) => {
  const search = c.req.query('search') || ''
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')

  let query = `
    SELECT id, email, name, phone, role, is_instructor, is_test_account, test_expires_at, created_at
    FROM users
  `
  const params: any[] = []

  if (search) {
    query += ` WHERE name LIKE ? OR email LIKE ? OR phone LIKE ?`
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }

  query += ` ORDER BY id DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const { results } = await c.env.DB.prepare(query).bind(...params).all()

  // 전체 회원 수 (검색 조건 적용)
  let countQuery = 'SELECT COUNT(*) as total FROM users'
  if (search) {
    countQuery += ` WHERE name LIKE ? OR email LIKE ? OR phone LIKE ?`
  }
  const countResult = search
    ? await c.env.DB.prepare(countQuery).bind(`%${search}%`, `%${search}%`, `%${search}%`).first() as any
    : await c.env.DB.prepare(countQuery).first() as any

  // 전체 통계 (검색 조건 무관)
  const statsResult = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END) as students,
      SUM(CASE WHEN role = 'instructor' OR is_instructor = 1 THEN 1 ELSE 0 END) as instructors,
      SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins,
      SUM(CASE WHEN is_test_account = 1 THEN 1 ELSE 0 END) as test_accounts
    FROM users
  `).first() as any

  return c.json({
    users: results,
    total: countResult?.total || 0,
    stats: {
      total: statsResult?.total || 0,
      students: statsResult?.students || 0,
      instructors: statsResult?.instructors || 0,
      admins: statsResult?.admins || 0,
      testAccounts: statsResult?.test_accounts || 0
    }
  })
})

// 회원 상세 조회
app.get('/api/admin/users/:id', async (c) => {
  const userId = parseInt(c.req.param('id'))
  const user = await c.env.DB.prepare(`
    SELECT id, email, name, phone, role, is_test_account, test_expires_at, created_at
    FROM users WHERE id = ?
  `).bind(userId).first()

  if (!user) {
    return c.json({ error: '회원을 찾을 수 없습니다.' }, 404)
  }

  return c.json({ user })
})

// 회원 정보 수정
app.put('/api/admin/users/:id', async (c) => {
  const userId = parseInt(c.req.param('id'))
  const { name, phone, role, is_test_account } = await c.req.json()

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()
  if (!user) {
    return c.json({ error: '회원을 찾을 수 없습니다.' }, 404)
  }

  await c.env.DB.prepare(`
    UPDATE users SET
      name = COALESCE(?, name),
      phone = COALESCE(?, phone),
      role = COALESCE(?, role),
      is_test_account = COALESCE(?, is_test_account),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(name, phone, role, is_test_account ? 1 : 0, userId).run()

  return c.json({ success: true, message: '회원 정보가 수정되었습니다.' })
})

// 회원 삭제
app.delete('/api/admin/users/:id', async (c) => {
  const userId = parseInt(c.req.param('id'))

  const user = await c.env.DB.prepare('SELECT id, role, is_instructor FROM users WHERE id = ?').bind(userId).first() as any
  if (!user) {
    return c.json({ error: '회원을 찾을 수 없습니다.' }, 404)
  }

  // 강사인 경우 강사 레코드도 삭제
  if (isInstructorUser(user)) {
    await c.env.DB.prepare('DELETE FROM instructors WHERE user_id = ?').bind(userId).run()
  }

  // 관련 데이터 삭제
  await c.env.DB.prepare('DELETE FROM enrollments WHERE user_id = ?').bind(userId).run()
  await c.env.DB.prepare('DELETE FROM wishlist WHERE user_id = ?').bind(userId).run()
  await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ?').bind(userId).run()
  await c.env.DB.prepare('DELETE FROM orders WHERE user_id = ?').bind(userId).run()
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()

  return c.json({ success: true, message: '회원이 삭제되었습니다.' })
})

// ============================================
// 관리자: 코스별 수강신청자 관리
// ============================================

// 코스별 수강신청자 목록
app.get('/api/admin/classes/:classId/enrollments', async (c) => {
  const classId = parseInt(c.req.param('classId'))

  const { results } = await c.env.DB.prepare(`
    SELECT e.*, u.name as user_name, u.email as user_email, u.phone as user_phone
    FROM enrollments e
    JOIN users u ON e.user_id = u.id
    WHERE e.class_id = ?
    ORDER BY e.enrolled_at DESC
  `).bind(classId).all()

  return c.json({ enrollments: results })
})

// 전체 수강신청자 목록 (코스 정보 포함)
app.get('/api/admin/enrollments', async (c) => {
  const classId = c.req.query('classId')
  const status = c.req.query('status')
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')

  let query = `
    SELECT e.*,
           u.name as user_name, u.email as user_email, u.phone as user_phone,
           c.title as class_title
    FROM enrollments e
    JOIN users u ON e.user_id = u.id
    JOIN classes c ON e.class_id = c.id
    WHERE 1=1
  `
  const params: any[] = []

  if (classId) {
    query += ` AND e.class_id = ?`
    params.push(parseInt(classId))
  }
  if (status) {
    query += ` AND e.status = ?`
    params.push(status)
  }

  query += ` ORDER BY e.enrolled_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const { results } = await c.env.DB.prepare(query).bind(...params).all()

  return c.json({ enrollments: results })
})

// 수강 상태 변경 (활성/종료)
app.put('/api/admin/enrollments/:id/status', async (c) => {
  const enrollmentId = parseInt(c.req.param('id'))
  const { status } = await c.req.json()

  if (!['active', 'ended', 'expired'].includes(status)) {
    return c.json({ error: '유효하지 않은 상태입니다.' }, 400)
  }

  const enrollment = await c.env.DB.prepare('SELECT id, classin_account_uid FROM enrollments WHERE id = ?').bind(enrollmentId).first() as any
  if (!enrollment) {
    return c.json({ error: '수강 정보를 찾을 수 없습니다.' }, 404)
  }

  // 종료 시 가상 계정 반납
  if (status === 'ended' && enrollment.classin_account_uid) {
    await returnVirtualAccountFromEnrollment(c.env.DB, enrollmentId)
  }

  await c.env.DB.prepare(`
    UPDATE enrollments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(status, enrollmentId).run()

  return c.json({ success: true, message: '수강 상태가 변경되었습니다.' })
})

// 수강신청 삭제 (완전 삭제)
app.delete('/api/admin/enrollments/:id', async (c) => {
  const enrollmentId = parseInt(c.req.param('id'))

  const enrollment = await c.env.DB.prepare(
    'SELECT id, class_id, classin_account_uid, status FROM enrollments WHERE id = ?'
  ).bind(enrollmentId).first() as any

  if (!enrollment) {
    return c.json({ error: '수강 정보를 찾을 수 없습니다.' }, 404)
  }

  // 가상 계정 반납 (할당되어 있는 경우)
  if (enrollment.classin_account_uid) {
    await returnVirtualAccountFromEnrollment(c.env.DB, enrollmentId)
  }

  // 활성 수강인 경우 current_students 감소
  if (enrollment.status === 'active') {
    await c.env.DB.prepare(
      'UPDATE classes SET current_students = MAX(0, current_students - 1) WHERE id = ?'
    ).bind(enrollment.class_id).run()
  }

  // classin_sessions의 enrollment_id 참조 해제
  await c.env.DB.prepare(
    'UPDATE classin_sessions SET enrollment_id = NULL WHERE enrollment_id = ?'
  ).bind(enrollmentId).run()

  // enrollments 레코드 삭제
  await c.env.DB.prepare('DELETE FROM enrollments WHERE id = ?').bind(enrollmentId).run()

  return c.json({ success: true, message: '수강신청이 삭제되었습니다.' })
})

// Assign virtual account to user (사용자에게 가상 계정 할당)
app.post('/api/virtual-accounts/assign', async (c) => {
  const { userId, userName } = await c.req.json()

  if (!userId || !userName) {
    return c.json({ error: 'userId와 userName이 필요합니다.' }, 400)
  }

  // Check if user already has an account
  const existingUser = await c.env.DB.prepare(
    'SELECT classin_account_uid FROM users WHERE id = ? AND classin_account_uid != ""'
  ).bind(userId).first() as any

  if (existingUser?.classin_account_uid) {
    return c.json({
      success: true,
      accountUid: existingUser.classin_account_uid,
      message: '이미 할당된 계정이 있습니다.'
    })
  }

  // Get an available virtual account
  const account = await c.env.DB.prepare(`
    SELECT * FROM classin_virtual_accounts
    WHERE status = 'available' AND (is_registered = 0 OR is_registered IS NULL) AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY id LIMIT 1
  `).first() as any

  if (!account) {
    return c.json({ error: '사용 가능한 가상 계정이 없습니다.' }, 404)
  }

  const password = generateDefaultPassword()

  // Try to register with ClassIn API if configured
  let isRegistered = false
  const classInConfig = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (classInConfig) {
    const result = await registerVirtualAccount(classInConfig, account.account_uid, userName, password)
    isRegistered = result.success
    if (!result.success) {
      // Update error message but continue with assignment
      await c.env.DB.prepare(
        'UPDATE classin_virtual_accounts SET error_message = ? WHERE id = ?'
      ).bind(result.error || 'Registration failed', account.id).run()
    }
  }

  // Assign account to user
  await c.env.DB.prepare(`
    UPDATE classin_virtual_accounts
    SET user_id = ?, assigned_at = datetime('now'), assigned_name = ?,
        account_password = ?, is_registered = ?, status = 'assigned', updated_at = datetime('now')
    WHERE id = ?
  `).bind(userId, userName, password, isRegistered ? 1 : 0, account.id).run()

  // Update user with ClassIn account
  await c.env.DB.prepare(`
    UPDATE users SET classin_account_uid = ?, classin_registered = ? WHERE id = ?
  `).bind(account.account_uid, isRegistered ? 1 : 0, userId).run()

  return c.json({
    success: true,
    accountUid: account.account_uid,
    password: password,
    isRegistered,
    message: isRegistered
      ? 'ClassIn 계정이 등록되고 할당되었습니다.'
      : 'ClassIn 계정이 할당되었습니다. (API 등록 대기 중)'
  })
})

// Register virtual account with ClassIn API (계정을 ClassIn에 등록)
app.post('/api/virtual-accounts/register', async (c) => {
  const { accountId } = await c.req.json()

  const account = await c.env.DB.prepare(
    'SELECT * FROM classin_virtual_accounts WHERE id = ?'
  ).bind(accountId).first() as any

  if (!account) {
    return c.json({ error: '계정을 찾을 수 없습니다.' }, 404)
  }

  if (account.is_registered) {
    return c.json({ success: true, message: '이미 등록된 계정입니다.' })
  }

  const classInConfig = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!classInConfig) {
    return c.json({ error: 'ClassIn API가 설정되지 않았습니다.' }, 400)
  }

  const password = account.account_password || generateDefaultPassword()
  const result = await registerVirtualAccount(
    classInConfig,
    account.account_uid,
    account.assigned_name || 'Student',
    password
  )

  if (result.success) {
    const classInUid = result.uid || account.account_uid
    await c.env.DB.prepare(`
      UPDATE classin_virtual_accounts
      SET is_registered = 1, registered_at = datetime('now'), account_password = ?, classin_uid = ?, error_message = '', updated_at = datetime('now')
      WHERE id = ?
    `).bind(password, classInUid, accountId).run()

    if (account.user_id) {
      await c.env.DB.prepare(
        'UPDATE users SET classin_registered = 1 WHERE id = ?'
      ).bind(account.user_id).run()
    }

    return c.json({ success: true, message: 'ClassIn 등록 완료', classInUid })
  } else {
    await c.env.DB.prepare(
      'UPDATE classin_virtual_accounts SET error_message = ?, updated_at = datetime("now") WHERE id = ?'
    ).bind(result.error || 'Unknown error', accountId).run()
    return c.json({ success: false, error: result.error })
  }
})

// Get user's ClassIn account info
app.get('/api/user/:userId/classin-account', async (c) => {
  const userId = c.req.param('userId')

  const account = await c.env.DB.prepare(`
    SELECT va.*, u.name as user_name, u.email as user_email
    FROM classin_virtual_accounts va
    JOIN users u ON va.user_id = u.id
    WHERE va.user_id = ?
  `).bind(userId).first()

  if (!account) {
    return c.json({ hasAccount: false })
  }

  return c.json({ hasAccount: true, account })
})

// ==================== ClassIn Session API Routes ====================

// Get user's ClassIn sessions (for My Page)
app.get('/api/user/:userId/classin-sessions', async (c) => {
  const userId = c.req.param('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT cs.*, c.title as class_title, c.slug as class_slug, c.thumbnail as class_thumbnail,
           c.schedule_start, c.class_type, c.level,
           i.display_name as instructor_name, i.profile_image as instructor_image
    FROM classin_sessions cs
    JOIN classes c ON cs.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE cs.user_id = ?
    ORDER BY cs.scheduled_at ASC
  `).bind(userId).all()

  // join URL이 비어있는 세션이 있으면 재생성 시도
  const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  for (const session of results as any[]) {
    // join URL이 비어있으면 재생성
    if (!session.classin_join_url && session.classin_class_id && session.classin_course_id) {
      const enrollment = await c.env.DB.prepare(
        'SELECT classin_account_uid FROM enrollments WHERE id = ?'
      ).bind(session.enrollment_id).first() as any
      const studentUid = enrollment?.classin_account_uid || ''

      let newUrl = ''
      if (classInConfig && studentUid) {
        const loginUrlResult = await getClassInLoginUrl(classInConfig, studentUid, session.classin_course_id, session.classin_class_id, 1)
        newUrl = loginUrlResult.url || `https://www.eeo.cn/client/invoke/index.html?uid=${studentUid}&classId=${session.classin_class_id}&courseId=${session.classin_course_id}&schoolId=${classInConfig.SID}`
      } else if (classInConfig) {
        newUrl = `https://www.eeo.cn/client/invoke/index.html?classId=${session.classin_class_id}&courseId=${session.classin_course_id}&schoolId=${classInConfig.SID}`
      }

      if (newUrl) {
        await c.env.DB.prepare('UPDATE classin_sessions SET classin_join_url = ? WHERE id = ?').bind(newUrl, session.id).run()
        session.classin_join_url = newUrl
      }
    }

    // 종료된 강의의 경우 webcast URL 가져오기 (다시보기용)
    const startTime = session.scheduled_at ? new Date(session.scheduled_at).getTime() : 0
    const duration = (session.duration_minutes || 60) * 60 * 1000
    const isEnded = session.status === 'ended' || (startTime > 0 && (startTime + duration) < Date.now())

    if (isEnded && !session.classin_live_url && session.classin_course_id && session.classin_class_id && classInConfig) {
      // 다시보기 URL(webcast) 가져오기
      const webcastResult = await getClassInWebcastUrl(classInConfig, session.classin_course_id, session.classin_class_id)
      if (webcastResult.url) {
        await c.env.DB.prepare('UPDATE classin_sessions SET classin_live_url = ?, status = ? WHERE id = ?')
          .bind(webcastResult.url, 'ended', session.id).run()
        session.classin_live_url = webcastResult.url
        session.status = 'ended'
      }
    }

    // 종료된 강의은 다시보기 URL 사용
    if (isEnded && session.classin_live_url) {
      session.replay_url = session.classin_live_url
    }
  }

  return c.json(results)
})

// Get specific ClassIn session detail (for classroom entry page)
app.get('/api/classin-session/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const session: any = await c.env.DB.prepare(`
    SELECT cs.*, c.title as class_title, c.slug as class_slug, c.thumbnail as class_thumbnail,
           c.description as class_description, c.schedule_start, c.duration_minutes as class_duration,
           c.total_lessons, c.class_type, c.level,
           i.display_name as instructor_name, i.profile_image as instructor_image,
           i.bio as instructor_bio, i.specialty as instructor_specialty
    FROM classin_sessions cs
    JOIN classes c ON cs.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE cs.id = ?
  `).bind(sessionId).first()
  if (!session) return c.json({ error: 'Session not found' }, 404)

  // 종료된 강의의 경우 replay_url 설정 (다시보기용)
  const startTime = session.scheduled_at ? new Date(session.scheduled_at).getTime() : 0
  const duration = (session.duration_minutes || 60) * 60 * 1000
  const isEnded = session.status === 'ended' || (startTime > 0 && (startTime + duration) < Date.now())

  if (isEnded) {
    // classin_live_url이 없으면 webcast API 호출
    if (!session.classin_live_url && session.classin_course_id && session.classin_class_id) {
      const classInConfig: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
        ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
        : null
      if (classInConfig) {
        const webcastResult = await getClassInWebcastUrl(classInConfig, session.classin_course_id, session.classin_class_id)
        if (webcastResult.url) {
          await c.env.DB.prepare('UPDATE classin_sessions SET classin_live_url = ?, status = ? WHERE id = ?')
            .bind(webcastResult.url, 'ended', session.id).run()
          session.classin_live_url = webcastResult.url
          session.status = 'ended'
        }
      }
    }
    // replay_url 설정
    if (session.classin_live_url) {
      session.replay_url = session.classin_live_url
    }
  }

  return c.json(session)
})

// Get ClassIn session by enrollment (alternative lookup)
app.get('/api/enrollment/:enrollmentId/classin-session', async (c) => {
  const enrollmentId = c.req.param('enrollmentId')
  const session = await c.env.DB.prepare(`
    SELECT cs.*, c.title as class_title, c.slug as class_slug, c.thumbnail as class_thumbnail,
           c.schedule_start, c.class_type,
           i.display_name as instructor_name, i.profile_image as instructor_image
    FROM classin_sessions cs
    JOIN classes c ON cs.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE cs.enrollment_id = ?
    ORDER BY cs.created_at DESC LIMIT 1
  `).bind(enrollmentId).first()
  if (!session) return c.json({ error: 'No ClassIn session found' }, 404)
  return c.json(session)
})

// Generate fresh login URL for entering a class (로그인 토큰 포함 URL 동적 생성)
// Use ?redirect=true to automatically redirect to the ClassIn URL
app.get('/api/classin/enter/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const shouldRedirect = c.req.query('redirect') === 'true'

  const session = await c.env.DB.prepare(`
    SELECT cs.*, e.classin_account_uid, e.user_id, u.name as user_name
    FROM classin_sessions cs
    JOIN enrollments e ON cs.enrollment_id = e.id
    JOIN users u ON e.user_id = u.id
    WHERE cs.id = ?
  `).bind(sessionId).first() as any

  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const classInConfig = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!classInConfig) {
    return c.json({ error: 'ClassIn API not configured' }, 400)
  }

  const studentUid = session.classin_account_uid
  if (!studentUid) {
    return c.json({ error: 'No ClassIn account assigned' }, 400)
  }

  // Get virtual account info
  const virtualAccount = await c.env.DB.prepare(
    'SELECT account_uid FROM classin_virtual_accounts WHERE classin_uid = ? OR account_uid = ?'
  ).bind(studentUid, studentUid).first() as any

  const accountUid = virtualAccount?.account_uid || studentUid
  const userName = session.user_name || 'Student'

  // Step 1: Ensure student is registered with school (기관에 학생 추가)
  const schoolResult = await addSchoolStudent(classInConfig, accountUid, userName)
  console.log('addSchoolStudent result:', JSON.stringify(schoolResult))

  // Step 2: Add student to course (코스에 학생 추가)
  const courseResult = await addStudentToCourse(classInConfig, session.classin_course_id, studentUid)
  console.log('addStudentToCourse result:', JSON.stringify(courseResult))

  // Step 3: Generate fresh login URL with token
  const userAgent = c.req.header('user-agent') || ''
  const deviceType = detectDeviceType(userAgent)
  const isMobile = isMobileDevice(userAgent)
  const loginUrlResult = await getClassInLoginUrl(
    classInConfig,
    studentUid,
    session.classin_course_id,
    session.classin_class_id,
    deviceType
  )

  if (loginUrlResult.url) {
    // Update the session with the fresh URL
    await c.env.DB.prepare('UPDATE classin_sessions SET classin_join_url = ? WHERE id = ?')
      .bind(loginUrlResult.url, sessionId).run()

    if (shouldRedirect) {
      if (isMobile && loginUrlResult.requiresManualLogin) {
        return c.html(renderMobileLoginPage(loginUrlResult.url, INSTRUCTOR_DEFAULT_PASSWORD, accountUid))
      }
      return c.redirect(loginUrlResult.url)
    }
    return c.json({ success: true, url: loginUrlResult.url })
  }

  // Fallback to basic URL
  const fallbackUrl = `https://www.eeo.cn/client/invoke/index.html?uid=${studentUid}&classId=${session.classin_class_id}&courseId=${session.classin_course_id}&schoolId=${classInConfig.SID}`
  if (shouldRedirect) {
    return c.redirect(fallbackUrl)
  }
  return c.json({ success: true, url: fallbackUrl, warning: loginUrlResult.error })
})

// 학생이 강의 ID로 직접 입장 (수강 여부 확인 후 ClassIn 입장 URL 생성)
app.get('/api/classin/lesson-enter/:lessonId', async (c) => {
  const lessonId = c.req.param('lessonId')
  const shouldRedirect = c.req.query('redirect') === 'true'
  const userId = c.req.query('userId')

  if (!userId) {
    if (shouldRedirect) {
      return c.html('<html><body><h2>로그인이 필요합니다.</h2><script>setTimeout(function(){window.close()},2000)</script></body></html>')
    }
    return c.json({ error: 'userId required' }, 400)
  }

  // 1. 강의 정보 가져오기
  const lesson = await c.env.DB.prepare(`
    SELECT cl.*, c.id as course_id, c.price as course_price, c.title as course_title
    FROM class_lessons cl
    JOIN classes c ON cl.class_id = c.id
    WHERE cl.id = ?
  `).bind(lessonId).first() as any

  if (!lesson) {
    if (shouldRedirect) {
      return c.html('<html><body><h2>강의를 찾을 수 없습니다.</h2><script>setTimeout(function(){window.close()},2000)</script></body></html>')
    }
    return c.json({ error: 'Lesson not found' }, 404)
  }

  // 2. 수강 여부 확인 (무료 코스는 바로 입장)
  const isFree = !lesson.course_price
  let enrollment: any = null

  if (!isFree) {
    enrollment = await c.env.DB.prepare(`
      SELECT e.*, u.name as user_name
      FROM enrollments e
      JOIN users u ON e.user_id = u.id
      WHERE e.user_id = ? AND e.class_id = ? AND e.status = 'active'
    `).bind(userId, lesson.course_id).first()

    if (!enrollment) {
      if (shouldRedirect) {
        return c.html('<html><body><h2>코스 결제가 필요합니다.</h2><p>이 강의에 입장하려면 먼저 코스를 결제해주세요.</p><script>setTimeout(function(){window.close()},3000)</script></body></html>')
      }
      return c.json({ error: 'Enrollment required' }, 403)
    }
  } else {
    // 무료 코스는 사용자 정보만 가져옴
    enrollment = await c.env.DB.prepare('SELECT id, name as user_name FROM users WHERE id = ?').bind(userId).first()
  }

  // 3. ClassIn 설정 확인
  const classInConfig = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!classInConfig) {
    // ClassIn 미설정 - join_url이 있으면 사용
    if (lesson.join_url) {
      if (shouldRedirect) return c.redirect(lesson.join_url)
      return c.json({ success: true, url: lesson.join_url })
    }
    if (shouldRedirect) {
      return c.html('<html><body><h2>강의 입장 URL이 준비되지 않았습니다.</h2><script>setTimeout(function(){window.close()},2000)</script></body></html>')
    }
    return c.json({ error: 'No ClassIn config and no join_url' }, 400)
  }

  // 4. ClassIn 계정 확보 (enrollment에서 또는 가상계정)
  let studentUid = enrollment?.classin_account_uid

  if (!studentUid) {
    // 가상 계정 할당 시도
    const virtualAccount = await c.env.DB.prepare(`
      SELECT id, account_uid FROM classin_virtual_accounts
      WHERE is_used = 0 OR is_used IS NULL
      ORDER BY id ASC LIMIT 1
    `).first() as any

    if (virtualAccount) {
      studentUid = virtualAccount.account_uid
      // 사용 표시 및 enrollment에 저장
      await c.env.DB.prepare('UPDATE classin_virtual_accounts SET is_used = 1, used_by_user_id = ? WHERE id = ?')
        .bind(userId, virtualAccount.id).run()
      if (!isFree && enrollment) {
        await c.env.DB.prepare('UPDATE enrollments SET classin_account_uid = ? WHERE id = ?')
          .bind(studentUid, enrollment.id).run()
      }
    }
  }

  if (!studentUid) {
    if (shouldRedirect) {
      return c.html('<html><body><h2>ClassIn 계정이 준비되지 않았습니다.</h2><p>관리자에게 문의해주세요.</p><script>setTimeout(function(){window.close()},3000)</script></body></html>')
    }
    return c.json({ error: 'No ClassIn account available' }, 400)
  }

  // 5. 강의에 ClassIn 정보가 있는지 확인
  if (!lesson.classin_course_id || !lesson.classin_class_id) {
    // ClassIn 강의 정보가 없음 - join_url 사용
    if (lesson.join_url) {
      if (shouldRedirect) return c.redirect(lesson.join_url)
      return c.json({ success: true, url: lesson.join_url })
    }
    if (shouldRedirect) {
      return c.html('<html><body><h2>강의 입장 정보가 준비되지 않았습니다.</h2><script>setTimeout(function(){window.close()},2000)</script></body></html>')
    }
    return c.json({ error: 'Lesson has no ClassIn info' }, 400)
  }

  const userName = enrollment?.user_name || 'Student'

  // 6. 학생을 기관과 코스에 추가 (독립적이므로 병렬 실행)
  const [schoolResult, courseResult] = await Promise.all([
    addSchoolStudent(classInConfig, studentUid, userName),
    addStudentToCourse(classInConfig, lesson.classin_course_id, studentUid)
  ])
  console.log('lesson-enter addSchoolStudent:', JSON.stringify(schoolResult))
  console.log('lesson-enter addStudentToCourse:', JSON.stringify(courseResult))

  // 7. 로그인 URL 생성
  const userAgent = c.req.header('user-agent') || ''
  const deviceType = detectDeviceType(userAgent)
  const isMobile = isMobileDevice(userAgent)
  const loginUrlResult = await getClassInLoginUrl(
    classInConfig,
    studentUid,
    lesson.classin_course_id,
    lesson.classin_class_id,
    deviceType
  )

  if (loginUrlResult.url) {
    if (shouldRedirect) {
      if (isMobile && loginUrlResult.requiresManualLogin) {
        return c.html(renderMobileLoginPage(loginUrlResult.url, INSTRUCTOR_DEFAULT_PASSWORD, studentUid))
      }
      return c.redirect(loginUrlResult.url)
    }
    return c.json({ success: true, url: loginUrlResult.url })
  }

  // Fallback URL
  const fallbackUrl = `https://www.eeo.cn/client/invoke/index.html?uid=${studentUid}&classId=${lesson.classin_class_id}&courseId=${lesson.classin_course_id}&schoolId=${classInConfig.SID}`
  if (shouldRedirect) return c.redirect(fallbackUrl)
  return c.json({ success: true, url: fallbackUrl, warning: loginUrlResult.error })
})

// Generate fresh login URL for instructor entering a class (강사 입장 URL 동적 생성)
// 강사 본인의 ClassIn 계정(classin_uid)을 사용하여 입장
app.get('/api/classin/instructor-enter/:lessonId', async (c) => {
  const lessonId = c.req.param('lessonId')
  const shouldRedirect = c.req.query('redirect') === 'true'
  const mode = c.req.query('mode') || 'instructor'  // 'instructor' (강사) or 'observer' (청강생)
  try {

  // Get lesson info with instructor details (including virtual account)
  const lesson = await c.env.DB.prepare(`
    SELECT cl.*, c.instructor_id, i.user_id as instructor_user_id, i.classin_uid as instructor_classin_uid,
           i.classin_virtual_account as instructor_virtual_account, i.display_name as instructor_name,
           u.email as instructor_email, u.phone as instructor_phone
    FROM class_lessons cl
    JOIN classes c ON cl.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    JOIN users u ON i.user_id = u.id
    WHERE cl.id = ?
  `).bind(lessonId).first() as any

  if (!lesson) {
    if (shouldRedirect) {
      return c.html('<html><body><h2>강의를 찾을 수 없습니다.</h2></body></html>')
    }
    return c.json({ error: 'Lesson not found' }, 404)
  }

  const classInConfig = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!classInConfig) {
    if (shouldRedirect) {
      return c.html('<html><body><h2>ClassIn API가 설정되지 않았습니다.</h2></body></html>')
    }
    return c.json({ error: 'ClassIn API not configured' }, 400)
  }

  // 환경에 따라 가상계정 또는 실제 강사 계정 사용
  const useVirtualAccount = c.env.USE_INSTRUCTOR_VIRTUAL_ACCOUNT === 'true'

  let virtualAccount = ''
  let instructorUid = ''

  if (useVirtualAccount) {
    // T(teachers): 가상계정 사용 (authTicket 발급 + 강사 권한)
    // 강사에게 이미 classin_uid가 있으면 해당 UID의 가상계정을 사용 (수업 생성 시 teacherUid와 일치해야 함)
    if (lesson.instructor_classin_uid) {
      const existingVa = await c.env.DB.prepare(
        'SELECT account_uid FROM classin_virtual_accounts WHERE classin_uid = ?'
      ).bind(lesson.instructor_classin_uid).first() as any
      if (existingVa) {
        virtualAccount = existingVa.account_uid
        instructorUid = lesson.instructor_classin_uid
      }
    }

    if (!virtualAccount) {
      virtualAccount = lesson.instructor_virtual_account || ''
    }

    // 가상계정이 없으면 할당
    if (!virtualAccount) {
      const available = await c.env.DB.prepare(`
        SELECT * FROM classin_virtual_accounts
        WHERE status = 'available' AND (is_registered = 0 OR is_registered IS NULL) AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY id LIMIT 1
      `).first() as any

      if (!available) {
        if (shouldRedirect) {
          return c.html('<html><body><h2>사용 가능한 가상계정이 없습니다.</h2><p>관리자에게 문의하세요.</p></body></html>')
        }
        return c.json({ error: '사용 가능한 가상계정이 없습니다.' }, 400)
      }

      virtualAccount = available.account_uid

      // 강사에게 가상계정 할당
      await c.env.DB.prepare(`UPDATE instructors SET classin_virtual_account = ? WHERE id = ?`)
        .bind(virtualAccount, lesson.instructor_id).run()

      // 가상계정 상태 업데이트
      await c.env.DB.prepare(`
        UPDATE classin_virtual_accounts
        SET status = 'assigned', assigned_name = ?, assigned_at = datetime('now')
        WHERE id = ?
      `).bind('INSTRUCTOR:' + lesson.instructor_name, available.id).run()

      console.log('Assigned virtual account to instructor:', virtualAccount)
    }

    // 가상계정으로 ClassIn 등록 (이미 UID가 있으면 건너뜀)
    if (instructorUid) {
      console.log('Using existing instructor UID:', instructorUid, 'with virtual account:', virtualAccount)
    }
    const regResult = !instructorUid ? await registerVirtualAccount(classInConfig, virtualAccount, lesson.instructor_name || 'Instructor', INSTRUCTOR_DEFAULT_PASSWORD) : { uid: instructorUid, success: true }
    console.log('Virtual account register result:', JSON.stringify(regResult))

    if (regResult.uid) {
      instructorUid = regResult.uid

      // 가상계정 UID 저장
      await c.env.DB.prepare(`
        UPDATE classin_virtual_accounts
        SET is_registered = 1, classin_uid = ?, updated_at = datetime('now')
        WHERE account_uid = ?
      `).bind(instructorUid, virtualAccount).run()
    } else {
      // 이미 등록된 경우 UID 조회
      const existingAccount = await c.env.DB.prepare(
        'SELECT classin_uid FROM classin_virtual_accounts WHERE account_uid = ?'
      ).bind(virtualAccount).first() as any
      instructorUid = existingAccount?.classin_uid || ''
    }

    if (!instructorUid) {
      const errorMsg = '가상계정 등록 실패'
      if (shouldRedirect) {
        return c.html(`<html><body><h2>강사 입장 실패</h2><p>${errorMsg}</p></body></html>`)
      }
      return c.json({ error: errorMsg }, 400)
    }

    // 코스에 강사(조교)로 먼저 추가 - 강의실 내 강사 권한 부여!
    const addToCourseResult = await addTeacherToCourse(classInConfig, lesson.classin_course_id, instructorUid)
    console.log('addTeacherToCourse result:', JSON.stringify(addToCourseResult))

    // 학교 학생으로 추가 (authTicket 발급을 위해 필수!)
    const schoolResult = await addSchoolStudent(classInConfig, virtualAccount, lesson.instructor_name || 'Instructor')
    console.log('addSchoolStudent (instructor) result:', JSON.stringify(schoolResult))

    // 강사 이름으로 닉네임 복구 (학생 등록 시 덮어씌워졌을 수 있으므로)
    if (instructorUid && lesson.instructor_name) {
      const editResult = await editUserInfo(classInConfig, instructorUid, lesson.instructor_name)
      console.log('editUserInfo (instructor name restore) result:', JSON.stringify(editResult))
    }
  } else {
    // L(live): 실제 강사 계정 사용
    if (!lesson.instructor_classin_uid) {
      const errorMsg = '강사가 ClassIn에 등록되지 않았습니다.'
      if (shouldRedirect) {
        return c.html(`<html><body><h2>강사 입장 실패</h2><p>${errorMsg}</p></body></html>`)
      }
      return c.json({ error: errorMsg }, 400)
    }
    instructorUid = lesson.instructor_classin_uid
    console.log('Using real instructor account, UID:', instructorUid)
  }

  // Generate fresh login URL with token
  // mode=instructor: identity=3 (강사), mode=observer: identity=2 (청강생)
  const identity = mode === 'observer' ? 2 : 3
  const userAgent = c.req.header('user-agent') || ''
  const deviceType = detectDeviceType(userAgent)
  const isMobile = isMobileDevice(userAgent)
  const loginUrlResult = await getClassInLoginUrl(
    classInConfig,
    instructorUid,  // 가상계정 ClassIn UID 사용
    lesson.classin_course_id,
    lesson.classin_class_id,
    deviceType,
    identity  // 강사(3) 또는 청강생(2)
  )
  console.log('getClassInLoginUrl result:', JSON.stringify(loginUrlResult))

  if (loginUrlResult.url) {
    // Update the lesson with the fresh URL
    await c.env.DB.prepare('UPDATE class_lessons SET classin_instructor_url = ? WHERE id = ?')
      .bind(loginUrlResult.url, lessonId).run()

    // Also update classes table for latest lesson
    await c.env.DB.prepare('UPDATE classes SET classin_instructor_url = ? WHERE id = ?')
      .bind(loginUrlResult.url, lesson.class_id).run()

    if (shouldRedirect) {
      // 모바일 + 수동 로그인 필요 시 비밀번호를 보여주는 중간 페이지
      if (isMobile && loginUrlResult.requiresManualLogin) {
        return c.html(renderMobileLoginPage(loginUrlResult.url, INSTRUCTOR_DEFAULT_PASSWORD, virtualAccount))
      }
      // authTicket이 있으면 바로 리다이렉트 (자동 로그인)
      return c.redirect(loginUrlResult.url)
    }
    return c.json({ success: true, url: loginUrlResult.url, requiresManualLogin: loginUrlResult.requiresManualLogin })
  }

  // URL 생성 실패 - 디버그 정보 표시
  const debugInfo = {
    instructorUid,
    virtualAccount,
    courseId: lesson.classin_course_id,
    classId: lesson.classin_class_id,
    error: loginUrlResult.error,
    rawResponse: loginUrlResult.rawResponse
  }
  console.log('getClassInLoginUrl failed:', JSON.stringify(debugInfo))

  if (shouldRedirect) {
    return c.html(`
      <html><body style="font-family: sans-serif; padding: 20px;">
        <h2>ClassIn 입장 URL 생성 실패</h2>
        <p><strong>오류:</strong> ${loginUrlResult.error || 'URL 생성 실패'}</p>
        <h3>디버그 정보:</h3>
        <pre style="background: #f5f5f5; padding: 10px; overflow: auto;">${JSON.stringify(debugInfo, null, 2)}</pre>
      </body></html>
    `)
  }
  return c.json({ success: false, error: loginUrlResult.error, debug: debugInfo })
  } catch (err: any) {
    console.error('instructor-enter error:', err)
    if (shouldRedirect) {
      return c.html(`<html><body style="font-family:sans-serif;padding:20px"><h2>강사 입장 오류</h2><p>${err.message}</p><pre>${err.stack || ''}</pre></body></html>`)
    }
    return c.json({ error: err.message }, 500)
  }
})

// ==================== Subscription API Routes ====================

// Create a new subscription (월간 자동결제)
app.post('/api/subscription/create', async (c) => {
  const { userId, planType, classId, amount, paymentMethod, cardNumber, cardExpiry, cardCvc } = await c.req.json()
  
  if (!userId || !planType || !amount) return c.json({ error: '필수 정보가 누락되었습니다.' }, 400)
  
  // Check if user already has active subscription of same type
  const existing = await c.env.DB.prepare(`
    SELECT id FROM subscriptions WHERE user_id = ? AND plan_type = ? AND status = 'active' ${classId ? 'AND class_id = ?' : 'AND class_id IS NULL'}
  `).bind(...(classId ? [userId, planType, classId] : [userId, planType])).first()
  
  if (existing) return c.json({ error: '이미 동일한 구독이 활성화되어 있습니다.' }, 400)
  
  const last4 = cardNumber ? cardNumber.replace(/\s/g, '').slice(-4) : '0000'
  const today = new Date()
  const billingDay = today.getDate() // 결제일 = 가입일 기준
  const txId = `SUB_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  
  // Calculate period end and next billing date (1 month later)
  const periodEnd = new Date(today)
  periodEnd.setMonth(periodEnd.getMonth() + 1)
  const nextBilling = new Date(periodEnd)
  
  // Create subscription
  const subResult = await c.env.DB.prepare(`
    INSERT INTO subscriptions (user_id, plan_type, class_id, amount, payment_method, card_last4, billing_day, status, started_at, current_period_start, current_period_end, next_billing_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'), ?, ?)
  `).bind(
    userId, planType, classId || null, amount,
    paymentMethod || 'card', last4, billingDay,
    periodEnd.toISOString(), nextBilling.toISOString()
  ).run()
  
  const subscriptionId = subResult.meta.last_row_id
  
  // Record first payment
  await c.env.DB.prepare(`
    INSERT INTO subscription_payments (subscription_id, user_id, amount, payment_status, transaction_id, billing_period_start, billing_period_end)
    VALUES (?, ?, ?, 'completed', ?, datetime('now'), ?)
  `).bind(subscriptionId, userId, amount, txId, periodEnd.toISOString()).run()
  
  // Also create order record
  await c.env.DB.prepare(`
    INSERT INTO orders (user_id, order_type, class_id, subscription_plan, amount, payment_method, payment_status, card_last4, transaction_id)
    VALUES (?, 'subscription', ?, ?, ?, ?, 'completed', ?, ?)
  `).bind(userId, classId || null, planType, amount, paymentMethod || 'card', last4, txId).run()
  
  // Update user subscription info
  await c.env.DB.prepare(`
    UPDATE users SET subscription_plan = 'monthly', subscription_expires_at = ? WHERE id = ?
  `).bind(periodEnd.toISOString(), userId).run()
  
  // If class subscription, also enroll in class + create ClassIn session
  let classinSession: ClassInSessionResult | null = null
  if (classId) {
    // Insert or update enrollment with subscription_id
    await c.env.DB.prepare(`
      INSERT INTO enrollments (user_id, class_id, subscription_id)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, class_id) DO UPDATE SET subscription_id = ?, status = 'active', updated_at = datetime('now')
    `).bind(userId, classId, subscriptionId, subscriptionId).run()
    const enrollment = await c.env.DB.prepare('SELECT id FROM enrollments WHERE user_id = ? AND class_id = ?').bind(userId, classId).first() as any
    await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ? AND class_id = ?').bind(userId, classId).run()
    await c.env.DB.prepare('UPDATE classes SET current_students = current_students + 1 WHERE id = ?').bind(classId).run()
    
    const classInConfig: ClassInConfig | undefined = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
      ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
      : undefined
    classinSession = await createClassInSession(c.env.DB, classId, userId, enrollment?.id || 0, classInConfig)
  }
  
  return c.json({
    success: true,
    subscriptionId,
    transactionId: txId,
    billingDay,
    nextBillingDate: nextBilling.toISOString(),
    periodEnd: periodEnd.toISOString(),
    message: `월간 자동결제가 시작되었습니다! 매월 ${billingDay}일에 자동 결제됩니다.`,
    classinSession: classinSession ? {
      joinUrl: classinSession.joinUrl,
      classId: classinSession.classId,
      isDemo: !c.env.CLASSIN_SID
    } : null
  })
})

// Get user's subscriptions
app.get('/api/user/:userId/subscriptions', async (c) => {
  const userId = c.req.param('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT s.*, c.title as class_title, c.slug as class_slug, c.thumbnail as class_thumbnail,
           c.instructor_id, i.display_name as instructor_name
    FROM subscriptions s
    LEFT JOIN classes c ON s.class_id = c.id
    LEFT JOIN instructors i ON c.instructor_id = i.id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `).bind(userId).all()
  return c.json(results)
})

// Get subscription payment history
app.get('/api/subscription/:subId/payments', async (c) => {
  const subId = c.req.param('subId')
  const { results } = await c.env.DB.prepare(`
    SELECT * FROM subscription_payments WHERE subscription_id = ? ORDER BY created_at DESC
  `).bind(subId).all()
  return c.json(results)
})

// Cancel subscription
app.post('/api/subscription/:subId/cancel', async (c) => {
  const subId = c.req.param('subId')
  const { userId } = await c.req.json()
  
  const sub = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?').bind(subId, userId).first() as any
  if (!sub) return c.json({ error: '구독을 찾을 수 없습니다.' }, 404)
  if (sub.status !== 'active') return c.json({ error: '이미 해지된 구독입니다.' }, 400)
  
  // Cancel - subscription stays active until period end
  await c.env.DB.prepare(`
    UPDATE subscriptions SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `).bind(subId).run()
  
  return c.json({
    success: true,
    message: `구독이 해지되었습니다. ${new Date(sub.current_period_end).toLocaleDateString('ko-KR')}까지 이용 가능합니다.`,
    activeUntil: sub.current_period_end
  })
})

// Reactivate cancelled subscription
app.post('/api/subscription/:subId/reactivate', async (c) => {
  const subId = c.req.param('subId')
  const { userId } = await c.req.json()
  
  const sub = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?').bind(subId, userId).first() as any
  if (!sub) return c.json({ error: '구독을 찾을 수 없습니다.' }, 404)
  if (sub.status !== 'cancelled') return c.json({ error: '해지된 구독만 재활성화할 수 있습니다.' }, 400)
  
  await c.env.DB.prepare(`
    UPDATE subscriptions SET status = 'active', cancelled_at = NULL, updated_at = datetime('now') WHERE id = ?
  `).bind(subId).run()
  
  return c.json({ success: true, message: '구독이 다시 활성화되었습니다.' })
})

// Process automatic renewal (can be called by Cloudflare Cron Trigger)
app.post('/api/subscription/process-renewals', async (c) => {
  const now = new Date().toISOString()
  const { results: dueSubscriptions } = await c.env.DB.prepare(`
    SELECT s.*, u.name as user_name, u.email as user_email
    FROM subscriptions s JOIN users u ON s.user_id = u.id
    WHERE s.status = 'active' AND s.next_billing_date <= ? AND s.failed_attempts < 3
  `).bind(now).all() as any
  
  const results: any[] = []
  
  for (const sub of dueSubscriptions) {
    const txId = `RENEW_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const newPeriodStart = new Date(sub.current_period_end)
    const newPeriodEnd = new Date(newPeriodStart)
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1)
    const nextBilling = new Date(newPeriodEnd)
    
    // Demo mode: always succeed
    const paymentSuccess = true
    
    if (paymentSuccess) {
      // Record payment
      await c.env.DB.prepare(`
        INSERT INTO subscription_payments (subscription_id, user_id, amount, payment_status, transaction_id, billing_period_start, billing_period_end)
        VALUES (?, ?, ?, 'completed', ?, ?, ?)
      `).bind(sub.id, sub.user_id, sub.amount, txId, newPeriodStart.toISOString(), newPeriodEnd.toISOString()).run()
      
      // Update subscription
      await c.env.DB.prepare(`
        UPDATE subscriptions SET current_period_start = ?, current_period_end = ?, next_billing_date = ?, failed_attempts = 0, updated_at = datetime('now') WHERE id = ?
      `).bind(newPeriodStart.toISOString(), newPeriodEnd.toISOString(), nextBilling.toISOString(), sub.id).run()
      
      // Order record
      await c.env.DB.prepare(`
        INSERT INTO orders (user_id, order_type, class_id, subscription_plan, amount, payment_method, payment_status, card_last4, transaction_id)
        VALUES (?, 'subscription', ?, ?, ?, ?, 'completed', ?, ?)
      `).bind(sub.user_id, sub.class_id || null, sub.plan_type, sub.amount, sub.payment_method, sub.card_last4, txId).run()
      
      // Update user subscription expiry
      await c.env.DB.prepare(`UPDATE users SET subscription_expires_at = ? WHERE id = ?`).bind(newPeriodEnd.toISOString(), sub.user_id).run()
      
      results.push({ subscriptionId: sub.id, userId: sub.user_id, status: 'renewed', txId })
    } else {
      await c.env.DB.prepare(`
        UPDATE subscriptions SET failed_attempts = failed_attempts + 1, last_payment_error = '결제 실패', updated_at = datetime('now') WHERE id = ?
      `).bind(sub.id).run()
      results.push({ subscriptionId: sub.id, userId: sub.user_id, status: 'failed' })
    }
  }
  
  return c.json({ processed: results.length, results })
})

// ClassIn API Config status
app.get('/api/classin/status', async (c) => {
  const isConfigured = !!(c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
  return c.json({ 
    configured: isConfigured,
    mode: isConfigured ? 'production' : 'demo',
    message: isConfigured 
      ? 'ClassIn API가 연결되어 있습니다.' 
      : 'ClassIn API 데모 모드로 운영 중입니다. 실제 연동은 SID/SECRET 설정이 필요합니다.'
  })
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

// ==================== 헥토파이낸셜 PG Payment API ====================

// 헥토 PG 설정 상태 확인
app.get('/api/payment/hecto/status', async (c) => {
  const isConfigured = !!(c.env.HECTO_MID && c.env.HECTO_LICENSE_KEY && c.env.HECTO_AES_KEY)
  return c.json({
    configured: isConfigured,
    mode: c.env.HECTO_PAYMENT_SERVER?.includes('tbnpg') ? 'test' : 'production',
    mid: c.env.HECTO_MID || ''
  })
})

// 해시 테스트 엔드포인트
app.get('/api/payment/hecto/test-hash', async (c) => {
  const config = {
    MID: c.env.HECTO_MID || 'nxca_jt_il',
    LICENSE_KEY: c.env.HECTO_LICENSE_KEY || 'ST1009281328226982205',
    AES_KEY: c.env.HECTO_AES_KEY || 'pgSettle30y739r82jtd709yOfZ2yK5K'
  }
  
  // AES 암호화 테스트
  const testEncrypted = await aes256Encrypt('1000', config.AES_KEY)
  
  // 헥토 제공 테스트값
  const testPlain = 'nxca_jt_ilcardPG_card_20260402081633202604020816331000ST1009281328226982205'
  const expectedHash = '7c24546a160f4ecb9b68dc9c43302ed3ec47d0b8a0babff314f3e04ede97078c'
  const calculatedHash = await sha256Hash(testPlain)
  
  // 현재 시간으로 생성
  const now = new Date()
  const trdDt = now.toISOString().slice(0, 10).replace(/-/g, '')
  const trdTm = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const mchtTrdNo = 'PG_card_' + trdDt + trdTm + '0001'
  const trdAmt = '1000'
  
  const currentPlain = config.MID + 'card' + mchtTrdNo + trdDt + trdTm + trdAmt + config.LICENSE_KEY
  const currentHash = await sha256Hash(currentPlain)
  
  return c.json({
    aesTest: {
      input: '1000',
      encrypted: testEncrypted,
      key: config.AES_KEY.slice(0, 8) + '...'
    },
    test: {
      plain: testPlain,
      expectedHash,
      calculatedHash,
      match: calculatedHash === expectedHash
    },
    current: {
      mchtId: config.MID,
      method: 'card',
      mchtTrdNo,
      trdDt,
      trdTm,
      trdAmt,
      licenseKey: config.LICENSE_KEY.slice(0, 8) + '...',
      plain: currentPlain,
      hash: currentHash
    }
  })
})

// 결제 요청 준비 (파라미터 암호화 및 해시 생성)
app.post('/api/payment/hecto/prepare', async (c) => {
  const {
    classId,
    lessonId,
    userId,
    amount,
    productName,
    customerName,
    customerPhone,
    customerEmail,
    orderType  // 'class' | 'lesson' | 'subscription'
  } = await c.req.json()

  if (!c.env.HECTO_MID || !c.env.HECTO_LICENSE_KEY || !c.env.HECTO_AES_KEY) {
    return c.json({ error: '헥토파이낸셜 PG 설정이 완료되지 않았습니다.' }, 500)
  }

  const config: HectoConfig = {
    MID: c.env.HECTO_MID,
    LICENSE_KEY: c.env.HECTO_LICENSE_KEY,
    AES_KEY: c.env.HECTO_AES_KEY,
    PAYMENT_SERVER: c.env.HECTO_PAYMENT_SERVER || 'https://tbnpg.settlebank.co.kr',
    CANCEL_SERVER: c.env.HECTO_CANCEL_SERVER || 'https://tbgw.settlebank.co.kr'
  }

  // 한국 시간 (KST = UTC+9)
  const now = new Date()
  const kstOffset = 9 * 60 * 60 * 1000
  const kstDate = new Date(now.getTime() + kstOffset)
  const trdDt = kstDate.toISOString().slice(0, 10).replace(/-/g, '')
  const trdTm = kstDate.toISOString().slice(11, 19).replace(/:/g, '')
  // PHP 샘플 형식: PAYMENT + 날짜 + 시간 (랜덤 제외)
  const mchtTrdNo = 'PAYMENT' + trdDt + trdTm

  // DB에 주문 생성 (pending 상태)
  const orderResult = await c.env.DB.prepare(`
    INSERT INTO orders (user_id, order_type, class_id, amount, payment_method, payment_status, transaction_id)
    VALUES (?, ?, ?, ?, 'card', 'pending', ?)
  `).bind(userId, orderType || 'class', classId || null, amount, mchtTrdNo).run()
  const orderId = orderResult.meta.last_row_id

  // mchtParam에 주문 정보 저장 (결제 완료 후 처리용)
  const mchtParam = `${orderId}|${userId}|${classId || ''}|${lessonId || ''}|${orderType || 'class'}`

  const params = {
    mchtId: config.MID,
    method: 'card',
    mchtTrdNo,
    trdDt,
    trdTm,
    trdAmt: String(amount),
    mchtCustNm: customerName || '',
    cphoneNo: customerPhone || '',
    email: customerEmail || '',
    mchtCustId: String(userId)
  }

  const { encParams, pktHash, hashDebug } = await encryptHectoPaymentParams(config, params)

  // 결과 URL 생성
  const baseUrl = c.req.url.replace(/\/api\/.*$/, '')

  return c.json({
    success: true,
    orderId,
    hashDebug,
    paymentParams: {
      // PHP 샘플 순서와 동일하게
      env: config.PAYMENT_SERVER,
      mchtId: config.MID,
      method: 'card',
      trdDt,
      trdTm,
      mchtTrdNo,
      mchtName: c.env.APP_NAME_KO || '클래신',
      mchtEName: c.env.APP_NAME || 'ClassIn',
      pmtPrdtNm: productName || '강의 결제',
      trdAmt: encParams.trdAmt,
      mchtCustNm: encParams.mchtCustNm || '',
      custAcntSumry: '',
      expireDt: '',
      notiUrl: `${baseUrl}/api/payment/hecto/noti`,
      nextUrl: `${baseUrl}/api/payment/hecto/result`,
      cancUrl: `${baseUrl}/api/payment/hecto/result`,
      mchtParam,
      cphoneNo: params.cphoneNo || '',  // 평문으로 전송
      email: params.email || '',  // 평문으로 전송
      telecomCd: '',
      prdtTerm: '',
      mchtCustId: encParams.mchtCustId || '',
      taxTypeCd: '',
      taxAmt: '',
      vatAmt: '',
      taxFreeAmt: '',
      svcAmt: '',
      cardType: '',
      chainUserId: '',
      cardGb: '',
      clipCustNm: '',
      clipCustCi: '',
      clipCustPhoneNo: '',
      certNotiUrl: '',
      skipCd: '',
      multiPay: '',
      autoPayType: '',
      linkMethod: '',
      appScheme: '',
      custIp: '',
      corpPayCode: '',
      corpPayType: '',
      cashRcptUIYn: '',
      pktHash,
      ui: {
        type: 'popup',
        width: '430',
        height: '660'
      }
    }
  })
})

// 결제 결과 수신 (nextUrl/cancUrl로 호출됨)
app.post('/api/payment/hecto/result', async (c) => {
  const formData = await c.req.parseBody()

  const config: HectoConfig = {
    MID: c.env.HECTO_MID || '',
    LICENSE_KEY: c.env.HECTO_LICENSE_KEY || '',
    AES_KEY: c.env.HECTO_AES_KEY || '',
    PAYMENT_SERVER: c.env.HECTO_PAYMENT_SERVER || '',
    CANCEL_SERVER: c.env.HECTO_CANCEL_SERVER || ''
  }

  // 결과 파라미터 복호화
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(formData)) {
    params[key] = String(value)
  }

  const decryptedParams = await decryptHectoResultParams(config, params)

  // 결과 페이지 HTML 반환 (부모창으로 결과 전달)
  const resultHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>결제 결과</title>
  <style>
    body { font-family: 'Noto Sans KR', sans-serif; padding: 20px; text-align: center; }
    .result { max-width: 400px; margin: 50px auto; padding: 30px; border: 1px solid #e5e7eb; border-radius: 12px; }
    .success { background-color: #f0fdf4; border-color: #22c55e; }
    .fail { background-color: #fef2f2; border-color: #ef4444; }
    h2 { margin-bottom: 20px; }
    .btn { display: inline-block; padding: 12px 24px; background: #e11d48; color: white; border-radius: 8px; text-decoration: none; cursor: pointer; border: none; font-size: 16px; }
  </style>
</head>
<body>
  <div class="result ${decryptedParams.outStatCd === '0021' ? 'success' : 'fail'}">
    <h2>${decryptedParams.outStatCd === '0021' ? '결제 완료' : '결제 실패'}</h2>
    <p>${decryptedParams.outRsltMsg || ''}</p>
    <p>주문번호: ${decryptedParams.mchtTrdNo || ''}</p>
    ${decryptedParams.outStatCd === '0021' ? `<p>거래금액: ${Number(decryptedParams.trdAmt || 0).toLocaleString()}원</p>` : ''}
    <button class="btn" onclick="sendResult()">확인</button>
  </div>
  <script>
    var _PAY_RESULT = ${JSON.stringify(decryptedParams)};
    function sendResult() {
      if (window.opener) {
        window.opener.postMessage({ type: 'HECTO_PAYMENT_RESULT', data: _PAY_RESULT }, '*');
        window.close();
      } else if (window.parent) {
        window.parent.postMessage({ type: 'HECTO_PAYMENT_RESULT', data: _PAY_RESULT }, '*');
      } else {
        window.location.href = '/my/orders';
      }
    }
  </script>
</body>
</html>`

  return c.html(resultHtml)
})

// 결제 노티 수신 (서버간 통신, notiUrl로 호출됨)
app.post('/api/payment/hecto/noti', async (c) => {
  const formData = await c.req.parseBody()

  const config: HectoConfig = {
    MID: c.env.HECTO_MID || '',
    LICENSE_KEY: c.env.HECTO_LICENSE_KEY || '',
    AES_KEY: c.env.HECTO_AES_KEY || '',
    PAYMENT_SERVER: c.env.HECTO_PAYMENT_SERVER || '',
    CANCEL_SERVER: c.env.HECTO_CANCEL_SERVER || ''
  }

  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(formData)) {
    params[key] = String(value)
  }

  console.log('[Hecto Noti] Received:', JSON.stringify(params))

  // 해시 검증
  const isValidHash = await verifyHectoNotiHash(config, {
    outStatCd: params.outStatCd || '',
    trdDtm: params.trdDtm || '',
    mchtId: params.mchtId || '',
    mchtTrdNo: params.mchtTrdNo || '',
    trdAmt: params.trdAmt || '',
    pktHash: params.pktHash || ''
  })

  if (!isValidHash) {
    console.log('[Hecto Noti] Hash verification failed')
    return c.text('FAIL')
  }

  // 결제 성공 처리 (outStatCd: 0021 = 성공, 0051 = 입금대기)
  if (params.outStatCd === '0021') {
    try {
      // mchtParam에서 주문 정보 추출 (파이프 구분)
      const mchtParamParts = (params.mchtParam || '').split('|')
      const orderId = parseInt(mchtParamParts[0]) || 0
      const userId = parseInt(mchtParamParts[1]) || 0
      const classId = parseInt(mchtParamParts[2]) || null
      const lessonId = parseInt(mchtParamParts[3]) || null
      const orderType = mchtParamParts[4] || 'class'

      // 이미 취소된 주문은 업데이트하지 않음
      const existingOrder = await c.env.DB.prepare('SELECT payment_status FROM orders WHERE id = ?').bind(orderId).first() as any
      if (existingOrder?.payment_status === 'cancelled') {
        console.log('[Hecto Noti] Order already cancelled, skipping update:', orderId)
        return c.text('OK')
      }

      // 주문 상태 업데이트 (취소되지 않은 경우만)
      await c.env.DB.prepare(`
        UPDATE orders SET payment_status = 'completed', transaction_id = ?
        WHERE id = ? AND payment_status != 'cancelled'
      `).bind(params.trdNo || params.mchtTrdNo, orderId).run()

      // 수강 등록 처리
      if (orderType === 'lesson' && lessonId) {
        // 강의별 등록
        await c.env.DB.prepare(`
          INSERT INTO lesson_enrollments (user_id, class_lesson_id, payment_id, status)
          VALUES (?, ?, ?, 'active')
          ON CONFLICT(user_id, class_lesson_id) DO UPDATE SET status = 'active'
        `).bind(userId, lessonId, orderId).run()
      } else if (classId) {
        // 코스 등록
        await c.env.DB.prepare(`
          INSERT INTO enrollments (user_id, class_id, status)
          VALUES (?, ?, 'active')
          ON CONFLICT(user_id, class_id) DO UPDATE SET status = 'active', updated_at = datetime('now')
        `).bind(userId, classId).run()

        // 수강생 수 업데이트
        await c.env.DB.prepare('UPDATE classes SET current_students = current_students + 1 WHERE id = ?').bind(classId).run()

        // 장바구니에서 제거
        await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ? AND class_id = ?').bind(userId, classId).run()
      }

      console.log('[Hecto Noti] Payment success processed:', params.mchtTrdNo)
      return c.text('OK')
    } catch (e: any) {
      console.log('[Hecto Noti] Error processing payment:', e.message)
      return c.text('FAIL')
    }
  } else if (params.outStatCd === '0051') {
    // 입금대기 (가상계좌)
    console.log('[Hecto Noti] Waiting for deposit:', params.mchtTrdNo)
    return c.text('OK')
  }

  return c.text('FAIL')
})

// 관리자: 주문 목록 조회
app.get('/api/admin/orders', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)
  if (!isLoggedIn) {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  }

    const { results: orders } = await c.env.DB.prepare(`
    SELECT o.*, u.name as user_name, u.email as user_email, cl.title as class_title
    FROM orders o
    LEFT JOIN users u ON o.user_id = u.id
    LEFT JOIN classes cl ON o.class_id = cl.id
    ORDER BY o.id DESC
    LIMIT 100
  `).all()

  return c.json({ orders })
})

// 관리자: 주문 상태 업데이트
app.post('/api/admin/orders/:orderId/update', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)
  if (!isLoggedIn) {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  }

  const orderId = parseInt(c.req.param('orderId'))
  const { status, trdNo } = await c.req.json()

  await c.env.DB.prepare(`
    UPDATE orders SET payment_status = ?, transaction_id = COALESCE(?, transaction_id)
    WHERE id = ?
  `).bind(status, trdNo, orderId).run()

  return c.json({ success: true })
})

// 결제 완료 후 수강 등록 처리 API
app.post('/api/payment/hecto/complete', async (c) => {
  const { orderId, userId, classId, lessonId, orderType, trdNo, mchtTrdNo } = await c.req.json()

  try {
    // 이미 취소된 주문은 처리하지 않음
    const existingOrder = await c.env.DB.prepare('SELECT payment_status FROM orders WHERE id = ?').bind(orderId).first() as any
    if (existingOrder?.payment_status === 'cancelled') {
      console.log('[Hecto Complete] Order already cancelled, skipping:', orderId)
      return c.json({ success: false, error: 'Order already cancelled' })
    }

    // 주문 상태 업데이트 (취소되지 않은 경우만)
    await c.env.DB.prepare(`
      UPDATE orders SET payment_status = 'completed', transaction_id = ?
      WHERE id = ? AND payment_status != 'cancelled'
    `).bind(trdNo || mchtTrdNo, orderId).run()

    // 수강 등록 처리
    if (orderType === 'lesson' && lessonId) {
      // 강의별 등록
      await c.env.DB.prepare(`
        INSERT INTO lesson_enrollments (user_id, class_lesson_id, payment_id, status)
        VALUES (?, ?, ?, 'active')
        ON CONFLICT(user_id, class_lesson_id) DO UPDATE SET status = 'active'
      `).bind(userId, lessonId, orderId).run()
    } else if (classId) {
      // 코스 등록
      await c.env.DB.prepare(`
        INSERT INTO enrollments (user_id, class_id, status)
        VALUES (?, ?, 'active')
        ON CONFLICT(user_id, class_id) DO UPDATE SET status = 'active', updated_at = datetime('now')
      `).bind(userId, classId).run()

      // 수강생 수 업데이트
      await c.env.DB.prepare('UPDATE classes SET current_students = current_students + 1 WHERE id = ?').bind(classId).run()

      // 장바구니에서 제거
      await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ? AND class_id = ?').bind(userId, classId).run()
    }

    console.log('[Hecto Complete] Enrollment processed:', orderId, classId)
    return c.json({ success: true })
  } catch (e: any) {
    console.log('[Hecto Complete] Error:', e.message)
    return c.json({ success: false, error: e.message }, 500)
  }
})

// 결제 취소 API
app.post('/api/payment/hecto/cancel', async (c) => {
  const { orderId, reason } = await c.req.json()

  if (!c.env.HECTO_MID || !c.env.HECTO_LICENSE_KEY || !c.env.HECTO_AES_KEY) {
    return c.json({ error: '헥토파이낸셜 PG 설정이 완료되지 않았습니다.' }, 500)
  }

  // 주문 정보 조회
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first() as any
  if (!order) {
    return c.json({ error: '주문을 찾을 수 없습니다.' }, 404)
  }

  if (order.payment_status !== 'completed') {
    return c.json({ error: '취소할 수 없는 주문 상태입니다.' }, 400)
  }

  const config: HectoConfig = {
    MID: c.env.HECTO_MID,
    LICENSE_KEY: c.env.HECTO_LICENSE_KEY,
    AES_KEY: c.env.HECTO_AES_KEY,
    PAYMENT_SERVER: c.env.HECTO_PAYMENT_SERVER || 'https://tbnpg.settlebank.co.kr',
    CANCEL_SERVER: c.env.HECTO_CANCEL_SERVER || 'https://tbgw.settlebank.co.kr'
  }

  const now = new Date()
  const mchtTrdNo = `CNCL${now.toISOString().slice(0, 10).replace(/-/g, '')}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`

  const cancelResult = await cancelHectoPayment(config, {
    mchtTrdNo,
    orgTrdNo: order.transaction_id,
    cnclAmt: String(order.amount),
    cnclRsn: reason || '고객요청'
  })

  if (cancelResult.success) {
    // 주문 상태 업데이트
    await c.env.DB.prepare(`
      UPDATE orders SET payment_status = 'cancelled'
      WHERE id = ?
    `).bind(orderId).run()

    // 수강 취소 처리
    if (order.class_id) {
      await c.env.DB.prepare(`
        UPDATE enrollments SET status = 'cancelled', updated_at = datetime('now')
        WHERE user_id = ? AND class_id = ?
      `).bind(order.user_id, order.class_id).run()

      await c.env.DB.prepare('UPDATE classes SET current_students = MAX(0, current_students - 1) WHERE id = ?').bind(order.class_id).run()
    }

    return c.json({ success: true, message: '결제가 취소되었습니다.' })
  }

  return c.json({ success: false, error: cancelResult.error || '결제 취소에 실패했습니다.' }, 500)
})

// 관리자: 결제/수강 취소 (헥토 PG 카드결제 취소 포함)
// 순서: DB 업데이트 먼저 → PG 취소 나중에 (PG 취소가 오래 걸려서 Worker 타임아웃 방지)
app.post('/api/admin/orders/:orderId/cancel', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)
  if (!isLoggedIn) {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  }

  const orderId = parseInt(c.req.param('orderId'))
  const { reason } = await c.req.json()

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first() as any
  if (!order) {
    return c.json({ error: '주문을 찾을 수 없습니다.' }, 404)
  }

  // 1. DB 업데이트 먼저 (빠름)
  try {
    // 주문 상태 업데이트
    await c.env.DB.prepare(`
      UPDATE orders SET payment_status = 'cancelled'
      WHERE id = ?
    `).bind(orderId).run()

    // 수강 취소 처리
    if (order.class_id) {
      await c.env.DB.prepare(`
        UPDATE enrollments SET status = 'cancelled', updated_at = datetime('now')
        WHERE user_id = ? AND class_id = ?
      `).bind(order.user_id, order.class_id).run()

      await c.env.DB.prepare('UPDATE classes SET current_students = MAX(0, current_students - 1) WHERE id = ?').bind(order.class_id).run()
    }

    // lesson 취소
    if (order.order_type === 'lesson') {
      await c.env.DB.prepare(`
        DELETE FROM lesson_enrollments WHERE user_id = ? AND payment_id = ?
      `).bind(order.user_id, orderId).run()
    }
  } catch (dbError: any) {
    console.error('[Admin] DB update error:', dbError.message)
    return c.json({
      success: false,
      error: 'DB 업데이트 실패: ' + dbError.message
    })
  }

  // 2. PG 카드결제 취소 (느림 - 3~4초 소요)
  let pgCancelResult: { success: boolean; skipped?: boolean; error?: string } = { success: true, skipped: true }
  if (order.transaction_id && order.transaction_id.startsWith('SOFP_') && order.payment_status === 'completed') {
    if (c.env.HECTO_MID && c.env.HECTO_LICENSE_KEY && c.env.HECTO_AES_KEY) {
      const config: HectoConfig = {
        MID: c.env.HECTO_MID,
        LICENSE_KEY: c.env.HECTO_LICENSE_KEY,
        AES_KEY: c.env.HECTO_AES_KEY,
        PAYMENT_SERVER: c.env.HECTO_PAYMENT_SERVER || 'https://tbnpg.settlebank.co.kr',
        CANCEL_SERVER: c.env.HECTO_CANCEL_SERVER || 'https://tbgw.settlebank.co.kr'
      }

      const now = new Date()
      const mchtTrdNo = `CNCL${now.toISOString().slice(0, 10).replace(/-/g, '')}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`

      // transaction_id에서 결제수단 코드 추출 (SOFP_PGxx... → xx)
      const paymentMethodCode = order.transaction_id.substring(7, 9)

      pgCancelResult = await cancelHectoPayment(config, {
        mchtTrdNo,
        orgTrdNo: order.transaction_id,
        cnclAmt: String(order.amount),
        cnclRsn: reason || '관리자 취소',
        method: paymentMethodCode
      })

      console.log('[Admin] Hecto cancel result:', pgCancelResult)
    }
  }


  if (!pgCancelResult.success && !pgCancelResult.skipped) {
    return c.json({
      success: true,
      message: '수강은 취소되었으나 카드결제 취소에 실패했습니다. (' + (pgCancelResult.error || pgCancelResult.outRsltMsg || 'Unknown') + ')',
      pgError: pgCancelResult.error
    })
  }

  return c.json({
    success: true,
    message: '결제 및 수강이 취소되었습니다.'
  })
})

// ==================== 수업 매칭 시스템 API ====================

// JWT에서 사용자 정보 추출 헬퍼
async function getUserFromToken(c: any): Promise<any | null> {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const payload = await verifyJWT(auth.slice(7), c.env.JWT_SECRET)
  if (!payload) return null
  return await c.env.DB.prepare('SELECT id, email, name, role, is_instructor FROM users WHERE id = ?').bind(payload.sub).first()
}

// 수업 요청 생성 (로그인 필수)
app.post('/api/class-requests', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const { title, description, categoryId, preferredSchedule, budgetMin, budgetMax } = await c.req.json()
  if (!title || !description) return c.json({ error: '제목과 설명은 필수입니다.' }, 400)

  const result = await c.env.DB.prepare(`
    INSERT INTO class_requests (user_id, title, description, category_id, preferred_schedule, budget_min, budget_max, interest_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(user.id, title, description, categoryId || null, preferredSchedule || null, budgetMin || null, budgetMax || null).run()

  const requestId = result.meta.last_row_id
  // 요청자를 자동으로 관심자에 추가
  await c.env.DB.prepare('INSERT OR IGNORE INTO class_request_interests (request_id, user_id) VALUES (?, ?)').bind(requestId, user.id).run()

  return c.json({ success: true, id: requestId })
})

// 수업 요청 수정 (본인만, open 상태)
app.put('/api/class-requests/:id', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const id = parseInt(c.req.param('id'))
  const request = await c.env.DB.prepare('SELECT id, user_id, status FROM class_requests WHERE id = ?').bind(id).first() as any
  if (!request) return c.json({ error: '요청을 찾을 수 없습니다.' }, 404)
  if (request.user_id !== user.id) return c.json({ error: '본인의 요청만 수정할 수 있습니다.' }, 403)
  if (request.status !== 'open') return c.json({ error: '모집중인 요청만 수정할 수 있습니다.' }, 400)

  const { title, description, categoryId, preferredSchedule, budgetMin, budgetMax } = await c.req.json()
  if (!title || !description) return c.json({ error: '제목과 설명은 필수입니다.' }, 400)

  await c.env.DB.prepare(`
    UPDATE class_requests SET title = ?, description = ?, category_id = ?, preferred_schedule = ?, budget_min = ?, budget_max = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(title, description, categoryId || null, preferredSchedule || null, budgetMin || null, budgetMax || null, id).run()

  return c.json({ success: true })
})

// 수업 요청 게시판 목록
app.get('/api/class-requests', async (c) => {
  const status = c.req.query('status') || 'open'
  const limit = parseInt(c.req.query('limit') || '20')
  const offset = parseInt(c.req.query('offset') || '0')

  const { results } = await c.env.DB.prepare(`
    SELECT cr.*, u.name as author_name, cat.name as category_name,
           (SELECT COUNT(*) FROM class_request_applications WHERE request_id = cr.id AND status != 'rejected') as application_count
    FROM class_requests cr
    LEFT JOIN users u ON cr.user_id = u.id
    LEFT JOIN categories cat ON cr.category_id = cat.id
    WHERE cr.status = ?
    ORDER BY cr.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(status, limit, offset).all()

  const countResult = await c.env.DB.prepare('SELECT COUNT(*) as total FROM class_requests WHERE status = ?').bind(status).first() as any

  return c.json({ requests: results, total: countResult?.total || 0 })
})

// 수업 요청 상세
app.get('/api/class-requests/:id', async (c) => {
  const id = parseInt(c.req.param('id'))

  const request = await c.env.DB.prepare(`
    SELECT cr.*, u.name as author_name, u.email as author_email, cat.name as category_name
    FROM class_requests cr
    LEFT JOIN users u ON cr.user_id = u.id
    LEFT JOIN categories cat ON cr.category_id = cat.id
    WHERE cr.id = ?
  `).bind(id).first()

  if (!request) return c.json({ error: '요청을 찾을 수 없습니다.' }, 404)

  // 지원자 목록 (제출된 것만)
  const { results: applications } = await c.env.DB.prepare(`
    SELECT id, applicant_name, bio, proposed_title, proposed_price, status, created_at
    FROM class_request_applications
    WHERE request_id = ? AND status != 'draft'
    ORDER BY created_at ASC
  `).bind(id).all()

  return c.json({ request, applications })
})

// 관심 표시 토글 (로그인 필수)
app.post('/api/class-requests/:id/interest', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const requestId = parseInt(c.req.param('id'))

  // 이미 관심 표시했는지 확인
  const existing = await c.env.DB.prepare(
    'SELECT id FROM class_request_interests WHERE request_id = ? AND user_id = ?'
  ).bind(requestId, user.id).first()

  if (existing) {
    // 관심 해제
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM class_request_interests WHERE request_id = ? AND user_id = ?').bind(requestId, user.id),
      c.env.DB.prepare('UPDATE class_requests SET interest_count = MAX(0, interest_count - 1) WHERE id = ?').bind(requestId)
    ])
    return c.json({ interested: false })
  } else {
    // 관심 표시
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO class_request_interests (request_id, user_id) VALUES (?, ?)').bind(requestId, user.id),
      c.env.DB.prepare('UPDATE class_requests SET interest_count = interest_count + 1 WHERE id = ?').bind(requestId)
    ])
    return c.json({ interested: true })
  }
})

// 내 수업 요청 목록 (로그인 필수)
app.get('/api/my/class-requests', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const { results } = await c.env.DB.prepare(`
    SELECT cr.*, cat.name as category_name,
           (SELECT COUNT(*) FROM class_request_applications WHERE request_id = cr.id AND status = 'submitted') as pending_applications
    FROM class_requests cr
    LEFT JOIN categories cat ON cr.category_id = cat.id
    WHERE cr.user_id = ?
    ORDER BY cr.created_at DESC
  `).bind(user.id).all()

  return c.json({ requests: results })
})

// 내 지원 현황 (강사 지원)
app.get('/api/my/applications', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const { results } = await c.env.DB.prepare(`
    SELECT a.id, a.status, a.proposed_title, a.proposed_price, a.automation_step, a.automation_error, a.created_at, a.reviewed_at, a.admin_note,
           cr.title as request_title, cr.id as request_id,
           COALESCE(a.created_class_id, (
             SELECT c.id FROM classes c JOIN instructors i ON c.instructor_id = i.id
             WHERE i.user_id = a.user_id AND c.title = a.proposed_title LIMIT 1
           )) as created_class_id
    FROM class_request_applications a
    JOIN class_requests cr ON a.request_id = cr.id
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
  `).bind(user.id).all()

  return c.json({ applications: results })
})

// ==================== 강사 지원 에이전트 API ====================

// 지원 시작 (draft 생성, 로그인 필수)
app.post('/api/class-requests/:id/apply', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const requestId = parseInt(c.req.param('id'))

  // 요청 확인
  const request = await c.env.DB.prepare('SELECT id, user_id, status FROM class_requests WHERE id = ?').bind(requestId).first() as any
  if (!request) return c.json({ error: '요청을 찾을 수 없습니다.' }, 404)
  if (request.status !== 'open') return c.json({ error: '이미 매칭된 요청입니다.' }, 400)
  if (request.user_id === user.id) return c.json({ error: '본인의 요청에는 지원할 수 없습니다.' }, 403)

  // 이미 지원했는지 확인
  const existing = await c.env.DB.prepare(
    'SELECT id, conversation_step, status FROM class_request_applications WHERE request_id = ? AND user_id = ?'
  ).bind(requestId, user.id).first() as any

  if (existing) {
    return c.json({
      applicationId: existing.id,
      conversationStep: existing.conversation_step,
      status: existing.status,
      agentMessage: getAgentMessage(existing.conversation_step, existing, request),
      message: '이미 지원이 진행 중입니다.'
    })
  }

  // 새 지원 생성
  const result = await c.env.DB.prepare(`
    INSERT INTO class_request_applications (request_id, user_id, applicant_name, applicant_email)
    VALUES (?, ?, ?, ?)
  `).bind(requestId, user.id, user.name || '', user.email).run()

  return c.json({
    applicationId: result.meta.last_row_id,
    conversationStep: 0,
    status: 'draft',
    agentMessage: getAgentMessage(0, null, request)
  })
})

// 에이전트 대화 메시지 전송
app.post('/api/applications/:id/chat', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const appId = parseInt(c.req.param('id'))
  const { message } = await c.req.json()

  const app_row = await c.env.DB.prepare(`
    SELECT a.*, cr.title as request_title, cr.description as request_description
    FROM class_request_applications a
    JOIN class_requests cr ON a.request_id = cr.id
    WHERE a.id = ? AND a.user_id = ?
  `).bind(appId, user.id).first() as any

  if (!app_row) return c.json({ error: '지원을 찾을 수 없습니다.' }, 404)
  if (app_row.status === 'submitted') return c.json({ error: '이미 제출된 지원입니다.' }, 400)

  const step = app_row.conversation_step

  // "이전" 입력 시 뒤로가기
  if (message.trim() === '이전' && step > 0) {
    await c.env.DB.prepare('UPDATE class_request_applications SET conversation_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(step - 1, appId).run()
    return c.json({
      conversationStep: step - 1,
      agentMessage: getAgentMessage(step - 1, app_row, null)
    })
  }

  // 현재 step에 맞는 데이터 파싱/검증/저장
  const validation = validateAndSaveStep(step, message, app_row)
  if (validation.error) {
    return c.json({ conversationStep: step, agentMessage: validation.error, isError: true })
  }

  // DB 업데이트
  const updates = validation.updates!
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ')
  const values = Object.values(updates)

  if (step === 6) {
    // 최종 제출
    const setFinal = setClauses ? `${setClauses}, ` : ''
    await c.env.DB.prepare(`UPDATE class_request_applications SET ${setFinal}status = 'submitted', conversation_step = 7, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(...values, appId).run()
    return c.json({
      conversationStep: 7,
      status: 'submitted',
      agentMessage: '지원이 완료되었습니다! 관리자 검토 후 안내드리겠습니다. 감사합니다!'
    })
  }

  await c.env.DB.prepare(`UPDATE class_request_applications SET ${setClauses}, conversation_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...values, step + 1, appId).run()

  // 다음 step 메시지 반환 (업데이트된 데이터 포함)
  const updatedApp = { ...app_row, ...updates, conversation_step: step + 1 }
  return c.json({
    conversationStep: step + 1,
    agentMessage: getAgentMessage(step + 1, updatedApp, null)
  })
})

// 지원 상태/대화 조회
app.get('/api/applications/:id', async (c) => {
  const user = await getUserFromToken(c)
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const appId = parseInt(c.req.param('id'))
  const app_row = await c.env.DB.prepare(`
    SELECT a.*, cr.title as request_title, cr.description as request_description, cr.preferred_schedule, cr.budget_min, cr.budget_max
    FROM class_request_applications a
    JOIN class_requests cr ON a.request_id = cr.id
    WHERE a.id = ? AND a.user_id = ?
  `).bind(appId, user.id).first() as any

  if (!app_row) return c.json({ error: '지원을 찾을 수 없습니다.' }, 404)

  return c.json({
    application: app_row,
    agentMessage: app_row.status === 'submitted'
      ? '지원이 제출되었습니다. 관리자 검토를 기다려주세요.'
      : getAgentMessage(app_row.conversation_step, app_row, null)
  })
})

// 에이전트 메시지 생성
function getAgentMessage(step: number, app: any, request: any): string {
  switch (step) {
    case 0:
      return '안녕하세요! 이 수업에 관심을 가져주셔서 감사합니다. 먼저 간단한 자기소개와 관련 경력을 알려주세요. (최소 10자)'
    case 1:
      return `좋습니다! 이제 수업 제목을 정해볼까요?${request ? ` 요청 내용: "${request.title}"을 참고해서 제안해주세요.` : ''}`
    case 2:
      return '수업에서 무엇을 배울 수 있는지 설명해주세요. 마지막 줄에 난이도를 적어주세요. (초급/중급/고급/전체)'
    case 3:
      return '총 몇 회 수업이고, 한 회에 몇 분으로 하실 건가요? (예: 8회 60분)'
    case 4:
      return '수업 시작일, 요일, 시간을 정해볼까요? (예: 4월 14일 시작, 월/수, 저녁 7시)'
    case 5:
      return '수강료를 얼마로 제안하시겠어요? (원 단위, 숫자만 입력)'
    case 6: {
      if (!app) return '요약 정보를 준비 중입니다...'
      const days = app.proposed_schedule_days ? JSON.parse(app.proposed_schedule_days) : []
      const dayNames: Record<string, string> = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' }
      const dayStr = days.map((d: string) => dayNames[d] || d).join(', ')
      const levelNames: Record<string, string> = { beginner: '초급', intermediate: '중급', advanced: '고급', all: '전체' }
      return `📋 지원 내용 요약\n\n` +
        `👤 강사: ${app.applicant_name}\n` +
        `📝 자기소개: ${app.bio}\n` +
        `📚 수업 제목: ${app.proposed_title}\n` +
        `📖 수업 설명: ${app.proposed_description}\n` +
        `📊 난이도: ${levelNames[app.proposed_level] || app.proposed_level}\n` +
        `🔢 구성: ${app.proposed_lessons_count}회 × ${app.proposed_duration_minutes}분\n` +
        `📅 시작일: ${app.proposed_schedule_start?.split('T')[0] || app.proposed_schedule_start}\n` +
        `⏰ 스케줄: ${dayStr} ${app.proposed_schedule_time}\n` +
        `💰 수강료: ${Number(app.proposed_price).toLocaleString()}원\n\n` +
        `이 내용으로 제출하시겠습니까? ("네" 또는 "이전")`
    }
    default:
      return ''
  }
}

// 입력 검증 + 저장 데이터 생성
function validateAndSaveStep(step: number, message: string, app: any): { error?: string, updates?: Record<string, any> } {
  const msg = message.trim()

  switch (step) {
    case 0: {
      // 자기소개 (최소 10자)
      if (msg.length < 10) return { error: '자기소개를 좀 더 상세히 작성해주세요 (최소 10자)' }
      return { updates: { bio: msg } }
    }
    case 1: {
      // 수업 제목 (최소 2자)
      if (msg.length < 2) return { error: '수업 제목을 입력해주세요 (최소 2자)' }
      return { updates: { proposed_title: msg } }
    }
    case 2: {
      // 수업 설명 + 레벨
      const lines = msg.split('\n').map(l => l.trim()).filter(Boolean)
      const lastLine = lines[lines.length - 1]?.toLowerCase() || ''
      const levelMap: Record<string, string> = { '초급': 'beginner', '중급': 'intermediate', '고급': 'advanced', '전체': 'all', 'beginner': 'beginner', 'intermediate': 'intermediate', 'advanced': 'advanced', 'all': 'all' }
      const level = levelMap[lastLine]
      let description = msg
      if (level) {
        description = lines.slice(0, -1).join('\n')
      }
      if (description.length < 20) return { error: '수업 설명을 좀 더 작성해주세요 (최소 20자)' }
      return { updates: { proposed_description: description, proposed_level: level || 'all' } }
    }
    case 3: {
      // 회차 + 시간 파싱 (예: "8회 60분", "8 60")
      const nums = msg.match(/(\d+)/g)
      if (!nums || nums.length < 2) return { error: '수업 회차와 시간을 입력해주세요 (예: 8회 60분)' }
      const count = parseInt(nums[0])
      const duration = parseInt(nums[1])
      if (count < 1 || count > 50) return { error: '수업 회차는 1~50회 범위로 입력해주세요' }
      if (duration < 30 || duration > 240) return { error: '수업 시간은 30~240분 범위로 입력해주세요' }
      return { updates: { proposed_lessons_count: count, proposed_duration_minutes: duration } }
    }
    case 4: {
      // 스케줄 파싱 — UI에서 "2026-04-14, 월/수, 19:00" 형식 또는 자연어 입력

      // 날짜 파싱 (다양한 형식 지원)
      const dateMatch = msg.match(/(\d{4}-\d{2}-\d{2})|(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})|(\d{1,2})월\s*(\d{1,2})일/)
      let startDate: string | null = null
      if (dateMatch) {
        if (dateMatch[1]) {
          startDate = dateMatch[1]
        } else if (dateMatch[2]) {
          startDate = dateMatch[2].replace(/[/.]/g, '-')
        } else if (dateMatch[3] && dateMatch[4]) {
          const year = new Date().getFullYear()
          const month = dateMatch[3].padStart(2, '0')
          const day = dateMatch[4].padStart(2, '0')
          startDate = `${year}-${month}-${day}`
        }
      }
      if (!startDate) return { error: '시작일, 요일, 시간을 함께 입력해주세요\n예: 4월 14일, 월/수, 저녁 7시' }

      // 시작일이 오늘 이후인지 확인
      const today = new Date().toISOString().split('T')[0]
      if (startDate < today) return { error: '시작일은 오늘 이후여야 합니다' }

      // 날짜 부분 제거 후 요일 파싱 (날짜의 "월","일" 오인 방지)
      const msgNoDates = msg.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/\d{1,2}월\s*\d{1,2}일/g, '')
      const days: string[] = []
      const korMap: Record<string, string> = { '월': 'mon', '화': 'tue', '수': 'wed', '목': 'thu', '금': 'fri', '토': 'sat', '일': 'sun' }
      // "X요일" 전체 표기 지원
      const fullDayRegex = /([월화수목금토일])요일/g
      let fdm
      while ((fdm = fullDayRegex.exec(msgNoDates)) !== null) {
        if (korMap[fdm[1]]) days.push(korMap[fdm[1]])
      }
      // 단독 글자 (월/수, 월,수 등)
      const shortDayRegex = /(?:^|[\/,\s])([월화수목금토일])(?=[\/,\s]|$)/g
      let sdm
      while ((sdm = shortDayRegex.exec(msgNoDates)) !== null) {
        const val = korMap[sdm[1]]
        if (val && !days.includes(val)) days.push(val)
      }
      // 영어 요일
      for (const eng of ['mon','tue','wed','thu','fri','sat','sun']) {
        if (msg.toLowerCase().includes(eng) && !days.includes(eng)) days.push(eng)
      }
      const uniqueDays = [...new Set(days)]
      if (uniqueDays.length === 0) return { error: '요일을 선택해주세요 (예: 월/수 또는 토요일)' }

      // 시간 파싱 (HH:MM 형식 우선, 그 다음 자연어)
      const exactTime = msg.match(/(\d{2}):(\d{2})/)
      let time = '19:00'
      if (exactTime) {
        time = exactTime[0]
      } else {
        const timeMatch = msg.match(/(\d{1,2})\s*[:시]\s*(\d{0,2})/)
        if (timeMatch) {
          let hour = parseInt(timeMatch[1])
          const min = timeMatch[2] ? parseInt(timeMatch[2]) : 0
          if (hour < 12 && (msg.includes('저녁') || msg.includes('오후') || msg.includes('밤'))) hour += 12
          time = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`
        } else if (msg.includes('저녁')) { time = '19:00' }
        else if (msg.includes('오후')) { time = '14:00' }
        else if (msg.includes('오전')) { time = '10:00' }
      }

      return { updates: {
        proposed_schedule_start: startDate,
        proposed_schedule_days: JSON.stringify(uniqueDays),
        proposed_schedule_time: time
      }}
    }
    case 5: {
      // 가격 (숫자만)
      const price = parseInt(msg.replace(/[,원\s]/g, ''))
      if (isNaN(price) || price <= 0) return { error: '유효한 금액을 입력해주세요 (숫자만)' }
      return { updates: { proposed_price: price } }
    }
    case 6: {
      // 확인/제출
      const yes = ['네', '예', '확인', 'yes', 'y']
      if (yes.includes(msg.toLowerCase())) {
        return { updates: {} }  // 제출 처리는 chat 핸들러에서
      }
      if (msg === '이전') {
        return { error: 'back' }  // 뒤로가기는 상위에서 처리됨
      }
      return { error: '제출하시려면 "네", 수정하시려면 "이전"을 입력해주세요' }
    }
    default:
      return { error: '잘못된 단계입니다.' }
  }
}

// ==================== 관리자: 수업 매칭 관리 API ====================

// 관리자 인증 헬퍼 (API용)
async function requireAdminAPI(c: any): Promise<boolean> {
  const sessionToken = getSessionToken(c)
  return await checkAdminSession(c.env.DB, sessionToken)
}

// 관리자: 지원 목록
app.get('/api/admin/applications', async (c) => {
  if (!await requireAdminAPI(c)) return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  const status = c.req.query('status') || 'submitted'
  const { results } = await c.env.DB.prepare(`
    SELECT a.*, cr.title as request_title, cr.description as request_description, u.name as user_name, u.email as user_email
    FROM class_request_applications a
    JOIN class_requests cr ON a.request_id = cr.id
    JOIN users u ON a.user_id = u.id
    WHERE a.status = ?
    ORDER BY a.created_at DESC
  `).bind(status).all()
  return c.json({ applications: results })
})

// 관리자: 지원 상세
app.get('/api/admin/applications/:id', async (c) => {
  if (!await requireAdminAPI(c)) return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  const id = parseInt(c.req.param('id'))
  const app_row = await c.env.DB.prepare(`
    SELECT a.*, cr.title as request_title, cr.description as request_description, cr.user_id as requester_id,
           cr.preferred_schedule, cr.budget_min, cr.budget_max,
           u.name as applicant_user_name, u.email as applicant_user_email, u.role as applicant_role, u.is_instructor as applicant_is_instructor,
           requester.name as requester_name, requester.email as requester_email
    FROM class_request_applications a
    JOIN class_requests cr ON a.request_id = cr.id
    JOIN users u ON a.user_id = u.id
    JOIN users requester ON cr.user_id = requester.id
    WHERE a.id = ?
  `).bind(id).first()

  if (!app_row) return c.json({ error: '지원을 찾을 수 없습니다.' }, 404)
  return c.json({ application: app_row })
})

// 자동화 실행 함수
async function runAutomation(c: any, appId: number, startStep: number) {
  const app_row = await c.env.DB.prepare(`
    SELECT a.*, cr.title as request_title, cr.user_id as requester_id, cr.category_id as request_category_id,
           u.id as applicant_user_id, u.name as applicant_name, u.email as applicant_email, u.role as applicant_role, u.is_instructor as applicant_is_instructor
    FROM class_request_applications a
    JOIN class_requests cr ON a.request_id = cr.id
    JOIN users u ON a.user_id = u.id
    WHERE a.id = ?
  `).bind(appId).first() as any

  if (!app_row) throw new Error('Application not found')

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  let instructorId: number | null = null
  let classId: number | null = app_row.created_class_id || null

  // Step 1: 강사 등록
  if (startStep <= 1) {
    try {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_step = 1 WHERE id = ?').bind(appId).run()

      const isAlreadyInstructor = app_row.applicant_role === 'instructor' || app_row.applicant_is_instructor === 1
      if (!isAlreadyInstructor) {
        await c.env.DB.prepare("UPDATE users SET is_instructor = 1, role = 'instructor' WHERE id = ?").bind(app_row.applicant_user_id).run()
      }

      // instructors 테이블에 레코드 확인/생성
      const existingInstructor = await c.env.DB.prepare('SELECT id FROM instructors WHERE user_id = ?').bind(app_row.applicant_user_id).first() as any
      if (existingInstructor) {
        instructorId = existingInstructor.id
      } else {
        const insResult = await c.env.DB.prepare(
          'INSERT INTO instructors (user_id, display_name, bio) VALUES (?, ?, ?)'
        ).bind(app_row.applicant_user_id, app_row.applicant_name, app_row.bio || '').run()
        instructorId = insResult.meta.last_row_id as number
      }
    } catch (e: any) {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_error = ? WHERE id = ?').bind('Step 1 실패: ' + e.message, appId).run()
      return { error: 'Step 1: 강사 등록 실패 - ' + e.message }
    }
  } else {
    const existing = await c.env.DB.prepare('SELECT id FROM instructors WHERE user_id = ?').bind(app_row.applicant_user_id).first() as any
    instructorId = existing?.id
  }

  // Step 2: 코스 생성
  if (startStep <= 2) {
    try {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_step = 2 WHERE id = ?').bind(appId).run()

      if (app_row.created_class_id) {
        classId = app_row.created_class_id
      } else {
        const slug = (app_row.proposed_title || 'class').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now()
        const classResult = await c.env.DB.prepare(`
          INSERT INTO classes (title, slug, description, instructor_id, category_id, price, duration_minutes, level, class_type, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 'active')
        `).bind(
          app_row.proposed_title,
          slug,
          app_row.proposed_description || '',
          instructorId,
          app_row.request_category_id || 1,
          app_row.proposed_price || 0,
          app_row.proposed_duration_minutes || 60,
          app_row.proposed_level || 'all'
        ).run()
        classId = classResult.meta.last_row_id as number
        // 즉시 created_class_id 저장 (재시도 시 복원 가능하도록)
        await c.env.DB.prepare('UPDATE class_request_applications SET created_class_id = ? WHERE id = ?').bind(classId, appId).run()
      }
    } catch (e: any) {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_error = ? WHERE id = ?').bind('Step 2 실패: ' + e.message, appId).run()
      return { error: 'Step 2: 코스 생성 실패 - ' + e.message }
    }
  } else {
    classId = app_row.created_class_id
    // created_class_id가 없으면 instructorId로 최근 생성된 class 복원
    if (!classId && instructorId) {
      const recent = await c.env.DB.prepare('SELECT id FROM classes WHERE instructor_id = ? ORDER BY id DESC LIMIT 1').bind(instructorId).first() as any
      classId = recent?.id || null
    }
  }

  // Step 3: ClassIn 코스 생성
  if (startStep <= 3 && config) {
    try {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_step = 3 WHERE id = ?').bind(appId).run()

      const cls = await c.env.DB.prepare('SELECT classin_course_id FROM classes WHERE id = ?').bind(classId).first() as any
      if (!cls?.classin_course_id) {
        const courseResult = await createClassInCourse(config, app_row.proposed_title)
        if (courseResult.error) throw new Error(courseResult.error)
        if (!courseResult.courseId) throw new Error('ClassIn API가 코스 ID를 반환하지 않았습니다')
        await c.env.DB.prepare('UPDATE classes SET classin_course_id = ? WHERE id = ?').bind(courseResult.courseId, classId).run()
      }
    } catch (e: any) {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_error = ? WHERE id = ?').bind('Step 3 실패: ' + e.message, appId).run()
      return { error: 'Step 3: ClassIn 코스 생성 실패 - ' + e.message }
    }
  }

  // Step 4: 수업 세션 생성
  if (startStep <= 4 && config) {
    try {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_step = 4 WHERE id = ?').bind(appId).run()

      if (!classId) throw new Error('classId가 없습니다. 처음부터 재시도해주세요.')
      let cls = await c.env.DB.prepare('SELECT id, classin_course_id, duration_minutes FROM classes WHERE id = ?').bind(classId).first() as any
      if (!cls?.classin_course_id) {
        // Step 3에서 코스 생성이 안 됐으면 여기서 재시도
        const courseResult = await createClassInCourse(config, app_row.proposed_title)
        if (courseResult.error) throw new Error('코스 생성 실패: ' + courseResult.error)
        if (!courseResult.courseId) throw new Error('ClassIn API가 코스 ID를 반환하지 않았습니다')
        await c.env.DB.prepare('UPDATE classes SET classin_course_id = ? WHERE id = ?').bind(courseResult.courseId, classId).run()
        cls = await c.env.DB.prepare('SELECT id, classin_course_id, duration_minutes FROM classes WHERE id = ?').bind(classId).first() as any
        if (!cls?.classin_course_id) throw new Error('ClassIn 코스 ID가 없습니다')
      }

      // 이미 생성된 레슨 수 확인 (멱등성)
      const existingCount = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM class_lessons WHERE class_id = ?').bind(classId).first() as any
      const alreadyCreated = existingCount?.cnt || 0
      const totalLessons = app_row.proposed_lessons_count || 1

      if (alreadyCreated < totalLessons) {
        // 스케줄 계산
        const days = app_row.proposed_schedule_days ? JSON.parse(app_row.proposed_schedule_days) : ['mon']
        const time = app_row.proposed_schedule_time || '19:00'
        const startDateStr = app_row.proposed_schedule_start || new Date().toISOString().split('T')[0]
        const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
        const dayNumbers = days.map((d: string) => dayMap[d] ?? 1)

        // 날짜 계산 (문자열로 관리하여 타임존 혼동 방지)
        const dates: string[] = []
        const cursor = new Date(startDateStr + 'T12:00:00Z')  // UTC noon으로 날짜 경계 문제 방지
        let safety = 0
        while (dates.length < totalLessons && safety < 365) {
          if (dayNumbers.includes(cursor.getUTCDay())) {
            const y = cursor.getUTCFullYear()
            const m = String(cursor.getUTCMonth() + 1).padStart(2, '0')
            const d = String(cursor.getUTCDate()).padStart(2, '0')
            dates.push(`${y}-${m}-${d}`)
          }
          cursor.setUTCDate(cursor.getUTCDate() + 1)
          safety++
        }

        // 강사 정보
        const instructor = await c.env.DB.prepare(
          'SELECT id, classin_uid, classin_virtual_account, display_name FROM instructors WHERE id = ?'
        ).bind(instructorId).first() as any

        // 강사 ClassIn 등록 (가상계정)
        if (!instructor?.classin_uid && config) {
          const useVirtual = c.env.USE_INSTRUCTOR_VIRTUAL_ACCOUNT === 'true'
          if (useVirtual) {
            const va = await c.env.DB.prepare(
              "SELECT id, account_uid, account_password FROM classin_virtual_accounts WHERE status = 'available' LIMIT 1"
            ).first() as any
            if (va) {
              // VA 동기화는 registerInstructorWithClassIn 내부에서 자동 처리됨
              await registerInstructorWithClassIn(c.env.DB, instructor.id, config, va.account_uid)
            }
          }
        }

        // 강사 재조회 (ClassIn 등록 후)
        const updatedInstructor = await c.env.DB.prepare(
          'SELECT id, classin_uid, classin_virtual_account, display_name FROM instructors WHERE id = ?'
        ).bind(instructorId).first() as any

        for (let i = alreadyCreated; i < dates.length; i++) {
          const dateStr = dates[i]
          // KST 시간을 +09:00 오프셋으로 명시하여 정확한 UTC 변환
          const kstDateTime = new Date(`${dateStr}T${time}:00+09:00`)
          const utcTimestamp = Math.floor(kstDateTime.getTime() / 1000)
          const durationMins = app_row.proposed_duration_minutes || 60
          const endTimestamp = utcTimestamp + durationMins * 60

          const lessonResult = await createClassInLesson(
            config,
            cls.classin_course_id,
            `${app_row.proposed_title} - ${i + 1}회차`,
            utcTimestamp,
            endTimestamp,
            updatedInstructor?.classin_uid || ''
          )

          const scheduledAt = kstDateTime.toISOString()
          await c.env.DB.prepare(`
            INSERT INTO class_lessons (class_id, lesson_title, scheduled_at, duration_minutes, classin_course_id, classin_class_id, classin_instructor_url, lesson_number, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
          `).bind(
            classId,
            `${i + 1}회차`,
            scheduledAt,
            durationMins,
            cls.classin_course_id,
            lessonResult.classId || null,
            lessonResult.joinUrl || null,
            i + 1
          ).run()
        }
      }

      // classes.classin_class_id를 첫 번째 레슨의 classin_class_id로 설정 (createClassInSession 중복 방지)
      const firstLesson = await c.env.DB.prepare(
        'SELECT classin_class_id FROM class_lessons WHERE class_id = ? AND classin_class_id IS NOT NULL ORDER BY lesson_number ASC LIMIT 1'
      ).bind(classId).first() as any
      if (firstLesson?.classin_class_id) {
        await c.env.DB.prepare(
          'UPDATE classes SET classin_class_id = ? WHERE id = ?'
        ).bind(firstLesson.classin_class_id, classId).run()
      }
    } catch (e: any) {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_error = ? WHERE id = ?').bind('Step 4 실패: ' + e.message, appId).run()
      return { error: 'Step 4: 수업 세션 생성 실패 - ' + e.message }
    }
  }

  // Step 5: created_class_id 저장
  if (startStep <= 5) {
    await c.env.DB.prepare('UPDATE class_request_applications SET automation_step = 5, created_class_id = ? WHERE id = ?').bind(classId, appId).run()
  }

  // Step 6: 매칭 완료 + 다른 지원자 거절 + 학생 자동 등록
  if (startStep <= 6) {
    try {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_step = 6 WHERE id = ?').bind(appId).run()

      // class_requests 업데이트
      await c.env.DB.prepare(
        "UPDATE class_requests SET status = 'matched', matched_application_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(appId, app_row.request_id).run()

      // 다른 지원자 거절
      await c.env.DB.prepare(
        "UPDATE class_request_applications SET status = 'rejected', admin_note = '다른 강사가 선정되었습니다', reviewed_at = CURRENT_TIMESTAMP WHERE request_id = ? AND id != ? AND status != 'rejected'"
      ).bind(app_row.request_id, appId).run()

      // 요청 학생을 수업에 자동 등록
      const existingEnrollment = await c.env.DB.prepare(
        'SELECT id FROM enrollments WHERE user_id = ? AND class_id = ?'
      ).bind(app_row.requester_id, classId).first()

      if (!existingEnrollment) {
        await c.env.DB.prepare(
          "INSERT INTO enrollments (user_id, class_id, status) VALUES (?, ?, 'active')"
        ).bind(app_row.requester_id, classId).run()
      }
    } catch (e: any) {
      await c.env.DB.prepare('UPDATE class_request_applications SET automation_error = ? WHERE id = ?').bind('Step 6 실패: ' + e.message, appId).run()
      return { error: 'Step 6: 매칭 완료 실패 - ' + e.message }
    }
  }

  // Step 7: 완료
  await c.env.DB.prepare(
    "UPDATE class_request_applications SET automation_step = 7, automation_error = NULL, status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(appId).run()

  return { success: true, classId }
}

// 관리자: 승인 (��동화 트리거)
app.post('/api/admin/applications/:id/approve', async (c) => {
  if (!await requireAdminAPI(c)) return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  const id = parseInt(c.req.param('id'))
  const app_row = await c.env.DB.prepare('SELECT id, status, automation_step FROM class_request_applications WHERE id = ?').bind(id).first() as any
  if (!app_row) return c.json({ error: '지원을 찾을 수 없습니다.' }, 404)
  if (app_row.status !== 'submitted' && app_row.status !== 'approved') return c.json({ error: '제출된 지원만 승인할 수 있습니다.' }, 400)

  const result = await runAutomation(c, id, 1)
  if (result.error) return c.json({ success: false, error: result.error, step: app_row.automation_step })
  return c.json({ success: true, classId: result.classId })
})

// 관리자: 거절
app.post('/api/admin/applications/:id/reject', async (c) => {
  if (!await requireAdminAPI(c)) return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  const id = parseInt(c.req.param('id'))
  const { note } = await c.req.json()

  const app_row = await c.env.DB.prepare('SELECT id, request_id, status FROM class_request_applications WHERE id = ?').bind(id).first() as any
  if (!app_row) return c.json({ error: '지원을 찾을 수 없습니다.' }, 404)

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE class_request_applications SET status = 'rejected', admin_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(note || '', id),
    c.env.DB.prepare("UPDATE class_requests SET status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'matched'").bind(app_row.request_id)
  ])

  return c.json({ success: true })
})

// 관리자: 재시도 (실패한 단계부터 재개)
app.post('/api/admin/applications/:id/retry', async (c) => {
  if (!await requireAdminAPI(c)) return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  const id = parseInt(c.req.param('id'))
  const app_row = await c.env.DB.prepare('SELECT id, automation_step, automation_error FROM class_request_applications WHERE id = ?').bind(id).first() as any
  if (!app_row) return c.json({ error: '지원을 찾을 수 없습니다.' }, 404)
  if (!app_row.automation_error) return c.json({ error: '재시도할 오류가 없습니다.' }, 400)

  await c.env.DB.prepare('UPDATE class_request_applications SET automation_error = NULL WHERE id = ?').bind(id).run()
  const result = await runAutomation(c, id, app_row.automation_step)
  if (result.error) return c.json({ success: false, error: result.error })
  return c.json({ success: true, classId: result.classId })
})

// ==================== HTML Pages ====================

const headHTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClassIn Live - 라이브 양방향 코스 플랫폼</title>
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
        <span class="text-[10px] font-bold text-primary-500 bg-primary-50 px-1.5 py-0.5 rounded-full -ml-1">{{APP_BADGE}}</span>
      </a>
      
      <!-- Search -->
      <div class="hidden md:flex flex-1 max-w-xl mx-8">
        <div class="relative w-full">
          <input type="search" id="searchInput" placeholder="배우고 싶은 것을 검색해보세요" autocomplete="off" name="course-search" value=""
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
        <a href="/class-requests" class="hidden sm:flex items-center gap-1 px-3 py-2 text-sm font-medium text-dark-600 hover:text-primary-500 rounded-lg hover:bg-gray-50 transition-all">
          <i class="fas fa-hand-paper text-xs"></i>
          <span>수업 요청</span>
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
      <input type="search" id="searchInputMobile" placeholder="검색" autocomplete="off" name="course-search-mobile" value="" class="w-full h-9 pl-9 pr-4 bg-gray-50 border border-gray-200 rounded-lg text-sm">
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
        <h3 class="text-white font-bold mb-4">러닝퍼실리테이터</h3>
        <ul class="space-y-2 text-sm">
          <li><a href="#" class="hover:text-white transition-colors">러닝퍼실리테이터 센터</a></li>
          <li><a href="#" class="hover:text-white transition-colors">코스 개설</a></li>
          <li><a href="#" class="hover:text-white transition-colors">정산 안내</a></li>
          <li><a href="#" class="hover:text-white transition-colors">러닝퍼실리테이터 가이드</a></li>
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
      <p class="text-xs text-gray-500 text-center">&copy; 2026 크레드라. All rights reserved. | 대표: 곽정율 | 사업자등록번호: 486-46-01220 | 주소: 경기도 부천시 원미구 길주로 91, 4층 419호(상동, 비잔티움 상동)</p>
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
          <input type="email" id="loginEmail" placeholder="example@email.com" autocomplete="username" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-dark-700 mb-1">비밀번호</label>
          <input type="password" id="loginPassword" placeholder="비밀번호 입력" autocomplete="current-password" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm">
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
        <p class="text-sm text-gray-500 mt-1">지금 가입하고 무료 코스를 체험하세요</p>
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
        <div>
          <label class="block text-sm font-medium text-dark-700 mb-1"><i class="fas fa-flask text-purple-500 mr-1"></i>테스트 코드 <span class="text-gray-400 font-normal">(선택)</span></label>
          <input type="text" id="regTestCode" placeholder="테스트 코드가 있으면 입력하세요" class="w-full h-11 px-4 border border-gray-200 rounded-xl text-sm uppercase" style="text-transform: uppercase;">
          <p class="text-xs text-purple-600 mt-1"><i class="fas fa-info-circle mr-1"></i>테스트 코드 입력 시 30일간 무료 수강 가능</p>
        </div>
        <label class="flex items-start gap-2 text-xs text-gray-500"><input type="checkbox" id="agreeTerms" class="mt-0.5 accent-primary-500"> <span>이용약관 및 개인정보처리방침에 동의합니다</span></label>
        <button onclick="handleRegister()" class="w-full h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all">가입하기</button>
        <p class="text-center text-sm text-gray-500">이미 계정이 있으신가요? <button onclick="switchAuth('login')" class="text-primary-500 font-semibold hover:underline">로그인</button></p>
      </div>
      <p id="regError" class="text-red-500 text-sm text-center mt-3 hidden"></p>
    </div>
  </div>
</div>

<!-- Payment Modal (Simple) -->
<div id="paymentModal" class="fixed inset-0 z-[100] hidden">
  <div class="absolute inset-0 bg-black/50 modal-overlay" onclick="closePaymentModal()"></div>
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-2xl shadow-2xl fade-in">
    <div class="p-5 border-b border-gray-100">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold text-dark-900">결제 확인</h2>
        <button onclick="closePaymentModal()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times text-xl"></i></button>
      </div>
    </div>
    <div class="p-5">
      <!-- Order Summary -->
      <div id="paymentOrderSummary" class="bg-gray-50 rounded-xl p-4 mb-4"></div>

      <!-- Price Summary -->
      <div id="priceSummary" class="border-t border-gray-100 pt-4 mb-4 space-y-2"></div>

      <!-- Agreement -->
      <label class="flex items-start gap-2 text-xs text-gray-500 mb-4">
        <input type="checkbox" id="paymentAgree" class="mt-0.5 accent-primary-500">
        <span>결제 진행에 동의합니다. 구매 조건 및 환불 규정을 확인했습니다.</span>
      </label>

      <!-- Pay Button -->
      <button id="payButton" onclick="processPayment()" class="w-full h-12 bg-primary-500 hover:bg-primary-600 disabled:bg-gray-300 text-white font-bold rounded-xl transition-all text-base">
        결제하기
      </button>
      <p class="text-center text-xs text-gray-400 mt-3"><i class="fas fa-lock mr-1"></i>안전한 결제 (헥토파이낸셜)</p>
      <p id="paymentError" class="text-red-500 text-sm text-center mt-2 hidden"></p>
    </div>
  </div>
</div>

<!-- Payment Success Modal -->
<div id="successModal" class="fixed inset-0 z-[110] hidden">
  <div class="absolute inset-0 bg-black/50 modal-overlay"></div>
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-2xl shadow-2xl p-8 text-center fade-in">
    <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
      <i class="fas fa-check text-green-500 text-2xl"></i>
    </div>
    <h3 class="text-xl font-bold text-dark-900 mb-2">결제 완료!</h3>
    <p id="successMessage" class="text-sm text-gray-600 mb-4">결제가 성공적으로 완료되었습니다.</p>
    <div id="classinSessionInfo" class="hidden"></div>
    
    
    <div class="flex gap-2">
      <a href="/mypage" class="flex-1 h-11 bg-gray-100 hover:bg-gray-200 text-dark-700 font-semibold rounded-xl transition-all flex items-center justify-center">
        <i class="fas fa-user mr-1"></i>마이페이지
      </a>
      <button onclick="goToCourseDetail()" id="goToCourseBtn" class="flex-1 h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all">
        <i class="fas fa-book-open mr-1"></i>코스 상세 보기
      </button>
    </div>
  </div>
</div>

<!-- Test Code Modal -->
<div id="testCodeModal" class="fixed inset-0 z-[100] hidden">
  <div class="absolute inset-0 bg-black/50 modal-overlay" onclick="closeTestCodeModal()"></div>
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-2xl shadow-2xl fade-in">
    <div class="p-6 border-b border-gray-100">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-bold text-dark-900"><i class="fas fa-flask text-purple-500 mr-2"></i>테스트 코드 입력</h2>
        <button onclick="closeTestCodeModal()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times text-xl"></i></button>
      </div>
    </div>
    <div class="p-6">
      <div class="bg-purple-50 border border-purple-100 rounded-xl p-4 mb-4">
        <p class="text-sm text-purple-800"><i class="fas fa-info-circle mr-2"></i>테스트 코드를 입력하면 <strong>30일간 결제 없이</strong> 모든 코스를 무료로 수강할 수 있습니다.</p>
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">테스트 코드</label>
        <input type="text" id="testCodeInput" placeholder="테스트 코드를 입력하세요" class="w-full h-12 px-4 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 uppercase" style="text-transform: uppercase;">
      </div>
      <p id="testCodeError" class="text-red-500 text-sm mb-4 hidden"></p>
      <p id="testCodeSuccess" class="text-green-600 text-sm mb-4 hidden"></p>
      <button onclick="activateTestCode()" class="w-full h-12 bg-purple-500 hover:bg-purple-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-purple-500/30">
        <i class="fas fa-check-circle mr-2"></i>테스트 코드 활성화
      </button>
    </div>
    <div class="px-6 pb-6">
      <div id="testAccountStatus" class="hidden">
        <div class="bg-green-50 border border-green-200 rounded-xl p-4">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
              <i class="fas fa-check text-green-600"></i>
            </div>
            <div>
              <p class="font-semibold text-green-800">테스트 계정 활성화됨</p>
              <p class="text-sm text-green-600" id="testAccountExpiry">만료일: -</p>
            </div>
          </div>
        </div>
      </div>
    </div>
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
// 페이지별 스크립트에서 이미 선언했을 수 있으므로 조건부 선언
if (typeof currentUser === 'undefined') { var currentUser = JSON.parse(localStorage.getItem('classin_user') || 'null'); }
if (typeof currentToken === 'undefined') { var currentToken = localStorage.getItem('classin_token') || null; }

// 토큰이 없거나 구 형식이면 재로그인 필요
if (currentUser && (!currentToken || currentToken.startsWith('demo_token_'))) {
  localStorage.removeItem('classin_token');
  localStorage.removeItem('classin_user');
  currentUser = null;
  currentToken = null;
}

// ==================== Auth ====================
function updateAuthUI() {
  const area = document.getElementById('authArea');
  if (!area) return;
  if (currentUser) {
    const mypageUrl = '/mypage';
    area.innerHTML = \`
      <a href="\${mypageUrl}" class="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-50 transition-all">
        <div class="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
          <span class="text-sm font-bold text-primary-600">\${currentUser.name?.charAt(0) || 'U'}</span>
        </div>
        <span class="text-sm font-medium text-dark-700 hidden sm:block">마이페이지(\${currentUser.name}\${currentUser.is_test_account ? ',테스트' : ''})</span>
      </a>
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
    closeAuthModal(); updateAuthUI(); updateEnrolledBadges();
  } catch(e) { showError('loginError', '로그인에 실패했습니다.'); }
}

async function handleRegister() {
  const name = document.getElementById('regName').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPassword').value;
  const testCode = document.getElementById('regTestCode')?.value?.trim().toUpperCase() || '';
  const agree = document.getElementById('agreeTerms').checked;
  if (!name || !email || !password) { showError('regError', '모든 항목을 입력해주세요.'); return; }
  if (!agree) { showError('regError', '이용약관에 동의해주세요.'); return; }
  try {
    const res = await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email, password, name, testCode}) });
    const data = await res.json();
    if (!res.ok) { showError('regError', data.error); return; }
    currentUser = data.user; currentToken = data.token;
    localStorage.setItem('classin_user', JSON.stringify(data.user));
    localStorage.setItem('classin_token', data.token);
    closeAuthModal(); updateAuthUI(); updateEnrolledBadges();
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
      <span class="text-sm text-gray-600">총 \${items.length}개 코스</span>
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

  // 테스트 계정은 결제 없이 바로 수강 등록
  if (currentUser.is_test_account && classData.id) {
    testEnroll(classData.id);
    return;
  }

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

// 강의별 결제 모달
function openLessonPaymentModal(lessonData) {
  if (!currentUser) { openAuthModal('login'); return; }

  // 테스트 계정은 결제 없이 바로 강의 등록
  if (currentUser.is_test_account && lessonData.lessonId) {
    testEnrollLesson(lessonData.lessonId);
    return;
  }

  paymentData = {
    ...lessonData,
    id: lessonData.classId,
    title: lessonData.classTitle + ' - ' + lessonData.lessonTitle,
    original_price: lessonData.price,
    orderType: 'lesson',
    lessonId: lessonData.lessonId
  };
  document.getElementById('paymentModal').classList.remove('hidden');

  const lessonDate = new Date(lessonData.scheduledAt).toLocaleString('ko-KR', { timeZone:'Asia/Seoul', month:'long', day:'numeric', weekday:'short', hour:'2-digit', minute:'2-digit' });

  document.getElementById('paymentOrderSummary').innerHTML = \`
    <div class="flex gap-3">
      \${lessonData.thumbnail ? \`<img src="\${lessonData.thumbnail}" class="w-20 h-14 rounded-lg object-cover">\` : ''}
      <div>
        <p class="text-sm font-semibold text-dark-800">\${lessonData.lessonTitle}</p>
        <p class="text-xs text-gray-500 mt-0.5">\${lessonData.classTitle}</p>
        <p class="text-xs text-primary-500 mt-1"><i class="far fa-calendar-alt mr-1"></i>\${lessonDate}</p>
      </div>
    </div>
  \`;
  document.getElementById('priceSummary').innerHTML = \`
    <div class="flex justify-between text-sm"><span class="text-gray-500">강의 1개</span><span class="text-gray-700">\${lessonData.price.toLocaleString()}원</span></div>
    <div class="flex justify-between text-base font-bold pt-2 border-t border-gray-200 mt-2"><span class="text-dark-900">총 결제금액</span><span class="text-primary-600">\${lessonData.price.toLocaleString()}원</span></div>
  \`;
}

// 테스트 계정 강의 수강 등록
async function testEnrollLesson(lessonId) {
  try {
    const res = await fetch('/api/lesson-enroll/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, lessonId })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('successModal').classList.remove('hidden');
      document.getElementById('successMessage').textContent = '강의 수강이 완료되었습니다! (테스트 계정)';
      document.getElementById('classinSessionInfo').classList.add('hidden');
    } else {
      alert(data.error || '수강 등록 실패');
    }
  } catch (e) {
    alert('수강 등록 중 오류 발생');
  }
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

// 헥토파이낸셜 PG SDK 로드
let hectoSdkLoaded = false;
async function loadHectoSdk(serverUrl) {
  if (hectoSdkLoaded) return;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = serverUrl + '/resources/js/v1/SettlePG_v1.2.js';
    script.onload = () => { hectoSdkLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load Hecto PG SDK'));
    document.head.appendChild(script);
  });
}

// 헥토 결제 결과 수신 리스너
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'HECTO_PAYMENT_RESULT') {
    const result = e.data.data;
    const btn = document.getElementById('payButton');
    if (btn) { btn.disabled = false; btn.innerHTML = '결제하기'; }

    if (result.outStatCd === '0021') {
      // 결제 성공 - 수강 등록 처리 호출
      processEnrollmentAfterPayment(result);
    } else {
      // 결제 실패
      showError('paymentError', result.outRsltMsg || '결제에 실패했습니다.');
    }
  }
});

// 결제 성공 후 수강 등록 처리
async function processEnrollmentAfterPayment(result) {
  try {
    // mchtParam에서 주문 정보 추출
    const parts = (result.mchtParam || '').split('|');
    const orderId = parts[0];
    const userId = parts[1];
    const classId = parts[2];
    const lessonId = parts[3];
    const orderType = parts[4] || 'class';
    
    // 결제 완료 처리 API 호출
    const res = await fetch('/api/payment/hecto/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: parseInt(orderId),
        userId: parseInt(userId),
        classId: classId ? parseInt(classId) : null,
        lessonId: lessonId ? parseInt(lessonId) : null,
        orderType,
        trdNo: result.trdNo || result.mchtTrdNo,
        mchtTrdNo: result.mchtTrdNo
      })
    });
    
    const data = await res.json();
    if (data.success) {
      closePaymentModal();
      document.getElementById('successModal').classList.remove('hidden');
      document.getElementById('successMessage').textContent = '결제 및 수강등록이 완료되었습니다!';
      document.getElementById('classinSessionInfo').classList.add('hidden');
    } else {
      closePaymentModal();
      document.getElementById('successModal').classList.remove('hidden');
      document.getElementById('successMessage').textContent = '결제는 완료되었으나 수강등록에 문제가 있습니다. 고객센터에 문의해주세요.';
      document.getElementById('classinSessionInfo').classList.add('hidden');
    }
  } catch (e) {
    console.error('Enrollment error:', e);
    closePaymentModal();
    document.getElementById('successModal').classList.remove('hidden');
    document.getElementById('successMessage').textContent = '결제 완료! (수강등록 처리 중 오류 - 고객센터 문의)';
    document.getElementById('classinSessionInfo').classList.add('hidden');
  }
}

async function processPayment() {
  
  const agree = document.getElementById('paymentAgree').checked;
  if (!agree) { showError('paymentError', '결제 동의에 체크해주세요.'); return; }

  const btn = document.getElementById('payButton');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>결제 준비 중...';

  try {
    // 헥토 PG 설정 확인
    const statusRes = await fetch('/api/payment/hecto/status');
    const statusData = await statusRes.json();

    if (!statusData.configured) {
      // PG 미설정시 기존 데모 결제로 fallback
      const body = {
        userId: currentUser.id,
        classId: paymentData.id || null,
        lessonId: paymentData.lessonId || null,
        paymentMethod: paymentData.paymentMethod || 'card',
        cardNumber: document.getElementById('cardNumber')?.value?.replace(/\\s/g,'') || '',
        cardExpiry: document.getElementById('cardExpiry')?.value || '',
        cardCvc: document.getElementById('cardCvc')?.value || '',
        amount: paymentData.price,
        orderType: paymentData.orderType || 'class',
        subscriptionPlan: paymentData.subscriptionPlan || null
      };

      await new Promise(r => setTimeout(r, 1500));
      const res = await fetch('/api/payment/process', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const data = await res.json();

      if (data.success) {
        closePaymentModal();
        document.getElementById('successModal').classList.remove('hidden');
        document.getElementById('successMessage').textContent = data.message + ' (거래번호: ' + data.transactionId + ')';
        if (data.classinSession && data.classinSession.joinUrl) {
          const infoDiv = document.getElementById('classinSessionInfo');
          infoDiv.classList.remove('hidden');
          document.getElementById('classinJoinUrlText').textContent = data.classinSession.joinUrl;
          document.getElementById('classinClassIdText').textContent = '강의 ID: ' + (data.classinSession.classId || '');
          document.getElementById('classinJoinBtn').href = data.classinSession.joinUrl;
          document.getElementById('classinModeTag').textContent = data.classinSession.isDemo ? 'DEMO MODE - 실제 API 키 설정 시 ClassIn 연동' : 'ClassIn API 연동됨';
        } else {
          document.getElementById('classinSessionInfo').classList.add('hidden');
        }
      } else {
        showError('paymentError', data.error || '결제에 실패했습니다.');
      }
      btn.disabled = false; btn.innerHTML = '결제하기';
      return;
    }

    // 헥토 PG 결제 진행
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>결제창 로딩 중...';

    // 결제 파라미터 준비
    const prepareRes = await fetch('/api/payment/hecto/prepare', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        classId: paymentData.id || null,
        lessonId: paymentData.lessonId || null,
        userId: currentUser.id,
        amount: paymentData.price,
        productName: paymentData.title || '강의 결제',
        customerName: currentUser.name || '',
        customerPhone: currentUser.phone || '',
        customerEmail: currentUser.email || '',
        orderType: paymentData.orderType || 'class'
      })
    });
    const prepareData = await prepareRes.json();

    if (!prepareData.success) {
      showError('paymentError', prepareData.error || '결제 준비에 실패했습니다.');
      btn.disabled = false; btn.innerHTML = '결제하기';
      return;
    }

    // 헥토 PG SDK 로드
    
    
    
    await loadHectoSdk(prepareData.paymentParams.env);

    //// 결제창 호출
    
    SETTLE_PG.pay(prepareData.paymentParams, function(rsp) {
      // iframe 방식일 때 콜백
      if (rsp.outStatCd === '0021') {
        closePaymentModal();
        document.getElementById('successModal').classList.remove('hidden');
        document.getElementById('successMessage').textContent = '결제가 완료되었습니다! (주문번호: ' + rsp.mchtTrdNo + ')';
        document.getElementById('classinSessionInfo').classList.add('hidden');
      } else {
        showError('paymentError', rsp.outRsltMsg || '결제에 실패했습니다.');
      }
      btn.disabled = false; btn.innerHTML = '결제하기';
    });

  } catch(e) {
    console.error('Payment error:', e);
    showError('paymentError', '결제 처리 중 오류가 발생했습니다.');
    btn.disabled = false; btn.innerHTML = '결제하기';
  }
}

function closeSuccessModal() {
  document.getElementById('successModal').classList.add('hidden');
  // Refresh user data
  if (currentUser) {
    fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:currentUser.email, password:'any'}) })
      .then(r=>r.json()).then(d=>{ if(d.user){ currentUser=d.user; localStorage.setItem('classin_user',JSON.stringify(d.user)); updateAuthUI(); }});
  }
}

// 결제 완료 후 코스 상세 페이지로 이동
function goToCourseDetail() {
  document.getElementById('successModal').classList.add('hidden');
  if (paymentData.slug) {
    window.location.href = '/class/' + paymentData.slug;
  } else if (paymentData.id) {
    // slug가 없으면 마이페이지로
    window.location.href = '/mypage';
  }
}

// ==================== Subscription (월간 자동결제) ====================
let subscriptionData = {};

function openSubscriptionModal(data) {
  if (!currentUser) { openAuthModal('login'); return; }

  // 테스트 계정이 코스 월간 구독 시도 시 바로 수강 등록
  if (currentUser.is_test_account && data.classId) {
    testEnroll(data.classId);
    return;
  }

  subscriptionData = data;
  // goToCourseDetail에서 사용할 수 있도록 paymentData에도 slug 저장
  paymentData.slug = data.slug;
  paymentData.id = data.classId;
  document.getElementById('paymentModal').classList.remove('hidden');
  
  const billingDay = new Date().getDate();
  const nextMonth = new Date(); nextMonth.setMonth(nextMonth.getMonth() + 1);
  
  document.getElementById('paymentOrderSummary').innerHTML = \`
    <div class="flex gap-3">
      \${data.thumbnail ? \`<img src="\${data.thumbnail}" class="w-20 h-14 rounded-lg object-cover">\` : \`<div class="w-20 h-14 bg-primary-50 rounded-lg flex items-center justify-center"><i class="fas fa-crown text-primary-500 text-xl"></i></div>\`}
      <div>
        <p class="text-sm font-semibold text-dark-800">\${data.title}</p>
        <p class="text-xs text-gray-500 mt-0.5">\${data.instructor_name || '모든 코스 무제한'}</p>
      </div>
    </div>
    <div class="mt-3 bg-blue-50 rounded-xl p-3">
      <div class="flex items-center gap-2 mb-1">
        <i class="fas fa-sync-alt text-blue-500 text-sm"></i>
        <span class="text-sm font-bold text-blue-800">월간 자동결제</span>
      </div>
      <p class="text-xs text-blue-600">매월 <strong>\${billingDay}일</strong>에 자동 결제 · 다음 결제일: <strong>\${nextMonth.toLocaleDateString('ko-KR', {month:'long', day:'numeric'})}</strong></p>
    </div>
  \`;
  
  const discount = (data.originalAmount || data.amount) - data.amount;
  document.getElementById('priceSummary').innerHTML = \`
    <div class="flex justify-between text-sm"><span class="text-gray-500">월 정가</span><span class="text-gray-700">\${(data.originalAmount || data.amount).toLocaleString()}원</span></div>
    \${discount > 0 ? \`<div class="flex justify-between text-sm"><span class="text-gray-500">할인</span><span class="text-primary-500 font-medium">-\${discount.toLocaleString()}원</span></div>\` : ''}
    <div class="flex justify-between text-base font-bold pt-2 border-t border-gray-200 mt-2">
      <span class="text-dark-900">월 결제금액</span>
      <div class="text-right">
        <span class="text-primary-600">\${data.amount.toLocaleString()}원/월</span>
        <p class="text-[10px] text-gray-400 font-normal">매월 \${billingDay}일 자동결제</p>
      </div>
    </div>
  \`;
  
  // Override payment button for subscription
  const payBtn = document.getElementById('payButton');
  payBtn.innerHTML = '<i class="fas fa-sync-alt mr-2"></i>월간 구독 시작하기';
  payBtn.onclick = processSubscription;
}

async function processSubscription() {
  const agree = document.getElementById('paymentAgree').checked;
  if (!agree) { showError('paymentError', '결제 동의에 체크해주세요.'); return; }
  
  const btn = document.getElementById('payButton');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>구독 처리 중...';
  
  try {
    const body = {
      userId: currentUser.id,
      planType: subscriptionData.planType,
      classId: subscriptionData.classId || null,
      amount: subscriptionData.amount,
      paymentMethod: paymentData.paymentMethod || 'card',
      cardNumber: document.getElementById('cardNumber')?.value?.replace(/\\s/g,'') || '',
      cardExpiry: document.getElementById('cardExpiry')?.value || '',
      cardCvc: document.getElementById('cardCvc')?.value || ''
    };
    
    await new Promise(r => setTimeout(r, 1500));
    
    const res = await fetch('/api/subscription/create', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const data = await res.json();
    
    if (data.success) {
      closePaymentModal();
      document.getElementById('successModal').classList.remove('hidden');
      document.getElementById('successMessage').textContent = data.message;
      
      if (data.classinSession && data.classinSession.joinUrl) {
        const infoDiv = document.getElementById('classinSessionInfo');
        infoDiv.classList.remove('hidden');
        document.getElementById('classinJoinUrlText').textContent = data.classinSession.joinUrl;
        document.getElementById('classinClassIdText').textContent = '강의 ID: ' + (data.classinSession.classId || '');
        document.getElementById('classinJoinBtn').href = data.classinSession.joinUrl;
        document.getElementById('classinModeTag').textContent = data.classinSession.isDemo ? 'DEMO MODE' : 'ClassIn API 연동됨';
      } else {
        document.getElementById('classinSessionInfo').classList.add('hidden');
      }
    } else {
      showError('paymentError', data.error || '구독 처리에 실패했습니다.');
    }
  } catch(e) {
    showError('paymentError', '구독 처리 중 오류가 발생했습니다.');
  }
  
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt mr-2"></i>월간 구독 시작하기';
  // Reset pay button for normal payment
  btn.onclick = processPayment;
  btn.innerHTML = '결제하기';
}

// Switch between onetime and monthly pay options on class detail page
function switchPayOption(opt) {
  document.getElementById('payOnetime')?.classList.toggle('hidden', opt !== 'onetime');
  document.getElementById('payMonthly')?.classList.toggle('hidden', opt !== 'monthly');
  document.querySelectorAll('.pay-opt-tab').forEach(b => {
    b.classList.toggle('bg-white', false);
    b.classList.toggle('text-dark-900', false);
    b.classList.toggle('shadow-sm', false);
    b.classList.add('text-gray-500');
  });
  const activeBtn = document.getElementById(opt === 'onetime' ? 'payOptOnetime' : 'payOptMonthly');
  if (activeBtn) {
    activeBtn.classList.add('bg-white', 'text-dark-900', 'shadow-sm');
    activeBtn.classList.remove('text-gray-500');
  }
}

// ==================== My Page ====================
async function openMyPage(tab) {
  if (!currentUser) { openAuthModal('login'); return; }
  document.getElementById('myPageSidebar').classList.remove('hidden');
  const content = document.getElementById('myPageContent');
  const isInstructor = currentUser.role === 'instructor' || currentUser.is_instructor === 1;
  const activeTab = tab || 'enrollments';

  // Check test account status (학생만)
  let testAccountBadge = '';
  if (!isInstructor) {
    try {
      const testRes = await fetch('/api/user/' + currentUser.id + '/test-status');
      const testData = await testRes.json();
      if (testData.isTestAccount) {
        testAccountBadge = \`<span class="inline-block mt-1 ml-1 px-2 py-0.5 bg-purple-100 text-purple-600 text-xs font-semibold rounded-full"><i class="fas fa-flask mr-1"></i>테스트</span>\`;
      }
    } catch(e) {}
  }

  // 강사용 UI
  if (isInstructor) {
    content.innerHTML = \`
      <div class="flex items-center gap-3 mb-4 pb-4 border-b border-gray-100">
        <div class="w-14 h-14 bg-indigo-100 rounded-full flex items-center justify-center">
          <span class="text-xl font-bold text-indigo-600">\${currentUser.name?.charAt(0) || 'U'}</span>
        </div>
        <div>
          <p class="font-bold text-dark-900">\${currentUser.name}</p>
          <p class="text-sm text-gray-500">\${currentUser.email}</p>
          <span class="inline-block mt-1 px-2 py-0.5 bg-indigo-100 text-indigo-600 text-xs font-semibold rounded-full"><i class="fas fa-chalkboard-teacher mr-1"></i>강사</span>
        </div>
      </div>
      <div class="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1">
        <button onclick="loadMyPageTab('enrollments')" class="mypage-tab flex-1 py-1.5 text-xs font-medium rounded-lg transition-all \${activeTab==='enrollments'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}">강의중</button>
        <button onclick="loadMyPageTab('completed')" class="mypage-tab flex-1 py-1.5 text-xs font-medium rounded-lg transition-all \${activeTab==='completed'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}">강의완료</button>
      </div>
      <div id="myPageTabContent"></div>
    \`;
  } else {
    // 학생용 UI
    content.innerHTML = \`
      <div class="flex items-center gap-3 mb-4 pb-4 border-b border-gray-100">
        <div class="w-14 h-14 bg-primary-100 rounded-full flex items-center justify-center">
          <span class="text-xl font-bold text-primary-600">\${currentUser.name?.charAt(0) || 'U'}</span>
        </div>
        <div>
          <p class="font-bold text-dark-900">\${currentUser.name}</p>
          <p class="text-sm text-gray-500">\${currentUser.email}</p>
          \${currentUser.subscription_plan ? \`<span class="inline-block mt-1 px-2 py-0.5 bg-primary-100 text-primary-600 text-xs font-semibold rounded-full">\${currentUser.subscription_plan === 'annual' ? '연간' : '월간'} 구독중</span>\` : ''}
          \${testAccountBadge}
        </div>
      </div>
      <button onclick="openTestCodeModal(); closeMyPage();" class="w-full mb-4 py-3 bg-purple-50 hover:bg-purple-100 text-purple-700 font-medium rounded-xl transition-all flex items-center justify-center gap-2 border border-purple-200">
        <i class="fas fa-flask"></i>테스트 코드 입력
      </button>
      <div class="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1">
        <button onclick="loadMyPageTab('enrollments')" class="mypage-tab flex-1 py-1.5 text-xs font-medium rounded-lg transition-all \${activeTab==='enrollments'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}">수강중</button>
        <button onclick="loadMyPageTab('completed')" class="mypage-tab flex-1 py-1.5 text-xs font-medium rounded-lg transition-all \${activeTab==='completed'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}">수강완료</button>
        <button onclick="loadMyPageTab('subscriptions')" class="mypage-tab flex-1 py-1.5 text-xs font-medium rounded-lg transition-all \${activeTab==='subscriptions'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}"><i class="fas fa-sync-alt mr-0.5 text-[9px]"></i>구독</button>
        <button onclick="loadMyPageTab('orders')" class="mypage-tab flex-1 py-1.5 text-xs font-medium rounded-lg transition-all \${activeTab==='orders'?'bg-white text-dark-900 shadow-sm':'text-gray-500'}">결제내역</button>
      </div>
      <div id="myPageTabContent"></div>
    \`;
  }
  loadMyPageTab(activeTab);
}
function closeMyPage() { document.getElementById('myPageSidebar').classList.add('hidden'); }

// Test Code Functions
function openTestCodeModal() {
  if (!currentUser) { openAuthModal('login'); return; }
  document.getElementById('testCodeModal').classList.remove('hidden');
  document.getElementById('testCodeError').classList.add('hidden');
  document.getElementById('testCodeSuccess').classList.add('hidden');
  checkTestAccountStatus();
}

function closeTestCodeModal() {
  document.getElementById('testCodeModal').classList.add('hidden');
}

async function checkTestAccountStatus() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/user/' + currentUser.id + '/test-status');
    const data = await res.json();
    const statusDiv = document.getElementById('testAccountStatus');
    if (data.isTestAccount) {
      statusDiv.classList.remove('hidden');
      document.getElementById('testAccountExpiry').textContent = '만료일: ' + new Date(data.expiresAt).toLocaleDateString('ko-KR');
    } else {
      statusDiv.classList.add('hidden');
    }
  } catch (e) {}
}

async function activateTestCode() {
  if (!currentUser) { openAuthModal('login'); return; }
  const code = document.getElementById('testCodeInput').value.trim().toUpperCase();
  const errorEl = document.getElementById('testCodeError');
  const successEl = document.getElementById('testCodeSuccess');

  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  if (!code) {
    errorEl.textContent = '테스트 코드를 입력해주세요.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch('/api/test-account/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, accessCode: code })
    });
    const data = await res.json();

    if (data.success) {
      successEl.textContent = data.message;
      successEl.classList.remove('hidden');
      document.getElementById('testCodeInput').value = '';
      // Refresh user data
      currentUser.is_test_account = true;
      localStorage.setItem('classin_user', JSON.stringify(currentUser));
      // 1초 후 모달 닫고 마이페이지 새로고침
      setTimeout(() => {
        closeTestCodeModal();
        openMyPage();
      }, 1000);
    } else {
      errorEl.textContent = data.error || '활성화에 실패했습니다.';
      errorEl.classList.remove('hidden');
    }
  } catch (e) {
    errorEl.textContent = '서버 오류가 발생했습니다.';
    errorEl.classList.remove('hidden');
  }
}

function showEnrollSuccessModal(message, joinUrl, isDemo) {
  // 기존 모달이 있으면 제거
  const existingModal = document.getElementById('enrollSuccessModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'enrollSuccessModal';
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
  modal.innerHTML = \`
    <div class="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center">
      <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <i class="fas fa-check text-green-500 text-3xl"></i>
      </div>
      <h3 class="text-xl font-bold text-dark-900 mb-2">수강신청 완료!</h3>
      <p class="text-gray-600 mb-6">\${message}</p>
      <button onclick="document.getElementById('enrollSuccessModal').remove(); window.location.reload();"
              class="w-full h-12 bg-rose-500 hover:bg-rose-600 text-white font-bold rounded-xl transition-all shadow-lg">
        확인
      </button>
    </div>
  \`;
  document.body.appendChild(modal);
}

async function testEnroll(classId) {
  if (!currentUser) { openAuthModal('login'); return; }

  try {
    const res = await fetch('/api/test-account/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, classId: classId })
    });
    const data = await res.json();

    if (data.success) {
      if (data.classinSession && data.classinSession.joinUrl) {
        const joinUrl = data.classinSession.joinUrl;
        // 수강신청 완료 모달 표시
        showEnrollSuccessModal(data.message, joinUrl, data.classinSession.isDemo);
      } else {
        alert(data.message);
        window.location.reload();
      }
    } else {
      alert(data.error || '수강신청에 실패했습니다.');
    }
  } catch (e) {
    console.error('testEnroll error:', e);
    alert('서버 오류가 발생했습니다: ' + (e.message || e));
  }
}

async function loadMyPageTab(tab) {
  const isInstructor = currentUser.role === 'instructor' || currentUser.is_instructor === 1;
  const tabs = ['enrollments','completed','subscriptions','orders'];

  document.querySelectorAll('.mypage-tab').forEach((b,i) => {
    b.classList.toggle('bg-white', tabs[i]===tab);
    b.classList.toggle('text-dark-900', tabs[i]===tab);
    b.classList.toggle('shadow-sm', tabs[i]===tab);
    b.classList.toggle('text-gray-500', tabs[i]!==tab);
  });
  const container = document.getElementById('myPageTabContent');

  // 강사용 마이페이지
  if (isInstructor) {
    if (tab === 'enrollments') {
      // 강의중인 코스
      const res = await fetch('/api/user/'+currentUser.id+'/instructor-classes');
      const items = await res.json();

      const activeItems = items.filter(c => c.next_lesson_id || c.total_lesson_count === 0);

      container.innerHTML = activeItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-chalkboard text-3xl mb-2"></i><p>강의중인 코스가 없습니다</p></div>'
        : activeItems.map(c => {
          const hasNextLesson = c.next_lesson_id;
          const progress = c.total_lesson_count > 0 ? Math.round((c.completed_lesson_count / c.total_lesson_count) * 100) : 0;

          let lessonSection = '';
          if (hasNextLesson) {
            const dateStr = c.next_lesson_scheduled_at ? new Date(c.next_lesson_scheduled_at).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
            const enterBtn = c.next_lesson_id
              ? '<a href="/api/classin/instructor-enter/' + c.next_lesson_id + '?redirect=true" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex-1 h-8 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all"><i class="fas fa-door-open"></i> 강의실 입장</a>'
              : '<span class="flex-1 h-8 bg-gray-200 text-gray-600 text-xs font-semibold rounded-lg flex items-center justify-center gap-1"><i class="fas fa-clock"></i> 강의 준비중</span>';
            lessonSection = '<div class="mt-2 pt-2 border-t border-gray-50"><div class="flex items-center gap-2 mb-2"><span class="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-bold rounded">다음 강의</span><span class="text-[11px] text-gray-400">' + dateStr + '</span></div><p class="text-xs text-gray-600 mb-2 line-clamp-1">' + (c.next_lesson_title || '') + '</p><div class="flex gap-2">' + enterBtn + '</div></div>';
          } else {
            lessonSection = '<div class="mt-2 pt-2 border-t border-gray-50"><p class="text-xs text-gray-400 text-center">아직 예정된 강의가 없습니다</p></div>';
          }

          return '<div class="p-3 rounded-xl hover:bg-gray-50 transition-all mb-2 border border-gray-100"><a href="/class/' + c.slug + '" class="flex gap-3"><div class="relative flex-shrink-0"><img src="' + (c.thumbnail || '') + '" class="w-20 h-14 rounded-lg object-cover bg-gray-200" onerror="this.onerror=null; this.style.display=&apos;none&apos;">' + (hasNextLesson ? '<span class="absolute -top-1 -right-1 w-5 h-5 bg-indigo-500 rounded-full flex items-center justify-center"><i class="fas fa-video text-white text-[8px]"></i></span>' : '') + '</div><div class="flex-1 min-w-0"><p class="text-sm font-medium text-dark-800 line-clamp-1">' + c.title + '</p><p class="text-xs text-gray-500">' + (c.category_name || '') + ' · 수강생 ' + (c.active_students || 0) + '명</p><div class="flex items-center gap-2 mt-1"><div class="flex-1 bg-gray-200 rounded-full h-1.5"><div class="bg-indigo-500 h-1.5 rounded-full" style="width:' + progress + '%"></div></div><span class="text-[10px] text-gray-400">' + (c.completed_lesson_count || 0) + '/' + (c.total_lesson_count || 0) + '회</span></div></div></a>' + lessonSection + '</div>';
        }).join('');
    } else if (tab === 'completed') {
      // 강의완료된 코스
      const res = await fetch('/api/user/'+currentUser.id+'/instructor-classes');
      const items = await res.json();

      const completedItems = items.filter(c => c.total_lesson_count > 0 && !c.next_lesson_id);

      container.innerHTML = completedItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-check-circle text-3xl mb-2"></i><p>강의 완료된 코스가 없습니다</p></div>'
        : completedItems.map(c => {
          const progress = c.total_lesson_count > 0 ? Math.round((c.completed_lesson_count / c.total_lesson_count) * 100) : 100;
          return \`
          <div class="p-3 rounded-xl hover:bg-gray-50 transition-all mb-2 border border-gray-100">
            <a href="/class/\${c.slug}" class="flex gap-3">
              <div class="relative flex-shrink-0">
                <img src="\${c.thumbnail || ''}" class="w-20 h-14 rounded-lg object-cover bg-gray-200" onerror="this.onerror=null; this.style.display='none'">
                <span class="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center"><i class="fas fa-check text-white text-[8px]"></i></span>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-dark-800 line-clamp-1">\${c.title}</p>
                <p class="text-xs text-gray-500">\${c.category_name || ''} · 수강생 \${c.active_students || 0}명</p>
                <div class="flex items-center gap-2 mt-1">
                  <div class="flex-1 bg-green-200 rounded-full h-1.5"><div class="bg-green-500 h-1.5 rounded-full" style="width:\${progress}%"></div></div>
                  <span class="text-[10px] text-gray-400">\${c.completed_lesson_count || 0}/\${c.total_lesson_count || 0}회</span>
                </div>
              </div>
            </a>
            <div class="mt-2 pt-2 border-t border-gray-50">
              <div class="flex items-center gap-2">
                <span class="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded">강의 완료</span>
                <span class="text-[11px] text-gray-400">총 \${c.completed_lesson_count || 0}회 강의</span>
              </div>
            </div>
          </div>
        \`}).join('');
    }
    return;
  }

  // 학생용 마이페이지
  if (tab === 'enrollments') {
    const res = await fetch('/api/user/'+currentUser.id+'/enrollments');
    const items = await res.json();

    // 활성 수강만 표시 (다음 예정 강의가 있거나, 강의가 아직 없는 경우)
    const activeItems = items.filter(e => {
      // 관리자가 종료/만료 처리한 수강은 제외
      if (e.status === 'ended' || e.status === 'expired') return false;
      // 다음 예정 강의가 있거나, 아직 강의가 없는 경우 표시
      return e.next_lesson_id || e.total_lesson_count === 0;
    });

    container.innerHTML = activeItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-book-open text-3xl mb-2"></i><p>수강 중인 코스가 없습니다</p></div>'
      : activeItems.map(e => {
        const hasNextLesson = e.next_lesson_id;
        const progress = e.total_lesson_count > 0 ? Math.round((e.completed_lesson_count / e.total_lesson_count) * 100) : 0;

        let lessonSection = '';
        if (hasNextLesson) {
          const dateStr = e.next_lesson_scheduled_at ? new Date(e.next_lesson_scheduled_at).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
          const enterBtn = e.next_lesson_session_id
            ? '<a href="/api/classin/enter/' + e.next_lesson_session_id + '?redirect=true" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex-1 h-8 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all"><i class="fas fa-door-open"></i> 강의 입장</a>'
            : (e.next_lesson_join_url
              ? '<a href="' + e.next_lesson_join_url + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex-1 h-8 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all"><i class="fas fa-door-open"></i> 강의 입장</a>'
              : '<span class="flex-1 h-8 bg-gray-200 text-gray-600 text-xs font-semibold rounded-lg flex items-center justify-center gap-1"><i class="fas fa-clock"></i> 강의 준비중</span>');
          lessonSection = '<div class="mt-2 pt-2 border-t border-gray-50"><div class="flex items-center gap-2 mb-2"><span class="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded">다음 강의</span><span class="text-[11px] text-gray-400">' + dateStr + '</span></div><p class="text-xs text-gray-600 mb-2 line-clamp-1">' + (e.next_lesson_title || '') + '</p><div class="flex gap-2">' + enterBtn + '</div></div>';
        } else {
          lessonSection = '<div class="mt-2 pt-2 border-t border-gray-50"><p class="text-xs text-gray-400 text-center">아직 예정된 강의가 없습니다</p></div>';
        }

        return '<div class="p-3 rounded-xl hover:bg-gray-50 transition-all mb-2 border border-gray-100"><a href="/class/' + e.slug + '" class="flex gap-3"><div class="relative flex-shrink-0"><img src="' + e.thumbnail + '" class="w-20 h-14 rounded-lg object-cover">' + (hasNextLesson ? '<span class="absolute -top-1 -right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center"><i class="fas fa-video text-white text-[8px]"></i></span>' : '') + '</div><div class="flex-1 min-w-0"><p class="text-sm font-medium text-dark-800 line-clamp-1">' + e.title + '</p><p class="text-xs text-gray-500">' + e.instructor_name + '</p><div class="flex items-center gap-2 mt-1"><div class="flex-1 bg-gray-200 rounded-full h-1.5"><div class="bg-primary-500 h-1.5 rounded-full" style="width:' + progress + '%"></div></div><span class="text-[10px] text-gray-400">' + (e.completed_lesson_count || 0) + '/' + (e.total_lesson_count || 0) + '</span></div></div></a>' + lessonSection + '</div>';
      }).join('');
  } else if (tab === 'completed') {
    const res = await fetch('/api/user/'+currentUser.id+'/enrollments');
    const items = await res.json();

    // 완료된 수강 (종료/만료 처리되었거나, 모든 강의가 완료된 경우)
    const completedItems = items.filter(e => {
      if (e.status === 'ended' || e.status === 'expired') return true;
      // 강의가 있고, 다음 예정 강의가 없으면 완료
      return e.total_lesson_count > 0 && !e.next_lesson_id;
    });

    container.innerHTML = completedItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-check-circle text-3xl mb-2"></i><p>수강 완료된 코스가 없습니다</p></div>'
      : completedItems.map(e => {
        const progress = e.total_lesson_count > 0 ? Math.round((e.completed_lesson_count / e.total_lesson_count) * 100) : 100;
        return \`
        <div class="p-3 rounded-xl hover:bg-gray-50 transition-all mb-2 border border-gray-100">
          <a href="/class/\${e.slug}" class="flex gap-3">
            <div class="relative flex-shrink-0">
              <img src="\${e.thumbnail}" class="w-20 h-14 rounded-lg object-cover">
              <span class="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center"><i class="fas fa-check text-white text-[8px]"></i></span>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-dark-800 line-clamp-1">\${e.title}</p>
              <p class="text-xs text-gray-500">\${e.instructor_name}</p>
              <div class="flex items-center gap-2 mt-1">
                <div class="flex-1 bg-green-200 rounded-full h-1.5"><div class="bg-green-500 h-1.5 rounded-full" style="width:\${progress}%"></div></div>
                <span class="text-[10px] text-gray-400">\${e.completed_lesson_count || 0}/\${e.total_lesson_count || 0}</span>
              </div>
            </div>
          </a>
          <div class="mt-2 pt-2 border-t border-gray-50">
            <div class="flex items-center gap-2">
              <span class="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded">\${e.status === 'ended' ? '수강 종료' : '강의 완료'}</span>
              <span class="text-[11px] text-gray-400">총 \${e.completed_lesson_count || 0}회 강의</span>
            </div>
          </div>
        </div>
      \`}).join('');
  } else if (tab === 'subscriptions') {
    const res = await fetch('/api/user/'+currentUser.id+'/subscriptions');
    const subs = await res.json();
    if (!Array.isArray(subs) || subs.length === 0) {
      container.innerHTML = \`
        <div class="text-center py-8 text-gray-400">
          <i class="fas fa-sync-alt text-3xl mb-2"></i>
          <p>활성 구독이 없습니다</p>
          <a href="/#subscription" onclick="closeMyPage()" class="inline-block mt-3 px-4 py-2 bg-primary-500 text-white text-sm font-semibold rounded-xl hover:bg-primary-600 transition-all">구독 시작하기</a>
        </div>\`;
    } else {
      container.innerHTML = subs.map(sub => {
        const isActive = sub.status === 'active';
        const isCancelled = sub.status === 'cancelled';
        const nextDate = sub.next_billing_date ? new Date(sub.next_billing_date) : null;
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
        return \`
        <div class="p-4 rounded-xl border \${isActive ? 'border-blue-200 bg-blue-50/50' : isCancelled ? 'border-orange-200 bg-orange-50/50' : 'border-gray-200'} mb-3">
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-9 h-9 \${isActive ? 'bg-blue-100' : 'bg-gray-100'} rounded-lg flex items-center justify-center">
                <i class="fas \${sub.plan_type === 'all_monthly' ? 'fa-crown text-yellow-500' : 'fa-sync-alt text-blue-500'} text-sm"></i>
              </div>
              <div>
                <p class="text-sm font-bold text-dark-800">\${sub.class_title || '전체 코스 구독'}</p>
                <p class="text-xs text-gray-500">\${sub.instructor_name || '모든 강의 무제한'}</p>
              </div>
            </div>
            <span class="px-2 py-0.5 text-[10px] font-bold rounded-full \${isActive ? 'bg-green-100 text-green-700' : isCancelled ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'}">
              \${isActive ? '구독중' : isCancelled ? '해지 예정' : sub.status === 'payment_failed' ? '결제 실패' : sub.status}
            </span>
          </div>
          
          <div class="grid grid-cols-2 gap-2 mb-3">
            <div class="bg-white rounded-lg p-2">
              <p class="text-[10px] text-gray-400">월 결제금액</p>
              <p class="text-sm font-bold text-dark-800">\${sub.amount?.toLocaleString()}원</p>
            </div>
            <div class="bg-white rounded-lg p-2">
              <p class="text-[10px] text-gray-400">결제 수단</p>
              <p class="text-sm font-bold text-dark-800">\${sub.payment_method === 'card' ? '카드' : sub.payment_method} ····\${sub.card_last4}</p>
            </div>
            <div class="bg-white rounded-lg p-2">
              <p class="text-[10px] text-gray-400">매월 결제일</p>
              <p class="text-sm font-bold text-dark-800">매월 \${sub.billing_day}일</p>
            </div>
            <div class="bg-white rounded-lg p-2">
              <p class="text-[10px] text-gray-400">\${isCancelled ? '이용 가능일' : '다음 결제일'}</p>
              <p class="text-sm font-bold \${isCancelled ? 'text-orange-600' : 'text-blue-600'}">\${nextDate ? nextDate.toLocaleDateString('ko-KR', {month:'short', day:'numeric'}) : '-'}</p>
            </div>
          </div>
          
          \${isActive ? \`
            <button onclick="cancelSubscription(\${sub.id})" class="w-full h-9 border border-gray-200 text-gray-500 text-xs font-medium rounded-lg hover:bg-gray-50 hover:text-red-500 transition-all">
              <i class="fas fa-times mr-1"></i>구독 해지
            </button>
          \` : isCancelled ? \`
            <div class="flex gap-2">
              <p class="flex-1 text-xs text-orange-600 flex items-center"><i class="fas fa-info-circle mr-1"></i>\${periodEnd ? periodEnd.toLocaleDateString('ko-KR') : ''}까지 이용 가능</p>
              <button onclick="reactivateSubscription(\${sub.id})" class="h-9 px-4 bg-blue-500 text-white text-xs font-semibold rounded-lg hover:bg-blue-600 transition-all">
                <i class="fas fa-redo mr-1"></i>다시 구독
              </button>
            </div>
          \` : ''}
        </div>\`}).join('');
    }
  } else if (tab === 'wishlist') {
    const res = await fetch('/api/user/'+currentUser.id+'/wishlist');
    const items = await res.json();
    container.innerHTML = items.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="far fa-heart text-3xl mb-2"></i><p>찜한 코스가 없습니다</p></div>'
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
  setTimeout(() => toast.remove(), 4000);
}

function formatPrice(price) { return price?.toLocaleString() + '원'; }

// Class card HTML generator (코스 카드 - 항상 활성 상태, 강의 상태는 코스 클릭 후 강의 목록에서 확인)
function classCardHTML(cls) {
  return \`
    <a href="/class/\${cls.slug}" class="block bg-white rounded-2xl overflow-hidden card-hover border border-gray-100 course-card" data-course-id="\${cls.id}">
      <div class="relative aspect-[16/10] overflow-hidden">
        <img src="\${cls.thumbnail}" alt="\${cls.title}" class="w-full h-full object-cover transition-transform duration-500 hover:scale-105" loading="lazy">
        <span class="enrolled-badge absolute top-2.5 left-2.5 px-2 py-0.5 bg-green-500 text-white text-[10px] font-bold rounded-md hidden"><i class="fas fa-check mr-0.5"></i>수강중</span>
        \${cls.is_bestseller ? '<span class="absolute top-2.5 left-2.5 px-2 py-0.5 bg-primary-500 text-white text-[10px] font-bold rounded-md bestseller-badge">BEST</span>' : ''}
        \${cls.is_new ? '<span class="absolute top-2.5 left-2.5 px-2 py-0.5 bg-blue-500 text-white text-[10px] font-bold rounded-md new-badge">NEW</span>' : ''}
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

// ==================== Subscription Management ====================
async function cancelSubscription(subId) {
  if (!confirm('정말 구독을 해지하시겠습니까?\\n해지 후에도 현재 결제 기간까지는 이용 가능합니다.')) return;
  try {
    const res = await fetch('/api/subscription/' + subId + '/cancel', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ userId: currentUser.id })
    });
    const data = await res.json();
    if (data.success) { showToast(data.message); loadMyPageTab('subscriptions'); }
    else showToast(data.error || '해지에 실패했습니다.');
  } catch(e) { showToast('오류가 발생했습니다.'); }
}

async function reactivateSubscription(subId) {
  try {
    const res = await fetch('/api/subscription/' + subId + '/reactivate', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ userId: currentUser.id })
    });
    const data = await res.json();
    if (data.success) { showToast(data.message); loadMyPageTab('subscriptions'); }
    else showToast(data.error || '재활성화에 실패했습니다.');
  } catch(e) { showToast('오류가 발생했습니다.'); }
}

// 수강 중인 코스에 배지 표시
async function updateEnrolledBadges() {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (!user) return;

  try {
    // 사용자의 수강 목록 가져오기
    const res = await fetch('/api/user/' + user.id + '/enrollments');
    if (!res.ok) return;
    const enrollments = await res.json();

    // 수강 중인 코스 ID 목록 (숫자로 변환)
    const enrolledIds = enrollments.map(e => parseInt(e.class_id));
    console.log('Enrolled course IDs:', enrolledIds);

    // 코스 카드에 배지 표시
    document.querySelectorAll('.course-card').forEach(card => {
      const courseId = parseInt(card.dataset.courseId);
      console.log('Checking course card:', courseId, 'enrolled:', enrolledIds.includes(courseId));
      if (enrolledIds.includes(courseId)) {
        const badge = card.querySelector('.enrolled-badge');
        const bestsellerBadge = card.querySelector('.bestseller-badge');
        const newBadge = card.querySelector('.new-badge');
        if (badge) {
          badge.classList.remove('hidden');
          // BEST/NEW 배지 숨기기 (수강중 배지와 겹치지 않도록)
          if (bestsellerBadge) bestsellerBadge.classList.add('hidden');
          if (newBadge) newBadge.classList.add('hidden');
        }
      }
    });
  } catch (e) {
    console.log('Failed to load enrollments:', e);
  }
}

// Search handling
document.addEventListener('DOMContentLoaded', () => {
  updateAuthUI();
  updateEnrolledBadges();
  // Clear search inputs (prevent Chrome autofill)
  const si = document.getElementById('searchInput');
  const sim = document.getElementById('searchInputMobile');
  if (si) si.value = '';
  if (sim) sim.value = '';
  const searchHandler = (e) => { if (e.key === 'Enter') { window.location.href = '/categories?search=' + encodeURIComponent(e.target.value); } };
  si?.addEventListener('keydown', searchHandler);
  sim?.addEventListener('keydown', searchHandler);
});
</script>`

// ==================== Main Page ====================
app.get('/', async (c) => {
  // 모든 수업이 종료된 라이브 코스를 자동으로 completed 처리
  try {
    const cutoff = new Date(Date.now() - 3 * 3600000).toISOString()
    await c.env.DB.prepare(`
      UPDATE classes SET status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'active' AND class_type = 'live'
      AND (SELECT COUNT(*) FROM class_lessons WHERE class_id = classes.id) > 0
      AND NOT EXISTS (
        SELECT 1 FROM class_lessons WHERE class_id = classes.id
        AND scheduled_at > ?
      )
    `).bind(cutoff).run()
  } catch (e) { /* 자동 완료 실패해도 메인 페이지는 정상 로드 */ }

  const [categories, featured, newClasses, liveClasses, specialClasses, requestClasses] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM categories ORDER BY sort_order'),
    c.env.DB.prepare(`
      SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id
      WHERE c.status = 'active' AND c.is_bestseller = 1 ORDER BY c.homepage_sort_order ASC, c.rating DESC LIMIT 8
    `),
    c.env.DB.prepare(`
      SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id
      WHERE c.status = 'active' AND c.is_new = 1 ORDER BY c.homepage_sort_order ASC, c.created_at DESC LIMIT 8
    `),
    c.env.DB.prepare(`
      SELECT cl.id as lesson_id, cl.lesson_title, cl.scheduled_at, cl.duration_minutes, cl.classin_class_id, cl.status as lesson_status,
             c.id as class_id, c.title as class_title, c.slug, c.thumbnail,
             i.display_name as instructor_name, i.profile_image as instructor_image
      FROM class_lessons cl
      JOIN classes c ON cl.class_id = c.id
      JOIN instructors i ON c.instructor_id = i.id
      WHERE c.status = 'active'
        AND cl.scheduled_at > datetime('now', '-1 hour')
        AND cl.scheduled_at < datetime('now', '+14 days')
        AND cl.lesson_type IS NOT 'recorded'
      ORDER BY cl.scheduled_at ASC LIMIT 8
    `),
    c.env.DB.prepare(`
      SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id
      WHERE c.status = 'active' AND c.is_featured_special = 1 ORDER BY c.homepage_sort_order ASC, c.rating DESC LIMIT 8
    `),
    c.env.DB.prepare(`
      SELECT c.*, i.display_name as instructor_name, i.profile_image as instructor_image, i.verified as instructor_verified, cat.name as category_name
      FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id
      WHERE c.status = 'active' AND c.id IN (SELECT created_class_id FROM class_request_applications WHERE status = 'approved' AND created_class_id IS NOT NULL)
      ORDER BY c.created_at DESC LIMIT 8
    `)
  ])

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
          <span class="text-sm font-medium">실시간 라이브 양방향 코스</span>
        </div>
        <h1 class="text-3xl md:text-5xl font-extrabold leading-tight mb-4">
          당신의 성장을 위한<br>
          <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 to-pink-400">라이브 양방향 코스</span>가 시작됩니다
        </h1>
        <p class="text-gray-300 text-base md:text-lg mb-8 leading-relaxed">
          검증된 전문 강사의 실시간 양방향 강의으로 배우고,<br>
          직접 질문하고 소통하며 빠르게 성장하세요.
        </p>
        <div class="flex flex-wrap gap-3">
          <a href="/categories" class="px-6 py-3 bg-primary-500 hover:bg-primary-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-primary-500/30">
            <i class="fas fa-play mr-2"></i>코스 둘러보기
          </a>
          <a href="/class-requests" class="px-6 py-3 bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white font-medium rounded-xl transition-all border border-white/20">
            <i class="fas fa-hand-paper mr-2 text-yellow-400"></i>수업 요청하기
          </a>
        </div>
        <div class="flex items-center gap-6 mt-8">
          <div class="text-center"><p class="text-2xl font-bold">6,200+</p><p class="text-xs text-gray-400">전체 코스</p></div>
          <div class="w-px h-8 bg-white/20"></div>
          <div class="text-center"><p class="text-2xl font-bold">120K+</p><p class="text-xs text-gray-400">수강생</p></div>
          <div class="w-px h-8 bg-white/20"></div>
          <div class="text-center"><p class="text-2xl font-bold">4.8</p><p class="text-xs text-gray-400">평균 평점</p></div>
        </div>
      </div>
      <div class="hidden md:grid grid-cols-2 gap-3">
        <div class="space-y-3">
          <img src="/static/instructors/park-sw.jpg" class="w-full rounded-2xl shadow-2xl object-cover" alt="박서욱 선생님">
          <img src="/static/instructors/cho-wj.jpg" class="w-full rounded-2xl shadow-2xl object-cover" alt="조우제 선생님">
        </div>
        <div class="space-y-3 mt-6">
          <img src="/static/instructors/lee-jh.jpg" class="w-full rounded-2xl shadow-2xl object-cover" alt="이지후 선생님">
          <img src="/static/instructors/park-jy.jpg" class="w-full rounded-2xl shadow-2xl object-cover" alt="박지영 선생님">
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

<!-- 정율 선생님들 특강 코스 -->
${specialClasses.results.length > 0 ? `
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl md:text-2xl font-bold text-dark-900"><i class="fas fa-star text-yellow-500 mr-2"></i>정율 선생님들 특강</h2>
      <p class="text-sm text-gray-500 mt-1">정률 선생님들이 직접 진행하는 특별 강의</p>
    </div>
  </div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
    ${specialClasses.results.map((cls: any) => `<div>${classCardTemplate(cls)}</div>`).join('')}
  </div>
</section>
` : ''}

<!-- Featured / Bestseller Classes -->
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl md:text-2xl font-bold text-dark-900"><i class="fas fa-fire text-primary-500 mr-2"></i>베스트 코스</h2>
      <p class="text-sm text-gray-500 mt-1">가장 많은 수강생이 선택한 인기 코스</p>
    </div>
    <a href="/categories?sort=popular" class="text-sm text-primary-500 font-medium hover:underline">더보기 <i class="fas fa-chevron-right text-xs ml-0.5"></i></a>
  </div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4" id="featuredGrid">
    ${featured.results.map((cls: any) => `<div>${classCardTemplate(cls)}</div>`).join('')}
  </div>
</section>

<!-- 수업 요청 코스 (매칭 완료) -->
${requestClasses.results.length > 0 ? `
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl md:text-2xl font-bold text-dark-900"><i class="fas fa-handshake text-green-500 mr-2"></i>수업 요청 코스</h2>
      <p class="text-sm text-gray-500 mt-1">학생들의 요청으로 탄생한 맞춤 코스</p>
    </div>
    <a href="/class-requests" class="text-sm text-primary-500 font-medium hover:underline">수업 요청하기 <i class="fas fa-chevron-right text-xs ml-0.5"></i></a>
  </div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
    ${requestClasses.results.map((cls: any) => `<div>${classCardTemplate(cls)}</div>`).join('')}
  </div>
</section>
` : ''}

<!-- New Classes -->
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl md:text-2xl font-bold text-dark-900"><i class="fas fa-sparkles text-blue-500 mr-2"></i>신규 코스</h2>
      <p class="text-sm text-gray-500 mt-1">새롭게 오픈한 코스를 만나보세요</p>
    </div>
    <a href="/categories?sort=newest" class="text-sm text-primary-500 font-medium hover:underline">더보기 <i class="fas fa-chevron-right text-xs ml-0.5"></i></a>
  </div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
    ${newClasses.results.map((cls: any) => `<div>${classCardTemplate(cls)}</div>`).join('')}
  </div>
</section>

<!-- 예정된 라이브 수업 (수업 기반) -->
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="bg-gradient-to-r from-dark-900 to-dark-800 rounded-3xl p-6 md:p-10">
    <div class="flex items-center justify-between mb-6">
      <div>
        <div class="flex items-center gap-2 mb-2">
          <span class="w-2 h-2 bg-red-500 rounded-full badge-live"></span>
          <span class="text-sm font-medium text-red-400">LIVE</span>
        </div>
        <h2 class="text-xl md:text-2xl font-bold text-white">다가오는 라이브 수업</h2>
        <p class="text-sm text-gray-400 mt-1">2주 이내 예정된 수업을 확인하세요</p>
      </div>
      <a href="/categories?type=live" class="text-sm text-white/70 hover:text-white font-medium transition">전체 일정 보기 <i class="fas fa-chevron-right text-xs ml-0.5"></i></a>
    </div>
    ${liveClasses.results.length > 0 ? `
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      ${liveClasses.results.slice(0, 4).map((lesson: any) => {
        const start = new Date(lesson.scheduled_at)
        const now = new Date()
        const end = new Date(start.getTime() + (lesson.duration_minutes || 60) * 60000)
        const isLive = start <= now && now < end
        const dateStr = start.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' })
        const timeStr = start.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })
        return `
        <a href="/class/${lesson.slug}" class="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-4 hover:bg-white/10 transition-all block">
          <div class="flex gap-3 mb-3">
            <img src="${lesson.thumbnail || ''}" class="w-16 h-16 rounded-xl object-cover bg-white/10 flex-shrink-0">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold text-white line-clamp-1">${lesson.class_title}</p>
              <p class="text-xs text-white/60 mt-0.5">${lesson.lesson_title}</p>
              <p class="text-xs text-gray-400 mt-1">${lesson.instructor_name}</p>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <div class="text-xs text-gray-400">
              <i class="far fa-calendar-alt mr-1"></i>${dateStr} ${timeStr}
            </div>
            ${isLive
              ? '<span class="px-2 py-0.5 bg-red-500 text-white text-[10px] font-bold rounded-md animate-pulse">LIVE</span>'
              : `<span class="text-xs text-gray-500">${lesson.duration_minutes}분</span>`}
          </div>
        </a>`
      }).join('')}
    </div>
    ${liveClasses.results.length > 4 ? `
    <div class="text-center mt-6">
      <a href="/categories?type=live" class="inline-flex items-center gap-2 px-6 py-2.5 bg-white/10 hover:bg-white/20 text-white text-sm font-medium rounded-xl transition border border-white/20">
        <i class="fas fa-calendar-alt"></i>전체 ${liveClasses.results.length}개 수업 보기
      </a>
    </div>` : ''}
    ` : `
    <div class="text-center py-8">
      <p class="text-gray-400 text-sm">2주 이내 예정된 수업이 없습니다</p>
      <a href="/class-requests" class="inline-flex items-center gap-2 mt-3 px-4 py-2 bg-white/10 text-white text-sm rounded-lg hover:bg-white/20 transition">
        <i class="fas fa-hand-paper"></i>수업 요청하기
      </a>
    </div>
    `}
  </div>
</section>

${footerHTML}
${modalsHTML}
${globalScripts}
</body></html>`
  return c.html(applyBranding(html, c.env))
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
      <option value="newest">최신순</option>
      <option value="popular">인기순</option>
      <option value="rating">평점순</option>
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

  document.getElementById('resultCount').textContent = (currentOffset + classes.length) + '개의 코스';
  document.getElementById('loadMoreArea').classList.toggle('hidden', classes.length < PAGE_SIZE);

  // 수강중 배지 업데이트
  updateEnrolledBadges();
  
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
  const sort = urlParams.get('sort') || 'newest';
  document.getElementById('sortSelect').value = sort;
  if (cat) filterByCategory(cat);
  else loadClasses(false);
});
</script>
</body></html>`
  return c.html(applyBranding(html, c.env))
})

// ==================== 수업 요청 게시판 페이지 ====================
app.get('/class-requests', async (c) => {
  const html = `${headHTML}
${navHTML}
<main class="max-w-4xl mx-auto px-4 py-8">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900">수업 요청 게시판</h1>
      <p class="text-gray-500 mt-1">이런 수업이 있었으면 좋겠다고 요청해보세요!</p>
    </div>
    <button onclick="createRequest()" class="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium">수업 요청하기</button>
  </div>

  <div class="flex gap-2 mb-6">
    <button onclick="filterRequests('open')" id="filterOpen" class="px-3 py-1.5 rounded-full text-sm font-medium bg-primary-100 text-primary-700">모집중</button>
    <button onclick="filterRequests('matching')" id="filterMatching" class="px-3 py-1.5 rounded-full text-sm font-medium bg-gray-100 text-gray-600">매칭중</button>
    <button onclick="filterRequests('matched')" id="filterMatched" class="px-3 py-1.5 rounded-full text-sm font-medium bg-gray-100 text-gray-600">매칭완료</button>
  </div>

  <div id="requestList" class="space-y-4">
    <div class="text-center py-12 text-gray-400">불러오는 중...</div>
  </div>
</main>

<script>
let currentFilter = 'open';

async function loadRequests(status) {
  const res = await fetch('/api/class-requests?status=' + status);
  const data = await res.json();
  const list = document.getElementById('requestList');

  if (!data.requests || data.requests.length === 0) {
    list.innerHTML = '<div class="text-center py-12 text-gray-400">아직 요청이 없습니다.</div>';
    return;
  }

  list.innerHTML = data.requests.map(r => {
    const statusColors = { open: 'bg-green-100 text-green-700', matching: 'bg-yellow-100 text-yellow-700', matched: 'bg-blue-100 text-blue-700', closed: 'bg-gray-100 text-gray-500' };
    const statusLabels = { open: '모집중', matching: '매칭중', matched: '매칭완료', closed: '마감' };
    const budget = r.budget_min || r.budget_max ? (r.budget_min ? Number(r.budget_min).toLocaleString() + '원' : '') + (r.budget_min && r.budget_max ? ' ~ ' : '') + (r.budget_max ? Number(r.budget_max).toLocaleString() + '원' : '') : '';
    return '<a href="/class-requests/' + r.id + '" class="block bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition">' +
      '<div class="flex items-start justify-between">' +
        '<div class="flex-1">' +
          '<div class="flex items-center gap-2 mb-2">' +
            '<span class="px-2 py-0.5 rounded text-xs font-medium ' + (statusColors[r.status] || '') + '">' + (statusLabels[r.status] || r.status) + '</span>' +
            (r.category_name ? '<span class="text-xs text-gray-400">' + r.category_name + '</span>' : '') +
          '</div>' +
          '<h3 class="font-semibold text-gray-900 mb-1">' + r.title + '</h3>' +
          '<p class="text-sm text-gray-500 line-clamp-2">' + r.description + '</p>' +
          '<div class="flex items-center gap-4 mt-3 text-xs text-gray-400">' +
            '<span>' + r.author_name + '</span>' +
            '<span>관심 ' + (r.interest_count || 0) + '</span>' +
            '<span>지원 ' + (r.application_count || 0) + '</span>' +
            (budget ? '<span>' + budget + '</span>' : '') +
            '<span>' + new Date(r.created_at).toLocaleDateString('ko-KR') + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</a>';
  }).join('');
}

function filterRequests(status) {
  currentFilter = status;
  document.querySelectorAll('[id^="filter"]').forEach(b => {
    b.className = 'px-3 py-1.5 rounded-full text-sm font-medium ' + (b.id === 'filter' + status.charAt(0).toUpperCase() + status.slice(1) ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-600');
  });
  loadRequests(status);
}

function createRequest() {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (!user) { if (typeof openAuthModal === 'function') openAuthModal('login'); else alert('로그인이 필요합니다.'); return; }
  window.location.href = '/class-requests/new';
}

loadRequests('open');
</script>
${globalScripts}
${footerHTML}
</body></html>`
  return c.html(applyBranding(html, c.env))
})

// 수업 요청 작성 페이지
app.get('/class-requests/new', async (c) => {
  const { results: categories } = await c.env.DB.prepare('SELECT id, name FROM categories ORDER BY name').all()
  const catOptions = (categories as any[]).map(cat => `<option value="${cat.id}">${cat.name}</option>`).join('')

  const html = `${headHTML}
${navHTML}
<main class="max-w-2xl mx-auto px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900 mb-6">수업 요청하기</h1>
  <form id="requestForm" class="space-y-5">
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">수업 제목 <span class="text-red-500">*</span></label>
      <input type="text" id="reqTitle" required class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="예: 파이썬 기초부터 배우고 싶어요">
    </div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">상세 설명 <span class="text-red-500">*</span></label>
      <textarea id="reqDesc" required rows="4" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="어떤 내용을 배우고 싶은지 자세히 적어주세요"></textarea>
    </div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
      <select id="reqCategory" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
        <option value="">선택 안함</option>
        ${catOptions}
      </select>
    </div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">희망 요일</label>
      <div class="flex flex-wrap gap-2 mb-3" id="reqDayBtns">
        ${['평일','주말','월','화','수','목','금','토','일'].map(d =>
          `<button type="button" onclick="toggleDayBtn(this)" data-day="${d}" class="px-3 py-1.5 rounded-full border border-gray-300 text-sm hover:border-primary-400 hover:bg-primary-50 transition">${d}</button>`
        ).join('')}
      </div>
      <label class="block text-sm font-medium text-gray-700 mb-1">희망 시간대 <span class="text-xs text-gray-400">(2개 이상 선택을 권장합니다)</span></label>
      <div class="flex flex-wrap gap-2" id="reqTimeBtns">
        ${['오전 (9~12시)','오후 (1~5시)','저녁 (6~8시)','밤 (9~11시)'].map(t =>
          `<button type="button" onclick="toggleDayBtn(this)" data-time="${t}" class="px-3 py-1.5 rounded-full border border-gray-300 text-sm hover:border-primary-400 hover:bg-primary-50 transition">${t}</button>`
        ).join('')}
        <button type="button" onclick="toggleOther(this)" data-time="기타" class="px-3 py-1.5 rounded-full border border-gray-300 text-sm hover:border-primary-400 hover:bg-primary-50 transition">기타</button>
      </div>
      <input type="text" id="reqScheduleOther" class="hidden w-full mt-2 px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm" placeholder="예: 새벽 5시~7시" oninput="updateScheduleValue()">
      <input type="hidden" id="reqSchedule">
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">최소 예산 (원)</label>
        <input type="number" id="reqBudgetMin" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="예: 100000">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">최대 예산 (원)</label>
        <input type="number" id="reqBudgetMax" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="예: 300000">
      </div>
    </div>
    <button type="submit" class="w-full py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium">요청 등록하기</button>
  </form>
</main>

<script>
function toggleDayBtn(btn) {
  btn.classList.toggle('bg-primary-100');
  btn.classList.toggle('border-primary-500');
  btn.classList.toggle('text-primary-700');
  updateScheduleValue();
}
function toggleOther(btn) {
  btn.classList.toggle('bg-primary-100');
  btn.classList.toggle('border-primary-500');
  btn.classList.toggle('text-primary-700');
  var otherInput = document.getElementById('reqScheduleOther');
  if (btn.classList.contains('bg-primary-100')) {
    otherInput.classList.remove('hidden');
    otherInput.focus();
  } else {
    otherInput.classList.add('hidden');
    otherInput.value = '';
  }
  updateScheduleValue();
}
function updateScheduleValue() {
  var days = Array.from(document.querySelectorAll('#reqDayBtns button.bg-primary-100')).map(function(b){return b.dataset.day});
  var times = Array.from(document.querySelectorAll('#reqTimeBtns button.bg-primary-100:not([data-time="기타"])')).map(function(b){return b.dataset.time});
  var other = document.getElementById('reqScheduleOther').value.trim();
  if (other) times.push(other);
  var parts = [];
  if (days.length) parts.push(days.join(', '));
  if (times.length) parts.push(times.join(', '));
  document.getElementById('reqSchedule').value = parts.join(' / ') || '';
}
document.getElementById('requestForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const token = localStorage.getItem('classin_token');
  if (!token) { alert('로그인이 필요합니다.'); return; }

  const body = {
    title: document.getElementById('reqTitle').value,
    description: document.getElementById('reqDesc').value,
    categoryId: document.getElementById('reqCategory').value || null,
    preferredSchedule: document.getElementById('reqSchedule').value || null,
    budgetMin: document.getElementById('reqBudgetMin').value ? parseInt(document.getElementById('reqBudgetMin').value) : null,
    budgetMax: document.getElementById('reqBudgetMax').value ? parseInt(document.getElementById('reqBudgetMax').value) : null
  };

  const res = await fetch('/api/class-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.success) {
    alert('수업 요청이 등록되었습니다!');
    window.location.href = '/class-requests/' + data.id;
  } else {
    alert(data.error || '등록에 실패했습니다.');
  }
});
</script>
${globalScripts}
${footerHTML}
</body></html>`
  return c.html(applyBranding(html, c.env))
})

// 수업 요청 상세 페이지
app.get('/class-requests/:id', async (c) => {
  const id = parseInt(c.req.param('id'))

  const request = await c.env.DB.prepare(`
    SELECT cr.*, u.name as author_name, cat.name as category_name
    FROM class_requests cr
    LEFT JOIN users u ON cr.user_id = u.id
    LEFT JOIN categories cat ON cr.category_id = cat.id
    WHERE cr.id = ?
  `).bind(id).first() as any

  if (!request) return c.html('<h1>요청을 찾을 수 없습니다</h1>', 404)

  const [appResult, catResult] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT id, applicant_name, bio, proposed_title, proposed_price, status, created_at
    FROM class_request_applications WHERE request_id = ? AND status != 'draft'
    ORDER BY created_at ASC`).bind(id),
    c.env.DB.prepare('SELECT id, name FROM categories ORDER BY name')
  ])
  const applications = appResult.results as any[]
  const categories = catResult.results as any[]
  const catOptions = categories.map((cat: any) => `<option value="${cat.id}"${cat.id === request.category_id ? ' selected' : ''}>${cat.name}</option>`).join('')

  const statusColors: Record<string,string> = { open: 'bg-green-100 text-green-700', matching: 'bg-yellow-100 text-yellow-700', matched: 'bg-blue-100 text-blue-700', closed: 'bg-gray-100 text-gray-500' }
  const statusLabels: Record<string,string> = { open: '모집중', matching: '매칭중', matched: '매칭완료', closed: '마감' }
  const budget = request.budget_min || request.budget_max ? `${request.budget_min ? Number(request.budget_min).toLocaleString() + '원' : ''}${request.budget_min && request.budget_max ? ' ~ ' : ''}${request.budget_max ? Number(request.budget_max).toLocaleString() + '원' : ''}` : '미정'

  const applicationsHTML = applications.length > 0
    ? (applications as any[]).map((a: any) => `
      <div class="bg-gray-50 rounded-lg p-4">
        <div class="flex items-center justify-between mb-2">
          <span class="font-medium">${a.applicant_name}</span>
          <span class="text-xs px-2 py-0.5 rounded ${a.status === 'approved' ? 'bg-green-100 text-green-700' : a.status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}">${a.status === 'approved' ? '승인됨' : a.status === 'rejected' ? '거절됨' : '검토중'}</span>
        </div>
        <p class="text-sm text-gray-600 mb-1">${a.bio || ''}</p>
        ${a.proposed_title ? `<p class="text-sm"><strong>제안 수업:</strong> ${a.proposed_title}</p>` : ''}
        ${a.proposed_price ? `<p class="text-sm"><strong>제안 가격:</strong> ${Number(a.proposed_price).toLocaleString()}원</p>` : ''}
      </div>`).join('')
    : '<p class="text-gray-400 text-sm">아직 지원자가 없습니다.</p>'

  const html = `${headHTML}
${navHTML}
<main class="max-w-3xl mx-auto px-4 py-8">
  <a href="/class-requests" class="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">&larr; 게시판으로</a>

  <div id="viewSection" class="bg-white rounded-xl border border-gray-200 p-6 mb-6">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <span class="px-2 py-0.5 rounded text-xs font-medium ${statusColors[request.status] || ''}">${statusLabels[request.status] || request.status}</span>
        ${request.category_name ? `<span class="text-xs text-gray-400">${request.category_name}</span>` : ''}
      </div>
      ${request.status === 'open' ? `<button id="editBtn" onclick="showEditForm()" class="hidden text-sm text-gray-400 hover:text-primary-600 transition"><i class="fas fa-pen mr-1"></i>수정</button>` : ''}
    </div>
    <h1 class="text-xl font-bold text-gray-900 mb-3">${request.title}</h1>
    <p class="text-gray-600 whitespace-pre-line mb-4">${request.description}</p>

    <div class="grid grid-cols-2 gap-4 text-sm">
      <div><span class="text-gray-400">요청자:</span> <span class="font-medium">${request.author_name}</span></div>
      <div><span class="text-gray-400">예산:</span> <span class="font-medium">${budget}</span></div>
      ${request.preferred_schedule ? `<div><span class="text-gray-400">희망 시간:</span> <span class="font-medium">${request.preferred_schedule}</span></div>` : ''}
      <div><span class="text-gray-400">관심:</span> <span class="font-medium" id="interestCount">${request.interest_count || 0}</span>명</div>
    </div>

    <div class="flex gap-3 mt-6">
      <button id="interestBtn" onclick="toggleInterest(${request.id})" class="flex-1 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition text-sm font-medium">
        ❤️ 나도 듣고 싶어요
      </button>
      ${request.status === 'open' ? `<button id="applyBtn" onclick="startApply(${request.id})" class="flex-1 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition text-sm font-medium">🎓 가르쳐보겠습니다</button>` : ''}
    </div>
  </div>

  <!-- 수정 폼 (본인에게만 표시) -->
  <div id="editSection" class="hidden bg-white rounded-xl border border-gray-200 p-6 mb-6">
    <div class="flex items-center justify-between mb-4">
      <h2 class="font-bold text-gray-900">요청 수정</h2>
      <button onclick="hideEditForm()" class="text-sm text-gray-400 hover:text-gray-600"><i class="fas fa-times mr-1"></i>취소</button>
    </div>
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">수업 제목</label>
        <input type="text" id="editReqTitle" value="${(request.title || '').replace(/"/g, '&quot;')}" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">상세 설명</label>
        <textarea id="editReqDesc" rows="4" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500">${request.description || ''}</textarea>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
        <select id="editReqCategory" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
          <option value="">선택 안함</option>
          ${catOptions}
        </select>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">희망 요일</label>
        <div class="flex flex-wrap gap-2 mb-3" id="editDayBtns">
          ${['평일','주말','월','화','수','목','금','토','일'].map(d =>
            `<button type="button" onclick="toggleEditDay(this)" data-day="${d}" class="edit-day-btn px-3 py-1.5 rounded-full border border-gray-300 text-sm hover:border-primary-400 hover:bg-primary-50 transition">${d}</button>`
          ).join('')}
        </div>
        <label class="block text-sm font-medium text-gray-700 mb-1">희망 시간대 <span class="text-xs text-gray-400">(2개 이상 선택을 권장합니다)</span></label>
        <div class="flex flex-wrap gap-2" id="editTimeBtns">
          ${['오전 (9~12시)','오후 (1~5시)','저녁 (6~8시)','밤 (9~11시)'].map(t =>
            `<button type="button" onclick="toggleEditDay(this)" data-time="${t}" class="edit-time-btn px-3 py-1.5 rounded-full border border-gray-300 text-sm hover:border-primary-400 hover:bg-primary-50 transition">${t}</button>`
          ).join('')}
          <button type="button" onclick="toggleEditOther(this)" data-time="기타" class="edit-time-btn px-3 py-1.5 rounded-full border border-gray-300 text-sm hover:border-primary-400 hover:bg-primary-50 transition">기타</button>
        </div>
        <input type="text" id="editScheduleOther" class="hidden w-full mt-2 px-4 py-2.5 border border-gray-300 rounded-lg text-sm" placeholder="예: 새벽 5시~7시">
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">최소 예산 (원)</label>
          <input type="number" id="editReqBudgetMin" value="${request.budget_min || ''}" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">최대 예산 (원)</label>
          <input type="number" id="editReqBudgetMax" value="${request.budget_max || ''}" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
        </div>
      </div>
      <button onclick="saveRequestEdit()" class="w-full py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium"><i class="fas fa-save mr-1"></i>수정 저장</button>
    </div>
  </div>

  <div class="bg-white rounded-xl border border-gray-200 p-6">
    <h2 class="font-semibold text-gray-900 mb-4">지원자 (${applications.length}명)</h2>
    <div class="space-y-3">${applicationsHTML}</div>
  </div>
</main>

<script>
const REQUEST_ID = ${request.id};
const REQUEST_USER_ID = ${request.user_id};
const SAVED_SCHEDULE = '${(request.preferred_schedule || '').replace(/'/g, "\\'")}';

// 본인 요청이면 지원 버튼 숨기고 수정 버튼 표시
(function() {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (user && user.id === REQUEST_USER_ID) {
    const btn = document.getElementById('applyBtn');
    if (btn) btn.style.display = 'none';
    const editBtn = document.getElementById('editBtn');
    if (editBtn) editBtn.classList.remove('hidden');
  }
})();

function showEditForm() {
  document.getElementById('viewSection').classList.add('hidden');
  document.getElementById('editSection').classList.remove('hidden');
  // 기존 희망시간 복원
  if (SAVED_SCHEDULE) {
    var parts = SAVED_SCHEDULE.split(' / ');
    var dayPart = parts[0] || '';
    var timePart = parts.slice(1).join(' / ') || '';
    document.querySelectorAll('#editDayBtns button').forEach(function(btn) {
      if (dayPart.indexOf(btn.dataset.day) !== -1) {
        btn.classList.add('bg-primary-100','border-primary-500','text-primary-700');
      }
    });
    document.querySelectorAll('#editTimeBtns button:not([data-time="기타"])').forEach(function(btn) {
      if (timePart.indexOf(btn.dataset.time) !== -1) {
        btn.classList.add('bg-primary-100','border-primary-500','text-primary-700');
      }
    });
  }
}
function hideEditForm() {
  document.getElementById('editSection').classList.add('hidden');
  document.getElementById('viewSection').classList.remove('hidden');
}
function toggleEditDay(btn) {
  btn.classList.toggle('bg-primary-100');
  btn.classList.toggle('border-primary-500');
  btn.classList.toggle('text-primary-700');
}
function toggleEditOther(btn) {
  btn.classList.toggle('bg-primary-100');
  btn.classList.toggle('border-primary-500');
  btn.classList.toggle('text-primary-700');
  var otherInput = document.getElementById('editScheduleOther');
  if (btn.classList.contains('bg-primary-100')) { otherInput.classList.remove('hidden'); otherInput.focus(); }
  else { otherInput.classList.add('hidden'); otherInput.value = ''; }
}
function getEditSchedule() {
  var days = Array.from(document.querySelectorAll('#editDayBtns button.bg-primary-100')).map(function(b){return b.dataset.day});
  var times = Array.from(document.querySelectorAll('#editTimeBtns button.bg-primary-100:not([data-time="기타"])')).map(function(b){return b.dataset.time});
  var other = document.getElementById('editScheduleOther').value.trim();
  if (other) times.push(other);
  var p = [];
  if (days.length) p.push(days.join(', '));
  if (times.length) p.push(times.join(', '));
  return p.join(' / ') || null;
}
async function saveRequestEdit() {
  var token = localStorage.getItem('classin_token');
  if (!token) { alert('로그인이 필요합니다.'); return; }
  var body = {
    title: document.getElementById('editReqTitle').value,
    description: document.getElementById('editReqDesc').value,
    categoryId: document.getElementById('editReqCategory').value || null,
    preferredSchedule: getEditSchedule(),
    budgetMin: document.getElementById('editReqBudgetMin').value ? parseInt(document.getElementById('editReqBudgetMin').value) : null,
    budgetMax: document.getElementById('editReqBudgetMax').value ? parseInt(document.getElementById('editReqBudgetMax').value) : null
  };
  var res = await fetch('/api/class-requests/' + REQUEST_ID, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  });
  var data = await res.json();
  if (data.success) { alert('수정되었습니다!'); location.reload(); }
  else alert(data.error || '수정 실패');
}

async function toggleInterest(requestId) {
  const token = localStorage.getItem('classin_token');
  if (!token) { if (typeof openAuthModal === 'function') openAuthModal('login'); else alert('로그인이 필요합니다.'); return; }

  const res = await fetch('/api/class-requests/' + requestId + '/interest', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await res.json();
  const count = document.getElementById('interestCount');
  const current = parseInt(count.textContent);
  count.textContent = data.interested ? current + 1 : Math.max(0, current - 1);
  document.getElementById('interestBtn').textContent = data.interested ? '💔 관심 취소' : '❤️ 나도 듣고 싶어요';
}

function startApply(requestId) {
  const token = localStorage.getItem('classin_token');
  if (!token) { if (typeof openAuthModal === 'function') openAuthModal('login'); else alert('로그인이 필요합니다.'); return; }
  window.location.href = '/class-requests/' + requestId + '/apply';
}
</script>
${globalScripts}
${footerHTML}
</body></html>`
  return c.html(applyBranding(html, c.env))
})

// ==================== 강사 지원 에이전트 채팅 페이지 ====================
app.get('/class-requests/:id/apply', async (c) => {
  const requestId = parseInt(c.req.param('id'))
  const request = await c.env.DB.prepare('SELECT id, title, description, preferred_schedule, budget_min, budget_max FROM class_requests WHERE id = ?').bind(requestId).first() as any
  if (!request) return c.html('<h1>요청을 찾을 수 없습니다</h1>', 404)

  const budgetText = request.budget_min || request.budget_max ? `${request.budget_min ? Number(request.budget_min).toLocaleString() + '원' : ''}${request.budget_min && request.budget_max ? ' ~ ' : ''}${request.budget_max ? Number(request.budget_max).toLocaleString() + '원' : ''}` : ''

  const html = `${headHTML}
${navHTML}
<main class="max-w-2xl mx-auto px-4 py-8">
  <a href="/class-requests/${requestId}" class="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">&larr; 요청으로 돌아가기</a>

  <div class="bg-primary-50 rounded-lg p-4 mb-6">
    <p class="text-sm text-primary-600 font-medium">요청: ${request.title}</p>
    <p class="text-xs text-primary-500 mt-1">${request.description.substring(0, 100)}${request.description.length > 100 ? '...' : ''}</p>
    ${request.preferred_schedule || budgetText ? `<div class="flex flex-wrap gap-3 mt-2 text-xs text-primary-500">
      ${request.preferred_schedule ? `<span><i class="far fa-clock mr-1"></i>희망: ${request.preferred_schedule}</span>` : ''}
      ${budgetText ? `<span><i class="far fa-money-bill-alt mr-1"></i>예산: ${budgetText}</span>` : ''}
    </div>` : ''}
  </div>

  <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
    <div class="bg-gray-50 px-5 py-3 border-b">
      <h2 class="font-semibold text-gray-900">수업 설계 도우미</h2>
      <p class="text-xs text-gray-500">단계별로 수업 정보를 입력해주세요</p>
    </div>

    <div id="chatMessages" class="p-5 space-y-4 max-h-96 overflow-y-auto" style="min-height:200px;">
      <div class="text-center py-8 text-gray-400">로딩 중...</div>
    </div>

    <div id="chatInputArea" class="border-t p-4">
      <input type="hidden" id="chatInput" value="">
      <div id="stepUI" class="space-y-3"></div>
      <div class="flex gap-2 mt-2">
        <button onclick="sendPrev()" class="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100">← 이전 단계</button>
        <span id="stepIndicator" class="text-xs text-gray-400 ml-auto py-1">Step 0/6</span>
      </div>
    </div>
  </div>
</main>

<script>
const REQUEST_ID = ${requestId};
const REQUEST_TITLE = ${JSON.stringify(request.title)};
const PREFERRED_SCHEDULE = ${JSON.stringify(request.preferred_schedule || '')};
const BUDGET_MIN = ${request.budget_min || 'null'};
const BUDGET_MAX = ${request.budget_max || 'null'};
let applicationId = null;
let conversationStep = 0;
var selectedDays = [];

function addMessage(text, isAgent) {
  var c = document.getElementById('chatMessages');
  var d = document.createElement('div');
  d.className = isAgent ? 'flex items-start gap-3' : 'flex items-start gap-3 justify-end';
  d.innerHTML = isAgent
    ? '<div class="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0"><span class="text-sm">🤖</span></div><div class="bg-gray-100 rounded-xl rounded-tl-sm px-4 py-3 max-w-xs"><p class="text-sm text-gray-800 whitespace-pre-line">' + text + '</p></div>'
    : '<div class="bg-primary-600 text-white rounded-xl rounded-tr-sm px-4 py-3 max-w-xs"><p class="text-sm whitespace-pre-line">' + text + '</p></div>';
  c.appendChild(d); c.scrollTop = c.scrollHeight;
}

function renderStepUI(step) {
  var ui = document.getElementById('stepUI');
  document.getElementById('stepIndicator').textContent = 'Step ' + Math.min(step, 6) + '/6';
  conversationStep = step;

  if (step === 0) {
    ui.innerHTML = '<textarea id="bioInput" rows="3" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="간단한 자기소개와 관련 경력 (최소 10자)"></textarea>' +
      '<button onclick="submitText(document.getElementById(\\x27bioInput\\x27).value)" class="w-full py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium text-sm mt-2">다음</button>';
  } else if (step === 1) {
    var t = REQUEST_TITLE;
    ui.innerHTML = '<div class="grid grid-cols-1 gap-2">' +
      '<button onclick="submitText(this.textContent)" class="text-left px-4 py-3 border border-gray-200 rounded-lg hover:border-primary-400 hover:bg-primary-50 transition text-sm">' + t + ' 마스터 클래스</button>' +
      '<button onclick="submitText(this.textContent)" class="text-left px-4 py-3 border border-gray-200 rounded-lg hover:border-primary-400 hover:bg-primary-50 transition text-sm">' + t + ' 입문 과정</button>' +
      '<button onclick="submitText(this.textContent)" class="text-left px-4 py-3 border border-gray-200 rounded-lg hover:border-primary-400 hover:bg-primary-50 transition text-sm">' + t + ' 실전 워크숍</button>' +
      '<div class="flex gap-2"><input type="text" id="customTitle" class="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm" placeholder="직접 입력...">' +
      '<button onclick="submitText(document.getElementById(\\x27customTitle\\x27).value)" class="px-4 py-2.5 bg-gray-200 rounded-lg text-sm font-medium hover:bg-gray-300">확인</button></div>' +
    '</div>';
  } else if (step === 2) {
    ui.innerHTML = '<textarea id="descInput" rows="3" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="수업에서 무엇을 배울 수 있는지 설명해주세요 (최소 20자)"></textarea>' +
      '<label class="text-xs font-medium text-gray-500 mt-2 mb-1 block">난이도</label>' +
      '<div class="grid grid-cols-4 gap-2">' +
      '<button onclick="pickLevel(this,\\x27초급\\x27)" class="lvl-btn py-2 rounded-lg border border-gray-300 text-sm font-medium hover:border-primary-400">초급</button>' +
      '<button onclick="pickLevel(this,\\x27중급\\x27)" class="lvl-btn py-2 rounded-lg border border-gray-300 text-sm font-medium hover:border-primary-400">중급</button>' +
      '<button onclick="pickLevel(this,\\x27고급\\x27)" class="lvl-btn py-2 rounded-lg border border-gray-300 text-sm font-medium hover:border-primary-400">고급</button>' +
      '<button onclick="pickLevel(this,\\x27전체\\x27)" class="lvl-btn py-2 rounded-lg border border-gray-300 text-sm font-medium hover:border-primary-400 bg-primary-600 text-white border-primary-600">전체</button>' +
      '</div>' +
      '<button onclick="submitStep2()" class="w-full py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium text-sm mt-3">다음</button>';
    window._selectedLevel = '전체';
  } else if (step === 3) {
    ui.innerHTML = '<label class="text-xs font-medium text-gray-500 mb-1 block">총 회차</label>' +
      '<div class="flex gap-2 flex-wrap">' +
      ['4','6','8','10','12'].map(function(n){return '<button onclick="pickCount(this,'+n+')" class="cnt-btn px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:border-primary-400'+(n==='8'?' bg-primary-600 text-white border-primary-600':'')+'">'+n+'회</button>'}).join('') +
      '<input type="number" id="customCount" class="w-16 px-2 py-2 border border-gray-300 rounded-lg text-sm text-center" placeholder="기타" min="1" max="50" onchange="pickCount(null,this.value)">' +
      '</div>' +
      '<label class="text-xs font-medium text-gray-500 mt-3 mb-1 block">회당 시간</label>' +
      '<div class="flex gap-2 flex-wrap">' +
      ['30','45','60','90','120'].map(function(n){return '<button onclick="pickDur(this,'+n+')" class="dur-btn px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:border-primary-400'+(n==='60'?' bg-primary-600 text-white border-primary-600':'')+'">'+n+'분</button>'}).join('') +
      '<input type="number" id="customDur" class="w-20 px-2 py-2 border border-gray-300 rounded-lg text-sm text-center" placeholder="기타(분)" min="10" max="300" onchange="pickDur(null,this.value)">' +
      '</div>' +
      '<button onclick="submitStep3()" class="w-full py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium text-sm mt-3">다음</button>';
    window._count = 8; window._dur = 60;
  } else if (step === 4) {
    selectedDays = [];
    ui.innerHTML = (PREFERRED_SCHEDULE ? '<div class="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-2"><p class="text-xs text-blue-600"><i class="fas fa-info-circle mr-1"></i>요청자 희망: <strong>' + PREFERRED_SCHEDULE + '</strong></p></div>' : '') +
      '<div><label class="text-xs font-medium text-gray-500 mb-1 block">시작일</label>' +
      '<input type="date" id="schedDate" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"></div>' +
      '<div><label class="text-xs font-medium text-gray-500 mb-1 block">요일 선택</label>' +
      '<div class="flex gap-1.5">' +
      [['mon','월'],['tue','화'],['wed','수'],['thu','목'],['fri','금'],['sat','토'],['sun','일']].map(function(d){return '<button type="button" onclick="toggleDay(this,\\x27'+d[0]+'\\x27)" class="day-btn flex-1 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:border-primary-400 transition">'+d[1]+'</button>'}).join('') +
      '</div></div>' +
      '<div><label class="text-xs font-medium text-gray-500 mb-1 block">시간</label>' +
      '<select id="schedTime" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">' +
      '<option value="09:00">오전 9시</option><option value="10:00">오전 10시</option><option value="11:00">오전 11시</option>' +
      '<option value="13:00">오후 1시</option><option value="14:00">오후 2시</option><option value="15:00">오후 3시</option>' +
      '<option value="16:00">오후 4시</option><option value="17:00">오후 5시</option><option value="18:00">저녁 6시</option>' +
      '<option value="19:00">저녁 7시</option><option value="20:00">저녁 8시</option><option value="21:00">밤 9시</option><option value="22:00">밤 10시</option><option value="23:00">밤 11시</option>' +
      '</select></div>' +
      '<button onclick="submitSchedule()" class="w-full py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium text-sm">다음</button>';
    applyPreferredSchedule();
  } else if (step === 5) {
    var budgetHint = '';
    if (BUDGET_MIN || BUDGET_MAX) {
      var bmin = BUDGET_MIN ? Number(BUDGET_MIN).toLocaleString()+'원' : '';
      var bmax = BUDGET_MAX ? Number(BUDGET_MAX).toLocaleString()+'원' : '';
      budgetHint = '<div class="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-2"><p class="text-xs text-blue-600"><i class="fas fa-info-circle mr-1"></i>요청자 예산: <strong>' + bmin + (bmin&&bmax?' ~ ':'') + bmax + '</strong></p></div>';
    }
    ui.innerHTML = budgetHint + '<div class="grid grid-cols-3 gap-2">' +
      ['50,000','100,000','150,000','200,000','300,000','500,000'].map(function(p){return '<button onclick="submitText(\\x27'+p.replace(/,/g,'')+'\\x27);addMessage(\\x27'+p+'원\\x27,false)" class="py-3 rounded-lg border border-gray-200 hover:border-primary-400 hover:bg-primary-50 text-sm font-medium transition">'+p+'원</button>'}).join('') +
      '</div>' +
      '<div class="flex gap-2 mt-2"><input type="number" id="customPrice" class="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm" placeholder="직접 입력 (원)">' +
      '<button onclick="var v=document.getElementById(\\x27customPrice\\x27).value;if(v)submitText(v)" class="px-4 py-2.5 bg-gray-200 rounded-lg text-sm font-medium hover:bg-gray-300">확인</button></div>';
  } else if (step === 6) {
    ui.innerHTML = '<div class="flex gap-3">' +
      '<button onclick="submitText(\\x27네\\x27)" class="flex-1 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium">제출하기</button>' +
      '<button onclick="sendPrev()" class="flex-1 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition font-medium text-gray-600">수정하기</button>' +
      '</div>';
  } else {
    ui.innerHTML = '';
    document.getElementById('chatInputArea').style.display = 'none';
  }
}

async function initChat() {
  var token = localStorage.getItem('classin_token');
  if (!token) { alert('로그인이 필요합니다.'); window.location.href = '/class-requests/' + REQUEST_ID; return; }
  var res = await fetch('/api/class-requests/' + REQUEST_ID + '/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
  });
  var data = await res.json();
  if (data.error) { alert(data.error); window.location.href = '/class-requests/' + REQUEST_ID; return; }
  applicationId = data.applicationId;
  conversationStep = data.conversationStep;
  document.getElementById('chatMessages').innerHTML = '';
  if (data.status === 'submitted') {
    addMessage('지원이 이미 제출되었습니다. 관리자 검토를 기다려주세요.', true);
    document.getElementById('chatInputArea').style.display = 'none'; return;
  }
  if (conversationStep > 0) {
    var appRes = await fetch('/api/applications/' + applicationId, { headers: { Authorization: 'Bearer ' + token } });
    var appData = await appRes.json();
    addMessage(appData.agentMessage || data.agentMessage, true);
  } else { addMessage(data.agentMessage, true); }
  renderStepUI(conversationStep);
}

async function sendAPI(message, bubbleText) {
  if (!applicationId) return;
  if (bubbleText) addMessage(bubbleText, false);
  var token = localStorage.getItem('classin_token');
  var res = await fetch('/api/applications/' + applicationId + '/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ message: message })
  });
  var data = await res.json();
  if (data.isError) { addMessage(data.agentMessage, true); return; }
  if (data.error) { addMessage(data.error, true); return; }
  addMessage(data.agentMessage, true);
  if (data.status === 'submitted') { document.getElementById('chatInputArea').style.display = 'none'; return; }
  renderStepUI(data.conversationStep);
}

function submitText(val) {
  if (!val || !val.trim()) return;
  document.getElementById('chatInput').value = val.trim();
  addMessage(val.trim(), false);
  var token = localStorage.getItem('classin_token');
  fetch('/api/applications/' + applicationId + '/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ message: val.trim() })
  }).then(function(r){return r.json()}).then(function(data){
    if (data.isError) { addMessage(data.agentMessage, true); return; }
    if (data.error) { addMessage(data.error, true); return; }
    addMessage(data.agentMessage, true);
    if (data.status === 'submitted') { document.getElementById('chatInputArea').style.display = 'none'; return; }
    renderStepUI(data.conversationStep);
  });
}

function sendPrev() { sendAPI('이전', '← 이전 단계'); }

// Step 2 helpers
function pickLevel(btn, level) {
  window._selectedLevel = level;
  document.querySelectorAll('.lvl-btn').forEach(function(b){b.classList.remove('bg-primary-600','text-white','border-primary-600');b.classList.add('border-gray-300');});
  if(btn){btn.classList.add('bg-primary-600','text-white','border-primary-600');btn.classList.remove('border-gray-300');}
}
function submitStep2() {
  var desc = document.getElementById('descInput').value.trim();
  if (!desc) { alert('수업 설명을 입력해주세요'); return; }
  submitText(desc + '\\n' + (window._selectedLevel || '전체'));
}

// Step 3 helpers
function pickCount(btn, n) {
  window._count = parseInt(n);
  document.querySelectorAll('.cnt-btn').forEach(function(b){b.classList.remove('bg-primary-600','text-white','border-primary-600');b.classList.add('border-gray-300');});
  if(btn){btn.classList.add('bg-primary-600','text-white','border-primary-600');btn.classList.remove('border-gray-300');}
}
function pickDur(btn, n) {
  window._dur = parseInt(n);
  document.querySelectorAll('.dur-btn').forEach(function(b){b.classList.remove('bg-primary-600','text-white','border-primary-600');b.classList.add('border-gray-300');});
  if(btn){btn.classList.add('bg-primary-600','text-white','border-primary-600');btn.classList.remove('border-gray-300');}
}
function submitStep3() { submitText((window._count||8) + '회 ' + (window._dur||60) + '분'); }

// Step 4: 요청자 희망 시간 자동 적용
function applyPreferredSchedule() {
  if (!PREFERRED_SCHEDULE) return;
  var sched = PREFERRED_SCHEDULE;
  // 요일 매핑
  var dayMap = {'월':'mon','화':'tue','수':'wed','목':'thu','금':'fri','토':'sat','일':'sun'};
  var expandMap = {'평일':['mon','tue','wed','thu','fri'],'주말':['sat','sun']};
  var autoSelect = [];
  Object.keys(expandMap).forEach(function(k){ if(sched.indexOf(k)!==-1) autoSelect=autoSelect.concat(expandMap[k]); });
  Object.keys(dayMap).forEach(function(k){ if(sched.indexOf(k)!==-1 && autoSelect.indexOf(dayMap[k])===-1) autoSelect.push(dayMap[k]); });
  // 중복 제거 후 버튼 클릭
  autoSelect.filter(function(v,i,a){return a.indexOf(v)===i}).forEach(function(day){
    var btns = document.querySelectorAll('.day-btn');
    var dn = {mon:'월',tue:'화',wed:'수',thu:'목',fri:'금',sat:'토',sun:'일'};
    btns.forEach(function(btn){ if(btn.textContent===dn[day]) toggleDay(btn,day); });
  });
  // 시간대 매핑
  var timeMap = {'오전':['09:00','10:00','11:00'],'오후':['13:00','14:00','15:00','16:00','17:00'],'저녁':['18:00','19:00','20:00'],'밤':['21:00','22:00','23:00']};
  var selEl = document.getElementById('schedTime');
  Object.keys(timeMap).forEach(function(k){
    if(sched.indexOf(k)!==-1){ selEl.value=timeMap[k][0]; }
  });
}

function toggleDay(btn, day) {
  var idx = selectedDays.indexOf(day);
  if (idx >= 0) { selectedDays.splice(idx,1); btn.classList.remove('bg-primary-600','text-white','border-primary-600'); btn.classList.add('border-gray-300'); }
  else { selectedDays.push(day); btn.classList.add('bg-primary-600','text-white','border-primary-600'); btn.classList.remove('border-gray-300'); }
}
function submitSchedule() {
  var date = document.getElementById('schedDate').value;
  if (!date) { alert('시작일을 선택해주세요'); return; }
  if (selectedDays.length === 0) { alert('요일을 하나 이상 선택해주세요'); return; }
  var time = document.getElementById('schedTime').value;
  var dn = {mon:'월',tue:'화',wed:'수',thu:'목',fri:'금',sat:'토',sun:'일'};
  var ds = selectedDays.map(function(d){return dn[d]}).join('/');
  sendAPI(date + ', ' + ds + ', ' + time, ds + '요일 ' + time + ' (' + date + ' 시작)');
  selectedDays = [];
}

initChat();
</script>
${globalScripts}
${footerHTML}
</body></html>`
  return c.html(applyBranding(html, c.env))
})

// ==================== Class Detail Page ====================
app.get('/class/:slug', async (c) => {
  const slug = decodeURIComponent(c.req.param('slug'))
  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.id as iid, i.user_id as instructor_user_id, i.display_name as instructor_name, i.profile_image as instructor_image, i.bio as instructor_bio, i.specialty as instructor_specialty, i.total_students as instructor_total_students, i.total_classes as instructor_total_classes, i.rating as instructor_rating, i.verified as instructor_verified, cat.name as category_name, cat.slug as category_slug
    FROM classes c JOIN instructors i ON c.instructor_id = i.id JOIN categories cat ON c.category_id = cat.id WHERE c.slug = ?
  `).bind(slug).first() as any
  
  if (!cls) return c.html('<h1>Class not found</h1>', 404)

  const { results: lessons } = await c.env.DB.prepare('SELECT * FROM lessons WHERE class_id = ? ORDER BY sort_order').bind(cls.id).all()
  const { results: reviews } = await c.env.DB.prepare(`
    SELECT r.*, u.name as user_name FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.class_id = ? ORDER BY r.created_at DESC LIMIT 10
  `).bind(cls.id).all()

  // 다음 예정 강의 정보 (class_lessons 기준)
  const nextLesson = await c.env.DB.prepare(`
    SELECT * FROM class_lessons
    WHERE class_id = ? AND datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') > datetime('now')
    ORDER BY scheduled_at ASC LIMIT 1
  `).bind(cls.id).first()
  cls.next_lesson = nextLesson

  // 모든 예정된 강의 목록 (강의별 결제용)
  const { results: scheduledLessons } = await c.env.DB.prepare(`
    SELECT * FROM class_lessons
    WHERE class_id = ?
    ORDER BY scheduled_at ASC
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

  // 코스 강의 자료 파싱
  let courseMaterials: any[] = []
  try { courseMaterials = JSON.parse(cls.materials || '[]') } catch(e) {}

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
            
            ${cls.next_lesson ? `
            <div class="flex items-center gap-2 px-3 py-2 bg-red-50 rounded-xl mb-3">
              <i class="fas fa-calendar-alt text-red-500"></i>
              <span class="text-sm font-medium text-red-700">다음 강의: ${new Date(cls.next_lesson.scheduled_at).toLocaleString('ko-KR', {timeZone:'Asia/Seoul', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'})}</span>
            </div>
            <p class="text-xs text-gray-500 mb-3 -mt-1">${cls.next_lesson.lesson_title}</p>
            ` : `
            <div class="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-xl mb-3">
              <i class="fas fa-calendar-alt text-gray-500"></i>
              <span class="text-sm font-medium text-gray-600">예정된 강의 없음</span>
            </div>
            `}
            
            <div class="flex items-center gap-2 mb-3">
              <div class="flex-1 bg-gray-100 rounded-full h-2">
                <div class="bg-primary-500 h-2 rounded-full" style="width:${Math.round(cls.current_students / cls.max_students * 100)}%"></div>
              </div>
              <span class="text-xs text-gray-500 whitespace-nowrap">${cls.current_students}/${cls.max_students}명</span>
            </div>
            
            <!-- 결제 옵션 탭 -->
            <div class="flex gap-1 mb-3 bg-gray-100 rounded-xl p-1">
              <button onclick="switchPayOption('onetime')" id="payOptOnetime" class="pay-opt-tab flex-1 py-2 text-xs font-semibold rounded-lg bg-white text-dark-900 shadow-sm transition-all">1회 결제</button>
              <button onclick="switchPayOption('monthly')" id="payOptMonthly" class="pay-opt-tab flex-1 py-2 text-xs font-semibold rounded-lg text-gray-500 transition-all">
                <i class="fas fa-sync-alt mr-0.5 text-[10px]"></i>월간 자동결제
              </button>
            </div>
            
            <!-- 1회 결제 -->
            <div id="payOnetime">
              <button id="btnEnrollOnetime" onclick='openPaymentModal(${JSON.stringify({id:cls.id, slug:cls.slug, title:cls.title, price:cls.price, original_price:cls.original_price, discount_percent:cls.discount_percent, thumbnail:cls.thumbnail, instructor_name:cls.instructor_name})})' class="w-full h-12 bg-primary-500 hover:bg-primary-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-primary-500/30 mb-2">
                <i class="fas fa-credit-card mr-2"></i>바로 수강하기 · ${cls.price.toLocaleString()}원
              </button>
            </div>

            <!-- 월간 구독 -->
            <div id="payMonthly" class="hidden">
              <div class="bg-blue-50 rounded-xl p-3 mb-2">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs font-bold text-blue-800"><i class="fas fa-sync-alt mr-1"></i>월간 자동결제</span>
                  <span class="text-[10px] text-blue-600 bg-blue-100 px-2 py-0.5 rounded-full">매월 결제일 자동결제</span>
                </div>
                <p class="text-[11px] text-blue-600">오늘 결제 시 매월 ${new Date().getDate()}일에 자동으로 결제됩니다</p>
              </div>
              <button id="btnEnrollMonthly" onclick='openSubscriptionModal(${JSON.stringify({planType:"class_monthly", classId:cls.id, slug:cls.slug, title:cls.title, amount:cls.price, originalAmount:cls.original_price, thumbnail:cls.thumbnail, instructor_name:cls.instructor_name})})' class="w-full h-12 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-500/30 mb-2">
                <i class="fas fa-sync-alt mr-2"></i>월간 구독 시작 · ${cls.price.toLocaleString()}원/월
              </button>
            </div>

            <div class="grid grid-cols-2 gap-2">
              <button id="btnAddToCart" onclick="addToCart(${cls.id})" class="h-10 border border-gray-200 text-dark-600 font-medium rounded-xl hover:bg-gray-50 transition-all text-sm">
                <i class="fas fa-shopping-cart mr-1"></i>장바구니
              </button>
              <button onclick="toggleWishlistItem(${cls.id})" data-wishlist="${cls.id}" class="h-10 border border-gray-200 text-dark-600 font-medium rounded-xl hover:bg-gray-50 transition-all text-sm">
                <i class="far fa-heart mr-1"></i>찜하기
              </button>
            </div>
            
            <div class="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-gray-100 text-center">
              <div><p class="text-xs text-gray-400">강의 수</p><p class="text-sm font-bold text-dark-800">${cls.total_lessons}강</p></div>
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
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-info-circle text-blue-500 mr-2"></i>코스 소개</h2>
        <p class="text-sm text-dark-600 leading-relaxed whitespace-pre-line">${cls.description}</p>
      </div>

      <!-- Course Materials (강의 자료) -->
      ${courseMaterials.length > 0 ? `
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-paperclip text-amber-500 mr-2"></i>강의 자료 <span class="text-sm font-normal text-gray-500">(${courseMaterials.length}개)</span></h2>
        <div class="flex flex-wrap gap-3">
          ${courseMaterials.map((m: any) => `
            <a href="${m.url}" target="_blank" download class="inline-flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 hover:border-amber-400 hover:bg-amber-100 rounded-xl text-sm text-amber-800 transition-all">
              <i class="fas fa-file-download text-amber-500"></i>
              <span>${m.filename || '다운로드'}</span>
            </a>
          `).join('')}
        </div>
        <p class="text-xs text-gray-400 mt-3"><i class="fas fa-info-circle mr-1"></i>수강 등록 후 자료를 다운로드할 수 있습니다</p>
      </div>
      ` : ''}

      <!-- Scheduled Lessons (강의 목록) -->
      ${scheduledLessons.length > 0 ? `
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-calendar-alt text-red-500 mr-2"></i>강의 목록 <span class="text-sm font-normal text-gray-500">(${scheduledLessons.length}개)</span></h2>
        <div class="space-y-3">
          ${scheduledLessons.map((sl: any, idx: number) => {
            const now = Date.now()
            // lesson_type이 'recorded'이거나 stream_uid가 있으면 녹화 강의로 처리
            const isRecorded = sl.lesson_type === 'recorded' || !!sl.stream_uid
            const startTime = new Date(sl.scheduled_at).getTime()
            const endTime = startTime + (sl.duration_minutes || 60) * 60 * 1000
            const isEnded = !isRecorded && endTime < now
            const isLive = !isRecorded && !isEnded && startTime <= now && now < endTime
            const isUpcoming = !isRecorded && startTime > now

            const dateStr = isRecorded ? '즉시 시청 가능' : new Date(sl.scheduled_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' })
            const timeStr = isRecorded ? '' : new Date(sl.scheduled_at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })

            let typeBadge, statusBadge, actionButton, bgClass, circleClass

            // 강의 유형 배지
            typeBadge = isRecorded
              ? '<span class="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-[10px] font-medium rounded mr-1">녹화</span>'
              : '<span class="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-medium rounded mr-1">라이브</span>'

            if (isRecorded) {
              // 녹화 강의
              statusBadge = '<span class="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">시청가능</span>'
              // 코스 가격 확인 (강의별 가격 없음)
              if (cls.price > 0) {
                // 유료 코스 - 미결제 상태로 기본 표시, 수강 여부 확인 후 시청하기로 변경
                actionButton = "<span class=\"lesson-action-btn\" data-lesson-id=\"" + sl.id + "\" data-course-id=\"" + cls.id + "\" data-state=\"recorded\"><span class=\"unpaid-btn px-4 py-2 bg-gray-300 text-gray-500 text-sm font-medium rounded-xl inline-block\"><i class=\"fas fa-lock mr-1\"></i>미결제</span></span>"
              } else {
                // 무료 코스 - 바로 시청
                actionButton = '<button onclick="openWatchWindow(' + sl.id + ')" class="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white text-sm font-semibold rounded-xl transition-all"><i class="fas fa-play mr-1"></i>시청하기</button>'
              }
              bgClass = 'bg-purple-50 border-purple-200'
              circleClass = 'bg-purple-500'
            } else if (isEnded) {
              statusBadge = '<span class="px-2 py-0.5 bg-gray-200 text-gray-600 text-xs font-medium rounded-full">종료</span>'
              if (cls.price > 0) {
                // 유료 코스 - 미결제 상태로 기본 표시, 수강 여부 확인 후 다시보기로 변경
                actionButton = "<span class=\"lesson-action-btn\" data-lesson-id=\"" + sl.id + "\" data-course-id=\"" + cls.id + "\" data-replay-url=\"" + (sl.replay_url || '') + "\" data-state=\"ended\"><span class=\"unpaid-btn px-4 py-2 bg-gray-300 text-gray-500 text-sm font-medium rounded-xl inline-block\"><i class=\"fas fa-lock mr-1\"></i>미결제</span></span>"
              } else {
                actionButton = sl.replay_url
                  ? '<a href="' + sl.replay_url + '" target="_blank" class="px-4 py-2 bg-green-500 hover:bg-green-600 text-white text-sm font-semibold rounded-xl transition-all"><i class="fas fa-play mr-1"></i>다시보기</a>'
                  : '<span class="text-gray-400 text-sm">다시보기 없음</span>'
              }
              bgClass = 'bg-gray-50'
              circleClass = 'bg-gray-300'
            } else if (isLive) {
              statusBadge = '<span class="px-2 py-0.5 bg-red-500 text-white text-xs font-medium rounded-full animate-pulse">진행중</span>'
              if (cls.price > 0) {
                // 미결제 상태로 기본 표시, 수강 여부 확인 후 입장하기로 변경
                actionButton = "<span class=\"lesson-action-btn\" data-lesson-id=\"" + sl.id + "\" data-course-id=\"" + cls.id + "\" data-join-url=\"" + (sl.join_url || '') + "\" data-state=\"live\"><span class=\"unpaid-btn px-4 py-2 bg-gray-300 text-gray-500 text-sm font-medium rounded-xl inline-block\"><i class=\"fas fa-lock mr-1\"></i>미결제</span></span>"
              } else {
                actionButton = sl.join_url ? '<a href="' + sl.join_url + '" target="_blank" class="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-red-500/30"><i class="fas fa-video mr-1"></i>입장하기</a>' : '<span class="text-gray-400 text-sm">입장 링크 없음</span>'
              }
              bgClass = 'bg-red-50 border-red-200'
              circleClass = 'bg-red-500'
            } else {
              statusBadge = '<span class="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-medium rounded-full">예정</span>'
              if (cls.price > 0) {
                // 미결제 상태로 기본 표시, 수강 여부 확인 후 입장하기로 변경
                actionButton = "<span class=\"lesson-action-btn\" data-lesson-id=\"" + sl.id + "\" data-course-id=\"" + cls.id + "\" data-join-url=\"" + (sl.join_url || '') + "\" data-state=\"scheduled\"><span class=\"unpaid-btn px-4 py-2 bg-gray-300 text-gray-500 text-sm font-medium rounded-xl inline-block\"><i class=\"fas fa-lock mr-1\"></i>미결제</span></span>"
              } else {
                actionButton = '<span class="text-gray-500 text-sm"><i class="far fa-clock mr-1"></i>시작 대기</span>'
              }
              bgClass = 'bg-blue-50 border-blue-200'
              circleClass = 'bg-blue-500'
            }

            const iconClass = isRecorded ? 'fas fa-video' : 'far fa-calendar'
            const timeSpan = timeStr ? '<span><i class="far fa-clock mr-1"></i>' + timeStr + '</span>' : ''

            // 커리큘럼/자료 파싱
            let slCurrItems = []
            let slMatItems = []
            try { slCurrItems = JSON.parse(sl.curriculum_items || '[]') } catch(e) {}
            try { slMatItems = JSON.parse(sl.materials || '[]') } catch(e) {}
            const slHasDetail = slCurrItems.length > 0 || slMatItems.length > 0 || (sl.description && sl.description.trim())
            const slDetailId = 'slDetail_' + sl.id

            let slDetailSection = ''
            if (slHasDetail) {
              slDetailSection = '<div id="' + slDetailId + '" class="hidden mt-3 pt-3 border-t border-gray-200 space-y-3">'
              if (sl.description && sl.description.trim()) {
                slDetailSection += '<div><p class="text-xs font-semibold text-gray-500 mb-1"><i class="fas fa-align-left mr-1"></i>강의 소개</p><p class="text-sm text-gray-700 whitespace-pre-line">' + sl.description + '</p></div>'
              }
              if (slCurrItems.length > 0) {
                slDetailSection += '<div><p class="text-xs font-semibold text-gray-500 mb-1"><i class="fas fa-list-ol mr-1"></i>커리큘럼</p><div class="space-y-1.5">'
                slCurrItems.forEach(function(ci: any, i: number) {
                  slDetailSection += '<div class="flex items-start gap-2 pl-1"><span class="w-5 h-5 bg-indigo-100 text-indigo-600 text-[10px] font-bold rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">' + (i+1) + '</span><div><p class="text-sm font-medium text-dark-800">' + (ci.title || '') + '</p>' + (ci.desc ? '<p class="text-xs text-gray-500">' + ci.desc + '</p>' : '') + '</div></div>'
                })
                slDetailSection += '</div></div>'
              }
              if (slMatItems.length > 0) {
                slDetailSection += '<div><p class="text-xs font-semibold text-gray-500 mb-1"><i class="fas fa-paperclip mr-1"></i>강의 자료</p><div class="flex flex-wrap gap-2">'
                slMatItems.forEach(function(m: any) {
                  slDetailSection += '<a href="' + m.url + '" target="_blank" download class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 hover:border-purple-300 hover:bg-purple-50 rounded-lg text-xs text-gray-700 transition-all shadow-sm"><i class="fas fa-file-download text-purple-500"></i>' + (m.filename || '파일') + '</a>'
                })
                slDetailSection += '</div></div>'
              }
              slDetailSection += '</div>'
            }

            const slExpandBtn = slHasDetail ? '<button onclick="event.stopPropagation(); var el=document.getElementById(\'' + slDetailId + '\'); el.classList.toggle(\'hidden\'); this.querySelector(\'i\').classList.toggle(\'rotate-180\')" class="text-gray-400 hover:text-gray-600 text-xs transition-all"><i class="fas fa-chevron-down transition-transform"></i> 상세보기</button>' : ''
            const slCurrBadge = slCurrItems.length > 0 ? '<span class="px-1.5 py-0.5 bg-indigo-100 text-indigo-600 text-[10px] font-medium rounded"><i class="fas fa-list-ol mr-0.5"></i>' + slCurrItems.length + '</span>' : ''
            const slMatBadge = slMatItems.length > 0 ? '<span class="text-amber-500 text-xs"><i class="fas fa-paperclip"></i></span>' : ''

            return '<div class="p-4 border border-gray-100 rounded-xl ' + bgClass + ' hover:shadow-sm transition-all">' +
              '<div class="flex flex-col sm:flex-row sm:items-center gap-4">' +
                '<div class="flex items-center gap-3 flex-1">' +
                  '<div class="w-10 h-10 rounded-full ' + circleClass + ' flex items-center justify-center text-white font-bold text-sm">' + (idx + 1) + '</div>' +
                  '<div>' +
                    '<p class="font-semibold text-dark-800">' + typeBadge + sl.lesson_title + ' ' + slCurrBadge + slMatBadge + '</p>' +
                    '<div class="flex items-center gap-2 text-sm text-gray-500 mt-1">' +
                      '<span><i class="' + iconClass + ' mr-1"></i>' + dateStr + '</span>' +
                      timeSpan +
                      '<span><i class="fas fa-hourglass-half mr-1"></i>' + sl.duration_minutes + '분</span>' +
                      slExpandBtn +
                    '</div>' +
                  '</div>' +
                '</div>' +
                '<div class="flex items-center gap-3">' +
                  statusBadge +
                  actionButton +
                '</div>' +
              '</div>' +
              slDetailSection +
            '</div>'
          }).join('')}
        </div>
        <div class="mt-4 p-4 bg-blue-50 rounded-xl border border-blue-100">
          <div class="flex items-start gap-3">
            <i class="fas fa-info-circle text-blue-500 mt-0.5"></i>
            <div class="text-sm text-blue-800">
              <p class="font-semibold mb-1">코스 결제 안내</p>
              <p class="text-blue-600">코스를 결제하시면 포함된 모든 강의를 수강하실 수 있습니다.</p>
            </div>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- Curriculum (챕터별 + 강의 입장 연결) -->
      <div class="bg-white rounded-2xl p-6 border border-gray-100">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-list-ol text-purple-500 mr-2"></i>커리큘럼 <span class="text-sm font-normal text-gray-500">(${lessons.length}강)</span></h2>
        <div class="space-y-3">
          ${Object.entries(chapters).map(([chapter, chLessons]: [string, any[]], ci) => `
            <div class="border border-gray-100 rounded-xl overflow-hidden">
              <button onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.chev-icon').classList.toggle('rotate-180')" class="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-all">
                <div class="flex items-center gap-2">
                  <span class="w-6 h-6 bg-primary-100 text-primary-600 text-xs font-bold rounded-full flex items-center justify-center">${ci + 1}</span>
                  <span class="text-sm font-semibold text-dark-800">${chapter}</span>
                  <span class="text-xs text-gray-400">(${chLessons.length}강)</span>
                </div>
                <i class="fas fa-chevron-down text-gray-400 text-xs transition-transform chev-icon"></i>
              </button>
              <div class="${ci === 0 ? '' : 'hidden'}">
                ${chLessons.map((lesson: any, li: number) => {
                  const iconClass = lesson.lesson_type === 'live' ? 'fa-video text-red-400' : lesson.lesson_type === 'assignment' ? 'fa-pencil-alt text-blue-400' : 'fa-play-circle text-gray-400'
                  return `
                  <div class="curriculum-item flex items-center gap-3 px-4 py-3 border-t border-gray-50 hover:bg-purple-50 transition-all cursor-pointer group" data-lesson-title="${lesson.title.replace(/"/g, '&quot;')}" data-lesson-type="${lesson.lesson_type}" onclick="enterCurriculumLesson(this)">
                    <span class="text-xs text-gray-400 w-5">${li + 1}</span>
                    <i class="fas ${iconClass} text-sm"></i>
                    <span class="text-sm text-dark-700 flex-1 group-hover:text-purple-700 transition-colors">${lesson.title}</span>
                    ${lesson.is_preview ? '<span class="text-[10px] text-primary-500 font-bold border border-primary-200 px-1.5 py-0.5 rounded">미리보기</span>' : ''}
                    <span class="text-xs text-gray-400">${lesson.duration_minutes}분</span>
                    <i class="fas fa-chevron-right text-gray-300 text-xs group-hover:text-purple-400 transition-colors"></i>
                  </div>`
                }).join('')}
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
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-chalkboard-teacher text-indigo-500 mr-2"></i>러닝퍼실리테이터 소개</h2>
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
              <span><i class="far fa-play-circle mr-1"></i>${cls.instructor_total_classes}개 코스</span>
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

        <!-- 리뷰 작성 폼 (수강생 전용, JS에서 표시/숨김 제어) -->
        <div id="reviewFormSection" class="hidden mb-6">
          <div class="border border-gray-200 rounded-xl p-4 bg-gray-50">
            <p class="text-sm font-semibold text-dark-800 mb-3"><i class="fas fa-pen mr-1 text-green-500"></i>후기 작성하기</p>
            <div class="flex items-center gap-1 mb-3" id="reviewStarSelector">
              <button type="button" onclick="setReviewRating(1)" class="review-star text-gray-300 hover:text-yellow-400 text-xl transition-colors"><i class="fas fa-star"></i></button>
              <button type="button" onclick="setReviewRating(2)" class="review-star text-gray-300 hover:text-yellow-400 text-xl transition-colors"><i class="fas fa-star"></i></button>
              <button type="button" onclick="setReviewRating(3)" class="review-star text-gray-300 hover:text-yellow-400 text-xl transition-colors"><i class="fas fa-star"></i></button>
              <button type="button" onclick="setReviewRating(4)" class="review-star text-gray-300 hover:text-yellow-400 text-xl transition-colors"><i class="fas fa-star"></i></button>
              <button type="button" onclick="setReviewRating(5)" class="review-star text-gray-300 hover:text-yellow-400 text-xl transition-colors"><i class="fas fa-star"></i></button>
              <span id="reviewRatingText" class="text-sm text-gray-400 ml-2">별점을 선택해주세요</span>
            </div>
            <textarea id="reviewContent" rows="3" placeholder="수업에 대한 솔직한 후기를 남겨주세요. 다른 수강생에게 큰 도움이 됩니다!" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-green-400 focus:border-green-400 resize-none bg-white"></textarea>
            <div class="flex items-center justify-between mt-3">
              <p class="text-xs text-gray-400">작성한 후기는 수정/삭제가 불가합니다</p>
              <button onclick="submitReview(${cls.id})" id="submitReviewBtn" class="px-4 py-2 bg-green-500 hover:bg-green-600 text-white text-sm font-semibold rounded-lg transition-all disabled:bg-gray-300 disabled:cursor-not-allowed" disabled>후기 등록</button>
            </div>
          </div>
        </div>
        <!-- 이미 작성한 경우 -->
        <div id="reviewAlreadyWritten" class="hidden mb-6">
          <div class="p-3 bg-green-50 border border-green-200 rounded-xl text-center">
            <p class="text-sm text-green-700"><i class="fas fa-check-circle mr-1"></i>이미 후기를 작성하셨습니다. 감사합니다!</p>
          </div>
        </div>

        <div class="space-y-4" id="reviewsList">
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

      <!-- Q&A 게시판 -->
      <div class="bg-white rounded-2xl p-6 border border-gray-100" id="qna">
        <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-question-circle text-blue-500 mr-2"></i>Q&A <span class="text-sm font-normal text-gray-500" id="qnaCount"></span></h2>

        <!-- 질문 작성 폼 (로그인 시) -->
        <div id="qnaFormSection" class="mb-6">
          <div class="border border-gray-200 rounded-xl p-4 bg-gray-50">
            <p class="text-sm font-semibold text-dark-800 mb-3"><i class="fas fa-pen mr-1 text-blue-500"></i>질문하기</p>
            <textarea id="qnaContent" rows="3" placeholder="수업에 대해 궁금한 점을 질문해주세요. 강사님이 직접 답변해드립니다!" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-400 focus:border-blue-400 resize-none bg-white"></textarea>
            <div class="flex items-center justify-between mt-3">
              <p class="text-xs text-gray-400">질문은 본인만 삭제할 수 있습니다</p>
              <button onclick="submitQna(${cls.id})" class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold rounded-lg transition-all">질문 등록</button>
            </div>
          </div>
        </div>
        <!-- 비로그인 안내 -->
        <div id="qnaLoginPrompt" class="hidden mb-6">
          <div class="p-3 bg-blue-50 border border-blue-200 rounded-xl text-center">
            <p class="text-sm text-blue-700"><i class="fas fa-lock mr-1"></i>질문을 작성하려면 <a href="/login" class="font-semibold underline">로그인</a>이 필요합니다.</p>
          </div>
        </div>

        <div class="space-y-4" id="qnaList">
          <div class="text-center py-8 text-gray-400 text-sm" id="qnaEmpty">
            <i class="fas fa-comment-dots text-2xl mb-2 block"></i>
            아직 질문이 없습니다. 첫 번째 질문을 남겨보세요!
          </div>
        </div>
      </div>
    </div>

    <!-- Sidebar spacer for sticky card on desktop -->
    <div class="hidden md:block md:col-span-2"></div>
  </div>
</section>

<script>
// 강의 버튼 활성화 함수
function activateLessonButtons(isInstructor) {
  document.querySelectorAll('.lesson-action-btn').forEach(function(wrapper) {
    const lessonId = wrapper.dataset.lessonId;
    const joinUrl = wrapper.dataset.joinUrl;
    const replayUrl = wrapper.dataset.replayUrl;
    const state = wrapper.dataset.state;

    // 사용자 ID 가져오기
    const currentUser = JSON.parse(localStorage.getItem('classin_user') || 'null');
    const currentUserId = currentUser ? currentUser.id : '';

    // 강사는 instructor-enter API 사용
    const enterUrl = isInstructor
      ? '/api/classin/instructor-enter/' + lessonId + '?redirect=true'
      : '/api/classin/lesson-enter/' + lessonId + '?redirect=true&userId=' + currentUserId;

    if (state === 'recorded') {
      wrapper.innerHTML = '<button onclick="openWatchWindow(' + lessonId + ')" class="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white text-sm font-semibold rounded-xl transition-all"><i class="fas fa-play mr-1"></i>시청하기</button>';
    } else if (state === 'ended') {
      // 종료된 강의 - 다시보기
      wrapper.innerHTML = replayUrl
        ? '<a href="' + replayUrl + '" target="_blank" class="px-4 py-2 bg-green-500 hover:bg-green-600 text-white text-sm font-semibold rounded-xl transition-all"><i class="fas fa-play mr-1"></i>다시보기</a>'
        : '<span class="text-gray-400 text-sm">다시보기 없음</span>';
    } else if (state === 'live') {
      wrapper.innerHTML = '<a href="' + enterUrl + '" target="_blank" class="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-red-500/30"><i class="fas fa-video mr-1"></i>' + (isInstructor ? '강의실 입장' : '입장하기') + '</a>';
    } else {
      wrapper.innerHTML = '<a href="' + enterUrl + '" target="_blank" class="px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-primary-500/30"><i class="fas fa-door-open mr-1"></i>' + (isInstructor ? '강의실 입장' : '입장하기') + '</a>';
    }
  });
}

// 페이지 로드 시 수강 여부 확인하여 버튼 업데이트
(async function checkEnrollmentOnLoad() {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (!user) return;

  const courseId = ${cls.id};
  const courseSlug = '${cls.slug}';
  console.log('[Enrollment Check] courseId:', courseId, 'userId:', user.id);

  // 강사/관리자는 모든 강의 접근 가능
  const isThisClassInstructor = (user.id === ${cls.instructor_user_id || 0});
  if (user.role === 'instructor' || user.role === 'admin' || user.is_instructor === 1) {
    activateLessonButtons(isThisClassInstructor);
    return;
  }

  try {
    const res = await fetch('/api/enrollments/check?userId=' + user.id + '&classId=' + courseId);
    const data = await res.json();
    console.log('[Enrollment Check] Result:', data);

    if (data.enrolled) {
      // 수강 중인 경우 - 결제 버튼 변경
      const payOnetimeDiv = document.getElementById('payOnetime');
      const payMonthlyDiv = document.getElementById('payMonthly');
      const payTabsDiv = document.querySelector('.pay-opt-tab')?.parentElement;

      if (payOnetimeDiv) {
        payOnetimeDiv.innerHTML = '<a href="/class/' + courseSlug + '#lessons" class="w-full h-12 bg-green-500 hover:bg-green-600 text-white font-bold rounded-xl transition-all flex items-center justify-center"><i class="fas fa-check-circle mr-2"></i>결제 완료 - 수강중</a>';
      }
      if (payMonthlyDiv) payMonthlyDiv.classList.add('hidden');
      if (payTabsDiv) payTabsDiv.classList.add('hidden');

      // 장바구니/찜하기 버튼도 숨김
      const btnAddToCart = document.getElementById('btnAddToCart');
      if (btnAddToCart) btnAddToCart.parentElement.classList.add('hidden');

      // 수강 중인 경우 - 강의 입장 버튼 활성화 (미결제 → 입장하기/시청하기)
      activateLessonButtons();
    }
  } catch (e) {
    console.log('Enrollment check failed:', e);
  }
})();

// 녹화 강의 새 창에서 열기
function openWatchWindow(lessonId) {
  window.open('/watch/' + lessonId, 'watchLesson', 'width=1200,height=800');
}

// 코스 수강 여부 확인 후 녹화 강의 시청
async function checkEnrollmentAndWatch(lessonId, courseId) {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  const token = localStorage.getItem('classin_token');

  if (!user || !token) {
    if (typeof openLoginModal === 'function') openLoginModal();
    else window.location.href = '/login';
    return;
  }

  // 강사 본인 코스면 바로 시청
  if (user.role === 'instructor' || user.role === 'admin' || user.is_instructor === 1) {
    openWatchWindow(lessonId);
    return;
  }

  // 수강 여부 확인
  try {
    const res = await fetch('/api/enrollments/check?userId=' + user.id + '&classId=' + courseId);
    const data = await res.json();
    if (data.enrolled) {
      openWatchWindow(lessonId);
    } else {
      alert('코스 결제가 필요합니다. 코스를 먼저 수강 신청해주세요.');
    }
  } catch (e) {
    alert('수강 확인 중 오류가 발생했습니다.');
  }
}

// 코스 수강 여부 확인 후 라이브 강의 입장
async function checkEnrollmentAndJoin(lessonId, courseId) {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  const token = localStorage.getItem('classin_token');
  // 클릭된 버튼에서 join URL 가져오기
  const btn = event.currentTarget;
  const joinUrl = btn.dataset.joinUrl || '';

  if (!user || !token) {
    if (typeof openLoginModal === 'function') openLoginModal();
    else window.location.href = '/login';
    return;
  }

  // 강사/관리자면 바로 입장
  if (user.role === 'instructor' || user.role === 'admin' || user.is_instructor === 1) {
    if (joinUrl) window.open(joinUrl, '_blank');
    else alert('입장 링크가 아직 없습니다.');
    return;
  }

  // 수강 여부 확인
  try {
    const res = await fetch('/api/enrollments/check?userId=' + user.id + '&classId=' + courseId);
    const data = await res.json();
    if (data.enrolled) {
      if (joinUrl) window.open(joinUrl, '_blank');
      else alert('입장 링크가 아직 없습니다.');
    } else {
      alert('코스 결제가 필요합니다. 코스를 먼저 수강 신청해주세요.');
    }
  } catch (e) {
    alert('수강 확인 중 오류가 발생했습니다.');
  }
}

// ===== 커리큘럼 → 강의 입장 =====
const classLessonsData = ${JSON.stringify((scheduledLessons as any[]).map(sl => ({
  id: sl.id,
  title: sl.lesson_title,
  type: sl.lesson_type === 'recorded' || sl.stream_uid ? 'recorded' : 'live',
  status: sl.status,
  scheduledAt: sl.scheduled_at,
  durationMinutes: sl.duration_minutes,
  price: sl.price,
  replayUrl: sl.replay_url,
  streamUid: sl.stream_uid
})))};
const classId = ${cls.id};
const classPrice = ${cls.price || 0};
const classThumbnail = '${cls.thumbnail || ''}';
const classTitle = '${(cls.title || '').replace(/'/g, "\\'")}';
const instructorName = '${(cls.instructor_name || '').replace(/'/g, "\\'")}';

function enterCurriculumLesson(el) {
  const title = el.dataset.lessonTitle;
  const lessonType = el.dataset.lessonType;
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');

  // 커리큘럼 제목과 매칭되는 class_lesson 찾기 (부분 매칭)
  let matched = classLessonsData.find(cl => cl.title && cl.title.includes(title));
  if (!matched && classLessonsData.length > 0) {
    // 매칭 안 되면 순서 기반으로 연결 시도
    const items = document.querySelectorAll('.curriculum-item');
    const idx = Array.from(items).indexOf(el);
    if (idx >= 0 && idx < classLessonsData.length) matched = classLessonsData[idx];
  }

  if (!user) {
    // 로그인 안 한 경우
    if (typeof openLoginModal === 'function') openLoginModal();
    else window.location.href = '/login';
    return;
  }

  if (matched) {
    const now = Date.now();
    const startTime = new Date(matched.scheduledAt).getTime();
    const endTime = startTime + (matched.durationMinutes || 60) * 60 * 1000;
    // type이 'recorded'이거나 streamUid가 있으면 녹화 강의로 처리
    const isRecorded = matched.type === 'recorded' || !!matched.streamUid;
    const isEnded = !isRecorded && endTime < now;
    const isLive = !isRecorded && !isEnded && startTime <= now && now < endTime;

    if (isRecorded) {
      // 녹화 강의 → 시청
      openWatchWindow(matched.id);
    } else if (isLive) {
      // 라이브 진행중 → 수업 입장 (새 API로 수강 여부 확인 + ClassIn 입장)
      window.open('/api/classin/lesson-enter/' + matched.id + '?redirect=true&userId=' + user.id, '_blank');
    } else if (isEnded && matched.replayUrl) {
      // 종료됨 + 다시보기 → 다시보기
      window.open(matched.replayUrl, '_blank');
    } else if (isEnded) {
      // 종료됨 but 다시보기 없음
      alert('이 강의의 다시보기가 아직 준비되지 않았습니다.');
    } else {
      // 예정된 강의 → 입장 (수강 여부에 따라 서버에서 처리)
      window.open('/api/classin/lesson-enter/' + matched.id + '?redirect=true&userId=' + user.id, '_blank');
    }
  } else {
    // 매칭 강의 없음 → 아직 일정 없음 안내
    alert('아직 해당 강의의 일정이 등록되지 않았습니다.');
  }
}

// ===== 리뷰 작성 기능 =====
let selectedReviewRating = 0;
const ratingLabels = ['', '별로예요', '그저 그래요', '괜찮아요', '좋아요', '최고예요!'];

function setReviewRating(rating) {
  selectedReviewRating = rating;
  const stars = document.querySelectorAll('.review-star');
  stars.forEach((star, i) => {
    star.classList.toggle('text-yellow-400', i < rating);
    star.classList.toggle('text-gray-300', i >= rating);
  });
  document.getElementById('reviewRatingText').textContent = ratingLabels[rating];
  checkReviewReady();
}

function checkReviewReady() {
  const content = document.getElementById('reviewContent').value.trim();
  document.getElementById('submitReviewBtn').disabled = !(selectedReviewRating > 0 && content.length >= 5);
}

async function submitReview(classId) {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (!user) return;
  const content = document.getElementById('reviewContent').value.trim();
  if (!selectedReviewRating || content.length < 5) return;

  const btn = document.getElementById('submitReviewBtn');
  btn.disabled = true;
  btn.textContent = '등록 중...';

  try {
    const token = localStorage.getItem('classin_token');
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ classId, userId: user.id, rating: selectedReviewRating, content })
    });
    const data = await res.json();
    if (data.success) {
      // 리뷰 목록에 추가
      const reviewsList = document.getElementById('reviewsList');
      const stars = Array.from({length:5}, (_, i) => '<i class="' + (i < selectedReviewRating ? 'fas' : 'far') + ' fa-star text-yellow-400 text-[10px]"></i>').join('');
      const newReview = '<div class="pb-4 border-b border-gray-50"><div class="flex items-center justify-between mb-2"><div class="flex items-center gap-2"><div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center text-xs font-bold text-green-600">' + user.name.charAt(0) + '</div><div><p class="text-sm font-medium text-dark-800">' + user.name + '</p><div class="flex items-center gap-0.5">' + stars + '</div></div></div><span class="text-xs text-gray-400">방금 전</span></div><p class="text-sm text-dark-600 leading-relaxed">' + content.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p></div>';
      reviewsList.insertAdjacentHTML('afterbegin', newReview);
      // 폼 숨기고 완료 표시
      document.getElementById('reviewFormSection').classList.add('hidden');
      document.getElementById('reviewAlreadyWritten').classList.remove('hidden');
    } else {
      alert(data.error || '리뷰 등록에 실패했습니다.');
      btn.disabled = false;
      btn.textContent = '후기 등록';
    }
  } catch(e) {
    alert('오류가 발생했습니다.');
    btn.disabled = false;
    btn.textContent = '후기 등록';
  }
}

// 리뷰 textarea 입력 감지
document.getElementById('reviewContent')?.addEventListener('input', checkReviewReady);

// 수강생인지 확인하여 리뷰 폼 표시
(function initReviewForm() {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (!user || user.id === ${cls.instructor_user_id || 0}) return;
  // 수강 여부 확인
  fetch('/api/user/' + user.id + '/enrollments')
    .then(r => r.json())
    .then(data => {
      const list = Array.isArray(data) ? data : (data.enrollments || []);
      const enrolled = list.some(e => e.class_id === ${cls.id} || e.id === ${cls.id});
      if (!enrolled) return;
      // 이미 리뷰 작성했는지 확인 (서버 렌더된 리뷰 목록에서 이름 매칭)
      const existingReviews = document.querySelectorAll('#reviewsList .pb-4');
      let alreadyWritten = false;
      existingReviews.forEach(el => {
        const nameEl = el.querySelector('.font-medium');
        if (nameEl && nameEl.textContent === user.name) alreadyWritten = true;
      });
      if (alreadyWritten) {
        document.getElementById('reviewAlreadyWritten').classList.remove('hidden');
      } else {
        document.getElementById('reviewFormSection').classList.remove('hidden');
      }
    })
    .catch(() => {});
})();

// 강사 본인 수업이면 "수업 관리" 버튼 표시
document.addEventListener('DOMContentLoaded', () => {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  const instructorUserId = ${cls.instructor_user_id || 0};
  if (user && user.id === instructorUserId) {
    const enrollBtn = document.getElementById('btnEnrollOnetime');
    if (enrollBtn) {
      enrollBtn.innerHTML = '<i class="fas fa-cog mr-2"></i>수업 관리';
      enrollBtn.className = 'w-full h-12 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-all flex items-center justify-center shadow-lg';
      enrollBtn.onclick = function(e) { e.preventDefault(); window.location.href = '/instructor/classes/${cls.id}/edit'; };
      enrollBtn.disabled = false;
    }
    var monthlyBtn = document.getElementById('btnEnrollMonthly');
    if (monthlyBtn) monthlyBtn.parentElement.classList.add('hidden');
    var cartBtn = document.getElementById('btnAddToCart');
    if (cartBtn) cartBtn.parentElement.classList.add('hidden');
    return;
  }
  // 듀얼 롤: 자기 코스 강사는 위에서 이미 "수업 관리"로 전환됨. 다른 코스는 수강 가능.
});

// ===== Q&A 게시판 JS =====
const QNA_CLASS_ID = ${cls.id};

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderComment(c, isReply) {
  const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  const canDelete = user && (user.id === c.user_id || user.role === 'admin');
  const initial = (c.user_name || 'U').charAt(0);
  const badge = c.is_instructor ? ' <span class="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded">강사</span>' : '';
  const deleteBtn = canDelete ? ' <button onclick="deleteQna(' + c.id + ',this)" class="text-xs text-gray-400 hover:text-red-500 transition-colors">삭제</button>' : '';
  const replyBtn = !isReply ? '<button onclick="showReplyForm(' + c.id + ')" class="text-xs text-blue-500 hover:text-blue-700 transition-colors mt-2"><i class="fas fa-reply mr-1"></i>답글</button>' : '';
  const dateStr = new Date(c.created_at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  const avatarColor = c.is_instructor ? 'bg-blue-100 text-blue-600' : 'bg-gray-200 text-gray-500';
  const bgClass = isReply ? 'ml-8 bg-gray-50' : 'bg-white';

  var h = '<div class="' + bgClass + ' rounded-xl p-4 border border-gray-100" data-comment-id="' + c.id + '">';
  h += '<div class="flex items-start gap-3">';
  h += '<div class="w-8 h-8 rounded-full ' + avatarColor + ' flex items-center justify-center text-xs font-bold flex-shrink-0">' + initial + '</div>';
  h += '<div class="flex-1 min-w-0">';
  h += '<div class="flex items-center flex-wrap gap-1 mb-1"><span class="text-sm font-medium text-dark-800">' + escHtml(c.user_name) + '</span>' + badge + '<span class="text-xs text-gray-400">' + dateStr + '</span>' + deleteBtn + '</div>';
  h += '<p class="text-sm text-dark-600 leading-relaxed whitespace-pre-line">' + escHtml(c.content) + '</p>';
  h += replyBtn;
  h += '</div></div>';

  if (!isReply) {
    h += '<div class="space-y-2 mt-3" id="replies-' + c.id + '">';
    if (c.replies && c.replies.length > 0) {
      c.replies.forEach(function(r) { h += renderComment(r, true); });
    }
    h += '</div>';
    h += '<div id="replyForm-' + c.id + '" class="hidden mt-3 ml-8"></div>';
  }
  h += '</div>';
  return h;
}

function showReplyForm(parentId) {
  var user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (!user) { window.location.href = '/login'; return; }
  document.querySelectorAll('[id^="replyForm-"]').forEach(function(el) { el.classList.add('hidden'); el.innerHTML = ''; });
  var el = document.getElementById('replyForm-' + parentId);
  el.innerHTML = '<div class="flex gap-2"><textarea id="replyText-' + parentId + '" rows="2" placeholder="답글을 작성해주세요..." class="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-400 resize-none"></textarea><div class="flex flex-col gap-1"><button onclick="submitReply(' + parentId + ')" class="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg transition-all">등록</button><button onclick="hideReplyForm(' + parentId + ')" class="px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-600 text-xs rounded-lg transition-all">취소</button></div></div>';
  el.classList.remove('hidden');
  document.getElementById('replyText-' + parentId).focus();
}

function hideReplyForm(parentId) {
  var el = document.getElementById('replyForm-' + parentId);
  el.classList.add('hidden');
  el.innerHTML = '';
}

async function submitQna(classId) {
  var user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (!user) { window.location.href = '/login'; return; }
  var content = document.getElementById('qnaContent').value.trim();
  if (!content) return alert('질문 내용을 입력해주세요.');
  var token = localStorage.getItem('classin_token');
  try {
    var res = await fetch('/api/classes/' + classId + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ content: content })
    });
    var data = await res.json();
    if (data.error) return alert(data.error);
    document.getElementById('qnaContent').value = '';
    document.getElementById('qnaEmpty').classList.add('hidden');
    document.getElementById('qnaList').insertAdjacentHTML('afterbegin', renderComment(data, false));
    updateQnaCount(1);
  } catch(e) { alert('오류가 발생했습니다.'); }
}

async function submitReply(parentId) {
  var content = document.getElementById('replyText-' + parentId).value.trim();
  if (!content) return;
  var token = localStorage.getItem('classin_token');
  try {
    var res = await fetch('/api/classes/' + QNA_CLASS_ID + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ content: content, parent_id: parentId })
    });
    var data = await res.json();
    if (data.error) return alert(data.error);
    hideReplyForm(parentId);
    document.getElementById('replies-' + parentId).insertAdjacentHTML('beforeend', renderComment(data, true));
  } catch(e) { alert('오류가 발생했습니다.'); }
}

async function deleteQna(commentId, btn) {
  if (!confirm('정말 삭제하시겠습니까?')) return;
  var token = localStorage.getItem('classin_token');
  try {
    var res = await fetch('/api/classes/' + QNA_CLASS_ID + '/comments/' + commentId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    if (data.success) {
      var el = btn.closest('[data-comment-id="' + commentId + '"]');
      if (el) el.remove();
      updateQnaCount(-1);
    } else { alert(data.error || '삭제에 실패했습니다.'); }
  } catch(e) { alert('삭제에 실패했습니다.'); }
}

var qnaTotal = 0;
function updateQnaCount(delta) {
  qnaTotal += delta;
  document.getElementById('qnaCount').textContent = '(' + qnaTotal + '개)';
  if (qnaTotal <= 0) document.getElementById('qnaEmpty').classList.remove('hidden');
}

// Q&A 초기 로드
(async function initQna() {
  var user = JSON.parse(localStorage.getItem('classin_user') || 'null');
  if (!user) {
    document.getElementById('qnaFormSection').classList.add('hidden');
    document.getElementById('qnaLoginPrompt').classList.remove('hidden');
  }
  try {
    var res = await fetch('/api/classes/' + QNA_CLASS_ID + '/comments');
    var questions = await res.json();
    qnaTotal = questions.length;
    document.getElementById('qnaCount').textContent = '(' + qnaTotal + '개)';
    if (questions.length > 0) {
      document.getElementById('qnaEmpty').classList.add('hidden');
      document.getElementById('qnaList').innerHTML = questions.map(function(q) { return renderComment(q, false); }).join('');
    }
  } catch(e) { console.log('Q&A load failed:', e); }
})();
</script>

${footerHTML}
${modalsHTML}
${globalScripts}
</body></html>`
  return c.html(applyBranding(html, c.env))
})

// ==================== Student Mypage ====================
app.get('/mypage', async (c) => {

  const html = `${headHTML}
<body class="bg-gray-50 min-h-screen">
${navHTML}

<!-- 프로필 헤더 -->
<section class="bg-white border-b border-gray-100">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 py-6">
    <div class="flex items-center gap-4">
      <div id="profileAvatar" class="w-14 h-14 bg-gradient-to-br from-primary-400 to-primary-600 rounded-full flex items-center justify-center shadow-lg shadow-primary-200">
        <span class="text-xl font-bold text-white">?</span>
      </div>
      <div class="flex-1 min-w-0">
        <h1 id="profileName" class="text-lg font-bold text-gray-900">로딩 중...</h1>
        <p id="profileSub" class="text-sm text-gray-400 mt-0.5"></p>
      </div>
      <button onclick="handleLogout()" class="px-4 py-2 text-sm text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-lg transition-all">로그아웃</button>
    </div>
  </div>
</section>

<!-- 다음 수업 알림 (라이브 진행 중이면 강조) -->
<div id="nextLessonBanner" class="hidden">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 py-3">
    <div id="nextLessonContent" class="rounded-xl p-4"></div>
  </div>
</div>

<!-- 코스 목록 -->
<section class="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
  <!-- 수강 중인 수업 -->
  <div id="mypageContent">
    <div class="text-center py-16">
      <div class="w-10 h-10 border-3 border-primary-200 border-t-primary-500 rounded-full animate-spin mx-auto mb-4"></div>
      <p class="text-sm text-gray-400">불러오는 중...</p>
    </div>
  </div>

  <!-- 내 강의 코스 (강사인 경우) -->
  <div id="instructorCoursesSection" class="hidden">
    <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-chalkboard-teacher text-indigo-500 mr-2"></i>내 강의 코스</h2>
    <div id="instructorCoursesContent"></div>
  </div>

  <!-- 내가 듣고 싶은 수업 (학생 입장) -->
  <div id="myRequestsSection" class="hidden">
    <div class="flex items-center gap-2 mb-4">
      <span class="w-7 h-7 bg-amber-100 rounded-lg flex items-center justify-center text-sm">🙋</span>
      <h2 class="text-lg font-bold text-dark-900">내가 듣고 싶은 수업</h2>
      <span class="text-xs text-gray-400">학생으로 요청한 수업</span>
    </div>
    <div id="myRequestsContent"></div>
  </div>

  <!-- 내가 가르치겠다고 지원한 수업 (강사 입장) -->
  <div id="myAppsSection" class="hidden">
    <div class="flex items-center gap-2 mb-4">
      <span class="w-7 h-7 bg-purple-100 rounded-lg flex items-center justify-center text-sm">🎓</span>
      <h2 class="text-lg font-bold text-dark-900">내가 지원한 강의</h2>
      <span class="text-xs text-gray-400">강사로 지원한 수업</span>
    </div>
    <div id="myAppsContent"></div>
  </div>
</section>

<script>
var currentUser = JSON.parse(localStorage.getItem('classin_user') || 'null');
var currentToken = localStorage.getItem('classin_token') || null;
if (!currentUser) {
  window.location.href = '/?login=required';
} else {
  // 프로필 세팅
  var initial = currentUser.name ? currentUser.name.charAt(0) : 'U';
  document.getElementById('profileAvatar').innerHTML = '<span class="text-xl font-bold text-white">' + initial + '</span>';
  document.getElementById('profileName').textContent = currentUser.name + '님';
  document.getElementById('profileSub').textContent = currentUser.email || '';

  // 헤더에 사용자 정보 표시
  var authArea = document.getElementById('authArea');
  if (authArea) {
    var mypageUrl = '/mypage';
    authArea.innerHTML = '<a href="' + mypageUrl + '" class="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-50 transition-all">' +
      '<div class="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">' +
        '<span class="text-sm font-bold text-primary-600">' + initial + '</span>' +
      '</div>' +
      '<span class="text-sm font-medium text-dark-700 hidden sm:block">' + currentUser.name + '</span>' +
    '</a>' +
    '<button onclick="handleLogout()" class="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-50 transition-all">로그아웃</button>';
  }
  loadMyEnrollments();
  loadMyInstructorCourses();
  loadMyClassRequests();
  loadMyApplications();
}

function handleLogout() {
  localStorage.removeItem('classin_user');
  localStorage.removeItem('classin_token');
  location.href = '/';
}

async function loadMyEnrollments() {
  const res = await fetch('/api/user/'+currentUser.id+'/enrollments-with-lessons');
  const enrollments = await res.json();
  const container = document.getElementById('mypageContent');

  if (!Array.isArray(enrollments) || enrollments.length === 0) {
    container.innerHTML = '<div class="text-center py-20">' +
      '<div class="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-5">' +
        '<i class="fas fa-book-open text-3xl text-gray-300"></i>' +
      '</div>' +
      '<p class="text-lg font-semibold text-gray-500 mb-2">수강 중인 코스가 없어요</p>' +
      '<p class="text-sm text-gray-400 mb-6">관심 있는 코스를 둘러보세요</p>' +
      '<a href="/categories" class="inline-flex items-center gap-2 px-6 py-3 bg-primary-500 text-white font-semibold rounded-xl hover:bg-primary-600 transition-all shadow-lg shadow-primary-200">' +
        '<i class="fas fa-search"></i>코스 둘러보기</a>' +
    '</div>';
    return;
  }

  // 가장 가까운 라이브/예정 수업 찾기 (배너용)
  var nextLesson = null;
  var nextCourse = null;
  var now = Date.now();
  enrollments.forEach(function(e) {
    if (!e.lessons) return;
    e.lessons.forEach(function(lesson) {
      var start = new Date(lesson.scheduled_at).getTime();
      var end = start + (lesson.duration_minutes || 60) * 60 * 1000;
      if (end > now && lesson.session_id) {
        if (!nextLesson || start < new Date(nextLesson.scheduled_at).getTime()) {
          nextLesson = lesson;
          nextCourse = e;
        }
      }
    });
  });

  // 다음 수업 배너 표시
  if (nextLesson) {
    var banner = document.getElementById('nextLessonBanner');
    var content = document.getElementById('nextLessonContent');
    var start = new Date(nextLesson.scheduled_at).getTime();
    var end = start + (nextLesson.duration_minutes || 60) * 60 * 1000;
    var isLive = start <= now && now < end;
    var dateStr = new Date(nextLesson.scheduled_at).toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', month:'long', day:'numeric', weekday:'short', hour:'2-digit', minute:'2-digit' });

    if (isLive) {
      content.className = 'rounded-xl p-4 bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-lg shadow-red-200';
      content.innerHTML = '<div class="flex items-center justify-between gap-3">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2 mb-1"><span class="w-2 h-2 bg-white rounded-full animate-pulse"></span><span class="text-xs font-bold opacity-90">LIVE 진행중</span></div>' +
          '<p class="font-bold truncate">' + (nextLesson.lesson_title || nextCourse.title) + '</p>' +
          '<p class="text-sm opacity-80">' + nextCourse.instructor_name + '</p>' +
        '</div>' +
        '<a href="/api/classin/enter/' + nextLesson.session_id + '?redirect=true" target="_blank" class="flex-shrink-0 px-5 py-3 bg-white text-red-600 font-bold rounded-xl hover:bg-red-50 transition-all text-sm shadow-lg">' +
          '<i class="fas fa-door-open mr-1.5"></i>입장하기</a>' +
      '</div>';
    } else {
      content.className = 'rounded-xl p-4 bg-gradient-to-r from-blue-500 to-indigo-500 text-white shadow-lg shadow-blue-200';
      content.innerHTML = '<div class="flex items-center justify-between gap-3">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2 mb-1"><i class="far fa-calendar-alt text-xs opacity-80"></i><span class="text-xs font-medium opacity-90">다음 수업</span></div>' +
          '<p class="font-bold truncate">' + (nextLesson.lesson_title || nextCourse.title) + '</p>' +
          '<p class="text-sm opacity-80">' + dateStr + '</p>' +
        '</div>' +
        '<a href="/api/classin/enter/' + nextLesson.session_id + '?redirect=true" target="_blank" class="flex-shrink-0 px-5 py-3 bg-white/20 backdrop-blur text-white font-bold rounded-xl hover:bg-white/30 transition-all text-sm border border-white/30">' +
          '<i class="fas fa-door-open mr-1.5"></i>입장하기</a>' +
      '</div>';
    }
    banner.className = '';
  }

  // 코스 카드 렌더링
  container.innerHTML = '<div class="grid gap-4">' + enrollments.map(function(e) {
    var lessons = e.lessons || [];
    var totalLessons = lessons.length;
    var completedLessons = lessons.filter(function(l) {
      var end = new Date(l.scheduled_at).getTime() + (l.duration_minutes || 60) * 60 * 1000;
      return end < now;
    }).length;
    var progress = totalLessons > 0 ? Math.round(completedLessons / totalLessons * 100) : 0;

    var hasSubscription = e.subscription_status === 'active';
    var subBadge = hasSubscription
      ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-600 text-[11px] font-semibold rounded-full"><i class="fas fa-sync-alt text-[9px]"></i>구독</span>'
      : '';

    // 강의 목록 (최대 5개, 나머지는 접기)
    var lessonsHtml = '';
    if (totalLessons > 0) {
      lessonsHtml = lessons.map(function(lesson, idx) {
        var start = new Date(lesson.scheduled_at).getTime();
        var end = start + (lesson.duration_minutes || 60) * 60 * 1000;
        var isEnded = end < now;
        var isLive = !isEnded && start <= now && now < end;
        var dateStr = new Date(lesson.scheduled_at).toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });

        var icon, statusText, actionHtml;
        if (isEnded) {
          icon = '<div class="w-7 h-7 bg-gray-100 rounded-full flex items-center justify-center flex-shrink-0"><i class="fas fa-check text-gray-400 text-xs"></i></div>';
          statusText = '<span class="text-[11px] text-gray-400">완료</span>';
          actionHtml = lesson.replay_url
            ? '<a href="'+lesson.replay_url+'" target="_blank" class="inline-flex items-center gap-1 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium rounded-lg transition-all"><i class="fas fa-play text-[10px]"></i>다시보기</a>'
            : '';
        } else if (isLive) {
          icon = '<div class="w-7 h-7 bg-red-500 rounded-full flex items-center justify-center flex-shrink-0 shadow-lg shadow-red-200"><span class="w-2 h-2 bg-white rounded-full animate-pulse"></span></div>';
          statusText = '<span class="text-[11px] text-red-500 font-bold">LIVE</span>';
          actionHtml = lesson.session_id
            ? '<a href="/api/classin/enter/'+lesson.session_id+'?redirect=true" target="_blank" class="inline-flex items-center gap-1 px-4 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs font-bold rounded-lg transition-all shadow-md shadow-red-200"><i class="fas fa-door-open text-[10px]"></i>입장</a>'
            : '';
        } else {
          icon = '<div class="w-7 h-7 bg-blue-50 rounded-full flex items-center justify-center flex-shrink-0"><span class="text-[11px] font-bold text-blue-500">'+(idx+1)+'</span></div>';
          statusText = '<span class="text-[11px] text-blue-500">' + dateStr + '</span>';
          actionHtml = lesson.session_id
            ? '<a href="/api/classin/enter/'+lesson.session_id+'?redirect=true" target="_blank" class="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 text-xs font-medium rounded-lg transition-all"><i class="fas fa-door-open text-[10px]"></i>입장</a>'
            : '<span class="text-[11px] text-gray-300">준비중</span>';
        }

        var hiddenClass = idx >= 3 ? ' lesson-hidden-'+e.id+' hidden' : '';

        return '<div class="flex items-center gap-3 py-2.5' + hiddenClass + '">' +
          icon +
          '<div class="flex-1 min-w-0">' +
            '<p class="text-sm font-medium text-gray-700 truncate">' + (lesson.lesson_title || '제목 없음') + '</p>' +
            statusText +
          '</div>' +
          '<div class="flex-shrink-0">' + actionHtml + '</div>' +
        '</div>';
      }).join('<div class="border-b border-gray-50"></div>');

      // 더보기 버튼
      if (totalLessons > 3) {
        lessonsHtml += '<button onclick="toggleLessons('+e.id+')" id="toggleBtn-'+e.id+'" class="w-full mt-2 py-2 text-xs text-gray-400 hover:text-gray-600 transition-all">' +
          '<i class="fas fa-chevron-down mr-1"></i>나머지 ' + (totalLessons - 3) + '개 강의 보기</button>';
      }
    } else {
      lessonsHtml = '<p class="text-sm text-gray-400 text-center py-6">예정된 강의가 없습니다</p>';
    }

    return '<div class="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm hover:shadow-md transition-shadow">' +
      // 코스 헤더
      '<a href="/class/'+e.slug+'" class="flex gap-4 p-4 pb-3 hover:bg-gray-50 transition-colors">' +
        '<img src="'+(e.thumbnail || '')+'" class="w-20 h-20 rounded-xl object-cover flex-shrink-0 bg-gray-100" onerror="this.onerror=null; this.src=&apos;data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22><rect fill=%22%23f3f4f6%22 width=%2280%22 height=%2280%22/><text x=%2240%22 y=%2245%22 font-size=%2220%22 text-anchor=%22middle%22 fill=%22%23d1d5db%22>?</text></svg>&apos;">' +
        '<div class="flex-1 min-w-0 py-1">' +
          '<div class="flex items-center gap-2 mb-1.5">' +
            '<p class="text-base font-bold text-gray-800 truncate">' + e.title + '</p>' +
            subBadge +
          '</div>' +
          '<p class="text-sm text-gray-400 mb-2">' + e.instructor_name + '</p>' +
          // 프로그레스 바
          '<div class="flex items-center gap-2">' +
            '<div class="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">' +
              '<div class="h-full bg-gradient-to-r from-primary-400 to-primary-500 rounded-full transition-all" style="width:' + progress + '%"></div>' +
            '</div>' +
            '<span class="text-[11px] text-gray-400 flex-shrink-0">' + completedLessons + '/' + totalLessons + '강</span>' +
          '</div>' +
        '</div>' +
        '<i class="fas fa-chevron-right text-gray-300 self-center text-sm"></i>' +
      '</a>' +
      // 강의 목록
      '<div class="px-4 pb-4 pt-1 border-t border-gray-50">' +
        lessonsHtml +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function toggleLessons(courseId) {
  var items = document.querySelectorAll('.lesson-hidden-' + courseId);
  var btn = document.getElementById('toggleBtn-' + courseId);
  var isHidden = items[0] && items[0].classList.contains('hidden');
  items.forEach(function(el) { el.classList.toggle('hidden'); });
  // 구분선도 토글
  if (isHidden) {
    btn.innerHTML = '<i class="fas fa-chevron-up mr-1"></i>접기';
  } else {
    btn.innerHTML = '<i class="fas fa-chevron-down mr-1"></i>나머지 ' + items.length + '개 강의 보기';
  }
}

// 내 강의 코스 (강사인 경우)
async function loadMyInstructorCourses() {
  if (!currentUser || (currentUser.role !== 'instructor' && currentUser.is_instructor !== 1)) return;
  try {
    var res = await fetch('/api/user/'+currentUser.id+'/instructor-classes-with-lessons');
    if (!res.ok) return;
    var courses = await res.json();
    if (!Array.isArray(courses) || courses.length === 0) return;

    var section = document.getElementById('instructorCoursesSection');
    var container = document.getElementById('instructorCoursesContent');
    section.classList.remove('hidden');

    container.innerHTML = '<div class="space-y-3">' + courses.map(function(course) {
      var lessonCount = course.lessons ? course.lessons.length : 0;
      var now = Date.now();
      var nextLesson = null;
      if (course.lessons) {
        course.lessons.forEach(function(l) {
          var end = new Date(l.scheduled_at).getTime() + (l.duration_minutes || 60) * 60000;
          if (end > now && l.session_id && (!nextLesson || new Date(l.scheduled_at).getTime() < new Date(nextLesson.scheduled_at).getTime())) {
            nextLesson = l;
          }
        });
      }

      var nextInfo = '';
      if (nextLesson) {
        var start = new Date(nextLesson.scheduled_at).getTime();
        var end = start + (nextLesson.duration_minutes || 60) * 60000;
        var isLive = start <= now && now < end;
        if (isLive) {
          nextInfo = '<a href="/api/classin/enter/' + nextLesson.session_id + '?redirect=true" target="_blank" class="px-3 py-1.5 bg-red-500 text-white text-xs font-bold rounded-lg animate-pulse"><i class="fas fa-door-open mr-1"></i>LIVE</a>';
        } else {
          var dateStr = new Date(nextLesson.scheduled_at).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
          nextInfo = '<span class="text-xs text-gray-400"><i class="far fa-calendar-alt mr-1"></i>' + dateStr + '</span>';
        }
      }

      return '<div class="flex items-center gap-4 p-4 bg-white border border-gray-100 rounded-xl hover:shadow-sm transition">' +
        '<div class="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0"><i class="fas fa-chalkboard-teacher text-indigo-500"></i></div>' +
        '<div class="flex-1 min-w-0">' +
          '<a href="/class/' + course.slug + '" class="text-sm font-bold text-dark-900 hover:text-primary-600 truncate block">' + course.title + '</a>' +
          '<p class="text-xs text-gray-400 mt-0.5">' + lessonCount + '강 · ' + (course.price ? Number(course.price).toLocaleString() + '원' : '무료') + '</p>' +
        '</div>' +
        '<div class="flex items-center gap-2 flex-shrink-0">' +
          nextInfo +
          '<a href="/instructor/classes/' + course.id + '/edit" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium rounded-lg transition"><i class="fas fa-cog mr-1"></i>관리</a>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  } catch(e) { /* silent */ }
}

// 내 수업 요청
async function loadMyClassRequests() {
  try {
    var token = localStorage.getItem('classin_token');
    var res = await fetch('/api/my/class-requests', { headers: { Authorization: 'Bearer ' + token } });
    var data = await res.json();
    if (!data.requests || data.requests.length === 0) return;

    var section = document.getElementById('myRequestsSection');
    var container = document.getElementById('myRequestsContent');
    section.classList.remove('hidden');

    var statusLabels = { open: '모집중', matching: '매칭중', matched: '매칭완료', closed: '마감' };
    var statusColors = { open: 'bg-green-100 text-green-700', matching: 'bg-yellow-100 text-yellow-700', matched: 'bg-blue-100 text-blue-700', closed: 'bg-gray-100 text-gray-500' };

    container.innerHTML = '<div class="space-y-3">' + data.requests.map(function(r) {
      return '<a href="/class-requests/' + r.id + '" class="flex items-center gap-4 p-4 bg-amber-50 border-l-4 border-amber-400 rounded-xl hover:shadow-sm transition block">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2 mb-1">' +
            '<span class="text-[11px] text-amber-600 font-medium">🙋 수업 요청</span>' +
            '<span class="px-2 py-0.5 rounded text-[11px] font-medium ' + (statusColors[r.status] || '') + '">' + (statusLabels[r.status] || r.status) + '</span>' +
          '</div>' +
          '<p class="text-sm font-bold text-dark-900 truncate">' + r.title + '</p>' +
          '<p class="text-xs text-gray-400 mt-0.5">' + (r.pending_applications || 0) + '명 지원 · 관심 ' + (r.interest_count || 0) + '명</p>' +
        '</div>' +
        '<i class="fas fa-chevron-right text-gray-300"></i>' +
      '</a>';
    }).join('') + '</div>';
  } catch(e) { /* silent */ }
}

// 내 지원 현황
async function loadMyApplications() {
  try {
    var token = localStorage.getItem('classin_token');
    var res = await fetch('/api/my/applications', { headers: { Authorization: 'Bearer ' + token } });
    var data = await res.json();
    if (!data.applications || data.applications.length === 0) return;

    var section = document.getElementById('myAppsSection');
    var container = document.getElementById('myAppsContent');
    section.classList.remove('hidden');

    var statusLabels = { draft: '작성중', submitted: '검토중', approved: '승인됨', rejected: '거절됨' };
    var statusColors = { draft: 'bg-gray-100 text-gray-500', submitted: 'bg-yellow-100 text-yellow-700', approved: 'bg-green-100 text-green-700', rejected: 'bg-red-100 text-red-700' };

    container.innerHTML = '<div class="space-y-3">' + data.applications.map(function(a) {
      var classLink = '';
      if (a.status === 'approved' && a.created_class_id) {
        classLink = '<a href="/instructor/classes/' + a.created_class_id + '/edit" class="px-3 py-1.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-600 text-xs font-medium rounded-lg transition"><i class="fas fa-external-link-alt mr-1"></i>수업 관리</a>';
      }

      var errorInfo = '';
      if (a.automation_error) {
        errorInfo = '<p class="text-xs text-red-400 mt-1"><i class="fas fa-exclamation-triangle mr-1"></i>' + a.automation_error + '</p>';
      }
      if (a.admin_note) {
        errorInfo += '<p class="text-xs text-gray-400 mt-1"><i class="fas fa-comment mr-1"></i>' + a.admin_note + '</p>';
      }

      return '<div class="p-4 bg-purple-50 border-l-4 border-purple-400 rounded-xl">' +
        '<div class="flex items-center gap-4">' +
          '<div class="flex-1 min-w-0">' +
            '<div class="flex items-center gap-2 mb-1">' +
              '<span class="text-[11px] text-purple-600 font-medium">🎓 강의 지원</span>' +
              '<span class="px-2 py-0.5 rounded text-[11px] font-medium ' + (statusColors[a.status] || '') + '">' + (statusLabels[a.status] || a.status) + '</span>' +
              '<a href="/class-requests/' + a.request_id + '" class="text-xs text-gray-400 hover:text-primary-500 truncate">' + a.request_title + ' 요청에 지원</a>' +
            '</div>' +
            '<p class="text-sm font-bold text-dark-900 truncate">' + (a.proposed_title || '제목 미정') + '</p>' +
            '<p class="text-xs text-gray-400 mt-0.5">' + (a.proposed_price ? Number(a.proposed_price).toLocaleString() + '원' : '') + '</p>' +
            errorInfo +
          '</div>' +
          '<div class="flex-shrink-0">' + classLink + '</div>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  } catch(e) { /* silent */ }
}
</script>

${footerHTML}
${modalsHTML}
${globalScripts}
</body></html>`
  return c.html(applyBranding(html, c.env))
})

// ==================== Instructor Mypage ====================
// ==================== 강사 수업 편집 페이지 ====================
app.get('/instructor/classes/:id/edit', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.user_id as instructor_user_id, i.display_name as instructor_name, i.bio as instructor_bio, i.specialty as instructor_specialty, cat.name as category_name
    FROM classes c JOIN instructors i ON c.instructor_id = i.id LEFT JOIN categories cat ON c.category_id = cat.id WHERE c.id = ?
  `).bind(classId).first() as any
  if (!cls) return c.html('<h1>수업을 찾을 수 없습니다</h1>', 404)

  const { results: curriculum } = await c.env.DB.prepare('SELECT * FROM lessons WHERE class_id = ? ORDER BY sort_order ASC').bind(classId).all()
  const whatYouLearn = cls.what_you_learn ? cls.what_you_learn.split('|') : []

  // 수강생 목록 조회
  const { results: students } = await c.env.DB.prepare(`
    SELECT e.id as enrollment_id, e.status, e.enrolled_at, e.expires_at,
           u.name, u.email, u.phone
    FROM enrollments e
    JOIN users u ON e.user_id = u.id
    WHERE e.class_id = ?
    ORDER BY e.enrolled_at DESC
  `).bind(classId).all() as any
  const activeStudents = (students || []).filter((s: any) => s.status === 'active')

  const html = `${headHTML}
<body class="bg-gray-50 min-h-screen">
${navHTML}
<main class="max-w-4xl mx-auto px-4 py-8">
  <a href="/class/${cls.slug}" class="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block"><i class="fas fa-arrow-left mr-1"></i>수업 페이지로 돌아가기</a>

  <div class="flex items-center justify-between mb-6">
    <h1 class="text-2xl font-bold text-gray-900">수업 관리</h1>
    <span class="text-sm text-gray-500">${cls.category_name || ''}</span>
  </div>

  <!-- 탭 -->
  <div class="flex border-b mb-6">
    <button onclick="switchTab('info')" id="tab-info" class="px-6 py-3 text-sm font-medium border-b-2 border-primary-500 text-primary-600">기본 정보</button>
    <button onclick="switchTab('students')" id="tab-students" class="px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700">수강생 <span class="ml-1 px-1.5 py-0.5 text-xs bg-primary-100 text-primary-600 rounded-full">${activeStudents.length}</span></button>
    <button onclick="switchTab('profile')" id="tab-profile" class="px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700">프로필</button>
    <button onclick="switchTab('curriculum')" id="tab-curriculum" class="px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700">커리큘럼</button>
    <button onclick="switchTab('thumbnail')" id="tab-thumbnail" class="px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700">썸네일</button>
  </div>

  <!-- 기본 정보 탭 -->
  <div id="panel-info">
    <div class="bg-white rounded-xl border p-6 space-y-5">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">수업 제목</label>
        <input type="text" id="editTitle" value="${(cls.title || '').replace(/"/g, '&quot;')}" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">수업 설명</label>
        <textarea id="editDesc" rows="5" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500">${cls.description || ''}</textarea>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">배울 내용 (줄바꿈으로 구분)</label>
        <textarea id="editLearn" rows="4" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="각 줄에 하나씩 입력하세요">${whatYouLearn.join('\\n')}</textarea>
      </div>
      <button onclick="saveBasicInfo()" class="w-full py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium"><i class="fas fa-save mr-2"></i>저장하기</button>
    </div>
  </div>

  <!-- 수강생 탭 -->
  <div id="panel-students" class="hidden">
    <div class="bg-white rounded-xl border p-6">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-gray-900"><i class="fas fa-users text-primary-500 mr-2"></i>수강생 목록</h3>
        <span class="text-sm text-gray-500">총 ${(students || []).length}명 (활성 ${activeStudents.length}명)</span>
      </div>
      ${(students || []).length === 0
        ? '<div class="text-center py-12 text-gray-400"><i class="fas fa-user-slash text-3xl mb-3"></i><p>아직 수강생이 없습니다.</p></div>'
        : `<div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-200 text-left">
              <th class="pb-3 font-medium text-gray-500">#</th>
              <th class="pb-3 font-medium text-gray-500">이름</th>
              <th class="pb-3 font-medium text-gray-500">이메일</th>
              <th class="pb-3 font-medium text-gray-500">등록일</th>
              <th class="pb-3 font-medium text-gray-500">상태</th>
            </tr>
          </thead>
          <tbody>
            ${(students as any[]).map((s: any, i: number) => {
              const enrollDate = s.enrolled_at ? new Date(s.enrolled_at) : null
              const dateStr = enrollDate ? enrollDate.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'
              const statusClass = s.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
              const statusText = s.status === 'active' ? '수강중' : s.status === 'expired' ? '만료' : s.status || '-'
              return `<tr class="border-b border-gray-100 hover:bg-gray-50">
                <td class="py-3 text-gray-400">${i + 1}</td>
                <td class="py-3 font-medium text-gray-900">${s.name || '이름 없음'}</td>
                <td class="py-3 text-gray-500">${s.email || '-'}</td>
                <td class="py-3 text-gray-500">${dateStr}</td>
                <td class="py-3"><span class="px-2 py-0.5 text-xs font-medium rounded-full ${statusClass}">${statusText}</span></td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  </div>

  <!-- 프로필 탭 -->
  <div id="panel-profile" class="hidden">
    <div class="bg-white rounded-xl border p-6 space-y-5">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">전문 분야</label>
        <input type="text" id="editSpecialty" value="${(cls.instructor_specialty || '').replace(/"/g, '&quot;')}" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="예: 영어 교육, 수학, 프로그래밍">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">자기 소개</label>
        <textarea id="editBio" rows="6" class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="수강생에게 보여질 자기 소개를 작성해주세요">${cls.instructor_bio || ''}</textarea>
      </div>
      <p class="text-xs text-gray-400"><i class="fas fa-info-circle mr-1"></i>이 정보는 수업 상세 페이지의 '러닝퍼실리테이터 소개' 섹션에 표시됩니다.</p>
      <button onclick="saveProfile()" class="w-full py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium"><i class="fas fa-save mr-2"></i>프로필 저장</button>
    </div>
  </div>

  <!-- 커리큘럼 탭 -->
  <div id="panel-curriculum" class="hidden">
    <div class="bg-white rounded-xl border p-6">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-gray-900">커리큘럼 항목</h3>
        <button onclick="addCurrItem()" class="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm hover:bg-primary-700 transition"><i class="fas fa-plus mr-1"></i>추가</button>
      </div>
      <div id="currList" class="space-y-3">
        ${curriculum.length === 0 ? '<p class="text-gray-400 text-sm py-8 text-center">아직 커리큘럼이 없습니다. 항목을 추가해주세요.</p>' :
          (curriculum as any[]).map((l: any, i: number) => `
          <div class="curr-item border border-gray-200 rounded-lg p-4" data-id="${l.id}">
            <div class="flex items-start gap-3">
              <span class="w-7 h-7 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">${i + 1}</span>
              <div class="flex-1 space-y-2">
                <input type="text" value="${(l.title || '').replace(/"/g, '&quot;')}" class="curr-title w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium" placeholder="강의 제목">
                <textarea class="curr-desc w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600" rows="2" placeholder="강의 설명 (선택)">${l.description || ''}</textarea>
              </div>
              <button onclick="deleteCurrItem(this, ${l.id})" class="text-gray-400 hover:text-red-500 p-1"><i class="fas fa-trash-alt"></i></button>
            </div>
          </div>`).join('')}
      </div>
      <button onclick="saveCurriculum()" class="w-full py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium mt-4"><i class="fas fa-save mr-2"></i>커리큘럼 저장</button>
    </div>
  </div>

  <!-- 썸네일 탭 -->
  <div id="panel-thumbnail" class="hidden">
    <div class="bg-white rounded-xl border p-6">
      <h3 class="font-semibold text-gray-900 mb-4">수업 썸네일</h3>
      <div class="mb-4">
        ${cls.thumbnail
          ? `<img src="${cls.thumbnail}" alt="현재 썸네일" class="w-full max-w-md rounded-lg border">`
          : '<div class="w-full max-w-md h-48 bg-gray-100 rounded-lg border flex items-center justify-center text-gray-400"><i class="fas fa-image text-3xl"></i></div>'}
      </div>
      <div id="dropZone" class="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-primary-400 hover:bg-primary-50 transition cursor-pointer"
        onclick="document.getElementById('thumbFile').click()"
        ondragover="event.preventDefault(); this.classList.add('border-primary-500','bg-primary-50')"
        ondragleave="this.classList.remove('border-primary-500','bg-primary-50')"
        ondrop="event.preventDefault(); this.classList.remove('border-primary-500','bg-primary-50'); uploadThumb(event.dataTransfer.files[0])">
        <i class="fas fa-cloud-upload-alt text-3xl text-gray-400 mb-2"></i>
        <p class="text-sm text-gray-500">클릭하거나 이미지를 드래그하여 업로드</p>
        <p class="text-xs text-gray-400 mt-1">JPG, PNG, WebP (최대 5MB)</p>
      </div>
      <input type="file" id="thumbFile" accept="image/*" class="hidden" onchange="uploadThumb(this.files[0])">
      <div id="uploadProgress" class="hidden mt-3">
        <div class="w-full bg-gray-200 rounded-full h-2"><div id="uploadBar" class="bg-primary-500 h-2 rounded-full transition-all" style="width:0%"></div></div>
        <p id="uploadStatus" class="text-xs text-gray-500 mt-1 text-center">업로드 중...</p>
      </div>
    </div>
  </div>
</main>

${globalScripts}
<script>
const CLASS_ID = ${classId};
var currCounter = ${curriculum.length};

function switchTab(tab) {
  ['info','students','profile','curriculum','thumbnail'].forEach(function(t) {
    document.getElementById('panel-'+t).classList.toggle('hidden', t !== tab);
    var tabBtn = document.getElementById('tab-'+t);
    if (t === tab) {
      tabBtn.classList.add('border-primary-500','text-primary-600');
      tabBtn.classList.remove('border-transparent','text-gray-500');
    } else {
      tabBtn.classList.remove('border-primary-500','text-primary-600');
      tabBtn.classList.add('border-transparent','text-gray-500');
    }
  });
}

async function saveBasicInfo() {
  var token = localStorage.getItem('classin_token');
  var learn = document.getElementById('editLearn').value.split('\\n').filter(function(l){return l.trim()}).join('|');
  var res = await fetch('/api/instructor/classes/' + CLASS_ID, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      title: document.getElementById('editTitle').value,
      description: document.getElementById('editDesc').value,
      whatYouLearn: learn || null
    })
  });
  var data = await res.json();
  if (data.success) alert('저장되었습니다!');
  else alert(data.error || '저장 실패');
}

async function saveProfile() {
  var token = localStorage.getItem('classin_token');
  var res = await fetch('/api/instructor/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      bio: document.getElementById('editBio').value,
      specialty: document.getElementById('editSpecialty').value
    })
  });
  var data = await res.json();
  if (data.success) alert('프로필이 저장되었습니다!');
  else alert(data.error || '저장 실패');
}

function addCurrItem() {
  currCounter++;
  var list = document.getElementById('currList');
  var empty = list.querySelector('p.text-gray-400');
  if (empty) empty.remove();
  var num = list.querySelectorAll('.curr-item').length + 1;
  var div = document.createElement('div');
  div.className = 'curr-item border border-gray-200 rounded-lg p-4';
  div.dataset.id = 'new';
  div.innerHTML = '<div class="flex items-start gap-3">' +
    '<span class="w-7 h-7 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">' + num + '</span>' +
    '<div class="flex-1 space-y-2">' +
    '<input type="text" class="curr-title w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium" placeholder="강의 제목">' +
    '<textarea class="curr-desc w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600" rows="2" placeholder="강의 설명 (선택)"></textarea>' +
    '</div>' +
    '<button onclick="this.closest(\\'.curr-item\\').remove(); renumberCurr()" class="text-gray-400 hover:text-red-500 p-1"><i class="fas fa-trash-alt"></i></button>' +
    '</div>';
  list.appendChild(div);
}

function renumberCurr() {
  document.querySelectorAll('.curr-item').forEach(function(el, i) {
    var num = el.querySelector('span');
    if (num) num.textContent = (i + 1).toString();
  });
}

async function deleteCurrItem(btn, id) {
  if (!confirm('이 항목을 삭제하시겠습니까?')) return;
  var token = localStorage.getItem('classin_token');
  await fetch('/api/instructor/classes/' + CLASS_ID + '/curriculum/' + id, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + token }
  });
  btn.closest('.curr-item').remove();
  renumberCurr();
}

async function saveCurriculum() {
  var token = localStorage.getItem('classin_token');
  var items = document.querySelectorAll('.curr-item');
  // 기존 항목 삭제 후 전체 재생성
  var existingIds = [];
  items.forEach(function(el) { if (el.dataset.id !== 'new') existingIds.push(el.dataset.id); });

  // 모든 항목을 순서대로 저장
  for (var i = 0; i < items.length; i++) {
    var el = items[i];
    var title = el.querySelector('.curr-title').value.trim();
    var desc = el.querySelector('.curr-desc').value.trim();
    if (!title) continue;

    if (el.dataset.id === 'new') {
      var res = await fetch('/api/instructor/classes/' + CLASS_ID + '/curriculum', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ title: title, description: desc })
      });
      var data = await res.json();
      if (data.id) el.dataset.id = data.id;
    } else {
      await fetch('/api/instructor/classes/' + CLASS_ID + '/curriculum/' + el.dataset.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ title: title, description: desc })
      });
    }
  }
  alert('커리큘럼이 저장되었습니다!');
  location.reload();
}

async function uploadThumb(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('5MB 이하 이미지만 업로드 가능합니다.'); return; }

  var progress = document.getElementById('uploadProgress');
  progress.classList.remove('hidden');
  document.getElementById('uploadBar').style.width = '30%';
  document.getElementById('uploadStatus').textContent = '업로드 중...';

  var token = localStorage.getItem('classin_token');
  var fd = new FormData();
  fd.append('file', file);

  try {
    document.getElementById('uploadBar').style.width = '60%';
    var res = await fetch('/api/instructor/classes/' + CLASS_ID + '/thumbnail', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: fd
    });
    var data = await res.json();
    document.getElementById('uploadBar').style.width = '100%';

    if (data.success) {
      document.getElementById('uploadStatus').textContent = '업로드 완료!';
      setTimeout(function() { location.reload(); }, 500);
    } else {
      document.getElementById('uploadStatus').textContent = data.error || '업로드 실패';
    }
  } catch (e) {
    document.getElementById('uploadStatus').textContent = '업로드 실패: ' + e.message;
  }
}
</script>
</body></html>`

  return c.html(html)
})

app.get('/instructor/mypage', (c) => c.redirect('/mypage'))

// 레거시 강사 마이페이지 코드는 /mypage에 통합됨
/* eslint-disable */
const _legacyInstructorMypage_REMOVED = true
if (false) { const _dead = async (c: any) => {
  const html = `${headHTML}
<body class="bg-gray-50 min-h-screen">
${navHTML}

<section class="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
  <!-- 내 강의 코스 (강사로서) -->
  <div class="bg-white rounded-2xl p-6 shadow-lg border border-gray-100">
    <h1 class="text-xl font-bold text-dark-900 mb-6"><i class="fas fa-chalkboard-teacher text-indigo-500 mr-2"></i>내 강의 코스</h1>
    <div id="instructorMypageContent">
      <div class="text-center py-8 text-gray-400">
        <i class="fas fa-spinner fa-spin text-2xl mb-2"></i>
        <p>로딩 중...</p>
      </div>
    </div>
  </div>

  <!-- 수강 중인 수업 (학생으로서) -->
  <div id="enrollmentSection" class="hidden bg-white rounded-2xl p-6 shadow-lg border border-gray-100">
    <h2 class="text-xl font-bold text-dark-900 mb-6"><i class="fas fa-book-reader text-green-500 mr-2"></i>수강 중인 수업</h2>
    <div id="enrollmentContent"></div>
  </div>

  <!-- 내 수업 요청 현황 -->
  <div id="myRequestsSection" class="hidden bg-white rounded-2xl p-6 shadow-lg border border-gray-100">
    <h2 class="text-xl font-bold text-dark-900 mb-6"><i class="fas fa-hand-paper text-amber-500 mr-2"></i>내 수업 요청</h2>
    <div id="myRequestsContent"></div>
  </div>
</section>

<!-- Lesson Create Modal for Instructor -->
<div id="instructorLessonModal" class="fixed inset-0 z-50 hidden overflow-y-auto">
  <div class="absolute inset-0 bg-black/50" onclick="closeInstructorLessonModal()"></div>
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl max-h-[80vh] overflow-y-auto">
    <h3 class="text-lg font-bold mb-4"><i class="fas fa-plus-circle text-indigo-500 mr-2"></i>강의 생성 - <span id="instructorLessonCourseName"></span></h3>
    <input type="hidden" id="instructorLessonClassId">
    <div id="instructorLessonRows" class="space-y-3 mb-4"></div>
    <button onclick="addInstructorLessonRow()" class="w-full py-2 border-2 border-dashed border-gray-300 text-gray-500 hover:border-indigo-400 hover:text-indigo-500 rounded-xl transition-all"><i class="fas fa-plus mr-1"></i>강의 추가</button>
    <div class="flex gap-2 mt-4">
      <button onclick="closeInstructorLessonModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
      <button onclick="submitInstructorLessons()" id="instructorLessonSubmitBtn" class="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold rounded-lg">생성</button>
    </div>
  </div>
</div>

<script>
const _instrUser = JSON.parse(localStorage.getItem('classin_user') || 'null');

if (!_instrUser || (_instrUser.role !== 'instructor' && _instrUser.is_instructor !== 1)) {
  window.location.href = '/mypage';
} else {
  loadInstructorCourses();
  loadInstructorEnrollments();
  loadMyRequests();
}

async function loadInstructorCourses() {
  const container = document.getElementById('instructorMypageContent');

  try {
    const res = await fetch('/api/user/'+_instrUser.id+'/instructor-classes-with-lessons');
    if (!res.ok) {
      container.innerHTML = '<div class="text-center py-12 text-red-400"><i class="fas fa-exclamation-triangle text-4xl mb-3"></i><p class="text-lg">데이터를 불러오는데 실패했습니다</p><p class="text-sm mt-2">오류: '+res.status+'</p></div>';
      return;
    }
    const courses = await res.json();

    if (!Array.isArray(courses) || courses.length === 0) {
      container.innerHTML = '<div class="text-center py-12 text-gray-400"><i class="fas fa-chalkboard text-4xl mb-3"></i><p class="text-lg">담당 코스가 없습니다</p></div>';
      return;
    }

  container.innerHTML = courses.map(course => {
    const lessonsHtml = course.lessons && course.lessons.length > 0 ? course.lessons.map((lesson, idx) => {
      const safeLessonTitle = (lesson.lesson_title || '').replace(/'/g, "\\\\'");

      // 녹화 강의인 경우 (lesson_type이 'recorded'이거나 stream_uid가 있으면)
      if (lesson.lesson_type === 'recorded' || lesson.stream_uid) {
        const isProcessing = lesson.status === 'processing';
        const statusBadge = isProcessing
          ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-[10px] font-medium rounded-full">처리중</span>'
          : '<span class="px-2 py-0.5 bg-purple-100 text-purple-700 text-[10px] font-medium rounded-full"><i class="fas fa-video mr-1"></i>녹화</span>';
        const actionBtn = isProcessing
          ? '<button onclick="checkLessonStatus('+lesson.id+')" class="px-3 py-1 bg-yellow-500 hover:bg-yellow-600 text-white text-xs font-medium rounded-lg"><i class="fas fa-sync-alt mr-1"></i>상태 확인</button>'
          : '<button onclick="openWatchWindow('+lesson.id+')" class="px-3 py-1 bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium rounded-lg"><i class="fas fa-play mr-1"></i>강의 보기</button>';
        const deleteBtn = '<button onclick="deleteInstructorLesson('+lesson.id+', \\\''+safeLessonTitle+'\\\', true)" class="ml-2 text-red-400 hover:text-red-600" title="강의 삭제"><i class="fas fa-trash-alt text-xs"></i></button>';
        const durationStr = lesson.duration_minutes ? lesson.duration_minutes + '분' : '-';

        return '<div class="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">' +
          '<span class="w-6 h-6 bg-purple-500 text-white text-xs font-bold rounded-full flex items-center justify-center">'+(idx+1)+'</span>' +
          '<div class="flex-1 min-w-0">' +
            '<p class="text-sm font-medium text-dark-700 truncate">'+(lesson.lesson_title || '제목 없음')+'</p>' +
            '<p class="text-xs text-gray-400">녹화 강의 · '+durationStr+'</p>' +
          '</div>' +
          '<div class="flex items-center gap-2">' + statusBadge + actionBtn + deleteBtn + '</div>' +
        '</div>';
      }

      // 라이브 강의인 경우
      const now = Date.now();
      const startTime = new Date(lesson.scheduled_at).getTime();
      const endTime = startTime + (lesson.duration_minutes || 60) * 60 * 1000;
      const isEnded = endTime < now;
      const isLive = !isEnded && startTime <= now && now < endTime;

      const dateStr = new Date(lesson.scheduled_at).toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });

      let statusBadge, actionBtn, deleteBtn;
      if (isEnded) {
        statusBadge = '<span class="px-2 py-0.5 bg-gray-200 text-gray-600 text-[10px] font-medium rounded-full">완료</span>';
        actionBtn = lesson.replay_url
          ? '<a href="'+lesson.replay_url+'" target="_blank" class="px-3 py-1 bg-green-500 hover:bg-green-600 text-white text-xs font-medium rounded-lg">다시보기</a>'
          : '<span class="text-gray-400 text-xs">-</span>';
        deleteBtn = '';
      } else if (isLive) {
        statusBadge = '<span class="px-2 py-0.5 bg-red-500 text-white text-[10px] font-medium rounded-full animate-pulse">진행중</span>';
        actionBtn = '<a href="/api/classin/instructor-enter/'+lesson.id+'?redirect=true" target="_blank" class="px-3 py-1 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded-lg">강의실 입장</a>';
        deleteBtn = '';
      } else {
        statusBadge = '<span class="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-medium rounded-full">예정</span>';
        actionBtn = '<a href="/api/classin/instructor-enter/'+lesson.id+'?redirect=true" target="_blank" class="px-3 py-1 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg">강의실 입장</a>';
        deleteBtn = '<button onclick="deleteInstructorLesson('+lesson.id+', \\\''+safeLessonTitle+'\\\')" class="ml-2 text-red-400 hover:text-red-600" title="강의 삭제"><i class="fas fa-trash-alt text-xs"></i></button>';
      }

      return '<div class="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0 '+(isEnded ? 'opacity-60' : '')+'">' +
        '<span class="w-6 h-6 '+(isEnded ? 'bg-gray-300' : isLive ? 'bg-red-500' : 'bg-indigo-500')+' text-white text-xs font-bold rounded-full flex items-center justify-center">'+(idx+1)+'</span>' +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-sm font-medium text-dark-700 truncate">'+(lesson.lesson_title || '제목 없음')+'</p>' +
          '<p class="text-xs text-gray-400">'+dateStr+' · '+lesson.duration_minutes+'분</p>' +
        '</div>' +
        '<div class="flex items-center gap-2">' + statusBadge + actionBtn + deleteBtn + '</div>' +
      '</div>';
    }).join('') : '<p class="text-sm text-gray-400 text-center py-4">예정된 강의가 없습니다</p>';

    const safeTitle = (course.title || '').replace(/'/g, "\\\\'").replace(/"/g, '&quot;');

    return '<div class="mb-6 last:mb-0 p-4 bg-gray-50 rounded-xl border border-gray-100">' +
      '<div class="flex gap-4 mb-4">' +
        '<img src="'+(course.thumbnail || '')+'" class="w-24 h-16 rounded-lg object-cover flex-shrink-0 bg-gray-200" onerror="this.onerror=null; this.style.display=&apos;none&apos;">' +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-base font-bold text-dark-800 truncate">'+course.title+'</p>' +
          '<p class="text-sm text-gray-500">'+(course.category_name || '')+'</p>' +
          '<p class="text-xs text-gray-400 mt-1">수강생 '+(course.active_students || 0)+'명</p>' +
        '</div>' +
        '<button onclick="openInstructorLessonModal('+course.id+', \\\''+safeTitle+'\\\')" class="h-8 px-3 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold rounded-lg flex items-center gap-1"><i class="fas fa-plus"></i>강의 생성</button>' +
      '</div>' +
      '<div class="bg-white rounded-lg p-3 border border-gray-100">' +
        '<h4 class="text-sm font-semibold text-dark-700 mb-2"><i class="fas fa-list-ol text-indigo-400 mr-1"></i>강의 목록</h4>' +
        lessonsHtml +
      '</div>' +
    '</div>';
  }).join('');
  } catch (err) {
    console.error('loadInstructorCourses error:', err);
    container.innerHTML = '<div class="text-center py-12 text-red-400"><i class="fas fa-exclamation-triangle text-4xl mb-3"></i><p class="text-lg">데이터를 불러오는데 실패했습니다</p><p class="text-sm mt-2">오류 발생</p></div>';
  }
}

// Instructor Lesson Modal functions
let instructorLessonRowId = 0;

function openInstructorLessonModal(classId, className) {
  document.getElementById('instructorLessonClassId').value = classId;
  document.getElementById('instructorLessonCourseName').textContent = className;
  document.getElementById('instructorLessonRows').innerHTML = '';
  instructorLessonRowId = 0;
  addInstructorLessonRow();
  document.getElementById('instructorLessonModal').classList.remove('hidden');
}

function closeInstructorLessonModal() {
  document.getElementById('instructorLessonModal').classList.add('hidden');
}

function addInstructorLessonRow() {
  const rowId = ++instructorLessonRowId;
  const now = new Date(Date.now() + 5 * 60 * 1000);
  const defaultDateTime = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + 'T' + String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

  const html = '<div id="lessonRow'+rowId+'" class="p-3 bg-gray-50 rounded-xl border border-gray-200">' +
    '<div class="flex justify-between items-center mb-2">' +
      '<span class="text-sm font-bold text-indigo-600">강의 #'+rowId+'</span>' +
      (rowId > 1 ? '<button onclick="removeInstructorLessonRow('+rowId+')" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>' : '') +
    '</div>' +
    '<input type="text" id="lessonTitle'+rowId+'" placeholder="강의명 (선택)" class="w-full px-3 py-2 mb-2 border border-gray-200 rounded-lg text-sm">' +
    '<input type="datetime-local" id="lessonDateTime'+rowId+'" value="'+defaultDateTime+'" class="w-full px-3 py-2 mb-2 border border-gray-200 rounded-lg text-sm">' +
    '<input type="number" id="lessonDuration'+rowId+'" value="60" min="10" max="240" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" placeholder="강의 시간(분)">' +
  '</div>';

  document.getElementById('instructorLessonRows').insertAdjacentHTML('beforeend', html);
}

function removeInstructorLessonRow(rowId) {
  document.getElementById('lessonRow'+rowId)?.remove();
}

async function submitInstructorLessons() {
  const classId = document.getElementById('instructorLessonClassId').value;
  const lessons = [];

  document.querySelectorAll('[id^="lessonRow"]').forEach(row => {
    const rowId = row.id.replace('lessonRow', '');
    const title = document.getElementById('lessonTitle'+rowId)?.value?.trim();
    const dateTime = document.getElementById('lessonDateTime'+rowId)?.value;
    const duration = parseInt(document.getElementById('lessonDuration'+rowId)?.value) || 60;

    if (dateTime) {
      lessons.push({
        title: title || null,
        scheduledAt: new Date(dateTime).toISOString(),
        durationMinutes: duration
      });
    }
  });

  if (lessons.length === 0) {
    alert('최소 1개의 강의을 입력해주세요.');
    return;
  }

  const btn = document.getElementById('instructorLessonSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>생성 중...';

  try {
    const res = await fetch('/api/instructor/classes/'+classId+'/create-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessons, userId: _instrUser.id })
    });
    const data = await res.json();

    if (data.success) {
      closeInstructorLessonModal();
      alert('강의가 생성되었습니다!');
      loadInstructorCourses();
    } else {
      alert(data.error || '강의 생성 실패');
    }
  } catch (e) {
    alert('강의 생성 중 오류 발생');
  }

  btn.disabled = false;
  btn.innerHTML = '생성';
}

function openWatchWindow(lessonId) {
  window.open('/watch/' + lessonId, 'watchLesson', 'width=1200,height=800');
}

async function checkLessonStatus(lessonId) {
  try {
    const res = await fetch('/api/lessons/' + lessonId + '/check-status', { method: 'POST' });
    const data = await res.json();

    if (data.status === 'ready') {
      alert(data.message || '비디오 처리 완료!');
      loadInstructorCourses(); // 목록 새로고침
    } else if (data.status === 'processing') {
      alert(data.message || '아직 처리 중입니다. 잠시 후 다시 시도해주세요.');
    } else {
      alert(data.error || '상태 확인 실패');
    }
  } catch (e) {
    alert('상태 확인 중 오류가 발생했습니다.');
  }
}

async function deleteInstructorLesson(lessonId, lessonTitle, isRecorded) {
  const confirmMsg = isRecorded
    ? '녹화 강의(' + lessonTitle + ')를 삭제하시겠습니까?'
    : '강의(' + lessonTitle + ')를 삭제하시겠습니까?\\n\\n주의: ClassIn에 등록된 강의도 함께 삭제됩니다.';
  if (!confirm(confirmMsg)) {
    return;
  }

  try {
    const res = await fetch('/api/instructor/lessons/' + lessonId, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: _instrUser.id })
    });
    const data = await res.json();

    if (data.success) {
      alert('강의가 삭제되었습니다.');
      loadInstructorCourses();
    } else {
      alert(data.error || '강의 삭제에 실패했습니다.');
    }
  } catch (e) {
    alert('강의 삭제 중 오류가 발생했습니다.');
  }
}

// 수강 중인 수업 로드 (강사이면서 학생인 경우)
async function loadInstructorEnrollments() {
  try {
    var res = await fetch('/api/user/'+_instrUser.id+'/enrollments-with-lessons');
    var enrollments = await res.json();
    if (!Array.isArray(enrollments) || enrollments.length === 0) return;

    var section = document.getElementById('enrollmentSection');
    var container = document.getElementById('enrollmentContent');
    section.classList.remove('hidden');

    var now = Date.now();
    container.innerHTML = '<div class="space-y-3">' + enrollments.map(function(e) {
      var lessons = e.lessons || [];
      var totalLessons = lessons.length;
      var completedLessons = lessons.filter(function(l) {
        return new Date(l.scheduled_at).getTime() + (l.duration_minutes || 60) * 60000 < now;
      }).length;
      var progress = totalLessons > 0 ? Math.round(completedLessons / totalLessons * 100) : 0;

      // 다음 수업 찾기
      var nextLesson = null;
      lessons.forEach(function(l) {
        var end = new Date(l.scheduled_at).getTime() + (l.duration_minutes || 60) * 60000;
        if (end > now && l.session_id && (!nextLesson || new Date(l.scheduled_at).getTime() < new Date(nextLesson.scheduled_at).getTime())) {
          nextLesson = l;
        }
      });

      var nextInfo = '';
      if (nextLesson) {
        var start = new Date(nextLesson.scheduled_at).getTime();
        var end = start + (nextLesson.duration_minutes || 60) * 60000;
        var isLive = start <= now && now < end;
        if (isLive) {
          nextInfo = '<a href="/api/classin/enter/' + nextLesson.session_id + '?redirect=true" target="_blank" class="px-3 py-1.5 bg-red-500 text-white text-xs font-bold rounded-lg animate-pulse"><i class="fas fa-door-open mr-1"></i>LIVE 입장</a>';
        } else {
          var dateStr = new Date(nextLesson.scheduled_at).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
          nextInfo = '<span class="text-xs text-gray-400"><i class="far fa-calendar-alt mr-1"></i>' + dateStr + '</span>';
        }
      }

      return '<div class="flex items-center gap-4 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition">' +
        '<img src="' + (e.thumbnail || '') + '" class="w-16 h-16 rounded-lg object-cover bg-gray-100 flex-shrink-0">' +
        '<div class="flex-1 min-w-0">' +
          '<a href="/class/' + e.slug + '" class="text-sm font-bold text-dark-900 hover:text-primary-600 truncate block">' + e.title + '</a>' +
          '<p class="text-xs text-gray-400 mt-0.5">' + (e.instructor_name || '') + '</p>' +
          '<div class="flex items-center gap-2 mt-1.5">' +
            '<div class="flex-1 bg-gray-200 rounded-full h-1.5 max-w-32"><div class="bg-green-500 h-1.5 rounded-full" style="width:' + progress + '%"></div></div>' +
            '<span class="text-[11px] text-gray-400">' + completedLessons + '/' + totalLessons + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="flex-shrink-0">' + nextInfo + '</div>' +
      '</div>';
    }).join('') + '</div>';
  } catch(e) { /* silent fail */ }
}

// 내 수업 요청 현황 로드
async function loadMyRequests() {
  try {
    var token = localStorage.getItem('classin_token');
    var res = await fetch('/api/my/class-requests', { headers: { Authorization: 'Bearer ' + token } });
    var data = await res.json();
    if (!data.requests || data.requests.length === 0) return;

    var section = document.getElementById('myRequestsSection');
    var container = document.getElementById('myRequestsContent');
    section.classList.remove('hidden');

    var statusLabels = { open: '모집중', matching: '매칭중', matched: '매칭완료', closed: '마감' };
    var statusColors = { open: 'bg-green-100 text-green-700', matching: 'bg-yellow-100 text-yellow-700', matched: 'bg-blue-100 text-blue-700', closed: 'bg-gray-100 text-gray-500' };

    container.innerHTML = '<div class="space-y-3">' + data.requests.map(function(r) {
      return '<a href="/class-requests/' + r.id + '" class="flex items-center gap-4 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition block">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2 mb-1">' +
            '<span class="px-2 py-0.5 rounded text-[11px] font-medium ' + (statusColors[r.status] || '') + '">' + (statusLabels[r.status] || r.status) + '</span>' +
            (r.category_name ? '<span class="text-[11px] text-gray-400">' + r.category_name + '</span>' : '') +
          '</div>' +
          '<p class="text-sm font-bold text-dark-900 truncate">' + r.title + '</p>' +
          '<p class="text-xs text-gray-400 mt-0.5">' + (r.application_count || 0) + '명 지원 · 관심 ' + (r.interest_count || 0) + '명</p>' +
        '</div>' +
        '<i class="fas fa-chevron-right text-gray-300"></i>' +
      '</a>';
    }).join('') + '</div>';
  } catch(e) { /* silent fail */ }
}
</script>

${footerHTML}
${modalsHTML}
${globalScripts}
</body></html>`
  return c.html(applyBranding(html, c.env))
}}

// ==================== 녹화 강의 시청 페이지 ====================
app.get('/watch/:lessonId', async (c) => {
  const lessonId = parseInt(c.req.param('lessonId'))

  // 강의 정보 조회
  const lesson = await c.env.DB.prepare(`
    SELECT cl.*, c.title as class_title, c.slug as class_slug, c.thumbnail as class_thumbnail,
           c.description as class_description, c.price as course_price,
           i.display_name as instructor_name, i.profile_image as instructor_image,
           i.bio as instructor_bio
    FROM class_lessons cl
    JOIN classes c ON cl.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE cl.id = ?
  `).bind(lessonId).first() as any

  if (!lesson) {
    return c.html('<html><body><h2>강의를 찾을 수 없습니다.</h2></body></html>')
  }

  // lesson_type이 'recorded'이거나 stream_uid가 있으면 녹화 강의로 처리
  if (lesson.lesson_type !== 'recorded' && !lesson.stream_uid) {
    return c.html('<html><body><h2>녹화 강의가 아닙니다.</h2><p><a href="/class/' + lesson.class_slug + '">코스로 이동</a></p></body></html>')
  }

  const isFree = !lesson.course_price

  const html = `${headHTML}
<body class="bg-gray-900 min-h-screen">
<!-- HLS.js 라이브러리 -->
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<div class="max-w-6xl mx-auto px-4 py-6">
  <!-- 헤더 -->
  <div class="flex items-center justify-between mb-4">
    <div class="flex items-center gap-3 text-sm">
      <span class="text-gray-400"><i class="fas fa-clock mr-1"></i>${lesson.duration_minutes || 0}분</span>
      ${isFree ? '<span class="px-2 py-1 bg-green-500/20 text-green-400 rounded-lg text-xs">무료</span>' : ''}
    </div>
    <button onclick="closePlayer()" class="px-4 py-2 flex items-center gap-2 bg-gray-700 hover:bg-red-500 text-gray-300 hover:text-white rounded-lg transition-all font-medium">
      <i class="fas fa-times"></i>
      <span>닫기</span>
    </button>
  </div>

  <!-- 비디오 플레이어 영역 -->
  <div class="bg-black rounded-xl overflow-hidden shadow-2xl mb-6" id="playerContainer">
    <!-- 로딩 상태 -->
    <div id="loadingState" class="aspect-video flex flex-col items-center justify-center text-white">
      <i class="fas fa-spinner fa-spin text-4xl mb-4"></i>
      <p>영상을 불러오는 중...</p>
    </div>

    <!-- 결제 필요 상태 -->
    <div id="paymentRequired" class="aspect-video flex-col items-center justify-center text-white hidden">
      <div class="text-center p-8">
        <i class="fas fa-lock text-6xl text-gray-500 mb-4"></i>
        <h3 class="text-xl font-bold mb-2">결제가 필요한 강의입니다</h3>
        <p class="text-gray-400 mb-6">이 강의를 시청하려면 결제가 필요합니다.</p>
        <div class="flex flex-col gap-3 max-w-xs mx-auto">
          <a href="/class/${lesson.class_slug}" class="px-6 py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-all">
            <i class="fas fa-shopping-cart mr-2"></i>결제하러 가기
          </a>
        </div>
      </div>
    </div>

    <!-- 에러 상태 -->
    <div id="errorState" class="aspect-video flex-col items-center justify-center text-white hidden">
      <i class="fas fa-exclamation-circle text-4xl text-red-500 mb-4"></i>
      <p id="errorMessage">영상을 불러올 수 없습니다.</p>
    </div>

    <!-- 비디오 플레이어 -->
    <video id="videoPlayer" class="w-full aspect-video hidden" controls playsinline poster="${lesson.stream_thumbnail || lesson.class_thumbnail || ''}">
      브라우저가 비디오 재생을 지원하지 않습니다.
    </video>
  </div>

  <!-- 강의 정보 -->
  <div class="bg-gray-800 rounded-xl p-6">
    <div class="flex items-start gap-4 mb-4">
      <img src="${lesson.instructor_image || ''}" class="w-12 h-12 rounded-full border-2 border-gray-700" alt="${lesson.instructor_name}">
      <div>
        <h1 class="text-xl font-bold text-white mb-1">${lesson.lesson_title}</h1>
        <p class="text-gray-400">${lesson.instructor_name} · ${lesson.class_title}</p>
      </div>
    </div>
    <p class="text-gray-300 text-sm">${lesson.class_description || ''}</p>
  </div>
</div>

<script>
// 닫기 버튼 함수
function closePlayer() {
  // 새 창으로 열렸으면 창 닫기, 아니면 이전 페이지로
  if (window.opener) {
    window.close();
  } else {
    window.history.back();
  }
}

(async function() {
  const lessonId = ${lessonId};
  const isFree = ${isFree};

  const loadingState = document.getElementById('loadingState');
  const paymentRequired = document.getElementById('paymentRequired');
  const errorState = document.getElementById('errorState');
  const videoPlayer = document.getElementById('videoPlayer');

  try {
    // 로컬스토리지에서 토큰과 사용자 정보 가져오기
    let token = localStorage.getItem('classin_token');
    const user = JSON.parse(localStorage.getItem('classin_user') || 'null');
    const isAdminOrInstructor = user && (user.role === 'admin' || user.role === 'instructor' || user.is_instructor === 1);

    // 토큰이 없거나 구 형식이면 재로그인 필요
    if (user && (!token || token.startsWith('demo_token_'))) {
      localStorage.removeItem('classin_token');
      localStorage.removeItem('classin_user');
      token = null;
    }

    // 관리자/강사/무료가 아니고 토큰이 없으면 결제 필요
    if (!token && !isFree && !isAdminOrInstructor) {
      loadingState.classList.add('hidden');
      paymentRequired.classList.remove('hidden');
      paymentRequired.classList.add('flex');
      return;
    }

    // 서명된 스트리밍 URL 요청
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const res = await fetch('/api/lessons/' + lessonId + '/stream-url', { headers });
    const data = await res.json();

    if (data.requirePayment) {
      loadingState.classList.add('hidden');
      paymentRequired.classList.remove('hidden');
      paymentRequired.classList.add('flex');
      return;
    }

    // 비디오 처리 중인 경우
    if (data.processing) {
      loadingState.classList.add('hidden');
      errorState.classList.remove('hidden');
      errorState.classList.add('flex');
      const pct = data.pctComplete ? ' (' + Math.round(data.pctComplete) + '%)' : '';
      document.getElementById('errorMessage').innerHTML = '<i class="fas fa-cog fa-spin text-4xl text-blue-400 mb-4"></i><br>비디오 처리 중입니다' + pct + '<br><span class="text-sm text-gray-400 mt-2">잠시 후 새로고침해주세요.</span>';
      return;
    }

    if (data.error || !data.hlsUrl) {
      throw new Error(data.error || '스트리밍 URL을 가져올 수 없습니다.');
    }

    // HLS.js로 비디오 재생
    loadingState.classList.add('hidden');
    videoPlayer.classList.remove('hidden');

    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: function(xhr, url) {
          // Cloudflare Stream은 자동으로 CORS 처리
        }
      });
      hls.loadSource(data.hlsUrl);
      hls.attachMedia(videoPlayer);
      hls.on(Hls.Events.MANIFEST_PARSED, function() {
        console.log('Video manifest loaded');
      });
      hls.on(Hls.Events.ERROR, function(event, data) {
        console.error('HLS Error:', data);
        if (data.fatal) {
          errorState.classList.remove('hidden');
          errorState.classList.add('flex');
          videoPlayer.classList.add('hidden');
          document.getElementById('errorMessage').textContent = '영상 재생 중 오류가 발생했습니다.';
        }
      });
    } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      // iOS Safari는 네이티브 HLS 지원
      videoPlayer.src = data.hlsUrl;
    } else {
      throw new Error('이 브라우저는 HLS 재생을 지원하지 않습니다.');
    }

  } catch (e) {
    console.error('Video load error:', e);
    loadingState.classList.add('hidden');
    errorState.classList.remove('hidden');
    errorState.classList.add('flex');
    document.getElementById('errorMessage').textContent = e.message || '영상을 불러올 수 없습니다.';
  }
})();
</script>

${footerHTML}
</body></html>`

  return c.html(applyBranding(html, c.env))
})

// ==================== ClassIn Classroom Entry Page ====================
app.get('/classroom/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const session = await c.env.DB.prepare(`
    SELECT cs.*, c.title as class_title, c.slug as class_slug, c.thumbnail as class_thumbnail,
           c.description as class_description, c.schedule_start, c.duration_minutes as class_duration,
           c.total_lessons, c.class_type, c.level, c.tags,
           i.display_name as instructor_name, i.profile_image as instructor_image,
           i.bio as instructor_bio, i.specialty as instructor_specialty,
           i.total_students as instructor_total_students, i.rating as instructor_rating, i.verified as instructor_verified
    FROM classin_sessions cs
    JOIN classes c ON cs.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE cs.id = ?
  `).bind(sessionId).first() as any

  if (!session) return c.html('<h1>Session not found</h1>', 404)

  const isDemo = !c.env.CLASSIN_SID
  const scheduledDate = session.schedule_start ? new Date(session.schedule_start) : new Date()
  const now = new Date()
  const isUpcoming = scheduledDate > now
  const timeDiff = scheduledDate.getTime() - now.getTime()
  const daysUntil = Math.max(0, Math.floor(timeDiff / 86400000))
  const hoursUntil = Math.max(0, Math.floor((timeDiff % 86400000) / 3600000))
  const minutesUntil = Math.max(0, Math.floor((timeDiff % 3600000) / 60000))

  const html = `${headHTML}
<body class="bg-gray-50 min-h-screen">
${navHTML}

<!-- Classroom Entry Hero -->
<section class="bg-gradient-to-br from-blue-900 via-dark-900 to-indigo-900 text-white">
  <div class="max-w-5xl mx-auto px-4 sm:px-6 py-10 md:py-16">
    <div class="grid md:grid-cols-2 gap-8 items-center">
      <div>
        <!-- Back link -->
        <a href="/class/${session.class_slug}" class="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white mb-4 transition-colors">
          <i class="fas fa-arrow-left text-xs"></i> 코스로 돌아가기
        </a>
        
        <!-- Status Badge -->
        <div class="flex items-center gap-2 mb-4">
          <span class="px-2.5 py-1 ${session.status === 'live' ? 'bg-red-500 badge-live' : session.status === 'ready' ? 'bg-blue-500' : 'bg-gray-500'} text-white text-xs font-bold rounded-lg">
            <i class="fas ${session.status === 'live' ? 'fa-circle text-[6px] mr-1' : session.status === 'ready' ? 'fa-check-circle mr-1' : 'fa-clock mr-1'}"></i>
            ${session.status === 'live' ? 'LIVE 진행중' : session.status === 'ready' ? '강의 준비 완료' : session.status === 'ended' ? '강의 종료' : '대기중'}
          </span>
          ${isDemo ? '<span class="px-2 py-0.5 bg-yellow-500/20 text-yellow-300 text-[10px] font-bold rounded-lg border border-yellow-500/30">DEMO MODE</span>' : '<span class="px-2 py-0.5 bg-green-500/20 text-green-300 text-[10px] font-bold rounded-lg border border-green-500/30">ClassIn API 연동</span>'}
        </div>
        
        <h1 class="text-2xl md:text-3xl font-bold leading-tight mb-3">${session.session_title}</h1>
        
        <!-- Instructor -->
        <div class="flex items-center gap-3 mb-6">
          <img src="${session.instructor_image}" class="w-10 h-10 rounded-full border-2 border-white/20">
          <div>
            <div class="flex items-center gap-1.5">
              <span class="font-semibold">${session.instructor_name}</span>
              ${session.instructor_verified ? '<i class="fas fa-check-circle text-blue-400 text-sm"></i>' : ''}
            </div>
            <p class="text-sm text-gray-400">${session.instructor_specialty || ''}</p>
          </div>
        </div>
        
        <!-- Schedule countdown -->
        ${isUpcoming ? `
        <div class="bg-white/10 backdrop-blur-sm rounded-2xl p-5 mb-6 border border-white/10">
          <p class="text-sm text-gray-300 mb-3"><i class="fas fa-calendar-alt mr-1"></i>강의 시작까지</p>
          <div class="grid grid-cols-3 gap-4 text-center">
            <div>
              <p class="text-3xl font-extrabold">${daysUntil}</p>
              <p class="text-xs text-gray-400 mt-1">일</p>
            </div>
            <div>
              <p class="text-3xl font-extrabold">${hoursUntil}</p>
              <p class="text-xs text-gray-400 mt-1">시간</p>
            </div>
            <div>
              <p class="text-3xl font-extrabold">${minutesUntil}</p>
              <p class="text-xs text-gray-400 mt-1">분</p>
            </div>
          </div>
          <p class="text-center text-sm text-gray-300 mt-3">
            <i class="far fa-calendar mr-1"></i>
            ${scheduledDate.toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul', year:'numeric', month:'long', day:'numeric', weekday:'long'})}
            ${scheduledDate.toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'})}
          </p>
        </div>
        ` : session.status === 'ended' ? `
        <div class="bg-gray-500/10 backdrop-blur-sm rounded-2xl p-4 mb-6 border border-gray-500/20">
          <div class="flex items-center gap-2">
            <span class="w-5 h-5 bg-green-500 rounded-full flex items-center justify-center"><i class="fas fa-check text-white text-[10px]"></i></span>
            <p class="text-sm font-semibold text-gray-300">강의가 완료되었습니다. 아래 버튼을 눌러 다시 보기하세요.</p>
          </div>
        </div>
        ` : `
        <div class="bg-green-500/10 backdrop-blur-sm rounded-2xl p-4 mb-6 border border-green-500/20">
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-green-500 rounded-full badge-live"></span>
            <p class="text-sm font-semibold text-green-300">강의가 곧 시작됩니다! 아래 버튼을 눌러 입장하세요.</p>
          </div>
        </div>
        `}
        
        <!-- Join Button -->
        <a href="${session.status === 'ended' && session.classin_live_url ? session.classin_live_url : session.classin_join_url}" target="_blank" rel="noopener" class="w-full h-14 ${session.status === 'ended' ? 'bg-green-500 hover:bg-green-600 shadow-green-500/30' : 'bg-blue-500 hover:bg-blue-600 shadow-blue-500/30'} text-white font-bold rounded-2xl transition-all shadow-lg flex items-center justify-center gap-3 text-lg mb-3">
          <i class="fas ${session.status === 'ended' ? 'fa-play-circle' : 'fa-door-open'}"></i>
          ${session.status === 'ended' ? 'ClassIn 강의 다시보기' : 'ClassIn 강의방 입장하기'}
        </a>
        <p class="text-center text-xs text-gray-500">${session.status === 'ended' ? '녹화된 강의 영상을 다시 볼 수 있습니다' : 'ClassIn 앱 또는 웹 브라우저에서 강의가 열립니다'}</p>
      </div>
      
      <!-- Right side: Session Info Card -->
      <div class="bg-white/5 backdrop-blur-sm rounded-2xl p-6 border border-white/10">
        <img src="${session.class_thumbnail}" class="w-full rounded-xl mb-4 aspect-video object-cover">
        
        <h3 class="text-lg font-bold mb-4">강의 정보</h3>
        
        <div class="space-y-3">
          <div class="flex items-center gap-3 text-sm">
            <div class="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center"><i class="fas fa-clock text-blue-400"></i></div>
            <div>
              <p class="text-gray-400 text-xs">강의 시간</p>
              <p class="font-medium">${session.duration_minutes}분</p>
            </div>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <div class="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center"><i class="fas fa-signal text-green-400"></i></div>
            <div>
              <p class="text-gray-400 text-xs">강의 유형</p>
              <p class="font-medium">실시간 라이브 양방향</p>
            </div>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <div class="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center"><i class="fas fa-graduation-cap text-yellow-400"></i></div>
            <div>
              <p class="text-gray-400 text-xs">난이도</p>
              <p class="font-medium">${session.level === 'beginner' ? '입문' : session.level === 'intermediate' ? '중급' : session.level === 'advanced' ? '고급' : '전체 수준'}</p>
            </div>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <div class="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center"><i class="fas fa-book text-purple-400"></i></div>
            <div>
              <p class="text-gray-400 text-xs">총 강의 수</p>
              <p class="font-medium">${session.total_lessons || 0}강</p>
            </div>
          </div>
        </div>
        
        <!-- ClassIn Session Details -->
        <div class="mt-5 pt-5 border-t border-white/10">
          <h4 class="text-sm font-bold text-gray-300 mb-3"><i class="fas fa-link mr-1"></i>ClassIn 세션 정보</h4>
          <div class="bg-white/5 rounded-xl p-3 space-y-2 text-xs">
            <div class="flex justify-between"><span class="text-gray-400">세션 ID</span><span class="font-mono">${session.classin_class_id || 'N/A'}</span></div>
            <div class="flex justify-between"><span class="text-gray-400">코스 ID</span><span class="font-mono">${session.classin_course_id || 'N/A'}</span></div>
            <div class="flex justify-between"><span class="text-gray-400">상태</span><span class="font-medium ${session.status === 'ready' ? 'text-green-400' : 'text-blue-400'}">${session.status === 'ready' ? '준비 완료' : session.status === 'live' ? '진행 중' : session.status}</span></div>
            <div class="flex justify-between"><span class="text-gray-400">모드</span><span class="font-medium ${isDemo ? 'text-yellow-400' : 'text-green-400'}">${isDemo ? '데모 모드' : '프로덕션'}</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Preparation Checklist -->
<section class="max-w-5xl mx-auto px-4 sm:px-6 py-10">
  <div class="grid md:grid-cols-2 gap-6">
    <!-- Before Class -->
    <div class="bg-white rounded-2xl p-6 border border-gray-100">
      <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-clipboard-check text-blue-500 mr-2"></i>강의 전 체크리스트</h2>
      <div class="space-y-3">
        <label class="flex items-start gap-3 p-3 rounded-xl bg-gray-50 cursor-pointer hover:bg-gray-100 transition-all">
          <input type="checkbox" class="mt-0.5 accent-blue-500 w-4 h-4">
          <div>
            <p class="text-sm font-medium text-dark-800">인터넷 연결 확인</p>
            <p class="text-xs text-gray-500">안정적인 Wi-Fi 또는 유선 연결 권장</p>
          </div>
        </label>
        <label class="flex items-start gap-3 p-3 rounded-xl bg-gray-50 cursor-pointer hover:bg-gray-100 transition-all">
          <input type="checkbox" class="mt-0.5 accent-blue-500 w-4 h-4">
          <div>
            <p class="text-sm font-medium text-dark-800">카메라 & 마이크 테스트</p>
            <p class="text-xs text-gray-500">양방향 강의을 위해 카메라와 마이크가 정상 작동하는지 확인</p>
          </div>
        </label>
        <label class="flex items-start gap-3 p-3 rounded-xl bg-gray-50 cursor-pointer hover:bg-gray-100 transition-all">
          <input type="checkbox" class="mt-0.5 accent-blue-500 w-4 h-4">
          <div>
            <p class="text-sm font-medium text-dark-800">ClassIn 앱 설치 (선택)</p>
            <p class="text-xs text-gray-500">더 나은 경험을 위해 <a href="https://www.classin.com/download" target="_blank" class="text-blue-500 underline">ClassIn 앱</a>을 설치하세요</p>
          </div>
        </label>
        <label class="flex items-start gap-3 p-3 rounded-xl bg-gray-50 cursor-pointer hover:bg-gray-100 transition-all">
          <input type="checkbox" class="mt-0.5 accent-blue-500 w-4 h-4">
          <div>
            <p class="text-sm font-medium text-dark-800">필기도구 및 교재 준비</p>
            <p class="text-xs text-gray-500">강의 내용을 메모할 수 있는 도구를 준비하세요</p>
          </div>
        </label>
      </div>
    </div>
    
    <!-- ClassIn Features -->
    <div class="bg-white rounded-2xl p-6 border border-gray-100">
      <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-star text-yellow-500 mr-2"></i>ClassIn 양방향 강의 기능</h2>
      <div class="space-y-4">
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas fa-chalkboard text-blue-500"></i>
          </div>
          <div>
            <p class="text-sm font-semibold text-dark-800">인터랙티브 화이트보드</p>
            <p class="text-xs text-gray-500">선생님과 학생이 함께 사용할 수 있는 실시간 화이트보드</p>
          </div>
        </div>
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas fa-hand-paper text-green-500"></i>
          </div>
          <div>
            <p class="text-sm font-semibold text-dark-800">실시간 질문 & 손들기</p>
            <p class="text-xs text-gray-500">궁금한 점을 바로 질문하고 선생님의 답변을 받으세요</p>
          </div>
        </div>
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 bg-purple-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas fa-users text-purple-500"></i>
          </div>
          <div>
            <p class="text-sm font-semibold text-dark-800">소그룹 토론방</p>
            <p class="text-xs text-gray-500">소그룹으로 나뉘어 토론하고 협력 학습을 진행합니다</p>
          </div>
        </div>
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas fa-record-vinyl text-red-500"></i>
          </div>
          <div>
            <p class="text-sm font-semibold text-dark-800">강의 녹화 & 다시보기</p>
            <p class="text-xs text-gray-500">놓친 부분은 녹화본으로 복습할 수 있습니다</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

${isDemo ? `
<!-- Demo Mode Notice -->
<section class="max-w-5xl mx-auto px-4 sm:px-6 pb-10">
  <div class="bg-yellow-50 border border-yellow-200 rounded-2xl p-6">
    <div class="flex items-start gap-3">
      <div class="w-10 h-10 bg-yellow-100 rounded-xl flex items-center justify-center flex-shrink-0">
        <i class="fas fa-info-circle text-yellow-600 text-lg"></i>
      </div>
      <div>
        <h3 class="text-base font-bold text-yellow-900 mb-2">데모 모드 안내</h3>
        <p class="text-sm text-yellow-800 leading-relaxed mb-3">
          현재 ClassIn API가 데모 모드로 운영 중입니다. 실제 강의방이 생성되지는 않습니다.<br>
          실제 ClassIn 강의방을 자동 생성하려면 다음이 필요합니다:
        </p>
        <div class="bg-yellow-100/50 rounded-xl p-4 space-y-2 text-sm text-yellow-900">
          <p><i class="fas fa-key mr-2 text-yellow-600"></i><strong>CLASSIN_SID</strong> - ClassIn 파트너 학교 ID</p>
          <p><i class="fas fa-lock mr-2 text-yellow-600"></i><strong>CLASSIN_SECRET</strong> - ClassIn API 비밀키</p>
          <p class="text-xs text-yellow-700 mt-2">
            <i class="fas fa-external-link-alt mr-1"></i>
            ClassIn 파트너 신청: <a href="https://www.classin.com/kr/partnership/" target="_blank" class="underline">classin.com/partnership</a>
          </p>
        </div>
        <div class="mt-3 p-3 bg-dark-800 rounded-xl text-xs font-mono text-green-400">
          <p class="text-gray-500"># Cloudflare 환경변수 설정</p>
          <p>npx wrangler secret put CLASSIN_SID</p>
          <p>npx wrangler secret put CLASSIN_SECRET</p>
        </div>
      </div>
    </div>
  </div>
</section>
` : ''}

${footerHTML}
${modalsHTML}
${globalScripts}
</body></html>`
  return c.html(applyBranding(html, c.env))
})

// Helper function for class card template (server-side)
function classCardTemplate(cls: any): string {
  return `
    <a href="/class/${cls.slug}" class="block bg-white rounded-2xl overflow-hidden card-hover border border-gray-100 course-card" data-course-id="${cls.id}">
      <div class="relative aspect-[16/10] overflow-hidden">
        <img src="${cls.thumbnail}" alt="${cls.title}" class="w-full h-full object-cover transition-transform duration-500 hover:scale-105" loading="lazy">
        <span class="enrolled-badge absolute top-2.5 left-2.5 px-2 py-0.5 bg-green-500 text-white text-[10px] font-bold rounded-md hidden"><i class="fas fa-check mr-0.5"></i>수강중</span>
        ${cls.is_bestseller ? '<span class="bestseller-badge absolute top-2.5 left-2.5 px-2 py-0.5 bg-primary-500 text-white text-[10px] font-bold rounded-md">BEST</span>' : ''}
        ${cls.is_new ? '<span class="new-badge absolute top-2.5 left-2.5 px-2 py-0.5 bg-blue-500 text-white text-[10px] font-bold rounded-md">NEW</span>' : ''}
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

// ==================== Admin Authentication ====================

// Simple hash function for password (in production, use bcrypt)
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(16)
}

// Password hashing with PBKDF2 (Web Crypto API)
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256)
  const saltB64 = btoa(String.fromCharCode(...salt))
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
  return `pbkdf2:${saltB64}:${hashB64}`
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('pbkdf2:')) {
    const [, saltB64, hashB64] = storedHash.split(':')
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0))
    const expectedHash = Uint8Array.from(atob(hashB64), c => c.charCodeAt(0))
    const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
    const actualHash = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256))
    if (actualHash.length !== expectedHash.length) return false
    let diff = 0
    for (let i = 0; i < actualHash.length; i++) diff |= actualHash[i] ^ expectedHash[i]
    return diff === 0
  }
  if (storedHash.startsWith('hash_')) {
    return password === storedHash.slice(5)
  }
  if (storedHash.startsWith('pbkdf2_')) {
    return password === storedHash.slice(7)
  }
  return false
}

// JWT helpers with HMAC-SHA256 (Web Crypto API)
function base64urlEncode(data: string): string {
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function base64urlDecode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return atob(s)
}

async function createJWT(payload: Record<string, any>, secret: string): Promise<string> {
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64urlEncode(JSON.stringify(payload))
  const signingInput = `${header}.${body}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput)))
  const signature = base64urlEncode(String.fromCharCode(...sig))
  return `${signingInput}.${signature}`
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, any> | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const signingInput = `${parts[0]}.${parts[1]}`
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const signature = Uint8Array.from(base64urlDecode(parts[2]), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(signingInput))
    if (!valid) return null
    const payload = JSON.parse(base64urlDecode(parts[1]))
    if (payload.exp && payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

// Generate session token
function generateSessionToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return token
}

// Check admin session
async function checkAdminSession(db: D1Database, sessionToken: string | undefined): Promise<boolean> {
  if (!sessionToken) return false

  const session = await db.prepare(`
    SELECT id FROM admin_sessions
    WHERE session_token = ? AND expires_at > datetime('now')
  `).bind(sessionToken).first()

  return !!session
}

// Get session token from cookie
function getSessionToken(c: any): string | undefined {
  const cookie = c.req.header('Cookie') || ''
  const match = cookie.match(/admin_session=([^;]+)/)
  return match ? match[1] : undefined
}

// Admin login page
app.get('/admin/login', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)

  if (isLoggedIn) {
    return c.redirect('/admin')
  }

  const error = c.req.query('error')

  const adminLoginHtml = `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>관리자 로그인 - ClassIn Live</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
  </style>
</head>
<body class="bg-gray-100 min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
    <div class="text-center mb-8">
      <h1 class="text-2xl font-bold text-rose-500 mb-2">ClassIn Live</h1>
      <p class="text-gray-500">관리자 로그인</p>
    </div>

    ${error ? `<div class="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-6 text-sm"><i class="fas fa-exclamation-circle mr-2"></i>${error === 'invalid' ? '아이디 또는 비밀번호가 올바르지 않습니다.' : '로그인이 필요합니다.'}</div>` : ''}

    <form action="/api/admin/login" method="POST">
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">아이디</label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"><i class="fas fa-user"></i></span>
          <input type="text" name="username" required class="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-rose-500 focus:border-transparent" placeholder="enter id">
        </div>
      </div>
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">비밀번호</label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"><i class="fas fa-lock"></i></span>
          <input type="password" name="password" required class="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-rose-500 focus:border-transparent" placeholder="••••••••">
        </div>
      </div>
      <button type="submit" class="w-full bg-rose-500 hover:bg-rose-600 text-white py-3 rounded-xl font-medium transition-all">
        <i class="fas fa-sign-in-alt mr-2"></i>로그인
      </button>
    </form>

    <p class="text-center text-sm text-gray-400 mt-6">
      <a href="/" class="hover:text-gray-600"><i class="fas fa-arrow-left mr-1"></i>메인으로 돌아가기</a>
    </p>
  </div>
</body>
</html>
  `
  return c.html(applyBranding(adminLoginHtml, c.env))
})

// Admin login API
app.post('/api/admin/login', async (c) => {
  const formData = await c.req.parseBody()
  const username = formData.username as string
  const password = formData.password as string

  // Get stored credentials
  const storedUsername = await c.env.DB.prepare(
    "SELECT setting_value FROM admin_settings WHERE setting_key = 'admin_username'"
  ).first() as any

  const storedPassword = await c.env.DB.prepare(
    "SELECT setting_value FROM admin_settings WHERE setting_key = 'admin_password_hash'"
  ).first() as any

  if (!storedUsername || !storedPassword) {
    return c.redirect('/admin/login?error=invalid')
  }

  // Check credentials (compare plain text for initial, hash for changed password)
  const isValidPassword = password === storedPassword.setting_value ||
                          simpleHash(password) === storedPassword.setting_value

  if (username !== storedUsername.setting_value || !isValidPassword) {
    return c.redirect('/admin/login?error=invalid')
  }

  // Create session
  const sessionToken = generateSessionToken()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours

  await c.env.DB.prepare(`
    INSERT INTO admin_sessions (session_token, expires_at) VALUES (?, ?)
  `).bind(sessionToken, expiresAt).run()

  // Clean up old sessions
  await c.env.DB.prepare(`
    DELETE FROM admin_sessions WHERE expires_at < datetime('now')
  `).run()

  // Set cookie and redirect
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/admin',
      'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
    }
  })
})

// Admin logout
app.get('/admin/logout', async (c) => {
  const sessionToken = getSessionToken(c)

  if (sessionToken) {
    await c.env.DB.prepare('DELETE FROM admin_sessions WHERE session_token = ?').bind(sessionToken).run()
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/admin/login',
      'Set-Cookie': 'admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
    }
  })
})

// Change admin password API
app.post('/api/admin/change-password', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)

  if (!isLoggedIn) {
    return c.json({ error: '로그인이 필요합니다.' }, 401)
  }

  const { currentPassword, newPassword } = await c.req.json()

  if (!currentPassword || !newPassword) {
    return c.json({ error: '현재 비밀번호와 새 비밀번호를 입력해주세요.' }, 400)
  }

  if (newPassword.length < 6) {
    return c.json({ error: '새 비밀번호는 6자 이상이어야 합니다.' }, 400)
  }

  // Verify current password
  const storedPassword = await c.env.DB.prepare(
    "SELECT setting_value FROM admin_settings WHERE setting_key = 'admin_password_hash'"
  ).first() as any

  const isValidPassword = currentPassword === storedPassword.setting_value ||
                          simpleHash(currentPassword) === storedPassword.setting_value

  if (!isValidPassword) {
    return c.json({ error: '현재 비밀번호가 올바르지 않습니다.' }, 400)
  }

  // Update password (store as hash)
  await c.env.DB.prepare(`
    UPDATE admin_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE setting_key = 'admin_password_hash'
  `).bind(simpleHash(newPassword)).run()

  return c.json({ success: true, message: '비밀번호가 변경되었습니다.' })
})

// ==================== Image Upload API ====================

app.post('/api/admin/upload-image', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)

  if (!isLoggedIn) {
    return c.json({ error: '로그인이 필요합니다.' }, 401)
  }

  try {
    const formData = await c.req.formData()
    const file = formData.get('image') as File

    if (!file) {
      return c.json({ error: '이미지 파일이 필요합니다.' }, 400)
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      return c.json({ error: '지원하지 않는 이미지 형식입니다. (JPEG, PNG, GIF, WebP만 가능)' }, 400)
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      return c.json({ error: '이미지 크기는 5MB 이하여야 합니다.' }, 400)
    }

    // Generate unique filename
    const ext = file.name.split('.').pop() || 'jpg'
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 8)
    const filename = 'thumbnails/' + timestamp + '-' + randomStr + '.' + ext

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer()
    await c.env.IMAGES.put(filename, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
      },
    })

    // Return the URL
    const imageUrl = '/api/images/' + filename

    return c.json({ success: true, url: imageUrl, filename })
  } catch (error) {
    console.error('Image upload error:', error)
    return c.json({ error: '이미지 업로드 중 오류가 발생했습니다.' }, 500)
  }
})

// Serve images from R2
app.get('/api/images/*', async (c) => {
  const path = c.req.path.replace('/api/images/', '')

  try {
    const object = await c.env.IMAGES.get(path)

    if (!object) {
      return c.json({ error: 'Image not found' }, 404)
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'public, max-age=31536000')

    return new Response(object.body, { headers })
  } catch (error) {
    console.error('Image serve error:', error)
    return c.json({ error: 'Failed to serve image' }, 500)
  }
})

// Upload material files (PDF, DOCX, etc.) to R2
app.post('/api/admin/upload-material', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)
  if (!isLoggedIn) return c.json({ error: '로그인이 필요합니다.' }, 401)

  try {
    const formData = await c.req.formData()
    const file = formData.get('file') as File
    if (!file) return c.json({ error: '파일이 필요합니다.' }, 400)

    const allowedTypes = [
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/haansofthwp', 'application/x-hwp',
      'application/zip', 'application/x-zip-compressed',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'
    ]
    const allowedExts = ['pdf','doc','docx','ppt','pptx','hwp','zip','xls','xlsx','txt']
    const ext = (file.name.split('.').pop() || '').toLowerCase()

    if (!allowedTypes.includes(file.type) && !allowedExts.includes(ext)) {
      return c.json({ error: '지원하지 않는 파일 형식입니다. (PDF, DOCX, PPTX, HWP, ZIP, XLS, TXT 가능)' }, 400)
    }
    if (file.size > 50 * 1024 * 1024) {
      return c.json({ error: '파일 크기는 50MB 이하여야 합니다.' }, 400)
    }

    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 8)
    const filename = 'materials/' + timestamp + '-' + randomStr + '.' + ext

    const arrayBuffer = await file.arrayBuffer()
    await c.env.IMAGES.put(filename, arrayBuffer, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    })

    return c.json({ success: true, url: '/api/materials/' + filename, filename: file.name })
  } catch (error) {
    console.error('Material upload error:', error)
    return c.json({ error: '파일 업로드 중 오류가 발생했습니다.' }, 500)
  }
})

// Serve material files from R2
app.get('/api/materials/*', async (c) => {
  const path = c.req.path.replace('/api/materials/', '')
  try {
    const object = await c.env.IMAGES.get(path)
    if (!object) return c.json({ error: 'File not found' }, 404)

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Cache-Control', 'public, max-age=31536000')
    return new Response(object.body, { headers })
  } catch (error) {
    return c.json({ error: 'Failed to serve file' }, 500)
  }
})

// ==================== Course Materials API ====================

// Get course-level materials
app.get('/api/admin/classes/:classId/materials', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)
  if (!isLoggedIn) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const classId = parseInt(c.req.param('classId'))
  const cls = await c.env.DB.prepare('SELECT materials FROM classes WHERE id = ?')
    .bind(classId).first()
  if (!cls) return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)

  let materials = []
  try { materials = JSON.parse(cls.materials || '[]') } catch(e) {}
  return c.json({ materials })
})

// Update course-level materials
app.post('/api/admin/classes/:classId/materials', async (c) => {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)
  if (!isLoggedIn) return c.json({ error: '로그인이 필요합니다.' }, 401)

  const classId = parseInt(c.req.param('classId'))
  const { materials } = await c.req.json()

  const cls = await c.env.DB.prepare('SELECT id FROM classes WHERE id = ?')
    .bind(classId).first()
  if (!cls) return c.json({ error: '코스를 찾을 수 없습니다.' }, 404)

  await c.env.DB.prepare('UPDATE classes SET materials = ?, updated_at = datetime("now") WHERE id = ?')
    .bind(JSON.stringify(materials || []), classId).run()

  return c.json({ success: true, materials })
})

// ==================== Admin Page - Virtual Account Management ====================

// Auth check helper for admin pages
async function requireAdminAuth(c: any): Promise<Response | null> {
  const sessionToken = getSessionToken(c)
  const isLoggedIn = await checkAdminSession(c.env.DB, sessionToken)

  if (!isLoggedIn) {
    return c.redirect('/admin/login?error=required')
  }
  return null
}

app.get('/admin', async (c) => {
  const authRedirect = await requireAdminAuth(c)
  if (authRedirect) return authRedirect

  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClassIn Live 관리자 - 가상 계정 관리</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
  </style>
</head>
<body class="bg-gray-100 min-h-screen">
  <!-- Header -->
  <nav class="bg-gray-900 text-white shadow-lg">
    <div class="max-w-7xl mx-auto px-4 py-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <a href="/" class="text-xl font-bold text-rose-400">ClassIn Live</a>
          <span class="text-gray-400">|</span>
          <span class="text-gray-300">관리자 대시보드</span>
        </div>
        <div class="flex items-center gap-4">
          <button onclick="openSettingsModal()" class="text-sm text-gray-400 hover:text-white"><i class="fas fa-cog mr-1"></i>설정</button>
          <a href="/admin/logout" class="text-sm text-gray-400 hover:text-white"><i class="fas fa-sign-out-alt mr-1"></i>로그아웃</a>
        </div>
      </div>
    </div>
  </nav>

  <div class="max-w-7xl mx-auto px-4 py-8">
    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8" id="statsCards">
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-users text-blue-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statTotal">0</p>
            <p class="text-sm text-gray-500">전체 계정</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-check-circle text-green-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statAvailable">0</p>
            <p class="text-sm text-gray-500">사용 가능</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-user-check text-purple-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statAssigned">0</p>
            <p class="text-sm text-gray-500">할당됨</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-rose-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-cloud-upload-alt text-rose-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statRegistered">0</p>
            <p class="text-sm text-gray-500">ClassIn 등록됨</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Class Matching Management Link -->
    <div class="bg-white rounded-xl p-6 shadow-sm mb-8">
      <a href="/admin/applications" class="flex items-center justify-between hover:bg-gray-50 -m-6 p-6 rounded-xl transition-all">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-handshake text-purple-500 text-xl"></i>
          </div>
          <div>
            <h2 class="text-lg font-bold text-gray-800">수업 매칭 관리</h2>
            <p class="text-sm text-gray-500">수업 요청 지원 검토 및 승인</p>
          </div>
        </div>
        <i class="fas fa-chevron-right text-gray-400"></i>
      </a>
    </div>

    <!-- Homepage Management Link -->
    <div class="bg-white rounded-xl p-6 shadow-sm mb-8">
      <a href="/admin/homepage" class="flex items-center justify-between hover:bg-gray-50 -m-6 p-6 rounded-xl transition-all">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-rose-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-home text-rose-500 text-xl"></i>
          </div>
          <div>
            <h2 class="text-lg font-bold text-gray-800">홈페이지 관리</h2>
            <p class="text-sm text-gray-500">메인 페이지 코스 배치 및 순서 관리</p>
          </div>
        </div>
        <i class="fas fa-chevron-right text-gray-400"></i>
      </a>
    </div>

    <!-- Orders Management Link -->
    <div class="bg-white rounded-xl p-6 shadow-sm mb-8">
      <a href="/admin/orders" class="flex items-center justify-between hover:bg-gray-50 -m-6 p-6 rounded-xl transition-all">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-credit-card text-green-500 text-xl"></i>
          </div>
          <div>
            <h2 class="text-lg font-bold text-gray-800">결제 관리</h2>
            <p class="text-sm text-gray-500">결제 내역 조회 및 취소</p>
          </div>
        </div>
        <i class="fas fa-chevron-right text-gray-400"></i>
      </a>
    </div>

    <!-- Initialize Accounts Section -->
    <div class="bg-white rounded-xl p-6 shadow-sm mb-8">
      <h2 class="text-lg font-bold text-gray-800 mb-4"><i class="fas fa-plus-circle text-blue-500 mr-2"></i>가상 계정 일괄 생성</h2>
      <div class="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div>
          <label class="block text-sm text-gray-600 mb-1">시작 UID</label>
          <input type="text" id="startUid" value="0065-20000531700" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">끝 UID</label>
          <input type="text" id="endUid" value="0065-20000531999" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">SID (학교 ID)</label>
          <input type="text" id="sid" value="67406208" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">만료일</label>
          <input type="datetime-local" id="expiresAt" value="2028-03-11T00:00" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500">
        </div>
        <div class="flex items-end">
          <button onclick="initAccounts()" class="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded-lg transition-all">
            <i class="fas fa-database mr-1"></i>계정 생성
          </button>
        </div>
      </div>
      <p class="text-xs text-gray-400 mt-3"><i class="fas fa-info-circle mr-1"></i>범위 내의 모든 UID를 데이터베이스에 등록합니다. 이미 존재하는 UID는 건너뜁니다.</p>
    </div>

    <!-- Account List (Collapsible) -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="p-6 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors" onclick="toggleAccountList()">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <i id="accountListToggleIcon" class="fas fa-chevron-right text-gray-400 transition-transform"></i>
            <h2 class="text-lg font-bold text-gray-800"><i class="fas fa-list text-purple-500 mr-2"></i>가상 계정 목록</h2>
            <span id="accountListSummary" class="text-sm text-gray-500"></span>
          </div>
          <div class="flex items-center gap-2" onclick="event.stopPropagation()">
            <select id="filterStatus" onchange="loadAccounts()" class="px-3 py-2 border border-gray-200 rounded-lg text-sm">
              <option value="">전체</option>
              <option value="available">사용 가능</option>
              <option value="assigned">할당됨</option>
              <option value="expired">만료됨</option>
            </select>
            <button onclick="loadAccounts()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg transition-all">
              <i class="fas fa-sync-alt"></i>
            </button>
          </div>
        </div>
      </div>
      <div id="accountListContent" class="hidden">
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">계정 UID</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">상태</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ClassIn 등록</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">할당된 사용자</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">비밀번호</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">만료일</th>
                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">작업</th>
              </tr>
            </thead>
            <tbody id="accountsTable" class="divide-y divide-gray-100">
              <tr><td colspan="7" class="px-6 py-8 text-center text-gray-400">로딩 중...</td></tr>
            </tbody>
          </table>
        </div>
        <div class="p-4 border-t border-gray-100 flex items-center justify-between">
          <p class="text-sm text-gray-500" id="paginationInfo">-</p>
          <div class="flex items-center gap-2">
            <button onclick="prevPage()" class="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50">이전</button>
            <button onclick="nextPage()" class="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50">다음</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick Links -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-8">
      <a href="/admin/users" class="bg-white rounded-xl p-6 shadow-sm hover:shadow-md transition-all group">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            <div class="w-14 h-14 bg-emerald-100 rounded-xl flex items-center justify-center group-hover:bg-emerald-200 transition-all">
              <i class="fas fa-users text-emerald-500 text-2xl"></i>
            </div>
            <div>
              <h3 class="text-lg font-bold text-gray-800">회원 관리</h3>
              <p class="text-sm text-gray-500">회원 조회, 검색, 삭제</p>
            </div>
          </div>
          <i class="fas fa-chevron-right text-gray-300 group-hover:text-emerald-500 transition-all"></i>
        </div>
      </a>
      <a href="/admin/enrollments" class="bg-white rounded-xl p-6 shadow-sm hover:shadow-md transition-all group">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            <div class="w-14 h-14 bg-orange-100 rounded-xl flex items-center justify-center group-hover:bg-orange-200 transition-all">
              <i class="fas fa-user-graduate text-orange-500 text-2xl"></i>
            </div>
            <div>
              <h3 class="text-lg font-bold text-gray-800">수강신청자 관리</h3>
              <p class="text-sm text-gray-500">코스별 수강생 관리, 수강 종료</p>
            </div>
          </div>
          <i class="fas fa-chevron-right text-gray-300 group-hover:text-orange-500 transition-all"></i>
        </div>
      </a>
    </div>

    <!-- Instructor Management Section -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden mt-8">
      <div class="p-6 border-b border-gray-100">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-bold text-gray-800"><i class="fas fa-chalkboard-teacher text-indigo-500 mr-2"></i>강사 관리</h2>
          <div class="flex items-center gap-2">
            <button onclick="openAddInstructorModal()" class="bg-indigo-500 hover:bg-indigo-600 text-white px-4 py-2 rounded-lg transition-all text-sm">
              <i class="fas fa-plus mr-1"></i>강사 추가
            </button>
            <button onclick="loadInstructors()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg transition-all">
              <i class="fas fa-sync-alt"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ID</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">이름</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">로그인 이메일</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ClassIn 전화번호/Email</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ClassIn UID</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ClassIn 등록</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">작업</th>
            </tr>
          </thead>
          <tbody id="instructorsTable" class="divide-y divide-gray-100">
            <tr><td colspan="7" class="px-6 py-8 text-center text-gray-400">로딩 중...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Class Management Section -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden mt-8">
      <div class="p-6 border-b border-gray-100">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-bold text-gray-800"><i class="fas fa-book text-blue-500 mr-2"></i>코스 관리</h2>
          <div class="flex items-center gap-2">
            <button onclick="openAddClassModal()" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg transition-all text-sm">
              <i class="fas fa-plus mr-1"></i>코스 추가
            </button>
            <button onclick="loadClasses()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg transition-all">
              <i class="fas fa-sync-alt"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-8"></th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">이미지</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">코스명</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">강사</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">가격</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">강의</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">강의생성</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">작업</th>
            </tr>
          </thead>
          <tbody id="classesTable" class="divide-y divide-gray-100">
            <tr><td colspan="8" class="px-6 py-8 text-center text-gray-400">로딩 중...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <!-- Settings Modal -->
  <div id="settingsModal" class="fixed inset-0 z-50 hidden">
    <div class="absolute inset-0 bg-black/50" onclick="closeSettingsModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
      <h3 class="text-lg font-bold mb-4"><i class="fas fa-cog text-gray-500 mr-2"></i>관리자 설정</h3>
      <div class="space-y-4">
        <div>
          <h4 class="text-sm font-semibold text-gray-700 mb-3"><i class="fas fa-lock text-gray-400 mr-2"></i>비밀번호 변경</h4>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">현재 비밀번호</label>
              <input type="password" id="currentPassword" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">새 비밀번호</label>
              <input type="password" id="newPassword" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" placeholder="6자 이상">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">새 비밀번호 확인</label>
              <input type="password" id="confirmPassword" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
            </div>
            <button onclick="changePassword()" class="w-full bg-rose-500 hover:bg-rose-600 text-white py-2 rounded-lg text-sm transition-all">
              비밀번호 변경
            </button>
          </div>
        </div>
      </div>
      <button onclick="closeSettingsModal()" class="mt-4 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg text-sm">닫기</button>
    </div>
  </div>

  <!-- Create Session Modal -->
  <div id="createSessionModal" class="fixed inset-0 z-50 hidden overflow-y-auto">
    <div class="absolute inset-0 bg-black/50" onclick="closeSessionModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
      <h3 class="text-lg font-bold mb-4"><i class="fas fa-calendar-plus text-blue-500 mr-2"></i>강의 생성</h3>
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-sm text-gray-500 mb-1">코스</p>
            <p class="font-medium" id="sessionClassName">-</p>
          </div>
          <div>
            <p class="text-sm text-gray-500 mb-1">강사</p>
            <p class="font-medium" id="sessionInstructor">-</p>
          </div>
        </div>
        <input type="hidden" id="sessionClassId" value="">
        <input type="hidden" id="sessionDurationDefault" value="60">

        <!-- 강의 목록 -->
        <div class="border border-gray-200 rounded-lg p-3">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-semibold text-gray-700">강의 목록</span>
            <button type="button" onclick="addLessonRow()" class="text-xs text-blue-500 hover:text-blue-700"><i class="fas fa-plus mr-1"></i>강의 추가</button>
          </div>
          <div id="lessonRowsContainer" class="space-y-3">
            <!-- 강의 행이 여기에 추가됨 -->
          </div>
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeSessionModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button id="createSessionBtn" onclick="confirmCreateSession()" class="flex-1 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg disabled:bg-gray-400 disabled:cursor-not-allowed">생성</button>
      </div>
    </div>
  </div>

  <!-- Recorded Lesson Modal (녹화 강의 생성) -->
  <div id="recordedLessonModal" class="fixed inset-0 z-50 hidden overflow-y-auto">
    <div class="absolute inset-0 bg-black/50" onclick="closeRecordedLessonModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
      <h3 class="text-lg font-bold mb-4"><i class="fas fa-video text-purple-500 mr-2"></i>녹화 강의 생성</h3>
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-sm text-gray-500 mb-1">코스</p>
            <p class="font-medium" id="recordedClassName">-</p>
          </div>
          <div>
            <p class="text-sm text-gray-500 mb-1">강사</p>
            <p class="font-medium" id="recordedInstructor">-</p>
          </div>
        </div>
        <input type="hidden" id="recordedClassId" value="">

        <!-- 강의 제목 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">강의 제목</label>
          <input type="text" id="recordedLessonTitle" placeholder="강의 제목 (비워두면 자동 생성)" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500">
        </div>

        <!-- 강의 설명 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">강의 설명</label>
          <textarea id="recordedLessonDesc" placeholder="이 강의에서 다루는 내용을 간단히 설명해주세요" rows="2" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 resize-none"></textarea>
        </div>

        <!-- 커리큘럼 항목 -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs font-semibold text-gray-600"><i class="fas fa-list-ol mr-1"></i>커리큘럼 항목</label>
            <button type="button" onclick="addRecordedCurriculumItem()" class="text-xs text-purple-500 hover:text-purple-700 font-medium"><i class="fas fa-plus mr-1"></i>항목 추가</button>
          </div>
          <div id="recordedCurriculumItems" class="space-y-2"></div>
        </div>

        <!-- 동영상 업로드 -->
        <div class="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer transition-all" id="uploadArea"
          ondragover="event.preventDefault(); this.classList.add('border-purple-500','bg-purple-50')"
          ondragleave="this.classList.remove('border-purple-500','bg-purple-50')"
          ondrop="event.preventDefault(); this.classList.remove('border-purple-500','bg-purple-50'); handleVideoDrop(event)">
          <input type="file" id="recordedVideoFile" accept="video/*" class="hidden" onchange="handleVideoSelect(this)">
          <input type="hidden" id="recordedStreamUid" value="">
          <div id="uploadPlaceholder">
            <i class="fas fa-cloud-upload-alt text-4xl text-gray-400 mb-2"></i>
            <p class="text-gray-600 mb-2">동영상 파일을 선택하거나 드래그하세요</p>
            <button type="button" onclick="document.getElementById('recordedVideoFile').click()" class="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-all">
              <i class="fas fa-folder-open mr-1"></i>파일 선택
            </button>
            <p class="text-xs text-gray-400 mt-2">MP4, MOV, AVI (최대 2시간)</p>
          </div>
          <div id="uploadProgress" class="hidden">
            <i class="fas fa-spinner fa-spin text-4xl text-purple-500 mb-2"></i>
            <p class="text-gray-600 mb-2" id="uploadStatusText">업로드 중...</p>
            <div class="w-full bg-gray-200 rounded-full h-2">
              <div id="uploadProgressBar" class="bg-purple-500 h-2 rounded-full transition-all" style="width: 0%"></div>
            </div>
            <p class="text-xs text-gray-400 mt-1" id="uploadPercentText">0%</p>
          </div>
          <div id="uploadComplete" class="hidden">
            <i class="fas fa-check-circle text-4xl text-green-500 mb-2"></i>
            <p class="text-green-600 mb-2">업로드 완료!</p>
            <p class="text-sm text-gray-600" id="videoDurationText">영상 길이: 분석 중...</p>
            <button type="button" onclick="resetVideoUpload()" class="mt-2 text-sm text-gray-500 hover:text-gray-700 underline">다른 파일 선택</button>
          </div>
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeRecordedLessonModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button id="createRecordedLessonBtn" onclick="confirmCreateRecordedLesson()" disabled class="flex-1 py-2 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-lg disabled:bg-gray-400 disabled:cursor-not-allowed">생성</button>
      </div>
    </div>
  </div>


  <!-- Course Materials Modal (강의 자료 추가) -->
  <div id="courseMaterialsModal" class="fixed inset-0 z-50 hidden overflow-y-auto">
    <div class="absolute inset-0 bg-black/50" onclick="closeCourseMaterialsModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
      <h3 class="text-lg font-bold mb-4"><i class="fas fa-paperclip text-amber-500 mr-2"></i>강의 자료 추가</h3>
      <div class="space-y-4">
        <div>
          <p class="text-sm text-gray-500 mb-1">코스</p>
          <p class="font-medium" id="materialCourseName">-</p>
        </div>
        <input type="hidden" id="materialCourseId" value="">

        <!-- 자료 업로드 -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-sm font-semibold text-gray-700"><i class="fas fa-file-alt mr-1"></i>강의 자료 목록</label>
            <label class="text-xs text-amber-600 hover:text-amber-700 font-medium cursor-pointer px-3 py-1.5 bg-amber-50 rounded-lg">
              <i class="fas fa-cloud-upload-alt mr-1"></i>파일 추가
              <input type="file" class="hidden" accept=".pdf,.doc,.docx,.ppt,.pptx,.hwp,.zip,.xls,.xlsx,.txt" onchange="uploadCourseMaterial(this)">
            </label>
          </div>
          <p class="text-xs text-gray-400 mb-3">PDF, DOCX, PPTX, HWP, ZIP, XLS, TXT (최대 50MB) - 드래그앤드롭 가능</p>
          <div id="courseMaterialsList" class="space-y-2 min-h-[60px] border border-dashed border-gray-200 rounded-lg p-3 cursor-pointer transition-all"
            ondragover="event.preventDefault(); this.classList.add('border-amber-500','bg-amber-50')"
            ondragleave="this.classList.remove('border-amber-500','bg-amber-50')"
            ondrop="event.preventDefault(); this.classList.remove('border-amber-500','bg-amber-50'); handleMaterialDrop(event)">
            <p class="text-sm text-gray-400 text-center py-4" id="noMaterialsText">등록된 자료가 없습니다</p>
          </div>
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeCourseMaterialsModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button onclick="saveCourseMaterials()" class="flex-1 py-2 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg">저장</button>
      </div>
    </div>
  </div>

  <!-- Result Modal -->
  <div id="resultModal" class="fixed inset-0 z-50 hidden">
    <div class="absolute inset-0 bg-black/50" onclick="closeModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
      <h3 class="text-lg font-bold mb-3" id="modalTitle">결과</h3>
      <p class="text-gray-600" id="modalMessage"></p>
      <button onclick="closeModal()" class="mt-4 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2 rounded-lg">확인</button>
    </div>
  </div>

  <!-- Add Instructor Modal -->
  <div id="addInstructorModal" class="fixed inset-0 z-50 hidden">
    <div class="absolute inset-0 bg-black/50" onclick="closeAddInstructorModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl">
      <h3 class="text-lg font-bold mb-4"><i class="fas fa-user-plus text-indigo-500 mr-2"></i>강사 추가</h3>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">이름 <span class="text-red-500">*</span></label>
          <input type="text" id="newInstructorName" placeholder="강사 이름" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">로그인 이메일 <span class="text-red-500">*</span></label>
          <input type="email" id="newInstructorEmail" placeholder="instructor@example.com" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
          <p class="text-xs text-gray-500 mt-1">사이트 로그인에 사용됩니다.</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">전화번호 <span class="text-red-500">*</span></label>
          <input type="tel" id="newInstructorPhone" placeholder="010-1234-5678" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">ClassIn 등록 방식</label>
          <div class="flex gap-4 mt-2">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="newClassInMethod" value="phone" checked class="w-4 h-4 text-indigo-500">
              <span class="text-sm text-gray-700">전화번호로 등록</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="newClassInMethod" value="email" class="w-4 h-4 text-indigo-500">
              <span class="text-sm text-gray-700">이메일로 등록</span>
            </label>
          </div>
          <p class="text-xs text-gray-500 mt-1">ClassIn 강사 계정 등록 시 사용할 정보를 선택합니다.</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">프로필 이미지</label>
          <div class="flex items-center gap-3">
            <div id="newInstructorImagePreview" class="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center overflow-hidden border-2 border-dashed border-gray-300 cursor-pointer transition-all"
              onclick="document.getElementById('newInstructorImageFile').click()"
              ondragover="event.preventDefault(); this.classList.add('border-indigo-500','bg-indigo-50')"
              ondragleave="this.classList.remove('border-indigo-500','bg-indigo-50')"
              ondrop="event.preventDefault(); this.classList.remove('border-indigo-500','bg-indigo-50'); handleInstructorImageDrop(event, 'new')">
              <i class="fas fa-user text-gray-400 text-xl"></i>
            </div>
            <div class="flex-1">
              <input type="file" id="newInstructorImageFile" accept="image/*" onchange="previewInstructorImage('new')" class="hidden">
              <input type="hidden" id="newInstructorImage" value="">
              <button type="button" onclick="document.getElementById('newInstructorImageFile').click()" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm rounded-lg transition-all">
                <i class="fas fa-upload mr-1"></i>이미지 업로드
              </button>
              <p class="text-xs text-gray-400 mt-1">JPG, PNG (최대 5MB) - 드래그앤드롭 가능</p>
            </div>
          </div>
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeAddInstructorModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button onclick="confirmAddInstructor()" id="btnAddInstructor" class="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold rounded-lg">추가</button>
      </div>
    </div>
  </div>

  <!-- Edit Instructor Modal -->
  <div id="editInstructorModal" class="fixed inset-0 z-50 hidden">
    <div class="absolute inset-0 bg-black/50" onclick="closeEditInstructorModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl">
      <h3 class="text-lg font-bold mb-4"><i class="fas fa-user-edit text-blue-500 mr-2"></i>강사 수정</h3>
      <input type="hidden" id="editInstructorId" value="">
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">이름 <span class="text-red-500">*</span></label>
          <input type="text" id="editInstructorName" placeholder="강사 이름" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">이메일 <span class="text-red-500">*</span></label>
          <input type="email" id="editInstructorEmail" placeholder="instructor@example.com" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">전화번호 <span class="text-red-500">*</span></label>
          <input type="tel" id="editInstructorPhone" placeholder="010-1234-5678" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">ClassIn 등록 방식</label>
          <div class="flex gap-4 mt-2">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="editClassInMethod" value="phone" checked class="w-4 h-4 text-blue-500">
              <span class="text-sm text-gray-700">전화번호로 등록</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="editClassInMethod" value="email" class="w-4 h-4 text-blue-500">
              <span class="text-sm text-gray-700">이메일로 등록</span>
            </label>
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">프로필 이미지</label>
          <div class="flex items-center gap-3">
            <div id="editInstructorImagePreview" class="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center overflow-hidden border-2 border-dashed border-gray-300">
              <i class="fas fa-user text-gray-400 text-xl"></i>
            </div>
            <div class="flex-1">
              <input type="file" id="editInstructorImageFile" accept="image/*" onchange="previewInstructorImage('edit')" class="hidden">
              <input type="hidden" id="editInstructorImage" value="">
              <button type="button" onclick="document.getElementById('editInstructorImageFile').click()" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm rounded-lg transition-all">
                <i class="fas fa-upload mr-1"></i>이미지 변경
              </button>
              <p class="text-xs text-gray-400 mt-1">JPG, PNG (최대 5MB)</p>
            </div>
          </div>
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeEditInstructorModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button onclick="confirmEditInstructor()" id="btnEditInstructor" class="flex-1 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg">저장</button>
      </div>
    </div>
  </div>

  <!-- Add/Edit Class Modal -->
  <div id="classModal" class="fixed inset-0 z-50 hidden overflow-y-auto">
    <div class="absolute inset-0 bg-black/50" onclick="closeClassModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-y-auto">
      <h3 class="text-lg font-bold mb-4" id="classModalTitle"><i class="fas fa-book text-blue-500 mr-2"></i>코스 추가</h3>
      <input type="hidden" id="editClassId" value="">
      <div class="grid grid-cols-2 gap-4">
        <div class="col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">제목 <span class="text-red-500">*</span></label>
          <input type="text" id="classTitle" placeholder="코스 제목" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div class="col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">설명</label>
          <textarea id="classDescription" placeholder="코스 설명" rows="3" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">강사 <span class="text-red-500">*</span></label>
          <select id="classInstructor" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
            <option value="">선택하세요</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">카테고리 <span class="text-red-500">*</span></label>
          <select id="classCategory" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
            <option value="">선택하세요</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">가격 (원)</label>
          <input type="number" id="classPrice" placeholder="0" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">강의 시간 (분, 기본값)</label>
          <input type="number" id="classDuration" placeholder="60" value="60" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">난이도</label>
          <select id="classLevel" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
            <option value="all">전체</option>
            <option value="beginner">입문</option>
            <option value="intermediate">중급</option>
            <option value="advanced">고급</option>
          </select>
        </div>
        <div class="col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">썸네일 이미지</label>
          <input type="hidden" id="classThumbnail" value="">
          <div id="thumbnailDropZone" class="relative border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-blue-400 transition-colors cursor-pointer"
               ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event)" onclick="document.getElementById('thumbnailFileInput').click()">
            <input type="file" id="thumbnailFileInput" accept="image/*" class="hidden" onchange="handleFileSelect(event)">
            <div id="thumbnailUploadPlaceholder">
              <i class="fas fa-cloud-upload-alt text-3xl text-gray-400 mb-2"></i>
              <p class="text-sm text-gray-500">클릭하거나 이미지를 드래그하세요</p>
              <p class="text-xs text-gray-400 mt-1">JPEG, PNG, GIF, WebP (최대 5MB)</p>
            </div>
            <div id="thumbnailPreview" class="hidden">
              <img id="thumbnailImg" src="" alt="미리보기" class="max-w-full h-32 object-contain mx-auto rounded-lg">
              <button type="button" onclick="event.stopPropagation(); removeThumbnail()" class="absolute top-2 right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600">
                <i class="fas fa-times text-xs"></i>
              </button>
            </div>
            <div id="thumbnailUploading" class="hidden">
              <i class="fas fa-spinner fa-spin text-2xl text-blue-500"></i>
              <p class="text-sm text-gray-500 mt-2">업로드 중...</p>
            </div>
          </div>
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeClassModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button onclick="confirmSaveClass()" id="saveClassBtn" class="flex-1 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg">추가</button>
      </div>
    </div>
  </div>

  <script>
    const ADMIN_KEY = 'classin-admin-2024';
    let currentPage = 0;
    const pageSize = 100;
    let accountListExpanded = false;

    // 녹화 강의 새 창에서 열기
    function openWatchWindow(lessonId) {
      window.open('/watch/' + lessonId, 'watchLesson', 'width=1200,height=800');
    }

    function toggleAccountList() {
      accountListExpanded = !accountListExpanded;
      const content = document.getElementById('accountListContent');
      const icon = document.getElementById('accountListToggleIcon');

      if (accountListExpanded) {
        content.classList.remove('hidden');
        icon.style.transform = 'rotate(90deg)';
      } else {
        content.classList.add('hidden');
        icon.style.transform = 'rotate(0deg)';
      }
    }

    async function loadStats() {
      const res = await fetch('/api/admin/virtual-accounts?limit=1');
      const data = await res.json();
      if (data.stats) {
        document.getElementById('statTotal').textContent = data.stats.total || 0;
        document.getElementById('statAvailable').textContent = data.stats.available || 0;
        document.getElementById('statAssigned').textContent = data.stats.assigned || 0;
        document.getElementById('statRegistered').textContent = data.stats.registered || 0;

        // Update collapsed summary
        const summary = '(총 ' + (data.stats.total || 0) + '개 / 사용 가능: ' + (data.stats.available || 0) + ' / 할당됨: ' + (data.stats.assigned || 0) + ')';
        document.getElementById('accountListSummary').textContent = summary;
      }
    }

    async function loadAccounts() {
      const status = document.getElementById('filterStatus').value;
      const url = '/api/admin/virtual-accounts?limit=' + pageSize + '&offset=' + (currentPage * pageSize) + (status ? '&status=' + status : '');
      const res = await fetch(url);
      const data = await res.json();

      const tbody = document.getElementById('accountsTable');
      if (!data.accounts || data.accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="px-6 py-8 text-center text-gray-400">계정이 없습니다.</td></tr>';
        return;
      }

      tbody.innerHTML = data.accounts.map(acc => \`
        <tr class="hover:bg-gray-50">
          <td class="px-6 py-4 font-mono text-sm">\${acc.account_uid}</td>
          <td class="px-6 py-4">
            <span class="px-2 py-1 rounded-full text-xs font-medium \${
              acc.status === 'available' ? 'bg-green-100 text-green-700' :
              acc.status === 'assigned' ? 'bg-purple-100 text-purple-700' :
              'bg-gray-100 text-gray-600'
            }">\${acc.status === 'available' ? '사용 가능' : acc.status === 'assigned' ? '할당됨' : acc.status}</span>
          </td>
          <td class="px-6 py-4">
            \${acc.is_registered
              ? '<span class="text-green-500"><i class="fas fa-check-circle"></i> 등록됨</span>'
              : '<span class="text-gray-400"><i class="far fa-circle"></i> 미등록</span>'
            }
          </td>
          <td class="px-6 py-4 text-sm">\${acc.assigned_name || '-'}</td>
          <td class="px-6 py-4 font-mono text-xs">\${acc.account_password || '-'}</td>
          <td class="px-6 py-4 text-sm text-gray-500">\${acc.expires_at ? new Date(acc.expires_at).toLocaleDateString('ko-KR') : '-'}</td>
          <td class="px-6 py-4">
            \${!acc.is_registered && acc.status === 'assigned' ?
              \`<button onclick="registerAccount(\${acc.id})" class="text-blue-500 hover:text-blue-700 text-sm"><i class="fas fa-cloud-upload-alt mr-1"></i>등록</button>\`
              : '-'
            }
          </td>
        </tr>
      \`).join('');

      const total = data.stats?.total || 0;
      const totalPages = Math.ceil(total / pageSize) || 1;
      document.getElementById('paginationInfo').textContent = \`페이지 \${currentPage + 1}/\${totalPages} (총 \${total}개)\`;
      loadStats();
    }

    async function initAccounts() {
      const startUid = document.getElementById('startUid').value;
      const endUid = document.getElementById('endUid').value;
      const sid = document.getElementById('sid').value;
      const expiresAt = document.getElementById('expiresAt').value.replace('T', ' ') + ':00';

      const res = await fetch('/api/admin/virtual-accounts/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startUid, endUid, sid, expiresAt, adminKey: ADMIN_KEY })
      });
      const data = await res.json();

      if (data.success) {
        showModal('성공', data.message);
        loadAccounts();
      } else {
        showModal('오류', data.error || '생성 실패');
      }
    }

    async function registerAccount(accountId) {
      const res = await fetch('/api/virtual-accounts/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId })
      });
      const data = await res.json();

      if (data.success) {
        showModal('성공', 'ClassIn에 계정이 등록되었습니다.');
        loadAccounts();
      } else {
        showModal('오류', data.error || '등록 실패');
      }
    }

    function showModal(title, message) {
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalMessage').textContent = message;
      document.getElementById('resultModal').classList.remove('hidden');
    }

    function closeModal() {
      document.getElementById('resultModal').classList.add('hidden');
    }

    function prevPage() { if (currentPage > 0) { currentPage--; loadAccounts(); } }
    function nextPage() { currentPage++; loadAccounts(); }

    // Instructor management functions
    async function loadInstructors() {
      const res = await fetch('/api/admin/instructors');
      const data = await res.json();

      const tbody = document.getElementById('instructorsTable');
      if (!data.instructors || data.instructors.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="px-6 py-8 text-center text-gray-400">강사가 없습니다.</td></tr>';
        return;
      }

      tbody.innerHTML = data.instructors.map(inst => \`
        <tr class="hover:bg-gray-50">
          <td class="px-4 py-3 text-sm">\${inst.id}</td>
          <td class="px-4 py-3 font-medium">\${inst.display_name}</td>
          <td class="px-4 py-3 text-sm text-gray-500">\${inst.user_email || '-'}</td>
          <td class="px-4 py-3 text-sm text-gray-500">\${inst.user_phone || '-'}</td>
          <td class="px-4 py-3 font-mono text-xs">
            \${inst.classin_uid
              ? '<span class="text-green-600">' + inst.classin_uid + '</span>'
              : '<span class="text-gray-400">-</span>'
            }
          </td>
          <td class="px-4 py-3">
            \${!inst.classin_uid ?
              \`<div class="flex items-center gap-2">
                <input type="text" id="phone_\${inst.id}" placeholder="전화번호/이메일" class="px-2 py-1 border border-gray-200 rounded text-xs w-32" value="\${inst.user_phone || inst.user_email || ''}">
                <button onclick="registerInstructor(\${inst.id})" class="text-indigo-500 hover:text-indigo-700 text-xs whitespace-nowrap" title="ClassIn 등록">
                  <i class="fas fa-cloud-upload-alt"></i>
                </button>
              </div>\`
              : \`<div class="flex items-center gap-2">
                  <span class="text-green-500 text-xs"><i class="fas fa-check-circle mr-1"></i>완료</span>
                  <button onclick="reRegisterInstructor(\${inst.id}, '\${inst.classin_uid}')" class="text-orange-500 hover:text-orange-700 text-xs" title="기관 교사로 재등록">
                    <i class="fas fa-sync-alt"></i>
                  </button>
                </div>\`
            }
          </td>
          <td class="px-4 py-3">
            <div class="flex items-center gap-2">
              <button onclick="openEditInstructorModal(\${inst.id}, '\${inst.display_name.replace(/'/g, "\\\\'")}', '\${(inst.user_email || '').replace(/'/g, "\\\\'")}', '\${(inst.user_phone || '').replace(/'/g, "\\\\'")}', '\${(inst.profile_image || '').replace(/'/g, "\\\\'")}', 'phone')" class="text-blue-500 hover:text-blue-700 text-sm" title="수정">
                <i class="fas fa-edit"></i>
              </button>
              <button onclick="deleteInstructor(\${inst.id}, '\${inst.display_name.replace(/'/g, "\\\\'")}')" class="text-red-500 hover:text-red-700 text-sm" title="삭제">
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </td>
        </tr>
      \`).join('');
    }

    function openAddInstructorModal() {
      document.getElementById('newInstructorName').value = '';
      document.getElementById('newInstructorEmail').value = '';
      document.getElementById('newInstructorPhone').value = '';
      document.getElementById('newInstructorImage').value = '';
      document.getElementById('newInstructorImageFile').value = '';
      document.getElementById('newInstructorImagePreview').innerHTML = '<i class="fas fa-user text-gray-400 text-xl"></i>';
      document.querySelector('input[name="newClassInMethod"][value="phone"]').checked = true;
      document.getElementById('addInstructorModal').classList.remove('hidden');
    }

    function closeAddInstructorModal() {
      document.getElementById('addInstructorModal').classList.add('hidden');
    }

    function openEditInstructorModal(id, name, email, phone, profileImage, classInMethod) {
      document.getElementById('editInstructorId').value = id;
      document.getElementById('editInstructorName').value = name || '';
      document.getElementById('editInstructorEmail').value = email || '';
      document.getElementById('editInstructorPhone').value = phone || '';
      document.getElementById('editInstructorImage').value = profileImage || '';
      document.getElementById('editInstructorImageFile').value = '';
      // ClassIn 등록 방식 설정
      const method = classInMethod || 'phone';
      document.querySelector('input[name="editClassInMethod"][value="' + method + '"]').checked = true;
      // 기존 이미지 프리뷰 표시
      const preview = document.getElementById('editInstructorImagePreview');
      if (profileImage) {
        preview.innerHTML = '<img src="' + profileImage + '" class="w-full h-full object-cover">';
      } else {
        preview.innerHTML = '<i class="fas fa-user text-gray-400 text-xl"></i>';
      }
      document.getElementById('editInstructorModal').classList.remove('hidden');
    }

    function closeEditInstructorModal() {
      document.getElementById('editInstructorModal').classList.add('hidden');
    }

    // 강사 이미지 미리보기
    // 강사 이미지 드롭 핸들러
    function handleInstructorImageDrop(event, mode) {
      const file = event.dataTransfer.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showModal('오류', '이미지 파일만 업로드할 수 있습니다.');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        showModal('오류', '이미지 크기는 5MB 이하여야 합니다.');
        return;
      }
      const fileInput = document.getElementById(mode + 'InstructorImageFile');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      previewInstructorImage(mode);
    }

    function previewInstructorImage(mode) {
      const fileInput = document.getElementById(mode + 'InstructorImageFile');
      const preview = document.getElementById(mode + 'InstructorImagePreview');
      const file = fileInput.files[0];
      if (file) {
        if (file.size > 5 * 1024 * 1024) {
          showModal('오류', '이미지 크기는 5MB 이하여야 합니다.');
          fileInput.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
          preview.innerHTML = '<img src="' + e.target.result + '" class="w-full h-full object-cover">';
        };
        reader.readAsDataURL(file);
      }
    }

    // 강사 이미지 업로드 (공통)
    async function uploadInstructorImage(fileInput) {
      const file = fileInput.files[0];
      if (!file) return null;

      const formData = new FormData();
      formData.append('image', file);

      const res = await fetch('/api/admin/upload-image', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        throw new Error('이미지 업로드 실패');
      }

      const data = await res.json();
      return data.url;
    }

    async function confirmEditInstructor() {
      const id = document.getElementById('editInstructorId').value;
      const name = document.getElementById('editInstructorName').value.trim();
      const email = document.getElementById('editInstructorEmail').value.trim();
      const phone = document.getElementById('editInstructorPhone').value.trim();
      const classInMethod = document.querySelector('input[name="editClassInMethod"]:checked')?.value || 'phone';
      let profileImage = document.getElementById('editInstructorImage').value.trim();
      const fileInput = document.getElementById('editInstructorImageFile');

      if (!name || !email || !phone) {
        showModal('오류', '이름, 이메일, 전화번호는 필수입니다.');
        return;
      }

      // 새 이미지 파일이 선택된 경우 업로드
      if (fileInput.files[0]) {
        const btn = document.getElementById('btnEditInstructor');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>업로드 중...';
        try {
          profileImage = await uploadInstructorImage(fileInput);
        } catch (e) {
          btn.disabled = false;
          btn.innerHTML = '저장';
          showModal('오류', e.message);
          return;
        }
        btn.disabled = false;
        btn.innerHTML = '저장';
      }

      const res = await fetch('/api/admin/instructors/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone, profileImage, classInMethod })
      });
      const data = await res.json();

      if (data.success) {
        closeEditInstructorModal();
        showModal('성공', data.message);
        loadInstructors();
      } else {
        showModal('오류', data.error || '수정 실패');
      }
    }

    async function confirmAddInstructor() {
      const name = document.getElementById('newInstructorName').value.trim();
      const email = document.getElementById('newInstructorEmail').value.trim();
      const phone = document.getElementById('newInstructorPhone').value.trim();
      const classInMethod = document.querySelector('input[name="newClassInMethod"]:checked')?.value || 'phone';
      let profileImage = document.getElementById('newInstructorImage').value.trim();
      const fileInput = document.getElementById('newInstructorImageFile');

      if (!name || !email || !phone) {
        showModal('오류', '이름, 이메일, 전화번호는 필수입니다.');
        return;
      }

      // 이미지 파일이 선택된 경우 업로드
      if (fileInput.files[0]) {
        const btn = document.getElementById('btnAddInstructor');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>업로드 중...';
        try {
          profileImage = await uploadInstructorImage(fileInput);
        } catch (e) {
          btn.disabled = false;
          btn.innerHTML = '추가';
          showModal('오류', e.message);
          return;
        }
        btn.disabled = false;
        btn.innerHTML = '추가';
      }

      const res = await fetch('/api/admin/instructors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone, classInMethod, profileImage })
      });
      const data = await res.json();

      if (data.success) {
        closeAddInstructorModal();
        let msg = '강사가 추가되었습니다.';
        if (data.instructor.classin_uid) {
          msg += ' (ClassIn UID: ' + data.instructor.classin_uid + ')';
        } else if (data.classInError) {
          msg += '\\n\\nClassIn 등록 실패: ' + data.classInError;
        }
        showModal('성공', msg);
        loadInstructors();
      } else {
        showModal('오류', data.error || '강사 추가 실패');
      }
    }

    async function deleteInstructor(instructorId, instructorName) {
      if (!confirm(instructorName + ' 강사를 삭제하시겠습니까?')) return;

      const res = await fetch('/api/admin/instructors/' + instructorId, {
        method: 'DELETE'
      });
      const data = await res.json();

      if (data.success) {
        loadInstructors();
        alert('강사가 삭제되었습니다.');
      } else {
        alert(data.error || '삭제 실패');
      }
    }

    async function registerInstructor(instructorId) {
      const phoneInput = document.getElementById('phone_' + instructorId);
      const phoneNumber = phoneInput ? phoneInput.value.trim() : '';

      if (!phoneNumber) {
        showModal('오류', '전화번호를 입력해주세요. (예: 010-1234-5678)');
        return;
      }

      const res = await fetch('/api/admin/instructors/register-classin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructorId, phoneNumber })
      });
      const data = await res.json();

      if (data.success) {
        showModal('성공', '강사 ClassIn 등록 완료! UID: ' + data.classInUid);
        loadInstructors();
      } else {
        showModal('오류', data.error || '등록 실패');
      }
    }

    async function reRegisterInstructor(instructorId, classInUid) {
      const phoneNumber = prompt('기관 교사로 재등록하려면 전화번호 또는 이메일을 입력하세요.\\n(예: 010-1234-5678 또는 email@example.com)\\n\\n기존 UID: ' + classInUid);
      if (!phoneNumber) return;

      const res = await fetch('/api/admin/instructors/re-register-classin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructorId, classInUid, phoneNumber })
      });
      const data = await res.json();

      if (data.success) {
        showModal('성공', data.message);
        loadInstructors();
      } else {
        showModal('오류', data.error || '재등록 실패');
      }
    }

    // Class session management
    let selectedClassId = null;

    let instructorsList = [];
    let categoriesList = [];

    // Track expanded courses
    let expandedCourses = new Set();
    let courseLessonsCache = {};

    async function loadClasses() {
      const res = await fetch('/api/admin/classes');
      const data = await res.json();

      const tbody = document.getElementById('classesTable');
      if (!data.classes || data.classes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="px-6 py-8 text-center text-gray-400">코스가 없습니다.</td></tr>';
        return;
      }

      const now = Date.now();

      tbody.innerHTML = data.classes.map(cls => {
        const thumbnail = cls.thumbnail || '';
        const safeTitle = cls.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const safeInstructor = (cls.instructor_name || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const isExpanded = expandedCourses.has(cls.id);

        // 강의 생성 버튼 (라이브 + 녹화)
        let liveBtn, recordedBtn;
        if (!cls.instructor_classin_uid) {
          liveBtn = '<span class="text-gray-400 text-xs" title="강사 ClassIn UID 없음">-</span>';
        } else {
          liveBtn = \`<button onclick="event.stopPropagation(); openCreateSession(\${cls.id}, '\${safeTitle}', '\${safeInstructor}', \${cls.duration_minutes || 60})" class="text-blue-500 hover:text-blue-700 text-sm" title="라이브 강의"><i class="fas fa-video"></i></button>\`;
        }
        recordedBtn = \`<button onclick="event.stopPropagation(); openRecordedLessonModal(\${cls.id}, '\${safeTitle}', '\${safeInstructor}')" class="text-purple-500 hover:text-purple-700 text-sm ml-2" title="녹화 강의"><i class="fas fa-cloud-upload-alt"></i></button>\`;
        const createBtn = liveBtn + recordedBtn;

        // 강의 수 표시
        const lessonCount = cls.lesson_count || 0;
        const lessonBadge = lessonCount > 0
          ? \`<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">\${lessonCount}개</span>\`
          : '<span class="text-gray-400 text-xs">없음</span>';

        return \`
          <tr class="hover:bg-gray-50 cursor-pointer border-b border-gray-100" onclick="toggleCourseLessons(\${cls.id}, '\${safeTitle}')">
            <td class="px-3 py-2 text-gray-400">
              <i class="fas fa-chevron-\${isExpanded ? 'down' : 'right'} text-xs transition-transform" id="chevron-\${cls.id}"></i>
            </td>
            <td class="px-3 py-2">
              <img src="\${thumbnail}" alt="" class="w-16 h-10 object-cover rounded bg-gray-200" onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2760%27 height=%2740%27%3E%3Crect fill=%27%23e5e7eb%27 width=%27100%25%27 height=%27100%25%27/%3E%3C/svg%3E'">
            </td>
            <td class="px-3 py-2">
              <div class="font-medium text-sm line-clamp-1 max-w-[200px]">\${cls.title}</div>
              <div class="text-xs text-gray-400">\${cls.category_name || ''}</div>
            </td>
            <td class="px-3 py-2 text-sm">\${cls.instructor_name || '-'}</td>
            <td class="px-3 py-2 text-sm">\${(cls.price || 0).toLocaleString()}원</td>
            <td class="px-3 py-2">\${lessonBadge}</td>
            <td class="px-3 py-2">\${createBtn}</td>
            <td class="px-3 py-2">
              <div class="flex items-center gap-2">
                <button onclick="event.stopPropagation(); openEditClass(\${cls.id})" class="text-gray-500 hover:text-blue-500 text-sm" title="수정"><i class="fas fa-edit"></i></button>
                <button onclick="event.stopPropagation(); deleteClass(\${cls.id}, '\${cls.title.replace(/'/g, "\\\\'")}')" class="text-gray-500 hover:text-red-500 text-sm" title="삭제"><i class="fas fa-trash-alt"></i></button>
              </div>
            </td>
          </tr>
          <tr id="lessons-row-\${cls.id}" class="\${isExpanded ? '' : 'hidden'}">
            <td colspan="8" class="p-0">
              <div id="lessons-content-\${cls.id}" class="bg-gray-50 border-l-4 border-l-blue-300 border-t border-b border-gray-200 ml-8">
                <div class="p-4 text-gray-500 text-center text-sm">강의 목록 로딩 중...</div>
              </div>
            </td>
          </tr>
        \`;
      }).join('');

      // 이미 펼쳐진 코스의 강의 목록 다시 로드
      expandedCourses.forEach(courseId => {
        loadCourseLessons(courseId);
      });
    }

    async function toggleCourseLessons(courseId, courseTitle) {
      const lessonsRow = document.getElementById('lessons-row-' + courseId);
      const chevron = document.getElementById('chevron-' + courseId);

      if (expandedCourses.has(courseId)) {
        // 접기
        expandedCourses.delete(courseId);
        lessonsRow.classList.add('hidden');
        chevron.classList.remove('fa-chevron-down');
        chevron.classList.add('fa-chevron-right');
      } else {
        // 펼치기
        expandedCourses.add(courseId);
        lessonsRow.classList.remove('hidden');
        chevron.classList.remove('fa-chevron-right');
        chevron.classList.add('fa-chevron-down');
        await loadCourseLessons(courseId);
      }
    }

    async function loadCourseLessons(courseId) {
      const contentDiv = document.getElementById('lessons-content-' + courseId);
      if (!contentDiv) {
        // 코스가 삭제되었거나 DOM이 아직 없음 - expandedCourses에서 제거
        expandedCourses.delete(courseId);
        return;
      }
      contentDiv.innerHTML = '<div class="p-4 text-gray-500 text-center text-sm">강의 목록 로딩 중...</div>';

      const res = await fetch('/api/admin/classes/' + courseId + '/lessons');
      const data = await res.json();

      // 코스 정보 가져오기 (강의 추가 버튼용)
      const courseInfo = data.courseInfo || {};
      const addBtnsHtml = buildLessonAddButtons(courseId, courseInfo);

      if (!data.lessons || data.lessons.length === 0) {
        contentDiv.innerHTML = '<div class="p-6 text-center"><div class="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3"><i class="fas fa-chalkboard-teacher text-xl text-gray-300"></i></div><p class="text-sm text-gray-400 mb-4">아직 등록된 강의가 없습니다</p>' + addBtnsHtml + '</div>';
        return;
      }

      const now = Date.now();

      // 강의을 강의중(전)/강의완료로 분류
      const upcomingLessons = [];
      const completedLessons = [];

      data.lessons.forEach(lesson => {
        const endTime = new Date(lesson.scheduled_at).getTime() + (lesson.duration_minutes || 60) * 60 * 1000;
        const isTimeOver = endTime < now;
        const isEnded = lesson.status === 'ended' || isTimeOver;

        if (isEnded) {
          completedLessons.push({ ...lesson, isEnded: true });
        } else {
          upcomingLessons.push({ ...lesson, isEnded: false, isLive: lesson.status === 'live' && !isTimeOver });
        }
      });

      // 강의 행 렌더링 함수
      const renderLessonRow = (lesson) => {
        // lesson_type이 'recorded'이거나 stream_uid가 있으면 녹화 강의로 처리
        const isRecorded = lesson.lesson_type === 'recorded' || !!lesson.stream_uid;
        const startTime = new Date(lesson.scheduled_at);
        const timeStr = isRecorded ? '-' : startTime.toLocaleString('ko-KR', { timeZone:'Asia/Seoul', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });

        let typeBadge, statusBadge, actionBtn, deleteBtn;

        // 강의 유형 배지
        typeBadge = isRecorded
          ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 mr-1">녹화</span>'
          : '<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 mr-1">라이브</span>';

        if (isRecorded) {
          // 녹화 강의
          statusBadge = '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">시청가능</span>';
          actionBtn = \`<button onclick="openWatchWindow(\${lesson.id})" class="px-3 py-1 bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium rounded-lg">시청하기</button>\`;
          deleteBtn = \`<button onclick="deleteAdminLesson(\${lesson.id}, '\${lesson.lesson_title.replace(/'/g, "\\\\'")}', \${courseId}, true)" class="text-red-400 hover:text-red-600 text-xs" title="강의 삭제"><i class="fas fa-trash-alt"></i></button>\`;
        } else if (lesson.isEnded) {
          statusBadge = '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">완료</span>';
          actionBtn = lesson.replay_url
            ? \`<a href="\${lesson.replay_url}" target="_blank" class="px-3 py-1 bg-green-500 hover:bg-green-600 text-white text-xs font-medium rounded-lg">다시보기</a>\`
            : '<span class="text-gray-400 text-xs">-</span>';
          deleteBtn = '<span class="text-gray-300 text-xs" title="종료된 강의는 삭제 불가"><i class="fas fa-trash-alt"></i></span>';
        } else if (lesson.isLive) {
          statusBadge = '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-red-500 text-white animate-pulse">진행중</span>';
          actionBtn = lesson.id
            ? \`<div class="relative inline-block">
                <button onclick="toggleEnterMenu(\${lesson.id})" class="px-3 py-1 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded-lg">강의실 입장 <i class="fas fa-caret-down ml-1"></i></button>
                <div id="enterMenu_\${lesson.id}" class="hidden absolute right-0 mt-1 w-32 bg-white rounded-lg shadow-lg border z-50">
                  <a href="/api/classin/instructor-enter/\${lesson.id}?redirect=true&mode=instructor" target="_blank" class="block px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-t-lg">강사로 입장</a>
                  <a href="/api/classin/instructor-enter/\${lesson.id}?redirect=true&mode=observer" target="_blank" class="block px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-b-lg">청강생으로 입장</a>
                </div>
              </div>\`
            : '-';
          deleteBtn = '<span class="text-gray-300 text-xs" title="진행중인 강의는 삭제 불가"><i class="fas fa-trash-alt"></i></span>';
        } else {
          statusBadge = '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">예정</span>';
          actionBtn = lesson.id
            ? \`<div class="relative inline-block">
                <button onclick="toggleEnterMenu(\${lesson.id})" class="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium rounded-lg">강의실 입장 <i class="fas fa-caret-down ml-1"></i></button>
                <div id="enterMenu_\${lesson.id}" class="hidden absolute right-0 mt-1 w-32 bg-white rounded-lg shadow-lg border z-50">
                  <a href="/api/classin/instructor-enter/\${lesson.id}?redirect=true&mode=instructor" target="_blank" class="block px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-t-lg">강사로 입장</a>
                  <a href="/api/classin/instructor-enter/\${lesson.id}?redirect=true&mode=observer" target="_blank" class="block px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-b-lg">청강생으로 입장</a>
                </div>
              </div>\`
            : '-';
          deleteBtn = \`<button onclick="deleteAdminLesson(\${lesson.id}, '\${lesson.lesson_title.replace(/'/g, "\\\\'")}', \${courseId}, false)" class="text-red-400 hover:text-red-600 text-xs" title="강의 삭제"><i class="fas fa-trash-alt"></i></button>\`;
        }

        const rowBgClass = isRecorded ? 'bg-purple-50' : (lesson.isEnded ? 'bg-gray-100' : lesson.isLive ? 'bg-red-50' : 'bg-blue-50');

        // 커리큘럼/자료 배지
        let currItems = [];
        let matItems = [];
        try { currItems = JSON.parse(lesson.curriculum_items || '[]'); } catch(e) {}
        try { matItems = JSON.parse(lesson.materials || '[]'); } catch(e) {}
        const currBadge = currItems.length > 0 ? '<span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-600" title="커리큘럼 ' + currItems.length + '개"><i class="fas fa-list-ol mr-0.5"></i>' + currItems.length + '</span>' : '';
        const matBadge = matItems.length > 0 ? '<span class="ml-1 text-amber-500 text-xs" title="자료 ' + matItems.length + '개"><i class="fas fa-paperclip"></i></span>' : '';
        const hasDetail = currItems.length > 0 || matItems.length > 0 || (lesson.description && lesson.description.trim());
        const detailId = 'lessonDetail_' + lesson.id;

        // 상세 확장 영역 (커리큘럼 + 자료)
        let detailHtml = '';
        if (hasDetail) {
          detailHtml = '<tr id="' + detailId + '" class="hidden"><td colspan="6" class="px-4 py-3 bg-white border-b border-gray-200">';
          if (lesson.description && lesson.description.trim()) {
            detailHtml += '<div class="mb-2"><p class="text-xs font-semibold text-gray-500 mb-1"><i class="fas fa-align-left mr-1"></i>강의 설명</p><p class="text-sm text-gray-700 whitespace-pre-line">' + lesson.description + '</p></div>';
          }
          if (currItems.length > 0) {
            detailHtml += '<div class="mb-2"><p class="text-xs font-semibold text-gray-500 mb-1"><i class="fas fa-list-ol mr-1"></i>커리큘럼 (' + currItems.length + ')</p><div class="space-y-1">';
            currItems.forEach(function(item, i) {
              detailHtml += '<div class="flex items-start gap-2 pl-2"><span class="text-xs text-gray-400 font-mono mt-0.5">' + (i+1) + '.</span><div><p class="text-sm text-gray-800">' + (item.title || '') + '</p>' + (item.desc ? '<p class="text-xs text-gray-500">' + item.desc + '</p>' : '') + '</div></div>';
            });
            detailHtml += '</div></div>';
          }
          if (matItems.length > 0) {
            detailHtml += '<div><p class="text-xs font-semibold text-gray-500 mb-1"><i class="fas fa-paperclip mr-1"></i>강의 자료 (' + matItems.length + ')</p><div class="flex flex-wrap gap-2">';
            matItems.forEach(function(mat) {
              detailHtml += '<a href="' + mat.url + '" target="_blank" class="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-xs text-gray-700 transition-all"><i class="fas fa-file-download text-purple-400"></i>' + (mat.filename || '파일') + '</a>';
            });
            detailHtml += '</div></div>';
          }
          detailHtml += '</td></tr>';
        }

        const toggleAttr = hasDetail ? ' onclick="document.getElementById(\\'' + detailId + '\\').classList.toggle(\\\'hidden\\\')" style="cursor:pointer" title="클릭하여 상세 보기"' : '';

        return \`
          <tr class="\${rowBgClass} border-b border-gray-200 hover:brightness-95 transition-all"\${toggleAttr}>
            <td class="px-4 py-2 text-sm font-medium text-gray-700">\${typeBadge}\${lesson.lesson_title}\${currBadge}\${matBadge}\${hasDetail ? '<i class="fas fa-chevron-down text-gray-300 text-[10px] ml-1"></i>' : ''}</td>
            <td class="px-4 py-2 text-sm text-gray-600">\${timeStr}</td>
            <td class="px-4 py-2 text-sm text-gray-600">\${lesson.duration_minutes}분</td>
            <td class="px-4 py-2">\${statusBadge}</td>
            <td class="px-4 py-2">\${actionBtn}</td>
            <td class="px-4 py-2 text-center whitespace-nowrap">\${!lesson.isEnded && !lesson.isLive && !isRecorded ? '<button onclick="event.stopPropagation(); openEditLessonModal('+lesson.id+', \\''+lesson.lesson_title.replace(/'/g, "\\\\'")+'\\',' + lesson.duration_minutes + ', \\''+lesson.scheduled_at+'\\',' + courseId + ')" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="수정"><i class="fas fa-pen"></i></button>' : ''}\${deleteBtn}</td>
          </tr>
        \` + detailHtml;
      };

      let html = '<div class="px-4 py-2">';

      // 강의중(전) 섹션
      if (upcomingLessons.length > 0) {
        html += \`
          <div class="mb-4">
            <h4 class="text-sm font-bold text-blue-700 mb-2 flex items-center gap-2">
              <i class="fas fa-clock"></i> 예정/진행중 (\${upcomingLessons.length}개)
            </h4>
            <table class="w-full">
              <thead class="bg-blue-100">
                <tr>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-blue-700">강의명</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-blue-700">일시</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-blue-700">시간</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-blue-700">상태</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-blue-700">강사입장</th>
                  <th class="px-4 py-2 text-center text-xs font-semibold text-blue-700">작업</th>
                </tr>
              </thead>
              <tbody>
                \${upcomingLessons.map(renderLessonRow).join('')}
              </tbody>
            </table>
          </div>
        \`;
      }

      // 강의완료 섹션
      if (completedLessons.length > 0) {
        html += \`
          <div>
            <h4 class="text-sm font-bold text-gray-600 mb-2 flex items-center gap-2">
              <i class="fas fa-check-circle"></i> 강의완료 (\${completedLessons.length}개)
            </h4>
            <table class="w-full">
              <thead class="bg-gray-200">
                <tr>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-600">강의명</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-600">일시</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-600">시간</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-600">상태</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-600">다시보기</th>
                  <th class="px-4 py-2 text-center text-xs font-semibold text-gray-600">작업</th>
                </tr>
              </thead>
              <tbody>
                \${completedLessons.map(renderLessonRow).join('')}
              </tbody>
            </table>
          </div>
        \`;
      }

      // 강의 추가 버튼 (하단)
      html += '<div class="mt-3 pt-3 border-t border-gray-200">' + addBtnsHtml + '</div>';

      html += '</div>';
      contentDiv.innerHTML = html;
    }

    function buildLessonAddButtons(courseId, courseInfo) {
      const safeTitle = (courseInfo.title || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const safeInstructor = (courseInfo.instructor_name || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const duration = courseInfo.duration_minutes || 60;
      const hasClassinUid = !!courseInfo.instructor_classin_uid;

      const liveBtn = '<button onclick="event.stopPropagation(); openCreateSession(' + courseId + ', \\'' + safeTitle + '\\', \\'' + safeInstructor + '\\', ' + duration + ')" class="flex items-center gap-2 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-xl transition-all shadow-sm"><i class="fas fa-video"></i>라이브 강의 추가</button>';

      const recordedBtn = '<button onclick="event.stopPropagation(); openRecordedLessonModal(' + courseId + ', \\'' + safeTitle + '\\', \\'' + safeInstructor + '\\')" class="flex items-center gap-2 px-4 py-2.5 bg-purple-500 hover:bg-purple-600 text-white text-sm font-medium rounded-xl transition-all shadow-sm"><i class="fas fa-cloud-upload-alt"></i>녹화 강의 추가</button>';

      const materialsBtn = '<button onclick="event.stopPropagation(); openCourseMaterialsModal(' + courseId + ', \\'' + safeTitle + '\\')" class="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-xl transition-all shadow-sm"><i class="fas fa-paperclip"></i>강의 자료 추가</button>';

      return '<div class="flex items-center justify-center gap-3">' + liveBtn + recordedBtn + materialsBtn + '</div>';
    }

    function toggleEnterMenu(lessonId) {
      const menu = document.getElementById('enterMenu_' + lessonId);
      const isHidden = menu.classList.contains('hidden');
      // 다른 메뉴 닫기
      document.querySelectorAll('[id^="enterMenu_"]').forEach(m => m.classList.add('hidden'));
      if (isHidden) menu.classList.remove('hidden');
    }
    // 외부 클릭 시 메뉴 닫기
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[id^="enterMenu_"]') && !e.target.closest('button[onclick^="toggleEnterMenu"]')) {
        document.querySelectorAll('[id^="enterMenu_"]').forEach(m => m.classList.add('hidden'));
      }
    });

    async function deleteAdminLesson(lessonId, lessonTitle, courseId, isRecorded) {
      const confirmMsg = isRecorded
        ? '녹화 강의(' + lessonTitle + ')를 삭제하시겠습니까?'
        : '강의(' + lessonTitle + ')를 삭제하시겠습니까?\\n\\n주의: ClassIn에 등록된 강의도 함께 삭제됩니다.';
      if (!confirm(confirmMsg)) {
        return;
      }

      try {
        const res = await fetch('/api/admin/lessons/' + lessonId, {
          method: 'DELETE'
        });

        if (res.ok) {
          showModal('성공', '강의가 삭제되었습니다.');
          loadCourseLessons(courseId);
          loadClasses();
        } else {
          const data = await res.json().catch(function() { return {}; });
          showModal('오류', data.error || '강의 삭제에 실패했습니다.');
        }
      } catch (e) {
        showModal('오류', '강의 삭제 중 오류가 발생했습니다.');
      }
    }

    function openEditLessonModal(lessonId, title, duration, scheduledAt, courseId) {
      // scheduledAt은 UTC ISO → KST로 변환하여 입력 필드에 표시
      var d = new Date(scheduledAt);
      // KST offset (+9h)
      var kst = new Date(d.getTime() + 9 * 3600000);
      var dateVal = kst.toISOString().split('T')[0];
      var timeVal = kst.toISOString().split('T')[1].substring(0, 5);

      var modal = document.getElementById('editLessonModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'editLessonModal';
        modal.className = 'fixed inset-0 z-50 flex items-center justify-center';
        document.body.appendChild(modal);
      }
      modal.innerHTML = '<div class="absolute inset-0 bg-black/50" onclick="closeEditLessonModal()"></div>' +
        '<div class="relative bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">' +
          '<h3 class="text-lg font-bold mb-4"><i class="fas fa-pen text-blue-500 mr-2"></i>강의 수정</h3>' +
          '<div class="space-y-4">' +
            '<div><label class="block text-sm font-medium text-gray-700 mb-1">강의명</label>' +
              '<input type="text" id="editLessonTitle" value="' + title.replace(/"/g, '&quot;') + '" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"></div>' +
            '<div><label class="block text-sm font-medium text-gray-700 mb-1">날짜</label>' +
              '<input type="date" id="editLessonDate" value="' + dateVal + '" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"></div>' +
            '<div><label class="block text-sm font-medium text-gray-700 mb-1">시간 (KST)</label>' +
              '<input type="time" id="editLessonTime" value="' + timeVal + '" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"></div>' +
            '<div><label class="block text-sm font-medium text-gray-700 mb-1">수업 시간 (분)</label>' +
              '<input type="number" id="editLessonDuration" value="' + duration + '" min="10" max="300" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"></div>' +
          '</div>' +
          '<div class="flex gap-2 mt-5">' +
            '<button onclick="closeEditLessonModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-lg text-sm">취소</button>' +
            '<button onclick="saveEditLesson(' + lessonId + ',' + courseId + ')" class="flex-1 py-2 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-lg text-sm">저장</button>' +
          '</div>' +
        '</div>';
      modal.classList.remove('hidden');
    }

    function closeEditLessonModal() {
      var modal = document.getElementById('editLessonModal');
      if (modal) modal.remove();
    }

    async function saveEditLesson(lessonId, courseId) {
      var date = document.getElementById('editLessonDate').value;
      var time = document.getElementById('editLessonTime').value;
      var title = document.getElementById('editLessonTitle').value;
      var duration = parseInt(document.getElementById('editLessonDuration').value);
      if (!date || !time) { alert('날짜와 시간을 입력해주세요.'); return; }

      // KST → UTC ISO 변환
      var kstDate = new Date(date + 'T' + time + ':00+09:00');
      var scheduledAt = kstDate.toISOString();

      try {
        var res = await fetch('/api/admin/lessons/' + lessonId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: scheduledAt, durationMinutes: duration, lessonTitle: title })
        });
        var data = await res.json();
        if (data.success) {
          closeEditLessonModal();
          showModal('성공', '강의가 수정되었습니다.');
          loadCourseLessons(courseId);
        } else {
          alert(data.error || '수정 실패');
        }
      } catch(e) { alert('수정 중 오류가 발생했습니다.'); }
    }

    async function loadInstructorsForSelect() {
      const res = await fetch('/api/admin/instructors');
      const data = await res.json();
      instructorsList = data.instructors || [];
      const select = document.getElementById('classInstructor');
      select.innerHTML = '<option value="">선택하세요</option>' +
        instructorsList.map(i => \`<option value="\${i.id}">\${i.display_name}</option>\`).join('');
    }

    async function loadCategoriesForSelect() {
      const res = await fetch('/api/admin/categories');
      const data = await res.json();
      categoriesList = data.categories || [];
      const select = document.getElementById('classCategory');
      select.innerHTML = '<option value="">선택하세요</option>' +
        categoriesList.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
    }

    function openAddClassModal() {
      document.getElementById('editClassId').value = '';
      document.getElementById('classModalTitle').innerHTML = '<i class="fas fa-book text-blue-500 mr-2"></i>코스 추가';
      document.getElementById('saveClassBtn').textContent = '추가';

      // Clear form
      document.getElementById('classTitle').value = '';
      document.getElementById('classDescription').value = '';
      document.getElementById('classInstructor').value = '';
      document.getElementById('classCategory').value = '';
      document.getElementById('classPrice').value = '';
      document.getElementById('classDuration').value = '60';
      document.getElementById('classLevel').value = 'all';
      document.getElementById('classThumbnail').value = '';
      document.getElementById('thumbnailPreview').classList.add('hidden');
      document.getElementById('thumbnailUploadPlaceholder').classList.remove('hidden');
      document.getElementById('thumbnailUploading').classList.add('hidden');
      document.getElementById('thumbnailFileInput').value = '';

      loadInstructorsForSelect();
      loadCategoriesForSelect();
      document.getElementById('classModal').classList.remove('hidden');
    }

    async function openEditClass(classId) {
      // Load class data
      const res = await fetch('/api/admin/classes');
      const data = await res.json();
      const cls = data.classes.find(c => c.id === classId);
      if (!cls) {
        showModal('오류', '코스를 찾을 수 없습니다.');
        return;
      }

      document.getElementById('editClassId').value = classId;
      document.getElementById('classModalTitle').innerHTML = '<i class="fas fa-edit text-blue-500 mr-2"></i>코스 수정';
      document.getElementById('saveClassBtn').textContent = '수정';

      // Fill form
      document.getElementById('classTitle').value = cls.title || '';
      document.getElementById('classDescription').value = cls.description || '';
      document.getElementById('classPrice').value = cls.price || '';
      document.getElementById('classDuration').value = cls.duration_minutes || 60;
      document.getElementById('classLevel').value = cls.level || 'all';
      document.getElementById('classThumbnail').value = cls.thumbnail || '';

      document.getElementById('thumbnailUploading').classList.add('hidden');
      document.getElementById('thumbnailFileInput').value = '';
      if (cls.thumbnail) {
        document.getElementById('thumbnailImg').src = cls.thumbnail;
        document.getElementById('thumbnailPreview').classList.remove('hidden');
        document.getElementById('thumbnailUploadPlaceholder').classList.add('hidden');
      } else {
        document.getElementById('thumbnailPreview').classList.add('hidden');
        document.getElementById('thumbnailUploadPlaceholder').classList.remove('hidden');
      }

      await loadInstructorsForSelect();
      await loadCategoriesForSelect();
      document.getElementById('classInstructor').value = cls.instructor_id || '';
      document.getElementById('classCategory').value = cls.category_id || '';

      document.getElementById('classModal').classList.remove('hidden');
    }

    function closeClassModal() {
      document.getElementById('classModal').classList.add('hidden');
    }

    async function confirmSaveClass() {
      const classId = document.getElementById('editClassId').value;
      const title = document.getElementById('classTitle').value.trim();
      const description = document.getElementById('classDescription').value.trim();
      const instructorId = document.getElementById('classInstructor').value;
      const categoryId = document.getElementById('classCategory').value;
      const price = document.getElementById('classPrice').value;
      const durationMinutes = document.getElementById('classDuration').value;
      const level = document.getElementById('classLevel').value;
      const thumbnail = document.getElementById('classThumbnail').value.trim();

      if (!title || !instructorId || !categoryId) {
        showModal('오류', '제목, 강사, 카테고리는 필수입니다.');
        return;
      }

      const body = {
        title, description,
        instructorId: parseInt(instructorId),
        categoryId: parseInt(categoryId),
        price: price ? parseInt(price) : 0,
        durationMinutes: durationMinutes ? parseInt(durationMinutes) : 60,
        level, thumbnail
      };

      const url = classId ? '/api/admin/classes/' + classId : '/api/admin/classes';
      const method = classId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      if (data.success) {
        closeClassModal();
        showModal('성공', classId ? '코스가 수정되었습니다.' : '코스가 추가되었습니다.');
        loadClasses();
      } else {
        showModal('오류', data.error || '저장 실패');
      }
    }

    async function deleteClass(classId, classTitle) {
      if (!confirm(classTitle + ' 코스를 삭제하시겠습니까?')) return;

      const res = await fetch('/api/admin/classes/' + classId, { method: 'DELETE' });
      const data = await res.json();

      if (data.success) {
        showModal('성공', data.message);
        loadClasses();
      } else {
        showModal('오류', data.error || '삭제 실패');
      }
    }

    // Thumbnail upload functions
    function handleDragOver(e) {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('thumbnailDropZone').classList.add('border-blue-500', 'bg-blue-50');
    }

    function handleDragLeave(e) {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('thumbnailDropZone').classList.remove('border-blue-500', 'bg-blue-50');
    }

    function handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('thumbnailDropZone').classList.remove('border-blue-500', 'bg-blue-50');
      
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        uploadThumbnail(files[0]);
      }
    }

    function handleFileSelect(e) {
      const files = e.target.files;
      if (files.length > 0) {
        uploadThumbnail(files[0]);
      }
    }

    async function uploadThumbnail(file) {
      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        showModal('오류', '지원하지 않는 이미지 형식입니다. (JPEG, PNG, GIF, WebP만 가능)');
        return;
      }

      // Validate file size (5MB)
      if (file.size > 5 * 1024 * 1024) {
        showModal('오류', '이미지 크기는 5MB 이하여야 합니다.');
        return;
      }

      // Show uploading state
      document.getElementById('thumbnailUploadPlaceholder').classList.add('hidden');
      document.getElementById('thumbnailPreview').classList.add('hidden');
      document.getElementById('thumbnailUploading').classList.remove('hidden');

      try {
        const formData = new FormData();
        formData.append('image', file);

        const res = await fetch('/api/admin/upload-image', {
          method: 'POST',
          body: formData
        });

        const data = await res.json();

        if (data.success) {
          document.getElementById('classThumbnail').value = data.url;
          document.getElementById('thumbnailImg').src = data.url;
          document.getElementById('thumbnailUploading').classList.add('hidden');
          document.getElementById('thumbnailPreview').classList.remove('hidden');
        } else {
          throw new Error(data.error || '업로드 실패');
        }
      } catch (error) {
        document.getElementById('thumbnailUploading').classList.add('hidden');
        document.getElementById('thumbnailUploadPlaceholder').classList.remove('hidden');
        showModal('오류', '이미지 업로드 실패: ' + error.message);
      }
    }

    function removeThumbnail() {
      document.getElementById('classThumbnail').value = '';
      document.getElementById('thumbnailImg').src = '';
      document.getElementById('thumbnailPreview').classList.add('hidden');
      document.getElementById('thumbnailUploadPlaceholder').classList.remove('hidden');
      document.getElementById('thumbnailFileInput').value = '';
    }

    let lessonRowCounter = 0;

    function openCreateSession(classId, className, instructorName, durationMinutes) {
      selectedClassId = classId;
      document.getElementById('sessionClassName').textContent = className;
      document.getElementById('sessionInstructor').textContent = instructorName;
      document.getElementById('sessionClassId').value = classId;
      document.getElementById('sessionDurationDefault').value = durationMinutes || 60;

      // 강의 행 초기화
      document.getElementById('lessonRowsContainer').innerHTML = '';
      lessonRowCounter = 0;
      addLessonRow(); // 첫 번째 행 추가

      document.getElementById('createSessionModal').classList.remove('hidden');
    }

    function getDefaultDateTime(offsetMinutes = 5) {
      const defaultTime = new Date(Date.now() + offsetMinutes * 60 * 1000);
      const year = defaultTime.getFullYear();
      const month = String(defaultTime.getMonth() + 1).padStart(2, '0');
      const day = String(defaultTime.getDate()).padStart(2, '0');
      const hours = String(defaultTime.getHours()).padStart(2, '0');
      const minutes = String(defaultTime.getMinutes()).padStart(2, '0');
      return year + '-' + month + '-' + day + 'T' + hours + ':' + minutes;
    }

    function addLessonRow() {
      const container = document.getElementById('lessonRowsContainer');
      const durationDefault = document.getElementById('sessionDurationDefault').value || 60;
      const rowId = ++lessonRowCounter;
      const minTime = getDefaultDateTime(5);

      const row = document.createElement('div');
      row.id = 'lessonRow_' + rowId;
      row.className = 'bg-gray-50 rounded-xl p-4 space-y-3 border border-gray-200';
      row.innerHTML = \`
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold text-gray-700"><i class="fas fa-play-circle text-blue-500 mr-1"></i>강의 #\${rowId}</span>
          \${lessonRowCounter > 1 ? '<button type="button" onclick="removeLessonRow(' + rowId + ')" class="text-red-400 hover:text-red-600 text-xs"><i class="fas fa-trash-alt"></i></button>' : ''}
        </div>
        <input type="text" id="lessonTitle_\${rowId}" placeholder="강의명 (선택, 기본: 코스명 #번호)" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="text-xs text-gray-500">시작 일시</label>
            <input type="datetime-local" id="lessonTime_\${rowId}" value="\${minTime}" min="\${minTime}" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="text-xs text-gray-500">시간(분)</label>
            <input type="number" id="lessonDuration_\${rowId}" value="\${durationDefault}" min="10" max="360" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
          </div>
        </div>
        <div>
          <label class="text-xs text-gray-500">강의 설명</label>
          <textarea id="lessonDesc_\${rowId}" placeholder="이 강의에서 다루는 내용을 간단히 설명해주세요" rows="2" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 resize-none"></textarea>
        </div>
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs font-semibold text-gray-600"><i class="fas fa-list-ol mr-1"></i>커리큘럼 항목</label>
            <button type="button" onclick="addCurriculumItem(\${rowId})" class="text-xs text-blue-500 hover:text-blue-700 font-medium"><i class="fas fa-plus mr-1"></i>항목 추가</button>
          </div>
          <div id="curriculumItems_\${rowId}" class="space-y-2"></div>
        </div>
      \`;
      container.appendChild(row);
    }

    function removeLessonRow(rowId) {
      const row = document.getElementById('lessonRow_' + rowId);
      if (row) row.remove();
    }

    // 커리큘럼 항목 추가
    let curriculumItemCounters = {};
    function addCurriculumItem(rowId) {
      if (!curriculumItemCounters[rowId]) curriculumItemCounters[rowId] = 0;
      curriculumItemCounters[rowId]++;
      const itemId = curriculumItemCounters[rowId];
      const container = document.getElementById('curriculumItems_' + rowId);
      const item = document.createElement('div');
      item.id = 'currItem_' + rowId + '_' + itemId;
      item.className = 'flex gap-2 items-start bg-white rounded-lg p-2 border border-gray-100';
      item.innerHTML = '<span class="text-xs text-gray-400 mt-2 font-mono">' + itemId + '.</span>' +
        '<div class="flex-1 space-y-1">' +
        '<input type="text" placeholder="항목 제목" class="curr-title w-full px-2 py-1 text-sm border border-gray-200 rounded focus:ring-1 focus:ring-blue-400">' +
        '<input type="text" placeholder="항목 설명 (선택)" class="curr-desc w-full px-2 py-1 text-xs border border-gray-100 rounded text-gray-500 focus:ring-1 focus:ring-blue-400">' +
        '</div>' +
        '<button type="button" onclick="document.getElementById(\\\'currItem_' + rowId + '_' + itemId + '\\\').remove()" class="text-red-300 hover:text-red-500 mt-2"><i class="fas fa-times text-xs"></i></button>';
      container.appendChild(item);
    }

    // 강의 자료 업로드
    async function uploadMaterial(input, rowId) {
      const file = input.files[0];
      if (!file) return;
      input.value = '';

      const container = document.getElementById('materialsList_' + rowId);
      const currentCount = container.querySelectorAll('.material-item').length;
      if (currentCount >= 5) {
        showModal('알림', '강의 자료는 최대 5개까지 첨부할 수 있습니다.');
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        showModal('오류', '파일 크기는 50MB 이하여야 합니다.');
        return;
      }

      // 업로드 중 표시
      const tempId = 'matTemp_' + Date.now();
      container.insertAdjacentHTML('beforeend',
        '<div id="' + tempId + '" class="material-item flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-gray-100 text-sm">' +
        '<i class="fas fa-spinner fa-spin text-blue-400"></i>' +
        '<span class="flex-1 text-gray-500 truncate">' + file.name + ' 업로드 중...</span>' +
        '</div>');

      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/admin/upload-material', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.success) {
          const el = document.getElementById(tempId);
          el.innerHTML = '<i class="fas fa-file-alt text-purple-400"></i>' +
            '<span class="flex-1 truncate text-gray-700">' + data.filename + '</span>' +
            '<input type="hidden" class="mat-url" value="' + data.url + '">' +
            '<input type="hidden" class="mat-name" value="' + data.filename + '">' +
            '<button type="button" onclick="this.closest(\\\'.material-item\\\').remove()" class="text-red-300 hover:text-red-500"><i class="fas fa-times text-xs"></i></button>';
        } else {
          document.getElementById(tempId).remove();
          showModal('오류', data.error || '업로드 실패');
        }
      } catch (e) {
        document.getElementById(tempId).remove();
        showModal('오류', '파일 업로드 중 오류: ' + e.message);
      }
    }

    // 강의 행에서 커리큘럼/자료 데이터 수집
    function collectLessonData(rowId) {
      const title = document.getElementById('lessonTitle_' + rowId)?.value || '';
      const time = document.getElementById('lessonTime_' + rowId)?.value || '';
      const duration = parseInt(document.getElementById('lessonDuration_' + rowId)?.value || '60');
      const desc = document.getElementById('lessonDesc_' + rowId)?.value || '';

      // 커리큘럼 항목 수집
      const currItems = [];
      const currContainer = document.getElementById('curriculumItems_' + rowId);
      if (currContainer) {
        currContainer.querySelectorAll('[id^="currItem_"]').forEach(item => {
          const t = item.querySelector('.curr-title')?.value || '';
          const d = item.querySelector('.curr-desc')?.value || '';
          if (t) currItems.push({ title: t, desc: d });
        });
      }

      // 자료 수집
      const mats = [];
      const matsContainer = document.getElementById('materialsList_' + rowId);
      if (matsContainer) {
        matsContainer.querySelectorAll('.material-item').forEach(item => {
          const url = item.querySelector('.mat-url')?.value;
          const name = item.querySelector('.mat-name')?.value;
          if (url && name) mats.push({ url: url, filename: name });
        });
      }

      return { title, scheduledAt: time, durationMinutes: duration, description: desc, curriculumItems: currItems, materials: mats };
    }

    function closeSessionModal() {
      document.getElementById('createSessionModal').classList.add('hidden');
      selectedClassId = null;
    }

    // ==================== 녹화 강의 관련 함수 ====================

    let recordedStreamUid = '';
    let tusUpload = null;

    let recordedCurrCounter = 0;


    // ==================== Course Materials Functions ====================
    let courseMaterials = [];

    async function openCourseMaterialsModal(courseId, courseName) {
      document.getElementById('materialCourseId').value = courseId;
      document.getElementById('materialCourseName').textContent = courseName;
      courseMaterials = [];

      // Load existing materials
      try {
        const res = await fetch('/api/admin/classes/' + courseId + '/materials');
        const data = await res.json();
        if (data.materials) {
          courseMaterials = data.materials;
        }
      } catch (e) {
        console.error('Failed to load materials:', e);
      }

      renderCourseMaterialsList();
      document.getElementById('courseMaterialsModal').classList.remove('hidden');
    }

    function closeCourseMaterialsModal() {
      document.getElementById('courseMaterialsModal').classList.add('hidden');
      courseMaterials = [];
    }

    function renderCourseMaterialsList() {
      const container = document.getElementById('courseMaterialsList');
      const noText = document.getElementById('noMaterialsText');

      if (courseMaterials.length === 0) {
        container.innerHTML = '<p class="text-sm text-gray-400 text-center py-4" id="noMaterialsText">등록된 자료가 없습니다</p>';
        return;
      }

      container.innerHTML = courseMaterials.map(function(m, idx) {
        return '<div class="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">' +
          '<div class="flex items-center gap-2 min-w-0">' +
            '<i class="fas fa-file text-amber-500"></i>' +
            '<span class="text-sm truncate">' + m.filename + '</span>' +
          '</div>' +
          '<button onclick="removeCourseMaterial(' + idx + ')" class="text-red-400 hover:text-red-600 p-1">' +
            '<i class="fas fa-times"></i>' +
          '</button>' +
        '</div>';
      }).join('');
    }

    // 강의 자료 드롭 핸들러
    function handleMaterialDrop(event) {
      const files = event.dataTransfer.files;
      if (!files.length) return;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.size > 50 * 1024 * 1024) {
          showModal('오류', file.name + ': 파일 크기는 50MB 이하여야 합니다.');
          continue;
        }
        uploadCourseMaterialFile(file);
      }
    }

    async function uploadCourseMaterialFile(file) {
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/admin/upload-material', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (data.success) {
          courseMaterials.push({ url: data.url, filename: data.filename });
          renderCourseMaterialsList();
        } else {
          showModal('오류', data.error || '업로드 실패: ' + file.name);
        }
      } catch (e) {
        showModal('오류', '업로드 중 오류가 발생했습니다.');
      }
    }

    async function uploadCourseMaterial(input) {
      if (!input.files[0]) return;
      const file = input.files[0];

      if (file.size > 50 * 1024 * 1024) {
        alert('파일 크기는 50MB 이하여야 합니다.');
        input.value = '';
        return;
      }

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch('/api/admin/upload-material', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (data.success) {
          courseMaterials.push({ url: data.url, filename: data.filename });
          renderCourseMaterialsList();
        } else {
          alert(data.error || '업로드 실패');
        }
      } catch (e) {
        alert('업로드 중 오류가 발생했습니다.');
      }
      input.value = '';
    }

    function removeCourseMaterial(idx) {
      courseMaterials.splice(idx, 1);
      renderCourseMaterialsList();
    }

    async function saveCourseMaterials() {
      const courseId = document.getElementById('materialCourseId').value;
      try {
        const res = await fetch('/api/admin/classes/' + courseId + '/materials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ materials: courseMaterials })
        });
        const data = await res.json();
        if (data.success) {
          closeCourseMaterialsModal();
          alert('강의 자료가 저장되었습니다.');
        } else {
          alert(data.error || '저장 실패');
        }
      } catch (e) {
        alert('저장 중 오류가 발생했습니다.');
      }
    }

    // ==================== Recorded Lesson Functions ====================
    function openRecordedLessonModal(classId, className, instructorName) {
      document.getElementById('recordedClassName').textContent = className;
      document.getElementById('recordedInstructor').textContent = instructorName;
      document.getElementById('recordedClassId').value = classId;
      document.getElementById('recordedLessonTitle').value = '';
      document.getElementById('recordedLessonDesc').value = '';
      document.getElementById('recordedCurriculumItems').innerHTML = '';
      
      recordedCurrCounter = 0;
      resetVideoUpload();
      document.getElementById('recordedLessonModal').classList.remove('hidden');
    }

    function addRecordedCurriculumItem() {
      recordedCurrCounter++;
      const itemId = recordedCurrCounter;
      const container = document.getElementById('recordedCurriculumItems');
      const item = document.createElement('div');
      item.id = 'recCurrItem_' + itemId;
      item.className = 'flex gap-2 items-start bg-white rounded-lg p-2 border border-gray-100';
      item.innerHTML = '<span class="text-xs text-gray-400 mt-2 font-mono">' + itemId + '.</span>' +
        '<div class="flex-1 space-y-1">' +
        '<input type="text" placeholder="항목 제목" class="rec-curr-title w-full px-2 py-1 text-sm border border-gray-200 rounded focus:ring-1 focus:ring-purple-400">' +
        '<input type="text" placeholder="항목 설명 (선택)" class="rec-curr-desc w-full px-2 py-1 text-xs border border-gray-100 rounded text-gray-500 focus:ring-1 focus:ring-purple-400">' +
        '</div>' +
        '<button type="button" onclick="document.getElementById(\\\'recCurrItem_' + itemId + '\\\').remove()" class="text-red-300 hover:text-red-500 mt-2"><i class="fas fa-times text-xs"></i></button>';
      container.appendChild(item);
    }

    async function uploadRecordedMaterial(input) {
      const file = input.files[0];
      if (!file) return;
      input.value = '';

      const container = document.getElementById('recordedMaterialsList');
      const currentCount = container.querySelectorAll('.material-item').length;
      if (currentCount >= 5) {
        showModal('알림', '강의 자료는 최대 5개까지 첨부할 수 있습니다.');
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        showModal('오류', '파일 크기는 50MB 이하여야 합니다.');
        return;
      }

      const tempId = 'recMatTemp_' + Date.now();
      container.insertAdjacentHTML('beforeend',
        '<div id="' + tempId + '" class="material-item flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-gray-100 text-sm">' +
        '<i class="fas fa-spinner fa-spin text-purple-400"></i>' +
        '<span class="flex-1 text-gray-500 truncate">' + file.name + ' 업로드 중...</span>' +
        '</div>');

      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/admin/upload-material', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.success) {
          const el = document.getElementById(tempId);
          el.innerHTML = '<i class="fas fa-file-alt text-purple-400"></i>' +
            '<span class="flex-1 truncate text-gray-700">' + data.filename + '</span>' +
            '<input type="hidden" class="mat-url" value="' + data.url + '">' +
            '<input type="hidden" class="mat-name" value="' + data.filename + '">' +
            '<button type="button" onclick="this.closest(\\\'.material-item\\\').remove()" class="text-red-300 hover:text-red-500"><i class="fas fa-times text-xs"></i></button>';
        } else {
          document.getElementById(tempId).remove();
          showModal('오류', data.error || '업로드 실패');
        }
      } catch (e) {
        document.getElementById(tempId).remove();
        showModal('오류', '파일 업로드 중 오류: ' + e.message);
      }
    }

    function closeRecordedLessonModal() {
      document.getElementById('recordedLessonModal').classList.add('hidden');
      if (tusUpload) {
        tusUpload.abort();
        tusUpload = null;
      }
      recordedStreamUid = '';
    }

    function resetVideoUpload() {
      document.getElementById('recordedVideoFile').value = '';
      document.getElementById('recordedStreamUid').value = '';
      document.getElementById('uploadPlaceholder').classList.remove('hidden');
      document.getElementById('uploadProgress').classList.add('hidden');
      document.getElementById('uploadComplete').classList.add('hidden');
      document.getElementById('createRecordedLessonBtn').disabled = true;
      recordedStreamUid = '';
      if (tusUpload) {
        tusUpload.abort();
        tusUpload = null;
      }
    }

    // TUS 업로드 설정
    const TUS_CHUNK_SIZE = 50 * 1024 * 1024; // 50MB per TUS chunk
    const TUS_UPLOAD_THRESHOLD = 200 * 1024 * 1024; // 200MB 이상이면 TUS 사용

    // 동영상 드롭 핸들러
    function handleVideoDrop(event) {
      const file = event.dataTransfer.files[0];
      if (!file) return;
      if (!file.type.startsWith('video/')) {
        showModal('오류', '동영상 파일만 업로드할 수 있습니다.');
        return;
      }
      const fileInput = document.getElementById('recordedVideoFile');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      handleVideoSelect(fileInput);
    }

    async function handleVideoSelect(input) {
      const file = input.files[0];
      if (!file) return;

      // 파일 크기 체크 (최대 5GB)
      if (file.size > 5 * 1024 * 1024 * 1024) {
        showModal('오류', '파일 크기가 너무 큽니다. 최대 5GB까지 업로드 가능합니다.');
        input.value = '';
        return;
      }

      // UI 업데이트
      document.getElementById('uploadPlaceholder').classList.add('hidden');
      document.getElementById('uploadProgress').classList.remove('hidden');
      document.getElementById('uploadComplete').classList.add('hidden');

      try {
        // 200MB 이상이면 TUS resumable upload, 아니면 기존 방식
        if (file.size >= TUS_UPLOAD_THRESHOLD) {
          await handleTusUpload(file);
        } else {
          await handleDirectUpload(file);
        }
      } catch (e) {
        console.error('Upload error:', e);
        showModal('오류', e.message || '업로드 중 오류가 발생했습니다.');
        resetVideoUpload();
      }
    }

    // TUS resumable upload (200MB 이상 대용량 파일)
    async function handleTusUpload(file) {
      const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'video.mp4';

      document.getElementById('uploadStatusText').textContent = 'TUS 업로드 준비 중...';
      console.log('TUS upload starting:', { filename: safeFilename, totalSize: file.size });

      // 1. tus-js-client 라이브러리 로드
      await loadScript('https://cdn.jsdelivr.net/npm/tus-js-client@4.1.0/dist/tus.min.js');
      console.log('TUS library loaded');

      // 2. TUS 업로드 URL 발급
      const tusUrlRes = await fetch('/api/admin/stream/tus-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadLength: file.size,
          filename: safeFilename
        })
      });

      if (!tusUrlRes.ok) {
        const errText = await tusUrlRes.text();
        console.error('TUS URL failed:', errText);
        throw new Error('TUS 업로드 URL 발급 실패');
      }

      const tusData = await tusUrlRes.json();
      console.log('TUS upload URL:', tusData);

      if (!tusData.uploadURL) {
        throw new Error(tusData.error || 'TUS 업로드 URL 없음');
      }

      recordedStreamUid = tusData.uid;
      document.getElementById('recordedStreamUid').value = tusData.uid;

      // 3. TUS 업로드 시작
      document.getElementById('uploadStatusText').textContent = '업로드 중...';

      return new Promise((resolve, reject) => {
        const upload = new tus.Upload(file, {
          endpoint: tusData.uploadURL,
          uploadUrl: tusData.uploadURL,
          chunkSize: TUS_CHUNK_SIZE,
          retryDelays: [0, 1000, 3000, 5000, 10000],
          metadata: {
            filename: safeFilename,
            filetype: file.type || 'video/mp4'
          },
          onError: function(error) {
            console.error('TUS upload error:', error);
            reject(new Error('TUS 업로드 실패: ' + error.message));
          },
          onProgress: function(bytesUploaded, bytesTotal) {
            const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
            document.getElementById('uploadProgressBar').style.width = percentage + '%';
            document.getElementById('uploadPercentText').textContent = percentage + '%';
            const uploadedMB = (bytesUploaded / 1024 / 1024).toFixed(1);
            const totalMB = (bytesTotal / 1024 / 1024).toFixed(1);
            document.getElementById('uploadStatusText').textContent = '업로드 중... ' + uploadedMB + 'MB / ' + totalMB + 'MB';
          },
          onSuccess: function() {
            console.log('TUS upload success, uid:', recordedStreamUid);
            document.getElementById('uploadProgress').classList.add('hidden');
            document.getElementById('uploadComplete').classList.remove('hidden');
            document.getElementById('createRecordedLessonBtn').disabled = false;

            // 비디오 정보 폴링
            pollVideoStatus(recordedStreamUid);
            resolve();
          }
        });

        // 저장해서 취소 시 사용
        tusUpload = upload;

        // 이전 업로드 이어받기 시도
        upload.findPreviousUploads().then(function(previousUploads) {
          if (previousUploads.length > 0) {
            console.log('Found previous upload, resuming...');
            upload.resumeFromPreviousUpload(previousUploads[0]);
          }
          upload.start();
        });
      });
    }

    // 기존 직접 업로드 (500MB 미만)
    async function handleDirectUpload(file) {
      document.getElementById('uploadStatusText').textContent = '업로드 URL 발급 중...';

      // 1. 업로드 URL 발급
      const urlRes = await fetch('/api/admin/stream/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDurationSeconds: 7200 })
      });
      const urlData = await urlRes.json();

      if (!urlData.uploadURL) {
        throw new Error(urlData.error || '업로드 URL 발급 실패');
      }

      recordedStreamUid = urlData.uid;
      document.getElementById('recordedStreamUid').value = urlData.uid;
      document.getElementById('uploadStatusText').textContent = '업로드 중...';

      // 2. Cloudflare Stream 기본 업로드 (POST + FormData)
      const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'video.mp4';
      const formData = new FormData();
      formData.append('file', file, safeFilename);

      // 동적 타임아웃: 최소 10분, GB당 10분 추가
      const fileSizeGB = file.size / (1024 * 1024 * 1024);
      const dynamicTimeout = Math.max(600000, Math.ceil(fileSizeGB) * 600000);

      // 재시도 로직이 포함된 업로드 함수
      const uploadWithRetry = async (maxRetries = 3) => {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open('POST', urlData.uploadURL, true);
              xhr.timeout = dynamicTimeout;

              xhr.upload.onprogress = function(e) {
                if (e.lengthComputable) {
                  const percentage = Math.round((e.loaded / e.total) * 100);
                  document.getElementById('uploadProgressBar').style.width = percentage + '%';
                  document.getElementById('uploadPercentText').textContent = percentage + '%';
                  if (attempt > 1) {
                    document.getElementById('uploadStatusText').textContent = '재시도 ' + attempt + '/' + maxRetries + ' - ' + percentage + '%';
                  }
                }
              };

              xhr.onload = function() {
                if (xhr.status >= 200 && xhr.status < 300) {
                  console.log('Upload success:', xhr.responseText);
                  resolve(xhr.response);
                } else {
                  console.error('Upload failed:', xhr.status, xhr.responseText);
                  reject(new Error('업로드 실패: ' + xhr.status + ' - ' + (xhr.responseText || 'Unknown error')));
                }
              };

              xhr.onerror = function() {
                console.error('Upload network error (attempt ' + attempt + ')');
                const onlineStatus = navigator.onLine ? '서버 응답 없음' : '인터넷 연결 끊김';
                reject(new Error('네트워크 오류: ' + onlineStatus));
              };

              xhr.ontimeout = function() {
                console.error('Upload timeout (attempt ' + attempt + ')');
                reject(new Error('업로드 시간 초과 (타임아웃: ' + Math.round(dynamicTimeout / 60000) + '분)'));
              };

              xhr.send(formData);
            });
            return; // 성공하면 종료
          } catch (err) {
            lastError = err;
            console.warn('Upload attempt ' + attempt + ' failed:', err.message);
            if (attempt < maxRetries) {
              // 재시도 전 대기 (exponential backoff: 2초, 4초, 8초...)
              const waitTime = Math.pow(2, attempt) * 1000;
              document.getElementById('uploadStatusText').textContent = '재시도 대기 중... (' + (waitTime / 1000) + '초)';
              document.getElementById('uploadProgressBar').style.width = '0%';
              document.getElementById('uploadPercentText').textContent = '0%';
              await new Promise(r => setTimeout(r, waitTime));
            }
          }
        }
        throw lastError; // 모든 재시도 실패
      };

      await uploadWithRetry(3);

      // 업로드 성공
      document.getElementById('uploadProgress').classList.add('hidden');
      document.getElementById('uploadComplete').classList.remove('hidden');
      document.getElementById('createRecordedLessonBtn').disabled = false;

      // 비디오 정보 폴링 (duration 등)
      pollVideoStatus(recordedStreamUid);
    }

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        if (document.querySelector('script[src="' + src + '"]')) {
          resolve();
          return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    async function pollVideoStatus(uid, attempts = 0) {
      if (attempts > 30) {
        document.getElementById('videoDurationText').textContent = '영상 처리 시간 초과. 생성 후 자동 업데이트됩니다.';
        return;
      }

      try {
        // Stream API로 직접 조회할 수 없으므로 녹화 강의 생성 시 서버에서 조회
        document.getElementById('videoDurationText').textContent = '영상 처리 중... (생성 시 자동 확인)';
      } catch (e) {
        setTimeout(() => pollVideoStatus(uid, attempts + 1), 2000);
      }
    }

    async function confirmCreateRecordedLesson() {
      const classId = document.getElementById('recordedClassId').value;
      const title = document.getElementById('recordedLessonTitle').value.trim();
      const streamUid = document.getElementById('recordedStreamUid').value || recordedStreamUid;
      const description = document.getElementById('recordedLessonDesc').value.trim();

      // 커리큘럼 항목 수집
      const curriculumItems = [];
      document.getElementById('recordedCurriculumItems').querySelectorAll('[id^="recCurrItem_"]').forEach(function(item) {
        const t = item.querySelector('.rec-curr-title')?.value || '';
        const d = item.querySelector('.rec-curr-desc')?.value || '';
        if (t) curriculumItems.push({ title: t, desc: d });
      });

      // 자료는 코스 레벨에서 관리
      const materials = [];

      if (!streamUid) {
        showModal('오류', '동영상을 먼저 업로드해주세요.');
        return;
      }

      const btn = document.getElementById('createRecordedLessonBtn');
      btn.disabled = true;
      btn.textContent = '생성 중...';

      try {
        const res = await fetch('/api/admin/classes/' + classId + '/create-recorded-lesson', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title || null,
            streamUid: streamUid,
            description: description || null,
            curriculumItems: curriculumItems,
            materials: materials
          })
        });

        const data = await res.json();

        if (data.success) {
          showModal('성공', data.message || '녹화 강의가 생성되었습니다!');
          closeRecordedLessonModal();
          loadClasses();
        } else {
          showModal('오류', data.error || '강의 생성 실패');
        }
      } catch (e) {
        showModal('오류', '강의 생성 중 오류가 발생했습니다.');
      } finally {
        btn.disabled = false;
        btn.textContent = '생성';
      }
    }

    // ==================== 라이브 강의 관련 함수 ====================

    async function confirmCreateSession() {
      if (!selectedClassId) return;

      // 모든 강의 행에서 데이터 수집 (커리큘럼 + 자료 포함)
      const lessons = [];
      const rows = document.getElementById('lessonRowsContainer').children;
      for (const row of rows) {
        const rowId = row.id.replace('lessonRow_', '');
        const data = collectLessonData(rowId);

        if (!data.scheduledAt) {
          showModal('오류', '모든 강의의 시작 시간을 입력해주세요.');
          return;
        }
        data.scheduledAt = new Date(data.scheduledAt).toISOString();
        lessons.push(data);
      }

      if (lessons.length === 0) {
        showModal('오류', '최소 1개의 강의을 추가해주세요.');
        return;
      }

      // 중복 클릭 방지
      const btn = document.getElementById('createSessionBtn');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>생성중...';

      try {
        const res = await fetch('/api/admin/classes/' + selectedClassId + '/create-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lessons })
        });
        const data = await res.json();

        closeSessionModal();

        if (data.success) {
          showModal('성공', data.message || '강의가 생성되었습니다!');
          loadClasses();
        } else {
          showModal('오류', data.error || '강의 생성 실패');
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = '생성';
      }
    }

    // Settings modal functions
    function openSettingsModal() {
      document.getElementById('currentPassword').value = '';
      document.getElementById('newPassword').value = '';
      document.getElementById('confirmPassword').value = '';
      document.getElementById('settingsModal').classList.remove('hidden');
    }

    function closeSettingsModal() {
      document.getElementById('settingsModal').classList.add('hidden');
    }

    async function changePassword() {
      const currentPassword = document.getElementById('currentPassword').value;
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;

      if (!currentPassword || !newPassword || !confirmPassword) {
        showModal('오류', '모든 필드를 입력해주세요.');
        return;
      }

      if (newPassword !== confirmPassword) {
        showModal('오류', '새 비밀번호가 일치하지 않습니다.');
        return;
      }

      if (newPassword.length < 6) {
        showModal('오류', '새 비밀번호는 6자 이상이어야 합니다.');
        return;
      }

      const res = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json();

      if (data.success) {
        closeSettingsModal();
        showModal('성공', data.message);
      } else {
        showModal('오류', data.error || '비밀번호 변경 실패');
      }
    }

    // Initial load
    loadAccounts();
    loadInstructors();
    loadClasses();
  </script>
</body>
</html>
  `)
})

// ==================== Admin Page - Orders Management ====================
app.get('/admin/orders', async (c) => {
  const authRedirect = await requireAdminAuth(c)
  if (authRedirect) return authRedirect

  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>결제 관리 - ClassIn Live 관리자</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
  </style>
</head>
<body class="bg-gray-100 min-h-screen">
  <nav class="bg-gray-900 text-white shadow-lg">
    <div class="max-w-7xl mx-auto px-4 py-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <a href="/" class="text-xl font-bold text-rose-400">ClassIn Live</a>
          <span class="text-gray-400">|</span>
          <span class="text-gray-300">결제 관리</span>
        </div>
        <a href="/admin" class="text-sm text-gray-400 hover:text-white"><i class="fas fa-arrow-left mr-1"></i>관리자 대시보드</a>
      </div>
    </div>
  </nav>

  <div class="max-w-7xl mx-auto px-4 py-8">
    <div class="bg-white rounded-xl p-6 shadow-sm">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-lg font-bold text-gray-800"><i class="fas fa-credit-card text-green-500 mr-2"></i>결제 내역</h2>
        <button onclick="loadOrders()" class="text-sm text-blue-500 hover:text-blue-700"><i class="fas fa-sync-alt mr-1"></i>새로고침</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-200 bg-gray-50">
              <th class="text-left py-3 px-3 text-gray-600 font-medium">주문ID</th>
              <th class="text-left py-3 px-3 text-gray-600 font-medium">사용자</th>
              <th class="text-left py-3 px-3 text-gray-600 font-medium">강의</th>
              <th class="text-right py-3 px-3 text-gray-600 font-medium">금액</th>
              <th class="text-center py-3 px-3 text-gray-600 font-medium">상태</th>
              <th class="text-left py-3 px-3 text-gray-600 font-medium">거래번호</th>
              <th class="text-left py-3 px-3 text-gray-600 font-medium">결제일시</th>
              <th class="text-center py-3 px-3 text-gray-600 font-medium">작업</th>
            </tr>
          </thead>
          <tbody id="ordersTableBody">
            <tr><td colspan="8" class="py-8 text-center text-gray-400">로딩 중...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="modal" class="fixed inset-0 bg-black/50 hidden items-center justify-center z-50" onclick="closeModal()">
    <div class="bg-white rounded-xl p-6 max-w-md mx-4" onclick="event.stopPropagation()">
      <h3 id="modalTitle" class="text-lg font-bold mb-2"></h3>
      <p id="modalMessage" class="text-gray-600 mb-4"></p>
      <button onclick="closeModal()" class="w-full bg-gray-800 text-white py-2 rounded-lg">확인</button>
    </div>
  </div>

  <script>
    function showModal(title, message) {
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalMessage').textContent = message;
      document.getElementById('modal').classList.remove('hidden');
      document.getElementById('modal').classList.add('flex');
    }
    function closeModal() {
      document.getElementById('modal').classList.add('hidden');
      document.getElementById('modal').classList.remove('flex');
    }

    async function loadOrders() {
      try {
        var res = await fetch('/api/admin/orders');
        var data = await res.json();
        console.log("[Cancel Response]", data);

        if (data.error) {
          document.getElementById('ordersTableBody').innerHTML = '<tr><td colspan="8" class="py-8 text-center text-red-400">' + data.error + '</td></tr>';
          return;
        }

        if (!data.orders || data.orders.length === 0) {
          document.getElementById('ordersTableBody').innerHTML = '<tr><td colspan="8" class="py-8 text-center text-gray-400">결제 내역이 없습니다.</td></tr>';
          return;
        }

        document.getElementById('ordersTableBody').innerHTML = data.orders.map(function(order) {
          var statusClass = order.payment_status === 'completed' ? 'bg-green-100 text-green-700' :
                order.payment_status === 'cancelled' ? 'bg-red-100 text-red-700' :
                'bg-yellow-100 text-yellow-700';
          var statusText = order.payment_status === 'completed' ? '완료' :
                order.payment_status === 'cancelled' ? '취소됨' : '대기';
          var cancelBtn = order.payment_status === 'completed' ?
                '<button onclick="cancelOrder(' + order.id + ')" class="bg-red-50 text-red-500 hover:bg-red-100 px-3 py-1 rounded-lg text-xs font-medium"><i class="fas fa-times-circle mr-1"></i>취소</button>' :
                '<span class="text-gray-300">-</span>';
          return '<tr class="border-b border-gray-100 hover:bg-gray-50" data-order-id="' + order.id + '">' +
            '<td class="py-3 px-3 font-medium">#' + order.id + '</td>' +
            '<td class="py-3 px-3">' + (order.user_name || '-') + '<br><span class="text-xs text-gray-400">' + (order.user_email || '') + '</span></td>' +
            '<td class="py-3 px-3">' + (order.class_title || '-') + '</td>' +
            '<td class="py-3 px-3 text-right font-medium">' + Number(order.amount).toLocaleString() + '원</td>' +
            '<td class="py-3 px-3 text-center status-cell"><span class="px-2 py-1 rounded-full text-xs font-medium ' + statusClass + '">' + statusText + '</span></td>' +
            '<td class="py-3 px-3 text-xs text-gray-500">' + (order.transaction_id || '-') + '</td>' +
            '<td class="py-3 px-3 text-xs text-gray-500">' + (order.created_at ? new Date(order.created_at + 'Z').toLocaleString('ko-KR', {timeZone: 'Asia/Seoul'}) : '-') + '</td>' +
            '<td class="py-3 px-3 text-center action-cell">' + cancelBtn + '</td>' +
          '</tr>';
        }).join('');
      } catch (e) {
        document.getElementById('ordersTableBody').innerHTML = '<tr><td colspan="8" class="py-8 text-center text-red-400">오류: ' + e.message + '</td></tr>';
      }
    }

    async function cancelOrder(orderId) {
      if (!confirm('이 결제를 취소하시겠습니까?\\n(수강 등록도 함께 취소됩니다)')) return;

      var reason = prompt('취소 사유를 입력하세요:', '고객 요청');
      if (!reason) return;

      try {
        var res = await fetch('/api/admin/orders/' + orderId + '/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason })
        });
        var data = await res.json();
        console.log('[Cancel API Response]', JSON.stringify(data));

        if (data.success) {
          showModal(data.pgError ? '주의' : '완료', data.message || '결제 및 수강이 취소되었습니다.');
          // D1 복제 지연 문제로 UI 직접 업데이트
          var row = document.querySelector('tr[data-order-id="' + orderId + '"]');
          if (row) {
            var statusCell = row.querySelector('.status-cell');
            if (statusCell) {
              statusCell.innerHTML = '<span class="px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700">취소됨</span>';
            }
            var actionCell = row.querySelector('.action-cell');
            if (actionCell) {
              actionCell.innerHTML = '<span class="text-gray-300">-</span>';
            }
          }
        } else {
          showModal('오류', data.error || '취소에 실패했습니다.');
        }
      } catch (e) {
        showModal('오류', '서버 오류: ' + e.message);
      }
    }

    loadOrders();
  </script>
</body>
</html>
`)
})

// ==================== Admin Page - User Management ====================
app.get('/admin/users', async (c) => {
  const authRedirect = await requireAdminAuth(c)
  if (authRedirect) return authRedirect

  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>회원 관리 - ClassIn Live 관리자</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
  </style>
</head>
<body class="bg-gray-100 min-h-screen">
  <nav class="bg-gray-900 text-white shadow-lg">
    <div class="max-w-7xl mx-auto px-4 py-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <a href="/" class="text-xl font-bold text-rose-400">ClassIn Live</a>
          <span class="text-gray-400">|</span>
          <span class="text-gray-300">회원 관리</span>
        </div>
        <a href="/admin" class="text-sm text-gray-400 hover:text-white"><i class="fas fa-arrow-left mr-1"></i>관리자 대시보드</a>
      </div>
    </div>
  </nav>

  <div class="max-w-7xl mx-auto px-4 py-8">
    <!-- Stats -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-emerald-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-users text-emerald-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statTotal">0</p>
            <p class="text-sm text-gray-500">전체 회원</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-user-graduate text-blue-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statStudents">0</p>
            <p class="text-sm text-gray-500">학생</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-chalkboard-teacher text-indigo-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statInstructors">0</p>
            <p class="text-sm text-gray-500">강사</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-yellow-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-flask text-yellow-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statTest">0</p>
            <p class="text-sm text-gray-500">테스트 계정</p>
          </div>
        </div>
      </div>
    </div>

    <!-- User List -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="p-6 border-b border-gray-100">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-bold text-gray-800"><i class="fas fa-users text-emerald-500 mr-2"></i>회원 목록</h2>
          <div class="flex items-center gap-2">
            <input type="text" id="userSearch" placeholder="이름/이메일/전화번호 검색" class="px-3 py-2 border border-gray-200 rounded-lg text-sm w-64" onkeyup="if(event.key===&apos;Enter&apos;){currentPage=0;loadUsers();}">
            <button onclick="currentPage=0;loadUsers()" class="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition-all text-sm">
              <i class="fas fa-search mr-1"></i>검색
            </button>
            <button onclick="document.getElementById(&apos;userSearch&apos;).value=&apos;&apos;;currentPage=0;loadUsers()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg transition-all">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ID</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">이름</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">이메일</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">전화번호</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">역할</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">테스트</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">가입일</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">작업</th>
            </tr>
          </thead>
          <tbody id="usersTable" class="divide-y divide-gray-100">
            <tr><td colspan="8" class="px-6 py-8 text-center text-gray-400">로딩 중...</td></tr>
          </tbody>
        </table>
      </div>
      <div class="p-4 border-t border-gray-100 flex items-center justify-between">
        <p class="text-sm text-gray-500" id="paginationInfo">-</p>
        <div class="flex items-center gap-2">
          <button onclick="prevPage()" class="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50 disabled:opacity-50" id="prevBtn">이전</button>
          <span class="text-sm text-gray-600" id="pageInfo">1</span>
          <button onclick="nextPage()" class="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50 disabled:opacity-50" id="nextBtn">다음</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Result Modal -->
  <div id="resultModal" class="fixed inset-0 z-50 hidden">
    <div class="absolute inset-0 bg-black/50" onclick="closeModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
      <h3 class="text-lg font-bold mb-2" id="modalTitle">알림</h3>
      <p class="text-gray-600 whitespace-pre-wrap" id="modalMessage"></p>
      <button onclick="closeModal()" class="mt-4 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg">확인</button>
    </div>
  </div>

  <script>
    const pageSize = 50;
    let currentPage = 0;
    let totalUsers = 0;

    function showModal(title, message) {
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalMessage').textContent = message;
      document.getElementById('resultModal').classList.remove('hidden');
    }

    function closeModal() {
      document.getElementById('resultModal').classList.add('hidden');
    }

    async function loadUsers() {
      const search = document.getElementById('userSearch').value.trim();
      const res = await fetch('/api/admin/users?limit=' + pageSize + '&offset=' + (currentPage * pageSize) + (search ? '&search=' + encodeURIComponent(search) : ''));
      const data = await res.json();
      totalUsers = data.total || 0;

      // Update stats from API
      if (data.stats) {
        document.getElementById('statTotal').textContent = data.stats.total;
        document.getElementById('statStudents').textContent = data.stats.students;
        document.getElementById('statInstructors').textContent = data.stats.instructors;
        document.getElementById('statTest').textContent = data.stats.testAccounts;
      }

      const tbody = document.getElementById('usersTable');
      if (!data.users || data.users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="px-6 py-8 text-center text-gray-400">회원이 없습니다.</td></tr>';
        document.getElementById('paginationInfo').textContent = '총 0명';
        updatePagination();
        return;
      }

      tbody.innerHTML = data.users.map(user => {
        const isInstr = user.role === 'instructor' || user.is_instructor === 1;
        const roleLabel = user.role === 'admin' ? '관리자' : isInstr ? '강사' : '학생';
        const roleColor = user.role === 'admin' ? 'bg-red-100 text-red-700' : isInstr ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600';
        return \`
          <tr class="hover:bg-gray-50">
            <td class="px-4 py-3 text-sm">\${user.id}</td>
            <td class="px-4 py-3 font-medium">\${user.name}</td>
            <td class="px-4 py-3 text-sm text-gray-500">\${user.email}</td>
            <td class="px-4 py-3 text-sm text-gray-500">\${user.phone || '-'}</td>
            <td class="px-4 py-3"><span class="px-2 py-0.5 rounded text-xs \${roleColor}">\${roleLabel}</span></td>
            <td class="px-4 py-3">\${user.is_test_account ? '<span class="px-2 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700">테스트</span>' : '-'}</td>
            <td class="px-4 py-3 text-xs text-gray-500">\${new Date(user.created_at).toLocaleDateString('ko-KR')}</td>
            <td class="px-4 py-3">
              <div class="flex items-center gap-2">
                <a href="/admin/enrollments?userId=\${user.id}" class="text-blue-500 hover:text-blue-700 text-sm" title="수강 내역"><i class="fas fa-book"></i></a>
                <button onclick="deleteUser(\${user.id}, '\${user.name.replace(/'/g, "\\\\'")}')" class="text-gray-400 hover:text-red-500 text-sm" title="삭제"><i class="fas fa-trash-alt"></i></button>
              </div>
            </td>
          </tr>
        \`;
      }).join('');

      const start = currentPage * pageSize + 1;
      const end = Math.min(start + data.users.length - 1, totalUsers);
      document.getElementById('paginationInfo').textContent = \`총 \${totalUsers}명 중 \${start}-\${end}\`;
      updatePagination();
    }

    function updatePagination() {
      const totalPages = Math.ceil(totalUsers / pageSize);
      document.getElementById('pageInfo').textContent = (currentPage + 1) + ' / ' + Math.max(totalPages, 1);
      document.getElementById('prevBtn').disabled = currentPage === 0;
      document.getElementById('nextBtn').disabled = (currentPage + 1) >= totalPages;
    }

    function prevPage() { if (currentPage > 0) { currentPage--; loadUsers(); } }
    function nextPage() { if ((currentPage + 1) * pageSize < totalUsers) { currentPage++; loadUsers(); } }

    async function deleteUser(userId, userName) {
      if (!confirm(userName + ' 회원을 삭제하시겠습니까?\\n관련된 수강, 주문 내역이 모두 삭제됩니다.')) return;

      const res = await fetch('/api/admin/users/' + userId, { method: 'DELETE' });
      const data = await res.json();

      if (data.success) {
        showModal('성공', data.message);
        loadUsers();
      } else {
        showModal('오류', data.error || '삭제 실패');
      }
    }

    // Initial load
    loadUsers();
  </script>
</body>
</html>
  `)
})

// ==================== Admin Page - Enrollment Management ====================
app.get('/admin/enrollments', async (c) => {
  const authRedirect = await requireAdminAuth(c)
  if (authRedirect) return authRedirect

  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>수강신청자 관리 - ClassIn Live 관리자</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
  </style>
</head>
<body class="bg-gray-100 min-h-screen">
  <nav class="bg-gray-900 text-white shadow-lg">
    <div class="max-w-7xl mx-auto px-4 py-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <a href="/" class="text-xl font-bold text-rose-400">ClassIn Live</a>
          <span class="text-gray-400">|</span>
          <span class="text-gray-300">수강신청자 관리</span>
        </div>
        <a href="/admin" class="text-sm text-gray-400 hover:text-white"><i class="fas fa-arrow-left mr-1"></i>관리자 대시보드</a>
      </div>
    </div>
  </nav>

  <div class="max-w-7xl mx-auto px-4 py-8">
    <!-- Stats -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-user-graduate text-orange-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statTotal">0</p>
            <p class="text-sm text-gray-500">전체 수강</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-play-circle text-green-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statActive">0</p>
            <p class="text-sm text-gray-500">수강중</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-stop-circle text-gray-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statEnded">0</p>
            <p class="text-sm text-gray-500">종료</p>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl p-6 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-id-card text-purple-500 text-xl"></i>
          </div>
          <div>
            <p class="text-2xl font-bold text-gray-800" id="statAssigned">0</p>
            <p class="text-sm text-gray-500">ClassIn 할당</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Enrollment List -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="p-6 border-b border-gray-100">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <h2 class="text-lg font-bold text-gray-800"><i class="fas fa-user-graduate text-orange-500 mr-2"></i>수강신청자 목록</h2>
          <div class="flex items-center gap-2 flex-wrap">
            <select id="classFilter" onchange="currentPage=0;loadEnrollments()" class="px-3 py-2 border border-gray-200 rounded-lg text-sm">
              <option value="">전체 코스</option>
            </select>
            <select id="statusFilter" onchange="currentPage=0;loadEnrollments()" class="px-3 py-2 border border-gray-200 rounded-lg text-sm">
              <option value="">전체 상태</option>
              <option value="active">수강중</option>
              <option value="ended">종료</option>
              <option value="expired">만료</option>
            </select>
            <input type="text" id="searchInput" placeholder="이름/이메일 검색" class="px-3 py-2 border border-gray-200 rounded-lg text-sm w-48" onkeyup="if(event.key==='Enter'){currentPage=0;loadEnrollments();}">
            <button onclick="currentPage=0;loadEnrollments()" class="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg transition-all text-sm">
              <i class="fas fa-search"></i>
            </button>
            <button onclick="resetFilters()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg transition-all">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ID</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">코스</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">수강생</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">이메일</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">전화번호</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">상태</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ClassIn UID</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">수강일</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">작업</th>
            </tr>
          </thead>
          <tbody id="enrollmentsTable" class="divide-y divide-gray-100">
            <tr><td colspan="9" class="px-6 py-8 text-center text-gray-400">로딩 중...</td></tr>
          </tbody>
        </table>
      </div>
      <div class="p-4 border-t border-gray-100 flex items-center justify-between">
        <p class="text-sm text-gray-500" id="paginationInfo">-</p>
        <div class="flex items-center gap-2">
          <button onclick="prevPage()" class="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50 disabled:opacity-50" id="prevBtn">이전</button>
          <span class="text-sm text-gray-600" id="pageInfo">1</span>
          <button onclick="nextPage()" class="px-3 py-1 border border-gray-200 rounded text-sm hover:bg-gray-50 disabled:opacity-50" id="nextBtn">다음</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Result Modal -->
  <div id="resultModal" class="fixed inset-0 z-50 hidden">
    <div class="absolute inset-0 bg-black/50" onclick="closeModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
      <h3 class="text-lg font-bold mb-2" id="modalTitle">알림</h3>
      <p class="text-gray-600 whitespace-pre-wrap" id="modalMessage"></p>
      <button onclick="closeModal()" class="mt-4 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg">확인</button>
    </div>
  </div>

  <script>
    const pageSize = 50;
    let currentPage = 0;
    let totalEnrollments = 0;
    let allEnrollments = [];

    // Get URL params
    const urlParams = new URLSearchParams(window.location.search);
    const initialUserId = urlParams.get('userId');

    function showModal(title, message) {
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalMessage').textContent = message;
      document.getElementById('resultModal').classList.remove('hidden');
    }

    function closeModal() {
      document.getElementById('resultModal').classList.add('hidden');
    }

    async function loadClassOptions() {
      const res = await fetch('/api/admin/classes');
      const data = await res.json();
      const select = document.getElementById('classFilter');
      select.innerHTML = '<option value="">전체 코스</option>' +
        (data.classes || []).map(c => \`<option value="\${c.id}">\${c.title}</option>\`).join('');
    }

    async function loadEnrollments() {
      const classId = document.getElementById('classFilter').value;
      const status = document.getElementById('statusFilter').value;
      const search = document.getElementById('searchInput').value.trim().toLowerCase();

      // Fetch all enrollments (API doesn't have search, so we filter client-side)
      let url = '/api/admin/enrollments?limit=1000';
      if (classId) url += '&classId=' + classId;
      if (status) url += '&status=' + status;

      const res = await fetch(url);
      const data = await res.json();

      // Filter by search and userId
      allEnrollments = (data.enrollments || []).filter(e => {
        if (initialUserId && e.user_id !== parseInt(initialUserId)) return false;
        if (search) {
          return e.user_name.toLowerCase().includes(search) ||
                 e.user_email.toLowerCase().includes(search);
        }
        return true;
      });

      totalEnrollments = allEnrollments.length;

      // Update stats
      document.getElementById('statTotal').textContent = totalEnrollments;
      document.getElementById('statActive').textContent = allEnrollments.filter(e => e.status === 'active').length;
      document.getElementById('statEnded').textContent = allEnrollments.filter(e => e.status === 'ended').length;
      document.getElementById('statAssigned').textContent = allEnrollments.filter(e => e.classin_account_uid).length;

      renderTable();
    }

    function renderTable() {
      const tbody = document.getElementById('enrollmentsTable');
      const start = currentPage * pageSize;
      const pageData = allEnrollments.slice(start, start + pageSize);

      if (pageData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="px-6 py-8 text-center text-gray-400">수강 신청자가 없습니다.</td></tr>';
        document.getElementById('paginationInfo').textContent = '총 0건';
        updatePagination();
        return;
      }

      tbody.innerHTML = pageData.map(e => {
        const statusLabel = e.status === 'active' ? '수강중' : e.status === 'ended' ? '종료' : e.status === 'expired' ? '만료' : e.status || '-';
        const statusColor = e.status === 'active' ? 'bg-green-100 text-green-700' : e.status === 'ended' ? 'bg-gray-100 text-gray-600' : 'bg-red-100 text-red-700';
        return \`
          <tr class="hover:bg-gray-50">
            <td class="px-4 py-3 text-sm">\${e.id}</td>
            <td class="px-4 py-3 text-sm font-medium max-w-[200px] truncate" title="\${e.class_title}">\${e.class_title}</td>
            <td class="px-4 py-3 font-medium">\${e.user_name}</td>
            <td class="px-4 py-3 text-sm text-gray-500">\${e.user_email}</td>
            <td class="px-4 py-3 text-sm text-gray-500">\${e.user_phone || '-'}</td>
            <td class="px-4 py-3"><span class="px-2 py-0.5 rounded text-xs \${statusColor}">\${statusLabel}</span></td>
            <td class="px-4 py-3 font-mono text-xs text-gray-500">\${e.classin_account_uid || '-'}</td>
            <td class="px-4 py-3 text-xs text-gray-500">\${new Date(e.enrolled_at).toLocaleDateString('ko-KR')}</td>
            <td class="px-4 py-3">
              <div class="flex gap-1">
                \${e.status === 'active' ? \`<button onclick="endEnrollment(\${e.id})" class="text-orange-500 hover:text-orange-700 text-xs px-2 py-1 border border-orange-200 rounded hover:bg-orange-50">종료</button>\` : ''}
                <button onclick="deleteEnrollment(\${e.id})" class="text-red-500 hover:text-red-700 text-xs px-2 py-1 border border-red-200 rounded hover:bg-red-50">삭제</button>
              </div>
            </td>
          </tr>
        \`;
      }).join('');

      const end = Math.min(start + pageData.length, totalEnrollments);
      document.getElementById('paginationInfo').textContent = \`총 \${totalEnrollments}건 중 \${start + 1}-\${end}\`;
      updatePagination();
    }

    function updatePagination() {
      const totalPages = Math.ceil(totalEnrollments / pageSize);
      document.getElementById('pageInfo').textContent = (currentPage + 1) + ' / ' + Math.max(totalPages, 1);
      document.getElementById('prevBtn').disabled = currentPage === 0;
      document.getElementById('nextBtn').disabled = (currentPage + 1) >= totalPages;
    }

    function prevPage() { if (currentPage > 0) { currentPage--; renderTable(); } }
    function nextPage() { if ((currentPage + 1) * pageSize < totalEnrollments) { currentPage++; renderTable(); } }

    function resetFilters() {
      document.getElementById('classFilter').value = '';
      document.getElementById('statusFilter').value = '';
      document.getElementById('searchInput').value = '';
      currentPage = 0;
      // Clear userId param
      if (initialUserId) {
        window.history.replaceState({}, '', '/admin/enrollments');
      }
      loadEnrollments();
    }

    async function endEnrollment(enrollmentId) {
      if (!confirm('이 수강을 종료하시겠습니까? 할당된 ClassIn 가상 계정이 반납됩니다.')) return;

      const res = await fetch('/api/admin/enrollments/' + enrollmentId + '/status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ended' })
      });
      const data = await res.json();

      if (data.success) {
        showModal('성공', data.message);
        loadEnrollments();
      } else {
        showModal('오류', data.error || '상태 변경 실패');
      }
    }

    async function deleteEnrollment(enrollmentId) {
      if (!confirm('이 수강신청을 삭제하시겠습니까?\\n\\n이 작업은 되돌릴 수 없습니다.')) return;

      const res = await fetch('/api/admin/enrollments/' + enrollmentId, {
        method: 'DELETE'
      });
      const data = await res.json();

      if (data.success) {
        showModal('성공', data.message);
        loadEnrollments();
      } else {
        showModal('오류', data.error || '삭제 실패');
      }
    }

    // Initial load
    loadClassOptions();
    loadEnrollments();
  </script>
</body>
</html>
  `)
})

// Scheduled handler for cron trigger (매일 자정 만료된 수강권 처리)
async function processExpiredEnrollments(db: D1Database) {
  // Find expired enrollments with assigned virtual accounts
  const { results: expiredEnrollments } = await db.prepare(`
    SELECT id, user_id, classin_account_uid FROM enrollments
    WHERE classin_account_uid != '' AND classin_returned_at IS NULL
    AND status = 'active' AND expires_at IS NOT NULL AND expires_at < datetime('now')
  `).all() as any

  let returnedCount = 0
  for (const enrollment of expiredEnrollments) {
    // Check if user has active subscriptions
    const activeSubscription = await db.prepare(`
      SELECT COUNT(*) as cnt FROM subscriptions WHERE user_id = ? AND status = 'active'
    `).bind(enrollment.user_id).first() as any

    // Check if user has other active enrollments
    const otherActiveEnrollments = await db.prepare(`
      SELECT COUNT(*) as cnt FROM enrollments
      WHERE user_id = ? AND id != ? AND status = 'active' AND classin_account_uid != ''
    `).bind(enrollment.user_id, enrollment.id).first() as any

    // Clear enrollment's virtual account reference
    await db.prepare(`
      UPDATE enrollments
      SET classin_account_uid = '', classin_account_password = '', classin_returned_at = datetime('now'), status = 'expired', updated_at = datetime('now')
      WHERE id = ?
    `).bind(enrollment.id).run()

    // Return account only if no other active enrollments or subscriptions
    if ((!activeSubscription || activeSubscription.cnt === 0) &&
        (!otherActiveEnrollments || otherActiveEnrollments.cnt === 0)) {
      await db.prepare(`
        UPDATE classin_virtual_accounts
        SET user_id = NULL, assigned_at = NULL, assigned_name = '',
            account_password = '', is_registered = 0, status = 'available', updated_at = datetime('now')
        WHERE account_uid = ?
      `).bind(enrollment.classin_account_uid).run()
      returnedCount++
    }
  }

  return { processed: expiredEnrollments.length, returned: returnedCount }
}

// ==================== 관리자: 수업 매칭 관리 페이지 ====================
app.get('/admin/applications', async (c) => {
  const authRedirect = await requireAdminAuth(c)
  if (authRedirect) return authRedirect

  const html = `${headHTML}
<body class="bg-gray-50 min-h-screen">
  <div class="max-w-6xl mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <a href="/admin" class="text-sm text-gray-500 hover:text-gray-700">&larr; 관리자 대시보드</a>
        <h1 class="text-2xl font-bold text-gray-900 mt-1">수업 매칭 관리</h1>
      </div>
    </div>

    <div class="flex gap-2 mb-6">
      <button onclick="loadApps('submitted')" id="tabSubmitted" class="px-4 py-2 rounded-lg text-sm font-medium bg-primary-100 text-primary-700">검토 대기</button>
      <button onclick="loadApps('approved')" id="tabApproved" class="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600">승인됨</button>
      <button onclick="loadApps('rejected')" id="tabRejected" class="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600">거절됨</button>
      <button onclick="loadApps('draft')" id="tabDraft" class="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600">작성중</button>
    </div>

    <div id="appList" class="space-y-4">
      <div class="text-center py-12 text-gray-400">불러오는 중...</div>
    </div>

    <!-- 상세 모달 -->
    <div id="detailModal" class="fixed inset-0 bg-black bg-opacity-50 z-50 hidden flex items-center justify-center p-4">
      <div class="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-lg font-bold">지원 상세</h2>
          <button onclick="closeDetail()" class="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>
        <div id="detailContent"></div>
      </div>
    </div>
  </div>

<script>
let currentTab = 'submitted';

async function loadApps(status) {
  currentTab = status;
  ['Submitted','Approved','Rejected','Draft'].forEach(s => {
    const el = document.getElementById('tab' + s);
    el.className = 'px-4 py-2 rounded-lg text-sm font-medium ' + (s.toLowerCase() === status ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-600');
  });

  const res = await fetch('/api/admin/applications?status=' + status);
  const data = await res.json();
  const list = document.getElementById('appList');

  if (!data.applications || data.applications.length === 0) {
    list.innerHTML = '<div class="text-center py-12 text-gray-400">지원이 없습니다.</div>';
    return;
  }

  list.innerHTML = data.applications.map(function(a) {
    var stepLabel = a.automation_step > 0 ? ' (자동화: ' + a.automation_step + '/7)' : '';
    var errorBadge = a.automation_error ? '<span class="text-xs text-red-500 ml-2">오류</span>' : '';
    return '<div class="bg-white rounded-xl border p-5 hover:shadow-md transition cursor-pointer" onclick="showDetail(' + a.id + ')">' +
      '<div class="flex items-center justify-between mb-2">' +
        '<span class="font-semibold text-gray-900">' + escHtml(a.applicant_name) + '</span>' +
        '<span class="text-xs text-gray-400">' + new Date(a.created_at).toLocaleDateString('ko-KR') + '</span>' +
      '</div>' +
      '<p class="text-sm text-gray-500 mb-1">요청: ' + escHtml(a.request_title) + '</p>' +
      (a.proposed_title ? '<p class="text-sm">제안: <strong>' + escHtml(a.proposed_title) + '</strong>' + (a.proposed_price ? ' (' + Number(a.proposed_price).toLocaleString() + '원)' : '') + '</p>' : '') +
      '<div class="flex items-center gap-2 mt-2">' +
        '<span class="text-xs px-2 py-0.5 rounded bg-gray-100">' + a.status + stepLabel + '</span>' +
        errorBadge +
      '</div>' +
    '</div>';
  }).join('');
}

function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function showDetail(id) {
  var res = await fetch('/api/admin/applications/' + id);
  var data = await res.json();
  var a = data.application;
  var days = a.proposed_schedule_days ? JSON.parse(a.proposed_schedule_days) : [];
  var dayNames = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };
  var dayStr = days.map(function(d) { return dayNames[d] || d; }).join(', ');
  var levelNames = { beginner: '초급', intermediate: '중급', advanced: '고급', all: '전체' };

  var html = '<div class="space-y-4">' +
    '<div class="bg-gray-50 rounded-lg p-4">' +
      '<h3 class="font-medium text-sm text-gray-500 mb-2">원래 요청</h3>' +
      '<p class="font-semibold">' + escHtml(a.request_title) + '</p>' +
      '<p class="text-sm text-gray-600">' + escHtml(a.request_description) + '</p>' +
      '<p class="text-xs text-gray-400 mt-1">요청자: ' + escHtml(a.requester_name) + ' (' + escHtml(a.requester_email) + ')</p>' +
    '</div>' +
    '<div class="bg-blue-50 rounded-lg p-4">' +
      '<h3 class="font-medium text-sm text-blue-600 mb-2">지원자 정보</h3>' +
      '<p><strong>' + escHtml(a.applicant_name) + '</strong> (' + escHtml(a.applicant_user_email) + ')</p>' +
      '<p class="text-sm text-gray-600 mt-1">' + escHtml(a.bio) + '</p>' +
    '</div>' +
    '<div class="grid grid-cols-2 gap-3 text-sm">' +
      '<div><span class="text-gray-400">수업 제목:</span> <strong>' + escHtml(a.proposed_title || '-') + '</strong></div>' +
      '<div><span class="text-gray-400">난이도:</span> ' + escHtml(levelNames[a.proposed_level] || a.proposed_level || '-') + '</div>' +
      '<div><span class="text-gray-400">구성:</span> ' + (a.proposed_lessons_count || '-') + '회 x ' + (a.proposed_duration_minutes || '-') + '분</div>' +
      '<div><span class="text-gray-400">수강료:</span> ' + (a.proposed_price ? Number(a.proposed_price).toLocaleString() + '원' : '-') + '</div>' +
      '<div><span class="text-gray-400">시작일:</span> ' + escHtml(a.proposed_schedule_start || '-') + '</div>' +
      '<div><span class="text-gray-400">스케줄:</span> ' + escHtml(dayStr || '-') + ' ' + escHtml(a.proposed_schedule_time || '') + '</div>' +
    '</div>';

  if (a.automation_step > 0) {
    var steps = ['', '강사 등록', '코스 생성', 'ClassIn 코스', '세션 생성', 'ID 저장', '매칭 완료', '알림'];
    html += '<div class="bg-yellow-50 rounded-lg p-4">' +
      '<h3 class="font-medium text-sm text-yellow-700 mb-2">자동화 진행 상태</h3>' +
      '<div class="flex gap-1">';
    for (var i = 1; i <= 7; i++) {
      var color = i < a.automation_step ? 'bg-green-500' : i === a.automation_step ? (a.automation_error ? 'bg-red-500' : 'bg-yellow-500') : 'bg-gray-300';
      html += '<div class="flex-1 h-2 rounded ' + color + '" title="Step ' + i + ': ' + steps[i] + '"></div>';
    }
    html += '</div><p class="text-xs text-gray-500 mt-2">현재: Step ' + a.automation_step + ' - ' + steps[a.automation_step] + '</p>';
    if (a.automation_error) {
      html += '<p class="text-xs text-red-500 mt-1">' + escHtml(a.automation_error) + '</p>';
    }
    html += '</div>';
  }

  // 액션 버튼
  if (a.status === 'submitted') {
    html += '<div class="flex gap-3 pt-2">' +
      '<button onclick="approveApp(' + a.id + ')" class="flex-1 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium">승인</button>' +
      '<button onclick="rejectApp(' + a.id + ')" class="flex-1 py-2.5 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 font-medium">거절</button>' +
    '</div>';
  }
  if (a.automation_error) {
    html += '<button onclick="retryApp(' + a.id + ')" class="w-full py-2.5 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 font-medium mt-2">재시도 (Step ' + a.automation_step + '부터)</button>';
  }
  if (a.created_class_id) {
    html += '<p class="text-xs text-green-600 mt-2">생성된 코스 ID: ' + a.created_class_id + '</p>';
  }

  html += '</div>';
  document.getElementById('detailContent').innerHTML = html;
  document.getElementById('detailModal').classList.remove('hidden');
}

function closeDetail() {
  document.getElementById('detailModal').classList.add('hidden');
}

async function approveApp(id) {
  if (!confirm('이 지원을 승인하시겠습니까? 자동으로 수업이 생성됩니다.')) return;
  var res = await fetch('/api/admin/applications/' + id + '/approve', { method: 'POST' });
  var data = await res.json();
  if (data.success) {
    alert('승인 완료! 코스 ID: ' + data.classId);
    closeDetail();
    loadApps(currentTab);
  } else {
    alert('오류: ' + (data.error || '알 수 없는 오류'));
    closeDetail();
    loadApps(currentTab);
  }
}

async function rejectApp(id) {
  var note = prompt('거절 사유를 입력해주세요:');
  if (note === null) return;
  var res = await fetch('/api/admin/applications/' + id + '/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note })
  });
  var data = await res.json();
  if (data.success) {
    alert('거절되었습니다.');
    closeDetail();
    loadApps(currentTab);
  } else {
    alert('오류: ' + data.error);
  }
}

async function retryApp(id) {
  if (!confirm('실패한 단계부터 재시도하시겠습니까?')) return;
  var res = await fetch('/api/admin/applications/' + id + '/retry', { method: 'POST' });
  var data = await res.json();
  if (data.success) {
    alert('재시도 성공!');
    closeDetail();
    loadApps(currentTab);
  } else {
    alert('오류: ' + data.error);
    showDetail(id);
  }
}

loadApps('submitted');
</script>
</body></html>`
  return c.html(html)
})

// ==================== 홈페이지 관리 페이지 ====================
app.get('/admin/homepage', async (c) => {
  const authRedirect = await requireAdminAuth(c)
  if (authRedirect) return authRedirect

  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>홈페이지 관리 - ClassIn Live 관리자</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
    .drag-over { border: 2px dashed #3b82f6 !important; background: #eff6ff !important; }
    .dragging { opacity: 0.5; }
  </style>
</head>
<body class="bg-gray-100 min-h-screen">
  <nav class="bg-gray-900 text-white shadow-lg">
    <div class="max-w-7xl mx-auto px-4 py-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <a href="/" class="text-xl font-bold text-rose-400">ClassIn Live</a>
          <span class="text-gray-400">|</span>
          <span class="text-gray-300">홈페이지 관리</span>
        </div>
        <a href="/admin" class="text-sm text-gray-400 hover:text-white"><i class="fas fa-arrow-left mr-1"></i>관리자 대시보드</a>
      </div>
    </div>
  </nav>

  <div class="max-w-7xl mx-auto px-4 py-8">
    <!-- 안내 -->
    <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
      <p class="text-sm text-blue-700"><i class="fas fa-info-circle mr-1"></i>메인 홈페이지에 표시되는 3개 섹션의 코스를 관리합니다. 코스를 추가/제거하고 표시 순서를 변경할 수 있습니다.</p>
    </div>

    <!-- 정률 특강 코스 섹션 -->
    <div class="bg-white rounded-xl p-6 shadow-sm mb-6">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <i class="fas fa-star text-yellow-500 text-lg"></i>
          <h2 class="text-lg font-bold text-gray-800">정율 선생님들 특강</h2>
          <span id="specialCount" class="text-xs bg-yellow-100 text-yellow-600 font-semibold px-2 py-0.5 rounded-full">0/8</span>
        </div>
        <div class="flex gap-2">
          <button onclick="openAddCourseModal('special')" class="text-sm bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1.5 rounded-lg transition-all">
            <i class="fas fa-plus mr-1"></i>코스 추가
          </button>
          <button onclick="saveOrder('special')" class="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition-all">
            <i class="fas fa-save mr-1"></i>순서 저장
          </button>
        </div>
      </div>
      <p class="text-xs text-gray-400 mb-3">is_featured_special = 1인 코스가 메인 페이지 최상단에 표시됩니다.</p>
      <div id="specialList" class="space-y-2">
        <p class="text-sm text-gray-400 py-4 text-center">로딩 중...</p>
      </div>
    </div>

    <!-- 베스트 코스 섹션 -->
    <div class="bg-white rounded-xl p-6 shadow-sm mb-6">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <i class="fas fa-fire text-orange-500 text-lg"></i>
          <h2 class="text-lg font-bold text-gray-800">베스트 코스</h2>
          <span id="bestsellerCount" class="text-xs bg-orange-100 text-orange-600 font-semibold px-2 py-0.5 rounded-full">0/8</span>
        </div>
        <div class="flex gap-2">
          <button onclick="openAddCourseModal('bestseller')" class="text-sm bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 rounded-lg transition-all">
            <i class="fas fa-plus mr-1"></i>코스 추가
          </button>
          <button onclick="saveOrder('bestseller')" class="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition-all">
            <i class="fas fa-save mr-1"></i>순서 저장
          </button>
        </div>
      </div>
      <p class="text-xs text-gray-400 mb-3">is_bestseller = 1인 코스가 평점순으로 최대 8개 표시됩니다.</p>
      <div id="bestsellerList" class="space-y-2">
        <p class="text-sm text-gray-400 py-4 text-center">로딩 중...</p>
      </div>
    </div>

    <!-- 예정된 라이브 코스 섹션 -->
    <div class="bg-white rounded-xl p-6 shadow-sm mb-6">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
          <h2 class="text-lg font-bold text-gray-800">예정된 라이브 양방향 코스</h2>
          <span id="liveCount" class="text-xs bg-red-100 text-red-600 font-semibold px-2 py-0.5 rounded-full">0</span>
        </div>
        <button onclick="saveOrder('live')" class="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition-all">
          <i class="fas fa-save mr-1"></i>순서 저장
        </button>
      </div>
      <p class="text-xs text-gray-400 mb-3">class_type = 'live'인 코스가 자동 포함됩니다. 순서만 변경 가능합니다.</p>
      <div id="liveList" class="space-y-2">
        <p class="text-sm text-gray-400 py-4 text-center">로딩 중...</p>
      </div>
    </div>

    <!-- 신규 코스 섹션 -->
    <div class="bg-white rounded-xl p-6 shadow-sm mb-6">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <i class="fas fa-sparkles text-blue-500 text-lg"></i>
          <h2 class="text-lg font-bold text-gray-800">신규 코스</h2>
          <span id="newCount" class="text-xs bg-blue-100 text-blue-600 font-semibold px-2 py-0.5 rounded-full">0/8</span>
        </div>
        <div class="flex gap-2">
          <button onclick="openAddCourseModal('new')" class="text-sm bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 rounded-lg transition-all">
            <i class="fas fa-plus mr-1"></i>코스 추가
          </button>
          <button onclick="saveOrder('new')" class="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition-all">
            <i class="fas fa-save mr-1"></i>순서 저장
          </button>
        </div>
      </div>
      <p class="text-xs text-gray-400 mb-3">is_new = 1인 코스가 생성일순으로 최대 8개 표시됩니다.</p>
      <div id="newList" class="space-y-2">
        <p class="text-sm text-gray-400 py-4 text-center">로딩 중...</p>
      </div>
    </div>
  </div>

  <!-- 코스 추가 모달 -->
  <div id="addCourseModal" class="fixed inset-0 bg-black/50 z-50 hidden items-center justify-center" onclick="if(event.target===this)closeAddCourseModal()">
    <div class="bg-white rounded-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
      <div class="p-5 border-b border-gray-100">
        <div class="flex items-center justify-between">
          <h3 id="addCourseModalTitle" class="text-lg font-bold text-gray-800">코스 추가</h3>
          <button onclick="closeAddCourseModal()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
        </div>
        <div class="mt-3">
          <input type="text" id="courseSearchInput" placeholder="코스명 또는 강사명으로 검색..."
            class="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            oninput="filterCourses()">
        </div>
      </div>
      <div id="courseSearchResults" class="p-4 overflow-y-auto flex-1">
        <p class="text-sm text-gray-400 text-center py-4">로딩 중...</p>
      </div>
    </div>
  </div>

  <!-- 알림 모달 -->
  <div id="alertModal" class="fixed inset-0 bg-black/50 z-50 hidden items-center justify-center" onclick="if(event.target===this)this.style.display='none'">
    <div class="bg-white rounded-2xl p-6 max-w-sm mx-4 text-center">
      <h3 id="alertTitle" class="text-lg font-bold text-gray-800 mb-2"></h3>
      <p id="alertMessage" class="text-sm text-gray-600 mb-4"></p>
      <button onclick="document.getElementById('alertModal').style.display='none'" class="bg-blue-500 hover:bg-blue-600 text-white font-semibold px-6 py-2 rounded-lg">확인</button>
    </div>
  </div>

<script>
let sections = { bestseller: [], newCourses: [], liveCourses: [], allActive: [] };
let currentSection = '';

function showAlert(title, msg) {
  document.getElementById('alertTitle').textContent = title;
  document.getElementById('alertMessage').textContent = msg;
  document.getElementById('alertModal').style.display = 'flex';
}

async function loadSections() {
  try {
    const res = await fetch('/api/admin/homepage/sections');
    sections = await res.json();
    renderSection('bestseller', sections.bestseller, 'bestsellerList', 'bestsellerCount');
    renderSection('special', sections.specialCourses || [], 'specialList', 'specialCount');
    renderSection('live', sections.liveCourses, 'liveList', 'liveCount');
    renderSection('new', sections.newCourses, 'newList', 'newCount');
  } catch (e) {
    showAlert('오류', '데이터를 불러오지 못했습니다.');
  }
}

function renderSection(type, courses, listId, countId) {
  const list = document.getElementById(listId);
  const countEl = document.getElementById(countId);

  if (type === 'live') {
    countEl.textContent = courses.length;
  } else {
    countEl.textContent = courses.length + '/8';
  }

  if (courses.length === 0) {
    list.innerHTML = '<p class="text-sm text-gray-400 py-4 text-center">등록된 코스가 없습니다.</p>';
    return;
  }

  list.innerHTML = courses.map((cls, idx) => \`
    <div class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg group" draggable="true"
         data-section="\${type}" data-id="\${cls.id}" data-index="\${idx}"
         ondragstart="onDragStart(event)" ondragover="onDragOver(event)" ondrop="onDrop(event)" ondragend="onDragEnd(event)">
      <div class="cursor-grab text-gray-300 hover:text-gray-500">
        <i class="fas fa-grip-vertical"></i>
      </div>
      <span class="text-xs text-gray-400 font-mono w-5 text-center">\${idx + 1}</span>
      <img src="\${cls.thumbnail || ''}" class="w-14 h-10 rounded-lg object-cover bg-gray-200 flex-shrink-0" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 56 40%22><rect fill=%22%23e5e7eb%22 width=%2256%22 height=%2240%22/></svg>'">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold text-gray-800 truncate">\${cls.title}</p>
        <p class="text-xs text-gray-500">\${cls.instructor_name} · \${cls.price ? cls.price.toLocaleString() + '원' : '무료'}</p>
      </div>
      <div class="flex items-center gap-1">
        \${cls.is_bestseller ? '<span class="text-[10px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded font-semibold">BEST</span>' : ''}
        \${cls.is_new ? '<span class="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-semibold">NEW</span>' : ''}
        \${cls.class_type === 'live' ? '<span class="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-semibold">LIVE</span>' : ''}
      </div>
      <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onclick="moveCourse('\${type}', \${idx}, -1)" class="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 text-gray-400 \${idx === 0 ? 'invisible' : ''}">
          <i class="fas fa-chevron-up text-xs"></i>
        </button>
        <button onclick="moveCourse('\${type}', \${idx}, 1)" class="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 text-gray-400 \${idx === courses.length - 1 ? 'invisible' : ''}">
          <i class="fas fa-chevron-down text-xs"></i>
        </button>
        \${type !== 'live' ? \`<button onclick="removeCourse('\${type}', \${cls.id})" class="w-7 h-7 flex items-center justify-center rounded hover:bg-red-100 text-red-400 hover:text-red-600">
          <i class="fas fa-times text-xs"></i>
        </button>\` : ''}
      </div>
    </div>
  \`).join('');
}

// 드래그 앤 드롭
let dragItem = null;

function onDragStart(e) {
  dragItem = e.currentTarget;
  dragItem.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.currentTarget;
  if (target !== dragItem && target.dataset.section === dragItem.dataset.section) {
    target.classList.add('drag-over');
  }
}

function onDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  target.classList.remove('drag-over');
  if (!dragItem || target === dragItem) return;

  const section = dragItem.dataset.section;
  if (target.dataset.section !== section) return;

  const fromIdx = parseInt(dragItem.dataset.index);
  const toIdx = parseInt(target.dataset.index);

  let arr;
  if (section === 'bestseller') arr = sections.bestseller;
  else if (section === 'new') arr = sections.newCourses;
  else arr = sections.liveCourses;

  const [moved] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, moved);

  const listId = section === 'bestseller' ? 'bestsellerList' : section === 'special' ? 'specialList' : section === 'new' ? 'newList' : 'liveList';
  const countId = section === 'bestseller' ? 'bestsellerCount' : section === 'special' ? 'specialCount' : section === 'new' ? 'newCount' : 'liveCount';
  renderSection(section, arr, listId, countId);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  dragItem = null;
}

// 순서 이동 (위/아래 버튼)
function moveCourse(section, idx, direction) {
  let arr;
  if (section === 'bestseller') arr = sections.bestseller;
  else if (section === 'new') arr = sections.newCourses;
  else arr = sections.liveCourses;

  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= arr.length) return;

  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];

  const listId = section === 'bestseller' ? 'bestsellerList' : section === 'special' ? 'specialList' : section === 'new' ? 'newList' : 'liveList';
  const countId = section === 'bestseller' ? 'bestsellerCount' : section === 'special' ? 'specialCount' : section === 'new' ? 'newCount' : 'liveCount';
  renderSection(section, arr, listId, countId);
}

// 순서 저장
async function saveOrder(section) {
  let arr;
  if (section === 'bestseller') arr = sections.bestseller;
  else if (section === 'new') arr = sections.newCourses;
  else arr = sections.liveCourses;

  const items = arr.map((cls, idx) => ({ id: cls.id, sortOrder: idx + 1 }));

  try {
    const res = await fetch('/api/admin/homepage/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });
    const data = await res.json();
    if (data.success) {
      showAlert('완료', '순서가 저장되었습니다.');
    } else {
      showAlert('오류', data.error || '저장에 실패했습니다.');
    }
  } catch (e) {
    showAlert('오류', '네트워크 오류가 발생했습니다.');
  }
}

// 코스 추가 모달
function openAddCourseModal(section) {
  currentSection = section;
  const modal = document.getElementById('addCourseModal');
  const title = document.getElementById('addCourseModalTitle');

  if (section === 'bestseller') title.textContent = '베스트 코스에 추가';
  else title.textContent = '신규 코스에 추가';

  document.getElementById('courseSearchInput').value = '';
  modal.style.display = 'flex';
  filterCourses();
  document.getElementById('courseSearchInput').focus();
}

function closeAddCourseModal() {
  document.getElementById('addCourseModal').style.display = 'none';
  currentSection = '';
}

function filterCourses() {
  const query = document.getElementById('courseSearchInput').value.toLowerCase();
  const container = document.getElementById('courseSearchResults');

  // 현재 섹션에 이미 있는 코스 ID 목록
  let currentIds;
  if (currentSection === 'bestseller') currentIds = new Set(sections.bestseller.map(c => c.id));
  else if (currentSection === 'special') currentIds = new Set((sections.specialCourses || []).map(c => c.id));
  else currentIds = new Set(sections.newCourses.map(c => c.id));

  const filtered = sections.allActive.filter(cls => {
    const matchesQuery = !query || cls.title.toLowerCase().includes(query) || (cls.instructor_name || '').toLowerCase().includes(query);
    const notInSection = !currentIds.has(cls.id);
    return matchesQuery && notInSection;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400 text-center py-4">검색 결과가 없습니다.</p>';
    return;
  }

  container.innerHTML = filtered.map(cls => \`
    <button onclick="addCourseToSection(\${cls.id})" class="w-full flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg text-left transition-all">
      <img src="\${cls.thumbnail || ''}" class="w-12 h-8 rounded object-cover bg-gray-200 flex-shrink-0" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 32%22><rect fill=%22%23e5e7eb%22 width=%2248%22 height=%2232%22/></svg>'">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-gray-800 truncate">\${cls.title}</p>
        <p class="text-xs text-gray-500">\${cls.instructor_name} · \${cls.price ? cls.price.toLocaleString() + '원' : '무료'}</p>
      </div>
      <div class="flex items-center gap-1">
        \${cls.is_bestseller ? '<span class="text-[10px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded">BEST</span>' : ''}
        \${cls.is_new ? '<span class="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded">NEW</span>' : ''}
        \${cls.class_type === 'live' ? '<span class="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded">LIVE</span>' : ''}
      </div>
      <i class="fas fa-plus text-blue-400 text-sm"></i>
    </button>
  \`).join('');
}

async function addCourseToSection(courseId) {
  const flag = currentSection === 'bestseller' ? { isBestseller: 1 } : currentSection === 'special' ? { isFeaturedSpecial: 1 } : { isNew: 1 };

  try {
    const res = await fetch('/api/admin/classes/' + courseId + '/homepage-flags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flag)
    });
    const data = await res.json();
    if (data.success) {
      closeAddCourseModal();
      await loadSections();
      showAlert('완료', '코스가 추가되었습니다.');
    } else {
      showAlert('오류', data.error || '추가에 실패했습니다.');
    }
  } catch (e) {
    showAlert('오류', '네트워크 오류가 발생했습니다.');
  }
}

async function removeCourse(section, courseId) {
  if (!confirm('이 코스를 섹션에서 제거하시겠습니까?')) return;

  const flag = section === 'bestseller' ? { isBestseller: 0 } : section === 'special' ? { isFeaturedSpecial: 0 } : { isNew: 0 };

  try {
    const res = await fetch('/api/admin/classes/' + courseId + '/homepage-flags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flag)
    });
    const data = await res.json();
    if (data.success) {
      await loadSections();
      showAlert('완료', '코스가 제거되었습니다.');
    } else {
      showAlert('오류', data.error || '제거에 실패했습니다.');
    }
  } catch (e) {
    showAlert('오류', '네트워크 오류가 발생했습니다.');
  }
}

// 초기 로드
loadSections();
</script>
</body>
</html>
`)
})

export default app

