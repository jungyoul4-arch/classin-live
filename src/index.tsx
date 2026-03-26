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

const app = new Hono<{ Bindings: Bindings }>()

// 미들웨어: 모든 HTML 응답에 브랜드명 자동 치환 적용
app.use('*', async (c, next) => {
  await next()
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
    '开课时间至少一分钟以后': '수업 시작 시간은 최소 1분 후여야 합니다.',
    '手机号码已注册': '이미 등록된 전화번호입니다.',
    '手机号码不合法': '전화번호 형식이 올바르지 않습니다.',
    '超出机构老师最大启用数量': '기관 교사 최대 수를 초과했습니다. ClassIn 관리자에게 문의하세요.',
    '参数不全或错误': '파라미터가 불완전하거나 잘못되었습니다.',
    '请求数据不合法': '요청 데이터가 유효하지 않습니다.',
    '机构下面没有该老师，请在机构下添加该老师': '기관에 해당 교사가 없습니다. 강사 관리에서 재등록해주세요.',
    '班主任不是本机构的老师': '강사가 이 기관에 등록되지 않았습니다.',
    '课程不存在': '코스가 존재하지 않습니다.',
    '课节不存在': '수업이 존재하지 않습니다.',
    '学生已经在课程中': '학생이 이미 코스에 등록되어 있습니다.',
    '参数错误': '파라미터 오류입니다.',
    '权限不足': '권한이 부족합니다.',
    '签名验证失败': '서명 검증에 실패했습니다.',
    '时间戳过期': '타임스탬프가 만료되었습니다.',
    '用户不存在': '사용자가 존재하지 않습니다.',
    '课程名称不能为空': '코스명을 입력해주세요.',
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
  // mainTeacherUid는 수업(addClass) 생성 시 설정하므로 여기서는 생략

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
    return { success: false, error: data.msg || 'Failed to create lesson via LMS API' }
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
): Promise<{ url?: string; error?: string; rawResponse?: string }> {
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

        // authTicket이 있으면 포함, 없으면 없이 URL 생성
        if (authTicket && authTicket !== 'null') {
          // Build web URL with authTicket (자동 로그인 가능)
          url = `https://www.eeo.cn/client/invoke/index.html?telephone=${telephone}&authTicket=${authTicket}&classId=${classIdParam}&courseId=${courseIdParam}&schoolId=${schoolIdParam}`
        } else {
          // authTicket 없이 URL 생성 (수동 로그인 필요)
          console.log('getLoginLinked: authTicket is null or missing, using URL without authTicket')
          url = `https://www.eeo.cn/client/invoke/index.html?telephone=${telephone}&classId=${classIdParam}&courseId=${courseIdParam}&schoolId=${schoolIdParam}`
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
        // 이미 생성된 ClassIn 코스/수업이 있는지 확인
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

          // 수업(레슨)이 없으면 새로 생성
          if (!existingClassId) {
            // 수업 시작 시간은 최소 2분 후여야 함 (ClassIn API 요구사항)
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

            // 생성된 코스/수업 ID를 classes 테이블에 저장
            if (result.classId) {
              const scheduledAtISO = new Date(beginTime * 1000).toISOString()
              await db.prepare(`
                UPDATE classes SET classin_course_id = ?, classin_class_id = ?, classin_scheduled_at = ?, classin_created_at = datetime('now') WHERE id = ?
              `).bind(courseId, result.classId, scheduledAtISO, classId).run()
              existingClassId = result.classId

              // 새 수업 생성 시에도 studentUid를 URL에 포함
              if (studentUid && result.joinUrl) {
                result.joinUrl = result.joinUrl.includes('uid=')
                  ? result.joinUrl
                  : `${result.joinUrl}&uid=${studentUid}`
              } else if (studentUid && !result.joinUrl) {
                result.joinUrl = `https://www.eeo.cn/client/invoke/index.html?classId=${result.classId}&courseId=${courseId}&schoolId=${config.SID}&uid=${studentUid}`
              }
            }
          } else {
            // 기존 수업 사용
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

    // class_lessons에도 저장 (마이페이지 다음 수업 표시용)
    if (result.courseId && result.classId) {
      // 이미 해당 수업이 class_lessons에 있는지 확인
      const existingLesson = await db.prepare(
        'SELECT id FROM class_lessons WHERE class_id = ? AND classin_class_id = ?'
      ).bind(classId, result.classId).first()

      if (!existingLesson) {
        // 수업 번호 계산
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
): Promise<{ success: boolean; error?: string }> {
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
    const data = await res.json() as any
    console.log('addSchoolStudent response:', JSON.stringify(data))
    if (data.error_info?.errno === 1) {
      return { success: true }
    }
    return { success: false, error: translateClassInError(data.error_info?.error || 'Failed to add student to school') }
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
    const errorMsg = data.error_info?.error || ''
    if (errorMsg.includes('已经存在') || errorMsg.includes('already exists')) {
      return { success: true }
    }
    return { success: false, error: translateClassInError(errorMsg || 'Failed to add teacher to course'), rawResponse: text.substring(0, 500) }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// Generate default password for virtual accounts
function generateDefaultPassword(): string {
  return 'ClassIn' + Math.random().toString(36).substr(2, 6).toUpperCase()
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

  // If already registered, return existing UID
  if (instructor.classin_uid) {
    return { uid: instructor.classin_uid }
  }

  // 이메일인지 전화번호인지 판단
  const account = accountInput || instructor.email
  const isEmail = account.includes('@')
  const accountValue = isEmail ? account : formatKoreanPhoneForClassIn(account)
  const teacherName = instructor.display_name || instructor.user_name || 'Teacher'

  try {
    // Step 1: register API로 UID 조회 (addToSchoolMember 없이 - 기존 계정도 UID 반환)
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
      return { uid: classInUid }
    }

    // addTeacher 실패해도 UID는 저장 (나중에 재등록으로 기관 교사 추가 가능)
    await db.prepare(`
      UPDATE instructors SET classin_uid = ?, classin_registered_at = datetime('now') WHERE id = ?
    `).bind(classInUid, instructorId).run()

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
    WHERE status = 'available' AND (expires_at IS NULL OR expires_at > datetime('now'))
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

    // 기관(school)에 학생 추가 (필수! 이것이 없으면 수업 배정 불가)
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
  const slug = c.req.param('slug')
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

  // 다음 예정 수업 정보 (class_lessons 기준)
  const nextLesson = await c.env.DB.prepare(`
    SELECT * FROM class_lessons
    WHERE class_id = ? AND datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') > datetime('now')
    ORDER BY scheduled_at ASC LIMIT 1
  `).bind(cls.id).first()

  // 총 수업 수 및 완료된 수업 수
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
    WHERE r.class_id = ? ORDER BY r.created_at DESC
  `).bind(id).all()
  return c.json(results)
})

// Simple auth - login
app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  const user = await c.env.DB.prepare('SELECT id, email, name, avatar, role, subscription_plan, subscription_expires_at, is_test_account, test_expires_at FROM users WHERE email = ?').bind(email).first()
  if (!user) return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401)
  // Simple password check for demo (in production, use proper hashing)
  return c.json({ user, token: `demo_token_${(user as any).id}` })
})

// Simple auth - register
app.post('/api/auth/register', async (c) => {
  const { email, password, name } = await c.req.json()
  try {
    const result = await c.env.DB.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').bind(email, `hash_${password}`, name).run()
    const userId = result.meta.last_row_id
    const user = await c.env.DB.prepare('SELECT id, email, name, avatar, role, is_test_account, test_expires_at FROM users WHERE id = ?').bind(userId).first() as any

    return c.json({
      user,
      token: `demo_token_${userId}`
    })
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: '이미 등록된 이메일입니다.' }, 400)
    return c.json({ error: '회원가입에 실패했습니다.' }, 500)
  }
})

// Get user enrollments (with next lesson info from class_lessons)
app.get('/api/user/:userId/enrollments', async (c) => {
  const userId = c.req.param('userId')
  const now = new Date().toISOString()

  // 수강 목록과 함께 각 클래스의 다음 예정 수업, 최근 종료 수업 정보 포함
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
    WHERE e.user_id = ?
    ORDER BY COALESCE(next_lesson.scheduled_at, e.enrolled_at) DESC
  `).bind(userId).all()
  return c.json(results)
})

// Get instructor's classes (강사가 개설한 클래스 목록)
app.get('/api/user/:userId/instructor-classes', async (c) => {
  const userId = c.req.param('userId')

  // 사용자가 강사인지 확인하고 instructor_id 가져오기
  const instructor = await c.env.DB.prepare(`
    SELECT i.id FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE u.id = ? AND u.role = 'instructor'
  `).bind(userId).first() as any

  if (!instructor) {
    return c.json([])
  }

  // 강사의 클래스 목록과 다음 예정 수업 정보
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
  const { userId, classId, paymentMethod, cardNumber, cardExpiry, cardCvc, amount, orderType, subscriptionPlan } = await c.req.json()

  const last4 = cardNumber ? cardNumber.slice(-4) : '0000'
  const txId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

  // Create order
  const orderResult = await c.env.DB.prepare(`
    INSERT INTO orders (user_id, order_type, class_id, subscription_plan, amount, payment_method, payment_status, card_last4, transaction_id)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
  `).bind(userId, orderType || 'class', classId || null, subscriptionPlan || null, amount, paymentMethod || 'card', last4, txId).run()

  let classinSession: ClassInSessionResult | null = null
  let virtualAccountInfo: { accountUid: string; password: string; isRegistered: boolean } | null = null

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

      // 새 수업이 생성되었고 기존 session과 다른 경우 - 새 session 필요
      if (classLatest?.classin_class_id &&
          (!classinSession || classinSession.classin_class_id !== classLatest.classin_class_id)) {
        // 새 수업에 대한 session 생성
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
          message: '새 수업에 등록되었습니다.',
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
        message: '이미 수강 중인 클래스입니다.',
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

// Admin: Create test access code
app.post('/api/admin/test-codes/create', async (c) => {
  const { code, description, maxUses, expiresAt, adminKey } = await c.req.json()

  if (adminKey !== 'classin-admin-2024') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  }

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
  const { results } = await c.env.DB.prepare('SELECT * FROM test_access_codes ORDER BY created_at DESC').all()
  return c.json(results)
})

// ==================== ClassIn Virtual Account API Routes ====================

// End enrollment and return virtual account (관리자: 수강 종료 및 가상 계정 반납)
app.post('/api/admin/enrollments/:enrollmentId/end', async (c) => {
  const enrollmentId = parseInt(c.req.param('enrollmentId'))
  const { adminKey } = await c.req.json()

  if (adminKey !== 'classin-admin-2024') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  }

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
  const { adminKey } = await c.req.json()

  if (adminKey !== 'classin-admin-2024') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  }

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
  const { startUid, endUid, sid, expiresAt, adminKey } = await c.req.json()

  // Simple admin key check (in production, use proper auth)
  if (adminKey !== 'classin-admin-2024') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403)
  }

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
        name: '테스트 수업',
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

// ==================== ClassIn 수업 관리 API ====================

// 관리자: ClassIn 수업 생성 (시간 지정)
app.post('/api/admin/classes/:classId/create-session', async (c) => {
  const classId = parseInt(c.req.param('classId'))
  const { scheduledAt } = await c.req.json()  // ISO 8601 format: "2024-03-20T14:00:00"

  if (!scheduledAt) {
    return c.json({ error: '수업 시간(scheduledAt)이 필요합니다.' }, 400)
  }

  // 시간 검증: 최소 2분 후여야 함
  const scheduledTime = new Date(scheduledAt).getTime()
  const minTime = Date.now() + 2 * 60 * 1000  // 2분 후
  if (scheduledTime < minTime) {
    return c.json({ error: '수업 시작 시간은 현재로부터 최소 2분 후여야 합니다.' }, 400)
  }

  const config: ClassInConfig | null = (c.env.CLASSIN_SID && c.env.CLASSIN_SECRET)
    ? { SID: c.env.CLASSIN_SID, SECRET: c.env.CLASSIN_SECRET, API_BASE: 'https://api.eeo.cn' }
    : null

  if (!config) {
    return c.json({ error: 'ClassIn API가 설정되지 않았습니다.' }, 500)
  }

  // 클래스 및 강사 정보 조회
  const cls = await c.env.DB.prepare(`
    SELECT c.*, i.classin_uid as instructor_classin_uid, i.display_name as instructor_name
    FROM classes c
    JOIN instructors i ON c.instructor_id = i.id
    WHERE c.id = ?
  `).bind(classId).first() as any

  if (!cls) {
    return c.json({ error: '클래스를 찾을 수 없습니다.' }, 404)
  }

  if (!cls.instructor_classin_uid) {
    return c.json({ error: '강사가 ClassIn에 등록되지 않았습니다. 먼저 강사를 등록해주세요.' }, 400)
  }

  // 진행중인 수업이 있는지 확인 (아직 끝나지 않은 수업)
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
      message: `진행중인 수업이 있습니다: ${activeLesson.lesson_title}`,
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

  // 2. 수업 번호 계산 (기존 수업 수 + 1)
  const lessonCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM class_lessons WHERE class_id = ?'
  ).bind(classId).first() as any
  const lessonNumber = (lessonCount?.count || 0) + 1
  const lessonTitle = `${cls.title} #${lessonNumber}`

  // 3. 수업(레슨) 생성 - 지정된 시간으로
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
    return c.json({ error: '수업 생성 실패: ' + lessonResult.error }, 500)
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

  // 6. classes 테이블 업데이트 (최신 수업 정보 + lesson_count + schedule_start 동기화)
  await c.env.DB.prepare(`
    UPDATE classes
    SET classin_course_id = ?, classin_class_id = ?, classin_instructor_url = ?,
        classin_status = 'scheduled', classin_scheduled_at = ?, classin_created_at = datetime('now'),
        schedule_start = ?, lesson_count = ?
    WHERE id = ?
  `).bind(courseId, lessonResult.classId, instructorUrl, scheduledAt, scheduledAt, lessonNumber, classId).run()

  return c.json({
    success: true,
    message: `수업 "${lessonTitle}"이 생성되었습니다!`,
    courseId,
    classId: lessonResult.classId,
    lessonId: lessonNumber,
    lessonTitle,
    instructorUrl,
    scheduledAt,
    isNewCourse
  })
})

// 관리자: 클래스별 수업 이력 조회
app.get('/api/admin/classes/:classId/lessons', async (c) => {
  const classId = parseInt(c.req.param('classId'))

  const { results } = await c.env.DB.prepare(`
    SELECT * FROM class_lessons
    WHERE class_id = ?
    ORDER BY lesson_number DESC
  `).bind(classId).all() as { results: any[] }

  // 종료된 수업 처리 (오류 발생해도 기본 결과는 반환)
  try {
    const now = Date.now()
    const classInConfig = await getClassInConfig(c.env.DB)

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

      // 종료된 수업 중 replay_url이 없는 경우 ClassIn API에서 다시보기 URL 가져오기
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

  return c.json({ lessons: results })
})

// 관리자: 수업 상태 업데이트 (ended로 변경 등)
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

// 관리자: 클래스 목록 (ClassIn 상태 포함)
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

// 관리자: 클래스 생성
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

// 관리자: 클래스 수정
app.put('/api/admin/classes/:id', async (c) => {
  const classId = parseInt(c.req.param('id'))
  const { title, description, instructorId, categoryId, price, scheduleStart, durationMinutes, thumbnail, level, classType, status } = await c.req.json()

  const cls = await c.env.DB.prepare('SELECT id FROM classes WHERE id = ?').bind(classId).first()
  if (!cls) {
    return c.json({ error: '클래스를 찾을 수 없습니다.' }, 404)
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

  return c.json({ success: true, message: '클래스가 수정되었습니다.' })
})

// 관리자: 클래스 삭제
app.delete('/api/admin/classes/:id', async (c) => {
  const classId = parseInt(c.req.param('id'))

  const cls = await c.env.DB.prepare('SELECT id, title FROM classes WHERE id = ?').bind(classId).first() as any
  if (!cls) {
    return c.json({ error: '클래스를 찾을 수 없습니다.' }, 404)
  }

  // 활성 수강생이 있는지 확인 (종료/만료된 수강은 제외)
  const enrollments = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM enrollments WHERE class_id = ? AND status = 'active'"
  ).bind(classId).first() as any
  if (enrollments?.count > 0) {
    return c.json({ error: `${enrollments.count}명의 활성 수강생이 있습니다. 먼저 수강을 종료해주세요.` }, 400)
  }

  // 관련 테이블들 삭제 (FOREIGN KEY 제약 해결)
  await c.env.DB.prepare('DELETE FROM classin_sessions WHERE class_id = ?').bind(classId).run()
  await c.env.DB.prepare('DELETE FROM enrollments WHERE class_id = ?').bind(classId).run()
  await c.env.DB.prepare('DELETE FROM orders WHERE class_id = ?').bind(classId).run()
  await c.env.DB.prepare('DELETE FROM lessons WHERE class_id = ?').bind(classId).run()
  await c.env.DB.prepare('DELETE FROM reviews WHERE class_id = ?').bind(classId).run()
  await c.env.DB.prepare('DELETE FROM wishlist WHERE class_id = ?').bind(classId).run()
  await c.env.DB.prepare('DELETE FROM cart WHERE class_id = ?').bind(classId).run()
  await c.env.DB.prepare('DELETE FROM subscriptions WHERE class_id = ?').bind(classId).run()
  await c.env.DB.prepare('DELETE FROM class_lessons WHERE class_id = ?').bind(classId).run()

  // 클래스 삭제
  await c.env.DB.prepare('DELETE FROM classes WHERE id = ?').bind(classId).run()

  return c.json({ success: true, message: '클래스가 삭제되었습니다.' })
})

// 관리자: 카테고리 목록
app.get('/api/admin/categories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM categories ORDER BY sort_order, name').all()
  return c.json({ categories: results })
})

// 관리자: 특정 클래스 ClassIn 정보 조회
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
    return c.json({ error: '클래스를 찾을 수 없습니다.' }, 404)
  }

  // 해당 수업의 수강생 수
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
  const { name, email, classInAccount, profileImage } = await c.req.json()

  if (!name || !email) {
    return c.json({ error: '이름과 로그인 이메일은 필수입니다.' }, 400)
  }

  // 이메일 중복 체크
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) {
    return c.json({ error: '이미 등록된 이메일입니다.' }, 400)
  }

  // ClassIn 계정 결정 (입력값 없으면 로그인 이메일 사용)
  const classInAccountValue = classInAccount?.trim() || email

  // 1. 유저 생성 (ClassIn 계정을 phone 필드에 저장 - 전화번호/이메일 모두 가능)
  const passwordHash = '$2a$10$defaulthash' // 임시 비밀번호
  const userResult = await c.env.DB.prepare(`
    INSERT INTO users (email, password_hash, name, phone, role)
    VALUES (?, ?, ?, ?, 'instructor')
  `).bind(email, passwordHash, name, classInAccountValue !== email ? classInAccountValue : '').run()

  const userId = userResult.meta.last_row_id

  // 2. 강사 레코드 생성
  const instructorResult = await c.env.DB.prepare(`
    INSERT INTO instructors (user_id, display_name, profile_image)
    VALUES (?, ?, ?)
  `).bind(userId, name, profileImage || '').run()

  const instructorId = instructorResult.meta.last_row_id

  // 3. ClassIn 등록 (classInAccount 또는 이메일로 등록)
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
      classin_uid: classInUid
    },
    classInError: classInError || undefined
  })
})

// Update instructor (관리자: 강사 수정)
app.put('/api/admin/instructors/:id', async (c) => {
  const instructorId = parseInt(c.req.param('id'))
  const { name, email, phone, profileImage } = await c.req.json()

  // 강사 정보 조회
  const instructor = await c.env.DB.prepare(`
    SELECT i.*, u.id as user_id, u.phone as user_phone FROM instructors i
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

  // 전화번호가 변경되었고 ClassIn 설정이 있으면 재등록
  let classInResult = null
  const phoneChanged = phone && phone !== instructor.user_phone
  if (phoneChanged && c.env.CLASSIN_SID && c.env.CLASSIN_SECRET) {
    const config = {
      SID: c.env.CLASSIN_SID,
      SECRET: c.env.CLASSIN_SECRET,
      API_BASE: 'https://api.eeo.cn'
    }

    // 기존 UID 초기화
    await c.env.DB.prepare(`
      UPDATE instructors SET classin_uid = NULL, classin_registered_at = NULL WHERE id = ?
    `).bind(instructorId).run()

    // 새 전화번호로 ClassIn 재등록
    classInResult = await registerInstructorWithClassIn(c.env.DB, instructorId, config, phone)
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

  // 해당 강사의 클래스가 있는지 확인
  const hasClasses = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM classes WHERE instructor_id = ?'
  ).bind(instructorId).first() as any

  if (hasClasses?.count > 0) {
    return c.json({ error: `이 강사에게 ${hasClasses.count}개의 클래스가 있습니다. 먼저 클래스를 삭제해주세요.` }, 400)
  }

  // 강사 삭제
  await c.env.DB.prepare('DELETE FROM instructors WHERE id = ?').bind(instructorId).run()
  // 유저도 삭제 (강사 역할만 삭제하려면 이 부분 수정)
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(instructor.user_id).run()

  return c.json({ success: true, message: '강사가 삭제되었습니다.' })
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
    SELECT id, email, name, phone, role, is_test_account, test_expires_at, created_at
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
      SUM(CASE WHEN role = 'instructor' THEN 1 ELSE 0 END) as instructors,
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

  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(userId).first() as any
  if (!user) {
    return c.json({ error: '회원을 찾을 수 없습니다.' }, 404)
  }

  // 강사인 경우 강사 레코드도 삭제
  if (user.role === 'instructor') {
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
// 관리자: 클래스별 수강신청자 관리
// ============================================

// 클래스별 수강신청자 목록
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

// 전체 수강신청자 목록 (클래스 정보 포함)
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
    WHERE status = 'available' AND (expires_at IS NULL OR expires_at > datetime('now'))
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

    // 종료된 수업의 경우 webcast URL 가져오기 (다시보기용)
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

    // 종료된 수업은 다시보기 URL 사용
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

  // 종료된 수업의 경우 replay_url 설정 (다시보기용)
  const startTime = session.scheduled_at ? new Date(session.scheduled_at).getTime() : 0
  const duration = (session.duration_minutes || 60) * 60 * 1000
  const isEnded = session.status === 'ended' || (startTime > 0 && (startTime + duration) < Date.now())

  if (isEnded) {
    // classin_live_url이 없으면 webcast API 호출
    if (!session.classin_live_url && session.classin_course_id && session.classin_class_id) {
      const classInConfig = await getClassInConfig(c.env.DB)
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
  const loginUrlResult = await getClassInLoginUrl(
    classInConfig,
    studentUid,
    session.classin_course_id,
    session.classin_class_id,
    1  // PC
  )

  if (loginUrlResult.url) {
    // Update the session with the fresh URL
    await c.env.DB.prepare('UPDATE classin_sessions SET classin_join_url = ? WHERE id = ?')
      .bind(loginUrlResult.url, sessionId).run()

    if (shouldRedirect) {
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

// Generate fresh login URL for instructor entering a class (강사 입장 URL 동적 생성)
// Use ?redirect=true to automatically redirect to the ClassIn URL
app.get('/api/classin/instructor-enter/:lessonId', async (c) => {
  const lessonId = c.req.param('lessonId')
  const shouldRedirect = c.req.query('redirect') === 'true'

  // Get lesson info with instructor details
  const lesson = await c.env.DB.prepare(`
    SELECT cl.*, c.instructor_id, i.classin_uid as instructor_classin_uid, i.display_name as instructor_name
    FROM class_lessons cl
    JOIN classes c ON cl.class_id = c.id
    JOIN instructors i ON c.instructor_id = i.id
    WHERE cl.id = ?
  `).bind(lessonId).first() as any

  if (!lesson) {
    if (shouldRedirect) {
      return c.html('<html><body><h2>수업을 찾을 수 없습니다.</h2></body></html>')
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

  const instructorUid = lesson.instructor_classin_uid
  if (!instructorUid) {
    if (shouldRedirect) {
      return c.html('<html><body><h2>강사의 ClassIn UID가 없습니다. 관리자에게 문의하세요.</h2></body></html>')
    }
    return c.json({ error: 'Instructor has no ClassIn UID' }, 400)
  }

  // Step 1: Add teacher to course (코스에 강사 추가 - 이미 추가된 경우 무시됨)
  const courseResult = await addTeacherToCourse(classInConfig, lesson.classin_course_id, instructorUid)
  console.log('addTeacherToCourse result:', JSON.stringify(courseResult), 'instructorUid:', instructorUid, 'courseId:', lesson.classin_course_id)

  // Step 2: Generate fresh login URL with token (identity=3 강사)
  const loginUrlResult = await getClassInLoginUrl(
    classInConfig,
    instructorUid,
    lesson.classin_course_id,
    lesson.classin_class_id,
    1,  // PC
    3   // 강사
  )

  if (loginUrlResult.url) {
    // Update the lesson with the fresh URL
    await c.env.DB.prepare('UPDATE class_lessons SET classin_instructor_url = ? WHERE id = ?')
      .bind(loginUrlResult.url, lessonId).run()

    // Also update classes table for latest lesson
    await c.env.DB.prepare('UPDATE classes SET classin_instructor_url = ? WHERE id = ?')
      .bind(loginUrlResult.url, lesson.class_id).run()

    if (shouldRedirect) {
      return c.redirect(loginUrlResult.url)
    }
    return c.json({ success: true, url: loginUrlResult.url })
  }

  // Fallback to basic URL (without authTicket - user will need to login manually)
  const fallbackUrl = `https://www.eeo.cn/client/invoke/index.html?uid=${instructorUid}&classId=${lesson.classin_class_id}&courseId=${lesson.classin_course_id}&schoolId=${classInConfig.SID}`
  if (shouldRedirect) {
    return c.redirect(fallbackUrl)
  }
  return c.json({ success: true, url: fallbackUrl, warning: loginUrlResult.error || 'authTicket 생성 실패. ClassIn에 직접 로그인해야 합니다.' })
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

// ==================== HTML Pages ====================

const headHTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClassIn Live - 라이브 양방향 클래스 플랫폼</title>
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
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-2xl shadow-2xl p-8 text-center fade-in">
    <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
      <i class="fas fa-check text-green-500 text-2xl"></i>
    </div>
    <h3 class="text-xl font-bold text-dark-900 mb-2">결제 완료!</h3>
    <p id="successMessage" class="text-sm text-gray-600 mb-4">결제가 성공적으로 완료되었습니다.</p>
    
    <!-- ClassIn Session Info -->
    <div id="classinSessionInfo" class="hidden mb-4">
      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 text-left">
        <div class="flex items-center gap-2 mb-3">
          <div class="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
            <i class="fas fa-video text-white text-sm"></i>
          </div>
          <div>
            <p class="text-sm font-bold text-blue-900">ClassIn 수업방이 생성되었습니다</p>
            <p id="classinModeTag" class="text-[10px] text-blue-600 font-medium"></p>
          </div>
        </div>
        <div class="space-y-2">
          <div class="flex items-center gap-2 text-sm">
            <i class="fas fa-link text-blue-400 w-4"></i>
            <span class="text-blue-800 truncate flex-1" id="classinJoinUrlText"></span>
          </div>
          <div class="flex items-center gap-2 text-sm">
            <i class="fas fa-hashtag text-blue-400 w-4"></i>
            <span class="text-blue-800" id="classinClassIdText">수업 ID: </span>
          </div>
        </div>
        <a id="classinJoinBtn" href="#" target="_blank" rel="noopener" class="mt-3 w-full h-10 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2">
          <i class="fas fa-door-open"></i>
          ClassIn 수업방 입장하기
        </a>
      </div>
    </div>
    
    <div class="flex gap-2">
      <button onclick="closeSuccessModal()" class="flex-1 h-11 bg-gray-100 hover:bg-gray-200 text-dark-700 font-semibold rounded-xl transition-all">확인</button>
      <button id="goToMyClassBtn" onclick="closeSuccessModal(); openMyPage('enrollments')" class="flex-1 h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all">
        <i class="fas fa-book-open mr-1"></i>내 수업 보기
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
        <p class="text-sm text-purple-800"><i class="fas fa-info-circle mr-2"></i>테스트 코드를 입력하면 <strong>30일간 결제 없이</strong> 모든 클래스를 무료로 수강할 수 있습니다.</p>
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
        <span class="text-sm font-medium text-dark-700 hidden sm:block">마이페이지(\${currentUser.name}\${currentUser.is_test_account ? ',테스트' : ''})</span>
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
      
      // Show ClassIn session info if available
      if (data.classinSession && data.classinSession.joinUrl) {
        const infoDiv = document.getElementById('classinSessionInfo');
        infoDiv.classList.remove('hidden');
        document.getElementById('classinJoinUrlText').textContent = data.classinSession.joinUrl;
        document.getElementById('classinClassIdText').textContent = '수업 ID: ' + (data.classinSession.classId || '');
        document.getElementById('classinJoinBtn').href = data.classinSession.joinUrl;
        document.getElementById('classinModeTag').textContent = data.classinSession.isDemo ? 'DEMO MODE - 실제 API 키 설정 시 ClassIn 연동' : 'ClassIn API 연동됨';
      } else {
        document.getElementById('classinSessionInfo').classList.add('hidden');
      }
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
  // Refresh user data
  if (currentUser) {
    fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:currentUser.email, password:'any'}) })
      .then(r=>r.json()).then(d=>{ if(d.user){ currentUser=d.user; localStorage.setItem('classin_user',JSON.stringify(d.user)); updateAuthUI(); }});
  }
}

// ==================== Subscription (월간 자동결제) ====================
let subscriptionData = {};

function openSubscriptionModal(data) {
  if (!currentUser) { openAuthModal('login'); return; }

  // 테스트 계정이 클래스 월간 구독 시도 시 바로 수강 등록
  if (currentUser.is_test_account && data.classId) {
    testEnroll(data.classId);
    return;
  }

  subscriptionData = data;
  document.getElementById('paymentModal').classList.remove('hidden');
  
  const billingDay = new Date().getDate();
  const nextMonth = new Date(); nextMonth.setMonth(nextMonth.getMonth() + 1);
  
  document.getElementById('paymentOrderSummary').innerHTML = \`
    <div class="flex gap-3">
      \${data.thumbnail ? \`<img src="\${data.thumbnail}" class="w-20 h-14 rounded-lg object-cover">\` : \`<div class="w-20 h-14 bg-primary-50 rounded-lg flex items-center justify-center"><i class="fas fa-crown text-primary-500 text-xl"></i></div>\`}
      <div>
        <p class="text-sm font-semibold text-dark-800">\${data.title}</p>
        <p class="text-xs text-gray-500 mt-0.5">\${data.instructor_name || '모든 클래스 무제한'}</p>
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
        document.getElementById('classinClassIdText').textContent = '수업 ID: ' + (data.classinSession.classId || '');
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
  const isInstructor = currentUser.role === 'instructor';
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
      <a href="\${joinUrl}" target="_blank" rel="noopener"
         onclick="setTimeout(() => { document.getElementById('enrollSuccessModal').remove(); window.location.reload(); }, 300);"
         class="block w-full h-12 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-xl transition-all shadow-lg flex items-center justify-center gap-2 mb-3">
        <i class="fas fa-door-open"></i>
        ClassIn 수업방 입장하기
      </a>
      <button onclick="document.getElementById('enrollSuccessModal').remove(); window.location.reload();"
              class="w-full h-10 text-gray-500 hover:text-gray-700 font-medium transition-all">
        나중에 입장하기
      </button>
      \${isDemo ? '<p class="text-xs text-gray-400 mt-3"><i class="fas fa-info-circle mr-1"></i>DEMO MODE</p>' : ''}
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
  const isInstructor = currentUser.role === 'instructor';
  const tabs = isInstructor ? ['enrollments','completed'] : ['enrollments','completed','subscriptions','orders'];

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
      // 강의중인 클래스
      const res = await fetch('/api/user/'+currentUser.id+'/instructor-classes');
      const items = await res.json();

      const activeItems = items.filter(c => c.next_lesson_id || c.total_lesson_count === 0);

      container.innerHTML = activeItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-chalkboard text-3xl mb-2"></i><p>강의중인 클래스가 없습니다</p></div>'
        : activeItems.map(c => {
          const hasNextLesson = c.next_lesson_id;
          const progress = c.total_lesson_count > 0 ? Math.round((c.completed_lesson_count / c.total_lesson_count) * 100) : 0;

          let lessonSection = '';
          if (hasNextLesson) {
            const dateStr = c.next_lesson_scheduled_at ? new Date(c.next_lesson_scheduled_at).toLocaleDateString('ko-KR', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
            const enterBtn = c.next_lesson_id
              ? '<a href="/api/classin/instructor-enter/' + c.next_lesson_id + '?redirect=true" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex-1 h-8 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all"><i class="fas fa-door-open"></i> 강의실 입장</a>'
              : '<span class="flex-1 h-8 bg-gray-200 text-gray-600 text-xs font-semibold rounded-lg flex items-center justify-center gap-1"><i class="fas fa-clock"></i> 수업 준비중</span>';
            lessonSection = '<div class="mt-2 pt-2 border-t border-gray-50"><div class="flex items-center gap-2 mb-2"><span class="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-bold rounded">다음 수업</span><span class="text-[11px] text-gray-400">' + dateStr + '</span></div><p class="text-xs text-gray-600 mb-2 line-clamp-1">' + (c.next_lesson_title || '') + '</p><div class="flex gap-2">' + enterBtn + '</div></div>';
          } else {
            lessonSection = '<div class="mt-2 pt-2 border-t border-gray-50"><p class="text-xs text-gray-400 text-center">아직 예정된 수업이 없습니다</p></div>';
          }

          return '<div class="p-3 rounded-xl hover:bg-gray-50 transition-all mb-2 border border-gray-100"><a href="/class/' + c.slug + '" class="flex gap-3"><div class="relative flex-shrink-0"><img src="' + (c.thumbnail || 'https://via.placeholder.com/80x56?text=No+Image') + '" class="w-20 h-14 rounded-lg object-cover">' + (hasNextLesson ? '<span class="absolute -top-1 -right-1 w-5 h-5 bg-indigo-500 rounded-full flex items-center justify-center"><i class="fas fa-video text-white text-[8px]"></i></span>' : '') + '</div><div class="flex-1 min-w-0"><p class="text-sm font-medium text-dark-800 line-clamp-1">' + c.title + '</p><p class="text-xs text-gray-500">' + (c.category_name || '') + ' · 수강생 ' + (c.active_students || 0) + '명</p><div class="flex items-center gap-2 mt-1"><div class="flex-1 bg-gray-200 rounded-full h-1.5"><div class="bg-indigo-500 h-1.5 rounded-full" style="width:' + progress + '%"></div></div><span class="text-[10px] text-gray-400">' + (c.completed_lesson_count || 0) + '/' + (c.total_lesson_count || 0) + '회</span></div></div></a>' + lessonSection + '</div>';
        }).join('');
    } else if (tab === 'completed') {
      // 강의완료된 클래스
      const res = await fetch('/api/user/'+currentUser.id+'/instructor-classes');
      const items = await res.json();

      const completedItems = items.filter(c => c.total_lesson_count > 0 && !c.next_lesson_id);

      container.innerHTML = completedItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-check-circle text-3xl mb-2"></i><p>강의 완료된 클래스가 없습니다</p></div>'
        : completedItems.map(c => {
          const progress = c.total_lesson_count > 0 ? Math.round((c.completed_lesson_count / c.total_lesson_count) * 100) : 100;
          return \`
          <div class="p-3 rounded-xl hover:bg-gray-50 transition-all mb-2 border border-gray-100">
            <a href="/class/\${c.slug}" class="flex gap-3">
              <div class="relative flex-shrink-0">
                <img src="\${c.thumbnail || 'https://via.placeholder.com/80x56?text=No+Image'}" class="w-20 h-14 rounded-lg object-cover">
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
                <span class="text-[11px] text-gray-400">총 \${c.completed_lesson_count || 0}회 수업</span>
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

    // 활성 수강만 표시 (다음 예정 수업이 있거나, 수업이 아직 없는 경우)
    const activeItems = items.filter(e => {
      // 관리자가 종료/만료 처리한 수강은 제외
      if (e.status === 'ended' || e.status === 'expired') return false;
      // 다음 예정 수업이 있거나, 아직 수업이 없는 경우 표시
      return e.next_lesson_id || e.total_lesson_count === 0;
    });

    container.innerHTML = activeItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-book-open text-3xl mb-2"></i><p>수강 중인 클래스가 없습니다</p></div>'
      : activeItems.map(e => {
        const hasNextLesson = e.next_lesson_id;
        const progress = e.total_lesson_count > 0 ? Math.round((e.completed_lesson_count / e.total_lesson_count) * 100) : 0;

        let lessonSection = '';
        if (hasNextLesson) {
          const dateStr = e.next_lesson_scheduled_at ? new Date(e.next_lesson_scheduled_at).toLocaleDateString('ko-KR', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
          const enterBtn = e.next_lesson_session_id
            ? '<a href="/api/classin/enter/' + e.next_lesson_session_id + '?redirect=true" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex-1 h-8 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all"><i class="fas fa-door-open"></i> 수업 입장</a>'
            : (e.next_lesson_join_url
              ? '<a href="' + e.next_lesson_join_url + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex-1 h-8 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all"><i class="fas fa-door-open"></i> 수업 입장</a>'
              : '<span class="flex-1 h-8 bg-gray-200 text-gray-600 text-xs font-semibold rounded-lg flex items-center justify-center gap-1"><i class="fas fa-clock"></i> 수업 준비중</span>');
          lessonSection = '<div class="mt-2 pt-2 border-t border-gray-50"><div class="flex items-center gap-2 mb-2"><span class="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded">다음 수업</span><span class="text-[11px] text-gray-400">' + dateStr + '</span></div><p class="text-xs text-gray-600 mb-2 line-clamp-1">' + (e.next_lesson_title || '') + '</p><div class="flex gap-2">' + enterBtn + '</div></div>';
        } else {
          lessonSection = '<div class="mt-2 pt-2 border-t border-gray-50"><p class="text-xs text-gray-400 text-center">아직 예정된 수업이 없습니다</p></div>';
        }

        return '<div class="p-3 rounded-xl hover:bg-gray-50 transition-all mb-2 border border-gray-100"><a href="/class/' + e.slug + '" class="flex gap-3"><div class="relative flex-shrink-0"><img src="' + e.thumbnail + '" class="w-20 h-14 rounded-lg object-cover">' + (hasNextLesson ? '<span class="absolute -top-1 -right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center"><i class="fas fa-video text-white text-[8px]"></i></span>' : '') + '</div><div class="flex-1 min-w-0"><p class="text-sm font-medium text-dark-800 line-clamp-1">' + e.title + '</p><p class="text-xs text-gray-500">' + e.instructor_name + '</p><div class="flex items-center gap-2 mt-1"><div class="flex-1 bg-gray-200 rounded-full h-1.5"><div class="bg-primary-500 h-1.5 rounded-full" style="width:' + progress + '%"></div></div><span class="text-[10px] text-gray-400">' + (e.completed_lesson_count || 0) + '/' + (e.total_lesson_count || 0) + '</span></div></div></a>' + lessonSection + '</div>';
      }).join('');
  } else if (tab === 'completed') {
    const res = await fetch('/api/user/'+currentUser.id+'/enrollments');
    const items = await res.json();

    // 완료된 수강 (종료/만료 처리되었거나, 모든 수업이 완료된 경우)
    const completedItems = items.filter(e => {
      if (e.status === 'ended' || e.status === 'expired') return true;
      // 수업이 있고, 다음 예정 수업이 없으면 완료
      return e.total_lesson_count > 0 && !e.next_lesson_id;
    });

    container.innerHTML = completedItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-check-circle text-3xl mb-2"></i><p>수강 완료된 클래스가 없습니다</p></div>'
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
              <span class="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded">\${e.status === 'ended' ? '수강 종료' : '수업 완료'}</span>
              <span class="text-[11px] text-gray-400">총 \${e.completed_lesson_count || 0}회 수업</span>
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
                <p class="text-sm font-bold text-dark-800">\${sub.class_title || '전체 클래스 구독'}</p>
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
  setTimeout(() => toast.remove(), 4000);
}

function formatPrice(price) { return price?.toLocaleString() + '원'; }

// Class card HTML generator
function classCardHTML(cls) {
  // 수업 종료 여부 확인 (schedule_start + duration이 현재 시간보다 이전인 경우)
  const now = Date.now();
  const scheduleTime = cls.classin_scheduled_at ? new Date(cls.classin_scheduled_at).getTime() :
                       (cls.schedule_start ? new Date(cls.schedule_start).getTime() : 0);
  const durationMs = (cls.duration_minutes || 60) * 60 * 1000;
  const isEnded = cls.class_type === 'live' && scheduleTime > 0 && (scheduleTime + durationMs < now);

  // 수업 종료된 경우 비활성화
  if (isEnded) {
    return \`
      <div class="block bg-white rounded-2xl overflow-hidden border border-gray-200 opacity-60 cursor-not-allowed">
        <div class="relative aspect-[16/10] overflow-hidden grayscale">
          <img src="\${cls.thumbnail}" alt="\${cls.title}" class="w-full h-full object-cover" loading="lazy">
          <span class="absolute top-2.5 right-2.5 px-2 py-0.5 bg-gray-600 text-white text-[10px] font-bold rounded-md">수업 종료</span>
        </div>
        <div class="p-4">
          <div class="flex items-center gap-1.5 mb-2">
            <span class="text-xs text-gray-400 font-medium">\${cls.category_name || ''}</span>
            <span class="text-gray-300 text-xs">|</span>
            <span class="text-xs text-gray-400">\${cls.level === 'beginner' ? '입문' : cls.level === 'intermediate' ? '중급' : cls.level === 'advanced' ? '고급' : '전체'}</span>
          </div>
          <h3 class="text-sm font-semibold text-gray-500 line-clamp-2 mb-2 leading-snug">\${cls.title}</h3>
          <div class="flex items-center gap-1.5 mb-3">
            <span class="text-xs text-gray-400 font-medium">\${cls.instructor_name}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-sm font-bold text-gray-500">\${cls.price.toLocaleString()}원</span>
          </div>
          <div class="flex items-center gap-3 mt-2 pt-2 border-t border-gray-50 text-[11px] text-gray-400">
            <span><i class="far fa-clock mr-0.5"></i>\${cls.duration_minutes}분</span>
            <span class="text-gray-400">종료됨</span>
          </div>
        </div>
      </div>
    \`;
  }

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
          <span class="text-sm font-medium">실시간 라이브 양방향 클래스</span>
        </div>
        <h1 class="text-3xl md:text-5xl font-extrabold leading-tight mb-4">
          당신의 성장을 위한<br>
          <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 to-pink-400">라이브 양방향 클래스</span>가 시작됩니다
        </h1>
        <p class="text-gray-300 text-base md:text-lg mb-8 leading-relaxed">
          검증된 전문 강사의 실시간 양방향 수업으로 배우고,<br>
          직접 질문하고 소통하며 빠르게 성장하세요.
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
        <h2 class="text-xl md:text-2xl font-bold text-white">예정된 라이브 양방향 클래스</h2>
        <p class="text-sm text-gray-400 mt-1">실시간으로 선생님과 소통하며 배워보세요</p>
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
                <span class="text-xs text-gray-500">${cls.schedule_start ? new Date(cls.schedule_start).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul', month: 'long', day: 'numeric'}) : ''}</span>
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
    <h2 class="text-2xl md:text-3xl font-bold text-dark-900 mb-3"><i class="fas fa-crown text-yellow-500 mr-2"></i>월간 구독으로 편하게 수강하세요</h2>
    <p class="text-gray-500">결제일 기준 매월 자동결제! 5일에 결제하면 매달 5일에 자동으로 결제됩니다</p>
    <div class="inline-flex items-center gap-2 mt-3 px-4 py-2 bg-blue-50 rounded-full">
      <i class="fas fa-sync-alt text-blue-500 text-sm"></i>
      <span class="text-sm text-blue-700 font-medium">월간 자동결제 · 언제든 해지 가능</span>
    </div>
  </div>
  <div class="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
    
    <!-- 개별 클래스 월간 구독 -->
    <div class="bg-white rounded-2xl border-2 border-gray-100 p-6 hover:border-primary-200 transition-all">
      <div class="text-center">
        <div class="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center mx-auto mb-3">
          <i class="fas fa-book-open text-blue-500 text-lg"></i>
        </div>
        <span class="text-sm font-semibold text-gray-500 uppercase">클래스 월간 구독</span>
        <div class="mt-3 mb-1">
          <span class="text-3xl font-extrabold text-dark-900">클래스별</span>
        </div>
        <p class="text-sm text-gray-400 mb-4">월 수강료 자동결제</p>
        <ul class="text-sm text-gray-600 space-y-2 mb-6 text-left">
          <li><i class="fas fa-check text-green-500 mr-2"></i>선택한 클래스 매월 수강</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>매월 결제일에 자동 결제</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>ClassIn 라이브 수업 참여</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>녹화 강의 다시보기</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>언제든 해지 가능</li>
        </ul>
        <a href="/categories" class="block w-full h-11 border-2 border-blue-500 text-blue-500 font-semibold rounded-xl hover:bg-blue-50 transition-all leading-[2.75rem] text-center">클래스 선택하기</a>
      </div>
    </div>

    <!-- 전체 클래스 월간 구독 -->
    <div class="bg-white rounded-2xl border-2 border-primary-500 p-6 relative shadow-lg shadow-primary-100">
      <div class="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary-500 text-white text-xs font-bold rounded-full">BEST</div>
      <div class="text-center">
        <div class="w-12 h-12 bg-primary-50 rounded-xl flex items-center justify-center mx-auto mb-3">
          <i class="fas fa-crown text-primary-500 text-lg"></i>
        </div>
        <span class="text-sm font-semibold text-primary-500 uppercase">전체 구독 플랜</span>
        <div class="mt-3 mb-1">
          <span class="text-3xl font-extrabold text-dark-900">199,000</span>
          <span class="text-gray-500">원/월</span>
        </div>
        <p class="text-xs text-gray-400 mb-4">매월 자동결제 <span class="line-through">299,000원</span> <span class="text-primary-500 font-bold">33% 할인</span></p>
        <ul class="text-sm text-gray-600 space-y-2 mb-6 text-left">
          <li><i class="fas fa-check text-green-500 mr-2"></i><strong>모든 클래스</strong> 무제한 수강</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>매월 결제일에 자동 결제</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>ClassIn 라이브 수업 무제한</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>녹화 강의 전체 다시보기</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>1:1 멘토링 월 2회</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>커뮤니티 & 학습자료 제공</li>
          <li><i class="fas fa-check text-green-500 mr-2"></i>언제든 해지 가능</li>
        </ul>
        <button onclick="openSubscriptionModal({planType:'all_monthly', title:'전체 클래스 월간 구독', amount:199000, originalAmount:299000})" class="w-full h-11 bg-primary-500 hover:bg-primary-600 text-white font-semibold rounded-xl transition-all shadow-lg shadow-primary-500/30">월간 구독 시작하기</button>
      </div>
    </div>

    <!-- 구독 혜택 안내 -->
    <div class="bg-gradient-to-br from-dark-800 to-dark-900 rounded-2xl p-6 text-white">
      <div class="text-center md:text-left">
        <div class="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center mx-auto md:mx-0 mb-3">
          <i class="fas fa-shield-alt text-yellow-400 text-lg"></i>
        </div>
        <h3 class="text-lg font-bold mb-4">월간 자동결제 안내</h3>
        <div class="space-y-4 text-sm">
          <div class="flex items-start gap-3">
            <div class="w-7 h-7 bg-blue-500/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-calendar-check text-blue-400 text-xs"></i>
            </div>
            <div>
              <p class="font-semibold">결제일 기준 자동결제</p>
              <p class="text-gray-400 text-xs mt-0.5">5일에 결제하면 매달 5일에 자동 결제</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-7 h-7 bg-green-500/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-undo text-green-400 text-xs"></i>
            </div>
            <div>
              <p class="font-semibold">언제든 해지 가능</p>
              <p class="text-gray-400 text-xs mt-0.5">해지해도 결제 기간까지 이용 가능</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-7 h-7 bg-yellow-500/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-bell text-yellow-400 text-xs"></i>
            </div>
            <div>
              <p class="font-semibold">결제 전 알림</p>
              <p class="text-gray-400 text-xs mt-0.5">자동결제 3일 전 알림 발송</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-7 h-7 bg-primary-500/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
              <i class="fas fa-credit-card text-primary-400 text-xs"></i>
            </div>
            <div>
              <p class="font-semibold">안전한 결제</p>
              <p class="text-gray-400 text-xs mt-0.5">카드정보 암호화 저장, PCI DSS 준수</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    
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
  const sort = urlParams.get('sort') || 'newest';
  document.getElementById('sortSelect').value = sort;
  if (cat) filterByCategory(cat);
  else loadClasses(false);
});
</script>
</body></html>`
  return c.html(applyBranding(html, c.env))
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

  // 다음 예정 수업 정보 (class_lessons 기준)
  const nextLesson = await c.env.DB.prepare(`
    SELECT * FROM class_lessons
    WHERE class_id = ? AND datetime(scheduled_at, '+' || COALESCE(duration_minutes, 60) || ' minutes') > datetime('now')
    ORDER BY scheduled_at ASC LIMIT 1
  `).bind(cls.id).first()
  cls.next_lesson = nextLesson

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
            
            ${cls.next_lesson ? `
            <div class="flex items-center gap-2 px-3 py-2 bg-red-50 rounded-xl mb-3">
              <i class="fas fa-calendar-alt text-red-500"></i>
              <span class="text-sm font-medium text-red-700">다음 수업: ${new Date(cls.next_lesson.scheduled_at).toLocaleString('ko-KR', {timeZone:'Asia/Seoul', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'})}</span>
            </div>
            <p class="text-xs text-gray-500 mb-3 -mt-1">${cls.next_lesson.lesson_title}</p>
            ` : (cls.schedule_start ? `
            <div class="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-xl mb-3">
              <i class="fas fa-calendar-alt text-gray-500"></i>
              <span class="text-sm font-medium text-gray-600">예정된 수업 없음</span>
            </div>
            ` : '')}
            
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
              <button onclick='openPaymentModal(${JSON.stringify({id:cls.id, title:cls.title, price:cls.price, original_price:cls.original_price, discount_percent:cls.discount_percent, thumbnail:cls.thumbnail, instructor_name:cls.instructor_name})})' class="w-full h-12 bg-primary-500 hover:bg-primary-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-primary-500/30 mb-2">
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
              <button onclick='openSubscriptionModal(${JSON.stringify({planType:"class_monthly", classId:cls.id, title:cls.title, amount:cls.price, originalAmount:cls.original_price, thumbnail:cls.thumbnail, instructor_name:cls.instructor_name})})' class="w-full h-12 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-500/30 mb-2">
                <i class="fas fa-sync-alt mr-2"></i>월간 구독 시작 · ${cls.price.toLocaleString()}원/월
              </button>
            </div>
            
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
          <i class="fas fa-arrow-left text-xs"></i> 클래스로 돌아가기
        </a>
        
        <!-- Status Badge -->
        <div class="flex items-center gap-2 mb-4">
          <span class="px-2.5 py-1 ${session.status === 'live' ? 'bg-red-500 badge-live' : session.status === 'ready' ? 'bg-blue-500' : 'bg-gray-500'} text-white text-xs font-bold rounded-lg">
            <i class="fas ${session.status === 'live' ? 'fa-circle text-[6px] mr-1' : session.status === 'ready' ? 'fa-check-circle mr-1' : 'fa-clock mr-1'}"></i>
            ${session.status === 'live' ? 'LIVE 진행중' : session.status === 'ready' ? '수업 준비 완료' : session.status === 'ended' ? '수업 종료' : '대기중'}
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
          <p class="text-sm text-gray-300 mb-3"><i class="fas fa-calendar-alt mr-1"></i>수업 시작까지</p>
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
            <p class="text-sm font-semibold text-gray-300">수업이 완료되었습니다. 아래 버튼을 눌러 다시 보기하세요.</p>
          </div>
        </div>
        ` : `
        <div class="bg-green-500/10 backdrop-blur-sm rounded-2xl p-4 mb-6 border border-green-500/20">
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-green-500 rounded-full badge-live"></span>
            <p class="text-sm font-semibold text-green-300">수업이 곧 시작됩니다! 아래 버튼을 눌러 입장하세요.</p>
          </div>
        </div>
        `}
        
        <!-- Join Button -->
        <a href="${session.status === 'ended' && session.classin_live_url ? session.classin_live_url : session.classin_join_url}" target="_blank" rel="noopener" class="w-full h-14 ${session.status === 'ended' ? 'bg-green-500 hover:bg-green-600 shadow-green-500/30' : 'bg-blue-500 hover:bg-blue-600 shadow-blue-500/30'} text-white font-bold rounded-2xl transition-all shadow-lg flex items-center justify-center gap-3 text-lg mb-3">
          <i class="fas ${session.status === 'ended' ? 'fa-play-circle' : 'fa-door-open'}"></i>
          ${session.status === 'ended' ? 'ClassIn 수업 다시보기' : 'ClassIn 수업방 입장하기'}
        </a>
        <p class="text-center text-xs text-gray-500">${session.status === 'ended' ? '녹화된 수업 영상을 다시 볼 수 있습니다' : 'ClassIn 앱 또는 웹 브라우저에서 수업이 열립니다'}</p>
      </div>
      
      <!-- Right side: Session Info Card -->
      <div class="bg-white/5 backdrop-blur-sm rounded-2xl p-6 border border-white/10">
        <img src="${session.class_thumbnail}" class="w-full rounded-xl mb-4 aspect-video object-cover">
        
        <h3 class="text-lg font-bold mb-4">수업 정보</h3>
        
        <div class="space-y-3">
          <div class="flex items-center gap-3 text-sm">
            <div class="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center"><i class="fas fa-clock text-blue-400"></i></div>
            <div>
              <p class="text-gray-400 text-xs">수업 시간</p>
              <p class="font-medium">${session.duration_minutes}분</p>
            </div>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <div class="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center"><i class="fas fa-signal text-green-400"></i></div>
            <div>
              <p class="text-gray-400 text-xs">수업 유형</p>
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
              <p class="text-gray-400 text-xs">총 수업 수</p>
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
      <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-clipboard-check text-blue-500 mr-2"></i>수업 전 체크리스트</h2>
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
            <p class="text-xs text-gray-500">양방향 수업을 위해 카메라와 마이크가 정상 작동하는지 확인</p>
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
            <p class="text-xs text-gray-500">수업 내용을 메모할 수 있는 도구를 준비하세요</p>
          </div>
        </label>
      </div>
    </div>
    
    <!-- ClassIn Features -->
    <div class="bg-white rounded-2xl p-6 border border-gray-100">
      <h2 class="text-lg font-bold text-dark-900 mb-4"><i class="fas fa-star text-yellow-500 mr-2"></i>ClassIn 양방향 수업 기능</h2>
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
            <p class="text-sm font-semibold text-dark-800">수업 녹화 & 다시보기</p>
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
          현재 ClassIn API가 데모 모드로 운영 중입니다. 실제 수업방이 생성되지는 않습니다.<br>
          실제 ClassIn 수업방을 자동 생성하려면 다음이 필요합니다:
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
              <p class="text-sm text-gray-500">클래스별 수강생 관리, 수강 종료</p>
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
          <h2 class="text-lg font-bold text-gray-800"><i class="fas fa-book text-blue-500 mr-2"></i>클래스 관리</h2>
          <div class="flex items-center gap-2">
            <button onclick="openAddClassModal()" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg transition-all text-sm">
              <i class="fas fa-plus mr-1"></i>클래스 추가
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
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">이미지</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">클래스명</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">강사</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">가격</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">라이브 시작</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ClassIn</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">예약 시간</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">강사입장</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">수업생성</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">수업이력</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">작업</th>
            </tr>
          </thead>
          <tbody id="classesTable" class="divide-y divide-gray-100">
            <tr><td colspan="11" class="px-6 py-8 text-center text-gray-400">로딩 중...</td></tr>
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
  <div id="createSessionModal" class="fixed inset-0 z-50 hidden">
    <div class="absolute inset-0 bg-black/50" onclick="closeSessionModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl">
      <h3 class="text-lg font-bold mb-4"><i class="fas fa-calendar-plus text-blue-500 mr-2"></i>ClassIn 수업 생성</h3>
      <div class="space-y-4">
        <div>
          <p class="text-sm text-gray-500 mb-1">클래스</p>
          <p class="font-medium" id="sessionClassName">-</p>
        </div>
        <div>
          <p class="text-sm text-gray-500 mb-1">강사</p>
          <p class="font-medium" id="sessionInstructor">-</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">수업 시작 시간</label>
          <input type="datetime-local" id="sessionScheduledAt" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeSessionModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button id="createSessionBtn" onclick="confirmCreateSession()" class="flex-1 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg disabled:bg-gray-400 disabled:cursor-not-allowed">생성</button>
      </div>
    </div>
  </div>

  <!-- Lesson History Modal -->
  <div id="lessonHistoryModal" class="fixed inset-0 z-50 hidden overflow-y-auto">
    <div class="absolute inset-0 bg-black/50" onclick="closeLessonHistoryModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-2xl shadow-xl max-h-[80vh] overflow-y-auto">
      <h3 class="text-lg font-bold mb-4"><i class="fas fa-history text-purple-500 mr-2"></i>수업 이력 - <span id="lessonHistoryClassName"></span></h3>
      <div id="lessonHistoryContent">
        <p class="text-gray-500 text-center py-4">로딩중...</p>
      </div>
      <button onclick="closeLessonHistoryModal()" class="mt-4 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2 rounded-lg">닫기</button>
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
          <label class="block text-sm font-medium text-gray-700 mb-1">ClassIn 계정 (전화번호/이메일)</label>
          <input type="text" id="newInstructorClassInAccount" placeholder="010-1234-5678 또는 classin@example.com" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
          <p class="text-xs text-gray-500 mt-1">비워두면 로그인 이메일로 ClassIn에 등록됩니다.</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">프로필 이미지 URL</label>
          <input type="text" id="newInstructorImage" placeholder="https://..." class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeAddInstructorModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button onclick="confirmAddInstructor()" class="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold rounded-lg">추가</button>
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
          <label class="block text-sm font-medium text-gray-700 mb-1">전화번호 (ClassIn 등록용)</label>
          <input type="text" id="editInstructorPhone" placeholder="010-1234-5678" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">프로필 이미지 URL</label>
          <input type="text" id="editInstructorImage" placeholder="https://..." class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
      </div>
      <div class="flex gap-3 mt-6">
        <button onclick="closeEditInstructorModal()" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg">취소</button>
        <button onclick="confirmEditInstructor()" class="flex-1 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg">저장</button>
      </div>
    </div>
  </div>

  <!-- Add/Edit Class Modal -->
  <div id="classModal" class="fixed inset-0 z-50 hidden overflow-y-auto">
    <div class="absolute inset-0 bg-black/50" onclick="closeClassModal()"></div>
    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl p-6 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-y-auto">
      <h3 class="text-lg font-bold mb-4" id="classModalTitle"><i class="fas fa-book text-blue-500 mr-2"></i>클래스 추가</h3>
      <input type="hidden" id="editClassId" value="">
      <div class="grid grid-cols-2 gap-4">
        <div class="col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">제목 <span class="text-red-500">*</span></label>
          <input type="text" id="classTitle" placeholder="클래스 제목" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div class="col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">설명</label>
          <textarea id="classDescription" placeholder="클래스 설명" rows="3" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"></textarea>
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
          <label class="block text-sm font-medium text-gray-700 mb-1">수업 시간 (분)</label>
          <input type="number" id="classDuration" placeholder="60" value="60" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">수업 시작일</label>
          <input type="datetime-local" id="classScheduleStart" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
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
              <button onclick="openEditInstructorModal(\${inst.id}, '\${inst.display_name.replace(/'/g, "\\\\'")}', '\${(inst.user_email || '').replace(/'/g, "\\\\'")}', '\${(inst.user_phone || '').replace(/'/g, "\\\\'")}', '\${(inst.profile_image || '').replace(/'/g, "\\\\'")}')" class="text-blue-500 hover:text-blue-700 text-sm" title="수정">
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
      document.getElementById('newInstructorClassInAccount').value = '';
      document.getElementById('newInstructorImage').value = '';
      document.getElementById('addInstructorModal').classList.remove('hidden');
    }

    function closeAddInstructorModal() {
      document.getElementById('addInstructorModal').classList.add('hidden');
    }

    function openEditInstructorModal(id, name, email, phone, profileImage) {
      document.getElementById('editInstructorId').value = id;
      document.getElementById('editInstructorName').value = name || '';
      document.getElementById('editInstructorEmail').value = email || '';
      document.getElementById('editInstructorPhone').value = phone || '';
      document.getElementById('editInstructorImage').value = profileImage || '';
      document.getElementById('editInstructorModal').classList.remove('hidden');
    }

    function closeEditInstructorModal() {
      document.getElementById('editInstructorModal').classList.add('hidden');
    }

    async function confirmEditInstructor() {
      const id = document.getElementById('editInstructorId').value;
      const name = document.getElementById('editInstructorName').value.trim();
      const email = document.getElementById('editInstructorEmail').value.trim();
      const phone = document.getElementById('editInstructorPhone').value.trim();
      const profileImage = document.getElementById('editInstructorImage').value.trim();

      if (!name || !email) {
        showModal('오류', '이름과 이메일은 필수입니다.');
        return;
      }

      const res = await fetch('/api/admin/instructors/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone, profileImage })
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
      const classInAccount = document.getElementById('newInstructorClassInAccount').value.trim();
      const profileImage = document.getElementById('newInstructorImage').value.trim();

      if (!name || !email) {
        showModal('오류', '이름과 로그인 이메일은 필수입니다.');
        return;
      }

      const res = await fetch('/api/admin/instructors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, classInAccount, profileImage })
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
        showModal('성공', data.message);
        loadInstructors();
      } else {
        showModal('오류', data.error || '삭제 실패');
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

    async function loadClasses() {
      const res = await fetch('/api/admin/classes');
      const data = await res.json();

      const tbody = document.getElementById('classesTable');
      if (!data.classes || data.classes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="px-6 py-8 text-center text-gray-400">클래스가 없습니다.</td></tr>';
        return;
      }

      const now = Date.now();

      tbody.innerHTML = data.classes.map(cls => {
        const hasSession = cls.classin_course_id && cls.classin_class_id;
        const scheduledTime = cls.classin_scheduled_at ? new Date(cls.classin_scheduled_at).getTime() : 0;
        const durationMs = (cls.duration_minutes || 60) * 60 * 1000;
        // classin_scheduled_at이 null이면 종료된 것으로 처리
        const isSessionEnded = hasSession && (!scheduledTime || (scheduledTime + durationMs < now));

        let statusBadge;
        if (isSessionEnded) {
          statusBadge = '<span class="px-1 py-0.5 rounded text-xs bg-orange-100 text-orange-700">종료</span>';
        } else if (hasSession) {
          statusBadge = '<span class="px-1 py-0.5 rounded text-xs bg-green-100 text-green-700">생성</span>';
        } else {
          statusBadge = '<span class="px-1 py-0.5 rounded text-xs bg-gray-100 text-gray-600">-</span>';
        }

        // 수업 생성 버튼 로직: 세션 없거나 종료된 경우 생성 가능
        let createBtn;
        if (!cls.instructor_classin_uid) {
          createBtn = '<span class="text-gray-400 text-xs">-</span>';
        } else if (!hasSession || isSessionEnded) {
          const safeTitle = cls.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
          const safeInstructor = (cls.instructor_name || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
          createBtn = \`<button onclick="openCreateSession(\${cls.id}, '\${safeTitle}', '\${safeInstructor}', '\${cls.schedule_start || ''}')" class="text-blue-500 hover:text-blue-700 text-xs"><i class="fas fa-plus"></i></button>\`;
        } else {
          createBtn = '<span class="text-green-500 text-xs"><i class="fas fa-check"></i></span>';
        }

        const thumbnail = cls.thumbnail || 'https://via.placeholder.com/60x40?text=No+Image';

        return \`
          <tr class="hover:bg-gray-50">
            <td class="px-3 py-2">
              <img src="\${thumbnail}" alt="" class="w-16 h-10 object-cover rounded" onerror="this.src='https://via.placeholder.com/60x40?text=No+Image'">
            </td>
            <td class="px-3 py-2">
              <div class="font-medium text-sm line-clamp-1 max-w-[150px]">\${cls.title}</div>
              <div class="text-xs text-gray-400">\${cls.category_name}</div>
            </td>
            <td class="px-3 py-2 text-sm">\${cls.instructor_name}</td>
            <td class="px-3 py-2 text-sm">\${(cls.price || 0).toLocaleString()}원</td>
            <td class="px-3 py-2 text-xs">
              \${cls.schedule_start ? \`<span class="\${new Date(cls.schedule_start).getTime() < now ? 'text-gray-400' : 'text-blue-600 font-medium'}">\${new Date(cls.schedule_start).toLocaleString('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>\` : '-'}
            </td>
            <td class="px-3 py-2">\${statusBadge}</td>
            <td class="px-3 py-2 text-xs text-gray-500">
              \${cls.classin_scheduled_at ? new Date(cls.classin_scheduled_at).toLocaleString('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '-'}
            </td>
            <td class="px-3 py-2">
              \${hasSession && cls.latest_lesson_id
                ? \`<a href="/api/classin/instructor-enter/\${cls.latest_lesson_id}?redirect=true" target="_blank" class="text-blue-500 hover:text-blue-700 text-xs"><i class="fas fa-sign-in-alt"></i></a>\`
                : '-'}
            </td>
            <td class="px-3 py-2">\${createBtn}</td>
            <td class="px-3 py-2">
              \${cls.lesson_count > 0
                ? \`<button onclick="openLessonHistoryModal(\${cls.id}, '\${cls.title.replace(/'/g, "\\\\'")}')" class="text-purple-500 hover:text-purple-700 text-xs"><i class="fas fa-history"></i> \${cls.lesson_count}</button>\`
                : '<span class="text-gray-400 text-xs">-</span>'}
            </td>
            <td class="px-3 py-2">
              <div class="flex items-center gap-2">
                <button onclick="openEditClass(\${cls.id})" class="text-gray-500 hover:text-blue-500 text-sm"><i class="fas fa-edit"></i></button>
                <button onclick="deleteClass(\${cls.id}, '\${cls.title.replace(/'/g, "\\\\'")}')" class="text-gray-500 hover:text-red-500 text-sm"><i class="fas fa-trash-alt"></i></button>
              </div>
            </td>
          </tr>
        \`;
      }).join('');
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
      document.getElementById('classModalTitle').innerHTML = '<i class="fas fa-book text-blue-500 mr-2"></i>클래스 추가';
      document.getElementById('saveClassBtn').textContent = '추가';

      // Clear form
      document.getElementById('classTitle').value = '';
      document.getElementById('classDescription').value = '';
      document.getElementById('classInstructor').value = '';
      document.getElementById('classCategory').value = '';
      document.getElementById('classPrice').value = '';
      document.getElementById('classDuration').value = '60';
      document.getElementById('classScheduleStart').value = '';
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
        showModal('오류', '클래스를 찾을 수 없습니다.');
        return;
      }

      document.getElementById('editClassId').value = classId;
      document.getElementById('classModalTitle').innerHTML = '<i class="fas fa-edit text-blue-500 mr-2"></i>클래스 수정';
      document.getElementById('saveClassBtn').textContent = '수정';

      // Fill form
      document.getElementById('classTitle').value = cls.title || '';
      document.getElementById('classDescription').value = cls.description || '';
      document.getElementById('classPrice').value = cls.price || '';
      document.getElementById('classDuration').value = cls.duration_minutes || 60;
      document.getElementById('classLevel').value = cls.level || 'all';
      document.getElementById('classThumbnail').value = cls.thumbnail || '';

      if (cls.schedule_start) {
        const d = new Date(cls.schedule_start);
        const formatted = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + 'T' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
        document.getElementById('classScheduleStart').value = formatted;
      } else {
        document.getElementById('classScheduleStart').value = '';
      }

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
      const scheduleStart = document.getElementById('classScheduleStart').value;
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
        scheduleStart: scheduleStart ? new Date(scheduleStart).toISOString() : null,
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
        showModal('성공', classId ? '클래스가 수정되었습니다.' : '클래스가 추가되었습니다.');
        loadClasses();
      } else {
        showModal('오류', data.error || '저장 실패');
      }
    }

    async function deleteClass(classId, classTitle) {
      if (!confirm(classTitle + ' 클래스를 삭제하시겠습니까?')) return;

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

    function openCreateSession(classId, className, instructorName, scheduleStart) {
      selectedClassId = classId;
      document.getElementById('sessionClassName').textContent = className;
      document.getElementById('sessionInstructor').textContent = instructorName;

      // 항상 5분 후 시간으로 설정 (과거 시간 무시)
      const defaultTime = new Date(Date.now() + 5 * 60 * 1000);

      // Format for datetime-local input (로컬 시간 YYYY-MM-DDTHH:MM)
      const year = defaultTime.getFullYear();
      const month = String(defaultTime.getMonth() + 1).padStart(2, '0');
      const day = String(defaultTime.getDate()).padStart(2, '0');
      const hours = String(defaultTime.getHours()).padStart(2, '0');
      const minutes = String(defaultTime.getMinutes()).padStart(2, '0');
      const formatted = year + '-' + month + '-' + day + 'T' + hours + ':' + minutes;

      document.getElementById('sessionScheduledAt').value = formatted;
      document.getElementById('sessionScheduledAt').min = formatted;

      document.getElementById('createSessionModal').classList.remove('hidden');
    }

    function closeSessionModal() {
      document.getElementById('createSessionModal').classList.add('hidden');
      selectedClassId = null;
    }

    async function confirmCreateSession() {
      if (!selectedClassId) return;

      const scheduledAt = document.getElementById('sessionScheduledAt').value;
      if (!scheduledAt) {
        showModal('오류', '수업 시간을 선택해주세요.');
        return;
      }

      // 중복 클릭 방지
      const btn = document.getElementById('createSessionBtn');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>생성중...';

      try {
        const res = await fetch('/api/admin/classes/' + selectedClassId + '/create-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: new Date(scheduledAt).toISOString() })
        });
        const data = await res.json();

        closeSessionModal();

        if (data.success) {
          if (data.alreadyExists) {
            showModal('알림', '이미 생성된 수업이 있습니다.\\n\\n코스 ID: ' + data.courseId + '\\n수업 ID: ' + data.classId);
          } else {
            showModal('성공', 'ClassIn 수업이 생성되었습니다!\\n\\n코스 ID: ' + data.courseId + '\\n수업 ID: ' + data.classId);
          }
          loadClasses();
        } else {
          showModal('오류', data.error || '수업 생성 실패');
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = '생성';
      }
    }

    // Lesson History modal functions
    async function openLessonHistoryModal(classId, className) {
      document.getElementById('lessonHistoryClassName').textContent = className;
      document.getElementById('lessonHistoryContent').innerHTML = '<p class="text-gray-500 text-center py-4">로딩중...</p>';
      document.getElementById('lessonHistoryModal').classList.remove('hidden');

      const res = await fetch('/api/admin/classes/' + classId + '/lessons');
      const data = await res.json();

      if (data.lessons && data.lessons.length > 0) {
        const now = Date.now();
        document.getElementById('lessonHistoryContent').innerHTML = \`
          <div class="space-y-3">
            \${data.lessons.map(lesson => {
              // 수업 종료 시간 계산 (시작시간 + 수업시간)
              const endTime = new Date(lesson.scheduled_at).getTime() + (lesson.duration_minutes || 60) * 60 * 1000;
              const isTimeOver = endTime < now;
              const isEnded = lesson.status === 'ended' || isTimeOver;
              const isLive = lesson.status === 'live' && !isTimeOver;

              return \`
              <div class="p-4 border rounded-xl \${isEnded ? 'bg-gray-50 border-gray-200' : isLive ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-200'}">
                <div class="flex items-center justify-between mb-2">
                  <span class="font-bold text-gray-800">\${lesson.lesson_title}</span>
                  <span class="px-2 py-0.5 text-xs font-bold rounded-full \${isEnded ? 'bg-gray-200 text-gray-600' : isLive ? 'bg-red-500 text-white' : 'bg-blue-500 text-white'}">
                    \${isEnded ? '종료' : isLive ? '진행중' : '예정'}
                  </span>
                </div>
                <div class="text-sm text-gray-600 space-y-1">
                  <p><i class="fas fa-calendar text-gray-400 w-4"></i> \${new Date(lesson.scheduled_at).toLocaleString('ko-KR')}</p>
                  <p><i class="fas fa-clock text-gray-400 w-4"></i> \${lesson.duration_minutes}분</p>
                  <p><i class="fas fa-video text-gray-400 w-4"></i> 수업 ID: \${lesson.classin_class_id || '-'}</p>
                </div>
                <div class="flex gap-2 mt-3">
                  \${isEnded
                    ? \`<span class="flex-1 py-1.5 bg-gray-300 text-gray-600 text-xs font-semibold rounded-lg text-center cursor-default">수업 종료</span>\`
                    : (lesson.id ? \`<a href="/api/classin/instructor-enter/\${lesson.id}?redirect=true" target="_blank" class="flex-1 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg text-center">강사 입장</a>\` : '')}
                  \${lesson.replay_url ? \`<a href="\${lesson.replay_url}" target="_blank" class="flex-1 py-1.5 bg-green-500 hover:bg-green-600 text-white text-xs font-semibold rounded-lg text-center">다시보기</a>\` : ''}
                </div>
              </div>
            \`}).join('')}
          </div>
        \`;
      } else {
        document.getElementById('lessonHistoryContent').innerHTML = '<p class="text-gray-500 text-center py-8">수업 이력이 없습니다.</p>';
      }
    }

    function closeLessonHistoryModal() {
      document.getElementById('lessonHistoryModal').classList.add('hidden');
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
            <input type="text" id="userSearch" placeholder="이름/이메일/전화번호 검색" class="px-3 py-2 border border-gray-200 rounded-lg text-sm w-64" onkeyup="if(event.key==='Enter'){currentPage=0;loadUsers();}">
            <button onclick="currentPage=0;loadUsers()" class="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition-all text-sm">
              <i class="fas fa-search mr-1"></i>검색
            </button>
            <button onclick="document.getElementById('userSearch').value='';currentPage=0;loadUsers()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg transition-all">
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
        const roleLabel = user.role === 'admin' ? '관리자' : user.role === 'instructor' ? '강사' : '학생';
        const roleColor = user.role === 'admin' ? 'bg-red-100 text-red-700' : user.role === 'instructor' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600';
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
              <option value="">전체 클래스</option>
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
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">클래스</th>
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
      select.innerHTML = '<option value="">전체 클래스</option>' +
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

export default app
