const fs = require('fs');

const content = fs.readFileSync('all_catalog.txt', 'utf8');
const lines = content.split('\n');

console.log("=== Checking for ASIN/SKU ending in B6FD51 ===");
lines.forEach(line => {
  if (line.toUpperCase().includes('B6FD51')) {
    console.log(line);
  }
});
