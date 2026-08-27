# Local TLS test certificates

Self-signed material for the Docker TLS fixtures only (`single-tls`,
`cluster-tls`, `sentinel-tls`, `postgres-tls`). Committed deliberately, and
sanctioned by `docs/RULES.md`: it grants access to nothing, is never shipped
(`package.json` `files` excludes `test/`), and is regenerable at any time.

`redis.key` is a private key, so a repository secret scanner will flag it.
That finding is expected and is not a leak. Do not replace these with anything
issued by a real CA, and do not reuse them outside these fixtures.

The fixtures run with certificate verification disabled because the
certificate is self-signed. Verified TLS — `rejectUnauthorized: true` with a
real CA — is covered by the AWS MemoryDB deployment path instead.
