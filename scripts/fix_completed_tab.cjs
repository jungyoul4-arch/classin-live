const fs = require('fs');
let content = fs.readFileSync('src/index.tsx', 'utf-8');

// The problem is that ${activeTab should be \${activeTab in the completed button
// But only for the completed tab line, not the others

const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("loadMyPageTab('completed')") && lines[i].includes('${activeTab')) {
    // Replace ${activeTab with \${activeTab
    lines[i] = lines[i].replace(/\$\{activeTab==='/g, '\\${activeTab===');
    console.log('Fixed line', i + 1);
  }
}

content = lines.join('\n');
fs.writeFileSync('src/index.tsx', content);
console.log('Done');
