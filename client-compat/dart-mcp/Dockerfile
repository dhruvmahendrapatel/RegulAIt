# ADR-0257 — dart_mcp, pinned by pubspec.lock, fetched and COMPILED at IMAGE BUILD
# into a native executable. The runtime image holds that executable and the Dart
# runtime files only: no SDK, no pub cache, nothing to resolve at test time. The
# harness runs it on an `--internal` docker network whose only reachable host is
# the gateway.
#
# dart:3.9, pinned by its multi-arch index digest.
FROM dart:3.9@sha256:9db24325a8df958f4aa64e0880d8254ba304602c1d85ecee326b2c576883cc3a AS build
WORKDIR /client
COPY pubspec.yaml pubspec.lock ./
# `extra_ca` is an OPTIONAL build secret for a builder behind a TLS-intercepting proxy
# (CI does not pass it). It lives only in this discarded stage.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then cat /run/secrets/extra_ca >> /etc/ssl/certs/ca-certificates.crt; fi; \
    dart pub get --enforce-lockfile
COPY bin ./bin
RUN dart pub get --offline --enforce-lockfile && dart analyze --fatal-infos bin && dart compile exe bin/run.dart -o /client/run

FROM scratch
COPY --from=build /runtime/ /
COPY --from=build /client/run /client/run
USER 65534:65534
ENTRYPOINT ["/client/run"]
