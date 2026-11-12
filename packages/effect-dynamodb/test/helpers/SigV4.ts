/**
 * A check of the SigV4 signature on a request the SDK sent to a
 * `localServer`, so a test can tell which secret signed it, not only which key
 * id and session token it names.
 */

import { createHash, createHmac } from "node:crypto"
import type { SeenRequest } from "./LocalServer.js"

const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const hmac = (key: string | Buffer, text: string) => createHmac("sha256", key).update(text).digest()

/** Whether `request` carries a valid SigV4 signature made with `secret`. */
export const signedWith = (request: SeenRequest, secret: string): boolean => {
  const match = AUTHORIZATION.exec(String(request.headers.authorization))
  if (match === null) return false
  const [, , day, region, service, signedHeaders, signature] =
    match as unknown as ReadonlyArray<string>
  const headers = signedHeaders!
    .split(";")
    .map((name) => `${name}:${String(request.headers[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("")
  const payload = String(request.headers["x-amz-content-sha256"] ?? sha256(request.body))
  const canonical = ["POST", "/", "", headers, signedHeaders, payload].join("\n")
  const scope = `${day}/${region}/${service}/aws4_request`
  const toSign = [
    "AWS4-HMAC-SHA256",
    String(request.headers["x-amz-date"]),
    scope,
    sha256(canonical),
  ]
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day!), region!), service!), "aws4_request")
  return hmac(key, toSign.join("\n")).toString("hex") === signature
}

export const keyIdOf = (request: SeenRequest) =>
  AUTHORIZATION.exec(String(request.headers.authorization))?.[1]

/** Each request's key id, its session token, and whether `secrets[i]` signed it. */
export const wire = (requests: ReadonlyArray<SeenRequest>, secrets: ReadonlyArray<string>) =>
  requests.map((request, i) => [
    keyIdOf(request),
    request.headers["x-amz-security-token"],
    signedWith(request, secrets[i] ?? ""),
  ])
