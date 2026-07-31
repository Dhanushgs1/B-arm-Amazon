#!/bin/bash

# Generate Historical Analysis Report with 30/7-day windows
echo "🚀 Generating Historical Analysis Report..."
echo ""

curl -X POST http://localhost:3000/api/generate-historical-report \
  -H "Content-Type: application/json" \
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
