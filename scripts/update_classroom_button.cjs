const fs = require('fs');
let content = fs.readFileSync('src/index.tsx', 'utf-8');

const oldText = `        <!-- Join Button -->
        <a href="\${session.classin_join_url}" target="_blank" rel="noopener" class="w-full h-14 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-2xl transition-all shadow-lg shadow-blue-500/30 flex items-center justify-center gap-3 text-lg mb-3">
          <i class="fas fa-door-open"></i>
          ClassIn 수업방 입장하기
        </a>
        <p class="text-center text-xs text-gray-500">ClassIn 앱 또는 웹 브라우저에서 수업이 열립니다</p>`;

const newText = `        <!-- Join Button -->
        <a href="\${session.classin_join_url}" target="_blank" rel="noopener" class="w-full h-14 \${session.status === 'ended' ? 'bg-green-500 hover:bg-green-600 shadow-green-500/30' : 'bg-blue-500 hover:bg-blue-600 shadow-blue-500/30'} text-white font-bold rounded-2xl transition-all shadow-lg flex items-center justify-center gap-3 text-lg mb-3">
          <i class="fas \${session.status === 'ended' ? 'fa-play-circle' : 'fa-door-open'}"></i>
          \${session.status === 'ended' ? 'ClassIn 수업 다시보기' : 'ClassIn 수업방 입장하기'}
        </a>
        <p class="text-center text-xs text-gray-500">\${session.status === 'ended' ? '녹화된 수업 영상을 다시 볼 수 있습니다' : 'ClassIn 앱 또는 웹 브라우저에서 수업이 열립니다'}</p>`;

if (content.includes(oldText)) {
  content = content.replace(oldText, newText);
  fs.writeFileSync('src/index.tsx', content);
  console.log('Updated classroom join button');
} else {
  console.log('Text not found');
}
