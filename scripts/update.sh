#!/usr/bin/env bash
#
# Обновление развёрнутого приложения.
#
#   ./scripts/update.sh              обновить из репозитория
#   ./scripts/update.sh --no-pull    пересобрать из того, что уже лежит
#
# Порядок такой: снять резервную копию, забрать изменения, пересобрать
# образ, поднять контейнер, дождаться готовности. Если что-то пойдёт не
# так на середине, база останется нетронутой - она в примонтированном
# каталоге, а не внутри образа.

set -euo pipefail

cd "$(dirname "$0")/.."
SERVICE=mednet

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n\n' "$1"; exit 1; }

# --- Проверки перед началом -------------------------------------------
command -v docker >/dev/null || fail "docker не найден"
docker compose version >/dev/null 2>&1 || fail "нужен docker compose версии 2"
[ -f docker-compose.yml ] || fail "docker-compose.yml не найден: запускайте из каталога проекта"

# Приложение живёт в сетевом пространстве контейнера WireGuard. Если тот
# лежит, пересборка пройдёт, а запуск сорвётся с невнятной ошибкой.
NETMODE=$(grep -oP 'network_mode:\s*"?container:\K[^"]+' docker-compose.yml || true)
if [ -n "$NETMODE" ]; then
  docker inspect -f '{{.State.Running}}' "$NETMODE" 2>/dev/null | grep -q true \
    || fail "контейнер $NETMODE не запущен, а приложение использует его сеть.
Сначала поднимите его, затем повторите обновление."
fi

# --- 1. Резервная копия -----------------------------------------------
say "1. Резервная копия базы"
if docker compose ps --status running --services 2>/dev/null | grep -qx "$SERVICE"; then
  docker compose exec -T "$SERVICE" npm run backup 2>&1 | grep -E "Снимок|КБ" || true
else
  echo "  контейнер не запущен, копировать нечего"
fi

# --- 2. Отметка для отката --------------------------------------------
say "2. Отметка текущей сборки"
if docker image inspect mednet-tracker:latest >/dev/null 2>&1; then
  PREV="mednet-tracker:previous"
  docker tag mednet-tracker:latest "$PREV"
  echo "  предыдущий образ сохранён как $PREV"
else
  echo "  предыдущего образа нет, это первая сборка"
fi

# --- 3. Изменения из репозитория --------------------------------------
if [ "${1:-}" != "--no-pull" ]; then
  say "3. Получение изменений"
  if [ -d .git ]; then
    git pull --ff-only
  else
    echo "  каталог не под управлением git, пропускаем"
  fi
else
  say "3. Получение изменений пропущено (--no-pull)"
fi

# --- 4. Сборка и запуск -----------------------------------------------
say "4. Сборка образа"
docker compose build

say "5. Перезапуск контейнера"
docker compose up -d

# --- 6. Ожидание готовности -------------------------------------------
say "6. Проверка готовности"
for i in $(seq 1 30); do
  STATE=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$SERVICE" 2>/dev/null || echo "нет")
  case "$STATE" in
    healthy|running)
      echo "  состояние: $STATE"
      break ;;
    unhealthy|exited|dead)
      docker compose logs --tail=40 "$SERVICE"
      fail "контейнер в состоянии «$STATE». Откат: docker tag mednet-tracker:previous mednet-tracker:latest && docker compose up -d" ;;
    *)
      printf '.'; sleep 2 ;;
  esac
done
echo

# --- 7. Уборка --------------------------------------------------------
# Каждая пересборка оставляет неиспользуемый образ. На диске в 25 ГБ
# они накапливаются незаметно и однажды заканчиваются в самый неудобный
# момент. Метку previous при этом не трогаем - она нужна для отката.
say "7. Уборка неиспользуемых образов"
FREED=$(docker image prune -f 2>/dev/null | grep -oP 'Total reclaimed space: \K.*' || echo "0B")
echo "  освобождено: $FREED"
echo "  занято docker: $(docker system df --format '{{.Size}}' 2>/dev/null | head -1)"

say "Готово"
docker compose ps
echo
echo "  Журнал:  docker compose logs -f $SERVICE"
echo "  Откат:   docker tag mednet-tracker:previous mednet-tracker:latest && docker compose up -d"
echo
