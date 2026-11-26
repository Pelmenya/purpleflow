<div align="center">

<img src="app/build/icon.png" width="96" height="96" alt="Логотип PurpleFlow">

# PurpleFlow

**Штаб для ваших ИИ-агентов**

Бесплатное приложение для компьютера, которое ведёт Claude Code и Codex по шагам: один агент пишет код по утверждённому вами плану, другой делает ревью, тесты и браузер проверяют результат — а вы принимаете готовое.

[![CI](https://github.com/PurpleSchool/purpleflow/actions/workflows/ci.yml/badge.svg)](https://github.com/PurpleSchool/purpleflow/actions/workflows/ci.yml)
[![Релиз](https://img.shields.io/github/v/release/PurpleSchool/purpleflow?include_prereleases&label=релиз&color=7c5cff)](https://github.com/PurpleSchool/purpleflow/releases/latest)
[![Лицензия: MIT](https://img.shields.io/badge/лицензия-MIT-7c5cff)](LICENSE)
![Статус: beta](https://img.shields.io/badge/статус-beta-e0a458)
![macOS · Linux · Windows](https://img.shields.io/badge/macOS_·_Linux_·_Windows-3b3d45)

[**Скачать**](https://github.com/PurpleSchool/purpleflow/releases/latest) · [Быстрый старт](#быстрый-старт) · [Руководство](docs/guide.md) · [Архитектура](ARCHITECTURE.md) · [Как участвовать](CONTRIBUTING.md) · [English](README.en.md)

<img src="docs/screenshots/run-timeline.png" alt="Экран прогона: стадии задачи на шкале времени" width="900">

</div>

## Зачем это нужно

Агент в терминале сам планирует, сам пишет и сам решает, что всё работает. PurpleFlow разводит эти роли: **тот, кто пишет код, его не принимает**.

<img src="docs/screenshots/comparison.png" alt="Сравнение: одна модель в терминале и команда моделей с проверками в PurpleFlow" width="900">

Своего агента в PurpleFlow нет: стадии выполняют установленные у вас `claude`, `codex`, `opencode` или `agy` (Antigravity CLI) — любой из них можно выключить в настройках. Через `opencode` подключаются любые провайдеры: OpenRouter, DeepSeek, локальные модели; `agy` (Antigravity CLI) работает через AI-прокси PurpleSchool или через ваш аккаунт Google. Приложение отвечает за порядок, проверки и ваши решения.

## Как идёт задача

Агент не перескочит ни одну стадию: красные тесты или замечание ревьюера возвращают задачу исполнителю. На двух стадиях решаете вы.

```mermaid
flowchart LR
  A[Уточнение] --> B[План] --> C{{Утверждение}} --> D[Реализация] --> E[Проверки] --> F[Ревью] --> G{{Приёмка}} --> H[Коммит и PR]
  E -- красные тесты --> D
  F -- замечания --> D
  G -- есть замечания --> D
```

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/gate1-plan.png" alt="Утверждение плана"></td>
    <td width="50%"><img src="docs/screenshots/gate2-accept.png" alt="Приёмка: дифф и решение"></td>
  </tr>
  <tr>
    <td><b>Утверждение плана.</b> Видите, что агент сделает, до первой строчки кода.</td>
    <td><b>Приёмка.</b> Дифф, замечания ревьюера и ваши комментарии к строкам. Затем «Влить» или «Создать PR».</td>
  </tr>
</table>

## Возможности

| | |
| --- | --- |
| **Быстрая настройка** | Выберите основного агента и пресет — «Экономный», «Оптимальный» или «Максимальное качество» — и роли с моделями расставятся сами. Ревьюер всегда работает на другой модели, чем исполнитель. |
| **Разные модели на разных ролях** | Любую роль можно поправить вручную: планировщику, исполнителю и ревьюеру — свой `claude`, `codex`, `opencode` или `agy` и своя модель. Больше всего работы на реализации: туда можно поставить модель подешевле, а план и ревью оставить сильной. |
| **Режимы под задачу** | Быстрая правка, баг (сначала падающий тест), задача, большая задача по этапам, рефакторинг (тесты зелёные до и после). Не знаете, что выбрать, — нажмите «Авто». |
| **Обязательные проверки** | Тесты и линтер проекта. Команды определяются сами для Node.js, Go, Python и Rust, для остальных указываются вручную. |
| **Визуальная проверка** | Отдельный агент открывает приложение в браузере и смотрит на результат. |
| **Изоляция** | Каждая задача — отдельная worktree и ветка `purpleflow/…`. Ваша рабочая копия не меняется, влить или открыть PR решаете вы. |
| **Несколько репозиториев** | Выберите папку, в которой лежат репозитории (например, `api` и `web`), и отметьте нужные. Агент правит их все в одной задаче, а коммит, слияние и PR делаются в каждом. |
| **Pull request** | Создание PR на GitHub, отработка замечаний ревьюеров и упавших проверок CI. |
| **Менеджер прогона** | Чат рядом с прогоном: спросите, как идут дела, или поправьте ход. |
| **Восстановление** | Закрыли приложение на середине — прогон можно продолжить после запуска. |

## Быстрый старт

**Не работали в терминале?** Скачайте установщик: он сам поставит PurpleFlow, Node.js, Git и агентов, а Claude Code, Codex и редакторы подключит к моделям PurpleSchool переключателями.

| macOS | Windows | Linux |
| --- | --- | --- |
| [PurpleFlow-Installer.dmg](https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer.dmg) | [x64](https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-x64.exe) · [ARM](https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-arm64.exe) | [deb (Ubuntu, Debian)](https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-amd64.deb) · [rpm (Fedora, RHEL)](https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-x86_64.rpm) · [AppImage](https://github.com/PurpleSchool/purpleflow/releases/latest/download/PurpleFlow-Installer-x86_64.AppImage) |

Или по шагам:

**1. Скачайте PurpleFlow** со страницы [Releases](https://github.com/PurpleSchool/purpleflow/releases/latest) для macOS, Windows или Linux. При первом запуске кнопка «Настроить» сама поставит недостающие Node.js, `claude`, `codex` и OpenSpec. Отдельно понадобится только git. Дальше приложение будет предлагать обновления.

Можно поставить агентов и вручную:

```bash
npm i -g @anthropic-ai/claude-code @openai/codex @fission-ai/openspec
# по желанию — opencode и его провайдеры:
npm i -g opencode-ai && opencode auth login
# по желанию — Antigravity CLI 1.5+: пакета в npm нет, ставится установщиком Google
# (https://antigravity.google/docs/cli/install). С AI-прокси PurpleSchool вход в Google не нужен.
```

**2. Опишите задачу:** выберите папку проекта и режим. PurpleFlow позовёт вас только на утверждение плана и приёмку.

<details>
<summary>Запуск из исходников</summary>

Нужны Node.js ≥ 22.18 и git.

```bash
git clone https://github.com/PurpleSchool/purpleflow.git
```

```bash
cd purpleflow && npm install
```

```bash
npm run dev
```

Сборка установщиков и подпись — в [руководстве](docs/guide.md#сборка).

</details>

<details>
<summary>Windows: проекты внутри WSL</summary>

Если проекты и агенты живут в WSL, запустите внутри WSL Linux-версию PurpleFlow — окно откроется на рабочем столе Windows через WSLg. Тогда git, агенты, тесты и dev-серверы работают в Linux, рядом с кодом.

Нужна WSL 2 с WSLg: Windows 11 или Windows 10 22H2 с WSL из Microsoft Store. В PowerShell:

```powershell
wsl --install -d Ubuntu
```

Если WSL уже стоит — обновите её, чтобы появился WSLg:

```powershell
wsl --update
```

Дальше всё — в терминале Ubuntu. Поставьте git и последнюю версию PurpleFlow из релизов:

```bash
sudo apt update && sudo apt install -y git curl
```

```bash
url=$(curl -s https://api.github.com/repos/PurpleSchool/purpleflow/releases/latest | grep -o 'https://[^"]*/PurpleFlow-[0-9.]*-amd64\.deb')
```

```bash
curl -LO "$url" && sudo apt install -y "./$(basename "$url")"
```

Запуск:

```bash
purpleflow
```

При первом запуске кнопка «Настроить» поставит Node.js, агентов и OpenSpec — внутри WSL, отдельно от Windows. Вход в `claude`, `codex` и других агентов тоже свой, в домашней папке WSL.

- Держите проекты в файловой системе Linux (`~/projects`), а не в `/mnt/c`: через `/mnt/c` git и агенты работают в разы медленнее.
- Встроенный браузер открывает dev-серверы по `localhost`, как обычно.
- Окно не появилось — выполните в PowerShell `wsl --shutdown` и запустите `purpleflow` снова.

</details>

## На чём работать

Приложение бесплатно в обоих случаях.

| Свои подписки | Токены PurpleSchool |
| --- | --- |
| Claude Pro / Max или ChatGPT Plus / Pro: PurpleFlow запускает Claude Code и Codex под вашим входом. Нажмите «Пропустить» при первом запуске — регистрация не нужна, расход идёт из лимитов подписки. | Нет зарубежной карты или не хватает лимитов? Все модели через одну подписку: оплата картой российского банка, без VPN. Запросы агентов идут через AI-прокси PurpleSchool. |

## Ваш код остаётся вашим

- PurpleFlow работает на вашем компьютере. Код получает только выбранный вами агент и его провайдер моделей, а с токенами PurpleSchool запросы проходят через наш AI-прокси.
- Изменения попадают только в отдельную ветку, а слияние всегда за вами.
- Если приложение падает, разработчики получают отчёт об ошибке: тип, стек, версии приложения и системы. Код, задачи, пути и ключи вычищаются до отправки.
- Вместе с отчётами идёт статистика шагов: как прошла первая настройка, какие стадии проходят задачи, режим, пресет, агент и модель исполнителя, решения на воротах и чем закончился прогон, результаты проверок, версии приложения и системы — по ней видно, где и как часто случаются ошибки. Она привязана к случайному идентификатору установки; если вы вошли через PurpleSchool, сервер связывает её и с аккаунтом. Код, тексты задач, пути и ключи не отправляются.
- Отчёты и статистика отключаются одним выключателем в настройках на вкладке «Приложение».
- Код открыт: можно прочитать, что именно делает каждая стадия, — [промпты стадий](core/prompts) лежат в репозитории.

## Статус

Проект в **beta**: основные сценарии покрыты тестами, но возможны ошибки. Начинайте с проектов, где легко откатиться.

| ОС | Поддержка |
| --- | --- |
| macOS | ✅ проверки и сквозные тесты окна в CI при выпуске версии, живая проверка |
| Linux | ✅ проверки и сквозные тесты окна в CI |
| Windows | ✅ проверки ядра и окна в CI, живая проверка |

## Участие в проекте

Ошибки и идеи — в [Issues](https://github.com/PurpleSchool/purpleflow/issues), как собрать проект и прогнать проверки — в [CONTRIBUTING](CONTRIBUTING.md), об уязвимостях — по правилам из [SECURITY](SECURITY.md). Интерфейс, промпты и комментарии в коде на русском; issues и pull request на английском тоже приветствуются.

Хотите научиться работать с агентами? В [курсах PurpleSchool](https://purpleschool.ru) есть программы по Claude Code и Codex.

## Лицензия

[MIT](LICENSE) © PurpleSchool
