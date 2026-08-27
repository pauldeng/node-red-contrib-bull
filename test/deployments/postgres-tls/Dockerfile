# Bakes the repo's shared self-signed TLS fixture (test/deployments/tls-certs)
# into the image with the ownership PostgreSQL demands. A bind-mounted repo
# file keeps its host ownership (uid 1000 here), and PostgreSQL refuses to
# start unless its private key is owned by the server user and not
# group/world readable, so COPY followed by a plain RUN chown/chmod bakes
# the right owner and mode in at build time instead. (Not COPY's own
# --chown/--chmod flags: those need BuildKit, which is not guaranteed
# available -- e.g. no buildx plugin -- while RUN chown/chmod works on the
# legacy builder too.)
#
# The right uid is per image variant, verified rather than assumed:
#   docker run --rm postgres:17-alpine id postgres  -> uid=70(postgres)
#   docker run --rm postgres:17 id postgres         -> uid=999(postgres)
# This Dockerfile targets postgres:17-alpine (uid 70), matching the
# unencrypted PostgreSQL fixture's image (test/integration-postgres.test.js).
FROM postgres:17-alpine

COPY tls-certs/redis.key /var/lib/postgresql/tls/server.key
COPY tls-certs/redis.crt /var/lib/postgresql/tls/server.crt
RUN chown postgres:postgres /var/lib/postgresql/tls/server.key /var/lib/postgresql/tls/server.crt \
    && chmod 600 /var/lib/postgresql/tls/server.key \
    && chmod 644 /var/lib/postgresql/tls/server.crt
