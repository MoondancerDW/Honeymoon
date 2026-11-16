# Honeymoon

Карта Equestria и самостоятельная браузерная игра на основе района
Honeymoon. Здесь можно ходить, летать, строить из блоков и микроблоков RedPower
и редактировать постройки резцом. Исходные блоки тоже доступны для разрушения.
Отдельная копия карты позволяет восстановить оригинальные постройки.
Правки сохраняются и видны другим гостевым сессиям.

- [Подготовка и запуск](project/README.md)
- [Готовая сборка для Windows x64](https://github.com/MoondancerDW/Honeymoon/releases/download/pc-test-inventory-weather/Honeymoon-Creative-Weather-Windows-x64.zip)
- [Архив браузерного клиента и Node.js-сервера](https://github.com/MoondancerDW/Honeymoon/releases/download/pc-test-inventory-weather/honeymoon-browser-client.zip)
- [Отдельная копия исходной карты для восстановления](https://github.com/MoondancerDW/Honeymoon/releases/download/pc-test-inventory-weather/Honeymoon-Original-Map.zip)
- [Тестовый релиз с инвентарём, погодой и восстановлением карты](https://github.com/MoondancerDW/Honeymoon/releases/tag/pc-test-inventory-weather)
- [Манифест исходного клиента Minecraft](project/legacy/README.md)
- [Проверки, визуальные замены и замеры](project/REPORT.md)
- [Архивы карты Equestria](https://github.com/MoondancerDW/Honeymoon/releases/tag/equestria-source)

Архивы мира распаковываются в один каталог, чтобы объединить регионы.
Для извлечения оригинального визуала понадобятся пять архивов
из локального комплекта Honeymoon.

Первичный анализ карты хранится в [analysis](analysis). Скрипты
из [tools](tools/README_TOOLS_RU.txt) читают исходное сохранение и записывают
повторные отчёты в `analysis/rerun/`.
