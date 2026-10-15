---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Projection rows read through a `DynamoModel.configure`d read model now hold exactly the model's fields (#160), `Hidden` ones included. The engine looked up the field list on the configured wrapper, found none, and kept the whole decoded item. As a result, `pk`, `sk`, `__edd_e__` and other storage attributes leaked into the state that `evolve` receives and that results carry (for example, the stored row of an already-applied redelivery, or `catchUp`). The make-time check that a named checkpoint, instance, map or revision field belongs to the model (`EDD-9081`) now applies to configured models too.
