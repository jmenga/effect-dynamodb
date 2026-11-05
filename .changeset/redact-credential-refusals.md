---
"effect-dynamodb": patch
---

Keep AWS's reply to a signature or credential refusal out of errors. The reply can quote the signed request, including the caller's session token, and a tagged error's `cause` is rendered by tracers, loggers and `JSON.stringify`. The DynamoDB and DynamoDB Streams clients now give such a `cause` a fixed `message` and `stack`, keeping its `name`, `$fault`, `$metadata` and prototype. That covers `InvalidSignatureException`, `SignatureDoesNotMatch`, `IncompleteSignatureException`, `MissingAuthenticationTokenException`, `UnrecognizedClientException`, `InvalidClientTokenId`, `ExpiredTokenException`, `ExpiredToken` and `RequestExpired`, and any other error whose text mentions `x-amz-security-token`. Code that reads such a `cause`'s `message` now gets the fixed text; every other error's `cause` is unchanged.
