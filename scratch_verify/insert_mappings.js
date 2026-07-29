const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '../.env.local' });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
// barm_amazon_campaign_sku_map now lives in the dedicated `barm` schema
// (moved out of `public`), so this client must be scoped to it.
const supabase = createClient(supabaseUrl, supabaseKey, { db: { schema: 'barm' } });

const mappings = [
  { campaign_name: "Chewy Tube - Brand ad", sku: "B-CT-G-8" },
  { campaign_name: "IR Therapy Lamp - Brand AD", sku: "B-IR-LP-200" },
  { campaign_name: "Insemination kit-Brand ads- 7/3/2026 09:29:33.167", sku: "B-INSEM-KIT-PK5-3" },
  { campaign_name: "Mesh Nebulizer 135 - Brand Ad", sku: "BMN132-4" },
  { campaign_name: "Mesh nebulizer - Brand ads (new)", sku: "BMN132" },
  { campaign_name: "Republic Day Sale-SD views b6fd51", sku: "B-INSEM-KIT-PK5-4" },
  { campaign_name: "Video ad for Nascool suction irrigation", sku: "NASCOOL-SUCSYS-5" },
  { campaign_name: "Video ad for Peakflow", sku: "SMPF-01-2" }
];

async function main() {
  try {
    console.log("=== Upserting Mappings into Supabase ===");
    for (const m of mappings) {
      console.log(`Upserting: "${m.campaign_name}" -> "${m.sku}"`);
      const { error } = await supabase
        .from('barm_amazon_campaign_sku_map')
        .upsert(
          { campaign_name: m.campaign_name, sku: m.sku, updated_at: new Date().toISOString() },
          { onConflict: 'campaign_name' }
        );
      if (error) {
        console.error(`Error upserting "${m.campaign_name}":`, error.message);
      } else {
        console.log(`Successfully mapped!`);
      }
    }
  } catch (e) {
    console.error("General error:", e);
  }
}

main();
