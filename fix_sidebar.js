const fs = require('fs');
const path = 'src/components/flipkart/App.jsx';
let c = fs.readFileSync(path, 'utf8');
c = c.replace(/hidden md:flex flex-col fixed/g, 'hidden flex-col fixed !hidden');
c = c.replace(/sidebarCollapsed \? 'md:ml-16' : 'md:ml-64'/g, '""');
fs.writeFileSync(path, c);
console.log('Sidebar fixed');
