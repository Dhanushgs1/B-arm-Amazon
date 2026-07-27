import { NextRequest, NextResponse } from 'next/server';
import { exportHistoricalAnalysisReport } from '@/lib/historicalAnalysisReportExport';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId, workspaceId, accountName, keySlot, endDate } = body;

    if (!keySlot) {
      return NextResponse.json(
        { error: 'Missing keySlot parameter' },
        { status: 400 }
      );
    }

    // Generate the report
    const result = await exportHistoricalAnalysisReport({
      account: {
        id: accountId,
        workspace_id: workspaceId,
        name: accountName || 'Marketplace360 Account',
      },
      keySlot,
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
