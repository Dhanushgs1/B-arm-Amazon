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

function parseSheet13(sheetPath) {
  const content = fs.readFileSync(sheetPath, 'utf8');
  const cellRegex = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const data = {};
  
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

const targetCampaigns = [
  'Chewy Tube - Brand ad',
  'IR Therapy Lamp - Brand AD',
  'Insemination kit-Brand ads- 7/3/2026 09:29:33.167',
  'Mesh Nebulizer 135 - Brand Ad',
  'Mesh nebulizer - Brand ads (new)',
  'Republic Day Sale-SD views b6fd51',
  'Video ad for Nascool suction irrigation',
  'Video ad for Peakflow'
];

try {
  const filePath = path.join(xlDir, 'worksheets', 'sheet13.xml');
  const sheetData = parseSheet13(filePath);
  
  console.log("=== Matching Campaign Mappings from Spreadsheet (Sheet 13) ===");
  
  const campaignToSkus = {};
  Object.keys(sheetData).forEach(rowNum => {
    const row = sheetData[rowNum];
    // Column E is Campaign Name
    // Column G is Advertised SKU
    // Column I is Advertised ASIN
    const campaignName = row['E'];
    const advertisedSku = row['G'];
    const advertisedAsin = row['I'];
    
    if (campaignName) {
      const isTarget = targetCampaigns.some(tc => campaignName.toLowerCase().trim() === tc.toLowerCase().trim());
      if (isTarget) {
        if (!campaignToSkus[campaignName]) {
          campaignToSkus[campaignName] = new Set();
        }
        if (advertisedSku) campaignToSkus[campaignName].add(advertisedSku);
      }
    }
  });

  for (const [camp, skus] of Object.entries(campaignToSkus)) {
    console.log(`Campaign: "${camp}" -> SKUs:`, [...skus]);
  }
  
  // Let's also do a partial search in case some names are slightly different
  console.log("\n=== Partial Search for Target Keywords ===");
  const keywords = ['chewy', 'ir', 'insem', 'nebulizer', 'republic', 'nascool', 'peakflow'];
  const partialMap = {};
  
  Object.keys(sheetData).forEach(rowNum => {
    const row = sheetData[rowNum];
    const campaignName = row['E'];
    const advertisedSku = row['G'];
    
    if (campaignName && advertisedSku) {
      const match = keywords.some(k => campaignName.toLowerCase().includes(k));
      if (match) {
        if (!partialMap[campaignName]) {
          partialMap[campaignName] = new Set();
        }
        partialMap[campaignName].add(advertisedSku);
      }
    }
  });

  for (const [camp, skus] of Object.entries(partialMap)) {
    console.log(`Campaign: "${camp}" -> SKUs:`, [...skus]);
  }

} catch (e) {
  console.error("Error:", e);
}
