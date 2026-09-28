#!/bin/bash

# Generate Historical Analysis Report with 30/7-day windows
echo "🚀 Generating Historical Analysis Report..."
echo ""

# The route only accepts signed calls: export INTERNAL_API_SECRET (same value as .env.local) first.
: "${INTERNAL_API_SECRET:?INTERNAL_API_SECRET must be set}"
curl -X POST http://localhost:3000/api/generate-historical-report \
  -H "Content-Type: application/json" \
  -H "x-m360-internal: ${INTERNAL_API_SECRET}" \
  -d '{
    "accountId": "default-account",
    "workspaceId": "default-workspace",
    "accountName": "BARM Amazon Account",
    "keySlot": "default",
    "generateWindows": true
  }' \
  -s | jq .

echo ""
echo "✅ Report generation triggered!"
echo "📂 Check your Downloads folder for the Excel file"
echo ""
