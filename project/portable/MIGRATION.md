# Перенос сервера Lilium Moonlight на другой Windows-ПК

Установщик скачивает проверенную сборку Windows x64 с картой и Node.js, затем накладывает клиент и сервер из выбранного коммита. Сохранение переносится отдельной папкой. В ней находятся база игроков и мира, ключ владельца, журналы и резервные копии из `state/backups`. Передавайте её через доверенный носитель или закрытое хранилище.

## Подготовка нового ПК

Зарегистрируйте новый ПК в том же tailnet под временным именем. Подготовьте папку игры до остановки старого сервера. Скачивание займёт около 3,4 ГБ. Установщику понадобятся примерно 13 ГиБ свободного места для загрузки и распаковки на одном диске. [Имена устройств Tailscale](https://tailscale.com/docs/concepts/machine-names)

Из PowerShell скачайте установщик и используйте тот же коммит для установки. Папка назначения должна быть новой. Если рабочий стол перенаправлен в OneDrive, выберите локальную папку, например в `%LOCALAPPDATA%`.

```powershell
$repo = 'MoondancerDW/Honeymoon'
$revision = (Invoke-RestMethod "https://api.github.com/repos/$repo/commits/main").sha
$installer = Join-Path $env:TEMP 'Install-Honeymoon.ps1'
$newGame = Join-Path ([Environment]::GetFolderPath('Desktop')) 'hnm'
Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$repo/$revision/project/portable/Install-Honeymoon.ps1" -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Revision $revision -Destination $newGame
```

## Снимок со старого ПК

Остановите сервер штатно и дождитесь закрытия консоли. Снимок нужно создать после последней игры, чтобы в него попали последние изменения и новые приглашения. Версию скрипта для переноса можно взять из подготовленной новой установки или из того же коммита.

```powershell
$oldGame = Join-Path ([Environment]::GetFolderPath('Desktop')) 'hnm'
$snapshot = Join-Path ([Environment]::GetFolderPath('Desktop')) ('Lilium-Moonlight-transfer-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$repo = 'MoondancerDW/Honeymoon'
$revision = (Invoke-RestMethod "https://api.github.com/repos/$repo/commits/main").sha
$transfer = Join-Path $env:TEMP 'Transfer-Honeymoon.mjs'
Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$repo/$revision/project/portable/Transfer-Honeymoon.mjs" -OutFile $transfer
& (Join-Path $oldGame 'runtime\node.exe') $transfer export $oldGame $snapshot
```

Скопируйте получившуюся папку на новый ПК. Импортируйте её до первого запуска игры. Скрипт проверит целостность базы, контрольные суммы и соответствие карты. Существующая папка `state` блокирует импорт, чтобы защитить уже начатую игру.

```powershell
$snapshot = 'C:\Transfer\Lilium-Moonlight-transfer'
& (Join-Path $newGame 'runtime\node.exe') (Join-Path $newGame 'Transfer-Honeymoon.mjs') import $newGame $snapshot
```

## Сохранение публичного адреса

Для сохранения входа в прежних браузерах и всех действующих ссылок нужны перенесённая база и точный прежний URL с `https`, тем же DNS-именем и портом 443.

1. В панели Tailscale переименуйте старый ПК, чтобы освободить прежнее имя сервера. При необходимости сохраните старый ПК в tailnet под другим именем. Если сторонний сервис использует прежнее DNS-имя, согласуйте перенос имени до этого шага.
2. Присвойте новому ПК точное старое имя. Отключите автогенерацию имени, если она включена. Проверьте полное имя в `tailscale status --json`, поле `Self.DNSName`.
3. На новом ПК запустите `Start-Internet.cmd` и оставьте консоль открытой. Проверьте адрес из сети без Tailscale. При временной ошибке TLS дайте публичному Funnel до 10 минут на восстановление.
4. Проверьте вход игрока в уже зарегистрированном браузере и вход по отдельному тестовому приглашению. Старые ссылки сохраняют прежний статус и срок действия. Для входа владельца с нового браузера используйте локальный адрес из консоли и перенесённый `state/npc-admin.key`.

Ключи и состояние самого Tailscale между ПК переносить не требуется. Для переименования узлов и подключения к tailnet нужен доступ владельца сети. [Имена устройств](https://tailscale.com/docs/concepts/machine-names) · [Публичный Funnel](https://tailscale.com/docs/features/tailscale-funnel)

На время переезда текущие подключения прервутся. До проверки сохраните старую установку. При откате после игры на новом сервере сделайте новый снимок с него, чтобы сохранить эти правки.
