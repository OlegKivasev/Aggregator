"""Проверка доступа к Part-Kom WebServices REST v4."""

import getpass
import sys

import requests
from requests.auth import HTTPBasicAuth
from requests.exceptions import RequestException


API_URL = "https://ws.part-kom.ru/v4/search/offers"


def main() -> None:
    article = input("Артикул для поиска: ").strip()
    login = input("Логин Part-Kom: ").strip()
    password = getpass.getpass("Пароль Part-Kom: ")

    if not article or not login or not password:
        sys.exit("Артикул, логин и пароль обязательны.")

    try:
        response = requests.get(
            API_URL,
            auth=HTTPBasicAuth(login, password),
            params={"number": article},
            timeout=(10, 30),
            headers={"Accept": "application/json"},
        )
    except RequestException as error:
        sys.exit(f"Ошибка соединения: {error}")

    print(f"HTTP status: {response.status_code}")

    try:
        payload = response.json()
    except ValueError:
        payload = response.text[:500]

    error_message = payload.get("message", "") if isinstance(payload, dict) else ""

    if response.status_code == 401:
        print("Авторизация не прошла: проверьте логин, пароль и разрешенный IP.")
    elif error_message == "Wrong IP address: 127.0.0.1":
        print("API доступен, но Part-Kom отклонил IP-адрес запроса.")
        print("Попросите Part-Kom разрешить внешний IP VPN, а не 127.0.0.1.")
    elif response.status_code in (200, 400, 405, 422):
        print("Учетные данные приняты. API доступен.")
        print(payload)
    else:
        print("Неожиданный ответ API:")
        print(payload)


if __name__ == "__main__":
    main()
