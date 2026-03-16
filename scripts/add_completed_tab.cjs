const fs = require('fs');
let content = fs.readFileSync('src/index.tsx', 'utf-8');

const oldText = `      \\\`}).join('');
  } else if (tab === 'subscriptions') {
    const res = await fetch('/api/user/'+currentUser.id+'/subscriptions');`;

const newText = `      \\\`}).join('');
  } else if (tab === 'completed') {
    const res = await fetch('/api/user/'+currentUser.id+'/enrollments');
    const items = await res.json();
    const sessRes = await fetch('/api/user/'+currentUser.id+'/classin-sessions');
    const sessions = await sessRes.json();
    const sessionMap = {};
    if (Array.isArray(sessions)) sessions.forEach(s => { sessionMap[s.class_id] = s; });

    const completedItems = items.filter(e => {
      const session = sessionMap[e.class_id];
      return session && session.status === 'ended';
    });

    container.innerHTML = completedItems.length === 0 ? '<div class="text-center py-8 text-gray-400"><i class="fas fa-check-circle text-3xl mb-2"></i><p>수강 완료된 클래스가 없습니다</p></div>'
      : completedItems.map(e => {
        const session = sessionMap[e.class_id];
        return \\\`
        <div class="p-3 rounded-xl hover:bg-gray-50 transition-all mb-2 border border-gray-100">
          <a href="/class/\\\${e.slug}" class="flex gap-3">
            <div class="relative flex-shrink-0">
              <img src="\\\${e.thumbnail}" class="w-20 h-14 rounded-lg object-cover">
              <span class="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center"><i class="fas fa-check text-white text-[8px]"></i></span>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-dark-800 line-clamp-1">\\\${e.title}</p>
              <p class="text-xs text-gray-500">\\\${e.instructor_name}</p>
              <div class="w-full bg-green-200 rounded-full h-1.5 mt-2"><div class="bg-green-500 h-1.5 rounded-full" style="width:100%"></div></div>
            </div>
          </a>
          <div class="mt-2 pt-2 border-t border-gray-50">
            <div class="flex items-center gap-2 mb-2">
              <span class="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded">수업 완료</span>
              <span class="text-[11px] text-gray-400">\\\${session.scheduled_at ? new Date(session.scheduled_at).toLocaleDateString('ko-KR', {month:'short', day:'numeric'}) : ''}</span>
            </div>
            <div class="flex gap-2">
              <a href="\\\${session.classin_join_url}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex-1 h-8 bg-green-500 hover:bg-green-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all">
                <i class="fas fa-play-circle"></i> 다시 보기
              </a>
              <a href="/classroom/\\\${session.id}" onclick="event.stopPropagation()" class="h-8 px-3 border border-gray-200 text-dark-600 text-xs font-medium rounded-lg flex items-center justify-center gap-1 hover:bg-gray-50 transition-all">
                <i class="fas fa-info-circle"></i> 상세
              </a>
            </div>
          </div>
        </div>
      \\\`}).join('');
  } else if (tab === 'subscriptions') {
    const res = await fetch('/api/user/'+currentUser.id+'/subscriptions');`;

if (content.includes(oldText)) {
  content = content.replace(oldText, newText);
  fs.writeFileSync('src/index.tsx', content);
  console.log('Added completed tab handler');
} else {
  console.log('Old text not found. Trying alternative search...');
  // Try to find the pattern with regex
  const pattern = /\`\}\)\.join\(''\);\s*\} else if \(tab === 'subscriptions'\) \{\s*const res = await fetch\('\/api\/user\/'\+currentUser\.id\+'\/subscriptions'\);/;
  if (pattern.test(content)) {
    console.log('Found with regex');
  } else {
    console.log('Pattern not found');
  }
}
