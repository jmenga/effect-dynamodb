import { useState } from "react"
import type { GeneratedPutItem, GeneratedQuery } from "../../lib/playground-engine"

interface Props {
  composedKeys: Record<string, string> | null
  putItemParams: GeneratedPutItem | null
  queryParams: ReadonlyArray<{ name: string; params: GeneratedQuery | null }>
}

type Tab = "keys" | "putItem" | "query"

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "0.375rem 0.75rem",
  borderRadius: "0.375rem 0.375rem 0 0",
  border: "1px solid var(--sl-color-gray-5)",
  borderBottom: active
    ? "1px solid var(--sl-color-bg-sidebar)"
    : "1px solid var(--sl-color-gray-5)",
  backgroundColor: active ? "var(--sl-color-bg-sidebar)" : "transparent",
  color: active ? "var(--sl-color-text)" : "var(--sl-color-gray-3)",
  cursor: "pointer",
  fontSize: "0.8rem",
  fontWeight: active ? 600 : 400,
  marginBottom: "-1px",
})

function JsonBlock({ data }: { data: unknown }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: "1rem",
        fontSize: "0.8rem",
        overflow: "auto",
        maxHeight: "24rem",
        fontFamily: "var(--sl-font-system-mono)",
        lineHeight: 1.5,
      }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

export function OutputPanel({ composedKeys, putItemParams, queryParams }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("keys")

  return (
    <div
      style={{
        borderRadius: "0.5rem",
        border: "1px solid var(--sl-color-gray-5)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "0.25rem",
          padding: "0.5rem 0.5rem 0",
          backgroundColor: "var(--sl-color-bg)",
          borderBottom: "1px solid var(--sl-color-gray-5)",
        }}
      >
        <button
          type="button"
          style={tabStyle(activeTab === "keys")}
          onClick={() => setActiveTab("keys")}
        >
          Keys
        </button>
        <button
          type="button"
          style={tabStyle(activeTab === "putItem")}
          onClick={() => setActiveTab("putItem")}
        >
          PutItem
        </button>
        <button
          type="button"
          style={tabStyle(activeTab === "query")}
          onClick={() => setActiveTab("query")}
        >
          Query
        </button>
      </div>
      <div style={{ backgroundColor: "var(--sl-color-bg-sidebar)" }}>
        {activeTab === "keys" &&
          (composedKeys ? (
            <JsonBlock data={composedKeys} />
          ) : (
            <p style={{ padding: "1rem", color: "var(--sl-color-gray-3)" }}>
              Missing composite attributes
            </p>
          ))}
        {activeTab === "putItem" &&
          (putItemParams ? (
            <JsonBlock data={putItemParams} />
          ) : (
            <p style={{ padding: "1rem", color: "var(--sl-color-gray-3)" }}>
              Missing composite attributes
            </p>
          ))}
        {activeTab === "query" && (
          <div>
            {queryParams.map(({ name, params }) => (
              <div key={name}>
                <div
                  style={{
                    padding: "0.5rem 1rem 0",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    color: "var(--sl-color-gray-2)",
                  }}
                >
                  {name} {params?.IndexName ? `(${params.IndexName})` : "(table)"}
                </div>
                {params ? (
                  <JsonBlock data={params} />
                ) : (
                  <p style={{ padding: "0.5rem 1rem", color: "var(--sl-color-gray-3)" }}>
                    Missing composites
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
