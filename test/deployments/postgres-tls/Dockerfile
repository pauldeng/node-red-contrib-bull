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
#   docker run --rm postgres:18-alpine id postgres  -> uid=70(postgres)
#   docker run --rm postgres:latest id postgres     -> uid=999(postgres)
# This Dockerfile targets postgres:18-alpine (uid 70), matching the
# unencrypted PostgreSQL fixture's image (test/integration-postgres.test.js).
# The certificates live in /etc/postgresql/tls, NOT under
# /var/lib/postgresql. PostgreSQL 18's image declares an anonymous volume over
# the whole of /var/lib/postgresql (17 declared only
# /var/lib/postgresql/data), so anything baked into that tree is masked at
# runtime -- the server then cannot read ssl_cert_file and refuses to start,
# which surfaces as a readiness timeout rather than as a missing file.
FROM postgres:18-alpine

COPY tls-certs/redis.key /etc/postgresql/tls/server.key
COPY tls-certs/redis.crt /etc/postgresql/tls/server.crt
RUN chown postgres:postgres /etc/postgresql/tls/server.key /etc/postgresql/tls/server.crt \
    && chmod 600 /etc/postgresql/tls/server.key \
    && chmod 644 /etc/postgresql/tls/server.crt
