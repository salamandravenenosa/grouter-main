Set-Location -LiteralPath $PSScriptRoot

if ($args.Count -eq 0) {
  bun index.ts serve on
} else {
  bun index.ts @args
}
