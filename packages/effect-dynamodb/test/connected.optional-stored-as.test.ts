/**
 * A date the model declares optional whose storage `DynamoModel.configure` sets stays optional and
 * is stored in that form, against DynamoDB Local. The suite is `helpers/OptionalStoredAs.ts`, on
 * the harness in `helpers/ConnectedHarness.ts`; recording-table twin: `OptionalStoredAs.test.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { describe } from "vitest"
import { connectedHarness, dynamoAvailable } from "./helpers/ConnectedHarness.js"
import { suite } from "./helpers/OptionalStoredAs.js"

suite(connectedHarness("optional-stored-as"), (await dynamoAvailable()) ? describe : describe.skip)
