# CDN Benchmark

Инструменты для сравнения производительности загрузки изображений через CDN vs напрямую с origin.

## Установка

```bash
npm install
npx playwright install-deps && npx playwright install
```

### Windows

1. Установите Node.js LTS: https://nodejs.org/en/download
2. Откройте PowerShell в папке проекта:

```powershell
npm install
npx playwright install-deps && npx playwright install
node bin/bench.js run
```

---

## Скрипты

### 1. cdn-compare.sh — curl-бенчмарк одного изображения

Простой скрипт на bash, измеряет чистое сетевое время загрузки одного изображения через curl.

**Алгоритм:**

1. Берёт два URL: CDN (`media.mamba.ru`) и origin (`photo*.wambacdn.net`)
2. Делает N запросов (по умолчанию 100) к каждому URL
3. Для каждого запроса curl измеряет:
   - `time_total` — полное время загрузки
   - `time_starttransfer` (TTFB) — время до первого байта
   - `time_namelookup`, `time_connect`, `time_appconnect` — DNS, TCP, TLS
4. Агрегирует: mean, p50, p95, p99, max
5. Выводит improvement CDN vs origin

**Запуск:**

```bash
./bin/cdn-compare.sh
```

**Результат:** `cdn.csv`, `origin.csv` + summary в консоль

**Особенности:**

- Чистое сетевое время без overhead браузера
- Показывает максимальный теоретический выигрыш CDN
- Один файл — видно влияние bandwidth

---

### 2. bench.js — браузерный бенчмарк страницы с изображениями

Node.js скрипт с Playwright, измеряет время загрузки всех изображений на странице в реальном браузере.

**Алгоритм:**

1. **Warmup** (2 прогона): загружает все страницы для прогрева DNS/TCP/CDN edge cache
2. **Основной цикл** (для каждой страницы × repeats):
   - Рандомизирует порядок вариантов (origin/cdn) для устранения bias
   - Создаёт новый browser context (изоляция)
   - Отключает браузерный кэш через CDP
   - Загружает страницу, ждёт `domcontentloaded`
   - Auto-scroll для lazy-load изображений
   - Собирает Resource Timing API для всех `<img>`:
     - `responseEnd` — когда последний байт получен
     - `duration` — время загрузки каждой картинки
   - Вычисляет метрики:
     - `images_ms` = lastImageEnd - firstImageStart (чистое время на картинки)
     - `avg_img_ms` = среднее время на одну картинку
3. **Агрегация**: median, p90, stddev для origin и cdn
4. **Отчёт**: CSV с одной строкой на прогон + итоговая строка TOTAL
5. **Upload**: опционально загружает CSV в S3

**Запуск:**

```bash
# Полный бенчмарк (3 страницы × 3 повтора × 2 варианта)
node bin/bench.js run

# С параметрами
node bin/bench.js run --repeats 10

# Бенчмарк одного изображения
node bin/bench.js image https://media.mamba.ru/path/to/image.jpg

# Бенчмарк списка URL
node bin/bench.js urls --urls https://example.com/urls.txt
```

**Основные опции:**

| Опция | Default | Описание |
|-------|---------|----------|
| `--repeats` | 3 | Количество повторов на вариант |
| `--base-url` | `https://cdntest.wamba.com` | Базовый URL |
| `--browser` | chromium | Браузер (chromium/firefox/webkit) |
| `--headless` | true | Headless режим |
| `--delay-ms` | 1000 | Задержка между прогонами |
| `--image-hosts` | - | Фильтр хостов изображений (wildcard `*`) |
| `--verbose` | true | Подробный вывод |
| `--s3-bucket` | - | S3 bucket для upload |

**Формат результата:** `results/<timestamp>.csv`

```csv
timestamp,page_id,variant,run,images_ms,avg_img_ms,ttfb_ms,...
2026-01-24T15:14:48Z,page1,origin,1,404,146,87,...
2026-01-24T15:14:50Z,page1,cdn,1,183,119,55,...
...
2026-01-24T15:15:04Z,TOTAL,-,-,,,,...,281,429,116,224,420,124,20.5,2.1
```

Колонки TOTAL: `origin_median`, `origin_p90`, `origin_avg_img`, `cdn_median`, `cdn_p90`, `cdn_avg_img`, `improvement_%`, `improvement_p90_%`

В CSV также есть `city` (указанный в CLI/конфиге) и `city_geo` (определённый по IP).

---

## Сравнение скриптов

| | cdn-compare.sh | bench.js |
|---|---|---|
| **Инструмент** | curl | Playwright (Chromium) |
| **Что измеряет** | 1 изображение | Страница с 18 картинками |
| **Метрика** | Сетевое время curl | Resource Timing API браузера |
| **Параллелизм** | Нет | Да (как в реальном браузере) |
| **Типичный результат** | CDN +80-90% faster | CDN +10-30% faster |
| **Применение** | Оценка сети/CDN | Реальный UX пользователя |

---

## Конфигурация

`bench.config.json`:

```json
{
  "s3_bucket": "bucket-name",
  "s3_endpoint": "storage.yandexcloud.net",
  "s3_access_key_id": "...",
  "s3_secret_access_key": "...",
  "city": "Moscow"
}
```

Для Yandex Object Storage: `s3_endpoint=storage.yandexcloud.net`, регион определяется автоматически.

---

## Структура проекта

```
bin/
  bench.js          — CLI (node)
  cdn-compare.sh    — curl benchmark (bash)
lib/
  browser.js        — Playwright, Resource Timing API
  report.js         — генерация CSV
  utils.js          — статистика (median, percentile, stddev)
  http.js           — HTTP запросы, S3 upload
  geo.js            — определение города по IP
results/            — результаты бенчмарков
```
