# Run AFTER closing Claude session 823d48ce-4ce0-45a1-87a1-ead2f1a2fca9 (the file is written to while the session is open).
# Replaces the Shopify webhook signing key that Shopify admin displayed ("... signed with <64 hex chars>")
# with a placeholder. Matches by pattern, so the key itself is not in this script.
$f = "$env:USERPROFILE\.claude\projects\C--Users-B-ARM-Downloads-Marketplace360-20260818T041003Z-1-001\823d48ce-4ce0-45a1-87a1-ead2f1a2fca9.jsonl"
$pattern = 'signed with [0-9a-f]{64}'
$text = [System.IO.File]::ReadAllText($f)
$before = ([regex]::Matches($text, $pattern)).Count
$text = [regex]::Replace($text, $pattern, 'signed with [REDACTED-SHOPIFY-SIGNING-KEY]')
[System.IO.File]::WriteAllText($f, $text, (New-Object System.Text.UTF8Encoding($false)))
$after = ([regex]::Matches([System.IO.File]::ReadAllText($f), $pattern)).Count
"redacted $before occurrence(s); remaining: $after"
