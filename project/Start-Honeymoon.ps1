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
    if (!$importRequired) {
        $world = Get-Content -Raw -LiteralPath $worldPath | ConvertFrom-Json
        $importRequired = $world.bounds.minX -ne -128 -or
            ($TerrainRadius -gt 8 -and $world.visualRadius -ne 10) -or
            ($TerrainRadius -and $TerrainRadius -notin $world.terrain.radius)
    }
    if ($importRequired) {
        & $nodePath import/anvil.mjs --radius 8 --terrain-radius "$TerrainRadius"
        if ($LASTEXITCODE) { throw 'World import failed.' }
    }
    $atlasMetadata = 'generated\textures\atlas.json'
    $atlasVersion = if (Test-Path -LiteralPath $atlasMetadata) {
        (Get-Content -Raw -LiteralPath $atlasMetadata | ConvertFrom-Json).schemaVersion
    }
    if ($atlasVersion -ne 11 -or !(Test-Path -LiteralPath 'generated\textures\atlas.png')) {
        & $pythonPath -B world/textures.py
        if ($LASTEXITCODE) { throw 'Texture extraction failed. Install Pillow from world/requirements.txt.' }
    }
    $modelInputs = @{
        biblio = @{ Script = 'world/biblio-extract.py'; Source = '../sources/Honeymoon/mods/BiblioCraft.zip' }
        jammy = @{ Script = 'world/jammy-models.py'; Source = '../sources/Honeymoon/minecraft.jar' }
        redpower = @{ Script = 'world/redpower-lamps.py'; Source = '../sources/Honeymoon/mods/RedPowerDigital-2.0pr6.zip' }
    }
    foreach ($family in $modelInputs.Keys) {
        $modelJson = "generated/models/$family.json"
        $current = Test-Path -LiteralPath $modelJson
        if ($current -and $family -eq 'jammy') {
            $current = (Get-Content -Raw -LiteralPath $modelJson | ConvertFrom-Json).schemaVersion -eq 4
        }
        if ($current -and $family -eq 'biblio') {
            $current = (Get-Content -Raw -LiteralPath $modelJson | ConvertFrom-Json).schemaVersion -eq 2
        }
        if ((Test-Path -LiteralPath $modelInputs[$family].Source) -and
            (!$current -or !(Test-Path -LiteralPath "generated/models/$family.png"))) {
            & $pythonPath -B $modelInputs[$family].Script
            if ($LASTEXITCODE) { throw "Model extraction failed for $family." }
        }
    }
    $soundManifest = 'generated/sounds/sounds.json'
    $soundVersion = if (Test-Path -LiteralPath $soundManifest) {
        (Get-Content -Raw -LiteralPath $soundManifest | ConvertFrom-Json).version
    }
    if ($soundVersion -lt 3 -and (Test-Path -LiteralPath '../sources/Honeymoon/resources')) {
        & $pythonPath -B world/sounds.py
        if ($LASTEXITCODE) { throw 'Sound extraction failed.' }
    }
    & $nodePath server/index.mjs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
