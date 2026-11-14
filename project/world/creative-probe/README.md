# Реестр блоков для креатива

`world/creative-catalog.json` содержит каталог блоков из Minecraft 1.4.7 и
Forge 6.6.2.534 с установленными модами Honeymoon. `creative-registry.mjs`
строит каталог из реестра запущенного клиента и сверяет номера блоков с
палитрой карты. Локальная версия `generated/creative/catalog.json` хранит
также исходные грани, текстуры и размеры для проверки конвертации.

Для обновления реестра понадобится отдельная рабочая копия оригинального
клиента и JDK 8. Выключите звук и музыку, уберите OpenAL DLL из копии.
Из каталога `project` соберите диагностический агент в рабочую папку.

```powershell
$jdk = 'D:/path/to/jdk8'
$capture = New-Item -ItemType Directory -Force work/creative-registry
$classes = New-Item -ItemType Directory -Force (Join-Path $capture.FullName 'classes')
& "$jdk/bin/javac.exe" -encoding UTF-8 -d $classes.FullName world/creative-probe/CreativeRegistryProbe.java
& "$jdk/bin/jar.exe" cfm "$($capture.FullName)/CreativeRegistryProbe.jar" world/creative-probe/MANIFEST.MF -C $classes.FullName .
```

Добавьте в параметры JVM клиента этот аргумент, подставив полный путь к
рабочей папке. После загрузки модов агент сохранит TSV с реестром и TSV
с вариантами предметов, затем закроет клиент. Открывать сохранение не нужно.

```text
-javaagent:D:/Honeymoon-transfer/project/work/creative-registry/CreativeRegistryProbe.jar=D:/Honeymoon-transfer/project/work/creative-registry/registry-full.tsv
```

Для англоязычного поиска можно извлечь `lang/en_US.lang` из чистого JAR
Minecraft Java 1.4.7 в `work/creative-registry/english.lang`. В клиенте
Honeymoon этот язык содержит русские переводы. Затем обновите каталог.

```powershell
node world/creative-registry.mjs --compact world/creative-catalog.json
```

Реестр Forge содержит 711 заполненных слотов, из которых 160 заняты
служебными заглушками реестра предметов. Остаётся 551 действительный ID
блока. Каталог сохраняет творческие варианты и технические состояния с
карты, а также отличимые по исходным данным состояния граней и окраски.
Для составных блоков RedPower агент записывает значения `CoverLib` и
проверяет, какие сочетания материалов и форм объявлены модом.
