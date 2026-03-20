import type { DynamoSchema } from "../../lib/playground-engine"
import { schemaPrefix } from "../../lib/playground-engine"

interface Props {
  keys: Record<string, string>
  schema: DynamoSchema
}

interface Segment {
  text: string
  kind: "prefix" | "entity" | "value" | "delimiter"
}

const COLORS: Record<Segment["kind"], string> = {
  prefix: "#6366f1",
  entity: "#f59e0b",
  value: "#10b981",
  delimiter: "var(--sl-color-gray-4)",
}

function parseKey(key: string, schema: DynamoSchema): Segment[] {
  const pre = schemaPrefix(schema)
  const segments: Segment[] = []

  if (!key.startsWith(pre)) {
    segments.push({ text: key, kind: "value" })
    return segments
  }

  segments.push({ text: pre, kind: "prefix" })
  const rest = key.slice(pre.length)
  if (!rest) return segments

  // rest starts with # — split remaining parts
  const parts = rest.slice(1).split("#")
  for (let i = 0; i < parts.length; i++) {
    segments.push({ text: "#", kind: "delimiter" })
    // First part after prefix is typically entity type or collection name
    if (i === 0) {
      segments.push({ text: parts[i]!, kind: "entity" })
    } else {
      segments.push({ text: parts[i]!, kind: "value" })
    }
  }

  return segments
}

function KeyRow({ label, value, schema }: { label: string; value: string; schema: DynamoSchema }) {
  const segments = parseKey(value, schema)
  return (
    <div
      style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", marginBottom: "0.25rem" }}
    >
      <code
        style={{
          fontSize: "0.8rem",
          fontWeight: 600,
          minWidth: "5rem",
          color: "var(--sl-color-gray-3)",
        }}
      >
        {label}
      </code>
      <code style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
        {segments.map((seg, i) => (
          <span key={i} style={{ color: COLORS[seg.kind] }}>
            {seg.text}
          </span>
        ))}
      </code>
    </div>
  )
}

export function KeyVisualizer({ keys, schema }: Props) {
  return (
    <div
      style={{
        padding: "1rem",
        borderRadius: "0.5rem",
        backgroundColor: "var(--sl-color-bg-sidebar)",
        border: "1px solid var(--sl-color-gray-6)",
      }}
    >
      <span
        style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}
      >
        Generated Keys
      </span>
      <div
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          fontSize: "0.75rem",
          marginBottom: "0.75rem",
        }}
      >
        <span>
          <span style={{ color: COLORS.prefix }}>schema prefix</span>
        </span>
        <span>
          <span style={{ color: COLORS.entity }}>entity/collection</span>
        </span>
        <span>
          <span style={{ color: COLORS.value }}>attribute values</span>
        </span>
      </div>
      {Object.entries(keys).map(([field, value]) => (
        <KeyRow key={field} label={field} value={value} schema={schema} />
      ))}
    </div>
  )
}
