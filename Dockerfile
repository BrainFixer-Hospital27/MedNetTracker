# =====================================================================
#  MedNet Tracker
#
#  Образ намеренно простой: приложение целиком на JavaScript, сборщика
#  нет, нативных модулей нет. Ставим зависимости, копируем исходники -
#  и всё. Многоступенчатая сборка тут не нужна: компилировать нечего.
#
#  База нужна версии 22.5 или новее: в ней появился встроенный модуль
#  node:sqlite, на котором работает хранилище.
# =====================================================================
FROM node:22-alpine

# Часовой пояс. Без него контейнер живёт по UTC, и отметки времени
# в журнале изменений разойдутся с местными на несколько часов.
ARG TZ=Europe/Moscow
ENV TZ=${TZ}
RUN apk add --no-cache tzdata tini \
 && cp /usr/share/zoneinfo/${TZ} /etc/localtime \
 && echo ${TZ} > /etc/timezone

WORKDIR /app

# Слой с зависимостями кешируется отдельно: пересобирается только
# когда меняется package.json, а не при каждой правке кода
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null \
 || npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Каталог данных: база, планы этажей. Монтируется томом, поэтому
# заранее отдаём его пользователю node - иначе процесс без прав root
# не сможет туда писать.
RUN mkdir -p /app/data/svg && chown -R node:node /app/data

# Работаем не от root: если приложение когда-нибудь скомпрометируют,
# злоумышленник не получит прав в контейнере
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

# tini как первый процесс: корректно передаёт сигналы и не оставляет
# зомби-процессов при остановке контейнера
ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
