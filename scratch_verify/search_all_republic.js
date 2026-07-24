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

function searchSheet(sheetPath, sheetName) {
  const content = fs.readFileSync(sheetPath, 'utf8');
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
    if (vMatch) {
      const rawVal = vMatch[1];
      let value = '';
      if (type === 's') {
        value = strings[parseInt(rawVal, 10)] || '';
      } else {
        value = rawVal;
      }
      
      const valLower = value.toLowerCase();
      if (
        valLower.includes('republic') || 
        valLower.includes('b6fd51') || 
        valLower.includes('nascool') || 
        valLower.includes('peakflow')
      ) {
        console.log(`[${sheetName}] Cell ${col}${rowNum} Match: "${value}"`);
      }
    }
  }
}

const worksheetsDir = path.join(xlDir, 'worksheets');
const files = fs.readdirSync(worksheetsDir).filter(f => f.endsWith('.xml'));

console.log("=== Searching all sheets for Republic, b6fd51, Nascool, Peakflow ===");
files.forEach(file => {
  searchSheet(path.join(worksheetsDir, file), file);
});
