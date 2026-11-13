/**
 * The mark an outbox item carries from 1.41.0 (`__edd_rm__`, #237), as the library composes it
 * (`ProjectionEngine.outboxMark`): the read model's tag, then a hash of the projection and the
 * event the item's own attributes name.
 */

import { outboxMark, readModelTag } from "../../src/internal/ProjectionEngine.js"
import { layoutTag, projectionLayoutsOf } from "../../src/internal/TransactableOps.js"

type Stored = Record<string, { readonly S?: string; readonly N?: string } | undefined>

/** The mark of `item`, written by the read model's projection at `layout` (its only one, by default). */
export const markOf = (readModel: object, item: Stored, layout = 0): string =>
  outboxMark(readModelTag(readModel)!, layoutTag(projectionLayoutsOf(readModel)![layout]!), {
    source: item.source!.S!,
    streamId: item.streamId!.S!,
    version: Number(item.version!.N),
  })

/** The read model's tag a mark begins with. */
export const tagOf = (readModel: object): string => readModelTag(readModel)!
