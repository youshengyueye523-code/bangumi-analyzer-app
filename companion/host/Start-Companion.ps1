param([string]$PackageRoot)
$ErrorActionPreference = 'Stop'
$node = Join-Path $PSScriptRoot '../../.runtime/node-v24.22.1-win-x64/node.exe'
$script = Join-Path $PSScriptRoot 'scripts/run.mjs'
if (-not (Test-Path -LiteralPath $node)) { throw 'Trusted Node 24 maintainer runtime not found. See README for alternative launch.' }
if ($PackageRoot) { & $node $script $PackageRoot } else { & $node $script }
exit $LASTEXITCODE
