const fs = require('fs');
let content = fs.readFileSync('src/index.tsx', 'utf-8');

const oldText = `        \` : \`
        <div class="bg-green-500/10 backdrop-blur-sm rounded-2xl p-4 mb-6 border border-green-500/20">
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-green-500 rounded-full badge-live"></span>
            <p class="text-sm font-semibold text-green-300">수업이 곧 시작됩니다! 아래 버튼을 눌러 입장하세요.</p>
          </div>
        </div>
        \`}`;

const newText = `        \` : session.status === 'ended' ? \`
        <div class="bg-gray-500/10 backdrop-blur-sm rounded-2xl p-4 mb-6 border border-gray-500/20">
          <div class="flex items-center gap-2">
            <span class="w-5 h-5 bg-green-500 rounded-full flex items-center justify-center"><i class="fas fa-check text-white text-[10px]"></i></span>
            <p class="text-sm font-semibold text-gray-300">수업이 완료되었습니다. 아래 버튼을 눌러 다시 보기하세요.</p>
          </div>
        </div>
        \` : \`
        <div class="bg-green-500/10 backdrop-blur-sm rounded-2xl p-4 mb-6 border border-green-500/20">
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-green-500 rounded-full badge-live"></span>
            <p class="text-sm font-semibold text-green-300">수업이 곧 시작됩니다! 아래 버튼을 눌러 입장하세요.</p>
          </div>
        </div>
        \`}`;

if (content.includes(oldText)) {
  content = content.replace(oldText, newText);
  fs.writeFileSync('src/index.tsx', content);
  console.log('Updated status message');
} else {
  console.log('Text not found');
}
