# Binary attachment transport

The Gitea v1.23.4 API attachment detail route returns JSON metadata.
Its response is never interpreted as file content.

The versioned upstream [web router](https://github.com/go-gitea/gitea/blob/v1.23.4/routers/web/web.go#L755) registers GET `/attachments/{uuid}`.
The [attachment handler](https://github.com/go-gitea/gitea/blob/v1.23.4/routers/web/repo/attachment.go#L82) resolves that UUID, checks repository access and serves stored bytes.
Direct object storage can instead redirect.
The CLI uses this separate same-origin web route with the UUID from validated API metadata and refuses all redirects.
It ignores metadata-supplied download origins.

This contract is derived from versioned source.
The synthetic fixture contains independently authored bytes `[0,255,13,10,42,128,99]`, which the fake service checks on multipart receipt and returns for binary verification.
The tests verify the SHA-256, byte length and content type through the installed CLI and, when selected, the real local Artium managed input and artifact interfaces.
They establish offline behavior only.
Private-token authentication on the web route, object storage compatibility, native Windows and live binary transfer remain pending.

The separately approved commissioning procedure remains unexecuted.
A future exact sandbox authorization must identify an existing benign attachment, its repository, tag, ID, UUID, basename, type, independently known byte length and original-file SHA-256.
With a bound origin and protected credential reference, read metadata, verify that identity and download once into a private temporary destination using a 10-second deadline and independent 1 MB response ceiling.
Compare exact bytes, digest and type, recording route and status without credentials.
Repeat through the approved deployed Artium managed artifact interface, verify custody and the same bytes, then dispose of both outputs.
Record each channel independently; unavailable channels remain pending.
Approval of the procedure for synthetic fixture design does not authorize live execution.
