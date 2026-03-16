const fs = require('fs');
let content = fs.readFileSync('src/index.tsx', 'utf-8');

// Update the tabs array
content = content.replace(
  "const tabs = ['enrollments','subscriptions','wishlist','orders'];",
  "const tabs = ['enrollments','completed','subscriptions','orders'];"
);

fs.writeFileSync('src/index.tsx', content);
console.log('Updated tabs array');
