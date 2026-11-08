# ADR-0257 — the Laravel AI SDK, pinned by composer.lock and vendored at IMAGE BUILD.
# At test time the container has no route out: the harness runs it on an `--internal`
# docker network whose only reachable host is the gateway.
#
# composer:2 and php:8.4-cli-alpine, each pinned by its multi-arch index digest.
FROM composer:2@sha256:8de2184c6de224f4689e8f80ed5f5edaf0030b6b8b7839a22a2bcb6722ac87d0 AS deps
WORKDIR /client
COPY composer.json composer.lock ./
# `extra_ca` is an OPTIONAL build secret for a builder behind a TLS-intercepting proxy
# (CI does not pass it). It lives only in this discarded stage.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export COMPOSER_CAFILE=/run/secrets/extra_ca; fi; \
    composer install --no-dev --no-interaction --no-progress --no-scripts --no-plugins \
      --prefer-dist --ignore-platform-req=ext-* --classmap-authoritative

FROM php:8.4-cli-alpine@sha256:b58f9a66fe9734250fc42818edc77d679a071a83cefdcda87b21b668a91094b1
WORKDIR /client
COPY --from=deps /client/vendor ./vendor
COPY composer.json run.php ./
# The root filesystem is read-only at test time; Laravel's caches and logs go to the tmpfs.
ENV APP_PACKAGES_CACHE=/tmp/packages.php APP_SERVICES_CACHE=/tmp/services.php \
    APP_CONFIG_CACHE=/tmp/config.php APP_ROUTES_CACHE=/tmp/routes.php APP_EVENTS_CACHE=/tmp/events.php \
    LOG_CHANNEL=stderr
USER www-data
ENTRYPOINT ["php", "-d", "memory_limit=512M", "run.php"]
