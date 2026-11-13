param(
    [ValidateSet(0, 8, 16, 32)] [int] $TerrainRadius = 32
)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    $runtime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $python = Get-Command python -ErrorAction SilentlyContinue
    $pythonPath = if ($python -and (Get-Item -LiteralPath $python.Source).Length -gt 0) {
        $python.Source
    } else {
        Join-Path $runtime 'python\python.exe'
    }
    if (!(Test-Path -LiteralPath $pythonPath)) { throw 'Install Python 3.10+ and Pillow from world/requirements.txt.' }
    New-Item -ItemType Directory -Path work -Force | Out-Null
    $env:TEMP = Join-Path $PSScriptRoot 'work'
    $env:TMP = $env:TEMP
    $env:npm_config_cache = Join-Path $env:TEMP 'npm-cache'
    if (!(Test-Path -LiteralPath 'node_modules\three\build\three.module.js')) {
        $npm = Get-Command npm -ErrorAction SilentlyContinue
        if ($npm) {
            & $npm.Source ci
        } elseif (Test-Path -LiteralPath 'work\npm\bin\npm-cli.js') {
            & $nodePath 'work\npm\bin\npm-cli.js' ci
        } else {
            throw 'Install Node.js with npm and run npm ci.'
        }
        if ($LASTEXITCODE) { throw 'npm ci failed.' }
    }
    $worldPath = 'generated\world\world.json'
    $importRequired = !(Test-Path -LiteralPath $worldPath)
    if (!$importRequired -and $TerrainRadius) {
        $world = Get-Content -Raw -LiteralPath $worldPath | ConvertFrom-Json
        $importRequired = $TerrainRadius -notin $world.terrain.radius
    }
    if ($importRequired) {
        & $nodePath import/anvil.mjs --terrain-radius $TerrainRadius
        if ($LASTEXITCODE) { throw 'World import failed.' }
    }
    if (!(Test-Path -LiteralPath 'generated\textures\atlas.png')) {
        & $pythonPath -B world/textures.py
        if ($LASTEXITCODE) { throw 'Texture extraction failed. Install Pillow from world/requirements.txt.' }
    }
    & $nodePath server/index.mjs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
