# Local TLS test certificates

Self-signed material for the Docker TLS fixtures only (`single-tls`,
`cluster-tls`, `sentinel-tls`, `postgres-tls`). Committed deliberately, and
sanctioned by `docs/RULES.md`: it grants access to nothing, is never shipped
(`package.json` `files` excludes `test/`), and is regenerable at any time.

`redis.key` is a private key, so a repository secret scanner will flag it.
That finding is expected and is not a leak. Do not replace these with anything
issued by a real CA, and do not reuse them outside these fixtures.

The Docker topology fixtures disable certificate verification because the
certificate is self-signed. The dedicated PostgreSQL TLS integration test
passes `ca.crt` through Node-RED credentials and verifies it with
`rejectUnauthorized: true`; AWS MemoryDB covers the same verified path for
Redis.
