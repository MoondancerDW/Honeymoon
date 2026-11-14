# Клиент Minecraft из комплекта Honeymoon

[Архив браузерного клиента](https://github.com/MoondancerDW/Honeymoon/releases/download/equestria-source/honeymoon-browser-client.zip)
содержит игру, сервер и инструменты импорта. Для повторного создания исходного
визуала нужны пять архивов из локального комплекта Honeymoon.

| Путь под sources/Honeymoon/ | Ресурс |
| --- | --- |
| texturepacks/My-Little-Ponyach-147f.zip | Основной текстурпак |
| mods/1.4.7_Jammy_Furniture_Mod_V4.1.zip | Jammy Furniture 4.1 |
| mods/BiblioCraft.zip | BiblioCraft |
| mods/MLB-CORE_147.zip | Mine Little Brony Core |
| mods/Pam's HarvestCraft.zip | Pam's HarvestCraft и связанные ресурсы |

Из каталога project проверьте имена и контрольные суммы.

```sh
node legacy/verify-inputs.mjs atlas
```

[Манифест](client-inputs.json) содержит точные хеши исходных архивов модов
и версии загрузчиков. Команда `node legacy/verify-inputs.mjs legacy`
проверяет архивы и оригинальный модифицированный minecraft.jar
в локальном комплекте. Версии из манифеста сопоставлены с журналом
оригинальной сборки. Сам журнал в релиз не входит.

Полный набор браузерных моделей также использует `minecraft.jar` и
`mods/RedPowerDigital-2.0pr6.zip`. Для извлечения звука используются
локальные `resources/`, `audiotori/` и, при наличии, архив Chisel.

Для отдельной тестовой установки начните с Java 8, официальной версии
[Minecraft 1.4.7](https://launcher.mojang.com/v1/objects/53ed4b9d5c358ecfff2d8b846b4427b888287028/client.jar)
и [Forge 6.6.2.534](https://files.minecraftforge.net/net/minecraftforge/forge/index_1.4.7.html).
Forge можно выбрать в отдельном инстансе Prism Launcher. В оригинале также установлены LiteLoader 1.4.7 и
[OptiFine 1.4.6 HD U D5](https://optifine.net/adload?f=OptiFine_1.4.6_HD_U_D5.zip).
Официальная 1.4.7 служит базой для установки. Для точного визуального
сравнения используйте отдельную копию готового локального комплекта.
Перед запуском копии задайте `sound:0.0`, `music:0.0` и
`soundCategory_master:0.0`. Локальная копия Minecraft 1.4.7 использовалась
для парных кадров и проверки движения. В тестовой копии также отключены
OpenAL, Audiotori и MAtmos.

Условия распространения исходных компонентов опубликованы
[Mojang](https://www.minecraft.net/en-us/eula),
[OptiFine](https://www.optifine.net/copyright) и
[BiblioCraft](https://www.bibliocraftmod.com/copyright/).
