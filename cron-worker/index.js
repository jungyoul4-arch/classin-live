// Cloudflare Cron Worker for ClassIn Virtual Account Auto-Return
// 만료된 수강권의 가상 계정 자동 반납

export default {
  // Cron Trigger 핸들러
  async scheduled(event, env, ctx) {
    console.log('Cron triggered at:', new Date().toISOString());

    try {
      const response = await fetch(`${env.API_BASE_URL}/api/admin/enrollments/process-expired`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          adminKey: env.ADMIN_KEY
        })
      });

      const result = await response.json();
      console.log('Process expired result:', result);

      return result;
    } catch (error) {
      console.error('Cron job failed:', error);
      throw error;
    }
  },

  // 수동 테스트용 HTTP 핸들러
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      // 수동 실행
      const result = await this.scheduled({}, env, ctx);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      status: 'ok',
      message: 'ClassIn Cron Worker',
      endpoints: {
        '/run': 'Manually trigger the cron job'
      },
      schedule: 'Daily at 00:00 UTC (09:00 KST)'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
