# Запись звуковых свойств Minecraft 1.4.7

`world/sounds.py` копирует Ogg из оригинальных ресурсов и активного пакета
Audiotori в локальный `generated/sounds/`. Файлы сопоставляются по SHA-256.
Имена и пути исходников сохранены в `sounds.json`. Стандартные ресурсы
заполняют отсутствующие события, звуки блоков Chisel берутся из архива мода.
Звуки старых дисков в формате MUS заменяются соответствующими Ogg из
установленного пакета Audiotori.

`block-sound-types.json` содержит звуки шагов и установки, громкость,
высоту звука и материалы RedPower из исходного реестра блоков Forge.
В нём также хранится распределение инструментов нотного блока по материалам.
Реестр был снят после загрузки оригинальных модов. Для повторного съёма
запустите отдельную копию Minecraft 1.4.7 с отключённым звуком и Java 8 JDK.
Из `project/` выполните следующие команды, указав папку JDK и PID копии.

```powershell
$jdk = 'D:/path/to/jdk8'
$mcPid = 1234
New-Item -ItemType Directory -Force work/audio-registry | Out-Null
& "$jdk/bin/javac.exe" -encoding UTF-8 -cp "$jdk/lib/tools.jar" -d work/audio-registry world/sound-probe/BlockRegistry.java
& "$jdk/bin/jar.exe" cfm work/audio-registry/BlockRegistry.jar world/sound-probe/MANIFEST.MF -C work/audio-registry BlockRegistry.class
$output = Join-Path (Get-Location) 'work/audio-registry/blocks.tsv'
& "$jdk/bin/java.exe" -cp "work/audio-registry;$jdk/lib/tools.jar" BlockRegistry $mcPid (Resolve-Path work/audio-registry/BlockRegistry.jar) $output
python -B world/sounds.py --refresh-blocks work/audio-registry/blocks.tsv
```

В настольном браузере звук включается при входе в мир. Кнопки в верхней
панели управляют звуком и фоновой музыкой. Музыка запускается по явному
включению, после первой дорожки между композициями происходит исходная
пауза 10–20 минут. Звуки воды, лавы, огня и портала берутся из тех же файлов,
а частота их воспроизведения в браузере зависит от ближайших источников.
У нотных блоков правый щелчок меняет ноту, а сигнал красного камня
проигрывает сохранённую. У проигрывателя, в котором карта сохранила диск,
правый щелчок управляет воспроизведением этого диска. Для дверей браузер
выбирает звук по новому состоянию, а оригинальный клиент выбирает один
из двух событий случайно. Звуки мобов и логика окружения MAtmos в этот
перенос не входят.

`node qa/audio.mjs` проверяет звуковой поток в Microsoft Edge. Сценарий
открывает деревянную дверь `(-31, 65, -59)`, проходит через неё и записывает
PCM непосредственно с выходного узла Web Audio в
`work/audio-registry/browser-door-and-steps.wav`. Список фактически
загруженных Ogg и результаты проверки выключения звука и фоновой музыки
сохраняются в `work/audio-registry/browser-audio.json`.
