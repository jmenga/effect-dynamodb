/**
 * Entity-level refs name the referenced entity's key composite, a cascade stores what a put
 * stores, and every write keys the indexes a ref's id is a composite of as a put keys them,
 * against DynamoDB Local. The suites are `helpers/EntityRefKeys.ts`, `helpers/EntityRefCascade.ts`
 * and `helpers/EntityRefWrites.ts`, on the harness in `helpers/ConnectedHarness.ts`;
 * recording-table twin: `EntityRefKeys.test.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { describe } from "vitest"
import { connectedHarness, dynamoAvailable } from "./helpers/ConnectedHarness.js"
import { suite as cascadeSuite } from "./helpers/EntityRefCascade.js"
import { suite as keepSuite } from "./helpers/EntityRefKeep.js"
import { suite } from "./helpers/EntityRefKeys.js"
import { suite as operandsSuite } from "./helpers/EntityRefOperands.js"
import { suite as storedAsSuite } from "./helpers/EntityRefStoredAs.js"
import { suite as writesSuite } from "./helpers/EntityRefWrites.js"

const describeConnected = (await dynamoAvailable()) ? describe : describe.skip
const harness = connectedHarness("entity-ref-keys")

suite(harness, describeConnected)
cascadeSuite(harness, describeConnected)
writesSuite(harness, describeConnected)
keepSuite(harness, describeConnected)
operandsSuite(harness, describeConnected)
storedAsSuite(harness, describeConnected)
