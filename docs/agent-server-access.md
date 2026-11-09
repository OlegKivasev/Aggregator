# Доступ агента к серверу агрегатора

Инструкция описывает проверенное подключение из Codex на том же Windows-компьютере, где открыт MobaXterm. Локальный туннель на `127.0.0.1` не доступен агенту, который выполняется на другом компьютере или удалённом runner.

Прямое SSH-подключение из рабочего окружения Codex истекало по тайм-ауту; проверенный путь — через локальный MobaXterm-туннель.

## 1. Запустить туннель в MobaXterm

Откройте **Tunneling → New SSH tunnel → Local port forwarding** и задайте:

| Поле | Значение |
| --- | --- |
| Forwarded port | `22422` |
| Remote server | `127.0.0.1` |
| Remote port | `22` |
| SSH server | `91.184.246.232` |
| SSH login | `root` |
| SSH port | `22` |

Сохраните правило и запустите туннель. Root-вход используется только MobaXterm для SSH-перенаправления; пароль и root-ключ агенту не передаются.

Проверить локальный порт из PowerShell:

```powershell
Test-NetConnection 127.0.0.1 -Port 22422 -InformationLevel Quiet
```

Ожидаемый результат — `True`.

## 2. Создать отдельный ключ на этом компьютере

В PowerShell задайте уникальное имя пользователя и создайте временную пару ключей:

```powershell
$account = 'codex-audit-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$keyDir = Join-Path $env:TEMP $account
New-Item -ItemType Directory -Path $keyDir | Out-Null
$keyPath = Join-Path $keyDir 'id_ed25519'
ssh-keygen -q -t ed25519 -N "" -C $account -f $keyPath
Get-Content "$keyPath.pub"
```

Скопируйте только вывод `.pub`. Закрытый файл `id_ed25519` остаётся на этом компьютере; не вставляйте его в чат и не помещайте в репозиторий. В этой схеме ключ без парольной фразы лежит во временной папке и используется только для отдельной учётки без `sudo`.
Запишите значение `$account`: оно понадобится в root-сессии и при очистке. Выполняйте PowerShell-шаги в одном окне, чтобы переменные `$account`, `$keyDir` и `$keyPath` сохранились.

## 3. Создать ограниченную учётку на сервере

В открытой MobaXterm root-сессии подставьте то же имя из `$account` вместо `ACCOUNT`:

```bash
account=ACCOUNT
adduser --disabled-password --gecos "" "$account"
group=$(id -gn "$account")
home=$(getent passwd "$account" | cut -d: -f6)
ssh_dir="$home/.ssh"
install -d -m 700 -o "$account" -g "$group" "$ssh_dir"
cat > "$ssh_dir/authorized_keys" <<'EOF'
restrict ssh-ed25519 ВСТАВЬТЕ_СЮДА_ОДНУ_СТРОКУ_ИЗ_id_ed25519.pub
EOF
chown "$account:$group" "$ssh_dir/authorized_keys"
chmod 600 "$ssh_dir/authorized_keys"
```

Перед строкой из `.pub` оставьте `restrict `. Не добавляйте учётку в `sudo` или группу `docker`: группа Docker фактически даёт root-доступ. Ключ `restrict` запрещает SSH-перенаправления, X11 и агентский forwarding.

Проверить установленный ключ:

```bash
ssh-keygen -lf "$ssh_dir/authorized_keys"
```

Отпечаток должен совпасть с результатом `ssh-keygen -lf "$keyPath.pub"` на Windows.

## 4. Проверить сервер и подключиться

Подлинный host key сервера проверен через root-сессию. Его отпечаток:

```text
SHA256:8wGC2JNUz8GjAp//yyzLrlTY+brg5LQwp1d80c6oLl4
```

Первое SSH-подключение из PowerShell:

```powershell
$knownHosts = Join-Path $env:TEMP ($account + '-known_hosts')
ssh -i $keyPath -p 22422 `
  -o KexAlgorithms=curve25519-sha256 `
  -o UserKnownHostsFile=$knownHosts `
  -o StrictHostKeyChecking=ask `
  -o IdentitiesOnly=yes `
  "$account@127.0.0.1" 'id -un'
```

На первом запросе SSH сравните показанный отпечаток с отпечатком выше и подтвердите только при совпадении. Ожидаемый вывод команды — имя временной учётки. Для следующих подключений используйте тот же `$keyPath`, `$knownHosts` и опцию `-o StrictHostKeyChecking=yes`.

Для Windows SSH-клиента нужен `KexAlgorithms=curve25519-sha256`: без него встроенный `ssh-keyscan` в этой сессии не смог обработать выбранный сервером алгоритм обмена ключами.

## 5. Границы доступа

- Агент подключается через `127.0.0.1:22422` и выполняет команды от временного пользователя, не от root.
- Учётка не имеет `sudo` и не входит в группу `docker`.
- Каталог `/root/Aggregator` и `/etc/autoservice-aggregator/credentials.env` закрыты от этой учётки. Не открывайте секретный файл ради анализа; для доступа к коду используйте рабочую копию проекта или отдельно выдайте точечное чтение нужных файлов.
- Другой агент сможет использовать этот путь только если он работает на том же компьютере с активным MobaXterm-туннелем и имеет свой локальный закрытый ключ.

## 6. Удалить временный доступ после работы

В root-сессии MobaXterm удалите временную учётку и её домашнюю папку. Подставьте фактическое имя из шага 2; переменная `$account` может быть потеряна после переподключения:

```bash
deluser --remove-home ACCOUNT
```

Остановите туннель в менеджере MobaXterm. В PowerShell удалите закрытый ключ, публичную копию и временный файл доверенных host keys:

```powershell
Remove-Item -LiteralPath $keyPath, "$keyPath.pub", $knownHosts -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $keyDir -Force -ErrorAction SilentlyContinue
```

Справка MobaXterm по SSH-туннелям: [раздел SSH tunnelling](https://mobaxterm.mobatek.net/documentation.html).
