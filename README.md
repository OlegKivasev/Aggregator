# Autoservice Aggregator

Node.js 26 service that searches configured automotive-parts suppliers and streams normalized results to the browser over SSE.

## Local Run

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm start
```

The application listens on `127.0.0.1:3000` by default. `PORT` can override the port.

## Backend Architecture

- `src/backend/server.ts` is the composition root and process lifecycle entrypoint.
- `src/backend/http/` owns routing, request validation, HTTP/SSE responses, and static files.
- `src/backend/application/` owns search orchestration and supplier-session use cases.
- `src/backend/search-service.ts` is the stable facade that wires application services to supplier adapters.
- `src/backend/session/` owns in-process session state, operation generations, and atomic persisted state.
- `src/backend/suppliers/` contains the supplier contract and isolated integrations.

Dependencies flow from HTTP transport through application services to supplier adapters and external integrations. Supplier-specific payloads and browser behavior do not cross into the HTTP or frontend layers.

The frontend uses native browser modules without a bundler. `src/frontend/app.js` owns DOM state and event wiring, while `result-formatting.js`, `search-stream.js`, and `supplier-search-summary.js` isolate result safety, SSE transport, and summary formatting respectively.

## Инструкция для AI-агентов и будущих правок

Этот раздел является maintenance contract проекта. Перед изменением кода AI-агент обязан прочитать `AGENTS.md`, этот раздел, `package.json`, `tsconfig.json`, связанные production-файлы и тесты. Нельзя исправлять симптом, не установив фактическую причину по коду, документации поставщика и воспроизводимому ответу приложения.

### Основной принцип

- Делайте минимальное корректное изменение. Не переписывайте работающий модуль целиком и не смешивайте исправление с несвязанным рефакторингом.
- Не меняйте HTTP routes, methods, status codes, JSON schemas, SSE event types, `SupplierId`, `NormalizedSearchResult`, сортировку, persisted frontend state и правила выбора поставщиков без явного решения владельца.
- Защитное изменение допустимо, если оно устраняет crash, race condition, утечку, бесконечное ожидание, небезопасный ввод или преобразование реальной ошибки в ложный успех.
- Не добавляйте compatibility branch, fallback или abstraction «на будущее». Сначала должен существовать конкретный контракт или подтвержденное повторение.
- Не угадывайте внешний payload. Сначала получите документацию или безопасный structural diagnostic, затем зафиксируйте наблюдаемую форму regression-тестом.
- Не удаляйте пользовательские файлы, `.state`, credentials, cookies или несвязанные изменения рабочего дерева. Каталог `patrkom test/` не относится к production composition и не должен изменяться без отдельного запроса.

### Направление зависимостей

Соблюдайте направление:

```text
frontend / HTTP transport
  -> application services
  -> supplier adapter contract
  -> concrete supplier integration
  -> external HTTP API / browser / filesystem
```

- `src/backend/server.ts` только собирает приложение, запускает HTTP server и закрывает shared resources.
- `src/backend/http/` отвечает за routing, parsing, validation, security headers, JSON/SSE transport и static serving. Здесь не должно быть supplier business logic.
- `src/backend/application/` оркестрирует поиск, авторизацию, logout и session validation. Application services получают concrete operations через composition root, а не импортируют supplier infrastructure напрямую.
- `src/backend/search-service.ts` является composition facade. Concrete adapters, authorization functions и state cleanup связываются здесь.
- `src/backend/session/` управляет runtime credentials, состояниями сессий, поколениями операций и атомарной записью файлов.
- `src/backend/suppliers/` содержит независимые adapters. Один supplier не должен импортировать или изменять другой.
- Frontend не должен знать исходные payload поставщиков. В браузер передаются только нормализованные результаты и стабильные SSE events.
- Не создавайте циклические imports, универсальные `manager/utils/helper` без одной ясной ответственности или wrapper ради одного простого вызова.

### HTTP и SSE contracts

- URL запроса разбирается только относительно фиксированного `http://127.0.0.1`; `Host` header не является доверенным.
- Request body ограничен, malformed JSON получает предсказуемый `400`, чрезмерный body получает `413`.
- Article и supplier IDs валидируются до вызова application service.
- Static serving обязан оставаться внутри `src/frontend`; path traversal возвращает `404`.
- Security headers должны устанавливаться и для JSON, и для static responses.
- Поиск использует существующий SSE contract: `search_started`, `supplier_status`, `result`, `search_completed`, `fatal_error`. Payload и порядок lifecycle нельзя менять только в backend или только во frontend.
- Ошибка одного supplier не завершает параллельный поиск остальных. `fatal_error` разрешен только для ошибки всего search process.
- Client disconnect должен abort-ить authorization, validation и search. Abort не логируется как unexpected internal error.
- Любой внешний request обязан иметь caller `AbortSignal`, bounded timeout, response-size limit, ограниченные retries и проверенный HTTPS origin.
- Shared HTTP agents и browser resources закрываются при shutdown.

### Ошибки и безопасная диагностика

- Используйте typed errors из `src/backend/errors.ts`: `SupplierAuthError`, `SupplierTimeoutError`, `SupplierIntegrationError`, `SupplierSessionInvalidatedError`.
- Не определяйте timeout по тексту сообщения. Проверяйте тип ошибки или typed abort reason.
- Public HTTP mapping сохраняется: validation `400`, authorization `401`, integration `502`, timeout `504`, internal `500`.
- Raw exception messages, upstream payloads, credentials, URLs с query, filesystem paths, cookies и tokens не должны попадать в HTTP, SSE или logs.
- `SupplierIntegrationError.publicMessage` используется только как явный opt-in для заранее сформулированного безопасного сообщения. Никогда не присваивайте туда upstream `message`, `detail`, HTML или сериализованный payload.
- `SupplierIntegrationError.diagnosticCode` может содержать только безопасный stage/schema code. Допустимы имена полей и типы без значений; запрещены payload values, login, customer ID, URL, article и credentials.
- Поиск показывает `publicMessage` только для typed integration error. Без явного opt-in остается `Supplier search failed`.
- Operational logs должны содержать только operation, category и безопасный diagnostic code. Не добавляйте временные dumps и `console.log`; единственный обычный startup log находится в `server.ts`.
- При диагностике реального supplier сначала воспроизведите публичный lifecycle через `/api/suppliers/sessions` и `/api/search?stream=once...`. Если данных недостаточно, добавьте безопасный stage-code и regression-тест, а не раскрывайте raw response.

### Session lifecycle и persisted state

- Authorization является exclusive operation для конкретного supplier: она отменяет старые операции и блокирует новые до завершения.
- Успешная новая session вызывает `supersedeOthers`, чтобы поздний старый search или state write не пережил смену credentials.
- Logout сначала инвалидирует операции, затем очищает runtime credentials и persisted supplier state.
- Каждый async state write проверяет generation непосредственно перед atomic replace. Stale operation не может восстановить файл после logout.
- Persisted JSON заменяется атомарно; directory/file permissions остаются `0700`/`0600` там, где ОС это поддерживает.
- В production `STATE_DIR` обязателен, является абсолютным и находится вне application checkout.
- Не удаляйте существующие state files во время тестирования: они могут содержать активные sessions.
- Успешно проверенные runtime credentials сохраняются на диск только при настроенном `SUPPLIER_CREDENTIALS_ENCRYPTION_KEY`: AES-256-GCM ciphertext находится в `STATE_DIR`, а master key поступает отдельно из secret manager/environment.
- Без `SUPPLIER_CREDENTIALS_ENCRYPTION_KEY` runtime credentials живут только в памяти процесса. Master key нельзя хранить рядом с ciphertext, в checkout или logs.
- При auth-expiry session validation один раз повторяет полноценную авторизацию с сохраненными credentials. Authorization rejection очищает supplier state и credentials; timeout/integration error не запускает бесконечные retries.
- Не обрезайте password через `trim()`. Login нормализуется отдельно; пробелы password могут быть значимыми.
- Неудачная повторная авторизация должна завершиться typed authorization error и HTTP `401`, даже если старая session остается действующей.
- Каждый adapter обязан иметь отдельный lightweight `validateSession`. Нельзя проверять сессию путем product search с последующим выбрасыванием результатов.

### Нормализация supplier data

Каждый emitted `NormalizedSearchResult` обязан удовлетворять следующим условиям:

- `supplier` совпадает с adapter ID;
- `brand`, `article`, `title` являются непустыми строками из реального ответа;
- article соответствует запрошенному по supplier-specific normalization;
- `price` является конечным положительным числом;
- `warehouse` содержит реальное название/код или `null`;
- `deliveryDate` и `deliveryDateTo` являются валидными ISO dates или `null`, причем конец интервала позже начала;
- `deliveryDateApproximate` отражает качество исходного срока;
- `link` использует только `http:` или `https:` и ожидаемый supplier site;
- отсутствующие значения не заменяются выдуманными складами, датами, ценами, остатками или ссылками.

Если supplier вернул часть валидных и часть невалидных предложений, валидные можно отдать, а невалидные отфильтровать. Если весь непустой ответ оказался невалидным, это integration error, а не успешный пустой результат.

### Правило пустого результата

- Пустой success допустим только для документированного и структурно валидного ответа «предложений нет».
- HTTP error, supplier error flag, error envelope, malformed JSON/HTML, отсутствующая обязательная response collection и полностью невалидные offers не превращаются в `[]`.
- Не восстанавливайте старые `return []`, `return null`, пустые catch или mock fallback ради того, чтобы UI выглядел успешным.
- Один supplier error остается локальным `supplier_status`; поиск других suppliers продолжается.

### Подтвержденные особенности поставщиков

#### Rossko

- Production search использует существующую business-site/API session integration; standalone SOAP script не является fallback production adapter.
- `ROSSKO_USE_STUB` допустим только как явный development opt-in. Отсутствие конфигурации не включает mock автоматически.
- Проверяйте supplier `errorFlag`, структуру groups/cards/stocks и обязательные product fields. Malformed collections являются integration error.
- Сохраняйте все точные совпадения article, а не только первый product ID.
- Authenticated cookies нельзя отправлять на другой origin; URL проверяется до request.

#### Armtek

- Используется только официальный WebService API; не возвращайте ETP/browser fallback.
- Credentials проверяются через `getUserVkorgList` и `getUserInfo`. Найденные `VKORG` и `KUNNR_RG` сохраняются с hash активного login; state другого login применять нельзя.
- `getUserVkorgList`, `search` и `getStoreList` могут возвращать либо прямой массив, либо объект с `ARRAY`. Обе документированные/наблюдаемые формы поддерживаются.
- Search отправляет `VKORG`, `KUNNR_RG`, `PIN`, `QUERY_TYPE` и только реально настроенные optional parameters.
- `DLVDT` и `WRNTDT` образуют интервал поставки; невозможные календарные даты отбрасываются.
- `KEYZAK` по документации является реальным кодом склада. `getStoreList` нужен только для optional преобразования `KEYZAK -> SKLNAME`.
- Ошибка или timeout `getStoreList` не должны отменять уже полученные валидные offers. В таком случае показывайте `KEYZAK`; authorization и parent abort при этом не подавляются.
- Ошибка основного `ws_search/search` остается supplier integration error. Не превращайте ее в пустой список.

#### PartKOM

- Используется официальный Web Services v4: `GET /v4/search/brands` для connection check и `GET /v4/search/offers` для поиска с Basic Authentication.
- `search/offers` требует `number`; `find_substitutes=0` сохраняет поиск точного артикула без аналогов.
- Официальная документация описывает тело как JSON string, но реальный media type может быть нестандартным. Поэтому bounded body парсится как JSON независимо от `Content-Type`; не возвращайте permissive fallback для невалидного JSON.
- Допускается UTF-8 BOM перед JSON.
- Документация описывает collection напрямую, но реальный API возвращает envelope `{ success: true, data: [...] }`. Boundary обязан проверить boolean `success`, проверить `data` как array и развернуть его одинаково для brands и offers.
- `{ success: false, ... }` является integration error. Не извлекайте и не показывайте raw error values.
- API errors могут приходить как `application/problem+json` с `message`, `detail`, `error` или `title`. IP restriction распознается до общей классификации HTTP status и показывает только безопасное сообщение.
- Серверный public IP должен быть разрешен в настройках PartKOM.
- Runtime credentials могут сохраняться только в общем authenticated encrypted store; whitespace password сохраняется.

#### STParts

- Используются ABCP `user/info` для session check и `search/batch` для поиска.
- Один batch содержит не более 100 brand/article pairs. Не возвращайте старую последовательность отдельных запросов без доказанной необходимости.
- Successful searches кешируются в памяти на одну минуту; cache key должен учитывать реальные search inputs и account context.
- Error envelopes и `errorCode`, включая `301`, остаются integration errors согласно принятому поведению проекта. Валидная пустая result map означает отсутствие предложений.
- `user/info` должен содержать распознаваемое identity field; `{}` не является валидной session.
- Warehouse HTML/color/rating считаются недоверенными и нормализуются до ограниченного набора значений.

#### MotorDetal

- Token state имеет generation guard; поздняя авторизация не может восстановить token после logout.
- Проверяйте HTTP status, API success/error envelope, обязательные tokens и initialization response.
- Отсутствующая или malformed product page является integration error, а не пустым результатом.
- Auth error очищает supplier session; timeout и integration error не маскируются друг под друга.

#### Механик Ладов

- Browser/context lifecycle всегда закрывается в `finally`; abort не оставляет page/context.
- Shared browser сбрасывается после disconnect и закрывается при application shutdown.
- Storage state записывается только при актуальной generation.
- Пустой или нераспознанный HTML не означает «нет предложений». Успешный empty допустим только при распознанной странице результатов без строк.
- Origin проверяется до navigation, credentials и cookies не попадают в screenshots, HTML dumps и logs.

### Frontend contract

- Frontend остается vanilla JavaScript с native ESM и без bundler/framework.
- `index.html` загружает `/app.js` через `type="module"`; новые модули импортируются относительными путями и должны обслуживаться static server.
- `app.js` отвечает за DOM state и wiring. Изолированные transport/formatting функции размещаются в `search-stream.js`, `result-formatting.js` и `supplier-search-summary.js`, если не требуют общего mutable UI state.
- Backend, supplier и `localStorage` data недоверенны. Предпочитайте `textContent`; при `innerHTML` экранируйте каждое значение и отдельно проверяйте URL.
- В `href` и result links допускаются только `http:`/`https:`. Inline event handlers, `eval` и `new Function` запрещены.
- Password/token нельзя сохранять в `localStorage`. Поврежденное persisted UI state должно безопасно сбрасываться.
- Custom SSE parser сейчас сохраняет EventSource-like callbacks и разделитель `\n\n`. Не меняйте parsing semantics без синхронного browser regression-теста.
- Не разделяйте tabs/results/filter blocks механически: они используют общий mutable state. Сначала определите четкий state boundary, иначе callback plumbing увеличит риск regressions.

### Зависимости и runtime

- Целевой runtime: Node.js 26. TypeScript запускается через native type stripping без `--experimental-strip-types`.
- Package manager: `pnpm`; `pnpm-lock.yaml` является обязательным источником воспроизводимой установки.
- Не редактируйте lockfile вручную. После изменения dependency используйте `pnpm`, фиксируйте точную совместимую версию и объясняйте необходимость.
- Сначала проверяйте возможность использовать Node.js standard library. Не добавляйте dependency для простого parsing, timeout, URL validation или atomic filesystem operation.
- После изменения production dependencies обязательно выполняйте `pnpm audit --prod`.
- Не добавляйте фиктивную build-команду: проект не использует bundler и отдельную production build.

### Обязательный порядок работы

1. Прочитать документы, связанные source files, все usages и существующие tests.
2. Воспроизвести проблему локально или через безопасный public endpoint. Для live supplier не выводить secrets и raw payload.
3. Сверить реальный ответ с официальной документацией. Если они различаются, поддерживать только подтвержденные формы и описать расхождение здесь.
4. Добавить deterministic regression test без обращения к реальному supplier.
5. Внести минимальное production-изменение.
6. Выполнить targeted test и typecheck.
7. Выполнить полный набор проверок.
8. Перепроверить diff на debug code, secrets, local absolute paths, mocks, `TODO/FIXME`, dead imports и случайные изменения API.

Обязательные команды:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node --check src/frontend/app.js
node --check src/frontend/result-formatting.js
node --check src/frontend/search-stream.js
node --check src/frontend/supplier-search-summary.js
git diff --check
```

Если изменялись production dependencies, дополнительно:

```sh
pnpm audit --prod
```

Live supplier check запускается только при явном запросе и наличии безопасно настроенных credentials. Не помещайте secrets в command history, test fixtures, logs или итоговый отчет. Если live check невозможен, перечислите непроверенные integrations и точный manual scenario.

### Критерии готовности правки

Правка не завершена, пока:

- typecheck и полный test suite не проходят;
- измененные frontend modules не проходят `node --check`;
- abort, timeout и cleanup не проверены для затронутого async path;
- новая ошибка не раскрывает private details;
- нет implicit mock/fake fallback и ложного empty success;
- state write не может пережить logout или смену credentials;
- HTTP/SSE/data contracts либо сохранены, либо изменение явно согласовано и покрыто тестами;
- README и `.env.example` обновлены при изменении runtime/deployment configuration;
- итоговый отчет не перечисляет реально не выполненные проверки как успешные.

## Batch Article Audit

With the server running, audit articles through the same SSE API used by the frontend:

```sh
pnpm audit:articles -- 90915YZZJ1 5050LR VAP-021-2375
pnpm audit:articles -- --file articles.txt
Get-Content articles.txt | pnpm audit:articles
pnpm audit:articles -- --sample
```

Use one article per line in an input file; blank lines and `#` comments are ignored. Run
`pnpm audit:articles -- --help` for server URL, supplier, concurrency, timeout, and output
options. Each run creates `article-audit-reports/<timestamp>/report.md` and `report.json`
relative to the directory where the command is started. A failed article makes the command
exit with code `2`; command/configuration failures use code `1`.

## Rossko SOAP Diagnostic

`rossko:search` is a standalone diagnostic utility for the official Rossko SOAP API.
It does not use the browser session integration, normalize results, or persist credentials.
It prints the complete SOAP XML response, including all product, stock, and cross fields
returned by Rossko.

Set keys only in the current shell or a secret manager. Do not place them in `.env.example`
or the repository:

```powershell
$env:ROSSKO_KEY1 = "..."
$env:ROSSKO_KEY2 = "..."
pnpm rossko:search -- --checkout
```

`--checkout` calls `GetCheckoutDetails`. From its response, use an account-available
`delivery_id` and, unless the delivery method is pickup, an `address_id` for the search:

```powershell
pnpm rossko:search -- 90915YZZJ1 --delivery-id "..." --address-id "..."
```

Alternatively, set `ROSSKO_DELIVERY_ID` and `ROSSKO_ADDRESS_ID`; then `pnpm rossko:search`
prompts only for the article. The SOAP API has a 300 requests/minute and 100,000 requests/day
limit, and returns at most 80 product cards and 80 crosses per product.

## Production

- Use Node.js 26 and install dependencies from `pnpm-lock.yaml` with `pnpm install --frozen-lockfile`.
- Run `pnpm exec playwright install chromium` when no system Chrome or Edge path is configured.
- Set `STATE_DIR` to a directory outside the application checkout. Restrict it to the dedicated service account because it contains supplier cookies, tokens, and optionally encrypted credentials.
- Set `SUPPLIER_CREDENTIALS_ENCRYPTION_KEY` from the deployment secret manager to a base64-encoded random 32-byte key. Do not put the key in the checkout or `STATE_DIR`; losing it requires restoring the original key or moving the unreadable credential file aside and authorizing suppliers again.
- Log in to Rossko from the supplier settings using the business-account login and password.
- Terminate TLS and require authentication at the reverse proxy before exposing `/api/*`.
- Keep the service bound to loopback and proxy only from a trusted local endpoint.
- Pass supplier credentials and API keys through environment variables or the runtime authorization UI. Do not store them in files in the checkout.
- Armtek stores API-discovered `VKORG` and `KUNNR_RG` in `STATE_DIR/armtek-api-account-state.json`, bound to a hash of the active login and protected with mode `0600`. Explicit `ARMTEK_VKORG` and `ARMTEK_KUNNR_RG` take precedence.
- Armtek uses only its WebService API for authorization and search. API failures are reported as Armtek errors; the service does not query ETP or use a browser-session fallback.
- PartKOM uses only the official Web Services v4 API with Basic authentication. Credentials entered in supplier settings use the common encrypted credential store when its key is configured; there is no browser-session fallback.
- PartKOM Web Services access must allow the server's public IP address. An API `Wrong IP address` response is shown as a safe configuration error without exposing credentials or the upstream payload.
- PartKOM documents successful responses as JSON strings without guaranteeing an HTTP media type. Responses remain size-bounded and must parse as JSON, but a valid JSON body is accepted even when its `Content-Type` is non-standard.
- Current PartKOM responses may wrap the documented collection in `{ success: true, data: [...] }`; the integration validates and unwraps this envelope before normalizing brands or offers.
- STParts uses ABCP `user/info` for session checks and combines up to 100 brand/article pairs in each `search/batch` request. Batch search excludes online stocks by ABCP design; successful searches are cached in memory for one minute to reduce repeated API usage.

Copy the variable names from `.env.example` into the server's secret manager or service environment. The application does not load `.env` files itself.

## Encrypted Supplier Credentials

Supplier session artifacts and supplier credentials are stored separately:

- supplier cookies, browser storage state, and API tokens use supplier-specific files in `STATE_DIR`;
- login/password pairs successfully verified through the runtime authorization UI use the shared `STATE_DIR/supplier-credentials.enc.json` file;
- the credential file contains only an AES-256-GCM envelope with a random IV, ciphertext, and authentication tag;
- `SUPPLIER_CREDENTIALS_ENCRYPTION_KEY` is never written to `STATE_DIR` and must be supplied independently by the deployment secret manager or service environment.

Create `STATE_DIR` outside the application checkout and restrict it to the service account. For example:

```sh
install -d -o <service-user> -g <service-group> -m 0700 /var/lib/autoservice-aggregator
```

Generate one persistent 32-byte master key encoded as Base64:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store the generated value in the deployment secret manager. The application environment must contain:

```text
NODE_ENV=production
STATE_DIR=/var/lib/autoservice-aggregator
SUPPLIER_CREDENTIALS_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

Do not commit the value, put it in `.env.example`, log it, or store it inside `STATE_DIR`. A systemd `EnvironmentFile` containing the key must be owned by root and have mode `0600`. The application does not parse `.env` files by itself.

After the key is configured, authorize each runtime-configured supplier once through the application settings. A successful authorization atomically creates or updates `supplier-credentials.enc.json` with mode `0600`. Password whitespace is preserved. Credentials already supplied directly through the service environment, such as Armtek or STParts API credentials, remain available after restart without being copied from the environment into this file.

On restart, the application loads the encrypted credentials using the same master key. Existing cookies or tokens are reused. A lightweight session validation that receives `SupplierAuthError` performs one bounded full authorization attempt with the stored credentials. Timeout and integration failures do not cause unbounded login retries. Explicit supplier logout invalidates active operations and removes that supplier's persisted session and credential entry.

The same `STATE_DIR` and master key must be retained across deployments and restarts. If the key is missing or does not authenticate an existing credential file, startup fails instead of ignoring the file. Restore the original key whenever possible. If the key is permanently lost, stop the service, move `supplier-credentials.enc.json` to a protected backup location, start the service with a new key, and authorize every supplier again. Do not delete unrelated supplier state files.

Check the encrypted file metadata without printing its contents:

```sh
stat -c '%A %a %U:%G %n' /var/lib/autoservice-aggregator/supplier-credentials.enc.json
```

Expected ownership is the service account and expected mode is `600`. Verify all sessions through the dedicated validation endpoint; this does not run a product search:

```sh
curl -fsS \
  -X POST \
  -H 'Content-Type: application/json' \
  --data '{"article":"90915YZZJ1","suppliers":["rossko","armtek","part-kom","stparts","motordetal","mladov"]}' \
  http://127.0.0.1:3000/api/suppliers/sessions/validate
```

Use the configured local port instead of `3000` when `PORT` is overridden. A result status of `connected` means validation or automatic recovery succeeded, `expired` means manual authorization is required, and `error` means validation was temporarily unavailable.

## Configuration Validation

Configuration is validated when backend modules are loaded. Invalid ports, timeouts, retry counts, supplier URLs, or production state paths stop startup with a configuration error instead of falling back to unsafe values.

- Supplier base URLs must use HTTPS, the documented supplier hostname, and the standard HTTPS port.
- In `NODE_ENV=production`, `STATE_DIR` is required, must be absolute, and must resolve outside the application checkout.
- Browser paths are supplier-specific. A browser path configured for one supplier is not reused by another supplier.
- Password values are not trimmed. Keep intentional leading or trailing whitespace in the secret value.
- Numeric defaults are documented in `.env.example`. Search and navigation timeouts are capped at 120 seconds, retry attempts at five, and retry or polling delays at bounded operation-specific values.

## Public Errors

API responses never include raw supplier payloads, internal URLs, local paths, or exception messages. Authorization request validation returns HTTP 400, rejected supplier credentials return 401, supplier integration failures return 502, supplier timeouts return 504, and unexpected internal failures return 500. Fatal SSE failures use the stable public message `Search failed`; supplier-specific search failures continue to use `supplier_status` events.

## External Request Bounds

Supplier HTTP requests use caller cancellation, bounded request deadlines, approved HTTPS origins, contract-appropriate response validation, and response-size limits. JSON media types are checked when the supplier guarantees them; the documented PartKOM JSON-string exception is parsed from a bounded body. Authorization work is cancelled when the client disconnects and has an overall deadline configured by `SUPPLIER_AUTHORIZATION_TIMEOUT_MS`. Shared HTTP agents and browser resources are closed during service shutdown.

## Session Lifecycle

Persisted supplier state is replaced atomically using restrictive directory and file permissions. Logout invalidates and aborts active work before deleting state, and late operations cannot restore an older session. Authorization is exclusive per supplier: existing searches are cancelled and new searches are rejected until the authorization attempt finishes, preventing old credentials or browser state from overwriting a newly established session.

Session validation uses a dedicated lightweight account/session check for every supplier. It does not execute a product search or emit and discard offers.

Validation runs without a success/progress modal. If a supplier reports an expired session, the backend makes one bounded automatic authorization attempt with stored credentials. The UI interrupts the search only when recovery fails or validation is unavailable.

## Empty Results

An empty successful search is returned only when the supplier provides a valid no-offer response. Supplier error flags, API error envelopes, malformed result groups, unrecognized empty HTML, and wholly invalid normalized output are reported as supplier integration errors rather than being converted to an empty result set.
