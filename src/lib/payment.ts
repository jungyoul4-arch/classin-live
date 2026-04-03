// ==================== 헥토파이낸셜 PG Integration Module ====================

export interface HectoConfig {
  MID: string
  LICENSE_KEY: string
  AES_KEY: string
  PAYMENT_SERVER: string
  CANCEL_SERVER: string
}

// PKCS5 패딩 (AES256 암호화용)
function pkcs5Pad(data: Uint8Array, blockSize: number = 16): Uint8Array {
  const padding = blockSize - (data.length % blockSize)
  const result = new Uint8Array(data.length + padding)
  result.set(data)
  result.fill(padding, data.length)
  return result
}

// PKCS5 언패딩 (AES256 복호화용)
function pkcs5Unpad(data: Uint8Array): Uint8Array {
  const padding = data[data.length - 1]
  if (padding > 16 || padding === 0) return data
  return data.slice(0, data.length - padding)
}

// AES-256-ECB 암호화 (Web Crypto API 사용)
export async function aes256Encrypt(plainText: string, keyString: string): Promise<string> {
  if (!plainText) return ''

  const encoder = new TextEncoder()
  const keyData = encoder.encode(keyString)
  const plainData = encoder.encode(plainText)

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  )

  const iv = new Uint8Array(16)

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    key,
    plainData
  )

  const encryptedArray = new Uint8Array(encrypted).slice(0, 16)
  return btoa(String.fromCharCode(...encryptedArray))
}

// AES-256-ECB 복호화 (Web Crypto API 사용)
export async function aes256Decrypt(cipherText: string, keyString: string): Promise<string> {
  if (!cipherText) return ''

  const encoder = new TextEncoder()
  const keyData = encoder.encode(keyString)

  const cipherData = Uint8Array.from(atob(cipherText), c => c.charCodeAt(0))

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  )

  const iv = new Uint8Array(16)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    key,
    cipherData
  )

  const decryptedArray = pkcs5Unpad(new Uint8Array(decrypted))
  return new TextDecoder().decode(decryptedArray)
}

// SHA256 해시 생성
export async function sha256Hash(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const dataBuffer = encoder.encode(data)
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// 헥토 결제 요청 파라미터 암호화
export async function encryptHectoPaymentParams(
  config: HectoConfig,
  params: {
    mchtId: string
    method: string
    mchtTrdNo: string
    trdDt: string
    trdTm: string
    trdAmt: string
    mchtCustNm?: string
    cphoneNo?: string
    email?: string
    mchtCustId?: string
  }
): Promise<{ encParams: Record<string, string>; pktHash: string; hashDebug: string }> {
  const hashPlain = params.mchtId + params.method + params.mchtTrdNo + params.trdDt + params.trdTm + params.trdAmt + config.LICENSE_KEY
  const pktHash = await sha256Hash(hashPlain)
  const hashDebug = 'Plain: ' + hashPlain + ' | Hash: ' + pktHash

  const encParams: Record<string, string> = {}

  encParams.trdAmt = await aes256Encrypt(params.trdAmt, config.AES_KEY)

  if (params.mchtCustNm) encParams.mchtCustNm = await aes256Encrypt(params.mchtCustNm, config.AES_KEY)
  if (params.cphoneNo) encParams.cphoneNo = await aes256Encrypt(params.cphoneNo, config.AES_KEY)
  if (params.email) encParams.email = await aes256Encrypt(params.email, config.AES_KEY)
  if (params.mchtCustId) encParams.mchtCustId = await aes256Encrypt(params.mchtCustId, config.AES_KEY)

  return { encParams, pktHash, hashDebug }
}

// 헥토 결제 결과 복호화
export async function decryptHectoResultParams(
  config: HectoConfig,
  params: Record<string, string>
): Promise<Record<string, string>> {
  const decryptFields = ['mchtCustId', 'trdAmt', 'pointTrdAmt', 'cardTrdAmt', 'vtlAcntNo', 'cphoneNo', 'csrcAmt']
  const result: Record<string, string> = { ...params }

  for (const field of decryptFields) {
    if (params[field]) {
      try {
        result[field] = await aes256Decrypt(params[field], config.AES_KEY)
      } catch (e) {
        console.log(`Failed to decrypt ${field}:`, e)
      }
    }
  }

  return result
}

// 헥토 노티 해시 검증
export async function verifyHectoNotiHash(
  config: HectoConfig,
  params: {
    outStatCd: string
    trdDtm: string
    mchtId: string
    mchtTrdNo: string
    trdAmt: string
    pktHash: string
  }
): Promise<boolean> {
  const hashPlain = params.outStatCd + params.trdDtm + params.mchtId + params.mchtTrdNo + params.trdAmt + config.LICENSE_KEY
  const calculatedHash = await sha256Hash(hashPlain)
  return calculatedHash === params.pktHash
}

// 헥토 결제 취소 API 호출
export async function cancelHectoPayment(
  config: HectoConfig,
  params: {
    mchtTrdNo: string
    orgTrdNo: string
    cnclAmt: string
    cnclRsn?: string
    method?: string
  }
): Promise<{ success: boolean; outStatCd?: string; outRsltCd?: string; outRsltMsg?: string; error?: string }> {
  const now = new Date()
  const trdDt = now.toISOString().slice(0, 10).replace(/-/g, '')
  const trdTm = now.toTimeString().slice(0, 8).replace(/:/g, '')

  const hashPlain = trdDt + trdTm + config.MID + params.mchtTrdNo + params.cnclAmt + config.LICENSE_KEY
  const pktHash = await sha256Hash(hashPlain)

  const encCnclAmt = await aes256Encrypt(params.cnclAmt, config.AES_KEY)

  const reqBody = {
    params: {
      mchtId: config.MID,
      ver: '0A19',
      method: params.method || 'CA',
      bizType: 'C0',
      encCd: '23',
      mchtTrdNo: params.mchtTrdNo,
      trdDt,
      trdTm,
      mobileYn: 'N',
      osType: 'W'
    },
    data: {
      pktHash,
      orgTrdNo: params.orgTrdNo,
      cnclAmt: encCnclAmt,
      crcCd: 'KRW',
      cnclOrd: '001',
      cnclRsn: params.cnclRsn || '고객요청'
    }
  }

  try {
    const response = await fetch(`${config.CANCEL_SERVER}/spay/APICancel.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    })

    const result = await response.json() as any
    const resParams = result.params || {}

    if (resParams.outStatCd === '0021') {
      return { success: true, ...resParams }
    }
    return { success: false, ...resParams, error: resParams.outRsltMsg || 'Cancel failed' }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}
