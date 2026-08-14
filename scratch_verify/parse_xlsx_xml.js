const fs = require('fs');
const path = require('path');

const xlDir = 'c:/Users/91906/Documents/Barm Amazon/xlsx_extract/xl';

// Read shared strings
const sharedStringsContent = fs.readFileSync(path.join(xlDir, 'sharedStrings.xml'), 'utf8');
const strings = [];
const matches = sharedStringsContent.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g);
for (const match of matches) {
  strings.push(match[1]);
}

function parseSheet(sheetPath) {
  const content = fs.readFileSync(sheetPath, 'utf8');
  const data = {};
  
  // Match <c ...> ... </c> or <c ... />
  // We can match <c followed by space, up to > or />
  const cellRegex = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let cellMatch;
  while ((cellMatch = cellRegex.exec(content)) !== null) {
    const attrsStr = cellMatch[1];
    const inner = cellMatch[2] || '';
    
    const rMatch = attrsStr.match(/r="([A-Z]+)(\d+)"/);
    if (!rMatch) continue;
    const col = rMatch[1];
    const rowNum = parseInt(rMatch[2], 10);
    
    const tMatch = attrsStr.match(/t="([^"]+)"/);
    const type = tMatch ? tMatch[1] : '';
    
    const vMatch = inner.match(/<v>([^<]+)<\/v>/);
    let value = '';
    if (vMatch) {
      const rawVal = vMatch[1];
      if (type === 's') {
        const valIndex = parseInt(rawVal, 10);
        value = strings[valIndex] || '';
      } else {
        value = rawVal;
      }
      
      if (!data[rowNum]) data[rowNum] = {};
      data[rowNum][col] = value;
    }
  }
  return data;
}

const worksheetsDir = path.join(xlDir, 'worksheets');
const files = fs.readdirSync(worksheetsDir).filter(f => f.endsWith('.xml'));

let output = '';
files.forEach(file => {
  const filePath = path.join(worksheetsDir, file);
  try {
    const data = parseSheet(filePath);
    output += `\n=========================================\n`;
    output += `Sheet: ${file}\n`;
    output += `=========================================\n`;
    
    const rows = Object.keys(data).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    rows.slice(0, 15).forEach(rowNum => {
      output += `Row ${rowNum}: ${JSON.stringify(data[rowNum])}\n`;
    });
  } catch (e) {
    output += `Error parsing ${file}: ${e.message}\n`;
  }
});

fs.writeFileSync('sheet_samples.txt', output);
console.log("Wrote samples to sheet_samples.txt");
