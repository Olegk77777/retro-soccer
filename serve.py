#!/usr/bin/env python3
# Локальный дев-сервер. То же, что `python3 -m http.server`, но с запретом кэширования:
# браузер каждый раз берёт свежие файлы, и правки видны сразу без «жёсткого обновления».
import http.server

PORT = 8123


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    print(f'Дев-сервер запущен: http://localhost:{PORT} (кэш выключен)')
    try:
        http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler).serve_forever()
    except KeyboardInterrupt:
        print('\nСервер остановлен')
