import { useCallback, useMemo, useState } from "react"
import {
  composeAllKeys,
  type DynamoSchema,
  generatePutItemParams,
  generateQueryParams,
  makeSchema,
} from "../../lib/playground-engine"
import { type Scenario, scenarios } from "../../lib/scenarios"
import { KeyVisualizer } from "./KeyVisualizer"
import { OutputPanel } from "./OutputPanel"
import { ParameterEditor } from "./ParameterEditor"
import { ScenarioSelector } from "./ScenarioSelector"
import { SchemaConfig } from "./SchemaConfig"

export default function Playground() {
  const [scenarioIndex, setScenarioIndex] = useState(0)
  const scenario = scenarios[scenarioIndex]!

  const [schemaOverrides, setSchemaOverrides] = useState<{
    name: string
    version: number
    casing: "lowercase" | "uppercase" | "preserve"
  }>({ ...scenario.schema })

  const [fieldValues, setFieldValues] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(scenario.fields.map((f) => [f.name, f.defaultValue])),
  )

  const handleScenarioChange = useCallback((index: number) => {
    setScenarioIndex(index)
    const s = scenarios[index]!
    setSchemaOverrides({ ...s.schema })
    setFieldValues(Object.fromEntries(s.fields.map((f) => [f.name, f.defaultValue])))
  }, [])

  const schema: DynamoSchema = useMemo(() => makeSchema(schemaOverrides), [schemaOverrides])

  const composedKeys = useMemo(() => {
    try {
      return composeAllKeys(
        schema,
        scenario.entityType,
        scenario.entityVersion,
        scenario.indexes,
        fieldValues as Record<string, unknown>,
      )
    } catch {
      return null
    }
  }, [schema, scenario, fieldValues])

  const putItemParams = useMemo(() => {
    try {
      return generatePutItemParams(
        schema,
        scenario.entityType,
        scenario.entityVersion,
        scenario.indexes,
        fieldValues as Record<string, unknown>,
        scenario.tableName,
      )
    } catch {
      return null
    }
  }, [schema, scenario, fieldValues])

  const queryParams = useMemo(() => {
    const indexEntries = Object.entries(scenario.indexes)
    return indexEntries.map(([name, index]) => {
      try {
        return {
          name,
          params: generateQueryParams(
            schema,
            scenario.entityType,
            scenario.entityVersion,
            name,
            index,
            fieldValues as Record<string, unknown>,
            scenario.tableName,
          ),
        }
      } catch {
        return { name, params: null }
      }
    })
  }, [schema, scenario, fieldValues])

  return (
    <div
      className="not-content"
      style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
        <ScenarioSelector
          scenarios={scenarios as unknown as Scenario[]}
          selectedIndex={scenarioIndex}
          onChange={handleScenarioChange}
        />
        <SchemaConfig value={schemaOverrides} onChange={setSchemaOverrides} />
      </div>

      <ParameterEditor fields={scenario.fields} values={fieldValues} onChange={setFieldValues} />

      {composedKeys && <KeyVisualizer keys={composedKeys} schema={schema} />}

      <OutputPanel
        composedKeys={composedKeys}
        putItemParams={putItemParams}
        queryParams={queryParams}
      />
    </div>
  )
}
