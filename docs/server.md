# Серверный режим на подготовленном Linux

Служба слушает только `127.0.0.1`, а защищённый HTTPS-доступ с телефона даёт reverse proxy. Настольное приложение продолжает работать отдельно: у службы должен быть собственный `dataDir`, нельзя направлять его в данные приложения. Один экземпляр службы использует один каталог данных.

## Предпосылки

- Linux с systemd и пользовательскими службами; команды ниже поддерживают только `SHELL=/bin/bash` у пользователя службы.
- Пользователь службы — владелец checkout, проектов и их рабочих копий. Системная служба от root не нужна.
- Чистый checkout PurpleFlow с Node.js ≥ 22.18 и git; подготовленный git-проект с настроенной командой тестов.
- Установленные и настроенные CLI агентов. Абсолютные пути к `claude`, `codex` и другим выбранным CLI задаются в конфиге; `openspec` берётся из checkout.
- Домен, HTTPS reverse proxy (в примере Caddy) и действующий сертификат.

Все команды настройки, кроме `loginctl` и управления Caddy, выполняйте от пользователя службы. В примерах `<пользователь>` — его имя.

## Сборка и конфигурация

Из корня чистого checkout:

```bash
npm ci
npm run build:core
npm run build:web
```

Создайте отдельные каталоги и секрет входа:

```bash
mkdir -p "$HOME/.config/purpleflow-server" "$HOME/.local/state/purpleflow-server"
chmod 700 "$HOME/.local/state/purpleflow-server"
install -d -m 700 "$HOME/.local/state/purpleflow-server/data"
test "$(stat -c '%a' "$HOME/.local/state/purpleflow-server/data")" = 700
node -e 'require("node:fs").writeFileSync(process.argv[1], require("node:crypto").randomBytes(32).toString("base64url") + "\n", { mode: 0o600 })' "$HOME/.config/purpleflow-server/secret"
cp docs/server/config.example.json "$HOME/.config/purpleflow-server/config.json"
chmod 600 "$HOME/.config/purpleflow-server/config.json"
```

Отредактируйте `config.json` и замените все плейсхолдеры:

- `__CHECKOUT__` — абсолютный путь к этому checkout;
- `__DATA_DIR__` — например, `/home/<пользователь>/.local/state/purpleflow-server/data`; каталог данных службы должен быть отдельным, иметь владельца-пользователя службы и права `0700`. При другом значении `__DATA_DIR__` подставьте тот же абсолютный путь вместо `$HOME/.local/state/purpleflow-server/data` в обе команды: `install` и проверку через `stat`;
- `__PROJECT_DIR__` — абсолютный путь к подготовленному git-проекту;
- `__SECRET_FILE__` — абсолютный путь к созданному `secret`;
- `__CLAUDE__` и `__CODEX__` — абсолютные пути к установленным CLI; неиспользуемый `codex` можно удалить из `toolPaths`, если ревьюером назначен `claude`.

`projects[0].testCommand` замените `node --version` на реальную команду тестов проекта. Все значения `settings.toolPaths` и все пути конфига должны быть абсолютными. В частности, `openspec` — это абсолютный путь `<checkout>/node_modules/.bin/openspec`, а не `node_modules/.bin/openspec` и не имя из `PATH`.

Не используйте в `dataDir` ни `${XDG_CONFIG_HOME:-$HOME/.config}/PurpleFlow/data`, ни прежний `${XDG_CONFIG_HOME:-$HOME/.config}/PS Flow/data`: `loadServerConfig` отклонит совпадение, включая пути через симлинки. Если в окружении службы задана `PURPLEFLOW_USER_DATA`, отклоняется и её подкаталог `data`. Предел проверки: desktop, запущенный с `PURPLEFLOW_USER_DATA` в другом окружении, служба не видит. Поэтому не направляйте `dataDir` в профиль desktop даже при другом способе задания этого каталога.

`publicOrigin` — точный HTTPS origin без пути, который откроется на телефоне. `port` — локальный порт для reverse proxy.

## Вход агентов

### Собственный вход Claude Code (по умолчанию)

В примере задано `"claudeAuth": "login"`. Войдите в Claude Code от пользователя службы обычной командой `claude` до запуска прогонов. PurpleFlow передаёт модель через `--model`; в `settings.models` оставьте пустую строку или задайте модель/алиас, который понимает установленный Claude Code.

При этом способе `claudeEnv` вычищает `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` и `ANTHROPIC_BASE_URL`, чтобы переменные не перекрыли собственный вход.

### Anthropic-совместимый провайдер

Например, для Kimi Code задайте в `config.json` `"claudeAuth": "env"`. Переменные провайдера кладутся не в unit, а в отдельный файл пользователя службы:

```bash
install -m 600 /dev/null "$HOME/.config/purpleflow-server/provider.env"
```

Содержимое `provider.env` (подставьте ключ и фактические имена моделей провайдера):

```bash
ANTHROPIC_BASE_URL=https://api.kimi.ai/coding/
ANTHROPIC_API_KEY=КЛЮЧ_ПРОВАЙДЕРА
ANTHROPIC_MODEL=МОДЕЛЬ_ПО_УМОЛЧАНИЮ
ANTHROPIC_DEFAULT_OPUS_MODEL=МОДЕЛЬ_ДЛЯ_OPUS
ANTHROPIC_DEFAULT_SONNET_MODEL=МОДЕЛЬ_ДЛЯ_SONNET
ANTHROPIC_DEFAULT_HAIKU_MODEL=МОДЕЛЬ_ДЛЯ_HAIKU
```

Поддерживается только bash. Если `~/.bash_profile` отсутствует, создайте его, сохранив прежнюю настройку из `~/.profile`:

```bash
if [ ! -e "$HOME/.bash_profile" ]; then
  printf '%s\n' '[ -f ~/.profile ] && . ~/.profile' > "$HOME/.bash_profile"
  chmod 600 "$HOME/.bash_profile"
fi
```

Добавьте в `~/.bash_profile` строку (при только что созданном файле — после первой строки с `~/.profile`):

```bash
set -a; . "$HOME/.config/purpleflow-server/provider.env"; set +a
```

Именно `~/.bash_profile`: `bash -il` читает первый существующий из `~/.bash_profile`, `~/.bash_login`, `~/.profile`. Подключения только из `~/.profile` недостаточно, если уже есть один из двух первых файлов; zsh и другие шеллы этой инструкцией не поддерживаются.

Проверка должна вывести ровно `1`:

```bash
sudo -iu <пользователь> bash -ilc 'env' | grep -c '^ANTHROPIC_BASE_URL='
```

`Environment=` и `EnvironmentFile=` в unit до агента не доходят: `buildAgentEnv` пропускает из окружения службы только базовые и сетевые переменные, остальное читает из login-шелла через `loadLoginShellEnv`. `PATH` также приходит из login-шелла и заменяет значение из unit. Не используйте `env` из `~/.claude/settings.json` как основной способ: с `"userConfig": false` PurpleFlow запускает claude с `--setting-sources project,local`, и пользовательские настройки не читаются.

Окружение агентов читается один раз при старте службы. После изменения `provider.env` обязательно выполните:

```bash
systemctl --user restart purpleflow.service
```

В `settings.models` оставьте пустые строки или используйте алиасы `opus` и `sonnet`: PurpleFlow передаёт `--model`, а провайдер отображает алиасы через `ANTHROPIC_DEFAULT_*_MODEL`. Вход провайдера и прохождение прогона до плана проверьте вручную после установки: автоматическая проверка сетевого входа ключом владельца не выполняется.

## Уведомления в Telegram

Это необязательный раздел; пример конфига его намеренно не содержит. Без него служба работает, а защищённая страница `/settings` показывает «Telegram не подключён».

Для подключения добавьте в корень `config.json`:

```json
"telegram": {
  "tokenFile": "/home/<пользователь>/.config/purpleflow-server/telegram-token",
  "chatId": "ЛИЧНЫЙ_ЧАТ_ВЛАДЕЛЬЦА",
  "apiBase": "https://api.telegram.org"
}
```

`apiBase` необязателен. `tokenFile` должен быть абсолютным путём к файлу токена с правами `0600`, принадлежащим пользователю службы; `chatId` — личный чат владельца. Служба читает токен до привязки порта и отклоняет запуск, если файл доступен группе или остальным пользователям. После настройки перезапустите службу, откройте защищённую `/settings` и нажмите «Отправить пробное сообщение». Сообщение должно прийти в личный чат.

## Пользовательская служба systemd

Скопируйте пример:

```bash
mkdir -p "$HOME/.config/systemd/user"
cp docs/server/purpleflow.service "$HOME/.config/systemd/user/purpleflow.service"
```

В `~/.config/systemd/user/purpleflow.service` замените:

- `__NODE__` — абсолютный путь к `node` (его показывает `command -v node`);
- `__CHECKOUT__` — абсолютный путь к checkout;
- `__CONFIG__` — абсолютный путь к `config.json`.

Итоговый `ExecStart` должен запускать `<checkout>/core/dist/server/main.js` с аргументами `--config <абсолютный-путь-к-config.json>`. Сохраните `KillMode=control-group`, `Restart=on-failure` и `WantedBy=default.target`. Не добавляйте `PrivateNetwork` и `JoinsNamespaceOf`: блокировка `dataDir` использует абстрактный сокет в общем сетевом пространстве, а перезапуск внутри unit должен оставаться в нём.

Включите linger, иначе пользовательская служба завершится после выхода из SSH, затем запустите службу:

```bash
sudo loginctl enable-linger <пользователь>
systemctl --user daemon-reload
systemctl --user enable --now purpleflow.service
```

Проверьте состояние и локальный вход без постоянно открытого просмотра журнала:

```bash
systemctl --user status purpleflow.service --no-pager
journalctl --user -u purpleflow.service -n 100 --no-pager
curl -i http://127.0.0.1:4173/login
```

## HTTPS и приёмка с телефона

Пример сайта Caddy; порт должен совпадать с `port` конфига:

```caddy
purpleflow.example.com {
  reverse_proxy 127.0.0.1:4173
}
```

Перезапускайте Caddy штатными средствами сервера после изменения его конфигурации. Откройте `publicOrigin` с телефона и войдите секретом из `secret`.

Для ручной приёмки:

1. Запустите задачу в подготовленном проекте и дождитесь следующей стадии или гейта. Скопируйте ссылку на прогон.
2. Полностью завершите SSH-сеанс. С телефона откройте защищённую ссылку по HTTPS: linger должен сохранить службу работающей.
3. Откройте ссылку в новом браузере без сессии: произойдёт переход на вход, после успешного входа откроется тот же прогон.
4. Нажмите «Выйти» и снова откройте ссылку: вход потребуется повторно, после него снова откроется тот же прогон.
5. При `"claudeAuth": "env"` проверьте, что прогон доходит до плана на модели провайдера. При настроенном Telegram выполните пробу на `/settings`.

Для продолжения использования настольного приложения ничего в его настройках менять не нужно; его каталог данных остаётся отдельным от каталога службы.
