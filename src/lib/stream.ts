// ==================== Cloudflare Stream API Module ====================

export interface StreamConfig {
  accountId: string
  apiToken: string
  signingKeyId?: string
  signingKeyJwk?: string
}

// Cloudflare Stream: Direct Creator Upload URL 발급
export async function getStreamUploadUrl(
  config: StreamConfig,
  options?: { maxDurationSeconds?: number; requireSignedURLs?: boolean; allowedOrigins?: string[] }
): Promise<{ uploadURL?: string; uid?: string; error?: string }> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/direct_upload`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          maxDurationSeconds: options?.maxDurationSeconds || 3600,
          requireSignedURLs: options?.requireSignedURLs ?? false
        })
      }
    )

    const data = await response.json() as any
    console.log('Stream direct_upload response:', JSON.stringify(data))

    if (data.success && data.result) {
      return {
        uploadURL: data.result.uploadURL,
        uid: data.result.uid
      }
    }
    return { error: data.errors?.[0]?.message || 'Failed to get upload URL' }
  } catch (e: any) {
    return { error: e.message || 'Network error' }
  }
}

// Cloudflare Stream: 비디오 정보 조회
export async function getStreamVideoInfo(
  config: StreamConfig,
  videoUid: string
): Promise<{ duration?: number; thumbnail?: string; playback?: { hls?: string; dash?: string }; status?: string; error?: string }> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${videoUid}`,
      {
        headers: {
          'Authorization': `Bearer ${config.apiToken}`
        }
      }
    )

    const data = await response.json() as any
    console.log('Stream video info response:', JSON.stringify(data))

    if (data.success && data.result) {
      const video = data.result
      return {
        duration: video.duration,
        thumbnail: video.thumbnail,
        playback: video.playback,
        status: video.status?.state
      }
    }
    return { error: data.errors?.[0]?.message || 'Failed to get video info' }
  } catch (e: any) {
    return { error: e.message || 'Network error' }
  }
}

// Cloudflare Stream: 비디오 설정 업데이트 (서명 요구 끄기 등)
export async function updateStreamVideoSettings(
  config: StreamConfig,
  videoUid: string,
  settings: { requireSignedURLs?: boolean }
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${videoUid}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(settings)
      }
    )

    const data = await response.json() as any
    console.log('Stream update response:', JSON.stringify(data))

    if (data.success) {
      return { success: true }
    }
    return { success: false, error: data.errors?.[0]?.message || 'Failed to update video' }
  } catch (e: any) {
    return { success: false, error: e.message || 'Network error' }
  }
}

// Cloudflare Stream: 서명된 토큰 생성 (JWT)
export async function generateStreamSignedToken(
  videoUid: string,
  signingKeyId: string,
  signingKeyJwk: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  const jwk = JSON.parse(signingKeyJwk)
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const header = {
    alg: 'RS256',
    kid: signingKeyId
  }

  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: videoUid,
    kid: signingKeyId,
    exp: now + expiresInSeconds,
    accessRules: [
      { type: 'video', id: videoUid, action: 'allow' }
    ]
  }

  const base64UrlEncode = (obj: any) => {
    const json = JSON.stringify(obj)
    const base64 = btoa(json)
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  const headerB64 = base64UrlEncode(header)
  const payloadB64 = base64UrlEncode(payload)
  const message = `${headerB64}.${payloadB64}`

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(message)
  )

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return `${message}.${signatureB64}`
}

// Cloudflare Stream: 서명된 재생 URL 생성
export async function getSignedStreamUrl(
  config: StreamConfig,
  videoUid: string,
  expiresInSeconds: number = 3600
): Promise<{ hlsUrl?: string; error?: string }> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${videoUid}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.apiToken}`
        }
      }
    )
    const data = await response.json() as any

    if (!data.success || !data.result?.playback?.hls) {
      return { error: 'Failed to get video playback URL' }
    }

    const baseHlsUrl = data.result.playback.hls

    if (!config.signingKeyId || !config.signingKeyJwk) {
      return { hlsUrl: baseHlsUrl }
    }

    const token = await generateStreamSignedToken(
      videoUid,
      config.signingKeyId,
      config.signingKeyJwk,
      expiresInSeconds
    )
    return { hlsUrl: `${baseHlsUrl}?token=${token}` }
  } catch (e: any) {
    return { error: e.message || 'Failed to get signed URL' }
  }
}
