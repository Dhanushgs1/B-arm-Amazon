import { NextRequest, NextResponse } from 'next/server';
import { exportHistoricalAnalysisReport } from '@/lib/historicalAnalysisReportExport';
import { checkInternal } from '@/lib/apiAuth';
import { rejectUnlessAllowed } from '@/lib/appRouteAuth';

export async function POST(request: NextRequest) {
  // Heavy build that writes a file on the server; its only caller is generate-report-now.sh, so
  // it takes signed server/script calls only (x-m360-internal: $INTERNAL_API_SECRET).
  const rejected = rejectUnlessAllowed(request, checkInternal);
  if (rejected) return rejected;
  try {
    const body = await request.json();
    const { accountId, workspaceId, accountName, startDate, endDate } = body;

    // keySlot is no longer required: this report is built entirely from the
    // uploaded Supabase tables, so it needs no SellerMate API key. Callers may
    // still send one — it is simply ignored rather than rejected.

    if (startDate && endDate && startDate > endDate) {
      return NextResponse.json(
        { error: `startDate (${startDate}) is after endDate (${endDate})` },
        { status: 400 }
      );
    }

    // Generate the report — endDate only, the report is a fixed trailing 30/7-day
    // window ending there (see the function's own signature); startDate is validated
    // above but not passed through, since the function has no use for it.
    const result = await exportHistoricalAnalysisReport({
      account: {
        id: accountId,
        workspace_id: workspaceId,
        name: accountName || 'Marketplace360 Account',
      },
      endDate: endDate || new Date().toISOString().split('T')[0],
    });

    return NextResponse.json({
      success: true,
      filename: result.filename,
      skuCount: result.skuCount,
      unmappedCampaignSpend: result.unmappedCampaignSpend,
      message: `✅ Report generated successfully! File: ${result.filename}`,
    });
  } catch (error) {
    console.error('Error generating historical report:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
