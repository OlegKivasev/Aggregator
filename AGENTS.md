# Autoservice Aggregator: правила для AI-агентов

Этот файл содержит обязательные правила работы с проектом. Они дополняют инструкции пользователя и среды выполнения. При конфликте соблюдай инструкции с более высоким приоритетом и явно сообщай о невозможности выполнить требование.

## Проект

Autoservice Aggregator — production-приложение для параллельного поиска автомобильных запчастей у внешних поставщиков.

Технологический стек:

- Node.js 24.
- TypeScript в strict-режиме.
- Native ESM и запуск TypeScript через Node type stripping.
- Нативный HTTP-сервер Node.js.
- Vanilla JavaScript frontend без bundler.
- SSE для потоковой выдачи результатов.
- Playwright для browser-интеграций.
- pnpm и зафиксированный `pnpm-lock.yaml`.

Основные точки входа:

- Backend: `src/backend/server.ts`.
- Application service: `src/backend/search-service.ts`.
- Frontend: `src/frontend/index.html` и `src/frontend/app.js`.
- Supplier integrations: `src/backend/suppliers/`.
- Tests: `tests/`.

Главная цель: вносить минимальные, корректные и проверяемые изменения без несанкционированного изменения бизнес-логики, HTTP API, SSE events и форматов данных.

## Порядок работы

Перед изменением:

1. Прочитай `README.md`, `package.json`, `tsconfig.json` и связанные исходные файлы.
2. Найди все места использования изменяемых функций, типов, маршрутов и файлов.
3. Проверь существующие тесты и диагностические scripts.
4. Установи реальную причину проблемы. Не исправляй только симптом.
5. Определи минимальное изменение, достаточное для решения задачи.

Во время работы:

1. Вноси небольшие логически завершённые изменения.
2. Не переписывай работающий модуль целиком без подтверждённой необходимости.
3. Не смешивай функциональное изменение с несвязанным рефакторингом.
4. После существенного изменения запускай релевантные проверки.
5. Не исправляй и не удаляй несвязанные пользовательские изменения.

После работы:

1. Повтори все доступные проверки.
2. Перепроверь отсутствие заглушек, debug-кода, секретов и локальных путей.
3. Укажи изменения публичного поведения, даже если они исправляют дефект.
4. Перечисли проверки, которые не удалось выполнить.
5. Не заявляй о production-готовности при наличии release-blocking дефектов.

## Обязательные проверки

Стандартные команды:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node --check src/frontend/app.js
```

После изменения production-зависимостей дополнительно выполни:

```sh
pnpm audit --prod
```

В проекте нет отдельной production-сборки и bundler. Не добавляй фиктивную build-команду только ради формального наличия.

Если `node` или `pnpm` отсутствует в `PATH`, попробуй найти доступный runtime безопасным способом. Если проверка всё равно невозможна, сообщи об этом; не выдавай непроверенный результат за успешный.

## Запрет на заглушки

В production-коде запрещены:

- mock-ответы и фиктивные результаты;
- выдуманные товары, цены, остатки, склады и даты;
- `example.com` вместо реальной ссылки;
- fake authorization или искусственно успешная сессия;
- `setTimeout` для имитации реальной работы;
- временные `return []`, `return null` или пустые методы;
- случайные и дефолтные бизнес-данные вместо отсутствующих данных;
- `TODO` или `FIXME` вместо завершённой реализации;
- catch-блоки, которые без обоснования скрывают ошибку;
- fallback с реальных данных на фиктивные;
- автоматическое включение mock при отсутствии production-конфигурации.

Если корректная реализация невозможна:

- не имитируй результат;
- верни предсказуемую configuration/integration error;
- объясни, каких данных или решений не хватает;
- предложи безопасный следующий шаг.

Mocks, stubs и hardcoded fixtures разрешены только в тестах или диагностических инструментах, если они:

- физически отделены от production composition;
- не содержат реальных credentials или tokens;
- детерминированы;
- не могут включиться в production без явного opt-in;
- явно обозначены как test/diagnostic data.

`ROSSKO_USE_STUB` допустим только как явный development opt-in. Отсутствие Rossko-конфигурации должно приводить к понятной ошибке, а не к mock-результатам.

## Модульная архитектура

Соблюдай направление зависимостей:

```text
frontend / HTTP transport
  -> application service
  -> supplier adapter contract
  -> concrete supplier integration
  -> external API / browser / filesystem
```

Ответственность слоёв:

- `server.ts` отвечает за HTTP routing, validation, безопасный parsing и response transport.
- Application service отвечает за use cases, orchestration, adapter selection и lifecycle.
- Supplier adapter инкапсулирует особенности одного поставщика.
- Session layer управляет runtime-состоянием авторизации.
- Integration modules работают с внешними HTTP API, HTML, browser и filesystem.
- Frontend отвечает только за пользовательский интерфейс и клиентский transport.

Архитектурные правила:

- Не помещай бизнес-логику в HTTP routes или DOM handlers.
- Один supplier adapter не должен зависеть от другого.
- Integration modules не должны управлять HTTP responses или DOM приложения.
- Frontend не должен знать внутренние форматы API поставщиков.
- Не создавай циклические импорты.
- Не импортируй concrete infrastructure в абстрактный contract без необходимости.
- Не создавай универсальные `manager`, `helper` или `utils` без ясной ответственности.
- Не создавай интерфейс или wrapper ради единственного простого вызова.
- Выноси общий код только при реальном повторении и одинаковой семантике.
- Не объединяй похожие supplier-функции, если их нормализация или бизнес-смысл отличаются.
- Каждый модуль должен иметь одну понятную зону ответственности.
- Сохраняй существующие публичные фасады при внутреннем разделении модулей.

## Изменение и удаление кода

Перед удалением проверь:

- статические импорты;
- dynamic imports;
- package scripts;
- HTML entry points;
- callback и registry usage;
- filesystem-based loading;
- tests;
- diagnostic scripts;
- environment-dependent branches.

Не удаляй код только по подсказке IDE. Если использование нельзя надёжно исключить, не удаляй его: опиши риск и предложи безопасную миграцию.

После подтверждённой миграции не сохраняй старую реализацию «на всякий случай». Удаляй недостижимые файлы, exports, imports, variables и branches.

Не добавляй backward compatibility без конкретной причины: persisted data, внешние consumers, уже опубликованный API или явное требование пользователя.

## TypeScript

Обязательные требования:

- Сохраняй `strict`, `noUnusedLocals` и `noUnusedParameters`.
- Не используй `any` без объективной причины.
- Для boundary-кода с Playwright `any` допустим только при отсутствии практичного точного типа и в минимальной области.
- Не используй `@ts-ignore` и не отключай проверку файла.
- Не обходи типы двойным assertion через `unknown`.
- Описывай реальные внешние payload отдельными интерфейсами.
- Используй optional fields только для действительно необязательных данных.
- Не объявляй неиспользуемые поля внешних моделей.
- Сохраняй discriminated unions для `SearchStreamEvent`.
- Не расширяй публичные типы без необходимости.
- Не используй TypeScript-синтаксис, который Node type stripping не поддерживает, включая parameter properties.
- Не оставляй неиспользуемые imports, exports, parameters и variables.

Внешний JSON всегда считай недоверенным:

- проверяй обязательные поля;
- обрабатывай `null`, `undefined` и неожиданные типы;
- не допускай `NaN` и `Infinity`;
- проверяй даты перед преобразованием;
- не полагайся только на TypeScript assertion для runtime validation.

## Supplier adapters

Каждый adapter должен:

- иметь стабильные `SupplierId`, `displayName` и ограниченный `timeoutMs`;
- проверять конфигурацию или сессию;
- возвращать понятную auth/configuration error;
- соблюдать `AbortSignal`;
- завершаться в ограниченное время;
- отдавать только `NormalizedSearchResult`;
- фильтровать результаты по нужному артикулу согласно правилам поставщика;
- не генерировать фиктивные предложения;
- не изменять данные другого поставщика;
- не скрывать upstream error под успешным пустым ответом.

Для каждого результата проверяй:

- `supplier` соответствует adapter;
- `brand`, `article` и `title` получены из реальных данных;
- `price` является конечным положительным числом;
- `warehouse` отражает реальное значение или `null`;
- `deliveryDate` является валидной ISO-датой или `null`;
- `deliveryDateApproximate` соответствует качеству исходных данных;
- `link` использует `http:` или `https:` и ожидаемый supplier origin.

Нормализация должна быть детерминированной. Не заменяй отсутствующие данные случайными или правдоподобно выглядящими значениями.

## HTTP и browser integrations

Для каждого внешнего HTTP-запроса:

- используй ограниченный timeout;
- передавай `AbortSignal`;
- проверяй HTTP status;
- ограничивай размер ответа, если он потенциально большой;
- проверяй Content-Type, когда он значим;
- ограничивай retries;
- не повторяй необратимую операцию автоматически;
- не отправляй supplier cookies на другой origin;
- проверяй protocol и hostname перед authenticated request;
- не логируй request headers, credentials или полный payload.

Для Playwright:

- загружай `playwright` только из объявленной dependency;
- не используй абсолютные пути к локальному `node_modules`;
- browser path получай из environment;
- при отсутствии внешнего browser path используй браузер Playwright;
- проверяй origin перед `page.goto`, если URL получен извне;
- закрывай временные contexts и browsers в `finally`;
- shared browser должен сбрасываться после `disconnected`;
- shared browser должен закрываться при shutdown;
- abort не должен оставлять context или page;
- не сохраняй credentials в screenshots, HTML dumps или logs.

## Конфигурация и секреты

Секреты разрешено получать только из:

- environment variables;
- runtime authorization request;
- разрешённого secret manager.

Запрещено:

- хранить credentials, API keys и tokens в исходном коде;
- добавлять реальные секреты в `.env.example`;
- добавлять локальные абсолютные пути пользователя;
- добавлять cookies и storage state в repository;
- возвращать секреты или внутренние URL пользователю;
- логировать usernames, passwords, Authorization, cookies или tokens.

Валидируй environment configuration при чтении:

- `PORT` — целое число от 1 до 65535;
- timeout — положительное ограниченное число;
- attempts — положительное ограниченное целое число;
- URL — допустимый protocol и ожидаемый hostname;
- boolean flags — только явно поддерживаемые значения.

`STATE_DIR` в production:

- должен находиться вне application checkout;
- должен принадлежать отдельному service account;
- directory permissions должны быть `0700`;
- cookies/token files должны иметь permissions `0600`;
- logout должен удалять соответствующее состояние;
- поздняя async-операция не должна восстанавливать state после logout.

Не удаляй существующие `.state` files без явного запроса: они могут содержать активные supplier sessions.

## Безопасность HTTP

HTTP server должен:

- использовать фиксированную безопасную base URL при разборе `request.url`;
- не доверять `Host` header;
- ограничивать request body;
- ограничивать длину query parameters;
- предсказуемо обрабатывать malformed JSON;
- не раскрывать stack traces и raw upstream errors;
- возвращать стабильные публичные сообщения;
- устанавливать security headers;
- защищать static serving от выхода за frontend directory;
- обрабатывать client disconnect;
- корректно завершаться по `SIGTERM` и `SIGINT`.

Не добавляй permissive CORS. Считай, что TLS и пользовательскую аутентификацию обеспечивает доверенный reverse proxy. Не ослабляй loopback binding без явного требования.

Изменения authentication/authorization нельзя делать молча: это инфраструктурное и продуктовое решение, которое требует явного описания migration и deployment impact.

## Frontend

Все данные backend, suppliers и `localStorage` считай недоверенными.

Правила rendering:

- предпочитай `textContent`;
- при использовании `innerHTML` экранируй каждое динамическое значение;
- отдельно экранируй text и attributes;
- проверяй URL перед записью в `href` или `data-*`;
- разрешай только ожидаемые protocols;
- не вставляй supplier HTML напрямую;
- не используй `eval`, `new Function` и inline event handlers;
- не сохраняй passwords и tokens в `localStorage`;
- корректно обрабатывай повреждённый или устаревший local state.

Не меняй формат SSE events без синхронного изменения backend, frontend и tests. Не добавляй frontend framework, если задача корректно решается существующим стеком.

После изменения `src/frontend/app.js` обязательно выполни:

```sh
node --check src/frontend/app.js
```

## Обработка ошибок

Различай:

- validation error;
- configuration error;
- authorization error;
- supplier timeout;
- supplier integration error;
- client abort;
- internal server error.

Правила:

- пользователю возвращается безопасное сообщение;
- secrets, internal paths и raw payload не раскрываются;
- abort не считается неожиданной internal error;
- timeout не маскируется под успешный пустой результат;
- ошибка одного supplier не должна завершать весь параллельный поиск;
- `fatal_error` используется только для ошибки всего search process;
- подробности ошибки не должны попадать в public response без фильтрации.

Не подавляй ошибку пустым catch. Пустой catch допустим только для явно необязательной операции, если причина задокументирована коротким комментарием и основное поведение сохраняется.

## Логи

Не используй `console.log` для debug output в application modules. Допустимо оставить только минимальный operational logging, например сообщение запуска сервера.

В production logs запрещены:

- credentials и usernames;
- tokens, cookies и Authorization headers;
- customer IDs;
- raw upstream payloads;
- HTML dumps;
- полные URLs с query parameters;
- временные timing logs;
- сообщения этапов browser navigation без operational ценности.

Diagnostic scripts могут печатать диагностический результат, но не секреты. Они не должны импортироваться production entry point.

## Тесты

Для исправления дефекта добавляй regression test, если его можно сделать детерминированным без обращения к реальному supplier.

Проверяй релевантные сценарии:

- success;
- invalid input;
- missing configuration;
- authorization failure;
- timeout;
- abort;
- malformed external data;
- HTML и URL safety;
- отсутствие implicit mock fallback;
- request body limit;
- static path containment;
- malformed Host;
- graceful shutdown.

Тесты не должны:

- обращаться к реальным suppliers без явного integration flag;
- использовать реальные credentials;
- зависеть от локальных абсолютных путей;
- зависеть от порядка выполнения;
- оставлять child processes, browsers или temporary files;
- использовать случайные значения без фиксированного seed или иной гарантии.

Hardcoded test fixtures допустимы и предпочтительны, если они вымышлены, минимальны и детерминированы.

## Зависимости

Перед добавлением dependency:

1. Проверь возможность использовать стандартную библиотеку.
2. Объясни необходимость новой dependency.
3. Используй точную совместимую версию.
4. Обнови `pnpm-lock.yaml` штатным package manager.
5. Запусти typecheck, tests и `pnpm audit --prod`.

Не редактируй lockfile вручную. Не удаляй dependency, пока не проверены static imports, dynamic imports, scripts, tests и runtime loading.

## Публичное поведение

Без явного разрешения не меняй:

- HTTP routes и methods;
- status codes;
- JSON formats;
- SSE event types и payload;
- `SupplierId`;
- `NormalizedSearchResult`;
- правила выбора suppliers;
- сортировку и отображение результатов;
- бизнес-правила поиска;
- persisted frontend state format.

Без отдельного согласования допустимы только обоснованные defensive changes:

- устранение фиктивных production-данных;
- закрытие уязвимости;
- ограничение явно вредоносного ввода;
- предотвращение утечки секретов;
- исправление crash, race condition или недостижимого кода.

Каждое изменение observable behavior явно опиши в итоговом отчёте.

## Git и рабочее дерево

- Не удаляй и не откатывай изменения, которые сделал пользователь или другой агент.
- Не используй destructive commands вроде `git reset --hard` или `git checkout --` без явного запроса.
- Не создавай commit, tag, branch или pull request без явного запроса.
- Не добавляй `.state`, `.env`, logs, credentials или local browser data в Git.
- Если Git недоступен или repository повреждён, сообщи об ограничении и продолжай безопасные проверки без Git.

## Критерии готовности

Задача завершена только если:

- нет новых заглушек и фиктивных production-данных;
- нет новых `TODO`/`FIXME` вместо реализации;
- нет подтверждённого мёртвого кода;
- нет неиспользуемых imports, variables, functions и dependencies;
- нет временных debug logs;
- нет hardcoded secrets и локальных user paths;
- нет необработанных promise rejections;
- resources закрываются;
- abort и timeout соблюдаются;
- typecheck проходит;
- tests проходят;
- frontend syntax check проходит после frontend-изменений;
- production dependency audit проходит после изменения dependencies;
- lockfile соответствует `package.json`;
- `README.md` и `.env.example` обновлены при изменении deployment configuration.

Если полная проверка требует реальных supplier credentials, не запускай её автоматически. Укажи точную ручную integration-проверку и связанный риск.

## Итоговый отчёт

После завершения сообщи:

1. Что изменено.
2. Почему изменение безопасно.
3. Какие проверки выполнены и с каким результатом.
4. Какие проверки выполнить не удалось.
5. Какие риски остались.
6. Изменилось ли публичное поведение.
7. Какие решения требуют подтверждения владельца проекта.

Не утверждай, что задача полностью проверена или готова к production, если это не подтверждено выполненными проверками.
