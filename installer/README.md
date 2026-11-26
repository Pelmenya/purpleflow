# Установщик PurpleFlow

Маленькое приложение для тех, кто не работает в терминале. Одна кнопка ставит PurpleFlow и всё, что ему нужно: Node.js, Git, Claude Code, Codex и OpenSpec.

- **PurpleFlow** — последний выпуск с GitHub. Файл и его sha512 берутся из `latest*.yml` выпуска. На macOS приложение распаковывается в `/Applications` (без прав на запись — в `~/Applications`), на Windows идёт тихая установка для текущего пользователя, на Linux AppImage кладётся в `~/Applications` вместе с ярлыком. Если PurpleFlow уже стоит, установщик его не трогает: обновляется PurpleFlow сам.
- **Окружение** ставится теми же модулями ядра (`core/src/services`), что и кнопка «Настроить» в PurpleFlow.
- **Git**: на macOS открывается системное окно установки инструментов Xcode, на Windows используется winget, на Linux показывается подсказка.

```bash
npm run dev:installer          # из корня репозитория
npm run dist:mac -w @purpleflow/installer
```

В режиме разработки `PURPLEFLOW_INSTALLER_APPS_DIR=/tmp/apps` ставит PurpleFlow в эту папку, а не в настоящие `/Applications`.

## Выпуск

Установщик выходит в тех же релизах, что и PurpleFlow, с той же версией (`npm run release -- X.Y.Z` поднимает и её).

- **Windows и Linux** собирает CI по тегу и кладёт в черновик релиза рядом с PurpleFlow ([release.yml](../.github/workflows/release.yml)).
- **macOS** — локально, как и сам PurpleFlow: после того как CI создал черновик, выполните

  ```bash
  npm run release:mac -w @purpleflow/installer
  ```

  Скрипт соберёт universal dmg, проверит подпись и нотаризацию и загрузит `PurpleFlow-Installer.dmg` в релиз текущей версии. С `-- --no-upload` — только собрать и проверить.

Имена файлов без версии, поэтому ссылки постоянные и ведут на последний опубликованный выпуск:

- https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer.dmg
- https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-x64.exe и https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-arm64.exe
- https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-amd64.deb, https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-x86_64.rpm и https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-x86_64.AppImage

Установщик не обновляется сам и не публикует `latest*.yml`, поэтому файлы автообновления PurpleFlow он не задевает.

